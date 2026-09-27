import { z } from 'zod'

/** Versioned contracts for deterministic engineering-survey processing. */
export const SURVEY_SCHEMA_VERSION = 1 as const

export const SurveyNetworkTypeV1 = z.enum([
  'leveling',
  'height-control',
  'traverse',
  'plane-control',
  'triangulation',
  'cpiii-free-station',
  'cpiii-resection',
  'coordinate-transform',
  'gnss'
])
export type SurveyNetworkTypeV1 = z.infer<typeof SurveyNetworkTypeV1>

export const CoordinateTransformTypeV1 = z.enum(['similarity-2d', 'helmert-7', 'gauss-kruger-forward', 'gauss-kruger-inverse', 'height-fit'])
export type CoordinateTransformTypeV1 = z.infer<typeof CoordinateTransformTypeV1>

export const SurveyFormatIdV1 = z.enum([
  'workwise-json', 'delimited-text', 'xlsx',
  // Stage A P0 format identities. Registration only: parsing/detection is
  // deliberately implemented by later tasks, never inferred from a suffix.
  'cosa-in1', 'cosa-in2', 'cosa-net', 'cosa-ou1', 'cosa-ou2', 'south-dat',
  'leica-gsi8', 'leica-gsi16', 'leica-hexml',
  'trimble-jobxml', 'trimble-m5',
  'tds-raw', 'carlson-rw5', 'sokkia-sdr', 'topcon-gts7', 'topcon-fc5',
  'nikon-raw', 'spectra-survey-pro', 'landxml',
  'survey-cloud-suc',
  'rinex-observation', 'rinex-navigation', 'rinex-meteorological', 'rinex-clock', 'hatanaka-rinex',
  'sinex', 'nmea-0183', 'rtcm2', 'rtcm3', 'sp3', 'ionex', 'antex',
  'ublox-ubx', 'novatel-oem', 'septentrio-sbf', 'binex', 'javad-jps', 'topcon-tps',
  'south-sth', 'hitarget-zhd', 'chcnav-hcn', 'comnav-cnb',
  'trimble-t00', 'trimble-t01', 'trimble-t02', 'trimble-t04', 'trimble-job', 'leica-dbx', 'leica-mdb',
  'unknown'
])
export type SurveyFormatIdV1 = z.infer<typeof SurveyFormatIdV1>

export const SurveyImportDispositionV1 = z.enum([
  'adjustment-ready',
  'gnss-processing-required',
  'converter-required',
  'archive-only'
])
export type SurveyImportDispositionV1 = z.infer<typeof SurveyImportDispositionV1>

export const SurveyFormatDetectionMethodV1 = z.enum([
  'content-signature',
  'structural-probe',
  'extension-fallback'
])
export type SurveyFormatDetectionMethodV1 = z.infer<typeof SurveyFormatDetectionMethodV1>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function inferredDetectionMethod(value: Record<string, unknown>): SurveyFormatDetectionMethodV1 {
  const signatures = Array.isArray(value.matchedSignatures) ? value.matchedSignatures : []
  return signatures.some((signature) => typeof signature === 'string' && /extension$/i.test(signature))
    ? 'extension-fallback'
    : 'content-signature'
}

export const SurveyFormatDetectionCreateV1 = z.object({
  format: SurveyFormatIdV1,
  vendor: z.string().min(1),
  version: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  extension: z.string().optional(),
  matchedSignatures: z.array(z.string().min(1)).max(20),
  extensionConflict: z.boolean().default(false),
  /** Actual tier used for the result; never silently inferred by consumers. */
  method: SurveyFormatDetectionMethodV1
}).strict()
export const SurveyFormatDetectionV1 = z.preprocess((input) => {
  const value = asRecord(input)
  if (!value) return input
  return { ...value, method: value.method ?? inferredDetectionMethod(value) }
}, SurveyFormatDetectionCreateV1)
export type SurveyFormatDetectionV1 = z.infer<typeof SurveyFormatDetectionV1>

/** Additive presentation metadata. Original audit messages remain unchanged. */
export const SurveyLocalizedDiagnosticV1 = z.object({
  en: z.object({
    message: z.string().min(1),
    suggestedAction: z.string().min(1).max(2_000).optional()
  }).strict()
}).strict()

export const SurveyImportDiagnosticV1 = z.object({
  code: z.enum([
    'format_detected', 'format_conflict', 'unknown_format', 'invalid_record',
    'record_ignored', 'limit_exceeded', 'unsafe_archive', 'encoding_detected',
    'gnss_processing_required', 'converter_required', 'missing_geometry',
    'missing_datum', 'missing_covariance', 'mapping_required'
  ]),
  severity: z.enum(['info', 'warning', 'blocking']),
  message: z.string().min(1),
  localized: SurveyLocalizedDiagnosticV1.optional(),
  sourceRecord: z.number().int().positive().optional(),
  byteOffset: z.number().int().nonnegative().optional(),
  /** Stable ID of the corresponding raw-record anchor, when one exists. */
  recordAnchor: z.string().min(1).optional(),
  /** A recoverable next action. The diagnostic catalogue is completed in A-23. */
  suggestedAction: z.string().min(1).max(2_000).optional()
}).strict()
export type SurveyImportDiagnosticV1 = z.infer<typeof SurveyImportDiagnosticV1>

export const SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS = 2_048 as const
export const SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_ENTRIES = 10_000 as const
export const SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_BYTES = 8 * 1024 * 1024
export const SURVEY_EXTENSION_FALLBACK_MAX_CONFIDENCE = 0.5 as const

export const SurveyRawRecordAnchorCreateV1 = z.object({
  id: z.string().min(1),
  sourceRecord: z.number().int().positive(),
  line: z.number().int().positive().optional(),
  byteOffset: z.number().int().nonnegative().optional(),
  byteLength: z.number().int().nonnegative().optional(),
  section: z.string().optional(),
  recordType: z.string().optional(),
  /** Byte offset and length are the immutable source-record locator. */
  rawOffset: z.number().int().nonnegative(),
  rawLength: z.number().int().positive(),
  /** Text records additionally carry the original one-based line number. */
  rawLineNo: z.number().int().positive().optional(),
  /** Bounded, review-only excerpt; the original stays in Attachment Store. */
  rawSnippet: z.string().max(SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS)
}).strict()
const SurveyRawRecordAnchorReadShapeV1 = SurveyRawRecordAnchorCreateV1.extend({
  // Pre-contract records had no byte length. Preserve their read path without
  // allowing newly produced records to claim a zero-length source location.
  rawLength: z.number().int().nonnegative()
})
export const SurveyRawRecordAnchorV1 = z.preprocess((input) => {
  const value = asRecord(input)
  if (!value) return input
  const line = typeof value.line === 'number' ? value.line : undefined
  const byteOffset = typeof value.byteOffset === 'number' ? value.byteOffset : 0
  const byteLength = typeof value.byteLength === 'number' ? value.byteLength : 0
  return {
    ...value,
    rawOffset: value.rawOffset ?? byteOffset,
    rawLength: value.rawLength ?? byteLength,
    rawLineNo: value.rawLineNo ?? line,
    rawSnippet: value.rawSnippet ?? ''
  }
}, SurveyRawRecordAnchorReadShapeV1)
export type SurveyRawRecordAnchorV1 = z.infer<typeof SurveyRawRecordAnchorV1>

