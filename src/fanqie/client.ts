import { createHash } from 'node:crypto'
import { fetch as networkFetch, ProxyAgent, type Dispatcher } from 'undici'
import { z } from 'zod'
import type { FanqieChapter, FanqieProgress, FanqieShelfBook } from '../shared/fanqie.ts'
import { officialChapter } from './content.ts'

const BASE = 'https://fanqienovel.com'
const LOGIN_PAGE = `${BASE}/main/writer/login`
const COMMON = { passport_jssdk_version: '3.0.16', passport_jssdk_type: 'normal', aid: '2503', language: 'zh', account_sdk_source: 'web' }
export const cookieSchema = z.object({ name: z.string().regex(/^[\w-]+$/), value: z.string().max(8192).regex(/^[^\r\n;]*$/),
  path: z.string().startsWith('/'), expires: z.number().nullable() })
export type FanqieCookie = z.infer<typeof cookieSchema>
export class FanqieError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'FanqieError' }
}
type Row = Record<string, unknown>
function row(value: unknown): Row { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {} }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(row) : [] }
export function fanqieId(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new FanqieError('PROTOCOL_CHANGED', '番茄返回的书籍或章节编号精度无效。')
  const id = String(value ?? '')
  return /^\d{1,64}$/.test(id) ? id : ''
}
export function parseFanqieJson(text: string): unknown {
  // Preserve integer IDs beyond JS's safe integer range, without touching JSON strings.
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|(-?\d{16,})(?=[\s,\]}])/gu, (token, integer: string | undefined) => integer ? `"${integer}"` : token))
}
function apiData(value: unknown): unknown {
  const object = row(value)
  if (object.code !== undefined && Number(object.code) !== 0) {
    const message = String(object.message ?? object.msg ?? '')
    if (/登录|login|session|unauth/iu.test(message)) throw new FanqieError('AUTH_EXPIRED', '番茄登录已过期，请重新扫码。')
    throw new FanqieError('UPSTREAM_REJECTED', '番茄暂时拒绝请求，请稍后重试。')
  }
  if (!('data' in object)) throw new FanqieError('PROTOCOL_CHANGED', '番茄响应格式变化，未覆盖本地进度。')
  return object.data
}
export function normalizeProgress(payload: unknown): FanqieProgress[] {
  const data = apiData(payload)
  if (!Array.isArray(data)) throw new FanqieError('PROTOCOL_CHANGED', '番茄进度列表格式变化。')
  return rows(data).flatMap(item => {
    const bookId = fanqieId(item.book_id ?? item.bookId)
    const chapterId = fanqieId(item.item_id ?? item.itemId)
    return bookId && chapterId && chapterId !== '0' ? [{ bookId, chapterId, fetchedAt: Date.now() }] : []
  })
}
export function normalizeChapters(payload: unknown): FanqieChapter[] {
  const data = row(apiData(payload))
  const source = Array.isArray(data.chapterListWithVolume) ? data.chapterListWithVolume.flat() : data.chapterList
  if (!Array.isArray(source)) throw new FanqieError('PROTOCOL_CHANGED', '番茄目录格式变化，无法安全定位章节。')
  const chapters = rows(source).map(item => ({ id: fanqieId(item.itemId ?? item.item_id), title: String(item.title ?? item.chapter_name ?? '') }))
  if (!chapters.length || chapters.some(item => !item.id || !item.title) || new Set(chapters.map(item => item.id)).size !== chapters.length)
    throw new FanqieError('PROTOCOL_CHANGED', '番茄目录不完整，无法安全定位章节。')
  return chapters
}

