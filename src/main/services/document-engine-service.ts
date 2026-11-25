import { randomUUID, createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, relative } from 'node:path'
import type {
  DocumentEngineId,
  DocumentEngineStatusV1,
  DocumentParseErrorCode,
  DocumentParseRequestV1,
  DocumentParseResultV1
} from '../../shared/agent-workbench'
import { canonicalizeContainmentRoot, resolveContainedPath } from './canonical-containment'
import { safeSpawn } from './safe-spawn'
import { MINERU_VERSION, MineruInstallerService, type MineruInstallPreflight } from './mineru-installer-service'
import { analyzePdfDocument, type PdfDocumentAnalysisV1 } from './pdf-document-service'
import { atomicWriteFile } from './durable-file'
import { inspectOfficeArchive } from './office-archive-security'
import {
  UNLIMITED_OCR_UNVERSIONED_IDENTITY,
  UNLIMITED_OCR_UNVERIFIED_IDENTITY,
  UnlimitedOcrService,
  normalizeUnlimitedOcrServerUrl
} from './unlimited-ocr-service'
import JSZip from 'jszip'
import { z } from 'zod'

const MARKITDOWN_ENGINE_VERSION = 'markitdown-v0.1.9-workwise-1'
const DOCUMENT_RESULT_CACHE_REVISION = 'document-result-v2'
const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024
const MAX_PROTOCOL_BYTES = 16 * 1024 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_METADATA_ARRAY_ITEMS = 1_000
const MAX_METADATA_STRING_LENGTH = 64 * 1024
const DEFAULT_PARSE_TIMEOUT_MS = 10 * 60 * 1_000
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.pptx', '.xlsx'])

const boundedStringSchema = z.string().max(MAX_METADATA_STRING_LENGTH)
const boundedStringArraySchema = z.array(boundedStringSchema).max(MAX_METADATA_ARRAY_ITEMS)
const documentEngineIdSchema = z.enum(['markitdown', 'unlimited-ocr-local', 'mineru-local', 'mineru-private'])
const documentParsingModeSchema = z.enum(['auto', 'fast', 'accurate'])
const positivePageSchema = z.number().int().positive()
const finiteNonNegativeSchema = z.number().finite().nonnegative()
const headingSchema = z.object({
  level: z.number().int().positive(),
  text: boundedStringSchema,
  page: positivePageSchema.optional()
})
const tableSchema = z.object({
  markdown: boundedStringSchema,
  page: positivePageSchema.optional()
})
const mediaSchema = z.object({
  relativePath: boundedStringSchema,
  mediaType: boundedStringSchema.optional(),
  page: positivePageSchema.optional()
})
const referenceSchema = z.object({
  page: positivePageSchema,
  blockId: boundedStringSchema.optional(),
  kind: z.enum(['text', 'table', 'formula', 'image']).optional(),
  boundingBox: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).optional()
})
const documentParseResultSchema = z.object({
  id: boundedStringSchema,
  engine: documentEngineIdSchema,
  engineVersion: boundedStringSchema,
  sourceSha256: boundedStringSchema.min(1),
  markdown: z.string().max(MAX_METADATA_BYTES),
  headings: z.array(headingSchema).max(MAX_METADATA_ARRAY_ITEMS),
  tables: z.array(tableSchema).max(MAX_METADATA_ARRAY_ITEMS),
  media: z.array(mediaSchema).max(MAX_METADATA_ARRAY_ITEMS),
  references: z.array(referenceSchema).max(MAX_METADATA_ARRAY_ITEMS),
  sourceStructure: z.object({
    pageCount: z.number().int().nonnegative().optional(),
    worksheets: boundedStringArraySchema.optional(),
    slideCount: z.number().int().nonnegative().optional()
  }).optional(),
  warnings: boundedStringArraySchema,
  quality: z.object({
    status: z.enum(['good', 'degraded', 'enhanced']),
    reasons: boundedStringArraySchema
  }),
  route: z.object({
    requestedMode: documentParsingModeSchema,
    selectedEngine: documentEngineIdSchema,
    fallbackFrom: documentEngineIdSchema.optional(),
    switchReason: boundedStringArraySchema.optional()
  }),
  degradedFrom: documentEngineIdSchema.optional(),
  cacheHit: z.boolean(),
  durationMs: finiteNonNegativeSchema
})
const workwiseCacheSchema = z.object({
  revision: z.literal(DOCUMENT_RESULT_CACHE_REVISION),
  markdownPath: boundedStringSchema,
  result: documentParseResultSchema
})
const documentSidecarResponseSchema = z.object({
  ok: z.boolean(),
  code: boundedStringSchema.optional(),
  message: boundedStringSchema.optional(),
  engine: documentEngineIdSchema.optional(),
  engineVersion: boundedStringSchema.optional(),
  sourceSha256: boundedStringSchema.min(1).optional(),
  markdownPath: boundedStringSchema.optional(),
  headings: z.array(headingSchema).max(MAX_METADATA_ARRAY_ITEMS).optional(),
  tables: z.array(tableSchema).max(MAX_METADATA_ARRAY_ITEMS).optional(),
  media: z.array(mediaSchema).max(MAX_METADATA_ARRAY_ITEMS).optional(),
  references: z.array(referenceSchema).max(MAX_METADATA_ARRAY_ITEMS).optional(),
  warnings: boundedStringArraySchema.optional(),
  durationMs: finiteNonNegativeSchema.optional()
})

export type DocumentSidecarResponse = {
  ok: boolean
  code?: string
  message?: string
  engine?: DocumentEngineId
  engineVersion?: string
  sourceSha256?: string
  markdownPath?: string
  headings?: DocumentParseResultV1['headings']
  tables?: DocumentParseResultV1['tables']
  media?: DocumentParseResultV1['media']
  references?: DocumentParseResultV1['references']
  warnings?: string[]
  durationMs?: number
}

export type DocumentQualityAssessment = {
  needsAccurateEngine: boolean
  reasons: string[]
}

