// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, ReadingPosition, RecentBook } from '../src/shared/types.ts'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const bookStorage = vi.hoisted(() => ({
  deleteBook: vi.fn(),
  getBook: vi.fn(),
  saveBook: vi.fn(),
}))

const localStorage = vi.hoisted(() => ({
  hydrateFromHost: vi.fn(),
  loadBookmarks: vi.fn(),
  loadPanel: vi.fn(),
  loadProgress: vi.fn(),
  loadRecents: vi.fn(),
  loadSettings: vi.fn(),
  saveBookmarks: vi.fn(),
  savePanel: vi.fn(),
  saveProgress: vi.fn(),
  saveRecents: vi.fn(),
  saveSettings: vi.fn(),
  syncToHost: vi.fn(),
}))

const fileLoader = vi.hoisted(() => ({ loadBookFromFile: vi.fn() }))

vi.mock('../src/client/storage/books.ts', () => bookStorage)
vi.mock('../src/client/storage/local.ts', () => localStorage)
vi.mock('../src/shared/file.ts', () => fileLoader)

import { parseBookText } from '../src/shared/parser.ts'
import { ReaderProvider, useReader } from '../src/client/state/ReaderContext.tsx'

let root: Root | null = null
let reader: ReturnType<typeof useReader> | null = null

function fixtureBook(format: Book['format'] = 'txt'): Book {
  return {
    id: `fixture-${format}`,
    name: '四季',
    format,
    encoding: 'utf-8',
    size: 80,
    lastModified: 0,
    openedAt: 0,
    largeFileMode: false,
    ...parseBookText('第一章 春\n风来了。\n花开了。\n第二章 夏\n蝉鸣。\n雨停了。'),
  }
}

function savedPosition(book: Book): ReadingPosition {
  return {
    bookId: book.id,
    chapterIndex: 0,
    paragraphIndex: 1,
    scrollOffset: 0,
    updatedAt: 1,
    readingSeconds: 0,
  }
}

function recentFor(book: Book): RecentBook {
  return {
    id: book.id,
    name: book.name,
    size: book.size,
    encoding: book.encoding,
    openedAt: 1,
    format: book.format,
  }
}

function Probe(): null {
  reader = useReader()
  return null
}

async function renderProvider(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<ReaderProvider><Probe /></ReaderProvider>)
    await Promise.resolve()
  })
}

function currentReader(): ReturnType<typeof useReader> {
  if (reader === null) throw new Error('reader context is not mounted')
  return reader
}

beforeEach(() => {
  vi.clearAllMocks()
  reader = null
  localStorage.hydrateFromHost.mockResolvedValue(false)
  localStorage.loadBookmarks.mockReturnValue([])
  localStorage.loadPanel.mockReturnValue({
    expanded: false,
    width: 420,
    immersive: false,
    toolsVisible: true,
    launcherYRatio: 0.43,
  })
  localStorage.loadProgress.mockReturnValue({})
  localStorage.loadRecents.mockReturnValue([])
  localStorage.loadSettings.mockReturnValue({
    fontSize: 18,
    fontFamily: 'system',
    lineSpacing: 'comfortable',
    theme: 'light',
    tocPosition: 'top',
    firstLineIndent: true,
    pageMode: 'scroll',
    footerDisplay: 'chapter-progress',
    toggleShortcut: {
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      key: 'r',
      code: 'KeyR',
    },
  })
  bookStorage.deleteBook.mockResolvedValue(undefined)
  bookStorage.saveBook.mockResolvedValue(undefined)
  localStorage.syncToHost.mockResolvedValue(undefined)
})

afterEach(() => {
  if (root !== null) act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

describe('recent book progress snapshots', () => {
  it('backfills a legacy recent after opening and only rewrites it for a new integer percentage', async () => {
    const book = fixtureBook()
    const position = savedPosition(book)
    localStorage.loadProgress.mockReturnValue({ [book.id]: position })
    localStorage.loadRecents.mockReturnValue([recentFor(book)])
    bookStorage.getBook.mockResolvedValue(book)
    await renderProvider()

    expect(currentReader().recents[0]?.progressPercent).toBeUndefined()
    await act(async () => { await currentReader().openRecent(book.id) })
    const openedPercent = currentReader().recents[0]?.progressPercent
    expect(openedPercent).toBeGreaterThan(0)

    const savesAfterOpen = localStorage.saveRecents.mock.calls.length
    act(() => currentReader().markParagraphVisible(position.paragraphIndex, 20))
    expect(localStorage.saveRecents).toHaveBeenCalledTimes(savesAfterOpen)

    act(() => currentReader().goToParagraph(5))
    expect(currentReader().recents[0]?.progressPercent).toBeGreaterThan(openedPercent ?? 0)
    expect(localStorage.saveRecents.mock.calls.length).toBeGreaterThan(savesAfterOpen)
  })

  it.each(['txt', 'online'] as const)('creates a progress snapshot for a new %s book', async (format) => {
    const book = fixtureBook(format)
    fileLoader.loadBookFromFile.mockResolvedValue({ book, warnings: [] })
    await renderProvider()

    await act(async () => {
      if (format === 'online') await currentReader().loadOnlineBook(book)
      else await currentReader().loadFile(new File(['story'], 'story.txt', { type: 'text/plain' }))
    })

    expect(currentReader().recents[0]?.format).toBe(format)
    expect(currentReader().recents[0]?.progressPercent).toBeGreaterThanOrEqual(0)
  })
})
