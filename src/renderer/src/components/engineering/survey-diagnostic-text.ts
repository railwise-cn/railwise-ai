import surveyServiceEnglish from '../../locales/en/survey-service.json'
import engineeringEnglish from '../../locales/en/engineering-diagnostics.json'
import parserEnglish from '../../locales/en/survey-parser-diagnostics.json'
import appI18n from '../../i18n'
import { formatRuntimeError } from '../../lib/format-runtime-error'
import { professionalSurveyDiagnosticChinese } from './survey-professional-diagnostics'
import { surveySourceFormatLabel } from './survey-source-format-labels'
const serviceEnglish = { ...surveyServiceEnglish, ...engineeringEnglish, ...parserEnglish }

/**
 * Replace the format-catalog policy envelope with a decision a survey
 * practitioner can act on. The catalog/version and parser vocabulary remain
 * available in advanced trace data; they do not belong in the work surface.
 */
function professionalizeFormatPolicy(text: string, english: boolean): string | undefined {
  const hasChinesePolicy = /\bP0\b[^\n。；;]*格式(?:目录|受理目录)/i.test(text)
  const hasEnglishPolicy = /\bP0\b[^\n.;]*\b(?:format catalog|admission catalog)\b/i.test(text)
  if (!hasChinesePolicy && !hasEnglishPolicy) return undefined

  // Findings may already have passed through a presentation layer that
  // translated the disposition while leaving the catalog explanation intact.
  const readySignal = /当前资料可进入计算前检查|可进入计算前检查|开始计算前|\b(?:ready\s+to\s+calculate|before\s+calculation|calculation\s+pauses)\b/i.test(text)
  const blockedSignal = /当前不能直接计算|不能进入计算|\b(?:cannot\s+be\s+calculated|not\s+ready\s+to\s+calculate|archive-only|converter-required|gnss-processing-required)\b/i.test(text)
  const state = /(?:当前能力策略为|当前处置为|\bpermits|\bpolicy is|\bcurrent disposition:)\s*(adjustment-ready|archive-only|converter-required|gnss-processing-required)\b/i.exec(text)?.[1]
    ?? /^(adjustment-ready|archive-only|converter-required|gnss-processing-required)\s*:/i.exec(text)?.[1]

  const explanation = state && ['archive-only', 'converter-required', 'gnss-processing-required'].includes(state.toLowerCase())
    ? professionalDispositionText(state.toLowerCase(), english)
    : english
      ? state?.toLowerCase() === 'adjustment-ready' || (state === undefined && readySignal)
        ? 'Survey data recognized. Confirm the datum, control points, observation relationships, closure and precision before calculation. Calculation pauses when any check is incomplete.'
        : state !== undefined || blockedSignal
          ? 'Survey data recognized, but it cannot be calculated yet. Check the original records, field mapping, units and datum, then import the data again.'
          : 'Survey data recognized. Confirm the datum, control points, observation relationships, closure and precision before calculation.'
      : state?.toLowerCase() === 'adjustment-ready' || (state === undefined && readySignal)
        ? '资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件；任一条件未满足时，系统会暂停计算。'
        : state !== undefined || blockedSignal
          ? '资料已识别，但当前不能直接计算。请检查原始记录、字段对应关系、单位和基准后重新导入。'
          : '资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件。'
  const remainder = removeKnownFormatPolicyCopy(text)
  return remainder ? `${explanation}${english ? ' ' : ''}${remainder}` : explanation
}

/** Remove only catalog-owned copy, never the remaining engineering finding.
 * AI answers can quote a stored diagnostic and add a measured failure in the
 * same paragraph. Replacing the paragraph would erase that failure. */
