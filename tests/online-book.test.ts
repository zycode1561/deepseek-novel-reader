import { describe, expect, it } from 'vitest'
import { buildOnlineBook } from '../src/shared/online-book.ts'

const origin = {
  sourceId: 'sonovel-1',
  sourceName: '测试源',
  bookUrl: 'https://books.example/book/42',
  fetchedAt: 1,
}

describe('online book construction', () => {
  it('builds exact chapter, paragraph, and content offsets', () => {
    const book = buildOnlineBook({
      name: ' 测试书 ',
      origin,
      chapters: [
        { title: '第一章', paragraphs: [' 第一段。 ', '第二段。'] },
        { title: '第二章', paragraphs: ['结尾。'] },
      ],
    }, 123)

    expect(book.format).toBe('online')
    expect(book.name).toBe('测试书')
    expect(book.content).toBe('第一章\n第一段。\n第二段。\n第二章\n结尾。')
    expect(book.paragraphs.map(item => book.content.slice(item.start, item.end))).toEqual(
      book.paragraphs.map(item => item.text),
    )
    expect(book.chapters[0]).toMatchObject({ paragraphStart: 0, paragraphEnd: 2, start: 0 })
    expect(book.chapters[1]).toMatchObject({ paragraphStart: 3, paragraphEnd: 4 })
    expect(book.origin).toMatchObject({ ...origin, fetchedAt: 123 })
  })

  it('uses a stable source-and-URL book id across refreshes', () => {
    const first = buildOnlineBook({ name: '旧正文', origin, chapters: [{ title: '一', paragraphs: ['旧'] }] }, 1)
    const refreshed = buildOnlineBook({ name: '新正文', origin, chapters: [{ title: '一', paragraphs: ['新'] }] }, 2)
    const anotherSource = buildOnlineBook({
      name: '新正文',
      origin: { ...origin, sourceId: 'sonovel-2' },
      chapters: [{ title: '一', paragraphs: ['新'] }],
    }, 2)
    expect(refreshed.id).toBe(first.id)
    expect(anotherSource.id).not.toBe(first.id)
  })
})
