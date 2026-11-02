import {
  AlignmentType,
  BorderStyle,
  BookmarkEnd,
  BookmarkStart,
  bookmarkUniqueNumericIdGen,
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  SimpleField,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type IRunOptions
} from 'docx'
import hljs from 'highlight.js'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, extname } from 'node:path'
import {
  type ExportElementStyle,
  type ExportElementType,
  type ExportStyleTemplate
} from '../../shared/write-export-templates'
import {
  elementStyleToParagraphOptions,
  elementStyleToRunOptions,
  pageLayoutToSectionMargin,
  resolveExportTemplate
} from './write-docx-styles'
import { parseMarkdownFrontmatter } from './write-document-service'
import { readWriteImageResource } from './write-image-resource'
import { createWriteMarkdownIt } from '../../shared/write-advanced-markdown'
import { buildWriteMathOmml } from './write-math-omml'
import { writeMathImageTransformation } from './write-math-image-layout'
import { renderWriteMathImage, renderWriteMermaidDiagrams, type WriteRenderedDiagram } from './write-advanced-renderer'

type InlineToken = {
  type: string
  tag?: string
  content: string
  children?: InlineToken[]
  attrGet?: (name: string) => string | null
  meta?: { id?: number; subId?: number; label?: string; checked?: boolean } | null
}

type MarkdownToken = InlineToken & {
  nesting?: number
  map?: [number, number]
  markup?: string
  info?: string
}

type ImageInfo = {
  data: Buffer
  width: number
  height: number
  extension: 'png' | 'jpg' | 'gif' | 'bmp'
}

const MAX_IMAGE_DIMENSION = 100_000
const MAX_IMAGE_PIXELS = 100_000_000
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.mdx'])

function safeImageDimension(value: number): number | null {
  return Number.isInteger(value) && value > 0 && value <= MAX_IMAGE_DIMENSION ? value : null
}

function safeImageSize(data: Buffer): { width: number; height: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = safeImageDimension(data.readUInt32BE(16))
    const height = safeImageDimension(data.readUInt32BE(20))
    return width && height && width * height <= MAX_IMAGE_PIXELS ? { width, height } : null
  }

  if (data.length >= 10 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) {
    const width = safeImageDimension(data.readUInt16LE(6))
    const height = safeImageDimension(data.readUInt16LE(8))
    return width && height && width * height <= MAX_IMAGE_PIXELS ? { width, height } : null
  }

  if (data.length >= 26 && data.subarray(0, 2).toString('ascii') === 'BM') {
    const width = safeImageDimension(Math.abs(data.readInt32LE(18)))
    const height = safeImageDimension(Math.abs(data.readInt32LE(22)))
    return width && height && width * height <= MAX_IMAGE_PIXELS ? { width, height } : null
  }

  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 3 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (offset < data.length && data[offset] === 0xff) offset += 1
    if (offset >= data.length) break
    const marker = data[offset]
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 1 >= data.length) break
    const segmentLength = data.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > data.length) break
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      const height = safeImageDimension(data.readUInt16BE(offset + 3))
      const width = safeImageDimension(data.readUInt16BE(offset + 5))
      return width && height && width * height <= MAX_IMAGE_PIXELS ? { width, height } : null
    }
    offset += segmentLength
  }
  return null
}

type TableCellSpec = {
  header: boolean
  children: any[]
}

type InlineState = {
  bold: boolean
  italics: boolean
  strike: boolean
  underline: boolean
  link: { href: string; children: any[] } | null
}

type ListState = {
  type: 'bullet' | 'ordered'
  level: number
}

const md = createWriteMarkdownIt({
  html: true,
  linkify: true,
  breaks: false
})

const CODE_COLORS: Record<string, string> = {
  'hljs-keyword': 'D73A49',
  'hljs-built_in': '005CC5',
  'hljs-type': 'D73A49',
  'hljs-literal': '005CC5',
  'hljs-string': '032F62',
  'hljs-regexp': '032F62',
  'hljs-symbol': '005CC5',
  'hljs-comment': '6A737D',
  'hljs-title': '6F42C1',
  'hljs-function': '6F42C1',
  'hljs-attr': '22863A',
  'hljs-attribute': '22863A',
  'hljs-number': '005CC5',
  'hljs-meta': 'D73A49',
  'hljs-tag': '22863A',
  'hljs-name': '22863A',
  default: '24292E'
}

