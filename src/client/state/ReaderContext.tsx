import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren,
} from 'react'
import { MAX_PANEL_WIDTH, MIN_PANEL_WIDTH } from '../../shared/constants.ts'
import { loadBookFromFile } from '../../shared/file.ts'
import { createId } from '../../shared/id.ts'
import { calculateProgress } from '../../shared/progress.ts'
import { buildReadingBook, onlineReadingBookId } from '../../shared/online-reading.ts'
import { closeOnlineReading, getOnlineChapter, OnlineApiError, openOnlineReading } from '../online/api.ts'
import type {
  Book, Bookmark, PanelPreferences, ReaderSettings, ReadingPosition, RecentBook, OnlineReadingReference, OnlineReadingSession,
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
  startOnlineReading(resultId: string): Promise<void>
  retryOnlineChapter(): void
  openRecent(id: string): Promise<boolean>
  removeRecent(id: string): Promise<void>
  updateSettings(patch: Partial<ReaderSettings>): void
  updatePanel(patch: Partial<PanelPreferences>): void
  togglePanel(): void
  setPanelWidth(width: number): void
  goToChapter(index: number): void
  goToParagraph(index: number, chapterIndex?: number): void
  markParagraphVisible(index: number, scrollOffset?: number): void
  clearPendingParagraph(): void
  addBookmark(): void
  removeBookmark(id: string): void
  clearError(): void
}

const ReaderContext = createContext<ReaderContextValue | null>(null)