function removeKnownFormatPolicyCopy(text: string): string {
  let remainder = text
    .replace(/(?:COSA(?:\(科傻\))?|SOUTH(?:\(南方\))?|Trimble\/Zeiss|Leica\/Hexagon|科傻|天宝|徕卡|南方测绘)\s*\/\s*[a-z][a-z0-9-]*\s+已保留(?:可审计的解析对象|原始源文件)[；;]\s*/gi, '')
    .replace(/[a-z][a-z0-9-]*:\s*(?:auditable parsed objects|original source) retained;\s*/gi, '')
    .replace(/(?:已保留(?:可审计的解析对象及原始记录锚点|原始源文件)，但 )?格式 [a-z][a-z0-9-]* 不在当前 P0 厂商格式受理目录中；解析器或 fixture 识别仅用于审计和预检，不构成 adjustment-ready 许可。/gi, '')
    .replace(/\bP0\s+(?:格式目录|format catalog|admission catalog)\s*(?:workwise-survey-format-catalog-[a-z0-9._-]+)?\s*(?:(?:当前能力策略为|permits|policy is)\s*(?:adjustment-ready|archive-only|converter-required|gnss-processing-required)\s*[:：]?|当前资料可进入计算前检查\s*[:：]?|—)?\s*/gi, '')
    .replace(/当前处置为 (?:adjustment-ready|archive-only|converter-required|gnss-processing-required)。/gi, '')
    .replace(/^(?:adjustment-ready|archive-only|converter-required|gnss-processing-required):\s*/i, '')
  for (const sentence of knownFormatPolicySentences) remainder = remainder.split(sentence).join('')
  return remainder.replace(/^[\s。；;:：—]+|[\s；;:：—]+$/g, '').trim()
}

// Exact catalog explanations and their historical presentation variants.
// Unknown adjoining sentences are deliberately retained as source evidence.
const knownFormatPolicySentences = [
  '严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断平差。',
  '严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断。',
  '仅在用户提供并验证显式已知点/测段列映射、m/km 单位声明且严格解析成功时可进入策略校验；缺失或无效映射仍归档。',
  '严格识别 For M5 aBFFB 测段、Rb/Rf 顺序、米制读数和原始记录锚点后可进入策略校验；已知高程基准、闭合、拓扑和精度条件仍由平差入口逐项验证。',
  '词法、观测语义和单位转换成功后可进入策略校验；固定控制、基准、几何、闭合和精度条件仍由平差入口逐项验证。',
  '隔离的 .NET 拓扑读取核心仅有 synthetic 证据；registry 尚未具备调用方坐标和文件组来源的接入条件，当前只能归档审查。',
  '解析器能力限制优先，当前资料仅供查看。',
  '解析器能力限制优先；',
  '原始资料需要进一步检查。',
  'LandXML 的 Units.angleUnit / directionUnit 及方向参考语义尚未完成互操作验收，解析字段不构成可平差的单位解释。',
  'strict structure parsing, record anchors and unit conversion are required before policy checks.',
  'Strict structure parsing, record anchors and unit conversion permit strategy validation.',
  'Parsing, datum, topology, closure or precision failures still block adjustment.',
  'Strategy validation requires confirmed known-point/section mappings, explicit m/km units and a successful strict parse.',
  'Missing or invalid mappings remain archive-only.',
  'Strict For M5 aBFFB section recognition, Rb/Rf order, metre readings and raw-record anchors permit strategy validation.',
  'Known height datum, closure, topology and precision are checked at adjustment entry.',
  'Validated lexical structure, observation semantics and unit conversion permit strategy validation.',
  'Fixed control, datum, geometry, closure and precision are still checked at adjustment entry.',
  'The isolated .NET topology reader has synthetic evidence only.',
  'Registry integration with caller coordinates and companion-file provenance is incomplete; archive review only.',
  'Read-only result comparison fields are planned; no accepted parser/fixture evidence is registered yet.',
  'Authoritative DAT column order is n.a.; no default mapping may be guessed and unmapped files are archive-only.',
  'Parser capability restrictions take precedence; the source is retained for review only.'
]

function professionalDispositionText(disposition: string, english: boolean): string {
  if (english) {
    if (disposition === 'adjustment-ready') return 'Survey data is ready for professional checks. Confirm the datum, control points, observation relationships, closure and precision before adjustment.'
    if (disposition === 'archive-only') return 'This format can be reviewed but not adjusted directly. Convert or export it to a supported survey format before importing it for calculation.'
    if (disposition === 'converter-required') return 'Convert this file to a supported survey format before importing it again.'
    if (disposition === 'gnss-processing-required') return 'Complete GNSS baseline processing and import its results before continuing.'
    return 'This survey file is not ready for adjustment. Check the original file, format, field mapping, units and coordinate datum before importing it again.'
  }
  if (disposition === 'adjustment-ready') return '资料已识别。开始平差前，请确认坐标基准、控制点、观测关系、闭合差和精度条件。'
  if (disposition === 'archive-only') return '此格式当前仅支持查看与质量检查，不能直接用于平差。如需计算，请转换或导出为受支持的测量格式后再导入。'
  if (disposition === 'converter-required') return '此资料需先转换为受支持的测量格式，再重新导入。'
  if (disposition === 'gnss-processing-required') return '此资料需先完成 GNSS 基线解算，再导入解算成果继续处理。'
  return '当前资料暂不能用于平差。请检查原始文件、格式、字段映射、单位和坐标基准后重新导入。'
}

