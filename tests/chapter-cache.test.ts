import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnlineChapterCache } from '../src/client/online/chapter-cache.ts'
import type { ChapterPrefetchCount, OnlineReadingChapter, OnlineReadingSession } from '../src/shared/types.ts'

const session: OnlineReadingSession = {
  id: 'reading', sourceName: '测试源',
  reference: { sourceId: 'demo', bookUrl: 'https://novels.example/book', bookName: '测试', keyword: '测试' },
  chapters: Array.from({ length: 8 }, (_, index) => ({ title: `第${index + 1}章` })),
}
const chapter = (index: number): OnlineReadingChapter => ({ index, title: session.chapters[index]!.title, paragraphs: [`正文${index}`] })
const signal = () => new AbortController().signal
const caches: OnlineChapterCache[] = []
function setup() {
  const fetch = vi.fn(async (_id: string, index: number, _signal?: AbortSignal) => chapter(index))
  const cache = new OnlineChapterCache(session, fetch)
  caches.push(cache)
  return { cache, fetch }
}
function deferred() {
  let resolve!: (chapter: OnlineReadingChapter) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<OnlineReadingChapter>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => { caches.splice(0).forEach(cache => cache.dispose()) })

describe('memory-only chapter prefetch', () => {
  it.each([0, 1, 2, 3] as ChapterPrefetchCount[])('prefetches exactly %i following chapters', async count => {
    const { cache, fetch } = setup()
    cache.prefetch(0, count)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(count))
    expect(fetch.mock.calls.map(call => call[1])).toEqual(Array.from({ length: count }, (_, index) => index + 1))
  })

  it('fetches nearest first and shares an in-flight prefetch with a chapter turn', async () => {
    const { cache, fetch } = setup(), pending = deferred()
    fetch.mockReturnValueOnce(pending.promise)
    cache.prefetch(0, 3)
    expect(fetch.mock.calls.map(call => call[1])).toEqual([1])
    const reading = cache.read(1, signal())
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![2]!.aborted).toBe(false)
    pending.resolve(chapter(1))
    await expect(reading).resolves.toEqual(chapter(1))
    cache.prefetch(1, 3)
    await vi.waitFor(() => expect(fetch.mock.calls.map(call => call[1])).toEqual([1, 2, 3, 4]))
  })

  it('reuses completed chapters, slides the window and evicts old bodies', async () => {
    const { cache, fetch } = setup()
    await cache.read(0, signal())
    cache.prefetch(0, 2)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    await cache.read(1, signal())
    expect(fetch).toHaveBeenCalledTimes(3)
    cache.prefetch(1, 2)
    await vi.waitFor(() => expect(fetch.mock.calls.map(call => call[1])).toEqual([0, 1, 2, 3]))
    await cache.read(0, signal())
    expect(fetch.mock.calls.map(call => call[1])).toEqual([0, 1, 2, 3, 0])
  })

  it('stops at the final chapter', async () => {
    const { cache, fetch } = setup()
    cache.prefetch(6, 3)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(fetch.mock.calls[0]![1]).toBe(7)
    cache.prefetch(7, 3)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('ignores speculative failure and retries the failed chapter when selected', async () => {
    const { cache, fetch } = setup()
    fetch.mockRejectedValueOnce(new Error('网络中断'))
    cache.prefetch(0, 2)
    await vi.waitFor(() => expect(fetch.mock.calls.map(call => call[1])).toEqual([1, 2]))
    await expect(cache.read(1, signal())).resolves.toEqual(chapter(1))
    expect(fetch.mock.calls.map(call => call[1])).toEqual([1, 2, 1])
  })

  it('cancels irrelevant work on a jump and rejects late stale results', async () => {
    const { cache, fetch } = setup(), pending = deferred()
    fetch.mockReturnValueOnce(pending.promise)
    cache.prefetch(0, 3)
    const oldSignal = fetch.mock.calls[0]![2]!
    await cache.read(5, signal())
    expect(oldSignal.aborted).toBe(true)
    pending.resolve(chapter(1))
    await cache.read(1, signal())
    expect(fetch.mock.calls.map(call => call[1])).toEqual([1, 5, 1])
  })

  it('cancels a promoted request with foreground navigation and allows a fresh retry', async () => {
    const { cache, fetch } = setup(), pending = deferred(), controller = new AbortController()
    fetch.mockReturnValueOnce(pending.promise)
    cache.prefetch(0, 2)
    const reading = cache.read(1, controller.signal)
    controller.abort()
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch.mock.calls[0]![2]!.aborted).toBe(true)
    await expect(cache.read(1, signal())).resolves.toEqual(chapter(1))
    pending.resolve(chapter(1))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('aborts outstanding prefetch when disabled and releases everything on dispose', async () => {
    const { cache, fetch } = setup(), pending = deferred()
    fetch.mockReturnValueOnce(pending.promise)
    cache.prefetch(0, 3)
    cache.prefetch(0, 0)
    expect(fetch.mock.calls[0]![2]!.aborted).toBe(true)
    pending.resolve(chapter(1))
    await cache.read(0, signal())
    cache.dispose()
    await expect(cache.read(0, signal())).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch.mock.calls.map(call => call[1])).toEqual([1, 0])
  })
})
