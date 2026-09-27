import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { extname } from 'node:path'
import JSZip from 'jszip'
import {
  SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_BYTES,
  SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_ENTRIES,
  SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS,
  EMPTY_SURVEY_CORRECTION_STATE,
  SurveyFormatDetectionV1,
  SurveyConverterProvenanceV1,
  SurveyObservationV1,
  SurveyPointV1,
  SurveyRawRecordAnchorCreateV1,
  SurveyRawRecordAnchorV1,
  SurveySourceFileCreateV1,
  WORKWISE_SURVEY_SOURCE_FORMAT,
  WORKWISE_SURVEY_SOURCE_FORMAT_VERSION,
  WorkwiseSurveySourceV1,
  type SurveyFormatIdV1,
  type SurveyImportDiagnosticV1,
  type SurveyImportDispositionV1,
  type SurveyNetworkV1,
  type SurveyNetworkTypeV1,
  type SurveyObservationV1 as SurveyObservation,
  type SurveyPointV1 as SurveyPoint,
  type SurveySourceFileV1 as SurveySourceFile
} from '../contracts/survey.js'
import { BUNDLED_SURVEY_CONVERTERS, MacOsSandboxedSurveyConverterExecutor, SurveyConverterRegistry } from './survey-converter.js'
import { isCosaIn2ParseError, parseCosaIn2, type CosaIn2ParseError, type CosaIn2RecordAnchor } from './survey-cosa-in2.js'
import { initializeCosaDirectionDistanceNetwork, initializeCosaDistanceNetwork } from './survey-cosa-in2-initializer.js'
import { parseCosaIn1, type CosaIn1Mapping } from './survey-cosa-in1.js'
import { findP0SurveyFormatEntry, isAcceptedOpenSurveyInputFormat, isMappingRequiredOpenSurveyInputFormat } from './survey-format-catalog.js'
import { lexLeicaGsi, type LeicaGsiLexAnchor, type LeicaGsiLexRecord, type LeicaGsiStandardWord } from './survey-leica-gsi-lexer.js'
import { toMetres, toRadians } from './survey-units.js'

const REGISTRY_VERSION = 'workwise-survey-formats-23'
const COSA_IN2_PARSER_ID = 'cosa-in2-parser'
const COSA_IN2_PARSER_VERSION = '0.3.0'
const SURVEY_CLOUD_SUC_PARSER_ID = 'survey-cloud-suc-archive-adapter'
const SURVEY_CLOUD_SUC_PARSER_VERSION = '0.1.1'
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_UNWRAPPED_BYTES = 128 * 1024 * 1024
const MAX_ARCHIVE_RATIO = 200
const MAX_ARCHIVE_ENTRIES = 32
const MAX_OOXML_ENTRIES = 2_048
const MAX_TEXT_LINES = 200_000
// Keep provenance capacity aligned with the parser's maximum observation
// count: silently dropping anchors would make a nominally ready source
// unauditable.
const MAX_RECORD_ANCHORS = 100_000
const MAX_PARSED_POINTS = 10_000
const MAX_PARSED_OBSERVATIONS = 100_000
const MAX_RAW_FIELDS_BYTES = 8 * 1024 * 1024
const MAX_XML_DEPTH = 64
const MAX_XML_TAGS = 500_000
/** Detection always inspects this fixed, bounded prefix—not an arbitrary file-sized head. */
const DETECTION_PROBE_BYTES = 8 * 1024
/** A strong content signature may safely override a misleading filename suffix. */
const HIGH_CONFIDENCE_CONTENT_CONFLICT_MINIMUM = 0.95
/**
 * This is a deterministic fingerprint of the versioned parser bundle. Any
 * parser-semantic change must advance REGISTRY_VERSION, which changes the
 * audit fingerprint without depending on a source file path at runtime.
 */
const REGISTRY_PARSER_SOURCE_HASH = createHash('sha256')
  .update(`survey-format-registry:${REGISTRY_VERSION}`)
  .digest('hex')
const REGISTRY_IMPORTER_ID = 'workwise:survey-format-registry'
/**
 * Runtime cannot hash its TypeScript source reliably. This is therefore a
 * versioned implementation fingerprint, not a byte-for-byte source hash:
 * any COSA parser/adapter semantic change must advance its parser version.
 * A build-time source-manifest hash remains a follow-up hardening item.
 */
const COSA_IN2_PARSER_SOURCE_HASH = createHash('sha256')
  .update(`survey-cosa-in2:${COSA_IN2_PARSER_VERSION}`)
  .digest('hex')
const COSA_IN1_PARSER_ID = 'cosa-in1-parser'
const COSA_IN1_PARSER_VERSION = '0.1.0'
const COSA_IN1_PARSER_SOURCE_HASH = createHash('sha256')
  .update(`survey-cosa-in1:${COSA_IN1_PARSER_VERSION}`)
  .digest('hex')
const SOUTH_DAT_PARSER_ID = 'south-dat-column-mapping-parser'
const SOUTH_DAT_PARSER_VERSION = '0.1.0'
const SOUTH_DAT_PARSER_SOURCE_HASH = createHash('sha256')
  .update(`survey-south-dat:${SOUTH_DAT_PARSER_VERSION}`)
  .digest('hex')
const M5_PARSER_ID = 'trimble-m5-abffb-parser'
const M5_PARSER_VERSION = '0.2.0'
const M5_PARSER_SOURCE_HASH = createHash('sha256')
  .update(`survey-trimble-m5:${M5_PARSER_VERSION}`)
  .digest('hex')
const SURVEY_CLOUD_SUC_PARSER_SOURCE_HASH = createHash('sha256')
  .update(`survey-cloud-suc:${SURVEY_CLOUD_SUC_PARSER_VERSION}`)
  .digest('hex')

type RawField = string | number | boolean | null
/**
 * Metadata from the schema-validated frozen WorkWise envelope. This excludes
 * project/runtime state and all point/observation arrays: the latter must
 * always come from the registry's anchor-preserving parse output.
 */
type FrozenWorkwiseNetworkMetadata = Partial<Pick<SurveyNetworkV1,
  'id' | 'networkType' | 'transformType' | 'coordinateSystem' | 'projection' |
  'centralMeridian' | 'ellipsoid' | 'verticalDatum' | 'heightDatum' | 'unit'
>>
type ParsedSource = {
  knownPoints: SurveyPoint[]
  unknownPoints: SurveyPoint[]
  observations: SurveyObservation[]
  instrumentParameters?: Record<string, number>
  observationEpoch?: string
  coordinateSystem?: string
  projection?: string
  ellipsoid?: string
  verticalDatum?: string
  unit?: string
  /** Raw source declaration may deliberately differ from runtime canonical units. */
  linearUnitRaw?: string
  angularUnitRaw?: string
  /**
   * A parser may preserve a raw unit declaration without claiming its point
   * coordinates and heights have been converted to the Survey runtime's m/rad
   * canonical domain.  Such input must stay archive-only.
   */
  canonicalUnitsVerified?: boolean
  parserId?: string
  parserVersion?: string
  parserSourceHash?: string
  dispositionReason?: string
  requiresManualConfirmation?: boolean
  /** Parser-specific counts win over generic derived counts when available. */
  summaryOverride?: Partial<{
    pointCount: number
    stationCount: number
    observationCount: number
    recordCount: number
    skippedRecordCount: number
  }>
  /** Source-level fields such as a parser header that no point/observation owns. */
  sourceRawFields?: Record<string, RawField>
  /**
   * A parser may need to stop collecting source-level raw fields before the
   * generic retention pass.  The final source diagnostic is emitted once by
   * the registry so this local signal cannot duplicate a warning.
   */
  preservedRawFieldsTruncated?: boolean
  /** Present only after the frozen WorkWise envelope itself has been schema-validated. */
  frozenNetwork?: FrozenWorkwiseNetworkMetadata
  diagnostics?: SurveyImportDiagnosticV1[]
  anchors?: SurveyRawRecordAnchorV1[]
  disposition?: SurveyImportDispositionV1
}

export type SurveySourceEnvelope = ParsedSource & {
  effectiveName: string
  effectiveBytes: Buffer
  effectiveText?: string
  sourceFile: SurveySourceFile
  /** Original source retained when `sourceFile` is a converter output. */
  originalSourceFile?: SurveySourceFile
  /** Bytes addressed by `originalSourceFile`, never by converted anchors. */
  originalBytes?: Buffer
}

export type SurveyFormatInput = {
  name: string
  bytes: Buffer
  networkType?: SurveyNetworkTypeV1
  /** Explicit low-level mapping; no default or GUI confirmation is inferred. */
  cosaIn1Mapping?: CosaIn1Mapping
  /** Optional local cancellation; never persisted as source provenance. */
  signal?: AbortSignal
}

type Detection = {
  format: SurveyFormatIdV1
  vendor: string
  version?: string
  confidence: number
  signatures: string[]
  method?: 'content-signature' | 'structural-probe' | 'extension-fallback'
}

type TextResult = { text: string; encoding: string }

class SurveySourceParseError extends Error {
  constructor(readonly code: SurveyImportDiagnosticV1['code'], message: string) {
    super(message)
    this.name = 'SurveySourceParseError'
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function extension(name: string): string {
  const lower = name.toLowerCase()
  const rinexShort = /\.\d{2}[odngmlphq]$/.exec(lower)
  return rinexShort ? rinexShort[0] : extname(lower)
}

function decodeText(bytes: Buffer): TextResult {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(Math.max(0, bytes.length - 2))
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1]!
      swapped[index - 1] = bytes[index]!
    }
    return { text: new TextDecoder('utf-16le').decode(swapped), encoding: 'utf-16be' }
  }
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('gb18030').decode(body), encoding: 'gb18030' }
  }
}

function boundedLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > MAX_TEXT_LINES) throw new SurveySourceParseError('limit_exceeded', `测量源文件超过 ${MAX_TEXT_LINES.toLocaleString('zh-CN')} 条文本记录上限`)
  return lines
}

function validateXmlSafety(text: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new SurveySourceParseError('invalid_record', 'XML 包含 DTD 或实体声明，已按不可信输入阻断')
  let depth = 0
  let tags = 0
  for (const match of text.matchAll(/<\s*(\/)?\s*([A-Za-z_][\w:.-]*)\b[^>]*?(\/)?\s*>/g)) {
    tags += 1
    if (tags > MAX_XML_TAGS) throw new SurveySourceParseError('limit_exceeded', `XML 标签数量超过 ${MAX_XML_TAGS.toLocaleString('zh-CN')} 上限`)
    if (match[1]) depth = Math.max(0, depth - 1)
    else if (!match[3]) {
      depth += 1
      if (depth > MAX_XML_DEPTH) throw new SurveySourceParseError('limit_exceeded', `XML 嵌套深度超过 ${MAX_XML_DEPTH} 层上限`)
    }
  }
}

function xmlDecode(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function xmlAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of raw.matchAll(/([:\w.-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1]!.toLowerCase()] = xmlDecode(match[3] ?? '')
  }
  return attributes
}

function xmlTag(body: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i').exec(body)
    if (match?.[1]?.trim()) return xmlDecode(match[1].replace(/<[^>]+>/g, '').trim())
  }
  return undefined
}

function valueOf(record: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name.toLowerCase()]
    if (value !== undefined && value.trim()) return value.trim()
  }
  return undefined
}

function numberOf(record: Record<string, string>, ...names: string[]): number | undefined {
  const raw = valueOf(record, ...names)
  if (!raw) return undefined
  const value = Number(raw.replace(/[,\s]/g, ''))
  return Number.isFinite(value) ? value : undefined
}

function decimalDegrees(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined
  const numeric = Number(raw.trim())
  if (Number.isFinite(numeric)) return numeric
  const parts = raw.replace(/[º°]/g, ' ').replace(/[′']/g, ' ').replace(/[″"]/g, ' ').trim().split(/\s+/).map(Number)
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return undefined
  const sign = parts[0]! < 0 ? -1 : 1
  return sign * (Math.abs(parts[0]!) + Math.abs(parts[1] ?? 0) / 60 + Math.abs(parts[2] ?? 0) / 3600)
}

function anchor(line: number, recordType?: string, section?: string, id = `record-${line}`): SurveyRawRecordAnchorV1 {
  return SurveyRawRecordAnchorV1.parse({
    id,
    sourceRecord: line,
    line,
    rawOffset: 0,
    rawLength: 0,
    rawLineNo: line,
    rawSnippet: '',
    ...(recordType ? { recordType } : {}),
    ...(section ? { section } : {})
  })
}

function diagnostic(code: SurveyImportDiagnosticV1['code'], severity: SurveyImportDiagnosticV1['severity'], message: string, sourceRecord?: number, english?: string): SurveyImportDiagnosticV1 {
  return { code, severity, message, ...(english ? { localized: { en: { message: english } } } : {}), ...(sourceRecord ? { sourceRecord, recordAnchor: `record-${sourceRecord}` } : {}) }
}

function rawFields(record: Record<string, unknown>): Record<string, RawField> {
  const output: Record<string, RawField> = {}
  for (const [key, value] of Object.entries(record).slice(0, 80)) {
    if (typeof value === 'string') output[key] = value.slice(0, 2_000)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value
  }
  return output
}

function parsedWithinLimits(parsed: ParsedSource): ParsedSource {
  const pointCount = parsed.knownPoints.length + parsed.unknownPoints.length
  if (pointCount > MAX_PARSED_POINTS) throw new SurveySourceParseError('limit_exceeded', `解析点位 ${pointCount.toLocaleString('zh-CN')} 个，超过 ${MAX_PARSED_POINTS.toLocaleString('zh-CN')} 上限`)
  if (parsed.observations.length > MAX_PARSED_OBSERVATIONS) throw new SurveySourceParseError('limit_exceeded', `解析观测 ${parsed.observations.length.toLocaleString('zh-CN')} 条，超过 ${MAX_PARSED_OBSERVATIONS.toLocaleString('zh-CN')} 上限`)
  if ((parsed.anchors?.length ?? 0) > MAX_RECORD_ANCHORS) throw new SurveySourceParseError('limit_exceeded', `解析原始记录锚点 ${(parsed.anchors?.length ?? 0).toLocaleString('zh-CN')} 条，超过 ${MAX_RECORD_ANCHORS.toLocaleString('zh-CN')} 上限；已拒绝导入以避免截断审计来源`)
  let rawBytes = 0
  for (const item of [...parsed.knownPoints, ...parsed.unknownPoints, ...parsed.observations]) {
    if (!item.rawFields) continue
    rawBytes += Buffer.byteLength(JSON.stringify(item.rawFields), 'utf8')
    if (rawBytes > MAX_RAW_FIELDS_BYTES) throw new SurveySourceParseError('limit_exceeded', `保留的厂商原始字段超过 ${MAX_RAW_FIELDS_BYTES / (1024 * 1024)} MiB 上限`)
  }
  return parsed
}

function utf16SourceLineRanges(bytes: Buffer, bigEndian: boolean): Array<{ offset: number; length: number }> {
  const ranges: Array<{ offset: number; length: number }> = []
  const prefixLength = 2
  let offset = prefixLength
  const codeUnitAt = (index: number) => bigEndian
    ? (bytes[index]! << 8) | bytes[index + 1]!
    : bytes[index]! | (bytes[index + 1]! << 8)
  for (let index = prefixLength; index + 1 < bytes.length; index += 2) {
    const separator = codeUnitAt(index)
    if (separator !== 0x000a && separator !== 0x000d) continue
    ranges.push({ offset, length: index - offset })
    if (separator === 0x000d && index + 3 < bytes.length && codeUnitAt(index + 2) === 0x000a) index += 2
    offset = index + 2
  }
  if (offset < bytes.length) ranges.push({ offset, length: bytes.length - offset })
  return ranges
}

function sourceLineRanges(bytes: Buffer, text: TextResult | null): Array<{ offset: number; length: number }> {
  if (text?.encoding === 'utf-16le') return utf16SourceLineRanges(bytes, false)
  if (text?.encoding === 'utf-16be') return utf16SourceLineRanges(bytes, true)
  const ranges: Array<{ offset: number; length: number }> = []
  // `decodeText` strips a UTF-8 BOM before the parser sees line/column
  // positions. Keep byte anchors in the original attachment by starting the
  // first physical range after that three-byte transport marker.
  let offset = text?.encoding === 'utf-8' && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  for (let index = 0; index < bytes.length; index += 1) {
    const separator = bytes[index]
    if (separator !== 0x0a && separator !== 0x0d) continue
    // Text exporters in the field use LF, CRLF, and legacy CR-only line
    // endings. Treat CRLF as one separator while retaining CR-only records.
    const end = separator === 0x0a && index > offset && bytes[index - 1] === 0x0d
      ? index - 1
      : index
    ranges.push({ offset, length: end - offset })
    if (separator === 0x0d && bytes[index + 1] === 0x0a) index += 1
    offset = index + 1
  }
  if (offset < bytes.length) ranges.push({ offset, length: bytes.length - offset })
  return ranges
}

function rawByteSnippet(bytes: Buffer, offset: number, length: number): string {
  const slice = bytes.subarray(offset, Math.min(bytes.length, offset + Math.min(length, Math.floor(SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS / 2))))
  const text = slice.toString('utf8')
  const hasUnsafeControlByte = slice.some((byte) => byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)
  return hasUnsafeControlByte
    ? `hex:${slice.toString('hex')}`.slice(0, SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS)
    : text.slice(0, SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS)
}

/** Return a bounded original-text excerpt without splitting a Unicode surrogate pair. */
function rawTextSnippet(text: string, start: number, end: number): string {
  const cappedEnd = Math.min(end, start + SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS)
  let snippet = text.slice(start, cappedEnd)
  const last = snippet.charCodeAt(snippet.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) snippet = snippet.slice(0, -1)
  return snippet
}

/** Completes parser-level record IDs with immutable byte locations and a bounded review excerpt. */
function completeRawRecordAnchors(anchors: SurveyRawRecordAnchorV1[], bytes: Buffer, text: TextResult | null): SurveyRawRecordAnchorV1[] {
  const ranges = sourceLineRanges(bytes, text)
  const lines = text?.text.split(/\r\n|\n|\r/) ?? []
  return anchors.map((anchor) => {
    const rawLineNo = anchor.rawLineNo ?? anchor.line
    const lineRange = rawLineNo ? ranges[rawLineNo - 1] : undefined
    const rawOffset = anchor.byteOffset ?? lineRange?.offset ?? anchor.rawOffset
    const candidateLength = anchor.byteLength && anchor.byteLength > 0
      ? anchor.byteLength
      : lineRange?.length ?? anchor.rawLength
    // XML record ordinals need not equal physical line numbers; anchor them to
    // the complete source rather than fabricating a zero-length location.
    const rawLength = candidateLength > 0 ? candidateLength : Math.max(1, bytes.length - rawOffset)
    const rawSnippet = anchor.rawSnippet || (rawLineNo && text ? (lines[rawLineNo - 1] ?? '').slice(0, SURVEY_SOURCE_MAX_RAW_SNIPPET_CHARS) : rawByteSnippet(bytes, rawOffset, rawLength))
    return SurveyRawRecordAnchorCreateV1.parse({
      ...anchor,
      byteOffset: anchor.byteOffset ?? rawOffset,
      byteLength: anchor.byteLength && anchor.byteLength > 0 ? anchor.byteLength : rawLength,
      rawOffset,
      rawLength,
      ...(rawLineNo ? { rawLineNo } : {}),
      rawSnippet
    })
  })
}

function sourceUnits(parsed: ParsedSource): { linearUnitRaw: string; angularUnitRaw: string } {
  const linear = new Set<string>()
  const angular = new Set<string>()
  for (const observation of parsed.observations) {
    if (observation.type === 'direction' || observation.type === 'angle' || observation.type === 'zenith') angular.add(observation.unit)
    else linear.add(observation.unit)
  }
  if (!linear.size && parsed.unit) linear.add(parsed.unit)
  return {
    linearUnitRaw: parsed.linearUnitRaw ?? ([...linear].sort().join(', ') || 'not-declared'),
    angularUnitRaw: parsed.angularUnitRaw ?? ([...angular].sort().join(', ') || 'not-declared')
  }
}

function sourceSummary(parsed: ParsedSource, records: SurveyRawRecordAnchorV1[], diagnostics: SurveyImportDiagnosticV1[]) {
  const points = [...parsed.knownPoints, ...parsed.unknownPoints]
  const pointIds = new Set(points.map((point) => point.id))
  const stationIds = new Set(points.filter((point) => point.pointClass === 'station').map((point) => point.id))
  return {
    pointCount: parsed.summaryOverride?.pointCount ?? pointIds.size,
    stationCount: parsed.summaryOverride?.stationCount ?? stationIds.size,
    observationCount: parsed.summaryOverride?.observationCount ?? parsed.observations.length,
    // A source record is a physical/raw record, not the number of observations
    // derived from it (one GSI block may emit several observations).
    recordCount: parsed.summaryOverride?.recordCount ?? (records.length || Math.max(parsed.observations.length, pointIds.size)),
    skippedRecordCount: parsed.summaryOverride?.skippedRecordCount ?? diagnostics.filter((diagnostic) => diagnostic.code === 'record_ignored').length
  }
}

type PreservedRawFieldTruncationReason = 'entry-limit' | 'byte-limit' | 'key-collision-limit'

type PreservedRawFieldsResult = {
  fields: Record<string, RawField>
  truncationReasons: readonly PreservedRawFieldTruncationReason[]
}

function preservedRawFieldsLimitDiagnostic(): SurveyImportDiagnosticV1 {
  return {
    code: 'limit_exceeded',
    severity: 'warning',
    message: '为保持审计记录边界，来源原始字段超过保留上限；超出部分未写入 preservedRawFields，原始附件仍已保留。',
    suggestedAction: '请通过已保留的原始附件和记录锚点复核完整字段；必要时按可追溯边界拆分来源后重新导入。'
  }
}

function preservedRawFields(parsed: ParsedSource): PreservedRawFieldsResult {
  const output: Record<string, RawField> = {}
  let byteCount = 0
  let entryCount = 0
  const truncationReasons = new Set<PreservedRawFieldTruncationReason>()
  const addValue = (baseKey: string, value: RawField) => {
    if (entryCount >= SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_ENTRIES) {
      truncationReasons.add('entry-limit')
      return
    }
    let key = baseKey.slice(0, 240)
    let suffix = 2
    while (key in output && suffix <= 999) key = `${baseKey.slice(0, 250)}#${suffix++}`
    if (key in output) {
      truncationReasons.add('key-collision-limit')
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify({ [key]: value }), 'utf8')
    if (byteCount + bytes > SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_BYTES) {
      truncationReasons.add('byte-limit')
      return
    }
    output[key] = value
    byteCount += bytes
    entryCount += 1
  }
  const add = (scope: 'point' | 'observation', item: SurveyPoint | SurveyObservation) => {
    if (!item.rawFields) return
    const locator = ('sourceRecordId' in item && item.sourceRecordId) || item.sourceLocator || item.id
    for (const [field, value] of Object.entries(item.rawFields)) {
      addValue(`${scope}:${locator}:${field}`, value)
    }
  }
  for (const [field, value] of Object.entries(parsed.sourceRawFields ?? {})) addValue(`source:${field}`, value)
  for (const point of [...parsed.knownPoints, ...parsed.unknownPoints]) add('point', point)
  for (const observation of parsed.observations) add('observation', observation)
  return { fields: output, truncationReasons: Object.freeze([...truncationReasons]) }
}

function dispositionReason(disposition: SurveyImportDispositionV1, detection: SurveyFormatDetectionV1, diagnostics: SurveyImportDiagnosticV1[]): string {
  const blocking = diagnostics.find((diagnostic) => diagnostic.severity === 'blocking')
  if (blocking) return `${disposition}: ${blocking.code} — ${blocking.message.slice(0, 300)}`
  if (disposition === 'adjustment-ready') return `内容已识别为 ${detection.vendor} / ${detection.format}，且没有阻断诊断`
  if (disposition === 'gnss-processing-required') return `${detection.format} 需先完成 GNSS 后处理`
  if (disposition === 'converter-required') return `${detection.format} 需经审计的本地转换器转换`
  return `${detection.format} 当前仅可归档保留`
}

function uniquePoints(points: SurveyPoint[]): SurveyPoint[] {
  const merged = new Map<string, SurveyPoint>()
  for (const point of points) {
    const current = merged.get(point.id)
    merged.set(point.id, SurveyPointV1.parse({
      ...(current ?? {}),
      ...point,
      known: Boolean(current?.known || point.known),
      pointClass: current?.known || point.known ? 'known' : point.pointClass
    }))
  }
  return [...merged.values()]
}

function classifyPoints(points: SurveyPoint[]): { knownPoints: SurveyPoint[]; unknownPoints: SurveyPoint[] } {
  const unique = uniquePoints(points)
  return {
    knownPoints: unique.filter((point) => point.known || point.pointClass === 'known'),
    unknownPoints: unique.filter((point) => !point.known && point.pointClass !== 'known')
  }
}

const EXTENSION_FORMATS: Partial<Record<string, SurveyFormatIdV1[]>> = {
  '.json': ['workwise-json'],
  '.csv': ['delimited-text'],
  '.tsv': ['delimited-text'],
  '.xlsx': ['xlsx'],
  '.gsi': ['leica-gsi8', 'leica-gsi16'],
  '.hexml': ['leica-hexml'],
  '.jxl': ['trimble-jobxml'],
  '.jobxml': ['trimble-jobxml'],
  '.m5': ['trimble-m5'],
  // P0 COSA/South identities intentionally do not imply a parser. They are
  // used only by the explicit, non-ready extension-fallback branch below.
  '.in1': ['cosa-in1'],
  '.in2': ['cosa-in2'],
  '.net': ['cosa-net'],
  '.ou1': ['cosa-ou1'],
  '.ou2': ['cosa-ou2'],
  '.dat': ['south-dat'],
  '.raw': ['tds-raw', 'nikon-raw'],
  '.rw5': ['carlson-rw5'],
  '.sdr': ['sokkia-sdr'],
  '.sdr20': ['sokkia-sdr'],
  '.sdr33': ['sokkia-sdr'],
  '.suc': ['survey-cloud-suc'],
  '.gts': ['topcon-gts7'],
  '.gt7': ['topcon-gts7'],
  '.fc5': ['topcon-fc5'],
  '.nik': ['nikon-raw'],
  '.survey': ['spectra-survey-pro'],
  '.spj': ['spectra-survey-pro'],
  '.xml': ['leica-hexml', 'trimble-jobxml', 'landxml'],
  '.landxml': ['landxml'],
  '.rnx': ['rinex-observation', 'rinex-navigation', 'rinex-meteorological', 'rinex-clock', 'hatanaka-rinex'],
  '.obs': ['rinex-observation'],
  '.nav': ['rinex-navigation'],
  '.crx': ['hatanaka-rinex'],
  '.snx': ['sinex'],
  '.sinex': ['sinex'],
  '.nmea': ['nmea-0183'],
  '.rtcm': ['rtcm2', 'rtcm3'],
  '.rtcm2': ['rtcm2'],
  '.rtcm3': ['rtcm3'],
  '.sp3': ['sp3'],
  '.ion': ['ionex'],
  '.inx': ['ionex'],
  '.atx': ['antex'],
  '.ubx': ['ublox-ubx'],
  '.nov': ['novatel-oem'],
  '.sbf': ['septentrio-sbf'],
  '.bnx': ['binex'],
  '.binex': ['binex'],
  '.jps': ['javad-jps'],
  '.tps': ['topcon-tps'],
  '.sth': ['south-sth'],
  '.zhd': ['hitarget-zhd'],
  '.hcn': ['chcnav-hcn'],
  '.cnb': ['comnav-cnb'],
  '.t00': ['trimble-t00'],
  '.t01': ['trimble-t01'],
  '.t02': ['trimble-t02'],
  '.t04': ['trimble-t04'],
  '.job': ['trimble-job', 'spectra-survey-pro'],
  '.dbx': ['leica-dbx'],
  '.mdb': ['leica-mdb']
}

function expectedFormats(ext: string): SurveyFormatIdV1[] | undefined {
  if (/\.\d{2}o$/.test(ext)) return ['rinex-observation']
  if (/\.\d{2}[nglphq]$/.test(ext)) return ['rinex-navigation']
  if (/\.\d{2}m$/.test(ext)) return ['rinex-meteorological']
  if (/\.\d{2}d$/.test(ext)) return ['hatanaka-rinex']
  return EXTENSION_FORMATS[ext]
}

function rinexDetection(text: string): Detection | null {
  const header = boundedLines(text).slice(0, 100).find((line) => line.includes('RINEX VERSION / TYPE') || line.includes('CRINEX VERS'))
  if (!header) return null
  const version = header.slice(0, 9).trim() || undefined
  if (header.includes('CRINEX VERS')) return { format: 'hatanaka-rinex', vendor: 'RINEX', version, confidence: 1, signatures: ['CRINEX VERS'] }
  const type = header.slice(20, 21).toUpperCase()
  const format: SurveyFormatIdV1 = type === 'O' ? 'rinex-observation' : type === 'M' ? 'rinex-meteorological' : type === 'C' ? 'rinex-clock' : 'rinex-navigation'
  return { format, vendor: 'RINEX', version, confidence: 1, signatures: ['RINEX VERSION / TYPE'] }
}

/**
 * Returns a UTF-8-byte-bounded prefix without encoding the entire source.
 * Detection must never obtain a later signature merely because a file is
 * large; parsers still receive the complete source after format selection.
 */
function boundedTextProbe(text: string): string {
  let byteCount = 0
  let end = 0
  while (end < text.length) {
    const codePoint = text.codePointAt(end)!
    const width = codePoint > 0xffff ? 2 : 1
    const character = text.slice(end, end + width)
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (byteCount + characterBytes > DETECTION_PROBE_BYTES) break
    byteCount += characterBytes
    end += width
  }
  return text.slice(0, end)
}

function commaFields(line: string): string[] {
  return line.split(',').map((value) => value.trim())
}

function isFiniteNonNegative(value: string): boolean {
  const number = Number(value)
  return value.length > 0 && Number.isFinite(number) && number >= 0
}

function isFiniteNumber(value: string): boolean {
  return value.length > 0 && Number.isFinite(Number(value))
}

/**
 * Bounded shallow COSA probe. It deliberately establishes only the first
 * header/block shape; the isolated parser performs all semantic validation
 * and never yields partial observations on malformed input.
 */
function probeCosaIn2(text: string): Detection | null {
  const lines = text.split(/\r?\n/)
  const header = lines[0] ? commaFields(lines[0]) : []
  let sawKnownPoint = false
  let stationIndex = -1
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (!line) continue
    const fields = commaFields(line)
    if (stationIndex < 0) {
      if (fields.length === 3 && fields[1] !== 'L' && fields[1] !== 'S' && isFiniteNumber(fields[1]!) && isFiniteNumber(fields[2]!)) {
        sawKnownPoint = true
        continue
      }
      if (sawKnownPoint && fields.length === 1 && fields[0]) stationIndex = index
      continue
    }
    if (fields.length === 3 && (fields[1] === 'L' || fields[1] === 'S') && fields[0] && fields[2]) {
      const validHeader = header.length === 3 && header.every(isFiniteNonNegative)
      const validBacksightReset = fields[1] === 'L' && /^[+-]?0(?:\.0+)?$/.test(fields[2]!)
      return {
        format: 'cosa-in2',
        vendor: 'COSA(科傻)',
        confidence: validHeader && validBacksightReset ? 0.98 : 0.55,
        signatures: [validHeader && validBacksightReset ? 'COSA .in2 three-value header + L,0 station block' : 'COSA .in2 station block (semantic validation pending)'],
        method: 'structural-probe'
      }
    }
  }
  return null
}

/**
 * Bounded, syntax-only SurveyCloud SUC probe. The field semantics and units
 * are not publicly specified, so this establishes a repeatable file shape
 * for archival review only; it deliberately does not interpret any values.
 */
type SurveyCloudSucField = {
  /** Exact source segment between delimiters, including padding and quotes. */
  raw: string
  /** Structural comparison view only; it is never persisted as source data. */
  value: string
}

/** Choose the dominant delimiter outside quoted regions. */
function surveyCloudSucDelimiter(line: string): ',' | '\t' | null {
  let quote: '"' | "'" | null = null
  let hasComma = false
  let hasTab = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (quote) {
      if (character === quote) {
        if (line[index + 1] === quote) index += 1
        else quote = null
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ',') hasComma = true
    if (character === '\t') hasTab = true
  }
  // NAS records use tabs as padding inside comma-separated fields. Prefer a
  // comma whenever one exists outside quotes; tab-only records remain valid.
  return hasComma ? ',' : hasTab ? '\t' : null
}

/**
 * Split one SUC record without treating delimiters inside quoted fields as
 * record separators. SUC has no published field contract yet, so this is a
 * syntax-only lexer: it supports comma/tab separators and doubled quote
 * escapes, but does not assign a meaning to any field.
 */
function splitSurveyCloudSucFields(line: string): SurveyCloudSucField[] | null {
  const rawFields: string[] = []
  const delimiter = surveyCloudSucDelimiter(line)
  let fieldStart = 0
  let quote: '"' | "'" | null = null
  let quoteClosed = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (quote) {
      if (character === quote) {
        // RFC-style doubled quotes are an escaped quote, not the end of the
        // field. Keeping the raw segment unchanged preserves the evidence.
        if (line[index + 1] === quote) {
          index += 1
          continue
        }
        quote = null
        quoteClosed = true
      }
      continue
    }
    if (quoteClosed) {
      if (character === delimiter) {
        rawFields.push(line.slice(fieldStart, index))
        fieldStart = index + 1
        quoteClosed = false
      } else if (!/\s/.test(character)) {
        // A quoted field may only be followed by whitespace and a delimiter.
        return null
      }
      continue
    }
    if (character === delimiter) {
      rawFields.push(line.slice(fieldStart, index))
      fieldStart = index + 1
      continue
    }
    if (character === '"' || character === "'") {
      // Quotes are valid only at the beginning of a field, apart from
      // optional padding. An embedded quote would make the structure
      // ambiguous and must not be mistaken for a valid SUC record.
      if (line.slice(fieldStart, index).trim().length > 0) return null
      quote = character
    }
  }
  if (quote) return null
  rawFields.push(line.slice(fieldStart))

  return rawFields.map((raw) => ({ raw, value: surveyCloudSucFieldValue(raw) }))
}

