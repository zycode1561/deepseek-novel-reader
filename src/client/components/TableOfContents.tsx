import { useMemo, useState } from 'react'
import { useReader } from '../state/ReaderContext.tsx'
import { Icon } from './Icon.tsx'

export function TableOfContents({ embedded = false, onSelect }: { embedded?: boolean; onSelect?: () => void }): JSX.Element {
  const { book, progress, goToChapter } = useReader()
  const [query, setQuery] = useState('')
  const chapters = useMemo(() => {
    if (book === null) return []
    const needle = query.trim().toLocaleLowerCase()
    return needle.length === 0 ? book.chapters : book.chapters.filter(chapter => chapter.title.toLocaleLowerCase().includes(needle))
  }, [book, query])

  if (book === null) return <div />
  return <section className={`dnr-toc ${embedded ? 'dnr-toc--embedded' : ''}`} aria-label="目录">
    {!embedded && <div className="dnr-panel-heading"><span>目录</span><span>{book.chapters.length} 章</span></div>}
    <label className="dnr-search-field dnr-search-field--small">
      <Icon name="search" width="15" height="15" />
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="筛选章节" />
      {query !== '' && <button type="button" aria-label="清空筛选" onClick={() => setQuery('')}><Icon name="close" width="13" height="13" /></button>}
    </label>
    <div className="dnr-toc-list" role="tree">
      {chapters.map(chapter => <button
        key={chapter.id}
        type="button"
        role="treeitem"
        aria-current={progress?.chapterIndex === chapter.index ? 'true' : undefined}
        className={progress?.chapterIndex === chapter.index ? 'is-active' : ''}
        style={{ paddingLeft: `${12 + (chapter.level - 1) * 12}px` }}
        onClick={() => { goToChapter(chapter.index); onSelect?.() }}
      >
        <span className="dnr-toc-index">{String(chapter.index + 1).padStart(2, '0')}</span>
        <span>{chapter.title}</span>
      </button>)}
      {chapters.length === 0 && <div className="dnr-empty-small">没有匹配的章节</div>}
    </div>
  </section>
}
