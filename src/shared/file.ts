import { LARGE_FILE_BYTES, MAX_FILE_BYTES } from './constants.ts'
import { decodeNovelBuffer } from './encoding.ts'
import { createBookId } from './id.ts'
import { parseBookText } from './parser.ts'
import type { Book, BookFormat } from './types.ts'

export class FileLoadError extends Error {
  constructor(
    message: string,
    public readonly code: 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'READ_FAILED',
  ) {
    super(message)
    this.name = 'FileLoadError'
  }
}

function formatFromName(name: string): BookFormat | null {
  const lower = name.toLocaleLowerCase()
  if (lower.endsWith('.txt')) return 'txt'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  return null
}

export interface LoadBookResult {
  book: Book
  warnings: string[]
}

export async function loadBookFromFile(file: File): Promise<LoadBookResult> {
  const format = formatFromName(file.name)
  if (format === null) {
    throw new FileLoadError('暂不支持此格式。请选择 .txt、.md 或 .markdown 文件。', 'UNSUPPORTED_FORMAT')
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new FileLoadError('文件超过 50MB。建议先按卷拆分，避免浏览器内存不足。', 'TOO_LARGE')
  }

  try {
    const decoded = decodeNovelBuffer(await file.arrayBuffer())
    const parsed = parseBookText(decoded.text)
    const id = createBookId(file, parsed.content)
    const largeFileMode = file.size > LARGE_FILE_BYTES
    return {
      book: {
        id,
        name: file.name.replace(/\.(txt|md|markdown)$/i, ''),
        format,
        encoding: decoded.encoding,
        size: file.size,
        lastModified: file.lastModified,
        ...parsed,
        openedAt: Date.now(),
        largeFileMode,
      },
      warnings: largeFileMode
        ? [...decoded.warnings, '文件超过 10MB：已启用按章节渲染模式，搜索结果最多显示 500 条。']
        : decoded.warnings,
    }
  } catch (error) {
    if (error instanceof FileLoadError) throw error
    throw new FileLoadError(error instanceof Error ? error.message : '文件读取失败。', 'READ_FAILED')
  }
}
