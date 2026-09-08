import type { DecodedFile, FileEncoding } from './types.ts'

function decoder(label: string, fatal = false): TextDecoder {
  return new TextDecoder(label, { fatal })
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

function controlCharacterRatio(text: string): number {
  if (text.length === 0) return 0
  const controls = text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g)?.length ?? 0
  return controls / text.length
}

/**
 * Decode common Chinese novel encodings without sending file contents anywhere.
 * GB2312 and GBK are strict subsets of GB18030, so the browser's GB18030 decoder
 * is the safest common fallback and preserves all three formats.
 */
export function decodeNovelBuffer(buffer: ArrayBuffer): DecodedFile {
  const bytes = new Uint8Array(buffer)
  const warnings: string[] = []

  if (hasUtf8Bom(bytes)) {
    return {
      text: decoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'utf-8-bom',
      warnings,
    }
  }

  try {
    const text = decoder('utf-8', true).decode(bytes)
    if (controlCharacterRatio(text) < 0.01) {
      return { text, encoding: 'utf-8', warnings }
    }
    warnings.push('UTF-8 内容包含较多控制字符，已尝试中文编码回退。')
  } catch {
    // Invalid UTF-8 is expected for legacy GBK/GB2312 files.
  }

  try {
    const text = decoder('gb18030', true).decode(bytes)
    return {
      text,
      encoding: 'gb18030',
      warnings: [...warnings, '文件按 GB18030 解码（兼容 GBK/GB2312）。'],
    }
  } catch {
    const text = decoder('utf-8').decode(bytes)
    return {
      text,
      encoding: 'utf-8',
      warnings: [...warnings, '无法可靠识别编码，已使用 UTF-8 容错解码，个别字符可能显示为 �。'],
    }
  }
}

export function encodingLabel(encoding: FileEncoding): string {
  if (encoding === 'gb18030') return 'GB18030 / GBK / GB2312'
  if (encoding === 'utf-8-bom') return 'UTF-8 BOM'
  return 'UTF-8'
}
