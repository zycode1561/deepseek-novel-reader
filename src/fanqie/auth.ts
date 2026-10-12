import { randomUUID } from 'node:crypto'
import qrcode from 'qrcode-generator'
import type { FanqieBinding, FanqieLocation, FanqieLogin, FanqieOpen, FanqiePosition, FanqiePull, FanqieStatus } from '../shared/fanqie.ts'
import type { FanqieLibrary } from './library.ts'
import { FanqieClient, FanqieError, type FanqieCookie } from './client.ts'
import { FanqieCredentialFile, FanqieStore, type FanqieCredentials } from './store.ts'

export interface FanqieConfig { requestTimeoutMs: number; loginTimeoutMs: number; pollIntervalMs: number }
interface LoginAttempt { id: string; token: string; cookies: FanqieCookie[]; expiresAt: number; controller: AbortController; lastPoll: number; busy: boolean }
interface Ticket { expiresAt: number; generation: number; pull: FanqiePull }

export class FanqieService {
  private auth: FanqieCredentials | null = null
  private login: LoginAttempt | null = null
  private readonly controller = new AbortController()
  private accountController = new AbortController()
  private generation = 0
  private readonly tickets = new Map<string, Ticket>()
  constructor(private readonly client: FanqieClient, private readonly store: FanqieStore,
    private readonly credentials: FanqieCredentialFile, private readonly config: FanqieConfig, private readonly library?: FanqieLibrary) {}
  async initialize(): Promise<void> { this.auth = await this.credentials.read() }
  dispose(): void { this.controller.abort(); this.cancelLogin(); this.tickets.clear(); void this.client.dispose() }
  status(): FanqieStatus {
    const valid = this.auth?.cookies.some(cookie => cookie.name === 'sessionid' && (cookie.expires === null || cookie.expires > Date.now()))
    return { loggedIn: !!valid, accountId: valid ? this.auth!.accountId : null,
      bindings: valid ? this.store.bindings(this.auth!.accountId) : [], pollIntervalMs: this.config.pollIntervalMs }
  }
  cancelLogin(id?: string): void {
    if (id && this.login?.id !== id) return
    this.login?.controller.abort(); this.login = null
  }
  async startLogin(signal: AbortSignal): Promise<FanqieLogin> {
    this.cancelLogin()
    const attempt: LoginAttempt = { id: randomUUID(), token: '', cookies: [], expiresAt: Date.now() + this.config.loginTimeoutMs,
      controller: new AbortController(), lastPoll: 0, busy: false }
    this.login = attempt
    try {
      const response = await this.client.startLogin(attempt.cookies, AbortSignal.any([signal, attempt.controller.signal, this.controller.signal]))
      if (this.login !== attempt) throw new FanqieError('LOGIN_CANCELLED', '扫码登录已取消。')
      attempt.token = response.token
      const qr = qrcode(0, 'M'); qr.addData(response.url); qr.make()
      return { id: attempt.id, qrImage: qr.createDataURL(5, 20), expiresAt: attempt.expiresAt }
    } catch (error) { if (this.login === attempt) this.cancelLogin(); throw error }
  }
  async checkLogin(id: string, signal: AbortSignal): Promise<{ state: string; status: FanqieStatus }> {
    const attempt = this.login
    if (!attempt || id !== attempt.id) throw new FanqieError('LOGIN_CANCELLED', '二维码已取消，请重新扫码。')
    if (attempt.expiresAt <= Date.now()) { this.cancelLogin(); return { state: 'expired', status: this.status() } }
    if (attempt.busy || Date.now() - attempt.lastPoll < this.config.pollIntervalMs) return { state: 'waiting', status: this.status() }
    attempt.lastPoll = Date.now(); attempt.busy = true
    try {
      const combined = AbortSignal.any([signal, attempt.controller.signal, this.controller.signal])
      const state = await this.client.checkLogin(attempt.token, attempt.cookies, combined)
      combined.throwIfAborted()
      if (this.login !== attempt) throw new FanqieError('LOGIN_CANCELLED', '扫码登录已取消。')
      if (state === 'expired') { this.cancelLogin(); return { state, status: this.status() } }
      if (state === 'confirmed' && attempt.cookies.some(cookie => cookie.name === 'sessionid')) {
        // Validate the session against the reader endpoint before marking login complete.
        await this.client.progress(attempt.cookies, combined)
        combined.throwIfAborted()
        const auth = { accountId: this.client.accountId(attempt.cookies), cookies: attempt.cookies }
        const previous = this.auth
        const generation = ++this.generation; this.tickets.clear()
        this.accountController.abort(); this.accountController = new AbortController()
        await this.credentials.write(auth)
        if (combined.aborted || this.login !== attempt) {
          if (generation === this.generation) await this.credentials.write(previous)
          throw new FanqieError('LOGIN_CANCELLED', '扫码登录已取消。')
        }
        combined.throwIfAborted()
        this.auth = auth; this.cancelLogin()
        return { state: 'confirmed', status: this.status() }
      }
      return { state: state === 'confirmed' || state === 'success' ? 'confirming' : state, status: this.status() }
    } finally { attempt.busy = false }
  }
  async logout(): Promise<void> {
    this.generation++; this.cancelLogin(); this.tickets.clear(); this.auth = null
    this.accountController.abort(); this.accountController = new AbortController()
    await this.credentials.write(null)
  }
  private session(): FanqieCredentials {
    if (!this.auth || !this.status().loggedIn) throw new FanqieError('AUTH_EXPIRED', '请先扫码登录番茄账号。')
    return this.auth
  }
  private async authenticated<T>(signal: AbortSignal, action: (auth: FanqieCredentials, combined: AbortSignal) => Promise<T>): Promise<T> {
    const auth = this.session(); const generation = this.generation
    const combined = AbortSignal.any([signal, this.controller.signal, this.accountController.signal])
    try {
      const result = await action(auth, combined)
      combined.throwIfAborted()
      if (generation !== this.generation || auth !== this.auth) throw new FanqieError('ACCOUNT_CHANGED', '番茄账号已切换，请重新同步。')
      return result
    } catch (error) {
      if (generation !== this.generation || auth !== this.auth) throw new FanqieError('ACCOUNT_CHANGED', '番茄账号已切换，请重新同步。')
      if (error instanceof FanqieError && error.code === 'AUTH_EXPIRED' && generation === this.generation) await this.logout()
      throw error
    }
  }
  async shelf(signal: AbortSignal) { return await this.authenticated(signal, (auth, combined) => this.client.shelf(auth.cookies, combined)) }
  async openBook(bookId: string, name: string, signal: AbortSignal, fromPhone = false): Promise<FanqieOpen> {
    return await this.authenticated(signal, async (auth, combined) => {
      const chapters = await this.client.chapters(bookId, auth.cookies, combined)
      combined.throwIfAborted()
      const remote = (await this.client.progress(auth.cookies, combined)).find(item => item.bookId === bookId)
      const saved = this.library?.position(auth.accountId, bookId)
      const remoteChapterId = remote?.chapterId ?? ''
      const restore = !fromPhone && saved && saved.remoteChapterId === remoteChapterId
      const targetId = restore ? saved.chapterId : remoteChapterId || saved?.chapterId
      const chapterIndex = targetId ? chapters.findIndex(chapter => chapter.id === targetId) : 0
      if (targetId && chapterIndex < 0) throw new FanqieError('CHAPTER_NOT_FOUND', '阅读位置对应的章节不在番茄目录中，请刷新后重试。')
      return { accountId: auth.accountId, bookId, name, chapters, chapterIndex, paragraphIndex: restore ? saved.paragraphIndex : 0, remoteChapterId }
    })
  }
  async readChapter(accountId: string, bookId: string, chapterId: string, signal: AbortSignal) {
    return await this.authenticated(signal, async (auth, combined) => {
      if (accountId !== auth.accountId) throw new FanqieError('ACCOUNT_CHANGED', '番茄账号已切换，请重新打开书籍。')
      return await this.client.chapter(bookId, chapterId, auth.cookies, combined)
    })
  }
  async savePosition(accountId: string, bookId: string, position: FanqiePosition): Promise<void> {
    const auth = this.session()
    if (accountId !== auth.accountId) throw new FanqieError('ACCOUNT_CHANGED', '番茄账号已切换，未保存旧账号的阅读位置。')
    if (!this.library) throw new FanqieError('LIBRARY_UNAVAILABLE', '番茄阅读记录服务未启用。')
    await this.library.save(auth.accountId, bookId, position)
  }
  async bind(binding: FanqieBinding): Promise<void> {
    const auth = this.session()
    await this.store.bind(auth.accountId, binding)
    this.tickets.clear()
  }
  async unbind(localBookId: string): Promise<void> { await this.store.unbind(this.session().accountId, localBookId); this.tickets.clear() }
  async pull(localBookId: string, signal: AbortSignal): Promise<FanqiePull | null> {
    if (!this.status().loggedIn) return null
    return await this.authenticated(signal, async (auth, combined) => {
      const binding = this.store.binding(auth.accountId, localBookId)
      if (!binding) return null
      const progress = (await this.client.progress(auth.cookies, combined)).find(item => item.bookId === binding.remoteBookId)
      combined.throwIfAborted()
      if (!progress) throw new FanqieError('NO_REMOTE_PROGRESS', '番茄没有这本书的云端阅读位置，请先在手机阅读并联网同步。')
      const chapters = await this.client.chapters(binding.remoteBookId, auth.cookies, combined)
      if (!chapters.some(chapter => chapter.id === progress.chapterId)) throw new FanqieError('CHAPTER_NOT_FOUND', '手机阅读章节不在当前番茄目录中，请稍后重试。')
      const ticket = randomUUID()
      const pull = { ticket, accountId: auth.accountId, binding, progress, chapters }
      for (const [key, entry] of this.tickets) if (entry.expiresAt <= Date.now()) this.tickets.delete(key)
      if (this.tickets.size >= 64) this.tickets.delete(this.tickets.keys().next().value!)
      this.tickets.set(ticket, { expiresAt: Date.now() + 10 * 60_000, generation: this.generation, pull })
      return pull
    })
  }
  async acknowledge(ticket: string, local: FanqieLocation): Promise<void> {
    const entry = this.tickets.get(ticket); const auth = this.session()
    if (!entry || entry.expiresAt <= Date.now() || entry.generation !== this.generation || entry.pull.accountId !== auth.accountId)
      throw new FanqieError('STALE_SYNC', '同步结果已过期或账号已切换，请重新同步。')
    try { await this.store.acknowledge(auth.accountId, entry.pull.binding, entry.pull.progress.chapterId, local) }
    catch { throw new FanqieError('STALE_SYNC', '书籍绑定或进度已变化，请重新同步。') }
    this.tickets.delete(ticket)
  }
}
