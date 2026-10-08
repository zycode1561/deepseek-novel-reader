import { randomUUID } from 'node:crypto'
import type { OnlineReadingChapter, OnlineReadingSession } from '../shared/types.ts'
import type { OnlineSourceEngine, ResolvedOnlineResult, ChapterLink } from './engine.ts'

const SESSION_TTL_MS = 30 * 60_000
const MAX_SESSIONS = 64

interface ReadingEntry {
  result: ResolvedOnlineResult
  links: ChapterLink[]
  controller: AbortController
  expiresAt: number
}

export class OnlineReadingError extends Error {
  constructor(message: string, public readonly code: 'READING_EXPIRED' | 'CHAPTER_NOT_FOUND') {
    super(message)
    this.name = 'OnlineReadingError'
  }
}

/** Holds rule/TOC snapshots only; chapter bodies are never persisted or prefetched. */
export class OnlineReadingRegistry {
  private readonly entries = new Map<string, ReadingEntry>()
  private readonly controller = new AbortController()

  constructor(private readonly engine: Pick<OnlineSourceEngine, 'previewToc' | 'readChapter' | 'isResultCurrent'>) {}

  dispose(): void {
    this.controller.abort()
    for (const id of this.entries.keys()) this.close(id)
  }

  close(id: string): void {
    this.entries.get(id)?.controller.abort()
    this.entries.delete(id)
  }

  async open(result: ResolvedOnlineResult, signal: AbortSignal): Promise<OnlineReadingSession> {
    const combined = AbortSignal.any([signal, this.controller.signal])
    const links = await this.engine.previewToc(result, combined)
    combined.throwIfAborted()
    if (!this.engine.isResultCurrent(result)) throw new OnlineReadingError('书源已修改或停用，请重新搜索。', 'READING_EXPIRED')
    for (const [id, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.close(id)
    if (this.entries.size >= MAX_SESSIONS) this.close(this.entries.keys().next().value!)
    const id = randomUUID()
    this.entries.set(id, { result, links, controller: new AbortController(), expiresAt: Date.now() + SESSION_TTL_MS })
    return {
      id,
      reference: { sourceId: result.source.id, bookUrl: result.bookUrl, bookName: result.public.bookName, keyword: result.keyword ?? result.public.bookName },
      sourceName: result.source.name,
      chapters: links.map(link => ({ title: link.title })),
    }
  }

  async chapter(id: string, index: number, signal: AbortSignal): Promise<OnlineReadingChapter> {
    const entry = this.entries.get(id)
    if (!entry || entry.expiresAt <= Date.now() || !this.engine.isResultCurrent(entry.result)) {
      this.close(id)
      throw new OnlineReadingError('在线阅读会话已过期，请重新连接。', 'READING_EXPIRED')
    }
    const link = entry.links[index]
    if (!Number.isSafeInteger(index) || index < 0 || !link) throw new OnlineReadingError('未找到该章节。', 'CHAPTER_NOT_FOUND')
    entry.expiresAt = Date.now() + SESSION_TTL_MS
    const combined = AbortSignal.any([signal, this.controller.signal, entry.controller.signal])
    const chapter = await this.engine.readChapter(entry.result, link, combined)
    combined.throwIfAborted()
    if (!this.engine.isResultCurrent(entry.result)) throw new OnlineReadingError('书源已修改或停用，请重新连接。', 'READING_EXPIRED')
    entry.expiresAt = Date.now() + SESSION_TTL_MS
    return { index, ...chapter }
  }
}
