import { describe, expect, it, vi } from 'vitest'
import { OnlineEngineError, type ResolvedOnlineResult } from '../src/online/engine.ts'
import { OnlineRegistry, OnlineRegistryError, type OnlineRegistryEngine } from '../src/online/registry.ts'
import { loadBuiltinRules } from '../src/online/rules.ts'
import { buildOnlineBook } from '../src/shared/online-book.ts'

function resolvedResult(): ResolvedOnlineResult {
  const source = loadBuiltinRules()[0]!
  return {
    source,
    bookUrl: `${source.url}book/42`,
    public: {
      id: '', sourceId: source.id, sourceName: source.name, sourceUrl: `${source.url}book/42`,
      bookName: '测试书', author: '作者', intro: '', category: '', latestChapter: '',
      lastUpdateTime: '', status: '', wordCount: '',
    },
  }
}

function completedEngine(result: ResolvedOnlineResult): OnlineRegistryEngine {
  return {
    search: async () => ({ results: [result.public], resolved: [result], failedSources: 3, searchedSources: 11 }),
    acquire: async (_result, progress) => {
      progress(1, 2, 1)
      progress(2, 2, 1)
      return buildOnlineBook({
        name: '测试书',
        origin: { sourceId: result.source.id, sourceName: result.source.name, bookUrl: result.bookUrl, fetchedAt: 1 },
        chapters: [{ title: '第一章', paragraphs: ['正文。'] }],
      })
    },
  }
}

describe('opaque online result and acquisition registry', () => {
  it('waits for TXT persistence and exposes its path on completion', async () => {
    const result = resolvedResult()
    let completeSave!: (path: string) => void
    const save = vi.fn(async () => await new Promise<string>(resolve => { completeSave = resolve }))
    const registry = new OnlineRegistry(completedEngine(result), save)
    const search = await registry.search('测试', new AbortController().signal)
    const job = registry.createAcquisition(search.results[0]!.id)
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(registry.status(job.id).state).not.toBe('completed')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ content: '第一章\n正文。' }), expect.any(AbortSignal))
    completeSave('/novel/测试书.txt')
    await vi.waitFor(() => expect(registry.status(job.id)).toMatchObject({ state: 'completed', txtPath: '/novel/测试书.txt' }))
  })

  it('keeps the acquired book readable and reports TXT write failures', async () => {
    const result = resolvedResult()
    const registry = new OnlineRegistry(completedEngine(result), async () => { throw new Error('permission denied') })
    const search = await registry.search('测试', new AbortController().signal)
    const job = registry.createAcquisition(search.results[0]!.id)
    await vi.waitFor(() => expect(registry.status(job.id)).toMatchObject({ state: 'completed', txtError: 'permission denied' }))
    expect(registry.status(job.id).txtPath).toBeUndefined()
    expect(registry.result(job.id).content).toContain('正文。')
  })

  it('does not export when acquisition ignores a late cancellation', async () => {
    const result = resolvedResult()
    const engine = completedEngine(result)
    const acquire = engine.acquire
    let release!: () => void
    engine.acquire = async (...args) => { await new Promise<void>(resolve => { release = resolve }); return acquire(...args) }
    const save = vi.fn()
    const registry = new OnlineRegistry(engine, save)
    const search = await registry.search('测试', new AbortController().signal)
    const job = registry.createAcquisition(search.results[0]!.id)
    registry.cancel(job.id)
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(registry.status(job.id).state).toBe('cancelled')
    expect(save).not.toHaveBeenCalled()
  })

  it('returns opaque IDs, reports partial source failures, and exposes a completed book', async () => {
    const result = resolvedResult()
    const registry = new OnlineRegistry(completedEngine(result))
    const search = await registry.search('测试', new AbortController().signal)
    expect(search).toMatchObject({ failedSources: 3, searchedSources: 11 })
    expect(search.results[0]?.id).toMatch(/^[0-9a-f-]{36}$/u)
    expect(() => registry.createAcquisition(result.bookUrl)).toThrow(OnlineRegistryError)

    const job = registry.createAcquisition(search.results[0]!.id)
    await vi.waitFor(() => expect(registry.status(job.id).state).toBe('completed'))
    expect(registry.result(job.id)).toMatchObject({ format: 'online', name: '测试书' })
  })

  it('expires search IDs and rejects later acquisition requests', async () => {
    vi.useFakeTimers()
    try {
      const result = resolvedResult()
      const registry = new OnlineRegistry(completedEngine(result))
      const search = await registry.search('测试', new AbortController().signal)
      vi.advanceTimersByTime(15 * 60 * 1000 + 1)
      expect(() => registry.createAcquisition(search.results[0]!.id)).toThrow('搜索结果已过期')
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an in-flight task and clears it on dispose', async () => {
    const result = resolvedResult()
    const engine: OnlineRegistryEngine = {
      search: async () => ({ results: [result.public], resolved: [result], failedSources: 0, searchedSources: 1 }),
      acquire: async (_result, _progress, signal) => await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new OnlineEngineError('抓取已取消。', 'CANCELLED')), { once: true })
      }),
    }
    const registry = new OnlineRegistry(engine)
    const search = await registry.search('测试', new AbortController().signal)
    const job = registry.createAcquisition(search.results[0]!.id)
    expect(registry.cancel(job.id)).toMatchObject({ state: 'cancelled', errorCode: 'CANCELLED' })
    await vi.waitFor(() => expect(registry.status(job.id).state).toBe('cancelled'))
    registry.dispose()
    expect(() => registry.status(job.id)).toThrow('未找到抓取任务')
  })
})
