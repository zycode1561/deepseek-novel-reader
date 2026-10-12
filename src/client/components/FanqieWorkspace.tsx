import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FanqieOpen, FanqieShelfBook, FanqieStatus, FanqieText } from '../../shared/fanqie.ts'
import { buildReadingBook } from '../../shared/online-reading.ts'
import type { Book, OnlineReadingSession, ReadingPosition } from '../../shared/types.ts'
import { FanqieApiError, getFanqieStatus, openFanqieBook, readFanqieChapter, saveFanqiePosition } from '../fanqie/api.ts'
import { ReaderContext, useReader, type ReaderContextValue } from '../state/ReaderContext.tsx'
import { FanqiePanel } from './FanqiePanel.tsx'
import { Icon } from './Icon.tsx'
import { ReaderBody, type ReaderBodyHandle } from './ReaderBody.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import { TableOfContents } from './TableOfContents.tsx'

function readingBook(open: FanqieOpen, text: FanqieText, index: number): Book {
  const session: OnlineReadingSession = { id: `${open.accountId}:${open.bookId}`, sourceName: '番茄小说', chapters: open.chapters,
    reference: { sourceId: 'fanqie', bookUrl: `https://fanqienovel.com/page/${open.bookId}`, bookName: open.name, keyword: open.name } }
  return { ...buildReadingBook(session, { index, title: text.title, paragraphs: text.paragraphs }), id: `fanqie-${open.bookId}` }
}

