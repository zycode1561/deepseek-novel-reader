// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Book, ReadingPosition, RecentBook } from '../src/shared/types.ts'
import type { OnlineReadingSession, OnlineReadingChapter } from '../src/shared/types.ts'

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
const onlineApi = vi.hoisted(() => ({ openOnlineReading: vi.fn(), getOnlineChapter: vi.fn(), closeOnlineReading: vi.fn() }))

vi.mock('../src/client/storage/books.ts', () => bookStorage)
vi.mock('../src/client/storage/local.ts', () => localStorage)
vi.mock('../src/shared/file.ts', () => fileLoader)
vi.mock('../src/client/online/api.ts', async original => ({ ...await original<typeof import('../src/client/online/api.ts')>(), ...onlineApi }))

import { parseBookText } from '../src/shared/parser.ts'
import { ReaderProvider, useReader } from '../src/client/state/ReaderContext.tsx'
import { onlineReadingBookId } from '../src/shared/online-reading.ts'
import { OnlineApiError } from '../src/client/online/api.ts'
import { DEFAULT_SETTINGS } from '../src/shared/constants.ts'
import { SettingsPanel } from '../src/client/components/SettingsPanel.tsx'

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

async function renderProvider(showSettings = false): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<ReaderProvider><Probe />{showSettings && <SettingsPanel />}</ReaderProvider>)
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
    prefetchChapters: 0,
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
  onlineApi.openOnlineReading.mockReset()
  onlineApi.getOnlineChapter.mockReset()
  onlineApi.closeOnlineReading.mockReset().mockResolvedValue({ ok: true })
})

function readingSession(id = 'session-1'): OnlineReadingSession {
  return {
    id, sourceName: '演示源',
    reference: { sourceId: 'demo', bookUrl: 'https://novels.example/books/42', bookName: '四季', keyword: '四季' },
    chapters: [{ title: '春' }, { title: '夏' }, { title: '秋' }],
  }
}

function readingChapter(index: number): OnlineReadingChapter {
  return { index, title: ['春', '夏', '秋'][index]!, paragraphs: [`正文${index}第一段`, `正文${index}第二段`] }
}

