import { LARGE_FILE_BYTES, MAX_FILE_BYTES } from './constants.ts'
import { hashText } from './id.ts'
import type { Book, Chapter, OnlineBookOrigin, Paragraph } from './types.ts'

export interface CrawledChapter {
  title: string
  paragraphs: string[]
}

export interface OnlineBookInput {
  name: string
  origin: OnlineBookOrigin
  chapters: CrawledChapter[]
}

export class OnlineBookBuildError extends Error {
  constructor(message: string, public readonly code: 'BOOK_TOO_LARGE' | 'TOC_EMPTY') {
    super(message)
    this.name = 'OnlineBookBuildError'
  }
}

export function buildOnlineBook(input: OnlineBookInput, now = Date.now()): Book {
  if (input.chapters.length === 0) throw new OnlineBookBuildError('书籍目录为空。', 'TOC_EMPTY')

  const contentParts: string[] = []
  const chapters: Chapter[] = []
  const paragraphs: Paragraph[] = []
  let offset = 0

  const append = (text: string): { start: number; end: number } => {
    if (contentParts.length > 0) {
      contentParts.push('\n')
      offset += 1
    }
    const start = offset
    contentParts.push(text)
    offset += text.length
    return { start, end: offset }
  }

  input.chapters.forEach((sourceChapter, chapterIndex) => {
    const title = sourceChapter.title.trim() || `第 ${chapterIndex + 1} 章`
    const chapterStart = offset + (contentParts.length > 0 ? 1 : 0)
    const paragraphStart = paragraphs.length
    const headingPosition = append(title)
    paragraphs.push({
      id: `paragraph-${paragraphs.length}`,
      index: paragraphs.length,
      chapterId: `chapter-${chapterIndex}`,
      text: title,
      ...headingPosition,
      isHeading: true,
    })
    for (const raw of sourceChapter.paragraphs) {
      const text = raw.trim()
      if (text.length === 0) continue
      const position = append(text)
      paragraphs.push({
        id: `paragraph-${paragraphs.length}`,
        index: paragraphs.length,
        chapterId: `chapter-${chapterIndex}`,
        text,
        ...position,
        isHeading: false,
      })
    }
    chapters.push({
      id: `chapter-${chapterIndex}`,
      index: chapterIndex,
      title,
      level: 1,
      start: chapterStart,
      end: offset,
      paragraphStart,
      paragraphEnd: Math.max(paragraphStart, paragraphs.length - 1),
    })
  })

  const content = contentParts.join('')
  const size = new TextEncoder().encode(content).byteLength
  if (size > MAX_FILE_BYTES) {
    throw new OnlineBookBuildError('抓取后的正文超过 50MB，请选择分卷版本。', 'BOOK_TOO_LARGE')
  }

  return {
    id: `book-${hashText(`${input.origin.sourceId}:${input.origin.bookUrl}`)}`,
    name: input.name.trim() || '未命名在线书籍',
    format: 'online',
    encoding: 'utf-8',
    size,
    lastModified: now,
    content,
    chapters,
    paragraphs,
    openedAt: now,
    largeFileMode: size > LARGE_FILE_BYTES,
    origin: { ...input.origin, fetchedAt: now },
  }
}