/** Presentation-only translation for internal format and gate vocabulary. */
function professionalizeDiagnosticText(text: string, language: string): string {
  const english = language.toLowerCase().startsWith('en')
  const detected = /^(?:识别为 (.+)，置信度 (\d+)%|Detected (.+); confidence (\d+)%)$/.exec(text)
  if (detected) {
    const format = (detected[1] ?? detected[3])!.replace(/\b(?:cosa-(?:in[12]|net|ou[12])|south-dat|workwise-json|delimited-text|survey-cloud-suc)\b/g,
      value => surveySourceFormatLabel(appI18n.getFixedT(language, 'common'), value, language))
      .replace('COSA(科傻) / COSA', english ? 'COSA' : '科傻 COSA')
      .replace('COSA / COSA', 'COSA')
    const confidence = detected[2] ?? detected[4]
    return english ? `Recognized ${format}; confidence ${confidence}%` : `识别为 ${format}，置信度 ${confidence}%`
  }
  if (/\bF-FMT-10\b/i.test(text)) {
    const explanation = /映射工作流|mapping workflow/i.test(text) ? english
      ? 'In import preflight, confirm the point identifiers, observation type, units and angle format, save the mapping, and import the file again.'
      : '请在导入预检中确认点号、观测类型、单位和角度格式，保存映射后重新导入。'
      : /CSV|delimited text|Excel XLSX/i.test(text) ? english
      ? 'This table still needs column, unit and angle-format confirmation. Complete and save the mapping in import preflight before importing it for adjustment.'
      : '此表格资料尚未完成列映射、单位和角度格式确认。请在导入预检中完成并保存映射后重新导入。'
      : professionalDispositionText('archive-only', english)
    const remainder = text
      .replace(/(?:archive-only:\s*)?(?:CSV \/ 分隔文本|Excel XLSX) 尚未附带 F-FMT-10 所需的已保存列映射、线性单位、角度格式和用户确认记录；不得以表头猜测代替确认后进入平差。/g, '')
      .replace('先在 F-FMT-10 映射工作流中选择列、线性单位和角度格式，保存映射方案并完成用户确认；该流程尚未实现时请使用受冻结 WorkWise JSON 合同的输入。', '')
      .replace(/\bF-FMT-10\b/gi, english ? 'table mapping' : '表格对应关系')
      .trim()
    return remainder ? `${explanation}${english ? ' ' : ''}${remainder}` : explanation
  }
  const formatPolicy = professionalizeFormatPolicy(text, english)
  if (formatPolicy) return formatPolicy
  const disposition = /^(?:((?:archive-only|converter-required|gnss-processing-required|adjustment-ready)): [a-z][a-z0-9_]* —|源文件处置为 ((?:archive-only|converter-required|gnss-processing-required|adjustment-ready))，不得进入平差：|Source disposition is ((?:archive-only|converter-required|gnss-processing-required|adjustment-ready)); adjustment is blocked:)/i.exec(text)
  const dispositionValue = disposition?.[1] ?? disposition?.[2] ?? disposition?.[3]
  if (dispositionValue) {
    const explanation = professionalDispositionText(dispositionValue.toLowerCase(), english)
    let remainder = text.slice(disposition![0].length).trim()
    // Disposition wrappers may nest. Remove routing labels but retain the
    // concrete failure (point, source row, measurement and restriction).
    remainder = remainder.replace(/^(?:archive-only|converter-required|gnss-processing-required|adjustment-ready): [a-z][a-z0-9_]* —\s*/i, '')
    for (const generic of [
      '无法通过内容签名安全识别测量文件；不会回退为通用 CSV',
      '转换器未安装', '尚需完成基线解算', 'converter missing', '当前文件暂不能处理。'
    ]) remainder = remainder.replace(generic, '')
    const details = remainder.trim() ? surveyLegacyDiagnosticText(remainder.trim(), language) : ''
    return details ? `${explanation}${english ? ' ' : ''}${details}` : explanation
  }
  return text
    .replace(/workwise-survey-format-catalog-[a-z0-9._-]+/gi, '')
    .replace(/本次模型或工具尝试失败，任务将从检查点继续。/g, '本次处理未能完成，可从上次保存的位置继续。')
    .replace(/This model or tool attempt failed\. The task will resume from its checkpoint\./gi, 'Processing did not finish. You can continue from the last saved step.')
    .replace(/当前能力策略为\s*adjustment-ready\s*[：:]/gi, '当前资料可进入计算前检查：')
    .replace(/adjustment-ready\s*许可/gi, english ? 'calculation admission' : '进入计算')
    .replace(/\badjustment-ready\b/gi, english ? 'ready to calculate' : '可以开始计算')
    .replace(/服务端已确认来源资格/g, '来源资格已确认')
    .replace(/服务端未授予来源资格/g, '来源资格未确认')
    .replace(/服务端来源资格校验/g, '来源资格校验')
    .replace(/\s{2,}/g, ' ')
    // Keep spaces that are part of legacy format labels such as "COSA .in1".
    .replace(/\s+([，。；：,;])/g, '$1')
    .trim()
}

