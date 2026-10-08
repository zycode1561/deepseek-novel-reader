import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTxtDirectory, saveBookTxt, txtFilename } from '../src/online/txt-export.ts'
import { buildOnlineBook } from '../src/shared/online-book.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'novel-txt-'))
  roots.push(root)
  return root
}
function book(bookUrl = 'https://example.com/book/1') {
  return buildOnlineBook({ name: '../测试/书名', origin: { sourceId: 'demo', sourceName: '演示源', bookUrl, fetchedAt: 1 },
    chapters: [{ title: '第一章 春', paragraphs: ['中文正文。', '第二段。'] }, { title: '第二章 夏', paragraphs: ['尾章正文。'] }] })
}

describe('full-book TXT export', () => {
  it('uses configurable absolute directories and rejects invalid configuration', () => {
    expect(resolveTxtDirectory(undefined, '/default/txt')).toBe('/default/txt')
    expect(resolveTxtDirectory('/Users/apple/Documents/novel', '/default')).toBe('/Users/apple/Documents/novel')
    expect(resolveTxtDirectory('~/novel', '/default')).toBe(join(homedir(), 'novel'))
    for (const value of ['', '   ', 'relative/path', '/bad\0path']) expect(() => resolveTxtDirectory(value, '/default')).toThrow('txtDirectory')
  })

  it('creates the directory, preserves chapter order and UTF-8 text, and replaces the same book atomically', async () => {
    const directory = join(await temporaryDirectory(), 'novel')
    const original = book()
    const signal = new AbortController().signal
    const path = await saveBookTxt(directory, original, signal)
    expect(path).toBe(join(directory, txtFilename(original)))
    expect(await readFile(path, 'utf8')).toBe('第一章 春\n中文正文。\n第二段。\n第二章 夏\n尾章正文。')
    expect(await saveBookTxt(directory, { ...original, content: original.content + '\n更新正文' }, signal)).toBe(path)
    expect(await readFile(path, 'utf8')).toContain('更新正文')
    const other = await saveBookTxt(directory, book('https://example.com/book/2'), signal)
    expect(other).not.toBe(path)
    expect(await readdir(directory)).toHaveLength(2)
  })

  it('bounds names, blocks traversal, and rejects malformed book IDs', () => {
    expect(txtFilename(book())).not.toMatch(/[\/\\]/u)
    expect(Buffer.byteLength(txtFilename({ id: 'book-123', name: '书'.repeat(500) }))).toBeLessThan(255)
    expect(() => txtFilename({ id: '../escape', name: '书' })).toThrow('invalid book id')
  })

  it('reports a non-directory target and leaves no files after cancellation', async () => {
    const root = await temporaryDirectory()
    const occupied = join(root, 'file')
    await writeFile(occupied, 'original')
    await expect(saveBookTxt(occupied, book(), new AbortController().signal)).rejects.toThrow()
    expect(await readFile(occupied, 'utf8')).toBe('original')
    await expect(saveBookTxt(join(root, 'cancelled'), book(), AbortSignal.abort())).rejects.toThrow()
    expect(await readdir(root)).toEqual(['file'])
  })
})
