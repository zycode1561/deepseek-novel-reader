import { useCallback, useEffect, useRef, useState } from 'react'
import { fanqieSyncDecision, locationOf, matchFanqieChapter, sameLocation, type FanqiePull, type FanqieStatus } from '../../shared/fanqie.ts'
import { useReader } from '../state/ReaderContext.tsx'
import { acknowledgeFanqie, FanqieApiError, getFanqieStatus, pullFanqieProgress } from './api.ts'

export interface FanqieProposal { pull: FanqiePull; candidates: number[]; reason: string }
export function useFanqieSync() {
  const reader = useReader()
  const current = useRef(reader); current.current = reader
  const [status, setStatus] = useState<FanqieStatus | null>(null)
  const [proposal, setProposal] = useState<FanqieProposal | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const operation = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const invalidate = useCallback(() => {
    generation.current++; operation.current?.abort(); operation.current = null
    setProposal(null); setBusy(false); setMessage('')
  }, [])
  const refreshStatus = useCallback(async () => { const value = await getFanqieStatus(); setStatus(value); return value }, [])
  useEffect(() => {
    const controller = new AbortController()
    void getFanqieStatus(controller.signal).then(setStatus).catch(() => {})
    return () => { controller.abort(); operation.current?.abort(); generation.current++ }
  }, [])
  const sync = useCallback(async (manual = false) => {
    const start = current.current
    if (!start.book || !start.progress || !start.ready || start.loading) return
    operation.current?.abort()
    const controller = new AbortController(); operation.current = controller
    const gen = ++generation.current
    setBusy(true); setProposal(null); setMessage('')
    try {
      const pull = await pullFanqieProgress(start.book.id, controller.signal)
      controller.signal.throwIfAborted()
      const latest = current.current
      if (gen !== generation.current || latest.book?.id !== start.book.id || !latest.progress) return
      if (!pull) { if (manual) setMessage('请先登录番茄，并将当前书籍与番茄书架绑定。'); return }
      const remote = pull.chapters.find(chapter => chapter.id === pull.progress.chapterId)!
      const candidates = matchFanqieChapter(remote, latest.book.chapters)
      if (candidates.length !== 1) {
        setProposal({ pull, candidates, reason: candidates.length ? '找到多个同名章节，请确认对应位置。' : '目录存在差异，请选择对应章节。' }); return
      }
      const target = candidates[0]!
      const location = locationOf(latest.progress)
      const first = latest.book.chapters[0]?.paragraphStart ?? 0
      const decision = fanqieSyncDecision(pull.binding, pull.progress.chapterId, location, target,
        latest.progress.chapterIndex === 0 && latest.progress.paragraphIndex <= Math.max(0, first))
      if (decision === 'unchanged') { if (manual) setMessage('手机章节没有变化，已保留电脑阅读位置。'); return }
      if (decision === 'conflict' || !sameLocation(start.progress, latest.progress)) {
        setProposal({ pull, candidates, reason: '手机与电脑都有阅读位置，请选择从哪里继续。' }); return
      }
      let position = latest.progress
      if (decision === 'apply') {
        const applied = await latest.applySyncedChapter(latest.book.id, target, location)
        if (!applied) { setProposal({ pull, candidates, reason: '章节未加载成功或电脑位置已变化，请重试。' }); return }
        position = applied
      }
      if (gen !== generation.current) return
      await acknowledgeFanqie(pull.ticket, locationOf(position))
      if (gen !== generation.current) return
      setMessage(decision === 'apply' ? `已同步手机章节：${remote.title}` : '手机与电脑在同一章，已保留电脑章内位置。')
      await refreshStatus()
    } catch (error) {
      if (!controller.signal.aborted && gen === generation.current) {
        setMessage(error instanceof Error ? error.message : '同步失败，已保留本地位置。')
        if (error instanceof FanqieApiError && error.code === 'AUTH_EXPIRED') void refreshStatus().catch(() => {})
      }
    } finally { if (gen === generation.current) setBusy(false) }
  }, [refreshStatus])
  useEffect(() => {
    invalidate()
    if (reader.book && reader.ready) void sync()
    return () => { operation.current?.abort(); generation.current++ }
  }, [reader.book?.id, reader.ready, invalidate, sync])

  const resolve = useCallback(async (target: number | null) => {
    const pending = proposal; const latest = current.current
    if (!pending || !latest.book || !latest.progress || latest.book.id !== pending.pull.binding.localBookId) return
    const gen = generation.current
    setBusy(true)
    try {
      let position = latest.progress
      if (target !== null) {
        const applied = await latest.applySyncedChapter(latest.book.id, target, locationOf(latest.progress))
        if (!applied) throw new Error('章节未加载成功或阅读位置已变化，请重试。')
        position = applied
      }
      if (gen !== generation.current) return
      await acknowledgeFanqie(pending.pull.ticket, locationOf(position))
      if (gen !== generation.current) return
      setProposal(null); setMessage(target === null ? '已保留电脑位置。' : `已同步到：${latest.book.chapters[target]?.title}`)
      await refreshStatus()
    } catch (error) { if (gen === generation.current) setMessage(error instanceof Error ? error.message : '同步失败。') }
    finally { if (gen === generation.current) setBusy(false) }
  }, [proposal, refreshStatus])
  return { status, setStatus, refreshStatus, proposal, message, busy, sync, resolve, invalidate }
}
export type FanqieSync = ReturnType<typeof useFanqieSync>
