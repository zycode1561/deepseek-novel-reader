// The client bundle is emitted as CJS, so pin the browser export explicitly;
// otherwise conditional resolution can select fflate's worker_threads build.
import { unzip, unzipSync, type UnzipFileInfo, type Unzipped } from 'fflate/browser'
import type { Chapter, Paragraph, ParsedBook } from './types.ts'

const MAX_ARCHIVE_ENTRIES = 4_096
const MAX_RELEVANT_UNCOMPRESSED_BYTES = 96 * 1024 * 1024
const MAX_EXTRACTED_TEXT_BYTES = 50 * 1024 * 1024

const CONTENT_MEDIA_TYPES = new Set([
  'application/xhtml+xml',
  'text/html',
])

const BLOCK_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'blockquote', 'pre', 'li', 'dt', 'dd',
])

const IGNORED_TAGS = new Set([
  'head', 'script', 'style', 'noscript', 'template', 'svg',
  'audio', 'video', 'object', 'embed', 'canvas', 'nav',
])

export type EpubParseErrorCode =
  | 'INVALID_EPUB'
  | 'ENCRYPTED_EPUB'
  | 'EMPTY_EPUB'
  | 'EPUB_TOO_LARGE'

export class EpubParseError extends Error {
  constructor(message: string, public readonly code: EpubParseErrorCode) {
    super(message)
    this.name = 'EpubParseError'
  }
}

export interface ParsedEpub {
  title: string | null
  parsed: ParsedBook
  warnings: string[]
}

interface ManifestItem {
  id: string
  path: string
  mediaType: string
  properties: Set<string>
}

interface NavigationEntry {
  title: string
  level: number
  path: string
  fragment: string | null
}

interface ContentBlock {
  text: string
  headingLevel: number | null
  ids: string[]
}

interface ContentDocument {
  path: string
  title: string | null
  blocks: ContentBlock[]
  idToBlock: Map<string, number>
  globalStart: number
}

interface ChapterBoundary {
  blockIndex: number
  title: string
  level: number
  source: 'navigation' | 'fallback'
}

interface ReferenceTarget {
  path: string
  fragment: string | null
}

function elementName(element: Element): string {
  return (element.localName || element.tagName.split(':').at(-1) || '').toLocaleLowerCase()
}

function childElements(node: Node): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1)
}

function allElements(root: Node, wanted?: string): Element[] {
  const result: Element[] = []
  const stack = [...childElements(root)].reverse()
  while (stack.length > 0) {
    const element = stack.pop()!
    if (wanted === undefined || elementName(element) === wanted) result.push(element)
    const children = childElements(element)
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!)
  }
  return result
}

function firstElement(root: Node, wanted: string): Element | null {
  return allElements(root, wanted)[0] ?? null
}

function directChild(root: Node, wanted: string): Element | null {
  return childElements(root).find(element => elementName(element) === wanted) ?? null
}

function directChildren(root: Node, wanted: string): Element[] {
  return childElements(root).filter(element => elementName(element) === wanted)
}

function normalizeInlineText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/gu, ' ').trim()
}

function textFromNode(root: Node): string {
  const chunks: string[] = []
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.nodeType === 3 || node.nodeType === 4) {
      chunks.push(node.nodeValue ?? '')
      continue
    }
    if (node.nodeType !== 1 && node !== root) continue
    if (node.nodeType === 1) {
      const name = elementName(node as Element)
      if (IGNORED_TAGS.has(name)) continue
      if (name === 'br') chunks.push('\n')
    }
    const children = Array.from(node.childNodes)
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!)
  }
  return normalizeInlineText(chunks.join(''))
}

