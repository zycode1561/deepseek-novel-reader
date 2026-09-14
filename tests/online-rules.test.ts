import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  isPrivateAddress, parseSearchDocument, transformRanwenChapter, transformWxsyChapter, transformWxsyToc,
  validateSourceUrl,
} from '../src/online/engine.ts'
import { loadBuiltinRules } from '../src/online/rules.ts'
import searchFixtures from './fixtures/online-search.json' with { type: 'json' }

describe('bundled SoNovel-compatible rules', () => {
  it('validates and exposes all 11 enabled sources with host allowlists', () => {
    const rules = loadBuiltinRules()
    expect(rules).toHaveLength(11)
    expect(new Set(rules.map(item => item.id)).size).toBe(11)
    for (const source of rules) {
      expect(source.search.result).not.toBe('')
      expect(source.toc.item).not.toBe('')
      expect(source.chapter.content).not.toBe('')
      expect(source.allowedHosts.has(new URL(source.url).hostname)).toBe(true)
    }
  })

  it.each(searchFixtures)('extracts the local $sourceId search fixture', (fixture) => {
    const source = loadBuiltinRules().find(item => item.id === fixture.sourceId)!
    const [result] = parseSearchDocument(source, fixture.html, source.search.url)
    expect(result?.public).toMatchObject({ bookName: fixture.bookName, author: fixture.author })
    expect(result?.bookUrl).toMatch(/^https?:\/\//u)
  })

  it('runs the named wxsy hidden-directory transformation without evaluating rule JavaScript', () => {
    const fixture = `
      <style>.section-list.ycxsid>li:nth-child(1){display:none}.section-list.ycxsid>li:nth-last-child(1){display:none}</style>
      <ul class="section-list ycxsid"><li>广告头</li><li>第一章</li><li>第二章</li><li>广告尾</li></ul>`
    const transformed = transformWxsyToc(fixture)
    expect(transformed).toContain('第一章')
    expect(transformed).toContain('第二章')
    expect(transformed).not.toContain('<li>广告头</li>')
    expect(transformed).not.toContain('<li>广告尾</li>')
  })

  it.each([
    ['燃文章节', transformRanwenChapter, true],
    ['顶点章节', transformWxsyChapter, false],
  ] as const)('decodes the named %s transformation', (_name, transform, keepsRecommendation) => {
    const encoded = Buffer.from('<p>真实正文。</p>', 'utf8').toString('base64')
    const fixture = `<script>document.writeln(qsbs.bb('${encoded}'));</script><p>相邻推荐:广告</p>`
    const transformed = transform(fixture)
    expect(transformed).toContain('真实正文。')
    expect(transformed.includes('相邻推荐')).toBe(keepsRecommendation)
  })
})

describe('SSRF address filtering', () => {
  it.each([
    '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.2', '203.0.113.4',
    '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  ])('blocks %s', address => expect(isPrivateAddress(address)).toBe(true))

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public address %s', address => expect(isPrivateAddress(address)).toBe(false),
  )

  it('rejects a malicious redirect host before DNS lookup', async () => {
    const source = loadBuiltinRules()[0]!
    const resolver = async (): Promise<Array<{ address: string }>> => [{ address: '1.1.1.1' }]
    await expect(validateSourceUrl(source, 'https://attacker.example/private', resolver)).rejects.toThrow('未授权主机')
  })

  it('rejects DNS rebinding of an allowed source host to a private address', async () => {
    const source = loadBuiltinRules()[0]!
    const resolver = async (): Promise<Array<{ address: string }>> => [{ address: '169.254.169.254' }]
    await expect(validateSourceUrl(source, source.url, resolver)).rejects.toThrow('私有网络')
  })

  it('accepts Clash-style synthetic DNS only for an allowlisted source hostname', async () => {
    const source = loadBuiltinRules()[0]!
    const resolver = async (): Promise<Array<{ address: string }>> => [{ address: '198.18.0.15' }]
    await expect(validateSourceUrl(source, source.url, resolver)).resolves.toEqual(new URL(source.url))
    await expect(validateSourceUrl(source, 'https://attacker.example/book', resolver)).rejects.toThrow('未授权主机')
  })
})
