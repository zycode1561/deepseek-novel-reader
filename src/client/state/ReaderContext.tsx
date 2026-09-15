import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren,
} from 'react'
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from '../../shared/constants.ts'
import { loadBookFromFile } from '../../shared/file.ts'
import { createId } from '../../shared/id.ts'
import { calculateProgress } from '../../shared/progress.ts'
import type {
  Book, Bookmark, PanelPreferences, ReaderSettings, ReadingPosition, RecentBook,
} from '../../shared/types.ts'
import { deleteBook, getBook, saveBook } from '../storage/books.ts'
import {
  hydrateFromHost, loadBookmarks, loadPanel, loadProgress, loadRecents, loadSettings,
  saveBookmarks, savePanel, saveProgress, saveRecents, saveSettings, syncToHost,
} from '../storage/local.ts'

interface ReaderContextValue {
  book: Book | null
  settings: ReaderSettings
  panel: PanelPreferences
  progress: ReadingPosition | null
  bookmarks: Bookmark[]
  recents: RecentBook[]
  loading: boolean
  error: string | null
  notices: string[]
  pendingParagraph: number | null
  loadFile(file: File): Promise<boolean>
  loadOnlineBook(book: Book): Promise<void>
  openRecent(id: string): Promise<boolean>
  removeRecent(id: string): Promise<void>
  updateSettings(patch: Partial<ReaderSettings>): void
  updatePanel(patch: Partial<PanelPreferences>): void
  togglePanel(): void
  setPanelWidth(width: number): void
  goToChapter(index: number): void
  goToParagraph(index: number): void
  markParagraphVisible(index: number, scrollOffset?: number): void
  clearPendingParagraph(): void
  addBookmark(): void
  removeBookmark(id: string): void
  clearError(): void
}

const ReaderContext = createContext<ReaderContextValue | null>(null)

function initialPosition(book: Book, saved: Record<string, ReadingPosition>): ReadingPosition {
  return saved[book.id] ?? {
    bookId: book.id,
    chapterIndex: 0,
    paragraphIndex: book.chapters[0]?.paragraphStart ?? 0,
    scrollOffset: 0,
    updatedAt: Date.now(),
    readingSeconds: 0,
  }
}

function recentFromBook(book: Book, position: ReadingPosition): RecentBook {
  return {
    id: book.id,
    name: book.name,
    size: book.size,
    encoding: book.encoding,
    openedAt: Date.now(),
    format: book.format,
    progressPercent: Math.round(calculateProgress(book, position).bookPercent),
  }
}