function textFromBlock(root: Element): string {
  const preserveLines = elementName(root) === 'pre'
  const chunks: string[] = []
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.nodeType === 3 || node.nodeType === 4) {
      chunks.push(node.nodeValue ?? '')
      continue
    }
    if (node.nodeType !== 1 && node !== root) continue
    if (node.nodeType === 1) {
      const element = node as Element
      const name = elementName(element)
      if (IGNORED_TAGS.has(name)) continue
      if (element !== root && BLOCK_TAGS.has(name)) continue
      if (name === 'br') chunks.push('\n')
    }
    const children = Array.from(node.childNodes)
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!)
  }
  const joined = chunks.join('').replace(/\u00a0/g, ' ')
  if (!preserveLines) return joined.replace(/\s+/gu, ' ').trim()
  return joined.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim()
}

function parseMarkup(text: string, mimeType: DOMParserSupportedType, label: string): Document {
  const document = new DOMParser().parseFromString(text, mimeType)
  const parserError = allElements(document, 'parsererror')[0]
  if (document.documentElement === null || parserError !== undefined) {
    throw new EpubParseError(`${label} 不是有效的 XML/XHTML。`, 'INVALID_EPUB')
  }
  return document
}

function decodeMarkup(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) {
    return new TextDecoder('utf-16be').decode(bytes)
  }
  if (bytes.length >= 4 && bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) {
    return new TextDecoder('utf-16le').decode(bytes)
  }

  const prefixBytes = bytes.subarray(0, Math.min(bytes.length, 1_024))
  const prefix = String.fromCharCode(...prefixBytes)
  const declared = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/iu.exec(prefix)?.[1]
  if (declared !== undefined) {
    try {
      return new TextDecoder(declared).decode(bytes)
    } catch {
      // Invalid or unsupported labels fall through to the EPUB default, UTF-8.
    }
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function normalizeArchivePath(rawPath: string): string | null {
  if (rawPath.includes('\0') || rawPath.includes('\\') || rawPath.startsWith('/') || /^[a-z]:/iu.test(rawPath)) return null
  const segments: string[] = []
  for (const segment of rawPath.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    segments.push(segment)
  }
  return segments.join('/')
}

function normalizeResolvedPath(rawPath: string): string | null {
  if (rawPath.includes('\0') || rawPath.includes('\\') || rawPath.startsWith('/') || /^[a-z]:/iu.test(rawPath)) return null
  const segments: string[] = []
  for (const segment of rawPath.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

function decodeReferencePath(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function resolveReference(basePath: string, rawReference: string): ReferenceTarget | null {
  const trimmed = rawReference.trim()
  if (trimmed.length === 0 || trimmed.startsWith('//') || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return null
  const hashIndex = trimmed.indexOf('#')
  const beforeHash = hashIndex < 0 ? trimmed : trimmed.slice(0, hashIndex)
  const rawFragment = hashIndex < 0 ? null : trimmed.slice(hashIndex + 1)
  const queryIndex = beforeHash.indexOf('?')
  const pathPart = queryIndex < 0 ? beforeHash : beforeHash.slice(0, queryIndex)
  const decodedPath = decodeReferencePath(pathPart)
  const decodedFragment = rawFragment === null ? null : decodeReferencePath(rawFragment)
  if (decodedPath === null || (rawFragment !== null && decodedFragment === null)) return null

  const baseDirectory = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : ''
  const path = normalizeResolvedPath(pathPart === '' ? basePath : `${baseDirectory}${decodedPath}`)
  if (path === null || path.length === 0) return null
  return { path, fragment: decodedFragment === null || decodedFragment.length === 0 ? null : decodedFragment }
}

function relevantArchiveEntry(info: UnzipFileInfo): boolean {
  const path = normalizeArchivePath(info.name)
  if (path === null) return false
  const lower = path.toLocaleLowerCase()
  return lower === 'mimetype'
    || lower === 'meta-inf/container.xml'
    || lower === 'meta-inf/encryption.xml'
    || /\.(?:opf|ncx|xml|xhtml|html|htm)$/iu.test(lower)
}

interface ArchiveFilterState {
  entryCount: number
  relevantBytes: number
  unsafePath: boolean
  tooLarge: boolean
}

function createArchiveFilter(): { state: ArchiveFilterState; filter(info: UnzipFileInfo): boolean } {
  const state: ArchiveFilterState = { entryCount: 0, relevantBytes: 0, unsafePath: false, tooLarge: false }
  return {
    state,
    filter(info) {
      state.entryCount += 1
      if (state.entryCount > MAX_ARCHIVE_ENTRIES) state.tooLarge = true
      if (normalizeArchivePath(info.name) === null) state.unsafePath = true
      if (!relevantArchiveEntry(info)) return false
      state.relevantBytes += info.originalSize
      if (state.relevantBytes > MAX_RELEVANT_UNCOMPRESSED_BYTES) state.tooLarge = true
      return !state.tooLarge && !state.unsafePath
    },
  }
}

function validateArchiveLimits(state: ArchiveFilterState): void {
  if (state.unsafePath) throw new EpubParseError('EPUB 包含不安全的内部路径。', 'INVALID_EPUB')
  if (state.tooLarge) {
    throw new EpubParseError('EPUB 解压后的正文资源过大或文件数量过多。', 'EPUB_TOO_LARGE')
  }
}

function unzipSynchronously(bytes: Uint8Array): Unzipped {
  const { state, filter } = createArchiveFilter()
  const archive = unzipSync(bytes, { filter })
  validateArchiveLimits(state)
  return archive
}

function unzipArchive(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    const { state, filter } = createArchiveFilter()
    try {
      unzip(bytes, { filter }, (error, archive) => {
        if (error !== null) {
          reject(error)
          return
        }
        try {
          validateArchiveLimits(state)
          resolve(archive)
        } catch (caught) {
          reject(caught)
        }
      })
    } catch {
      try {
        resolve(unzipSynchronously(bytes))
      } catch (caught) {
        reject(caught)
      }
    }
  })
}

function indexArchive(archive: Unzipped): Map<string, Uint8Array> {
  const indexed = new Map<string, Uint8Array>()
  for (const [rawPath, bytes] of Object.entries(archive)) {
    const path = normalizeArchivePath(rawPath)
    if (path === null || path.length === 0 || indexed.has(path)) {
      throw new EpubParseError('EPUB 包含冲突或不安全的内部路径。', 'INVALID_EPUB')
    }
    indexed.set(path, bytes)
  }
  return indexed
}

function requireArchiveEntry(archive: Map<string, Uint8Array>, path: string, label: string): Uint8Array {
  const bytes = archive.get(path)
  if (bytes === undefined) throw new EpubParseError(`EPUB 缺少 ${label}（${path}）。`, 'INVALID_EPUB')
  return bytes
}

function findPackagePath(archive: Map<string, Uint8Array>): string {
  const containerBytes = requireArchiveEntry(archive, 'META-INF/container.xml', 'container.xml')
  const container = parseMarkup(decodeMarkup(containerBytes), 'application/xml', 'container.xml')
  const rootfiles = allElements(container, 'rootfile')
  const selected = rootfiles.find(element => element.getAttribute('media-type') === 'application/oebps-package+xml')
    ?? rootfiles[0]
  const fullPath = selected?.getAttribute('full-path')
  const path = fullPath === null || fullPath === undefined ? null : normalizeArchivePath(fullPath)
  if (path === null || path.length === 0) {
    throw new EpubParseError('container.xml 未声明有效的 OPF package 路径。', 'INVALID_EPUB')
  }
  return path
}

function itemProperties(element: Element): Set<string> {
  return new Set((element.getAttribute('properties') ?? '').split(/\s+/u).filter(Boolean))
}

function parsePackage(packageDocument: Document, packagePath: string): {
  title: string | null
  manifest: Map<string, ManifestItem>
  spine: ManifestItem[]
  navItem: ManifestItem | null
  ncxItem: ManifestItem | null
  warnings: string[]
} {
  const warnings: string[] = []
  const metadata = firstElement(packageDocument, 'metadata')
  const titleElement = metadata === null ? null : firstElement(metadata, 'title')
  const title = titleElement === null ? null : normalizeInlineText(textFromNode(titleElement)) || null
  const manifestElement = firstElement(packageDocument, 'manifest')
  const spineElement = firstElement(packageDocument, 'spine')
  if (manifestElement === null || spineElement === null) {
    throw new EpubParseError('OPF 缺少 manifest 或 spine。', 'INVALID_EPUB')
  }

  const manifest = new Map<string, ManifestItem>()
  for (const element of directChildren(manifestElement, 'item')) {
    const id = element.getAttribute('id')?.trim()
    const href = element.getAttribute('href')
    const mediaType = element.getAttribute('media-type')?.trim().toLocaleLowerCase()
    if (id === undefined || id.length === 0 || href === null || mediaType === undefined || mediaType.length === 0) continue
    const target = resolveReference(packagePath, href)
    if (target === null) {
      warnings.push(`已忽略无效或外部 manifest 资源：${href}`)
      continue
    }
    manifest.set(id, { id, path: target.path, mediaType, properties: itemProperties(element) })
  }

  const spine: ManifestItem[] = []
  for (const itemref of directChildren(spineElement, 'itemref')) {
    if ((itemref.getAttribute('linear') ?? 'yes').toLocaleLowerCase() === 'no') continue
    const idref = itemref.getAttribute('idref')
    const item = idref === null ? undefined : manifest.get(idref)
    if (item === undefined) {
      warnings.push(`spine 引用了缺失的 manifest 项：${idref ?? '(empty)'}`)
      continue
    }
    if (!CONTENT_MEDIA_TYPES.has(item.mediaType)) {
      warnings.push(`已忽略不支持的 spine 资源：${item.path}`)
      continue
    }
    spine.push(item)
  }
  if (spine.length === 0) throw new EpubParseError('EPUB 没有可读取的主正文 spine。', 'INVALID_EPUB')

  const navItem = [...manifest.values()].find(item => item.properties.has('nav')) ?? null
  const tocId = spineElement.getAttribute('toc')
  const ncxItem = (tocId === null ? undefined : manifest.get(tocId))
    ?? [...manifest.values()].find(item => item.mediaType === 'application/x-dtbncx+xml')
    ?? null
  return { title, manifest, spine, navItem, ncxItem, warnings }
}

function epubType(element: Element): string {
  const direct = element.getAttribute('epub:type') ?? element.getAttribute('type')
  if (direct !== null) return direct
  for (const attribute of Array.from(element.attributes)) {
    if ((attribute.localName || attribute.name.split(':').at(-1)) === 'type') return attribute.value
  }
  return ''
}

function parseNavigationDocument(document: Document, navPath: string): NavigationEntry[] {
  const toc = allElements(document, 'nav').find(element => epubType(element).split(/\s+/u).includes('toc'))
  if (toc === undefined) return []
  const entries: NavigationEntry[] = []
  for (const anchor of allElements(toc, 'a')) {
    const href = anchor.getAttribute('href')
    const title = normalizeInlineText(textFromNode(anchor))
    if (href === null || title.length === 0) continue
    const target = resolveReference(navPath, href)
    if (target === null) continue
    let level = 0
    let parent = anchor.parentElement
    while (parent !== null && parent !== toc) {
      if (elementName(parent) === 'ol') level += 1
      parent = parent.parentElement
    }
    entries.push({ title, level: Math.max(1, level), ...target })
  }
  return entries
}

function parseNcxDocument(document: Document, ncxPath: string): NavigationEntry[] {
  const navMap = firstElement(document, 'navmap')
  if (navMap === null) return []
  const entries: NavigationEntry[] = []
  const roots = directChildren(navMap, 'navpoint')
  const stack = roots.map(element => ({ element, level: 1 })).reverse()
  while (stack.length > 0) {
    const { element, level } = stack.pop()!
    const label = directChild(element, 'navlabel')
    const content = directChild(element, 'content')
    const title = label === null ? '' : normalizeInlineText(textFromNode(label))
    const src = content?.getAttribute('src')
    const target = src === null || src === undefined ? null : resolveReference(ncxPath, src)
    if (title.length > 0 && target !== null) entries.push({ title, level, ...target })
    const children = directChildren(element, 'navpoint')
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ element: children[index]!, level: level + 1 })
    }
  }
  return entries
}

