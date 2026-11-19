import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import JSZip from 'jszip'
import type { DocumentParseRequestV1, DocumentParseResultV1, DocumentParsingMode } from '../../shared/agent-workbench'
import { canonicalizeContainmentRoot, isCanonicalPathContained, resolveContainedPath } from './canonical-containment'
import { DocumentEngineService } from './document-engine-service'
import { inspectOfficeArchive } from './office-archive-security'
import { analyzePdfDocument, type PdfPageTextV1 } from './pdf-document-service'

const MAX_FILE_BYTES = 200 * 1024 * 1024
const MAX_TEXT_BYTES = 32 * 1024 * 1024
const PDF_FALLBACK_TIMEOUT_MS = 60_000

export type ChatAttachmentKind = 'image' | 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'markdown' | 'csv'
export type StagedChatAttachment = {
  importId: string
  originalFileName: string
  relativePath: string
  absolutePath: string
  kind: ChatAttachmentKind
  mimeType: string
  byteSize: number
  sha256: string
}

export type ParsedChatAttachment = StagedChatAttachment & {
  text?: string
  document?: DocumentParseResultV1
  pdfTextPages?: PdfPageTextV1[]
  state: 'ready' | 'degraded'
  warnings: string[]
  degradationReasons: string[]
  sourceStructure?: {
    pageCount?: number
    headings?: number
    tables?: number
    worksheets?: string[]
    slideCount?: number
  }
}

