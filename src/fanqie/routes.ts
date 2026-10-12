import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { readJsonBody, sameOrigin, sendError, sendJson } from '../online/routes.ts'
import { FanqieError } from './client.ts'
import type { FanqieService } from './auth.ts'
import { localBookIdSchema, remoteBookIdSchema, locationSchema } from './store.ts'
import { fanqiePositionSchema } from './library.ts'

const BASE = '/dsh-novel-reader/fanqie'
export function registerFanqieRoutes(ctx: Context, service: FanqieService): void {
  const controller = new AbortController()
  ctx.effect(() => () => { controller.abort(); service.dispose() }, 'novel-reader: close fanqie sessions')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: BASE, handler: async (request, response) => {
    const expected = new Set([`${ctx.webServer.host}:${ctx.webServer.port}`, `127.0.0.1:${ctx.webServer.port}`, `localhost:${ctx.webServer.port}`])
    if (!expected.has(request.headers.host ?? '') || !sameOrigin(request, request.method)
      || (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))))
      return sendError(response, 403, 'FORBIDDEN', '请求来源不可信。')
    const path = new URL(request.url ?? '/', 'http://localhost').pathname.slice(BASE.length)
    const method = request.method
    const aborted = new AbortController()
    request.once('aborted', () => aborted.abort())
    response.once('close', () => { if (!response.writableEnded) aborted.abort() })
    const signal = AbortSignal.any([controller.signal, aborted.signal])
    try {
      if (path === '/status' && method === 'GET') return sendJson(response, 200, service.status())
      if (path === '/login' && method === 'POST') return sendJson(response, 200, await service.startLogin(signal))
      if (path === '/login' && method === 'DELETE') {
        const { id } = z.object({ id: z.string().uuid() }).strict().parse(await readJsonBody(request))
        service.cancelLogin(id); return sendJson(response, 200, { ok: true })
      }
      if (path === '/login/check' && method === 'POST') {
        const { id } = z.object({ id: z.string().uuid() }).strict().parse(await readJsonBody(request))
        return sendJson(response, 200, await service.checkLogin(id, signal))
      }
      if (path === '/logout' && method === 'POST') { await service.logout(); return sendJson(response, 200, service.status()) }
      if (path === '/shelf' && method === 'POST') return sendJson(response, 200, await service.shelf(signal))
      if (path === '/books/open' && method === 'POST') {
        const { bookId, name, fromPhone } = z.object({ bookId: remoteBookIdSchema, name: z.string().min(1).max(500), fromPhone: z.boolean().default(false) }).strict().parse(await readJsonBody(request))
        return sendJson(response, 200, await service.openBook(bookId, name, signal, fromPhone))
      }
      if (path === '/books/chapter' && method === 'POST') {
        const { accountId, bookId, chapterId } = z.object({ accountId: z.string().regex(/^[a-f0-9]{64}$/), bookId: remoteBookIdSchema, chapterId: remoteBookIdSchema }).strict().parse(await readJsonBody(request))
        return sendJson(response, 200, await service.readChapter(accountId, bookId, chapterId, signal))
      }
      if (path === '/books/position' && method === 'POST') {
        const { accountId, bookId, position } = z.object({ accountId: z.string().regex(/^[a-f0-9]{64}$/), bookId: remoteBookIdSchema, position: fanqiePositionSchema }).strict().parse(await readJsonBody(request))
        await service.savePosition(accountId, bookId, position); return sendJson(response, 200, { ok: true })
      }
      if (path === '/bindings' && method === 'POST') {
        const binding = z.object({ localBookId: localBookIdSchema, remoteBookId: remoteBookIdSchema, remoteBookName: z.string().min(1).max(500) }).strict().parse(await readJsonBody(request))
        await service.bind(binding); return sendJson(response, 200, service.status())
      }
      if (path === '/bindings' && method === 'DELETE') {
        const { localBookId } = z.object({ localBookId: localBookIdSchema }).strict().parse(await readJsonBody(request))
        await service.unbind(localBookId); return sendJson(response, 200, service.status())
      }
      if (path === '/pull' && method === 'POST') {
        const { localBookId } = z.object({ localBookId: localBookIdSchema }).strict().parse(await readJsonBody(request))
        return sendJson(response, 200, await service.pull(localBookId, signal))
      }
      if (path === '/ack' && method === 'POST') {
        const { ticket, local } = z.object({ ticket: z.string().uuid(), local: locationSchema }).strict().parse(await readJsonBody(request))
        await service.acknowledge(ticket, local); return sendJson(response, 200, { ok: true })
      }
      return sendError(response, 404, 'NOT_FOUND', '接口不存在或请求方法不正确。')
    } catch (error) {
      if (signal.aborted) return
      if (error instanceof z.ZodError || error instanceof SyntaxError) return sendError(response, 400, 'INVALID_REQUEST', '请求参数不正确。')
      if (error instanceof FanqieError) return sendError(response, error.code === 'AUTH_EXPIRED' ? 401 : 502, error.code, error.message)
      sendError(response, 500, 'REQUEST_FAILED', '番茄请求失败，请稍后重试。')
    }
  } }), 'novel-reader: fanqie routes')
}
