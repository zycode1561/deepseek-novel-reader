import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetch } from 'undici'
import { lookup } from 'node:dns/promises'
import { OnlineSourceEngine } from '../src/online/engine.ts'
import { resolveOnlineConfig } from '../src/index.ts'
import { compileAnyReader } from '../src/online/any-reader.ts'
import { RuleTests } from '../src/online/rule-tests.ts'
import { RuleStore, type RuleState } from '../src/online/rule-store.ts'
import { OnlineRegistry } from '../src/online/registry.ts'
import { OnlineReadingRegistry } from '../src/online/reading.ts'
import { loadBuiltinRules } from '../src/online/rules.ts'
import { ANY_READER_TEMPLATE } from '../src/shared/rules.ts'
import fixture from './fixtures/any-reader.json'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]) }))
vi.mock('undici', async importOriginal => ({ ...await importOriginal<typeof import('undici')>(), fetch: vi.fn() }))
const engines: OnlineSourceEngine[] = []
const signal = (): AbortSignal => new AbortController().signal
function engine(): OnlineSourceEngine {
  const value = new OnlineSourceEngine(resolveOnlineConfig({ minRequestIntervalMs: 0, maxRequestIntervalMs: 0, maxRetries: 0 }))
  value.setSources([compileAnyReader(fixture.rule, 'custom:fixture')])
  engines.push(value)
  return value
}
beforeEach(() => {
  vi.mocked(fetch).mockReset()
  vi.mocked(lookup).mockReset().mockResolvedValue([{ address: '1.1.1.1', family: 4 }])
  vi.mocked(fetch).mockImplementation(async url => {
    const address = new URL(String(url))
    const pages = fixture.pages as Record<string, unknown>
    const page = pages[address.pathname + address.search] ?? pages[address.pathname]
    return new Response(JSON.stringify(page), { status: page ? 200 : 404, headers: { 'content-type': 'application/json' } }) as unknown as Awaited<ReturnType<typeof fetch>>
  })
})
afterEach(async () => { await Promise.all(engines.splice(0).map(value => value.dispose())) })