describe('online chapter reading and durable metadata', () => {
  it('returns from history to the active online book without reconnecting or losing progress', async () => {
    onlineApi.openOnlineReading.mockResolvedValue(readingSession())
    onlineApi.getOnlineChapter.mockResolvedValue(readingChapter(0))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    act(() => currentReader().markParagraphVisible(2))
    const id = currentReader().book!.id
    onlineApi.openOnlineReading.mockRejectedValue(new Error('源站已找不到这本书'))
    onlineApi.openOnlineReading.mockClear()
    onlineApi.getOnlineChapter.mockClear()
    await act(async () => { expect(await currentReader().openRecent(id)).toBe(true) })
    expect(onlineApi.openOnlineReading).not.toHaveBeenCalled()
    expect(onlineApi.getOnlineChapter).not.toHaveBeenCalled()
    expect(currentReader().progress).toMatchObject({ chapterIndex: 0, paragraphIndex: 2 })
    expect(currentReader().error).toBeNull()
  })
  it('loads only one chapter, works without book storage, changes chapters and returns to a bookmark', async () => {
    const session = readingSession()
    onlineApi.openOnlineReading.mockResolvedValue(session)
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => readingChapter(index))
    bookStorage.saveBook.mockRejectedValue(new Error('quota exceeded'))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    expect(onlineApi.getOnlineChapter).toHaveBeenCalledTimes(1)
    expect(bookStorage.saveBook).not.toHaveBeenCalled()
    expect(currentReader().book?.chapters).toHaveLength(3)
    expect(currentReader().recents[0]?.onlineReading).toEqual(session.reference)
    act(() => { currentReader().markParagraphVisible(2); currentReader().addBookmark() })
    const bookmark = currentReader().bookmarks[0]!
    await act(async () => { currentReader().goToChapter(1) })
    expect(currentReader().progress?.chapterIndex).toBe(1)
    expect(currentReader().book?.content).toContain('正文1')
    expect(currentReader().book?.content).not.toContain('正文0')
    expect(currentReader().recents[0]?.progressPercent).toBeGreaterThanOrEqual(33)
    await act(async () => { currentReader().goToParagraph(bookmark.paragraphIndex, bookmark.chapterIndex) })
    expect(currentReader().progress?.chapterIndex).toBe(0)
    expect(currentReader().progress?.paragraphIndex).toBe(bookmark.paragraphIndex)
  })

  it('reconnects a recent online book and loads its saved chapter and paragraph without IndexedDB', async () => {
    const session = readingSession('new-host-session'), id = onlineReadingBookId(session.reference)
    localStorage.loadRecents.mockReturnValue([{ ...recentFor(fixtureBook('online')), id, onlineReading: session.reference }])
    localStorage.loadProgress.mockReturnValue({ [id]: { ...savedPosition(fixtureBook()), bookId: id, chapterIndex: 2, paragraphIndex: 2 } })
    onlineApi.openOnlineReading.mockResolvedValue(session)
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => readingChapter(index))
    await renderProvider()
    await act(async () => { expect(await currentReader().openRecent(id)).toBe(true) })
    expect(onlineApi.openOnlineReading).toHaveBeenCalledWith({ reference: session.reference }, expect.any(AbortSignal))
    expect(onlineApi.getOnlineChapter).toHaveBeenCalledWith(session.id, 2, expect.any(AbortSignal))
    expect(currentReader().progress).toMatchObject({ chapterIndex: 2, paragraphIndex: 2 })
    expect(currentReader().pendingParagraph).toBe(2)
    expect(bookStorage.getBook).not.toHaveBeenCalled()
  })

  it('ignores a late cancelled chapter response after a faster directory jump', async () => {
    onlineApi.openOnlineReading.mockResolvedValue(readingSession())
    onlineApi.getOnlineChapter.mockResolvedValue(readingChapter(0))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    let resolveSlow!: (chapter: OnlineReadingChapter) => void
    onlineApi.getOnlineChapter.mockImplementationOnce(() => new Promise(resolve => { resolveSlow = resolve }))
    act(() => currentReader().goToChapter(1))
    const slowSignal = onlineApi.getOnlineChapter.mock.calls.at(-1)![2] as AbortSignal
    onlineApi.getOnlineChapter.mockResolvedValueOnce(readingChapter(2))
    await act(async () => { currentReader().goToChapter(2) })
    expect(slowSignal.aborted).toBe(true)
    await act(async () => { resolveSlow(readingChapter(1)) })
    expect(currentReader().progress?.chapterIndex).toBe(2)
    expect(currentReader().book?.content).toContain('正文2')
    expect(currentReader().loading).toBe(false)
  })

  it('keeps the current chapter after failure, retries the target and renews an expired session', async () => {
    onlineApi.openOnlineReading.mockResolvedValue(readingSession())
    onlineApi.getOnlineChapter.mockResolvedValue(readingChapter(0))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    onlineApi.getOnlineChapter.mockRejectedValueOnce(new Error('网络中断'))
    await act(async () => { currentReader().goToChapter(1) })
    expect(currentReader().error).toBe('网络中断')
    expect(currentReader().progress?.chapterIndex).toBe(0)
    onlineApi.getOnlineChapter.mockRejectedValueOnce(new OnlineApiError('过期', 'READING_EXPIRED')).mockResolvedValueOnce(readingChapter(1))
    onlineApi.openOnlineReading.mockResolvedValueOnce(readingSession('renewed'))
    await act(async () => { currentReader().retryOnlineChapter() })
    expect(currentReader().book?.onlineReading?.sessionId).toBe('renewed')
    expect(currentReader().progress?.chapterIndex).toBe(1)
    expect(currentReader().error).toBeNull()
  })
})

