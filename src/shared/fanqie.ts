import type { ReadingPosition } from './types.ts'

export interface FanqieChapter { id: string; title: string }
export interface FanqieProgress { bookId: string; chapterId: string; fetchedAt: number }
export interface FanqieShelfBook { id: string; name: string; author: string; chapterId: string }
export interface FanqieLocation { chapterIndex: number; paragraphIndex: number }
export interface FanqieBinding {
  localBookId: string
  remoteBookId: string
  remoteBookName: string
  baseline?: { remoteChapterId: string; local: FanqieLocation } | undefined
}
export interface FanqieStatus { loggedIn: boolean; accountId: string | null; bindings: FanqieBinding[]; pollIntervalMs: number }
export interface FanqieLogin { id: string; qrImage: string; expiresAt: number }
export interface FanqiePosition { chapterId: string; paragraphIndex: number; remoteChapterId: string; updatedAt: number }
export interface FanqieOpen {
  accountId: string; bookId: string; name: string; chapters: FanqieChapter[]
  chapterIndex: number; paragraphIndex: number; remoteChapterId: string
}
export interface FanqieText { id: string; title: string; paragraphs: string[]; fontData?: string }
export interface FanqiePull {
  ticket: string
  accountId: string
  binding: FanqieBinding
  progress: FanqieProgress
  chapters: FanqieChapter[]
}

export function locationOf(position: Pick<ReadingPosition, 'chapterIndex' | 'paragraphIndex'>): FanqieLocation {
  return { chapterIndex: position.chapterIndex, paragraphIndex: position.paragraphIndex }
}
export function sameLocation(a: FanqieLocation, b: FanqieLocation): boolean {
  return a.chapterIndex === b.chapterIndex && a.paragraphIndex === b.paragraphIndex
}

function normalizedTitle(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}
function chapterNumber(title: string): string | undefined {
  const value = /^(?:第\s*([\d零〇一二两三四五六七八九十百千万]+)\s*[章回节]|chapter\s*(\d+))/iu.exec(title.normalize('NFKC'))
  return value?.[1] ?? value?.[2]
}
function titleBody(title: string): string {
  return normalizedTitle(title.replace(/^\s*(?:第\s*[\d零〇一二两三四五六七八九十百千万]+\s*[章回节]|chapter\s*\d+)\s*/iu, ''))
}

/** Return every plausible candidate. Ambiguous titles are never silently chosen. */
export function matchFanqieChapter(remote: FanqieChapter, local: { id?: string; title: string }[]): number[] {
  const ids = local.flatMap((chapter, index) => chapter.id === remote.id ? [index] : [])
  if (ids.length) return ids
  const title = normalizedTitle(remote.title)
  const exact = title ? local.flatMap((chapter, index) => normalizedTitle(chapter.title) === title ? [index] : []) : []
  if (exact.length) return exact
  const body = titleBody(remote.title)
  const number = chapterNumber(remote.title)
  // Require both a nonempty chapter name and the same explicit number.
  return body && number ? local.flatMap((chapter, index) =>
    titleBody(chapter.title) === body && chapterNumber(chapter.title) === number ? [index] : []) : []
}

export function fanqieSyncDecision(binding: FanqieBinding, remoteChapterId: string, local: FanqieLocation, target: number,
  atStart: boolean): 'unchanged' | 'keep' | 'apply' | 'conflict' {
  if (binding.baseline?.remoteChapterId === remoteChapterId) return 'unchanged'
  if (local.chapterIndex === target) return 'keep'
  const localChanged = binding.baseline ? !sameLocation(binding.baseline.local, local) : !atStart
  return localChanged ? 'conflict' : 'apply'
}