export function assessDocumentQuality(input: {
  extension: string
  markdown: string
  sourceBytes: number
  warnings?: string[]
  pageCount?: number
  pageTextCharacters?: number
}): DocumentQualityAssessment {
  if (input.extension !== '.pdf') return { needsAccurateEngine: false, reasons: [] }
  const normalized = input.markdown.replace(/\s+/g, '')
  const reasons: string[] = []
  const minimumText = Math.max(160, Math.min(2_000, Math.floor(input.sourceBytes / 8_192)))
  if (normalized.length < minimumText) reasons.push('low_text_density')
  if (input.pageCount) {
    const pageTextCharacters = input.pageTextCharacters ?? normalized.length
    if (pageTextCharacters === 0) reasons.push('scanned_document')
    else if (pageTextCharacters < Math.max(80, input.pageCount * 40)) reasons.push('weak_text_layer')
  }
  const replacementCount = [...input.markdown].filter((character) => character === '\uFFFD').length
  if (replacementCount > 8 && replacementCount / Math.max(1, input.markdown.length) > 0.005) reasons.push('garbled_text')
  const lines = input.markdown.split(/\r?\n/)
  const displayFormulaCount = (input.markdown.match(/\$\$[\s\S]*?\$\$/g) ?? []).length
  const formulaCommandCount = (input.markdown.match(/\\(?:frac|sum|int|sqrt|begin|end|alpha|beta)\b/g) ?? []).length
  if (displayFormulaCount >= 2 || formulaCommandCount >= 2) reasons.push('formula_dense')
  const tableRows = lines.filter((line) => {
    if (!/^\s*\|(?:[^|]*\|){2,}\s*$/.test(line)) return false
    return !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line)
  })
  if (tableRows.length >= 3) reasons.push('table_dense')
  const columnarLines = lines.filter((line) => line.split(/\t+/).length >= 3)
  if (columnarLines.length >= 2) reasons.push('complex_layout')
  const warnings = (input.warnings ?? []).join('\n')
  if (/scan|ocr/i.test(warnings)) reasons.push('scanned_document')
  if (/formula|equation/i.test(warnings)) reasons.push('formula_dense')
  if (/table|cross.?page/i.test(warnings)) reasons.push('table_dense')
  if (/multi.?column|layout/i.test(warnings)) reasons.push('complex_layout')
  return { needsAccurateEngine: reasons.length > 0, reasons: [...new Set(reasons)] }
}

export type DocumentEngineRunner = (input: {
  parseId: string
  engine: 'markitdown' | 'unlimited-ocr-local' | 'mineru-local'
  unlimitedOcrServerUrl?: string
  unlimitedOcrEngineVersion?: string
  workspaceRoot: string
  inputPath: string
  outputDirectory: string
  signal: AbortSignal
}) => Promise<DocumentSidecarResponse>

export type DocumentEngineServiceOptions = {
  resourcesPath?: string
  developmentRoot?: string
  toolsRoot?: string
  platform?: NodeJS.Platform
  arch?: string
  runner?: DocumentEngineRunner
  unlimitedOcr?: UnlimitedOcrService
  parseTimeoutMs?: number
}

export class DocumentEngineError extends Error {
  constructor(
    message: string,
    readonly code: DocumentParseErrorCode
  ) {
    super(message)
    this.name = 'DocumentEngineError'
  }
}

export class DocumentEngineService {
  private readonly active = new Map<string, AbortController>()
  private readonly options: Required<Omit<DocumentEngineServiceOptions, 'runner' | 'unlimitedOcr'>> & {
    runner?: DocumentEngineRunner
  }
  private readonly mineruInstaller: MineruInstallerService
  private readonly unlimitedOcr: UnlimitedOcrService

  constructor(options: DocumentEngineServiceOptions = {}) {
    this.options = {
      resourcesPath: options.resourcesPath ?? process.resourcesPath ?? '',
      developmentRoot: options.developmentRoot ?? process.cwd(),
      toolsRoot: options.toolsRoot ?? join(homedir(), '.workwise', 'tools'),
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      parseTimeoutMs: normalizeParseTimeout(options.parseTimeoutMs),
      runner: options.runner
    }
    this.unlimitedOcr = options.unlimitedOcr ?? new UnlimitedOcrService()
    this.mineruInstaller = new MineruInstallerService({
      toolsRoot: this.options.toolsRoot,
      platform: this.options.platform
    })
  }

  async listEngines(privateServerUrl?: string, unlimitedOcrServerUrl?: string): Promise<DocumentEngineStatusV1[]> {
    const markitdown = await this.executableStatus(this.markitdownExecutable())
    const mineru = this.options.runner ? true : await this.mineruInstaller.isInstalled()
    let unlimitedOcrState: DocumentEngineStatusV1['state'] = 'needs_configuration'
    let unlimitedOcrMessage = 'Configure an explicit loopback Unlimited-OCR server URL.'
    let unlimitedOcrVersion: string | undefined
    if (unlimitedOcrServerUrl?.trim()) {
      try {
        const origin = normalizeUnlimitedOcrServerUrl(unlimitedOcrServerUrl)
        const health = await this.unlimitedOcr.checkHealth(origin)
        unlimitedOcrState = health.available ? 'available' : 'error'
        unlimitedOcrMessage = health.available ? '' : health.message || 'Unlimited-OCR server health check failed.'
        unlimitedOcrVersion = health.available
          ? health.identity ?? (health.identityUnverified
              ? UNLIMITED_OCR_UNVERIFIED_IDENTITY
              : UNLIMITED_OCR_UNVERSIONED_IDENTITY)
          : UNLIMITED_OCR_UNVERIFIED_IDENTITY
      } catch (error) {
        unlimitedOcrState = 'error'
        unlimitedOcrMessage = safeErrorMessage(error)
        unlimitedOcrVersion = UNLIMITED_OCR_UNVERIFIED_IDENTITY
      }
    }
    return [
      {
        id: 'markitdown',
        state: markitdown ? 'available' : 'not_installed',
        version: markitdown ? MARKITDOWN_ENGINE_VERSION : undefined,
        local: true,
        capabilities: ['pdf', 'docx', 'pptx', 'xlsx'],
        message: markitdown ? undefined : 'The bundled MarkItDown sidecar is unavailable.',
        attribution: 'Microsoft MarkItDown (MIT)'
      },
      {
        id: 'unlimited-ocr-local',
        state: unlimitedOcrState,
        local: true,
        capabilities: ['pdf', 'ocr', 'layout', 'formula'],
        message: unlimitedOcrMessage || undefined,
        version: unlimitedOcrVersion,
        attribution: 'Baidu Unlimited-OCR (MIT); local server configured by user'
      },
      {
        id: 'mineru-local',
        state: mineru ? 'available' : 'not_installed',
        local: true,
        capabilities: ['pdf', 'ocr', 'layout', 'formula'],
        message: mineru ? undefined : 'Install the optional high-accuracy parser to use local OCR and layout analysis.',
        version: mineru ? `mineru-${MINERU_VERSION}` : undefined,
        attribution: `MinerU ${MINERU_VERSION} (MinerU Open Source License)`
      },
      {
        id: 'mineru-private',
        state: privateServerUrl?.trim() ? 'error' : 'needs_configuration',
        local: false,
        capabilities: ['pdf', 'ocr', 'layout', 'formula'],
        message: privateServerUrl?.trim()
          ? 'Private MinerU transport is not configured in this build.'
          : 'An enterprise private MinerU endpoint must be configured explicitly.',
        attribution: 'User-configured private MinerU service'
      }
    ]
  }

