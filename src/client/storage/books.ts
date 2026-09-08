import type { Book } from '../../shared/types.ts'
import { deleteHostBook, loadHostBook, saveHostBook } from './host.ts'

/**
 * Book body storage. The host half keeps book files under
 * $DSH_HOME/storages/novel-reader-books so large books survive Desktop
 * restarts (browser IndexedDB is per-launch-origin and would be lost).
 * IndexedDB stays as a fast local cache: reads try it first, then the host;
 * writes go to both.
 */

const DATABASE_NAME = 'dsh-novel-reader'
const DATABASE_VERSION = 1
const STORE_NAME = 'books'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE_NAME, mode)
    const request = run(tx.objectStore(STORE_NAME))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    tx.oncomplete = () => database.close()
    tx.onerror = () => {
      database.close()
      reject(tx.error ?? new Error('IndexedDB transaction failed'))
    }
  })
}

export async function saveBook(book: Book): Promise<IDBValidKey> {
  // Local cache first (fast), then the durable host copy.
  const key = await transaction('readwrite', store => store.put(book))
  void saveHostBook(book)
  return key
}

export async function getBook(id: string): Promise<Book | undefined> {
  // Fast local cache; fall back to the host when the per-launch origin is fresh.
  const local = await transaction<Book | undefined>('readonly', store => store.get(id))
  if (local !== undefined) return local
  const remote = await loadHostBook(id)
  if (remote === null) return undefined
  try {
    await transaction('readwrite', store => store.put(remote))
  } catch {
    // Cache write failure is harmless; the host copy remains authoritative.
  }
  return remote
}

export async function deleteBook(id: string): Promise<undefined> {
  await transaction<undefined>('readwrite', store => store.delete(id))
  void deleteHostBook(id)
  return undefined
}