export function ReaderProvider({ children }: PropsWithChildren): JSX.Element {
  const [book, setBook] = useState<Book | null>(null)
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings)
  const [panel, setPanel] = useState<PanelPreferences>(loadPanel)
  const [progressByBook, setProgressByBook] = useState<Record<string, ReadingPosition>>(loadProgress)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks)
  const [recents, setRecents] = useState<RecentBook[]>(loadRecents)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [pendingParagraph, setPendingParagraph] = useState<number | null>(null)
  const hostHydrated = useRef(false)

  const progress = book === null ? null : initialPosition(book, progressByBook)
  const activeBookProgressPercent = useMemo(() => {
    if (book === null || progress === null) return null
    return Math.round(calculateProgress(book, progress).bookPercent)
  }, [book, progress?.chapterIndex, progress?.paragraphIndex])

  // Hydrate the browser caches from the durable host copy on mount. Until
  // this settles, local writes must not sync back to the host (they could
  // clobber newer host data with stale per-launch-origin caches).
  useEffect(() => {
    let cancelled = false
    void hydrateFromHost().then((hydrated) => {
      if (cancelled) return
      hostHydrated.current = true
      if (!hydrated) return
      setSettings(loadSettings())
      setPanel(loadPanel())
      setProgressByBook(loadProgress())
      setBookmarks(loadBookmarks())
      setRecents(loadRecents())
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => saveSettings(settings), [settings])
  useEffect(() => savePanel(panel), [panel])
  useEffect(() => saveProgress(progressByBook), [progressByBook])
  useEffect(() => saveBookmarks(bookmarks), [bookmarks])
  useEffect(() => saveRecents(recents), [recents])

  // Keep a lightweight progress snapshot with the recent-book metadata. This
  // avoids loading every cached book body just to render the recent list.
  useEffect(() => {
    if (book === null || activeBookProgressPercent === null) return
    setRecents((current) => {
      const index = current.findIndex(item => item.id === book.id)
      if (index < 0 || current[index]?.progressPercent === activeBookProgressPercent) return current
      return current.map((item, itemIndex) => itemIndex === index
        ? { ...item, progressPercent: activeBookProgressPercent }
        : item)
    })
  }, [activeBookProgressPercent, book])

  // Debounced push of every local change to the durable host store.
  useEffect(() => {
    if (!hostHydrated.current) return
    const timer = globalThis.setTimeout(() => { void syncToHost() }, 800)
    return () => globalThis.clearTimeout(timer)
  }, [settings, panel, progressByBook, bookmarks, recents])

  // Reading-time accounting pauses when the tab is hidden or the panel is closed.
  useEffect(() => {
    if (book === null || !panel.expanded) return
    const timer = globalThis.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      setProgressByBook((current) => {
        const position = initialPosition(book, current)
        return {
          ...current,
          [book.id]: { ...position, readingSeconds: position.readingSeconds + 15, updatedAt: Date.now() },
        }
      })
    }, 15_000)
    return () => globalThis.clearInterval(timer)
  }, [book, panel.expanded])

  const activateBook = useCallback((nextBook: Book) => {
    const nextPosition = initialPosition(nextBook, progressByBook)
    setBook(nextBook)
    setProgressByBook((current) => ({
      ...current,
      [nextBook.id]: initialPosition(nextBook, current),
    }))
    setPendingParagraph(nextPosition.paragraphIndex)
    setRecents((current) => [recentFromBook(nextBook, nextPosition), ...current.filter(item => item.id !== nextBook.id)].slice(0, 10))
    setPanel((current) => ({ ...current, expanded: true }))
  }, [progressByBook])

  const loadFile = useCallback(async (file: File) => {
    setLoading(true)
    setError(null)
    setNotices([])
    try {
      const result = await loadBookFromFile(file)
      try {
        await saveBook(result.book)
      } catch {
        result.warnings.push('浏览器存储空间不足：本次可正常阅读，但“最近打开”可能无法离线恢复正文。')
      }
      setNotices(result.warnings)
      activateBook(result.book)
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '文件读取失败。')
      return false
    } finally {
      setLoading(false)
    }
  }, [activateBook])

  const loadOnlineBook = useCallback(async (onlineBook: Book) => {
    setLoading(true)
    setError(null)
    setNotices([])
    try {
      await saveBook(onlineBook)
      setNotices(onlineBook.largeFileMode ? ['正文超过 10MB，已启用大文件模式。'] : [])
      activateBook(onlineBook)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '在线书籍保存失败。')
      throw caught
    } finally {
      setLoading(false)
    }
  }, [activateBook])

  const openRecent = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const stored = await getBook(id)
      if (stored === undefined) throw new Error('未找到缓存正文，请重新选择原文件。')
      activateBook({ ...stored, openedAt: Date.now() })
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '最近文件打开失败。')
      return false
    } finally {
      setLoading(false)
    }
  }, [activateBook])

  const removeRecent = useCallback(async (id: string) => {
    setRecents(current => current.filter(item => item.id !== id))
    try {
      await deleteBook(id)
    } catch {
      // Metadata is already removed. A stale cache entry is harmless.
    }
  }, [])

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings(current => ({ ...current, ...patch }))
  }, [])

  const updatePanel = useCallback((patch: Partial<PanelPreferences>) => {
    setPanel(current => ({ ...current, ...patch }))
  }, [])

  const togglePanel = useCallback(() => {
    setPanel(current => ({ ...current, expanded: !current.expanded }))
  }, [])

  const setPanelWidth = useCallback((width: number) => {
    const nextWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.round(width)))
    setPanel(current => ({ ...current, width: nextWidth }))
  }, [])

  const goToChapter = useCallback((chapterIndex: number) => {
    if (book === null) return
    const chapter = book.chapters[Math.max(0, Math.min(book.chapters.length - 1, chapterIndex))]
    if (chapter === undefined) return
    const paragraphIndex = chapter.paragraphStart
    setProgressByBook(current => ({
      ...current,
      [book.id]: {
        ...initialPosition(book, current), chapterIndex: chapter.index,
        paragraphIndex, scrollOffset: 0, updatedAt: Date.now(),
      },
    }))
    setPendingParagraph(paragraphIndex)
  }, [book])

  const goToParagraph = useCallback((paragraphIndex: number) => {
    if (book === null) return
    const chapter = book.chapters.find(item =>
      paragraphIndex >= item.paragraphStart && paragraphIndex <= item.paragraphEnd,
    ) ?? book.chapters[0]
    if (chapter === undefined) return
    setProgressByBook(current => ({
      ...current,
      [book.id]: {
        ...initialPosition(book, current), chapterIndex: chapter.index,
        paragraphIndex, scrollOffset: 0, updatedAt: Date.now(),
      },
    }))
    setPendingParagraph(paragraphIndex)
  }, [book])

  const markParagraphVisible = useCallback((paragraphIndex: number, scrollOffset = 0) => {
    if (book === null) return
    const chapterIndex = book.chapters.find(item =>
      paragraphIndex >= item.paragraphStart && paragraphIndex <= item.paragraphEnd,
    )?.index ?? 0
    setProgressByBook(current => ({
      ...current,
      [book.id]: {
        ...initialPosition(book, current), chapterIndex, paragraphIndex,
        scrollOffset, updatedAt: Date.now(),
      },
    }))
  }, [book])

  const addBookmark = useCallback(() => {
    if (book === null || progress === null) return
    const paragraph = book.paragraphs[progress.paragraphIndex]
    if (paragraph === undefined) return
    setBookmarks((current) => {
      const duplicate = current.some(item => item.bookId === book.id && item.paragraphIndex === paragraph.index)
      if (duplicate) return current
      return [{
        id: createId('bookmark'), bookId: book.id,
        chapterIndex: progress.chapterIndex, paragraphIndex: paragraph.index,
        excerpt: paragraph.text.slice(0, 80), createdAt: Date.now(),
      }, ...current]
    })
  }, [book, progress])

  const removeBookmark = useCallback((id: string) => {
    setBookmarks(current => current.filter(item => item.id !== id))
  }, [])

  const value = useMemo<ReaderContextValue>(() => ({
    book, settings, panel, progress,
    bookmarks: book === null ? [] : bookmarks.filter(item => item.bookId === book.id),
    recents, loading, error, notices, pendingParagraph,
    loadFile, loadOnlineBook, openRecent, removeRecent, updateSettings, updatePanel, togglePanel,
    setPanelWidth, goToChapter, goToParagraph, markParagraphVisible,
    clearPendingParagraph: () => setPendingParagraph(null),
    addBookmark, removeBookmark, clearError: () => setError(null),
  }), [
    book, settings, panel, progress, bookmarks, recents, loading, error, notices,
    pendingParagraph, loadFile, loadOnlineBook, openRecent, removeRecent, updateSettings,
    updatePanel, togglePanel, setPanelWidth, goToChapter, goToParagraph,
    markParagraphVisible, addBookmark, removeBookmark,
  ])

  return <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>
}

export function useReader(): ReaderContextValue {
  const value = useContext(ReaderContext)
  if (value === null) throw new Error('useReader must be used inside ReaderProvider')
  return value
}
