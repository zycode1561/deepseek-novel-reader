import { useEffect, useMemo, useRef, useState } from 'react'
import JSON5 from 'json5'
import { ANY_READER_TEMPLATE, type ManagedRule, type RuleFormat, type RuleImportPreview, type RuleTestResponse } from '../../shared/rules.ts'
import { commitRuleImport, deleteRule, exportRules, listRules, previewRuleImport, saveRule, setRuleEnabled, testRule } from '../online/api.ts'

const groups = [
  { title: '基本信息', fields: [['name', '名称'], ['host', '域名'], ['author', '规则作者'], ['userAgent', 'User-Agent / 请求头 JSON'], ['allowedHosts', '额外授权主机（JSON 数组）']] },
  { title: '搜索', fields: [['searchUrl', '请求地址'], ['searchList', '列表'], ['searchName', '书名'], ['searchAuthor', '作者'], ['searchDescription', '简介'], ['searchChapter', '最新章节'], ['searchResult', '阶段结果'], ['searchNextUrl', '下一页（扩展字段）']] },
  { title: '目录', fields: [['chapterUrl', '请求地址（空值使用阶段结果）'], ['chapterList', '列表'], ['chapterName', '章节名称'], ['chapterResult', '阶段结果'], ['chapterNextUrl', '下一页']] },
  { title: '正文', fields: [['contentUrl', '请求地址（空值使用阶段结果）'], ['contentItems', '正文'], ['contentNextUrl', '下一页']] },
]
const sonovelGroups = [
  { title: '基本信息', fields: [['name', '名称'], ['url', '域名'], ['comment', '说明']] },
  { title: '搜索', fields: [['search.url', '请求地址'], ['search.method', '方法'], ['search.data', 'POST 表单'], ['search.result', '列表'], ['search.bookName', '书名 / 链接'], ['search.author', '作者']] },
  { title: '目录', fields: [['toc.url', '请求地址'], ['toc.baseUri', '相对链接基址'], ['toc.list', '页面变换'], ['toc.item', '章节链接'], ['toc.nextPage', '下一页']] },
  { title: '正文', fields: [['chapter.title', '标题'], ['chapter.content', '正文'], ['chapter.paragraphTag', '分段规则'], ['chapter.filterTag', '删除元素'], ['chapter.filterTxt', '删除文本'], ['chapter.nextPage', '下一页']] },
]
function fieldValue(raw: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, raw)
}
function setField(raw: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const copy = structuredClone(raw)
  const keys = path.split('.')
  let root = copy
  for (const key of keys.slice(0, -1)) {
    if (!root[key] || typeof root[key] !== 'object') root[key] = {}
    root = root[key] as Record<string, unknown>
  }
  root[keys.at(-1)!] = value
  return copy
}

