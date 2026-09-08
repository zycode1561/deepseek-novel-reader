import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadSettings } from '../src/client/storage/local.ts'

function stubSettings(value: unknown): void {
  vi.stubGlobal('localStorage', {
    getItem: () => JSON.stringify(value),
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 1,
  } satisfies Storage)
}

afterEach(() => vi.unstubAllGlobals())

describe('reader page mode settings', () => {
  it('keeps existing users on the original scrolling mode', () => {
    stubSettings({ fontSize: 20 })
    expect(loadSettings().pageMode).toBe('scroll')
    expect(loadSettings().footerDisplay).toBe('chapter-title')
    expect(loadSettings().toggleShortcut).toMatchObject({ metaKey: true, key: '/', code: 'Slash' })
  })

  it('restores the horizontal paged mode', () => {
    stubSettings({ pageMode: 'paged' })
    expect(loadSettings().pageMode).toBe('paged')
  })

  it('restores the chapter progress footer', () => {
    stubSettings({ footerDisplay: 'chapter-progress' })
    expect(loadSettings().footerDisplay).toBe('chapter-progress')
  })

  it('restores a custom panel toggle shortcut', () => {
    stubSettings({
      toggleShortcut: {
        altKey: true, ctrlKey: false, metaKey: true, shiftKey: false, key: 'b', code: 'KeyB',
      },
    })
    expect(loadSettings().toggleShortcut).toMatchObject({ metaKey: true, altKey: true, code: 'KeyB' })
  })
})