const SurveyRawFieldValueV1 = z.union([z.string(), z.number(), z.boolean(), z.null()])

/**
 * Persisted, per-observation correction ledger.  Source importers set a flag
 * only when the source proves that the corresponding correction was already
 * applied; downstream reduction code must reject a second application.
 *
 * This is intentionally a plain JSON shape rather than the branded in-memory
 * helper in `survey-units.ts`, so it can be carried through networks,
 * evidence, and manifests without losing auditability.
 */
export const SurveyCorrectionStateV1 = z.object({
  ppmApplied: z.boolean().default(false),
  prismConstantApplied: z.boolean().default(false),
  additiveConstantApplied: z.boolean().default(false),
  meteoApplied: z.boolean().default(false),
  slopeToHorizontalApplied: z.boolean().default(false),
  earthCurvatureRefractionApplied: z.boolean().default(false),
  centeringApplied: z.boolean().default(false),
  projectionReductionApplied: z.boolean().default(false)
}).strict()
export type SurveyCorrectionStateV1 = z.infer<typeof SurveyCorrectionStateV1>

/** Canonical persisted state for a source that supplies no applied correction evidence. */
export const EMPTY_SURVEY_CORRECTION_STATE: SurveyCorrectionStateV1 = Object.freeze({
  ppmApplied: false,
  prismConstantApplied: false,
  additiveConstantApplied: false,
  meteoApplied: false,
  slopeToHorizontalApplied: false,
  earthCurvatureRefractionApplied: false,
  centeringApplied: false,
  projectionReductionApplied: false
})

export const SurveyPreservedRawFieldsV1 = z.record(z.string().min(1).max(256), SurveyRawFieldValueV1)
  .superRefine((fields, context) => {
    if (Object.keys(fields).length > SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_ENTRIES) {
      context.addIssue({ code: 'custom', message: `preservedRawFields exceeds ${SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_ENTRIES} entries` })
    }
    if (new TextEncoder().encode(JSON.stringify(fields)).byteLength > SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_BYTES) {
      context.addIssue({ code: 'custom', message: `preservedRawFields exceeds ${SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_BYTES} bytes` })
    }
  })
export type SurveyPreservedRawFieldsV1 = z.infer<typeof SurveyPreservedRawFieldsV1>

export const SurveySourceSummaryV1 = z.object({
  pointCount: z.number().int().nonnegative(),
  stationCount: z.number().int().nonnegative(),
  observationCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  skippedRecordCount: z.number().int().nonnegative()
}).strict()
export type SurveySourceSummaryV1 = z.infer<typeof SurveySourceSummaryV1>

export const SurveyFileGroupDescriptorV1 = z.object({
  name: z.string().trim().min(1).max(1_024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative().max(64 * 1024 * 1024)
}).strict()
export type SurveyFileGroupDescriptorV1 = z.infer<typeof SurveyFileGroupDescriptorV1>

export const CosaFileGroupInspectionRequestV1 = z.object({
  files: z.array(SurveyFileGroupDescriptorV1).min(1).max(64)
}).strict()
export type CosaFileGroupInspectionRequestV1 = z.infer<typeof CosaFileGroupInspectionRequestV1>

const SurveyConverterProvenanceBaseV1 = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  executableHash: z.string().min(1),
  inputHash: z.string().min(1),
  outputHash: z.string().min(1).optional(),
  networkAccess: z.literal('none'),
  arguments: z.array(z.string()).max(50),
  status: z.enum(['passed', 'blocked'])
}).strict()
export const SurveyConverterProvenanceV1 = z.discriminatedUnion('origin', [
  SurveyConverterProvenanceBaseV1.extend({
    origin: z.literal('user-supplied')
  }),
  SurveyConverterProvenanceBaseV1.extend({
    origin: z.literal('workwise-bundled'),
    license: z.string().min(1)
  })
])
export type SurveyConverterProvenanceV1 = z.infer<typeof SurveyConverterProvenanceV1>

const SurveyConverterManifestBaseV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  id: z.string().min(1),
  version: z.string().min(1),
  auditReference: z.string().min(1),
  executablePath: z.string().min(1).refine((value) => value.startsWith('/'), { message: 'converter executablePath must be an absolute local path' }),
  executableHash: z.string().regex(/^[0-9a-f]{64}$/),
  inputFormats: z.array(SurveyFormatIdV1).min(1).max(20),
  outputFormat: SurveyFormatIdV1,
  outputExtension: z.string().regex(/^\.[a-z0-9]{1,12}$/),
  arguments: z.array(z.string().min(1)).min(1).max(50)
    .refine((values) => values.some((value) => value.includes('{input}')), { message: 'converter arguments require {input}' })
    .refine((values) => values.some((value) => value.includes('{output}')), { message: 'converter arguments require {output}' }),
  timeoutMs: z.number().int().min(1_000).max(120_000),
  maxOutputBytes: z.number().int().min(1).max(128 * 1024 * 1024),
  networkAccess: z.literal('none')
}).strict()
export const SurveyConverterManifestV1 = z.discriminatedUnion('origin', [
  SurveyConverterManifestBaseV1.extend({
    origin: z.literal('user-supplied')
  }),
  SurveyConverterManifestBaseV1.extend({
    origin: z.literal('workwise-bundled'),
    license: z.string().min(1),
    redistributionApproved: z.literal(true)
  })
])
export type SurveyConverterManifestV1 = z.infer<typeof SurveyConverterManifestV1>

/** Immutable identity of the original bytes consumed by a converter. */
export const SurveyConversionInputV1 = z.object({
  sourcePath: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  originalPreserved: z.literal(true),
  formatId: SurveyFormatIdV1,
  vendor: z.string().min(1),
  formatVersion: z.string().min(1).nullable(),
  detectionMethod: SurveyFormatDetectionMethodV1,
  detectionConfidence: z.number().min(0).max(1),
  extensionClaimed: z.string().min(1).nullable(),
  extensionContentConflict: z.boolean(),
  detection: SurveyFormatDetectionV1
}).strict().superRefine((input, context) => {
  if (input.size !== input.fileSize) context.addIssue({ code: 'custom', path: ['fileSize'], message: 'fileSize must equal legacy size alias' })
  if (input.formatId !== input.detection.format) context.addIssue({ code: 'custom', path: ['formatId'], message: 'formatId must equal detection.format' })
  if (input.vendor !== input.detection.vendor) context.addIssue({ code: 'custom', path: ['vendor'], message: 'vendor must equal detection.vendor' })
  if (input.formatVersion !== (input.detection.version ?? null)) context.addIssue({ code: 'custom', path: ['formatVersion'], message: 'formatVersion must equal detection.version' })
  if (input.detectionMethod !== input.detection.method) context.addIssue({ code: 'custom', path: ['detectionMethod'], message: 'detectionMethod must equal detection.method' })
  if (input.detectionConfidence !== input.detection.confidence) context.addIssue({ code: 'custom', path: ['detectionConfidence'], message: 'detectionConfidence must equal detection.confidence' })
  if (input.extensionClaimed !== (input.detection.extension ?? null)) context.addIssue({ code: 'custom', path: ['extensionClaimed'], message: 'extensionClaimed must equal detection.extension' })
  if (input.extensionContentConflict !== input.detection.extensionConflict) context.addIssue({ code: 'custom', path: ['extensionContentConflict'], message: 'extensionContentConflict must equal detection.extensionConflict' })
})
export type SurveyConversionInputV1 = z.infer<typeof SurveyConversionInputV1>