describe('chapter prefetch in the reader', () => {
  beforeEach(() => {
    localStorage.loadSettings.mockReturnValue({ ...DEFAULT_SETTINGS })
    onlineApi.openOnlineReading.mockResolvedValue(readingSession())
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => readingChapter(index))
  })

  it('prefetches two chapters by default, keeps progress unchanged, and turns without another request', async () => {
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    await vi.waitFor(() => expect(onlineApi.getOnlineChapter.mock.calls.map(call => call[1])).toEqual([0, 1, 2]))
    expect(currentReader().book?.content).toContain('正文0')
    expect(currentReader().book?.content).not.toContain('正文1')
    expect(currentReader().progress?.chapterIndex).toBe(0)
    expect(currentReader().error).toBeNull()
    expect(currentReader().loading).toBe(false)
    expect(bookStorage.saveBook).not.toHaveBeenCalled()
    const persisted = [localStorage.saveSettings, localStorage.saveProgress, localStorage.saveRecents, localStorage.saveBookmarks]
      .flatMap(mock => mock.mock.calls)
    expect(JSON.stringify(persisted)).not.toContain('正文')
    await act(async () => { currentReader().goToChapter(1) })
    expect(currentReader().book?.content).toContain('正文1')
    expect(currentReader().progress?.chapterIndex).toBe(1)
    expect(onlineApi.getOnlineChapter).toHaveBeenCalledTimes(3)
    await act(async () => { currentReader().goToChapter(2) })
    expect(currentReader().progress?.chapterIndex).toBe(2)
    expect(onlineApi.getOnlineChapter).toHaveBeenCalledTimes(3)
  })

  it('promotes a pending prefetch without aborting it or issuing a duplicate chapter request', async () => {
    let finish!: (value: OnlineReadingChapter) => void
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => index === 1
      ? new Promise(resolve => { finish = resolve }) : readingChapter(index))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    const prefetchSignal = onlineApi.getOnlineChapter.mock.calls[1]![2] as AbortSignal
    act(() => currentReader().goToChapter(1))
    expect(currentReader().loading).toBe(true)
    expect(currentReader().progress?.chapterIndex).toBe(0)
    expect(prefetchSignal.aborted).toBe(false)
    expect(onlineApi.getOnlineChapter.mock.calls.map(call => call[1])).toEqual([0, 1])
    await act(async () => { finish(readingChapter(1)) })
    expect(currentReader().progress?.chapterIndex).toBe(1)
    expect(currentReader().loading).toBe(false)
    expect(onlineApi.getOnlineChapter.mock.calls.map(call => call[1])).toEqual([0, 1, 2])
  })

  it('keeps speculative errors silent and requests a failed chapter again when selected', async () => {
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => {
      if (index === 1) throw new Error('预读网络中断')
      return readingChapter(index)
    })
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    await vi.waitFor(() => expect(onlineApi.getOnlineChapter).toHaveBeenCalledTimes(3))
    expect(currentReader().error).toBeNull()
    expect(currentReader().progress?.chapterIndex).toBe(0)
    onlineApi.getOnlineChapter.mockResolvedValueOnce(readingChapter(1))
    await act(async () => { currentReader().goToChapter(1) })
    expect(currentReader().progress?.chapterIndex).toBe(1)
    expect(currentReader().error).toBeNull()
    expect(onlineApi.getOnlineChapter.mock.calls.filter(call => call[1] === 1)).toHaveLength(2)
  })

  it('renews expired sessions only for a selected chapter and discards the old session cache', async () => {
    onlineApi.getOnlineChapter.mockImplementation(async (id, index) => {
      if (id === 'session-1' && index === 2) throw new OnlineApiError('过期', 'READING_EXPIRED')
      return { ...readingChapter(index), paragraphs: [`${id}正文${index}`] }
    })
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    await vi.waitFor(() => expect(onlineApi.getOnlineChapter).toHaveBeenCalledTimes(3))
    expect(onlineApi.openOnlineReading).toHaveBeenCalledTimes(1)
    expect(currentReader().error).toBeNull()
    onlineApi.openOnlineReading.mockResolvedValueOnce(readingSession('renewed'))
    await act(async () => { currentReader().goToChapter(2) })
    expect(currentReader().book?.onlineReading?.sessionId).toBe('renewed')
    expect(onlineApi.closeOnlineReading).toHaveBeenCalledWith('session-1')
    await act(async () => { currentReader().goToChapter(1) })
    expect(currentReader().book?.content).toContain('renewed正文1')
    expect(onlineApi.getOnlineChapter.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['session-1', 0], ['session-1', 1], ['session-1', 2], ['session-1', 2], ['renewed', 2], ['renewed', 1],
    ])
  })

  it('gives a directory jump priority and does not display a cancelled prefetch response', async () => {
    let finish!: (value: OnlineReadingChapter) => void
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => index === 1
      ? new Promise(resolve => { finish = resolve }) : readingChapter(index))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    const prefetchSignal = onlineApi.getOnlineChapter.mock.calls[1]![2] as AbortSignal
    await act(async () => { currentReader().goToChapter(2) })
    expect(prefetchSignal.aborted).toBe(true)
    await act(async () => { finish(readingChapter(1)) })
    expect(currentReader().progress?.chapterIndex).toBe(2)
    expect(currentReader().book?.content).toContain('正文2')
    expect(currentReader().loading).toBe(false)
    expect(onlineApi.getOnlineChapter.mock.calls.map(call => call[1])).toEqual([0, 1, 2])
  })

  it('disables prefetch from settings, aborts it, and ignores its late result', async () => {
    let finish!: (value: OnlineReadingChapter) => void
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => index === 1
      ? new Promise(resolve => { finish = resolve }) : readingChapter(index))
    await renderProvider(true)
    await act(async () => { await currentReader().startOnlineReading('result') })
    const prefetchSignal = onlineApi.getOnlineChapter.mock.calls[1]![2] as AbortSignal
    const group = [...document.querySelectorAll('.dnr-setting-group')].find(element => element.textContent?.includes('章节智能预读'))!
    const buttons = [...group.querySelectorAll('button')]
    expect(buttons[2]?.getAttribute('aria-pressed')).toBe('true')
    act(() => buttons[0]!.click())
    expect(prefetchSignal.aborted).toBe(true)
    expect(currentReader().settings.prefetchChapters).toBe(0)
    expect(localStorage.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ prefetchChapters: 0 }))
    await act(async () => { finish(readingChapter(1)) })
    onlineApi.getOnlineChapter.mockResolvedValueOnce(readingChapter(1))
    await act(async () => { currentReader().goToChapter(1) })
    expect(onlineApi.getOnlineChapter.mock.calls.map(call => call[1])).toEqual([0, 1, 1])
    expect(currentReader().progress?.chapterIndex).toBe(1)
  })

  it('discards the old book window and aborts pending prefetch on switching books and unmounting', async () => {
    let finish!: (value: OnlineReadingChapter) => void
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => index === 1
      ? new Promise(resolve => { finish = resolve }) : readingChapter(index))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('first') })
    const oldSignal = onlineApi.getOnlineChapter.mock.calls[1]![2] as AbortSignal
    const oldFinish = finish
    const nextSession = readingSession('second')
    nextSession.reference = { ...nextSession.reference, bookName: '另一部小说', bookUrl: 'https://novels.example/books/43' }
    onlineApi.openOnlineReading.mockResolvedValueOnce(nextSession)
    await act(async () => { await currentReader().startOnlineReading('second') })
    expect(oldSignal.aborted).toBe(true)
    expect(onlineApi.closeOnlineReading).toHaveBeenCalledWith('session-1')
    await act(async () => { oldFinish(readingChapter(1)) })
    expect(currentReader().book?.name).toBe('另一部小说')
    expect(currentReader().progress?.chapterIndex).toBe(0)
    expect(onlineApi.getOnlineChapter.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['session-1', 0], ['session-1', 1], ['second', 0], ['second', 1],
    ])
    const nextSignal = onlineApi.getOnlineChapter.mock.calls[3]![2] as AbortSignal
    act(() => root?.unmount())
    root = null
    expect(nextSignal.aborted).toBe(true)
    expect(onlineApi.closeOnlineReading).toHaveBeenCalledWith('second')
    finish(readingChapter(1))
  })

  it('pauses on collapse and a hidden page, then resumes when reading becomes visible', async () => {
    let finish!: (value: OnlineReadingChapter) => void
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => index === 1
      ? new Promise(resolve => { finish = resolve }) : readingChapter(index))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    try {
      await renderProvider()
      await act(async () => { await currentReader().startOnlineReading('result') })
      const firstSignal = onlineApi.getOnlineChapter.mock.calls[1]![2] as AbortSignal
      act(() => currentReader().updatePanel({ expanded: false }))
      expect(firstSignal.aborted).toBe(true)
      await act(async () => { finish(readingChapter(1)) })
      expect(onlineApi.getOnlineChapter).toHaveBeenCalledTimes(2)
      act(() => currentReader().updatePanel({ expanded: true }))
      const secondSignal = onlineApi.getOnlineChapter.mock.calls[2]![2] as AbortSignal
      visibility.mockReturnValue('hidden')
      act(() => document.dispatchEvent(new Event('visibilitychange')))
      expect(secondSignal.aborted).toBe(true)
      await act(async () => { finish(readingChapter(1)) })
      onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => readingChapter(index))
      visibility.mockReturnValue('visible')
      await act(async () => document.dispatchEvent(new Event('visibilitychange')))
      expect(onlineApi.getOnlineChapter.mock.calls.map(call => call[1])).toEqual([0, 1, 1, 1, 2])
      expect(currentReader().progress?.chapterIndex).toBe(0)
    } finally { visibility.mockRestore() }
  })
})

