import { createHash, randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import JSON5 from 'json5'
import { z } from 'zod'
import type { ManagedRule, RuleDiagnostic, RuleFormat, RuleImportPreview, RuleImportResult } from '../shared/rules.ts'
import { compileAnyReader } from './any-reader.ts'
import { loadBuiltinRules, parseSoNovelRule, type SourceRule } from './rules.ts'
import { checkedRegex } from './expressions.ts'

export const MAX_RULE_BYTES = 1024 * 1024
export const MAX_IMPORT_RULES = 200
const builtinSources = loadBuiltinRules()
const storedRuleSchema = z.object({ id: z.string().min(1).max(240), format: z.enum(['any-reader', 'sonovel']), raw: z.record(z.string(), z.unknown()), enabled: z.boolean() })
export const ruleStateSchema = z.object({ custom: z.array(storedRuleSchema).max(2000), builtinEnabled: z.record(z.string(), z.boolean()) })
export type RuleState = z.infer<typeof ruleStateSchema>
export interface RulePersistence { get(): RuleState; set(value: RuleState): Promise<unknown> }
const domainSpec = defineDomain({ name: 'novel_reader_rules', version: 0, tables: {}, global: { schema: ruleStateSchema, initial: { custom: [], builtinEnabled: {} } } })

export class RuleStoreError extends Error {
  constructor(public readonly code: string, message: string) { super(message) }
}

function sizeCheck(value: unknown): void {
  if (Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)) > MAX_RULE_BYTES) {
    throw new RuleStoreError('RULE_TOO_LARGE', '规则输入超过 1 MiB。')
  }
}
export function decodeRuleImport(text: string): Record<string, unknown>[] {
  sizeCheck(text)
  let value: unknown
  try {
    if (text.trim().startsWith('eso://')) {
      const start = text.lastIndexOf('@')
      if (start < 0) throw new Error('缺少 ESO 压缩数据。')
      const base64 = text.slice(start + 1).trim()
      if (!/^[a-z\d+/]+={0,2}$/i.test(base64)) throw new Error('无效的 Base64 数据。')
      // Upstream uses pako.deflate/inflate (zlib-wrapped DEFLATE).
      value = JSON.parse(inflateSync(Buffer.from(base64, 'base64'), { maxOutputLength: MAX_RULE_BYTES }).toString('utf8'))
    } else value = JSON5.parse(text)
  } catch (error) { throw new RuleStoreError('INVALID_RULE', `规则解码失败：${error instanceof Error ? error.message : String(error)}`) }
  const rows = Array.isArray(value) ? value : [value]
  if (!rows.length || rows.length > MAX_IMPORT_RULES) throw new RuleStoreError('IMPORT_LIMIT', '每次请导入 1–200 条规则。')
  if (rows.some(row => row === null || typeof row !== 'object' || Array.isArray(row))) throw new RuleStoreError('INVALID_RULE', '每条规则必须是 JSON 对象。')
  sizeCheck(value)
  return rows as Record<string, unknown>[]
}

export function compileRule(raw: Record<string, unknown>, format: RuleFormat, id: string): SourceRule {
  if (format === 'any-reader') return compileAnyReader(raw, id)
  const source = parseSoNovelRule(raw, id)
  const original = builtinSources.find(item => item.id === source.builtinTransform)
  for (const [group, fields] of Object.entries(raw)) {
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) continue
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== 'string' || !value.includes('@js:')) continue
      const bundled = original ? (original as unknown as Record<string, Record<string, unknown>>)[group]?.[key] : undefined
      if (value !== bundled) throw new Error(`${group}.${key}: 自定义 SoNovel 规则不支持 JavaScript。`)
    }
  }
  for (const [name, pattern] of [['book.url', source.book.url], ['chapter.paragraphTag', source.chapter.paragraphTag], ['chapter.filterTxt', source.chapter.filterTxt]]) {
    if (!pattern) continue
    const [group, key] = name!.split('.')
    if (original && (original as unknown as Record<string, Record<string, unknown>>)[group!]?.[key!] === pattern) continue
    try { checkedRegex(pattern!, 'gu') } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  return source
}
function diagnostics(raw: Record<string, unknown>, format: RuleFormat, id: string): RuleDiagnostic[] {
  try { compileRule(raw, format, id); return [] }
  catch (error) {
    return (error instanceof Error ? error.message : String(error)).split('\n').map(message => {
      const match = /^([\w.]+):\s*(.*)$/.exec(message)
      return { field: match?.[1] ?? 'rule', message: match?.[2] ?? message }
    })
  }
}
function publicRule(item: z.infer<typeof storedRuleSchema>, kind: ManagedRule['kind']): ManagedRule {
  const issues = diagnostics(item.raw, item.format, item.id)
  return { ...structuredClone(item), name: typeof item.raw.name === 'string' ? item.raw.name : '未命名书源', kind,
    compatible: issues.length === 0, enabled: issues.length === 0 && item.enabled, diagnostics: issues }
}

export class RuleStore {
  private state: RuleState
  private queue: Promise<unknown> = Promise.resolve()
  private readonly imports = new Map<string, { expiresAt: number; preview: RuleImportPreview }>()
  private readonly listeners = new Set<() => void>()
  private readonly builtins = builtinSources.map(source => {
    const { allowedHosts: _allowedHosts, id, ...raw } = source
    return { id, format: 'sonovel' as const, raw: { ...raw, builtinTransform: id }, enabled: true }
  })