function isCjk(char: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)
}

type WriteDocxRenderContext = {
  template: ExportStyleTemplate
  inlineElementType: ExportElementType
  workspaceRoot?: string
  diagrams: Map<string, WriteRenderedDiagram | null>
  footnoteReferences: Set<number>
  nextBookmarkId: () => number
}

/**
 * 每次导出都有独立的异步上下文。这样多个窗口或任务并发导出不同模板时，
 * 深层的 Markdown/图片异步解析不会读到另一份模板。
 */
const writeDocxRenderContext = new AsyncLocalStorage<WriteDocxRenderContext>()

function templateStyle(elementType: ExportElementType): ExportElementStyle | undefined {
  return writeDocxRenderContext.getStore()?.template.styles[elementType]
}

function currentInlineElementType(): ExportElementType {
  return writeDocxRenderContext.getStore()?.inlineElementType ?? 'p'
}

/**
 * 构造一个 TextRun。若提供了 elementType 且模板上下文存在，
 * 字体/字号/颜色从模板读取；否则回退到 0.3.0 硬编码默认值。
 * options 中的同名字段会覆盖模板值（用于行内代码、链接等特殊着色）。
 */
function textRun(
  text: string,
  options: Partial<IRunOptions> = {},
  elementType?: ExportElementType
): TextRun {
  const style = elementType ? templateStyle(elementType) : undefined
  const templateRunOpts = style ? elementStyleToRunOptions(style) : undefined
  return new TextRun({
    text,
    font: templateRunOpts?.font ?? {
      ascii: 'Calibri',
      hAnsi: 'Calibri',
      eastAsia: 'Microsoft YaHei',
      hint: 'eastAsia'
    },
    size: templateRunOpts?.size ?? 22,
    color: templateRunOpts?.color ?? '111827',
    bold: templateRunOpts?.bold,
    italics: templateRunOpts?.italics,
    ...options
  })
}

/**
 * 构造一个 Paragraph。若提供了 elementType 且模板上下文存在，
 * spacing/alignment/indent 从模板读取；否则回退到 0.3.0 硬编码默认值。
 */
function paragraph(
  children: any[],
  options: Record<string, unknown> = {},
  elementType?: ExportElementType
): Paragraph {
  const style = elementType ? templateStyle(elementType) : undefined
  const templateParaOpts = style ? elementStyleToParagraphOptions(style) : undefined
  return new Paragraph({
    spacing: templateParaOpts?.spacing ?? { before: 80, after: 160, line: 360, lineRule: 'auto' },
    alignment: templateParaOpts?.alignment,
    indent: templateParaOpts?.indent,
    children: children.length > 0 ? children : [textRun('')],
    ...options
  })
}

async function loadImage(src: string, sourcePath: string): Promise<ImageInfo | null> {
  const resource = await readWriteImageResource({ src, sourcePath, workspaceRoot: writeDocxRenderContext.getStore()?.workspaceRoot })
  if (!resource) return null
  const extension = resource.extension
  if (!['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(extension)) return null

  try {
    const data = resource.data
    const size = safeImageSize(data)
    if (!size) return null
    const width = size.width
    const height = size.height
    return {
      data,
      width,
      height,
      extension: extension === 'jpeg' ? 'jpg' : (extension as ImageInfo['extension'])
    }
  } catch {
    return null
  }
}

function scaledImageSize(image: ImageInfo): { width: number; height: number } {
  const maxWidth = 560
  if (image.width <= maxWidth) return { width: image.width, height: image.height }
  const ratio = maxWidth / image.width
  return {
    width: maxWidth,
    height: Math.max(1, Math.round(image.height * ratio))
  }
}

function previousTextChar(tokens: InlineToken[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (token.type === 'text' || token.type === 'code_inline') {
      return token.content ? token.content[token.content.length - 1] : null
    }
    if (token.type === 'image' || token.type === 'hardbreak') return null
  }
  return null
}

function nextTextChar(tokens: InlineToken[], index: number): string | null {
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type === 'text' || token.type === 'code_inline') {
      return token.content ? token.content[0] : null
    }
    if (token.type === 'image' || token.type === 'hardbreak') return null
  }
  return null
}