function parseEncryptedPaths(archive: Map<string, Uint8Array>, warnings: string[]): Set<string> {
  const bytes = archive.get('META-INF/encryption.xml')
  if (bytes === undefined) return new Set()
  try {
    const document = parseMarkup(decodeMarkup(bytes), 'application/xml', 'encryption.xml')
    const paths = new Set<string>()
    for (const reference of allElements(document, 'cipherreference')) {
      const uri = reference.getAttribute('URI') ?? reference.getAttribute('uri')
      if (uri === null) continue
      const rootTarget = resolveReference('', uri)
      const relativeTarget = resolveReference('META-INF/encryption.xml', uri)
      if (rootTarget !== null && archive.has(rootTarget.path)) paths.add(rootTarget.path)
      else if (relativeTarget !== null) paths.add(relativeTarget.path)
    }
    return paths
  } catch {
    warnings.push('encryption.xml 无法解析；若正文受 DRM 保护，导入将失败。')
    return new Set()
  }
}

function idsForBlock(element: Element): string[] {
  const ids = new Set<string>()
  let ancestor: Element | null = element
  while (ancestor !== null) {
    const id = ancestor.getAttribute('id')
    if (id !== null && id.length > 0) ids.add(id)
    ancestor = ancestor.parentElement
  }
  for (const descendant of allElements(element)) {
    const id = descendant.getAttribute('id')
    if (id !== null && id.length > 0) ids.add(id)
  }
  return [...ids]
}