/** Return a trimmed/unquoted comparison view while retaining the raw field. */
function surveyCloudSucFieldValue(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length < 2) return trimmed
  const quote = trimmed[0]
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return trimmed
  const inner = trimmed.slice(1, -1)
  // Decode only the lexical escape needed for structural checks. The raw
  // segment, including both quote characters and any padding, is preserved.
  // A NAS exporter uses horizontal tabs as padding *inside* quoted fields;
  // collapse that padding only in the comparison view so lifecycle tokens
  // remain recognizable without changing the preserved source field.
  return inner.replaceAll(`${quote}${quote}`, quote).replace(/\s+/g, ' ').trim()
}

/**
 * A few SurveyCloud exports wrap the complete CSV record in one pair of
 * quotes (`"SSJ3,4,1,0.0000"`) instead of quoting each field.  Unwrap that
 * outer layer only for structural checks; the archival parser continues to
 * retain the original line as-is so its raw evidence cannot be rewritten.
 */
function surveyCloudSucStructuralFields(line: string): SurveyCloudSucField[] | null {
  const direct = splitSurveyCloudSucFields(line)
  if (!direct || direct.length !== 1) return direct
  const trimmed = direct[0]!.raw.trim()
  if (trimmed.length < 3) return direct
  const quote = trimmed[0]
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) return direct
  const inner = trimmed.slice(1, -1)
  if (!inner.includes(',') && !inner.includes('\t')) return direct
  const nested = splitSurveyCloudSucFields(inner)
  return nested && nested.length > 1 ? nested : null
}

