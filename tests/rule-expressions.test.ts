import { describe, expect, it } from 'vitest'
import { evaluate, extract, textParagraphs } from '../src/online/expressions.ts'
import { buildRuleRequest, compileAnyReader, diagnoseAnyReader } from '../src/online/any-reader.ts'
import { ANY_READER_TEMPLATE } from '../src/shared/rules.ts'
import fixture from './fixtures/any-reader.json'

const context = { host: 'https://novels.example', keyword: '书 名', result: { id: 'book42' }, lastResult: { id: 'prior' } }
const html = '<ul><li class="book"><a href="/42">名字1</a><p class="author">张三</p></li><li class="book"><a href="/43">名字2</a></li></ul>'
describe('declarative AnyReader expressions', () => {
  it('extracts CSS lists, root attributes, text and inner/outer HTML', () => {
    const rows = evaluate('.book', html, context)
    expect(rows).toHaveLength(2)
    expect(extract('a@text', rows[0], context, 'name')).toBe('名字1')
    expect(extract('@href', '<a href="/42">标题</a>', context, 'link')).toBe('/42')
    expect(extract('a@outerHtml', rows[0], context, 'html')).toContain('<a href="/42">')
    expect(extract('a@innerHtml', rows[0], context, 'html')).toBe('名字1')
    expect(extract('.missing@text||.author@text', rows[0], context, 'author')).toBe('张三')
    expect(extract('a@text&&.author@text', rows[0], context, 'combined')).toBe('名字1  张三')
    expect(extract('a@text&&.missing@text||.author@text', rows[0], context, 'combinedFallback')).toBe('名字1  张三')
  })
  it('supports XPath nodes, attributes, text and scalar functions', () => {
    expect(evaluate('//*[@class="book"]', html, context)).toHaveLength(2)
    expect(extract('@xpath://a/@href', html, context, 'link')).toBe('/42  /43')
    expect(extract('//a/text()', html, context, 'name')).toBe('名字1  名字2')
    expect(extract('@xpath:count(//li)', html, context, 'count')).toBe('2')
  })
  it('preserves JSON objects and handles wildcards, slices and chained HTML', () => {
    expect(evaluate('$.books', fixture.pages['/api/search'], context)).toEqual(fixture.pages['/api/search'].books)
    expect(evaluate('$.a[:1]', { a: [1, 2] }, context)).toEqual([1])
    expect(extract('$.html@css:.author@text', { html }, context, 'author')).toBe('张三')
    expect(evaluate('$', context.result, context)).toEqual([context.result])
    expect(extract('https://novels.example/{{$.id}}', context.result, context, 'link')).toBe('https://novels.example/book42')
  })
  it('supports regex replacement, first-match replacement and replace cascades', () => {
    expect(extract('a@text##名字##书名', html, context, 'name')).toBe('书名1  书名2')
    expect(extract('$.text##a##b##true', { text: 'aaa' }, context, 'text')).toBe('baa')
    expect(extract('a@text@replace:\\d', html, context, 'name')).toBe('名字  名字')
    expect(extract('$.text##(a)(b)##$2$1', { text: 'ab' }, context, 'text')).toBe('ba')
  })
  it('does not split CSS attribute literals or run JSONPath/script expressions', () => {
    expect(extract('a[data-x="a||b"]@text', '<a data-x="a||b">值</a>', context, 'literal')).toBe('值')
    expect(() => evaluate('@json:$.a[?(@.x)]', '{}', context, 'json')).toThrow('脚本表达式')
    expect(() => evaluate('@js:process.exit()', '', context, 'script')).toThrow('不支持')
    expect(() => evaluate('a@text##[', html, context, 'regex')).toThrow('regex')
    expect(() => evaluate('a@text##(a+)+$', html, context, 'regex')).toThrow('复杂度')
    expect(extract('$.html##张三##李四@css:.author@text', { html }, context, 'chainedReplace')).toBe('李四')
  })
  it('preserves paragraphs and removes executable markup from text previews', () => {
    expect(textParagraphs('<div>第一段<br>第二段</div><p>第三段</p><script>alert(1)</script>')).toEqual(['第一段', '第二段', '第三段'])
  })
})
describe('request descriptions and compatibility', () => {
  it('encodes URL keywords and substitutes JSON bodies without corrupting quotes', () => {
    const rule = compileAnyReader(fixture.rule, 'fixture').anyReader!
    const request = buildRuleRequest(rule, 'searchUrl', { ...context, keyword: '书 名"' })
    expect(request.url).toBe('https://novels.example/api/search?q=%E4%B9%A6%20%E5%90%8D%22')
    expect(JSON.parse(request.body!)).toEqual({ q: '书 名"' })
    expect(request.method).toBe('POST')
    expect(request.headers).toMatchObject({ 'x-test': 'search', 'content-type': 'application/json' })
    expect(JSON.parse(buildRuleRequest(rule, 'chapterUrl', context).body!)).toEqual({ book: { id: 'book42' } })
    const templated = compileAnyReader({ ...ANY_READER_TEMPLATE, userAgent: '{"X-Query":"$keyword"}', searchUrl: '/search?q={{keyword}}' }, 'template').anyReader!
    const templatedRequest = buildRuleRequest(templated, 'searchUrl', { ...context, keyword: 'a&"b' })
    expect(new URL(templatedRequest.url).searchParams.get('q')).toBe('a&"b')
    expect(templatedRequest.headers['x-query']).toBe('a&"b')
  })
  it('supports form POST bodies, protocol-relative URLs and declared additional hosts', () => {
    const raw = { ...ANY_READER_TEMPLATE, allowedHosts: ['cdn.example.com'], userAgent: '{"X-Token":"$keyword"}',
      searchUrl: '{"url":"//api.example.com/search","method":"POST","headers":{"Content-Type":"application/x-www-form-urlencoded"},"body":{"q":"$keyword"}}' }
    const source = compileAnyReader(raw, 'fixture')
    expect([...source.allowedHosts]).toEqual(expect.arrayContaining(['example.com', 'api.example.com', 'cdn.example.com']))
    const request = buildRuleRequest(source.anyReader!, 'searchUrl', context)
    expect(request.body).toBe('q=%E4%B9%A6+%E5%90%8D')
    expect(request.headers['x-token']).toBe('书 名')
    const objectSource = compileAnyReader({ ...ANY_READER_TEMPLATE, searchUrl: { url: 'https://api.example.com/search' } }, 'object')
    expect(objectSource.allowedHosts.has('api.example.com')).toBe(true)
  })
  it.each(['@js:1', '@web:https://example.com', '@filter:mp4'])('reports unsupported %s without evaluation', script => {
    expect(diagnoseAnyReader({ ...ANY_READER_TEMPLATE, searchList: script }).some(item => item.field === 'searchList')).toBe(true)
  })
  it('reports loadJs, content type, multi-road and invalid request headers', () => {
    expect(diagnoseAnyReader({ ...ANY_READER_TEMPLATE, contentType: 0, loadJs: 'throw 1', enableMultiRoads: true }).map(item => item.field)).toEqual(expect.arrayContaining(['contentType', 'loadJs', 'enableMultiRoads']))
    expect(diagnoseAnyReader({ ...ANY_READER_TEMPLATE, userAgent: '{"Host":"127.0.0.1"}' }).length).toBeGreaterThan(0)
    expect(diagnoseAnyReader({ ...ANY_READER_TEMPLATE, allowedHosts: ['*.example.com'] }).map(item => item.field)).toContain('allowedHosts')
  })
})
