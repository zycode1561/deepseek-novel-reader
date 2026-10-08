import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebServerRoute } from '../src/index.ts'
import type { OnlineReadingSession, OnlineSearchResponse } from '../src/shared/types.ts'
import type { OnlineSourceEngine, ResolvedOnlineResult } from '../src/online/engine.ts'
import { loadBuiltinRules } from '../src/online/rules.ts'
import { registerOnlineRoutes } from '../src/online/routes.ts'

let ctx: Context
const routes = new Map<string, WebServerRoute>()
const source = loadBuiltinRules()[0]!
const result: ResolvedOnlineResult = {
  source, bookUrl: `${source.url}book/42`,
  public: { id: '', sourceId: source.id, sourceName: source.name, sourceUrl: `${source.url}book/42`, bookName: '测试', author: '', intro: '', category: '', latestChapter: '', lastUpdateTime: '', status: '', wordCount: '' },
}
const engine = {
  search: vi.fn(), previewToc: vi.fn(), readChapter: vi.fn(), resumeReading: vi.fn(),
  isResultCurrent: vi.fn(), listSources: vi.fn(), dispose: vi.fn(),
}

function call(path: string, method = 'GET', body?: unknown, origin = 'http://127.0.0.1:4321') {
  const url = `/dsh-novel-reader/online${path}`
  const route = routes.get(`exact:${url.split('?')[0]}`) ?? routes.get('prefix:/dsh-novel-reader/online/readings')!
  const request = Object.assign(new Readable({ read() { if (body !== undefined) this.push(JSON.stringify(body)); this.push(null) } }), {
    method, url, headers: { host: '127.0.0.1:4321', origin },
  })
  let status = 0, value: unknown
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(code: number) { status = code },
    end(text?: string) { this.writableEnded = true; value = text ? JSON.parse(text) : null },
  })
  const done = Promise.resolve(route.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse)).then(() => ({ status, value }))
  return { done, response }
}

beforeEach(async () => {
  vi.resetAllMocks()
  routes.clear()
  engine.search.mockResolvedValue({ results: [result.public], resolved: [result], failedSources: 0, searchedSources: 1 })
  engine.previewToc.mockResolvedValue([{ title: '一', url: `${source.url}chapter/1` }, { title: '二', url: `${source.url}chapter/2` }])
  engine.readChapter.mockResolvedValue({ title: '二', paragraphs: ['第二章正文'] })
  engine.resumeReading.mockResolvedValue(result)
  engine.isResultCurrent.mockReturnValue(true)
  engine.dispose.mockResolvedValue(undefined)
  ctx = new Context()
  ctx.provide('webServer', { host: '127.0.0.1', port: 4321, register(route: WebServerRoute) {
    const key = `${route.kind}:${route.path}`
    routes.set(key, route)
    return () => { routes.delete(key) }
  } })
  await ctx.plugin((context: Context) => registerOnlineRoutes(context, engine as unknown as OnlineSourceEngine))
})
afterEach(async () => { await ctx.fiber.dispose(); vi.useRealTimers() })

async function open(): Promise<OnlineReadingSession> {
  const search = (await call('/search?q=测试').done).value as OnlineSearchResponse
  const response = await call('/readings', 'POST', { resultId: search.results[0]!.id }).done
  expect(response.status).toBe(200)
  return response.value as OnlineReadingSession
}

describe('online reading HTTP boundary and lifecycle', () => {
  it('opens just the TOC, requests a selected chapter, validates paths and releases sessions', async () => {
    const session = await open()
    expect(engine.readChapter).not.toHaveBeenCalled()
    expect(await call(`/readings/${session.id}/chapters/1`).done).toMatchObject({ status: 200, value: { index: 1, paragraphs: ['第二章正文'] } })
    expect(engine.readChapter.mock.calls[0]?.[1].url).toBe(`${source.url}chapter/2`)
    expect(await call(`/readings/${session.id}/chapters/900`).done).toMatchObject({ status: 404, value: { error: { code: 'CHAPTER_NOT_FOUND' } } })
    expect(await call(`/readings/${session.id}/chapters/1/extra`).done).toMatchObject({ status: 400 })
    expect(await call(`/readings/${session.id}`, 'DELETE').done).toMatchObject({ status: 200 })
    expect(await call(`/readings/${session.id}/chapters/0`).done).toMatchObject({ status: 404, value: { error: { code: 'READING_EXPIRED' } } })
  })

  it('rejects cross-origin writes and arbitrary requests and resumes only with validated metadata', async () => {
    expect(await call('/readings', 'POST', { resultId: 'x' }, 'https://evil.example').done).toMatchObject({ status: 403 })
    expect(await call('/readings', 'POST', { url: 'http://127.0.0.1/private' }).done).toMatchObject({ status: 400 })
    expect(await call('/readings', 'POST', { reference: { sourceId: 'x', bookName: 'x', bookUrl: 'x', keyword: '' } }).done).toMatchObject({ status: 400 })
    expect(engine.resumeReading).not.toHaveBeenCalled()
    const session = await open()
    expect(await call('/readings', 'POST', { reference: session.reference }).done).toMatchObject({ status: 200 })
    expect(engine.resumeReading).toHaveBeenCalledWith(session.reference, expect.any(AbortSignal))
    vi.useFakeTimers()
    vi.advanceTimersByTime(31 * 60_000)
    expect(await call(`/readings/${session.id}/chapters/0`).done).toMatchObject({ status: 404, value: { error: { code: 'READING_EXPIRED' } } })
  })

  it.each(['disconnect', 'unload'] as const)('cancels chapter requests on %s', async action => {
    const session = await open()
    let captured: AbortSignal | undefined
    engine.readChapter.mockImplementation(async (_result, _link, signal: AbortSignal) => {
      captured = signal
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const pending = call(`/readings/${session.id}/chapters/0`)
    await vi.waitFor(() => expect(captured).toBeDefined())
    if (action === 'disconnect') pending.response.emit('close')
    else await ctx.fiber.dispose()
    await pending.done
    expect(captured!.aborted).toBe(true)
    if (action === 'unload') expect(routes.size).toBe(0)
  })
})
