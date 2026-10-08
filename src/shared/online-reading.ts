import { hashText } from './id.ts'
import { buildOnlineBook } from './online-book.ts'
import type { Book, OnlineReadingChapter, OnlineReadingReference, OnlineReadingSession } from './types.ts'

export function onlineReadingBookId(reference: OnlineReadingReference): string {
  return `book-${hashText(`reading:${reference.sourceId}:${reference.bookUrl}:${reference.bookName}`)}`
}

/** Only the active chapter has paragraphs; every chapter remains in the TOC. */
export function buildReadingBook(session: OnlineReadingSession, chapter: OnlineReadingChapter): Book {
  if (!session.chapters[chapter.index]) throw new Error('未找到该章节。')
  const book = buildOnlineBook({
    name: session.reference.bookName,
    origin: { sourceId: session.reference.sourceId, sourceName: session.sourceName, bookUrl: session.reference.bookUrl, fetchedAt: Date.now() },
    chapters: [chapter],
  })
  const active = book.chapters[0]!
  return {
    ...book,
    id: onlineReadingBookId(session.reference),
    chapters: session.chapters.map((item, index) => ({
      ...active, id: `chapter-${index}`, index, title: index === chapter.index ? chapter.title : item.title,
      ...(index === chapter.index ? {} : { start: -1, end: -1, paragraphStart: -1, paragraphEnd: -1 }),
    })),
    paragraphs: book.paragraphs.map(paragraph => ({ ...paragraph, chapterId: `chapter-${chapter.index}` })),
    onlineReading: { sessionId: session.id, reference: session.reference, chapterIndex: chapter.index },
  }
}
