import { createHash, randomUUID } from 'node:crypto'
import type { RuleTestRequest, RuleTestResponse } from '../shared/rules.ts'
import type { OnlineSourceEngine, ResolvedOnlineResult, ChapterLink } from './engine.ts'
import type { SourceRule } from './rules.ts'
import { compileRule, RuleStoreError } from './rule-store.ts'
import { RuleExpressionError } from './expressions.ts'

type HandleValue = { kind: 'book'; result: ResolvedOnlineResult } | { kind: 'chapter'; source: SourceRule; link: ChapterLink }
export class RuleTests {
  private readonly handles = new Map<string, { value: HandleValue; fingerprint: string; expiresAt: number }>()
  constructor(private readonly engine: OnlineSourceEngine) {}
  dispose(): void { this.handles.clear() }
  private add(value: HandleValue, fingerprint: string): string {
    if (this.handles.size >= 2000) this.handles.delete(this.handles.keys().next().value!)
    const id = randomUUID()
    this.handles.set(id, { value, fingerprint, expiresAt: Date.now() + 15 * 60_000 })
    return id
  }
  private get(id: string | undefined, fingerprint: string): HandleValue {
    const entry = id ? this.handles.get(id) : undefined
    if (!entry || entry.fingerprint !== fingerprint || entry.expiresAt < Date.now()) {
      throw new RuleStoreError('TEST_EXPIRED', '测试结果已过期或规则已修改，请从搜索重新测试。')
    }
    return entry.value
  }
  async run(input: RuleTestRequest, signal: AbortSignal): Promise<RuleTestResponse> {
    for (const [id, value] of this.handles) if (value.expiresAt < Date.now()) this.handles.delete(id)
    const fingerprint = createHash('sha256').update(JSON.stringify([input.format, input.raw])).digest('hex')
    const response: RuleTestResponse = { stage: input.stage, requests: [], items: [], paragraphs: [], diagnostics: [] }
    try {
      const source = compileRule(input.raw, input.format, `test:${fingerprint}`)
      if (input.stage === 'search') {
        const keyword = input.keyword?.trim() ?? ''
        if (!keyword || keyword.length > 100) throw new RuleStoreError('INVALID_QUERY', '请输入 1–100 个字符的测试关键词。')
        const results = await this.engine.previewSearch(source, keyword, signal, response.requests)
        response.items = results.slice(0, 100).map(result => ({ handle: this.add({ kind: 'book', result }, fingerprint), title: result.public.bookName, author: result.public.author, url: result.bookUrl }))
        if (!response.items.length) response.diagnostics.push({ field: 'searchList', message: '未提取到有效搜索结果，请检查列表、名称与结果规则。' })
      } else if (input.stage === 'toc') {
        const handle = this.get(input.handle, fingerprint)
        if (handle.kind !== 'book') throw new RuleStoreError('INVALID_TEST', '请选择搜索结果进行目录测试。')
        const links = await this.engine.previewToc(handle.result, signal, response.requests)
        response.items = links.slice(0, 100).map(link => ({ handle: this.add({ kind: 'chapter', source: handle.result.source, link }, fingerprint), title: link.title, url: link.url }))
      } else {
        const handle = this.get(input.handle, fingerprint)
        if (handle.kind !== 'chapter') throw new RuleStoreError('INVALID_TEST', '请选择章节进行正文测试。')
        const chapter = await this.engine.previewContent(handle.source, handle.link, signal, response.requests)
        response.paragraphs = chapter.paragraphs
      }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof RuleStoreError) throw error
      response.diagnostics = [{ field: error instanceof RuleExpressionError ? error.field : input.stage,
        message: error instanceof Error ? error.message : String(error) }]
    }
    return response
  }
}
