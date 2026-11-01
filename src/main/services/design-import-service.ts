import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  type FileHandle
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseSvgStringsToDocument } from '../../shared/design-svg-parser'
import {
  generateDesignElementId,
  createDesignDocument,
  createDesignPage,
  type DesignDocumentV1,
  type DesignElement,
  type DesignPage,
  type DesignImportDiagnostic,
  type DesignImportReportV1
} from '../../shared/design-document'
import type { DesignFidelityWarning } from '../../shared/design-workspace'
import { resolvePptMasterScript } from './design-ppt-master-paths'
import {
  isPptMasterSidecarAvailable,
  runPptMasterSidecar
} from './ppt-master-sidecar'
import { inspectPptxPackage } from './pptx-integrity'
import type { PptxImportReport } from '../../shared/pptx-document'

/**
 * Design 工作区导入服务（main 进程）。
 *
 * 把 .pptx 文件通过 PPT Master 的 pptx_to_svg.py 转为 SVG，
 * 再用 design-svg-parser 解析为 DesignDocumentV1。
 *
 * 复用 ppt-master-tool-provider 的 execFile + 超时模式
 * （✅ 已核实 ppt-master-tool-provider.ts:244-276）。
 */

const IMPORT_TIMEOUT_MS = 3 * 60 * 1000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_IMPORTED_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMPORTED_IMAGE_TOTAL_BYTES = 48 * 1024 * 1024
const MAX_IMPORTED_IMAGES = 64
const MAX_IMPORTED_SVG_BYTES = 16 * 1024 * 1024
const MAX_IMPORTED_SVG_TOTAL_BYTES = 256 * 1024 * 1024
const ZIP_EOCD_MIN_BYTES = 22
const ZIP_MAX_COMMENT_BYTES = 65_535
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50

export const PPTX_IMPORT_LIMITS = Object.freeze({
  sourceBytes: 200 * 1024 * 1024,
  entries: 4_096,
  centralDirectoryBytes: 16 * 1024 * 1024,
  uncompressedBytes: 512 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  // Real-world decks with charts and long embedded drawing data regularly exceed
  // 16 MiB for a single XML part. The aggregate and compression-ratio limits still
  // protect against ZIP bombs, so allow a bounded 64 MiB part here.
  xmlBytes: 64 * 1024 * 1024,
  compressionRatio: 200,
  slides: 500
})

export type PptxImportPreflightResult = {
  sourceBytes: number
  entryCount: number
  slideCount: number
  compressedBytes: number
  uncompressedBytes: number
}

type PptxCentralEntry = {
  name: string
  flags: number
  method: number
  compressedBytes: number
  uncompressedBytes: number
  localHeaderOffset: number
}

export type ImportedDesignImage = {
  provisionalId: string
  filename: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml'
  bytes: Uint8Array
  width?: number
  height?: number
}

export type DesignImportResult =
  | {
      ok: true
      document: DesignDocumentV1
      /** Exact staged bytes used by conversion; never re-read a mutable original after conversion. */
      sourcePptxBytes: Uint8Array
      images: ImportedDesignImage[]
      warnings: DesignFidelityWarning[]
      importReport: DesignImportReportV1
    }
  | { ok: false; message: string; code?: 'import_quality_failed'; importReport?: DesignImportReportV1 }

/**
 * Validate the converted document before image persistence or UI activation.
 * Slight page bleed is normal in presentation artwork; coordinates beyond ten
 * slide dimensions indicate a broken unit/transform conversion, not clipping.
 */
export function createDesignImportReport(input: {
  document: DesignDocumentV1
  sourceFileName: string
  sourceSlideCount: number
  warnings?: readonly DesignFidelityWarning[]
  importedAt?: number
}): DesignImportReportV1 {
  const { document } = input
  const diagnostics: DesignImportDiagnostic[] = []
  let warningCount = 0
  let errorCount = 0
  const add = (diagnostic: DesignImportDiagnostic): void => {
    if (diagnostic.severity === 'warning') warningCount += 1
    if (diagnostic.severity === 'error') errorCount += 1
    if (diagnostics.length < 1_999) diagnostics.push(diagnostic)
  }
  if (document.pages.length !== input.sourceSlideCount) {
    add({
      code: 'slide_count_mismatch', severity: 'error',
      message: `The PPTX contains ${input.sourceSlideCount} slides, but conversion produced ${document.pages.length}.`
    })
  }
  let elementCount = 0
  let textElementCount = 0
  let imageElementCount = 0
  for (const [pageIndex, page] of document.pages.entries()) {
    const pageNumber = pageIndex + 1
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) {
      add({ code: 'invalid_page_geometry', severity: 'error', pageNumber, pageId: page.id,
        message: `Page ${pageNumber} has an invalid canvas size.` })
    }
    for (const element of page.elements) {
      elementCount += 1
      if (element.type === 'text' && element.text?.trim()) textElementCount += 1
      if (element.type === 'image') imageElementCount += 1
      const location = { pageNumber, pageId: page.id, elementId: element.id }
      const geometry = [element.x, element.y, element.w, element.h, element.rotation]
      if (
        geometry.some((value) => !Number.isFinite(value)) ||
        (element.type !== 'line' && (element.w < 0 || element.h < 0))
      ) {
        add({ code: 'invalid_element_geometry', severity: 'error', ...location,
          message: `Page ${pageNumber} contains an element with invalid geometry.` })
      } else if (
        Math.abs(element.x) > page.width * 10 || Math.abs(element.y) > page.height * 10 ||
        Math.abs(element.w) > page.width * 10 || Math.abs(element.h) > page.height * 10
      ) {
        add({ code: 'extreme_element_geometry', severity: 'error', ...location,
          message: `Page ${pageNumber} contains an element more than ten canvas dimensions away or oversized; conversion units may be invalid.` })
      } else if (
        element.type === 'text' && element.text?.trim() && !element.hidden &&
        (element.x + element.w < 0 || element.y + element.h < 0 || element.x > page.width || element.y > page.height)
      ) {
        add({ code: 'text_outside_canvas', severity: 'warning', ...location,
          message: `Page ${pageNumber} contains text entirely outside the visible canvas.` })
      }
    }
  }
  for (const warning of input.warnings ?? []) {
    const legacyPageNumber = warning.pageId?.match(/^page-(\d+)$/)?.[1]
    const pageIndex = legacyPageNumber
      ? Number(legacyPageNumber) - 1
      : document.pages.findIndex((page) => page.id === warning.pageId)
    const page = document.pages[pageIndex]
    add({
      code: warning.code, severity: 'warning', message: warning.message,
      ...(page ? { pageNumber: pageIndex + 1, pageId: page.id } : {}),
      ...(warning.elementId ? { elementId: warning.elementId } : {})
    })
  }
  if (warningCount + errorCount > diagnostics.length) {
    diagnostics.push({ code: 'diagnostics_truncated', severity: 'info',
      message: 'Only the first 1999 diagnostics are stored; summary counts include all findings.' })
  }
  const fidelityPages = document.pages.filter((page) => page.displayMode === 'fidelity').length
  return {
    schemaVersion: 'v1', sourceType: 'pptx', sourceFileName: basename(input.sourceFileName),
    sourceSlideCount: input.sourceSlideCount, convertedSlideCount: document.pages.length,
    importedAt: input.importedAt ?? Date.now(),
    mode: fidelityPages === 0 ? 'editable' : fidelityPages === document.pages.length ? 'fidelity' : 'mixed',
    summary: { elementCount, textElementCount, imageElementCount, warningCount, errorCount },
    diagnostics
  }
}