async function parseInlineTokens(tokens: InlineToken[], sourcePath: string): Promise<any[]> {
  const output: any[] = []
  let buffer = ''
  const state: InlineState = {
    bold: false,
    italics: false,
    strike: false,
    underline: false,
    link: null
  }

  const push = (child: any): void => {
    if (state.link) {
      state.link.children.push(child)
    } else {
      output.push(child)
    }
  }

  const flush = (): void => {
    if (!buffer) return
    // 普通文本：用当前 inline 元素上下文（正文='p'，表格内='table'）读取字体/字号/颜色。
    // 注意：非链接时不传 color 字段（而非传 undefined），否则 ...options 展开时
    // undefined 会覆盖 textRun 里从模板读取的 color 值。
    push(textRun(buffer, {
      bold: state.bold,
      italics: state.italics,
      strike: state.strike,
      underline: state.underline
        ? { type: UnderlineType.SINGLE, color: '111827' }
        : state.link
          ? { type: UnderlineType.SINGLE, color: '0F62FE' }
          : undefined,
      // 链接强制蓝色；非链接不传 color，让模板颜色生效
      ...(state.link ? { color: '0F62FE' } : {})
    }, currentInlineElementType()))
    buffer = ''
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type === 'text') {
      buffer += token.content
    } else if (token.type === 'write_task_checkbox') {
      buffer += token.meta?.checked ? '☑ ' : '☐ '
    } else if (token.type === 'strong_open') {
      flush()
      state.bold = true
    } else if (token.type === 'strong_close') {
      flush()
      state.bold = false
    } else if (token.type === 'em_open') {
      flush()
      state.italics = true
    } else if (token.type === 'em_close') {
      flush()
      state.italics = false
    } else if (token.type === 's_open') {
      flush()
      state.strike = true
    } else if (token.type === 's_close') {
      flush()
      state.strike = false
    } else if (token.type === 'html_inline') {
      if (/<u\b/i.test(token.content)) {
        flush()
        state.underline = true
      }
      if (/<\/u>/i.test(token.content)) {
        flush()
        state.underline = false
      }
    } else if (token.type === 'code_inline') {
      flush()
      // 行内代码：从模板的 code 元素读取字体，保留灰底着色
      const codeStyle = templateStyle('code')
      const codeRunOpts = codeStyle ? elementStyleToRunOptions(codeStyle) : undefined
      push(textRun(token.content, {
        font: codeRunOpts?.font ?? {
          ascii: 'Consolas',
          hAnsi: 'Consolas',
          eastAsia: 'Microsoft YaHei',
          hint: 'eastAsia'
        },
        size: codeRunOpts?.size ?? 20,
        color: codeRunOpts?.color ?? '111827',
        shading: { type: ShadingType.CLEAR, fill: 'EEF2F7', color: 'auto' }
      }))
    } else if (token.type === 'math_inline') {
      flush()
      push(await buildMathRun(token.content, false))
    } else if (token.type === 'footnote_ref') {
      flush()
      const id = token.meta?.id
      if (Number.isInteger(id) && id! >= 0) {
        const noteId = id! + 1
        const bookmark = `RailWiseFootnote${noteId}`
        const seen = writeDocxRenderContext.getStore()!.footnoteReferences
        if (seen.has(noteId)) {
          // Some Word-compatible renderers renumber duplicated native note
          // references independently. A repeated Markdown citation points to
          // the original note through an explicit cross-reference instead.
          const reference = new SimpleField(`NOTEREF ${bookmark} \\h \\f`)
          reference.addChildElement(textRun(String(noteId), { style: 'FootnoteReference', superScript: true }))
          push(reference)
        } else {
          seen.add(noteId)
          const bookmarkId = writeDocxRenderContext.getStore()!.nextBookmarkId()
          push(new BookmarkStart(bookmark, bookmarkId))
          push(new FootnoteReferenceRun(noteId))
          push(new BookmarkEnd(bookmarkId))
        }
      }
    } else if (token.type === 'link_open') {
      flush()
      state.link = { href: token.attrGet?.('href') ?? '', children: [] }
    } else if (token.type === 'link_close') {
      flush()
      if (state.link) {
        const href = state.link.href.trim()
        if (/^(https?:|mailto:)/i.test(href)) {
          output.push(new ExternalHyperlink({ link: href, children: state.link.children }))
        } else {
          output.push(...state.link.children)
        }
        state.link = null
      }
    } else if (token.type === 'image') {
      flush()
      const src = token.attrGet?.('src') ?? ''
      const alt = token.content || basename(src) || 'Image'
      const image = await loadImage(src, sourcePath)
      if (image) {
        const transformation = scaledImageSize(image)
        push(
          new ImageRun({
            type: image.extension,
            data: image.data,
            transformation,
            altText: { title: alt, description: alt, name: alt }
          })
        )
      } else {
        push(textRun(`[Image: ${alt}]`, { italics: true, color: '9B1C1C' }))
      }
    } else if (token.type === 'softbreak') {
      const prev = previousTextChar(tokens, i)
      const next = nextTextChar(tokens, i)
      buffer += prev && next && isCjk(prev) && isCjk(next) ? '' : ' '
    } else if (token.type === 'hardbreak') {
      flush()
      push(new TextRun({ break: 1 }))
    } else if (token.children?.length) {
      flush()
      const nested = await parseInlineTokens(token.children, sourcePath)
      nested.forEach(push)
    }
  }

  flush()
  return output
}

