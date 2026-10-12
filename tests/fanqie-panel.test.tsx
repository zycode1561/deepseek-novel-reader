// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book } from '../src/shared/types.ts'
import type { FanqieAccount } from '../src/client/components/FanqiePanel.tsx'
import { parseBookText } from '../src/shared/parser.ts'

const mocks = vi.hoisted(() => ({ useReader: vi.fn(), getFanqieShelf: vi.fn(), bindFanqieBook: vi.fn() }))
vi.mock('../src/client/state/ReaderContext.tsx', () => ({ useReader: mocks.useReader }))
vi.mock('../src/client/fanqie/api.ts', async original => ({ ...await original<typeof import('../src/client/fanqie/api.ts')>(),
  getFanqieShelf: mocks.getFanqieShelf, bindFanqieBook: mocks.bindFanqieBook }))
import { FanqiePanel } from '../src/client/components/FanqiePanel.tsx'

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLElement
let account: FanqieAccount
let onRead: ReturnType<typeof vi.fn>
let reader: { book: Book | null; loading: boolean; recents: any[]; loadFile: ReturnType<typeof vi.fn>; openRecent: ReturnType<typeof vi.fn>;
  clearError: ReturnType<typeof vi.fn>; error: string | null; removeRecent: ReturnType<typeof vi.fn> }
const localBook: Book = { id: 'book-local', name: '四季', format: 'txt', encoding: 'utf-8', size: 40,
  lastModified: 0, openedAt: 1, largeFileMode: false, ...parseBookText('第一章 春\n风来了。\n第二章 夏\n雨来了。') }
async function render() { await act(async () => { root.render(<FanqiePanel account={account} onRead={onRead} />) }) }
function button(text: string): HTMLButtonElement {
  const value = [...container.querySelectorAll('button')].find(node => node.textContent === text)
  expect(value, `missing button: ${text}`).toBeDefined()
  return value!
}
beforeEach(() => {
  vi.resetAllMocks()
  reader = { book: null, loading: false, recents: [{ id: localBook.id, name: localBook.name, format: 'txt', encoding: 'utf-8', size: 40, openedAt: 1 }],
    loadFile: vi.fn(), openRecent: vi.fn(), clearError: vi.fn(), error: null, removeRecent: vi.fn() }
  mocks.useReader.mockImplementation(() => reader)
  account = { status: { loggedIn: true, accountId: 'a', bindings: [], pollIntervalMs: 2000 }, setStatus: vi.fn(), refreshStatus: vi.fn() }
  onRead = vi.fn()
  vi.mocked(account.refreshStatus).mockResolvedValue(account.status!)
  mocks.getFanqieShelf.mockResolvedValue([{ id: '12', name: '四季', author: '作者', chapterId: '21' }])
  mocks.bindFanqieBook.mockResolvedValue({ ...account.status, bindings: [{ localBookId: 'book-local', remoteBookId: '12', remoteBookName: '四季' }] })
  container = document.body.appendChild(document.createElement('div')); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren() })

describe('independent Fanqie shelf', () => {
  it('opens a Fanqie book without a current local book or a binding', async () => {
    await render()
    expect(container.textContent).not.toContain('绑定')
    expect(container.textContent).not.toContain('电脑书籍')
    const read = button('继续阅读')
    expect(read.disabled).toBe(false)
    await act(async () => read.click())
    expect(onRead).toHaveBeenCalledWith({ id: '12', name: '四季', author: '作者', chapterId: '21' })
    expect(mocks.useReader).not.toHaveBeenCalled()
    expect(mocks.bindFanqieBook).not.toHaveBeenCalled()
  })
  it('also opens directly when an unrelated local book is already selected', async () => {
    reader.book = localBook
    await render()
    await act(async () => button('继续阅读').click())
    expect(onRead).toHaveBeenCalledOnce()
    expect(reader.openRecent).not.toHaveBeenCalled()
    expect(reader.loadFile).not.toHaveBeenCalled()
    expect(mocks.bindFanqieBook).not.toHaveBeenCalled()
  })
  it('allows retrying a failed shelf request', async () => {
    mocks.getFanqieShelf.mockRejectedValueOnce(new Error('读取书架失败'))
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('读取书架失败')
    await act(async () => button('刷新书架').click())
    expect(button('继续阅读').disabled).toBe(false)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