/**
 * A valid OOXML source must remain openable even when the optional compatibility
 * renderer cannot produce a reference SVG. The native editor reads the source
 * bytes directly; these empty pages are only the durable document shell and
 * carry an explicit diagnostic so the UI never presents a broken SVG as truth.
 */
function createNativeOnlyPptxDocument(
  name: string,
  sourceSlideCount: number,
  sourceSha256: string,
  sourceBytes: number,
  conversionMessage: string | null,
  nativeReport: PptxImportReport
): { document: DesignDocumentV1; report: DesignImportReportV1; warnings: DesignFidelityWarning[] } {
  const base = createDesignDocument({ name, format: 'ppt169' })
  const pages = Array.from({ length: sourceSlideCount }, (_, index) => ({
    ...createDesignPage({ format: 'ppt169', name: `Slide ${index + 1}` }),
    width: nativeReport.pages[index]?.width ?? 1280,
    height: nativeReport.pages[index]?.height ?? 720
  }))
  const warnings: DesignFidelityWarning[] = [...(conversionMessage ? [{
    code: 'native_import_diagnostic' as const,
    message: `Compatibility preview unavailable; the original PPTX remains available in the native editor. ${conversionMessage}`
  }] : []), ...nativeReport.warnings.map((message) => ({ code: 'native_object_diagnostic' as const, message }))]
  const document: DesignDocumentV1 = {
    ...base,
    schemaVersion: 'v2',
    documentKind: 'pptx',
    pages,
    pptx: {
      editorBackend: 'pptx-vanilla-viewer',
      editorVersion: '3.61.0',
      source: { sha256: sourceSha256, bytes: sourceBytes, cachedFilename: 'source.pptx' },
      importReport: nativeReport,
      editorModel: {
        schemaVersion: 1,
        kind: 'native-pptx-index',
        slideCount: sourceSlideCount,
        pages: nativeReport.pages.map((page) => ({
          pageIndex: page.pageIndex,
          sourceName: page.sourceName,
          objectCount: page.objectCount,
          editableObjectCount: page.editableObjectCount,
          protectedObjectCount: page.protectedObjectCount,
          failedObjectCount: page.failedObjectCount
        })),
        sourceObjectIds: nativeReport.objects.map((object) => ({
          id: object.id,
          pageIndex: object.pageIndex,
          type: object.type,
          support: object.support
        }))
      },
      // Clone the inventory entries. The resource validator treats repeated
      // object references as corruption, and the report itself remains the
      // canonical immutable inventory.
      protectedObjects: nativeReport.objects
        .filter((object) => object.support === 'protected')
        .map((object) => ({
          ...object,
          ...(object.fonts ? { fonts: [...object.fonts] } : {}),
          ...(object.geometry ? { geometry: { ...object.geometry } } : {}),
          ...(object.table ? { table: { ...object.table } } : {})
        }))
    }
  }
  const report = createDesignImportReport({
    document,
    sourceFileName: `${name}.pptx`,
    sourceSlideCount,
    warnings
  })
  report.summary.elementCount = nativeReport.objects.length
  report.summary.textElementCount = nativeReport.objects.filter((item) => item.type === 'text').length
  report.summary.imageElementCount = nativeReport.objects.filter((item) => item.type === 'image').length
  for (const message of nativeReport.errors) {
    report.diagnostics.push({ code: 'native_source_quality_failed', severity: 'error', message })
    report.summary.errorCount += 1
  }
  for (const object of nativeReport.objects.filter((item) => item.support !== 'editable')) {
    report.diagnostics.push({ code: 'protected_object', severity: 'warning', pageNumber: object.pageIndex + 1,
      elementId: object.id, message: `${object.name || object.id}: ${object.reason || 'Original OOXML is protected.'}` })
    report.summary.warningCount += 1
  }
  document.importReport = report
  return { document, report, warnings }
}

export function hasBlockingDesignImportErrors(report: DesignImportReportV1): boolean {
  return report.summary.errorCount > 0 || report.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
}

function resolvePythonCommand(): string {
  return process.env.WORKWISE_PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3')
}

