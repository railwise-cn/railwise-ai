import {
  SurveyImportDiagnosticV1,
  type SurveyImportDiagnosticV1 as SurveyImportDiagnostic
} from '../contracts/survey.js'

/**
 * Versioned, internal presentation and recovery policy for import diagnostics.
 *
 * This catalogue deliberately contains stable, code-owned bilingual copy.
 * Parser input (including raw source text) is never interpolated into a title,
 * message, or suggested action.  Callers may attach an opaque record locator
 * through `SurveyImportDiagnosticAnchorContextV1`, but it is not treated as an
 * instruction or as replacement diagnostic copy.
 */
export const SURVEY_IMPORT_DIAGNOSTIC_CATALOG_VERSION = 'workwise-survey-import-diagnostics-1.2.0' as const

export type SurveyImportDiagnosticCodeV1 = SurveyImportDiagnostic['code']
export type SurveyImportDiagnosticSeverityV1 = SurveyImportDiagnostic['severity']

export type SurveyImportDiagnosticAnchorContextV1 = Readonly<Pick<
  SurveyImportDiagnostic,
  'sourceRecord' | 'byteOffset' | 'recordAnchor'
>>

export type SurveyImportDiagnosticDefinitionV1 = Readonly<{
  /** Stable internal identifier, separate from the contract's machine code. */
  id: string
  code: SurveyImportDiagnosticCodeV1
  /** Default severity used by `createSurveyImportDiagnostic`; contextual emitters may be stricter. */
  severity: SurveyImportDiagnosticSeverityV1
  /** Short Chinese label for compact preflight and diagnostic views. */
  title: string
  english: Readonly<{ title: string; message: string; suggestedAction: string }>
  /** Stable Chinese explanation that contains no source-file content. */
  message: string
  /** A concrete next step; never an "unknown error" fallback. */
  suggestedAction: string
}>

export type SurveyImportDiagnosticDefinitionFor<Code extends SurveyImportDiagnosticCodeV1> = Readonly<
  Omit<SurveyImportDiagnosticDefinitionV1, 'id' | 'code'> & {
    id: `survey-import/${Code}`
    code: Code
  }
>

const englishDefinitions = {
  "format_detected": {
    "title": "Format recognized",
    "message": "The bounded detector recognized the format. Source records, diagnostics and disposition still determine whether it can be used for computation.",
    "suggestedAction": "Check vendor, format and version, then continue import preflight."
  },
  "format_conflict": {
    "title": "Extension/content conflict",
    "message": "The filename extension conflicts with recognized content or structure. Measurement data cannot be interpreted from the extension alone.",
    "suggestedAction": "Check the source and filename. Import using the recognized format or supply the original file without renaming."
  },
  "unknown_format": {
    "title": "Format not safely recognized",
    "message": "The bounded detector cannot safely identify this survey source. It will not fall back to a generic table reader.",
    "suggestedAction": "Keep the original and provide vendor format documentation, export details or audited conversion results."
  },
  "invalid_record": {
    "title": "Invalid record",
    "message": "A record violates the format grammar, field types or structural constraints and cannot produce a trustworthy observation.",
    "suggestedAction": "Use the raw-record anchor to inspect and correct the record. Preserve the original and reimport."
  },
  "record_ignored": {
    "title": "Record excluded from observations",
    "message": "Some records were not admitted to normalized observations. Original files and record locations remain available for review.",
    "suggestedAction": "Inspect the record anchor and parsing reason. Supply missing fields or confirm that exclusion is appropriate."
  },
  "limit_exceeded": {
    "title": "Processing limit exceeded",
    "message": "File size, expanded container size, record count or parsing complexity exceeded a safety limit. Parsing stopped.",
    "suggestedAction": "Split the source at traceable boundaries or reduce the container size. Preserve provenance for every part before reimporting."
  },
  "unsafe_archive": {
    "title": "Unsafe archive",
    "message": "The archive has unsafe structure, paths, expansion ratio or member provenance. Its measurement records cannot be admitted safely.",
    "suggestedAction": "Supply an unencrypted archive without path traversal containing only traceable survey sources, or import the uncompressed originals."
  },
  "encoding_detected": {
    "title": "Text encoding detected",
    "message": "Encoding detection supports safe decoding; it does not confirm format, units or record semantics.",
    "suggestedAction": "Check vendor export encoding and displayed characters. Re-export using the correct encoding if text is corrupted."
  },
  "gnss_processing_required": {
    "title": "GNSS post-processing required",
    "message": "This source lacks a traceable datum, three-dimensional baseline vectors or complete covariance and cannot enter baseline adjustment.",
    "suggestedAction": "Generate baseline results with a fixed datum and complete covariance using an appropriate GNSS post-processing workflow, then import."
  },
  "converter_required": {
    "title": "Audited converter required",
    "message": "This proprietary or opaque format requires an allowed local converter. Extension-based guesses cannot replace parsing.",
    "suggestedAction": "Select an audited local converter and verify its license, version, executable hash and input/output provenance."
  },
  "missing_geometry": {
    "title": "Network geometry missing",
    "message": "Stations, targets, connections or observation geometry needed to construct and validate the network are missing.",
    "suggestedAction": "Supply stations, targets and observation connections consistent with the original field records, then reimport."
  },
  "missing_datum": {
    "title": "Datum missing",
    "message": "The source does not declare or fix the required coordinate, height or GNSS datum. A traceable reference frame is unavailable.",
    "suggestedAction": "Provide confirmed coordinate and height datums plus fixed control points or equivalent datum constraints, then validate again."
  },
  "missing_covariance": {
    "title": "Covariance missing",
    "message": "The source lacks covariance or equivalent precision information needed for the stochastic model, weights and uncertainties.",
    "suggestedAction": "Supply complete covariance or a confirmed equivalent precision model, preserving its source and unit declarations, then reimport."
  },
  "mapping_required": {
    "title": "Confirmed field mapping required",
    "message": "The CSV/XLSX network has no traceable column mapping, linear units, angular format or filter rules. Table content cannot directly become adjustment observations.",
    "suggestedAction": "Confirm columns, units, angular format and filters in the F-FMT-10 mapping workflow. Save the mapping and preserve the original before reimporting."
  }
} as const satisfies Record<SurveyImportDiagnosticCodeV1, { title: string; message: string; suggestedAction: string }>