  async parse(request: DocumentParseRequestV1 & {
    unlimitedOcrServerUrl?: string
    signal?: AbortSignal
  }): Promise<DocumentParseResultV1> {
    const parseId = request.parseId?.trim() || request.idempotencyKey.trim() || randomUUID()
    if (this.active.has(parseId)) throw new DocumentEngineError('A parse with this id is already running.', 'document_parse_failed')
    if (request.signal?.aborted) {
      throw new DocumentEngineError('Document parsing was cancelled.', 'document_parse_cancelled')
    }
    const controller = new AbortController()
    const abortFromParent = (): void => {
      controller.abort(new DocumentEngineError('Document parsing was cancelled.', 'document_parse_cancelled'))
    }
    request.signal?.addEventListener('abort', abortFromParent, { once: true })
    this.active.set(parseId, controller)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const error = new DocumentEngineError('Document parsing timed out.', 'document_parse_timeout')
        controller.abort(error)
        reject(error)
      }, this.options.parseTimeoutMs)
    })
    const operation = this.parseWithSignal(request, parseId, controller)
    try {
      return await Promise.race([operation, deadline])
    } catch (error) {
      if (controller.signal.aborted) throw documentParseAbortError(controller.signal)
      throw error
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', abortFromParent)
      this.active.delete(parseId)
    }
  }

  private async parseWithSignal(
    request: DocumentParseRequestV1 & { unlimitedOcrServerUrl?: string },
    parseId: string,
    controller: AbortController
  ): Promise<DocumentParseResultV1> {
      const workspaceRoot = await canonicalizeContainmentRoot(request.workspaceRoot)
      throwIfDocumentParseAborted(controller.signal)
      const inputPath = await resolveContainedPath({
        root: workspaceRoot,
        target: request.relativePath,
        mustExist: true,
        expect: 'file',
        rejectFinalLink: true
      })
      throwIfDocumentParseAborted(controller.signal)
      const file = await stat(inputPath)
      if (file.size > MAX_DOCUMENT_BYTES) {
        throw new DocumentEngineError('Document exceeds the 200 MiB limit.', 'resource_limit')
      }
      const extension = extname(inputPath).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw new DocumentEngineError(`Unsupported document format: ${extension || '(none)'}`, 'unsupported_format')
      }
      if (extension !== '.pdf') inspectOfficeArchive(await readFile(inputPath, { signal: controller.signal }))
      throwIfDocumentParseAborted(controller.signal)
      const sourceSha256 = await sha256File(inputPath, controller.signal)
      throwIfDocumentParseAborted(controller.signal)
      const mineruAvailable = this.options.runner ? true : await this.mineruInstaller.isInstalled()
      throwIfDocumentParseAborted(controller.signal)
      let unlimitedOcrServerUrl = ''
      const unlimitedOcrRequired = request.preferredEngine === 'unlimited-ocr-local'
      if (request.unlimitedOcrServerUrl?.trim()) {
        try {
          unlimitedOcrServerUrl = normalizeUnlimitedOcrServerUrl(request.unlimitedOcrServerUrl)
        } catch (error) {
          if (unlimitedOcrRequired) {
            throw new DocumentEngineError(safeErrorMessage(error), 'document_engine_unavailable')
          }
        }
      }
      const engine = await this.selectEngine(request, extension, mineruAvailable, Boolean(unlimitedOcrServerUrl))
      let unlimitedOcrEngineVersion: string | undefined
      let cacheEligible = true
      if (engine === 'unlimited-ocr-local') {
        const health = await this.unlimitedOcr.checkHealth(unlimitedOcrServerUrl, controller.signal)
        throwIfDocumentParseAborted(controller.signal)
        cacheEligible = health.available && !health.identityUnverified
        unlimitedOcrEngineVersion = health.available && !health.identityUnverified
          ? health.identity ?? UNLIMITED_OCR_UNVERSIONED_IDENTITY
          : UNLIMITED_OCR_UNVERIFIED_IDENTITY
      }
      const cacheVersion = engineCacheVersion(engine, unlimitedOcrEngineVersion)
      const cacheKey = createHash('sha256')
        .update(`${sourceSha256}\0${engine}\0${cacheVersion}\0${DOCUMENT_RESULT_CACHE_REVISION}\0${request.mode}\0${mineruAvailable}\0${unlimitedOcrServerUrl}`)
        .digest('hex')
      const outputDirectory = await resolveContainedPath({
        root: workspaceRoot,
        target: request.outputDirectory || join('.workwise', 'cache', 'documents', cacheKey),
        mustExist: false,
        expect: 'directory',
        rejectFinalLink: true
      })
      throwIfDocumentParseAborted(controller.signal)
      const cached = cacheEligible
        ? await this.readCache(workspaceRoot, outputDirectory, parseId, {
            sourceSha256,
            engine,
            engineVersion: unlimitedOcrEngineVersion,
            mode: request.mode,
            allowLegacyCache: !request.outputDirectory
          })
        : null
      throwIfDocumentParseAborted(controller.signal)
      if (cached) return cached
      // Isolate each attempt because a timed-out parser may ignore AbortSignal
      // and finish after an immediate retry has started.
      const attemptDirectory = await resolveContainedPath({
        root: workspaceRoot,
        target: join(outputDirectory, '.attempts', randomUUID()),
        mustExist: false,
        expect: 'directory',
        rejectFinalLink: true
      })
      await mkdir(attemptDirectory, { recursive: true })
      let keepAttemptDirectory = false
      try {
      throwIfDocumentParseAborted(controller.signal)

      if (engine === 'mineru-private') {
        if (!request.allowPrivateServerUpload) {
          throw new DocumentEngineError(
            'Private MinerU upload requires explicit permission for this workspace.',
            'document_upload_not_allowed'
          )
        }
        throw new DocumentEngineError('Private MinerU transport is not configured.', 'document_engine_unavailable')
      }

      let response: DocumentSidecarResponse
      let degradedFrom: DocumentEngineId | undefined
      let routeFallbackFrom: DocumentEngineId | undefined
      let quality: DocumentQualityAssessment = { needsAccurateEngine: false, reasons: [] }
      let pdfAnalysis: PdfDocumentAnalysisV1 | undefined
      try {
        response = await this.runEngine({
          parseId,
          engine,
          workspaceRoot,
          inputPath,
          outputDirectory: attemptDirectory,
          signal: controller.signal,
          unlimitedOcrServerUrl,
          ...(unlimitedOcrEngineVersion ? { unlimitedOcrEngineVersion } : {})
        })
      } catch (error) {
        if (controller.signal.aborted) {
          throw documentParseAbortError(controller.signal)
        }
        if (engine === 'unlimited-ocr-local') {
          const unlimitedOcrWarning = `Unlimited-OCR failed: ${safeErrorMessage(error)}`
          let fallbackResponse: DocumentSidecarResponse | undefined
          let mineruError: unknown
          if (mineruAvailable) {
            try {
              fallbackResponse = await this.runEngine({
                parseId,
                engine: 'mineru-local',
                workspaceRoot,
                inputPath,
                outputDirectory: attemptDirectory,
                signal: controller.signal,
                unlimitedOcrServerUrl
              })
              fallbackResponse.warnings = [
                ...(fallbackResponse.warnings ?? []),
                unlimitedOcrWarning
              ]
              routeFallbackFrom = engine
            } catch (fallbackError) {
              if (controller.signal.aborted) {
                throw documentParseAbortError(controller.signal)
              }
              mineruError = fallbackError
            }
          }
          if (!fallbackResponse) {
            fallbackResponse = await this.runEngine({
              parseId,
              engine: 'markitdown',
              workspaceRoot,
              inputPath,
              outputDirectory: attemptDirectory,
              signal: controller.signal,
              unlimitedOcrServerUrl
            })
            fallbackResponse.warnings = [
              ...(fallbackResponse.warnings ?? []),
              unlimitedOcrWarning,
              ...(mineruError ? [`MinerU failed: ${safeErrorMessage(mineruError)}`] : []),
              'High-accuracy parsing failed; the local MarkItDown result is shown.'
            ]
            fallbackResponse.engine = 'markitdown'
            degradedFrom = mineruError ? 'mineru-local' : engine
          }
          response = fallbackResponse
        } else if (engine === 'mineru-local') {
          response = await this.runEngine({
            parseId,
            engine: 'markitdown',
            workspaceRoot,
            inputPath,
            outputDirectory: attemptDirectory,
            signal: controller.signal,
            unlimitedOcrServerUrl
          })
          response.warnings = [
            ...(response.warnings ?? []),
            `High-accuracy parsing failed; the local MarkItDown result is shown: ${safeErrorMessage(error)}`
          ]
          response.engine = 'markitdown'
          degradedFrom = engine
        } else {
          throw error
        }
      }
      throwIfDocumentParseAborted(controller.signal)
      if (request.mode === 'auto' && engine === 'markitdown' && response.ok && response.markdownPath) {
        const lightweightPath = await resolveContainedPath({
          root: workspaceRoot,
          target: response.markdownPath,
          mustExist: true,
          expect: 'file',
          rejectFinalLink: true
        })
        throwIfDocumentParseAborted(controller.signal)
        const lightweightMarkdown = await readFile(lightweightPath, { encoding: 'utf8', signal: controller.signal })
        pdfAnalysis = await analyzePdfDocument(inputPath, controller.signal).catch((error) => {
          if (controller.signal.aborted) throw documentParseAbortError(controller.signal)
          response.warnings = [...(response.warnings ?? []), `PDF.js text-layer analysis failed: ${safeErrorMessage(error)}`]
          return undefined
        })
        throwIfDocumentParseAborted(controller.signal)
        quality = assessDocumentQuality({
          extension,
          markdown: lightweightMarkdown,
          sourceBytes: file.size,
          warnings: response.warnings,
          pageCount: pdfAnalysis?.pageCount,
          pageTextCharacters: pdfAnalysis?.pages.reduce((sum, page) => sum + page.text.length, 0)
        })
        if (quality.needsAccurateEngine) {
          response.warnings = [
            ...(response.warnings ?? []),
            `This document may need high-accuracy parsing (${quality.reasons.join(', ')}); choose high-accuracy parsing to use configured Unlimited-OCR or MinerU.`
          ]
        }
      }
      if (!response.ok || !response.markdownPath) {
        throw new DocumentEngineError(
          response.message ? sanitizeDocumentDiagnostic(response.message) : 'Document parser returned an invalid response.',
          'document_parse_failed'
        )
      }
      const markdownPath = await resolveContainedPath({
        root: workspaceRoot,
        target: response.markdownPath,
        mustExist: true,
        expect: 'file',
        rejectFinalLink: true
      })
      throwIfDocumentParseAborted(controller.signal)
      const markdown = await readFile(markdownPath, { encoding: 'utf8', signal: controller.signal })
      if (Buffer.byteLength(markdown) > MAX_PROTOCOL_BYTES) {
        throw new DocumentEngineError('Parsed Markdown exceeds the 16 MiB result limit.', 'resource_limit')
      }
      const selectedEngine = response.engine ?? engine
      if (extension === '.pdf' && !pdfAnalysis) {
        pdfAnalysis = await analyzePdfDocument(inputPath, controller.signal).catch((error) => {
          if (controller.signal.aborted) throw documentParseAbortError(controller.signal)
          response.warnings = [...(response.warnings ?? []), `PDF.js text-layer analysis failed: ${safeErrorMessage(error)}`]
          return undefined
        })
      }
      throwIfDocumentParseAborted(controller.signal)
      if (extension === '.pdf' && selectedEngine === 'markitdown') {
        quality = assessDocumentQuality({
          extension,
          markdown,
          sourceBytes: file.size,
          warnings: response.warnings,
          pageCount: pdfAnalysis?.pageCount,
          pageTextCharacters: pdfAnalysis?.pages.reduce((sum, page) => sum + page.text.length, 0)
        })
      }
      const supplemented = supplementPageReferences({
        engine: selectedEngine,
        markdown,
        headings: response.headings ?? [],
        tables: response.tables ?? [],
        references: response.references ?? [],
        analysis: pdfAnalysis
      })
      const sourceStructure = await inspectDocumentStructure(inputPath, extension, pdfAnalysis)
      const fallbackFrom = routeFallbackFrom ?? degradedFrom
      const switchReason = [...new Set([
        ...quality.reasons,
        ...(fallbackFrom ? ['engine_fallback'] : [])
      ])]
      const result: DocumentParseResultV1 = {
        id: parseId,
        engine: selectedEngine,
        engineVersion: response.engineVersion || engineCacheVersion(selectedEngine, unlimitedOcrEngineVersion),
        sourceSha256: response.sourceSha256 || sourceSha256,
        markdown,
        headings: supplemented.headings,
        tables: supplemented.tables,
        media: response.media ?? [],
        references: supplemented.references,
        sourceStructure,
        warnings: [...(response.warnings ?? []), ...(pdfAnalysis?.warnings ?? [])],
        quality: {
          status: degradedFrom
            ? 'degraded'
            : selectedEngine === 'unlimited-ocr-local' || selectedEngine === 'mineru-local' || selectedEngine === 'mineru-private'
            ? 'enhanced'
            : quality.needsAccurateEngine ? 'degraded' : 'good',
          reasons: degradedFrom
            ? [...new Set([...quality.reasons, 'engine_fallback'])]
            : quality.reasons
        },
        route: {
          requestedMode: request.mode,
          selectedEngine,
          ...(fallbackFrom ? { fallbackFrom } : {}),
          ...(switchReason.length > 0 ? { switchReason } : {})
        },
        degradedFrom,
        cacheHit: false,
        durationMs: response.durationMs ?? 0
      }
      if (cacheEligible && !degradedFrom && !routeFallbackFrom) {
        throwIfDocumentParseAborted(controller.signal)
        await this.writeCache(workspaceRoot, outputDirectory, markdownPath, result, controller.signal)
      }
      throwIfDocumentParseAborted(controller.signal)
      keepAttemptDirectory = true
      return result
      } finally {
        if (!keepAttemptDirectory) {
          await rm(attemptDirectory, { recursive: true, force: true }).catch(() => undefined)
        }
      }
  }

  cancel(parseId: string): boolean {
    const controller = this.active.get(parseId)
    if (!controller) return false
    controller.abort(new DocumentEngineError('Document parsing was cancelled.', 'document_parse_cancelled'))
    return true
  }

  mineruPreflight(): Promise<MineruInstallPreflight> {
    return this.mineruInstaller.preflight()
  }

  async installMineru(): Promise<DocumentEngineStatusV1> {
    await this.mineruInstaller.install()
    const statuses = await this.listEngines()
    return statuses.find((status) => status.id === 'mineru-local')!
  }

  private async selectEngine(
    request: DocumentParseRequestV1,
    extension: string,
    mineruAvailable: boolean,
    unlimitedOcrAvailable: boolean
  ): Promise<DocumentEngineId> {
    if (request.preferredEngine) {
      if (request.preferredEngine === 'mineru-private' && !request.allowPrivateServerUpload) {
        throw new DocumentEngineError('Private document upload was not authorized.', 'document_upload_not_allowed')
      }
      if (request.preferredEngine === 'unlimited-ocr-local' && !unlimitedOcrAvailable) {
        throw new DocumentEngineError('The local Unlimited-OCR server is not configured.', 'document_engine_unavailable')
      }
      return request.preferredEngine
    }
    if (request.mode === 'fast' || extension !== '.pdf') return 'markitdown'
    if (request.mode === 'accurate') {
      if (unlimitedOcrAvailable) return 'unlimited-ocr-local'
      if (mineruAvailable) return 'mineru-local'
      throw new DocumentEngineError('No high-accuracy document engine is configured.', 'document_engine_unavailable')
    }
    // Auto starts with the lightweight local parser. Quality signals returned by
    // the parser are surfaced as warnings; an installed MinerU can be selected
    // explicitly without ever uploading the document.
    return 'markitdown'
  }

  private async readCache(
    workspaceRoot: string,
    outputDirectory: string,
    parseId: string,
    expected: {
      sourceSha256: string
      engine: DocumentEngineId
      engineVersion?: string
      mode: DocumentParseRequestV1['mode']
      allowLegacyCache: boolean
    }
  ): Promise<DocumentParseResultV1 | null> {
    try {
      const metadataPath = await resolveContainedPath({
        root: workspaceRoot,
        target: join(outputDirectory, 'workwise-result.json'),
        mustExist: true,
        expect: 'file',
        rejectFinalLink: true
      })
      const workwisePayload = workwiseCacheSchema.safeParse(await readBoundedJson(metadataPath))
      if (!workwisePayload.success) return null
      const { markdownPath, result } = workwisePayload.data
      if (
        result.sourceSha256 !== expected.sourceSha256 ||
        result.engine !== expected.engine ||
        (expected.engineVersion !== undefined && result.engineVersion !== expected.engineVersion) ||
        result.route.requestedMode !== expected.mode ||
        result.route.selectedEngine !== expected.engine ||
        result.degradedFrom ||
        result.route.fallbackFrom
      ) return null
      const workwiseMarkdownPath = await resolveContainedPath({
        root: workspaceRoot,
        target: markdownPath,
        mustExist: true,
        expect: 'file',
        rejectFinalLink: true
      })
      const workwiseMarkdown = await readFile(workwiseMarkdownPath, 'utf8')
      if (Buffer.byteLength(workwiseMarkdown) > MAX_PROTOCOL_BYTES) {
        throw new DocumentEngineError('Parsed Markdown exceeds the 16 MiB result limit.', 'resource_limit')
      }
      const switchReason = result.route.switchReason ?? (
        result.quality.reasons.length > 0 ? result.quality.reasons : undefined
      )
      return {
        ...result,
        id: parseId,
        markdown: workwiseMarkdown,
        route: switchReason ? { ...result.route, switchReason } : result.route,
        cacheHit: true,
        durationMs: 0
      }
    } catch (error) {
      if (error instanceof DocumentEngineError && error.code === 'resource_limit') throw error
      // Older sidecar-only caches remain readable below.
    }
    try {
      if (!expected.allowLegacyCache) return null
      const metadataPath = await resolveContainedPath({
        root: workspaceRoot,
        target: join(outputDirectory, 'result.json'),
        mustExist: true,
        expect: 'file',
        rejectFinalLink: true
      })
      const parsed = documentSidecarResponseSchema.safeParse(await readBoundedJson(metadataPath))
      if (!parsed.success) return null
      const payload = parsed.data as DocumentSidecarResponse
      if (
        !payload.ok ||
        !payload.markdownPath ||
        payload.engine !== expected.engine ||
        (expected.engineVersion !== undefined && payload.engineVersion !== expected.engineVersion) ||
        payload.sourceSha256 !== expected.sourceSha256
      ) return null
      const markdownPath = await resolveContainedPath({
        root: workspaceRoot,
        target: payload.markdownPath,
        mustExist: true,
        expect: 'file',
        rejectFinalLink: true
      })
      const markdown = await readFile(markdownPath, 'utf8')
      if (Buffer.byteLength(markdown) > MAX_PROTOCOL_BYTES) {
        throw new DocumentEngineError('Parsed Markdown exceeds the 16 MiB result limit.', 'resource_limit')
      }
      return {
        id: parseId,
        engine: payload.engine,
        engineVersion: payload.engineVersion ?? MARKITDOWN_ENGINE_VERSION,
        sourceSha256: payload.sourceSha256,
        markdown,
        headings: payload.headings ?? [],
        tables: payload.tables ?? [],
        media: payload.media ?? [],
        references: payload.references ?? [],
        warnings: payload.warnings ?? [],
        quality: { status: 'good', reasons: [] },
        route: { requestedMode: 'fast', selectedEngine: payload.engine },
        cacheHit: true,
        durationMs: 0
      }
    } catch (error) {
      if (error instanceof DocumentEngineError && error.code === 'resource_limit') throw error
      return null
    }
  }

  private async writeCache(
    workspaceRoot: string,
    outputDirectory: string,
    markdownPath: string,
    result: DocumentParseResultV1,
    signal: AbortSignal
  ): Promise<void> {
    const payload = workwiseCacheSchema.parse({
      revision: DOCUMENT_RESULT_CACHE_REVISION,
      markdownPath: relative(workspaceRoot, markdownPath).replaceAll('\\', '/'),
      result: { ...result, markdown: '' }
    })
    await atomicWriteFile(
      join(outputDirectory, 'workwise-result.json'),
      `${JSON.stringify(payload, null, 2)}\n`,
      { beforeReplace: async () => throwIfDocumentParseAborted(signal) }
    )
  }

  private async runEngine(input: Parameters<DocumentEngineRunner>[0]): Promise<DocumentSidecarResponse> {
    let response: unknown
    if (this.options.runner) {
      response = await this.options.runner(input)
    } else if (input.engine === 'markitdown') {
      response = await runJsonSidecar(this.markitdownExecutable(), [], input)
    } else if (input.engine === 'unlimited-ocr-local') {
      response = await this.unlimitedOcr.parse({
        serverUrl: input.unlimitedOcrServerUrl ?? '',
        inputPath: input.inputPath,
        outputDirectory: input.outputDirectory,
        signal: input.signal,
        engineVersion: input.unlimitedOcrEngineVersion
      }).then((result) => ({
        ok: true,
        engine: 'unlimited-ocr-local',
        engineVersion: result.engineVersion,
        markdownPath: relative(input.workspaceRoot, result.markdownPath).replaceAll('\\', '/'),
        warnings: result.warnings,
        durationMs: result.durationMs
      }))
    } else {
      response = await runJsonSidecar(this.mineruInstaller.pythonExecutable(), [this.mineruInstaller.adapterPath()], input)
    }
    throwIfDocumentParseAborted(input.signal)
    const parsed = documentSidecarResponseSchema.safeParse(response)
    if (!parsed.success) {
      throw new DocumentEngineError('Document parser returned an invalid response.', 'document_parse_failed')
    }
    const parsedResponse = parsed.data as DocumentSidecarResponse
    return input.engine === 'unlimited-ocr-local'
      ? { ...parsedResponse, engineVersion: input.unlimitedOcrEngineVersion ?? UNLIMITED_OCR_UNVERIFIED_IDENTITY }
      : parsedResponse
  }

  private markitdownExecutable(): string {
    const executable = this.options.platform === 'win32' ? 'workwise-markitdown.exe' : 'workwise-markitdown'
    const packaged = join(this.options.resourcesPath, 'app.asar.unpacked', 'sidecars', 'markitdown', executable)
    const development = join(
      this.options.developmentRoot,
      'build',
      'sidecars',
      `markitdown-${this.options.platform}-${this.options.arch}`,
      'workwise-markitdown',
      executable
    )
    return existsSync(packaged) ? packaged : development
  }

  private async executableStatus(path: string): Promise<boolean> {
    if (this.options.runner) return true
    try {
      await access(path)
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  }
}

