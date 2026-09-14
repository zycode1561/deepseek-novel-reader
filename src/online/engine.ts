import { lookup as lookupCallback } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { Buffer } from 'node:buffer'
import { load, type CheerioAPI } from 'cheerio'
import { Agent, ProxyAgent, fetch, type Dispatcher } from 'undici'
import { MAX_FILE_BYTES } from '../shared/constants.ts'
import { buildOnlineBook, OnlineBookBuildError, type CrawledChapter } from '../shared/online-book.ts'
import type { Book, OnlineBookResult, OnlineSearchResponse, OnlineSourceInfo } from '../shared/types.ts'
import { loadBuiltinRules, type ChapterRule, type SourceRule } from './rules.ts'

const MAX_HTML_BYTES = 8 * 1024 * 1024
const MAX_REDIRECTS = 5
const MAX_PAGES = 12
const MAX_CHAPTERS = 10_000

export interface OnlineEngineConfig {
  searchConcurrency: number
  chapterConcurrency: number
  requestTimeoutMs: number
  searchTimeoutMs: number
  maxRetries: number
  minRequestIntervalMs: number
  maxRequestIntervalMs: number
  maxSearchResults: number
  proxyUrl?: string
}

export interface ResolvedOnlineResult {
  public: OnlineBookResult
  source: SourceRule
  bookUrl: string
}

export interface SearchRunResult extends OnlineSearchResponse {
  resolved: ResolvedOnlineResult[]
}

interface FetchDocumentResult {
  html: string
  url: string
}

interface ChapterLink {
  title: string
  url: string
}

export class OnlineEngineError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'SOURCE_UNAVAILABLE'
      | 'TOC_EMPTY'
      | 'BOOK_TOO_LARGE'
      | 'TOO_MANY_CHAPTERS'
      | 'REQUEST_FAILED'
      | 'CANCELLED',
  ) {
    super(message)
    this.name = 'OnlineEngineError'
  }
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true
  const [a, b] = parts as [number, number, number, number]
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && parts[2] === 0)
    || (a === 192 && b === 0 && parts[2] === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && parts[2] === 100)
    || (a === 203 && b === 0 && parts[2] === 113)
}

/**
 * Clash and similar TUN-based proxies commonly synthesize DNS answers from
 * 198.18.0.0/15. The range is not publicly routable, but the proxy intercepts
 * connections to it and forwards them to the original hostname.
 *
 * We accept it only after the hostname has passed the bundled source
 * allowlist. All ordinary loopback, LAN, link-local and metadata ranges stay
 * blocked.
 */
function isSyntheticProxyIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return first === 198 && (second === 18 || second === 19)
}

function isAllowedSourceAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase().split('%', 1)[0]!
  return !isPrivateAddress(normalized) || isSyntheticProxyIpv4(normalized)
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase().split('%', 1)[0]!
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized)
  if (isIP(normalized) !== 6) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89a-f]/u.test(normalized) || normalized.startsWith('ff')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1]
  if (mapped !== undefined) return isPrivateIpv4(mapped)
  const mappedHex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u.exec(normalized)
  if (mappedHex !== null) {
    const high = Number.parseInt(mappedHex[1]!, 16)
    const low = Number.parseInt(mappedHex[2]!, 16)
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  return false
}

const controlledLookup: LookupFunction = (hostname, options, callback) => {
  lookupCallback(hostname, { all: true, verbatim: true, family: options.family }, (error, addresses) => {
    if (error !== null) {
      callback(error, '', 0)
      return
    }
    const allowedAddresses = addresses.filter(item => isAllowedSourceAddress(item.address))
    if (allowedAddresses.length === 0) {
      const denied = Object.assign(new Error('DNS resolved to a private address'), { code: 'EACCES' })
      callback(denied, '', 0)
      return
    }
    if (options.all) callback(null, allowedAddresses)
    else callback(null, allowedAddresses[0]!.address, allowedAddresses[0]!.family)
  })
}

