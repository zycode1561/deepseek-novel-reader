import { randomUUID } from 'node:crypto'
import type { Book, OnlineAcquisitionStatus, OnlineSearchResponse } from '../shared/types.ts'
import { OnlineEngineError, type ResolvedOnlineResult, type SearchRunResult } from './engine.ts'

const RESULT_TTL_MS = 15 * 60 * 1000
const JOB_TTL_MS = 30 * 60 * 1000

interface CachedResult {
  value: ResolvedOnlineResult
  expiresAt: number
}

interface AcquisitionJob {
  status: OnlineAcquisitionStatus
  controller: AbortController
  result?: Book
  expiresAt: number
}

export type SaveAcquiredBook = (book: Book, signal: AbortSignal) => Promise<string>

export interface OnlineRegistryEngine {
  isResultCurrent?(result: ResolvedOnlineResult): boolean
  search(query: string, signal: AbortSignal): Promise<SearchRunResult>
  acquire(
    result: ResolvedOnlineResult,
    progress: (completed: number, total: number, retries: number) => void,
    signal: AbortSignal,
  ): Promise<Book>
}

export class OnlineRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: 'RESULT_EXPIRED' | 'JOB_NOT_FOUND' | 'JOB_NOT_READY',
  ) {
    super(message)
    this.name = 'OnlineRegistryError'
  }
}

export class OnlineRegistry {
  private readonly results = new Map<string, CachedResult>()
  private readonly jobs = new Map<string, AcquisitionJob>()

  constructor(private readonly engine: OnlineRegistryEngine, private readonly saveTxt?: SaveAcquiredBook) {}

  dispose(): void {
    for (const job of this.jobs.values()) job.controller.abort()
    this.results.clear()
    this.jobs.clear()
  }

  private prune(now = Date.now()): void {
    for (const [id, item] of this.results) if (item.expiresAt <= now) this.results.delete(id)
    for (const [id, item] of this.jobs) {
      if (item.expiresAt <= now && !['queued', 'resolving', 'downloading'].includes(item.status.state)) this.jobs.delete(id)
    }
  }

  async search(query: string, signal: AbortSignal): Promise<OnlineSearchResponse> {
    this.prune()
    const response = await this.engine.search(query, signal)
    const expiresAt = Date.now() + RESULT_TTL_MS
    for (const resolved of response.resolved) {
      if (this.engine.isResultCurrent?.(resolved) === false) continue
      const id = randomUUID()
      resolved.public.id = id
      resolved.keyword = query
      this.results.set(id, { value: resolved, expiresAt })
    }
    return {
      results: response.resolved.filter(item => this.results.has(item.public.id)).map(item => item.public),
      failedSources: response.failedSources,
      searchedSources: response.searchedSources,
    }
  }

  createAcquisition(resultId: string): OnlineAcquisitionStatus {
    const resolved = this.resolveResult(resultId)
    const id = randomUUID()
    const controller = new AbortController()
    const job: AcquisitionJob = {
      controller,
      expiresAt: Date.now() + JOB_TTL_MS,
      status: {
        id,
        state: 'queued',
        bookName: resolved.public.bookName,
        completedChapters: 0,
        totalChapters: 0,
        retries: 0,
      },
    }
    this.jobs.set(id, job)
    void this.run(job, resolved)
    return { ...job.status }
  }

  resolveResult(resultId: string): ResolvedOnlineResult {
    this.prune()
    const cached = this.results.get(resultId)
    if (cached === undefined || cached.expiresAt <= Date.now() || this.engine.isResultCurrent?.(cached.value) === false) {
      throw new OnlineRegistryError('搜索结果已过期，请重新搜索。', 'RESULT_EXPIRED')
    }
    return cached.value
  }

  private async run(job: AcquisitionJob, result: ResolvedOnlineResult): Promise<void> {
    job.status = { ...job.status, state: 'resolving' }
    try {
      job.result = await this.engine.acquire(result, (completedChapters, totalChapters, retries) => {
        job.status = {
          ...job.status,
          state: totalChapters > 0 ? 'downloading' : 'resolving',
          completedChapters,
          totalChapters,
          retries,
        }
      }, job.controller.signal)
      job.controller.signal.throwIfAborted()
      if (this.saveTxt) {
        try {
          const txtPath = await this.saveTxt(job.result, job.controller.signal)
          job.status = { ...job.status, txtPath }
        } catch (error) {
          job.controller.signal.throwIfAborted()
          job.status = { ...job.status, txtError: error instanceof Error ? error.message : 'TXT 保存失败。' }
        }
      }
      job.controller.signal.throwIfAborted()
      job.status = { ...job.status, state: 'completed' }
    } catch (error) {
      if (job.controller.signal.aborted || (error instanceof OnlineEngineError && error.code === 'CANCELLED')) {
        job.status = { ...job.status, state: 'cancelled', errorCode: 'CANCELLED', error: '抓取已取消。' }
      } else {
        job.status = {
          ...job.status,
          state: 'failed',
          errorCode: error instanceof OnlineEngineError ? error.code : 'REQUEST_FAILED',
          error: error instanceof Error ? error.message : '在线书籍抓取失败。',
        }
      }
    } finally {
      job.expiresAt = Date.now() + JOB_TTL_MS
    }
  }

  status(id: string): OnlineAcquisitionStatus {
    this.prune()
    const job = this.jobs.get(id)
    if (job === undefined) throw new OnlineRegistryError('未找到抓取任务。', 'JOB_NOT_FOUND')
    return { ...job.status }
  }

  result(id: string): Book {
    const job = this.jobs.get(id)
    if (job === undefined) throw new OnlineRegistryError('未找到抓取任务。', 'JOB_NOT_FOUND')
    if (job.status.state !== 'completed' || job.result === undefined) {
      throw new OnlineRegistryError('抓取任务尚未完成。', 'JOB_NOT_READY')
    }
    return job.result
  }

  cancel(id: string): OnlineAcquisitionStatus {
    const job = this.jobs.get(id)
    if (job === undefined) throw new OnlineRegistryError('未找到抓取任务。', 'JOB_NOT_FOUND')
    if (['queued', 'resolving', 'downloading'].includes(job.status.state)) {
      job.status = { ...job.status, state: 'cancelled', errorCode: 'CANCELLED', error: '抓取已取消。' }
      job.controller.abort()
    }
    return { ...job.status }
  }
}