function initialPosition(book: Book, saved: Record<string, ReadingPosition>): ReadingPosition {
  const position = saved[book.id] ?? {
    bookId: book.id,
    chapterIndex: 0,
    paragraphIndex: book.chapters[0]?.paragraphStart ?? 0,
    scrollOffset: 0,
    updatedAt: Date.now(),
    readingSeconds: 0,
  }
  if (!book.onlineReading) return position
  const chapterIndex = book.onlineReading.chapterIndex
  return {
    ...position, chapterIndex,
    paragraphIndex: position.chapterIndex === chapterIndex
      ? Math.max(0, Math.min(book.paragraphs.length - 1, position.paragraphIndex)) : 0,
    scrollOffset: position.chapterIndex === chapterIndex ? position.scrollOffset : 0,
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
    ...(book.onlineReading ? { onlineReading: book.onlineReading.reference } : {}),
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
  const readingSession = useRef<OnlineReadingSession | null>(null)
  const readingRequest = useRef<AbortController | null>(null)
  const failedChapter = useRef<{ index: number; paragraphIndex: number } | null>(null)

  useEffect(() => () => {
    readingRequest.current?.abort()
    if (readingSession.current) void closeOnlineReading(readingSession.current.id).catch(() => {})
  }, [])

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
    if (!nextBook.onlineReading && readingSession.current) {
      void closeOnlineReading(readingSession.current.id).catch(() => {})
      readingSession.current = null
    }
    failedChapter.current = null
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
    readingRequest.current?.abort()
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
    readingRequest.current?.abort()
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

  const fetchReadingChapter = useCallback(async (session: OnlineReadingSession, index: number, signal: AbortSignal) => {
    let current = session
    let chapter
    try { chapter = await getOnlineChapter(current.id, index, signal) } catch (caught) {
      if (!(caught instanceof OnlineApiError) || caught.code !== 'READING_EXPIRED' || signal.aborted) throw caught
      current = await openOnlineReading({ reference: session.reference }, signal)
      try { chapter = await getOnlineChapter(current.id, index, signal) } catch (error) {
        void closeOnlineReading(current.id).catch(() => {})
        throw error
      }
    }
    if (signal.aborted) {
      if (current.id !== session.id) void closeOnlineReading(current.id).catch(() => {})
      signal.throwIfAborted()
    }
    try { return { session: current, book: buildReadingBook(current, chapter) } } catch (error) {
      if (current.id !== session.id) void closeOnlineReading(current.id).catch(() => {})
      throw error
    }
  }, [])

  const openReading = useCallback(async (input: { resultId: string } | { reference: OnlineReadingReference }) => {
    readingRequest.current?.abort()
    const controller = new AbortController()
    readingRequest.current = controller
    setLoading(true)
    setError(null)
    let openedSession: OnlineReadingSession | undefined
    try {
      openedSession = await openOnlineReading(input, controller.signal)
      controller.signal.throwIfAborted()
      const saved = progressByBook[onlineReadingBookId(openedSession.reference)]
      const index = Math.max(0, Math.min(openedSession.chapters.length - 1, saved?.chapterIndex ?? 0))
      const loaded = await fetchReadingChapter(openedSession, index, controller.signal)
      if (readingSession.current) void closeOnlineReading(readingSession.current.id).catch(() => {})
      readingSession.current = loaded.session
      setNotices(['在线按章阅读：正文仅保留在内存，搜索仅覆盖当前章节。'])
      activateBook(loaded.book)
    } catch (caught) {
      if (openedSession) void closeOnlineReading(openedSession.id).catch(() => {})
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '在线阅读失败。')
      throw caught
    } finally {
      if (readingRequest.current === controller) setLoading(false)
    }
  }, [activateBook, fetchReadingChapter, progressByBook])

  const startOnlineReading = useCallback(async (resultId: string) => {
    await openReading({ resultId })
  }, [openReading])

  const loadReadingChapter = useCallback(async (index: number, paragraphIndex = 0) => {
    const session = readingSession.current
    if (!session) return
    readingRequest.current?.abort()
    const controller = new AbortController()
    readingRequest.current = controller
    failedChapter.current = { index, paragraphIndex }
    setLoading(true)
    setError(null)
    try {
      const loaded = await fetchReadingChapter(session, index, controller.signal)
      readingSession.current = loaded.session
      const target = Math.max(0, Math.min(loaded.book.paragraphs.length - 1, paragraphIndex))
      setBook(loaded.book)
      setProgressByBook(current => ({ ...current, [loaded.book.id]: {
        ...initialPosition(loaded.book, current), chapterIndex: index, paragraphIndex: target, scrollOffset: 0, updatedAt: Date.now(),
      } }))
      setPendingParagraph(target)
      failedChapter.current = null
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '章节加载失败。')
    } finally {
      if (readingRequest.current === controller) setLoading(false)
    }
  }, [fetchReadingChapter])

  const retryOnlineChapter = useCallback(() => {
    const target = failedChapter.current
    if (target) void loadReadingChapter(target.index, target.paragraphIndex)
  }, [loadReadingChapter])

  const openRecent = useCallback(async (id: string) => {
    if (book?.id === id && book.onlineReading) {
      setPanel(current => ({ ...current, expanded: true }))
      setError(null)
      return true
    }
    const recent = recents.find(item => item.id === id)
    if (recent?.onlineReading) {
      try { await openReading({ reference: recent.onlineReading }); return true } catch { return false }
    }
    readingRequest.current?.abort()
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
  }, [activateBook, book, openReading, recents])

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
    if (book.onlineReading) {
      void loadReadingChapter(chapter.index)
      return
    }
    const paragraphIndex = chapter.paragraphStart
    setProgressByBook(current => ({
      ...current,
      [book.id]: {
        ...initialPosition(book, current), chapterIndex: chapter.index,
        paragraphIndex, scrollOffset: 0, updatedAt: Date.now(),
      },
    }))
    setPendingParagraph(paragraphIndex)
  }, [book, loadReadingChapter])

  const goToParagraph = useCallback((paragraphIndex: number, targetChapterIndex?: number) => {
    if (book === null) return
    if (book.onlineReading && targetChapterIndex !== undefined && targetChapterIndex !== book.onlineReading.chapterIndex) {
      void loadReadingChapter(targetChapterIndex, paragraphIndex)
      return
    }
    if (book.onlineReading) {
      readingRequest.current?.abort()
      failedChapter.current = null
      setLoading(false)
      setError(null)
    }
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
  }, [book, loadReadingChapter])

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
      const duplicate = current.some(item => item.bookId === book.id && item.chapterIndex === progress.chapterIndex && item.paragraphIndex === paragraph.index)
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
    loadFile, loadOnlineBook, startOnlineReading, retryOnlineChapter, openRecent, removeRecent, updateSettings, updatePanel, togglePanel,
    setPanelWidth, goToChapter, goToParagraph, markParagraphVisible,
    clearPendingParagraph: () => setPendingParagraph(null),
    addBookmark, removeBookmark, clearError: () => setError(null),
  }), [
    book, settings, panel, progress, bookmarks, recents, loading, error, notices,
    pendingParagraph, loadFile, loadOnlineBook, startOnlineReading, retryOnlineChapter, openRecent, removeRecent, updateSettings,
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
