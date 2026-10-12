import { afterEach, describe, expect, it, vi } from 'vitest'
const network = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('undici', () => ({ fetch: network.fetch, ProxyAgent: class {} }))
import { FanqieClient, normalizeChapters, normalizeProgress, parseFanqieJson, type FanqieCookie } from '../src/fanqie/client.ts'
import { fanqieSyncDecision, matchFanqieChapter } from '../src/shared/fanqie.ts'
import { officialChapter } from '../src/fanqie/content.ts'

const fontUrl = 'https://lf6-awef.bytetos.com/obj/awesome-font/c/abcdef.woff2'
function chapterHtml(overrides: Record<string, unknown> = {}, font = fontUrl) {
  return `<style>@font-face{src:url(${font})}</style><script>window.__INITIAL_STATE__=${JSON.stringify({ reader: {
    chapterData: { bookId: '12', itemId: '21', title: '春', needPay: false, isChapterLock: false, content: '<p>春风。}</p><p>\\"花开。<script>bad()</script></p>', ...overrides },
  } })};window.bad=bad();</script>`
}

afterEach(() => vi.resetAllMocks())
describe('Fanqie protocol and chapter mapping', () => {
  it('preserves 19-digit IDs and does not rewrite text inside JSON strings', () => {
    const payload = parseFanqieJson('{"code":0,"data":[{"book_id":7123456789012345678,"item_id":"7234567890123456789","text":"ID 7123456789012345678"}]}')
    expect(normalizeProgress(payload)[0]).toMatchObject({ bookId: '7123456789012345678', chapterId: '7234567890123456789' })
    expect((payload as any).data[0].text).toBe('ID 7123456789012345678')
    expect(() => normalizeProgress({ code: 0, data: [{ book_id: 7123456789012345678, item_id: '1' }] })).toThrow('精度')
  })
  it('flattens volume directories and rejects incomplete or changed responses', () => {
    expect(normalizeChapters({ code: 0, data: { chapterListWithVolume: [[{ itemId: '1', title: '第一章 春' }], [{ itemId: '2', title: '第二章 夏' }]] } }))
      .toEqual([{ id: '1', title: '第一章 春' }, { id: '2', title: '第二章 夏' }])
    expect(() => normalizeChapters({ code: 0, data: { allItemIds: ['1'] } })).toThrow('目录格式')
    expect(() => normalizeProgress({ code: 1000, message: 'need login' })).toThrow('登录已过期')
    expect(() => normalizeProgress({ code: 0, data: {} })).toThrow('格式')
  })
  it('never resolves duplicate titles or mismatched chapter numbers by position', () => {
    const remote = { id: '88', title: '第二章：夏' }
    expect(matchFanqieChapter(remote, [{ title: '第二章 夏' }, { title: '第二章 夏' }])).toEqual([0, 1])
    expect(matchFanqieChapter(remote, [{ title: '第三章 夏' }])).toEqual([])
    expect(matchFanqieChapter(remote, [{ title: '第二章 夏' }])).toEqual([0])
    expect(matchFanqieChapter({ id: '88', title: '' }, [{ title: '' }])).toEqual([])
  })
  it('compares positions rather than clocks or furthest-read chapter', () => {
    const binding = { localBookId: 'book-a', remoteBookId: '1', remoteBookName: '春夏', baseline: { remoteChapterId: '10', local: { chapterIndex: 8, paragraphIndex: 5 } } }
    expect(fanqieSyncDecision(binding, '9', { chapterIndex: 8, paragraphIndex: 5 }, 2, false)).toBe('apply')
    expect(fanqieSyncDecision(binding, '9', { chapterIndex: 9, paragraphIndex: 3 }, 2, false)).toBe('conflict')
    expect(fanqieSyncDecision(binding, '10', { chapterIndex: 9, paragraphIndex: 3 }, 2, false)).toBe('unchanged')
    expect(fanqieSyncDecision(binding, '9', { chapterIndex: 2, paragraphIndex: 7 }, 2, false)).toBe('keep')
  })
  it('never follows an off-origin redirect with account cookies', async () => {
    network.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }))
    const client = new FanqieClient(1000)
    await expect(client.request('/api/reader/book/progress', [{ name: 'sessionid', value: 'secret', path: '/', expires: null }], new AbortController().signal))
      .rejects.toMatchObject({ code: 'UNTRUSTED_REDIRECT' })
    expect(network.fetch).toHaveBeenCalledTimes(1)
  })
  it('retains intermediate cookies while honoring paths, expiry and cookie domains', async () => {
    const headers = new Headers({ location: '/complete' })
    headers.append('set-cookie', 'sessionid=secret; Path=/; Secure')
    headers.append('set-cookie', 'passport_csrf_token=csrf; Path=/passport; Secure')
    headers.append('set-cookie', 'bad=wrong; Domain=evil.example; Path=/')
    network.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers }))
      .mockResolvedValueOnce(new Response('{"code":0,"data":[]}', { headers: { 'content-type': 'application/json' } }))
    const cookies: FanqieCookie[] = [{ name: 'old', value: 'expired', path: '/', expires: 1 }]
    await new FanqieClient(1000).request('/passport/web/check_qrconnect/', cookies, new AbortController().signal)
    expect(network.fetch.mock.calls[1]![1].headers.cookie).toBe('sessionid=secret')
    expect(cookies.some(cookie => cookie.name === 'bad')).toBe(false)
  })
  it('parses official chapter JSON without executing scripts, preserving strings and removing active markup', () => {
    const chapter = officialChapter(chapterHtml(), '12', '21')
    expect(chapter.paragraphs).toEqual(['春风。}', '\\"花开。'])
    expect(chapter.fontUrl).toBe(fontUrl)
    expect(() => officialChapter(chapterHtml({ bookId: '13' }), '12', '21')).toThrow('其他章节')
    expect(() => officialChapter(chapterHtml({ needPay: true }), '12', '21')).toThrow('官网')
    expect(() => officialChapter(chapterHtml({ isChapterLock: true }), '12', '21')).toThrow('官网')
    expect(() => officialChapter(chapterHtml({ content: '<p>\uE001</p>' }, 'https://evil.example/a.woff2'), '12', '21')).toThrow('字体')
  })
  it('loads only an allowlisted public font, without account cookies, and rejects non-font data', async () => {
    network.fetch.mockResolvedValueOnce(new Response(chapterHtml({ content: '<p>\uE001</p>' })))
      .mockResolvedValueOnce(new Response('wOF2font-fixture'))
    const client = new FanqieClient(1000), cookies = [{ name: 'sessionid', value: 'secret', path: '/', expires: null }]
    expect(await client.chapter('12', '21', cookies, new AbortController().signal)).toMatchObject({ id: '21', fontData: expect.stringMatching(/^data:font\/woff2;base64,/) })
    expect(network.fetch.mock.calls[0]![1].headers.cookie).toBe('sessionid=secret')
    expect(network.fetch.mock.calls[1]![0]).toBe(fontUrl)
    expect(network.fetch.mock.calls[1]![1]).toMatchObject({ redirect: 'error' })
    expect(network.fetch.mock.calls[1]![1].headers).toBeUndefined()
    network.fetch.mockResolvedValueOnce(new Response(chapterHtml())).mockResolvedValueOnce(new Response('<html>blocked</html>'))
    await expect(client.chapter('12', '21', cookies, new AbortController().signal)).rejects.toMatchObject({ code: 'FONT_UNAVAILABLE' })
  })
})
