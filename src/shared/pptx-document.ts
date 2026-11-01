/**
 * PPTX 文档集成契约。
 *
 * The renderer owns the editing surface, while the adapter is responsible for
 * translating a native PPTX editor model. Keeping this contract separate from
 * the free-canvas model lets old V1 documents remain readable and makes an
 * optional PPTist build replaceable without changing IPC payloads.
 */

export const PPTX_EDITOR_BACKENDS = ['pptx-vanilla-viewer', 'pptist', 'legacy-svg'] as const
export type PptxEditorBackend = (typeof PPTX_EDITOR_BACKENDS)[number]

export type PptxObjectSupport = 'editable' | 'protected' | 'unsupported' | 'failed'

export type PptxSourceObject = {
  id: string
  pageIndex: number
  type: string
  support: PptxObjectSupport
  reason?: string
  sourcePart?: string
  name?: string
  text?: string
  fonts?: string[]
  textRunCount?: number
  geometry?: { x: number; y: number; width: number; height: number; rotation: number }
  table?: { rows: number; columns: number; mergedCells: number }
}

export type PptxImportPageReport = {
  pageIndex: number
  sourceName?: string
  width: number
  height: number
  objectCount: number
  editableObjectCount: number
  protectedObjectCount: number
  failedObjectCount: number
  warnings: string[]
}

export type PptxImportReport = {
  sourcePath?: string
  sourceSha256?: string
  sourceBytes?: number
  sourceSlideCount: number
  importedSlideCount: number
  backend: PptxEditorBackend
  backendVersion: string
  status: 'complete' | 'partial' | 'blocked'
  pages: PptxImportPageReport[]
  objects: PptxSourceObject[]
  warnings: string[]
  errors: string[]
  generatedAt: number
}

export type PptxNativeSource = {
  path?: string
  sha256?: string
  bytes?: number
  /** Copy of the original source is stored beside the document when present. */
  cachedFilename?: string
}

export type PptxDocumentMetadata = {
  editorBackend: PptxEditorBackend
  editorVersion: string
  source?: PptxNativeSource
  importReport?: PptxImportReport
  /** Full PPTist-compatible model when the bundled editor is available. */
  editorModel?: Record<string, unknown>
  /** Versioned native payloads kept for objects the editor cannot mutate. */
  protectedObjects?: Record<string, unknown>[]
}

export const PPTX_DOCUMENT_FORMAT = 'pptx' as const

/** Bounded JSON reader shared by persistence and the renderer (no DOM/Node). */
export function normalizePptxImportReport(input: unknown): PptxImportReport | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const raw = input as Record<string, unknown>
  const integer = (value: unknown, max: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length <= 2_000 && value.every((item) => typeof item === 'string' && item.length <= 16_384)
  if (
    !integer(raw.sourceSlideCount, 500) || !integer(raw.importedSlideCount, 500) ||
    !integer(raw.generatedAt, Number.MAX_SAFE_INTEGER) ||
    !PPTX_EDITOR_BACKENDS.includes(raw.backend as PptxEditorBackend) ||
    typeof raw.backendVersion !== 'string' || raw.backendVersion.length > 128 ||
    !['complete', 'partial', 'blocked'].includes(String(raw.status)) ||
    !strings(raw.warnings) || !strings(raw.errors) ||
    !Array.isArray(raw.pages) || raw.pages.length > 500 ||
    !Array.isArray(raw.objects) || raw.objects.length > 30_000
  ) return undefined
  const pages: PptxImportPageReport[] = []
  for (const candidate of raw.pages) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const page = candidate as PptxImportPageReport
    if (!integer(page.pageIndex, 499) || !Number.isFinite(page.width) || !Number.isFinite(page.height) ||
      !integer(page.objectCount, 30_000) || !integer(page.editableObjectCount, 30_000) ||
      !integer(page.protectedObjectCount, 30_000) || !integer(page.failedObjectCount, 30_000) || !strings(page.warnings)) return undefined
    pages.push({ pageIndex: page.pageIndex, width: page.width, height: page.height,
      objectCount: page.objectCount, editableObjectCount: page.editableObjectCount,
      protectedObjectCount: page.protectedObjectCount, failedObjectCount: page.failedObjectCount,
      warnings: [...page.warnings], ...(typeof page.sourceName === 'string' ? { sourceName: page.sourceName.slice(0, 1024) } : {}) })
  }
  const objects: PptxSourceObject[] = []
  for (const candidate of raw.objects) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const item = candidate as PptxSourceObject
    if (typeof item.id !== 'string' || item.id.length > 256 || typeof item.type !== 'string' || item.type.length > 128 ||
      !integer(item.pageIndex, 499) || !['editable', 'protected', 'unsupported', 'failed'].includes(item.support)) return undefined
    const result: PptxSourceObject = { id: item.id, pageIndex: item.pageIndex, type: item.type, support: item.support }
    for (const field of ['reason', 'sourcePart', 'name', 'text'] as const) {
      if (typeof item[field] === 'string' && item[field]!.length <= 1024 * 1024) result[field] = item[field]
    }
    if (strings(item.fonts)) result.fonts = [...item.fonts]
    if (integer(item.textRunCount, 1_000_000)) result.textRunCount = item.textRunCount
    if (item.geometry && ['x', 'y', 'width', 'height', 'rotation'].every((key) => Number.isFinite(item.geometry![key as keyof NonNullable<PptxSourceObject['geometry']>]))) {
      result.geometry = { x: item.geometry.x, y: item.geometry.y, width: item.geometry.width, height: item.geometry.height, rotation: item.geometry.rotation }
    }
    if (item.table && [item.table.rows, item.table.columns, item.table.mergedCells].every((value) => integer(value, 1_000_000))) {
      result.table = { rows: item.table.rows, columns: item.table.columns, mergedCells: item.table.mergedCells }
    }
    objects.push(result)
  }
  return { sourceSlideCount: raw.sourceSlideCount, importedSlideCount: raw.importedSlideCount,
    backend: raw.backend as PptxEditorBackend, backendVersion: raw.backendVersion,
    status: raw.status as PptxImportReport['status'], generatedAt: raw.generatedAt, pages, objects,
    warnings: [...raw.warnings], errors: [...raw.errors],
    ...(typeof raw.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sourceSha256) ? { sourceSha256: raw.sourceSha256 } : {}),
    ...(integer(raw.sourceBytes, 200 * 1024 * 1024) ? { sourceBytes: raw.sourceBytes } : {}),
    ...(typeof raw.sourcePath === 'string' && raw.sourcePath.length <= 1024 ? { sourcePath: raw.sourcePath } : {}) }
}

export function isPptxDocument(document: { documentKind?: string; pptx?: unknown } | null | undefined): boolean {
  return document?.documentKind === PPTX_DOCUMENT_FORMAT || Boolean(document?.pptx)
}

export function createBlockedPptxReport(input: {
  sourceSlideCount: number
  importedSlideCount: number
  backend?: PptxEditorBackend
  backendVersion?: string
  error: string
}): PptxImportReport {
  const now = Date.now()
  return {
    sourceSlideCount: input.sourceSlideCount,
    importedSlideCount: input.importedSlideCount,
    backend: input.backend ?? 'legacy-svg',
    backendVersion: input.backendVersion ?? 'unavailable',
    status: 'blocked',
    pages: [],
    objects: [],
    warnings: [],
    errors: [input.error],
    generatedAt: now
  }
}