/**
 * Last-mile guard for diagnostics from older service payloads. Technical
 * vocabulary remains available in stored records, but it must not leak into
 * the compact survey work surface when an older message bypasses the format
 * policy branch. Keep measurements, source locations and engineering
 * conclusions; translate only implementation-owned labels here.
 */
function removeImplementationVocabulary(text: string, language: string): string {
  const english = language.toLowerCase().startsWith('en')
  const professionalCheck = english ? 'professional check' : '专业检查'
  // P0 is also a valid point or station label. Only rewrite it when the
  // nearby words clearly identify the old catalog/policy envelope.
  const replaceCatalogP0 = (value: string): string => value.replace(/\bP0\b/gi, (match, offset: number, whole: string) => {
    const context = `${whole.slice(Math.max(0, offset - 24), offset)} ${whole.slice(offset + match.length, offset + match.length + 48)}`
    return /格式(?:目录|受理目录)|format\s+(?:catalog|admission)|blocking\s+(?:rule|policy)|(?:policy|策略|质量)\s*(?:校验|check|gate|rule|目录)/i.test(context)
      ? professionalCheck
      : match
  })
  return replaceCatalogP0(text
    .replace(/(?:\btool(?:\s+(?:id|name))?|工具(?:名|名称|ID)?)\s*[:=：]\s*[a-z][a-z0-9_.:/-]*/gi, '')
    .replace(/\bP0\s+(?:blocking\s+rule|blocking\s+policy|policy|gate|rule)\b/gi, professionalCheck)
    .replace(/\bP0\s+(?:格式目录|格式受理目录|format catalog|admission catalog)\b/gi, '')
  )
    .replace(/\bworkwise-survey-format-catalog-[a-z0-9._-]+\b/gi, '')
    .replace(/(?:可审计的|auditable\s+)?解析对象(?:及原始记录锚点|and raw-record anchors)?/gi, english ? 'survey data' : '测量资料')
    .replace(/原始记录锚点|raw[- ]record anchors?/gi, english ? 'source record location' : '原始记录位置')
    .replace(/策略校验|strategy validation|policy checks?/gi, english ? 'professional checks' : '专业检查')
    .replace(/(?:解析器|\bparser\b(?!_contract))(?:或\s*fixture|\s+or\s+fixture)?/gi, english ? 'data reader' : '资料读取')
    .replace(/\bfixture\b/gi, english ? 'sample data' : '示例资料')
    .replace(/\badjustment-ready\b/gi, english ? 'ready for adjustment checks' : '可进入平差检查')
    .replace(/来源资格(?:校验|证据)?/g, '资料可用性')
    .replace(/source\s+(?:eligibility|admission)(?:\s+check|\s+evidence)?/gi, 'data availability')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。；：,;:)）])/g, '$1')
    .replace(/([（(])\s*([，。；：,;:)）])/g, '$1')
    .replace(/[，,；;：:]\s*([。.!！？])/g, '$1')
    .replace(/^[\s。；;:：—]+|[\s；;:：—]+$/g, '')
    .trim()
}

