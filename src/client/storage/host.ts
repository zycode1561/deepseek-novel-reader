import type { Book, ReaderState } from '../../shared/types.ts'

/**
 * Client half of the dsh-novel-reader host bridge. The reader state lives
 * durably on the host (storage-domain, under $DSH_HOME/storages) so it
 * survives DSH Desktop restarts even though the loopback origin changes.
 * Every call degrades gracefully: when the host routes are unreachable
 * (plain browser embedding, old host), callers fall back to browser storage.
 */

const STATE_PATH = '/dsh-novel-reader/state'
const BOOKS_PATH = '/dsh-novel-reader/books/'

/** Fetch wrapper: same-origin relative paths; never throws. */
async function request(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(path, { cache: 'no-store', ...init })
  } catch {
    return null
  }
}

/** Load the complete reader state from the host, or `null` when unavailable. */
export async function loadHostState(): Promise<ReaderState | null> {
  const response = await request(STATE_PATH)
  if (response === null || !response.ok) return null
  try {
    return await response.json() as ReaderState
  } catch {
    return null
  }
}

/** Persist the complete reader state on the host. Resolves even on failure. */
export async function saveHostState(state: ReaderState): Promise<void> {
  const response = await request(STATE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(state),
  })
  // Failure is deliberately silent: browser storage remains the fallback.
  void response
}

/** Load one book body from the host, or `null` when unavailable. */
export async function loadHostBook(id: string): Promise<Book | null> {
  const response = await request(`${BOOKS_PATH}${encodeURIComponent(id)}`)
  if (response === null || !response.ok) return null
  try {
    return await response.json() as Book
  } catch {
    return null
  }
}

/** Persist one book body on the host. Resolves even on failure. */
export async function saveHostBook(book: Book): Promise<void> {
  const response = await request(`${BOOKS_PATH}${encodeURIComponent(book.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(book),
  })
  // A non-ok response (route missing, oversized body) means the host copy was
  // NOT written; the caller's IndexedDB cache remains the fallback.
  if (response !== null && !response.ok) {
    console.warn(`[dsh-novel-reader] host book save failed: ${response.status}`)
  }
}

/** Remove one book body from the host. Resolves even on failure. */
export async function deleteHostBook(id: string): Promise<void> {
  const response = await request(`${BOOKS_PATH}${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (response !== null && !response.ok) {
    console.warn(`[dsh-novel-reader] host book delete failed: ${response.status}`)
  }
}
