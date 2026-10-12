// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FanqieOpen, FanqieStatus, FanqieText } from '../src/shared/fanqie.ts'
import { DEFAULT_SETTINGS, DEFAULT_PANEL } from '../src/shared/constants.ts'
import { parseBookText } from '../src/shared/parser.ts'
import { ReaderContext, type ReaderContextValue } from '../src/client/state/ReaderContext.tsx'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const api = vi.hoisted(() => ({ getFanqieStatus: vi.fn(), getFanqieShelf: vi.fn(), openFanqieBook: vi.fn(), readFanqieChapter: vi.fn(),
  saveFanqiePosition: vi.fn(), logoutFanqie: vi.fn(), startFanqieLogin: vi.fn(), cancelFanqieLogin: vi.fn(), checkFanqieLogin: vi.fn() }))
const probe = vi.hoisted(() => ({ reader: null as ReaderContextValue | null, glyphFont: undefined as string | undefined }))
vi.mock('../src/client/fanqie/api.ts', async original => ({ ...await original<typeof import('../src/client/fanqie/api.ts')>(), ...api }))
vi.mock('../src/client/components/ReaderBody.tsx', async () => {
  const { forwardRef } = await import('react')
  const { useReader } = await import('../src/client/state/ReaderContext.tsx')
  return { ReaderBody: forwardRef(function Body(props: { glyphFont?: string }, _ref) {
    probe.reader = useReader(); probe.glyphFont = props.glyphFont
    return <article data-testid="body">{probe.reader.book?.name}: {probe.reader.book?.content}</article>
  }) }
})
import { FanqieWorkspace } from '../src/client/components/FanqieWorkspace.tsx'

let root: Root, local: ReaderContextValue
const accountA = 'a'.repeat(64), accountB = 'b'.repeat(64)
const status = (accountId = accountA): FanqieStatus => ({ loggedIn: true, accountId, bindings: [], pollIntervalMs: 2000 })
const session = (overrides: Partial<FanqieOpen> = {}): FanqieOpen => ({ accountId: accountA, bookId: '12', name: '番茄书',
  chapters: [{ id: '21', title: '序章' }, { id: '22', title: '春' }, { id: '23', title: '夏' }], chapterIndex: 1, paragraphIndex: 1, remoteChapterId: '22', ...overrides })
