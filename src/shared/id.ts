/** Small deterministic hash used only as a local storage key, not for security. */
export function hashText(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function createBookId(file: Pick<File, 'name' | 'size' | 'lastModified'>, head: string): string {
  return `book-${hashText(`${file.name}:${file.size}:${file.lastModified}:${head.slice(0, 2048)}`)}`
}

export function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
