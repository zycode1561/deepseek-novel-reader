import { useReader } from '../state/ReaderContext.tsx'
import { Icon } from './Icon.tsx'

export function BookmarksPanel({ onSelect }: { onSelect: () => void }): JSX.Element {
  const { bookmarks, book, goToParagraph, removeBookmark } = useReader()
  return <section className="dnr-bookmarks">
    <div className="dnr-panel-heading"><span>书签</span><span>{bookmarks.length} 个</span></div>
    {bookmarks.length === 0
      ? <div className="dnr-empty-panel"><Icon name="bookmark" width="28" height="28" /><p>读到喜欢的地方，点一下书签按钮。</p></div>
      : <ul>{bookmarks.map(bookmark => <li key={bookmark.id}>
        <button type="button" className="dnr-bookmark-main" onClick={() => { goToParagraph(bookmark.paragraphIndex, bookmark.chapterIndex); onSelect() }}>
          <span>{book?.chapters[bookmark.chapterIndex]?.title ?? '正文'}</span>
          <p>{bookmark.excerpt}</p>
        </button>
        <button className="dnr-icon-button dnr-subtle" type="button" aria-label="删除书签" onClick={() => removeBookmark(bookmark.id)}><Icon name="trash" width="15" height="15" /></button>
      </li>)}</ul>}
  </section>
}
