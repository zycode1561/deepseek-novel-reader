import { chapterIndexForParagraph } from './progress.ts'
import type { Book, SearchResult } from './types.ts'

const MAX_RESULTS = 500

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 28)
  const end = Math.min(text.length, index + length + 42)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function searchBook(book: Book, rawQuery: string): SearchResult[] {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (query.length === 0) return []
  const results: SearchResult[] = []
  for (const paragraph of book.paragraphs) {
    const haystack = paragraph.text.toLocaleLowerCase()
    let from = 0
    while (from < haystack.length) {
      const matchStart = haystack.indexOf(query, from)
      if (matchStart < 0) break
      results.push({
        id: `search-${paragraph.index}-${matchStart}`,
        paragraphIndex: paragraph.index,
        chapterIndex: chapterIndexForParagraph(book, paragraph.index),
        excerpt: excerptAround(paragraph.text, matchStart, query.length),
        matchStart,
        matchLength: query.length,
      })
      if (results.length >= MAX_RESULTS) return results
      from = matchStart + Math.max(1, query.length)
    }
  }
  return results
}
