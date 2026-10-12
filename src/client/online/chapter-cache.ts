import type { ChapterPrefetchCount, OnlineReadingChapter, OnlineReadingSession } from '../../shared/types.ts'
import { getOnlineChapter } from './api.ts'

interface PendingChapter {
  controller: AbortController
  promise: Promise<OnlineReadingChapter>
  foreground: boolean
}

/** One reader session's sliding, memory-only chapter window. */
export class OnlineChapterCache {
  private readonly chapters = new Map<number, OnlineReadingChapter>()
  private readonly pending = new Map<number, PendingChapter>()
  private generation = 0
  private disposed = false

  constructor(
    private readonly session: OnlineReadingSession,
    private readonly fetchChapter = getOnlineChapter,
  ) {}

  get sessionId(): string { return this.session.id }

  private request(index: number): PendingChapter {
    const existing = this.pending.get(index)
    if (existing && !existing.controller.signal.aborted) return existing
    const controller = new AbortController()
    const entry: PendingChapter = { controller, foreground: false, promise: undefined! }
    entry.promise = this.fetchChapter(this.session.id, index, controller.signal).then(chapter => {
      controller.signal.throwIfAborted()
      if (chapter.index !== index) throw new Error('章节响应与请求不匹配。')
      if (!this.disposed && this.pending.get(index) === entry) this.chapters.set(index, chapter)
      return chapter
    }).finally(() => {
      if (this.pending.get(index) === entry) this.pending.delete(index)
    })
    this.pending.set(index, entry)
    return entry
  }

  async read(index: number, signal: AbortSignal): Promise<OnlineReadingChapter> {
    signal.throwIfAborted()
    if (this.disposed) throw new DOMException('阅读会话已关闭。', 'AbortError')
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.session.chapters.length) throw new Error('未找到该章节。')
    // Promote a matching prefetch; other speculative requests yield to reading.
    this.pause(index)
    const cached = this.chapters.get(index)
    if (cached) return cached
    const entry = this.request(index)
    entry.foreground = true
    let onAbort: () => void = () => {}
    try {
      return await Promise.race([
        entry.promise,
        new Promise<never>((_, reject) => {
          onAbort = () => { entry.controller.abort(); reject(signal.reason) }
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        }),
      ])
    } finally {
      signal.removeEventListener('abort', onAbort)
      entry.foreground = false
    }
  }

  prefetch(currentIndex: number, count: ChapterPrefetchCount): void {
    if (this.disposed) return
    const generation = ++this.generation
    const end = Math.min(this.session.chapters.length - 1, currentIndex + count)
    for (const index of this.chapters.keys()) {
      if (index < currentIndex || index > end) this.chapters.delete(index)
    }
    for (const [index, entry] of this.pending) {
      if (!entry.foreground && (index <= currentIndex || index > end)) entry.controller.abort()
    }
    // Fetch nearest first, with only one speculative request at a time.
    void (async () => {
      for (let index = currentIndex + 1; index <= end; index++) {
        if (this.disposed || generation !== this.generation) return
        if (this.chapters.has(index)) continue
        try { await this.request(index).promise } catch { /* Speculative failures never interrupt reading. */ }
      }
    })()
  }

  pause(keepIndex?: number): void {
    this.generation++
    for (const [index, entry] of this.pending) {
      if (!entry.foreground && index !== keepIndex) entry.controller.abort()
    }
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    for (const entry of this.pending.values()) entry.controller.abort()
    this.pending.clear()
    this.chapters.clear()
  }
}