function pptxLimitError(message: string): Error {
  return new Error(`unsafe_pptx: ${message}`)
}

async function readFileRange(
  handle: FileHandle,
  length: number,
  position: number
): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
    throw pptxLimitError('the ZIP contains an invalid byte range')
  }
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset)
    if (result.bytesRead === 0) throw pptxLimitError('the ZIP is truncated')
    offset += result.bytesRead
  }
  return buffer
}

function findEndOfCentralDirectory(tail: Buffer, tailOffset: number, sourceBytes: number): number {
  for (let offset = tail.length - ZIP_EOCD_MIN_BYTES; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue
    const commentBytes = tail.readUInt16LE(offset + 20)
    const absoluteOffset = tailOffset + offset
    if (absoluteOffset + ZIP_EOCD_MIN_BYTES + commentBytes === sourceBytes) {
      return offset
    }
  }
  throw pptxLimitError('the file is not a complete PPTX ZIP archive')
}

function decodeZipEntryName(bytes: Buffer): string {
  const name = bytes.toString('utf8')
  if (!name || name.includes('\u0000') || name.includes('\ufffd')) {
    throw pptxLimitError('the ZIP contains an invalid entry name')
  }
  const normalized = name.replace(/\\/g, '/')
  if (
    normalized !== name ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw pptxLimitError('the ZIP contains an unsafe entry path')
  }
  return normalized
}

function isXmlPptxEntry(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.xml') || lower.endsWith('.rels')
}

function parsePptxCentralDirectory(
  centralDirectory: Buffer,
  entryCount: number,
  centralDirectoryOffset: number,
  sourceBytes: number
): {
  entries: PptxCentralEntry[]
  slideCount: number
  compressedBytes: number
  uncompressedBytes: number
} {
  const entries: PptxCentralEntry[] = []
  const names = new Set<string>()
  let cursor = 0
  let slideCount = 0
  let compressedBytes = 0
  let uncompressedBytes = 0

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralDirectory.length) {
      throw pptxLimitError('the ZIP central directory is truncated')
    }
    if (centralDirectory.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw pptxLimitError('the ZIP central directory is malformed')
    }

    const flags = centralDirectory.readUInt16LE(cursor + 8)
    const method = centralDirectory.readUInt16LE(cursor + 10)
    const entryCompressedBytes = centralDirectory.readUInt32LE(cursor + 20)
    const entryUncompressedBytes = centralDirectory.readUInt32LE(cursor + 24)
    const nameBytes = centralDirectory.readUInt16LE(cursor + 28)
    const extraBytes = centralDirectory.readUInt16LE(cursor + 30)
    const commentBytes = centralDirectory.readUInt16LE(cursor + 32)
    const diskNumber = centralDirectory.readUInt16LE(cursor + 34)
    const localHeaderOffset = centralDirectory.readUInt32LE(cursor + 42)
    const recordBytes = 46 + nameBytes + extraBytes + commentBytes

    if (cursor + recordBytes > centralDirectory.length) {
      throw pptxLimitError('the ZIP central directory entry is truncated')
    }
    if (
      entryCompressedBytes === 0xffffffff ||
      entryUncompressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskNumber === 0xffff
    ) {
      throw pptxLimitError('ZIP64 PPTX files are not supported')
    }
    if (diskNumber !== 0) throw pptxLimitError('multi-disk PPTX files are not supported')
    if ((flags & 0x1) !== 0) throw pptxLimitError('encrypted PPTX entries are not supported')
    if (method !== 0 && method !== 8) {
      throw pptxLimitError(`unsupported ZIP compression method ${method}`)
    }

    const name = decodeZipEntryName(
      centralDirectory.subarray(cursor + 46, cursor + 46 + nameBytes)
    )
    const normalizedName = name.toLowerCase()
    if (names.has(normalizedName)) {
      throw pptxLimitError('the ZIP contains duplicate entry paths')
    }
    names.add(normalizedName)

    if (localHeaderOffset >= centralDirectoryOffset) {
      throw pptxLimitError('a ZIP entry points outside the file data area')
    }
    if (entryUncompressedBytes > PPTX_IMPORT_LIMITS.entryBytes) {
      throw pptxLimitError('a ZIP entry exceeds the 128 MiB limit')
    }
    if (isXmlPptxEntry(name) && entryUncompressedBytes > PPTX_IMPORT_LIMITS.xmlBytes) {
      throw pptxLimitError('an OOXML part exceeds the 64 MiB XML limit')
    }
    if (
      entryUncompressedBytes > 1024 * 1024 &&
      entryUncompressedBytes / Math.max(entryCompressedBytes, 1) >
        PPTX_IMPORT_LIMITS.compressionRatio
    ) {
      throw pptxLimitError('a ZIP entry exceeds the allowed compression ratio')
    }

    compressedBytes += entryCompressedBytes
    uncompressedBytes += entryUncompressedBytes
    if (!Number.isSafeInteger(compressedBytes) || !Number.isSafeInteger(uncompressedBytes)) {
      throw pptxLimitError('the ZIP size totals are invalid')
    }
    if (uncompressedBytes > PPTX_IMPORT_LIMITS.uncompressedBytes) {
      throw pptxLimitError('the PPTX exceeds the 512 MiB uncompressed limit')
    }
    if (/^ppt\/slides\/slide[1-9][0-9]*\.xml$/i.test(name)) {
      slideCount += 1
      if (slideCount > PPTX_IMPORT_LIMITS.slides) {
        throw pptxLimitError(`the PPTX exceeds ${PPTX_IMPORT_LIMITS.slides} slides`)
      }
    }

    entries.push({
      name,
      flags,
      method,
      compressedBytes: entryCompressedBytes,
      uncompressedBytes: entryUncompressedBytes,
      localHeaderOffset
    })
    cursor += recordBytes
  }

  if (cursor !== centralDirectory.length) {
    throw pptxLimitError('the ZIP central directory contains unexpected trailing data')
  }
  if (compressedBytes > sourceBytes) {
    throw pptxLimitError('the ZIP declares more compressed data than the source file contains')
  }
  if (
    uncompressedBytes > 16 * 1024 * 1024 &&
    uncompressedBytes / Math.max(compressedBytes, 1) > PPTX_IMPORT_LIMITS.compressionRatio
  ) {
    throw pptxLimitError('the PPTX exceeds the allowed total compression ratio')
  }
  if (!names.has('[content_types].xml') || !names.has('ppt/presentation.xml')) {
    throw pptxLimitError('the ZIP is missing required PowerPoint parts')
  }
  if (slideCount === 0) throw pptxLimitError('the PPTX contains no slides')

  return { entries, slideCount, compressedBytes, uncompressedBytes }
}

