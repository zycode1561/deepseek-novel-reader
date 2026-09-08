import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { calculateProgress } from '../../shared/progress.ts'
import { isToggleReaderShortcut } from '../shortcuts.ts'
import { useReader } from '../state/ReaderContext.tsx'
import { BookmarksPanel } from './BookmarksPanel.tsx'
import { FileLoader } from './FileLoader.tsx'
import { Icon } from './Icon.tsx'
import { ReaderBody, type ReaderBodyHandle } from './ReaderBody.tsx'
import { SearchPanel } from './SearchPanel.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import { TableOfContents } from './TableOfContents.tsx'

type View = 'reader' | 'toc' | 'search' | 'settings' | 'bookmarks' | 'file'

function durationLabel(seconds: number): string {
  if (seconds < 60) return '< 1 分钟'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

interface NovelReaderOverlayProps {
  onLayoutWidthChange: (width: number | null) => void
}

export function NovelReaderOverlay({ onLayoutWidthChange }: NovelReaderOverlayProps): JSX.Element {
  const {
    book, panel, settings, progress, notices, togglePanel, setPanelWidth,
    goToChapter, addBookmark, bookmarks,
  } = useReader()
  const [view, setView] = useState<View>('reader')
  const [searchQuery, setSearchQuery] = useState('')
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null)
  const readerBodyRef = useRef<ReaderBodyHandle>(null)
  const progressSnapshot = useMemo(() => book !== null && progress !== null
    ? calculateProgress(book, progress)
    : { chapterPercent: 0, bookPercent: 0 }, [book, progress])

  // Reflow the host conversation beside the reader whenever its width changes.
  useLayoutEffect(() => {
    onLayoutWidthChange(panel.expanded ? panel.width : null)
  }, [onLayoutWidthChange, panel.expanded, panel.width])

  useLayoutEffect(() => () => onLayoutWidthChange(null), [onLayoutWidthChange])

  useEffect(() => {
    if (drag === null) return
    const move = (event: PointerEvent): void => setPanelWidth(drag.startWidth + drag.startX - event.clientX)
    const stop = (): void => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [drag, setPanelWidth])

  useEffect(() => {
    const handleToggleShortcut = (event: KeyboardEvent): boolean => {
      if (!isToggleReaderShortcut(event, settings.toggleShortcut)) return false
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) togglePanel()
      return true
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      // App-owned dialogs (settings, attachment pickers, …) own keyboard input;
      // never act on reader shortcuts while one is open (e.g. DSH Desktop modal).
      if (document.querySelector('[aria-modal="true"]') !== null) return
      const target = event.target as HTMLElement | null
      // The shortcut editor owns key events while it is recording a new value.
      if (target?.closest('[data-shortcut-recorder="true"]') !== null) return
      // Handle the panel toggle before input and page-turn shortcuts so it
      // remains available while either expanded or collapsed.
      if (handleToggleShortcut(event)) return
      const editing = target?.matches('input, textarea, select, [contenteditable="true"]') ?? false
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault()
        setView('search')
        return
      }
      if (event.key === 'Escape' && view === 'search') {
        event.preventDefault()
        setView('reader')
        return
      }
      if (editing || view !== 'reader' || book === null || progress === null) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (settings.pageMode === 'paged') readerBodyRef.current?.turnPage(-1)
        else goToChapter(progress.chapterIndex - 1)
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (settings.pageMode === 'paged') readerBodyRef.current?.turnPage(1)
        else goToChapter(progress.chapterIndex + 1)
      }
    }
    // Capture before the host application handles navigation keys. DSH owns
    // document-level shortcuts that may otherwise stop the bubbling event.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [book, goToChapter, progress, settings.pageMode, settings.toggleShortcut, togglePanel, view])

  if (!panel.expanded) {
    return <button className="dnr-launcher" type="button" aria-label="打开小说阅读器" title="打开小说阅读器" onClick={togglePanel}><Icon name="book" width="20" height="20" /><span>阅读</span></button>
  }

  const currentChapter = progress?.chapterIndex ?? 0
  const currentChapterTitle = book?.chapters[currentChapter]?.title ?? ''
  const alreadyBookmarked = book !== null && progress !== null && bookmarks.some(item => item.paragraphIndex === progress.paragraphIndex)
  const showReader = book !== null && view === 'reader'

  return <aside
    className={`dnr-shell dnr-theme-${settings.theme} ${panel.toolsVisible ? '' : 'is-immersive'} ${drag !== null ? 'is-resizing' : ''}`}
    style={{ width: `${panel.width}px` }}
    aria-label="小说阅读器"
  >
    <div className="dnr-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整阅读器宽度" onPointerDown={event => {
      event.preventDefault()
      setDrag({ startX: event.clientX, startWidth: panel.width })
    }} />

    <button className="dnr-icon-button dnr-collapse-button" type="button" aria-label="收起阅读器" title="收起" onClick={togglePanel}><Icon name="chevron-right" /></button>
    {book === null
      ? <div className="dnr-top-spacer" aria-hidden="true" />
      : <div className="dnr-toolbar-dock">
        <div className="dnr-toolbar-dock-inner">
          <div className="dnr-top-spacer" aria-hidden="true" />
          <nav className="dnr-toolbar" aria-label="阅读工具">
            <button type="button" className={view === 'toc' ? 'is-active' : ''} onClick={() => setView(view === 'toc' ? 'reader' : 'toc')}><Icon name="toc" /><span>目录</span></button>
            <button type="button" className={view === 'search' ? 'is-active' : ''} onClick={() => setView(view === 'search' ? 'reader' : 'search')}><Icon name="search" /><span>搜索</span></button>
            <button type="button" className={alreadyBookmarked ? 'is-saved' : ''} onClick={addBookmark}><Icon name="bookmark" /><span>{alreadyBookmarked ? '已标记' : '书签'}</span></button>
            <button type="button" className={view === 'bookmarks' ? 'is-active' : ''} onClick={() => setView(view === 'bookmarks' ? 'reader' : 'bookmarks')}><Icon name="menu" /><span>书签夹</span></button>
            <button type="button" className={view === 'settings' ? 'is-active' : ''} onClick={() => setView(view === 'settings' ? 'reader' : 'settings')}><Icon name="settings" /><span>设置</span></button>
            <button type="button" className={view === 'file' ? 'is-active' : ''} onClick={() => setView(view === 'file' ? 'reader' : 'file')}><Icon name="file" /><span>文件</span></button>
          </nav>
        </div>
      </div>}

    {notices.length > 0 && book !== null && <div className="dnr-notice-strip">{notices[0]}</div>}

    <main className="dnr-main">
      {book === null && <FileLoader />}
      {book !== null && view === 'file' && <FileLoader compact />}
      {book !== null && view === 'toc' && <TableOfContents onSelect={() => setView('reader')} />}
      {book !== null && view === 'search' && <SearchPanel query={searchQuery} onQueryChange={setSearchQuery} onSelect={() => setView('reader')} />}
      {book !== null && view === 'settings' && <SettingsPanel />}
      {book !== null && view === 'bookmarks' && <BookmarksPanel onSelect={() => setView('reader')} />}
      {showReader && <div className={`dnr-reading-grid ${settings.tocPosition === 'left' ? 'has-toc' : ''}`}>
        {settings.tocPosition === 'left' && <TableOfContents embedded />}
        <ReaderBody ref={readerBodyRef} searchQuery={searchQuery} />
      </div>}
    </main>

    {showReader && progress !== null && <footer className="dnr-footer">
      <button type="button" onClick={() => goToChapter(currentChapter - 1)} disabled={currentChapter <= 0}><Icon name="chevron-left" /><span>上一章</span></button>
      {settings.footerDisplay === 'chapter-progress' ? <>
        <div className="dnr-chapter-progress" title={`本章 ${progressSnapshot.chapterPercent.toFixed(1)}%`}><i style={{ width: `${progressSnapshot.chapterPercent}%` }} /></div>
        <span className="dnr-reading-time"><Icon name="clock" width="14" height="14" />{durationLabel(progress.readingSeconds)}</span>
      </> : <span className="dnr-chapter-title" title={currentChapterTitle}>{currentChapterTitle}</span>}
      <button type="button" onClick={() => goToChapter(currentChapter + 1)} disabled={book === null || currentChapter >= book.chapters.length - 1}><span>下一章</span><Icon name="chevron-right" /></button>
    </footer>}
  </aside>
}