/** Presentation only: never change persisted audit messages or gate decisions. */
export type SurveyDiagnosticText = {
  code?: string
  message?: string
  suggestion?: string
  suggestedAction?: string
  localized?: { en: { message: string; suggestedAction?: string } }
}

const legacyActions: Record<string, string> = {
  ...serviceEnglish,
  '角度': 'angular ',
  '线性': 'linear ',
  '继续完成基准、控制点、观测角色、拓扑、闭合与精度校验；任一条件不满足都会阻断平差。': 'Validate datum, control points, observation roles, topology, closure and precision; any failed condition blocks adjustment.',
  '检查原始记录、显式映射和解析诊断；修正后通过重新检测/导入流程复核。': 'Inspect raw records, explicit mappings and parser diagnostics; correct the input and repeat detection/import.',
  '字段映射需要确认。': 'Field mapping requires confirmation.',
  '确认字段映射、单位和基准后重新导入。': 'Confirm field mapping, units and datum, then reimport.',
  '先在 F-FMT-10 映射工作流中选择列、线性单位和角度格式，保存映射方案并完成用户确认；该流程尚未实现时请使用受冻结 WorkWise JSON 合同的输入。': 'In import preflight, confirm the point identifiers, observation type, units and angle format, save the mapping, and import the file again.',
  '内容签名、记录结构和单位声明均已通过预检。': 'Content signatures, record structure and declared units passed preflight.'
}

const serviceTemplates = Object.entries(serviceEnglish).filter(([source]) => /\{\d+\}/.test(source)).map(([source, english]) => ({
  source,
  literals: source.split(/\{\d+\}/),
  parameters: [...source.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1])),
  english
}))

// Only these parameters contain system-generated diagnostics or field labels.
// All other parameters are opaque evidence (point IDs, file names, units, numbers).
const nestedDiagnosticParameters: Record<string, readonly number[]> = {
  '源文件处置为 {0}，不得进入平差：{1}': [1],
  '观测 {0} 的单位 {1} 没有已确认的 {2}换算定义，不能进入平差。': [2],
  '原始资料尚未验证：{0}': [0],
  '原始资料完整性校验失败：{0}': [0],
  '来源准入证据无效：{0}': [0],
  '无法回放派生修正：原始资料不满足可平差门禁（{0}）': [0],
  '历史校核 {0} 的原始资料不再满足可平差门禁：{1}': [1],
  '历史平差 {0} 的原始资料不再满足可平差门禁：{1}': [1],
  '变形成果 {0} 的实时平差证据读取失败：{1}': [1],
  '平差网络 {0} 原始资料完整性校验失败：{1}': [1],
  'Leica GSI 物理词法校验失败（{0}）：{1}': [1],
  'Leica GSI 数值语义校验失败：{0}': [0],
  'Leica GSI 第 {0} 行第 {1} 个 word 的{2}含有不允许的字符 {3}。': [2],
  '同一 GSI 物理记录含重复的 {0}，不能覆盖前一个值': [0]
}

