import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { OnlineAcquisitionStatus, OnlineBookResult } from '../../shared/types.ts'
import {
  cancelAcquisition, createAcquisition, getAcquisition, getAcquisitionResult,
  searchOnlineBooks,
} from '../online/api.ts'
import { useReader } from '../state/ReaderContext.tsx'
import { RuleManagerPanel } from './RuleManagerPanel.tsx'
import { Icon } from './Icon.tsx'

const POLL_INTERVAL_MS = 650

function statusText(status: OnlineAcquisitionStatus): string {
  if (status.state === 'queued') return '等待抓取任务…'
  if (status.state === 'resolving') return '正在解析详情页和目录…'
  if (status.state === 'downloading') return `正在抓取章节 ${status.completedChapters} / ${status.totalChapters}`
  if (status.state === 'completed') return '抓取完成，正在打开…'
  if (status.state === 'cancelled') return '抓取已取消。'
  return status.error ?? '抓取失败。'
}

function metadata(result: OnlineBookResult): string {
  return [result.author, result.category, result.status, result.wordCount].filter(Boolean).join(' · ')
}

interface OnlineSearchPanelProps {
  onBack(): void
  onOpened(): void
}

export function OnlineSearchPanel({ onBack, onOpened }: OnlineSearchPanelProps): JSX.Element {
  const { loadOnlineBook, startOnlineReading } = useReader()
  const [opening, setOpening] = useState(false)
  const [query, setQuery] = useState('')
  const [managingRules, setManagingRules] = useState(false)
  const [results, setResults] = useState<OnlineBookResult[]>([])
  const [failedSources, setFailedSources] = useState(0)
  const [searchedSources, setSearchedSources] = useState(0)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<OnlineAcquisitionStatus | null>(null)
  const searchController = useRef<AbortController | null>(null)

  useEffect(() => () => searchController.current?.abort(), [])

  useEffect(() => {
    if (job === null || !['queued', 'resolving', 'downloading'].includes(job.state)) return
    const controller = new AbortController()
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined
    let stopped = false

    const poll = async (): Promise<void> => {
      try {
        const next = await getAcquisition(job.id, controller.signal)
        if (stopped) return
        setJob(next)
        if (next.state === 'completed') {
          const book = await getAcquisitionResult(next.id)
          if (stopped) return
          await loadOnlineBook(book)
          if (!stopped) onOpened()
          return
        }
        if (['failed', 'cancelled'].includes(next.state)) return
        timer = globalThis.setTimeout(() => { void poll() }, POLL_INTERVAL_MS)
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(caught instanceof Error ? caught.message : '抓取状态查询失败。')
      }
    }
    void poll()
    return () => {
      stopped = true
      controller.abort()
      if (timer !== undefined) globalThis.clearTimeout(timer)
    }
  }, [job?.id, loadOnlineBook, onOpened])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const normalized = query.trim()
    if (normalized.length === 0) return
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    setSearching(true)
    setError(null)
    setJob(null)
    try {
      const response = await searchOnlineBooks(normalized, controller.signal)
      setResults(response.results)
      setFailedSources(response.failedSources)
      setSearchedSources(response.searchedSources)
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
        setError(caught instanceof Error ? caught.message : '在线搜书失败。')
      }
    } finally {
      if (searchController.current === controller) setSearching(false)
    }
  }

  const acquire = async (result: OnlineBookResult): Promise<void> => {
    setError(null)
    try {
      setJob(await createAcquisition(result.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法创建抓取任务。')
    }
  }

  const readOnline = async (result: OnlineBookResult): Promise<void> => {
    setOpening(true)
    setError(null)
    try {
      await startOnlineReading(result.id)
      onOpened()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '在线阅读失败。')
    } finally { setOpening(false) }
  }

  const cancel = async (): Promise<void> => {
    if (job === null) return
    try {
      await cancelAcquisition(job.id)
      setJob({ ...job, state: 'cancelled', error: '抓取已取消。' })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '取消抓取失败。')
    }
  }

  const activeJob = job !== null && ['queued', 'resolving', 'downloading'].includes(job.state)
  const percent = job !== null && job.totalChapters > 0
    ? Math.min(100, job.completedChapters / job.totalChapters * 100)
    : 0

  if (managingRules) return <RuleManagerPanel onBack={() => setManagingRules(false)} />
  return <section className="dnr-online-panel">
    <header className="dnr-online-heading">
      <button className="dnr-online-back" type="button" onClick={onBack} aria-label="返回">
        <Icon name="chevron-left" width="16" height="16" /><span>返回</span>
      </button>
      <div><strong>在线搜书</strong><span>聚合已启用书源</span></div>
      <button type="button" disabled={activeJob || searching || opening} onClick={() => setManagingRules(true)}>书源管理</button>
    </header>
    <form className="dnr-online-search" onSubmit={event => { void submit(event) }}>
      <div className="dnr-search-field">
        <Icon name="search" />
        <input value={query} maxLength={100} onChange={event => setQuery(event.currentTarget.value)} placeholder="输入书名或作者" aria-label="书名或作者" />
      </div>
      <button className="dnr-primary-button" type="submit" disabled={searching || activeJob || opening}>
        {searching ? '正在搜索…' : '搜书'}
      </button>
    </form>

    {searchedSources > 0 && <p className="dnr-online-summary">
      已搜索 {searchedSources} 个书源{failedSources > 0 ? `，${failedSources} 个暂时失败` : ''}，共 {results.length} 条结果。
    </p>}
    {error !== null && <div className="dnr-alert" role="alert">{error}</div>}
    {opening && <p role="status">正在加载目录和阅读章节…</p>}

    {job !== null && <div className={`dnr-acquisition dnr-acquisition--${job.state}`} aria-live="polite">
      <strong>{job.bookName}</strong>
      <span>{statusText(job)}</span>
      {job.totalChapters > 0 && <div className="dnr-acquisition-progress"><i style={{ width: `${percent}%` }} /></div>}
      {job.retries > 0 && <small>已重试 {job.retries} 次</small>}
      {activeJob && <button type="button" onClick={() => { void cancel() }}>取消抓取</button>}
    </div>}

    <div className="dnr-online-results">
      {results.map(result => <article key={result.id}>
        <div className="dnr-online-result-heading">
          <div><h3>{result.bookName}</h3><p>{metadata(result) || '暂无书籍元数据'}</p></div>
          <span>{result.sourceName}</span>
        </div>
        {(result.latestChapter || result.lastUpdateTime) && <p className="dnr-online-latest">
          {result.latestChapter}{result.latestChapter && result.lastUpdateTime ? ' · ' : ''}{result.lastUpdateTime}
        </p>}
        <div className="dnr-online-actions">
          <button className="dnr-primary-button" type="button" disabled={activeJob || opening} onClick={() => { void readOnline(result) }}>在线阅读</button>
          <button type="button" disabled={activeJob || opening} onClick={() => { void acquire(result) }}>加入书库并阅读</button>
          <a href={result.sourceUrl} target="_blank" rel="noreferrer">源站链接</a>
        </div>
      </article>)}
      {!searching && searchedSources > 0 && results.length === 0 && <div className="dnr-empty-small">没有找到匹配书籍，可以换个关键词。</div>}
    </div>

    <aside className="dnr-online-disclaimer">
      搜索和抓取请求由本机 Host 直接访问第三方书源；可用性与内容不作保证，请遵守来源网站规则。
      内置规则与设计源自 <a href="https://github.com/freeok/so-novel" target="_blank" rel="noreferrer">SoNovel</a>，
      本插件完整源码按 <a href="https://github.com/zycode1561/deepseek-novel-reader" target="_blank" rel="noreferrer">AGPL-3.0</a> 提供。
    </aside>
  </section>
}