function isInvisibleBlock(element: Element): boolean {
  let current: Element | null = element
  while (current !== null) {
    if (IGNORED_TAGS.has(elementName(current))
      || current.hasAttribute('hidden')
      || current.getAttribute('aria-hidden')?.toLocaleLowerCase() === 'true') return true
    const style = current.getAttribute('style')?.toLocaleLowerCase() ?? ''
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/u.test(style)) return true
    current = current.parentElement
  }
  return false
}

function parseContentDocument(bytes: Uint8Array, path: string): Omit<ContentDocument, 'globalStart'> {
  const document = parseMarkup(decodeMarkup(bytes), 'application/xhtml+xml', path)
  const blocks: ContentBlock[] = []
  const idToBlock = new Map<string, number>()
  for (const element of allElements(document)) {
    const name = elementName(element)
    if (!BLOCK_TAGS.has(name) || isInvisibleBlock(element)) continue
    const text = textFromBlock(element)
    if (text.length === 0) continue
    const headingLevel = /^h[1-6]$/u.test(name) ? Number(name.slice(1)) : null
    const ids = idsForBlock(element)
    const index = blocks.length
    blocks.push({ text, headingLevel, ids })
    for (const id of ids) if (!idToBlock.has(id)) idToBlock.set(id, index)
  }

  if (blocks.length === 0) {
    const body = firstElement(document, 'body') ?? document.documentElement
    const text = textFromNode(body)
    if (text.length > 0) blocks.push({ text, headingLevel: null, ids: [] })
  }

  const titleElement = firstElement(document, 'title')
  const documentTitle = titleElement === null ? null : normalizeInlineText(textFromNode(titleElement)) || null
  const headingTitle = blocks.find(block => block.headingLevel !== null)?.text ?? null
  return { path, title: headingTitle ?? documentTitle, blocks, idToBlock }
}