async function inspectDocumentStructure(
  path: string,
  extension: string,
  pdfAnalysis?: PdfDocumentAnalysisV1
): Promise<DocumentParseResultV1['sourceStructure']> {
  if (extension === '.pdf') return pdfAnalysis ? { pageCount: pdfAnalysis.pageCount } : undefined
  if (extension !== '.xlsx' && extension !== '.pptx') return undefined
  const archive = await JSZip.loadAsync(await readFile(path), { checkCRC32: true })
  if (extension === '.pptx') {
    return { slideCount: Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide[1-9]\d*\.xml$/i.test(name)).length }
  }
  const workbook = await archive.file('xl/workbook.xml')?.async('string')
  if (!workbook) return { worksheets: [] }
  return {
    worksheets: [...workbook.matchAll(/<sheet\b[^>]*\bname=(?:"([^"]*)"|'([^']*)')/gi)]
      .map((match) => decodeXmlEntities(match[1] ?? match[2] ?? ''))
  }
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
    const normalized = entity.toLowerCase()
    if (named[normalized]) return named[normalized]!
    const hexadecimal = normalized.startsWith('&#x')
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 3 : 2, -1), hexadecimal ? 16 : 10)
    return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity
  })
}

function engineCacheVersion(engine: DocumentEngineId, unlimitedOcrEngineVersion?: string): string {
  return engine === 'markitdown'
    ? MARKITDOWN_ENGINE_VERSION
    : engine === 'unlimited-ocr-local'
      ? unlimitedOcrEngineVersion ?? UNLIMITED_OCR_UNVERIFIED_IDENTITY
    : engine === 'mineru-local'
      ? `mineru-${MINERU_VERSION}`
      : 'mineru-private-v1'
}