function codeColor(className: string): string {
  for (const cls of className.split(/\s+/)) {
    if (CODE_COLORS[cls]) return CODE_COLORS[cls]
  }
  return CODE_COLORS.default
}

export function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
  // Decode one layer only: source code such as "&quot;" must remain literal.
  return value.replace(/&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return named[name]
    const point = Number.parseInt(hex ?? decimal ?? '', hex ? 16 : 10)
    // Reject invalid Unicode and XML text characters before constructing a run.
    const valid = point === 9 || point === 10 || point === 13
      || (point >= 0x20 && point <= 0xd7ff)
      || (point >= 0xe000 && point <= 0xfffd)
      || (point >= 0x10000 && point <= 0x10ffff)
    return Number.isSafeInteger(point) && valid ? String.fromCodePoint(point) : entity
  })
}

function highlightedCodeRuns(code: string, language: string): TextRun[] {
  let html = ''
  try {
    html = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language }).value
      : hljs.highlightAuto(code).value
  } catch {
    html = code.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  }

  // 代码块字体从模板 code 元素读取（颜色保留语法高亮色表，与模板正交）
  const codeStyle = templateStyle('code')
  const codeRunOpts = codeStyle ? elementStyleToRunOptions(codeStyle) : undefined
  const codeFont = codeRunOpts?.font ?? { ascii: 'Consolas', hAnsi: 'Consolas', eastAsia: 'Microsoft YaHei', hint: 'eastAsia' as const }
  const codeSize = codeRunOpts?.size ?? 19

  const runs: TextRun[] = []
  const colors: string[] = []
  const pattern = /<span class="([^"]+)">|<\/span>|([^<]+)/g
  for (const match of html.matchAll(pattern)) {
    if (match[1]) { colors.push(codeColor(match[1])); continue }
    if (match[0] === '</span>') { colors.pop(); continue }
    const color = colors.at(-1) ?? CODE_COLORS.default
    const text = decodeHtmlEntities(match[2] ?? '')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (line) {
        runs.push(textRun(line, {
          font: codeFont,
          size: codeSize,
          color,
          shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' }
        }))
      }
      if (index < lines.length - 1) {
        runs.push(new TextRun({ break: 1 }))
      }
    })
  }

  return runs.length > 0 ? runs : [textRun(code, { font: codeFont, size: codeSize })]
}

