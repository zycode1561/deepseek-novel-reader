export type RuleFormat = 'any-reader' | 'sonovel'
export interface RuleDiagnostic { field: string; message: string }
export interface ManagedRule {
  id: string
  name: string
  kind: 'builtin' | 'custom'
  format: RuleFormat
  enabled: boolean
  compatible: boolean
  diagnostics: RuleDiagnostic[]
  raw: Record<string, unknown>
}
export interface RuleImportItem extends ManagedRule { duplicate: boolean }
export interface RuleImportPreview { token: string; items: RuleImportItem[] }
export interface RuleImportResult { imported: number; skipped: number }
export interface RuleTestItem { handle: string; title: string; author?: string; url: string }
export interface RuleTestResponse {
  stage: 'search' | 'toc' | 'content'
  requests: string[]
  items: RuleTestItem[]
  paragraphs: string[]
  diagnostics: RuleDiagnostic[]
}
export interface RuleTestRequest {
  raw: Record<string, unknown>
  format: RuleFormat
  stage: RuleTestResponse['stage']
  keyword?: string
  handle?: string
}

export const ANY_READER_TEMPLATE: Record<string, unknown> = {
  name: '我的小说书源', host: 'https://example.com', contentType: 1,
  author: '', sort: 0, userAgent: '', enableSearch: true,
  searchUrl: '/search?q=$keyword', searchList: '.book',
  searchName: 'a@text', searchAuthor: '.author@text', searchResult: 'a@href',
  chapterUrl: '$result', chapterList: '.chapters a', chapterName: '@text', chapterResult: '@href',
  contentUrl: '$result', contentItems: '#content@html', chapterNextUrl: '', contentNextUrl: '',
}