const FORMATS: Record<string, { kind: ChatAttachmentKind; mime: string }> = {
  '.pdf': { kind: 'pdf', mime: 'application/pdf' },
  '.docx': { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xlsx': { kind: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.pptx': { kind: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  '.txt': { kind: 'text', mime: 'text/plain' },
  '.md': { kind: 'markdown', mime: 'text/markdown' },
  '.markdown': { kind: 'markdown', mime: 'text/markdown' },
  '.csv': { kind: 'csv', mime: 'text/csv' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' }
}

export class ChatAttachmentImportService {
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly options: {
    managedRoot: string
    documentEngine?: DocumentEngineService
  }) {}

  async stage(input: { sourcePath: string; declaredMimeType?: string; importId?: string }): Promise<StagedChatAttachment> {
    const importId = input.importId?.trim() || randomUUID()
    if (this.active.has(importId)) throw new Error('attachment import is already active')
    const controller = new AbortController()
    this.active.set(importId, controller)
    const source = await canonicalSourceFile(input.sourcePath)
    const format = FORMATS[extname(source).toLowerCase()]
    if (!format) throw new Error('unsupported attachment format')
    if (input.declaredMimeType && !mimeCompatible(input.declaredMimeType, format.mime)) {
      throw new Error('declared MIME type does not match file extension')
    }
    const sourceStat = await stat(source)
    if (!sourceStat.isFile()) throw new Error('attachment source is not a regular file')
    if (sourceStat.size > MAX_FILE_BYTES) throw new Error('attachment exceeds 200 MiB limit')
    await mkdir(this.options.managedRoot, { recursive: true })
    const managedRoot = await canonicalizeContainmentRoot(this.options.managedRoot)
    const targetDirectory = await resolveContainedPath({ root: managedRoot, target: join('imports', importId), expect: 'directory' })
    await mkdir(targetDirectory, { recursive: true })
    const target = await resolveContainedPath({
      root: managedRoot,
      target: join('imports', importId, sanitizeFileName(basename(source))),
      expect: 'file', rejectFinalLink: true
    })
    const hash = createHash('sha256')
    let bytes = 0
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength
        if (bytes > MAX_FILE_BYTES) return callback(new Error('attachment exceeds 200 MiB limit'))
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    try {
      await pipeline(createReadStream(source), limiter, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: controller.signal })
      const content = await readFile(target)
      await verifyFormat(content, format.kind, format.mime)
      const targetReal = await realpath(target)
      if (!isCanonicalPathContained(managedRoot, targetReal)) throw new Error('managed attachment path escaped storage root')
      return {
        importId, originalFileName: basename(source), relativePath: relative(managedRoot, targetReal),
        absolutePath: targetReal, kind: format.kind, mimeType: format.mime,
        byteSize: bytes, sha256: hash.digest('hex')
      }
    } catch (error) {
      await rm(targetDirectory, { recursive: true, force: true })
      throw error
    } finally {
      this.active.delete(importId)
    }
  }

  async parse(staged: StagedChatAttachment, options: {
    mode?: DocumentParsingMode
    unlimitedOcrServerUrl?: string
  } = {}): Promise<ParsedChatAttachment> {
    if (staged.kind === 'image') return { ...staged, state: 'ready', warnings: [], degradationReasons: [] }
    if (['text', 'markdown', 'csv'].includes(staged.kind)) {
      const text = await readBoundedText(staged.absolutePath)
      if (!text.trim()) throw new Error('attachment contains no usable text')
      return { ...staged, text, state: 'ready', warnings: [], degradationReasons: [] }
    }
    if (this.active.has(staged.importId)) throw new Error('attachment import is already active')
    const controller = new AbortController()
    this.active.set(staged.importId, controller)
    try {
      const request = {
        parseId: staged.importId,
        workspaceRoot: await canonicalizeContainmentRoot(this.options.managedRoot),
        relativePath: staged.relativePath,
        mode: options.mode ?? 'auto',
        unlimitedOcrServerUrl: options.unlimitedOcrServerUrl,
        allowPrivateServerUpload: false,
        idempotencyKey: `attachment:${staged.sha256}`,
        signal: controller.signal
      }
      throwIfAttachmentParseCancelled(request.signal)
      const engine = this.options.documentEngine
      if (!engine && staged.kind !== 'pdf') throw new Error('local document engine is unavailable')
      const result = await engine?.parse(request).catch((error) => {
        if (staged.kind !== 'pdf' || request.signal.aborted || hasTerminalPdfError(error)) throw error
        return undefined
      })
      throwIfAttachmentParseCancelled(request.signal)
      if (result && hasParsedText(result.markdown)) return withDocument(staged, result)
      if (staged.kind !== 'pdf') throw new Error('attachment parser returned no usable text')
      return await this.parsePdfFallback(staged, request, result)
    } finally {
      this.active.delete(staged.importId)
    }
  }

  private async parsePdfFallback(staged: StagedChatAttachment, request: DocumentParseRequestV1 & {
    unlimitedOcrServerUrl?: string
    signal: AbortSignal
  }, result?: DocumentParseResultV1): Promise<ParsedChatAttachment> {
    const analysisSignal = AbortSignal.any([request.signal, AbortSignal.timeout(PDF_FALLBACK_TIMEOUT_MS)])
    const analysis = await analyzePdfDocument(staged.absolutePath, analysisSignal).catch((error) => {
      if (analysisSignal.aborted && !request.signal.aborted) throw new Error('PDF text-layer analysis timed out')
      throw error
    })
    const warnings = [...new Set([...(result?.warnings ?? []), ...analysis.warnings])]
    if (!analysis.searchable && request.mode === 'auto' && request.unlimitedOcrServerUrl?.trim()) {
      const ocr = await this.options.documentEngine?.parse({
        ...request,
        mode: 'accurate',
        preferredEngine: 'unlimited-ocr-local',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(PDF_FALLBACK_TIMEOUT_MS)])
      }).catch((error) => {
        if (request.signal.aborted) throw error
        return undefined
      })
      throwIfAttachmentParseCancelled(request.signal)
      if (ocr && hasParsedText(ocr.markdown)) return withDocument(staged, ocr)
      warnings.push('Configured local OCR did not return text within this import attempt.')
    }

    const pdfTextPages = analysis.pages.filter((page) => page.text.length > 0)
    const degradationReasons = analysis.searchable
      ? ['pdf_text_layer_fallback']
      : ['no_extractable_pdf_text', 'scanned_or_sparse_pages']
    if (analysis.truncated) degradationReasons.push('pdf_text_layer_incomplete')
    warnings.push(analysis.searchable
      ? 'Text was recovered from the PDF text layer. Layout and table structure may be missing.'
      : 'The original PDF was saved. No usable text was extracted. A scanned PDF may require OCR.')
    return {
      ...staged, pdfTextPages, state: 'degraded', warnings, degradationReasons,
      sourceStructure: { pageCount: analysis.pageCount, headings: 0, tables: 0 }
    }
  }

  cancel(importId: string): boolean {
    const controller = this.active.get(importId)
    if (!controller) return false
    controller.abort()
    return true
  }

  async remove(staged: Pick<StagedChatAttachment, 'absolutePath'>): Promise<void> {
    const root = await canonicalizeContainmentRoot(this.options.managedRoot)
    const target = await realpath(staged.absolutePath)
    if (!isCanonicalPathContained(root, target)) throw new Error('attachment path is outside managed storage')
    await rm(dirname(target), { recursive: true, force: true })
  }
}

