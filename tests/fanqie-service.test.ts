import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FanqieService } from '../src/fanqie/auth.ts'
import { FanqieCredentialFile, FanqieStore } from '../src/fanqie/store.ts'
import type { FanqieClient, FanqieCookie } from '../src/fanqie/client.ts'
import { FanqieLibrary } from '../src/fanqie/library.ts'

let home: string
let service: FanqieService
let credentials: FanqieCredentialFile
let store: FanqieStore
let library: FanqieLibrary
const client = { startLogin: vi.fn(), checkLogin: vi.fn(), progress: vi.fn(), chapters: vi.fn(), chapter: vi.fn(), shelf: vi.fn(), accountId: vi.fn(), dispose: vi.fn() }
beforeEach(async () => {
  vi.resetAllMocks()
  home = await mkdtemp(join(tmpdir(), 'fanqie-test-'))
  credentials = new FanqieCredentialFile(join(home, 'private', 'auth.json'))
  let state = { accounts: {} }
  store = new FanqieStore({ get: () => state, set: async value => { state = structuredClone(value) } })
  let libraryState = { accounts: {} }
  library = new FanqieLibrary({ get: () => libraryState, set: async value => { libraryState = structuredClone(value) } })
  client.startLogin.mockResolvedValue({ token: 'opaque-login-token', url: 'https://fanqienovel.com/scan?token=test' })
  client.checkLogin.mockImplementation(async (_token, cookies: FanqieCookie[]) => {
    cookies.push({ name: 'sessionid', value: 'secret', path: '/', expires: null }); return 'confirmed'
  })
  client.accountId.mockReturnValue('a'.repeat(64))
  client.progress.mockResolvedValue([{ bookId: '12', chapterId: '21', fetchedAt: 1 }])
  client.chapters.mockResolvedValue([{ id: '21', title: '第一章 春' }])
  client.shelf.mockResolvedValue([])
  client.dispose.mockResolvedValue(undefined)
  service = new FanqieService(client as unknown as FanqieClient, store, credentials, { requestTimeoutMs: 1000, loginTimeoutMs: 300_000, pollIntervalMs: 2000 }, library)
  await service.initialize()
})