function fallbackTitle(document: ContentDocument, ordinal: number): string {
  if (document.title !== null && document.title.length > 0) return document.title
  const fileName = document.path.split('/').at(-1)?.replace(/\.[^.]+$/u, '') ?? ''
  return fileName.length > 0 ? fileName : `第 ${ordinal + 1} 章`
}

function assembleBook(documents: ContentDocument[], navigation: NavigationEntry[], warnings: string[]): ParsedBook {
  const blocks = documents.flatMap(document => document.blocks)
  if (blocks.length === 0) throw new EpubParseError('EPUB 中没有可读取的文字正文。', 'EMPTY_EPUB')

  const documentByPath = new Map(documents.map(document => [document.path, document]))
  const boundaries: ChapterBoundary[] = []
  for (const entry of navigation) {
    const document = documentByPath.get(entry.path)
    if (document === undefined || document.blocks.length === 0) {
      warnings.push(`目录目标不在主正文中，已忽略：${entry.path}`)
      continue
    }
    let localIndex = 0
    if (entry.fragment !== null) {
      const target = document.idToBlock.get(entry.fragment)
      if (target === undefined) {
        warnings.push(`目录锚点不存在，已定位到文档开头：${entry.path}#${entry.fragment}`)
      } else {
        localIndex = target
      }
    }
    boundaries.push({
      blockIndex: document.globalStart + localIndex,
      title: entry.title,
      level: Math.max(1, Math.min(6, entry.level)),
      source: 'navigation',
    })
  }

  if (boundaries.length === 0) {
    for (const [ordinal, document] of documents.entries()) {
      if (document.blocks.length === 0) continue
      const headings = document.blocks.flatMap((block, index) => block.headingLevel === null ? [] : [{ block, index }])
      if (headings.length === 0 || headings[0]!.index > 0) {
        boundaries.push({
          blockIndex: document.globalStart,
          title: fallbackTitle(document, ordinal),
          level: 1,
          source: 'fallback',
        })
      }
      for (const { block, index } of headings) {
        boundaries.push({
          blockIndex: document.globalStart + index,
          title: block.text,
          level: block.headingLevel ?? 1,
          source: 'fallback',
        })
      }
    }
  } else {
    for (const [ordinal, document] of documents.entries()) {
      if (document.blocks.length === 0) continue
      const hasBoundaryAtStart = boundaries.some(boundary => boundary.blockIndex === document.globalStart)
      if (!hasBoundaryAtStart) {
        boundaries.push({
          blockIndex: document.globalStart,
          title: fallbackTitle(document, ordinal),
          level: 1,
          source: 'fallback',
        })
      }
    }
  }

  boundaries.sort((left, right) => left.blockIndex - right.blockIndex
    || (left.source === 'navigation' ? -1 : 1))
  const uniqueBoundaries: ChapterBoundary[] = []
  for (const boundary of boundaries) {
    if (uniqueBoundaries.at(-1)?.blockIndex === boundary.blockIndex) continue
    uniqueBoundaries.push(boundary)
  }
  if (uniqueBoundaries[0]?.blockIndex !== 0) {
    uniqueBoundaries.unshift({ blockIndex: 0, title: '序章', level: 1, source: 'fallback' })
  }

  const chapterForBlock: number[] = []
  let boundaryIndex = 0
  for (let index = 0; index < blocks.length; index += 1) {
    while (boundaryIndex + 1 < uniqueBoundaries.length
      && uniqueBoundaries[boundaryIndex + 1]!.blockIndex <= index) boundaryIndex += 1
    chapterForBlock[index] = boundaryIndex
  }

  const hiddenHeadingBlocks = new Set(uniqueBoundaries.flatMap((boundary) => {
    const block = blocks[boundary.blockIndex]
    return block?.headingLevel === null || block === undefined ? [] : [boundary.blockIndex]
  }))
  const paragraphs: Paragraph[] = []
  const contentParts: string[] = []
  let contentLength = 0
  let encodedBytes = 0
  for (const [index, block] of blocks.entries()) {
    if (contentParts.length > 0) {
      contentParts.push('\n')
      contentLength += 1
      encodedBytes += 1
    }
    const start = contentLength
    contentParts.push(block.text)
    contentLength += block.text.length
    encodedBytes += new TextEncoder().encode(block.text).byteLength
    if (encodedBytes > MAX_EXTRACTED_TEXT_BYTES) {
      throw new EpubParseError('EPUB 提取后的纯文本超过 50MB。', 'EPUB_TOO_LARGE')
    }
    const chapterIndex = chapterForBlock[index] ?? 0
    paragraphs.push({
      id: `paragraph-${index}`,
      index,
      chapterId: `chapter-${chapterIndex}`,
      text: block.text,
      start,
      end: contentLength,
      isHeading: hiddenHeadingBlocks.has(index),
    })
  }
  const content = contentParts.join('')

  const chapters: Chapter[] = uniqueBoundaries.map((boundary, index) => {
    const nextBlock = uniqueBoundaries[index + 1]?.blockIndex ?? paragraphs.length
    const paragraphStart = Math.min(boundary.blockIndex, paragraphs.length - 1)
    const paragraphEnd = Math.max(paragraphStart, nextBlock - 1)
    return {
      id: `chapter-${index}`,
      index,
      title: boundary.title,
      level: boundary.level,
      start: paragraphs[paragraphStart]?.start ?? 0,
      end: nextBlock < paragraphs.length ? paragraphs[nextBlock]!.start : content.length,
      paragraphStart,
      paragraphEnd,
    }
  })
  return { content, chapters, paragraphs }
}

