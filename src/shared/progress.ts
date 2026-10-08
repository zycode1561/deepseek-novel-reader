import type { Book, Chapter, ReadingPosition } from './types.ts'

export interface ProgressSnapshot {
  chapterPercent: number
  bookPercent: number
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function readingOffset(paragraphs: Book['paragraphs'], paragraphIndex: number): number {
  const next = paragraphs.findIndex(paragraph => paragraph.index >= paragraphIndex)
  return next >= 0 ? next : Math.max(0, paragraphs.length - 1)
}

export function calculateProgress(book: Book, position: ReadingPosition): ProgressSnapshot {
  const chapter = book.chapters[position.chapterIndex] ?? book.chapters[0]
  if (chapter === undefined || book.paragraphs.length === 0) {
    return { chapterPercent: 0, bookPercent: 0 }
  }
  // Heading rows are navigation metadata, not reading content. Excluding them
  // keeps a two-paragraph chapter from starting at an artificial 66%.
  const bookBody = book.paragraphs.filter(paragraph => !paragraph.isHeading)
  const chapterBody = bookBody.filter(paragraph => paragraph.chapterId === chapter.id)
  const chapterOffset = readingOffset(chapterBody, position.paragraphIndex)
  const bookOffset = readingOffset(bookBody, position.paragraphIndex)
  const chapterPercent = clampPercent(((chapterOffset + 1) / Math.max(1, chapterBody.length)) * 100)
  return {
    chapterPercent,
    bookPercent: book.onlineReading
      ? clampPercent((chapter.index + chapterPercent / 100) / book.chapters.length * 100)
      : clampPercent(((bookOffset + 1) / Math.max(1, bookBody.length)) * 100),
  }
}

export function chapterIndexForParagraph(book: Book, paragraphIndex: number): number {
  return book.chapters.find((chapter: Chapter) =>
    paragraphIndex >= chapter.paragraphStart && paragraphIndex <= chapter.paragraphEnd,
  )?.index ?? 0
}
