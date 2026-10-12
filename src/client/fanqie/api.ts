import type { FanqieBinding, FanqieLocation, FanqieLogin, FanqieOpen, FanqiePosition, FanqiePull, FanqieShelfBook, FanqieStatus, FanqieText } from '../../shared/fanqie.ts'

export class FanqieApiError extends Error {
  constructor(public readonly code: string, message: string) { super(message) }
}
async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try { response = await fetch(`/dsh-novel-reader/fanqie${path}`, { method, credentials: 'same-origin', cache: 'no-store',
    ...(signal ? { signal } : {}), ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }) }
  catch { signal?.throwIfAborted(); throw new FanqieApiError('HOST_UNAVAILABLE', '无法连接阅读器服务。') }
  let value
  try { value = await response.json() } catch { throw new FanqieApiError('HOST_UNAVAILABLE', '番茄同步模块未启用或服务尚未更新。') }
  if (!response.ok) throw new FanqieApiError(value?.error?.code ?? 'REQUEST_FAILED', value?.error?.message ?? '番茄同步失败。')
  return value as T
}
export const getFanqieStatus = (signal?: AbortSignal) => request<FanqieStatus>('/status', 'GET', undefined, signal)
export const startFanqieLogin = (signal?: AbortSignal) => request<FanqieLogin>('/login', 'POST', undefined, signal)
export const checkFanqieLogin = (id: string, signal?: AbortSignal) => request<{ state: string; status: FanqieStatus }>('/login/check', 'POST', { id }, signal)
export const cancelFanqieLogin = (id: string) => request('/login', 'DELETE', { id })
export const logoutFanqie = () => request<FanqieStatus>('/logout', 'POST')
export const getFanqieShelf = (signal?: AbortSignal) => request<FanqieShelfBook[]>('/shelf', 'POST', undefined, signal)
export const bindFanqieBook = (binding: FanqieBinding) => request<FanqieStatus>('/bindings', 'POST', binding)
export const unbindFanqieBook = (localBookId: string) => request<FanqieStatus>('/bindings', 'DELETE', { localBookId })
export const pullFanqieProgress = (localBookId: string, signal?: AbortSignal) => request<FanqiePull | null>('/pull', 'POST', { localBookId }, signal)
export const acknowledgeFanqie = (ticket: string, local: FanqieLocation) => request('/ack', 'POST', { ticket, local })
export const openFanqieBook = (bookId: string, name: string, signal?: AbortSignal, fromPhone = false) => request<FanqieOpen>('/books/open', 'POST', { bookId, name, fromPhone }, signal)
export const readFanqieChapter = (accountId: string, bookId: string, chapterId: string, signal?: AbortSignal) => request<FanqieText>('/books/chapter', 'POST', { accountId, bookId, chapterId }, signal)
export const saveFanqiePosition = (accountId: string, bookId: string, position: FanqiePosition) => request('/books/position', 'POST', { accountId, bookId, position })
