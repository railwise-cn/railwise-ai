import surveyServiceEnglish from '../../locales/en/survey-service.json'
import engineeringEnglish from '../../locales/en/engineering-diagnostics.json'
import parserEnglish from '../../locales/en/survey-parser-diagnostics.json'
const serviceEnglish = { ...surveyServiceEnglish, ...engineeringEnglish, ...parserEnglish }

/** Presentation only: never change persisted audit messages or gate decisions. */
export type SurveyDiagnosticText = {
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
function translatedServiceTemplate(text: string, depth = 0): string | undefined {
  if (depth > 3 || text.length > 16384) return undefined
  if (Object.prototype.hasOwnProperty.call(legacyActions, text)) return legacyActions[text]
  // dispositionReason wraps a system diagnostic in a stable disposition/code
  // envelope. Its message is translatable; opaque identifiers are not.
  const disposition = /^(archive-only|converter-required|gnss-processing-required|adjustment-ready): ([a-z][a-z0-9_]*) — ([\s\S]+)$/.exec(text)
  if (disposition) return `${disposition[1]}: ${disposition[2]} — ${translatedServiceTemplate(disposition[3]!, depth + 1) ?? disposition[3]}`
  for (const { source, literals, parameters, english } of serviceTemplates) {
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
        ? translatedServiceTemplate(value, depth + 1) ?? value
        : value
      cursor = end + suffix.length
    }
    if (matched && cursor === text.length) return english.replace(/\{(\d+)\}/g, (_, id: string) => values[Number(id)] ?? '')
  }
  return undefined
}

/** Exact legacy compatibility; unknown text remains visible rather than losing evidence. */
export function surveyLegacyDiagnosticText(text: string, language: string): string {
  if (!language.toLowerCase().startsWith('en')) return text
  const serviceText = translatedServiceTemplate(text)
  if (serviceText !== undefined) return serviceText
  const encoding = /^文本编码 (utf-8|utf-16le|utf-16be|gb18030)$/.exec(text)
  if (encoding) return `Text encoding: ${encoding[1]}`
  const detected = /^识别为 (.+)，置信度 (\d+)%$/.exec(text)
  if (detected) return `Detected ${detected[1]!.replace('COSA(科傻)', 'COSA')}; confidence ${detected[2]}%`
  return text
}

/** Decode the existing Runtime error envelope without hiding its stable code. */
export function surveyRuntimeErrorText(text: string, language: string): string {
  if (text.includes('model_provider_unavailable')) return language.toLowerCase().startsWith('en')
    ? 'The selected model provider is unavailable. Restore it in Settings or select a provider and model before sending again.'
    : '所选模型提供商已不可用。请在设置中恢复该提供商，或重新选择提供商与模型后发送。'
  let message = text
  try {
    const body = JSON.parse(text) as { error?: string | { code?: string; message?: string }; message?: string }
    if (typeof body.error === 'string') message = body.message ? `${body.error}: ${surveyLegacyDiagnosticText(body.message, language)}` : body.error
    else if (body.error && typeof body.error.message === 'string') message = `${body.error.code ? `${body.error.code}: ` : ''}${surveyLegacyDiagnosticText(body.error.message, language)}`
    else if (typeof body.message === 'string') message = body.message
  } catch { /* Plain-text Runtime errors are supported by older versions. */ }
  return surveyLegacyDiagnosticText(message, language)
}

export function surveyDiagnosticText(item: SurveyDiagnosticText, language: string, field: 'message' | 'action' = 'message'): string {
  const original = field === 'message' ? item.message ?? '' : item.suggestedAction ?? item.suggestion ?? ''
  const english = field === 'message' ? item.localized?.en.message : item.localized?.en.suggestedAction
  return language.toLowerCase().startsWith('en') && english ? english : surveyLegacyDiagnosticText(original, language)
}
