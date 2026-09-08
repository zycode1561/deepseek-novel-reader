import { describe, expect, it } from 'vitest'
import {
  isToggleReaderShortcut, shortcutFromKeyboardEvent, shortcutLabel, type ReaderKeyboardEvent,
} from '../src/client/shortcuts.ts'
import type { ReaderShortcut } from '../src/shared/types.ts'

function keyboardEvent(overrides: Partial<ReaderKeyboardEvent> = {}): ReaderKeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    key: '/',
    code: 'Slash',
    keyCode: 191,
    ...overrides,
  }
}

describe('reader panel toggle shortcut', () => {
  it('matches Command + / using key, code, or legacy keyCode', () => {
    expect(isToggleReaderShortcut(keyboardEvent())).toBe(true)
    expect(isToggleReaderShortcut(keyboardEvent({ key: 'Unidentified' }))).toBe(true)
    expect(isToggleReaderShortcut(keyboardEvent({ key: 'Unidentified', code: 'NumpadDivide', keyCode: 111 }))).toBe(true)
    expect(isToggleReaderShortcut(keyboardEvent({ key: '/', code: '', keyCode: 0 }))).toBe(true)
    expect(isToggleReaderShortcut(keyboardEvent({ key: 'Unidentified', code: '', keyCode: 191 }))).toBe(true)
  })

  it('accepts macOS webviews that expose Command through modifier state', () => {
    expect(isToggleReaderShortcut(keyboardEvent({
      metaKey: false,
      getModifierState: key => key === 'Meta',
    }))).toBe(true)
  })

  it('does not consume a plain slash or modified variants', () => {
    expect(isToggleReaderShortcut(keyboardEvent({ metaKey: false }))).toBe(false)
    expect(isToggleReaderShortcut(keyboardEvent({ altKey: true }))).toBe(false)
    expect(isToggleReaderShortcut(keyboardEvent({ ctrlKey: true }))).toBe(false)
    expect(isToggleReaderShortcut(keyboardEvent({ shiftKey: true }))).toBe(false)
    expect(isToggleReaderShortcut(keyboardEvent({ key: '.', code: 'Period', keyCode: 190 }))).toBe(false)
  })

  it('records and matches a custom modifier combination', () => {
    const event = keyboardEvent({ metaKey: false, ctrlKey: true, altKey: true, key: 'k', code: 'KeyK', keyCode: 75 })
    const shortcut = shortcutFromKeyboardEvent(event)
    expect(shortcut).toEqual({
      altKey: true, ctrlKey: true, metaKey: false, shiftKey: false, key: 'k', code: 'KeyK',
    })
    expect(isToggleReaderShortcut(event, shortcut!)).toBe(true)
    expect(isToggleReaderShortcut(keyboardEvent(), shortcut!)).toBe(false)
    expect(shortcutLabel(shortcut!)).toBe('Control + Option + K')
  })

  it('rejects modifier-only and unmodified shortcuts', () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent({ metaKey: true, key: 'Meta', code: 'MetaLeft', keyCode: 91 }))).toBeNull()
    expect(shortcutFromKeyboardEvent(keyboardEvent({ metaKey: false, key: 'k', code: 'KeyK', keyCode: 75 }))).toBeNull()
  })

  it('formats the default Command + / shortcut', () => {
    const shortcut: ReaderShortcut = {
      altKey: false, ctrlKey: false, metaKey: true, shiftKey: false, key: '/', code: 'Slash',
    }
    expect(shortcutLabel(shortcut)).toBe('Command + /')
  })
})
