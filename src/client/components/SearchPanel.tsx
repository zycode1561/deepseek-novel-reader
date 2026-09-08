import { useEffect, useMemo, useRef, useState } from 'react'
import { searchBook } from '../../shared/search.ts'
import { useReader } from '../state/ReaderContext.tsx'
import { Icon } from './Icon.tsx'

interface SearchPanelProps {
  query: string
  onQueryChange(value: string): void
  onSelect(): void
}

export function SearchPanel({ query, onQueryChange, onSelect }: SearchPanelProps): JSX.Element {
  const { book, goToParagraph } = useReader()
  const inputRef = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState(0)
  const results = useMemo(() => book === null ? [] : searchBook(book, query), [book, query])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => setSelected(0), [query])

  const jump = (index: number): void => {
    const result = results[index]
    if (result === undefined) return
    setSelected(index)
    goToParagraph(result.paragraphIndex)
    onSelect()
  }

  return <section className="dnr-search-panel">
    <div className="dnr-panel-heading"><span>全文搜索</span><span>{results.length > 0 ? `${selected + 1} / ${results.length}` : '0 条'}</span></div>
    <label className="dnr-search-field">
      <Icon name="search" />
      <input ref={inputRef} value={query} onChange={event => onQueryChange(event.target.value)} placeholder="输入关键词" onKeyDown={event => {
        if (event.key === 'Enter' && results.length > 0) {
          event.preventDefault()
          const direction = event.shiftKey ? -1 : 1
          jump((selected + direction + results.length) % results.length)
        }
      }} />
      {query !== '' && <button type="button" aria-label="清空搜索" onClick={() => onQueryChange('')}><Icon name="close" width="14" height="14" /></button>}
    </label>
    <p className="dnr-search-help">Enter 下一个 · Shift+Enter 上一个 · Esc 关闭</p>
    <div className="dnr-search-results">
      {results.map((result, index) => <button key={result.id} type="button" className={selected === index ? 'is-active' : ''} onClick={() => jump(index)}>
        <span>{book?.chapters[result.chapterIndex]?.title}</span>
        <p>{result.excerpt}</p>
      </button>)}
      {query.trim() !== '' && results.length === 0 && <div className="dnr-empty-small">没有找到“{query.trim()}”</div>}
    </div>
  </section>
}
