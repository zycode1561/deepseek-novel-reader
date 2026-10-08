// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it, vi } from 'vitest'
import * as reader from '../src/client/index.tsx'
import * as host from '../src/index.ts'

const require = createRequire(import.meta.url)

// Exercise the published browser closure with the real shared host modules.
// The renderer owns ctx.slots in DSH 0.2; the removed client-runtime must not
// be needed to activate the reader or clean up its contributions.
function loadRenderer(): typeof import('@deepseek-ai/dsh-client-ui-renderer/client') {
  let result: typeof import('@deepseek-ai/dsh-client-ui-renderer/client') | undefined
  const code = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-renderer/client'), 'utf8')
  new Function('window', code)({
    __ModuleLoader__: {
      load: ({ factory }: { factory: (resolve: typeof require) => typeof result }) => {
        result = factory(require)
      },
    },
  })
  if (result === undefined) throw new Error('DSH renderer closure did not register')
  return result
}

function frame(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
  }, ({ renderSlot }) => renderSlot('shell.overlay', {}))
}
const shellPlugin = { inject: ['slots'], apply: frame }

describe('DSH 0.2 client compatibility', () => {
  it('activates the published client bundle with the real shared renderer', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(loadRenderer())
      await ctx.plugin(shellPlugin)
      let published: typeof reader | undefined
      new Function('window', readFileSync(join(import.meta.dirname, '../lib/client.js'), 'utf8'))({
        __ModuleLoader__: { load: ({ factory }: { factory: (resolve: typeof require) => typeof reader }) => { published = factory(require) } },
      })
      expect(published).toBeDefined()
      const fiber = ctx.plugin(published!)
      await fiber
      expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)).toContain('dsh-novel-reader')
      expect(document.querySelectorAll('[data-plugin="dsh-novel-reader"]')).toHaveLength(1)
      await fiber.dispose()
      expect(document.querySelector('[data-plugin="dsh-novel-reader"]')).toBeNull()
    } finally { await ctx.fiber.dispose() }
  })
  it('waits for services and slot declarations, then removes effects on unload', async () => {
    const ctx = new Context()
    try {
      const fiber = ctx.plugin(reader)
      await fiber
      expect(document.querySelector('[data-plugin="dsh-novel-reader"]')).toBeNull()

      await ctx.plugin(loadRenderer())
      expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)

      const shell = ctx.plugin(shellPlugin)
      await shell
      expect(ctx.slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual(['dsh-novel-reader'])
      expect(document.querySelectorAll('[data-plugin="dsh-novel-reader"]')).toHaveLength(1)

      await shell.dispose()
      expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
      await ctx.plugin(shellPlugin)
      expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)

      await fiber.dispose()
      expect(ctx.slots.entries('shell.overlay')).toHaveLength(0)
      expect(document.querySelector('[data-plugin="dsh-novel-reader"]')).toBeNull()
      await ctx.plugin(reader)
      expect(ctx.slots.entries('shell.overlay')).toHaveLength(1)
      expect(document.querySelectorAll('[data-plugin="dsh-novel-reader"]')).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
    expect(document.querySelector('[data-plugin="dsh-novel-reader"]')).toBeNull()
  })

  it('reopens durable reader state and unregisters routes with the new storage providers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-reader-compat-'))
    vi.stubEnv('DSH_HOME', home)
    const ctx = new Context()
    const routes = new Map<string, host.WebServerRoute>()
    try {
      await ctx.plugin(Storage)
      await ctx.plugin(storageJson, { root: join(home, 'storages') })
      await ctx.plugin(storageDomain, { backend: 'json' })
      await ctx.plugin((serviceCtx: Context) => {
        serviceCtx.provide('webServer', {
          host: '127.0.0.1', port: 0,
          register(route: host.WebServerRoute) {
            const key = `${route.kind}:${route.path}`
            if (routes.has(key)) throw new Error('duplicate route')
            routes.set(key, route)
            return () => { routes.delete(key) }
          },
        })
      })
      const fiber = ctx.plugin(host)
      await fiber
      const state = { settings: { fontSize: 22 }, panel: {}, progress: {}, bookmarks: [], recents: [] }
      await ctx.storageDomain.get('novel_reader')!.global.set(state)
      expect(routes.has('exact:/dsh-novel-reader/state')).toBe(true)
      await fiber.dispose()
      expect(routes.size).toBe(0)

      await ctx.plugin(host)
      let payload = ''
      let status = 0
      await routes.get('exact:/dsh-novel-reader/state')!.handler({
        method: 'GET', headers: { host: '127.0.0.1' },
      } as IncomingMessage, {
        writeHead(code: number) { status = code },
        end(body: string) { payload = body },
      } as unknown as ServerResponse)
      expect(status).toBe(200)
      expect(JSON.parse(payload)).toEqual(state)
    } finally {
      await ctx.fiber.dispose()
      vi.unstubAllEnvs()
      await rm(home, { recursive: true, force: true })
    }
    expect(routes.size).toBe(0)
  })
})