function diagnosticDefinition<Code extends SurveyImportDiagnosticCodeV1>(
  code: Code,
  severity: SurveyImportDiagnosticSeverityV1,
  title: string,
  message: string,
  suggestedAction: string
): SurveyImportDiagnosticDefinitionFor<Code> {
  return Object.freeze({
    id: `survey-import/${code}` as `survey-import/${Code}`,
    code,
    severity,
    title,
    english: Object.freeze(englishDefinitions[code]),
    message,
    suggestedAction
  })
}

/**
 * This literal list is intentionally checked against the contract union at
 * compile time and against the Zod enum at runtime.  Adding a new contract
 * code therefore cannot silently omit its Chinese recovery guidance.
 */
const declaredDiagnosticCodes = [
  'format_detected',
  'format_conflict',
  'unknown_format',
  'invalid_record',
  'record_ignored',
  'limit_exceeded',
  'unsafe_archive',
  'encoding_detected',
  'gnss_processing_required',
  'converter_required',
  'missing_geometry',
  'missing_datum',
  'missing_covariance',
  'mapping_required'
] as const satisfies readonly SurveyImportDiagnosticCodeV1[]

export const SURVEY_IMPORT_DIAGNOSTIC_CODES = Object.freeze(declaredDiagnosticCodes)

