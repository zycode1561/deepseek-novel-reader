import {
  DEFAULT_LAUNCHER_Y_RATIO,
  LAUNCHER_DRAG_THRESHOLD_PX,
  LAUNCHER_EDGE_PADDING_PX,
} from './constants.ts'

/** Normalize persisted launcher data from current, old, or corrupted states. */
export function normalizeLauncherYRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LAUNCHER_Y_RATIO
  return Math.min(1, Math.max(0, value))
}

/** A 5px movement is considered a drag; shorter movement remains a click. */
export function hasLauncherDragExceededThreshold(startY: number, currentY: number): boolean {
  if (!Number.isFinite(startY) || !Number.isFinite(currentY)) return false
  return Math.abs(currentY - startY) >= LAUNCHER_DRAG_THRESHOLD_PX
}

/**
 * Convert the pointer-derived launcher center to a normalized overlay position.
 * The button remains inside the visible overlay with a small safe edge margin.
 */
export function launcherYRatioFromPointer(
  centerClientY: number,
  overlayTop: number,
  overlayHeight: number,
  launcherHeight: number,
  edgePadding = LAUNCHER_EDGE_PADDING_PX,
): number {
  if (![centerClientY, overlayTop, overlayHeight, launcherHeight, edgePadding].every(Number.isFinite)
    || overlayHeight <= 0) return DEFAULT_LAUNCHER_Y_RATIO

  const halfWithPadding = Math.max(0, launcherHeight / 2 + edgePadding)
  const safeInset = Math.min(overlayHeight / 2, halfWithPadding)
  const minCenter = overlayTop + safeInset
  const maxCenter = overlayTop + overlayHeight - safeInset
  const clampedCenter = Math.min(maxCenter, Math.max(minCenter, centerClientY))
  return normalizeLauncherYRatio((clampedCenter - overlayTop) / overlayHeight)
}