async function parseTable(tokens: MarkdownToken[], startIndex: number, sourcePath: string): Promise<{
  table: Table
  nextIndex: number
}> {
  const context = writeDocxRenderContext.getStore()
  if (!context) return parseTableInner(tokens, startIndex, sourcePath)
  return writeDocxRenderContext.run(
    { ...context, inlineElementType: 'table' },
    () => parseTableInner(tokens, startIndex, sourcePath)
  )
}

async function parseTableInner(tokens: MarkdownToken[], startIndex: number, sourcePath: string): Promise<{
  table: Table
  nextIndex: number
}> {
  const rows: TableRow[] = []
  const rowCells: TableCellSpec[][] = []
  let maxCellCount = 0
  let i = startIndex + 1
  let currentCells: TableCellSpec[] = []

  while (i < tokens.length && tokens[i].type !== 'table_close') {
    const token = tokens[i]
    if (token.type === 'tr_open') {
      currentCells = []
      i += 1
      continue
    }
    if (token.type === 'tr_close') {
      if (currentCells.length > 0) {
        rowCells.push(currentCells)
        maxCellCount = Math.max(maxCellCount, currentCells.length)
      }
      i += 1
      continue
    }
    if (token.type === 'th_open' || token.type === 'td_open') {
      const header = token.type === 'th_open'
      const closeType = header ? 'th_close' : 'td_close'
      let inlineToken: MarkdownToken | null = null
      let cursor = i + 1
      while (cursor < tokens.length && tokens[cursor].type !== closeType) {
        if (tokens[cursor].type === 'inline') inlineToken = tokens[cursor]
        cursor += 1
      }
      const cellChildren = inlineToken?.children
        ? await parseInlineTokens(inlineToken.children, sourcePath)
        : []
      currentCells.push({ header, children: cellChildren })
      i = cursor + 1
      continue
    }
    i += 1
  }

  const cellWidth = 100 / Math.max(1, maxCellCount)
  const tableStyle = templateStyle('table')
  const tableParagraphOptions = tableStyle
    ? elementStyleToParagraphOptions(tableStyle)
    : undefined
  rowCells.forEach((cells) => {
    rows.push(
      new TableRow({
        children: cells.map((cell) => (
          new TableCell({
            width: { size: cellWidth, type: WidthType.PERCENTAGE },
            shading: cell.header ? { type: ShadingType.CLEAR, fill: 'F3F6FA', color: 'auto' } : undefined,
            margins: { top: 90, bottom: 90, left: 120, right: 120 },
            children: [
              // 表格单元格：从模板 table 元素读取字体/字号/行距
              paragraph(cell.children, {
                alignment: cell.header
                  ? AlignmentType.CENTER
                  : (tableParagraphOptions?.alignment ?? AlignmentType.LEFT),
                spacing: tableParagraphOptions?.spacing ??
                  { before: 0, after: 0, line: 300, lineRule: 'auto' },
                indent: tableParagraphOptions?.indent
              }, 'table')
            ]
          })
        ))
      })
    )
  })

  return {
    table: new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
        left: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
        right: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' }
      }
    }),
    nextIndex: i + 1
  }
}

function headingLevel(tag = 'h1'): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  if (tag === 'h2') return HeadingLevel.HEADING_2
  if (tag === 'h3') return HeadingLevel.HEADING_3
  if (tag === 'h4') return HeadingLevel.HEADING_4
  if (tag === 'h5') return HeadingLevel.HEADING_5
  if (tag === 'h6') return HeadingLevel.HEADING_6
  return HeadingLevel.HEADING_1
}

/**
 * 把 heading tag 映射到模板元素类型。h4-h6 回退到 h3 的样式
 * （模板只配置 H1/H2/H3 三级标题样式）。
 */
function headingElementType(tag = 'h1'): ExportElementType {
  if (tag === 'h1') return 'h1'
  if (tag === 'h2') return 'h2'
  return 'h3'
}

function headingSize(tag = 'h1'): number {
  if (tag === 'h1') return 34
  if (tag === 'h2') return 29
  if (tag === 'h3') return 25
  return 22
}

