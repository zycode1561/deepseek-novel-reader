import { describe, expect, it } from 'vitest'
import { calculateProgress } from '../src/shared/progress.ts'
import { searchBook } from '../src/shared/search.ts'
import { parseBookText } from '../src/shared/parser.ts'
import type { Book, ReadingPosition } from '../src/shared/types.ts'

function fixtureBook(): Book {
  const parsed = parseBookText('第一章 春天\n风从窗外来。\n春天也跟着来了。\n第二章 夏天\n蝉鸣很长。')
  return {
    id: 'fixture', name: '四季', format: 'txt', encoding: 'utf-8', size: 80,
    lastModified: 0, openedAt: 0, largeFileMode: false, ...parsed,
  }
}

describe('progress and search', () => {
  it('calculates chapter and total progress from a paragraph', () => {
    const book = fixtureBook()
    const position: ReadingPosition = {
      bookId: book.id, chapterIndex: 0, paragraphIndex: 1,
      scrollOffset: 0, updatedAt: 0, readingSeconds: 0,
    }
    const progress = calculateProgress(book, position)
    expect(progress.bookPercent).toBeGreaterThan(0)
    expect(progress.chapterPercent).toBeGreaterThan(0)
    expect(progress.bookPercent).toBeLessThanOrEqual(100)
  })

  it('returns paragraph and chapter coordinates for every match', () => {
    const results = searchBook(fixtureBook(), '春天')
    expect(results).toHaveLength(2)
    expect(results.every(result => result.chapterIndex === 0)).toBe(true)
  })
})