const text = (id: string): FanqieText => ({ id, title: '章节', paragraphs: ['段落零', '段落一', '段落二'] })
async function render(active = true) {
  await act(async () => root.render(<ReaderContext.Provider value={local}><FanqieWorkspace active={active} /></ReaderContext.Provider>))
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
}
function reader(): ReaderContextValue { if (!probe.reader) throw new Error('missing Fanqie reader'); return probe.reader }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); probe.reader = null
  api.getFanqieStatus.mockResolvedValue(status())
  api.getFanqieShelf.mockResolvedValue([{ id: '12', name: '番茄书', author: '作者', chapterId: '22' }])
  api.openFanqieBook.mockResolvedValue(session())
  api.readFanqieChapter.mockImplementation(async (_account, _book, id) => text(id))
  api.saveFanqiePosition.mockResolvedValue(undefined)
  local = { book: null, progress: null, settings: { ...DEFAULT_SETTINGS, pageMode: 'scroll' }, panel: { ...DEFAULT_PANEL, expanded: true },
    bookmarks: [], recents: [], notices: [], ready: true, loading: false, error: null, pendingParagraph: null,
    ...Object.fromEntries(['setReaderActive', 'applySyncedChapter', 'loadFile', 'loadOnlineBook', 'startOnlineReading', 'retryOnlineChapter',
      'openRecent', 'removeRecent', 'updateSettings', 'updatePanel', 'togglePanel', 'setPanelWidth', 'goToChapter', 'goToParagraph',
      'markParagraphVisible', 'clearPendingParagraph', 'addBookmark', 'removeBookmark', 'clearError'].map(key => [key, vi.fn()])) } as ReaderContextValue
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('Fanqie workspace isolation', () => {
  it('renders navigation in the shared header without moving the reading state', async () => {
    const target = document.createElement('div'); document.body.append(target)
    const renderWithHeader = async (active: boolean) => {
      await act(async () => root.render(<ReaderContext.Provider value={local}><FanqieWorkspace active={active} toolbarTarget={target} /></ReaderContext.Provider>))
    }
    await renderWithHeader(true); await click('继续阅读')
    expect(target.querySelector('[aria-label="番茄阅读工具"]')).not.toBeNull()
    expect(document.querySelector('.dnr-fanqie-workspace .dnr-fanqie-toolbar')).toBeNull()
    expect(target.querySelector('[aria-current="page"]')?.textContent).toBe('正文')
    act(() => reader().markParagraphVisible(2))
    await renderWithHeader(false)
    expect(target.querySelector('.dnr-fanqie-toolbar')).toBeNull()
    await renderWithHeader(true)
    expect(reader().progress?.paragraphIndex).toBe(2)
    await click('目录')
    expect(target.querySelector('[aria-current="page"]')?.textContent).toBe('目录')
    await click('正文'); await click('同步手机进度')
    expect(api.openFanqieBook).toHaveBeenLastCalledWith('12', '番茄书', expect.any(AbortSignal), true)
    expect(local.goToChapter).not.toHaveBeenCalled()
  })
  it('reads directly with an empty local library and persists only the remote account/book position', async () => {
    await render(); await click('继续阅读')
    expect(api.readFanqieChapter).toHaveBeenCalledWith(accountA, '12', '22', expect.any(AbortSignal))
    expect(reader().progress).toMatchObject({ chapterIndex: 1, paragraphIndex: 1 })
    act(() => reader().markParagraphVisible(2))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(api.saveFanqiePosition).toHaveBeenLastCalledWith(accountA, '12', expect.objectContaining({ chapterId: '22', paragraphIndex: 2, remoteChapterId: '22' }))
    expect(local.book).toBeNull(); expect(local.progress).toBeNull(); expect(local.recents).toEqual([])
    expect(local.loadFile).not.toHaveBeenCalled(); expect(local.applySyncedChapter).not.toHaveBeenCalled()
  })
  it('retains both reading locations on a source switch and routes chapter keys only to the active library', async () => {
    local.book = { id: 'local-book', name: '本地书', format: 'txt', encoding: 'utf-8', size: 1, lastModified: 0, openedAt: 1, largeFileMode: false,
      ...parseBookText('第一章\n本地正文') }
    local.progress = { bookId: 'local-book', chapterIndex: 0, paragraphIndex: 1, scrollOffset: 40, readingSeconds: 15, updatedAt: 1 }
    const before = structuredClone(local.progress)
    await render(); await click('继续阅读')
    act(() => reader().markParagraphVisible(2)); await render(false)
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })))
    expect(api.readFanqieChapter).toHaveBeenCalledTimes(1)
    await render(true)
    expect(reader().progress?.paragraphIndex).toBe(2)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true })))
    expect(reader().progress?.chapterIndex).toBe(2)
    expect(local.progress).toEqual(before); expect(local.book.id).toBe('local-book')
    expect(local.goToChapter).not.toHaveBeenCalled(); expect(local.markParagraphVisible).not.toHaveBeenCalled()
  })
  it('ignores late cancelled chapters, retries failed chapter loading and keeps the committed progress baseline', async () => {
    await render(); await click('继续阅读')
    let finish!: (value: FanqieText) => void
    api.readFanqieChapter.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => reader().goToChapter(0))
    const oldSignal = api.readFanqieChapter.mock.calls.at(-1)![3] as AbortSignal
    await act(async () => reader().goToChapter(2))
    expect(oldSignal.aborted).toBe(true)
    await act(async () => finish(text('21')))
    expect(reader().progress?.chapterIndex).toBe(2)
    api.openFanqieBook.mockResolvedValueOnce(session({ chapterIndex: 0, remoteChapterId: '21' }))
    api.readFanqieChapter.mockRejectedValueOnce(new Error('网络中断'))
    await click('同步手机进度')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('网络中断')
    await render(false)
    expect(api.saveFanqiePosition).toHaveBeenLastCalledWith(accountA, '12', expect.objectContaining({ chapterId: '23', remoteChapterId: '22' }))
    await render(true); await click('重试')
    expect(reader().progress?.chapterIndex).toBe(0)
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
  it('clears old content and isolates the next account after logging out', async () => {
    await render(); await click('继续阅读'); await click('番茄书架')
    api.logoutFanqie.mockResolvedValue({ loggedIn: false, accountId: null, bindings: [], pollIntervalMs: 2000 })
    await click('退出登录')
    expect(document.querySelector('[data-testid="body"]')).toBeNull()
    expect(document.querySelector('[aria-label="番茄阅读工具"]')).toBeNull()
    api.getFanqieStatus.mockResolvedValue(status(accountB))
    // Remount as the next login; no position from account A is supplied to the Host.
    act(() => root.unmount()); root = createRoot(document.body.firstElementChild!)
    api.openFanqieBook.mockResolvedValue(session({ accountId: accountB, paragraphIndex: 0 }))
    await render(); await click('继续阅读')
    expect(reader().progress?.paragraphIndex).toBe(0)
    expect(api.readFanqieChapter).toHaveBeenLastCalledWith(accountB, '12', '22', expect.any(AbortSignal))
  })
  it('loads the official glyph font before displaying encoded content and removes it on unmount', async () => {
    const load = vi.fn().mockResolvedValue(undefined), add = vi.fn(), remove = vi.fn()
    vi.stubGlobal('FontFace', class { load = load })
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add, delete: remove } })
    api.readFanqieChapter.mockResolvedValueOnce({ ...text('22'), fontData: 'data:font/woff2;base64,d09GMg==' })
    await render(); await click('继续阅读')
    expect(load).toHaveBeenCalledOnce(); expect(add).toHaveBeenCalledOnce()
    expect(probe.glyphFont).toBe('dnr-fanqie-0')
    act(() => root.unmount()); expect(remove).toHaveBeenCalledOnce()
    root = createRoot(document.body.firstElementChild!)
  })
})