async function verifyPptxLocalHeaders(
  handle: FileHandle,
  entries: readonly PptxCentralEntry[],
  centralDirectoryOffset: number
): Promise<void> {
  for (const entry of entries) {
    const header = await readFileRange(handle, 30, entry.localHeaderOffset)
    if (header.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
      throw pptxLimitError('a ZIP local header is malformed')
    }
    const flags = header.readUInt16LE(6)
    const method = header.readUInt16LE(8)
    const nameBytes = header.readUInt16LE(26)
    const extraBytes = header.readUInt16LE(28)
    const dataOffset = entry.localHeaderOffset + 30 + nameBytes + extraBytes
    const dataEnd = dataOffset + entry.compressedBytes
    if (
      flags !== entry.flags ||
      method !== entry.method ||
      !Number.isSafeInteger(dataEnd) ||
      dataEnd > centralDirectoryOffset
    ) {
      throw pptxLimitError('a ZIP local header does not match its central directory entry')
    }
    const localName = decodeZipEntryName(
      await readFileRange(handle, nameBytes, entry.localHeaderOffset + 30)
    )
    if (localName !== entry.name) {
      throw pptxLimitError('a ZIP local entry name does not match its central directory entry')
    }
  }
}

/**
 * 在启动 Python/sidecar 前对 PPTX 的 ZIP 目录做有界预检。
 * 这里只读取文件尾、中央目录与短本地头，不解压任何 entry。
 */
export async function preflightPptxForDesignImport(
  pptxPath: string
): Promise<PptxImportPreflightResult> {
  const info = await lstat(pptxPath)
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size < ZIP_EOCD_MIN_BYTES ||
    info.size > PPTX_IMPORT_LIMITS.sourceBytes
  ) {
    throw pptxLimitError('the source must be a regular PPTX file between 22 bytes and 200 MiB')
  }

  const handle = await open(pptxPath, 'r')
  try {
    const tailBytes = Math.min(
      info.size,
      ZIP_EOCD_MIN_BYTES + ZIP_MAX_COMMENT_BYTES
    )
    const tailOffset = info.size - tailBytes
    const tail = await readFileRange(handle, tailBytes, tailOffset)
    const eocdOffsetInTail = findEndOfCentralDirectory(tail, tailOffset, info.size)
    const eocd = tail.subarray(eocdOffsetInTail)
    const diskNumber = eocd.readUInt16LE(4)
    const centralDiskNumber = eocd.readUInt16LE(6)
    const diskEntries = eocd.readUInt16LE(8)
    const entryCount = eocd.readUInt16LE(10)
    const centralDirectoryBytes = eocd.readUInt32LE(12)
    const centralDirectoryOffset = eocd.readUInt32LE(16)
    const absoluteEocdOffset = tailOffset + eocdOffsetInTail

    if (
      diskNumber === 0xffff ||
      centralDiskNumber === 0xffff ||
      diskEntries === 0xffff ||
      entryCount === 0xffff ||
      centralDirectoryBytes === 0xffffffff ||
      centralDirectoryOffset === 0xffffffff
    ) {
      throw pptxLimitError('ZIP64 PPTX files are not supported')
    }
    if (diskNumber !== 0 || centralDiskNumber !== 0 || diskEntries !== entryCount) {
      throw pptxLimitError('multi-disk PPTX files are not supported')
    }
    if (entryCount === 0 || entryCount > PPTX_IMPORT_LIMITS.entries) {
      throw pptxLimitError(`the PPTX must contain between 1 and ${PPTX_IMPORT_LIMITS.entries} entries`)
    }
    if (centralDirectoryBytes > PPTX_IMPORT_LIMITS.centralDirectoryBytes) {
      throw pptxLimitError('the ZIP central directory exceeds 16 MiB')
    }
    if (
      !Number.isSafeInteger(centralDirectoryOffset + centralDirectoryBytes) ||
      centralDirectoryOffset + centralDirectoryBytes !== absoluteEocdOffset
    ) {
      throw pptxLimitError('the ZIP central directory range is invalid')
    }

    const centralDirectory = await readFileRange(
      handle,
      centralDirectoryBytes,
      centralDirectoryOffset
    )
    const parsed = parsePptxCentralDirectory(
      centralDirectory,
      entryCount,
      centralDirectoryOffset,
      info.size
    )
    await verifyPptxLocalHeaders(handle, parsed.entries, centralDirectoryOffset)
    return {
      sourceBytes: info.size,
      entryCount,
      slideCount: parsed.slideCount,
      compressedBytes: parsed.compressedBytes,
      uncompressedBytes: parsed.uncompressedBytes
    }
  } finally {
    await handle.close()
  }
}

/**
 * 导入 PPTX 为 DesignDocument。
 *
 * 1. 创建临时目录
 * 2. 调 pptx_to_svg.py 转换（--inheritance-mode flat，自包含）
 * 3. 读 svg/ 目录下所有 slide_NN.svg
 * 4. 用 parseSvgStringsToDocument 解析
 */
