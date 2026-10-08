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

function recentProgress(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

interface FileLoaderProps {
  compact?: boolean
  onBrowseOnline?: () => void
  onOpened(): void
}

export function FileLoader({ compact = false, onBrowseOnline, onOpened }: FileLoaderProps): JSX.Element {
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
        if (file !== undefined) {
          void loadFile(file).then((opened) => {
            if (opened) onOpened()
          })
        }
        event.currentTarget.value = ''
      }}
    />
    <div className="dnr-file-hero">
      <div className="dnr-file-hero-heading">
        <div className="dnr-file-hero-icon"><Icon name="book" width="24" height="24" /></div>
        <div className="dnr-empty-copy">
          <h2>{compact ? '换一本书' : '把故事放在手边'}</h2>
          <p>{compact ? '从本地文件或在线书库开始新的阅读。' : '本地解析、随时续读，文件不会上传。'}</p>
        </div>
      </div>
      <div className="dnr-file-actions">
        <button className="dnr-primary-button" type="button" onClick={choose} disabled={loading}>
          <Icon name="file" />{loading ? '正在解析…' : '打开本地文件'}
        </button>
        {onBrowseOnline !== undefined && <button className="dnr-secondary-button" type="button" onClick={onBrowseOnline}>
          <Icon name="globe" />在线搜书
        </button>}
      </div>
      <p className="dnr-file-hint">支持 TXT、Markdown、EPUB · 自动识别 UTF-8 / GBK / GB2312 · 最大 50MB</p>
    </div>
    {error !== null && <div className="dnr-alert" role="alert">{error}</div>}

    {recents.length > 0 && <div className="dnr-recents">
      <div className="dnr-section-label">最近打开</div>
      <ul>
        {recents.map((recent) => {
          const progressPercent = recentProgress(recent.progressPercent)
          return <li key={recent.id}>
            <button className="dnr-recent-main" type="button" onClick={() => {
              void openRecent(recent.id).then((opened) => {
                if (opened) onOpened()
              })
            }}>
              <span className="dnr-recent-name">{recent.name}</span>
              <span className="dnr-recent-meta">{recent.onlineReading ? '在线按章阅读' : `${formatBytes(recent.size)} · ${recentFormat(recent)}`}</span>
              <span className="dnr-recent-progress-row">
                {progressPercent === null
                  ? <span className="dnr-recent-progress-track" aria-hidden="true"><i /></span>
                  : <span
                      className="dnr-recent-progress-track"
                      role="progressbar"
                      aria-label={`${recent.name} 阅读进度`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progressPercent}
                    ><i style={{ width: `${progressPercent}%` }} /></span>}
                <span className="dnr-recent-progress-label">
                  {progressPercent === null ? '进度待更新' : `已读 ${progressPercent}%`}
                </span>
              </span>
            </button>
            <button className="dnr-icon-button dnr-subtle" type="button" aria-label={`移除 ${recent.name}`} onClick={() => void removeRecent(recent.id)}>
              <Icon name="trash" width="15" height="15" />
            </button>
          </li>
        })}
      </ul>
    </div>}
  </section>
}
