import { describe, expect, it } from 'vitest'
import {
  hasLauncherDragExceededThreshold,
  launcherYRatioFromPointer,
  normalizeLauncherYRatio,
} from '../src/shared/launcher-position.ts'

describe('launcher position helpers', () => {
  it('normalizes missing, invalid, and finite persisted ratios', () => {
    expect(normalizeLauncherYRatio(undefined)).toBe(0.43)
    expect(normalizeLauncherYRatio(Number.NaN)).toBe(0.43)
    expect(normalizeLauncherYRatio(0.61)).toBe(0.61)
    expect(normalizeLauncherYRatio(-0.1)).toBe(0)
    expect(normalizeLauncherYRatio(1.1)).toBe(1)
  })

  it('uses a five pixel threshold to distinguish clicks from drags', () => {
    expect(hasLauncherDragExceededThreshold(100, 104.99)).toBe(false)
    expect(hasLauncherDragExceededThreshold(100, 105)).toBe(true)
    expect(hasLauncherDragExceededThreshold(100, 95)).toBe(true)
  })

  it('converts overlay-relative pointer positions to a ratio', () => {
    expect(launcherYRatioFromPointer(420, 20, 800, 44)).toBe(0.5)
  })

  it('keeps the launcher inside the overlay safe edges', () => {
    // 44px launcher => 22px half-height + 8px safe padding = 30px inset.
    expect(launcherYRatioFromPointer(-100, 20, 800, 44)).toBe(30 / 800)
    expect(launcherYRatioFromPointer(2_000, 20, 800, 44)).toBe(770 / 800)
  })

  it('falls back safely when overlay geometry is unusable', () => {
    expect(launcherYRatioFromPointer(100, 0, 0, 44)).toBe(0.43)
    expect(launcherYRatioFromPointer(Number.NaN, 0, 800, 44)).toBe(0.43)
  })
})