const catalogDefinitions = {
  format_detected: diagnosticDefinition(
    'format_detected',
    'info',
    '格式已识别',
    '已在受限检测范围内识别出文件格式；仍需以来源记录、解析诊断和导入处置确认是否可用于后续计算。',
    '核对厂商、格式和版本信息；确认无误后继续执行导入预检。'
  ),
  format_conflict: diagnosticDefinition(
    'format_conflict',
    'blocking',
    '扩展名与内容不一致',
    '文件扩展名与内容或结构识别结果不一致，系统不能仅根据扩展名解释测量数据。',
    '核对原始文件来源和文件名；使用识别出的格式重新导入，或提供未改名的原始文件。'
  ),
  unknown_format: diagnosticDefinition(
    'unknown_format',
    'blocking',
    '格式无法安全识别',
    '当前受限检测范围内无法安全识别该测量源文件，系统不会把它回退为通用表格读取。',
    '保留原文件，并提供厂商格式说明、导出方式或经审计的转换结果后再处理。'
  ),
  invalid_record: diagnosticDefinition(
    'invalid_record',
    'blocking',
    '记录格式无效',
    '存在不符合当前格式语法、字段类型或结构约束的记录，不能据此生成可信观测。',
    '根据原始记录锚点核对并修正源文件记录；保留原文件后重新导入。'
  ),
  record_ignored: diagnosticDefinition(
    'record_ignored',
    'warning',
    '记录未纳入观测',
    '部分记录未进入规范化观测模型，但原始文件和记录定位信息仍会被保留以便复核。',
    '查看对应记录锚点和解析原因；补齐所需字段或确认该记录可被排除。'
  ),
  limit_exceeded: diagnosticDefinition(
    'limit_exceeded',
    'blocking',
    '超出安全处理上限',
    '文件大小、容器展开量、记录数量或解析复杂度超出当前安全上限，解析已停止以保护运行环境。',
    '按可追溯的边界拆分源文件或降低容器规模；确认每个部分仍保留原始来源后重新导入。'
  ),
  unsafe_archive: diagnosticDefinition(
    'unsafe_archive',
    'blocking',
    '压缩容器不安全',
    '压缩文件包含不安全的结构、路径、展开比例或成员来源，当前契约不能安全发布其中的测量记录。',
    '提供未加密、无路径穿越且只含可追溯测量源文件的原始文件；必要时直接导入未压缩源文件。'
  ),
  encoding_detected: diagnosticDefinition(
    'encoding_detected',
    'info',
    '文本编码已检测',
    '系统已检测到文本编码；编码识别仅用于安全解码，不等同于格式、单位或记录语义已被确认。',
    '核对厂商导出编码和字符显示；如出现乱码，请以正确编码重新导出原始文件。'
  ),
  gnss_processing_required: diagnosticDefinition(
    'gnss_processing_required',
    'blocking',
    '需要 GNSS 后处理',
    '该 GNSS 源尚未同时具备可追溯的基准、三维基线向量和完整协方差，不能直接进入基线平差。',
    '先在合规的 GNSS 后处理流程中生成带固定基准和完整协方差的基线成果，再导入平差。'
  ),
  converter_required: diagnosticDefinition(
    'converter_required',
    'blocking',
    '需要受审计转换器',
    '该厂商私有或不透明格式需要经过允许的本地转换器处理，不能由系统根据扩展名或猜测语义直接解析。',
    '选择已获审计的本地转换器，并核对其许可证、版本、可执行文件哈希和输入输出来源后再转换。'
  ),
  missing_geometry: diagnosticDefinition(
    'missing_geometry',
    'blocking',
    '缺少网形几何信息',
    '源数据缺少构建测量网所需的站点、目标、连接关系或必要观测几何，无法进行可信校核或平差。',
    '补齐站点、目标和观测连接关系，并确认其与原始外业记录一致后重新导入。'
  ),
  missing_datum: diagnosticDefinition(
    'missing_datum',
    'blocking',
    '缺少基准信息',
    '源数据未声明或未固定计算所需的坐标、高程或 GNSS 基准，结果将无法获得可追溯的参考框架。',
    '提供经确认的坐标和高程基准，以及固定控制点或等效基准约束后重新校核。'
  ),
  missing_covariance: diagnosticDefinition(
    'missing_covariance',
    'blocking',
    '缺少协方差信息',
    '源数据未提供完成随机模型所需的协方差或等效精度信息，不能安全计算权阵和不确定度。',
    '提供完整协方差矩阵或经确认的等效精度模型，并保留其来源和单位说明后重新导入。'
  ),
  mapping_required: diagnosticDefinition(
    'mapping_required',
    'blocking',
    '需要受确认的字段映射',
    'CSV/XLSX 测量网络尚未提供可追溯的列映射、线性单位、角度格式和筛选规则，不能把表格内容直接解释为可平差观测。',
    '在 F-FMT-10 映射工作流中确认列、单位、角度格式与筛选规则，保存可复用映射并保留原文件后重新导入。'
  )
} satisfies Record<SurveyImportDiagnosticCodeV1, SurveyImportDiagnosticDefinitionV1>

type AssertNever<Value extends never> = Value
type _ContractCodesMissingFromDeclaredList = AssertNever<Exclude<SurveyImportDiagnosticCodeV1, (typeof declaredDiagnosticCodes)[number]>>
type _DeclaredCodesOutsideContract = AssertNever<Exclude<(typeof declaredDiagnosticCodes)[number], SurveyImportDiagnosticCodeV1>>
type _ContractCodesMissingFromCatalog = AssertNever<Exclude<SurveyImportDiagnosticCodeV1, keyof typeof catalogDefinitions>>
type _CatalogCodesOutsideContract = AssertNever<Exclude<keyof typeof catalogDefinitions, SurveyImportDiagnosticCodeV1>>

export const SURVEY_IMPORT_DIAGNOSTIC_CATALOG = Object.freeze(catalogDefinitions)

const allowedSeverities = new Set<SurveyImportDiagnosticSeverityV1>(['info', 'warning', 'blocking'])
const chineseCopy = /[\u3400-\u9fff]/u
const forbiddenFallbackCopy = '未知错误'

/**
 * Runtime counterpart to the compile-time Record checks.  It is exported for
 * CI and tests so catalogue drift caused by a generated/loaded contract is
 * explicit rather than producing an unhelpful fallback diagnostic.
 */
