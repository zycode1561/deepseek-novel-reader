import { z } from 'zod'
import rawRules from '../../rules/main.json' with { type: 'json' }

const selector = z.string().optional().default('')

const searchRuleSchema = z.object({
  disabled: z.boolean().optional().default(false),
  baseUri: selector,
  timeout: z.number().int().positive().optional(),
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
  concurrency: z.number().int().positive().optional(),
  minInterval: z.number().nonnegative().optional(),
  maxInterval: z.number().nonnegative().optional(),
  maxAttempts: z.number().int().positive().optional(),
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

export function loadBuiltinRules(): SourceRule[] {
  const parsed = z.array(sourceRuleSchema).parse(rawRules)
  return parsed.map((rule, index) => {
    validateHttpUrl(rule.url, `source URL at index ${index}`)
    validateHttpUrl(rule.search.url, `search URL at index ${index}`)
    validateHttpUrl(rule.search.baseUri, `search base URI at index ${index}`, true)
    validateHttpUrl(rule.toc.url, `TOC URL at index ${index}`, true)
    validateHttpUrl(rule.toc.baseUri, `TOC base URI at index ${index}`, true)
    if (rule.crawl?.minInterval !== undefined && rule.crawl.maxInterval !== undefined
      && rule.crawl.maxInterval < rule.crawl.minInterval) {
      throw new Error(`dsh-novel-reader: invalid crawl interval at rule index ${index}`)
    }
    const hosts = [rule.url, rule.search.url, rule.search.baseUri, rule.toc.url, rule.toc.baseUri]
      .map(configuredHost)
      .filter((host): host is string => host !== null)
    if (hosts.length === 0) throw new Error(`dsh-novel-reader: rule index ${index} has no allowed HTTP host`)
    return {
      ...rule,
      id: `sonovel-${index + 1}`,
      allowedHosts: new Set(hosts),
    }
  }).filter(rule => !rule.disabled && !rule.search.disabled)
}