export class FanqieClient {
  private readonly dispatcher: Dispatcher | undefined
  constructor(private readonly timeoutMs: number, proxyUrl?: string) { if (proxyUrl) this.dispatcher = new ProxyAgent(proxyUrl) }
  async dispose(): Promise<void> { await this.dispatcher?.close() }
  private cookieHeader(cookies: FanqieCookie[], path: string): string {
    return cookies.filter(cookie => (cookie.expires === null || cookie.expires > Date.now())
      && (path === cookie.path || path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
      .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
  }
  private mergeCookies(cookies: FanqieCookie[], headers: { getSetCookie(): string[] }, url: URL): void {
    for (const header of headers.getSetCookie()) {
      const [pair, ...parts] = header.split(';')
      const equals = pair!.indexOf('=')
      if (equals < 1) continue
      const attrs = Object.fromEntries(parts.map(part => { const [name, ...value] = part.trim().split('='); return [name!.toLowerCase(), value.join('=')] }))
      if (attrs.domain && attrs.domain.replace(/^\./, '').toLowerCase() !== url.hostname) continue
      const path = attrs.path?.startsWith('/') ? attrs.path : url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/'
      const age = attrs['max-age'] === undefined ? NaN : Number(attrs['max-age'])
      const expires = Number.isFinite(age) ? Date.now() + age * 1000 : attrs.expires ? Date.parse(attrs.expires) : NaN
      const parsed = cookieSchema.safeParse({ name: pair!.slice(0, equals).trim(), value: pair!.slice(equals + 1).trim(), path,
        expires: Number.isFinite(expires) ? expires : null })
      if (!parsed.success) continue
      const old = cookies.findIndex(cookie => cookie.name === parsed.data.name && cookie.path === path)
      if (old >= 0) cookies.splice(old, 1)
      if (parsed.data.expires === null || parsed.data.expires > Date.now()) cookies.push(parsed.data)
    }
  }
  async request(path: string, cookies: FanqieCookie[], signal: AbortSignal, body?: unknown, follow = true, html = false): Promise<{ value: unknown; location: string | null }> {
    let url = new URL(path, BASE)
    for (let redirect = 0; redirect < 6; redirect++) {
      // Exact origin allowlist: never forward account cookies to custom sources or another domain.
      if (url.origin !== BASE || url.username || url.password) throw new FanqieError('UNTRUSTED_REDIRECT', '番茄登录跳转到尚未支持的域名，已停止请求。')
      let response
      try {
        response = await networkFetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
          headers: { accept: 'application/json, text/plain, */*', referer: LOGIN_PAGE, origin: BASE,
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            cookie: this.cookieHeader(cookies, url.pathname), 'x-tt-passport-csrf-token': cookies.find(item => item.name === 'passport_csrf_token')?.value ?? '',
            ...(body === undefined ? {} : { 'content-type': 'application/json;charset=UTF-8' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      } catch {
        signal.throwIfAborted()
        throw new FanqieError('NETWORK_ERROR', '无法连接番茄，请检查网络或代理后重试。')
      }
      this.mergeCookies(cookies, response.headers, url)
      const location = response.headers.get('location')
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        if (!location) throw new FanqieError('PROTOCOL_CHANGED', '番茄登录跳转缺少目标地址。')
        if (!follow) return { value: null, location: new URL(location, url).href }
        url = new URL(location, url)
        if (response.status === 303 || response.status === 302) body = undefined
        continue
      }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new FanqieError('AUTH_EXPIRED', '番茄登录失效或请求受限，请重新扫码或稍后重试。') }
      if (!response.ok) { await response.body?.cancel(); throw new FanqieError('UPSTREAM_REJECTED', '番茄服务暂时不可用，请稍后重试。') }
      const chunks: Uint8Array[] = []; let size = 0
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw new FanqieError('RESPONSE_TOO_LARGE', '番茄响应过大，已停止处理。')
        chunks.push(chunk)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (html) return { value: text, location: null }
      try { return { value: parseFanqieJson(text), location: null } }
      catch { if (url.pathname === '/main/writer/login' || cookies.some(item => item.name === 'sessionid')) return { value: null, location: null }
        throw new FanqieError('PROTOCOL_CHANGED', '番茄响应不是预期的 JSON，可能需要重新登录。') }
    }
    throw new FanqieError('REDIRECT_LIMIT', '番茄登录跳转次数过多。')
  }
  async startLogin(cookies: FanqieCookie[], signal: AbortSignal): Promise<{ token: string; url: string }> {
    await this.request(LOGIN_PAGE, cookies, signal)
    const params = new URLSearchParams({ ...COMMON, need_logo: 'true', next: LOGIN_PAGE })
    const { value } = await this.request(`/passport/web/get_qrcode/?${params}`, cookies, signal)
    const data = row(row(value).data)
    const token = String(data.token ?? ''); const url = String(data.qrcode_index_url ?? '')
    if (!token || token.length > 4096 || !/^https:\/\//.test(url) || url.length > 4096) throw new FanqieError('LOGIN_UNAVAILABLE', '无法获取番茄登录二维码，请稍后重试。')
    return { token, url }
  }
  async checkLogin(token: string, cookies: FanqieCookie[], signal: AbortSignal): Promise<string> {
    const params = new URLSearchParams({ ...COMMON, token, next: '/' })
    const response = await this.request(`/passport/web/check_qrconnect/?${params}`, cookies, signal, undefined, false)
    const data = row(row(response.value).data)
    const status = String(data.status ?? 'waiting')
    const redirect = response.location ?? (typeof data.redirect_url === 'string' ? data.redirect_url : null)
    if (redirect && (response.location || status === 'success' || status === 'confirmed')) await this.request(redirect, cookies, signal)
    return cookies.some(item => item.name === 'sessionid' && (item.expires === null || item.expires > Date.now())) ? 'confirmed' : status
  }
  accountId(cookies: FanqieCookie[]): string {
    const value = cookies.find(item => item.name === 'uid_tt')?.value ?? cookies.find(item => item.name === 'sessionid')?.value
    if (!value) throw new FanqieError('AUTH_EXPIRED', '番茄登录未完成。')
    return createHash('sha256').update(value).digest('hex')
  }
  async progress(cookies: FanqieCookie[], signal: AbortSignal): Promise<FanqieProgress[]> {
    return normalizeProgress((await this.request('/api/reader/book/progress', cookies, signal)).value)
  }
  async chapters(bookId: string, cookies: FanqieCookie[], signal: AbortSignal): Promise<FanqieChapter[]> {
    return normalizeChapters((await this.request(`/api/reader/directory/detail?bookId=${encodeURIComponent(bookId)}`, cookies, signal)).value)
  }
  async chapter(bookId: string, chapterId: string, cookies: FanqieCookie[], signal: AbortSignal) {
    const response = await this.request(`/reader/${encodeURIComponent(chapterId)}`, cookies, signal, undefined, true, true)
    const chapter = officialChapter(String(response.value), bookId, chapterId)
    let fontData: string | undefined
    if (chapter.fontUrl) {
      // Fonts are public assets. Never send account cookies to a CDN.
      const response = await networkFetch(chapter.fontUrl, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}) })
      if (!response.ok) { await response.body?.cancel(); throw new FanqieError('FONT_UNAVAILABLE', '番茄字体加载失败，请重试。') }
      const chunks: Uint8Array[] = []; let size = 0
      if (response.body) for await (const chunk of response.body) {
        size += chunk.length
        if (size > 2 * 1024 * 1024) throw new FanqieError('FONT_UNAVAILABLE', '番茄字体文件过大。')
        chunks.push(chunk)
      }
      const buffer = Buffer.concat(chunks)
      if (buffer.subarray(0, 4).toString('ascii') !== 'wOF2') throw new FanqieError('FONT_UNAVAILABLE', '番茄字体格式不正确。')
      fontData = `data:font/woff2;base64,${buffer.toString('base64')}`
    }
    return { id: chapter.id, title: chapter.title, paragraphs: chapter.paragraphs, ...(fontData ? { fontData } : {}) }
  }
  async shelf(cookies: FanqieCookie[], signal: AbortSignal): Promise<FanqieShelfBook[]> {
    const payload = (await this.request('/reading/bookapi/bookshelf/info/v:version/?aid=1967&iid=0&version_code=57700&update_version_code=57700', cookies, signal)).value
    const data = apiData(payload)
    const list = Array.isArray(data) ? data : row(data).book_shelf_info ?? row(data).bookShelfInfo
    if (!Array.isArray(list)) throw new FanqieError('PROTOCOL_CHANGED', '番茄书架格式变化。')
    const ids = rows(list).map(item => fanqieId(item.book_id ?? item.bookId)).filter(Boolean)
    if (!ids.length) return []
    if (ids.length > 1000) throw new FanqieError('SHELF_LIMIT', '番茄书架超过当前支持的 1000 本。')
    const progress = await this.progress(cookies, signal)
    const books: FanqieShelfBook[] = []
    for (let offset = 0; offset < ids.length; offset += 50) {
      const detail = apiData((await this.request('/api/bookshelf/multidetail', cookies, signal, { books: ids.slice(offset, offset + 50)
        .map(book_id => ({ book_id, item_id: progress.find(item => item.bookId === book_id)?.chapterId ?? '0' })) })).value)
      if (!Array.isArray(row(detail).detail_list)) throw new FanqieError('PROTOCOL_CHANGED', '番茄书籍详情格式变化。')
      for (const item of rows(row(detail).detail_list)) {
        const id = fanqieId(item.book_id ?? item.bookId)
        if (id) books.push({ id, name: String(item.book_name ?? item.title ?? item.name ?? '未命名'), author: String(item.author ?? item.author_name ?? ''),
          chapterId: progress.find(position => position.bookId === id)?.chapterId ?? '' })
      }
    }
    return books
  }
}
