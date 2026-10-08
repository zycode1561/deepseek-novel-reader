import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import * as host from '../src/index.ts'
import { ANY_READER_TEMPLATE, type ManagedRule, type RuleImportPreview } from '../src/shared/rules.ts'

describe('managed rule Host routes and lifecycle', () => {
  it('uses real DSH storage, restores rules after reload, respects origin and removes every route', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rule-routes-'))
    vi.stubEnv('DSH_HOME', home)
    const ctx = new Context(), routes = new Map<string, host.WebServerRoute>()
    const call = async (path: string, method = 'GET', body?: unknown, origin: string | null = 'http://127.0.0.1:4321') => {
      const base = '/dsh-novel-reader/online'
      const pathname = `${base}${path}`
      const route = routes.get(`exact:${pathname.split('?')[0]}`) ?? [...routes.values()].filter(route => route.kind === 'prefix' && pathname.startsWith(route.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]!
      const request = Object.assign(new Readable({ read() { if (body !== undefined) this.push(JSON.stringify(body)); this.push(null) } }), {
        method, url: pathname, headers: { host: '127.0.0.1:4321', ...(origin ? { origin } : {}) },
      })
      let status = 0, value: unknown
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        writeHead(code: number) { status = code },
        end(text?: string) { this.writableEnded = true; value = text ? JSON.parse(text) : null },
      })
      await route.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse)
      return { status, value }
    }
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(storageJson, { root: join(home, 'storages') })
      await ctx.plugin(storageDomain, { backend: 'json' })
      await ctx.plugin((serviceCtx: Context) => { serviceCtx.provide('webServer', {
        host: '127.0.0.1', port: 4321, register(route: host.WebServerRoute) {
          const key = `${route.kind}:${route.path}`
          if (routes.has(key)) throw new Error('duplicate route')
          routes.set(key, route)
          return () => { routes.delete(key) }
        },
      }) })
      let fiber = ctx.plugin(host)
      await fiber
      expect((await call('/rules')).value).toHaveLength(11)
      expect(await call('/rules', 'POST', { raw: ANY_READER_TEMPLATE, format: 'any-reader' }, null)).toMatchObject({ status: 403 })
      expect(await call('/rules', 'POST', { raw: ANY_READER_TEMPLATE, format: 'any-reader' }, 'https://evil.example')).toMatchObject({ status: 403 })
      const saved = (await call('/rules', 'POST', { raw: { ...ANY_READER_TEMPLATE, id: 'new', preserved: [1, 2] }, format: 'any-reader', enabled: true })).value as ManagedRule
      expect(saved.compatible).toBe(true)
      expect((await call('/sources')).value).toHaveLength(12)
      const rulePath = `/rules/${encodeURIComponent(saved.id)}`
      expect((await call(rulePath)).value).toMatchObject({ raw: { preserved: [1, 2] } })
      await call('/rules/sonovel-1', 'PUT', { enabled: false })
      await call(rulePath, 'PUT', { enabled: false })
      expect((await call('/sources')).value).toHaveLength(10)
      await fiber.dispose()
      expect(routes.size).toBe(0)
      fiber = ctx.plugin(host)
      await fiber
      expect((await call(rulePath)).value).toMatchObject({ enabled: false, raw: { preserved: [1, 2] } })
      expect((await call('/rules/sonovel-1')).value).toMatchObject({ enabled: false })
      expect((await call(`/rules/export?id=${encodeURIComponent(saved.id)}`)).value).toEqual(saved.raw)
      const preview = (await call('/rules/import', 'POST', { text: JSON.stringify({ ...saved.raw, name: '新版' }) })).value as RuleImportPreview
      expect(preview.items[0]?.duplicate).toBe(true)
      expect((await call('/rules/import', 'POST', { token: preview.token })).value).toEqual({ imported: 0, skipped: 1 })
      const invalid = (await call('/rules', 'POST', { raw: { ...ANY_READER_TEMPLATE, loadJs: 'throw new Error()' }, format: 'any-reader', enabled: true })).value as ManagedRule
      expect(invalid).toMatchObject({ compatible: false, enabled: false })
      expect((await call(`/rules/${encodeURIComponent(invalid.id)}`, 'PUT', { enabled: true })).status).toBe(400)
      expect((await call('/rules/test', 'POST', { raw: invalid.raw, format: 'any-reader', stage: 'search', keyword: 'test' })).value).toMatchObject({ requests: [], items: [], diagnostics: expect.any(Array) })
      expect((await call('/rules', 'POST', { raw: { ...ANY_READER_TEMPLATE, comment: 'x'.repeat(1024 * 1024) }, format: 'any-reader' })).status).toBe(413)
      expect((await call('/rules/sonovel-1', 'DELETE')).status).toBe(400)
      expect((await call(rulePath, 'DELETE')).value).toEqual({ ok: true })
      expect((await call(rulePath)).status).toBe(404)
      await fiber.dispose()
      expect(routes.size).toBe(0)
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
      await rm(home, { recursive: true, force: true })
    }
  })
})
