import type { Context } from '@deepseek-ai/cordis'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { FanqiePosition } from '../shared/fanqie.ts'
import { remoteBookIdSchema } from './store.ts'

export const fanqiePositionSchema = z.object({ chapterId: remoteBookIdSchema, paragraphIndex: z.number().int().min(0).max(1_000_000),
  remoteChapterId: z.string().regex(/^\d{0,64}$/), updatedAt: z.number().min(0) }).strict()
const schema = z.object({ accounts: z.record(z.string(), z.record(remoteBookIdSchema, fanqiePositionSchema)) })
type State = z.infer<typeof schema>
const spec = defineDomain({ name: 'novel_reader_fanqie_library', version: 0, tables: {}, global: { schema, initial: { accounts: {} } } })
export class FanqieLibrary {
  private state: State
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly persistence: { get(): State; set(value: State): Promise<unknown> }) { this.state = schema.parse(persistence.get()) }
  position(accountId: string, bookId: string): FanqiePosition | undefined { return structuredClone(this.state.accounts[accountId]?.[bookId]) }
  save(accountId: string, bookId: string, position: FanqiePosition): Promise<void> {
    const operation = this.queue.catch(() => {}).then(async () => {
      const next = structuredClone(this.state)
      const books = next.accounts[accountId] ??= {}
      if (!(bookId in books) && Object.keys(books).length >= 1000) throw new Error('番茄阅读记录已达到 1000 本上限。')
      books[remoteBookIdSchema.parse(bookId)] = fanqiePositionSchema.parse(position)
      await this.persistence.set(next); this.state = next
    })
    this.queue = operation; return operation
  }
}
export async function openFanqieLibrary(ctx: Context) {
  const domain = await ctx.storageDomain.open(spec)
  ctx.effect(() => () => { void domain.close() }, 'novel-reader: close fanqie library')
  return new FanqieLibrary({ get: () => domain.global.get(), set: value => domain.global.set(value) })
}
