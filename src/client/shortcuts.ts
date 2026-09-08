import { DEFAULT_TOGGLE_SHORTCUT } from '../shared/constants.ts'
import type { ReaderShortcut } from '../shared/types.ts'

/** Minimal keyboard shape used by the reader shortcut matcher and recorder. */
export interface ReaderKeyboardEvent {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  key: string
  code: string
  keyCode: number
  getModifierState?(keyArg: string): boolean
}

const MODIFIER_KEYS = new Set([
  'Alt', 'AltGraph', 'Control', 'Meta', 'Shift',
])

function modifierState(event: ReaderKeyboardEvent, name: 'Alt' | 'Control' | 'Meta' | 'Shift'): boolean {
  const direct = name === 'Alt' ? event.altKey
    : name === 'Control' ? event.ctrlKey
      : name === 'Meta' ? event.metaKey
        : event.shiftKey
  return direct || event.getModifierState?.(name) === true
}

function normalizedKey(key: string): string {
  return key.length === 1 ? key.toLocaleLowerCase() : key
}

/** Convert a keydown event into a persistable shortcut. Modifier-only keys are ignored. */
export function shortcutFromKeyboardEvent(event: ReaderKeyboardEvent): ReaderShortcut | null {
  const metaKey = modifierState(event, 'Meta')
  const ctrlKey = modifierState(event, 'Control')
  const altKey = modifierState(event, 'Alt')
  const shiftKey = modifierState(event, 'Shift')
  if (MODIFIER_KEYS.has(event.key) || (!metaKey && !ctrlKey && !altKey && !shiftKey)) return null
  if (event.code.length === 0 && event.key.length === 0) return null

  return {
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    key: normalizedKey(event.key),
    code: event.code,
  }
}

/** Match the configured toggle shortcut across browser engines and keyboard layouts. */
export function isToggleReaderShortcut(
  event: ReaderKeyboardEvent,
  shortcut: ReaderShortcut = DEFAULT_TOGGLE_SHORTCUT,
): boolean {
  if (modifierState(event, 'Meta') !== shortcut.metaKey
    || modifierState(event, 'Control') !== shortcut.ctrlKey
    || modifierState(event, 'Alt') !== shortcut.altKey
    || modifierState(event, 'Shift') !== shortcut.shiftKey) return false

  const codeMatches = shortcut.code.length > 0 && event.code === shortcut.code
  const keyMatches = shortcut.key.length > 0 && normalizedKey(event.key) === normalizedKey(shortcut.key)
  const slashFallback = shortcut.code === 'Slash' && shortcut.key === '/'
    && (event.code === 'NumpadDivide' || event.keyCode === 191 || event.keyCode === 111)
  return codeMatches || keyMatches || slashFallback
}

const KEY_LABELS: Record<string, string> = {
  ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑',
  Backspace: 'Backspace', Comma: ',', Delete: 'Delete', Enter: 'Enter', Equal: '=',
  Escape: 'Esc', Minus: '-', Period: '.', Quote: "'", Semicolon: ';', Slash: '/',
  Space: 'Space', Tab: 'Tab', Backquote: '`', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\',
}

/** Human-readable label used by the shortcut editor. */
export function shortcutLabel(shortcut: ReaderShortcut): string {
  const parts: string[] = []
  if (shortcut.metaKey) parts.push('Command')
  if (shortcut.ctrlKey) parts.push('Control')
  if (shortcut.altKey) parts.push('Option')
  if (shortcut.shiftKey) parts.push('Shift')
  const keyLabel = KEY_LABELS[shortcut.code]
    ?? (/^Key[A-Z]$/.test(shortcut.code) ? shortcut.code.slice(3) : undefined)
    ?? (/^Digit\d$/.test(shortcut.code) ? shortcut.code.slice(5) : undefined)
    ?? (shortcut.key.length === 1 ? shortcut.key.toLocaleUpperCase() : shortcut.key)
    ?? shortcut.code
  parts.push(keyLabel)
  return parts.join(' + ')
}