const SurveySourceFileCreateShapeV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  /** Stable logical original location; it avoids persisting a user-machine path. */
  sourcePath: z.string().min(1),
  name: z.string().min(1),
  /** Legacy alias retained for records persisted before the contract freeze. */
  size: z.number().int().nonnegative(),
  fileSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  importedAt: z.string().min(1),
  importedBy: z.string().min(1),
  originalPreserved: z.literal(true),
  /** Flattened format identity is the frozen cross-layer contract. */
  formatId: SurveyFormatIdV1,
  vendor: z.string().min(1),
  formatVersion: z.string().min(1).nullable(),
  detectionMethod: SurveyFormatDetectionMethodV1,
  detectionConfidence: z.number().min(0).max(1),
  extensionClaimed: z.string().min(1).nullable(),
  extensionContentConflict: z.boolean(),
  /** Extension-only identification never bypasses an explicit human review. */
  requiresManualConfirmation: z.boolean(),
  detection: SurveyFormatDetectionV1,
  disposition: SurveyImportDispositionV1,
  dispositionReason: z.string().min(1),
  dispositionReasonEn: z.string().min(1).optional(),
  parserId: z.string().min(1),
  parserVersion: z.string().min(1),
  parserSourceHash: z.string().min(1),
  /** Flattened converter identity keeps the audit chain queryable without
   * decoding the optional, richer converter provenance object. */
  converterId: z.string().min(1).optional(),
  converterVersion: z.string().min(1).optional(),
  converterBinaryHash: z.string().min(1).optional(),
  linearUnitRaw: z.string().min(1).max(120),
  angularUnitRaw: z.string().min(1).max(120),
  /** `unverified` means no source-to-canonical conversion claim was made. */
  linearUnitCanonical: z.enum(['m', 'unverified']),
  /** `unverified` means no source-to-canonical conversion claim was made. */
  angularUnitCanonical: z.enum(['rad', 'unverified']),
  datumDeclared: z.string().min(1).nullable(),
  heightSystemDeclared: z.string().min(1).nullable(),
  recordCount: z.number().int().nonnegative(),
  summary: SurveySourceSummaryV1,
  /** Canonical name from the frozen contract. */
  records: z.array(SurveyRawRecordAnchorCreateV1).max(100_000),
  /** Compatibility alias for records written before the contract freeze. */
  diagnostics: z.array(SurveyImportDiagnosticV1).max(2_000),
  rawRecordAnchors: z.array(SurveyRawRecordAnchorCreateV1).max(100_000),
  preservedRawFields: SurveyPreservedRawFieldsV1,
  converter: SurveyConverterProvenanceV1.optional(),
  /** Present only when this source is the actual output of a conversion. */
  conversionInput: SurveyConversionInputV1.optional()
}).strict()

/**
 * Full write contract for newly ingested source files. It deliberately keeps
 * source units separate from canonical units and rejects an apparently ready
 * source that still carries a blocking diagnostic.
 */
export const SurveySourceFileCreateV1 = SurveySourceFileCreateShapeV1.superRefine((source, context) => {
  const add = (path: Array<string | number>, message: string) => context.addIssue({ code: 'custom', path, message })
  if (source.fileSize !== source.size) add(['fileSize'], 'fileSize must equal legacy size alias')
  if (source.formatId !== source.detection.format) add(['formatId'], 'formatId must equal detection.format')
  if (source.vendor !== source.detection.vendor) add(['vendor'], 'vendor must equal detection.vendor')
  if (source.formatVersion !== (source.detection.version ?? null)) add(['formatVersion'], 'formatVersion must equal detection.version')
  if (source.detectionMethod !== source.detection.method) add(['detectionMethod'], 'detectionMethod must equal detection.method')
  if (source.detectionConfidence !== source.detection.confidence) add(['detectionConfidence'], 'detectionConfidence must equal detection.confidence')
  if (source.extensionClaimed !== (source.detection.extension ?? null)) add(['extensionClaimed'], 'extensionClaimed must equal detection.extension')
  if (source.extensionContentConflict !== source.detection.extensionConflict) add(['extensionContentConflict'], 'extensionContentConflict must equal detection.extensionConflict')
  if (source.detectionMethod === 'extension-fallback') {
    if (source.detectionConfidence > SURVEY_EXTENSION_FALLBACK_MAX_CONFIDENCE) {
      add(['detectionConfidence'], `extension-fallback confidence must be at most ${SURVEY_EXTENSION_FALLBACK_MAX_CONFIDENCE}`)
    }
    if (!source.requiresManualConfirmation) add(['requiresManualConfirmation'], 'extension-fallback requires manual confirmation')
    if (source.disposition === 'adjustment-ready') add(['disposition'], 'extension-fallback cannot automatically be adjustment-ready')
  }
  if (source.summary.recordCount !== source.recordCount) add(['summary', 'recordCount'], 'summary.recordCount must equal recordCount')
  if (source.records.length !== source.rawRecordAnchors.length || source.records.some((record, index) => JSON.stringify(record) !== JSON.stringify(source.rawRecordAnchors[index]))) {
    add(['records'], 'records must mirror the legacy rawRecordAnchors alias')
  }
  source.records.forEach((record, index) => {
    if (record.rawOffset + record.rawLength > source.fileSize) {
      add(['records', index, 'rawLength'], 'raw record byte range must fit within fileSize')
    }
  })
  const converterAliases = [source.converterId, source.converterVersion, source.converterBinaryHash]
  if (converterAliases.some((value) => value !== undefined) && converterAliases.some((value) => value === undefined)) {
    add(['converterId'], 'converterId, converterVersion and converterBinaryHash must be recorded together')
  }
  if (source.converter) {
    if (source.converterId !== source.converter.id) add(['converterId'], 'converterId must equal converter.id')
    if (source.converterVersion !== source.converter.version) add(['converterVersion'], 'converterVersion must equal converter.version')
    if (source.converterBinaryHash !== source.converter.executableHash) add(['converterBinaryHash'], 'converterBinaryHash must equal converter.executableHash')
  }
  if (source.conversionInput) {
    if (!source.converter) add(['converter'], 'converted source files require converter provenance')
    if (source.converter?.status !== 'passed') add(['converter', 'status'], 'converted source files require passed converter provenance')
    if (source.converter?.inputHash !== source.conversionInput.sha256) add(['conversionInput', 'sha256'], 'conversionInput.sha256 must equal converter.inputHash')
    if (source.converter?.outputHash !== source.sha256) add(['sha256'], 'converted source sha256 must equal converter.outputHash')
  }
  if (source.disposition === 'adjustment-ready' && source.diagnostics.some((item) => item.severity === 'blocking')) {
    add(['disposition'], 'adjustment-ready source files cannot carry blocking diagnostics')
  }
  if (source.disposition === 'adjustment-ready' && source.linearUnitCanonical !== 'm') {
    add(['linearUnitCanonical'], 'adjustment-ready source files require confirmed metre canonical units')
  }
  if (source.disposition === 'adjustment-ready' && source.angularUnitCanonical !== 'rad') {
    add(['angularUnitCanonical'], 'adjustment-ready source files require confirmed radian canonical units')
  }
})

