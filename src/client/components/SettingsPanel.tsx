import { useState } from 'react'
import { DEFAULT_TOGGLE_SHORTCUT } from '../../shared/constants.ts'
import type { FooterDisplay, FontFamily, LineSpacing, PageMode, ReaderTheme, TocPosition } from '../../shared/types.ts'
import { shortcutFromKeyboardEvent, shortcutLabel } from '../shortcuts.ts'
import { useReader } from '../state/ReaderContext.tsx'

const fonts: Array<{ value: FontFamily; label: string; preview: string }> = [
  { value: 'system', label: '系统', preview: '苹方 / 默认' },
  { value: 'songti', label: '宋体', preview: '思源宋体' },
  { value: 'heiti', label: '黑体', preview: '思源黑体' },
  { value: 'kaiti', label: '楷体', preview: '楷体' },
  { value: 'serif', label: '衬线', preview: 'Noto Serif' },
]

const spacings: Array<{ value: LineSpacing; label: string }> = [
  { value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '适中' }, { value: 'relaxed', label: '宽松' },
]

const themes: Array<{ value: ReaderTheme; label: string }> = [
  { value: 'light', label: '日间白' }, { value: 'dark', label: '夜间黑' },
  { value: 'eye-care', label: '护眼绿' }, { value: 'parchment', label: '羊皮纸' },
]

const pageModes: Array<{ value: PageMode; label: string; hint: string }> = [
  { value: 'scroll', label: '上下滚动', hint: '保留当前连续阅读方式' },
  { value: 'paged', label: '左右翻页', hint: '类似微信读书，按屏分页' },
]

const footerDisplays: Array<{ value: FooterDisplay; label: string }> = [
  { value: 'chapter-progress', label: '章节进度条' },
  { value: 'chapter-title', label: '章节名称' },
]

export function SettingsPanel(): JSX.Element {
  const { settings, updateSettings } = useReader()
  const [recordingShortcut, setRecordingShortcut] = useState(false)
  return <section className="dnr-settings">
    <div className="dnr-panel-heading"><span>阅读设置</span><span>{settings.fontSize}px</span></div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">字号</div>
      <div className="dnr-range-row"><span>小</span><input aria-label="字体大小" type="range" min="12" max="32" step="1" value={settings.fontSize} onChange={event => updateSettings({ fontSize: Number(event.target.value) })} /><span>大</span></div>
    </div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">字体</div>
      <div className="dnr-font-grid">{fonts.map(font => <button key={font.value} type="button" className={settings.fontFamily === font.value ? 'is-active' : ''} data-font={font.value} onClick={() => updateSettings({ fontFamily: font.value })}><strong>{font.label}</strong><span>{font.preview}</span></button>)}</div>
    </div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">行间距</div>
      <div className="dnr-segmented">{spacings.map(item => <button key={item.value} type="button" className={settings.lineSpacing === item.value ? 'is-active' : ''} onClick={() => updateSettings({ lineSpacing: item.value })}>{item.label}</button>)}</div>
    </div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">翻页方式</div>
      <div className="dnr-page-mode-grid">{pageModes.map(item => <button key={item.value} type="button" className={settings.pageMode === item.value ? 'is-active' : ''} onClick={() => updateSettings({ pageMode: item.value })}><strong>{item.label}</strong><span>{item.hint}</span></button>)}</div>
    </div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">主题</div>
      <div className="dnr-theme-grid">{themes.map(item => <button key={item.value} type="button" className={settings.theme === item.value ? 'is-active' : ''} onClick={() => updateSettings({ theme: item.value })}><i data-theme={item.value} /><span>{item.label}</span></button>)}</div>
    </div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">目录布局</div>
      <div className="dnr-segmented">{(['left', 'top'] as TocPosition[]).map(value => <button key={value} type="button" className={settings.tocPosition === value ? 'is-active' : ''} onClick={() => updateSettings({ tocPosition: value })}>{value === 'left' ? '左侧常驻' : '顶部面板'}</button>)}</div>
    </div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">底部显示</div>
      <div className="dnr-segmented">{footerDisplays.map(item => <button key={item.value} type="button" className={settings.footerDisplay === item.value ? 'is-active' : ''} onClick={() => updateSettings({ footerDisplay: item.value })}>{item.label}</button>)}</div>
    </div>

    <div className="dnr-setting-group">
      <div className="dnr-section-label">展开 / 收起快捷键</div>
      <div className="dnr-shortcut-editor">
        <button
          type="button"
          className={recordingShortcut ? 'is-recording' : ''}
          data-shortcut-recorder={recordingShortcut || undefined}
          aria-label="编辑展开或收起快捷键"
          onClick={() => setRecordingShortcut(true)}
          onBlur={() => setRecordingShortcut(false)}
          onKeyDown={(event) => {
            if (!recordingShortcut) return
            event.preventDefault()
            event.stopPropagation()
            if (event.key === 'Escape') {
              setRecordingShortcut(false)
              return
            }
            const shortcut = shortcutFromKeyboardEvent(event.nativeEvent)
            if (shortcut === null) return
            updateSettings({ toggleShortcut: shortcut })
            setRecordingShortcut(false)
          }}
        >
          <span>{recordingShortcut ? '请按新的组合键…' : shortcutLabel(settings.toggleShortcut)}</span>
          <small>{recordingShortcut ? '至少包含 Command、Control、Option 或 Shift' : '点击后录制'}</small>
        </button>
        <button type="button" className="dnr-shortcut-reset" onClick={() => {
          updateSettings({ toggleShortcut: { ...DEFAULT_TOGGLE_SHORTCUT } })
          setRecordingShortcut(false)
        }}>恢复默认</button>
      </div>
      <p className="dnr-setting-hint">录制时按 Esc 取消。部分浏览器或系统快捷键可能会优先于插件响应。</p>
    </div>

    <label className="dnr-toggle-row"><span><strong>段落首行缩进</strong><small>更适合中文长篇阅读</small></span><input type="checkbox" checked={settings.firstLineIndent} onChange={event => updateSettings({ firstLineIndent: event.target.checked })} /></label>
  </section>
}
