import { DEFAULT_PANEL, DEFAULT_SETTINGS, STORAGE_KEYS } from '../../shared/constants.ts'
import type {
  Bookmark, PanelPreferences, ReaderSettings, ReadingPosition, RecentBook,
} from '../../shared/types.ts'
import { loadHostState, saveHostState } from './host.ts'

/**
 * Reader state persistence.
 *
 * Primary store: the host half (storage-domain under $DSH_HOME/storages),
 * which survives DSH Desktop restarts regardless of the per-launch loopback
 * port. Browser localStorage remains a synchronous cache/fallback: reads
 * hydrate instantly from it, then reconcile with the host; writes go to both
 * so the UI stays responsive even when the host is unreachable.
 */

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = globalThis.localStorage?.getItem(key)
    return value === null || value === undefined ? fallback : JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or quota failure: reading remains usable for this session.
  }
}

export function loadSettings(): ReaderSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<ReaderSettings>>(STORAGE_KEYS.settings, {}) }
}

export function saveSettings(value: ReaderSettings): void {
  writeJson(STORAGE_KEYS.settings, value)
}

export function loadPanel(): PanelPreferences {
  return { ...DEFAULT_PANEL, ...readJson<Partial<PanelPreferences>>(STORAGE_KEYS.panel, {}) }
}

export function savePanel(value: PanelPreferences): void {
  writeJson(STORAGE_KEYS.panel, value)
}

export function loadProgress(): Record<string, ReadingPosition> {
  return readJson<Record<string, ReadingPosition>>(STORAGE_KEYS.progress, {})
}

export function saveProgress(value: Record<string, ReadingPosition>): void {
  writeJson(STORAGE_KEYS.progress, value)
}

export function loadBookmarks(): Bookmark[] {
  return readJson<Bookmark[]>(STORAGE_KEYS.bookmarks, [])
}

export function saveBookmarks(value: Bookmark[]): void {
  writeJson(STORAGE_KEYS.bookmarks, value)
}

export function loadRecents(): RecentBook[] {
  return readJson<RecentBook[]>(STORAGE_KEYS.recents, [])
}

export function saveRecents(value: RecentBook[]): void {
  writeJson(STORAGE_KEYS.recents, value.slice(0, 10))
}

// ---------------------------------------------------------------------------
// Host reconciliation: hydrate browser caches from the host once, then push
// every local change to the host (debounced by the caller).
// ---------------------------------------------------------------------------

/** True when the host state carries no user data at all (fresh install). */
function isEmptyHostState(state: NonNullable<Awaited<ReturnType<typeof loadHostState>>>): boolean {
  const settingsEmpty = state.settings === undefined || Object.keys(state.settings).length === 0
  const panelEmpty = state.panel === undefined || Object.keys(state.panel).length === 0
  const progressEmpty = state.progress === undefined || Object.keys(state.progress).length === 0
  const bookmarksEmpty = state.bookmarks === undefined || state.bookmarks.length === 0
  const recentsEmpty = state.recents === undefined || state.recents.length === 0
  return settingsEmpty && panelEmpty && progressEmpty && bookmarksEmpty && recentsEmpty
}

/** Load the host state and merge it over the browser caches. Never throws. */
export async function hydrateFromHost(): Promise<boolean> {
  const state = await loadHostState()
  if (state === null) return false
  // Fresh host: keep whatever the browser already has (first-run migration);
  // the debounced sync will push it to the host.
  if (isEmptyHostState(state)) return true
  if (state.settings) writeJson(STORAGE_KEYS.settings, state.settings)
  if (state.panel) writeJson(STORAGE_KEYS.panel, state.panel)
  if (state.progress) writeJson(STORAGE_KEYS.progress, state.progress)
  if (state.bookmarks) writeJson(STORAGE_KEYS.bookmarks, state.bookmarks)
  if (state.recents) writeJson(STORAGE_KEYS.recents, state.recents)
  return true
}

/** Push the current browser caches to the host. Never throws. */
export async function syncToHost(): Promise<void> {
  await saveHostState({
    settings: loadSettings(),
    panel: loadPanel(),
    progress: loadProgress(),
    bookmarks: loadBookmarks(),
    recents: loadRecents(),
  })
}