export function RuleManagerPanel({ onBack }: { onBack(): void }): JSX.Element {
  const [rules, setRules] = useState<ManagedRule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ManagedRule | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [format, setFormat] = useState<RuleFormat>('any-reader')
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [enabled, setEnabled] = useState(true)
  const [hostsText, setHostsText] = useState('[]')
  const [importing, setImporting] = useState(false)
  const [importText, setImportText] = useState('')
  const [preview, setPreview] = useState<RuleImportPreview | null>(null)
  const [updateIds, setUpdateIds] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [test, setTest] = useState<RuleTestResponse | null>(null)
  const testController = useRef<AbortController | null>(null)
  const readOnly = selected?.kind === 'builtin'
  const parsed = useMemo((): { raw: Record<string, unknown> | null; issue: string | null } => {
    try {
      const value: unknown = JSON5.parse(draft || '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('规则必须是 JSON 对象。')
      return { raw: value as Record<string, unknown>, issue: null }
    } catch (caught) { return { raw: null, issue: caught instanceof Error ? caught.message : String(caught) } }
  }, [draft])
  const serializedHosts = JSON.stringify(parsed.raw?.allowedHosts ?? [])
  useEffect(() => { setHostsText(serializedHosts) }, [serializedHosts])
  const hostsIssue = useMemo(() => {
    try {
      const value: unknown = JSON5.parse(hostsText || '[]')
      if (!Array.isArray(value) || value.some(host => typeof host !== 'string' || !/^[a-z\d.-]+$/i.test(host))) throw new Error()
      return null
    } catch { return '额外授权主机请填写不含通配符的域名数组，例如 ["cdn.example.com"]。' }
  }, [hostsText])
  useEffect(() => {
    const controller = new AbortController()
    void listRules(controller.signal).then(setRules).catch(caught => {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '书源管理不可用。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); testController.current?.abort() }
  }, [])
  const refresh = async (): Promise<void> => { setRules(await listRules()) }
  const action = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null); setMessage('')
    try { await operation() }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { setBusy(false) }
  }
  const changeDraft = (text: string): void => { testController.current?.abort(); setDraft(text); setTest(null) }
  const edit = (rule: ManagedRule | null, copy = false): void => {
    testController.current?.abort()
    const raw = rule ? structuredClone(rule.raw) : structuredClone(ANY_READER_TEMPLATE)
    if (copy) { delete raw.id; raw.name = `${rule!.name}（副本）` }
    setSelected(copy ? null : rule); setFormat(rule?.format ?? 'any-reader'); setEnabled(copy ? true : rule?.enabled ?? true)
    changeDraft(JSON.stringify(raw, null, 2)); setEditing(true); setImporting(false); setMode('form'); setError(null); setMessage('')
  }
  const updateField = (path: string, text: string): void => {
    if (!parsed.raw) return
    try {
      const value = path === 'allowedHosts' ? JSON5.parse(text || '[]') : text
      changeDraft(JSON.stringify(setField(parsed.raw, path, value), null, 2))
    } catch { setError('额外授权主机请填写 JSON 数组，例如 ["cdn.example.com"]。') }
  }
  const download = (id?: string): void => { void action(async () => {
    const raw = await exportRules(id)
    const url = URL.createObjectURL(new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = 'novel-reader-rules.json'; anchor.click()
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }) }
  const runTest = (stage: RuleTestResponse['stage'], handle?: string): void => {
    if (!parsed.raw) return
    testController.current?.abort()
    const controller = new AbortController()
    testController.current = controller
    setBusy(true); setError(null)
    void testRule({ raw: parsed.raw, format, stage, keyword, ...(handle ? { handle } : {}) }, controller.signal)
      .then(value => { if (!controller.signal.aborted) setTest(value) })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught)) })
      .finally(() => { if (testController.current === controller) setBusy(false) })
  }

  return <section className="dnr-rules-panel">
    <header className="dnr-online-heading">
      <button type="button" className="dnr-online-back" onClick={onBack}>‹ 返回搜书</button>
      <div><strong>书源管理</strong><span>小说规则 · 保存在本机 Host</span></div>
    </header>
    {error && <div className="dnr-alert" role="alert">{error}</div>}
    {message && <p role="status">{message}</p>}
    {!editing && !importing && <>
      <div className="dnr-rule-actions">
        <button type="button" disabled={busy || loading || !!error} onClick={() => edit(null)}>新建规则</button>
        <button type="button" disabled={busy || loading || !!error} onClick={() => { setImporting(true); setPreview(null); setImportText('') }}>导入规则</button>
        <button type="button" disabled={busy || loading} onClick={() => download()}>导出自定义规则</button>
        {error && <button type="button" disabled={busy} onClick={() => { void action(refresh) }}>重试连接</button>}
      </div>
      {loading && <p role="status">正在连接书源管理…</p>}
      <div className="dnr-rule-list">{rules.map(rule => <article key={rule.id}>
        <div className="dnr-rule-title"><strong>{rule.name}</strong><label><input type="checkbox" aria-label={`启用 ${rule.name}`} checked={rule.enabled} disabled={busy || !rule.compatible} onChange={event => {
          const checked = event.currentTarget.checked
          void action(async () => { await setRuleEnabled(rule.id, checked); await refresh() })
        }} />启用</label></div>
        <small>{rule.kind === 'builtin' ? '内置' : '自定义'} · {rule.format === 'any-reader' ? 'AnyReader / 亦搜' : 'SoNovel'}{!rule.compatible ? ' · 不兼容，已禁用' : ''}</small>
        {!!rule.diagnostics.length && <ul className="dnr-rule-diagnostics">{rule.diagnostics.map((item, index) => <li key={index}><code>{item.field}</code>：{item.message}</li>)}</ul>}
        <div className="dnr-rule-actions">
          <button type="button" disabled={busy} onClick={() => edit(rule)}>{rule.kind === 'builtin' ? '查看 / 测试' : '编辑 / 测试'}</button>
          <button type="button" disabled={busy} onClick={() => edit(rule, true)}>复制并编辑</button>
          <button type="button" disabled={busy} onClick={() => download(rule.id)}>导出</button>
          {rule.kind === 'custom' && <button type="button" disabled={busy} onClick={() => { void action(async () => { await deleteRule(rule.id); await refresh() }) }}>删除</button>}
        </div>
      </article>)}</div>
    </>}

    {importing && <div className="dnr-rule-import">
      <div className="dnr-rule-actions"><button type="button" disabled={busy} onClick={() => setImporting(false)}>返回列表</button>
        <label className="dnr-rule-file">选择文件<input type="file" accept=".json,.json5,.txt" disabled={busy} onChange={event => {
          const file = event.currentTarget.files?.[0]
          if (!file) return
          void action(async () => { if (file.size > 1024 * 1024) throw new Error('文件超过 1 MiB。'); setImportText(await file.text()); setPreview(null) })
          event.currentTarget.value = ''
        }} /></label>
      </div>
      <label>JSON / JSON5 / eso://<textarea className="dnr-rule-json" aria-label="待导入规则" value={importText} disabled={busy} onChange={event => { setImportText(event.currentTarget.value); setPreview(null) }} /></label>
      <p className="dnr-setting-hint">每批最多 200 条、1 MiB。不兼容规则保留原文并禁用。</p>
      <button type="button" disabled={busy || !importText.trim()} onClick={() => { void action(async () => { setPreview(await previewRuleImport(importText)); setUpdateIds([]) }) }}>校验并预览</button>
      {preview && <>
        <div className="dnr-rule-list">{preview.items.map((rule, index) => <article key={`${rule.id}:${index}`}>
          <strong>{rule.name}</strong><p>{rule.compatible ? '兼容 · 默认启用' : '不兼容 · 保存后禁用'}</p>
          {rule.duplicate && <label><input type="checkbox" checked={updateIds.includes(rule.id)} onChange={event => setUpdateIds(event.currentTarget.checked ? [...updateIds, rule.id] : updateIds.filter(id => id !== rule.id))} />更新同 ID 规则（默认跳过）</label>}
          {rule.diagnostics.map((item, i) => <p className="dnr-rule-issue" key={i}>{item.field}：{item.message}</p>)}
        </article>)}</div>
        <button type="button" className="dnr-primary-button" disabled={busy} onClick={() => { void action(async () => {
          const result = await commitRuleImport(preview.token, updateIds)
          await refresh(); setImporting(false); setPreview(null); setMessage(`已导入 ${result.imported} 条，跳过 ${result.skipped} 条。`)
        }) }}>确认导入 {preview.items.length} 条</button>
      </>}
    </div>}

    {editing && <div className="dnr-rule-editor">
      <div className="dnr-rule-actions"><button type="button" disabled={busy} onClick={() => { testController.current?.abort(); setEditing(false) }}>返回列表</button>
        <button type="button" disabled={mode === 'form' || !parsed.raw} onClick={() => setMode('form')}>分步骤表单</button>
        <button type="button" disabled={mode === 'json' || !!hostsIssue} onClick={() => setMode('json')}>原始 JSON</button>
      </div>
      {readOnly && <p className="dnr-setting-hint">内置规则只读，可返回列表后“复制并编辑”。</p>}
      {mode === 'json' ? <textarea className="dnr-rule-json" aria-label="原始规则 JSON" spellCheck={false} readOnly={readOnly} disabled={busy} value={draft} onChange={event => changeDraft(event.currentTarget.value)} /> :
        <>{(format === 'any-reader' ? groups : sonovelGroups).map(group => <details key={group.title} open>
          <summary>{group.title}</summary>
          {group.fields.map(([path, label]) => {
            const value = parsed.raw ? fieldValue(parsed.raw, path!) : ''
            return <label key={path}>{label}{path === 'allowedHosts'
              ? <textarea rows={1} aria-label={`${group.title} ${label}`} disabled={readOnly || busy} value={hostsText} onChange={event => setHostsText(event.currentTarget.value)} onBlur={event => { if (!hostsIssue) updateField(path, event.currentTarget.value) }} />
              : <textarea rows={path?.endsWith('Url') || path?.endsWith('.url') ? 2 : 1} aria-label={`${group.title} ${label}`} disabled={readOnly || busy} value={typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')} onChange={event => updateField(path!, event.currentTarget.value)} />}</label>
          })}
        </details>)}</>}
      {parsed.issue && <p className="dnr-rule-issue" role="alert">{parsed.issue}</p>}
      {format === 'any-reader' && mode === 'form' && hostsIssue && <p className="dnr-rule-issue" role="alert">{hostsIssue}</p>}
      {!readOnly && <div className="dnr-rule-actions"><label><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.currentTarget.checked)} />保存后启用</label>
        <button type="button" className="dnr-primary-button" disabled={busy || !parsed.raw || (format === 'any-reader' && !!hostsIssue)} onClick={() => { void action(async () => {
          const saved = await saveRule(parsed.raw!, format, enabled, selected?.id)
          setSelected(saved); setEnabled(saved.enabled); changeDraft(JSON.stringify(saved.raw, null, 2)); await refresh()
          setMessage(saved.compatible ? '已保存，书源立即生效。' : '已保存原始规则；不兼容字段需修复后才能启用。')
        }) }}>保存规则</button></div>}
      {selected?.diagnostics.map((item, index) => <p className="dnr-rule-issue" key={index}>{item.field}：{item.message}</p>)}

      <div className="dnr-rule-test">
        <strong>分阶段测试</strong><p className="dnr-setting-hint">测试当前草稿，不保存规则、不整本下载。列表最多预览 100 项。</p>
        <label>测试书名 / 作者<input aria-label="测试关键词" maxLength={100} value={keyword} disabled={busy} onChange={event => setKeyword(event.currentTarget.value)} /></label>
        <div className="dnr-rule-actions"><button type="button" disabled={busy || !parsed.raw || !keyword.trim() || (format === 'any-reader' && !!hostsIssue)} onClick={() => runTest('search')}>测试搜索</button>
          {busy && <button type="button" onClick={() => testController.current?.abort()}>取消测试</button>}</div>
        {test && <>
          <p>{test.stage === 'search' ? '搜索结果：选择书籍测试目录' : test.stage === 'toc' ? '目录结果：选择章节测试正文' : '正文预览'}</p>
          <details open><summary>请求地址（{test.requests.length}）</summary>{test.requests.map((url, index) => <code className="dnr-rule-request" key={index}>{url}</code>)}</details>
          {test.diagnostics.map((item, index) => <p className="dnr-rule-issue" role="alert" key={index}>{item.field}：{item.message}</p>)}
          <div className="dnr-rule-test-items">{test.items.map(item => <button type="button" key={item.handle} disabled={busy} onClick={() => runTest(test.stage === 'search' ? 'toc' : 'content', item.handle)}><strong>{item.title}</strong><small>{item.author || item.url}</small></button>)}</div>
          <div className="dnr-rule-content-preview">{test.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
        </>}
      </div>
    </div>}
  </section>
}
