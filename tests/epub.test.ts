// @vitest-environment happy-dom

import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { EpubParseError, parseEpubBuffer } from '../src/shared/epub.ts'
import { loadBookFromFile } from '../src/shared/file.ts'

const encoder = new TextEncoder()

function archive(files: Record<string, string | Uint8Array>): ArrayBuffer {
  const entries = Object.fromEntries(Object.entries(files).map(([path, value]) => [
    path,
    typeof value === 'string' ? encoder.encode(value) : value,
  ]))
  const zipped = zipSync(entries)
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer
}

function container(packagePath = 'OPS/package.opf'): string {
  return `<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="${packagePath}" media-type="application/oebps-package+xml"/></rootfiles>
    </container>`
}

describe('parseEpubBuffer', () => {
  it('parses EPUB 3 NAV hierarchy, spine order, fragments, and visible text', async () => {
    const buffer = archive({
      mimetype: 'application/epub+zip',
      'META-INF/container.xml': container(),
      'OPS/package.opf': `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试 &amp; 故事</dc:title></metadata>
          <manifest>
            <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
            <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>
            <item id="aux" href="aux.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine><itemref idref="c1"/><itemref idref="aux" linear="no"/><itemref idref="c2"/></spine>
        </package>`,
      'OPS/nav.xhtml': `<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
          <nav epub:type="toc"><ol>
            <li><a href="c1.xhtml#one">第一章</a><ol><li><a href="c1.xhtml#two">第二节</a></li></ol></li>
            <li><a href="c2.xhtml">第二章</a></li>
          </ol></nav>
        </body></html>`,
      'OPS/c1.xhtml': `<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><head><title>文档一</title><style>secret style</style></head><body>
          <h1 id="one">第一章 原标题</h1><p>正文 &amp; 内容&#160;一。</p>
          <section id="two"><h2>第二节 原标题</h2><p>第二节正文。</p></section>
          <script>secret script</script><p hidden="hidden">隐藏内容</p>
        </body></html>`,
      'OPS/c2.xhtml': `<?xml version="1.0"?>
        <html xmlns="http://www.w3.org/1999/xhtml"><body>
          <h1>第二章 原标题</h1><ul><li>列表正文</li></ul><blockquote>引用正文</blockquote>
        </body></html>`,
      'OPS/aux.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>辅助内容不应进入主正文。</p></body></html>',
    })

    const result = await parseEpubBuffer(buffer)
    expect(result.title).toBe('测试 & 故事')
    expect(result.parsed.chapters.map(chapter => [chapter.title, chapter.level])).toEqual([
      ['第一章', 1], ['第二节', 2], ['第二章', 1],
    ])
    expect(result.parsed.paragraphs.map(paragraph => paragraph.text)).toEqual([
      '第一章 原标题', '正文 & 内容 一。', '第二节 原标题', '第二节正文。',
      '第二章 原标题', '列表正文', '引用正文',
    ])
    expect(result.parsed.content).not.toContain('secret')
    expect(result.parsed.content).not.toContain('隐藏内容')
    expect(result.parsed.content).not.toContain('辅助内容')
    expect(result.parsed.chapters[1]?.paragraphStart).toBe(2)
    expect(result.parsed.chapters[2]?.paragraphEnd).toBe(6)
  })

  it('falls back to an EPUB 2 NCX table of contents', async () => {
    const buffer = archive({
      'META-INF/container.xml': container(),
      'OPS/package.opf': `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>旧版小说</dc:title></metadata>
          <manifest>
            <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
            <item id="c1" href="one.xhtml" media-type="application/xhtml+xml"/>
            <item id="c2" href="two.xhtml" media-type="application/xhtml+xml"/>
          </manifest>
          <spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine>
        </package>`,
      'OPS/toc.ncx': `<?xml version="1.0"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
          <navPoint id="n1"><navLabel><text>旧版第一章</text></navLabel><content src="one.xhtml"/></navPoint>
          <navPoint id="n2"><navLabel><text>旧版第二章</text></navLabel><content src="two.xhtml"/></navPoint>
        </navMap></ncx>`,
      'OPS/one.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第一章正文。</p></body></html>',
      'OPS/two.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章正文。</p></body></html>',
    })
    const result = await parseEpubBuffer(buffer)
    expect(result.parsed.chapters.map(chapter => chapter.title)).toEqual(['旧版第一章', '旧版第二章'])
    expect(result.parsed.paragraphs.map(paragraph => paragraph.text)).toEqual(['第一章正文。', '第二章正文。'])
  })

  it('uses headings and normalized percent-encoded paths when navigation is absent', async () => {
    const buffer = archive({
      'META-INF/container.xml': container('EPUB/book.opf'),
      'EPUB/book.opf': `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata/><manifest><item id="c1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/></manifest>
          <spine><itemref idref="c1"/></spine>
        </package>`,
      'EPUB/Text/chapter 1.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>回退章节</h1><p>回退正文。</p></body></html>',
    })
    const result = await parseEpubBuffer(buffer)
    expect(result.title).toBeNull()
    expect(result.parsed.chapters.map(chapter => chapter.title)).toEqual(['回退章节'])
    expect(result.warnings.some(warning => warning.includes('未找到可用'))).toBe(true)
  })

  it('allows parent segments that remain inside the archive root', async () => {
    const buffer = archive({
      'META-INF/container.xml': container('EPUB/Package/book.opf'),
      'EPUB/Package/book.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata/><manifest><item id="c1" href="../Text/chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="c1"/></spine></package>`,
      'EPUB/Text/chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>安全父路径正文。</p></body></html>',
    })
    await expect(parseEpubBuffer(buffer)).resolves.toMatchObject({ parsed: { content: '安全父路径正文。' } })
  })

  it('rejects encrypted spine content without rejecting unrelated encrypted resources', async () => {
    const baseFiles = {
      'META-INF/container.xml': container(),
      'OPS/package.opf': `<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata/><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
          <spine><itemref idref="c1"/></spine>
        </package>`,
      'OPS/chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文。</p></body></html>',
      'OPS/font.otf': new Uint8Array([1, 2, 3]),
    }
    const encryptedBody = archive({
      ...baseFiles,
      'META-INF/encryption.xml': '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/chapter.xhtml"/></CipherData></EncryptedData></encryption>',
    })
    await expect(parseEpubBuffer(encryptedBody)).rejects.toMatchObject({ code: 'ENCRYPTED_EPUB' })

    const encryptedFont = archive({
      ...baseFiles,
      'META-INF/encryption.xml': '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/font.otf"/></CipherData></EncryptedData></encryption>',
    })
    await expect(parseEpubBuffer(encryptedFont)).resolves.toMatchObject({ parsed: { content: '正文。' } })
  })

  it.each([
    ['a corrupt ZIP', new Uint8Array([1, 2, 3]).buffer, 'INVALID_EPUB'],
    ['a missing container', archive({ 'OPS/package.opf': '<package/>' }), 'INVALID_EPUB'],
    ['an image-only book', archive({
      'META-INF/container.xml': container(),
      'OPS/package.opf': '<package><metadata/><manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>',
      'OPS/chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="cover.jpg"/></body></html>',
    }), 'EMPTY_EPUB'],
    ['an unsafe archive path', archive({
      'META-INF/container.xml': container(),
      '../OPS/package.opf': '<package/>',
    }), 'INVALID_EPUB'],
  ])('rejects %s', async (_label, buffer, code) => {
    await expect(parseEpubBuffer(buffer)).rejects.toMatchObject({ code })
  })

  it('loads EPUB through the existing file API and uses OPF metadata', async () => {
    const buffer = archive({
      'META-INF/container.xml': container(),
      'OPS/package.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>文件 API 书名</dc:title></metadata>
        <manifest><item id="c1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
        <spine><itemref idref="c1"/></spine></package>`,
      'OPS/chapter.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文。</p></body></html>',
    })
    const file = new File([buffer], 'fallback.epub', { type: 'application/epub+zip', lastModified: 123 })
    const result = await loadBookFromFile(file)
    expect(result.book).toMatchObject({ name: '文件 API 书名', format: 'epub', encoding: 'utf-8', content: '正文。' })
  })

  it('rejects archives with excessive entry counts before parsing content', async () => {
    const files: Record<string, string> = {
      'META-INF/container.xml': container(),
      'OPS/package.opf': '<package/>',
    }
    for (let index = 0; index < 4_096; index += 1) files[`junk/${index}.xml`] = ''
    await expect(parseEpubBuffer(archive(files))).rejects.toMatchObject({ code: 'EPUB_TOO_LARGE' })
  })

  it('exposes stable EPUB error codes', () => {
    expect(new EpubParseError('bad', 'INVALID_EPUB')).toMatchObject({ name: 'EpubParseError', code: 'INVALID_EPUB' })
  })
})
