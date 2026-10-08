// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANY_READER_TEMPLATE, type ManagedRule } from '../src/shared/rules.ts'
import { RuleManagerPanel } from '../src/client/components/RuleManagerPanel.tsx'
import { OnlineSearchPanel } from '../src/client/components/OnlineSearchPanel.tsx'
import * as api from '../src/client/online/api.ts'

vi.mock('../src/client/online/api.ts', () => ({ listRules: vi.fn(), saveRule: vi.fn(), setRuleEnabled: vi.fn(), deleteRule: vi.fn(), exportRules: vi.fn(), previewRuleImport: vi.fn(), commitRuleImport: vi.fn(), testRule: vi.fn() }))
vi.mock('../src/client/state/ReaderContext.tsx', () => ({ useReader: () => ({ loadOnlineBook: vi.fn() }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.resetAllMocks() })
const item: ManagedRule = { id: 'custom:any-reader:demo', name: '演示书源', raw: { ...ANY_READER_TEMPLATE, id: 'demo', extra: { keep: true } }, format: 'any-reader', kind: 'custom', enabled: true, compatible: true, diagnostics: [] }
async function mount(element: JSX.Element): Promise<HTMLElement> {
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(element))
  return container
}
async function click(container: HTMLElement, text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === text)
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })) })
}
describe('rule management UI', () => {
  it('opens book-source management from online search with an empty library', async () => {
    vi.mocked(api.listRules).mockResolvedValue([item])
    const container = await mount(<OnlineSearchPanel onBack={vi.fn()} onOpened={vi.fn()} />)
    await click(container, '书源管理')
    expect(container.textContent).toContain('演示书源')
    await click(container, '‹ 返回搜书')
    expect(container.textContent).toContain('在线搜书')
  })
  it('keeps JSON and form changes synchronized and preserves unknown fields on save', async () => {
    vi.mocked(api.listRules).mockResolvedValue([item])
    vi.mocked(api.saveRule).mockImplementation(async (raw, format, enabled, id) => ({ ...item, raw, format, enabled, id: id! }))
    const container = await mount(<RuleManagerPanel onBack={vi.fn()} />)
    await click(container, '编辑 / 测试')
    await input(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="基本信息 名称"]')!, '新名字')
    await click(container, '原始 JSON')
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="原始规则 JSON"]')!
    expect(JSON.parse(editor.value).name).toBe('新名字')
    const raw = { ...JSON.parse(editor.value), contentItems: '#main@html' }
    await input(editor, JSON.stringify(raw))
    await click(container, '分步骤表单')
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="正文 正文"]')!.value).toBe('#main@html')
    await click(container, '保存规则')
    expect(api.saveRule).toHaveBeenCalledWith(expect.objectContaining({ name: '新名字', contentItems: '#main@html', extra: { keep: true } }), 'any-reader', true, item.id)
  })
  it('uses returned handles for staged tests and renders body as text', async () => {
    vi.mocked(api.listRules).mockResolvedValue([item])
    vi.mocked(api.testRule).mockResolvedValueOnce({ stage: 'search', requests: ['https://example.com/search'], items: [{ title: '书籍', url: 'https://example.com/book', handle: 'book-handle' }], paragraphs: [], diagnostics: [] })
      .mockResolvedValueOnce({ stage: 'toc', requests: ['https://example.com/book'], items: [{ title: '第一章', url: 'https://example.com/chapter', handle: 'chapter-handle' }], paragraphs: [], diagnostics: [] })
      .mockResolvedValueOnce({ stage: 'content', requests: [], items: [], paragraphs: ['<script>alert(1)</script>', '正文'], diagnostics: [] })
    const container = await mount(<RuleManagerPanel onBack={vi.fn()} />)
    await click(container, '编辑 / 测试')
    await input(container.querySelector<HTMLInputElement>('input[aria-label="测试关键词"]')!, '测试')
    await click(container, '测试搜索')
    await click(container, '书籍https://example.com/book')
    expect(api.testRule).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'toc', handle: 'book-handle' }), expect.any(AbortSignal))
    await click(container, '第一章https://example.com/chapter')
    expect(api.testRule).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'content', handle: 'chapter-handle' }), expect.any(AbortSignal))
    expect(container.querySelector('.dnr-rule-content-preview')!.textContent).toContain('<script>')
    expect(container.querySelector('script')).toBeNull()
  })
  it('shows host failures and keeps incompatible rules disabled', async () => {
    vi.mocked(api.listRules).mockRejectedValue(new Error('无法连接阅读器 Host'))
    const container = await mount(<RuleManagerPanel onBack={vi.fn()} />)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Host')
    vi.mocked(api.listRules).mockResolvedValue([{ ...item, compatible: false, enabled: false, diagnostics: [{ field: 'loadJs', message: '不支持脚本' }] }])
    await click(container, '重试连接')
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true)
    expect(container.textContent).toContain('loadJs')
  })
  it('previews imports before committing and defaults to skipping duplicate IDs', async () => {
    vi.mocked(api.listRules).mockResolvedValue([item])
    vi.mocked(api.previewRuleImport).mockResolvedValue({ token: 'preview-token', items: [{ ...item, duplicate: true }] })
    vi.mocked(api.commitRuleImport).mockResolvedValue({ imported: 0, skipped: 1 })
    const container = await mount(<RuleManagerPanel onBack={vi.fn()} />)
    await click(container, '导入规则')
    await input(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="待导入规则"]')!, JSON.stringify(item.raw))
    await click(container, '校验并预览')
    expect(api.commitRuleImport).not.toHaveBeenCalled()
    expect(container.textContent).toContain('默认跳过')
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
    await click(container, '确认导入 1 条')
    expect(api.commitRuleImport).toHaveBeenCalledWith('preview-token', [])
    expect(container.textContent).toContain('跳过 1 条')
  })
})