// Scan literal boundaries without a backtracking regex over untrusted IDs.
// Ambiguous or unknown input remains verbatim rather than losing evidence.
function translatedServiceTemplate(text: string, depth = 0, english = true): string | undefined {
  if (depth > 3 || text.length > 16384) return undefined
  const exact = english ? legacyActions : professionalSurveyDiagnosticChinese
  if (Object.prototype.hasOwnProperty.call(exact, text)) return exact[text]
  // dispositionReason wraps a system diagnostic in a stable disposition/code
  // envelope. Its message is translatable; opaque identifiers are not.
  const disposition = /^(archive-only|converter-required|gnss-processing-required|adjustment-ready): ([a-z][a-z0-9_]*) — ([\s\S]+)$/.exec(text)
  if (disposition) return `${disposition[1]}: ${disposition[2]} — ${translatedServiceTemplate(disposition[3]!, depth + 1, english) ?? disposition[3]}`
  for (const { source, literals, parameters, english: translatedEnglish } of serviceTemplates) {
    const translation = english ? translatedEnglish : professionalSurveyDiagnosticChinese[source]
    if (translation === undefined) continue
    if (!text.startsWith(literals[0]!)) continue
    let cursor = literals[0]!.length
    const values: Record<number, string> = {}
    let matched = true
    for (let index = 0; index < parameters.length; index++) {
      const suffix = literals[index + 1]!
      const last = index === parameters.length - 1
      const end = last ? text.length - suffix.length : suffix ? text.indexOf(suffix, cursor) : cursor
      if (end < cursor || text.slice(end, end + suffix.length) !== suffix) { matched = false; break }
      const value = text.slice(cursor, end)
      const parameter = parameters[index]!
      values[parameter] = nestedDiagnosticParameters[source]?.includes(parameter)
        ? translatedServiceTemplate(value, depth + 1, english) ?? value
        : value
      cursor = end + suffix.length
    }
    if (matched && cursor === text.length) return translation.replace(/\{(\d+)\}/g, (_, id: string) => values[Number(id)] ?? '')
  }
  return undefined
}

/** Exact legacy compatibility; unknown text remains visible rather than losing evidence. */
export function surveyLegacyDiagnosticText(text: string, language: string): string {
  const english = language.toLowerCase().startsWith('en')
  // Read the stored disposition before translating its text, so a blocked
  // format can never become a suggestion to calculate after copy changes.
  const formatPolicy = professionalizeFormatPolicy(text, english)
  if (formatPolicy) return removeImplementationVocabulary(formatPolicy, language)
  const serviceText = translatedServiceTemplate(text, 0, english)
  let result = serviceText ?? text
  if (english && serviceText === undefined) {
    const encoding = /^文本编码 (utf-8|utf-16le|utf-16be|gb18030)$/.exec(text)
    if (encoding) result = `Text encoding: ${encoding[1]}`
    else {
      const detected = /^识别为 (.+)，置信度 (\d+)%$/.exec(text)
      if (detected) {
        const format = detected[1]!
          .replace('COSA(科傻)', 'COSA')
          .replace('South/南方测绘', 'South')
          .replace('南方测绘', 'South')
        result = `Detected ${format}; confidence ${detected[2]}%`
      }
    }
  }
  return removeImplementationVocabulary(professionalizeDiagnosticText(result, language), language)
}