type AddressResolver = (hostname: string) => Promise<readonly { address: string }[]>

export async function validateSourceUrl(
  source: SourceRule,
  rawUrl: string,
  resolveAddresses: AddressResolver = async hostname => await lookup(hostname, { all: true, verbatim: true }),
): Promise<URL> {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OnlineEngineError('书源使用了不安全的 URL 协议。', 'REQUEST_FAILED')
  if (url.username !== '' || url.password !== '') throw new OnlineEngineError('书源 URL 不得包含凭据。', 'REQUEST_FAILED')
  const hostname = url.hostname.toLocaleLowerCase()
  if (!source.allowedHosts.has(hostname)) throw new OnlineEngineError('书源跳转到了未授权主机。', 'REQUEST_FAILED')
  if (isIP(hostname) !== 0 && isPrivateAddress(hostname)) throw new OnlineEngineError('已阻止书源访问本机或私有网络。', 'REQUEST_FAILED')
  const addresses = await resolveAddresses(hostname)
  if (addresses.length === 0 || addresses.some(item => !isAllowedSourceAddress(item.address))) {
    throw new OnlineEngineError('书源域名解析到了本机或私有网络。', 'REQUEST_FAILED')
  }
  return url
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function normalizeForScore(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function relevance(item: OnlineBookResult, query: string): number {
  const needle = normalizeForScore(query)
  const title = normalizeForScore(item.bookName)
  const author = normalizeForScore(item.author)
  if (title === needle) return 100
  if (title.includes(needle)) return 80 - Math.min(20, title.length - needle.length)
  if (author === needle) return 70
  if (author.includes(needle)) return 55
  return title.split('').filter(character => needle.includes(character)).length
}

function splitSelector(value: string): { selector: string; hasScript: boolean } {
  const index = value.indexOf('@js:')
  return index < 0
    ? { selector: value, hasScript: false }
    : { selector: value.slice(0, index), hasScript: true }
}

function parseAttributeSelector(value: string): { selector: string; attribute?: string } {
  const plain = splitSelector(value).selector
  const match = /^(.*)@([a-zA-Z][\w-]*)$/u.exec(plain)
  return match === null ? { selector: plain } : { selector: match[1]!, attribute: match[2]! }
}

function selectedValue($: CheerioAPI, root: ReturnType<CheerioAPI>, selectorValue: string): string {
  if (selectorValue.trim().length === 0) return ''
  const parsed = parseAttributeSelector(selectorValue)
  const element = root.find(parsed.selector).addBack(parsed.selector).first()
  if (element.length === 0) return ''
  if (parsed.attribute !== undefined) return cleanText(element.attr(parsed.attribute) ?? '')
  const tagName = element.prop('tagName')?.toLocaleLowerCase()
  if (tagName === 'meta') return cleanText(element.attr('content') ?? '')
  return cleanText(element.text())
}

function selectedUrl($: CheerioAPI, root: ReturnType<CheerioAPI>, selectorValue: string, baseUrl: string): string {
  const parsed = parseAttributeSelector(selectorValue)
  const element = parsed.selector.trim().length === 0
    ? root.first()
    : root.find(parsed.selector).addBack(parsed.selector).first()
  const raw = element.attr(parsed.attribute ?? 'href') ?? element.attr('value') ?? ''
  if (raw.trim().length === 0) return ''
  try {
    return new URL(raw, baseUrl).toString()
  } catch {
    return ''
  }
}

function formData(template: string, query: string): URLSearchParams {
  const params = new URLSearchParams()
  const body = template.trim().replace(/^\{/u, '').replace(/\}$/u, '')
  if (body.length === 0) return params
  for (const entry of body.split(',')) {
    const separator = entry.indexOf(':')
    if (separator < 0) continue
    const key = entry.slice(0, separator).trim().replace(/^['"]|['"]$/gu, '')
    const value = entry.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, '').replaceAll('%s', query)
    if (key.length > 0) params.append(key, value)
  }
  return params
}

function randomBetween(minimum: number, maximum: number): number {
  if (maximum <= minimum) return minimum
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1))
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

async function mapLimit<T, R>(items: readonly T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      output[index] = await mapper(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return output
}

async function mapLimitSettled<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  let active = 0
  const waiting: Array<() => void> = []
  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise<void>(resolve => waiting.push(resolve))
    active += 1
  }
  const release = (): void => {
    active -= 1
    waiting.shift()?.()
  }
  return await Promise.allSettled(items.map(async (item, index) => {
    await acquire()
    try {
      return await mapper(item, index)
    } finally {
      release()
    }
  }))
}

function decodeHtml(bytes: ArrayBuffer, contentType: string | null): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/iu.exec(contentType ?? '')?.[1]?.toLocaleLowerCase()
  const data = new Uint8Array(bytes)
  const labels = charset !== undefined ? [charset, 'utf-8', 'gb18030'] : ['utf-8', 'gb18030']
  for (const label of [...new Set(labels)]) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(data)
    } catch {
      // Try the next declared/common encoding.
    }
  }
  return new TextDecoder('utf-8').decode(data)
}

