import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServerRoute } from '../index.ts'
import { OnlineRegistry, OnlineRegistryError } from './registry.ts'
import { OnlineSourceEngine } from './engine.ts'

const MAX_BODY_BYTES = 16 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function sameOrigin(request: IncomingMessage, method: string | undefined): boolean {
  const origin = request.headers.origin
  const host = request.headers.host
  const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE'
  if (mutating && origin === undefined) return false
  if (origin !== undefined) {
    if (host === undefined) return false
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return request.headers.forwarded === undefined
    && request.headers['x-forwarded-for'] === undefined
    && request.headers['x-real-ip'] === undefined
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } })
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function register(ctx: Context, route: WebServerRoute, label: string): void {
  ctx.effect(() => ctx.webServer.register(route), label)
}

export function registerOnlineRoutes(ctx: Context, engine: OnlineSourceEngine): void {
  const registry = new OnlineRegistry(engine)
  ctx.effect(() => () => registry.dispose(), 'dsh-novel-reader: cancel online jobs')
  ctx.effect(() => () => { void engine.dispose() }, 'dsh-novel-reader: close online network dispatcher')

  register(ctx, {
    kind: 'exact',
    path: '/dsh-novel-reader/online/sources',
    handler: (request, response) => {
      if (!sameOrigin(request, request.method)) return sendError(response, 403, 'FORBIDDEN', 'untrusted origin')
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' }); response.end(); return
      }
      sendJson(response, 200, engine.listSources())
    },
  }, 'dsh-novel-reader: online sources route')

  register(ctx, {
    kind: 'exact',
    path: '/dsh-novel-reader/online/search',
    handler: async (request, response) => {
      if (!sameOrigin(request, request.method)) return sendError(response, 403, 'FORBIDDEN', 'untrusted origin')
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' }); response.end(); return
      }
      const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('q')?.trim() ?? ''
      if (query.length === 0 || query.length > 100) return sendError(response, 400, 'INVALID_QUERY', '请输入 1–100 个字符的书名或作者。')
      const controller = new AbortController()
      request.once('aborted', () => controller.abort())
      try {
        sendJson(response, 200, await registry.search(query, controller.signal))
      } catch (error) {
        sendError(response, 502, 'REQUEST_FAILED', error instanceof Error ? error.message : '聚合搜索失败。')
      }
    },
  }, 'dsh-novel-reader: online search route')

  register(ctx, {
    kind: 'exact',
    path: '/dsh-novel-reader/online/acquisitions',
    handler: async (request, response) => {
      if (!sameOrigin(request, request.method)) return sendError(response, 403, 'FORBIDDEN', 'untrusted origin')
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' }); response.end(); return
      }
      try {
        const body = await readJsonBody(request)
        const resultId = typeof body === 'object' && body !== null ? (body as { resultId?: unknown }).resultId : undefined
        if (typeof resultId !== 'string' || !UUID_RE.test(resultId)) return sendError(response, 400, 'RESULT_EXPIRED', '无效的搜索结果。')
        sendJson(response, 202, registry.createAcquisition(resultId))
      } catch (error) {
        if (error instanceof OnlineRegistryError) return sendError(response, 404, error.code, error.message)
        sendError(response, 400, 'INVALID_REQUEST', error instanceof Error ? error.message : '无效请求。')
      }
    },
  }, 'dsh-novel-reader: online acquisition create route')

  register(ctx, {
    kind: 'prefix',
    path: '/dsh-novel-reader/online/acquisitions',
    handler: (request, response) => {
      if (!sameOrigin(request, request.method)) return sendError(response, 403, 'FORBIDDEN', 'untrusted origin')
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      const suffix = pathname.slice('/dsh-novel-reader/online/acquisitions/'.length)
      const [id, action, extra] = suffix.split('/')
      if (id === undefined || !UUID_RE.test(id) || extra !== undefined || (action !== undefined && action !== 'result')) {
        return sendError(response, 400, 'JOB_NOT_FOUND', '无效的抓取任务。')
      }
      try {
        if (request.method === 'GET' && action === 'result') return sendJson(response, 200, registry.result(id))
        if (request.method === 'GET' && action === undefined) return sendJson(response, 200, registry.status(id))
        if (request.method === 'DELETE' && action === undefined) return sendJson(response, 200, registry.cancel(id))
        response.writeHead(405, { allow: action === 'result' ? 'GET' : 'GET, DELETE' })
        response.end()
      } catch (error) {
        if (error instanceof OnlineRegistryError) {
          return sendError(response, error.code === 'JOB_NOT_READY' ? 409 : 404, error.code, error.message)
        }
        sendError(response, 500, 'REQUEST_FAILED', error instanceof Error ? error.message : '抓取任务失败。')
      }
    },
  }, 'dsh-novel-reader: online acquisition route')
}