/** Decode runtime errors without exposing internal codes or losing readable causes. */
export function surveyRuntimeErrorText(text: string, language: string): string {
  if (/无法连接到.*(?:Runtime|运行时)|(?:unable|failed|cannot) to connect.*runtime|runtime.*(?:not report ready|startup.*timed out)/i.test(text)) {
    return language.toLowerCase().startsWith('en')
      ? 'The survey service is not connected. Try reconnecting; your task data will remain saved.'
      : '测量服务尚未连接，请重试连接；已有任务资料会保留。'
  }
  if (text.includes('model_provider_unavailable')) return language.toLowerCase().startsWith('en')
    ? 'AI assistance is temporarily unavailable. Check the connection or try again later.'
    : 'AI 辅助暂时不可用，请检查连接或稍后重试。'
  let message = text
  let hasExplicitMessage = false
  try {
    const body = JSON.parse(text) as { error?: string | { code?: string; message?: string }; message?: string }
    if (typeof body.error === 'string') {
      message = body.message ?? body.error
      hasExplicitMessage = typeof body.message === 'string'
    } else if (body.error && typeof body.error.message === 'string') {
      message = body.error.message
      hasExplicitMessage = true
    }
    else if (typeof body.message === 'string') {
      message = body.message
      hasExplicitMessage = true
    }
  } catch { /* Plain-text Runtime errors are supported by older versions. */ }
  const unsupportedSurveyField = /(?:^|\b)survey_parser_contract:\s*unsupported field\s+([A-Za-z][A-Za-z0-9_-]{1,15})\b/i.exec(message.trim())
  if (unsupportedSurveyField) return language.toLowerCase().startsWith('en')
    ? `The survey record contains unsupported field ${unsupportedSurveyField[1]}. Check the instrument export format or reimport a compatible export.`
    : `测量记录包含当前不支持的字段 ${unsupportedSurveyField[1]}。请检查仪器导出格式，或使用兼容格式重新导入。`
  const translated = surveyLegacyDiagnosticText(message, language)
  if (translated !== message && translated.trim()) return translated
  const trimmedPayload = text.trimStart()
  const hasInternalDetails = (!hasExplicitMessage && (trimmedPayload.startsWith('{') || trimmedPayload.startsWith('[')))
    || /\b(?:[a-z][a-z0-9]+_[a-z0-9_-]+|[A-Z][A-Za-z0-9]*(?:Error|Exception))\b|(?:\/Users\/|\/private\/|\\Users\\)|\b(?:stack trace|at\s+\w+\s+\(|source(?:Sha|)256|contextHash|inputHash|parser(?:Id|Version)?|tool(?:Id|Name)?|manifest)\b|(?:^|\s)(?:GET|POST|PUT|PATCH|DELETE)\s+\/[^\s]+/i.test(message)
  const genericRuntimeMessage = /^(?:(?:read|write|request|creation|connection|runtime)\s+(?:failed|unavailable)|runtime request failed(?:\s*\(\d{3}\))?|(?:failed to (?:read|write|create|connect)))[.!]?$/i.test(message.trim())
  if (!hasInternalDetails && !genericRuntimeMessage && !/\r?\n/.test(message) && message.trim().length <= 320 && message.trim()) return message.trim()
  const fallback = appI18n.t('common:runtimeRequestFailed', { lng: language })
  const formatted = formatRuntimeError(new Error(text), fallback)
  return formatted === fallback ? fallback : formatted
}

export function surveyDiagnosticText(item: SurveyDiagnosticText, language: string, field: 'message' | 'action' = 'message'): string {
  const original = field === 'message' ? item.message ?? '' : item.suggestedAction ?? item.suggestion ?? ''
  const english = field === 'message' ? item.localized?.en.message : item.localized?.en.suggestedAction
  const translated = surveyLegacyDiagnosticText(original, language)
  // A localized explanation can add a source row or record number that the
  // generic legacy translation does not contain. Keep that detail, then run
  // it through the same presentation filter so old internal vocabulary still
  // cannot reach the work surface.
  const localizedInternal = english && /\b(?:JSON|transformType|coordinate-transform|parser|fixture|format\s+catalog|adjustment-ready|source(?:Sha256|Hash)|contextHash|revision|selector|typedEvidence|survey_[a-z0-9_-]+)\b/i.test(english)
  const displayed = language.toLowerCase().startsWith('en') && english && !localizedInternal
    ? surveyLegacyDiagnosticText(english, language)
    : translated
  return removeImplementationVocabulary(professionalizeDiagnosticText(displayed, language), language)
}

export function surveySourceDiagnosticText(item: SurveyDiagnosticText, language: string, sourceDisposition?: string, sourceEligible?: boolean): string {
  const original = item.message ?? ''
  if (item.code !== 'format_detected' && !/\bP0\b[^\n。；;]*格式(?:目录|受理目录)|\bP0\b[^\n.;]*\b(?:format catalog|admission catalog)\b/i.test(original)) {
    return removeImplementationVocabulary(surveyDiagnosticText(item, language), language)
  }

  const english = language.toLowerCase().startsWith('en')
  const restriction = sourceDisposition && sourceDisposition !== 'adjustment-ready'
    ? professionalDispositionText(sourceDisposition, english)
    : sourceEligible !== true ? english
      ? 'This source has not passed the checks required for adjustment. Verify source integrity and data quality before continuing.'
      : '该资料当前不具备平差条件。请先完成来源完整性和数据质量校核。'
      : undefined
  if (restriction) {
    // The current source decision overrides the catalog's general capability,
    // but not a specific measured failure appended to that catalog finding.
    const remainder = /^(?:archive-only|converter-required|gnss-processing-required|adjustment-ready): [a-z][a-z0-9_]* —/i.test(original)
      ? original
      : removeKnownFormatPolicyCopy(original)
    const detail = remainder ? surveyLegacyDiagnosticText(remainder, language) : ''
    if (detail.startsWith(restriction)) return removeImplementationVocabulary(detail, language)
    return removeImplementationVocabulary(detail ? `${restriction}${english ? ' ' : ''}${detail}` : restriction, language)
  }
  return removeImplementationVocabulary(surveyDiagnosticText(item, language), language)
}