export async function importPptxToDesign(
  pptxPath: string,
  options: { compatibilityPreview?: boolean } = {}
): Promise<DesignImportResult> {
  if (!existsSync(pptxPath)) {
    return { ok: false, message: `File not found: ${pptxPath}` }
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'workwise-design-import-'))
  const stagedPptxPath = join(tempDir, 'source.pptx')
  const conversionDirectory = join(tempDir, 'converted')

  try {
    // 1. 只把普通且大小有界的源文件复制到隔离目录；随后解析固定副本的 ZIP
    //    元数据。这样 preflight 与 Python/sidecar 使用的是同一份不可变输入。
    const sourceInfo = await lstat(pptxPath)
    if (
      sourceInfo.isSymbolicLink() ||
      !sourceInfo.isFile() ||
      sourceInfo.size <= 0 ||
      sourceInfo.size > PPTX_IMPORT_LIMITS.sourceBytes
    ) {
      throw pptxLimitError('the source is not a safe regular file under 200 MiB')
    }
    await copyFile(pptxPath, stagedPptxPath)
    const preflight = await preflightPptxForDesignImport(stagedPptxPath)
    const sourcePptxBytes = await readFile(stagedPptxPath)
    const sourceSha256 = createHash('sha256').update(sourcePptxBytes).digest('hex')
    const nativeInspection = await inspectPptxPackage(sourcePptxBytes)
    if (nativeInspection.report.errors.length) {
      const native = createNativeOnlyPptxDocument(basename(pptxPath, extname(pptxPath)),
        preflight.slideCount, sourceSha256, sourcePptxBytes.length, null, nativeInspection.report)
      return { ok: false, code: 'import_quality_failed',
        message: `PPTX source quality checks failed: ${nativeInspection.report.errors.join(' ')}`,
        importReport: native.report }
    }
    if (!options.compatibilityPreview) {
      const native = createNativeOnlyPptxDocument(basename(pptxPath, extname(pptxPath)),
        preflight.slideCount, sourceSha256, sourcePptxBytes.length, null, nativeInspection.report)
      return { ok: true, document: native.document, sourcePptxBytes, images: [], warnings: native.warnings,
        importReport: native.report }
    }
    await mkdir(conversionDirectory, { recursive: true })

    // 2. 优先使用原生 PPTX 解析（python-pptx 直读形状/段落/字体），
    //    失败或没有可编辑文字时回退到 pptx_to_svg。
    let nativeSvgReady = false
    if (isPptMasterSidecarAvailable()) {
      try {
        await runPptMasterSidecar({
          operation: 'ppt-master-import-pptx-native',
          workspaceRoot: tempDir,
          inputPath: stagedPptxPath,
          outputDirectory: conversionDirectory
        }, { timeoutMs: IMPORT_TIMEOUT_MS })
        const probeSvgDir = join(conversionDirectory, 'svg')
        if (existsSync(probeSvgDir)) {
          const probeFiles = (await readdir(probeSvgDir))
            .filter((name) => /^slide_\d+\.svg$/i.test(name))
            .sort()
          if (probeFiles.length > 0) {
            const first = await readFile(join(probeSvgDir, probeFiles[0]), 'utf8')
            nativeSvgReady = /<text\b/i.test(first)
          }
        }
      } catch {
        nativeSvgReady = false
      }
    }
    let conversionMessage: string | null = null
    try {
      if (!nativeSvgReady && isPptMasterSidecarAvailable()) {
        await runPptMasterSidecar({
          operation: 'ppt-master-import-pptx',
          workspaceRoot: tempDir,
          inputPath: stagedPptxPath,
          outputDirectory: conversionDirectory
        }, { timeoutMs: IMPORT_TIMEOUT_MS })
      }
      if (!nativeSvgReady && !isPptMasterSidecarAvailable()) {
        const developmentFallbackAllowed =
          process.env.NODE_ENV !== 'production' || process.defaultApp === true
        if (!developmentFallbackAllowed) {
          throw new Error('The bundled PPT Master runtime is unavailable.')
        }
        const scriptPath = resolvePptMasterScript('pptx_to_svg.py')
        if (!scriptPath) {
          throw new Error('PPT Master scripts not found.')
        }
        await runPptxToSvg(
          scriptPath,
          stagedPptxPath,
          conversionDirectory,
          resolvePythonCommand()
        )
      }
    } catch (error) {
      conversionMessage = error instanceof Error ? error.message : String(error)
    }

    // 3. 读 SVG 文件（flat 模式输出到 svg/ 目录）
    const nativeDiagnostics = await readNativeImportDiagnostics(conversionDirectory)
    const svgDir = join(conversionDirectory, 'svg')
    if (!existsSync(svgDir)) {
      const nativeOnly = createNativeOnlyPptxDocument(
        basename(pptxPath, '.pptx'),
        preflight.slideCount,
        sourceSha256,
        sourceInfo.size,
        conversionMessage ?? 'No compatibility renderer output was produced.',
        nativeInspection.report
      )
      return {
        ok: true,
        document: nativeOnly.document,
        sourcePptxBytes,
        images: [],
        warnings: nativeOnly.warnings,
        importReport: nativeOnly.report
      }
    }

    const svgFiles = (await readdir(svgDir))
      .filter((name) => name.toLowerCase().endsWith('.svg') && name.startsWith('slide_'))
      .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))

    if (svgFiles.length === 0 || svgFiles.length !== preflight.slideCount) {
      const nativeOnly = createNativeOnlyPptxDocument(
        basename(pptxPath, '.pptx'),
        preflight.slideCount,
        sourceSha256,
        sourceInfo.size,
        conversionMessage ?? `Compatibility renderer produced ${svgFiles.length} of ${preflight.slideCount} slides.`,
        nativeInspection.report
      )
      return {
        ok: true,
        document: nativeOnly.document,
        sourcePptxBytes,
        images: [],
        warnings: nativeOnly.warnings,
        importReport: nativeOnly.report
      }
    }
    if (svgFiles.length > preflight.slideCount || svgFiles.length > PPTX_IMPORT_LIMITS.slides) {
      throw new Error('PPT Master produced more SVG pages than the validated PPTX contains.')
    }

    // 4. 读取每个 SVG；sidecar 输出仍按不可信转换结果处理。
    const svgStrings: string[] = []
    let svgBytes = 0
    for (const file of svgFiles) {
      const svgPath = join(svgDir, file)
      const svgInfo = await lstat(svgPath)
      if (
        svgInfo.isSymbolicLink() ||
        !svgInfo.isFile() ||
        svgInfo.size <= 0 ||
        svgInfo.size > MAX_IMPORTED_SVG_BYTES ||
        svgBytes + svgInfo.size > MAX_IMPORTED_SVG_TOTAL_BYTES
      ) {
        throw new Error('PPT Master produced an unsafe or oversized SVG page.')
      }
      svgBytes += svgInfo.size
      const content = await readFile(svgPath, 'utf8')
      svgStrings.push(content)
    }

    // 5. Fidelity warnings from the raw SVG conversion.
    const warnings: DesignFidelityWarning[] = [...nativeDiagnostics]
    for (let pageIndex = 0; pageIndex < svgStrings.length; pageIndex += 1) {
      const svg = svgStrings[pageIndex]
      warnings.push(...inspectDesignSvgFidelity(svg, pageIndex))
    }

    // 6. Parse each slide into real Design elements. Pages with meaningful
    //    vector content (text, paths, filled shapes) stay fully editable.
    //    Only genuinely picture-only pages fall back to the locked full-page
    //    reference + invisible hit-region model.
    const name = basename(pptxPath, '.pptx')
    const parsedDocument = parseSvgStringsToDocument(svgStrings, name)
    const keepVector = parsedDocument.pages.map((page) => shouldKeepVectorElements(page))
    const hasFallbackPages = keepVector.some((keep) => !keep)
    const importedImages: ImportedDesignImage[] = []

    // Every page gets a full-page visual reference so users can switch a page
    // to “fidelity mode” (exact original look) at any time.
    for (let pageIndex = 0; pageIndex < svgStrings.length; pageIndex += 1) {
      const page = parsedDocument.pages[pageIndex]
      importedImages.push({
        provisionalId: pageReferenceImageId(pageIndex),
        filename: `slide-${String(pageIndex + 1).padStart(3, '0')}.svg`,
        mimeType: 'image/svg+xml',
        bytes: Buffer.from(svgStrings[pageIndex], 'utf8'),
        width: page?.width,
        height: page?.height
      })
    }

    // Embedded raster images inside SVG <image> elements become real editable
    // assets instead of being flattened into the page reference.
    for (let pageIndex = 0; pageIndex < svgStrings.length; pageIndex += 1) {
      let imageIndex = 0
      for (const href of imageHrefs(svgStrings[pageIndex])) {
        let bytes: Uint8Array | null = null
        let mimeType: ImportedDesignImage['mimeType'] | null = null
        const dataMatch = href.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i)
        if (dataMatch) {
          bytes = Buffer.from(dataMatch[2], 'base64')
          mimeType = `image/${dataMatch[1].toLowerCase()}` as ImportedDesignImage['mimeType']
        } else if (/^media\/[^/]+$/.test(href)) {
          try {
            const read = await readImportedDesignImage(href, svgDir, tempDir)
            bytes = read.bytes
            mimeType = read.mimeType
          } catch {
            continue
          }
        } else {
          continue
        }
        if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORTED_IMAGE_BYTES || !mimeType) continue
        const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]
        importedImages.push({
          provisionalId: pageImageElementId(pageIndex, imageIndex),
          filename: `slide-${String(pageIndex + 1).padStart(3, '0')}-img-${imageIndex + 1}.${extension}`,
          mimeType,
          bytes
        })
        imageIndex += 1
      }
    }

    const hrefToImageId: Array<Map<string, string>> = svgStrings.map(() => new Map())
    for (let pageIndex = 0; pageIndex < svgStrings.length; pageIndex += 1) {
      let imageIndex = 0
      for (const href of imageHrefs(svgStrings[pageIndex])) {
        if (href.startsWith('data:image/') || /^media\/[^/]+$/.test(href)) {
          hrefToImageId[pageIndex].set(href, pageImageElementId(pageIndex, imageIndex))
          imageIndex += 1
        }
      }
    }

    const parsedWithImages = parseSvgStringsToDocument(svgStrings, name, {
      imageAssetIdForHref: (href, pageIndex) => hrefToImageId[pageIndex]?.get(href)
    })
    const document: DesignDocumentV1 = {
      ...parsedWithImages,
      // Mark the result as a native PPTX document so the renderer can select
      // the PPTX adapter even though the editable fallback is SVG-backed.
      schemaVersion: 'v2',
      documentKind: 'pptx',
      pptx: {
        editorBackend: 'pptx-vanilla-viewer',
        editorVersion: '3.61.0',
        importReport: nativeInspection.report,
        source: {
          sha256: sourceSha256,
          bytes: sourceInfo.size,
          cachedFilename: 'source.pptx'
        }
      },
      pages: parsedWithImages.pages.map((page, pageIndex) => {
        const base = keepVector[pageIndex]
          ? buildEditablePage(page)
          : buildReferencePage(page, pageIndex)
        return {
          ...base,
          fidelityImageAssetId: pageReferenceImageId(pageIndex),
          displayMode: keepVector[pageIndex] ? 'editable' : 'fidelity'
        }
      })
    }
    if (hasFallbackPages) {
      warnings.unshift({
        code: 'reference_regions',
        message: 'Some slides are picture-only and keep the original visual as a locked reference with selectable hit regions; pages with real vector content were imported as editable elements.'
      })
    }

    const uniqueWarnings = dedupeWarnings(warnings)
    const importReport = createDesignImportReport({
      document,
      sourceFileName: basename(pptxPath),
      sourceSlideCount: preflight.slideCount,
      warnings: uniqueWarnings
    })
    if (hasBlockingDesignImportErrors(importReport)) {
      return {
        ok: false,
        code: 'import_quality_failed',
        message: `PPTX import failed quality checks (${importReport.summary.errorCount} errors). ${importReport.diagnostics.find((diagnostic) => diagnostic.severity === 'error')?.message ?? ''}`.trim(),
        importReport
      }
    }
    document.importReport = importReport
    return { ok: true, document, sourcePptxBytes, images: importedImages, warnings: uniqueWarnings, importReport }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: message.startsWith('unsafe_pptx:')
        ? `PowerPoint security check failed: ${message.slice('unsafe_pptx:'.length).trim()}.`
        : message
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function pageReferenceImageId(pageIndex: number): string {
  return `asset_import_slide_${pageIndex + 1}`
}

