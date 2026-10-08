import JSON5 from 'json5'
import type { RuleDiagnostic } from '../shared/rules.ts'
import type { SourceRule } from './rules.ts'
import { evaluate, extract, valueText, type ExpressionContext } from './expressions.ts'

export type AnyReaderRule = Record<string, unknown> & { host: string; name: string }
export interface RuleRequest { url: string; method: string; headers: Record<string, string>; body?: string }
const expressionFields = ['searchList', 'searchName', 'searchAuthor', 'searchCover', 'searchChapter', 'searchDescription', 'searchResult', 'searchNextUrl',
  'chapterList', 'chapterName', 'chapterResult', 'chapterNextUrl', 'contentItems', 'contentNextUrl']
const requiredFields = ['searchUrl', 'searchList', 'searchName', 'searchResult', 'chapterList', 'chapterName', 'chapterResult', 'contentItems']

export function field(rule: AnyReaderRule, key: string): string { return typeof rule[key] === 'string' ? rule[key] : '' }

function substitute(value: unknown, context: ExpressionContext, encodeKeyword = false): unknown {
  if (typeof value === 'string') {
    if (value === '$result') return context.result ?? ''
    if (value === '$lastResult') return context.lastResult ?? ''
    return value.replace(/\$(host|keyword|lastResult|result|pageSize|page)\b|searchKey|searchPage/g, (match, key: string | undefined) => {
      if (match === 'searchPage' || key === 'page') return '1'
      if (key === 'pageSize') return '20'
      const result = key === undefined ? context.keyword : context[key as keyof ExpressionContext]
      return (key === 'keyword' || match === 'searchKey') && encodeKeyword ? encodeURIComponent(valueText(result)) : valueText(result)
    })
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, context))
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, context)]))
  return value
}

function headerObject(value: unknown): Record<string, string> {
  if (value === undefined || value === '') return {}
  if (typeof value === 'string') value = value.trim().startsWith('{') ? JSON5.parse(value) : { 'user-agent': value }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求头必须是 JSON 对象。')
  const headers: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!/^[\w!#$%&'*+.^`|~-]+$/.test(key) || typeof item !== 'string' || /[\r\n]/.test(item)) throw new Error(`无效的请求头：${key}`)
    if (/^(host|content-length|connection|transfer-encoding|upgrade|proxy-.*|forwarded|x-forwarded-.*|x-real-ip)$/i.test(key)) throw new Error(`不允许覆盖请求头：${key}`)
    headers[key.toLowerCase()] = item
  }
  return headers
}

