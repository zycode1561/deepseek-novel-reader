import type {
  Book, OnlineAcquisitionStatus, OnlineErrorCode, OnlineSearchResponse,
} from '../../shared/types.ts'

const BASE_PATH = '/dsh-novel-reader/online'

interface ErrorEnvelope {
  error?: { code?: string; message?: string }
}

export class OnlineApiError extends Error {
  constructor(message: string, public readonly code: OnlineErrorCode | string = 'REQUEST_FAILED') {
    super(message)
    this.name = 'OnlineApiError'
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BASE_PATH}${path}`, { cache: 'no-store', ...init })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new OnlineApiError('无法连接阅读器 Host，请确认插件仍在运行。')
  }
  if (!response.ok) {
    let detail: ErrorEnvelope = {}
    try { detail = await response.json() as ErrorEnvelope } catch { /* non-JSON host error */ }
    throw new OnlineApiError(detail.error?.message ?? `请求失败（HTTP ${response.status}）。`, detail.error?.code)
  }
  return await response.json() as T
}

export function searchOnlineBooks(query: string, signal?: AbortSignal): Promise<OnlineSearchResponse> {
  return requestJson(`/search?q=${encodeURIComponent(query)}`, signal === undefined ? undefined : { signal })
}

export function createAcquisition(resultId: string): Promise<OnlineAcquisitionStatus> {
  return requestJson('/acquisitions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ resultId }),
  })
}

export function getAcquisition(id: string, signal?: AbortSignal): Promise<OnlineAcquisitionStatus> {
  return requestJson(`/acquisitions/${encodeURIComponent(id)}`, signal === undefined ? undefined : { signal })
}

export function cancelAcquisition(id: string): Promise<OnlineAcquisitionStatus> {
  return requestJson(`/acquisitions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function getAcquisitionResult(id: string): Promise<Book> {
  return requestJson(`/acquisitions/${encodeURIComponent(id)}/result`)
}