function supplementPageReferences(input: {
  engine: DocumentEngineId
  markdown: string
  headings: DocumentParseResultV1['headings']
  tables: DocumentParseResultV1['tables']
  references: DocumentParseResultV1['references']
  analysis?: PdfDocumentAnalysisV1
}): Pick<DocumentParseResultV1, 'headings' | 'tables' | 'references'> {
  const references = input.references.filter((reference) => isValidPdfPage(reference.page, input.analysis))
  const markers = markdownPageMarkers(
    input.markdown,
    input.analysis?.pageCount,
    input.engine !== 'markitdown'
  )
  for (const marker of markers) {
    if (!references.some((reference) => reference.blockId === `page-${marker.page}`)) {
      references.push({ page: marker.page, blockId: `page-${marker.page}`, kind: 'text' })
    }
  }
  const headings = input.headings
    .filter((heading) => heading.page === undefined || isValidPdfPage(heading.page, input.analysis))
    .slice(0, MAX_METADATA_ARRAY_ITEMS)
    .map((heading) => ({ ...heading }))
  const claimedHeadings = new Set<number>()
  for (const marker of markers) {
    for (const heading of marker.headings) {
      const existingIndex = headings.findIndex((current, index) => (
        !claimedHeadings.has(index) &&
        current.level === heading.level &&
        current.text === heading.text &&
        (current.page === undefined || current.page === marker.page)
      ))
      if (existingIndex >= 0) {
        if (headings[existingIndex]!.page === undefined) {
          headings[existingIndex] = { ...headings[existingIndex]!, page: marker.page }
        }
        claimedHeadings.add(existingIndex)
      } else if (headings.length < MAX_METADATA_ARRAY_ITEMS) {
        headings.push({ ...heading, page: marker.page })
        claimedHeadings.add(headings.length - 1)
      }
    }
  }
  const supplementedHeadings = headings.map((heading, index) => {
    const page = heading.page ?? (input.analysis?.pages.length ? findPdfPage(input.analysis.pages, heading.text) : undefined)
    if (
      page &&
      references.length < MAX_METADATA_ARRAY_ITEMS &&
      !references.some((reference) => reference.blockId === `heading-${index + 1}`)
    ) {
      references.push({ page, blockId: `heading-${index + 1}`, kind: 'text' })
    }
    return page ? { ...heading, page } : heading
  })
  const tables = input.tables
    .filter((table) => table.page === undefined || isValidPdfPage(table.page, input.analysis))
    .map((table, index) => {
    const page = table.page ?? (input.analysis?.pages.length ? findPdfPage(input.analysis.pages, table.markdown) : undefined)
    if (
      page &&
      references.length < MAX_METADATA_ARRAY_ITEMS &&
      !references.some((reference) => reference.blockId === `table-${index + 1}`)
    ) {
      references.push({ page, blockId: `table-${index + 1}`, kind: 'table' })
    }
    return page ? { ...table, page } : table
  })
  return {
    headings: supplementedHeadings.slice(0, MAX_METADATA_ARRAY_ITEMS),
    tables: tables.slice(0, MAX_METADATA_ARRAY_ITEMS),
    references: references.slice(0, MAX_METADATA_ARRAY_ITEMS)
  }
}