export function buildRuleRequest(rule: AnyReaderRule, key: string, context: ExpressionContext, baseUrl = rule.host): RuleRequest {
  const raw = rule[key]
  let description: unknown = raw === undefined || raw === '' ? context.result : raw
  if (typeof description === 'string' && description.trim().startsWith('{') && !description.trim().startsWith('{{')) description = JSON5.parse(description)
  if (typeof description === 'string') description = { url: description }
  if (description === null || typeof description !== 'object' || Array.isArray(description)) throw new Error(`${key}: 请求描述必须包含 URL。`)
  const params = description as Record<string, unknown>
  if (typeof params.url !== 'string') throw new Error(`${key}: 缺少 URL。`)
  let address = params.url
  if (/^@(css|json|xpath):|\{\{/.test(address)) address = extract(address, context.result, { ...context, keyword: encodeURIComponent(context.keyword ?? '') }, key)
  address = valueText(substitute(address, context, true))
  const url = new URL(address, baseUrl).toString()
  const parsedUrl = new URL(url)
  if (!/^https?:$/.test(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) throw new Error(`${key}: URL 必须是无凭据的 HTTP(S) 地址。`)
  const method = valueText(params.method || 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) throw new Error(`${key}: 仅支持 GET 和 POST。`)
  const headers = { ...headerObject(substitute(headerObject(rule.userAgent), context)), ...headerObject(substitute(headerObject(params.headers), context)) }
  const body = substitute(params.body ?? params.data, context)
  if (method === 'GET' && body !== undefined) throw new Error(`${key}: GET 请求不能带正文。`)
  if (body === undefined) return { url, method, headers }
  if (typeof body === 'object') {
    const contentType = headers['content-type']
    if (contentType?.includes('application/x-www-form-urlencoded')) {
      return { url, method, headers, body: new URLSearchParams(Object.entries(body ?? {}).map(([key, value]) => [key, valueText(value)])).toString() }
    }
    headers['content-type'] ??= 'application/json'
    return { url, method, headers, body: JSON.stringify(body) }
  }
  return { url, method, headers, body: valueText(body) }
}

export function diagnoseAnyReader(raw: Record<string, unknown>): RuleDiagnostic[] {
  const errors: RuleDiagnostic[] = []
  const add = (field: string, message: string): void => { errors.push({ field, message }) }
  if (raw.contentType !== undefined && raw.contentType !== 1) add('contentType', '首版仅支持小说（contentType: 1）。')
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !raw.id.trim())) add('id', '规则 ID 必须是非空字符串。')
  if (raw.sort !== undefined && (typeof raw.sort !== 'number' || !Number.isFinite(raw.sort))) add('sort', '排序必须是有限数值。')
  if (raw.enableSearch !== undefined && typeof raw.enableSearch !== 'boolean') add('enableSearch', '必须是布尔值。')
  if (typeof raw.name !== 'string' || !raw.name.trim()) add('name', '请填写书源名称。')
  try {
    const host = new URL(String(raw.host))
    if (!/^https?:$/.test(host.protocol) || host.username || host.password) throw new Error()
  } catch { add('host', '域名必须是无凭据的 HTTP(S) 地址。') }
  for (const key of requiredFields) {
    if (raw.enableSearch === false && key.startsWith('search')) continue
    if (key === 'searchUrl' && raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) continue
    if (typeof raw[key] !== 'string' || !String(raw[key]).trim()) add(key, '缺少必需规则。')
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && /@(?:js|hetu|web|webview|filter|http|encode|decode):/i.test(value)) add(key, '首版不执行脚本或浏览器规则。')
    if (['loadJs', 'contentDecoder', 'chapterRoads', 'chapterRoadName'].includes(key) && value) add(key, '首版不支持该功能。')
    if (key === 'enableMultiRoads' && value === true) add(key, '首版不支持多线路。')
    if (expressionFields.includes(key) && value !== undefined && typeof value !== 'string') add(key, '表达式必须是字符串。')
    if (expressionFields.includes(key) && typeof value === 'string' && value) {
      try {
        evaluate(value, /^@json:|^\$(?:[.\[]|$)/.test(value) ? '{}' : '<div></div>', { host: String(raw.host), result: {}, lastResult: {} }, key)
      } catch (error) { add(key, error instanceof Error ? error.message : String(error)) }
    }
  }
  if (raw.allowedHosts !== undefined && (!Array.isArray(raw.allowedHosts) || raw.allowedHosts.some(host => typeof host !== 'string' || !/^[a-z\d.-]+$/i.test(host)))) add('allowedHosts', '必须是域名数组，不支持通配符或路径。')
  if (typeof raw.host === 'string') {
    for (const key of ['searchUrl', 'chapterUrl', 'contentUrl']) {
      if (!raw[key]) continue
      try { buildRuleRequest(raw as AnyReaderRule, key, { host: raw.host, keyword: '测试', result: /\{\{|@json:/.test(JSON.stringify(raw[key])) ? { id: 'placeholder' } : `${raw.host}/book` }) }
      catch (error) { add(key, error instanceof Error ? error.message : String(error)) }
    }
  }
  return [...new Map(errors.map(error => [`${error.field}:${error.message}`, error])).values()]
}

export function compileAnyReader(raw: Record<string, unknown>, id: string): SourceRule {
  const diagnostics = diagnoseAnyReader(raw)
  if (diagnostics.length) throw new Error(diagnostics.map(item => `${item.field}: ${item.message}`).join('\n'))
  const rule = structuredClone(raw) as AnyReaderRule
  const allowedHosts = new Set([new URL(rule.host).hostname.toLowerCase()])
  for (const key of ['searchUrl', 'chapterUrl', 'contentUrl']) {
    const rawUrl = rule[key]
    let url = typeof rawUrl === 'object' && rawUrl !== null ? valueText((rawUrl as Record<string, unknown>).url) : valueText(rawUrl)
    if (typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') && !rawUrl.trim().startsWith('{{')) url = valueText((JSON5.parse(rawUrl) as Record<string, unknown>).url)
    const literalHost = /^(?:https?:)?\/\/([^/?#{}$]+)/i.exec(url)?.[1]
    if (literalHost) allowedHosts.add(new URL(`https://${literalHost}`).hostname.toLowerCase())
  }
  if (raw.allowedHosts !== undefined) {
    if (!Array.isArray(raw.allowedHosts)) throw new Error('allowedHosts: 必须是域名数组。')
    for (const host of raw.allowedHosts) {
      if (typeof host !== 'string' || !/^[a-z\d.-]+$/i.test(host)) throw new Error('allowedHosts: 不支持通配符或带路径的地址。')
      allowedHosts.add(host.toLowerCase())
    }
  }
  return {
    id, url: rule.host, name: rule.name, comment: valueText(rule.author), language: '', disabled: false, allowedHosts, anyReader: rule,
    search: { disabled: rule.enableSearch === false, baseUri: '', url: rule.host, method: 'GET', data: '', cookies: '', result: '', bookName: '', author: '', category: '', latestChapter: '', lastUpdateTime: '', status: '', wordCount: '', nextPage: '' },
    book: { url: '', bookName: '', author: '', intro: '', category: '', coverUrl: '', latestChapter: '', latestChapterUrl: '', lastUpdateTime: '', status: '' },
    toc: { baseUri: '', url: '', list: '', item: '', isDesc: false, nextPage: '' },
    chapter: { title: '', content: '', paragraphTagClosed: false, paragraphTag: '', filterTxt: '', filterTag: '', nextPage: '' },
  }
}