function inlinePlainText(token: MarkdownToken | undefined): string {
  if (!token) return ''
  if (token.children?.length) {
    return token.children
      .map((child) => {
        if (child.type === 'image') return child.content || child.attrGet?.('alt') || ''
        if (child.children?.length) return child.children.map((nested) => nested.content).join('')
        return child.content
      })
      .join('')
  }
  return token.content
}

function preprocessMarkdown(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

async function buildMathRun(source: string, display: boolean): Promise<any> {
  const editable = buildWriteMathOmml(source, display)
  if (editable) return editable
  const image = await renderWriteMathImage(source, display)
  if (image) {
    const fontSizePt = templateStyle(display ? 'p' : currentInlineElementType())?.fontSize ?? 11
    return new ImageRun({ type: 'png', data: image.png, transformation: writeMathImageTransformation(image, fontSizePt, display), altText: { title: source, description: source, name: 'Mathematical formula' } })
  }
  return textRun(`[公式无法排版：${source}]`, { color: '9B1C1C' })
}

export async function buildDocxFromMarkdown(options: {
  sourcePath: string
  content: string
  title?: string
  workspaceRoot?: string
  /**
   * 导出模板。若提供，标题/正文/表格/代码块的字体、字号、颜色、行距、缩进、
   * 对齐和页边距均由模板驱动；缺省时回退到 0.3.0 硬编码默认值（向后兼容）。
   */
  template?: ExportStyleTemplate
}): Promise<Buffer> {
  return writeDocxRenderContext.run(
    {
      template: options.template ?? resolveExportTemplate(undefined),
      inlineElementType: 'p',
      workspaceRoot: options.workspaceRoot,
      diagrams: new Map(),
      footnoteReferences: new Set(),
      nextBookmarkId: bookmarkUniqueNumericIdGen()
    },
    () => buildDocxFromMarkdownInner(options)
  )
}

async function renderDocxBlocks(tokens: MarkdownToken[], sourcePath: string): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = []
  const listStack: ListState[] = []
  let blockquoteDepth = 0

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type === 'heading_open') {
      const inlineToken = tokens[i + 1]
      const headingType = headingElementType(token.tag)
      const headingStyle = templateStyle(headingType)
      const headingRunOpts = headingStyle ? elementStyleToRunOptions(headingStyle) : undefined
      const headingParaOpts = headingStyle ? elementStyleToParagraphOptions(headingStyle) : undefined
      const hasAdvancedInline = inlineToken.children?.some((child) => child.type === 'math_inline' || child.type === 'footnote_ref')
      const context = writeDocxRenderContext.getStore()
      const headingChildren = hasAdvancedInline && context
        ? await writeDocxRenderContext.run({ ...context, inlineElementType: headingType }, () => parseInlineTokens(inlineToken.children!, sourcePath))
        : [textRun(inlinePlainText(inlineToken), {
          size: headingRunOpts?.size ?? headingSize(token.tag),
          bold: headingRunOpts?.bold ?? true,
          color: headingRunOpts?.color ?? '0F172A',
          font: headingRunOpts?.font
        }, headingType)]
      children.push(
        paragraph(headingChildren, {
          heading: headingLevel(token.tag),
          spacing: headingParaOpts?.spacing ?? { before: token.tag === 'h1' ? 200 : 160, after: 120, line: 300, lineRule: 'auto' },
          alignment: headingParaOpts?.alignment,
          indent: headingParaOpts?.indent
        }, headingType)
      )
      i += 2
      continue
    }

    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      listStack.push({
        type: token.type === 'ordered_list_open' ? 'ordered' : 'bullet',
        level: Math.min(listStack.length, 8)
      })
      continue
    }
    if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      listStack.pop()
      continue
    }
    if (token.type === 'blockquote_open') {
      blockquoteDepth += 1
      continue
    }
    if (token.type === 'blockquote_close') {
      blockquoteDepth = Math.max(0, blockquoteDepth - 1)
      continue
    }

    if (token.type === 'paragraph_open') {
      const inlineToken = tokens[i + 1]
      const runs = inlineToken?.children
        ? await parseInlineTokens(inlineToken.children, sourcePath)
        : [textRun(inlineToken?.content ?? '', {}, 'p')]
      const currentList = listStack[listStack.length - 1]
      // 正文段落：字体/字号/颜色由模板 p 元素驱动（通过 paragraph 工厂的 elementType 参数）。
      // 列表项和引用块保留各自的紧凑 spacing / 缩进 / 边框，覆盖模板的段落属性。
      const paraStyle = templateStyle('p')
      const paraOpts = paraStyle ? elementStyleToParagraphOptions(paraStyle) : undefined
      const inListOrQuote = Boolean(currentList) || blockquoteDepth > 0
      children.push(
        paragraph(runs, {
          numbering: currentList
            ? {
                reference: currentList.type === 'ordered' ? 'workwise-ordered' : 'workwise-bullet',
                level: currentList.level
              }
            : undefined,
          indent: blockquoteDepth > 0
            ? { left: 360 * blockquoteDepth }
            : (inListOrQuote ? undefined : paraOpts?.indent),
          border:
            blockquoteDepth > 0
              ? { left: { style: BorderStyle.SINGLE, size: 8, color: 'C7D2FE', space: 8 } }
              : undefined,
          shading:
            blockquoteDepth > 0
              ? { type: ShadingType.CLEAR, fill: 'F8FAFC', color: 'auto' }
              : undefined,
          alignment: inListOrQuote ? undefined : paraOpts?.alignment,
          spacing: currentList
            ? { before: 0, after: 80, line: 330, lineRule: 'auto' }
            : (blockquoteDepth > 0
                ? { before: 60, after: 140, line: 360, lineRule: 'auto' }
                : (paraOpts?.spacing ?? { before: 60, after: 140, line: 360, lineRule: 'auto' }))
        }, 'p')
      )
      i += 2
      continue
    }

    if (token.type === 'fence' || token.type === 'code_block') {
      const language = ((token.info ?? '').trim().split(/\s+/)[0] ?? '').toLowerCase()
      if (language === 'math' || language === 'latex') {
        children.push(paragraph([await buildMathRun(token.content, true)], { alignment: AlignmentType.CENTER }, 'p'))
        continue
      }
      if (language === 'mermaid') {
        const diagram = writeDocxRenderContext.getStore()?.diagrams.get(token.content)
        if (diagram) {
          const scale = Math.min(1, 560 / diagram.width, 760 / diagram.height)
          children.push(paragraph([new ImageRun({ type: 'png', data: diagram.png, transformation: { width: Math.max(1, Math.round(diagram.width * scale)), height: Math.max(1, Math.round(diagram.height * scale)) }, altText: { title: 'Mermaid diagram', description: token.content, name: 'Mermaid diagram' } })], { alignment: AlignmentType.CENTER }, 'p'))
        } else {
          children.push(paragraph([textRun('Mermaid 图表未能绘制，保留原始代码。', { color: '9B1C1C' })], {}, 'p'))
          children.push(paragraph(highlightedCodeRuns(token.content.replace(/\n$/, ''), ''), {}, 'code'))
        }
        continue
      }
      // 代码块：字体由模板 code 元素驱动（在 highlightedCodeRuns 内部已处理），
      // 段落 spacing/indent 也从 code 元素读取，保留灰底和边框装饰。
      const codeParaStyle = templateStyle('code')
      const codeParaOpts = codeParaStyle ? elementStyleToParagraphOptions(codeParaStyle) : undefined
      children.push(
        paragraph(highlightedCodeRuns(token.content.replace(/\n$/, ''), language), {
          border: {
            top: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' },
            bottom: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' },
            left: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' },
            right: { style: BorderStyle.SINGLE, size: 2, color: 'E5E7EB' }
          },
          shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' },
          spacing: codeParaOpts?.spacing ?? { before: 140, after: 180, line: 280, lineRule: 'auto' },
          indent: codeParaOpts?.indent,
          alignment: codeParaOpts?.alignment
        }, 'code')
      )
      continue
    }

    if (token.type === 'table_open') {
      const result = await parseTable(tokens, i, sourcePath)
      children.push(result.table)
      i = result.nextIndex - 1
      continue
    }

    if (token.type === 'hr') {
      children.push(
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CBD5E1' } },
          spacing: { before: 180, after: 180 }
        })
      )
    }
    if (token.type === 'math_block') children.push(paragraph([await buildMathRun(token.content, true)], { alignment: AlignmentType.CENTER }, 'p'))
  }

  return children
}

