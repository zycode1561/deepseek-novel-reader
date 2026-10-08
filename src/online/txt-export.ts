import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import type { Book } from '../shared/types.ts'

export function resolveTxtDirectory(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const directory = value.trim()
  const expanded = directory.startsWith('~/') ? join(homedir(), directory.slice(2)) : directory
  if (!expanded || !isAbsolute(expanded) || expanded.includes('\0')) {
    throw new Error('dsh-novel-reader: txtDirectory must be an absolute directory path')
  }
  return normalize(expanded)
}

/** A stable suffix keeps books with the same title from different sources separate. */
export function txtFilename(book: Pick<Book, 'id' | 'name'>): string {
  if (!/^book-[a-z0-9]+$/u.test(book.id)) throw new Error('invalid book id for TXT export')
  const title = book.name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').replace(/^[.\s]+|[.\s]+$/gu, '')
  // Bound UTF-8 filename bytes, including multibyte characters and the suffix.
  let safeTitle = ''
  for (const character of title) {
    if (Buffer.byteLength(safeTitle + character, 'utf8') > 160) break
    safeTitle += character
  }
  return `${safeTitle || '未命名书籍'}--${book.id}.txt`
}

/** Publish only complete UTF-8 books; an interrupted write leaves no partial TXT. */
export async function saveBookTxt(directory: string, book: Book, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const path = join(directory, txtFilename(book))
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(temporary, book.content, { encoding: 'utf8', flag: 'wx', signal })
    signal.throwIfAborted()
    await rename(temporary, path)
    return path
  } finally {
    await rm(temporary, { force: true })
  }
}
