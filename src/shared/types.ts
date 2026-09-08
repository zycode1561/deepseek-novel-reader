export type BookFormat = 'txt' | 'markdown'
export type FileEncoding = 'utf-8' | 'utf-8-bom' | 'gb18030'
export type ReaderTheme = 'light' | 'dark' | 'eye-care' | 'parchment'
export type LineSpacing = 'compact' | 'comfortable' | 'relaxed'
export type TocPosition = 'top' | 'left'
export type FontFamily = 'system' | 'songti' | 'heiti' | 'kaiti' | 'serif'
export type PageMode = 'scroll' | 'paged'
export type FooterDisplay = 'chapter-progress' | 'chapter-title'

/** Serializable keyboard shortcut stored with the reader preferences. */
export interface ReaderShortcut {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  key: string
  code: string
}

export interface Paragraph {
  id: string
  index: number
  chapterId: string
  text: string
  start: number
  end: number
  isHeading: boolean
}

export interface Chapter {
  id: string
  index: number
  title: string
  level: number
  start: number
  end: number
  paragraphStart: number
  paragraphEnd: number
}

export interface Book {
  id: string
  name: string
  format: BookFormat
  encoding: FileEncoding
  size: number
  lastModified: number
  content: string
  chapters: Chapter[]
  paragraphs: Paragraph[]
  openedAt: number
  largeFileMode: boolean
}

export interface ReadingPosition {
  bookId: string
  chapterIndex: number
  paragraphIndex: number
  scrollOffset: number
  updatedAt: number
  readingSeconds: number
}

export interface Bookmark {
  id: string
  bookId: string
  chapterIndex: number
  paragraphIndex: number
  excerpt: string
  createdAt: number
}

export interface ReaderSettings {
  fontSize: number
  fontFamily: FontFamily
  lineSpacing: LineSpacing
  theme: ReaderTheme
  tocPosition: TocPosition
  firstLineIndent: boolean
  pageMode: PageMode
  footerDisplay: FooterDisplay
  toggleShortcut: ReaderShortcut
}

export interface PanelPreferences {
  expanded: boolean
  width: number
  immersive: boolean
  toolsVisible: boolean
}

export interface RecentBook {
  id: string
  name: string
  size: number
  encoding: FileEncoding
  openedAt: number
  format: BookFormat
}

/** The complete reader state persisted by the host half (port-independent). */
export interface ReaderState {
  settings: Partial<ReaderSettings>
  panel: Partial<PanelPreferences>
  progress: Record<string, ReadingPosition>
  bookmarks: Bookmark[]
  recents: RecentBook[]
}

export interface SearchResult {
  id: string
  paragraphIndex: number
  chapterIndex: number
  excerpt: string
  matchStart: number
  matchLength: number
}

export interface DecodedFile {
  text: string
  encoding: FileEncoding
  warnings: string[]
}

export interface ParsedBook {
  content: string
  chapters: Chapter[]
  paragraphs: Paragraph[]
}
