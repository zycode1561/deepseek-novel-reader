import { useRef } from 'react'
import { encodingLabel } from '../../shared/encoding.ts'
import type { BookFormat } from '../../shared/types.ts'
import { useReader } from '../state/ReaderContext.tsx'
import { Icon } from './Icon.tsx'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function recentFormat(recent: { format: BookFormat; encoding: Parameters<typeof encodingLabel>[0] }): string {
  if (recent.format === 'online') return '在线'
  return recent.format === 'epub' ? 'EPUB' : encodingLabel(recent.encoding)
}

export function FileLoader({ compact = false, onBrowseOnline }: { compact?: boolean; onBrowseOnline?: () => void }): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const { loadFile, loading, recents, openRecent, removeRecent, error, clearError } = useReader()

  const choose = (): void => {
    clearError()
    inputRef.current?.click()
  }

  return <section className={`dnr-file-loader ${compact ? 'dnr-file-loader--compact' : ''}`}>
    <input
      ref={inputRef}
      className="dnr-visually-hidden"
      type="file"
      accept=".txt,.md,.markdown,.epub,text/plain,text/markdown,application/epub+zip"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        if (file !== undefined) void loadFile(file)
        event.currentTarget.value = ''
      }}
    />
    {!compact && <div className="dnr-empty-illustration"><Icon name="book" width="34" height="34" /></div>}
    <div className="dnr-empty-copy">
      <h2>{compact ? '换一本书' : '把故事放在手边'}</h2>
      {!compact && <p>文件只在本机浏览器中读取，不会上传。</p>}
    </div>
    <button className="dnr-primary-button" type="button" onClick={choose} disabled={loading}>
      <Icon name="file" />{loading ? '正在解析…' : '打开本地文件'}
    </button>
    {onBrowseOnline !== undefined && <button className="dnr-secondary-button" type="button" onClick={onBrowseOnline}>
      <Icon name="globe" />在线搜书
    </button>}
    <p className="dnr-file-hint">支持 TXT、Markdown、EPUB · 文本自动识别 UTF-8 / GBK / GB2312 · 最大 50MB</p>
    {error !== null && <div className="dnr-alert" role="alert">{error}</div>}

    {recents.length > 0 && <div className="dnr-recents">
      <div className="dnr-section-label">最近打开</div>
      <ul>
        {recents.map(recent => <li key={recent.id}>
          <button className="dnr-recent-main" type="button" onClick={() => void openRecent(recent.id)}>
            <span className="dnr-recent-name">{recent.name}</span>
            <span className="dnr-recent-meta">{formatBytes(recent.size)} · {recentFormat(recent)}</span>
          </button>
          <button className="dnr-icon-button dnr-subtle" type="button" aria-label={`移除 ${recent.name}`} onClick={() => void removeRecent(recent.id)}>
            <Icon name="trash" width="15" height="15" />
          </button>
        </li>)}
      </ul>
    </div>}
  </section>
}