  constructor(private readonly persistence: RulePersistence) { this.state = ruleStateSchema.parse(persistence.get()) }
  dispose(): void { this.imports.clear(); this.listeners.clear() }
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  list(): ManagedRule[] {
    return [...this.builtins.map(item => publicRule({ ...item, enabled: this.state.builtinEnabled[item.id] ?? true }, 'builtin')),
      ...this.state.custom.map(item => publicRule(item, 'custom'))]
  }
  get(id: string): ManagedRule {
    const item = this.list().find(rule => rule.id === id)
    if (!item) throw new RuleStoreError('RULE_NOT_FOUND', '未找到书源规则。')
    return item
  }
  sources(): SourceRule[] {
    return this.list().filter(item => item.enabled).map(item => {
      const source = compileRule(item.raw, item.format, item.id)
      source.revision = createHash('sha256').update(JSON.stringify([item.raw, item.enabled])).digest('hex')
      return source
    }).filter(source => !source.disabled && !source.search.disabled)
      .sort((left, right) => Number(right.anyReader?.sort ?? 0) - Number(left.anyReader?.sort ?? 0))
  }
  private transact(mutator: (state: RuleState) => void): Promise<void> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const next = structuredClone(this.state)
      mutator(next)
      ruleStateSchema.parse(next)
      await this.persistence.set(next)
      this.state = next
      for (const listener of this.listeners) listener()
    })
    this.queue = operation
    return operation
  }
  async save(raw: Record<string, unknown>, format: RuleFormat, enabled: boolean, id?: string): Promise<ManagedRule> {
    sizeCheck(raw)
    if (id && this.builtins.some(item => item.id === id)) throw new RuleStoreError('BUILTIN_READONLY', '内置规则请复制为自定义书源后修改。')
    const copy = structuredClone(raw)
    copy.id ??= randomUUID()
    const ruleId = id ?? `custom:${format}:${String(copy.id)}`
    if (ruleId.length > 240 || !ruleId.startsWith('custom:')) throw new RuleStoreError('INVALID_RULE', '无效的规则 ID。')
    const item = { id: ruleId, format, raw: copy, enabled: enabled && diagnostics(copy, format, ruleId).length === 0 }
    await this.transact(state => {
      const index = state.custom.findIndex(rule => rule.id === ruleId)
      if (index < 0) state.custom.push(item)
      else state.custom[index] = item
    })
    return this.get(ruleId)
  }
  async setEnabled(id: string, enabled: boolean): Promise<ManagedRule> {
    const existing = this.get(id)
    if (enabled && !existing.compatible) throw new RuleStoreError('UNSUPPORTED_RULE', '请先修复不兼容字段再启用。')
    await this.transact(state => {
      if (existing.kind === 'builtin') state.builtinEnabled[id] = enabled
      else state.custom.find(item => item.id === id)!.enabled = enabled
    })
    return this.get(id)
  }
  async remove(id: string): Promise<void> {
    if (this.get(id).kind === 'builtin') throw new RuleStoreError('BUILTIN_READONLY', '内置书源支持禁用，不支持删除。')
    await this.transact(state => { state.custom = state.custom.filter(item => item.id !== id) })
  }
  preview(text: string): RuleImportPreview {
    const rows = decodeRuleImport(text)
    const seen = new Set(this.state.custom.map(item => item.id))
    const items = rows.map(raw => {
      const format: RuleFormat = typeof raw.host === 'string' || 'contentType' in raw ? 'any-reader' : 'sonovel'
      const copy = structuredClone(raw)
      copy.id ??= randomUUID()
      const id = `custom:${format}:${String(copy.id)}`
      if (id.length > 240) throw new RuleStoreError('INVALID_RULE', '规则 ID 过长。')
      const item = publicRule({ id, format, raw: copy, enabled: true }, 'custom')
      const duplicate = seen.has(id)
      seen.add(id)
      return { ...item, duplicate }
    })
    const preview = { token: randomUUID(), items }
    for (const [token, entry] of this.imports) if (entry.expiresAt < Date.now()) this.imports.delete(token)
    if (this.imports.size >= 20) this.imports.delete(this.imports.keys().next().value!)
    this.imports.set(preview.token, { expiresAt: Date.now() + 15 * 60_000, preview })
    return structuredClone(preview)
  }
  async commit(token: string, updateIds: string[] = []): Promise<RuleImportResult> {
    const entry = this.imports.get(token)
    if (!entry || entry.expiresAt < Date.now()) throw new RuleStoreError('IMPORT_EXPIRED', '导入预览已过期，请重新校验。')
    const update = new Set(updateIds)
    let imported = 0, skipped = 0
    await this.transact(state => {
      for (const item of entry.preview.items) {
        const index = state.custom.findIndex(rule => rule.id === item.id)
        if (index >= 0 && !update.has(item.id)) { skipped++; continue }
        const stored = { id: item.id, format: item.format, raw: item.raw, enabled: item.enabled }
        if (index < 0) state.custom.push(stored)
        else state.custom[index] = stored
        imported++
      }
    })
    this.imports.delete(token)
    return { imported, skipped }
  }
}

export async function openRuleStore(ctx: Context): Promise<RuleStore> {
  const domain = await ctx.storageDomain.open(domainSpec)
  ctx.effect(() => () => { void domain.close() }, 'dsh-novel-reader: close rule domain')
  const store = new RuleStore(domain.global)
  ctx.effect(() => () => store.dispose(), 'dsh-novel-reader: clear rule previews')
  return store
}