/**
 * Structural read schema: old persisted records are enriched in memory but
 * are not retroactively rejected by write-time safety invariants.
 */
const SurveySourceFileReadShapeV1 = SurveySourceFileCreateShapeV1.extend({
  records: z.array(SurveyRawRecordAnchorV1).max(100_000),
  rawRecordAnchors: z.array(SurveyRawRecordAnchorV1).max(100_000)
})

function legacySourceFileDefaults(input: unknown): unknown {
  const value = asRecord(input)
  if (!value) return input
  const detection = asRecord(value.detection)
  const anchors = Array.isArray(value.rawRecordAnchors) ? value.rawRecordAnchors : []
  const records = Array.isArray(value.records) ? value.records : anchors
  const recordCount = typeof value.recordCount === 'number' ? value.recordCount : 0
  const size = typeof value.size === 'number' ? value.size : typeof value.fileSize === 'number' ? value.fileSize : undefined
  const detectionFormat = detection?.format
  const detectionVendor = detection?.vendor
  const detectionVersion = typeof detection?.version === 'string' ? detection.version : null
  const detectionExtension = typeof detection?.extension === 'string' ? detection.extension : null
  const detectionConfidence = typeof detection?.confidence === 'number' ? detection.confidence : undefined
  const extensionConflict = typeof detection?.extensionConflict === 'boolean' ? detection.extensionConflict : false
  const summary = asRecord(value.summary)
  return {
    ...value,
    sourcePath: value.sourcePath ?? (typeof value.sha256 === 'string' ? `attachment://sha256/${value.sha256}` : value.sourcePath),
    size,
    fileSize: value.fileSize ?? size,
    importedAt: value.importedAt ?? 'legacy-unknown',
    importedBy: value.importedBy ?? 'legacy-read-adapter',
    formatId: value.formatId ?? detectionFormat,
    vendor: value.vendor ?? detectionVendor,
    formatVersion: value.formatVersion ?? detectionVersion,
    detectionMethod: value.detectionMethod ?? (detection ? inferredDetectionMethod(detection) : undefined),
    detectionConfidence: value.detectionConfidence ?? detectionConfidence,
    extensionClaimed: value.extensionClaimed ?? detectionExtension,
    extensionContentConflict: value.extensionContentConflict ?? extensionConflict,
    requiresManualConfirmation: value.requiresManualConfirmation ?? (value.detectionMethod === 'extension-fallback' || (detection ? inferredDetectionMethod(detection) === 'extension-fallback' : false)),
    detection: detection ? { ...detection, method: detection.method ?? inferredDetectionMethod(detection) } : value.detection,
    dispositionReason: value.dispositionReason ?? 'legacy source record imported before the SurveySourceFile contract freeze',
    parserSourceHash: value.parserSourceHash ?? 'legacy-unavailable',
    linearUnitRaw: value.linearUnitRaw ?? 'legacy-unknown',
    angularUnitRaw: value.angularUnitRaw ?? 'legacy-unknown',
    // A legacy record did not make a source-to-canonical conversion claim.
    // Preserve its readability without promoting it through a later safety
    // gate as if it had been re-imported by an audited parser.
    linearUnitCanonical: value.linearUnitCanonical ?? 'unverified',
    angularUnitCanonical: value.angularUnitCanonical ?? 'unverified',
    datumDeclared: value.datumDeclared ?? null,
    heightSystemDeclared: value.heightSystemDeclared ?? null,
    summary: {
      pointCount: summary?.pointCount ?? 0,
      stationCount: summary?.stationCount ?? 0,
      observationCount: summary?.observationCount ?? 0,
      recordCount: summary?.recordCount ?? recordCount,
      skippedRecordCount: summary?.skippedRecordCount ?? 0
    },
    records: records.map((anchor) => {
      const rawAnchor = asRecord(anchor)
      if (!rawAnchor) return anchor
      const byteOffset = typeof rawAnchor.byteOffset === 'number' ? rawAnchor.byteOffset : 0
      const byteLength = typeof rawAnchor.byteLength === 'number' ? rawAnchor.byteLength : 0
      return {
        ...rawAnchor,
        rawOffset: rawAnchor.rawOffset ?? byteOffset,
        rawLength: rawAnchor.rawLength ?? byteLength,
        rawLineNo: rawAnchor.rawLineNo ?? rawAnchor.line,
        rawSnippet: rawAnchor.rawSnippet ?? ''
      }
    }),
    rawRecordAnchors: anchors.length ? anchors.map((anchor) => {
      const rawAnchor = asRecord(anchor)
      if (!rawAnchor) return anchor
      const byteOffset = typeof rawAnchor.byteOffset === 'number' ? rawAnchor.byteOffset : 0
      const byteLength = typeof rawAnchor.byteLength === 'number' ? rawAnchor.byteLength : 0
      return {
        ...rawAnchor,
        rawOffset: rawAnchor.rawOffset ?? byteOffset,
        rawLength: rawAnchor.rawLength ?? byteLength,
        rawLineNo: rawAnchor.rawLineNo ?? rawAnchor.line,
        rawSnippet: rawAnchor.rawSnippet ?? ''
      }
    }) : records.map((anchor) => {
      const rawAnchor = asRecord(anchor)
      if (!rawAnchor) return anchor
      const byteOffset = typeof rawAnchor.byteOffset === 'number' ? rawAnchor.byteOffset : 0
      const byteLength = typeof rawAnchor.byteLength === 'number' ? rawAnchor.byteLength : 0
      return {
        ...rawAnchor,
        rawOffset: rawAnchor.rawOffset ?? byteOffset,
        rawLength: rawAnchor.rawLength ?? byteLength,
        rawLineNo: rawAnchor.rawLineNo ?? rawAnchor.line,
        rawSnippet: rawAnchor.rawSnippet ?? ''
      }
    }),
    converterId: value.converterId ?? (typeof asRecord(value.converter)?.id === 'string' ? asRecord(value.converter)!.id : undefined),
    converterVersion: value.converterVersion ?? (typeof asRecord(value.converter)?.version === 'string' ? asRecord(value.converter)!.version : undefined),
    converterBinaryHash: value.converterBinaryHash ?? (typeof asRecord(value.converter)?.executableHash === 'string' ? asRecord(value.converter)!.executableHash : undefined),
    preservedRawFields: value.preservedRawFields ?? {}
  }
}