describe('AnyReader stages through the controlled online engine', () => {
  it('reopens a URL-based history entry when search no longer returns the book', async () => {
    const value = engine(), source = compileAnyReader({ ...ANY_READER_TEMPLATE, host: 'https://novels.example', chapterUrl: '' }, 'css-history')
    value.setSources([source])
    vi.mocked(fetch).mockImplementation(async url => {
      const path = new URL(String(url)).pathname
      return new Response(path === '/books/42' ? '<div class="chapters"><a href="/chapters/1">第一章</a></div>'
        : path === '/chapters/1' ? '<div id="content"><p>历史书籍正文</p></div>'
        : '<div>搜索结果已经变化</div>') as unknown as Awaited<ReturnType<typeof fetch>>
    })
    const reference = { sourceId: source.id, bookUrl: 'https://novels.example/books/42', bookName: '历史书籍', keyword: '旧搜索词' }
    const restored = await value.resumeReading(reference, signal())
    const reading = new OnlineReadingRegistry(value)
    const session = await reading.open(restored, signal())
    expect((await reading.chapter(session.id, 0, signal())).paragraphs).toEqual(['历史书籍正文'])
    expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/books/42', '/chapters/1'])
    expect(session.reference).toEqual(reference)
    reading.dispose()
    await expect(value.resumeReading({ ...reference, bookUrl: 'http://127.0.0.1/private' }, signal())).rejects.toThrow('未授权主机')
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    await expect(value.resumeReading(reference, signal())).rejects.toThrow('私有网络')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('resumes builtin books directly without requiring a matching search result', async () => {
    const value = engine()
    const source = loadBuiltinRules()[0]!
    value.setSources([source])
    const reference = { sourceId: source.id, bookUrl: `${source.url}book/42`, bookName: '旧书名', keyword: '旧关键词' }
    const restored = await value.resumeReading(reference, signal())
    expect(restored).toMatchObject({ bookUrl: reference.bookUrl, public: { bookName: reference.bookName } })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('opens a TOC without fetching content and restores object stage context on resume', async () => {
    const value = engine(), results = new OnlineRegistry(value), reading = new OnlineReadingRegistry(value)
    const search = await results.search('测试小说', signal())
    const result = results.resolveResult(search.results[0]!.id)
    const session = await reading.open(result, signal())
    expect(session.chapters.map(item => item.title)).toEqual(['第一章', '第二章'])
    expect(vi.mocked(fetch).mock.calls.some(([url]) => new URL(String(url)).pathname === '/api/chapter')).toBe(false)
    const chapter = await reading.chapter(session.id, 0, signal())
    expect(chapter.paragraphs).toEqual(['第一段。', '第二段。', '第三段。'])
    expect(vi.mocked(fetch).mock.calls.some(([url]) => new URL(String(url)).searchParams.get('id') === 'ch2')).toBe(false)
    await expect(reading.chapter(session.id, 999, signal())).rejects.toMatchObject({ code: 'CHAPTER_NOT_FOUND' })
    reading.close(session.id)
    await expect(reading.chapter(session.id, 0, signal())).rejects.toMatchObject({ code: 'READING_EXPIRED' })
    const restored = await value.resumeReading(session.reference, signal())
    expect(restored.stageInput).toEqual(result.stageInput)
    const next = await reading.open(restored, signal())
    expect((await reading.chapter(next.id, 1, signal())).paragraphs).toEqual(['第二章正文。'])
    value.setSources([])
    await expect(reading.chapter(next.id, 0, signal())).rejects.toMatchObject({ code: 'READING_EXPIRED' })
    await expect(value.resumeReading(session.reference, signal())).rejects.toThrow('停用')
    reading.dispose()
    results.dispose()
  })
  it('searches, preserves object results, follows cyclic pagination once and builds a readable book', async () => {
    const value = engine()
    const search = await value.search('测试小说', signal())
    expect(search).toMatchObject({ failedSources: 0, searchedSources: 1 })
    expect(search.resolved[0]?.stageInput).toEqual(fixture.pages['/api/search'].books[0])
    const progress = vi.fn()
    const book = await value.acquire(search.resolved[0]!, progress, signal())
    expect(book).toMatchObject({ format: 'online', name: '测试小说' })
    expect(book.chapters.map(item => item.title)).toEqual(['第一章', '第二章'])
    expect(book.content).toContain('第三段。')
    expect(progress).toHaveBeenLastCalledWith(2, 2, 0)
    const tocCall = vi.mocked(fetch).mock.calls.find(([url]) => new URL(String(url)).pathname === '/api/toc')!
    expect(JSON.parse(String(tocCall[1]?.body))).toEqual({ book: fixture.pages['/api/search'].books[0] })
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => new URL(String(url)).pathname === '/api/toc')).toHaveLength(1)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === 'https://novels.example/api/chapter?id=ch1')).toHaveLength(1)
  })
  it('tests an unsaved draft with opaque stage handles and rejects handles after edits', async () => {
    const value = engine(), tests = new RuleTests(value)
    const search = await tests.run({ raw: fixture.rule, format: 'any-reader', stage: 'search', keyword: '测试' }, signal())
    expect(search.items).toHaveLength(1)
    expect(search.requests).toHaveLength(1)
    const toc = await tests.run({ raw: fixture.rule, format: 'any-reader', stage: 'toc', handle: search.items[0]!.handle }, signal())
    expect(toc.items.map(item => item.title)).toEqual(['第一章', '第二章'])
    const content = await tests.run({ raw: fixture.rule, format: 'any-reader', stage: 'content', handle: toc.items[0]!.handle }, signal())
    expect(content.paragraphs).toEqual(['第一段。', '第二段。', '第三段。'])
    await expect(tests.run({ raw: { ...fixture.rule, name: '修改' }, format: 'any-reader', stage: 'toc', handle: search.items[0]!.handle }, signal())).rejects.toThrow('修改')
    tests.dispose()
    await expect(tests.run({ raw: fixture.rule, format: 'any-reader', stage: 'toc', handle: search.items[0]!.handle }, signal())).rejects.toThrow('过期')
  })
  it('continues an existing acquisition snapshot while edits/disable invalidate old search IDs', async () => {
    let state: RuleState = { custom: [], builtinEnabled: {} }
    const store = new RuleStore({ get: () => state, set: async next => { state = next } })
    const item = await store.save(fixture.rule, 'any-reader', true)
    const value = engine()
    value.setSources(store.sources().filter(source => source.id === item.id))
    store.onChanged(() => value.setSources(store.sources().filter(source => source.id === item.id)))
    const registry = new OnlineRegistry(value)
    const search = await registry.search('测试', signal())
    const job = registry.createAcquisition(search.results[0]!.id)
    await store.save({ ...fixture.rule, contentItems: '$.missing' }, 'any-reader', true, item.id)
    expect(() => registry.createAcquisition(search.results[0]!.id)).toThrow('过期')
    await vi.waitFor(() => expect(registry.status(job.id).state).toBe('completed'))
    expect(registry.result(job.id).content).toContain('第三段。')
    const fresh = await registry.search('测试', signal())
    await store.setEnabled(item.id, false)
    expect(() => registry.createAcquisition(fresh.results[0]!.id)).toThrow('过期')
    expect(await value.search('测试', signal())).toMatchObject({ searchedSources: 0, results: [] })
    registry.dispose()
  })
  it('reports exact field extraction errors and source failures independently', async () => {
    const value = engine()
    const tests = new RuleTests(value)
    const result = await tests.run({ raw: { ...fixture.rule, searchList: '$.notThere' }, format: 'any-reader', stage: 'search', keyword: '测试' }, signal())
    expect(result.diagnostics[0]?.field).toBe('searchList')
    vi.mocked(fetch).mockRejectedValue(new Error('offline'))
    expect(await value.search('测试', signal())).toMatchObject({ failedSources: 1, results: [] })
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed', { cause: Object.assign(new Error('contains-private-request-details'), { code: 'ECONNRESET' }) }))
    const failed = await tests.run({ raw: fixture.rule, format: 'any-reader', stage: 'search', keyword: '测试' }, signal())
    expect(failed.diagnostics[0]?.message).toContain('连接被重置（ECONNRESET）')
    expect(failed.diagnostics[0]?.message).not.toContain('private-request-details')
  })
  it('blocks unlisted redirects and private DNS and never downloads an oversized page', async () => {
    const value = engine(), source = value.sources[0]!
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) as unknown as Awaited<ReturnType<typeof fetch>>)
    await expect(value.previewSearch(source, '测试', signal())).rejects.toThrow('未授权主机')
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
    await expect(value.previewSearch(source, '测试', signal())).rejects.toThrow('私有网络')
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }) as unknown as Awaited<ReturnType<typeof fetch>>)
    await expect(value.previewSearch(source, '测试', signal())).rejects.toThrow('体积')
  })
  it('allows CSS sources with relative links and sanitizes chapter HTML', async () => {
    const value = engine(), raw = { ...ANY_READER_TEMPLATE, host: 'https://novels.example', searchUrl: '/search' }
    const source = compileAnyReader(raw, 'css')
    value.setSources([source])
    vi.mocked(fetch).mockImplementation(async url => {
      const path = new URL(String(url)).pathname
      return new Response(path === '/search' ? '<div class="book"><a href="/books/42">一本书</a></div>'
        : path === '/books/42' ? '<div class="chapters"><a href="/chapters/1">第一章</a></div>'
        : '<div id="content"><p>安全正文</p><br>第二段<script>window.pwned=true</script></div>') as unknown as Awaited<ReturnType<typeof fetch>>
    })
    const result = (await value.search('一本书', signal())).resolved[0]!
    expect(result.stageInput).toBe('/books/42')
    expect(result.bookUrl).toBe('https://novels.example/books/42')
    const book = await value.acquire(result, vi.fn(), signal())
    expect(book.content).toContain('安全正文')
    expect(book.content).not.toContain('pwned')
  })
})
