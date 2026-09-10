import type { PanelPreferences, ReaderSettings, ReaderShortcut } from './types.ts'

export const MIN_PANEL_WIDTH = 280
export const MAX_PANEL_WIDTH = 600
export const DEFAULT_PANEL_WIDTH = 420
export const DEFAULT_LAUNCHER_Y_RATIO = 0.43
export const LAUNCHER_DRAG_THRESHOLD_PX = 5
export const LAUNCHER_EDGE_PADDING_PX = 8
export const LARGE_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILE_BYTES = 50 * 1024 * 1024

export const DEFAULT_TOGGLE_SHORTCUT: ReaderShortcut = {
  altKey: false,
  ctrlKey: false,
  metaKey: true,
  shiftKey: false,
  key: '/',
  code: 'Slash',
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: 'system',
  lineSpacing: 'comfortable',
  theme: 'light',
  tocPosition: 'left',
  firstLineIndent: true,
  pageMode: 'scroll',
  footerDisplay: 'chapter-title',
  toggleShortcut: DEFAULT_TOGGLE_SHORTCUT,
}

export const DEFAULT_PANEL: PanelPreferences = {
  expanded: false,
  width: DEFAULT_PANEL_WIDTH,
  immersive: false,
  toolsVisible: true,
  launcherYRatio: DEFAULT_LAUNCHER_Y_RATIO,
}

export const STORAGE_KEYS = {
  settings: 'dsh-novel-reader:settings:v1',
  panel: 'dsh-novel-reader:panel:v1',
  progress: 'dsh-novel-reader:progress:v1',
  bookmarks: 'dsh-novel-reader:bookmarks:v1',
  recents: 'dsh-novel-reader:recents:v1',
} as const