async function buildDocxFromMarkdownInner(options: {
  sourcePath: string
  content: string
  title?: string
}): Promise<Buffer> {
  const parsed = parseMarkdownFrontmatter(options.content)
  const tokens = md.parse(preprocessMarkdown(DOCUMENT_EXTENSIONS.has(extname(options.sourcePath).toLowerCase()) && parsed.endOffset ? parsed.body : options.content), {}) as MarkdownToken[]
  const diagramSources = tokens.filter((token) => token.type === 'fence' && (token.info ?? '').trim().split(/\s+/)[0].toLowerCase() === 'mermaid').map((token) => token.content)
  const context = writeDocxRenderContext.getStore()!
  context.diagrams = await renderWriteMermaidDiagrams(diagramSources)
  const footnoteStart = tokens.findIndex((token) => token.type === 'footnote_block_open')
  const children = await renderDocxBlocks(footnoteStart === -1 ? tokens : tokens.slice(0, footnoteStart), options.sourcePath)
  const footnotes: Record<string, { children: Paragraph[] }> = {}
  if (footnoteStart !== -1) {
    for (let index = footnoteStart + 1; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token.type !== 'footnote_open' || !Number.isInteger(token.meta?.id)) continue
      const end = tokens.findIndex((candidate, cursor) => cursor > index && candidate.type === 'footnote_close')
      if (end === -1) break
      const body = tokens.slice(index + 1, end).filter((candidate) => candidate.type !== 'footnote_anchor')
      footnotes[String(token.meta!.id! + 1)] = { children: await renderDocxBlocks(body, options.sourcePath) as Paragraph[] }
      index = end
    }
  }

  const doc = new Document({
    creator: 'WorkWise',
    title: options.title || basename(options.sourcePath),
    features: { updateFields: true },
    footnotes,
    numbering: {
      config: [
        {
          reference: 'workwise-bullet',
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT },
            { level: 1, format: LevelFormat.BULLET, text: '\u25E6', alignment: AlignmentType.LEFT },
            { level: 2, format: LevelFormat.BULLET, text: '\u25AA', alignment: AlignmentType.LEFT }
          ]
        },
        {
          reference: 'workwise-ordered',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.LEFT },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.LEFT }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {
          page: {
            // 页边距从模板 pageLayout 读取（缺省 1440 twip = 1 inch，向后兼容）
            margin: pageLayoutToSectionMargin(
              (writeDocxRenderContext.getStore()?.template ?? resolveExportTemplate(undefined)).pageLayout
            )
          }
        },
        children: children.length > 0 ? children : [paragraph([textRun('', {}, 'p')], {}, 'p')]
      }
    ]
  })

  const archive = await JSZip.loadAsync(await Packer.toBuffer(doc))
  const notesPart = archive.file('word/footnotes.xml')
  if (notesPart) {
    const xml = new DOMParser().parseFromString(await notesPart.async('string'), 'application/xml')
    // docx 9.x prepends an automatic note mark to every footnote, including
    // its separator entries. Those special entries contain only separators,
    // not numbered content; remove the spurious marks without changing notes.
    for (const note of Array.from(xml.getElementsByTagName('w:footnote'))) {
      if (!['separator', 'continuationSeparator'].includes(note.getAttribute('w:type') ?? '')) continue
      for (const mark of Array.from(note.getElementsByTagName('w:footnoteRef'))) {
        const run = mark.parentNode
        if (run?.nodeName === 'w:r') run.parentNode?.removeChild(run)
      }
    }
    archive.file('word/footnotes.xml', new XMLSerializer().serializeToString(xml))
  }
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
