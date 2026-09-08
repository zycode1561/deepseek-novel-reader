import type { Chapter, Paragraph, ParsedBook } from './types.ts'

interface SourceLine {
  text: string
  start: number
  end: number
}

interface HeadingMatch {
  title: string
  level: number
}

const CHINESE_CHAPTER = /^\s*第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[章回节卷部篇]\s*[:：.、-]?\s*(.*)\s*$/u
const ENGLISH_CHAPTER = /^\s*chapter\s+([0-9ivxlcdm]+)\s*[:：.、-]?\s*(.*)\s*$/iu
const NUMBERED_HEADING = /^\s*(\d{1,4})\s*[.、]\s*(\S.{0,48})\s*$/u
const PADDED_HEADING = /^\s*(\d{3,4})\s+(\S.{0,48})\s*$/u
const MARKDOWN_HEADING = /^\s*(#{1,3})\s+(.+?)\s*#*\s*$/u

function normalizeText(input: string): string {
  return input.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
}

function toLines(content: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (const text of content.split('\n')) {
    const end = start + text.length
    lines.push({ text, start, end })
    start = end + 1
  }
  return lines
}

export function matchChapterHeading(rawLine: string): HeadingMatch | null {
  const line = rawLine.trim()
  if (line.length === 0 || line.length > 80) return null

  const markdown = MARKDOWN_HEADING.exec(line)
  if (markdown !== null) {
    return { title: markdown[2]!.trim(), level: markdown[1]!.length }
  }

  const chinese = CHINESE_CHAPTER.exec(line)
  if (chinese !== null) return { title: line, level: 1 }

  const english = ENGLISH_CHAPTER.exec(line)
  if (english !== null) return { title: line, level: 1 }

  const numbered = NUMBERED_HEADING.exec(line) ?? PADDED_HEADING.exec(line)
  if (numbered !== null) return { title: line, level: 1 }

  return null
}

function chapterForOffset(chapters: readonly Chapter[], offset: number): Chapter {
  let low = 0
  let high = chapters.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const chapter = chapters[middle]!
    if (offset < chapter.start) high = middle - 1
    else if (offset >= chapter.end) low = middle + 1
    else return chapter
  }
  return chapters[Math.max(0, Math.min(chapters.length - 1, high))]!
}

/** Parse headings and paragraph boundaries while retaining source offsets for exact progress/search. */
export function parseBookText(input: string): ParsedBook {
  const content = normalizeText(input)
  const lines = toLines(content)
  const headings = lines.flatMap((line) => {
    const match = matchChapterHeading(line.text)
    return match === null ? [] : [{ ...line, ...match }]
  })

  const chapters: Chapter[] = []
  const firstHeading = headings[0]
  const hasPreface = firstHeading !== undefined && content.slice(0, firstHeading.start).trim().length > 0

  if (headings.length === 0) {
    chapters.push({
      id: 'chapter-0', index: 0, title: '正文', level: 1,
      start: 0, end: content.length, paragraphStart: 0, paragraphEnd: 0,
    })
  } else {
    if (hasPreface) {
      chapters.push({
        id: 'chapter-0', index: 0, title: '序章', level: 1,
        start: 0, end: firstHeading!.start, paragraphStart: 0, paragraphEnd: 0,
      })
    }
    headings.forEach((heading, headingIndex) => {
      const index = chapters.length
      chapters.push({
        id: `chapter-${index}`,
        index,
        title: heading.title,
        level: heading.level,
        start: heading.start,
        end: headings[headingIndex + 1]?.start ?? content.length,
        paragraphStart: 0,
        paragraphEnd: 0,
      })
    })
  }

  const headingOffsets = new Set(headings.map((heading) => heading.start))
  const paragraphs: Paragraph[] = []
  for (const line of lines) {
    const text = line.text.trim()
    if (text.length === 0) continue
    const chapter = chapterForOffset(chapters, line.start)
    const index = paragraphs.length
    paragraphs.push({
      id: `paragraph-${index}`,
      index,
      chapterId: chapter.id,
      text,
      start: line.start,
      end: line.end,
      isHeading: headingOffsets.has(line.start),
    })
  }

  for (const chapter of chapters) {
    const contained = paragraphs.filter(paragraph => paragraph.chapterId === chapter.id)
    const first = contained[0]?.index ?? (chapters[chapter.index - 1]?.paragraphEnd ?? 0)
    const last = contained.at(-1)?.index ?? first
    chapter.paragraphStart = first
    chapter.paragraphEnd = last
  }

  return { content, chapters, paragraphs }
}