function sucDateValue(value: string): boolean {
  const match = /^(\d{4})([.-])(\d{2})\2(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[3])
  const day = Number(match[4])
  if (year < 1 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
  return day <= daysInMonth
}

function sucTimeValue(value: string, allowSingleDigitHour = false): boolean {
  const strictClock = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\s*[Zz])?$/
  const redundantClock = /^(?:\d|[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\s*[Zz])?$/
  return (allowSingleDigitHour ? redundantClock : strictClock).test(value)
}

function sucDateTimeValue(value: string): boolean {
  const match = /^(\d{4}[.-]\d{2}[.-]\d{2})\s*(?:T\s*)?((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d)(?:\s*[Zz])?$/.exec(value)
  return Boolean(match && sucDateValue(match[1]!) && match[2] !== undefined)
}

function probeSurveyCloudSuc(text: string): Detection | null {
  const lines = boundedLines(text)
  const firstNonEmpty = lines.findIndex((line) => line.trim().length > 0)
  if (firstNonEmpty < 0) return null

  const fieldsFor = (line: string): SurveyCloudSucField[] | null => surveyCloudSucStructuralFields(line)
  const header = fieldsFor(lines[firstNonEmpty]!)
  const headerValid = header?.length === 4
    // NAS inspection shows several upper-case exporter record codes. They are
    // retained as opaque syntax, not mapped to a station, point, or role.
    && /^[A-Z][A-Z0-9]{0,15}$/.test(header[0]!.value)
    && /^\d+$/.test(header[1]!.value)
    && /^\d+$/.test(header[2]!.value)
    && isFiniteNumber(header[3]!.value)
  if (!headerValid) return null

  const lifecycleRecord = (line: string, label: 'Start' | 'End') => {
    const fields = fieldsFor(line)
    if (!fields || fields.length < 2 || fields.length > 4 || fields[0]!.value !== label) return false
    const values = fields.slice(1).map((field) => field.value)
    // Published NAS samples use separate date/time fields. The probe also
    // accepts dotted dates, a merged date-time token, and an optional Z field.
    if (values.length === 1) return sucDateTimeValue(values[0]!)
    if (values.length === 2 && sucDateTimeValue(values[0]!) && /^Z$/i.test(values[1]!)) return true
    if (values.length === 2 && sucDateValue(values[0]!) && sucTimeValue(values[1]!)) return true
    // Some NAS exports concatenate the date and first clock token without a
    // separator, then repeat the clock token as a second field (for example
    // `YYYY.MM.DDHH:MM:SS,HH:MM:SS`).  Treat this only as a bounded lifecycle
    // shape; the values remain opaque and are never converted to an epoch.
    if (values.length === 2 && sucDateTimeValue(values[0]!) && sucTimeValue(values[1]!, true)) return true
    return values.length === 3 && sucDateValue(values[0]!) && sucTimeValue(values[1]!) && /^Z$/i.test(values[2]!)
  }
  const measurementLike = (line: string) => {
    const fields = fieldsFor(line)
    return Boolean(fields && fields.length === 6 && fields[0]!.value.length > 0 && fields.slice(1).every((field) => isFiniteNumber(field.value)))
  }

  let startLine = -1
  let endLine = -1
  let hasMeasurement = false
  for (let index = firstNonEmpty + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line.trim()) continue
    const fields = fieldsFor(line)
    // Reject malformed quoting in the bounded probe rather than allowing a
    // later valid-looking line to hide a structurally ambiguous record.
    if (!fields) return null
    const isStart = lifecycleRecord(line, 'Start')
    const isEnd = lifecycleRecord(line, 'End')
    // A lifecycle label with an invalid date/time or field count is not an
    // unrelated opaque record. Reject it explicitly so a later valid pair
    // cannot conceal malformed source structure.
    const lifecycleLabel = fields[0]?.value
    if ((lifecycleLabel === 'Start' || lifecycleLabel === 'End') && !isStart && !isEnd) return null
    if (isStart) {
      // A second Start or a Start after End is ambiguous structure, not a
      // reason to silently choose one lifecycle block.
      if (startLine >= 0) return null
      startLine = index
      continue
    }
    if (isEnd) {
      // End must follow Start in the bounded record stream. This also rejects
      // a preamble End that could otherwise be paired with a later Start.
      if (startLine < 0 || endLine >= 0) return null
      endLine = index
      continue
    }
    if (startLine >= 0 && endLine < 0 && measurementLike(line)) hasMeasurement = true
  }
  if (startLine < 0 || endLine < 0 || !hasMeasurement) return null

  return {
    format: 'survey-cloud-suc',
    vendor: '测量云',
    confidence: 0.98,
    signatures: ['SUC four-field header + Start/End lifecycle records + six-field measurement record'],
    method: 'structural-probe'
  }
}

const SAFE_EXTENSION_FALLBACKS: Readonly<Record<string, Readonly<{ format: SurveyFormatIdV1; vendor: string }>>> = {
  '.in1': { format: 'cosa-in1', vendor: 'COSA(科傻)' },
  '.net': { format: 'cosa-net', vendor: 'COSA(科傻)' },
  '.ou1': { format: 'cosa-ou1', vendor: 'COSA(科傻)' },
  '.ou2': { format: 'cosa-ou2', vendor: 'COSA(科傻)' },
  '.dat': { format: 'south-dat', vendor: 'South/南方测绘' }
}

const SAFE_EXTENSION_FALLBACK_FORMATS = new Set<SurveyFormatIdV1>(Object.values(SAFE_EXTENSION_FALLBACKS).map((fallback) => fallback.format))

function safeExtensionFallback(name: string): Detection | null {
  const ext = extension(name)
  const fallback = SAFE_EXTENSION_FALLBACKS[ext]
  if (!fallback) return null
  return {
    format: fallback.format,
    vendor: fallback.vendor,
    confidence: 0.25,
    signatures: [`${ext} unverified extension fallback`],
    method: 'extension-fallback'
  }
}

function detectText(name: string, text: string): Detection {
  const head = boundedTextProbe(text)
  const rinex = rinexDetection(head)
  if (rinex) return rinex
  if (/^%=?(?:SNX|TRO|BIA)/m.test(head) || /\+SOLUTION\/ESTIMATE/.test(head)) return { format: 'sinex', vendor: 'IERS/IGS', confidence: 1, signatures: ['SINEX header/section'] }
  if (/^\$(?:GP|GN|GL|GA|GB|BD)[A-Z]{3},/m.test(head)) return { format: 'nmea-0183', vendor: 'NMEA', confidence: 0.99, signatures: ['NMEA talker sentence'] }
  if (/^[#%][A-Z0-9_]+A?,[^\r\n]*;[^\r\n]+/m.test(head) && /(?:NOVATEL|BESTPOS|RANGE|RXSTATUS|HEADING)/i.test(head)) return { format: 'novatel-oem', vendor: 'NovAtel', confidence: 0.98, signatures: ['NovAtel OEM ASCII log'] }
  if (/^#[a-f]?[PV].{40,}/m.test(head) && /^##\s+\d+/m.test(head)) return { format: 'sp3', vendor: 'IGS', confidence: 0.99, signatures: ['SP3 header'] }
  if (/IONEX VERSION \/ TYPE/.test(head)) return { format: 'ionex', vendor: 'IGS', confidence: 1, signatures: ['IONEX VERSION / TYPE'] }
  if (/ANTEX VERSION \/ SYST/.test(head)) return { format: 'antex', vendor: 'IGS', confidence: 1, signatures: ['ANTEX VERSION / SYST'] }
  if (/<(?:\w+:)?LandXML\b/i.test(head)) return { format: 'landxml', vendor: 'LandXML', version: /version=["']([^"']+)/i.exec(head)?.[1], confidence: 1, signatures: ['LandXML root'] }
  if (/<(?:\w+:)?(?:JOBFile|JobXML)\b/i.test(head) || /Trimble[^<]{0,40}JobXML/i.test(head)) return { format: 'trimble-jobxml', vendor: 'Trimble', version: /version=["']([^"']+)/i.exec(head)?.[1], confidence: 1, signatures: ['JobXML/JXL root'] }
  if (/<(?:\w+:)?HeXML\b/i.test(head) || /HeXML\s+Version/i.test(head)) return { format: 'leica-hexml', vendor: 'Leica/Hexagon', version: /version=["']([^"']+)/i.exec(head)?.[1], confidence: 1, signatures: ['HeXML root'] }
  const gsiWord = /(?:^|\s)\*?\d{2}[^+\-\s]{0,8}[+-]\d{8,16}(?=\s|$)/m.exec(head)
  if (gsiWord) {
    const digits = /[+-](\d+)$/.exec(gsiWord[0].trim())?.[1]?.length ?? 8
    return { format: digits > 8 ? 'leica-gsi16' : 'leica-gsi8', vendor: 'Leica/Hexagon', confidence: 0.98, signatures: ['GSI word index/sign/value'] }
  }
  if (/\bFor\s+M5\b/i.test(head) || /\|\s*(?:Adr|KD1|Rb|Rf|HD|Z)\b/i.test(head)) return { format: 'trimble-m5', vendor: 'Trimble/Zeiss', confidence: 0.96, signatures: ['M5 tagged record'] }
  if (/^CO,Nikon RAW data format\b/im.test(head) || (/\bNikon\b/i.test(head) && /^(?:ST|F1|SS|MP),/m.test(head))) return { format: 'nikon-raw', vendor: 'Nikon', version: /Nikon RAW data format\s+V?([^,\s]+)/i.exec(head)?.[1], confidence: 0.99, signatures: ['Nikon RAW header/record codes'] }
  if (/^(?:JB|MO|OC|BK|SS|TR|GPS),/m.test(head)) {
    const format = extension(name) === '.rw5' || /Carlson/i.test(head) ? 'carlson-rw5' : 'tds-raw'
    return { format, vendor: format === 'carlson-rw5' ? 'Carlson' : 'TDS/Trimble', confidence: 0.96, signatures: ['RAW/RW5 record codes'] }
  }
  if (/\bTOPCON\b/i.test(head) && /\b(?:GTS-?7|GTS7)\b/i.test(head)) return { format: 'topcon-gts7', vendor: 'Topcon', confidence: 0.94, signatures: ['Topcon GTS-7 header'] }
  if (/\bTOPCON\b/i.test(head) && /\bFC-?5\b/i.test(head)) return { format: 'topcon-fc5', vendor: 'Topcon', confidence: 0.94, signatures: ['Topcon FC-5 header'] }
  if (/\b(?:Spectra Precision|Survey Pro)\b/i.test(head)) return { format: 'spectra-survey-pro', vendor: 'Spectra Precision', confidence: 0.92, signatures: ['Survey Pro header'] }
  if (/^(?:00|01|02|03|04|07|08|09)[A-Z0-9]{0,3}.{20,}/m.test(head) && /SDR|SOKKIA|SET\d|SRX\d|CX-\d/i.test(head)) return { format: 'sokkia-sdr', vendor: 'Sokkia', version: /00NM(?:SDR)?(20|33)\b/i.exec(head)?.[1] ? `SDR${/00NM(?:SDR)?(20|33)\b/i.exec(head)![1]}` : undefined, confidence: 0.94, signatures: ['SDR fixed-width record'] }
  const trimmed = head.trimStart()
  if (new RegExp(`"format"\\s*:\\s*"${WORKWISE_SURVEY_SOURCE_FORMAT}"`).test(trimmed) && new RegExp(`"formatVersion"\\s*:\\s*${WORKWISE_SURVEY_SOURCE_FORMAT_VERSION}\\b`).test(trimmed)) {
    return { format: 'workwise-json', vendor: 'WorkWise/open', version: String(WORKWISE_SURVEY_SOURCE_FORMAT_VERSION), confidence: 0.99, signatures: [`${WORKWISE_SURVEY_SOURCE_FORMAT}@${WORKWISE_SURVEY_SOURCE_FORMAT_VERSION}`] }
  }
  // Arbitrary JSON must not inherit the frozen WorkWise source contract just
  // because it starts with a JSON token. It remains unknown/archive-only.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return { format: 'unknown', vendor: 'unknown', confidence: 0, signatures: [] }
  const cosaIn2 = probeCosaIn2(head)
  if (cosaIn2) return cosaIn2
  const surveyCloudSuc = probeSurveyCloudSuc(head)
  if (surveyCloudSuc) return surveyCloudSuc
  // `.in2` has an explicit parser path only. A failed COSA probe must never
  // be relabelled as a generic delimited table merely because it has commas.
  if (extension(name) === '.in2') return { format: 'unknown', vendor: 'unknown', confidence: 0, signatures: [] }
  const extensionFallback = safeExtensionFallback(name)
  if (extensionFallback) return extensionFallback
  const first = boundedLines(head).find((line) => line.trim() && !line.trim().startsWith('#')) ?? ''
  if ((first.includes(',') || first.includes('\t') || first.includes(';')) && /[A-Za-z\u4e00-\u9fff]/.test(first)) return { format: 'delimited-text', vendor: 'open', confidence: 0.75, signatures: ['delimited header'] }
  const ext = extension(name)
  const opaque = expectedFormats(ext)?.[0]
  if (opaque && CONVERTER_FORMATS.has(opaque)) return { format: opaque, vendor: vendorForFormat(opaque), confidence: 0.5, signatures: ['opaque vendor extension'] }
  if (opaque && GNSS_STREAM_FORMATS.has(opaque)) return { format: opaque, vendor: vendorForFormat(opaque), confidence: 0.5, signatures: ['GNSS receiver extension'] }
  if (opaque && FIELD_REVIEW_FORMATS.has(opaque)) return { format: opaque, vendor: vendorForFormat(opaque), confidence: 0.45, signatures: ['field-controller extension'] }
  return { format: 'unknown', vendor: 'unknown', confidence: 0, signatures: [] }
}

function detectBinary(name: string, bytes: Buffer): Detection | null {
  bytes = bytes.subarray(0, DETECTION_PROBE_BYTES)
  if (bytes.length >= 3 && bytes[0] === 0xd3 && (bytes[1]! & 0xfc) === 0) return { format: 'rtcm3', vendor: 'RTCM', version: '3.x', confidence: 0.98, signatures: ['0xD3 RTCM3 frame'] }
  if (bytes.length >= 5 && (bytes[0] === 0x66 || bytes[0] === 0x99)) return { format: 'rtcm2', vendor: 'RTCM', version: '2.x', confidence: 0.78, signatures: ['RTCM2 0x66/0x99 preamble'] }
  if (bytes.length >= 2 && bytes[0] === 0xb5 && bytes[1] === 0x62) return { format: 'ublox-ubx', vendor: 'u-blox', confidence: 1, signatures: ['UBX 0xB5 0x62 sync'] }
  if (bytes.length >= 3 && bytes[0] === 0xaa && bytes[1] === 0x44 && (bytes[2] === 0x12 || bytes[2] === 0x13)) return { format: 'novatel-oem', vendor: 'NovAtel', confidence: 1, signatures: ['NovAtel OEM binary sync'] }
  if (bytes.length >= 2 && bytes[0] === 0x24 && bytes[1] === 0x40) return { format: 'septentrio-sbf', vendor: 'Septentrio', confidence: 1, signatures: ['SBF $@ sync'] }
  if (bytes.length >= 1 && [0xc2, 0xd2, 0xe2, 0xf2].includes(bytes[0]!)) return { format: 'binex', vendor: 'BINEX', confidence: 0.9, signatures: ['BINEX enhanced-record sync'] }
  const extensionFallback = safeExtensionFallback(name)
  if (extensionFallback) return extensionFallback
  const ext = extension(name)
  const opaque = expectedFormats(ext)?.[0]
  if (opaque && CONVERTER_FORMATS.has(opaque)) return { format: opaque, vendor: vendorForFormat(opaque), confidence: 0.5, signatures: ['opaque vendor extension'] }
  if (opaque && GNSS_STREAM_FORMATS.has(opaque)) return { format: opaque, vendor: vendorForFormat(opaque), confidence: 0.5, signatures: ['GNSS receiver extension'] }
  if (opaque && FIELD_REVIEW_FORMATS.has(opaque)) return { format: opaque, vendor: vendorForFormat(opaque), confidence: 0.45, signatures: ['field-controller extension'] }
  return null
}

function looksBinary(bytes: Buffer): boolean {
  // UTF-16 survey exports naturally contain NUL bytes. A BOM identifies them
  // as text before the generic control-byte heuristic runs.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false
  const probe = bytes.subarray(0, Math.min(bytes.length, 8_192))
  if (!probe.length) return false
  let controls = 0
  for (const value of probe) if (value === 0 || (value < 9 && value !== 0)) controls += 1
  return controls / probe.length > 0.01
}

const GNSS_STREAM_FORMATS = new Set<SurveyFormatIdV1>([
  'rinex-observation', 'rinex-navigation', 'rinex-meteorological', 'rinex-clock',
  'sinex', 'nmea-0183', 'rtcm2', 'rtcm3', 'sp3', 'ionex', 'antex',
  'ublox-ubx', 'novatel-oem', 'septentrio-sbf', 'binex', 'javad-jps', 'topcon-tps',
  'south-sth', 'hitarget-zhd', 'chcnav-hcn', 'comnav-cnb'
])

const CONVERTER_FORMATS = new Set<SurveyFormatIdV1>([
  'hatanaka-rinex', 'trimble-t00', 'trimble-t01', 'trimble-t02', 'trimble-t04', 'trimble-job',
  'leica-dbx', 'leica-mdb', 'spectra-survey-pro'
])

const FIELD_REVIEW_FORMATS = new Set<SurveyFormatIdV1>([
  'topcon-gts7', 'topcon-fc5', 'nikon-raw'
])

function vendorForFormat(format: SurveyFormatIdV1): string {
  if (format.startsWith('cosa')) return 'COSA(科傻)'
  if (format.startsWith('trimble')) return 'Trimble'
  if (format.startsWith('leica')) return 'Leica/Hexagon'
  if (format.startsWith('topcon')) return 'Topcon'
  if (format.startsWith('nikon')) return 'Nikon'
  if (format.startsWith('spectra')) return 'Spectra Precision'
  if (format.startsWith('ublox')) return 'u-blox'
  if (format.startsWith('novatel')) return 'NovAtel'
  if (format.startsWith('septentrio')) return 'Septentrio'
  if (format.startsWith('javad')) return 'Javad'
  if (format.startsWith('south')) return 'South/南方测绘'
  if (format.startsWith('hitarget')) return 'Hi-Target/中海达'
  if (format.startsWith('chcnav')) return 'CHCNAV/华测导航'
  if (format.startsWith('comnav')) return 'ComNav/司南导航'
  return format === 'binex' ? 'BINEX' : format.toUpperCase()
}

function cosaIn2CatalogEntry() {
  const catalogEntry = findP0SurveyFormatEntry('cosa-in2')
  if (!catalogEntry) throw new Error('The bounded P0 catalogue is missing the cosa-in2 entry')
  return catalogEntry
}

export function isGnssSurveyFormat(format: SurveyFormatIdV1): boolean {
  return GNSS_STREAM_FORMATS.has(format) || ['hatanaka-rinex', 'trimble-t00', 'trimble-t01', 'trimble-t02', 'trimble-t04'].includes(format)
}

function sourceDisposition(format: SurveyFormatIdV1): SurveyImportDispositionV1 {
  // Keep runtime defaults in lockstep with the bounded P0 capability policy.
  // The explicitly accepted open formats have a separate, frozen contract
  // (rather than a vendor parser claim). Every other non-P0 source starts in
  // a non-adjustment disposition.
  const p0CatalogEntry = findP0SurveyFormatEntry(format)
  if (p0CatalogEntry) return p0CatalogEntry.currentDisposition
  if (isAcceptedOpenSurveyInputFormat(format)) return 'adjustment-ready'
  if (GNSS_STREAM_FORMATS.has(format)) return 'gnss-processing-required'
  if (CONVERTER_FORMATS.has(format)) return 'converter-required'
  return 'archive-only'
}

/**
 * P0 parser output describes what was decoded; this policy is the sole source
 * of the SourceFile capability/disposition claim. A hard parse/detection
 * failure may only further restrict the catalogue policy to archive-only.
 */
function p0CatalogRuntimePolicy(
  format: SurveyFormatIdV1,
  options: Readonly<{ safetyBlocked: boolean; parserCapabilityRestricted: boolean; hasAuditableParse: boolean }>
): Readonly<{
  disposition: SurveyImportDispositionV1
  dispositionReason?: string
  requiresManualConfirmation: boolean
  diagnostic: SurveyImportDiagnosticV1
  dispositionReasonEn?: string
}> | undefined {
  const catalogEntry = findP0SurveyFormatEntry(format)
  if (!catalogEntry) return undefined

  const catalogDisposition: SurveyImportDispositionV1 = catalogEntry.currentDisposition
  const disposition: SurveyImportDispositionV1 = options.safetyBlocked || options.parserCapabilityRestricted ? 'archive-only' : catalogDisposition
  const englishPolicy = catalogEntry.currentDispositionReasonEn ?? catalogEntry.currentDispositionReason
  const englishAction = disposition === 'adjustment-ready'
    ? 'Validate datum, control points, observation roles, topology, closure and precision; any failed condition blocks adjustment.'
    : 'Inspect raw records, explicit mappings and parser diagnostics; correct the input and repeat detection/import.'
  const englishReason = `${disposition}: ${disposition !== catalogDisposition ? 'Parser capability restrictions take precedence; ' : ''}P0 format catalog ${catalogEntry.registryVersion} — ${englishPolicy}`
  const retained = options.hasAuditableParse ? '已保留可审计的解析对象' : '已保留原始源文件'
  return {
    disposition,
    // A hard failure should retain its source-specific, blocking reason. For a
    // successful parse, the P0 catalogue is the recorded capability authority.
    ...(options.safetyBlocked ? {} : {
      dispositionReason: `${disposition}: ${disposition !== catalogDisposition ? '解析器能力限制优先；' : ''}P0 格式目录 ${catalogEntry.registryVersion} — ${catalogEntry.currentDispositionReason}`
    }),
    ...(!options.safetyBlocked ? { dispositionReasonEn: englishReason } : {}),
    requiresManualConfirmation: disposition !== 'adjustment-ready',
    diagnostic: {
      code: 'format_detected',
      severity: 'warning',
      localized: { en: { message: `${catalogEntry.formatId}: ${options.hasAuditableParse ? 'auditable parsed objects retained' : 'original source retained'}; P0 format catalog ${catalogEntry.registryVersion} permits ${catalogDisposition}: ${englishPolicy}`, suggestedAction: englishAction } },
      message: `${catalogEntry.vendor} / ${catalogEntry.formatId} ${retained}；P0 格式目录 ${catalogEntry.registryVersion} 当前能力策略为 ${catalogDisposition}：${catalogEntry.currentDispositionReason}`,
      suggestedAction: disposition === 'adjustment-ready'
        ? '继续完成基准、控制点、观测角色、拓扑、闭合与精度校验；任一条件不满足都会阻断平差。'
        : '检查原始记录、显式映射和解析诊断；修正后通过重新检测/导入流程复核。'
    }
  }
}

/**
 * A recognizer/parser may preserve a useful, reviewable projection of a P1,
 * P2, or otherwise unaccepted format. That evidence is intentionally not an
 * acceptance decision: only the P0 catalogue (or the established open-input
 * path) can grant adjustment readiness. Keep parsed values and provenance for
 * inspection, but fail closed at the SourceFile capability boundary.
 */
function nonP0RuntimePolicy(
  format: SurveyFormatIdV1,
  options: Readonly<{
    hardArchive: boolean
    parserDisposition?: SurveyImportDispositionV1
    hasAuditableParse: boolean
  }>
): Readonly<{
  disposition: SurveyImportDispositionV1
  dispositionReason: string
  requiresManualConfirmation: boolean
  diagnostic: SurveyImportDiagnosticV1
}> | undefined {
  if (format === 'unknown' || findP0SurveyFormatEntry(format) || isAcceptedOpenSurveyInputFormat(format)) return undefined

  if (isMappingRequiredOpenSurveyInputFormat(format)) {
    const label = format === 'xlsx' ? 'Excel XLSX' : 'CSV / 分隔文本'
    return {
      disposition: 'archive-only',
      dispositionReason: `archive-only: ${label} 尚未附带 F-FMT-10 所需的已保存列映射、线性单位、角度格式和用户确认记录；不得以表头猜测代替确认后进入平差。`,
      requiresManualConfirmation: true,
      diagnostic: {
        code: 'mapping_required',
        severity: 'blocking',
        message: `${label} 已保留供审查，但没有可追溯的列映射、单位和角度格式确认；当前只能归档，不能进入平差。`,
        suggestedAction: '先在 F-FMT-10 映射工作流中选择列、线性单位和角度格式，保存映射方案并完成用户确认；该流程尚未实现时请使用受冻结 WorkWise JSON 合同的输入。'
      }
    }
  }

  const parserRestriction = options.parserDisposition && options.parserDisposition !== 'adjustment-ready'
    ? options.parserDisposition
    : undefined
  const disposition: SurveyImportDispositionV1 = options.hardArchive
    ? 'archive-only'
    : parserRestriction ?? sourceDisposition(format)
  const retained = options.hasAuditableParse ? '已保留可审计的解析对象及原始记录锚点' : '已保留原始源文件'
  const nextAction = disposition === 'gnss-processing-required'
    ? '请先完成受审计的 GNSS 后处理，并重新导入带固定基准和完整协方差的基线结果。'
    : disposition === 'converter-required'
      ? '请使用经审计、本地提供且哈希固定的格式转换器生成受支持格式后重新导入。'
      : '请保留原始文件；按该格式的已批准里程碑补齐规格、真实/negative fixtures、互操作验收并显式登记受理决定后再进入平差。'
  const unitBoundary = format === 'landxml'
    ? 'LandXML 的 Units.angleUnit / directionUnit 及方向参考语义尚未完成互操作验收，解析字段不构成可平差的单位解释。'
    : ''
  const policyMessage = `${detectionPolicyLabel(format)} 不在当前 P0 厂商格式受理目录中；解析器或 fixture 识别仅用于审计和预检，不构成 adjustment-ready 许可。${unitBoundary}当前处置为 ${disposition}。`
  return {
    disposition,
    dispositionReason: `${disposition}: ${policyMessage}`,
    requiresManualConfirmation: true,
    diagnostic: {
      code: 'format_detected',
      severity: 'warning',
      message: `${retained}，但 ${policyMessage}`,
      suggestedAction: nextAction
    }
  }
}

function detectionPolicyLabel(format: SurveyFormatIdV1): string {
  return `格式 ${format}`
}

function detectionWithExtension(name: string, detected: Detection): SurveyFormatDetectionV1 {
  const ext = extension(name)
  const expected = expectedFormats(ext)
  const conflict = Boolean(expected && detected.format !== 'unknown' && !expected.includes(detected.format))
  const method = detected.method ?? (detected.signatures.some((signature) => /extension$/i.test(signature))
    ? 'extension-fallback'
    : 'content-signature')
  return SurveyFormatDetectionV1.parse({
    format: detected.format,
    vendor: detected.vendor,
    version: detected.version,
    confidence: detected.confidence,
    extension: ext || undefined,
    matchedSignatures: detected.signatures,
    extensionConflict: conflict,
    method
  })
}

type UnwrappedSurveySource = Readonly<{
  name: string
  bytes: Buffer
  diagnostics: SurveyImportDiagnosticV1[]
  /** Whether record offsets address the preserved attachment or a container member. */
  byteSpace: 'original-attachment' | 'container-member'
}>

async function unwrap(name: string, bytes: Buffer): Promise<UnwrappedSurveySource> {
  if (bytes.length > MAX_SOURCE_BYTES) throw new SurveySourceParseError('limit_exceeded', `测量源文件超过 ${MAX_SOURCE_BYTES / (1024 * 1024)} MiB 上限`)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // Verify each member checksum before any archive metadata or content is
    // trusted.  Without CRC32 validation, a damaged ZIP can pass the entry
    // count/path/ratio checks and later be treated as a valid source.
    const zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: true })
    const isOoxmlWorkbook = Boolean(zip.file('[Content_Types].xml') && zip.file('xl/workbook.xml') && Object.keys(zip.files).some((entryName) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entryName)))
    if (isOoxmlWorkbook) {
      const entries = Object.values(zip.files).filter((entry) => !entry.dir)
      if (entries.length > MAX_OOXML_ENTRIES) throw new SurveySourceParseError('limit_exceeded', `Excel OOXML 条目超过 ${MAX_OOXML_ENTRIES.toLocaleString('zh-CN')} 个上限`)
      let expandedTotal = 0
      let compressedTotal = 0
      for (const entry of entries) {
        const internals = (entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data
        expandedTotal += internals?.uncompressedSize ?? 0
        compressedTotal += internals?.compressedSize ?? 0
      }
      if (expandedTotal > MAX_UNWRAPPED_BYTES || expandedTotal / Math.max(1, compressedTotal) > MAX_ARCHIVE_RATIO) throw new SurveySourceParseError('limit_exceeded', 'Excel OOXML 超过安全展开大小或压缩比上限')
      return { name, bytes, diagnostics: [], byteSpace: 'original-attachment' }
    }
    if (extension(name) === '.xlsx') throw new SurveySourceParseError('unsafe_archive', '扩展名为 .xlsx，但 ZIP 内容不是有效的 Excel OOXML 工作簿')
    const entries = Object.values(zip.files).filter((entry) => !entry.dir && !entry.name.startsWith('__MACOSX/'))
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new SurveySourceParseError('limit_exceeded', `测量 ZIP 条目超过 ${MAX_ARCHIVE_ENTRIES} 个上限`)
    if (entries.length !== 1) throw new SurveySourceParseError('unsafe_archive', '测量 ZIP 必须只包含一个源文件，不能自动选择多文件中的任意一个')
    const entry = entries[0]!
    const archivedName = entry.unsafeOriginalName || entry.name
    if (archivedName.includes('..') || archivedName.startsWith('/')) throw new SurveySourceParseError('unsafe_archive', '测量 ZIP 包含不安全路径')
    const internals = (entry as unknown as { _data?: { compressedSize?: number; uncompressedSize?: number } })._data
    const expanded = internals?.uncompressedSize ?? 0
    const compressed = Math.max(1, internals?.compressedSize ?? bytes.length)
    if (expanded > MAX_UNWRAPPED_BYTES || expanded / compressed > MAX_ARCHIVE_RATIO) throw new SurveySourceParseError('limit_exceeded', '测量 ZIP 超过安全展开大小或压缩比上限')
    const output = await entry.async('nodebuffer')
    if (output.length > MAX_UNWRAPPED_BYTES || output.length / Math.max(1, bytes.length) > MAX_ARCHIVE_RATIO) throw new SurveySourceParseError('limit_exceeded', '测量 ZIP 超过安全展开大小或压缩比上限')
    return {
      name: archivedName,
      bytes: output,
      diagnostics: [diagnostic('format_detected', 'info', `已从 ZIP 安全展开 ${archivedName}`)],
      byteSpace: 'container-member'
    }
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    let output: Buffer
    try { output = gunzipSync(bytes, { maxOutputLength: MAX_UNWRAPPED_BYTES }) }
    catch { throw new SurveySourceParseError('limit_exceeded', '测量 GZIP 无法在安全展开上限内解压') }
    if (output.length / Math.max(1, bytes.length) > MAX_ARCHIVE_RATIO) throw new SurveySourceParseError('limit_exceeded', '测量 GZIP 超过安全压缩比上限')
    return {
      name: name.replace(/\.gz$/i, ''),
      bytes: output,
      diagnostics: [diagnostic('format_detected', 'info', '已安全展开 GZIP 测量文件')],
      byteSpace: 'container-member'
    }
  }
  return { name, bytes, diagnostics: [], byteSpace: 'original-attachment' }
}

function gsiLexerSourceAnchor(
  lexicalAnchor: LeicaGsiLexAnchor,
  bytes: Buffer,
  text: TextResult | null
): SurveyRawRecordAnchorV1 | undefined {
  const ranges = sourceLineRanges(bytes, text)
  const lineRange = ranges[lexicalAnchor.line - 1]
  if (!lineRange || lexicalAnchor.byteLength <= 0) return undefined
  const utf16 = text?.encoding === 'utf-16le' || text?.encoding === 'utf-16be'
  const byteWidth = utf16 ? 2 : 1
  const rawOffset = lineRange.offset + Math.max(0, lexicalAnchor.column - 1) * byteWidth
  const available = Math.max(0, lineRange.offset + lineRange.length - rawOffset)
  const rawLength = Math.min(available, lexicalAnchor.byteLength * byteWidth)
  if (rawLength <= 0) return undefined
  return SurveyRawRecordAnchorCreateV1.parse({
    id: lexicalAnchor.id,
    sourceRecord: lexicalAnchor.sourceRecord,
    line: lexicalAnchor.line,
    byteOffset: rawOffset,
    byteLength: rawLength,
    rawOffset,
    rawLength,
    rawLineNo: lexicalAnchor.line,
    rawSnippet: rawByteSnippet(bytes, rawOffset, rawLength),
    recordType: 'GSI',
    section: 'leica-gsi-lexical-block'
  })
}

function gsiNumericWord(word: LeicaGsiStandardWord, angular: boolean): { value: number; rawUnit: string } {
  if (!/^\d+$/.test(word.rawData)) throw new RangeError('观测数值字段必须为十进制数字')
  const integer = Number(word.rawData)
  if (!Number.isSafeInteger(integer)) throw new RangeError('观测数值字段超过安全整数范围')
  const value = word.rawSign === '-' ? -integer : integer
  const code = word.information[3]
  // The sixth character declares the scale; GSI16 adds leading capacity,
  // not fractional precision. All conversions reuse the canonical unit API.
  if (angular) {
    switch (code) {
      case '2': return { value: toRadians({ unit: 'gon', value: value / 100_000 }), rawUnit: '2:0.00001-gon' }
      case '3': return { value: toRadians({ unit: 'degree-decimal', value: value / 100_000 }), rawUnit: '3:0.00001-degree' }
      case '4': return { value: toRadians({ unit: 'compact-dms', value: value / 10 }), rawUnit: '4:DDDMMSS.s' }
      case '5': return { value: toRadians({ unit: 'mil', value: value / 10_000, milsPerTurn: 6400 }), rawUnit: '5:0.0001-mil-6400' }
      default: throw new RangeError(`角度 WI${word.wi} 的单位码 ${JSON.stringify(code)} 无效或不是角度单位`)
    }
  }
  switch (code) {
    case '0': return { value: toMetres(value, 'mm'), rawUnit: '0:0.001-m' }
    case '1': return { value: toMetres(value / 1_000, 'ft'), rawUnit: '1:0.001-ft' }
    case '6': return { value: toMetres(value, '0.1mm'), rawUnit: '6:0.0001-m' }
    case '7': return { value: toMetres(value / 10_000, 'ft'), rawUnit: '7:0.0001-ft' }
    case '8': return { value: toMetres(value, '0.01mm'), rawUnit: '8:0.00001-m' }
    default: throw new RangeError(`长度 WI${word.wi} 的单位码 ${JSON.stringify(code)} 无效或不是长度单位`)
  }
}

type ParsedGsiPhysicalRecord = Readonly<{
  physical: LeicaGsiLexRecord
  point?: string
  /** Numeric values are decoded only for semantic WI fields used below. */
  numeric: ReadonlyMap<string, { value: number; rawUnit: string; word: LeicaGsiStandardWord }>
  /** Every physical word remains available to the raw-field ledger. */
  originalFields: Record<string, RawField>
  measurementWords: ReadonlyMap<string, LeicaGsiStandardWord>
}>

/**
 * Leica GSI uses the two-character WI=57 together with the first information
 * character to identify the four leveling distance fields.  The apparent
 * three-digit names (571..574) are semantic keys only; they are never present
 * in the physical source word.
 */
function gsiLevelingSemanticWi(word: LeicaGsiStandardWord): string | undefined {
  if (word.wi !== '57') return word.wi
  const informationCode = word.information[0]
  return informationCode && /^[1-4]$/.test(informationCode) ? `57${informationCode}` : undefined
}

const GSI_LEVELING_NUMERIC_WIS = new Set(['21', '22', '31', '32', '33', '83', '571', '572', '573', '574'])

/**
 * Leica triangle-height exports commonly use Z01/Z02 as local turning-point
 * shots inside every WI41 setup block. They are not global network points:
 * the same identifiers are reused by the next setup. The observations still
 * belong in the adjustment chain, so callers must namespace these IDs by
 * block instead of dropping the records or merging unrelated turns.
 */
function isLeicaGsiLocalTurningPoint(point: string): boolean {
  return /^Z0[12]$/i.test(point)
}

function leicaGsiPointId(point: string, blockIndex: number): string {
  return isLeicaGsiLocalTurningPoint(point)
    ? `gsi-block-${blockIndex + 1}:${point.toUpperCase()}`
    : point
}

/**
 * Decode the bounded semantic subset needed by a Leica leveling GSI block.
 * WI41 is a block delimiter and its payload is intentionally opaque.  All
 * other words remain in originalFields even when they are not used to create
 * an adjustment observation.
 */
function parseGsiPhysicalRecord(physical: LeicaGsiLexRecord, mode: string): ParsedGsiPhysicalRecord {
  const originalFields: Record<string, RawField> = { inputMode: mode }
  const numeric = new Map<string, { value: number; rawUnit: string; word: LeicaGsiStandardWord }>()
  const measurementWords = new Map<string, LeicaGsiStandardWord>()
  let point: string | undefined

  for (const word of physical.words) {
    originalFields[`word-${word.wordIndex}:wi${word.wi}`] = word.rawLexeme
    if (word.kind !== 'standard') continue
    if (word.wi === '11') {
      if (point !== undefined) throw new RangeError(`同一 GSI 物理记录含重复的 WI11 点号`)
      point = `${word.rawSign === '-' ? '-' : ''}${word.rawData.replace(/^0+/, '') || '0'}`
      continue
    }
    // WI41 carries '?......4' (or another attribute-like marker), not a
    // numeric measurement.  Its complete raw lexeme was already retained.
    if (word.wi === '41') continue
    // Decode only known measurement WIs. Unknown attributes stay opaque and
    // must never be guessed as distances or height differences.  WI57 is
    // resolved through its information-code semantic key (571..574).
    const semanticWi = gsiLevelingSemanticWi(word)
    if (!semanticWi || !GSI_LEVELING_NUMERIC_WIS.has(semanticWi)) continue
    const decoded = gsiNumericWord(word, word.wi === '21' || word.wi === '22')
    if (numeric.has(semanticWi)) throw new RangeError(`同一 GSI 物理记录含重复的 ${word.wi === '57' ? `WI57 信息码 ${word.information[0]}` : `WI${word.wi}`}，不能覆盖前一个值`)
    numeric.set(semanticWi, { ...decoded, word })
    measurementWords.set(semanticWi, word)
  }

  return Object.freeze({
    physical,
    ...(point !== undefined ? { point } : {}),
    numeric,
    originalFields,
    measurementWords
  })
}

/**
 * Leica's leveling export groups a setup between WI41 records.  The first
 * data record after WI41 must carry the instrument station WI11; records carrying WI83..08 or WI83..28 are
 * cumulative heights, and WI57 with information code 4 on the same
 * record is the cumulative route distance. Both must be differenced against
 * the preceding record before creating an adjacent route observation.
 * Intermediate WI32/WI33 and
 * WI57 information codes 1/2/3 stay provenance only; they are not promoted
 * to canonical observations.
 */
function parseLeicaGsiLevelingBlocks(
  lexed: Extract<ReturnType<typeof lexLeicaGsi>, { state: 'lexed' }>,
  sourceBytes?: Buffer
): ParsedSource {
  const records = lexed.records
  const anchors = records.map((physical) => anchor(physical.line, 'GSI'))
  const diagnostics: SurveyImportDiagnosticV1[] = []
  const points: SurveyPoint[] = []
  const observations: SurveyObservation[] = []
  const linearUnits = new Set<string>()
  const angularUnits = new Set<string>()
  const blocks: Array<{ marker: LeicaGsiLexRecord; records: LeicaGsiLexRecord[] }> = []
  let current: { marker: LeicaGsiLexRecord; records: LeicaGsiLexRecord[] } | undefined

  for (const physical of records) {
    const isMarker = physical.words.some((word) => word.kind === 'standard' && word.wi === '41')
    if (isMarker) {
      if (current) blocks.push(current)
      current = { marker: physical, records: [] }
      continue
    }
    if (!current) {
      diagnostics.push({
        ...diagnostic('invalid_record', 'blocking', 'Leica GSI 在首个 WI41 测量块前出现数据记录，无法确定设站边界。', physical.line),
        localized: { en: { message: `Leica GSI has data before the first WI41 block; the setup boundary is unknown.`, suggestedAction: 'Keep the complete original GSI and reimport an export containing the WI41 block header.' } },
        suggestedAction: '保留完整原始 GSI，并从包含 WI41 块起始记录的原始导出重新导入。'
      })
      continue
    }
    current.records.push(physical)
  }
  if (current) blocks.push(current)
  if (!blocks.length) {
    diagnostics.push({
      ...diagnostic('invalid_record', 'blocking', 'Leica GSI 未找到可解释的 WI41 测量块。', 1),
      localized: { en: { message: `No interpretable WI41 measurement block was found in Leica GSI.`, suggestedAction: 'Confirm this is a Leica height GSI export with WI41 setup blocks; use the compatible parser path for ordinary GSI observations.' } },
      suggestedAction: '确认该附件是包含 WI41 设站块的 Leica 高程 GSI 导出；普通 GSI 观测应使用兼容解析路径。'
    })
  }

  const parsedByLine = new Map<number, ParsedGsiPhysicalRecord | null>()
  const parseRecord = (physical: LeicaGsiLexRecord): ParsedGsiPhysicalRecord | undefined => {
    const cached = parsedByLine.get(physical.line)
    if (cached !== undefined) return cached ?? undefined
    try {
      const parsed = parseGsiPhysicalRecord(physical, lexed.mode)
      parsedByLine.set(physical.line, parsed)
      return parsed
    } catch (error) {
      parsedByLine.set(physical.line, null)
      diagnostics.push({
        ...diagnostic('invalid_record', 'blocking', `Leica GSI 第 ${physical.line} 行数值语义校验失败：${error instanceof Error ? error.message : String(error)}`, physical.line),
        suggestedAction: '保留原始 GSI 记录，核对 WI11、WI57/WI83 信息码和单位字段后重新导入。'
      })
      return undefined
    }
  }

  for (const [blockIndex, block] of blocks.entries()) {
    let stationRecord: ParsedGsiPhysicalRecord | undefined
    let previousCumulativeDistance: { value: number; rawUnit: string; word: LeicaGsiStandardWord } | undefined
    const firstPhysical = block.records[0]
    if (firstPhysical) stationRecord = parseRecord(firstPhysical)
    if (!stationRecord?.point) {
      diagnostics.push({
        ...diagnostic('invalid_record', 'blocking', `Leica GSI WI41 块 ${blockIndex + 1} 缺少首个 WI11 设站点号。`, block.marker.line),
        localized: { en: { message: `Leica GSI WI41 block ${blockIndex + 1} has no initial WI11 station ID.`, suggestedAction: 'Ensure every WI41 is followed by a WI11 station record; do not infer station IDs from auxiliary fields.' } },
        suggestedAction: '确认每个 WI41 之后紧跟包含设站点号的 WI11 记录；不要用辅助字段推断点号。'
      })
      continue
    }
    const station = stationRecord.point
    const initialHeight = stationRecord.numeric.get('83')
    if (!initialHeight || !['..18', '..58'].includes(initialHeight.word.information)) {
      diagnostics.push({
        ...diagnostic('invalid_record', 'blocking', `Leica GSI WI41 块 ${blockIndex + 1} 缺少首个 WI83 初始化高程，无法确定累计高程起点。`, stationRecord.physical.line),
        localized: { en: { message: `Leica GSI WI41 block ${blockIndex + 1} has no initial WI83 height; the cumulative-height origin is unknown.`, suggestedAction: 'Re-export the complete section including its initial height; never assume cumulative heights start at zero.' } },
        suggestedAction: '从仪器重新导出包含初始高程记录的完整测段；不能假定累计高程从零开始。'
      })
      continue
    }
    let previousCumulativeHeight = { ...initialHeight, line: stationRecord.physical.line }
    linearUnits.add(initialHeight.rawUnit)
    // A WI41 block is a sequential leveling route. The first final height
    // record starts at the setup station; every later record starts at the
    // previous final target (including local turning points).
    let previousPointId = station
    points.push(SurveyPointV1.parse({
      id: station,
      pointClass: 'station',
      known: false,
      sourceRow: stationRecord.physical.line,
      sourceLocator: `GSI:${stationRecord.physical.line}`,
      rawFields: { ...stationRecord.originalFields, role: 'station', blockId: `gsi-block-${blockIndex + 1}` }
    }))

    for (const physical of block.records) {
      // Leica leveling exports use two final-height information codes in the
      // field: `..08` and `..28`. `..18`/`..58` are setup initialization
      // records and remain provenance-only. Keep this accepted set explicit
      // so an unknown WI83 variant cannot become an adjustment observation.
      const finalHeightWords = physical.words.filter((word) => word.kind === 'standard' && word.wi === '83' && (word.information === '..08' || word.information === '..28'))
      const finalHeightWord = finalHeightWords[0]
      if (!finalHeightWord || finalHeightWord.kind !== 'standard') continue
      if (finalHeightWords.length > 1) {
        diagnostics.push({
          ...diagnostic('invalid_record', 'blocking', `Leica GSI 第 ${physical.line} 行含重复的最终 WI83..08/..28 高差字段。`, physical.line),
          localized: { en: { message: `Leica GSI line ${physical.line} has duplicate final WI83..08/..28 height fields.`, suggestedAction: 'Preserve the original and re-export with exactly one WI83..08 or WI83..28 field per final-height record.' } },
          suggestedAction: '保留原始记录并重新导出，确保每条最终高差记录只包含一个 WI83..08 或 WI83..28。'
        })
        continue
      }
      const parsed = parseRecord(physical)
      if (!parsed) continue
      if (!parsed.point) {
        diagnostics.push({
          ...diagnostic('invalid_record', 'blocking', `Leica GSI 第 ${physical.line} 行含最终 WI83..08/..28，但缺少同记录 WI11 目标点号。`, physical.line),
          localized: { en: { message: `Leica GSI line ${physical.line} has final WI83..08/..28 but no WI11 target on the same record.`, suggestedAction: 'Include WI11 target ID in the final-height record; do not infer targets from adjacent physical lines.' } },
          suggestedAction: '确保最终高差记录同时携带目标点 WI11；不得从相邻物理行猜测目标。'
        })
        continue
      }
      const rawTarget = parsed.point
      const target = leicaGsiPointId(rawTarget, blockIndex)
      const from = previousPointId
      const height = parsed.numeric.get('83')
      if (!height) {
        diagnostics.push({
          ...diagnostic('invalid_record', 'blocking', `Leica GSI 第 ${physical.line} 行的最终 WI83..08/..28 无法解码。`, physical.line),
          localized: { en: { message: `Leica GSI line ${physical.line} has an undecodable final WI83..08/..28 field.`, suggestedAction: 'Check WI83 unit codes and numeric fields, retaining the original GSI record.' } },
          suggestedAction: '核对 WI83 的单位码和数值字段，并保留原始 GSI 记录。'
        })
        continue
      }
      linearUnits.add(height.rawUnit)
      const cumulativeDistance = parsed.numeric.get('574')
      if (cumulativeDistance) linearUnits.add(cumulativeDistance.rawUnit)
      const routeLengthDelta = cumulativeDistance
        ? cumulativeDistance.value - (previousCumulativeDistance?.value ?? 0)
        : undefined
      if (cumulativeDistance && previousCumulativeDistance && routeLengthDelta !== undefined && routeLengthDelta <= 0) {
        diagnostics.push({
          ...diagnostic('invalid_record', 'blocking', `Leica GSI 第 ${physical.line} 行的 WI57 信息码 4 累计距离未严格递增（当前 ${cumulativeDistance.value}，前值 ${previousCumulativeDistance.value}）。`, physical.line),
          localized: { en: { message: `Leica GSI line ${physical.line}: WI57 information code 4 cumulative distance is not strictly increasing (current ${cumulativeDistance.value}, previous ${previousCumulativeDistance.value}).`, suggestedAction: 'Check WI57 information code 4 cumulative distances within the setup; correct or re-export non-increasing records before adjustment.' } },
          suggestedAction: '核对设站块内 WI57 信息码 4 的累计距离顺序；修正或重新导出非递增记录后再平差。'
        })
        continue
      }
      const routeLength = routeLengthDelta !== undefined && routeLengthDelta > 0 ? routeLengthDelta : undefined

      points.push(SurveyPointV1.parse({
        id: target,
        pointClass: 'unknown',
        known: false,
        sourceRow: physical.line,
        sourceLocator: `GSI:${physical.line}`,
        rawFields: {
          ...parsed.originalFields,
          role: 'target',
          blockId: `gsi-block-${blockIndex + 1}`,
          ...(target === rawTarget ? {} : { rawPointId: rawTarget, localTurningPoint: true })
        }
      }))
      // Only a true self-edge is a closure-check record. A normal route may
      // finish at the setup station after passing through a local turning
      // point (for example Z02 -> Y04H02); that edge must remain in the
      // production network. Compare the sequential chain endpoints rather
      // than the instrument station alone.
      if (from === target) {
        if (cumulativeDistance) previousCumulativeDistance = cumulativeDistance
        previousCumulativeHeight = { ...height, line: physical.line }
        diagnostics.push({
          ...diagnostic('record_ignored', 'warning', `Leica GSI 第 ${physical.line} 行是 ${station} 到自身的闭合检查记录，未作为生产网络边发布。`, physical.line),
          localized: { en: { message: `Leica GSI line ${physical.line} is a self-closure check at ${station}; it was excluded from production network edges.`, suggestedAction: 'Inspect the original closure-check record separately before adjustment; do not add self-edges to the production network.' } },
          suggestedAction: '如需检查闭合量，请在平差前单独查看该原始记录；不要将自闭合边加入生产网络。'
        })
        continue
      }
      const rawFields: Record<string, RawField> = {
        ...parsed.originalFields,
        blockId: `gsi-block-${blockIndex + 1}`,
        instrumentStation: station,
        station: from,
        from,
        target,
        ...(target === rawTarget ? {} : { rawPointId: rawTarget, rawTarget, localTurningPoint: true }),
        heightDifferenceUnit: 'm',
        heightDifferenceSource: 'adjacent-WI83-cumulative-height-difference',
        heightCumulativeValue: height.value,
        heightPreviousCumulativeValue: previousCumulativeHeight.value,
        heightPreviousRawLexeme: previousCumulativeHeight.word.rawLexeme,
        heightPreviousRecordId: `record-${previousCumulativeHeight.line}`,
        ...(cumulativeDistance ? {
          routeLengthUnit: 'm',
          routeLengthSource: 'WI57 information code 4 (cumulative)',
          routeLengthCumulativeValue: cumulativeDistance.value,
          routeLengthCumulativeUnit: cumulativeDistance.rawUnit,
          routeLengthRawValue: `${cumulativeDistance.word.rawSign}${cumulativeDistance.word.rawData}`,
          routeLengthInformation: cumulativeDistance.word.information,
          routeLengthRawLexeme: cumulativeDistance.word.rawLexeme,
          ...(previousCumulativeDistance ? {
            routeLengthPreviousCumulativeValue: previousCumulativeDistance.value,
            routeLengthPreviousCumulativeUnit: previousCumulativeDistance.rawUnit,
            routeLengthPreviousRawValue: `${previousCumulativeDistance.word.rawSign}${previousCumulativeDistance.word.rawData}`,
            routeLengthDeltaValue: routeLengthDelta ?? null,
            routeLengthDeltaUnit: 'm'
          } : {
            routeLengthDeltaValue: routeLengthDelta ?? null,
            routeLengthDeltaUnit: 'm'
          })
        } : {}),
        heightDifferenceRawValue: `${finalHeightWord.rawSign}${finalHeightWord.rawData}`,
        heightDifferenceInformation: finalHeightWord.information,
        heightDifferenceRawLexeme: finalHeightWord.rawLexeme,
      }
      observations.push(SurveyObservationV1.parse({
        id: `gsi-block-${blockIndex + 1}-line-${physical.line}-dh`,
        type: 'height-difference',
        from,
        to: target,
        station: from,
        target,
        value: height.value - previousCumulativeHeight.value,
        unit: 'm',
        ...(routeLength !== undefined ? { routeLength } : {}),
        sourceRow: physical.line,
        sourceLocator: `GSI:${physical.line}`,
        sourceRecordId: `record-${physical.line}`,
        qualityFlags: ['leica-gsi-wi41-block', 'leica-gsi-final-wi83', 'leica-gsi-wi83-cumulative-height', ...(cumulativeDistance ? ['leica-gsi-wi57-cumulative-distance'] : [])],
        rawFields
      }))
      previousPointId = target
      previousCumulativeHeight = { ...height, line: physical.line }
      if (cumulativeDistance) previousCumulativeDistance = cumulativeDistance
    }
  }

  if (!observations.length && !diagnostics.some((item) => item.severity === 'blocking')) {
    diagnostics.push({
      ...diagnostic('invalid_record', 'blocking', 'Leica GSI WI41 文件未产生可识别的最终 WI83..08/..28 高差观测。', blocks[0]?.marker.line ?? 1),
      localized: { en: { message: `Leica GSI WI41 input produced no recognizable final WI83..08/..28 height-difference observations.`, suggestedAction: 'Export final-height records with WI83..08 or WI83..28; intermediate WI32/WI33 cannot replace final heights.' } },
      suggestedAction: '确认原始导出包含带 WI83..08 或 WI83..28 的最终高差记录；中间 WI32/WI33 不能替代最终高差。'
    })
  }
  const classified = classifyPoints(points)
  return {
    ...classified,
    observations,
    diagnostics,
    anchors,
    disposition: observations.length && !diagnostics.some((item) => item.severity === 'blocking') ? 'adjustment-ready' : 'archive-only',
    unit: 'm',
    linearUnitRaw: [...linearUnits].sort().join(', ') || 'not-declared',
    angularUnitRaw: [...angularUnits].sort().join(', ') || 'not-applicable',
    canonicalUnitsVerified: true,
    parserId: 'leica-gsi-leveling-block-parser',
    parserVersion: '0.4.0'
  }
}

function parseLeicaGsi(text: string, format: 'leica-gsi8' | 'leica-gsi16', sourceBytes?: Buffer): ParsedSource {
  // Both physical and numeric validation are transactional: no plausible
  // prefix may escape a malformed source into the observation draft.
  const lexed = lexLeicaGsi(text)
  if (lexed.state === 'blocked') {
    const originalText = sourceBytes ? decodeText(sourceBytes) : null
    const lexicalAnchors = sourceBytes
      ? lexed.diagnostics.flatMap((item) => {
        const resolved = gsiLexerSourceAnchor(item.anchor, sourceBytes, originalText)
        return resolved ? [resolved] : []
      })
      : []
    const lexicalAnchorById = new Map(lexicalAnchors.map((item) => [item.id, item]))
    return {
      knownPoints: [],
      unknownPoints: [],
      observations: [],
      anchors: lexicalAnchors,
      disposition: 'archive-only',
      diagnostics: lexed.diagnostics.map((item) => diagnostic(
        'invalid_record',
        'blocking',
        `Leica GSI 物理词法校验失败（${item.code}）：${item.message}`,
        item.anchor.line
      )).map((item, index) => ({
        ...item,
        ...(sourceBytes && originalText && lexed.diagnostics[index]?.anchor.byteOffset !== undefined ? { byteOffset: gsiLexerSourceAnchor(lexed.diagnostics[index]!.anchor, sourceBytes, originalText)?.byteOffset ?? lexed.diagnostics[index]!.anchor.byteOffset } : {}),
        ...(lexicalAnchorById.get(lexed.diagnostics[index]!.anchor.id) ? { recordAnchor: lexed.diagnostics[index]!.anchor.id } : {})
      })),
      canonicalUnitsVerified: false,
      parserId: 'leica-gsi-physical-lexer',
      parserVersion: '0.1.0'
    }
  }
  const wide = format === 'leica-gsi16'
  if (lexed.dataWidth !== (wide ? 16 : 8)) {
    return {
      knownPoints: [],
      unknownPoints: [],
      observations: [],
      disposition: 'archive-only',
      diagnostics: [diagnostic(
        'format_conflict',
        'blocking',
        `Leica GSI 内容词法识别为 GSI${lexed.dataWidth}，但语义解析器收到的是 ${format}；拒绝继续解释该源文件。`,
        1
      )],
      canonicalUnitsVerified: false,
      parserId: 'leica-gsi-physical-lexer',
      parserVersion: '0.1.0'
    }
  }
  // Real Leica leveling exports use WI41 records to delimit setup blocks.
  // Keep the historical one-physical-line parser for synthetic/simple GSI
  // records that do not carry that delimiter, while routing block-shaped
  // sources through the explicit station/final-WI83 semantic adapter.
  if (lexed.records.some((physical) => physical.words.some((word) => word.kind === 'standard' && word.wi === '41'))) {
    return parseLeicaGsiLevelingBlocks(lexed, sourceBytes)
  }
  if (lexed.records.length > MAX_RECORD_ANCHORS) throw new SurveySourceParseError('limit_exceeded', 'GSI 原始记录超过锚点上限')
  const points: SurveyPoint[] = []
  const observations: SurveyObservation[] = []
  const diagnostics: SurveyImportDiagnosticV1[] = []
  const anchors: SurveyRawRecordAnchorV1[] = []
  const fieldNames: Record<number, string> = { 11: 'point', 21: 'hz', 22: 'zenith', 31: 'slope', 32: 'horizontal', 33: 'heightDifference', 81: 'easting', 82: 'northing', 83: 'height', 84: 'stationEasting', 85: 'stationNorthing', 86: 'stationHeight', 87: 'targetHeight', 88: 'instrumentHeight' }
  const linearUnits = new Set<string>()
  const angularUnits = new Set<string>()
  for (const physical of lexed.records) {
    const index = physical.line - 1
    anchors.push(anchor(physical.line, 'GSI'))
    const record: Record<string, RawField> = {}
    const originalFields: Record<string, RawField> = { inputMode: lexed.mode }
    const measurementWords = new Map<string, LeicaGsiStandardWord>()
    for (const word of physical.words) {
      originalFields[`word-${word.wordIndex}:wi${word.wi}`] = word.rawLexeme
      const wi = Number(word.wi); const name = fieldNames[wi]
      if (!name || word.kind !== 'standard') continue
      try {
        if (name in record) throw new RangeError(`同一记录含重复的 WI${word.wi}，不能覆盖前一个值`)
        if (wi === 11) record[name] = `${word.rawSign === '-' ? '-' : ''}${word.rawData.replace(/^0+/, '') || '0'}`
        else {
          const angular = wi === 21 || wi === 22
          const decoded = gsiNumericWord(word, angular)
          record[name] = decoded.value
          measurementWords.set(name, word)
          ;(angular ? angularUnits : linearUnits).add(decoded.rawUnit)
        }
      } catch (error) {
        const resolved = sourceBytes ? gsiLexerSourceAnchor(word.anchor, sourceBytes, decodeText(sourceBytes)) : undefined
        return {
          knownPoints: [], unknownPoints: [], observations: [],
          anchors: resolved ? [resolved] : [anchor(physical.line, 'GSI')],
          disposition: 'archive-only', canonicalUnitsVerified: false,
          diagnostics: [{
            ...diagnostic('invalid_record', 'blocking', `Leica GSI 数值语义校验失败：${error instanceof Error ? error.message : String(error)}`, physical.line),
            recordAnchor: resolved?.id ?? `record-${physical.line}`,
            byteOffset: resolved?.byteOffset ?? word.byteOffset,
            suggestedAction: '核对原始 word 的 WI、单位码和数值；不得按数据宽度猜测精度或手工补写观测。'
          }]
        }
      }
    }
    const observationRawFields = (name: string): Record<string, RawField> => {
      const word = measurementWords.get(name)!
      return { ...originalFields, rawValue: `${word.rawSign}${word.rawData}`, unitCode: word.information[3]!, information: word.information, rawLexeme: word.rawLexeme }
    }
    const target = typeof record.point === 'string' ? record.point : undefined
    if (!target) { diagnostics.push(diagnostic('record_ignored', 'warning', 'GSI 记录没有 WI11 点号，已保留但未生成观测', index + 1)); continue }
    const stationCoordinate = [record.stationEasting, record.stationNorthing, record.stationHeight].map((value) => typeof value === 'number' ? value : undefined)
    const station = stationCoordinate.some((value) => value !== undefined) ? `STN@${index + 1}` : 'STATION-UNCONFIRMED'
    points.push(SurveyPointV1.parse({ id: station, pointClass: 'station', known: false, x: stationCoordinate[0], y: stationCoordinate[1], height: stationCoordinate[2], sourceRow: index + 1, sourceLocator: `GSI:${index + 1}`, rawFields: originalFields }))
    points.push(SurveyPointV1.parse({ id: target, pointClass: 'unknown', known: false, x: typeof record.easting === 'number' ? record.easting : undefined, y: typeof record.northing === 'number' ? record.northing : undefined, height: typeof record.height === 'number' ? record.height : undefined, sourceRow: index + 1, sourceLocator: `GSI:${index + 1}`, rawFields: originalFields }))
    const common = { from: station, to: target, station, target, stationHeightOffset: typeof record.instrumentHeight === 'number' ? record.instrumentHeight : undefined, targetHeightOffset: typeof record.targetHeight === 'number' ? record.targetHeight : undefined, sourceRow: index + 1, sourceLocator: `GSI:${index + 1}`, sourceRecordId: `record-${index + 1}` }
    if (typeof record.hz === 'number') observations.push(SurveyObservationV1.parse({ id: `gsi-${index + 1}-hz`, type: 'direction', value: record.hz, unit: 'rad', ...common, rawFields: observationRawFields('hz') }))
    if (typeof record.zenith === 'number') observations.push(SurveyObservationV1.parse({ id: `gsi-${index + 1}-z`, type: 'zenith', value: record.zenith, unit: 'rad', ...common, rawFields: observationRawFields('zenith') }))
    if (typeof record.slope === 'number') observations.push(SurveyObservationV1.parse({ id: `gsi-${index + 1}-sd`, type: 'slope-distance', value: record.slope, unit: 'm', ...common, rawFields: observationRawFields('slope') }))
    else if (typeof record.horizontal === 'number') observations.push(SurveyObservationV1.parse({ id: `gsi-${index + 1}-hd`, type: 'distance', value: record.horizontal, unit: 'm', ...common, rawFields: observationRawFields('horizontal') }))
    if (typeof record.heightDifference === 'number') observations.push(SurveyObservationV1.parse({ id: `gsi-${index + 1}-dh`, type: 'height-difference', value: record.heightDifference, unit: 'm', ...common, rawFields: observationRawFields('heightDifference') }))
  }
  if (!observations.length) diagnostics.push(diagnostic('invalid_record', 'blocking', 'GSI 文件未产生可识别的方向、距离、天顶距或高差观测'))
  const classified = classifyPoints(points)
  return {
    ...classified, observations, diagnostics, anchors, disposition: observations.length ? 'adjustment-ready' : 'archive-only', unit: 'm',
    linearUnitRaw: [...linearUnits].sort().join(', ') || 'not-declared',
    angularUnitRaw: [...angularUnits].sort().join(', ') || 'not-declared'
  }
}

function xmlRecords(text: string, names: string[]): Array<{ tag: string; attributes: Record<string, string>; body: string; record: number; line: number }> {
  const result: Array<{ tag: string; attributes: Record<string, string>; body: string; record: number; line: number }> = []
  const alternation = names.join('|')
  const regex = new RegExp(`<((?:\\w+:)?(?:${alternation}))\\b([^>]*)>([\\s\\S]*?)<\\/\\1>|<((?:\\w+:)?(?:${alternation}))\\b([^>]*)\\/>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null && result.length < MAX_TEXT_LINES) {
    const offset = match.index ?? 0
    const line = 1 + (text.slice(0, offset).match(/\r\n|\n|\r/g)?.length ?? 0)
    result.push({ tag: (match[1] ?? match[4] ?? '').split(':').at(-1)!.toLowerCase(), attributes: xmlAttributes(match[2] ?? match[5] ?? ''), body: match[3] ?? '', record: result.length + 1, line })
  }
  return result
}

function xmlRecordMap(record: { attributes: Record<string, string>; body: string }, fields: string[]): Record<string, string> {
  const output = { ...record.attributes }
  for (const field of fields) {
    const value = xmlTag(record.body, field)
    if (value !== undefined) output[field.toLowerCase()] = value
  }
  return output
}

const LANDXML_UNVERIFIED_LINEAR_UNIT = 'landxml-linear-unit-unverified'
const LANDXML_UNVERIFIED_ANGULAR_UNIT = 'landxml-angular-unit-unverified'

type LandXmlUnitDeclaration = Readonly<{
  linearUnitRaw: string
  angularUnitRaw: string
  sourceRawFields: Record<string, RawField>
  diagnostic: SurveyImportDiagnosticV1
}>

/**
 * LandXML has several legal Units layouts (for example Metric/Imperial child
 * records) and directionUnit describes a reference convention, not a value
 * conversion. Stage A retains those declarations verbatim-ish for review but
 * deliberately does not turn them into a canonical length/angle assertion.
 */
function landXmlUnitDeclaration(text: string): LandXmlUnitDeclaration {
  const scopes = xmlRecords(text, ['Units'])
  const declarations = scopes.flatMap((scope) => [
    scope.attributes,
    ...xmlRecords(scope.body, ['Metric', 'Imperial', 'USSurvey', 'USCustomary', 'Unit']).map((record) => record.attributes)
  ])
  const sourceRawFields: Record<string, RawField> = {}
  let declarationIndex = 0
  for (const attributes of declarations) {
    for (const key of ['linearunit', 'angleunit', 'angularunit', 'directionunit']) {
      const value = attributes[key]?.trim()
      if (!value) continue
      sourceRawFields[`landxml.units.${declarationIndex}.${key}`] = value.slice(0, 240)
    }
    declarationIndex += 1
  }
  const declared = (...keys: string[]): { key: string; value: string } | undefined => {
    for (const attributes of declarations) {
      for (const key of keys) {
        const value = attributes[key]?.trim()
        if (value) return { key, value }
      }
    }
    return undefined
  }
  const linear = declared('linearunit')
  const angular = declared('angleunit', 'angularunit')
  const direction = declared('directionunit')
  const display = (entry: { key: string; value: string } | undefined, fallback: string) => entry
    // SourceFile raw-unit fields are bounded to 120 characters. Preserve the
    // complete declaration separately in sourceRawFields and keep this human
    // readable summary safely within the frozen contract.
    ? `${entry.key}=${entry.value.slice(0, 32)}`
    : `${fallback}=not-declared`
  return {
    linearUnitRaw: `LandXML Units.${display(linear, 'linearUnit')} (unverified)`,
    angularUnitRaw: `LandXML Units.${display(angular, 'angleUnit')}; ${display(direction, 'directionUnit')} (unverified)`,
    sourceRawFields,
    diagnostic: diagnostic(
      'format_detected',
      'warning',
      'LandXML Units 声明已作为原始元数据保留；linearUnit、angleUnit/angularUnit 与 directionUnit 的互操作语义尚未验证。数值未换算为 m 或 deg，观测单位已明确标为未确认，当前仅可审计归档。'
    )
  }
}

function parseSurveyXml(text: string, format: 'leica-hexml' | 'trimble-jobxml' | 'landxml'): ParsedSource {
  validateXmlSafety(text)
  const landXmlUnits = format === 'landxml' ? landXmlUnitDeclaration(text) : undefined
  const pointTags = format === 'landxml' ? ['CgPoint', 'Point'] : ['PointRecord', 'Point', 'CoordinateRecord']
  const pointRecords = xmlRecords(text, pointTags)
  const points: SurveyPoint[] = []
  const diagnostics: SurveyImportDiagnosticV1[] = [{
    code: 'invalid_record',
    severity: 'blocking',
    message: `${format} XML 已按受限方言提取点和观测，但方言语义、单位和元素级偏移仍未独立验收；当前只允许审计归档。`,
    suggestedAction: '保留本次原始 XML 供审计；完成授权或独立 golden 验证后再评估 adjustment-ready。'
  }]
  const anchors: SurveyRawRecordAnchorV1[] = []
  const addAnchor = (record: { tag: string; record: number; line: number }, section: string) => {
    const id = `xml-${section}-${record.record}`
    if (!anchors.some((item) => item.id === id)) anchors.push(anchor(record.line, record.tag.toUpperCase(), section, id))
  }
  const idNames = ['name', 'id', 'pointname', 'pointid', 'stationname', 'targetname']
  for (const record of pointRecords) {
    addAnchor(record, 'points')
    const fields = xmlRecordMap(record, ['Name', 'ID', 'PointName', 'PointID', 'North', 'Northing', 'Easting', 'East', 'Elevation', 'Height', 'Code', 'Classification'])
    const id = valueOf(fields, ...idNames) ?? record.attributes.name ?? record.attributes.id
    let x = numberOf(fields, 'north', 'northing', 'x'); let y = numberOf(fields, 'east', 'easting', 'y'); let height = numberOf(fields, 'elevation', 'height', 'z')
    if (record.tag === 'cgpoint') {
      const parts = record.body.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).map(Number)
      if (parts.length >= 2 && parts.every(Number.isFinite)) { x = parts[0]; y = parts[1]; height = parts[2] }
    }
    if (!id) { diagnostics.push(diagnostic('invalid_record', 'warning', 'XML 点记录缺少点号', record.record)); continue }
    const classification = valueOf(fields, 'classification', 'class', 'code')?.toLowerCase() ?? ''
    const known = /known|control|fixed|已知|控制/.test(classification)
    points.push(SurveyPointV1.parse({ id, pointClass: known ? 'known' : 'unknown', known, x, y, height, sourceRow: record.record, sourceLocator: `XML:${record.record}`, rawFields: rawFields(fields) }))
  }
  const stationNames = new Map<string, string>()
  for (const record of xmlRecords(text, ['StationRecord', 'InstrumentSetup', 'Station'])) {
    addAnchor(record, 'stations')
    const fields = xmlRecordMap(record, ['ID', 'StationID', 'StationName', 'PointID', 'PointName', 'InstrumentHeight'])
    const recordId = valueOf(fields, 'id', 'stationid') ?? record.attributes.id
    const stationName = valueOf(fields, 'stationname', 'pointname', 'pointid', 'name') ?? recordId
    if (recordId && stationName) stationNames.set(recordId, stationName)
    if (stationName) points.push(SurveyPointV1.parse({ id: stationName, pointClass: 'station', known: false, sourceRow: record.record, sourceLocator: `XML:station:${record.record}`, rawFields: rawFields(fields) }))
  }
  const targetNames = new Map<string, string>()
  for (const record of xmlRecords(text, ['TargetRecord', 'TargetSetup'])) {
    addAnchor(record, 'targets')
    const fields = xmlRecordMap(record, ['ID', 'TargetID', 'TargetName', 'PointID', 'PointName', 'TargetHeight', 'PrismHeight'])
    const recordId = valueOf(fields, 'id', 'targetid') ?? record.attributes.id
    const targetName = valueOf(fields, 'targetname', 'pointname', 'pointid', 'name') ?? recordId
    if (recordId && targetName) targetNames.set(recordId, targetName)
  }
  const observations: SurveyObservation[] = []
  const observationRecords = xmlRecords(text, ['Circle', 'RawObservation', 'TPSRawObservation', 'ReducedObservation', 'LevelObservation', 'Observation'])
  for (const record of observationRecords) {
    addAnchor(record, 'observations')
    const fields = xmlRecordMap(record, ['ID', 'StationID', 'StationName', 'SetupID', 'TargetID', 'TargetName', 'TargetSetupID', 'From', 'To', 'Backsight', 'Foresight', 'HorizontalCircle', 'HorizAngle', 'HorizontalAngle', 'Direction', 'VerticalCircle', 'ZenithAngle', 'VerticalAngle', 'EDMDistance', 'SlopeDistance', 'HorizontalDistance', 'HeightDifference', 'DeltaHeight', 'InstrumentHeight', 'TargetHeight', 'PrismHeight', 'TimeStamp', 'DateTime', 'Face', 'Set', 'Round'])
    const rawStation = valueOf(fields, 'stationname', 'from', 'backsight', 'stationid', 'setupid')
    const rawTarget = valueOf(fields, 'targetname', 'to', 'foresight', 'targetid', 'targetsetupid')
    const station = rawStation ? (stationNames.get(rawStation) ?? rawStation) : undefined
    const target = rawTarget ? (targetNames.get(rawTarget) ?? rawTarget) : undefined
    if (!station || !target) { diagnostics.push(diagnostic('missing_geometry', 'warning', `XML ${record.tag} 观测缺少测站或目标点`, record.record)); continue }
    points.push(SurveyPointV1.parse({ id: station, pointClass: 'station', known: false, sourceRow: record.record }))
    points.push(SurveyPointV1.parse({ id: target, pointClass: 'unknown', known: false, sourceRow: record.record }))
    const common = { from: station, to: target, station, target, stationHeightOffset: numberOf(fields, 'instrumentheight'), targetHeightOffset: numberOf(fields, 'targetheight', 'prismheight'), timestamp: valueOf(fields, 'timestamp', 'datetime'), face: /right|face2|ii/i.test(valueOf(fields, 'face') ?? '') ? 'right' as const : /left|face1|i/i.test(valueOf(fields, 'face') ?? '') ? 'left' as const : undefined, set: numberOf(fields, 'set'), round: numberOf(fields, 'round'), sourceRow: record.record, sourceLocator: `XML:${record.record}`, sourceRecordId: `xml-observations-${record.record}`, rawFields: rawFields(fields) }
    // Unlike the vendor-specific XML dialects, LandXML Units may declare feet,
    // radians, and a direction-reference convention. Until that declaration is
    // interoperably verified, keep only bare numeric tokens and never apply a
    // hidden decimal-degree/DMS conversion.
    const direction = format === 'landxml'
      ? numberOf(fields, 'horizontalcircle', 'horizangle', 'horizontalangle', 'direction')
      : decimalDegrees(valueOf(fields, 'horizontalcircle', 'horizangle', 'horizontalangle', 'direction'))
    const zenith = format === 'landxml'
      ? numberOf(fields, 'verticalcircle', 'zenithangle', 'verticalangle')
      : decimalDegrees(valueOf(fields, 'verticalcircle', 'zenithangle', 'verticalangle'))
    const slope = numberOf(fields, 'edmdistance', 'slopedistance')
    const horizontal = numberOf(fields, 'horizontaldistance')
    const heightDifference = numberOf(fields, 'heightdifference', 'deltaheight')
    const angularUnit = format === 'landxml' ? LANDXML_UNVERIFIED_ANGULAR_UNIT : 'deg'
    const linearUnit = format === 'landxml' ? LANDXML_UNVERIFIED_LINEAR_UNIT : 'm'
    if (direction !== undefined) observations.push(SurveyObservationV1.parse({ id: `xml-${record.record}-hz`, type: 'direction', value: direction, unit: angularUnit, ...common }))
    if (zenith !== undefined) observations.push(SurveyObservationV1.parse({ id: `xml-${record.record}-z`, type: 'zenith', value: zenith, unit: angularUnit, ...common }))
    if (slope !== undefined) observations.push(SurveyObservationV1.parse({ id: `xml-${record.record}-sd`, type: 'slope-distance', value: slope, unit: linearUnit, ...common }))
    else if (horizontal !== undefined) observations.push(SurveyObservationV1.parse({ id: `xml-${record.record}-hd`, type: 'distance', value: horizontal, unit: linearUnit, ...common }))
    if (heightDifference !== undefined) observations.push(SurveyObservationV1.parse({ id: `xml-${record.record}-dh`, type: 'height-difference', value: heightDifference, unit: linearUnit, ...common }))
  }
  if (!observations.length) diagnostics.push(diagnostic('invalid_record', 'blocking', `${format} 文件未产生可进入平差的观测记录`))
  const classified = classifyPoints(points)
  return {
    ...classified,
    observations,
    diagnostics: [...diagnostics, ...(landXmlUnits ? [landXmlUnits.diagnostic] : [])],
    // These are physical line anchors, not fabricated element offsets. For
    // minified XML several records may legitimately point to line 1; the
    // complete source line remains the auditable boundary until byte spans
    // for the XML dialect are independently verified.
    anchors,
    disposition: 'archive-only',
    unit: landXmlUnits ? 'landxml-unit-unverified' : 'm',
    ...(landXmlUnits ? {
      linearUnitRaw: landXmlUnits.linearUnitRaw,
      angularUnitRaw: landXmlUnits.angularUnitRaw,
      sourceRawFields: landXmlUnits.sourceRawFields
    } : {})
  }
}

function parseRawRw5(text: string, format: 'tds-raw' | 'carlson-rw5'): ParsedSource {
  const lines = boundedLines(text)
  const points: SurveyPoint[] = []
  const observations: SurveyObservation[] = []
  const diagnostics: SurveyImportDiagnosticV1[] = []
  const anchors: SurveyRawRecordAnchorV1[] = []
  let station: string | undefined
  let instrumentHeight: number | undefined
  let targetHeight: number | undefined
  let heightRecord: number | undefined
  let modeRecord: number | undefined
  let distanceUnit: string | undefined
  const distanceUnits = new Set<string>()
  const angleUnits = new Set<string>()
  let hasUnverifiedAngles = false
  let hasUnverifiedLengths = false
  // Carlson's public RW5 specification defines OP/FP and MO.UN, but does
  // not define AU's enumeration. Never interpret packed angle tokens as
  // decimal degrees, AR as an absolute direction, or VA as a zenith angle.
  // Reference: docs/references/SURVEY_FORMAT_SOURCES.md (Carlson RW5).
  const linearValue = (fields: Record<string, string>, ...keys: string[]): number | undefined => {
    const value = numberOf(fields, ...keys)
    if (value === undefined) return undefined
    switch (distanceUnit) {
      case '1': return value
      case '0': return toMetres(value, 'ft')
      case '2': return value * (1200 / 3937)
      default: hasUnverifiedLengths = true; return undefined
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (!line) continue
    const cells = line.split(',').map((cell) => cell.trim())
    const code = cells.shift()?.toUpperCase() ?? ''
    // Anchor comments, state records and rejected shots as well as accepted
    // projections. A diagnostic must never point at a missing source record.
    if (anchors.length >= MAX_RECORD_ANCHORS) throw new SurveySourceParseError('limit_exceeded', 'RAW/RW5 原始记录超过锚点上限')
    anchors.push(anchor(index + 1, code))
    if (code.startsWith('--')) continue
    const fields: Record<string, string> = {}
    for (const cell of cells) {
      const match = /^([A-Za-z]{1,2})(.*)$/.exec(cell)
      if (match) {
        const key = match[1]!.toLowerCase()
        if (Object.hasOwn(fields, key)) throw new SurveySourceParseError('invalid_record', `RAW/RW5 第 ${index + 1} 行含重复字段 ${key}，不能覆盖原值`)
        fields[key] = match[2]!.trim()
      }
    }
    const provenance = () => rawFields({
      ...fields, recordType: code, distanceUnit: distanceUnit ?? 'not-declared',
      ...(modeRecord ? { modeRecord } : {}), ...(heightRecord ? { heightRecord } : {})
    })
    if (code === 'MO') {
      // Do not re-use height state across a changed/unknown unit declaration.
      if (distanceUnit !== fields.un) { instrumentHeight = undefined; targetHeight = undefined; heightRecord = undefined }
      distanceUnit = valueOf(fields, 'un')
      modeRecord = index + 1
      distanceUnits.add(['0', '1', '2'].includes(distanceUnit ?? '') ? distanceUnit! : 'unknown')
      angleUnits.add(valueOf(fields, 'au')?.slice(0, 16) ?? 'not-declared')
    } else if (code === 'LS') {
      if (Object.hasOwn(fields, 'hi')) instrumentHeight = linearValue(fields, 'hi')
      if (Object.hasOwn(fields, 'hr')) targetHeight = linearValue(fields, 'hr')
      heightRecord = index + 1
    } else if (code === 'OC') {
      station = valueOf(fields, 'op', 'pn', 'pt')
      instrumentHeight = undefined
      targetHeight = undefined
      heightRecord = undefined
      if (station) points.push(SurveyPointV1.parse({ id: station, pointClass: 'station', known: false, x: linearValue(fields, 'n'), y: linearValue(fields, 'e'), height: linearValue(fields, 'el'), sourceRow: index + 1, sourceLocator: `${format}:${index + 1}`, rawFields: provenance() }))
    } else if (code === 'SP' || code === 'GPS') {
      const pointId = valueOf(fields, 'pn')
      if (pointId) points.push(SurveyPointV1.parse({ id: pointId, pointClass: 'unknown', known: false,
        // GPS EL is WGS84 ellipsoid height in metres, independent of MO.UN.
        // Keep LA/LN raw until the dd.mmss geographic mapping is validated.
        ...(code === 'GPS' ? { height: numberOf(fields, 'el') } : { x: linearValue(fields, 'n'), y: linearValue(fields, 'e'), height: linearValue(fields, 'el') }),
        sourceRow: index + 1, sourceLocator: `${format}:${index + 1}`, rawFields: provenance() }))
    } else if (['SS', 'TR', 'BD', 'BR', 'FD', 'FR'].includes(code)) {
      const occupy = valueOf(fields, 'op') ?? station
      const target = valueOf(fields, 'fp')
      if (!occupy || !target || occupy === target) { diagnostics.push(diagnostic('missing_geometry', 'warning', `${code} 记录缺少测站 OP/目标 FP 或两者相同，未生成观测`, index + 1)); continue }
      points.push(SurveyPointV1.parse({ id: occupy, pointClass: 'station', known: false, sourceRow: index + 1 }))
      points.push(SurveyPointV1.parse({ id: target, pointClass: 'unknown', known: false, sourceRow: index + 1 }))
      const face = code === 'BD' || code === 'FD' ? 'left' as const : code === 'BR' || code === 'FR' ? 'right' as const : undefined
      const common = { from: occupy, to: target, station: occupy, target, face,
        stationHeightOffset: !station || station === occupy ? instrumentHeight : undefined,
        targetHeightOffset: targetHeight,
        sourceRow: index + 1, sourceLocator: `${format}:${index + 1}`, sourceRecordId: `record-${index + 1}`, rawFields: provenance() }
      if (['az', 'br', 'ar', 'al', 'dr', 'dl', 'ze', 'va', 'ce'].some((key) => Object.hasOwn(fields, key))) hasUnverifiedAngles = true
      const slope = linearValue(fields, 'sd')
      const horizontal = linearValue(fields, 'hd')
      const rawSlope = numberOf(fields, 'sd')
      const rawHorizontal = numberOf(fields, 'hd')
      const value = slope ?? horizontal ?? rawSlope ?? rawHorizontal
      if (value !== undefined) observations.push(SurveyObservationV1.parse({
        id: `${format}-${index + 1}-${rawSlope !== undefined ? 'sd' : 'hd'}`,
        type: rawSlope !== undefined ? 'slope-distance' : 'distance', value,
        unit: slope !== undefined || horizontal !== undefined ? 'm' : 'rw5-linear-unverified', ...common
      }))
    }
  }
  if (hasUnverifiedLengths) diagnostics.push(diagnostic('invalid_record', 'blocking', 'RAW/RW5 未声明有效 MO.UN；距离仅保留原值，坐标及仪器/棱镜高未映射为米，禁止默认使用米。'))
  if (hasUnverifiedAngles) diagnostics.push(diagnostic('invalid_record', 'blocking', 'RAW/RW5 的 AU 枚举及角度参考语义尚未验证；AZ/BR/AR/AL/DR/DL、ZE/VA/CE 仅保留原字段，不把角度右当绝对方向或把垂直角当天顶距。'))
  if (!observations.length) diagnostics.push(diagnostic('invalid_record', 'blocking', `${format} 文件未产生可识别观测`))
  const classified = classifyPoints(points)
  return { ...classified, observations, diagnostics, anchors, disposition: 'archive-only', unit: 'm', canonicalUnitsVerified: false,
    linearUnitRaw: `MO.UN=${[...distanceUnits].sort().join(',') || 'not-declared'} (0=ft,1=m,2=US-ft)`,
    angularUnitRaw: `MO.AU=${[...angleUnits].sort().join(',') || 'not-declared'} (unverified)`.slice(0, 120)
  }
}

/**
 * Parse only the explicit, reviewable South DAT mapping envelope.
 *
 * South DAT exports are configurable by instrument/model and their authoritative
 * column order is not public. A bare `.dat` file must therefore remain opaque.
 * The synthetic envelope used by our regression fixtures carries a mapping
 * declaration in a comment, making the interpretation deterministic without
 * turning the extension itself into an implicit schema.
 */
function parseSouthDat(text: string): ParsedSource {
  const lines = boundedLines(text)
  const anchors: SurveyRawRecordAnchorV1[] = []
  const diagnostics: SurveyImportDiagnosticV1[] = []
  const points: SurveyPoint[] = []
  const mappingLine = lines.findIndex((line) => /^\s*#\s*WORKWISE-SOUTH-DAT\b/i.test(line))
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.trim()) continue
    if (anchors.length >= MAX_RECORD_ANCHORS) throw new SurveySourceParseError('limit_exceeded', 'South DAT 原始记录超过锚点上限')
    anchors.push(anchor(index + 1, index === mappingLine ? 'SOUTH-DAT-MAPPING' : 'SOUTH-DAT'))
  }

  const blocked = (code: SurveyImportDiagnosticV1['code'], message: string, sourceRecord?: number) => {
    diagnostics.push({
      code,
      severity: 'blocking',
      message,
      ...(sourceRecord ? { sourceRecord } : {}),
      suggestedAction: '请在原始导出中保存明确的列映射和线性单位，或在预检界面完成人工映射确认后重新导入。'
    })
  }

  if (mappingLine < 0) {
    blocked('mapping_required', '南方 DAT 未声明可审计的列映射；不同机型和导出设置允许重排字段，不能按默认列序解释。')
    diagnostics.push({
      code: 'missing_geometry',
      severity: 'blocking',
      message: '南方 DAT 未生成点位或观测，未声明映射的记录不能进入平差。',
      suggestedAction: '请提供包含明确列映射和单位声明的原始导出，或在预检界面完成人工映射确认。'
    })
    return {
      knownPoints: [], unknownPoints: [], observations: [], anchors, diagnostics,
      disposition: 'archive-only', parserId: SOUTH_DAT_PARSER_ID, parserVersion: SOUTH_DAT_PARSER_VERSION,
      parserSourceHash: SOUTH_DAT_PARSER_SOURCE_HASH, linearUnitRaw: 'not-declared', angularUnitRaw: 'not-applicable'
    }
  }

  const declaration = lines[mappingLine]!
  const columnsMatch = /\bcolumns\s*=\s*([A-Za-z][A-Za-z0-9_-]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_-]*)*)/i.exec(declaration)
  const unitMatch = /\b(?:linearUnit|unit)\s*=\s*([A-Za-z][A-Za-z0-9_-]*)/i.exec(declaration)
  const columns = columnsMatch?.[1]?.split(',').map((value) => value.trim().toLowerCase()) ?? []
  const aliases: Record<string, string> = {
    id: 'name', point: 'name', pointid: 'name', pointname: 'name', name: 'name',
    code: 'code', description: 'code',
    n: 'northing', north: 'northing', northing: 'northing', y: 'northing',
    e: 'easting', east: 'easting', easting: 'easting', x: 'easting',
    z: 'height', elev: 'height', elevation: 'height', height: 'height'
  }
  const normalizedColumns = columns.map((column) => aliases[column] ?? column)
  const required = ['name', 'northing', 'easting']
  const hasDuplicate = new Set(normalizedColumns).size !== normalizedColumns.length
  const unit = unitMatch?.[1]?.toLowerCase()
  if (!columns.length || hasDuplicate || required.some((column) => !normalizedColumns.includes(column))) {
    blocked('invalid_record', '南方 DAT 列映射必须唯一且至少包含 name、northing、easting。', mappingLine + 1)
    return {
      knownPoints: [], unknownPoints: [], observations: [], anchors, diagnostics,
      disposition: 'archive-only', parserId: SOUTH_DAT_PARSER_ID, parserVersion: SOUTH_DAT_PARSER_VERSION,
      parserSourceHash: SOUTH_DAT_PARSER_SOURCE_HASH, linearUnitRaw: unit ?? 'not-declared', angularUnitRaw: 'not-applicable'
    }
  }
  if (unit !== 'm' && unit !== 'meter' && unit !== 'metre' && unit !== 'meters' && unit !== 'metres') {
    blocked('invalid_record', `南方 DAT 线性单位 ${unit ?? '（未声明）'} 未纳入已验证的米制映射。`, mappingLine + 1)
    return {
      knownPoints: [], unknownPoints: [], observations: [], anchors, diagnostics,
      disposition: 'archive-only', parserId: SOUTH_DAT_PARSER_ID, parserVersion: SOUTH_DAT_PARSER_VERSION,
      parserSourceHash: SOUTH_DAT_PARSER_SOURCE_HASH, linearUnitRaw: unit ?? 'not-declared', angularUnitRaw: 'not-applicable'
    }
  }

  const columnIndex = (name: string) => normalizedColumns.indexOf(name)
  const dataLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > mappingLine && line.trim() && !/^\s*(?:#|;|\/\/)/.test(line))
  let malformed = false
  for (const { line, index } of dataLines) {
    const fields = commaFields(line)
    if (fields.length !== normalizedColumns.length) {
      malformed = true
      blocked('invalid_record', `南方 DAT 第 ${index + 1} 行字段数 ${fields.length} 与映射 ${normalizedColumns.length} 不一致。`, index + 1)
      continue
    }
    const id = fields[columnIndex('name')]?.trim()
    const northing = Number(fields[columnIndex('northing')])
    const easting = Number(fields[columnIndex('easting')])
    const rawHeight = columnIndex('height') >= 0 ? Number(fields[columnIndex('height')]) : undefined
    if (!id || !Number.isFinite(northing) || !Number.isFinite(easting) || (rawHeight !== undefined && !Number.isFinite(rawHeight))) {
      malformed = true
      blocked('invalid_record', `南方 DAT 第 ${index + 1} 行点号或坐标不是有限数值。`, index + 1)
      continue
    }
    points.push(SurveyPointV1.parse({
      id, pointClass: 'unknown', known: false, x: easting, y: northing,
      ...(rawHeight !== undefined ? { height: rawHeight } : {}), sourceRow: index + 1,
      sourceLocator: `SOUTH-DAT:${index + 1}`,
      rawFields: Object.fromEntries(normalizedColumns.map((column, position) => [`${column}Raw`, fields[position] ?? '']))
    }))
  }
  if (!dataLines.length) blocked('missing_geometry', '南方 DAT 映射已声明，但没有点位数据记录。', mappingLine + 1)
  if (malformed) points.length = 0
  const classified = classifyPoints(points)
  return {
    ...classified, observations: [], anchors, diagnostics,
    disposition: 'archive-only', parserId: SOUTH_DAT_PARSER_ID, parserVersion: SOUTH_DAT_PARSER_VERSION,
    parserSourceHash: SOUTH_DAT_PARSER_SOURCE_HASH, linearUnitRaw: unit ?? 'm', angularUnitRaw: 'not-applicable',
    sourceRawFields: { 'south-dat.mapping': declaration.slice(0, 512), 'south-dat.columns': normalizedColumns.join(','), 'south-dat.unit': unit ?? 'not-declared' }
  }
}

function parseM5(text: string): ParsedSource {
  const lines = boundedLines(text)
  const pointsById = new Map<string, SurveyPoint>()
  const observations: SurveyObservation[] = []
  const diagnostics: SurveyImportDiagnosticV1[] = []
  const anchors: SurveyRawRecordAnchorV1[] = []
  const sourceRawFields: Record<string, RawField> = {}

  // A real M5 export uses fixed-width fields inside a pipe-delimited envelope.
  // The point token is the text between KD1/KD2 and the next pipe; trailing
  // channel/round values (and, for observations, a timestamp) are metadata.
  const m5Point = (line: string): { kind: string; point: string } | undefined => {
    const match = /\|KD([12])\s+([^|]*)\|/i.exec(line)
    if (!match) return undefined
    let body = match[2]!.trim()
    if (match[1] === '2') body = body.replace(/\s+\d+\s+\d+\s*$/, '')
    body = body.replace(/\s+\d{1,3}\s*$/, '')
    body = body.replace(/\s+\d{1,2}:\d{2}:\d{2,3}\s*$/, '')
    const point = body.trim()
    return point ? { kind: `KD${match[1]}`, point } : undefined
  }
  const addPoint = (id: string, height: number | undefined, sourceRow: number, raw: Record<string, RawField>) => {
    const current = pointsById.get(id)
    const mergedRaw = { ...(current?.rawFields ?? {}), ...raw }
    pointsById.set(id, SurveyPointV1.parse({
      ...(current ?? { id, pointClass: 'unknown', known: false }),
      // M5 Z records are instrument-reported heights, not a declared datum.
      // Keep them in rawFields for review, but never publish them as point
      // heights: an explicit BM1/known-point mapping must be the only source
      // of control elevations for adjustment.
      sourceRow: current?.sourceRow ?? sourceRow,
      sourceLocator: current?.sourceLocator ?? `M5:${sourceRow}`,
      rawFields: mergedRaw
    }))
  }

  type M5Reading = {
    line: number
    address?: number
    point: string
    type: 'Rb' | 'Rf'
    value: number
    hd?: number
    raw: string
  }
  const readings: M5Reading[] = []
  let actualM5 = false
  let inSegment = false
  let pending: M5Reading[] = []
  let malformed = false
  const block = (message: string, line: number) => {
    malformed = true
    diagnostics.push({
      code: 'invalid_record', severity: 'blocking', message,
      sourceRecord: line, recordAnchor: `record-${line}`,
      suggestedAction: '请保留原始 DAT，并核对 M5 aBFFB 测段是否完整、Rb/Rf 顺序是否正确后重新导入。'
    })
  }
  const flushPending = (line: number) => {
    if (pending.length) {
      block(`M5 aBFFB 测段在第 ${line} 行前只有 ${pending.length} 条 Rb/Rf 记录，已阻断不完整测段。`, pending[0]!.line)
      pending = []
    }
  }
  const emitSegment = (segment: M5Reading[]) => {
    const first = segment[0]!
    const last = segment[3]!
    const pattern = segment.map((item) => item.type).join('')
    const validPattern = pattern === 'RbRfRfRb' || pattern === 'RfRbRbRf'
    const pointPair = segment[0]!.point === segment[3]!.point && segment[1]!.point === segment[2]!.point
    const distinct = segment[0]!.point !== segment[1]!.point
    if (!validPattern || !pointPair || !distinct) {
      block(`M5 第 ${first.line}-${last.line} 行不是可验证的 aBFFB 测段（顺序 ${pattern} 或点号关系不完整）。`, first.line)
      return
    }
    const edgePoint = segment[0]!.point
    const innerPoint = segment[1]!.point
    const from = first.type === 'Rb' ? edgePoint : innerPoint
    const to = first.type === 'Rb' ? innerPoint : edgePoint
    const backsights = segment.filter((item) => item.type === 'Rb')
    const foresights = segment.filter((item) => item.type === 'Rf')
    const value = (backsights[0]!.value + backsights[1]!.value) / 2 - (foresights[0]!.value + foresights[1]!.value) / 2
    const distances = segment.map((item) => item.hd)
    const routeLength = distances.every((item): item is number => item !== undefined)
      ? distances.reduce((sum, item) => sum + item, 0) / 2
      : undefined
    const raw = rawFields({
      format: 'M5-aBFFB', from, to, pattern,
      records: segment.map((item) => item.raw).join('\n'),
      rbValues: backsights.map((item) => item.value).join(','),
      rfValues: foresights.map((item) => item.value).join(','),
      ...(routeLength !== undefined ? { routeLength } : {})
    })
    observations.push(SurveyObservationV1.parse({
      id: `m5-${first.line}-${last.line}-dh`, type: 'height-difference', from, to, value,
      unit: 'm', ...(routeLength !== undefined ? { routeLength } : {}),
      sourceRow: first.line, sourceLocator: `M5:${first.line}-${last.line}`,
      sourceRecordId: `record-${first.line}`, rawFields: raw
    }))
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!line.trim()) continue
    if (anchors.length >= MAX_RECORD_ANCHORS) throw new SurveySourceParseError('limit_exceeded', 'M5 原始记录超过锚点上限')
    anchors.push(anchor(index + 1, 'M5'))
    if (/^\s*For\s+M5\|Adr\b/i.test(line)) actualM5 = true

    if (actualM5) {
      if (/\bStart-Line\b/i.test(line)) {
        flushPending(index + 1)
        inSegment = true
        continue
      }
      if (/\bEnd-Line\b/i.test(line)) {
        flushPending(index + 1)
        inSegment = false
        continue
      }
      const pointToken = m5Point(line)
      const address = /\|Adr\s+(\d+)/i.exec(line)?.[1]
      const point = pointToken?.point
      const zMatch = /\|\s*Z\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*m\b/i.exec(line)
      const hasZ = /\|\s*Z\b/i.test(line)
      const sightTag = /\|\s*(Rb|Rf)\b/i.exec(line)?.[1] as 'Rb' | 'Rf' | undefined
      const sightMatch = /\|\s*(?:Rb|Rf)\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*m\b/i.exec(line)
      const hasSight = /\|\s*(?:Rb|Rf)\b/i.test(line)
      const hdMatch = /\|\s*HD\s+([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*m\b/i.exec(line)
      const numericZ = zMatch ? Number(zMatch[1]) : undefined
      if (point) addPoint(point, numericZ, index + 1, rawFields({ kind: pointToken!.kind, address: address ?? null, raw: line }))
      if (hasZ && !zMatch) block(`M5 第 ${index + 1} 行 Z 高程不是有限米制数值。`, index + 1)
      if (hasSight) {
        if (!point || !sightTag || !sightMatch) {
          block(`M5 第 ${index + 1} 行 Rb/Rf 记录缺少点号或米制读数。`, index + 1)
        } else if (!inSegment) {
          block(`M5 第 ${index + 1} 行 Rb/Rf 记录不在 Start-Line/End-Line 测段内。`, index + 1)
        } else {
          const value = Number(sightMatch[1])
          const hd = hdMatch ? Number(hdMatch[1]) : undefined
          if (!Number.isFinite(value) || (hdMatch && !Number.isFinite(hd))) block(`M5 第 ${index + 1} 行 Rb/Rf 或 HD 不是有限数值。`, index + 1)
          else {
            pending.push({ line: index + 1, address: address ? Number(address) : undefined, point, type: sightTag, value, hd, raw: line })
            if (pending.length === 4) {
              emitSegment(pending)
              pending = []
            }
          }
        }
      }
      if (/\|KD2\b/i.test(line)) sourceRawFields[`m5.kd2.${index + 1}`] = line.slice(0, 2_000)
      continue
    }

    // Backward-compatible reduced M5 envelope used by older fixtures.
    const fields: Record<string, string> = {}
    for (const token of line.split('|').map((value) => value.trim()).filter(Boolean)) {
      const match = /^([A-Za-z][A-Za-z0-9]{0,4})\s*(.*)$/.exec(token)
      if (match) fields[match[1]!.toLowerCase()] = match[2]!.trim()
    }
    const point = valueOf(fields, 'kd1', 'to', 'pn', 'pt')
    const from = valueOf(fields, 'from', 'bs', 'rb')
    const height = numberOf(fields, 'z', 'elev', 'elevation')
    const difference = numberOf(fields, 'dh', 'hd', 'delta')
    if (point) addPoint(point, height, index + 1, rawFields(fields))
    if (point && from && difference !== undefined && point !== from) observations.push(SurveyObservationV1.parse({ id: `m5-${index + 1}-dh`, type: 'height-difference', from, to: point, value: difference, unit: 'm', routeLength: numberOf(fields, 'dist', 's'), sourceRow: index + 1, sourceLocator: `M5:${index + 1}`, sourceRecordId: `record-${index + 1}`, rawFields: rawFields(fields) }))
  }
  if (actualM5) {
    flushPending(lines.length)
    if (!observations.length) diagnostics.push(diagnostic('missing_geometry', 'blocking', 'M5/DAT 未生成完整 aBFFB 高差观测；请在预检中确认 Start-Line、Rb/Rf 测段关系'))
  } else if (!observations.length) {
    diagnostics.push(diagnostic('missing_geometry', 'blocking', 'M5/DAT 已识别，但缺少可明确配对的起止点与高差；请在预检中确认测段关系'))
  }
  const classified = classifyPoints([...pointsById.values()])
  return {
    ...classified, observations, diagnostics, anchors,
    sourceRawFields,
    parserId: M5_PARSER_ID, parserVersion: M5_PARSER_VERSION, parserSourceHash: M5_PARSER_SOURCE_HASH,
    disposition: observations.length && !malformed ? 'adjustment-ready' : 'archive-only', unit: 'm'
  }
}

function fixedNumber(line: string, start: number, end: number): number | undefined {
  const raw = line.slice(start, end).trim()
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function parseSdr(text: string): ParsedSource {
  const lines = boundedLines(text)
  const points: SurveyPoint[] = []
  const observations: SurveyObservation[] = []
  const diagnostics: SurveyImportDiagnosticV1[] = []
  const anchors: SurveyRawRecordAnchorV1[] = []
  const header = lines.find((line) => line.startsWith('00NM')) ?? ''
  const dialect = /SDR33\b/i.test(header) ? 'SDR33' : /SDR20\b/i.test(header) ? 'SDR20' : undefined
  const stationHeights = new Map<string, number>()
  let targetHeight: number | undefined
  if (!dialect) diagnostics.push(diagnostic('invalid_record', 'blocking', 'SDR 文件未声明 SDR20/SDR33 方言，不能安全套用固定字段布局'))
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trimEnd()
    if (!line.trim()) continue
    const code = line.slice(0, 4).toUpperCase()
    if (code === '03NM') {
      const parsedHeight = Number(line.slice(4).trim().split(/\s+/)[0])
      if (Number.isFinite(parsedHeight)) targetHeight = parsedHeight
    } else if (dialect && (code === '02TP' || code === '08TP')) {
      const layout = dialect === 'SDR33'
        ? { id: [4, 20], north: [20, 36], east: [36, 52], height: [52, 68], instrument: [68, 84] }
        : { id: [4, 8], north: [8, 18], east: [18, 28], height: [28, 38], instrument: [38, 48] }
      const id = line.slice(layout.id[0]!, layout.id[1]!).trim()
      const north = fixedNumber(line, layout.north[0]!, layout.north[1]!)
      const east = fixedNumber(line, layout.east[0]!, layout.east[1]!)
      const height = fixedNumber(line, layout.height[0]!, layout.height[1]!)
      const instrumentHeight = fixedNumber(line, layout.instrument[0]!, layout.instrument[1]!)
      if (id && north !== undefined && east !== undefined) {
        const known = code === '02TP'
        points.push(SurveyPointV1.parse({ id, pointClass: known ? 'known' : 'unknown', known, x: north, y: east, height, sourceRow: index + 1, sourceLocator: `${dialect}:${index + 1}`, rawFields: { code, dialect, record: line.slice(0, 2_000) } }))
        if (known && instrumentHeight !== undefined) stationHeights.set(id, instrumentHeight)
      } else diagnostics.push(diagnostic('record_ignored', 'warning', `${dialect} ${code} 记录缺少可验证的点号或坐标`, index + 1))
    } else if (dialect && (code === '09F1' || code === '09F2')) {
      const layout = dialect === 'SDR33'
        ? { station: [4, 20], target: [20, 36], slope: [36, 52], zenith: [52, 68], direction: [68, 84] }
        : { station: [4, 8], target: [8, 12], slope: [12, 22], zenith: [22, 32], direction: [32, 42] }
      const station = line.slice(layout.station[0]!, layout.station[1]!).trim()
      const target = line.slice(layout.target[0]!, layout.target[1]!).trim()
      const slope = fixedNumber(line, layout.slope[0]!, layout.slope[1]!)
      const zenith = fixedNumber(line, layout.zenith[0]!, layout.zenith[1]!)
      const direction = fixedNumber(line, layout.direction[0]!, layout.direction[1]!)
      if (!station || !target || (slope === undefined && zenith === undefined && direction === undefined)) {
        diagnostics.push(diagnostic('record_ignored', 'warning', `${dialect} ${code} 缺少测站、目标或数值字段，已保留但未生成观测`, index + 1))
      } else {
        points.push(SurveyPointV1.parse({ id: station, pointClass: 'station', known: false, sourceRow: index + 1 }))
        points.push(SurveyPointV1.parse({ id: target, pointClass: 'unknown', known: false, sourceRow: index + 1 }))
        const common = { from: station, to: target, station, target, face: code === '09F2' ? 'right' as const : 'left' as const, stationHeightOffset: stationHeights.get(station), targetHeightOffset: targetHeight, sourceRow: index + 1, sourceLocator: `${dialect}:${index + 1}`, sourceRecordId: `record-${index + 1}`, rawFields: { code, dialect, record: line.slice(0, 2_000) } }
        if (direction !== undefined) observations.push(SurveyObservationV1.parse({ id: `sdr-${index + 1}-hz`, type: 'direction', value: direction, unit: 'deg', ...common }))
        if (zenith !== undefined) observations.push(SurveyObservationV1.parse({ id: `sdr-${index + 1}-z`, type: 'zenith', value: zenith, unit: 'deg', ...common }))
        if (slope !== undefined) observations.push(SurveyObservationV1.parse({ id: `sdr-${index + 1}-sd`, type: 'slope-distance', value: slope, unit: 'm', ...common }))
      }
    }
    if (anchors.length < MAX_RECORD_ANCHORS) anchors.push(anchor(index + 1, code || 'SDR'))
  }
  if (!observations.length) diagnostics.push(diagnostic('missing_geometry', 'blocking', 'SDR 点位记录已保留；文件没有符合已验证 SDR20/SDR33 固定布局的测站—目标极坐标观测，请确认方言或导出 LandXML'))
  const classified = classifyPoints(points)
  return { ...classified, observations, diagnostics, anchors, disposition: observations.length && !diagnostics.some((item) => item.severity === 'blocking') ? 'adjustment-ready' : 'archive-only', unit: 'm' }
}

/** GNSS text evidence is line-based, not a claim to decode epochs/messages. */
function gnssTextEvidence(text: string, recordType: string): { lines: string[]; anchors: SurveyRawRecordAnchorV1[] } {
  const lines = boundedLines(text.replace(/\r(?!\n)/g, '\n'))
  let count = 0
  for (const line of lines) {
    if (line.trim() && ++count > MAX_RECORD_ANCHORS) throw new SurveySourceParseError('limit_exceeded', `${recordType} 超过 ${MAX_RECORD_ANCHORS.toLocaleString('zh-CN')} 条原始行锚点上限；未输出截断的来源记录`)
  }
  const anchors: SurveyRawRecordAnchorV1[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim()) anchors.push(anchor(index + 1, recordType))
  }
  return { lines, anchors }
}

function parseRinex(text: string, format: SurveyFormatIdV1): ParsedSource {
  const { lines, anchors } = gnssTextEvidence(text, 'RINEX-line')
  const diagnostics: SurveyImportDiagnosticV1[] = [diagnostic(format === 'hatanaka-rinex' ? 'converter_required' : 'gnss_processing_required', 'blocking', format === 'hatanaka-rinex' ? 'Hatanaka/CRINEX 需由受审计的本地转换器展开为 RINEX 后再进行 GNSS 解算' : 'RINEX 原始观测/星历不是基线向量；需先完成 GNSS 基线解算并生成固定基准与协方差')]
  const endHeader = lines.findIndex((line) => line.includes('END OF HEADER'))
  const header = endHeader >= 0 ? lines.slice(0, endHeader + 1) : []
  const marker = header.find((line) => line.includes('MARKER NAME'))?.slice(0, 60).trim()
  const approxIndex = header.findIndex((line) => line.includes('APPROX POSITION XYZ'))
  const approx = header[approxIndex]?.slice(0, 60).trim().split(/\s+/).map(Number)
  const points: SurveyPoint[] = marker && approx?.length === 3 && approx.every(Number.isFinite) ? [SurveyPointV1.parse({ id: marker, pointClass: 'check', known: false, x: approx[0], y: approx[1], height: approx[2], sourceRow: approxIndex + 1, sourceLocator: `RINEX:${approxIndex + 1}:APPROX POSITION XYZ` })] : []
  const recordCount = endHeader < 0 ? 0 : lines.slice(endHeader + 1).filter((line) => line.trim()).length
  if (endHeader < 0) diagnostics.push(diagnostic('invalid_record', 'blocking', 'RINEX 缺少 END OF HEADER，未从不完整标头提取坐标。', 1))
  for (const item of anchors) {
    item.recordType = endHeader < 0 ? 'RINEX-unverified-line' : item.line! <= endHeader + 1 ? 'RINEX-header-line' : 'RINEX-data-line'
  }
  return { ...classifyPoints(points), observations: [], diagnostics: [...diagnostics, diagnostic('format_detected', 'info', `RINEX 数据区 ${recordCount} 行${marker ? `，测站 ${marker}` : ''}；行数不是历元或观测数`)], anchors, disposition: format === 'hatanaka-rinex' ? 'converter-required' : 'gnss-processing-required', unit: 'm' }
}

function parseSinex(text: string): ParsedSource {
  const { lines, anchors } = gnssTextEvidence(text, 'SINEX-line')
  const coordinates = new Map<string, {
    solution: string
    values: Partial<Record<'x' | 'y' | 'height', number>>
    sourceRow: number
    rawFields: Record<string, RawField>
  }>()
  const ambiguousSites = new Set<string>()
  const diagnostics: SurveyImportDiagnosticV1[] = []
  let rejected = 0
  const reject = (index: number, message: string) => {
    rejected += 1
    if (diagnostics.length < 50) diagnostics.push(diagnostic('record_ignored', 'warning', message, index + 1))
  }
  let inEstimate = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.startsWith('+SOLUTION/ESTIMATE')) { inEstimate = true; continue }
    if (line.startsWith('-SOLUTION/ESTIMATE')) { inEstimate = false; continue }
    if (!inEstimate || !line.trim() || line.startsWith('*')) continue
    const fields = line.trim().split(/\s+/)
    if (!['STAX', 'STAY', 'STAZ'].includes(fields[1] ?? '')) continue
    // INDEX TYPE CODE PT SOLN EPOCH UNIT CONSTRAINT ESTIMATE [STDDEV].
    // The constraint flag precedes the estimate; it is never a coordinate.
    const value = Number(fields[8])
    if (fields.length < 9 || !/^\d+$/.test(fields[0]!) || fields[6] !== 'm' || !/^[012]$/.test(fields[7]!) || !Number.isFinite(value)) {
      reject(index, 'SINEX 坐标估计字段或单位无效，未读取为点坐标。')
      continue
    }
    const site = fields[2]!
    const solution = fields.slice(3, 6).join(':')
    const key = fields[1] === 'STAX' ? 'x' : fields[1] === 'STAY' ? 'y' : 'height'
    const point = coordinates.get(site) ?? { solution, values: {}, sourceRow: index + 1, rawFields: {} }
    if (point.solution !== solution || point.values[key] !== undefined) {
      ambiguousSites.add(site)
      reject(index, `SINEX 测站 ${site} 有多个点标识/解/历元或重复分量，未合并为单个坐标。`)
      continue
    }
    point.values[key] = value
    point.rawFields[`${key}SourceRecord`] = index + 1
    point.rawFields[`${key}Estimate`] = fields[8]!
    point.rawFields.solution = solution
    coordinates.set(site, point)
  }
  const points = [...coordinates].filter(([id, point]) => !ambiguousSites.has(id) && Object.keys(point.values).length === 3)
    .map(([id, point]) => SurveyPointV1.parse({ id, pointClass: 'check', known: false, ...point.values, sourceRow: point.sourceRow, sourceLocator: `SINEX:${point.sourceRow}:SOLUTION/ESTIMATE`, rawFields: point.rawFields }))
  return { ...classifyPoints(points), observations: [], diagnostics: [diagnostic('gnss_processing_required', 'blocking', 'SINEX 仅提供同解同历元的完整坐标检查值；没有逐基线向量/协方差和用户确认基准，不能进入基线网平差。'), ...diagnostics], anchors, disposition: 'gnss-processing-required', unit: 'm', summaryOverride: { skippedRecordCount: rejected } }
}

function nmeaCoordinate(raw: string, hemisphere: string): number | undefined {
  const value = Number(raw); if (!Number.isFinite(value)) return undefined
  const degrees = Math.floor(value / 100); const minutes = value - degrees * 100
  return (hemisphere === 'S' || hemisphere === 'W' ? -1 : 1) * (degrees + minutes / 60)
}

function parseNmea(text: string): ParsedSource {
  const { lines, anchors } = gnssTextEvidence(text, 'NMEA-line')
  const points: SurveyPoint[] = []
  let count = 0
  for (let index = 0; index < lines.length; index += 1) {
    const cells = lines[index]!.trim().split(',')
    if (!/\$(?:GP|GN|GL|GA|GB|BD)GGA/.test(cells[0] ?? '')) continue
    const latitude = nmeaCoordinate(cells[2] ?? '', cells[3] ?? '')
    const longitude = nmeaCoordinate(cells[4] ?? '', cells[5] ?? '')
    const height = Number(cells[9]); if (latitude === undefined || longitude === undefined) continue
    count += 1
    if (points.length < 1_000) points.push(SurveyPointV1.parse({ id: `NMEA-${count}`, pointClass: 'check', known: false, latitude, longitude, height: Number.isFinite(height) ? height : undefined, sourceRow: index + 1, sourceLocator: `NMEA:${index + 1}` }))
  }
  return { ...classifyPoints(points), observations: [], diagnostics: [diagnostic('gnss_processing_required', 'blocking', `已读取 ${count} 条 NMEA 定位记录；NMEA 定位结果不等于带协方差的 GNSS 基线观测`)], anchors, disposition: 'gnss-processing-required', unit: 'm' }
}

type Rtcm3Inspection = {
  messageTypes: number[]
  anchors: SurveyRawRecordAnchorV1[]
  diagnostics: SurveyImportDiagnosticV1[]
}

function unparsedGnssSourceAnchor(bytes: Buffer, format: SurveyFormatIdV1): SurveyRawRecordAnchorV1[] {
  if (!bytes.length) return []
  // One envelope for the original file, not guessed protocol messages. In
  // particular RTCM2 requires bit/word alignment and parity validation;
  // occurrences of 0x66/0x99 in arbitrary payloads are not record boundaries.
  return [SurveyRawRecordAnchorCreateV1.parse({
    id: `${format}-unparsed-source`, sourceRecord: 1,
    byteOffset: 0, byteLength: bytes.length, rawOffset: 0, rawLength: bytes.length,
    rawSnippet: '', recordType: `${format}-unparsed-source`
  })]
}

/**
 * Inspect RTCM3 frame boundaries only. This deliberately does not validate
 * the CRC or interpret message payloads beyond the optional 12-bit message
 * type, so a detected frame never becomes a semantic GNSS observation.
 */
function inspectRtcm3(bytes: Buffer): Rtcm3Inspection {
  const messageTypes = new Set<number>()
  const anchors: SurveyRawRecordAnchorV1[] = []
  const diagnostics: SurveyImportDiagnosticV1[] = []
  let offset = 0
  let sourceRecord = 0

  const addAnchor = (byteOffset: number, byteLength: number, recordType: string) => {
    sourceRecord += 1
    const item = SurveyRawRecordAnchorCreateV1.parse({
      id: `rtcm3-record-${sourceRecord}`,
      sourceRecord,
      byteOffset,
      byteLength,
      rawOffset: byteOffset,
      rawLength: byteLength,
      rawSnippet: '',
      recordType
    })
    anchors.push(item)
    return item
  }

  while (offset < bytes.length && anchors.length < MAX_RECORD_ANCHORS) {
    if (bytes[offset] !== 0xd3) {
      offset += 1
      continue
    }

    // A preamble without its two-byte length field cannot establish another
    // boundary. Preserve the remaining bytes rather than scanning into them.
    if (offset + 3 > bytes.length) {
      const record = addAnchor(offset, bytes.length - offset, 'RTCM3-truncated')
      diagnostics.push({
        code: 'invalid_record',
        severity: 'blocking',
        message: 'RTCM3 帧前导码后的长度字段不完整，已保留截断原始片段；该流不能作为可平差 GNSS 基线。',
        byteOffset: offset,
        recordAnchor: record.id,
        suggestedAction: '请重新导出或传输完整的 RTCM3 原始流，并在 GNSS 软件中完成基线解算、基准绑定和协方差导出后再导入。'
      })
      break
    }

    const payloadLength = ((bytes[offset + 1]! & 0x03) << 8) | bytes[offset + 2]!
    const frameLength = 3 + payloadLength + 3
    if (offset + frameLength > bytes.length) {
      const record = addAnchor(offset, bytes.length - offset, 'RTCM3-truncated')
      diagnostics.push({
        code: 'invalid_record',
        severity: 'blocking',
        message: `RTCM3 帧声明负载长度 ${payloadLength} 字节，但文件在完整帧结束前截断；已保留截断原始片段，不能将其视为 GNSS 基线结果。`,
        byteOffset: offset,
        recordAnchor: record.id,
        suggestedAction: '请重新导出或传输完整的 RTCM3 原始流，并在 GNSS 软件中完成基线解算、基准绑定和协方差导出后再导入。'
      })
      break
    }

    const messageType = payloadLength >= 2
      ? (bytes[offset + 3]! << 4) | (bytes[offset + 4]! >> 4)
      : undefined
    if (messageType !== undefined && messageTypes.size < 100) messageTypes.add(messageType)
    addAnchor(offset, frameLength, messageType === undefined ? 'RTCM3' : `RTCM3-${messageType}`)
    offset += frameLength
  }

  return { messageTypes: [...messageTypes].sort((left, right) => left - right), anchors, diagnostics }
}

function parseRtcm(bytes: Buffer, format: 'rtcm2' | 'rtcm3'): ParsedSource {
  const inspection: Rtcm3Inspection = format === 'rtcm3'
    ? inspectRtcm3(bytes)
    : { messageTypes: [], anchors: unparsedGnssSourceAnchor(bytes, format), diagnostics: [diagnostic('format_detected', 'warning', 'RTCM2 仅保留完整源文件字节范围；尚未验证位对齐、字校验和消息边界，不统计协议记录。')] }
  return {
    knownPoints: [],
    unknownPoints: [],
    observations: [],
    diagnostics: [
      diagnostic('gnss_processing_required', 'blocking', `${format.toUpperCase()} 改正/观测流已识别${inspection.messageTypes.length ? `，消息类型 ${inspection.messageTypes.join(', ')}` : ''}；需先解算为带基准和协方差的基线结果`),
      ...inspection.diagnostics
    ],
    anchors: inspection.anchors,
    ...(format === 'rtcm2' ? { summaryOverride: { recordCount: 0 } } : {}),
    disposition: 'gnss-processing-required',
    unit: 'm'
  }
}

function binaryAnchors(bytes: Buffer, format: 'ublox-ubx' | 'novatel-oem' | 'septentrio-sbf' | 'binex'): SurveyRawRecordAnchorV1[] {
  const anchors: SurveyRawRecordAnchorV1[] = []
  let offset = 0
  while (offset < bytes.length && anchors.length < MAX_RECORD_ANCHORS) {
    let length = 0
    let recordType: string = format
    if (format === 'ublox-ubx' && offset + 8 <= bytes.length && bytes[offset] === 0xb5 && bytes[offset + 1] === 0x62) {
      const payloadLength = bytes.readUInt16LE(offset + 4)
      length = 6 + payloadLength + 2
      recordType = `UBX-${bytes[offset + 2]!.toString(16).padStart(2, '0')}-${bytes[offset + 3]!.toString(16).padStart(2, '0')}`
    } else if (format === 'novatel-oem' && offset + 10 <= bytes.length && bytes[offset] === 0xaa && bytes[offset + 1] === 0x44 && (bytes[offset + 2] === 0x12 || bytes[offset + 2] === 0x13)) {
      const headerLength = bytes[offset + 3]!
      const payloadLength = bytes.readUInt16LE(offset + 8)
      length = headerLength + payloadLength + 4
      recordType = `NOVATEL-${bytes.readUInt16LE(offset + 4)}`
    } else if (format === 'septentrio-sbf' && offset + 8 <= bytes.length && bytes[offset] === 0x24 && bytes[offset + 1] === 0x40) {
      length = bytes.readUInt16LE(offset + 6)
      recordType = `SBF-${bytes.readUInt16LE(offset + 4) & 0x1fff}`
    } else if (format === 'binex' && [0xc2, 0xd2, 0xe2, 0xf2].includes(bytes[offset]!)) {
      length = 1
      recordType = `BINEX-0x${bytes[offset]!.toString(16)}`
    }
    if (length > 0 && offset + length <= bytes.length) {
      anchors.push(SurveyRawRecordAnchorCreateV1.parse({
        id: `record-${anchors.length + 1}`,
        sourceRecord: anchors.length + 1,
        byteOffset: offset,
        byteLength: length,
        rawOffset: offset,
        rawLength: length,
        rawSnippet: '',
        recordType
      }))
      offset += length
    } else offset += 1
  }
  return anchors
}

function parseGnssProfessionalSource(bytes: Buffer, format: SurveyFormatIdV1, text?: string): ParsedSource {
  const binaryFormat = format === 'ublox-ubx' || format === 'novatel-oem' || format === 'septentrio-sbf' || format === 'binex'
  const textEvidence = text !== undefined && ['sp3', 'ionex', 'antex'].includes(format)
    ? gnssTextEvidence(text, `${format}-line`)
    : undefined
  const opaqueSource = !binaryFormat && !textEvidence
  const anchors = binaryFormat
    ? binaryAnchors(bytes, format)
    : textEvidence?.anchors ?? unparsedGnssSourceAnchor(bytes, format)
  const recordCount = opaqueSource ? 0 : anchors.length
  const description: Partial<Record<SurveyFormatIdV1, string>> = {
    sp3: 'SP3 精密星历', ionex: 'IONEX 电离层产品', antex: 'ANTEX 天线校准',
    'ublox-ubx': 'u-blox UBX 原始接收机流', 'novatel-oem': 'NovAtel OEM 原始接收机流',
    'septentrio-sbf': 'Septentrio SBF 原始接收机流', binex: 'BINEX 原始 GNSS 交换流',
    'javad-jps': 'Javad JPS 原始接收机文件', 'topcon-tps': 'Topcon TPS 原始接收机文件',
    'south-sth': '南方测绘 STH 原始接收机文件', 'hitarget-zhd': '中海达 ZHD 原始接收机文件',
    'chcnav-hcn': '华测导航 HCN 原始接收机文件', 'comnav-cnb': '司南导航 CNB 原始接收机文件'
  }
  return {
    knownPoints: [],
    unknownPoints: [],
    observations: [],
    diagnostics: [
      diagnostic('gnss_processing_required', 'blocking', `${description[format] ?? format}已识别${recordCount ? `，预检${textEvidence ? '文本行' : '记录'} ${recordCount} 条` : ''}；它不是带固定基准和完整协方差的三维基线成果，必须先经过受审计的 GNSS 解算链`),
      ...(opaqueSource ? [diagnostic('format_detected', 'warning', '仅保留完整源文件字节范围；未验证接收机消息边界，不按二进制中的换行字节推断记录数量。')] : [])
    ],
    anchors,
    ...(opaqueSource ? { summaryOverride: { recordCount: 0 } } : {}),
    disposition: 'gnss-processing-required',
    unit: 'm'
  }
}

function parseConverterSource(format: SurveyFormatIdV1): ParsedSource {
  return {
    knownPoints: [], unknownPoints: [], observations: [], anchors: [], unit: 'm',
    disposition: 'converter-required',
    diagnostics: [diagnostic('converter_required', 'blocking', `${vendorForFormat(format)} / ${format} 需要固定版本、固定哈希、许可证已审计且网络隔离的本地转换器；当前不会猜测或重解释其字节`)]
  }
}

const WORKWISE_LINEAR_UNITS = new Set(['m', 'meter', 'meters', 'km', 'cm', 'mm'])
const WORKWISE_ANGULAR_UNITS = new Set(['rad', 'radian', 'radians', 'gon', 'grad', 'grads', 'deg', 'degree', 'degrees', '°', 'arcsec', 'arcsecond', 'arcseconds', 'sec', '″'])

type JsonTextSpan = { start: number; end: number }
type WorkwiseJsonRecordSpans = {
  knownPoints: JsonTextSpan[]
  unknownPoints: JsonTextSpan[]
  observations: JsonTextSpan[]
}

const MAX_WORKWISE_JSON_SCANNER_DEPTH = 128
/**
 * The frozen envelope's schema only admits small, named objects (apart from
 * instrumentParameters). Bound the temporary duplicate-key set as well, so a
 * malformed object cannot turn this pre-JSON.parse guard into an unbounded
 * allocation path.
 */
const MAX_WORKWISE_JSON_OBJECT_KEYS = 10_000

function workwiseJsonScannerError(message: string): never {
  throw new SurveySourceParseError('invalid_record', `WorkWise JSON 无法建立精确原始记录锚点：${message}`)
}

function skipJsonWhitespace(text: string, offset: number): number {
  let cursor = offset
  while (cursor < text.length && /[ \t\r\n]/.test(text[cursor]!)) cursor += 1
  return cursor
}

/** Returns the first offset after a JSON string without decoding its content. */
function jsonStringEnd(text: string, start: number): number {
  if (text[start] !== '"') workwiseJsonScannerError('记录键不是 JSON 字符串')
  let cursor = start + 1
  while (cursor < text.length) {
    const character = text[cursor]!
    if (character === '"') return cursor + 1
    if (character === '\\') {
      const escaped = text[cursor + 1]
      if (!escaped) workwiseJsonScannerError('字符串转义未结束')
      if (escaped === 'u') {
        const hex = text.slice(cursor + 2, cursor + 6)
        if (!/^[0-9a-f]{4}$/i.test(hex)) workwiseJsonScannerError('字符串 Unicode 转义无效')
        cursor += 6
      } else {
        if (!'"\\/bfnrt'.includes(escaped)) workwiseJsonScannerError('字符串转义无效')
        cursor += 2
      }
      continue
    }
    if (character.codePointAt(0)! < 0x20) workwiseJsonScannerError('字符串含有未转义控制字符')
    cursor += 1
  }
  workwiseJsonScannerError('字符串未结束')
}

/**
 * Finds the exact lexical span of one JSON value. JSON.parse has already
 * validated the source; this bounded scanner only recovers source positions
 * and intentionally does not reinterpret any survey fields.
 */
function jsonValueEnd(text: string, start: number, depth = 0): number {
  if (depth > MAX_WORKWISE_JSON_SCANNER_DEPTH) workwiseJsonScannerError(`JSON 嵌套超过 ${MAX_WORKWISE_JSON_SCANNER_DEPTH} 层`) 
  const offset = skipJsonWhitespace(text, start)
  const opening = text[offset]
  if (!opening) workwiseJsonScannerError('记录值缺失')
  if (opening === '"') return jsonStringEnd(text, offset)
  if (opening === '{') {
    let cursor = skipJsonWhitespace(text, offset + 1)
    if (text[cursor] === '}') return cursor + 1
    while (cursor < text.length) {
      if (text[cursor] !== '"') workwiseJsonScannerError('对象键缺失')
      cursor = skipJsonWhitespace(text, jsonStringEnd(text, cursor))
      if (text[cursor] !== ':') workwiseJsonScannerError('对象键后缺少冒号')
      cursor = skipJsonWhitespace(text, jsonValueEnd(text, cursor + 1, depth + 1))
      if (text[cursor] === '}') return cursor + 1
      if (text[cursor] !== ',') workwiseJsonScannerError('对象记录之间缺少逗号')
      cursor = skipJsonWhitespace(text, cursor + 1)
    }
    workwiseJsonScannerError('对象未结束')
  }
  if (opening === '[') {
    let cursor = skipJsonWhitespace(text, offset + 1)
    if (text[cursor] === ']') return cursor + 1
    while (cursor < text.length) {
      cursor = skipJsonWhitespace(text, jsonValueEnd(text, cursor, depth + 1))
      if (text[cursor] === ']') return cursor + 1
      if (text[cursor] !== ',') workwiseJsonScannerError('数组记录之间缺少逗号')
      cursor = skipJsonWhitespace(text, cursor + 1)
    }
    workwiseJsonScannerError('数组未结束')
  }
  let cursor = offset
  while (cursor < text.length && !/[ \t\r\n,}\]]/.test(text[cursor]!)) cursor += 1
  const primitive = text.slice(offset, cursor)
  if (!primitive) workwiseJsonScannerError('原始值缺失')
  try {
    JSON.parse(primitive)
  } catch {
    workwiseJsonScannerError('原始值无效')
  }
  return cursor
}

type WorkwiseJsonBoundedArrayField = 'knownPoints' | 'unknownPoints' | 'observations'

const WORKWISE_JSON_ARRAY_LIMITS: Readonly<Record<WorkwiseJsonBoundedArrayField, number>> = {
  knownPoints: MAX_PARSED_POINTS,
  unknownPoints: MAX_PARSED_POINTS,
  observations: MAX_PARSED_OBSERVATIONS
}

type WorkwiseJsonPreflightCounts = Record<WorkwiseJsonBoundedArrayField, number> & {
  points: number
  records: number
}

function recordWorkwiseJsonPreflightElement(
  field: WorkwiseJsonBoundedArrayField,
  counts: WorkwiseJsonPreflightCounts
): void {
  counts[field] += 1
  if (counts[field] > WORKWISE_JSON_ARRAY_LIMITS[field]) {
    const label = field === 'observations' ? '观测' : '点位'
    throw new SurveySourceParseError(
      'limit_exceeded',
      `WorkWise JSON network.${field} 超过 ${WORKWISE_JSON_ARRAY_LIMITS[field].toLocaleString('zh-CN')} 条${label}上限；已在 JSON 对象构造前拒绝导入。`
    )
  }
  if (field !== 'observations') {
    counts.points += 1
    if (counts.points > MAX_PARSED_POINTS) {
      throw new SurveySourceParseError(
        'limit_exceeded',
        `WorkWise JSON network.knownPoints 与 network.unknownPoints 合计超过 ${MAX_PARSED_POINTS.toLocaleString('zh-CN')} 个点位上限；已在 JSON 对象构造前拒绝导入。`
      )
    }
  }
  counts.records += 1
  if (counts.records > MAX_RECORD_ANCHORS) {
    throw new SurveySourceParseError(
      'limit_exceeded',
      `WorkWise JSON 点位与观测原始记录合计超过 ${MAX_RECORD_ANCHORS.toLocaleString('zh-CN')} 条锚点上限；已在 JSON 对象构造前拒绝导入。`
    )
  }
}

/**
 * Scan one JSON array without allocating spans or parsed values.  The scanner
 * uses the same string/value token rules as the later exact-anchor scanner,
 * but stops before an oversized frozen source can reach JSON.parse/Zod and
 * allocate a materialized point or observation collection.
 */
function boundedWorkwiseJsonArrayEnd(
  text: string,
  start: number,
  field: WorkwiseJsonBoundedArrayField,
  counts: WorkwiseJsonPreflightCounts
): number {
  const offset = skipJsonWhitespace(text, start)
  if (text[offset] !== '[') return jsonValueEnd(text, offset)
  let cursor = skipJsonWhitespace(text, offset + 1)
  if (text[cursor] === ']') return cursor + 1
  while (cursor < text.length) {
    recordWorkwiseJsonPreflightElement(field, counts)
    cursor = skipJsonWhitespace(text, jsonValueEnd(text, cursor))
    if (text[cursor] === ']') return cursor + 1
    if (text[cursor] !== ',') workwiseJsonScannerError('数组记录之间缺少逗号')
    cursor = skipJsonWhitespace(text, cursor + 1)
  }
  workwiseJsonScannerError('数组未结束')
}

/**
 * Walk a `network` object lexically and bound its three record collections.
 * The preflight deliberately checks every lexical duplicate of a protected
 * property: JSON.parse's last-key-wins semantics must not let a discarded,
 * oversized earlier array consume unbounded parsing resources.
 */
function preflightWorkwiseJsonNetwork(text: string, start: number, counts: WorkwiseJsonPreflightCounts): number {
  if (text[start] !== '{') return jsonValueEnd(text, start)
  let cursor = skipJsonWhitespace(text, start + 1)
  if (text[cursor] === '}') return cursor + 1
  while (cursor < text.length) {
    if (text[cursor] !== '"') workwiseJsonScannerError('对象键缺失')
    const keyStart = cursor
    const keyEnd = jsonStringEnd(text, cursor)
    let key: string
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as string
    } catch {
      workwiseJsonScannerError('对象键无效')
    }
    cursor = skipJsonWhitespace(text, keyEnd)
    if (text[cursor] !== ':') workwiseJsonScannerError('对象键后缺少冒号')
    const valueStart = skipJsonWhitespace(text, cursor + 1)
    const valueEnd = Object.hasOwn(WORKWISE_JSON_ARRAY_LIMITS, key)
      ? boundedWorkwiseJsonArrayEnd(text, valueStart, key as WorkwiseJsonBoundedArrayField, counts)
      : jsonValueEnd(text, valueStart)
    cursor = skipJsonWhitespace(text, valueEnd)
    if (text[cursor] === '}') return cursor + 1
    if (text[cursor] !== ',') workwiseJsonScannerError('对象记录之间缺少逗号')
    cursor = skipJsonWhitespace(text, cursor + 1)
  }
  workwiseJsonScannerError('对象未结束')
}

/**
 * F-FMT-39: preflight frozen WorkWise JSON before JSON.parse/Zod.  It holds
 * only the current lexical cursor and record count; no point, observation, or
 * source-anchor collection exists until this passes.
 */
function preflightWorkwiseJsonArrayLimits(text: string): void {
  const counts: WorkwiseJsonPreflightCounts = {
    knownPoints: 0,
    unknownPoints: 0,
    observations: 0,
    points: 0,
    records: 0
  }
  const rootStart = skipJsonWhitespace(text, 0)
  if (text[rootStart] !== '{') return
  let cursor = skipJsonWhitespace(text, rootStart + 1)
  if (text[cursor] === '}') return
  while (cursor < text.length) {
    if (text[cursor] !== '"') workwiseJsonScannerError('对象键缺失')
    const keyStart = cursor
    const keyEnd = jsonStringEnd(text, cursor)
    let key: string
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as string
    } catch {
      workwiseJsonScannerError('对象键无效')
    }
    cursor = skipJsonWhitespace(text, keyEnd)
    if (text[cursor] !== ':') workwiseJsonScannerError('对象键后缺少冒号')
    const valueStart = skipJsonWhitespace(text, cursor + 1)
    const valueEnd = key === 'network' && text[valueStart] === '{'
      ? preflightWorkwiseJsonNetwork(text, valueStart, counts)
      : jsonValueEnd(text, valueStart)
    cursor = skipJsonWhitespace(text, valueEnd)
    if (text[cursor] === '}') {
      if (skipJsonWhitespace(text, cursor + 1) !== text.length) workwiseJsonScannerError('JSON 根对象后存在额外内容')
      return
    }
    if (text[cursor] !== ',') workwiseJsonScannerError('对象记录之间缺少逗号')
    cursor = skipJsonWhitespace(text, cursor + 1)
  }
  workwiseJsonScannerError('对象未结束')
}

function decodedJsonObjectKey(text: string, start: number, end: number): string {
  try {
    const key = JSON.parse(text.slice(start, end))
    if (typeof key !== 'string') workwiseJsonScannerError('对象键无效')
    return key
  } catch (error) {
    if (error instanceof SurveySourceParseError) throw error
    workwiseJsonScannerError('对象键无效')
  }
}

function displayJsonObjectKey(key: string): string {
  const bounded = key.length > 160 ? `${key.slice(0, 160)}…` : key
  return JSON.stringify(bounded)
}

/**
 * Frozen JSON is both a calculation input and its audit evidence.  Native
 * JSON.parse accepts duplicate object keys with last-write-wins semantics,
 * which would make the source excerpt disagree with the value the solver
 * actually receives.  Reject every duplicate before JSON.parse, including
 * escaped-equivalent keys and nested point/observation objects.
 */
function workwiseJsonValueEndWithoutDuplicateKeys(text: string, start: number, depth = 0): number {
  if (depth > MAX_WORKWISE_JSON_SCANNER_DEPTH) workwiseJsonScannerError(`JSON 嵌套超过 ${MAX_WORKWISE_JSON_SCANNER_DEPTH} 层`)
  const offset = skipJsonWhitespace(text, start)
  const opening = text[offset]
  if (!opening) workwiseJsonScannerError('记录值缺失')
  if (opening === '"') return jsonStringEnd(text, offset)
  if (opening === '{') {
    const keys = new Set<string>()
    let cursor = skipJsonWhitespace(text, offset + 1)
    if (text[cursor] === '}') return cursor + 1
    while (cursor < text.length) {
      if (text[cursor] !== '"') workwiseJsonScannerError('对象键缺失')
      const keyStart = cursor
      const keyEnd = jsonStringEnd(text, cursor)
      const key = decodedJsonObjectKey(text, keyStart, keyEnd)
      if (keys.has(key)) {
        workwiseJsonScannerError(`冻结来源不允许重复对象键 ${displayJsonObjectKey(key)}；不得采用 JSON 的后写覆盖语义。`)
      }
      if (keys.size >= MAX_WORKWISE_JSON_OBJECT_KEYS) {
        workwiseJsonScannerError(`单个对象属性超过 ${MAX_WORKWISE_JSON_OBJECT_KEYS.toLocaleString('zh-CN')} 条安全上限`)
      }
      keys.add(key)
      cursor = skipJsonWhitespace(text, keyEnd)
      if (text[cursor] !== ':') workwiseJsonScannerError('对象键后缺少冒号')
      cursor = skipJsonWhitespace(text, workwiseJsonValueEndWithoutDuplicateKeys(text, cursor + 1, depth + 1))
      if (text[cursor] === '}') return cursor + 1
      if (text[cursor] !== ',') workwiseJsonScannerError('对象记录之间缺少逗号')
      cursor = skipJsonWhitespace(text, cursor + 1)
    }
    workwiseJsonScannerError('对象未结束')
  }
  if (opening === '[') {
    let cursor = skipJsonWhitespace(text, offset + 1)
    if (text[cursor] === ']') return cursor + 1
    while (cursor < text.length) {
      cursor = skipJsonWhitespace(text, workwiseJsonValueEndWithoutDuplicateKeys(text, cursor, depth + 1))
      if (text[cursor] === ']') return cursor + 1
      if (text[cursor] !== ',') workwiseJsonScannerError('数组记录之间缺少逗号')
      cursor = skipJsonWhitespace(text, cursor + 1)
    }
    workwiseJsonScannerError('数组未结束')
  }
  return jsonValueEnd(text, offset, depth)
}

function rejectDuplicateWorkwiseJsonObjectKeys(text: string): void {
  const rootStart = skipJsonWhitespace(text, 0)
  if (text[rootStart] !== '{') return
  const rootEnd = workwiseJsonValueEndWithoutDuplicateKeys(text, rootStart)
  if (skipJsonWhitespace(text, rootEnd) !== text.length) workwiseJsonScannerError('JSON 根对象后存在额外内容')
}

/** The duplicate-key preflight has already rejected ambiguous sources. */
function jsonObjectProperties(text: string, span: JsonTextSpan): Map<string, JsonTextSpan> {
  if (text[span.start] !== '{' || text[span.end - 1] !== '}') workwiseJsonScannerError('预期对象记录')
  const properties = new Map<string, JsonTextSpan>()
  let cursor = skipJsonWhitespace(text, span.start + 1)
  if (text[cursor] === '}') return properties
  while (cursor < span.end - 1) {
    if (text[cursor] !== '"') workwiseJsonScannerError('对象键缺失')
    const keyStart = cursor
    const keyEnd = jsonStringEnd(text, cursor)
    let key: string
    try {
      key = JSON.parse(text.slice(keyStart, keyEnd)) as string
    } catch {
      workwiseJsonScannerError('对象键无效')
    }
    cursor = skipJsonWhitespace(text, keyEnd)
    if (text[cursor] !== ':') workwiseJsonScannerError('对象键后缺少冒号')
    const valueStart = skipJsonWhitespace(text, cursor + 1)
    const valueEnd = jsonValueEnd(text, valueStart)
    properties.set(key, { start: valueStart, end: valueEnd })
    cursor = skipJsonWhitespace(text, valueEnd)
    if (text[cursor] === '}') return properties
    if (text[cursor] !== ',') workwiseJsonScannerError('对象记录之间缺少逗号')
    cursor = skipJsonWhitespace(text, cursor + 1)
  }
  workwiseJsonScannerError('对象未结束')
}

function jsonArrayElements(text: string, span: JsonTextSpan | undefined): JsonTextSpan[] {
  if (!span) return []
  if (text[span.start] !== '[' || text[span.end - 1] !== ']') workwiseJsonScannerError('预期记录数组')
  const elements: JsonTextSpan[] = []
  let cursor = skipJsonWhitespace(text, span.start + 1)
  if (text[cursor] === ']') return elements
  while (cursor < span.end - 1) {
    const start = cursor
    const end = jsonValueEnd(text, start)
    elements.push({ start, end })
    cursor = skipJsonWhitespace(text, end)
    if (text[cursor] === ']') return elements
    if (text[cursor] !== ',') workwiseJsonScannerError('数组记录之间缺少逗号')
    cursor = skipJsonWhitespace(text, cursor + 1)
  }
  workwiseJsonScannerError('数组未结束')
}

function workwiseJsonRecordSpans(text: string): WorkwiseJsonRecordSpans {
  const rootStart = skipJsonWhitespace(text, 0)
  const rootEnd = jsonValueEnd(text, rootStart)
  if (skipJsonWhitespace(text, rootEnd) !== text.length) workwiseJsonScannerError('JSON 根对象后存在额外内容')
  const root = jsonObjectProperties(text, { start: rootStart, end: rootEnd })
  const networkSpan = root.get('network')
  if (!networkSpan) workwiseJsonScannerError('缺少 network 对象')
  const network = jsonObjectProperties(text, networkSpan)
  return {
    knownPoints: jsonArrayElements(text, network.get('knownPoints')),
    unknownPoints: jsonArrayElements(text, network.get('unknownPoints')),
    observations: jsonArrayElements(text, network.get('observations'))
  }
}

type WorkwiseByteOffset = (characterOffset: number) => number

function utf16beBytes(text: string): Buffer {
  const littleEndian = Buffer.from(text, 'utf16le')
  const bigEndian = Buffer.alloc(littleEndian.length)
  for (let offset = 0; offset < littleEndian.length; offset += 2) {
    bigEndian[offset] = littleEndian[offset + 1]!
    bigEndian[offset + 1] = littleEndian[offset]!
  }
  return bigEndian
}

/**
 * Resolve only the lexical positions that will become anchors in one forward
 * UTF-8 scan. Calling Buffer.byteLength(text.slice(0, offset)) for every
 * record makes a 100k-record input quadratic and turns a bounded import into
 * a practical denial of service.
 */
function utf8ByteOffsetsAt(text: string, characterOffsets: readonly number[]): Map<number, number> {
  const offsets = [...new Set(characterOffsets)].sort((left, right) => left - right)
  const resolved = new Map<number, number>()
  let cursor = 0
  let byteOffset = 0
  for (const requestedOffset of offsets) {
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > text.length) {
      workwiseJsonScannerError('记录字符位置越界')
    }
    const previous = requestedOffset > 0 ? text.charCodeAt(requestedOffset - 1) : undefined
    const next = requestedOffset < text.length ? text.charCodeAt(requestedOffset) : undefined
    if (previous !== undefined && next !== undefined && previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      workwiseJsonScannerError('记录字符位置落在 Unicode 代理对中间')
    }
    while (cursor < requestedOffset) {
      const codeUnit = text.charCodeAt(cursor)
      const nextCodeUnit = cursor + 1 < text.length ? text.charCodeAt(cursor + 1) : undefined
      const surrogatePair = codeUnit >= 0xd800 && codeUnit <= 0xdbff && nextCodeUnit !== undefined && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff
      if (surrogatePair) {
        byteOffset += 4
        cursor += 2
      } else {
        byteOffset += codeUnit < 0x80 ? 1 : codeUnit < 0x800 ? 2 : 3
        cursor += 1
      }
    }
    resolved.set(requestedOffset, byteOffset)
  }
  return resolved
}

/**
 * Produce byte offsets in the preserved attachment's encoding. The importer
 * rejects an encoding whose exact round trip cannot be proved; a plausible
 * decoded string is not enough to fabricate an auditable raw locator.
 */
function workwiseByteOffsetMapper(text: string, bytes: Buffer, encoding: string, characterOffsets: readonly number[]): WorkwiseByteOffset {
  if (encoding === 'utf-8') {
    const prefixLength = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
    if (!bytes.subarray(prefixLength).equals(Buffer.from(text, 'utf8'))) {
      workwiseJsonScannerError('UTF-8 字节无法与已解码文本逐字节对应')
    }
    const resolved = utf8ByteOffsetsAt(text, characterOffsets)
    return (characterOffset) => {
      const byteOffset = resolved.get(characterOffset)
      if (byteOffset === undefined) workwiseJsonScannerError('请求了未解析的记录字符位置')
      return prefixLength + byteOffset
    }
  }
  if (encoding === 'utf-16le') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xfe || !bytes.subarray(2).equals(Buffer.from(text, 'utf16le'))) {
      workwiseJsonScannerError('UTF-16LE 字节无法与已解码文本逐字节对应')
    }
    return (characterOffset) => 2 + characterOffset * 2
  }
  if (encoding === 'utf-16be') {
    if (bytes[0] !== 0xfe || bytes[1] !== 0xff || !bytes.subarray(2).equals(utf16beBytes(text))) {
      workwiseJsonScannerError('UTF-16BE 字节无法与已解码文本逐字节对应')
    }
    return (characterOffset) => 2 + characterOffset * 2
  }
  workwiseJsonScannerError(`文本编码 ${encoding} 尚不能安全映射至原始字节位置`)
}

function workwiseJsonRecordAnchor(
  bytes: Buffer,
  text: string,
  span: JsonTextSpan,
  byteOffsetFor: WorkwiseByteOffset,
  id: string,
  sourceRecord: number,
  recordType: string,
  section: string
): SurveyRawRecordAnchorV1 {
  const rawOffset = byteOffsetFor(span.start)
  const rawEnd = byteOffsetFor(span.end)
  const rawLength = rawEnd - rawOffset
  if (!Number.isInteger(rawOffset) || !Number.isInteger(rawEnd) || rawOffset < 0 || rawLength <= 0 || rawEnd > bytes.length) {
    workwiseJsonScannerError('记录字节范围越界')
  }
  return SurveyRawRecordAnchorCreateV1.parse({
    id,
    sourceRecord,
    byteOffset: rawOffset,
    byteLength: rawLength,
    rawOffset,
    rawLength,
    // The source range remains byte-addressed, while the review excerpt uses
    // the registry's proven decoded text. Decoding UTF-16 bytes as UTF-8 here
    // would turn a valid source record into an opaque `hex:` placeholder.
    rawSnippet: rawTextSnippet(text, span.start, span.end),
    recordType,
    section
  })
}

function workwiseObservationIsAngular(observation: SurveyObservation): boolean {
  return observation.type === 'direction' || observation.type === 'angle' || observation.type === 'zenith'
}

function frozenWorkwiseNetworkMetadata(network: WorkwiseSurveySourceV1['network'], rawNetwork: Record<string, unknown>): FrozenWorkwiseNetworkMetadata {
  const metadata: FrozenWorkwiseNetworkMetadata = {}
  // `SurveyNetworkV1.partial()` still applies a few inner defaults. Preserve
  // only values actually present in the frozen bytes, otherwise an injected
  // "待确认" could shadow an explicit legacy heightDatum during migration.
  if (Object.hasOwn(rawNetwork, 'id') && network.id !== undefined) metadata.id = network.id
  if (Object.hasOwn(rawNetwork, 'networkType') && network.networkType !== undefined) metadata.networkType = network.networkType
  if (Object.hasOwn(rawNetwork, 'transformType') && network.transformType !== undefined) metadata.transformType = network.transformType
  if (Object.hasOwn(rawNetwork, 'coordinateSystem') && network.coordinateSystem !== undefined) metadata.coordinateSystem = network.coordinateSystem
  if (Object.hasOwn(rawNetwork, 'projection') && network.projection !== undefined) metadata.projection = network.projection
  if (Object.hasOwn(rawNetwork, 'centralMeridian') && network.centralMeridian !== undefined) metadata.centralMeridian = network.centralMeridian
  if (Object.hasOwn(rawNetwork, 'ellipsoid') && network.ellipsoid !== undefined) metadata.ellipsoid = network.ellipsoid
  if (Object.hasOwn(rawNetwork, 'verticalDatum') && network.verticalDatum !== undefined) metadata.verticalDatum = network.verticalDatum
  if (Object.hasOwn(rawNetwork, 'heightDatum') && network.heightDatum !== undefined) metadata.heightDatum = network.heightDatum
  if (Object.hasOwn(rawNetwork, 'unit') && network.unit !== undefined) metadata.unit = network.unit
  return metadata
}

/**
 * WorkWise JSON is an explicit, versioned source contract—not a fallback for
 * arbitrary JSON. Every point and observation receives an immutable, exact
 * byte-range anchor in the preserved attachment; JSON formatting or a second
 * record cannot cause a residual to refer to the entire document instead.
 */
function parseWorkwiseSurveySource(textResult: TextResult, bytes: Buffer): ParsedSource {
  const { text } = textResult
  preflightWorkwiseJsonArrayLimits(text)
  rejectDuplicateWorkwiseJsonObjectKeys(text)
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new SurveySourceParseError('invalid_record', 'WorkWise JSON 源文件不是有效 JSON')
  }
  const parsed = WorkwiseSurveySourceV1.safeParse(raw)
  if (!parsed.success) {
    throw new SurveySourceParseError('invalid_record', `WorkWise JSON 未满足冻结来源合同 ${WORKWISE_SURVEY_SOURCE_FORMAT}@${WORKWISE_SURVEY_SOURCE_FORMAT_VERSION}`)
  }
  const network = parsed.data.network
  const rawEnvelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const rawNetwork = rawEnvelope.network && typeof rawEnvelope.network === 'object' && !Array.isArray(rawEnvelope.network)
    ? rawEnvelope.network as Record<string, unknown>
    : {}
  const rawObservations = Array.isArray(rawNetwork.observations) ? rawNetwork.observations : []
  const knownPoints = network.knownPoints ?? []
  const unknownPoints = network.unknownPoints ?? []
  const observations = network.observations ?? []
  const recordSpans = workwiseJsonRecordSpans(text)
  if (
    recordSpans.knownPoints.length !== knownPoints.length ||
    recordSpans.unknownPoints.length !== unknownPoints.length ||
    recordSpans.observations.length !== observations.length
  ) {
    workwiseJsonScannerError('解析后的记录数量与原始 JSON 数组不一致')
  }
  const byteOffsetFor = workwiseByteOffsetMapper(
    text,
    bytes,
    textResult.encoding,
    [...recordSpans.knownPoints, ...recordSpans.unknownPoints, ...recordSpans.observations].flatMap((span) => [span.start, span.end])
  )
  const pointCount = knownPoints.length + unknownPoints.length
  const anchors = [
    ...knownPoints.map((_, index) => workwiseJsonRecordAnchor(
      bytes,
      text,
      recordSpans.knownPoints[index]!,
      byteOffsetFor,
      `workwise-json-known-point-${index + 1}`,
      index + 1,
      'workwise-json-known-point',
      'network.knownPoints'
    )),
    ...unknownPoints.map((_, index) => workwiseJsonRecordAnchor(
      bytes,
      text,
      recordSpans.unknownPoints[index]!,
      byteOffsetFor,
      `workwise-json-unknown-point-${index + 1}`,
      knownPoints.length + index + 1,
      'workwise-json-unknown-point',
      'network.unknownPoints'
    )),
    ...observations.map((_, index) => workwiseJsonRecordAnchor(
      bytes,
      text,
      recordSpans.observations[index]!,
      byteOffsetFor,
      `workwise-json-observation-${index + 1}`,
      pointCount + index + 1,
      'workwise-json-observation',
      'network.observations'
    ))
  ]
  const diagnostics: SurveyImportDiagnosticV1[] = []
  const rawLinearUnits = new Set<string>()
  const rawAngularUnits = new Set<string>()
  // A frozen source, not an import request, determines which solver may read
  // its observations. Do not let a UI-selected networkType (or transformType)
  // fill a semantic hole in otherwise valid-looking bytes.
  const hasExplicitNetworkType = Object.hasOwn(rawNetwork, 'networkType') && network.networkType !== undefined
  if (!hasExplicitNetworkType) {
    diagnostics.push({
      code: 'invalid_record',
      severity: 'blocking',
      message: 'WorkWise JSON 未显式声明 networkType；不得由导入请求或默认值决定平差模型。',
      suggestedAction: '在冻结 WorkWise JSON 的 network 中显式填写 networkType 后重新导出。'
    })
  } else if (network.networkType === 'coordinate-transform' && (!Object.hasOwn(rawNetwork, 'transformType') || network.transformType === undefined)) {
    diagnostics.push({
      code: 'invalid_record',
      severity: 'blocking',
      message: 'WorkWise JSON 声明 coordinate-transform 但未显式声明 transformType；不得由导入请求决定变换模型。',
      suggestedAction: '在冻结 WorkWise JSON 的 network 中显式填写 transformType（例如 similarity-2d、helmert-7 或 height-fit）后重新导出。'
    })
  }
  // `SurveyNetworkV1` deliberately remains structurally permissive enough to
  // read historical records.  A solver and residual provenance map, however,
  // are keyed by point/observation ID.  Letting duplicate IDs through as an
  // adjustment-ready frozen source would make those maps silently choose one
  // record.  Report the ambiguity at ingress (in one bounded diagnostic per
  // identity kind) and retain the source only for audit.
  const duplicateIds = (ids: readonly string[]): string[] => {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id)
      seen.add(id)
    }
    return [...duplicates].sort()
  }
  const describeDuplicates = (ids: readonly string[]) => `${ids.slice(0, 10).join('、')}${ids.length > 10 ? ` 等 ${ids.length} 个` : ''}`
  const duplicatePointIds = duplicateIds([...knownPoints, ...unknownPoints].map((point) => point.id))
  if (duplicatePointIds.length) {
    diagnostics.push({
      code: 'invalid_record',
      severity: 'blocking',
      message: `WorkWise JSON 已知点/未知点中存在重复点号 ${describeDuplicates(duplicatePointIds)}；点位映射不唯一，不能进入平差。`,
      suggestedAction: '为每个已知点和未知点分配唯一点号后重新导出冻结 WorkWise JSON。'
    })
  }
  const duplicateObservationIds = duplicateIds(observations.map((observation) => observation.id))
  if (duplicateObservationIds.length) {
    const duplicateIndex = observations.findIndex((observation) => duplicateObservationIds.includes(observation.id))
    const duplicateAnchor = duplicateIndex >= 0 ? anchors[pointCount + duplicateIndex] : undefined
    diagnostics.push({
      code: 'invalid_record',
      severity: 'blocking',
      message: `WorkWise JSON 中存在重复观测编号 ${describeDuplicates(duplicateObservationIds)}；残差与原始资料映射不唯一，不能进入平差。`,
      ...(duplicateAnchor ? { sourceRecord: duplicateAnchor.sourceRecord, recordAnchor: duplicateAnchor.id } : {}),
      suggestedAction: '为每条观测分配唯一编号，并保留对应的唯一原始资料记录锚点后重新导出。'
    })
  }
  const hasExplicitNetworkUnit = typeof rawNetwork.unit === 'string' && rawNetwork.unit.trim().length > 0
  if (hasExplicitNetworkUnit) rawLinearUnits.add(rawNetwork.unit as string)
  else rawLinearUnits.add('not-declared')
  if (!observations.length && !(network.networkType === 'coordinate-transform' && pointCount > 0)) {
    diagnostics.push(diagnostic('missing_geometry', 'blocking', 'WorkWise JSON 未包含观测记录；除已声明点位变换外，不能作为可平差来源'))
  }
  // The frozen envelope currently has no per-point coordinate/height unit
  // field.  Observation values are explicitly normalised later, but point
  // coordinates are already consumed by solvers as metres.  Do not label a
  // cm/mm/km coordinate network as canonical m until an auditable coordinate
  // conversion contract is implemented.
  const networkUnit = hasExplicitNetworkUnit ? (rawNetwork.unit as string).trim().toLowerCase() : ''
  const coordinateUnitIsMetres = hasExplicitNetworkUnit && ['m', 'meter', 'meters'].includes(networkUnit)
  if (!coordinateUnitIsMetres) {
    diagnostics.push({
      code: 'invalid_record',
      severity: 'blocking',
      message: hasExplicitNetworkUnit
        ? `WorkWise JSON 网络坐标/高程单位 ${rawNetwork.unit as string} 尚无冻结的点位换算合同；不得把点位数值标记为米制或进入平差。`
        : 'WorkWise JSON 未显式声明网络坐标/高程单位；不得默认以米制解释点位或进入平差。',
      suggestedAction: '请将点位坐标和高程以 m 重新导出，或等待具备点位单位映射与双来源验证的导入工作流。'
    })
  }
  let observationUnitsVerified = true
  for (const [index, observation] of observations.entries()) {
    const angular = workwiseObservationIsAngular(observation)
    const unitBucket = angular ? rawAngularUnits : rawLinearUnits
    const rawObservation = rawObservations[index] && typeof rawObservations[index] === 'object' && !Array.isArray(rawObservations[index])
      ? rawObservations[index] as Record<string, unknown>
      : {}
    const hasExplicitUnit = typeof rawObservation.unit === 'string' && rawObservation.unit.trim().length > 0
    const hasSigma = Object.prototype.hasOwnProperty.call(rawObservation, 'sigma') && rawObservation.sigma !== undefined
    const hasExplicitSigmaUnit = typeof rawObservation.sigmaUnit === 'string' && rawObservation.sigmaUnit.trim().length > 0
    unitBucket.add(hasExplicitUnit ? rawObservation.unit as string : 'not-declared')
    if (hasSigma) unitBucket.add(hasExplicitSigmaUnit ? rawObservation.sigmaUnit as string : 'not-declared')
    if (!hasExplicitUnit || (hasSigma && !hasExplicitSigmaUnit)) {
      observationUnitsVerified = false
      diagnostics.push({
        code: 'invalid_record',
        severity: 'blocking',
        message: `WorkWise JSON 第 ${index + 1} 条观测${!hasExplicitUnit ? '未显式声明观测单位' : '给出了中误差但未显式声明中误差单位'}；不得以默认单位进入平差。`,
        sourceRecord: anchors[pointCount + index]!.sourceRecord,
        recordAnchor: anchors[pointCount + index]!.id,
        suggestedAction: angular ? '显式提供观测 unit（deg、gon/grad、rad 或 arcsec）及 sigmaUnit。' : '显式提供观测 unit（m、km、cm 或 mm）及 sigmaUnit。'
      })
    }
    const supported = (angular ? WORKWISE_ANGULAR_UNITS : WORKWISE_LINEAR_UNITS).has(observation.unit.trim().toLowerCase())
    const sigmaSupported = !observation.sigmaUnit || (angular ? WORKWISE_ANGULAR_UNITS : WORKWISE_LINEAR_UNITS).has(observation.sigmaUnit.trim().toLowerCase())
    if (!supported || !sigmaSupported) {
      observationUnitsVerified = false
      diagnostics.push({
        code: 'invalid_record',
        severity: 'blocking',
        message: `WorkWise JSON 第 ${index + 1} 条观测的${!supported ? '观测' : '中误差'}单位没有冻结换算定义，不能进入平差`,
        sourceRecord: anchors[pointCount + index]!.sourceRecord,
        recordAnchor: anchors[pointCount + index]!.id,
        suggestedAction: angular ? '使用 deg、gon/grad、rad 或 arcsec，并明确中误差单位。' : '使用 m、km、cm 或 mm，并明确中误差单位。'
      })
    }
  }
  const anchoredObservations = observations.map((observation, index) => SurveyObservationV1.parse({
    ...observation,
    sourceRecordId: anchors[pointCount + index]!.id,
    sourceLocator: `WorkWise JSON:network.observations[${index}]`
  }))
  return {
    knownPoints: knownPoints.map((point, index) => SurveyPointV1.parse({
      ...point,
      sourceLocator: point.sourceLocator ?? `WorkWise JSON:network.knownPoints[${index}]`
    })),
    unknownPoints: unknownPoints.map((point, index) => SurveyPointV1.parse({
      ...point,
      sourceLocator: point.sourceLocator ?? `WorkWise JSON:network.unknownPoints[${index}]`
    })),
    observations: anchoredObservations,
    instrumentParameters: network.instrumentParameters,
    observationEpoch: network.observationEpoch,
    coordinateSystem: network.coordinateSystem,
    projection: network.projection,
    ellipsoid: network.ellipsoid,
    verticalDatum: network.verticalDatum ?? network.heightDatum,
    unit: network.unit,
    linearUnitRaw: [...rawLinearUnits].sort().join(', ') || 'not-declared',
    angularUnitRaw: [...rawAngularUnits].sort().join(', ') || 'not-declared',
    canonicalUnitsVerified: coordinateUnitIsMetres && observationUnitsVerified,
    parserId: 'workwise-survey-source',
    parserVersion: String(WORKWISE_SURVEY_SOURCE_FORMAT_VERSION),
    parserSourceHash: REGISTRY_PARSER_SOURCE_HASH,
    frozenNetwork: frozenWorkwiseNetworkMetadata(network, rawNetwork),
    disposition: diagnostics.some((item) => item.severity === 'blocking') ? 'archive-only' : 'adjustment-ready',
    dispositionReason: `冻结来源合同 ${WORKWISE_SURVEY_SOURCE_FORMAT}@${WORKWISE_SURVEY_SOURCE_FORMAT_VERSION}`,
    diagnostics,
    anchors,
    summaryOverride: { recordCount: anchors.length }
  }
}

function parseFieldReviewSource(format: SurveyFormatIdV1): ParsedSource {
  return {
    knownPoints: [], unknownPoints: [], observations: [], anchors: [], unit: 'm',
    disposition: 'archive-only',
    diagnostics: [diagnostic('missing_geometry', 'blocking', `${vendorForFormat(format)} / ${format} 方言已识别，但尚无通过固定数值 fixture 验证的观测语义；原文件已保留，不能直接进入平差`)]
  }
}

/**
 * Preserve the syntactically recognized SUC source without assigning semantics
 * to any record or numeric field. The source attachment and physical anchors
 * remain the review authority until a published format contract is available.
 */
function parseSurveyCloudSuc(text: string): ParsedSource {
  const sourceRawFields: Record<string, RawField> = {}
  const anchors: SurveyRawRecordAnchorV1[] = []
  let preservedFieldCount = 0
  let preservedFieldBytes = 0
  let preservedRawFieldsTruncated = false
  for (const [index, line] of boundedLines(text).entries()) {
    if (!line.trim()) continue
    const lineNumber = index + 1
    anchors.push(anchor(lineNumber, 'SUC', 'survey-cloud-suc', `survey-cloud-suc-line-${lineNumber}`))
    // Field indices are deliberately non-semantic. Retain the original
    // delimiter segments, including padding and quote characters, instead of
    // normalizing them to values. A malformed quote is kept as one opaque raw
    // field so archival preservation never drops source bytes.
    const fields = splitSurveyCloudSucFields(line)?.map((field) => field.raw) ?? [line]
    for (const [fieldIndex, field] of fields.entries()) {
      if (preservedFieldCount >= SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_ENTRIES) {
        preservedRawFieldsTruncated = true
        break
      }
      const key = `suc.line.${lineNumber}.field.${fieldIndex + 1}`
      const value = field.slice(0, 2_000)
      const entryBytes = Buffer.byteLength(JSON.stringify({ [`source:${key}`]: value }), 'utf8')
      if (preservedFieldBytes + entryBytes > SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_BYTES) {
        preservedRawFieldsTruncated = true
        break
      }
      sourceRawFields[key] = value
      preservedFieldBytes += entryBytes
      preservedFieldCount += 1
    }
  }
  return {
    knownPoints: [],
    unknownPoints: [],
    observations: [],
    anchors,
    sourceRawFields,
    preservedRawFieldsTruncated,
    // SUC has no independently verified observation semantics yet. Its
    // archival parser must never inherit the COSA mapping gate or reference
    // another parser's local state.
    disposition: 'archive-only',
    requiresManualConfirmation: true,
    linearUnitRaw: 'not-declared',
    angularUnitRaw: 'not-declared',
    canonicalUnitsVerified: false,
    parserId: SURVEY_CLOUD_SUC_PARSER_ID,
    parserVersion: SURVEY_CLOUD_SUC_PARSER_VERSION,
    parserSourceHash: SURVEY_CLOUD_SUC_PARSER_SOURCE_HASH,
    summaryOverride: { recordCount: anchors.length },
    diagnostics: [{
      code: 'missing_geometry',
      severity: 'blocking',
      message: '测量云 SUC（F-FMT-11，P2）格式规格仍未取证；字段语义、角度/距离/高程单位及基准均未声明，未生成点位或观测，仅保留原始记录供人工确认。',
      suggestedAction: '向测量云取得 SUC 格式规格或完成受控字段映射与用户确认；在此之前不得将该文件送入平差。'
    }]
  }
}

function cosaRecordAnchor(anchor: CosaIn2RecordAnchor): SurveyRawRecordAnchorV1 {
  return SurveyRawRecordAnchorCreateV1.parse({
    id: anchor.id,
    sourceRecord: anchor.sourceRecord,
    line: anchor.line,
    byteOffset: anchor.byteOffset,
    byteLength: anchor.byteLength,
    rawOffset: anchor.rawOffset,
    rawLength: anchor.rawLength,
    rawLineNo: anchor.line,
    rawSnippet: anchor.rawSnippet,
    recordType: anchor.recordType,
    section: 'cosa-in2'
  })
}

/** Translate the isolated COSA parser result without reinterpreting its units. */
function parseCosaIn2Source(bytes: Buffer): ParsedSource {
  // Feed the original bytes to keep parser byte offsets exact. `decodeText()`
  // is intentionally not used here because a replacement/legacy decoding
  // would make an otherwise plausible source locator false.
  const catalogEntry = cosaIn2CatalogEntry()
  const parsed = parseCosaIn2(bytes)
  const directionSigmaRad = parsed.priorPrecisions.directionArcSeconds * Math.PI / (180 * 3_600)
  const distanceSigmaMetres = (distanceMetres: number) => Math.hypot(
    parsed.priorPrecisions.distanceConstantMillimetres / 1_000,
    parsed.priorPrecisions.distancePpm * 1e-6 * distanceMetres
  )
  const priorRawFields = {
    priorDirectionSigmaArcSeconds: parsed.priorPrecisions.rawValues.directionArcSeconds,
    priorDistanceConstantMillimetres: parsed.priorPrecisions.rawValues.distanceConstantMillimetres,
    priorDistancePpm: parsed.priorPrecisions.rawValues.distancePpm,
    priorDirectionSigmaUnit: 'arcsec',
    priorDistanceConstantUnit: 'mm',
    priorDistancePpmUnit: 'ppm'
  }
  const knownPoints = parsed.points.map((point) => SurveyPointV1.parse({
    id: point.id,
    pointClass: 'known',
    known: true,
    x: point.x,
    y: point.y,
    sourceRow: point.anchor.line,
    sourceLocator: `COSA.in2:${point.anchor.line}`,
    rawFields: {
      point: point.rawValues.point,
      x: point.rawValues.x,
      y: point.rawValues.y,
      recordType: point.anchor.recordType
    }
  }))
  const knownCoordinates = new Map(parsed.points.map((point) => [point.id, { x: point.x, y: point.y }]))
  const stationInitialCoordinates = new Map(parsed.stations.map((station) => {
    const targets = parsed.observations
      .filter((observation) => observation.station === station.id)
      .map((observation) => knownCoordinates.get(observation.target))
      .filter((coordinate): coordinate is NonNullable<typeof coordinate> => coordinate !== undefined)
    const distinctTargets = new Map(targets.map((coordinate) => [`${coordinate.x}:${coordinate.y}`, coordinate]))
    const controls = [...distinctTargets.values()]
    // A station remains an unknown. The centroid is only a deterministic
    // starting value for the iterative solver, derived from its fixed targets.
    const initial = controls.length >= 2
      ? {
          x: controls.reduce((sum, coordinate) => sum + Number(coordinate.x), 0) / controls.length,
          y: controls.reduce((sum, coordinate) => sum + Number(coordinate.y), 0) / controls.length
        }
      : undefined
    return [station.id, initial] as const
  }))
  const stationPoints = parsed.stations.map((station) => SurveyPointV1.parse({
    id: station.id,
    pointClass: 'station',
    known: false,
    ...(stationInitialCoordinates.get(station.id) ?? {}),
    sourceRow: station.anchor.line,
    sourceLocator: `COSA.in2:${station.anchor.line}`,
    rawFields: {
      station: station.rawValue,
      recordType: station.anchor.recordType,
      ...(stationInitialCoordinates.get(station.id) ? { initialCoordinateMethod: 'known-target-centroid' } : {})
    }
  }))
  const pointIds = new Set([...parsed.points, ...parsed.stations].map((point) => point.id))
  const targetPoints = [...new Set(parsed.observations.map((observation) => observation.target))]
    .filter((id) => !pointIds.has(id))
    .map((id) => {
      const firstObservation = parsed.observations.find((observation) => observation.target === id)!
      return SurveyPointV1.parse({
        id,
        pointClass: 'unknown',
        known: false,
        sourceRow: firstObservation.sourceLine,
        sourceLocator: `COSA.in2:${firstObservation.sourceLine}`,
        rawFields: {
          role: 'target',
          sourceRecordId: firstObservation.sourceRecordId,
          initialCoordinateRequired: true
        }
      })
    })
  const distanceInitializationEdges = parsed.observations
    .filter((observation): observation is Extract<typeof observation, { type: 'distance' }> => observation.type === 'distance' && observation.value > 0)
    .map((observation) => ({ from: observation.station, to: observation.target, distance: observation.value }))
  const initialPoints = [...knownPoints, ...stationPoints, ...targetPoints].map((point) => ({
    id: point.id, fixed: point.known, x: point.x, y: point.y
  }))
  const polarInitialization = initializeCosaDirectionDistanceNetwork(
    initialPoints,
    distanceInitializationEdges,
    parsed.observations
      .filter((observation): observation is Extract<typeof observation, { type: 'direction' }> => observation.type === 'direction')
      .map((observation) => ({ station: observation.station, target: observation.target, radians: observation.value }))
  )
  const distanceInitialization = polarInitialization.unresolvedPointIds.length
    ? initializeCosaDistanceNetwork(initialPoints.map((point) => ({ ...point, ...polarInitialization.initialCoordinates.get(point.id) })), distanceInitializationEdges)
    : undefined
  const unknownPoints = [...stationPoints, ...targetPoints].map((point) => {
    const coordinateInitialization = polarInitialization.initialCoordinates.has(point.id) ? polarInitialization : distanceInitialization
    const initial = coordinateInitialization?.initialCoordinates.get(point.id)
    if (!initial) return point
    return SurveyPointV1.parse({
      ...point,
      x: initial.x,
      y: initial.y,
      rawFields: {
        ...point.rawFields,
        initialCoordinateMethod: coordinateInitialization === polarInitialization
          ? 'cosa-station-polar-rigid-initialization'
          : 'cosa-distance-network-stress-initialization',
        ...(coordinateInitialization?.rmsMetres == null ? {} : { initialCoordinateDistanceRmsMetres: coordinateInitialization.rmsMetres })
      }
    })
  })
  const observations = parsed.observations.map((observation) => {
    const common = {
      from: observation.station,
      to: observation.target,
      station: observation.station,
      target: observation.target,
      value: observation.value,
      unit: observation.unit,
      correctionState: EMPTY_SURVEY_CORRECTION_STATE,
      sourceRow: observation.sourceLine,
      sourceLocator: `COSA.in2:${observation.sourceLine}`,
      sourceRecordId: observation.sourceRecordId,
      rawFields: {
        target: observation.rawValues.target,
        code: observation.rawValues.code,
        value: observation.rawValues.value,
        record: observation.rawValues.record,
        rawUnit: observation.rawUnit,
        ...priorRawFields,
        ...(observation.type === 'direction'
          ? { role: observation.role, directionReference: 'cosa-station-circle', stationCircleOrientation: true, coordinateAxisOrder: 'north-east' }
          : {})
      }
    }
    if (observation.type === 'direction') {
      return SurveyObservationV1.parse({
        id: observation.id,
        type: 'direction',
        ...common,
        ...(directionSigmaRad > 0 ? { sigma: directionSigmaRad, sigmaUnit: 'rad' } : { qualityFlags: ['cosa-zero-direction-prior-sigma'] }),
        ...(observation.role === 'backsight-reset' ? { qualityFlags: [...(directionSigmaRad > 0 ? [] : ['cosa-zero-direction-prior-sigma']), 'cosa-backsight-reset'] } : {})
      })
    }
    const sigma = distanceSigmaMetres(observation.value)
    return SurveyObservationV1.parse({
      id: observation.id,
      type: 'distance',
      ...common,
      ...(sigma > 0 ? { sigma, sigmaUnit: 'm' } : { qualityFlags: ['cosa-zero-distance-prior-sigma'] })
    })
  })
  // The isolated parser retains blank physical separators so it can keep the
  // original COSA station grammar intact. SourceFile record anchors, however,
  // are immutable evidence records and require a non-empty byte range. A
  // separator has no source value to audit, so publish only semantic COSA
  // records rather than inventing a range over its line terminator.
  const semanticRecordAnchors = parsed.recordAnchors.filter((anchor) => anchor.recordType !== 'blank')
  return {
    knownPoints,
    unknownPoints,
    observations,
    anchors: semanticRecordAnchors.map(cosaRecordAnchor),
    diagnostics: [...(directionSigmaRad === 0 || (parsed.priorPrecisions.distanceConstantMillimetres === 0 && parsed.priorPrecisions.distancePpm === 0)
      ? [{
        code: 'invalid_record' as const,
        severity: 'warning' as const,
        message: 'COSA .in2 先验精度中存在零值，已保留原始值但未将零标准差写入统一观测模型。',
        suggestedAction: '请确认方向和距离先验精度为正值后再进行任何平差验收。'
      }]
      : [])],
    linearUnitRaw: 'm',
    angularUnitRaw: 'cosa-degree-dot-mmss',
    parserId: catalogEntry.parserId,
    parserVersion: catalogEntry.parserVersion,
    parserSourceHash: COSA_IN2_PARSER_SOURCE_HASH,
    summaryOverride: { ...parsed.summary, recordCount: semanticRecordAnchors.length },
    sourceRawFields: {
      'cosa-in2:coordinate-axis-order': 'north-east',
      'cosa-in2:prior-direction-arc-seconds': parsed.priorPrecisions.rawValues.directionArcSeconds,
      'cosa-in2:prior-distance-constant-millimetres': parsed.priorPrecisions.rawValues.distanceConstantMillimetres,
      'cosa-in2:prior-distance-ppm': parsed.priorPrecisions.rawValues.distancePpm
    }
  }
}

function cosaIn2ParseFailure(error: CosaIn2ParseError, bytes: Buffer): ParsedSource {
  const anchor = error.recordAnchor.rawLength > 0
    ? cosaRecordAnchor(error.recordAnchor)
    : bytes.length > 0
      ? SurveyRawRecordAnchorCreateV1.parse({
        id: error.recordAnchor.id,
        sourceRecord: error.recordAnchor.sourceRecord,
        line: error.recordAnchor.line,
        byteOffset: 0,
        byteLength: bytes.length,
        rawOffset: 0,
        rawLength: bytes.length,
        rawLineNo: error.recordAnchor.line,
        rawSnippet: rawByteSnippet(bytes, 0, bytes.length),
        recordType: error.recordAnchor.recordType,
        section: 'cosa-in2'
      })
      : undefined
  return {
    knownPoints: [],
    unknownPoints: [],
    observations: [],
    anchors: anchor ? [anchor] : [],
    disposition: 'archive-only',
    linearUnitRaw: 'm',
    angularUnitRaw: 'cosa-degree-dot-mmss',
    parserId: COSA_IN2_PARSER_ID,
    parserVersion: COSA_IN2_PARSER_VERSION,
    parserSourceHash: COSA_IN2_PARSER_SOURCE_HASH,
    diagnostics: [{
      code: error.code === 'limit-exceeded' ? 'limit_exceeded' : 'invalid_record',
      severity: 'blocking',
      message: `COSA .in2 解析失败（${error.code}）：第 ${error.line} 行、第 ${error.column} 列应为 ${error.expected}`,
      sourceRecord: error.recordAnchor.sourceRecord,
      byteOffset: anchor?.byteOffset ?? error.recordAnchor.byteOffset,
      ...(anchor ? { recordAnchor: anchor.id } : {}),
      suggestedAction: error.suggestedAction
    }]
  }
}

function cosaIn1Anchor(anchorValue: ReturnType<typeof parseCosaIn1>['recordAnchors'][number]): SurveyRawRecordAnchorV1 {
  return SurveyRawRecordAnchorCreateV1.parse({
    id: anchorValue.id,
    sourceRecord: anchorValue.sourceRecord,
    line: anchorValue.line,
    byteOffset: anchorValue.byteOffset,
    byteLength: anchorValue.byteLength,
    rawOffset: anchorValue.rawOffset,
    rawLength: anchorValue.rawLength,
    rawLineNo: anchorValue.line,
    rawSnippet: anchorValue.rawSnippet,
    recordType: anchorValue.recordType,
    section: 'cosa-in1'
  })
}

function parseCosaIn1Source(bytes: Buffer, mapping?: CosaIn1Mapping): ParsedSource {
  const parsed = parseCosaIn1(bytes, mapping)
  const anchors = parsed.recordAnchors.filter((item) => item.byteLength > 0).map(cosaIn1Anchor)
  const diagnostics = parsed.diagnostics.map((item) => ({
    code: item.code === 'mapping-required' ? 'mapping_required' as const : item.code === 'limit-exceeded' ? 'limit_exceeded' as const : item.code === 'empty-source' ? 'missing_geometry' as const : 'invalid_record' as const,
    severity: 'blocking' as const,
    message: item.message,
    suggestedAction: item.suggestedAction,
    sourceRecord: item.recordAnchor.sourceRecord,
    byteOffset: item.recordAnchor.byteOffset,
    ...(anchors.some((record) => record.id === item.recordAnchor.id) ? { recordAnchor: item.recordAnchor.id } : {})
  }))
  if (!mapping) diagnostics.push({ code: 'missing_geometry', severity: 'blocking', message: 'COSA .in1 has no confirmed section mapping; no observations were generated.', suggestedAction: 'Select a saved section mapping with explicit units.', sourceRecord: 1, byteOffset: 0 })
  const knownPoints = parsed.knownPoints.map((point) => SurveyPointV1.parse({
    id: point.id,
    pointClass: 'known',
    known: true,
    height: point.height,
    sourceRow: point.recordAnchor.line,
    sourceLocator: `COSA.in1:${point.recordAnchor.line}`,
    rawFields: { point: point.rawValues.point, height: point.rawValues.height, recordType: point.recordAnchor.recordType }
  }))
  const observationPoints = parsed.observations.flatMap((observation) => [
    SurveyPointV1.parse({ id: observation.from, pointClass: 'station', known: false, sourceRow: observation.recordAnchor.line, sourceLocator: `COSA.in1:${observation.recordAnchor.line}`, rawFields: { role: 'station' } }),
    SurveyPointV1.parse({ id: observation.to, pointClass: 'unknown', known: false, sourceRow: observation.recordAnchor.line, sourceLocator: `COSA.in1:${observation.recordAnchor.line}`, rawFields: { role: 'target' } })
  ])
  const observations = parsed.observations.map((observation) => SurveyObservationV1.parse({
    id: observation.id,
    type: 'height-difference',
    from: observation.from,
    to: observation.to,
    value: observation.value,
    unit: 'm',
    routeLength: observation.routeLengthKm * 1_000,
    sourceRow: observation.recordAnchor.line,
    sourceLocator: `COSA.in1:${observation.recordAnchor.line}`,
    sourceRecordId: observation.recordAnchor.id,
    rawFields: { from: observation.rawValues.from, to: observation.rawValues.to, value: observation.rawValues.value, routeLength: observation.rawValues.routeLengthKm, routeLengthUnit: 'km', heightDifferenceUnit: 'm' }
  }))
  const classified = classifyPoints([...knownPoints, ...observationPoints])
  return {
    ...classified,
    observations,
    anchors,
    diagnostics,
    disposition: parsed.state === 'valid' && mapping ? 'adjustment-ready' : 'archive-only',
    requiresManualConfirmation: !(parsed.state === 'valid' && mapping),
    linearUnitRaw: mapping ? 'm; routeLength=km' : 'not-declared',
    angularUnitRaw: 'not-applicable',
    canonicalUnitsVerified: parsed.state === 'valid',
    parserId: COSA_IN1_PARSER_ID,
    parserVersion: COSA_IN1_PARSER_VERSION,
    parserSourceHash: COSA_IN1_PARSER_SOURCE_HASH,
    sourceRawFields: parsed.mapping ? { 'cosa-in1.mapping': JSON.stringify(parsed.mapping) } : {},
    summaryOverride: { pointCount: classified.knownPoints.length + classified.unknownPoints.length, observationCount: observations.length, recordCount: anchors.length },
    dispositionReason: parsed.state === 'valid' && mapping
      ? 'COSA .in1 已按显式保存的分区映射解析并完成单位确认；仍须通过基准、拓扑、闭合和精度校验。'
      : 'COSA .in1 必须使用显式保存的分区映射；缺失或无效映射、或解析失败的来源只能归档。'
  }
}

/** P0 names with no verified semantic mapping may be retained, never guessed. */
function parseSafeExtensionFallbackSource(format: SurveyFormatIdV1): ParsedSource {
  return {
    knownPoints: [],
    unknownPoints: [],
    observations: [],
    anchors: [],
    disposition: 'archive-only',
    diagnostics: [{
      code: 'missing_geometry',
      severity: 'blocking',
      message: `${vendorForFormat(format)} / ${format} 仅由文件扩展名低置信度识别；尚无经 fixture 验证的字段映射，原文件只能归档，不能猜测为通用表格或进入平差`,
      suggestedAction: '请在预检中人工确认格式，并提供经过验证的字段映射或使用受支持的导出格式后重新导入。'
    }]
  }
}

function parseDetected(format: SurveyFormatIdV1, bytes: Buffer, text: TextResult | null, cosaIn1Mapping?: CosaIn1Mapping): ParsedSource {
  if (format === 'workwise-json') return parseWorkwiseSurveySource(text!, bytes)
  if (format === 'cosa-in1') return parseCosaIn1Source(bytes, cosaIn1Mapping)
  if (format === 'cosa-in2') return parseCosaIn2Source(bytes)
  if (format === 'survey-cloud-suc') return parseSurveyCloudSuc(text!.text)
  if (format === 'south-dat') return parseSouthDat(text!.text)
  if (SAFE_EXTENSION_FALLBACK_FORMATS.has(format)) return parseSafeExtensionFallbackSource(format)
  if (format === 'leica-gsi8' || format === 'leica-gsi16') return parseLeicaGsi(text!.text, format, bytes)
  if (format === 'leica-hexml' || format === 'trimble-jobxml' || format === 'landxml') return parseSurveyXml(text!.text, format)
  if (format === 'trimble-m5') return parseM5(text!.text)
  if (format === 'tds-raw' || format === 'carlson-rw5') return parseRawRw5(text!.text, format)
  if (format === 'sokkia-sdr') return parseSdr(text!.text)
  if (format.startsWith('rinex-') || format === 'hatanaka-rinex') return parseRinex(text!.text, format)
  if (format === 'sinex') return parseSinex(text!.text)
  if (format === 'nmea-0183') return parseNmea(text!.text)
  if (format === 'rtcm2' || format === 'rtcm3') return parseRtcm(bytes, format)
  if (GNSS_STREAM_FORMATS.has(format)) return parseGnssProfessionalSource(bytes, format, text?.text)
  if (CONVERTER_FORMATS.has(format)) return parseConverterSource(format)
  if (FIELD_REVIEW_FORMATS.has(format)) return parseFieldReviewSource(format)
  return { knownPoints: [], unknownPoints: [], observations: [], disposition: sourceDisposition(format), diagnostics: [], anchors: [] }
}

export class SurveyFormatRegistry {
  constructor(private readonly converters = new SurveyConverterRegistry(BUNDLED_SURVEY_CONVERTERS, new MacOsSandboxedSurveyConverterExecutor())) {}

  async ingest(input: SurveyFormatInput): Promise<SurveySourceEnvelope> {
    return await this.ingestInternal(input, true)
  }

  private async ingestInternal(input: SurveyFormatInput, allowConverter: boolean): Promise<SurveySourceEnvelope> {
    const originalHash = sha256(input.bytes)
    let unpacked: UnwrappedSurveySource
    let unwrapBlocked = false
    try {
      unpacked = await unwrap(input.name, input.bytes)
    } catch (error) {
      unwrapBlocked = true
      const parseError = error instanceof SurveySourceParseError ? error : new SurveySourceParseError('unsafe_archive', error instanceof Error ? error.message : String(error))
      unpacked = {
        name: input.name,
        bytes: input.bytes.subarray(0, 128 * 1024),
        diagnostics: [diagnostic(parseError.code, 'blocking', parseError.message)],
        byteSpace: 'original-attachment'
      }
    }
    const binary = looksBinary(unpacked.bytes)
    const text = binary ? null : decodeText(unpacked.bytes)
    let detected: Detection
    if (extension(unpacked.name) === '.xlsx' && unpacked.bytes[0] === 0x50 && unpacked.bytes[1] === 0x4b) detected = { format: 'xlsx', vendor: 'Microsoft/OpenXML', confidence: 1, signatures: ['OOXML ZIP container'] }
    else detected = (binary ? detectBinary(unpacked.name, unpacked.bytes) : null) ?? detectText(unpacked.name, text?.text ?? '')
    let detection = detectionWithExtension(unpacked.name, detected)
    let parseBlocked = false
    let parsed: ParsedSource
    if (unpacked.byteSpace === 'container-member') {
      // The frozen SourceFile contract anchors records against the original
      // attachment. A decompressed member has a different byte address space,
      // so retain it for review rather than publishing false source anchors.
      // This restriction intentionally applies to every parser, not only COSA:
      // a source is not auditable if its observation locators address bytes that
      // the persisted source record cannot identify.
      parseBlocked = true
      parsed = {
        knownPoints: [],
        unknownPoints: [],
        observations: [],
        disposition: 'archive-only',
        diagnostics: [{
          code: 'unsafe_archive',
          severity: 'blocking',
          message: `${detection.format} 位于解压后的成员字节流中；当前 SourceFile 契约只能锚定原始附件，不能安全发布成员内偏移。`,
          suggestedAction: '请先以未压缩原文件导入；待容器成员来源、哈希和偏移契约明确后再启用压缩成员解析。'
        }],
        anchors: []
      }
    } else {
      try {
        parsed = parsedWithinLimits(parseDetected(detection.format, unpacked.bytes, text, input.cosaIn1Mapping))
      } catch (error) {
        parseBlocked = true
        if (isCosaIn2ParseError(error)) {
          parsed = cosaIn2ParseFailure(error, unpacked.bytes)
        } else {
          const parseError = error instanceof SurveySourceParseError ? error : new SurveySourceParseError('invalid_record', error instanceof Error ? error.message : String(error))
          parsed = { knownPoints: [], unknownPoints: [], observations: [], disposition: 'archive-only', diagnostics: [diagnostic(parseError.code, 'blocking', parseError.message)], anchors: [] }
        }
      }
    }
    // COSA .in1 has no stable magic header. An explicit caller-saved mapping
    // plus a successful strict section parse is therefore its bounded
    // structural proof; a suffix alone remains archive-only.
    if (
      detection.format === 'cosa-in1' &&
      detection.method === 'extension-fallback' &&
      input.cosaIn1Mapping &&
      parsed.parserId === COSA_IN1_PARSER_ID &&
      parsed.canonicalUnitsVerified === true &&
      parsed.observations.length > 0 &&
      !(parsed.diagnostics ?? []).some((item) => item.severity === 'blocking')
    ) {
      detection = SurveyFormatDetectionV1.parse({
        ...detection,
        confidence: 0.98,
        method: 'structural-probe',
        matchedSignatures: [...detection.matchedSignatures, 'COSA .in1 explicit mapping + strict section parse'].slice(0, 20)
      })
    }
    const highConfidenceContentEvidence = detection.confidence >= HIGH_CONFIDENCE_CONTENT_CONFLICT_MINIMUM && (detection.method === 'content-signature' || detection.method === 'structural-probe')
    const contentWinsExtensionConflict = detection.extensionConflict && highConfidenceContentEvidence
    const baseDiagnostics = [
      ...unpacked.diagnostics,
      ...(text ? [diagnostic('encoding_detected', 'info', `文本编码 ${text.encoding}`, undefined, `Text encoding: ${text.encoding}`)] : []),
      diagnostic('format_detected', 'info', `识别为 ${detection.vendor} / ${detection.format}${detection.version ? ` ${detection.version}` : ''}，置信度 ${Math.round(detection.confidence * 100)}%`, undefined, `Detected ${detection.format}${detection.version ? ` ${detection.version}` : ''}; confidence ${Math.round(detection.confidence * 100)}%`),
      ...(detection.extensionConflict ? [diagnostic(
        'format_conflict',
        contentWinsExtensionConflict ? 'warning' : 'blocking',
        `文件后缀为 ${detection.extension || '（无）'}，实际${detection.method === 'structural-probe' ? '结构' : '内容'}识别为 ${detection.format}${contentWinsExtensionConflict ? '；已按高置信内容优先处理' : '；低置信或未解析冲突已阻断'}`
      )] : []),
      ...(detection.format === 'unknown' ? [diagnostic('unknown_format', 'blocking', '无法通过内容签名安全识别测量文件；不会回退为通用 CSV')] : []),
      ...(parsed.diagnostics ?? [])
    ]
    const hardArchive = unwrapBlocked || parseBlocked || (detection.extensionConflict && !contentWinsExtensionConflict) || detection.format === 'unknown'
    // A parser may explicitly impose a stricter disposition for an otherwise
    // recognized P0 source. It can never grant one beyond the catalogue, but
    // its restriction must survive a later catalogue promotion.
    const parserCapabilityRestricted = parsed.disposition !== undefined && parsed.disposition !== 'adjustment-ready'
    const p0Policy = p0CatalogRuntimePolicy(detection.format, {
      safetyBlocked: hardArchive || (parsed.diagnostics ?? []).some((diagnostic) => diagnostic.severity === 'blocking'),
      parserCapabilityRestricted,
      hasAuditableParse: parsed.observations.length > 0 || parsed.knownPoints.length > 0 || parsed.unknownPoints.length > 0
    })
    const nonP0Policy = p0Policy ? undefined : nonP0RuntimePolicy(detection.format, {
      hardArchive,
      parserDisposition: parsed.disposition,
      hasAuditableParse: parsed.observations.length > 0 || parsed.knownPoints.length > 0 || parsed.unknownPoints.length > 0
    })
    const retainedRawFields = preservedRawFields(parsed)
    const rawFieldRetentionWarning = parsed.preservedRawFieldsTruncated || retainedRawFields.truncationReasons.length > 0
      ? [preservedRawFieldsLimitDiagnostic()]
      : []
    const diagnostics = [...baseDiagnostics, ...(p0Policy ? [p0Policy.diagnostic] : []), ...(nonP0Policy ? [nonP0Policy.diagnostic] : []), ...rawFieldRetentionWarning]
    const resolvedDisposition: SurveyImportDispositionV1 = hardArchive
      ? 'archive-only'
      : p0Policy?.disposition ?? nonP0Policy?.disposition ?? parsed.disposition ?? sourceDisposition(detection.format)
    const records = completeRawRecordAnchors(parsed.anchors ?? [], unpacked.bytes, text)
    const summary = sourceSummary(parsed, records, diagnostics)
    const sourceUnitMetadata = sourceUnits(parsed)
    const hasUnverifiedCanonicalUnits = parsed.unit === 'landxml-unit-unverified' || parsed.canonicalUnitsVerified === false
    let sourceFile = SurveySourceFileCreateV1.parse({
      schemaVersion: 1,
      sourcePath: `attachment://sha256/${originalHash}/${encodeURIComponent(input.name)}`,
      name: input.name,
      size: input.bytes.length,
      fileSize: input.bytes.length,
      sha256: originalHash,
      importedAt: new Date().toISOString(),
      importedBy: REGISTRY_IMPORTER_ID,
      originalPreserved: true,
      formatId: detection.format,
      vendor: detection.vendor,
      formatVersion: detection.version ?? null,
      detectionMethod: detection.method,
      detectionConfidence: detection.confidence,
      extensionClaimed: detection.extension ?? null,
      extensionContentConflict: detection.extensionConflict,
      requiresManualConfirmation: detection.method === 'extension-fallback' || parsed.requiresManualConfirmation === true || p0Policy?.requiresManualConfirmation === true || nonP0Policy?.requiresManualConfirmation === true,
      detection,
      disposition: resolvedDisposition,
      ...(p0Policy?.dispositionReasonEn ? { dispositionReasonEn: p0Policy.dispositionReasonEn } : {}),
      dispositionReason: p0Policy?.dispositionReason ?? nonP0Policy?.dispositionReason ?? parsed.dispositionReason ?? dispositionReason(resolvedDisposition, detection, diagnostics),
      parserId: parsed.parserId ?? 'survey-format-registry',
      parserVersion: parsed.parserVersion ?? REGISTRY_VERSION,
      parserSourceHash: parsed.parserSourceHash ?? REGISTRY_PARSER_SOURCE_HASH,
      ...sourceUnitMetadata,
      // An archive-only LandXML parse preserves its raw Units declaration
      // without claiming that values were converted to m/rad.
      linearUnitCanonical: hasUnverifiedCanonicalUnits ? 'unverified' : 'm',
      angularUnitCanonical: hasUnverifiedCanonicalUnits ? 'unverified' : 'rad',
      datumDeclared: parsed.coordinateSystem ?? null,
      heightSystemDeclared: parsed.verticalDatum ?? null,
      recordCount: summary.recordCount,
      summary,
      diagnostics,
      records,
      rawRecordAnchors: records,
      preservedRawFields: retainedRawFields.fields
    })
    if (allowConverter && originalHash === sha256(unpacked.bytes) && resolvedDisposition === 'converter-required' && !unwrapBlocked && !parseBlocked && (!detection.extensionConflict || contentWinsExtensionConflict) && this.converters.has(detection.format)) {
      const conversion = await this.converters.convert(detection.format, unpacked.name, unpacked.bytes, input.signal)
      if (conversion) {
        if (!conversion.ok || !conversion.outputBytes || !conversion.outputName || !conversion.outputFormat) {
          sourceFile = SurveySourceFileCreateV1.parse({
            ...sourceFile,
            diagnostics: [...sourceFile.diagnostics, conversion.diagnostic],
            converter: conversion.provenance,
            converterId: conversion.provenance.id,
            converterVersion: conversion.provenance.version,
            converterBinaryHash: conversion.provenance.executableHash
          })
        } else {
          const converted = await this.ingestInternal({ ...input, name: conversion.outputName, bytes: conversion.outputBytes }, false)
          if (converted.sourceFile.detection.format !== conversion.outputFormat) {
            const blockedProvenance = SurveyConverterProvenanceV1.parse({ ...conversion.provenance, status: 'blocked' })
            sourceFile = SurveySourceFileCreateV1.parse({
              ...sourceFile,
              diagnostics: [...sourceFile.diagnostics, diagnostic('converter_required', 'blocking', `转换器声明输出 ${conversion.outputFormat}，但内容签名识别为 ${converted.sourceFile.detection.format}`)],
              converter: blockedProvenance,
              converterId: blockedProvenance.id,
              converterVersion: blockedProvenance.version,
              converterBinaryHash: blockedProvenance.executableHash
            })
          } else {
            const conversionInput = {
              sourcePath: sourceFile.sourcePath,
              name: sourceFile.name,
              size: sourceFile.size,
              fileSize: sourceFile.fileSize,
              sha256: sourceFile.sha256,
              originalPreserved: true as const,
              formatId: sourceFile.formatId,
              vendor: sourceFile.vendor,
              formatVersion: sourceFile.formatVersion,
              detectionMethod: sourceFile.detectionMethod,
              detectionConfidence: sourceFile.detectionConfidence,
              extensionClaimed: sourceFile.extensionClaimed,
              extensionContentConflict: sourceFile.extensionContentConflict,
              detection: sourceFile.detection
            }
            const convertedSourceFile = SurveySourceFileCreateV1.parse({
              ...converted.sourceFile,
              diagnostics: [...converted.sourceFile.diagnostics, conversion.diagnostic],
              converter: conversion.provenance,
              converterId: conversion.provenance.id,
              converterVersion: conversion.provenance.version,
              converterBinaryHash: conversion.provenance.executableHash,
              conversionInput
            })
            // The converted bytes are the active parser source. The original
            // is carried separately so no raw record anchor can falsely point
            // into an opaque vendor file.
            return {
              ...converted,
              sourceFile: convertedSourceFile,
              originalSourceFile: sourceFile,
              originalBytes: unpacked.bytes
            }
          }
        }
      }
    }
    return { ...parsed, effectiveName: unpacked.name, effectiveBytes: unpacked.bytes, ...(text ? { effectiveText: text.text } : {}), sourceFile }
  }
}

export const SURVEY_FORMAT_LIMITS = {
  detectionProbeBytes: DETECTION_PROBE_BYTES,
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxUnwrappedBytes: MAX_UNWRAPPED_BYTES,
  maxArchiveRatio: MAX_ARCHIVE_RATIO,
  maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
  maxOoxmlEntries: MAX_OOXML_ENTRIES,
  maxTextLines: MAX_TEXT_LINES,
  maxRecordAnchors: MAX_RECORD_ANCHORS,
  maxParsedPoints: MAX_PARSED_POINTS,
  maxParsedObservations: MAX_PARSED_OBSERVATIONS,
  maxRawFieldsBytes: MAX_RAW_FIELDS_BYTES,
  maxPreservedRawFieldEntries: SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_ENTRIES,
  maxPreservedRawFieldBytes: SURVEY_SOURCE_MAX_PRESERVED_RAW_FIELD_BYTES,
  maxXmlDepth: MAX_XML_DEPTH,
  maxXmlTags: MAX_XML_TAGS
} as const
