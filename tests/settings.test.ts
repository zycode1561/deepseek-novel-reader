import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPanel, loadSettings } from '../src/client/storage/local.ts'

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
    expect(loadSettings().prefetchChapters).toBe(2)
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

describe('chapter prefetch settings', () => {
  it.each([0, 1, 2, 3])('restores a prefetch window of %i chapters', count => {
    stubSettings({ prefetchChapters: count })
    expect(loadSettings().prefetchChapters).toBe(count)
  })

  it.each([-1, 4, 1.5, '3', null])('falls back to two chapters for invalid stored value %j', value => {
    stubSettings({ prefetchChapters: value })
    expect(loadSettings().prefetchChapters).toBe(2)
  })
})

describe('collapsed launcher persistence', () => {
  it('uses the existing 43% position for old panel data', () => {
    stubSettings({ expanded: false, width: 420 })
    expect(loadPanel().launcherYRatio).toBe(0.43)
  })

  it('restores a custom launcher position', () => {
    stubSettings({ launcherYRatio: 0.76 })
    expect(loadPanel().launcherYRatio).toBe(0.76)
  })

  it('falls back for invalid data and clamps finite out-of-range values', () => {
    stubSettings({ launcherYRatio: 'invalid' })
    expect(loadPanel().launcherYRatio).toBe(0.43)

    stubSettings({ launcherYRatio: -2 })
    expect(loadPanel().launcherYRatio).toBe(0)

    stubSettings({ launcherYRatio: 4 })
    expect(loadPanel().launcherYRatio).toBe(1)
  })
})