/**
 * Read adapter for legacy persisted records. It enriches the parsed result in
 * memory only; callers never rewrite an old source record merely by reading it.
 */
export const SurveySourceFileV1 = z.preprocess(legacySourceFileDefaults, SurveySourceFileReadShapeV1)
export type SurveySourceFileV1 = z.infer<typeof SurveySourceFileV1>

export const SurveyProjectV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  discipline: z.string().min(1).default('survey'),
  coordinateSystem: z.string().min(1).default('CGCS2000'),
  projection: z.string().min(1).default('Gauss-Kruger'),
  centralMeridian: z.number().finite().optional(),
  ellipsoid: z.string().min(1).default('CGCS2000'),
  verticalDatum: z.string().min(1).default('1985 National Height Datum'),
  unit: z.string().min(1).default('m'),
  signConvention: z.string().min(1).default('positive-up'),
  accuracyClass: z.string().min(1).default('engineering'),
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict()
export type SurveyProjectV1 = z.infer<typeof SurveyProjectV1>

export const SurveyPointV1 = z.object({
  id: z.string().min(1),
  pointClass: z.enum(['known', 'unknown', 'check', 'station']).default('unknown'),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  height: z.number().finite().optional(),
  /** Geodetic latitude/longitude in decimal degrees for Gauss-Kruger
   * projection. Cartesian adjustment values continue to use x/y/height. */
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  known: z.boolean().default(false),
  sourceRow: z.number().int().positive().optional(),
  sourceLocator: z.string().optional(),
  rawFields: z.record(z.string(), SurveyRawFieldValueV1).optional()
}).strict()
export type SurveyPointV1 = z.infer<typeof SurveyPointV1>

/** Explicit user-confirmed control-point values for a source that does not
 * carry datum labels (for example an instrument export with a sidecar
 * benchmark list).  This is an input mapping, not a source-record claim. */
export const SurveyKnownPointInputV1 = z.object({
  id: z.string().min(1),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  height: z.number().finite().optional(),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional()
}).strict().refine((point) => point.x !== undefined || point.y !== undefined || point.height !== undefined || point.latitude !== undefined || point.longitude !== undefined, {
  message: 'a known point mapping must provide at least one coordinate or height value'
})
export type SurveyKnownPointInputV1 = z.infer<typeof SurveyKnownPointInputV1>

export const SurveyObservationV1 = z.object({
  id: z.string().min(1),
  type: z.enum(['height-difference', 'distance', 'direction', 'angle', 'zenith', 'slope-distance', 'gnss-baseline', 'coordinate-pair']),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  station: z.string().min(1).optional(),
  target: z.string().min(1).optional(),
  left: z.string().min(1).optional(),
  right: z.string().min(1).optional(),
  value: z.number().finite(),
  unit: z.string().min(1).default('m'),
  /** GNSS baseline components in `unit`. `value` remains required as the
   * legacy scalar field so older stored observations stay readable, but a
   * GNSS adjustment requires all three vector components. */
  vectorX: z.number().finite().optional(),
  vectorY: z.number().finite().optional(),
  vectorZ: z.number().finite().optional(),
  /** Optional target coordinates used when fitting a coordinate transform. */
  targetX: z.number().finite().optional(),
  targetY: z.number().finite().optional(),
  targetHeight: z.number().finite().optional(),
  /** Instrument/prism offsets used by slope-distance and zenith models. */
  stationHeightOffset: z.number().finite().optional(),
  targetHeightOffset: z.number().finite().optional(),
  sigma: z.number().positive().optional(),
  /** Unit of sigma. Length observations default to the observation unit;
   * angular observations default to arc-seconds for legacy compatibility. */
  sigmaUnit: z.string().min(1).optional(),
  /** Observation covariance in row-major order and observation-unit squared.
   * GNSS baselines require a complete symmetric positive-definite 3 x 3
   * matrix; the loose array shape preserves legacy records so the strategy
   * can return a stable quality finding instead of failing schema parsing. */
  covariance: z.array(z.number().finite()).optional(),
  /**
   * Additive source-provenance ledger. It remains optional for legacy
   * observations; all new professional format importers must provide it.
   */
  correctionState: SurveyCorrectionStateV1.optional(),
  routeLength: z.number().positive().optional(),
  face: z.enum(['left', 'right', 'single']).optional(),
  timestamp: z.string().optional(),
  setupId: z.string().optional(),
  set: z.number().int().nonnegative().optional(),
  round: z.number().int().nonnegative().optional(),
  qualityFlags: z.array(z.string()).max(50).optional(),
  sourceRow: z.number().int().positive().optional(),
  sourceLocator: z.string().optional(),
  sourceRecordId: z.string().optional(),
  rawFields: z.record(z.string(), SurveyRawFieldValueV1).optional()
}).strict()
export type SurveyObservationV1 = z.infer<typeof SurveyObservationV1>

export const SurveyQualityFindingV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  id: z.string().min(1),
  networkId: z.string().min(1),
  code: z.enum([
    'missing_point', 'disconnected_network', 'unit_conflict', 'rank_deficient',
    'closure_exceeded', 'outlier_candidate', 'missing_covariance', 'missing_datum',
    'invalid_observation', 'dimension_limit', 'missing_baseline', 'insufficient_redundancy',
    'malformed_geometry', 'not_converged', 'format_detected', 'format_conflict', 'unknown_format',
    'record_ignored',
    'gnss_processing_required', 'converter_required', 'mapping_required', 'source_not_adjustment_ready', 'raw_source_integrity', 'parse_error'
  ]),
  severity: z.enum(['blocking', 'warning', 'info']),
  message: z.string().min(1),
  localized: SurveyLocalizedDiagnosticV1.optional(),
  suggestion: z.string().min(1),
  row: z.number().int().positive().optional(),
  status: z.enum(['open', 'resolved', 'accepted']).default('open'),
  createdAt: z.string().min(1)
}).strict()
export type SurveyQualityFindingV1 = z.infer<typeof SurveyQualityFindingV1>

export const SurveyNetworkV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  id: z.string().min(1),
  projectId: z.string().min(1),
  networkType: SurveyNetworkTypeV1,
  /** Explicit coordinate transformation strategy. Optional only for reading
   * legacy records whose strategy can be inferred without ambiguity. */
  transformType: CoordinateTransformTypeV1.optional(),
  /** Survey reference metadata is persisted with the network so a result can
   * be reviewed without relying on the current project form state. Defaults
   * keep older stored networks readable during migration. */
  coordinateSystem: z.string().min(1).default('待确认'),
  projection: z.string().min(1).default('待确认'),
  centralMeridian: z.number().finite().optional(),
  ellipsoid: z.string().min(1).default('待确认'),
  verticalDatum: z.string().min(1).default('待确认'),
  /** Legacy renderer/fixture alias; normalized responses use verticalDatum. */
  heightDatum: z.string().min(1).optional(),
  unit: z.string().min(1).default('m'),
  knownPoints: z.array(SurveyPointV1).max(10_000),
  unknownPoints: z.array(SurveyPointV1).max(10_000),
  observations: z.array(SurveyObservationV1).max(100_000),
  instrumentParameters: z.record(z.string(), z.number().finite()).default({}),
  observationEpoch: z.string().optional(),
  inputAttachmentHash: z.string().min(1).optional(),
  sourceFile: SurveySourceFileV1.optional(),
  qualityStatus: z.enum(['imported', 'validated', 'blocked', 'ready']).default('imported'),
  findings: z.array(SurveyQualityFindingV1).max(2_000).default([]),
  revision: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict()