export function assertSurveyImportDiagnosticCatalogIntegrity(): void {
  const contractCodes = SurveyImportDiagnosticV1.shape.code.options
  const contractCodeSet = new Set<string>(contractCodes)
  const declaredCodeSet = new Set<string>(SURVEY_IMPORT_DIAGNOSTIC_CODES)
  const catalogCodes = Object.keys(SURVEY_IMPORT_DIAGNOSTIC_CATALOG)

  if (contractCodeSet.size !== contractCodes.length || declaredCodeSet.size !== SURVEY_IMPORT_DIAGNOSTIC_CODES.length) {
    throw new Error('Survey import diagnostic catalogue integrity failed: contract or declared diagnostic codes are duplicated.')
  }
  if (contractCodeSet.size !== declaredCodeSet.size || contractCodes.some((code) => !declaredCodeSet.has(code))) {
    throw new Error('Survey import diagnostic catalogue integrity failed: declared codes do not exactly match SurveyImportDiagnosticV1.')
  }
  if (contractCodeSet.size !== catalogCodes.length || contractCodes.some((code) => !Object.prototype.hasOwnProperty.call(SURVEY_IMPORT_DIAGNOSTIC_CATALOG, code))) {
    throw new Error('Survey import diagnostic catalogue integrity failed: catalogue keys do not exactly match SurveyImportDiagnosticV1.')
  }

  for (const code of contractCodes) {
    const definition = (SURVEY_IMPORT_DIAGNOSTIC_CATALOG as Readonly<Record<string, SurveyImportDiagnosticDefinitionV1>>)[code]
    if (!definition) {
      throw new Error(`Survey import diagnostic catalogue integrity failed: ${code} has no definition.`)
    }
    if (definition.code !== code || definition.id !== `survey-import/${code}`) {
      throw new Error(`Survey import diagnostic catalogue integrity failed: ${code} has an inconsistent stable identifier.`)
    }
    if (!allowedSeverities.has(definition.severity)) {
      throw new Error(`Survey import diagnostic catalogue integrity failed: ${code} has an invalid severity.`)
    }
    for (const [field, value] of Object.entries({ title: definition.title, message: definition.message, suggestedAction: definition.suggestedAction })) {
      if (!value.trim() || !chineseCopy.test(value) || value.includes(forbiddenFallbackCopy)) {
        throw new Error(`Survey import diagnostic catalogue integrity failed: ${code}.${field} must contain usable Chinese copy and cannot be a fallback error.`)
      }
    }
    SurveyImportDiagnosticV1.parse({
      code,
      severity: definition.severity,
      message: definition.message,
      suggestedAction: definition.suggestedAction
    })
  }
}

assertSurveyImportDiagnosticCatalogIntegrity()

/** Returns the one authoritative definition for a contract-owned diagnostic code. */
export function getSurveyImportDiagnosticDefinition<Code extends SurveyImportDiagnosticCodeV1>(
  code: Code
): SurveyImportDiagnosticDefinitionFor<Code> {
  return SURVEY_IMPORT_DIAGNOSTIC_CATALOG[code] as SurveyImportDiagnosticDefinitionFor<Code>
}

/**
 * Boundary-safe lookup for untyped callers.  An unrecognised value yields no
 * definition; the caller must not replace it with an "unknown error" message.
 */
export function findSurveyImportDiagnosticDefinition(value: unknown): SurveyImportDiagnosticDefinitionV1 | undefined {
  const parsed = SurveyImportDiagnosticV1.shape.code.safeParse(value)
  return parsed.success ? getSurveyImportDiagnosticDefinition(parsed.data) : undefined
}

/**
 * Builds a contract-valid diagnostic from stable catalogue copy.  The optional
 * context is restricted to opaque source locations, so file content cannot
 * alter user-facing recovery guidance or become executable instruction.
 */
export function createSurveyImportDiagnostic<Code extends SurveyImportDiagnosticCodeV1>(
  code: Code,
  context: SurveyImportDiagnosticAnchorContextV1 = {}
): SurveyImportDiagnostic {
  const definition = getSurveyImportDiagnosticDefinition(code)
  return SurveyImportDiagnosticV1.parse({
    code,
    severity: definition.severity,
    message: definition.message,
    suggestedAction: definition.suggestedAction,
    localized: { en: { message: definition.english.message, suggestedAction: definition.english.suggestedAction } },
    ...(context.sourceRecord === undefined ? {} : { sourceRecord: context.sourceRecord }),
    ...(context.byteOffset === undefined ? {} : { byteOffset: context.byteOffset }),
    ...(context.recordAnchor === undefined ? {} : { recordAnchor: context.recordAnchor })
  })
}
