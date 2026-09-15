import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  hasLauncherDragExceededThreshold,
  launcherYRatioFromPointer,
  normalizeLauncherYRatio,
} from '../../shared/launcher-position.ts'
import { calculateProgress } from '../../shared/progress.ts'
import { isToggleReaderShortcut } from '../shortcuts.ts'
import { useReader } from '../state/ReaderContext.tsx'
import { BookmarksPanel } from './BookmarksPanel.tsx'
import { FileLoader } from './FileLoader.tsx'
import { Icon } from './Icon.tsx'
import { OnlineSearchPanel } from './OnlineSearchPanel.tsx'
import { ReaderBody, type ReaderBodyHandle } from './ReaderBody.tsx'
import { SearchPanel } from './SearchPanel.tsx'
import { SettingsPanel } from './SettingsPanel.tsx'
import { TableOfContents } from './TableOfContents.tsx'

type View = 'reader' | 'toc' | 'search' | 'online' | 'settings' | 'bookmarks' | 'file'

function durationLabel(seconds: number): string {
  if (seconds < 60) return '< 1 分钟'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

interface NovelReaderOverlayProps {
  onLayoutWidthChange: (width: number | null) => void
}

interface LauncherDragState {
  pointerId: number
  startClientY: number
  pointerOffsetY: number
  overlayTop: number
  overlayHeight: number
  launcherHeight: number
  moved: boolean
}

export function NovelReaderOverlay({ onLayoutWidthChange }: NovelReaderOverlayProps): JSX.Element {
  const {
    book, panel, settings, progress, notices, togglePanel, setPanelWidth,
    goToChapter, addBookmark, bookmarks, updatePanel,
  } = useReader()
  const [view, setView] = useState<View>('reader')
  const [searchQuery, setSearchQuery] = useState('')
  const [drag, setDrag] = useState<{ startX: number; startWidth: number } | null>(null)
  const [launcherDragRatio, setLauncherDragRatio] = useState<number | null>(null)
  const returnToReader = useCallback(() => setView('reader'), [])
  const launcherDragRef = useRef<LauncherDragState | null>(null)
  const suppressPointerClickUntilRef = useRef(0)
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
      if (book !== null && (event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'f') {
        event.preventDefault()
        setView('search')
        return
      }
      if (event.key === 'Escape' && (view === 'search' || view === 'online')) {
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

  const ratioForLauncherPointer = (event: ReactPointerEvent<HTMLButtonElement>, state: LauncherDragState): number => {
    // Keep the original grab point under the pointer instead of snapping the
    // button's center to the pointer as soon as dragging begins.
    const launcherCenterY = event.clientY - state.pointerOffsetY + state.launcherHeight / 2
    return launcherYRatioFromPointer(
      launcherCenterY,
      state.overlayTop,
      state.overlayHeight,
      state.launcherHeight,
    )
  }

  const onLauncherPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return

    const launcherRect = event.currentTarget.getBoundingClientRect()
    // shell.overlay is the true visible content area in all DSH Desktop modes;
    // its top edge already excludes the native title bar where applicable.
    const overlay = event.currentTarget.closest<HTMLElement>('[data-shell-overlay]')
    const overlayRect = overlay?.getBoundingClientRect()
    const overlayTop = overlayRect?.top ?? 0
    const overlayHeight = overlayRect?.height ?? globalThis.innerHeight
    if (!Number.isFinite(overlayHeight) || overlayHeight <= 0) return

    launcherDragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      pointerOffsetY: event.clientY - launcherRect.top,
      overlayTop,
      overlayHeight,
      launcherHeight: launcherRect.height,
      moved: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Some embedded WebViews reject capture during teardown. Local pointer
      // events still keep a short click functional in that case.
    }
  }

  const onLauncherPointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = launcherDragRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    if (!state.moved && hasLauncherDragExceededThreshold(state.startClientY, event.clientY)) {
      state.moved = true
    }
    if (!state.moved) return
    event.preventDefault()
    setLauncherDragRatio(ratioForLauncherPointer(event, state))
  }

  const onLauncherPointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = launcherDragRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    const moved = state.moved
      || hasLauncherDragExceededThreshold(state.startClientY, event.clientY)
    const finalRatio = moved ? ratioForLauncherPointer(event, state) : null

    // Clear the session before releasing capture: releasePointerCapture emits
    // lostpointercapture, which must not turn a successful drop into a cancel.
    launcherDragRef.current = null
    setLauncherDragRatio(null)
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Capture can already have been released by the WebView.
    }

    if (finalRatio !== null) {
      suppressPointerClickUntilRef.current = performance.now() + 300
      updatePanel({ launcherYRatio: finalRatio })
    }
  }

  const cancelLauncherDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const state = launcherDragRef.current
    if (state === null || state.pointerId !== event.pointerId) return
    // A cancelled capture is not a completed user choice: discard the
    // transient position and leave the persisted ratio untouched.
    launcherDragRef.current = null
    setLauncherDragRatio(null)
  }

  const onLauncherClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    // Pointer-generated click follows pointerup. Keyboard activation has
    // detail=0 and remains available even immediately after a drag.
    if (event.detail > 0 && performance.now() < suppressPointerClickUntilRef.current) {
      event.preventDefault()
      return
    }
    togglePanel()
  }

  if (!panel.expanded) {
    const launcherYRatio = launcherDragRatio ?? normalizeLauncherYRatio(panel.launcherYRatio)
    return <button
      className={`dnr-launcher ${launcherDragRatio === null ? '' : 'is-dragging'}`}
      style={{ '--dnr-launcher-top': `${launcherYRatio * 100}%` } as CSSProperties}
      type="button"
      aria-label="打开小说阅读器"
      title="打开小说阅读器（可上下拖动）"
      draggable={false}
      onClick={onLauncherClick}
      onPointerDown={onLauncherPointerDown}
      onPointerMove={onLauncherPointerMove}
      onPointerUp={onLauncherPointerUp}
      onPointerCancel={cancelLauncherDrag}
      onLostPointerCapture={cancelLauncherDrag}
    ><Icon name="book" width="20" height="20" /></button>
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
            <button type="button" className={view === 'online' ? 'is-active' : ''} onClick={() => setView(view === 'online' ? 'reader' : 'online')}><Icon name="globe" /><span>搜书</span></button>
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
      {book === null && view !== 'online' && <FileLoader onOpened={returnToReader} onBrowseOnline={() => setView('online')} />}
      {book !== null && view === 'file' && <FileLoader compact onOpened={returnToReader} onBrowseOnline={() => setView('online')} />}
      <div className="dnr-online-container" hidden={view !== 'online'}>
        <OnlineSearchPanel onBack={returnToReader} onOpened={returnToReader} />
      </div>
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