export type SurveyNetworkV1 = z.infer<typeof SurveyNetworkV1>

/**
 * The only open structured source that may enter the Survey import path
 * without F-FMT-10 column mapping.  This is deliberately an envelope rather
 * than an arbitrary JSON object so a JSON-looking vendor file cannot inherit
 * WorkWise adjustment readiness by syntax alone. In v1 `network.unit` must
 * be metre-equivalent before the registry admits the source: point x/y/height
 * and station/prism height offsets share that coordinate domain, while each
 * observation retains its own explicit `unit`/`sigmaUnit`.
 */
export const WORKWISE_SURVEY_SOURCE_FORMAT = 'workwise-survey-network' as const
export const WORKWISE_SURVEY_SOURCE_FORMAT_VERSION = 1 as const
export const WorkwiseSurveySourceV1 = z.object({
  format: z.literal(WORKWISE_SURVEY_SOURCE_FORMAT),
  formatVersion: z.literal(WORKWISE_SURVEY_SOURCE_FORMAT_VERSION),
  network: SurveyNetworkV1.partial()
}).strict()
export type WorkwiseSurveySourceV1 = z.infer<typeof WorkwiseSurveySourceV1>

/**
 * Immutable, derived corrections are deliberately kept outside the original
 * network payload. A correction can currently target only one scalar
 * observation value; coordinates, GNSS vectors, covariances and arbitrary
 * JSON paths are not mutable through this contract.
 */
export const SURVEY_DERIVED_CORRECTION_SCHEMA_VERSION = 1 as const

const SurveySha256V1 = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 digest')

export const SurveyDerivedCorrectionActorV1 = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(['human', 'kernel'])
}).strict()
export type SurveyDerivedCorrectionActorV1 = z.infer<typeof SurveyDerivedCorrectionActorV1>

export const SurveyDerivedCorrectionBasisV1 = z.object({
  /** Generic provenance only; normative rules and scoring remain commercial-rule-pack work. */
  kind: z.enum(['manual-review', 'instrument-reprocessing', 'other']),
  referenceId: z.string().min(1).max(500),
  evidenceHash: SurveySha256V1.optional()
}).strict()
export type SurveyDerivedCorrectionBasisV1 = z.infer<typeof SurveyDerivedCorrectionBasisV1>

export const SurveyDerivedCorrectionOperationV1 = z.object({
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(200),
  implementationHash: SurveySha256V1.optional()
}).strict()
export type SurveyDerivedCorrectionOperationV1 = z.infer<typeof SurveyDerivedCorrectionOperationV1>

export const SurveyDerivedCorrectionRecordV1 = z.object({
  schemaVersion: z.literal(SURVEY_DERIVED_CORRECTION_SCHEMA_VERSION),
  id: z.string().min(1).max(200),
  networkId: z.string().min(1),
  sequence: z.number().int().positive(),
  target: z.object({
    kind: z.literal('observation-value'),
    observationId: z.string().min(1),
    sourceRecordId: z.string().min(1),
    sourceAnchorId: z.string().min(1)
  }).strict(),
  rawSource: z.object({
    sourceSha256: SurveySha256V1,
    rawSourceLedgerInitialHash: SurveySha256V1,
    rawAnchorDigest: SurveySha256V1
  }).strict(),
  before: z.object({
    value: z.number().finite(),
    unit: z.string().min(1),
    observationSnapshotHash: SurveySha256V1
  }).strict(),
  after: z.object({
    value: z.number().finite(),
    unit: z.string().min(1)
  }).strict(),
  /** Always computed by the service from `after.value - before.value`. */
  delta: z.number().finite(),
  reason: z.string().min(1).max(2_000),
  basis: SurveyDerivedCorrectionBasisV1,
  operation: SurveyDerivedCorrectionOperationV1,
  actor: SurveyDerivedCorrectionActorV1,
  occurredAt: z.string().datetime({ offset: true }),
  /** The first record links to the initial raw-source ledger hash. */
  previousHash: SurveySha256V1,
  thisHash: SurveySha256V1
}).strict().superRefine((record, context) => {
  if (record.before.unit !== record.after.unit) {
    context.addIssue({ code: 'custom', path: ['after', 'unit'], message: 'derived correction units must not change' })
  }
  if (record.delta !== record.after.value - record.before.value) {
    context.addIssue({ code: 'custom', path: ['delta'], message: 'derived correction delta must equal after.value - before.value' })
  }
})
export type SurveyDerivedCorrectionRecordV1 = z.infer<typeof SurveyDerivedCorrectionRecordV1>

export const AdjustmentStatusV1 = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'needs_attention'])
export type AdjustmentStatusV1 = z.infer<typeof AdjustmentStatusV1>

export const AdjustmentRunV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  id: z.string().min(1),
  projectId: z.string().min(1),
  networkId: z.string().min(1),
  method: z.enum(['weighted-least-squares', 'conditional', 'helmert-seven-parameter', 'height-fit']),
  constraint: z.enum(['fixed-known-points', 'free', 'minimum-constraint']).default('fixed-known-points'),
  algorithmVersion: z.string().min(1),
  inputHash: z.string().min(1),
  status: AdjustmentStatusV1,
  revision: z.number().int().positive(),
  idempotencyKey: z.string().min(8),
  cancellationReason: z.string().optional(),
  resumeCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  completedAt: z.string().optional()
}).strict()
export type AdjustmentRunV1 = z.infer<typeof AdjustmentRunV1>

/** Standard (unit-Mahalanobis-radius) ellipse in the solved X/Y plane.
 * It is not a 68% or 95% confidence region and does not imply ENU for GNSS. */
export const SurveyXyErrorEllipseV1 = z.object({
  algorithmVersion: z.literal('survey-xy-error-ellipse-1'),
  coordinatePlane: z.literal('solution-xy'),
  covarianceUnit: z.literal('m2'),
  covarianceXY: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  semiMajor: z.number().finite().nonnegative(),
  semiMinor: z.number().finite().nonnegative(),
  axisUnit: z.literal('m'),
  orientationRad: z.number().finite().min(0).lt(Math.PI).nullable(),
  orientationConvention: z.literal('positive-x-toward-positive-y-mod-pi'),
  scale: z.literal('unit-mahalanobis-radius'),
  varianceBasis: z.enum(['a-priori', 'a-posteriori'])
}).strict().refine(value => value.semiMajor >= value.semiMinor, { message: 'Ellipse major axis must not be smaller than its minor axis' })
export type SurveyXyErrorEllipseV1 = z.infer<typeof SurveyXyErrorEllipseV1>

