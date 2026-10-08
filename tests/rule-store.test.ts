import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { RuleStore, decodeRuleImport, type RuleState } from '../src/online/rule-store.ts'
import { ANY_READER_TEMPLATE } from '../src/shared/rules.ts'

function storage() {
  let state: RuleState = { custom: [], builtinEnabled: {} }
  return { get: () => structuredClone(state), set: vi.fn(async (next: RuleState) => { state = structuredClone(next) }) }
}
describe('rule import codec', () => {
  it('accepts JSON/JSON5 objects and arrays and the upstream ESO zlib format', () => {
    expect(decodeRuleImport('{name:"规则", // comment\nhost:"https://example.com",}')).toHaveLength(1)
    const raw = [{ ...ANY_READER_TEMPLATE, id: 'rule1' }, { ...ANY_READER_TEMPLATE, id: 'rule2' }]
    expect(decodeRuleImport(JSON.stringify(raw))).toEqual(raw)
    const encoded = `eso://作者:规则@${deflateSync(JSON.stringify(raw)).toString('base64')}`
    expect(decodeRuleImport(encoded)).toEqual(raw)
  })
  it('rejects invalid, oversized and decompression-bomb inputs', () => {
    expect(() => decodeRuleImport('null')).toThrow('JSON 对象')
    expect(() => decodeRuleImport('[')).toThrow('解码失败')
    expect(() => decodeRuleImport('a'.repeat(1024 * 1024 + 1))).toThrow('1 MiB')
    expect(() => decodeRuleImport(JSON.stringify(Array.from({ length: 201 }, () => ({}))))).toThrow('200')
    expect(() => decodeRuleImport(`eso://:@${deflateSync('a'.repeat(2 * 1024 * 1024)).toString('base64')}`)).toThrow('解码失败')
  })
})
describe('durable managed sources', () => {
  it('keeps all builtins enabled, persists independent custom IDs and preserves unknown fields', async () => {
    const persistence = storage(), store = new RuleStore(persistence)
    expect(store.sources()).toHaveLength(11)
    const rule = await store.save({ ...ANY_READER_TEMPLATE, extra: { value: 1 } }, 'any-reader', true)
    expect(rule.id).toMatch(/^custom:any-reader:/)
    expect(rule.raw.extra).toEqual({ value: 1 })
    const reopened = new RuleStore(persistence)
    expect(reopened.get(rule.id)).toEqual(rule)
    expect(reopened.sources()).toHaveLength(12)
    await reopened.setEnabled('sonovel-1', false)
    expect(new RuleStore(persistence).sources()).toHaveLength(11)
    await expect(reopened.remove('sonovel-2')).rejects.toThrow('不支持删除')
  })
  it('retains incompatible raw rules disabled and reports exact fields', async () => {
    const store = new RuleStore(storage())
    const rule = await store.save({ ...ANY_READER_TEMPLATE, loadJs: 'process.exit()' }, 'any-reader', true)
    expect(rule).toMatchObject({ enabled: false, compatible: false })
    expect(rule.raw.loadJs).toBe('process.exit()')
    expect(rule.diagnostics.map(item => item.field)).toContain('loadJs')
    await expect(store.setEnabled(rule.id, true)).rejects.toThrow('修复')
    expect(store.sources()).toHaveLength(11)
  })
  it('previews without mutation and skips duplicates unless updates are selected', async () => {
    const persistence = storage(), store = new RuleStore(persistence)
    const raw = { ...ANY_READER_TEMPLATE, id: 'shared' }
    const first = store.preview(JSON.stringify(raw))
    expect(persistence.set).not.toHaveBeenCalled()
    expect(await store.commit(first.token)).toEqual({ imported: 1, skipped: 0 })
    const second = store.preview(JSON.stringify({ ...raw, name: '新版' }))
    expect(second.items[0]?.duplicate).toBe(true)
    expect(await store.commit(second.token)).toEqual({ imported: 0, skipped: 1 })
    const third = store.preview(JSON.stringify({ ...raw, name: '新版' }))
    await store.commit(third.token, [third.items[0]!.id])
    expect(store.get(third.items[0]!.id).name).toBe('新版')
    await expect(store.commit(third.token)).rejects.toThrow('过期')
  })
  it('serializes concurrent writes, publishes only persisted revisions and supports delete', async () => {
    const persistence = storage(), store = new RuleStore(persistence), changed = vi.fn()
    store.onChanged(changed)
    const [a, b] = await Promise.all([store.save({ ...ANY_READER_TEMPLATE, id: 'a' }, 'any-reader', true), store.save({ ...ANY_READER_TEMPLATE, id: 'b' }, 'any-reader', true)])
    expect(store.sources()).toHaveLength(13)
    const revision = store.sources().find(item => item.id === a.id)!.revision
    await store.save({ ...a.raw, name: '修改名称' }, a.format, true, a.id)
    expect(store.sources().find(item => item.id === a.id)!.revision).not.toBe(revision)
    await store.remove(b.id)
    expect(store.sources()).toHaveLength(12)
    expect(changed).toHaveBeenCalledTimes(4)
    persistence.set.mockRejectedValueOnce(new Error('disk full'))
    await expect(store.setEnabled(a.id, false)).rejects.toThrow('disk full')
    expect(store.get(a.id).enabled).toBe(true)
  })
})
