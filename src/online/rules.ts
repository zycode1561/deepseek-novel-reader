import { z } from 'zod'
import rawRules from '../../rules/main.json' with { type: 'json' }
import type { AnyReaderRule } from './any-reader.ts'

const selector = z.string().optional().default('')

const searchRuleSchema = z.object({
  disabled: z.boolean().optional().default(false),
  baseUri: selector,
  timeout: z.number().int().min(1000).max(120_000).optional(),
  url: z.string().min(1),
  method: z.enum(['get', 'post', 'GET', 'POST']),
  data: selector,
  cookies: selector,
  result: z.string().min(1),
  bookName: z.string().min(1),
  author: selector,
  category: selector,
  latestChapter: selector,
  lastUpdateTime: selector,
  status: selector,
  wordCount: selector,
  nextPage: selector,
})

const bookRuleSchema = z.object({
  url: selector,
  bookName: selector,
  author: selector,
  intro: selector,
  category: selector,
  coverUrl: selector,
  latestChapter: selector,
  latestChapterUrl: selector,
  lastUpdateTime: selector,
  status: selector,
}).default({
  url: '', bookName: '', author: '', intro: '', category: '', coverUrl: '',
  latestChapter: '', latestChapterUrl: '', lastUpdateTime: '', status: '',
})

const tocRuleSchema = z.object({
  baseUri: selector,
  url: selector,
  list: selector,
  item: z.string().min(1),
  isDesc: z.boolean().optional().default(false),
  nextPage: selector,
})

const chapterRuleSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  paragraphTagClosed: z.union([z.boolean(), z.enum(['true', 'false'])]).optional().default(false),
  paragraphTag: selector,
  filterTxt: selector,
  filterTag: selector,
  nextPage: selector,
})

const crawlRuleSchema = z.object({
  concurrency: z.number().int().min(1).max(50).optional(),
  minInterval: z.number().min(0).max(60).optional(),
  maxInterval: z.number().min(0).max(60).optional(),
  maxAttempts: z.number().int().min(1).max(11).optional(),
  retryMinInterval: z.number().nonnegative().optional(),
  retryMaxInterval: z.number().nonnegative().optional(),
}).optional()

const sourceRuleSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1),
  comment: z.string().optional().default(''),
  language: z.string().optional().default(''),
  disabled: z.boolean().optional().default(false),
  search: searchRuleSchema,
  book: bookRuleSchema,
  toc: tocRuleSchema,
  chapter: chapterRuleSchema,
  crawl: crawlRuleSchema,
})

export type SearchRule = z.infer<typeof searchRuleSchema>
export type BookRule = z.infer<typeof bookRuleSchema>
export type TocRule = z.infer<typeof tocRuleSchema>
export type ChapterRule = z.infer<typeof chapterRuleSchema>

export interface SourceRule extends z.infer<typeof sourceRuleSchema> {
  id: string
  allowedHosts: ReadonlySet<string>
  anyReader?: AnyReaderRule
  revision?: string
  builtinTransform?: string
}

function selectorBase(value: string): string {
  return value.split('@js:', 1)[0] ?? value
}

function configuredHost(value: string): string | null {
  const base = selectorBase(value)
  if (!/^https?:\/\//iu.test(base)) return null
  try {
    return new URL(base.replace('%s', 'placeholder')).hostname.toLocaleLowerCase()
  } catch {
    return null
  }
}

function validateHttpUrl(value: string, label: string, optional = false): void {
  const candidate = selectorBase(value).trim()
  if (candidate.length === 0 && optional) return
  try {
    const parsed = new URL(candidate.replaceAll('%s', 'placeholder'))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
  } catch (cause) {
    throw new Error(`dsh-novel-reader: invalid ${label} in bundled rules`, { cause })
  }
}

export function parseSoNovelRule(raw: unknown, id: string): SourceRule {
  const rule = sourceRuleSchema.parse(raw)
  validateHttpUrl(rule.url, `source URL in ${id}`)
  validateHttpUrl(rule.search.url, `search URL in ${id}`)
  validateHttpUrl(rule.search.baseUri, `search base URI in ${id}`, true)
  validateHttpUrl(rule.toc.url, `TOC URL in ${id}`, true)
  validateHttpUrl(rule.toc.baseUri, `TOC base URI in ${id}`, true)
  if (rule.crawl?.minInterval !== undefined && rule.crawl.maxInterval !== undefined
    && rule.crawl.maxInterval < rule.crawl.minInterval) {
    throw new Error(`dsh-novel-reader: invalid crawl interval in ${id}`)
  }
  const hosts = [rule.url, rule.search.url, rule.search.baseUri, rule.toc.url, rule.toc.baseUri]
    .map(configuredHost)
    .filter((host): host is string => host !== null)
  if (hosts.length === 0) throw new Error(`dsh-novel-reader: rule ${id} has no allowed HTTP host`)
  return {
    ...rule,
    id,
    allowedHosts: new Set(hosts),
    ...(typeof (raw as Record<string, unknown>).builtinTransform === 'string'
      ? { builtinTransform: String((raw as Record<string, unknown>).builtinTransform) } : {}),
  }
}

export function loadBuiltinRules(): SourceRule[] {
  const rules = z.array(z.unknown()).parse(rawRules)
  return rules.map((rule, index) => parseSoNovelRule(rule, `sonovel-${index + 1}`))
    .filter(rule => !rule.disabled && !rule.search.disabled)
}
