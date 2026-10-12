// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FanqiePull } from '../src/shared/fanqie.ts'
import type { Book, ReadingPosition } from '../src/shared/types.ts'
import { parseBookText } from '../src/shared/parser.ts'

const mocks = vi.hoisted(() => ({ useReader: vi.fn(), pull: vi.fn(), ack: vi.fn(), status: vi.fn() }))
vi.mock('../src/client/state/ReaderContext.tsx', () => ({ useReader: mocks.useReader }))
vi.mock('../src/client/fanqie/api.ts', async original => ({ ...await original<typeof import('../src/client/fanqie/api.ts')>(),
  pullFanqieProgress: mocks.pull, acknowledgeFanqie: mocks.ack, getFanqieStatus: mocks.status }))
import { useFanqieSync, type FanqieSync } from '../src/client/fanqie/useFanqieSync.ts'

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let sync: FanqieSync
let reader: { book: Book; progress: ReadingPosition; ready: boolean; loading: boolean; applySyncedChapter: ReturnType<typeof vi.fn> }
let pull: FanqiePull
function Probe() { sync = useFanqieSync(); return null }
async function render() { await act(async () => { root.render(<Probe />); await Promise.resolve() }) }
beforeEach(() => {
  vi.resetAllMocks()
  const book: Book = { id: 'book-a', name: '四季', format: 'txt', encoding: 'utf-8', size: 90, content: '', lastModified: 0, openedAt: 1, largeFileMode: false,
    ...parseBookText('第一章 春\n风来了。\n花开了。\n第二章 夏\n蝉鸣。\n雨停了。') }
  reader = { book, progress: { bookId: book.id, chapterIndex: 0, paragraphIndex: 0, scrollOffset: 0, updatedAt: 999, readingSeconds: 100 },
    ready: true, loading: false, applySyncedChapter: vi.fn(async (_id, target) => ({ ...reader.progress, chapterIndex: target, paragraphIndex: book.chapters[target]!.paragraphStart })) }
  mocks.useReader.mockImplementation(() => reader)
  pull = { ticket: 'ticket', accountId: 'a', binding: { localBookId: 'book-a', remoteBookId: '12', remoteBookName: '四季' },
    progress: { bookId: '12', chapterId: '22', fetchedAt: 1 }, chapters: [{ id: '21', title: '第一章 春' }, { id: '22', title: '第二章 夏' }] }
  mocks.pull.mockImplementation(async () => structuredClone(pull))
  mocks.status.mockResolvedValue({ loggedIn: true, accountId: 'a', bindings: [], pollIntervalMs: 2000 })
  mocks.ack.mockResolvedValue({ ok: true })
  root = createRoot(document.body.appendChild(document.createElement('div')))
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren() })
describe('phone-to-reader synchronization', () => {
  it('applies a uniquely mapped chapter and acknowledges only after loading succeeds', async () => {
    await render()
    expect(reader.applySyncedChapter).toHaveBeenCalledWith('book-a', 1, { chapterIndex: 0, paragraphIndex: 0 })
    expect(mocks.ack).toHaveBeenCalledWith('ticket', { chapterIndex: 1, paragraphIndex: reader.book.chapters[1]!.paragraphStart })
    expect(sync.message).toContain('第二章 夏')
  })
  it('ignores reading-time timestamps and protects a paragraph changed on the computer', async () => {
    pull.binding.baseline = { remoteChapterId: '21', local: { chapterIndex: 0, paragraphIndex: 0 } }
    reader.progress.paragraphIndex = 2
    await render()
    expect(reader.applySyncedChapter).not.toHaveBeenCalled()
    expect(sync.proposal?.reason).toContain('都有阅读位置')
    await act(async () => sync.resolve(null))
    expect(mocks.ack).toHaveBeenCalledWith('ticket', { chapterIndex: 0, paragraphIndex: 2 })
    expect(reader.applySyncedChapter).not.toHaveBeenCalled()
  })
  it('does not reapply an unchanged phone chapter or advance its local baseline', async () => {
    pull.binding.baseline = { remoteChapterId: '22', local: { chapterIndex: 0, paragraphIndex: 0 } }
    reader.progress.paragraphIndex = 2
    await render()
    expect(reader.applySyncedChapter).not.toHaveBeenCalled()
    expect(mocks.ack).not.toHaveBeenCalled()
  })
  it('does not jump when the reader moves during a pending phone request', async () => {
    let release!: (value: FanqiePull) => void
    mocks.pull.mockReturnValue(new Promise(resolve => { release = resolve }))
    await render()
    reader = { ...reader, progress: { ...reader.progress, paragraphIndex: 2 } }
    await render()
    await act(async () => { release(pull); await Promise.resolve() })
    expect(reader.applySyncedChapter).not.toHaveBeenCalled()
    expect(sync.proposal).not.toBeNull()
  })
  it('keeps the position and baseline when chapter loading fails', async () => {
    reader.applySyncedChapter.mockResolvedValue(null)
    await render()
    expect(mocks.ack).not.toHaveBeenCalled()
    expect(sync.proposal?.reason).toContain('未加载成功')
  })
  it('requires a choice for duplicate titles and cancels results on account invalidation', async () => {
    reader.book.chapters.push({ ...reader.book.chapters[1]!, index: 2 })
    await render()
    expect(sync.proposal?.candidates).toEqual([1, 2])
    expect(reader.applySyncedChapter).not.toHaveBeenCalled()
    await act(async () => sync.invalidate())
    expect(sync.proposal).toBeNull()
  })
})