export async function parseEpubBuffer(buffer: ArrayBuffer): Promise<ParsedEpub> {
  let rawArchive: Unzipped
  try {
    rawArchive = await unzipArchive(new Uint8Array(buffer))
  } catch (error) {
    if (error instanceof EpubParseError) throw error
    throw new EpubParseError('文件不是有效的 EPUB ZIP 容器。', 'INVALID_EPUB')
  }
  const archive = indexArchive(rawArchive)
  const packagePath = findPackagePath(archive)
  const packageBytes = requireArchiveEntry(archive, packagePath, 'OPF package')
  const packageDocument = parseMarkup(decodeMarkup(packageBytes), 'application/xml', packagePath)
  const packageInfo = parsePackage(packageDocument, packagePath)
  const warnings = [...packageInfo.warnings]
  const encryptedPaths = parseEncryptedPaths(archive, warnings)
  const encryptedContent = packageInfo.spine.find(item => encryptedPaths.has(item.path))
  if (encryptedContent !== undefined) {
    throw new EpubParseError(`正文资源受 DRM 或加密保护：${encryptedContent.path}`, 'ENCRYPTED_EPUB')
  }

  let navigation: NavigationEntry[] = []
  if (packageInfo.navItem !== null) {
    const bytes = archive.get(packageInfo.navItem.path)
    if (bytes !== undefined) {
      try {
        navigation = parseNavigationDocument(
          parseMarkup(decodeMarkup(bytes), 'application/xhtml+xml', packageInfo.navItem.path),
          packageInfo.navItem.path,
        )
      } catch {
        warnings.push('EPUB 3 NAV 无法解析，已尝试其他目录或正文标题。')
      }
    }
  }
  if (navigation.length === 0 && packageInfo.ncxItem !== null) {
    const bytes = archive.get(packageInfo.ncxItem.path)
    if (bytes !== undefined) {
      try {
        navigation = parseNcxDocument(
          parseMarkup(decodeMarkup(bytes), 'application/xml', packageInfo.ncxItem.path),
          packageInfo.ncxItem.path,
        )
      } catch {
        warnings.push('EPUB 2 NCX 无法解析，已回退到正文标题。')
      }
    }
  }
  if (navigation.length === 0) warnings.push('未找到可用的 EPUB 目录，已按正文标题与 spine 顺序生成目录。')

  const documents: ContentDocument[] = []
  let globalStart = 0
  for (const item of packageInfo.spine) {
    const bytes = archive.get(item.path)
    if (bytes === undefined) {
      warnings.push(`正文资源缺失，已跳过：${item.path}`)
      continue
    }
    try {
      const document = parseContentDocument(bytes, item.path)
      if (document.blocks.length === 0) {
        warnings.push(`正文资源没有可读取文字，已跳过：${item.path}`)
        continue
      }
      documents.push({ ...document, globalStart })
      globalStart += document.blocks.length
    } catch {
      warnings.push(`正文资源无法解析，已跳过：${item.path}`)
    }
  }

  const parsed = assembleBook(documents, navigation, warnings)
  return { title: packageInfo.title, parsed, warnings }
}
