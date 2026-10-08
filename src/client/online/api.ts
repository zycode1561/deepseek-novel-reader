import type {
  Book, OnlineAcquisitionStatus, OnlineErrorCode, OnlineSearchResponse, OnlineReadingReference, OnlineReadingSession, OnlineReadingChapter,
} from '../../shared/types.ts'
import type { ManagedRule, RuleFormat, RuleImportPreview, RuleImportResult, RuleTestRequest, RuleTestResponse } from '../../shared/rules.ts'

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

export function openOnlineReading(input: { resultId: string } | { reference: OnlineReadingReference }, signal?: AbortSignal): Promise<OnlineReadingSession> {
  return requestJson('/readings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
}

export function getOnlineChapter(id: string, index: number, signal?: AbortSignal): Promise<OnlineReadingChapter> {
  return requestJson(`/readings/${encodeURIComponent(id)}/chapters/${index}`, signal ? { signal } : undefined)
}

export function closeOnlineReading(id: string): Promise<{ ok: boolean }> {
  return requestJson(`/readings/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

const jsonRequest = (value: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
export function listRules(signal?: AbortSignal): Promise<ManagedRule[]> {
  return requestJson('/rules', signal ? { signal } : undefined)
}
export function saveRule(raw: Record<string, unknown>, format: RuleFormat, enabled: boolean, id?: string): Promise<ManagedRule> {
  return requestJson('/rules', jsonRequest({ raw, format, enabled, id }))
}
export function setRuleEnabled(id: string, enabled: boolean): Promise<ManagedRule> {
  return requestJson(`/rules/${encodeURIComponent(id)}`, jsonRequest({ enabled }, 'PUT'))
}
export function deleteRule(id: string): Promise<{ ok: boolean }> {
  return requestJson(`/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export function previewRuleImport(text: string): Promise<RuleImportPreview> {
  return requestJson('/rules/import', jsonRequest({ text }))
}
export function commitRuleImport(token: string, updateIds: string[]): Promise<RuleImportResult> {
  return requestJson('/rules/import', jsonRequest({ token, updateIds }))
}
export function exportRules(id?: string): Promise<Record<string, unknown> | Record<string, unknown>[]> {
  return requestJson(`/rules/export${id ? `?id=${encodeURIComponent(id)}` : ''}`)
}
export function testRule(input: RuleTestRequest, signal?: AbortSignal): Promise<RuleTestResponse> {
  return requestJson('/rules/test', { ...jsonRequest(input), ...(signal ? { signal } : {}) })
}
