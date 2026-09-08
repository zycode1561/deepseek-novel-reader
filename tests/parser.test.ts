import { describe, expect, it } from 'vitest'
import { matchChapterHeading, parseBookText } from '../src/shared/parser.ts'

describe('matchChapterHeading', () => {
  it.each([
    '第一章 初见', '第12回', 'Chapter 8 The Road', '1. 开始', '001 开始', '## 第二幕',
  ])('recognizes %s', (line) => {
    expect(matchChapterHeading(line)).not.toBeNull()
  })

  it('does not treat long prose as a chapter', () => {
    expect(matchChapterHeading('1 这是一段超过标题常见长度的正文，它带有数字但不应该被错误识别成章节标题，因为内容很长。')).toBeNull()
  })
})

describe('parseBookText', () => {
  it('creates a preface and stable paragraph ranges', () => {
    const result = parseBookText('书名\n作者\n\n第一章 相逢\n第一段。\n第二段。\n\n第二章 远行\n第三段。')
    expect(result.chapters.map(chapter => chapter.title)).toEqual(['序章', '第一章 相逢', '第二章 远行'])
    expect(result.paragraphs).toHaveLength(7)
    expect(result.chapters[1]?.paragraphStart).toBe(2)
    expect(result.chapters[2]?.paragraphEnd).toBe(6)
  })

  it('creates a single body chapter when no heading exists', () => {
    const result = parseBookText('第一段。\n\n第二段。')
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0]?.title).toBe('正文')
  })
})
