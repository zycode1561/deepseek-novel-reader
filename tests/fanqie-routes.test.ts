import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebServerRoute } from '../src/index.ts'
import type { FanqieService } from '../src/fanqie/auth.ts'
import { registerFanqieRoutes } from '../src/fanqie/routes.ts'

let ctx: Context
let route: WebServerRoute | undefined
const service = { status: vi.fn(), startLogin: vi.fn(), cancelLogin: vi.fn(), checkLogin: vi.fn(), logout: vi.fn(), shelf: vi.fn(),
  bind: vi.fn(), unbind: vi.fn(), pull: vi.fn(), acknowledge: vi.fn(), dispose: vi.fn(), openBook: vi.fn(), readChapter: vi.fn(), savePosition: vi.fn() }
beforeEach(async () => {
  vi.resetAllMocks(); ctx = new Context()
  service.status.mockReturnValue({ loggedIn: false, accountId: null, bindings: [], pollIntervalMs: 2000 })
  ctx.provide('webServer', { host: '127.0.0.1', port: 4321, register(value: WebServerRoute) { route = value; return () => { route = undefined } } })
  await ctx.plugin((context: Context) => registerFanqieRoutes(context, service as unknown as FanqieService))
})
afterEach(async () => ctx.fiber.dispose())
async function call(path: string, method = 'GET', body?: unknown, extra: Record<string, string | undefined> = {}) {
  const request = Object.assign(new Readable({ read() { if (body !== undefined) this.push(JSON.stringify(body)); this.push(null) } }), {
    url: `/dsh-novel-reader/fanqie${path}`, method, headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', ...extra },
  })
  let status = 0, value: any
  const response = Object.assign(new EventEmitter(), { writableEnded: false, writeHead(code: number) { status = code },
    end(text: string) { this.writableEnded = true; value = JSON.parse(text) } })
  await route!.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse)
  return { status, value }
}
it('accepts Desktop forwarded shelf POSTs after Origin and Sec-Fetch-Site are removed', async () => {
  service.shelf.mockResolvedValue([])
  const headers = { origin: undefined, 'x-novel-reader-request': '1' }
  expect((await call('/shelf', 'POST', undefined, { ...headers, 'sec-fetch-site': 'same-origin' })).status).toBe(200)
  expect((await call('/shelf', 'POST', undefined, { ...headers, referer: 'http://127.0.0.1:4321/chat' })).status).toBe(200)
  expect((await call('/shelf', 'POST', undefined, headers)).status).toBe(200)
  expect((await call('/shelf', 'POST', undefined, { ...headers, referer: 'dsh-app://app/' })).status).toBe(200)
  expect(service.shelf).toHaveBeenCalledTimes(4)
})
it('does not let the WebView fallback bypass cross-origin or proxy checks', async () => {
  const headers = { origin: undefined, 'x-novel-reader-request': '1', referer: 'http://127.0.0.1:4321/chat' }
  for (const extra of [
    { 'x-novel-reader-request': undefined },
    { origin: 'null' }, { origin: 'https://evil.example' },
    { referer: 'dsh-app://evil/' }, { referer: 'dsh-app://app.evil/' }, { referer: 'null' },
    { referer: 'http://127.0.0.1:4322/chat' }, { referer: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
    { forwarded: 'for=127.0.0.1' }, { 'x-forwarded-for': '127.0.0.1' }, { 'x-real-ip': '127.0.0.1' },
  ]) expect((await call('/shelf', 'POST', undefined, { ...headers, ...extra })).status).toBe(403)
  expect((await call('/shelf', 'OPTIONS', undefined, { origin: 'https://evil.example' })).status).toBe(403)
  expect(service.shelf).not.toHaveBeenCalled()
})
it('rejects untrusted hosts, cross-origin reads/writes and invalid request bodies', async () => {
  expect((await call('/status', 'GET', undefined, { host: 'evil.example:4321', origin: undefined })).status).toBe(403)
  expect((await call('/status', 'GET', undefined, { origin: 'https://evil.example' })).status).toBe(403)
  expect((await call('/status', 'GET', undefined, { origin: undefined, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  expect((await call('/login', 'POST', undefined, { origin: undefined })).status).toBe(403)
  expect((await call('/bindings', 'POST', { localBookId: 'book-a', remoteBookId: '12', remoteBookName: '春', url: 'https://evil.example' })).status).toBe(400)
  expect(service.startLogin).not.toHaveBeenCalled(); expect(service.bind).not.toHaveBeenCalled()
})
it('exposes only supported operations and unregisters sessions and routes on unload', async () => {
  expect((await call('/status')).status).toBe(200)
  expect((await call('/update_progress', 'POST', { progress: 5 })).status).toBe(404)
  expect((await call('/bindings', 'POST', { localBookId: 'book-a', remoteBookId: '12', remoteBookName: '春' })).status).toBe(200)
  expect(service.bind).toHaveBeenCalledWith({ localBookId: 'book-a', remoteBookId: '12', remoteBookName: '春' })
  await ctx.fiber.dispose(); expect(route).toBeUndefined(); expect(service.dispose).toHaveBeenCalledTimes(1)
})
it('opens remote books and validates independent reading positions without accepting a local book or arbitrary URL', async () => {
  const accountId = 'a'.repeat(64)
  service.openBook.mockResolvedValue({ bookId: '12', chapters: [] })
  expect((await call('/books/open', 'POST', { bookId: '12', name: '春' })).status).toBe(200)
  expect(service.openBook).toHaveBeenCalledWith('12', '春', expect.any(AbortSignal), false)
  expect((await call('/books/open', 'POST', { bookId: '12', name: '春', localBookId: 'local' })).status).toBe(400)
  expect((await call('/books/chapter', 'POST', { accountId, bookId: '12', chapterId: '21', url: 'https://evil.example' })).status).toBe(400)
  service.readChapter.mockResolvedValue({ id: '21', title: '春', paragraphs: ['正文'] })
  expect((await call('/books/chapter', 'POST', { accountId, bookId: '12', chapterId: '21' })).status).toBe(200)
  const position = { chapterId: '21', paragraphIndex: 2, remoteChapterId: '20', updatedAt: 1 }
  expect((await call('/books/position', 'POST', { accountId, bookId: '12', position })).status).toBe(200)
  expect(service.savePosition).toHaveBeenCalledWith(accountId, '12', position)
  expect((await call('/books/position', 'POST', { accountId, bookId: '12', position: { ...position, paragraphIndex: -1 } })).status).toBe(400)
  expect(service.bind).not.toHaveBeenCalled()
})
