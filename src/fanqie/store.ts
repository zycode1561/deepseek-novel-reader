import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { cookieSchema, type FanqieCookie } from './client.ts'
import type { FanqieBinding, FanqieLocation } from '../shared/fanqie.ts'

export const locationSchema = z.object({ chapterIndex: z.number().int().min(0), paragraphIndex: z.number().int().min(0) })
export const localBookIdSchema = z.string().regex(/^book-[a-z0-9]+$/)
export const remoteBookIdSchema = z.string().regex(/^\d{1,64}$/)
const bindingSchema = z.object({ localBookId: localBookIdSchema, remoteBookId: remoteBookIdSchema,
  remoteBookName: z.string().min(1).max(500), baseline: z.object({ remoteChapterId: remoteBookIdSchema, local: locationSchema }).optional() })
const stateSchema = z.object({ accounts: z.record(z.string(), z.array(bindingSchema).max(1000)) })
type State = z.infer<typeof stateSchema>
const spec = defineDomain({ name: 'novel_reader_fanqie', version: 0, tables: {}, global: { schema: stateSchema, initial: { accounts: {} } } })
export interface FanqiePersistence { get(): State; set(value: State): Promise<unknown> }

export class FanqieStore {
  private state: State
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly persistence: FanqiePersistence) { this.state = stateSchema.parse(persistence.get()) }
  bindings(accountId: string): FanqieBinding[] { return structuredClone(this.state.accounts[accountId] ?? []) }
  binding(accountId: string, localBookId: string): FanqieBinding | undefined { return this.bindings(accountId).find(item => item.localBookId === localBookId) }
  private transact(mutate: (next: State) => void): Promise<void> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const next = structuredClone(this.state); mutate(next); stateSchema.parse(next)
      await this.persistence.set(next); this.state = next
    })
    this.queue = operation; return operation
  }
  async bind(accountId: string, binding: FanqieBinding): Promise<void> {
    await this.transact(next => {
      const bindings = next.accounts[accountId] ?? []
      next.accounts[accountId] = [...bindings.filter(item => item.localBookId !== binding.localBookId), bindingSchema.parse(binding)]
    })
  }
  async unbind(accountId: string, localBookId: string): Promise<void> {
    await this.transact(next => { next.accounts[accountId] = (next.accounts[accountId] ?? []).filter(item => item.localBookId !== localBookId) })
  }
  async acknowledge(accountId: string, expected: FanqieBinding, remoteChapterId: string, local: FanqieLocation): Promise<void> {
    await this.transact(next => {
      const current = next.accounts[accountId]?.find(item => item.localBookId === expected.localBookId)
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('STALE_SYNC')
      current.baseline = { remoteChapterId, local: locationSchema.parse(local) }
    })
  }
}

export async function openFanqieStore(ctx: Context): Promise<FanqieStore> {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(() => () => { void domain.close() }, 'novel-reader: close fanqie domain')
  return new FanqieStore({ get: () => domain.global.get(), set: value => domain.global.set(value) })
}

const credentialSchema = z.object({ accountId: z.string().regex(/^[a-f0-9]{64}$/), cookies: z.array(cookieSchema).max(200) })
export interface FanqieCredentials { accountId: string; cookies: FanqieCookie[] }
/** Private host-only file. Never included in the browser state domain or logs. */
export class FanqieCredentialFile {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}
  async read(): Promise<FanqieCredentials | null> {
    try {
      const value = credentialSchema.parse(JSON.parse(await readFile(this.file, 'utf8')))
      await chmod(this.file, 0o600)
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof z.ZodError || error instanceof SyntaxError) return null
      throw error
    }
  }
  write(value: FanqieCredentials | null): Promise<void> {
    const snapshot = value === null ? null : JSON.stringify(credentialSchema.parse(value))
    const operation = this.queue.catch(() => {}).then(async () => {
      if (snapshot === null) { await rm(this.file, { force: true }); return }
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 }); await chmod(dirname(this.file), 0o700)
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try { await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, this.file) }
      finally { await rm(temporary, { force: true }) }
    })
    this.queue = operation; return operation
  }
}