function pageImageElementId(pageIndex: number, imageIndex: number): string {
  return `asset_import_slide_${pageIndex + 1}_img_${imageIndex + 1}`
}

/**
 * A page is worth keeping as real editable elements when it contains any
 * meaningful vector content: text, paths, or visible shapes. Picture-only
 * pages (full-page <image> plus empty placeholders) fall back to the locked
 * visual-reference model instead.
 */
export function shouldKeepVectorElements(page: DesignPage): boolean {
  return page.elements.some((element) => {
    if (element.type === 'text') return Boolean(element.text?.trim())
    if (element.type === 'path') return Boolean(element.pathData)
    if (element.type === 'ellipse' || element.type === 'line') return true
    if (element.type === 'rect') return Boolean(element.fill || element.stroke)
    return false
  })
}

function buildEditablePage(page: DesignPage): DesignPage {
  return {
    ...page,
    background: page.background ?? 'FFFFFF',
    elements: page.elements
      .map((element, elementIndex) => ({
        ...element,
        zIndex: element.zIndex ?? elementIndex,
        locked: false
      }))
      .filter((element) => !(element.type === 'image' && !element.imageAssetId))
  }
}

function buildReferencePage(page: DesignPage, pageIndex: number): DesignPage {
  const sourceText = page.elements
    .filter((element) => element.type === 'text' && element.text?.trim())
    .map((element) => element.text!.trim())
    .join(' · ')
    .slice(0, 400)
  const reference: DesignElement = {
    id: generateDesignElementId(),
    type: 'image',
    name: `幻灯片 ${pageIndex + 1} 参考图${sourceText ? ` · ${sourceText}` : ''}`,
    x: 0,
    y: 0,
    w: page.width,
    h: page.height,
    rotation: 0,
    opacity: 1,
    imageAssetId: pageReferenceImageId(pageIndex),
    zIndex: 0,
    locked: true
  }
  const regions: DesignElement[] = page.elements.map((element, elementIndex) => ({
    id: generateDesignElementId(),
    type: 'rect',
    name: designReferenceRegionName(element, elementIndex),
    x: Math.round(element.x),
    y: Math.round(element.y),
    w: Math.max(1, Math.round(element.w || 1)),
    h: Math.max(1, Math.round(element.h || 1)),
    rotation: element.rotation ?? 0,
    fill: 'FFFFFF',
    stroke: 'FFFFFF',
    opacity: 0,
    locked: true,
    zIndex: elementIndex + 1
  }))
  return {
    ...page,
    background: 'FFFFFF',
    elements: [reference, ...regions]
  }
}