function isValidPdfPage(page: number, analysis?: PdfDocumentAnalysisV1): boolean {
  return !analysis || page >= 1 && page <= analysis.pageCount
}

function markdownPageMarkers(
  markdown: string,
  pageCount?: number,
  allowExplicitPageMarkers = false
): Array<{
  page: number
  headings: Array<{ level: number; text: string }>
}> {
  if (pageCount) {
    const pages = markdown.split('\f')
    if (pages.length > 1 && pages.length === pageCount) {
      let remainingHeadings = MAX_METADATA_ARRAY_ITEMS
      return pages.slice(0, MAX_METADATA_ARRAY_ITEMS).map((page, index) => {
        const headings = markdownHeadings(page).slice(0, remainingHeadings)
        remainingHeadings -= headings.length
        return { page: index + 1, headings }
      })
    }
  }
  if (!allowExplicitPageMarkers) return []
  const matches = [...markdown.matchAll(/<!--\s*page\s*:\s*(\d+)\s*-->/gi)]
  if (matches.length > 0) {
    let remainingHeadings = MAX_METADATA_ARRAY_ITEMS
    return matches.slice(0, MAX_METADATA_ARRAY_ITEMS).flatMap((match, index) => {
      const page = Number(match[1])
      const maximumPage = pageCount ?? MAX_METADATA_ARRAY_ITEMS
      if (!Number.isSafeInteger(page) || page < 1 || page > maximumPage) return []
      const start = (match.index ?? 0) + match[0].length
      const end = matches[index + 1]?.index ?? markdown.length
      const headings = markdownHeadings(markdown.slice(start, end)).slice(0, remainingHeadings)
      remainingHeadings -= headings.length
      return [{ page, headings }]
    })
  }
  return []
}