describe('independent Fanqie reading', () => {
  it('opens the phone chapter without any local book or binding and restores its own paragraph', async () => {
    await login()
    client.chapters.mockResolvedValue([{ id: '20', title: '序章' }, { id: '21', title: '第一章' }, { id: '22', title: '第二章' }])
    const opened = await service.openBook('12', '春', new AbortController().signal)
    expect(opened).toMatchObject({ chapterIndex: 1, paragraphIndex: 0, remoteChapterId: '21' })
    await service.savePosition(opened.accountId, '12', { chapterId: '22', paragraphIndex: 8, remoteChapterId: '21', updatedAt: 1 })
    expect(await service.openBook('12', '春', new AbortController().signal)).toMatchObject({ chapterIndex: 2, paragraphIndex: 8 })
    expect(await service.openBook('12', '春', new AbortController().signal, true)).toMatchObject({ chapterIndex: 1, paragraphIndex: 0 })
    expect(service.status().bindings).toEqual([])
    expect(store.bindings(opened.accountId)).toEqual([])
  })
  it('follows a changed phone chapter, starts unread books at the first chapter and refuses missing chapter IDs', async () => {
    await login()
    await service.savePosition('a'.repeat(64), '12', { chapterId: '21', paragraphIndex: 8, remoteChapterId: '20', updatedAt: 1 })
    expect(await service.openBook('12', '春', new AbortController().signal)).toMatchObject({ chapterIndex: 0, paragraphIndex: 0, remoteChapterId: '21' })
    client.progress.mockResolvedValue([])
    expect(await service.openBook('13', '夏', new AbortController().signal)).toMatchObject({ chapterIndex: 0, paragraphIndex: 0, remoteChapterId: '' })
    client.progress.mockResolvedValue([{ bookId: '12', chapterId: '99' }])
    await expect(service.openBook('12', '春', new AbortController().signal)).rejects.toMatchObject({ code: 'CHAPTER_NOT_FOUND' })
  })
  it('isolates positions by account and rejects stale chapter reads and writes after an account switch', async () => {
    await login()
    const accountA = 'a'.repeat(64), accountB = 'b'.repeat(64)
    await service.savePosition(accountA, '12', { chapterId: '21', paragraphIndex: 8, remoteChapterId: '21', updatedAt: 1 })
    await service.logout(); client.accountId.mockReturnValue(accountB); await login()
    expect(await service.openBook('12', '春', new AbortController().signal)).toMatchObject({ accountId: accountB, paragraphIndex: 0 })
    await expect(service.readChapter(accountA, '12', '21', new AbortController().signal)).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    await expect(service.savePosition(accountA, '12', { chapterId: '21', paragraphIndex: 99, remoteChapterId: '21', updatedAt: 2 })).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    expect(client.chapter).not.toHaveBeenCalled()
    expect(library.position(accountA, '12')?.paragraphIndex).toBe(8)
    expect(library.position(accountB, '12')).toBeUndefined()
  })
  it('aborts an in-flight chapter on logout and never delivers its old account content', async () => {
    await login()
    let finish!: (value: unknown) => void
    client.chapter.mockReturnValue(new Promise(resolve => { finish = resolve }))
    const pending = service.readChapter('a'.repeat(64), '12', '21', new AbortController().signal)
    const signal = client.chapter.mock.calls[0]![3] as AbortSignal
    await service.logout(); finish({ id: '21', paragraphs: ['old account content'] })
    expect(signal.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
  })
})
afterEach(async () => { service.dispose(); await rm(home, { recursive: true, force: true }) })
async function login() {
  const qr = await service.startLogin(new AbortController().signal)
  expect(qr.qrImage).toMatch(/^data:image\/gif;base64,/)
  expect(JSON.stringify(qr)).not.toContain('opaque-login-token')
  await service.checkLogin(qr.id, new AbortController().signal)
}
describe('Fanqie account persistence and synchronization', () => {
  it('validates login, stores private credentials and keeps them out of frontend status', async () => {
    await login()
    expect(service.status()).toMatchObject({ loggedIn: true, accountId: 'a'.repeat(64), bindings: [] })
    expect(JSON.stringify(service.status())).not.toContain('secret')
    expect((await stat(join(home, 'private', 'auth.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, 'private'))).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(join(home, 'private', 'auth.json'), 'utf8')).cookies[0].value).toBe('secret')
    const restored = new FanqieService(client as unknown as FanqieClient, store, credentials, { requestTimeoutMs: 1000, loginTimeoutMs: 300_000, pollIntervalMs: 2000 })
    await restored.initialize(); expect(restored.status().loggedIn).toBe(true); restored.dispose()
  })
  it('isolates account bindings and does not advance baseline until a position is acknowledged', async () => {
    expect(await service.pull('book-a', new AbortController().signal)).toBeNull()
    await login()
    await service.bind({ localBookId: 'book-a', remoteBookId: '12', remoteBookName: '春' })
    const pull = (await service.pull('book-a', new AbortController().signal))!
    expect(service.status().bindings[0]!.baseline).toBeUndefined()
    await service.acknowledge(pull.ticket, { chapterIndex: 0, paragraphIndex: 3 })
    expect(service.status().bindings[0]!.baseline).toEqual({ remoteChapterId: '21', local: { chapterIndex: 0, paragraphIndex: 3 } })
    await service.logout()
    await expect(credentials.read()).resolves.toBeNull()
    client.accountId.mockReturnValue('b'.repeat(64))
    await login(); expect(service.status().bindings).toEqual([])
    await expect(service.acknowledge(pull.ticket, { chapterIndex: 0, paragraphIndex: 3 })).rejects.toMatchObject({ code: 'STALE_SYNC' })
  })
  it('rejects in-flight results after logout and stale acknowledgements after rebinding', async () => {
    await login(); await service.bind({ localBookId: 'book-a', remoteBookId: '12', remoteBookName: '春' })
    const pull = (await service.pull('book-a', new AbortController().signal))!
    await service.bind({ localBookId: 'book-a', remoteBookId: '13', remoteBookName: '夏' })
    await expect(service.acknowledge(pull.ticket, { chapterIndex: 0, paragraphIndex: 0 })).rejects.toMatchObject({ code: 'STALE_SYNC' })
    let release!: (value: unknown[]) => void
    client.chapters.mockClear()
    client.progress.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const pending = service.pull('book-a', new AbortController().signal)
    const requestSignal = client.progress.mock.calls.at(-1)![1] as AbortSignal
    await service.logout(); release([{ bookId: '13', chapterId: '21', fetchedAt: 1 }])
    await expect(pending).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' })
    expect(requestSignal.aborted).toBe(true)
    expect(client.chapters).not.toHaveBeenCalled()
    expect(service.status().loggedIn).toBe(false)
  })
  it('invalidates old QR attempts and refuses to confirm a session without a working reader endpoint', async () => {
    const old = await service.startLogin(new AbortController().signal)
    const fresh = await service.startLogin(new AbortController().signal)
    await expect(service.checkLogin(old.id, new AbortController().signal)).rejects.toMatchObject({ code: 'LOGIN_CANCELLED' })
    client.progress.mockRejectedValueOnce(new Error('blocked'))
    await expect(service.checkLogin(fresh.id, new AbortController().signal)).rejects.toThrow('blocked')
    expect(service.status().loggedIn).toBe(false)
    expect(await credentials.read()).toBeNull()
  })
})