export const AdjustmentPointResultV1 = z.object({
  id: z.string().min(1),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  height: z.number().finite().optional(),
  latitude: z.number().finite().min(-90).max(90).optional(),
  longitude: z.number().finite().min(-180).max(180).optional(),
  correctionX: z.number().finite().optional(),
  correctionY: z.number().finite().optional(),
  correctionHeight: z.number().finite().optional(),
  standardError: z.number().nonnegative().optional(),
  covariance: z.array(z.number().finite()).optional(),
  xyErrorEllipse: SurveyXyErrorEllipseV1.optional()
}).strict()

export const AdjustmentObservationResultV1 = z.object({
  observationId: z.string().min(1),
  correction: z.number().finite(),
  residual: z.number().finite(),
  /** Corrections and residuals are emitted in canonical Runtime units.
   * Optional for adjustment records created before 0.5.0. */
  unit: z.enum(['m', 'rad']).optional(),
  standardizedResidual: z.number().finite().optional(),
  standardizedResidualUnit: z.literal('sigma').default('sigma'),
  outlier: z.boolean().default(false),
  sourceRow: z.number().int().positive().optional(),
  /** Immutable source-record anchor inherited from the adjusted observation. */
  sourceRecordId: z.string().min(1).optional()
}).strict()

export const AdjustmentDisplacementV1 = z.object({
  pointId: z.string().min(1),
  dX: z.number().finite().optional(),
  dY: z.number().finite().optional(),
  dH: z.number().finite().optional(),
  magnitude: z.number().nonnegative(),
  kind: z.enum(['horizontal', 'vertical', 'three-dimensional']).default('horizontal')
}).strict()
export type AdjustmentDisplacementV1 = z.infer<typeof AdjustmentDisplacementV1>

export const AdjustmentResultV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  id: z.string().min(1),
  runId: z.string().min(1),
  networkId: z.string().min(1),
  observationCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  redundancy: z.number().int().nonnegative(),
  degreesOfFreedom: z.number().int().nonnegative(),
  /** Coordinates, heights, corrections, displacements and point standard
   * errors are normalized to metres before entering the numeric kernel. */
  linearUnit: z.literal('m').default('m'),
  /** Direction and angle residuals are normalized to radians. */
  angularUnit: z.literal('rad').default('rad'),
  closure: z.record(z.string(), z.number().finite()).default({}),
  /** Per-key units avoid assigning a linear unit to mixed-network angular
   * residual norms or to dimensionless relative closures. */
  closureUnits: z.record(z.string(), z.enum(['m', 'rad', 'ppm', 'ratio'])).default({}),
  /** Solved non-coordinate parameters such as per-station orientation. */
  parameters: z.record(z.string(), z.number().finite()).default({}),
  parameterUnits: z.record(z.string(), z.enum(['m', 'rad', 'ppm', 'ratio'])).default({}),
  unitWeightStdDev: z.number().nonnegative(),
  /** Unit-weight standard deviation and variance factor are statistical
   * scale values, never coordinate or height measurements. Defaults keep
   * legacy records readable without rewriting their stored JSON. */
  unitWeightStdDevUnit: z.literal('dimensionless').default('dimensionless'),
  varianceFactor: z.number().nonnegative(),
  varianceFactorUnit: z.literal('dimensionless').default('dimensionless'),
  /** False means the a-priori unit variance is retained because the network
   * has no redundancy; older records default to false rather than claiming
   * a posterior estimate. */
  varianceFactorEstimated: z.boolean().default(false),
  points: z.array(AdjustmentPointResultV1),
  observations: z.array(AdjustmentObservationResultV1),
  displacements: z.array(AdjustmentDisplacementV1).default([]),
  covariance: z.array(z.array(z.number().finite())).optional(),
  precision: z.object({ maxPointStdDev: z.number().nonnegative(), relativePrecision: z.number().nonnegative().optional(), passed: z.boolean() }).strict(),
  qualityFindings: z.array(SurveyQualityFindingV1),
  inputHash: z.string().min(1),
  algorithmVersion: z.string().min(1),
  validation: z.enum(['valid', 'invalid', 'pending']),
  /** Explicit deterministic strategy used for this run. Kept optional so
   * results written by 0.4.x remain readable during migration. */
  strategyId: SurveyNetworkTypeV1.optional(),
  /** Coordinate-transform sub-strategy; omitted for non-transform and legacy
   * results. */
  transformType: CoordinateTransformTypeV1.optional(),
  solverDiagnostics: z.object({
    iterations: z.number().int().nonnegative().optional(),
    rank: z.number().int().nonnegative().optional(),
    conditionEstimate: z.number().nonnegative().optional(),
    unsupportedReason: z.string().optional()
  }).strict().optional(),
  createdAt: z.string().min(1)
}).strict()
export type AdjustmentResultV1 = z.infer<typeof AdjustmentResultV1>

export const DeformationPairDefinitionV1 = z.object({
  id: z.string().min(1),
  firstPointId: z.string().min(1),
  secondPointId: z.string().min(1),
  kind: z.enum(['tilt', 'convergence']),
  distanceMode: z.enum(['horizontal', 'spatial', 'vertical']).default('horizontal'),
  /** Optional user-approved physical baseline for tilt. When omitted, the
   * reference epoch's horizontal point spacing is used. */
  baselineM: z.number().positive().optional()
}).strict()
  .refine((value) => value.firstPointId !== value.secondPointId, { message: 'deformation pair requires two different points' })
  .refine((value) => value.kind !== 'tilt' || value.distanceMode === 'horizontal', { message: 'tilt requires a horizontal baseline' })
export type DeformationPairDefinitionV1 = z.infer<typeof DeformationPairDefinitionV1>

export const DeformationEpochEvidenceV1 = z.object({
  adjustmentId: z.string().min(1),
  resultId: z.string().min(1),
  networkId: z.string().min(1),
  observationEpoch: z.string().min(1),
  inputHash: z.string().min(1),
  resultHash: z.string().min(1)
}).strict()
export type DeformationEpochEvidenceV1 = z.infer<typeof DeformationEpochEvidenceV1>

export const DeformationPointResultV1 = z.object({
  pointId: z.string().min(1),
  dX: z.number().finite().optional(),
  dY: z.number().finite().optional(),
  dH: z.number().finite().optional(),
  /** Positive settlement means the adjusted height decreased. */
  settlement: z.number().finite().optional(),
  horizontalDisplacement: z.number().nonnegative().optional(),
  spatialDisplacement: z.number().nonnegative(),
  rates: z.object({
    dXPerDay: z.number().finite().optional(),
    dYPerDay: z.number().finite().optional(),
    dHPerDay: z.number().finite().optional(),
    settlementPerDay: z.number().finite().optional(),
    horizontalPerDay: z.number().nonnegative().optional(),
    spatialPerDay: z.number().nonnegative()
  }).strict(),
  trend: z.enum(['settling', 'heaving', 'horizontal-moving', 'stable', 'unknown']),
  combinedStandardError: z.number().nonnegative().optional(),
  standardizedDisplacement: z.number().nonnegative().optional(),
  significant: z.boolean().optional(),
  unit: z.literal('m'),
  rateUnit: z.literal('m/day')
}).strict()
export type DeformationPointResultV1 = z.infer<typeof DeformationPointResultV1>

