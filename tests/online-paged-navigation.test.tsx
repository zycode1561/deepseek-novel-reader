// @vitest-environment happy-dom
import { act, createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildReadingBook } from '../src/shared/online-reading.ts'
import { DEFAULT_PANEL, DEFAULT_SETTINGS } from '../src/shared/constants.ts'
import type { useReader } from '../src/client/state/ReaderContext.tsx'
import { ReaderBody, type ReaderBodyHandle } from '../src/client/components/ReaderBody.tsx'

const state = vi.hoisted(() => ({ value: {} as ReturnType<typeof useReader> }))
vi.mock('../src/client/state/ReaderContext.tsx', () => ({ useReader: () => state.value }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

describe('asynchronous online page turns', () => {
  it('lands on the previous chapter last page after loading, without moving the old chapter', () => {
    const session = { id: 'session', reference: { sourceId: 'demo', bookUrl: 'https://novels.example/book', bookName: '测试', keyword: '测试' }, sourceName: 'demo', chapters: [{ title: '一' }, { title: '二' }] }
    const chapter = (index: number) => buildReadingBook(session, { index, title: session.chapters[index]!.title, paragraphs: ['第一段', '第二段'] })
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const flush = () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
    state.value = {
      book: chapter(1), progress: { bookId: chapter(1).id, chapterIndex: 1, paragraphIndex: 1, scrollOffset: 0, updatedAt: 0, readingSeconds: 0 },
      settings: { ...DEFAULT_SETTINGS, pageMode: 'paged' }, panel: DEFAULT_PANEL,
      pendingParagraph: null, clearPendingParagraph: vi.fn(), markParagraphVisible: vi.fn(), updatePanel: vi.fn(), goToChapter: vi.fn(), loading: false, error: null,
    } as unknown as ReturnType<typeof useReader>
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container), ref = createRef<ReaderBodyHandle>()
    const render = () => act(() => root.render(<ReaderBody ref={ref} searchQuery="" />))
    try {
      render()
      const scroller = container.querySelector<HTMLElement>('.dnr-reader-scroll')!
      Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 })
      Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 600 })
      const scrollTo = vi.fn((options: ScrollToOptions) => { scroller.scrollLeft = options.left ?? 0 })
      scroller.scrollTo = scrollTo
      state.value = { ...state.value, progress: { ...state.value.progress! } }
      render(); flush()
      scrollTo.mockClear()
      act(() => ref.current!.turnPage(-1))
      expect(state.value.goToChapter).toHaveBeenCalledWith(0)
      state.value = { ...state.value, loading: true }
      render(); flush()
      expect(scrollTo).not.toHaveBeenCalled()
      state.value = { ...state.value, book: chapter(0), progress: { ...state.value.progress!, chapterIndex: 0 }, pendingParagraph: 0, loading: false }
      render(); flush()
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 400, top: 0 })
      expect(container.querySelector('.dnr-page-number')?.textContent).toBe('3 / 3')
    } finally { act(() => root.unmount()) }
  })
})
