import { describe, expect, it } from 'vitest'
import { decodeNovelBuffer } from '../src/shared/encoding.ts'

describe('decodeNovelBuffer', () => {
  it('decodes UTF-8 with BOM', () => {
    const content = new TextEncoder().encode('中文测试')
    const bytes = new Uint8Array(content.length + 3)
    bytes.set([0xef, 0xbb, 0xbf])
    bytes.set(content, 3)
    const result = decodeNovelBuffer(bytes.buffer)
    expect(result.encoding).toBe('utf-8-bom')
    expect(result.text).toBe('中文测试')
  })

  it('falls back to GB18030 for GBK bytes', () => {
    // “中文” in GBK: D6 D0 CE C4
    const result = decodeNovelBuffer(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer)
    expect(result.encoding).toBe('gb18030')
    expect(result.text).toBe('中文')
  })
})