export const DeformationPairResultV1 = z.object({
  id: z.string().min(1),
  firstPointId: z.string().min(1),
  secondPointId: z.string().min(1),
  kind: z.enum(['tilt', 'convergence']),
  distanceMode: z.enum(['horizontal', 'spatial', 'vertical']),
  referenceDistance: z.number().nonnegative().optional(),
  currentDistance: z.number().nonnegative().optional(),
  /** Positive convergence means the point spacing decreased. */
  convergence: z.number().finite().optional(),
  convergenceRatePerDay: z.number().finite().optional(),
  baselineM: z.number().positive().optional(),
  differentialSettlement: z.number().finite().optional(),
  tilt: z.number().finite().optional(),
  linearUnit: z.literal('m'),
  rateUnit: z.literal('m/day'),
  tiltUnit: z.literal('ratio')
}).strict()
export type DeformationPairResultV1 = z.infer<typeof DeformationPairResultV1>

export const DeformationComparisonV1 = z.object({
  schemaVersion: z.literal(SURVEY_SCHEMA_VERSION),
  id: z.string().min(1),
  projectId: z.string().min(1),
  referenceAdjustmentId: z.string().min(1),
  currentAdjustmentId: z.string().min(1),
  adjustmentIds: z.array(z.string().min(1)).min(2).max(100),
  referenceEpoch: z.string().min(1),
  currentEpoch: z.string().min(1),
  durationDays: z.number().positive(),
  epochs: z.array(DeformationEpochEvidenceV1).min(2).max(100),
  points: z.array(DeformationPointResultV1),
  pairs: z.array(DeformationPairResultV1),
  stabilityRateMPerDay: z.number().nonnegative(),
  inputHash: z.string().min(1),
  algorithmVersion: z.string().min(1),
  createdAt: z.string().min(1)
}).strict()
export type DeformationComparisonV1 = z.infer<typeof DeformationComparisonV1>

export const SkillProvenanceV1 = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceRepository: z.string().min(1),
  sourcePath: z.string().min(1).optional(),
  commit: z.string().min(1),
  license: z.string().min(1),
  licenseFile: z.string().min(1).optional(),
  licenseHash: z.string().min(1).optional(),
  fileHashes: z.record(z.string(), z.string()).default({}),
  treeHash: z.string().min(1).optional(),
  scripts: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  dependencyStatus: z.enum(['passed', 'blocked', 'not-applicable']).default('not-applicable'),
  networkAccess: z.enum(['none', 'controlled', 'external']).default('none'),
  credentialAccess: z.enum(['none', 'reference-only', 'read']).default('none'),
  executionPolicy: z.enum(['sandboxed', 'user-approval-required', 'runtime-adapter-only']).default('sandboxed'),
  permissionReview: z.enum(['passed', 'blocked']).default('blocked'),
  scenarioEvidence: z.object({
    id: z.string().min(1),
    prompt: z.string().min(1),
    expectedEvidence: z.string().min(1),
    testFile: z.string().min(1),
    status: z.enum(['passed', 'blocked'])
  }).strict().optional(),
  aliasFor: z.array(z.string().min(1)).optional(),
  packaged: z.boolean(),
  status: z.enum(['available', 'blocked', 'review']).default('review'),
  reason: z.string().optional()
}).strict()
export type SkillProvenanceV1 = z.infer<typeof SkillProvenanceV1>

export const EngineeringCapabilityV1 = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  category: z.enum(['survey', 'monitoring', 'documents', 'standards', 'cad-bim']),
  skillIds: z.array(z.string()),
  toolIds: z.array(z.string()),
  available: z.boolean(),
  reason: z.string().optional()
}).strict()
export type EngineeringCapabilityV1 = z.infer<typeof EngineeringCapabilityV1>

const CosaIn1ColumnMappingSchemeRequestV1 = z.object({
  schemaVersion: z.literal('survey-column-mapping/v1'),
  mappingId: z.string().trim().min(1).max(128),
  revision: z.number().int().nonnegative(),
  formatId: z.literal('cosa-in1'),
  delimiter: z.enum(['csv', 'csv-fullwidth-comma', 'whitespace']),
  bindings: z.array(z.object({
    field: z.string().trim().min(1).max(128),
    columnIndex: z.number().int().min(0).max(32)
  }).strict()).min(1).max(32)
}).strict()

/** A bounded request shape; parser-level semantic validation remains strict. */
export const CosaIn1MappingRequestV1 = z.object({
  schemaVersion: z.literal('cosa-in1-mapping/v1'),
  heightUnit: z.literal('m'),
  routeLengthUnit: z.literal('km'),
  textEncoding: z.enum(['ascii', 'gb18030']).optional(),
  knownPointRecordCount: z.number().int().min(1).max(10_000).optional(),
  knownPoints: CosaIn1ColumnMappingSchemeRequestV1,
  observations: CosaIn1ColumnMappingSchemeRequestV1
}).strict()
export type CosaIn1MappingRequestV1 = z.infer<typeof CosaIn1MappingRequestV1>

export const SurveyNetworkImportRequest = z.object({
  projectId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200),
  networkType: SurveyNetworkTypeV1.optional(),
  transformType: CoordinateTransformTypeV1.optional(),
  network: SurveyNetworkV1.partial().optional(),
  name: z.string().min(1).optional(),
  dataBase64: z.string().min(1).optional(),
  inputAttachmentHash: z.string().min(1).optional(),
  cosaIn1Mapping: CosaIn1MappingRequestV1.optional(),
  /** Explicit, auditable control-point mapping; never inferred from a sidecar. */
  knownPoints: z.array(SurveyKnownPointInputV1).max(10_000).optional()
}).strict().refine((value) => Boolean(value.network || (value.name && value.dataBase64)), { message: 'network or name/dataBase64 is required' })
export type SurveyNetworkImportRequest = z.infer<typeof SurveyNetworkImportRequest>

export const SurveyNetworkValidateRequest = z.object({ expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(200) }).strict()
export const AdjustmentRequestV1 = z.object({ networkId: z.string().min(1), expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(200), method: AdjustmentRunV1.shape.method.optional(), constraint: AdjustmentRunV1.shape.constraint.optional() }).strict()
export const AdjustmentMutationRequestV1 = z.object({ expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(8).max(200), reason: z.string().max(500).optional() }).strict()
export const DeformationComparisonRequestV1 = z.object({
  projectId: z.string().min(1),
  adjustmentIds: z.array(z.string().min(1)).min(2).max(100),
  pairs: z.array(DeformationPairDefinitionV1).max(1_000).default([]),
  stabilityRateMPerDay: z.number().nonnegative().default(0.0001),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200)
}).strict()
export type DeformationComparisonRequestV1 = z.infer<typeof DeformationComparisonRequestV1>