const REFERENCE_REGION_LABELS: Record<string, string> = {
  text: '文本',
  rect: '形状',
  ellipse: '椭圆',
  line: '线条',
  path: '图形',
  image: '图片',
  group: '组合',
  preset: '预设形状'
}

function designReferenceRegionName(
  element: Pick<DesignElement, 'type' | 'text'>,
  index: number
): string {
  const label = REFERENCE_REGION_LABELS[element.type] ?? element.type ?? '元素'
  const snippet = element.type === 'text' ? element.text?.trim().slice(0, 24) : ''
  return snippet ? `${label} · ${snippet}` : `${label} ${index + 1}`
}

function imageHrefs(svg: string): string[] {
  const hrefs: string[] = []
  for (const match of svg.matchAll(/<image\b([^>]*)\/?>/gi)) {
    const attributes = match[1] ?? ''
    const href = attributes.match(/\b(?:href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
    const value = href?.[1] ?? href?.[2]
    if (value) hrefs.push(value)
  }
  return [...new Set(hrefs)]
}

export function inspectDesignSvgFidelity(
  svg: string,
  pageIndex: number
): DesignFidelityWarning[] {
  const warnings: DesignFidelityWarning[] = []
  const pageId = `page-${pageIndex + 1}`
  if (/<(?:filter|fe[A-Za-z]+)\b/i.test(svg)) {
    warnings.push({
      code: 'unsupported_filter',
      pageId,
      message: `Page ${pageIndex + 1} contains SVG filters that cannot be edited in Design.`
    })
  }
  if (/<mask\b|mask\s*=/i.test(svg)) {
    warnings.push({
      code: 'unsupported_mask',
      pageId,
      message: `Page ${pageIndex + 1} contains masks that cannot be edited in Design.`
    })
  }
  if (/<(?:linear|radial)Gradient\b/i.test(svg) || /fill\s*=\s*["']url\(/i.test(svg)) {
    warnings.push({
      code: 'gradient_approximation',
      pageId,
      message: `Page ${pageIndex + 1} contains gradient fills; editable mode keeps a representative solid color and the fidelity reference preserves the original appearance.`
    })
  }
  if (/<(?:text|tspan)\b[^>]*(?:fill-opacity|stroke-opacity)\s*=/i.test(svg)) {
    warnings.push({
      code: 'transparency_approximation',
      pageId,
      message: `Page ${pageIndex + 1} contains translucent paint; editable mode stores a single element opacity and may approximate per-run alpha.`
    })
  }
  if (/<g\b/i.test(svg)) {
    warnings.push({
      code: 'flattened_group',
      pageId,
      message: `Page ${pageIndex + 1} contains source groups; supported child elements were flattened in source order.`
    })
  }
  if (/transform\s*=\s*["'][^"']*(?:matrix|translate|scale|skew)[^(]*\(/i.test(svg)) {
    warnings.push({
      code: 'layout_approximation',
      pageId,
      message: `Page ${pageIndex + 1} contains complex transforms; layout may be approximate.`
    })
  }
  return warnings
}

function dedupeWarnings(warnings: DesignFidelityWarning[]): DesignFidelityWarning[] {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.pageId ?? ''}:${warning.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * The native converter writes a bounded JSON sidecar next to its SVG output.
 * Preserve one actionable warning per diagnostic code/slide instead of
 * copying every repeated shape approximation into the design document.
 */
async function readNativeImportDiagnostics(conversionDirectory: string): Promise<DesignFidelityWarning[]> {
  const reportPath = join(conversionDirectory, 'native-import-report.json')
  if (!existsSync(reportPath)) return []
  try {
    const parsed = JSON.parse(await readFile(reportPath, 'utf8')) as {
      diagnostics?: unknown
    }
    if (!Array.isArray(parsed.diagnostics)) return []
    const grouped = new Map<string, { count: number; slides: Set<number>; message: string }>()
    for (const value of parsed.diagnostics) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const item = value as Record<string, unknown>
      const code = typeof item.code === 'string' ? item.code.trim() : ''
      const message = typeof item.message === 'string' ? item.message.trim() : ''
      const slide = typeof item.slide === 'number' && Number.isSafeInteger(item.slide) ? item.slide : 0
      if (!code || !message) continue
      const key = `${code}\0${message}`
      const current = grouped.get(key) ?? { count: 0, slides: new Set<number>(), message }
      current.count += 1
      if (slide > 0 && current.slides.size < 8) current.slides.add(slide)
      grouped.set(key, current)
    }
    return [...grouped.entries()].slice(0, 32).map(([key, item]) => {
      const code = key.split('\0', 1)[0]
      const slideText = item.slides.size > 0 ? ` Slides: ${[...item.slides].join(', ')}.` : ''
      return {
        code: 'native_import_diagnostic' as const,
        pageId: item.slides.size === 1 ? `page-${[...item.slides][0]}` : undefined,
        message: `Native PPTX import reported ${code} ${item.count} time${item.count === 1 ? '' : 's'}: ${item.message}.${slideText}`
      }
    })
  } catch {
    return []
  }
}

export async function readImportedDesignImage(
  href: string,
  svgDirectory: string,
  importRoot: string
): Promise<{
  filename: string
  mimeType: ImportedDesignImage['mimeType']
  bytes: Uint8Array
}> {
  if (href.startsWith('data:')) {
    const match = href.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/)
    if (!match) throw new Error('unsupported embedded image encoding')
    const bytes = Buffer.from(match[2], 'base64')
    assertImageBytes(bytes, match[1])
    return {
      filename: `embedded.${extensionForMime(match[1])}`,
      mimeType: match[1] as ImportedDesignImage['mimeType'],
      bytes
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || isAbsolute(href) || href.includes('\u0000')) {
    throw new Error('external or absolute image references are not allowed')
  }
  const sourcePath = resolve(svgDirectory, href)
  const root = resolve(importRoot)
  const rel = relative(root, sourcePath)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('image reference escapes the import directory')
  }
  const info = await lstat(sourcePath)
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_IMPORTED_IMAGE_BYTES) {
    throw new Error('image is not a safe regular file under 12 MiB')
  }
  const bytes = await readFile(sourcePath)
  const mimeType = mimeFromExtension(sourcePath)
  if (!mimeType) throw new Error('unsupported image format')
  assertImageBytes(bytes, mimeType)
  return { filename: basename(sourcePath), mimeType, bytes }
}

function mimeFromExtension(path: string): ImportedDesignImage['mimeType'] | null {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return null
  }
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  return mimeType.slice('image/'.length)
}

function assertImageBytes(bytes: Uint8Array, mimeType: string): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORTED_IMAGE_BYTES) {
    throw new Error('image is empty or exceeds 12 MiB')
  }
  const header = Buffer.from(bytes.subarray(0, 12))
  const matches =
    mimeType === 'image/png'
      ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/jpeg'
        ? header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
        : mimeType === 'image/gif'
          ? ['GIF87a', 'GIF89a'].includes(header.subarray(0, 6).toString('ascii'))
          : mimeType === 'image/webp'
            ? header.subarray(0, 4).toString('ascii') === 'RIFF' &&
              header.subarray(8, 12).toString('ascii') === 'WEBP'
            : false
  if (!matches) throw new Error('image signature does not match its format')
}

/** 执行 pptx_to_svg.py */
function runPptxToSvg(
  scriptPath: string,
  pptxPath: string,
  outputDir: string,
  pythonCmd: string
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const args = [
      scriptPath,
      pptxPath,
      '-o', outputDir,
      '--embed-images',
      '--inheritance-mode', 'flat'
    ]
    const child = execFile(pythonCmd, args, {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: IMPORT_TIMEOUT_MS
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolvePromise()
        return
      }
      const detail = stderr.trim() || error.message
      reject(new Error(detail))
    })
    child.on('error', (err) => {
      reject(new Error(`Python execution failed: ${err.message}`))
    })
  })
}
