import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { ReaderState } from './shared/types.ts'

/**
 * Minimal `webServer` service surface (provided by @deepseek-ai/dsh-host-webserver
 * in every official composition). Declared here so the host half type-checks
 * without depending on the provider package.
 */
export interface WebServerRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      readonly host: string
      readonly port: number
      register(route: WebServerRoute): () => void
    }
  }
}

/**
 * dsh-novel-reader host half: durable, port-independent persistence for the
 * reader. The DSH Desktop shell binds its Web server to a random loopback
 * port per launch, so browser storage (localStorage / IndexedDB) is scoped
 * to a per-launch origin and "loses" reader state on every restart. This
 * half stores the reader state in the official storage-domain facility
 * (persisted under $DSH_HOME/storages) and exposes it to the client through
 * loopback HTTP routes; book bodies live as individual JSON files so large
 * books never need to be loaded into the domain's in-memory table.
 */

export const name = 'dsh-novel-reader'
export const inject = ['storageDomain', 'webServer']

/** Loose schema that preserves every unknown field while validating shape. */
const readerStateSchema = z.object({
  settings: z.unknown(),
  panel: z.unknown(),
  progress: z.record(z.string(), z.unknown()),
  bookmarks: z.array(z.unknown()),
  recents: z.array(z.unknown()),
}).passthrough()

const EMPTY_STATE: ReaderState = {
  settings: {},
  panel: {},
  progress: {},
  bookmarks: [],
  recents: [],
}

const domainSpec = defineDomain({
  name: 'novel_reader',
  version: 0,
  tables: {},
  global: { schema: readerStateSchema, initial: EMPTY_STATE },
})

/** Book id shape: `book-<base36 hash>` (see shared/id.ts). */
const BOOK_ID_RE = /^book-[a-z0-9]+$/
const MAX_STATE_BYTES = 4 * 1024 * 1024
/** Source files cap at 50 MiB; JSON escaping can inflate, so allow headroom. */
const MAX_BOOK_BYTES = 128 * 1024 * 1024

/**
 * Same-origin loopback check.
 * - Reads (GET): a browser same-origin GET carries no Origin header, so an
 *   absent Origin passes; a present one must still match Host.
 * - Writes (POST/PUT/DELETE): the Origin header is required and must match
 *   Host, so scripted/cross-origin callers are rejected.
 */
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
  // Reject anything that smells like a proxy or forwarded request.
  if (request.headers.forwarded !== undefined
    || request.headers['x-forwarded-for'] !== undefined
    || request.headers['x-real-ip'] !== undefined) return false
  return true
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
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

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(domainSpec)
  ctx.effect(() => () => { void domain.close() }, 'dsh-novel-reader: close state domain')

  const booksRoot = dshHomePath('storages', 'novel-reader-books')

  // -- reader state: GET + POST share one exact route (duplicate paths throw) --
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-novel-reader/state',
    handler: async (request, response) => {
      if (!sameOrigin(request, request.method)) return sendJson(response, 403, { error: 'untrusted origin' })
      if (request.method === 'GET') {
        sendJson(response, 200, domain.global.get())
        return
      }
      if (request.method === 'POST') {
        try {
          const value = await readJsonBody(request, MAX_STATE_BYTES)
          const parsed = readerStateSchema.parse(value)
          await domain.global.set(parsed)
          sendJson(response, 200, { ok: true })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      response.writeHead(405, { allow: 'GET, POST' })
      response.end()
    },
  }), 'dsh-novel-reader: state route')

  // -- book bodies: one GET/PUT/DELETE prefix route --
  // NOTE: the webserver matches `pathname.startsWith(prefix + '/')`, so the
  // prefix must NOT end with a slash (a trailing slash would double it and
  // never match `/dsh-novel-reader/books/<id>`).
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-novel-reader/books',
    handler: async (request, response) => {
      if (!sameOrigin(request, request.method)) return sendJson(response, 403, { error: 'untrusted origin' })
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const id = decodeURIComponent(url.pathname.slice('/dsh-novel-reader/books/'.length))
      if (!BOOK_ID_RE.test(id)) return sendJson(response, 400, { error: 'invalid book id' })
      const path = join(booksRoot, `${id}.json`)

      if (request.method === 'GET') {
        if (!existsSync(path)) return sendJson(response, 404, { error: 'book not found' })
        try {
          const body = readFileSync(path, 'utf8')
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'application/json; charset=utf-8',
          })
          response.end(body)
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      if (request.method === 'PUT') {
        try {
          const value = await readJsonBody(request, MAX_BOOK_BYTES)
          if (typeof value !== 'object' || value === null || (value as { id?: unknown }).id !== id) {
            return sendJson(response, 400, { error: 'book body id mismatch' })
          }
          mkdirSync(booksRoot, { recursive: true })
          writeFileSync(path, JSON.stringify(value))
          sendJson(response, 200, { ok: true })
        } catch (error) {
          sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      if (request.method === 'DELETE') {
        try {
          if (existsSync(path)) rmSync(path)
          sendJson(response, 200, { ok: true })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      response.writeHead(405, { allow: 'GET, PUT, DELETE' })
      response.end()
    },
  }), 'dsh-novel-reader: books route')
}
