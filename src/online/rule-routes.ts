import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { RuleTests } from './rule-tests.ts'
import { MAX_RULE_BYTES, RuleStore, RuleStoreError } from './rule-store.ts'
import type { OnlineSourceEngine } from './engine.ts'
import { readJsonBody, sameOrigin, sendError, sendJson } from './routes.ts'

const BASE = '/dsh-novel-reader/online/rules'
const rawSchema = z.record(z.string(), z.unknown())
const formatSchema = z.enum(['any-reader', 'sonovel'])
const saveSchema = z.object({ raw: rawSchema, format: formatSchema, enabled: z.boolean().default(true), id: z.string().max(240).optional() })
const testSchema = z.object({ raw: rawSchema, format: formatSchema, stage: z.enum(['search', 'toc', 'content']), keyword: z.string().max(100).optional(), handle: z.string().uuid().optional() })

export function registerRuleRoutes(ctx: Context, engine: OnlineSourceEngine, store: RuleStore): void {
  const tests = new RuleTests(engine)
  const pending = new Set<AbortController>()
  ctx.effect(() => () => { for (const controller of pending) controller.abort(); tests.dispose() }, 'dsh-novel-reader: dispose rule tests')
  const route = (path: string, kind: 'exact' | 'prefix', handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): void => {
    ctx.effect(() => ctx.webServer.register({ path, kind, handler: async (request, response) => {
      if (!sameOrigin(request, request.method)) return sendError(response, 403, 'FORBIDDEN', 'untrusted origin')
      try { await handler(request, response) }
      catch (error) {
        const code = error instanceof RuleStoreError ? error.code : 'INVALID_RULE'
        const message = error instanceof Error ? error.message : String(error)
        sendError(response, code === 'RULE_NOT_FOUND' ? 404 : code === 'RULE_TOO_LARGE' || message === 'request body too large' ? 413 : 400, code, message)
      }
    } }), `dsh-novel-reader: rule route ${path}`)
  }
  const methodError = (response: ServerResponse, allow: string): void => { response.writeHead(405, { allow }); response.end() }
  const body = async (request: IncomingMessage): Promise<unknown> => await readJsonBody(request, MAX_RULE_BYTES * 2 + 16_384)
  route(BASE, 'exact', async (request, response) => {
    if (request.method === 'GET') return sendJson(response, 200, store.list())
    if (request.method !== 'POST') return methodError(response, 'GET, POST')
    const value = saveSchema.parse(await body(request))
    sendJson(response, 200, await store.save(value.raw, value.format, value.enabled, value.id))
  })
  route(`${BASE}/import`, 'exact', async (request, response) => {
    if (request.method !== 'POST') return methodError(response, 'POST')
    const value = z.union([
      z.object({ text: z.string() }),
      z.object({ token: z.string().uuid(), updateIds: z.array(z.string().max(240)).max(200).default([]) }),
    ]).parse(await body(request))
    sendJson(response, 200, 'text' in value ? store.preview(value.text) : await store.commit(value.token, value.updateIds))
  })
  route(`${BASE}/export`, 'exact', async (request, response) => {
    if (request.method !== 'GET') return methodError(response, 'GET')
    const id = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('id')
    sendJson(response, 200, id ? store.get(id).raw : store.list().filter(item => item.kind === 'custom').map(item => item.raw))
  })
  route(`${BASE}/test`, 'exact', async (request, response) => {
    if (request.method !== 'POST') return methodError(response, 'POST')
    const value = testSchema.parse(await body(request))
    if (Buffer.byteLength(JSON.stringify(value.raw)) > MAX_RULE_BYTES) throw new RuleStoreError('RULE_TOO_LARGE', '规则输入超过 1 MiB。')
    const controller = new AbortController()
    pending.add(controller)
    const abort = (): void => { if (!response.writableEnded) controller.abort() }
    request.once('aborted', abort)
    response.once('close', abort)
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(engine.testTimeoutMs)])
      sendJson(response, 200, await tests.run({ raw: value.raw, format: value.format, stage: value.stage,
        ...(value.keyword !== undefined ? { keyword: value.keyword } : {}), ...(value.handle !== undefined ? { handle: value.handle } : {}) }, signal))
    } finally { pending.delete(controller); request.off('aborted', abort); response.off('close', abort) }
  })
  route(BASE, 'prefix', async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname.slice(BASE.length + 1)
    if (!path || path.includes('/')) throw new RuleStoreError('RULE_NOT_FOUND', '无效书源路径。')
    const id = decodeURIComponent(path)
    if (request.method === 'GET') return sendJson(response, 200, store.get(id))
    if (request.method === 'DELETE') { await store.remove(id); return sendJson(response, 200, { ok: true }) }
    if (request.method === 'PUT') {
      const value = z.object({ enabled: z.boolean() }).parse(await body(request))
      return sendJson(response, 200, await store.setEnabled(id, value.enabled))
    }
    methodError(response, 'GET, PUT, DELETE')
  })
}