function markdownHeadings(markdown: string): Array<{ level: number; text: string }> {
  return [...markdown.replace(/\f/g, '\n').matchAll(/^\s*(#{1,6})\s+(.+?)\s*$/gm)]
    .slice(0, MAX_METADATA_ARRAY_ITEMS)
    .map((heading) => ({
      level: heading[1].length,
      text: heading[2].replace(/\s+#+\s*$/, '').trim().slice(0, MAX_METADATA_STRING_LENGTH)
    }))
    .filter((heading) => heading.text.length > 0)
}

function findPdfPage(pages: PdfDocumentAnalysisV1['pages'], value: string): number | undefined {
  const query = normalizeForPageMatch(value)
  if (!query) return undefined
  const probes = [query.slice(0, 120), query.slice(0, 48), query.slice(0, 20)]
    .filter((probe, index, list) => probe.length >= 4 && list.indexOf(probe) === index)
  for (const page of pages) {
    const text = normalizeForPageMatch(page.text)
    if (probes.some((probe) => text.includes(probe))) return page.page
  }
  return undefined
}

function normalizeForPageMatch(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/[|#*_`~>-]/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const contents = await readFile(path, { signal })
  return createHash('sha256').update(contents).digest('hex')
}

function normalizeParseTimeout(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_PARSE_TIMEOUT_MS
}

function documentParseAbortError(signal: AbortSignal): DocumentEngineError {
  if (signal.reason instanceof DocumentEngineError) return signal.reason
  return new DocumentEngineError('Document parsing was cancelled.', 'document_parse_cancelled')
}

function throwIfDocumentParseAborted(signal: AbortSignal): void {
  if (signal.aborted) throw documentParseAbortError(signal)
}

export function sanitizeDocumentDiagnostic(message: string): string {
  let sanitized = message.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s]+/gi, '[url]')
  const boundary = String.raw`(?=\s+(?:and|via|at|from|on|in|because|with)\b|[,;)}\]]|$)`
  sanitized = sanitized.replace(new RegExp(String.raw`\b[A-Za-z]:\\[^\r\n]*?${boundary}`, 'g'), '[path]')
  sanitized = sanitized.replace(new RegExp(String.raw`(?<![A-Za-z0-9_])/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc)/[^\r\n]*?${boundary}`, 'g'), '[path]')
  return sanitized.replace(/\s{2,}/g, ' ').trim().slice(0, 240)
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error'
  return sanitizeDocumentDiagnostic(error.message)
}

async function readBoundedJson(path: string): Promise<unknown> {
  const info = await stat(path)
  if (!info.isFile()) throw new DocumentEngineError('Document metadata is not a regular file.', 'document_parse_failed')
  if (info.size > MAX_METADATA_BYTES) {
    throw new DocumentEngineError('Document parser metadata exceeds the 1 MiB limit.', 'resource_limit')
  }
  const contents = await readFile(path)
  if (contents.byteLength > MAX_METADATA_BYTES) {
    throw new DocumentEngineError('Document parser metadata exceeds the 1 MiB limit.', 'resource_limit')
  }
  return JSON.parse(contents.toString('utf8')) as unknown
}

async function runJsonSidecar(
  executable: string,
  args: string[],
  input: Parameters<DocumentEngineRunner>[0]
): Promise<DocumentSidecarResponse> {
  let child: ChildProcess | undefined
  const abort = (): void => {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      void safeSpawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f']).catch(() => child?.kill())
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
    }
  }
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    throwIfDocumentParseAborted(input.signal)
    child = await safeSpawn(executable, args, {
      cwd: input.workspaceRoot,
      workspaceRoot: input.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: process.env.TMPDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME
      }
    })
    if (input.signal.aborted) abort()
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes <= MAX_PROTOCOL_BYTES) stdout.push(chunk)
      else abort()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.reduce((sum, item) => sum + item.byteLength, 0) < 64 * 1024) stderr.push(chunk)
    })
    child.stdin?.end(JSON.stringify({
      workspaceRoot: input.workspaceRoot,
      inputPath: input.inputPath,
      outputDirectory: input.outputDirectory
    }))
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child?.once('error', reject)
      child?.once('exit', resolveExit)
    })
    throwIfDocumentParseAborted(input.signal)
    if (bytes > MAX_PROTOCOL_BYTES) throw new DocumentEngineError('Parser response exceeded the result limit.', 'resource_limit')
    const text = Buffer.concat(stdout).toString('utf8').trim()
    let response: DocumentSidecarResponse
    try {
      const parsed = documentSidecarResponseSchema.safeParse(JSON.parse(text) as unknown)
      if (!parsed.success) throw new Error('invalid response schema')
      response = parsed.data as DocumentSidecarResponse
    } catch {
      throw new DocumentEngineError(
        sanitizeDocumentDiagnostic(`Document parser exited with ${exitCode ?? 'unknown'}: ${Buffer.concat(stderr).toString('utf8')}`),
        'document_parse_failed'
      )
    }
    if (exitCode !== 0 || !response.ok) {
      throw new DocumentEngineError(
        response.message ? sanitizeDocumentDiagnostic(response.message) : 'Document parser failed.',
        'document_parse_failed'
      )
    }
    return response
  } finally {
    input.signal.removeEventListener('abort', abort)
  }
}

export function documentDisplayName(path: string): string {
  return basename(path)
}

export function documentRelativePath(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).replaceAll('\\', '/')
}