/** Separate reading state and Host API; no local books, recents or progress are written. */
export function FanqieWorkspace({ active, toolbarTarget = null }: { active: boolean; toolbarTarget?: HTMLElement | null }): JSX.Element {
  const local = useReader()
  const [status, updateStatus] = useState<FanqieStatus | null>(null)
  const [book, setBook] = useState<Book | null>(null)
  const [progress, setProgress] = useState<ReadingPosition | null>(null)
  const [pendingParagraph, setPendingParagraph] = useState<number | null>(null)
  const [view, setView] = useState<'shelf' | 'reader' | 'toc' | 'settings'>('shelf')
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fontFamily, setFontFamily] = useState<string | undefined>()
  const [failedIndex, setFailedIndex] = useState<number | null>(null)
  const opened = useRef<FanqieOpen | null>(null)
  const committed = useRef<FanqieOpen | null>(null)
  const accountId = useRef<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const snapshot = useRef({ book, progress }); snapshot.current = { book, progress }
  const readerBody = useRef<ReaderBodyHandle>(null)
  const fonts = useRef(new Map<string, { face: FontFace; family: string }>())

  const flushPosition = useCallback(() => {
    const session = committed.current, position = snapshot.current.progress
    if (!session || !position || snapshot.current.book?.id !== `fanqie-${session.bookId}` || accountId.current !== session.accountId) return
    const chapter = session.chapters[position.chapterIndex]
    if (chapter) void saveFanqiePosition(session.accountId, session.bookId, { chapterId: chapter.id, paragraphIndex: position.paragraphIndex,
      remoteChapterId: session.remoteChapterId, updatedAt: position.updatedAt }).catch(() => {})
  }, [])

  const setStatus = useCallback((value: FanqieStatus) => {
    if (accountId.current !== value.accountId) {
      generation.current++; request.current?.abort(); opened.current = null; committed.current = null
      setBook(null); setProgress(null); setFontFamily(undefined); setView('shelf'); setLoading(false); setError(null)
    }
    accountId.current = value.accountId; updateStatus(value)
  }, [])
  const refreshStatus = useCallback(async () => { const value = await getFanqieStatus(); setStatus(value); return value }, [setStatus])
  const account = useMemo(() => ({ status, setStatus, refreshStatus }), [status, setStatus, refreshStatus])

  useEffect(() => () => {
    generation.current++; request.current?.abort()
    flushPosition()
    for (const font of fonts.current.values()) document.fonts.delete(font.face)
    fonts.current.clear()
  }, [flushPosition])
  useEffect(() => {
    if (!active) { flushPosition(); generation.current++; request.current?.abort(); setLoading(false) }
  }, [active, flushPosition])

  const installFont = async (text: FanqieText, signal: AbortSignal): Promise<string | undefined> => {
    if (!text.fontData) return undefined
    const cached = fonts.current.get(text.fontData)
    if (cached) return cached.family
    const family = `dnr-fanqie-${fonts.current.size}`
    const face = new FontFace(family, `url(${text.fontData})`, { unicodeRange: 'U+E000-F8FF' })
    await face.load(); signal.throwIfAborted()
    document.fonts.add(face); fonts.current.set(text.fontData, { face, family })
    return family
  }
  const showChapter = async (session: FanqieOpen, index: number, paragraph: number, signal: AbortSignal, gen: number) => {
    const chapter = session.chapters[index]
    if (!chapter) throw new Error('未找到该章节。')
    const text = await readFanqieChapter(session.accountId, session.bookId, chapter.id, signal)
    signal.throwIfAborted()
    if (text.id !== chapter.id) throw new Error('章节响应与请求不匹配。')
    const family = await installFont(text, signal)
    signal.throwIfAborted()
    if (gen !== generation.current || accountId.current !== session.accountId) return
    const nextBook = readingBook(session, text, index)
    const target = Math.max(0, Math.min(nextBook.paragraphs.length - 1, paragraph))
    opened.current = session; committed.current = session
    setBook(nextBook); setProgress({ bookId: nextBook.id, chapterIndex: index, paragraphIndex: target, scrollOffset: 0, updatedAt: Date.now(), readingSeconds: 0 })
    setFontFamily(family); setPendingParagraph(target); setFailedIndex(null); setView('reader')
  }
  const handleError = (caught: unknown, signal: AbortSignal, gen: number) => {
    if (signal.aborted || gen !== generation.current) return
    setError(caught instanceof Error ? caught.message : '读取番茄章节失败。')
    if (caught instanceof FanqieApiError && caught.code === 'AUTH_EXPIRED') void refreshStatus().catch(() => {})
  }
  const open = useCallback(async (item: Pick<FanqieShelfBook, 'id' | 'name'>, fromPhone = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    const gen = ++generation.current
    setLoading(true); setError(null)
    if (committed.current?.bookId !== item.id) {
      flushPosition(); setBook(null); setProgress(null); opened.current = null; committed.current = null; setView('shelf')
    }
    try {
      const session = await openFanqieBook(item.id, item.name, controller.signal, fromPhone)
      controller.signal.throwIfAborted()
      if (gen !== generation.current || session.accountId !== accountId.current) return
      opened.current = session; setFailedIndex(session.chapterIndex)
      const current = snapshot.current
      const paragraph = fromPhone && current.book?.id === `fanqie-${session.bookId}` && current.progress?.chapterIndex === session.chapterIndex
        ? current.progress.paragraphIndex : session.paragraphIndex
      await showChapter(session, session.chapterIndex, paragraph, controller.signal, gen)
    } catch (caught) { handleError(caught, controller.signal, gen) }
    finally { if (gen === generation.current) setLoading(false) }
  }, [refreshStatus, flushPosition])
  const goToChapter = useCallback((index: number, paragraph = 0) => {
    const session = opened.current
    if (!session || !Number.isSafeInteger(index) || !session.chapters[index]) return
    request.current?.abort(); const controller = new AbortController(); request.current = controller
    const gen = ++generation.current
    setLoading(true); setError(null); setFailedIndex(index)
    void showChapter(session, index, paragraph, controller.signal, gen).catch(caught => handleError(caught, controller.signal, gen))
      .finally(() => { if (gen === generation.current) setLoading(false) })
  }, [refreshStatus])

  useEffect(() => {
    const session = committed.current
    if (!session || !book || !progress || loading || error || book.id !== `fanqie-${session.bookId}` || session.accountId !== status?.accountId) return
    const chapter = session.chapters[progress.chapterIndex]
    if (!chapter) return
    const timer = setTimeout(() => {
      void saveFanqiePosition(session.accountId, session.bookId, { chapterId: chapter.id, paragraphIndex: progress.paragraphIndex,
        remoteChapterId: session.remoteChapterId, updatedAt: progress.updatedAt }).catch(caught => {
        if (accountId.current === session.accountId) setError(caught instanceof Error ? caught.message : '保存番茄阅读位置失败。')
      })
    }, 500)
    return () => clearTimeout(timer)
  }, [book, progress, loading, error, status?.accountId])

  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (!local.panel.expanded || document.querySelector('[aria-modal="true"]') || event.defaultPrevented
        || (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]'))) return
      if (event.key === 'Escape' && view !== 'reader' && book) { setView('reader'); event.preventDefault(); return }
      if (view !== 'reader' || !progress || loading) return
      const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
      if (!direction) return
      event.preventDefault()
      if (local.settings.pageMode === 'paged') readerBody.current?.turnPage(direction)
      else goToChapter(progress.chapterIndex + direction)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [active, book, view, progress, loading, local.panel.expanded, local.settings.pageMode, goToChapter])

  const context: ReaderContextValue = {
    ...local, book, progress, loading, error, pendingParagraph, recents: [], bookmarks: [], notices: [],
    clearError: () => setError(null), clearPendingParagraph: () => setPendingParagraph(null),
    goToChapter, goToParagraph: (index, chapterIndex) => {
      if (chapterIndex !== undefined && chapterIndex !== progress?.chapterIndex) goToChapter(chapterIndex, index)
      else { setPendingParagraph(index); setProgress(current => current ? { ...current, paragraphIndex: index, updatedAt: Date.now() } : null) }
    },
    markParagraphVisible: (index, scrollOffset) => setProgress(current => current
      ? { ...current, paragraphIndex: index, scrollOffset: scrollOffset ?? current.scrollOffset, updatedAt: Date.now() } : null),
    loadFile: async () => false, loadOnlineBook: async () => {}, startOnlineReading: async () => {},
    openRecent: async () => false, removeRecent: async () => {}, addBookmark: () => {}, removeBookmark: () => {},
    applySyncedChapter: async () => null,
  }
  const fallbackChapter = opened.current?.chapters[failedIndex ?? progress?.chapterIndex ?? 0]?.id
  const toolbar = book && active ? <div className="dnr-fanqie-toolbar">
    <nav className="dnr-fanqie-navigation" aria-label="番茄阅读工具">
      <button type="button" aria-label="番茄书架" title="番茄书架" aria-current={view === 'shelf' ? 'page' : undefined} className={view === 'shelf' ? 'is-active' : ''} onClick={() => setView('shelf')}><Icon name="library" /><span>书架</span></button>
      <button type="button" aria-current={view === 'reader' ? 'page' : undefined} className={view === 'reader' ? 'is-active' : ''} onClick={() => setView('reader')}><Icon name="book" /><span>正文</span></button>
      <button type="button" aria-current={view === 'toc' ? 'page' : undefined} className={view === 'toc' ? 'is-active' : ''} onClick={() => setView(view === 'toc' ? 'reader' : 'toc')}><Icon name="toc" /><span>目录</span></button>
      <button type="button" aria-current={view === 'settings' ? 'page' : undefined} className={view === 'settings' ? 'is-active' : ''} onClick={() => setView(view === 'settings' ? 'reader' : 'settings')}><Icon name="settings" /><span>设置</span></button>
    </nav>
    <button className={`dnr-fanqie-sync ${syncing ? 'is-syncing' : ''}`} type="button" aria-label="同步手机进度" title="同步手机阅读进度" aria-busy={syncing} disabled={loading} onClick={() => {
      if (!opened.current) return
      setSyncing(true)
      void open({ id: opened.current.bookId, name: opened.current.name }, true).finally(() => setSyncing(false))
    }}><Icon name="sync" /><span>{syncing ? '同步中…' : '同步进度'}</span></button>
  </div> : null
  return <ReaderContext.Provider value={context}><div className="dnr-fanqie-workspace">
    {toolbarTarget ? createPortal(toolbar, toolbarTarget) : toolbar}
    {loading && <div className="dnr-notice-strip" role="status">正在加载番茄章节…</div>}
    {error && <div className="dnr-alert" role="alert">{error}
      <button type="button" disabled={loading} onClick={() => { if (failedIndex !== null) goToChapter(failedIndex); else setError(null) }}>重试</button>
      {fallbackChapter && <a href={`https://fanqienovel.com/reader/${fallbackChapter}`} target="_blank" rel="noreferrer">前往番茄官网阅读</a>}
    </div>}
    {view === 'shelf' && <FanqiePanel account={account} onRead={item => { void open(item) }} opening={loading} />}
    {book && view === 'toc' && <TableOfContents onSelect={() => setView('reader')} />}
    {book && view === 'settings' && <SettingsPanel />}
    {book && view === 'reader' && active && <>
      <div className={`dnr-reading-grid ${local.settings.tocPosition === 'left' ? 'has-toc' : ''}`}>
        {local.settings.tocPosition === 'left' && <TableOfContents embedded />}
        <ReaderBody ref={readerBody} searchQuery="" {...(fontFamily ? { glyphFont: fontFamily } : {})} />
      </div>
      <footer className="dnr-footer">
        <button type="button" disabled={loading || !progress || progress.chapterIndex === 0} onClick={() => goToChapter(progress!.chapterIndex - 1)}>上一章</button>
        <span className="dnr-chapter-title">{book.chapters[progress?.chapterIndex ?? 0]?.title}</span>
        <button type="button" disabled={loading || !progress || progress.chapterIndex >= book.chapters.length - 1} onClick={() => goToChapter(progress!.chapterIndex + 1)}>下一章</button>
      </footer>
    </>}
  </div></ReaderContext.Provider>
}
