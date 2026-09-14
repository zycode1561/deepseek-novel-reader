export type BookFormat = 'txt' | 'markdown' | 'epub' | 'online'
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
  origin?: OnlineBookOrigin
}

export interface OnlineBookOrigin {
  sourceId: string
  sourceName: string
  bookUrl: string
  fetchedAt: number
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
  /** Vertical center of the collapsed launcher within the visible overlay (0–1). */
  launcherYRatio: number
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

export interface OnlineSourceInfo {
  id: string
  name: string
  url: string
  comment: string
}

export interface OnlineBookResult {
  id: string
  sourceId: string
  sourceName: string
  sourceUrl: string
  bookName: string
  author: string
  intro: string
  category: string
  latestChapter: string
  lastUpdateTime: string
  status: string
  wordCount: string
}

export interface OnlineSearchResponse {
  results: OnlineBookResult[]
  failedSources: number
  searchedSources: number
}

export type OnlineAcquisitionState = 'queued' | 'resolving' | 'downloading' | 'completed' | 'failed' | 'cancelled'

export interface OnlineAcquisitionStatus {
  id: string
  state: OnlineAcquisitionState
  bookName: string
  completedChapters: number
  totalChapters: number
  retries: number
  errorCode?: OnlineErrorCode
  error?: string
}

export type OnlineErrorCode =
  | 'INVALID_QUERY'
  | 'RESULT_EXPIRED'
  | 'SOURCE_UNAVAILABLE'
  | 'TOC_EMPTY'
  | 'BOOK_TOO_LARGE'
  | 'TOO_MANY_CHAPTERS'
  | 'REQUEST_FAILED'
  | 'JOB_NOT_FOUND'
  | 'JOB_NOT_READY'
  | 'CANCELLED'

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