function withDocument(staged: StagedChatAttachment, result: DocumentParseResultV1): ParsedChatAttachment {
  return {
    ...staged,
    document: result,
    state: result.quality.status === 'degraded' ? 'degraded' : 'ready',
    warnings: result.warnings,
    degradationReasons: result.quality.reasons,
    sourceStructure: {
      ...result.sourceStructure,
      headings: result.headings.length,
      tables: result.tables.length
    }
  }
}

function hasParsedText(markdown: string): boolean {
  return Boolean(markdown.replace(/<!--\s*page\s*:\s*\d+\s*-->/gi, '').trim())
}

function hasTerminalPdfError(error: unknown): boolean {
  return error instanceof Error && 'code' in error &&
    ['password_required', 'invalid_document', 'document_parse_cancelled'].includes(String(error.code))
}

function throwIfAttachmentParseCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('Attachment parsing was cancelled'), { code: 'document_parse_cancelled' })
}

async function canonicalSourceFile(sourcePath: string): Promise<string> {
  const absolute = resolve(sourcePath)
  const parent = await canonicalizeContainmentRoot(dirname(absolute))
  return resolveContainedPath({ root: parent, target: basename(absolute), mustExist: true, expect: 'file', rejectFinalLink: true })
}

async function verifyFormat(content: Buffer, kind: ChatAttachmentKind, expectedMimeType: string): Promise<void> {
  if (kind === 'pdf' && content.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF signature is invalid')
  if (kind === 'image') {
    const detectedMimeType = detectImageMimeType(content)
    if (!detectedMimeType) throw new Error('image signature is invalid')
    if (detectedMimeType !== expectedMimeType) {
      throw new Error('image signature does not match file extension')
    }
  }
  if (['docx', 'xlsx', 'pptx'].includes(kind)) {
    inspectOfficeArchive(content)
    const archive = await JSZip.loadAsync(content, { checkCRC32: true })
    const requiredPrefix = kind === 'docx' ? 'word/' : kind === 'xlsx' ? 'xl/' : 'ppt/'
    if (!archive.file('[Content_Types].xml') || !Object.keys(archive.files).some((name) => name.startsWith(requiredPrefix))) {
      throw new Error(`Office archive does not contain the required ${kind.toUpperCase()} structure`)
    }
  }
  if (['text', 'markdown', 'csv'].includes(kind) && content.subarray(0, 4096).includes(0)) {
    throw new Error('text attachment contains binary NUL bytes')
  }
}

function detectImageMimeType(content: Buffer): string | null {
  if (
    content.length >= 8 &&
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) return 'image/png'
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    content.length >= 10 &&
    ['GIF87a', 'GIF89a'].includes(content.subarray(0, 6).toString('ascii'))
  ) return 'image/gif'
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString('ascii') === 'RIFF' &&
    content.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return null
}

async function readBoundedText(path: string): Promise<string> {
  const info = await stat(path)
  if (info.size > MAX_TEXT_BYTES) throw new Error('text attachment exceeds 32 MiB parsing limit')
  const bytes = await readFile(path)
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(bytes.length - 2)
    for (let index = 2; index + 1 < bytes.length; index += 2) { swapped[index - 2] = bytes[index + 1]!; swapped[index - 1] = bytes[index]! }
    return new TextDecoder('utf-16le', { fatal: true }).decode(swapped)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0))
}

function mimeCompatible(declared: string, expected: string): boolean {
  const normalized = declared.split(';', 1)[0]!.trim().toLowerCase()
  return normalized === expected || (expected === 'text/markdown' && normalized === 'text/plain')
}

function sanitizeFileName(value: string): string {
  const safe = value.normalize('NFC').replaceAll(/[\\/\0]/g, '_').replace(/^\.+/, '').slice(0, 180)
  return safe || 'attachment'
}