afterEach(() => {
  if (root !== null) act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

describe('recent book progress snapshots', () => {
  it('pauses local reading time while the independent Fanqie library is active', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    try {
      const book = fixtureBook()
      fileLoader.loadBookFromFile.mockResolvedValue({ book, warnings: [] })
      await renderProvider()
      await act(async () => { await currentReader().loadFile(new File(['story'], 'story.txt')) })
      act(() => { currentReader().updatePanel({ expanded: true }); currentReader().setReaderActive(false) })
      const before = structuredClone(currentReader().progress)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(currentReader().progress).toEqual(before)
      act(() => currentReader().setReaderActive(true))
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
      expect(currentReader().progress?.readingSeconds).toBe((before?.readingSeconds ?? 0) + 15)
    } finally { visibility.mockRestore(); vi.useRealTimers() }
  })

  it('applies a phone chapter atomically and refuses a stale expected location', async () => {
    const book = fixtureBook()
    fileLoader.loadBookFromFile.mockResolvedValue({ book, warnings: [] })
    await renderProvider()
    await act(async () => { await currentReader().loadFile(new File(['story'], 'story.txt')) })
    const before = currentReader().progress!
    let applied: ReadingPosition | null = null
    await act(async () => { applied = await currentReader().applySyncedChapter(book.id, 1, before) })
    expect(applied).toMatchObject({ chapterIndex: 1, paragraphIndex: book.chapters[1]!.paragraphStart })
    expect(currentReader().progress?.chapterIndex).toBe(1)
    await act(async () => { expect(await currentReader().applySyncedChapter(book.id, 0, before)).toBeNull() })
    expect(currentReader().progress?.chapterIndex).toBe(1)
  })

  it('does not overwrite a computer move while a synchronized online chapter is loading', async () => {
    localStorage.loadSettings.mockReturnValue({ ...DEFAULT_SETTINGS, prefetchChapters: 0 })
    onlineApi.openOnlineReading.mockResolvedValue(readingSession('sync-session'))
    onlineApi.getOnlineChapter.mockImplementation(async (_id, index) => readingChapter(index))
    await renderProvider()
    await act(async () => { await currentReader().startOnlineReading('result') })
    const before = currentReader().progress!
    const bookId = currentReader().book!.id
    let release!: (value: OnlineReadingChapter) => void
    onlineApi.getOnlineChapter.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    let pending!: Promise<ReadingPosition | null>
    await act(async () => { pending = currentReader().applySyncedChapter(bookId, 1, before) })
    act(() => currentReader().markParagraphVisible(1))
    await act(async () => { release(readingChapter(1)); expect(await pending).toBeNull() })
    expect(currentReader().progress).toMatchObject({ chapterIndex: 0, paragraphIndex: 1 })
    expect(currentReader().book?.onlineReading?.chapterIndex).toBe(0)
  })

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