export function transformWxsyToc(value: string): string {
  const before = [...value.matchAll(/\.section-list\.ycxsid>li:nth-child\(\d+\)\{display:none\}/gu)].length
  const after = [...value.matchAll(/\.section-list\.ycxsid>li:nth-last-child\(\d+\)\{display:none\}/gu)].length
  return value.replace(/(<ul[^>]*class="[^"]*\bsection-list\b[^"]*\bycxsid\b[^"]*">)([\s\S]*?)(<\/ul>)/giu, (_all, open: string, body: string, close: string) => {
    const items = body.match(/<li[\s\S]*?<\/li>/giu) ?? []
    return `${open}${items.slice(before, Math.max(before, items.length - after)).join('')}${close}`
  })
}

export function transformBase64Chapter(value: string, removeRecommendations = false): string {
  const decoded = value.replace(/<script>\s*document\.writeln\([^']*'([^']+)'\s*\)\s*\);\s*<\/script>/giu, (_all, encoded: string) => {
    try {
      return Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      return ''
    }
  })
  return removeRecommendations
    ? decoded.replace(/<p[^>]*>相邻推荐:[\s\S]*?<\/p>/giu, '')
    : decoded
}

export function transformWxsyChapter(value: string): string {
  return transformBase64Chapter(value, true)
}

export function transformRanwenChapter(value: string): string {
  return transformBase64Chapter(value, false)
}

function sourceTransformation(source: SourceRule, stage: 'search' | 'toc' | 'chapter', value: string): string {
  if (stage === 'toc' && source.id === 'sonovel-9') return transformWxsyToc(value)
  if (stage === 'chapter' && source.id === 'sonovel-9') return transformWxsyChapter(value)
  if (stage === 'chapter' && source.id === 'sonovel-11') return transformRanwenChapter(value)
  return value
}

function paragraphsFromHtml(source: SourceRule, html: string, rule: ChapterRule): string[] {
  const transformed = sourceTransformation(source, 'chapter', html)
  const $ = load(`<section id="dnr-content">${transformed}</section>`)
  const root = $('#dnr-content')
  if (rule.filterTag.trim().length > 0) root.find(rule.filterTag).remove()
  let normalized = root.html() ?? ''
  if (rule.paragraphTag.trim().length > 0) {
    try {
      normalized = normalized.replace(new RegExp(rule.paragraphTag, 'giu'), '\n')
    } catch {
      normalized = normalized.replace(/<br\s*\/?\s*>/giu, '\n')
    }
  }
  normalized = normalized.replace(/<\/(p|div|li|blockquote|h[1-6])>/giu, '</$1>\n').replace(/<br\s*\/?\s*>/giu, '\n')
  const text = load(`<div>${normalized}</div>`).root().text()
  let filtered = text.replace(/\r/gu, '')
  if (rule.filterTxt.trim().length > 0) {
    try {
      filtered = filtered.replace(new RegExp(rule.filterTxt, 'giu'), '')
    } catch {
      // A malformed optional filter must not discard an otherwise readable chapter.
    }
  }
  return filtered.split('\n').map(cleanText).filter(Boolean)
}

export function parseSearchDocument(source: SourceRule, html: string, pageUrl: string): ResolvedOnlineResult[] {
  const $ = load(sourceTransformation(source, 'search', html), { baseURI: source.search.baseUri || pageUrl })
  const resultSelector = splitSelector(source.search.result).selector
  const results: ResolvedOnlineResult[] = []
  $(resultSelector).each((_index, element) => {
    const root = $(element)
    const bookName = selectedValue($, root, source.search.bookName)
    const bookUrl = selectedUrl($, root, source.search.bookName, source.search.baseUri || pageUrl)
    if (bookName.length === 0 || bookUrl.length === 0) return
    const publicResult: OnlineBookResult = {
      id: '',
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: bookUrl,
      bookName,
      author: selectedValue($, root, source.search.author),
      intro: '',
      category: selectedValue($, root, source.search.category),
      latestChapter: selectedValue($, root, source.search.latestChapter),
      lastUpdateTime: selectedValue($, root, source.search.lastUpdateTime),
      status: selectedValue($, root, source.search.status),
      wordCount: selectedValue($, root, source.search.wordCount),
    }
    results.push({ public: publicResult, source, bookUrl })
  })
  return results
}

export class OnlineSourceEngine {
  readonly sources: SourceRule[]
  private readonly dispatcher: Dispatcher
  private readonly cookies = new Map<string, Map<string, string>>()

  constructor(private readonly config: OnlineEngineConfig) {
    this.sources = loadBuiltinRules()
    this.dispatcher = config.proxyUrl === undefined
      ? new Agent({ connect: { timeout: config.requestTimeoutMs, lookup: controlledLookup } })
      : new ProxyAgent(config.proxyUrl)
  }

  async dispose(): Promise<void> {
    this.cookies.clear()
    await this.dispatcher.close()
  }

  listSources(): OnlineSourceInfo[] {
    return this.sources.map(source => ({ id: source.id, name: source.name, url: source.url, comment: source.comment }))
  }

  private async assertSafeUrl(source: SourceRule, rawUrl: string): Promise<URL> {
    return await validateSourceUrl(source, rawUrl)
  }

  private async request(source: SourceRule, rawUrl: string, init: { method?: string; body?: URLSearchParams; signal: AbortSignal }): Promise<FetchDocumentResult> {
    let url = await this.assertSafeUrl(source, rawUrl)
    let method = init.method
    let body = init.body
    let referer = `${url.protocol}//${url.host}/`
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const timeout = AbortSignal.timeout(source.search.timeout ?? this.config.requestTimeoutMs)
      const signal = AbortSignal.any([init.signal, timeout])
      let response
      try {
        const storedCookies = [...(this.cookies.get(source.id)?.entries() ?? [])]
          .map(([name, value]) => `${name}=${value}`).join('; ')
        const cookie = [source.search.cookies.trim(), storedCookies].filter(Boolean).join('; ')
        response = await fetch(url, {
          ...(method === undefined ? {} : { method }),
          ...(body === undefined ? {} : { body }),
          signal,
          redirect: 'manual',
          dispatcher: this.dispatcher,
          headers: {
            accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9',
            'user-agent': 'Mozilla/5.0 (compatible; DSHNovelReader/0.2; +https://github.com/zycode1561/deepseek-novel-reader)',
            referer,
            ...(cookie.length > 0 ? { cookie } : {}),
          },
        })
      } catch (error) {
        if (init.signal.aborted) throw new OnlineEngineError('抓取已取消。', 'CANCELLED')
        if (signal.aborted) throw new OnlineEngineError('书源请求超时。', 'SOURCE_UNAVAILABLE')
        throw new OnlineEngineError(error instanceof Error ? error.message : '书源请求失败。', 'REQUEST_FAILED')
      }
      const setCookies = response.headers.getSetCookie()
      if (setCookies.length > 0) {
        const jar = this.cookies.get(source.id) ?? new Map<string, string>()
        for (const header of setCookies) {
          const pair = header.split(';', 1)[0] ?? ''
          const separator = pair.indexOf('=')
          if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
        }
        this.cookies.set(source.id, jar)
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (location === null) throw new OnlineEngineError('书源返回了无目标的重定向。', 'REQUEST_FAILED')
        referer = url.toString()
        url = await this.assertSafeUrl(source, new URL(location, url).toString())
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method?.toLocaleUpperCase() === 'POST')) {
          method = 'GET'
          body = undefined
        }
        continue
      }
      if (!response.ok) throw new OnlineEngineError(`书源返回 HTTP ${response.status}。`, 'SOURCE_UNAVAILABLE')
      const declared = Number(response.headers.get('content-length') ?? '0')
      if (declared > MAX_HTML_BYTES) throw new OnlineEngineError('书源页面体积超过安全限制。', 'REQUEST_FAILED')
      let bytes: ArrayBuffer
      try {
        bytes = await response.arrayBuffer()
      } catch (error) {
        if (init.signal.aborted) throw new OnlineEngineError('抓取已取消。', 'CANCELLED')
        if (signal.aborted) throw new OnlineEngineError('书源请求超时。', 'SOURCE_UNAVAILABLE')
        throw new OnlineEngineError(error instanceof Error ? error.message : '书源响应读取失败。', 'REQUEST_FAILED')
      }
      if (bytes.byteLength > MAX_HTML_BYTES) throw new OnlineEngineError('书源页面体积超过安全限制。', 'REQUEST_FAILED')
      return { html: decodeHtml(bytes, response.headers.get('content-type')), url: url.toString() }
    }
    throw new OnlineEngineError('书源重定向次数过多。', 'REQUEST_FAILED')
  }

  private async searchSource(source: SourceRule, query: string, signal: AbortSignal): Promise<ResolvedOnlineResult[]> {
    const searchUrl = source.search.url.replaceAll('%s', encodeURIComponent(query))
    const method = source.search.method.toLocaleUpperCase()
    const first = await this.request(source, searchUrl, {
      method,
      ...(method === 'POST' ? { body: formData(source.search.data, query) } : {}),
      signal,
    })
    const pages = [first]
    if (source.search.nextPage.trim().length > 0) {
      const $ = load(sourceTransformation(source, 'search', first.html))
      const urls = $(source.search.nextPage).toArray().map(element => selectedUrl($, $(element), '', first.url)).filter(Boolean)
      for (const url of [...new Set(urls)].slice(0, MAX_PAGES - 1)) pages.push(await this.request(source, url, { signal }))
    }

    const results: ResolvedOnlineResult[] = []
    for (const page of pages) {
      results.push(...parseSearchDocument(source, page.html, page.url))
    }
    return results
  }

  async search(query: string, signal: AbortSignal): Promise<SearchRunResult> {
    const timeout = AbortSignal.timeout(this.config.searchTimeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const settled = await mapLimitSettled(
      this.sources,
      this.config.searchConcurrency,
      source => this.searchSource(source, query, combined),
    )
    const merged = settled.flatMap(item => item.status === 'fulfilled' ? item.value : [])
    const unique = [...new Map(merged.map(item => [`${item.source.id}:${item.bookUrl}`, item])).values()]
      .sort((left, right) => relevance(right.public, query) - relevance(left.public, query))
      .slice(0, this.config.maxSearchResults)
    return {
      results: unique.map(item => item.public),
      resolved: unique,
      failedSources: settled.filter(item => item.status === 'rejected').length,
      searchedSources: this.sources.length,
    }
  }

  private resolveTocUrl(result: ResolvedOnlineResult): { url: string; baseUri: string } {
    const { source, bookUrl } = result
    const usesIdentifier = source.toc.url.includes('%s') || source.toc.baseUri.includes('%s')
    let identifier = ''
    if (usesIdentifier) {
      if (source.book.url.trim().length === 0) throw new OnlineEngineError('书源缺少目录 URL 所需的书籍标识规则。', 'TOC_EMPTY')
      identifier = new RegExp(source.book.url, 'u').exec(bookUrl)?.[1] ?? ''
      if (identifier.length === 0) throw new OnlineEngineError('无法从书籍链接解析目录标识。', 'TOC_EMPTY')
    }
    return {
      url: (source.toc.url || bookUrl).replaceAll('%s', identifier),
      baseUri: (source.toc.baseUri || source.toc.url || bookUrl).replaceAll('%s', identifier),
    }
  }

  private async loadBookDetails(result: ResolvedOnlineResult, signal: AbortSignal): Promise<FetchDocumentResult> {
    const document = await this.request(result.source, result.bookUrl, { signal })
    const $ = load(document.html, { baseURI: document.url })
    const fields = result.source.book
    result.public = {
      ...result.public,
      bookName: selectedValue($, $.root(), fields.bookName) || result.public.bookName,
      author: selectedValue($, $.root(), fields.author) || result.public.author,
      intro: selectedValue($, $.root(), fields.intro) || result.public.intro,
      category: selectedValue($, $.root(), fields.category) || result.public.category,
      latestChapter: selectedValue($, $.root(), fields.latestChapter) || result.public.latestChapter,
      lastUpdateTime: selectedValue($, $.root(), fields.lastUpdateTime) || result.public.lastUpdateTime,
      status: selectedValue($, $.root(), fields.status) || result.public.status,
    }
    return document
  }

  private tocLinks(source: SourceRule, html: string, pageUrl: string, baseUri: string): ChapterLink[] {
    const transformed = splitSelector(source.toc.list).hasScript ? sourceTransformation(source, 'toc', html) : html
    const $ = load(transformed, { baseURI: baseUri || pageUrl })
    return $(source.toc.item).toArray().flatMap(element => {
      const root = $(element)
      const url = selectedUrl($, root, '', baseUri || pageUrl)
      const title = cleanText(root.text())
      return url.length > 0 && title.length > 0 ? [{ title, url }] : []
    })
  }

  private async loadToc(result: ResolvedOnlineResult, signal: AbortSignal, details: FetchDocumentResult): Promise<ChapterLink[]> {
    const { source } = result
    const toc = this.resolveTocUrl(result)
    const first = source.toc.url.trim().length === 0 ? details : await this.request(source, toc.url, { signal })
    const pages = [first]
    if (source.toc.nextPage.trim().length > 0) {
      const transformed = splitSelector(source.toc.list).hasScript ? sourceTransformation(source, 'toc', first.html) : first.html
      const $ = load(transformed, { baseURI: toc.baseUri || first.url })
      const urls = $(source.toc.nextPage).toArray().map(element => selectedUrl($, $(element), '', toc.baseUri || first.url)).filter(Boolean)
      for (const url of [...new Set(urls)].slice(0, MAX_PAGES - 1)) pages.push(await this.request(source, url, { signal }))
    }
    const links = [...new Map(pages.flatMap(page => this.tocLinks(source, page.html, page.url, toc.baseUri)).map(link => [link.url, link])).values()]
    if (source.toc.isDesc) links.reverse()
    if (links.length === 0) throw new OnlineEngineError('源站章节目录为空。', 'TOC_EMPTY')
    if (links.length > MAX_CHAPTERS) throw new OnlineEngineError(`章节数量超过 ${MAX_CHAPTERS} 的安全限制。`, 'TOO_MANY_CHAPTERS')
    return links
  }

  private async loadChapter(source: SourceRule, link: ChapterLink, signal: AbortSignal): Promise<CrawledChapter> {
    let url = link.url
    let title = link.title
    const paragraphs: string[] = []
    const visited = new Set<string>()
    for (let page = 0; page < MAX_PAGES && url.length > 0 && !visited.has(url); page += 1) {
      visited.add(url)
      const document = await this.request(source, url, { signal })
      const $ = load(document.html, { baseURI: document.url })
      if (page === 0) title = selectedValue($, $.root(), source.chapter.title) || title
      const contentSelector = splitSelector(source.chapter.content).selector
      const selected = $(contentSelector)
      const html = selected.toArray().map(element => $(element).html() ?? '').join('\n')
      paragraphs.push(...paragraphsFromHtml(source, html, source.chapter))
      url = source.chapter.nextPage.trim().length > 0
        ? selectedUrl($, $.root(), source.chapter.nextPage, document.url)
        : ''
    }
    return { title, paragraphs }
  }

  async acquire(
    result: ResolvedOnlineResult,
    progress: (completed: number, total: number, retries: number) => void,
    signal: AbortSignal,
  ): Promise<Book> {
    const details = await this.loadBookDetails(result, signal)
    const links = await this.loadToc(result, signal, details)
    progress(0, links.length, 0)
    let completed = 0
    let retries = 0
    let downloadedBytes = 0
    const sourceConcurrency = result.source.crawl?.concurrency ?? this.config.chapterConcurrency
    const failureController = new AbortController()
    const acquisitionSignal = AbortSignal.any([signal, failureController.signal])
    let chapters: CrawledChapter[]
    try {
      chapters = await mapLimit(links, sourceConcurrency, async (link) => {
        let lastError: unknown
        const attempts = result.source.crawl?.maxAttempts ?? (this.config.maxRetries + 1)
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (acquisitionSignal.aborted) throw new OnlineEngineError('抓取已取消。', 'CANCELLED')
          const min = (result.source.crawl?.minInterval ?? this.config.minRequestIntervalMs / 1000) * 1000
          const max = (result.source.crawl?.maxInterval ?? this.config.maxRequestIntervalMs / 1000) * 1000
          await wait(randomBetween(Math.round(min), Math.round(max)), acquisitionSignal)
          try {
            const chapter = await this.loadChapter(result.source, link, acquisitionSignal)
            downloadedBytes += new TextEncoder().encode(`${chapter.title}\n${chapter.paragraphs.join('\n')}\n`).byteLength
            if (downloadedBytes > MAX_FILE_BYTES) {
              throw new OnlineEngineError('抓取后的正文超过 50MB，请选择分卷版本。', 'BOOK_TOO_LARGE')
            }
            completed += 1
            progress(completed, links.length, retries)
            return chapter
          } catch (error) {
            lastError = error
            if (error instanceof OnlineEngineError && (error.code === 'CANCELLED' || error.code === 'BOOK_TOO_LARGE')) throw error
            if (attempt + 1 < attempts) {
              retries += 1
              progress(completed, links.length, retries)
            }
          }
        }
        throw lastError instanceof Error ? lastError : new OnlineEngineError('章节抓取失败。', 'REQUEST_FAILED')
      })
    } catch (error) {
      failureController.abort()
      throw error
    }
    try {
      return buildOnlineBook({
        name: result.public.bookName,
        origin: {
          sourceId: result.source.id,
          sourceName: result.source.name,
          bookUrl: result.bookUrl,
          fetchedAt: Date.now(),
        },
        chapters,
      })
    } catch (error) {
      if (error instanceof OnlineBookBuildError) throw new OnlineEngineError(error.message, error.code)
      throw error
    }
  }
}
