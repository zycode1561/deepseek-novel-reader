import {
  Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect,
  useMemo, useRef, useState, type MouseEvent, type ReactNode,
} from 'react'
import { useReader } from '../state/ReaderContext.tsx'
import { Icon } from './Icon.tsx'

function highlighted(text: string, rawQuery: string): ReactNode {
  const query = rawQuery.trim()
  if (query === '') return text
  const lower = text.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  const nodes: ReactNode[] = []
  let cursor = 0
  let key = 0
  while (cursor < text.length) {
    const index = lower.indexOf(needle, cursor)
    if (index < 0) break
    if (index > cursor) nodes.push(text.slice(cursor, index))
    nodes.push(<mark key={key++}>{text.slice(index, index + needle.length)}</mark>)
    cursor = index + needle.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>)
}

function pageTotal(container: HTMLElement): number {
  const width = Math.max(1, container.clientWidth)
  // Subtract one pixel so a fractional layout remainder does not create a ghost page.
  return Math.max(1, Math.ceil((container.scrollWidth - 1) / width))
}

export interface ReaderBodyHandle {
  turnPage(direction: -1 | 1): void
}

export const ReaderBody = forwardRef<ReaderBodyHandle, { searchQuery: string }>(function ReaderBody(
  { searchQuery }, forwardedRef,
): JSX.Element {
  const {
    book, progress, settings, pendingParagraph, clearPendingParagraph,
    markParagraphVisible, updatePanel, panel, goToChapter, loading, error,
  } = useReader()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  const restoreKeyRef = useRef('')
  const landOnLastPageRef = useRef(false)
  const [pageWidth, setPageWidth] = useState(1)
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const chapter = book?.chapters[progress?.chapterIndex ?? 0]
  const paged = settings.pageMode === 'paged'
  const paragraphs = useMemo(() => {
    if (book === null || chapter === undefined) return []
    return book.paragraphs.filter(paragraph => paragraph.chapterId === chapter.id && !paragraph.isHeading)
  }, [book, chapter])

  const updatePosition = useCallback(() => {
    frameRef.current = null
    const container = scrollerRef.current
    if (container === null) return
    const bounds = container.getBoundingClientRect()
    const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-pindex]'))
    const visible = elements.find((element) => {
      if (!paged) return element.getBoundingClientRect().bottom > bounds.top + 72
      return Array.from(element.getClientRects()).some(rect =>
        rect.right > bounds.left + 24 && rect.left < bounds.right - 24,
      )
    }) ?? elements.at(-1)
    if (visible !== undefined) {
      const index = Number(visible.dataset.pindex)
      if (Number.isFinite(index)) {
        markParagraphVisible(index, paged ? container.scrollLeft : container.scrollTop)
      }
    }
    if (paged) setPageIndex(Math.max(0, Math.min(pageTotal(container) - 1, Math.round(container.scrollLeft / Math.max(1, container.clientWidth)))))
  }, [markParagraphVisible, paged])

  const turnPage = useCallback((direction: -1 | 1): void => {
    const container = scrollerRef.current
    if (container === null || book === null || chapter === undefined || !paged || loading) return
    const width = Math.max(1, container.clientWidth)
    const total = pageTotal(container)
    const current = Math.max(0, Math.min(total - 1, Math.round(container.scrollLeft / width)))
    const next = current + direction
    if (next >= 0 && next < total) {
      container.scrollTo({ left: next * width, top: 0, behavior: 'smooth' })
      setPageIndex(next)
      return
    }
    if (direction > 0 && chapter.index < book.chapters.length - 1) {
      goToChapter(chapter.index + 1)
    } else if (direction < 0 && chapter.index > 0) {
      landOnLastPageRef.current = true
      goToChapter(chapter.index - 1)
    }
  }, [book, chapter, goToChapter, paged, loading])

  useEffect(() => { if (error !== null) landOnLastPageRef.current = false }, [error])

  useImperativeHandle(forwardedRef, () => ({ turnPage }), [turnPage])

  // Measure after every layout-affecting setting. Page width is written back to
  // CSS so the column width + column gap equals exactly one reader viewport.
  useLayoutEffect(() => {
    const container = scrollerRef.current
    if (container === null || book === null || progress === null || chapter === undefined) return
    // A previous-chapter page turn must land after the new chapter arrives,
    // rather than consuming its last-page intent on the old chapter.
    if (book.onlineReading && loading) return
    const width = Math.max(1, container.clientWidth)
    if (width !== pageWidth) {
      restoreKeyRef.current = ''
      setPageWidth(width)
      return
    }

    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current)
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null
      const total = paged ? pageTotal(container) : 1
      setPageCount(total)

      const restoreKey = [
        book.id, chapter.id, settings.pageMode, pageWidth, settings.fontSize,
        settings.fontFamily, settings.lineSpacing, settings.firstLineIndent,
        panel.toolsVisible,
      ].join(':')
      const shouldRestore = pendingParagraph !== null
        || restoreKeyRef.current !== restoreKey
        || landOnLastPageRef.current
      if (!shouldRestore) {
        if (paged) setPageIndex(Math.max(0, Math.min(total - 1, Math.round(container.scrollLeft / width))))
        return
      }

      if (paged && landOnLastPageRef.current) {
        const last = total - 1
        landOnLastPageRef.current = false
        container.scrollTo({ left: last * width, top: 0 })
        setPageIndex(last)
      } else {
        const targetIndex = pendingParagraph ?? progress.paragraphIndex
        const exact = container.querySelector<HTMLElement>(`[data-pindex="${targetIndex}"]`)
        const fallback = paragraphs.find(paragraph => paragraph.index >= targetIndex)
        const target = exact ?? (fallback === undefined
          ? null
          : container.querySelector<HTMLElement>(`[data-pindex="${fallback.index}"]`))
        if (paged) {
          const bounds = container.getBoundingClientRect()
          const targetLeft = target === null
            ? 0
            : container.scrollLeft + target.getBoundingClientRect().left - bounds.left
          const targetPage = Math.max(0, Math.min(total - 1, Math.floor(Math.max(0, targetLeft) / width)))
          container.scrollTo({ left: targetPage * width, top: 0 })
          setPageIndex(targetPage)
        } else if (target === null) {
          container.scrollTo({ top: 0, left: 0 })
        } else {
          target.scrollIntoView({ block: 'start' })
        }
      }
      restoreKeyRef.current = restoreKey
      if (pendingParagraph !== null) clearPendingParagraph()
    })

    return () => {
      if (measureFrameRef.current !== null) {
        cancelAnimationFrame(measureFrameRef.current)
        measureFrameRef.current = null
      }
    }
  }, [
    book, chapter, clearPendingParagraph, pageWidth, paged, panel.toolsVisible, loading,
    panel.width, paragraphs, pendingParagraph, progress, settings.firstLineIndent,
    settings.fontFamily, settings.fontSize, settings.lineSpacing, settings.pageMode,
    settings.tocPosition,
  ])

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current)
  }, [])

  if (book === null || progress === null || chapter === undefined) return <div />

  const onArticleClick = (event: MouseEvent<HTMLElement>): void => {
    if ((event.target as HTMLElement).closest('button,input,a,mark') !== null) return
    updatePanel({ toolsVisible: !panel.toolsVisible, immersive: panel.toolsVisible })
  }
  const atFirstPage = chapter.index === 0 && pageIndex === 0
  const atLastPage = chapter.index === book.chapters.length - 1 && pageIndex >= pageCount - 1

  return <div className={`dnr-reader-stage ${paged ? 'is-paged' : 'is-scroll'}`}>
    <div
      ref={scrollerRef}
      className={`dnr-reader-scroll ${paged ? 'dnr-reader-scroll--paged' : ''}`}
      aria-busy={Boolean(book.onlineReading && loading)}
      onScroll={() => {
        if (frameRef.current === null) frameRef.current = requestAnimationFrame(updatePosition)
      }}
    >
      <article
        className="dnr-reader-article"
        data-font={settings.fontFamily}
        data-spacing={settings.lineSpacing}
        data-indent={settings.firstLineIndent || undefined}
        data-page-mode={settings.pageMode}
        style={{
          '--dnr-font-size': `${settings.fontSize}px`,
          '--dnr-page-width': `${pageWidth}px`,
        } as React.CSSProperties}
        onClick={onArticleClick}
      >
        <header>
          <span>第 {chapter.index + 1} / {book.chapters.length} 章</span>
          <h1>{chapter.title}</h1>
          <i />
        </header>
        {paragraphs.map(paragraph => <p id={paragraph.id} data-pindex={paragraph.index} key={paragraph.id}>{highlighted(paragraph.text, searchQuery)}</p>)}
        {paragraphs.length === 0 && <div className="dnr-empty-small">本章没有可显示的正文。</div>}
        <footer><span>本章完</span></footer>
      </article>
    </div>

    {paged && <>
      <button className="dnr-page-edge dnr-page-edge--previous" type="button" aria-label="上一页" title="上一页" disabled={atFirstPage || loading} onClick={() => turnPage(-1)}><Icon name="chevron-left" /></button>
      <button className="dnr-page-edge dnr-page-edge--next" type="button" aria-label="下一页" title="下一页" disabled={atLastPage || loading} onClick={() => turnPage(1)}><Icon name="chevron-right" /></button>
      <span className="dnr-page-number" aria-live="polite">{pageIndex + 1} / {pageCount}</span>
    </>}
  </div>
})
