import { load } from 'cheerio'
import { FanqieError, fanqieId, parseFanqieJson } from './client.ts'

/** Parse the official server-rendered state as JSON, never execute page scripts. */
export function readerState(html: string): Record<string, unknown> {
  const marker = 'window.__INITIAL_STATE__='
  const offset = html.indexOf(marker)
  if (offset < 0) throw new FanqieError('CONTENT_UNAVAILABLE', '番茄未返回可阅读正文，请在官网查看。')
  const start = offset + marker.length
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < html.length; index++) {
    const char = html[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      return parseFanqieJson(html.slice(start, index + 1)) as Record<string, unknown>
    }
  }
  throw new FanqieError('PROTOCOL_CHANGED', '番茄正文页面格式变化，请在官网查看。')
}

export function officialChapter(html: string, bookId: string, chapterId: string) {
  const state = readerState(html)
  const chapter = (state.reader as { chapterData?: Record<string, unknown> } | undefined)?.chapterData
  if (!chapter || fanqieId(chapter.bookId) !== bookId || fanqieId(chapter.itemId) !== chapterId)
    throw new FanqieError('CHAPTER_MISMATCH', '番茄返回了其他章节，已停止加载。')
  if (chapter.needPay || chapter.isChapterLock)
    throw new FanqieError('CONTENT_RESTRICTED', '这一章暂不能在阅读器内读取，请前往番茄官网阅读。')
  if (typeof chapter.content !== 'string' || !chapter.content.trim())
    throw new FanqieError('CONTENT_UNAVAILABLE', '番茄未返回可阅读正文，请在官网查看。')
  const $ = load(chapter.content)
  $('script,style,iframe,object,svg').remove()
  $('br').replaceWith('\n')
  const paragraphs = $('p').toArray().map(node => $(node).text().trim()).filter(Boolean)
  if (!paragraphs.length) paragraphs.push(...$.root().text().split(/\n+/).map(text => text.trim()).filter(Boolean))
  if (!paragraphs.length) throw new FanqieError('CONTENT_UNAVAILABLE', '这一章没有可显示的文字。')
  const fontUrl = /https:\/\/lf[36]-awef\.bytetos\.com\/obj\/awesome-font\/c\/[a-f0-9]+\.woff2/iu.exec(html)?.[0]
  if (/[\uE000-\uF8FF]/u.test(paragraphs.join('')) && !fontUrl)
    throw new FanqieError('FONT_UNAVAILABLE', '番茄正文缺少显示字体，请在官网查看。')
  return { id: chapterId, title: String(chapter.title ?? ''), paragraphs, ...(fontUrl ? { fontUrl } : {}) }
}
