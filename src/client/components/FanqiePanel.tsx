import { useEffect, useRef, useState } from 'react'
import type { FanqieLogin, FanqieShelfBook, FanqieStatus } from '../../shared/fanqie.ts'
import { cancelFanqieLogin, checkFanqieLogin, getFanqieShelf, logoutFanqie, startFanqieLogin } from '../fanqie/api.ts'

export interface FanqieAccount {
  status: FanqieStatus | null
  setStatus(value: FanqieStatus): void
  refreshStatus(): Promise<FanqieStatus>
}

/** Independent remote shelf: never reads the local ReaderContext. */
export function FanqiePanel({ account, onRead, opening = false }: {
  account: FanqieAccount; onRead(book: FanqieShelfBook): void; opening?: boolean
}): JSX.Element {
  const [login, setLogin] = useState<FanqieLogin | null>(null)
  const [shelf, setShelf] = useState<FanqieShelfBook[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loginState, setLoginState] = useState('等待手机扫码')
  const alive = useRef(true)
  const loginRequest = useRef<AbortController | null>(null)
  const loginId = useRef<string | null>(null)
  const disabled = busy || opening

  useEffect(() => {
    alive.current = true
    void account.refreshStatus().catch(error => { if (alive.current) setError(error instanceof Error ? error.message : '读取账号状态失败。') })
    return () => {
      alive.current = false; loginRequest.current?.abort()
      if (loginId.current) void cancelFanqieLogin(loginId.current).catch(() => {})
    }
  }, [account.refreshStatus])

  useEffect(() => {
    const controller = new AbortController()
    setShelf([])
    setBusy(false); setError('')
    if (account.status?.loggedIn) {
      setBusy(true)
      void getFanqieShelf(controller.signal).then(value => { if (!controller.signal.aborted) setShelf(value) }).catch(error => {
        if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取书架失败。')
      }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
    }
    return () => controller.abort()
  }, [account.status?.accountId, account.status?.loggedIn])

  useEffect(() => {
    if (!login) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (Date.now() >= login.expiresAt) { setError('二维码已过期，请重新扫码。'); setLogin(null); return }
      try {
        const result = await checkFanqieLogin(login.id, controller.signal)
        if (controller.signal.aborted) return
        if (result.state === 'confirmed') {
          loginId.current = null; setLogin(null); account.setStatus(result.status); setError(''); return
        }
        if (result.state === 'expired') { setLogin(null); setError('二维码已过期，请重新扫码。'); return }
        setLoginState(['scanned', 'confirm', 'confirming'].includes(result.state) ? '已扫码，请在手机确认登录' : '等待手机扫码')
      } catch (error) {
        if (controller.signal.aborted) return
        setError(error instanceof Error ? error.message : '检查登录状态失败。')
      }
      timer = setTimeout(() => { void poll() }, account.status?.pollIntervalMs ?? 2000)
    }
    timer = setTimeout(() => { void poll() }, account.status?.pollIntervalMs ?? 2000)
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [login, account.status?.pollIntervalMs, account.setStatus])

  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : '操作失败，请重试。') }
    finally { if (alive.current) setBusy(false) }
  }
  const beginLogin = () => void action(async () => {
    loginRequest.current?.abort()
    if (loginId.current) await cancelFanqieLogin(loginId.current).catch(() => {})
    const controller = new AbortController(); loginRequest.current = controller
    const next = await startFanqieLogin(controller.signal)
    if (!alive.current || controller.signal.aborted) { void cancelFanqieLogin(next.id).catch(() => {}); return }
    loginId.current = next.id; setLoginState('等待手机扫码'); setLogin(next)
  })

  return <section className="dnr-fanqie-panel">
    <div className="dnr-panel-heading"><strong>番茄书架</strong></div>
    <p className="dnr-fanqie-hint">直接打开番茄小说，续读手机章节。</p>
    <div className="dnr-fanqie-account">
      <strong>{account.status?.loggedIn ? '已连接番茄账号' : '尚未登录番茄'}</strong>
      <div className="dnr-fanqie-actions">
        <button type="button" disabled={disabled} onClick={beginLogin}>{account.status?.loggedIn ? '更换账号' : '扫码登录'}</button>
        {account.status?.loggedIn && <>
          <button type="button" disabled={disabled} onClick={() => void action(async () => {
            setLogin(null); loginId.current = null; setShelf([]); account.setStatus(await logoutFanqie())
          })}>退出登录</button>
          <button type="button" disabled={disabled} onClick={() => void action(async () => { setShelf(await getFanqieShelf()); await account.refreshStatus() })}>刷新书架</button>
        </>}
      </div>
      {login && <div className="dnr-fanqie-qr">
        <img src={login.qrImage} alt="番茄小说登录二维码" />
        <p role="status">{loginState}，请使用番茄小说 App 扫码。</p>
        <button type="button" onClick={() => { void cancelFanqieLogin(login.id).catch(() => {}); loginId.current = null; setLogin(null) }}>取消扫码</button>
      </div>}
    </div>
    {error && <div role="alert" className="dnr-alert">{error}</div>}
    {account.status?.loggedIn && <>
      {busy && <p role="status">正在读取番茄书架…</p>}
      {!busy && !shelf.length && <p className="dnr-fanqie-hint">书架为空，或暂未读取成功。可在手机添加书籍后刷新。</p>}
      <div className="dnr-fanqie-books">{shelf.map(item => <article key={item.id}>
        <strong>{item.name}</strong><small>{item.author}</small>
        <button type="button" disabled={disabled} onClick={() => onRead(item)}>{item.chapterId ? '继续阅读' : '开始阅读'}</button>
      </article>)}</div>
    </>}
  </section>
}
