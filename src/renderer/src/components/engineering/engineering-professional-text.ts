import appI18n from '../../i18n'
import { surveyDiagnosticText, surveyRuntimeErrorText } from './survey-diagnostic-text'

const internalOnlyLine = /^\s*(?:import\s|export\s|const\s|let\s|var\s|function\s|class\s|interface\s|type\s|enum\s)/i
const internalPhrase = /Selected Survey evidence|selected survey evidence|survey_parser_contract|\bP0\s+(?=(?:format|admission)\s+catalog|格式目录|受理目录)|(?:format|admission)\s+catalog|格式目录|受理目录|\bfixture\b|\bsample\s+data\b|\bdata\s+reader\b|示例资料|资料读取|\bsurvey_(?:read|write|propose|validate|quality|adjustment|import|export|evidence|context)(?:_[a-z0-9_-]+)?\b|survey_finding_[a-z0-9_-]+|tool_storm_suppressed|typedEvidence|contextHash|sourceSha256|parserSourceHash|(?:project|network|source|input|output|record|adjustment|parser)(?:Hash|Revision|Id)|(?:source|output|storedResults|recomputedResults|sourceContext|sourceFile)Hash|inputAttachmentHash|sourceRecordId|algorithmVersion|qualityFinding|callerDeclarationsAuthenticated|humanSignatureVerification|standardConformity|rawSourceIntegrity|sourceEligibility|format_detected|current-admissible|archive-only|converter-required|gnss-processing-required|adjustment-ready|unknown_format|schemaVersion|readOnly|correctionState|sourceRow|sourceLocator|recordType|rawFields|pointClass|knownPoints?|unknownPoints?|stationCount|observationCount|pointCount|initialCoordinateMethod|initialCoordinateDistanceRmsMetres|point-precision|xyErrorEllipse|covarianceXY|status\s*[:=]\s*(?:resolved|current|ok|success|open)|execution\s+(?:receipt|plan|protocol)|TaskRun|manifest(?:\.json)?|executionTurnId|(?:planId|plan_id|taskId|task_id|threadId|thread_id|toolId|tool_id)\s*[:=]|(?:\btool(?:\s+(?:id|name))?|工具(?:名|名称|ID)?)\s*[:=：]\s*[a-z][a-z0-9_.:/-]*|tool\s+call|tool\s+invocation|调用了?\s*\d+\s*个工具|工具调用返回|执行回执|执行协议|计划编号|上下文哈希|来源哈希|修订号|精确选择器|选择器|替代记录/i
const internalToken = /\b(?:eplan|task|run|adjustment|manifest|analysis|result|network|project|source|parser|plan|context|input|output|execution|receipt)[_-][0-9a-f]{8,}(?:-[0-9a-f-]{8,})?\b(?:…|\.\.\.)?/gi
const modelToken = /\b(?:deepseek|gpt|claude|gemini|qwen|llama)[-_a-z0-9.]*\b/gi
const codeLikeLine = /^(?:\s*(?:[>$#]\s*)?(?:npm|pnpm|yarn|bun|git|curl|wget|node|python|pip|tsx|npx)\s+|(?:GET|POST|PUT|PATCH|DELETE)\s+\/(?:v1|api)\/)/i
const structuredPayloadLine = /^\s*(?:[{}[\],]\s*$|["'][A-Za-z_$][\w$.-]*["']\s*:\s*|[A-Za-z_$][\w$.-]*\s*:\s*["'{[]|[[{].*[\]}]\s*$)/
const developerSyntaxLine = /^\s*(?:(?:if|for|while|switch|catch)\s*[({]|(?:else|try|finally)\b|case\s+[^:]+:|new\s+[A-Z_$]|(?:return|throw|await)\s+(?:[[{"']|[A-Za-z_$][\w$]*\s*[;(=]))|=>|\b(?:JSON\.(?:parse|stringify)|runtimeRequest|window\.workwise|fetch)\s*\(/i
const developerPayloadKey = /(?:["']?(?:contextHash|sourceSha256|parserSourceHash|inputHash|outputHash|taskId|planId|threadId|tool(?:Id|Name)?|parameters?|typedEvidence|sourceRecordId|algorithmVersion|projectRevision|networkRevision)["']?\s*[:=]|["']?(?:id|value|result|residual|x|y|z|point)["']?\s*:)/i
const professionalContent = /残差|沉降|高程|高差|坐标|观测|限差|禁止|超限|阻断|不得|方差因子|统计摘要|闭合差|精度|可计算|平差|\d+\s*(?:点|站|条|观测)\b|mm\b|\d\s*(?:m\b|rad\b|μm|[°′″]|毫米|米)|\b(?:residual|elevation|coordinate|observation|variance|statistics|closure|precision|calculable|adjustment|blocked|exceed|must not)\b|\.(?:pdf|csv|xlsx|in1|in2)\b/i
const residualImplementationVocabulary = /\b(?:fixture|sample\s+data|data\s+reader|format\s+catalog|admission\s+catalog|parser|runtime|hash|revision)\b/gi

/** Resolve the point selected by the surveyor from a legacy answer. A point
 * label must come from the answer/reference; never invent a fixed station ID.
 */
function surveyPointId(text: string): string | undefined {
  const reserved = new Set(['AI', 'CSV', 'COSA', 'DAT', 'PDF', 'XLSX', 'JSON', 'IN', 'OUT'])
  const candidates = [
    /(?:\bidentity\s+(?:id\s*[=:：]\s*)?|\bpoint(?:\s*id|\s*name)?\s*(?:is|=|:|：)?|点号|点位|测站|测点)\s*["“']?([A-Za-z][A-Za-z0-9_-]{0,31})/i,
    /(?:解释|说明|结果|成果|精度)\s*["“']?([A-Za-z]{1,8}(?:[-_]?\d{1,8})?)/i,
    /\b([A-Z]{1,8}[-_]?\d{1,8})\b/
  ]
  for (const pattern of candidates) {
    const match = pattern.exec(text)
    const value = match?.[1]
    if (value && !reserved.has(value.toUpperCase())) return value
  }
  return undefined
}

/** Remove inline object/array payloads while retaining surrounding findings. */
function removeInlineDeveloperPayload(text: string): string {
  let current = text
  // Repeat so a nested object is removed before its parent becomes a
  // single-line payload. The bounded expression avoids scanning across lines
  // or consuming a long natural-language paragraph.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current
      .replace(/\{[^{}\n]{0,2000}\}/g, (fragment) => developerPayloadKey.test(fragment) ? '' : fragment)
      .replace(/\[[^[\]\n]{0,2000}\]/g, (fragment) => developerPayloadKey.test(fragment) ? '' : fragment)
    if (next === current) break
    current = next
  }
  return current
}

/** Older answers describe evidence-reader mechanics. Preserve the resulting
 * limitation without asking a surveyor to repair a software reference. */
function historicalEvidenceStatement(line: string, language: string): string {
  const english = language.toLowerCase().startsWith('en')
  const label = (chinese: string, translated: string): string => english ? translated : chinese
  const prefix = line.match(/^(?:\d+[.)]\s+|[-*]\s+)/)?.[0] ?? ''
  const plain = line.replace(/[`*]/g, '')
  // Replace only the known legacy explanation sentence. Later sentences may
  // contain a successful retry, a measurement or a restriction and must stay.
  const sentenceEnd = line.search(/[。！？]/)
  const remainder = sentenceEnd < 0 ? '' : line.slice(sentenceEnd + 1).replace(/^\*\*/, '')
  const firstSentence = (sentenceEnd < 0 ? line : line.slice(0, sentenceEnd + 1)).replace(/[`*]/g, '')
  const hasProfessionalQuantity = /\d(?:[\d.eE+−⁻×–-]|\s)*\s*(?:mm|m\b|rad\b|[°′″μ]|毫米|米|秒)/i.test(firstSentence)
  const confirmed = /(?:已(?:经)?(?:核验|核查|核对|确认|验证)[^。！？]*(?:一致|成功|通过)|(?:重试|重新读取)[^。！？]*(?:成功|通过)|(?:现已|当前已)(?:成功|通过))/.test(plain)
  const statement = (chinese: string, translated: string): string => prefix + label(chinese, translated) + remainder
  if (/^#{1,6}\s/.test(line)) {
    return line.replace(/证据(?:读取情况（需要先说明）|读取结果（首要事项）|解析状态与边界)/g, '资料核查范围')
      .replace(/当前记录诊断（[^）]*）/g, '当前资料说明')
  }
  if (/^(?:我先|随后我|已按要求).*(?:类型化证据|精确选择器|survey_read_)/.test(firstSentence) && !hasProfessionalQuantity && !confirmed) return remainder
  if (/^[-*]\s+引用被精确命中/.test(firstSentence) && !hasProfessionalQuantity) return remainder
  if (/^[-*]\s+随后我/.test(plain) && /survey_read_context/.test(plain)) {
    return statement('以下补充内容来自当前资料，尚未完成对所选记录的独立核查。', 'The following supplementary information comes from current records; the selected record has not been independently verified.')
  }
  if (!confirmed && !hasProfessionalQuantity && (/^(?:\d+[.)]\s+)?(?:类型化证据引用无效|typedEvidence 引用已失效)/.test(firstSentence)
    || /invalid-reference/.test(firstSentence) && /(?:读取|引用|解析|返回|接口)/.test(firstSentence)
    || /本回合并不能.*严格读取器/.test(firstSentence)
    || /诊断说明：.*严格读取器/.test(firstSentence))) {
    return statement('所选资料目前无法完成核查。请重新选择相关记录后再核查；历史内容不能作为本次已验证的依据。', 'The selected record could not be verified. Select it again and recheck it; historical content is not verification for this request.')
  }
  if (!confirmed && !hasProfessionalQuantity && /^(?:\d+[.)]\s+)?(?:平差输入与|版本一致性[：:])/.test(firstSentence) && /(?:inputHash|sourceSha256|\bhash\b|revision|stale)/i.test(firstSentence)
    && /(?:不同|不一致|需确认|需核对|风险|一致性：)/.test(firstSentence)) {
    return statement('平差资料一致性需要复核：请确认平差使用的资料与当前源文件一致；未确认前，历史结果不能直接作为当前成果。', 'Check that the adjustment used the current source data. Until confirmed, historical results must not be treated as the current deliverable.')
  }
  if (!hasProfessionalQuantity && /^(?:\d+[.)]\s+)?(?:本证据只含初始坐标|证据语义与问题目标不匹配)/.test(firstSentence)
    && /(?:只含初始坐标|指向(?:网络)?初始坐标)/.test(firstSentence) && /不含(?:[^。]*?)(?:精度|point-precision)/.test(firstSentence)) {
    return statement('所选记录只含初始坐标，不含平差后点位精度。请从结果页选择相应平差成果，核查点位精度；两类记录不可混用。', 'The selected record contains initial coordinates, not adjusted point precision. Select the corresponding adjustment result to review precision; these records must not be interchanged.')
  }
  if (!confirmed && !hasProfessionalQuantity && /^(?:\d+[.)]\s+)?源快照一致性/.test(firstSentence) && /(?:若|如果|变更|旧快照)/.test(plain)) {
    return statement('资料更新后需要重新核查：源文件变更后，已有记录可能仍对应修改前的资料，请确认后再引用。', 'Recheck after source data changes: existing records may still describe the earlier data. Confirm their applicability before citing them.')
  }
  if (!confirmed && !hasProfessionalQuantity && /^(?:\d+[.)]\s+)?选择器字段(?:限制|未全部可传)/.test(firstSentence)) {
    return statement('本次尚未完成逐项依据核查。请在结果页重新选择需要复核的成果记录后继续。', 'Individual supporting records have not all been verified. Select the result to review again before continuing.')
  }
  if (!confirmed && !hasProfessionalQuantity && /^[-*]\s+平差记录\s+inputHash/.test(firstSentence) && /不同|不一致/.test(firstSentence)) {
    return statement('需核对平差资料与当前源文件的一致性。', 'Check that the adjustment data matches the current source file.')
  }
  return line
}

function removeInlineDeveloperReferences(text: string): string {
  // Strip developer tokens only; an API response or a sentence containing a
  // source path can still carry the only available measurement or restriction.
  return text
    .replace(/\b(?:npm|pnpm|yarn|bun|git|curl|wget|node|python|pip|tsx|npx)\s+(?:run|test|install|exec|build|typecheck|lint|start|dev|check)\b(?:\s+[a-z][a-z0-9:._-]*)?/gi, '')
    .replace(/(?:\/Users\/|\/private\/|[A-Za-z]:[\\/]|(?:src|kun|scripts|tests|components)\/)[\w./-]+\.(?:ts|tsx|js|jsx|yaml|yml|sql|sh|py)\b(?::\d+)?/gi, '')
    .replace(/^\s*(?:源代码|source\s+code)\s*[:：]?\s*[。.]?\s*$/i, '')
    .replace(/\b(?:requestId|workflowId|correlationId|traceId|sessionId)\s*[:=]\s*[a-z0-9_-]+/gi, '')
    .replace(/(?:\btool(?:\s+(?:id|name))?|工具(?:名|名称|ID)?)\s*[:=：]\s*[a-z][a-z0-9_.:/-]*/gi, '')
    .replace(/\/v\d+\/engineering\/[a-z0-9_/-]+/gi, '')
    .replace(/(?<![\w./-])(?:API|MCP|SDK|CLI|DOM|IPC|endpoint)\b|\bHTTP\s+\d{3}\b/gi, '')
    // Keep the measurement conclusion while hiding product implementation
    // labels that can appear in model-generated answers.
    .replace(/\bAttachment\s+Store\b/gi, '')
    // Leave a sentence's leading article in place so removing the service
    // label does not change a professional finding's capitalization.
    .replace(/\b(?:structured\s+)?local\s+(?:processing|calculation|execution)\s+service(?:\s+result)?\b\s*(?:returned|produced|result)?\s*(?:the\s+)?/gi, '')
    .replace(/\b(?:structured\s+)?(?:local\s+processing|survey\s+calculation)\s+service\s+result\b/gi, '')
    .replace(/模型\s*只接收摘要和证据索引\s*[：:，,；;]?/gi, '')
    .replace(/(?:the\s+)?model\s+(?:only\s+receives\s+summaries\s+and\s+evidence\s+indexes|receives\s+summaries\s+and\s+evidence\s+indexes\s+only)\s*[：:，,；;]?/gi, '')
    .replace(/\bmodel\s+(?:name|名称)\b[：:，,；;]?/gi, '')
    .replace(/本地计算服务(?:结果)?\s*[（(]?\s*不是模型(?:的)?猜测\s*[）)]?\s*[：:，,；;]?/gi, '')
    .replace(/\bnot\s+a\s+model\s+guess\b[：:，,]?\s*/gi, '')
    .replace(/不是模型(?:的)?猜测\s*[：:，,；;]?\s*/gi, '')
    .replace(/^[,，;；]\s*/g, '')
    .replace(/附件由\s*(?=托管|managed\b)/gi, '')
    // A line that only states where data is hosted has no survey meaning.
    .replace(/^\s*(?:托管|managed\s+by)\s*[。.!！]?\s*$/i, '')
    // Removing an implementation-only clause can leave a sentence fragment.
    .replace(/^\s*(?:the|a|an)\s*[。.!！]?\s*$/i, '')
    .replace(/[,，;；]\s*([。！？!?])/g, '$1')
    .replace(/[,，;；]\s*$/g, '')
    .trim()
}

function stripInternalFragments(line: string, language: string): string {
  const english = language.toLowerCase().startsWith('en')
  const label = (chinese: string, translated: string): string => english ? translated : chinese
  return line
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(?:^|(?<=。))选择器中[^。]*(?:原样传入|核验来源|定位到该点精度记录作答|点位精度即对应 point-precision)[。]?/g, '')
    .replace(/原因：该引用缺少\s*statistics\s*类型证据的必需字段[^。]*。/g, '所选资料的定位信息不完整，未能完成核查。')
    .replace(/请提供完整引用后重新读取/g, '请重新选择相应成果记录后核查')
    .replace(/需核对证据索引\/选择器路径\s*\[[^\]]+\]\s*是否仍有效，或重新取得有效引用后再读取/g, '请重新选择相应成果记录后核查')
    .replace(/（证据索引、记录版本或选择器路径有效性可能已变化）/g, '')
    .replace(/若目标是\s*(\S+)\s*精度，应引用平差类\s*typedEvidence（[^）]*）/g, '若需核查 $1 的精度，请选择对应平差成果')
    .replace(/\bsourceEligibility\.status\s*[:=]\s*blocked\b/gi, label('资料暂不能用于计算', 'Data is blocked from calculation'))
    .replace(/\bsourceEligibility\.status\s*[:=]\s*eligible\b/gi, label('资料可进入计算前检查', 'Data can proceed to pre-calculation checks'))
    .replace(/\bsourceEligibility\.eligible\s*[:=]\s*false\b/gi, label('资料暂不能用于计算', 'Data is blocked from calculation'))
    .replace(/\bsourceAdmission\.status\s*[:=]\s*blocked\b/gi, label('资料暂不能用于计算', 'Data is blocked from calculation'))
    .replace(/(\|\s*)sourceEligibility(?:\.eligible|\.status)?\s*(?=\|)/gi, label('$1资料可用性 ', '$1Data eligibility '))
    .replace(/(\|\s*)sourceAdmission(?:\.status)?\s*(?=\|)/gi, label('$1资料可用性 ', '$1Data eligibility '))
    .replace(/(\|\s*)standardConformity\s*(?=\|)/gi, label('$1规范符合性 ', '$1Standards conformity '))
    .replace(/(\|\s*)humanSignatureVerification\s*(?=\|)/gi, label('$1专业签认核验 ', '$1Professional signoff verification '))
    .replace(/(\|\s*)precision\.passed\s*(?=\|)/gi, label('$1精度检查是否通过 ', '$1Precision check passed '))
    .replace(/(\|\s*)blocked\s*(?=\|)/gi, label('$1暂不能用于计算 ', '$1Blocked from calculation '))
    .replace(/\binvalid-reference\b/gi, label('所选资料未能核验', 'selected record could not be verified'))
    .replace(/\bsurvey_(?:read_context|read_evidence)\b/gi, label('资料核查', 'record verification'))
    .replace(/[（(]与选择器一致[）)]/g, '')
    .replace(/\b(?:workwise|railwise)-survey-[a-z0-9.-]+\b/gi, '')
    .replace(/(?:算法|版本)\s*(?=[，；;,:：)）])/g, '')
    .replace(/\bcosa-in[12]-\d+-backsight-reset\b/gi, label('后视归零方向', 'Backsight zero direction'))
    .replace(/\bcosa-in[12]-\d+-(?:direction|distance|height-difference)\b/gi, label('原始观测', 'Source observation'))
    .replace(/\bplane-control\b/gi, label('平面控制网', 'Plane control network'))
    .replace(/\bunit-mahalanobis\b/gi, label('单位马氏半径', 'Unit Mahalanobis radius'))
    .replace(/\bstandardError\b/gi, label('中误差', 'Standard error'))
    .replace(/\bthresholds\b/gi, label('限差设置', 'Tolerance settings'))
    .replace(/\{\s*\}/g, '')
    .replace(/规范符合性\s*(?:[:=：]\s*)?not-evaluated/gi, '规范符合性尚未评估')
    .replace(/人员签认\s*(?:[:=：]\s*)?not-evaluated/gi, '人员签认尚未核验')
    .replace(/standardConformity\s*与人员签认均为\s*not-evaluated/gi, '规范符合性与人员签认均尚未评估')
    .replace(/调用方声明未被认证/g, '所提供声明未经独立核实')
    .replace(/\bcorrectionState(?=[（(])/gi, label('改正项状态', 'Observation correction status'))
    .replace(/(改正项状态[（(][^)）]*[）)])\s*均为\s*false\b/gi, '$1均未施加')
    .replace(/(投影归化|投影归算|对中|棱镜常数|气象)\s*均\s*false\b/gi, '$1均未施加')
    .replace(/\bsourceEligibility\.eligible\s*[:=]\s*true\b/gi, label('资料可进入计算前检查', 'Data can proceed to pre-calculation checks'))
    .replace(/\bsourceAdmission(?:\.status)?\s*(?:[:=：]|为)?\s*/gi, label('资料可用性：', 'Source availability: '))
    .replace(/\bqualityStatus\s*[:=：]?\s*validated\b/gi, label('资料质量已校核', 'Data quality checked'))
    .replace(/\bstatus\s+open\b/gi, label('仍待处理', 'Review still required'))
    .replace(/\bknown\s*\|\s*false\b/gi, label('是否已知点 | 否', 'Known control point | No'))
    .replace(/\bknown\s*\|\s*true\b/gi, label('是否已知点 | 是', 'Known control point | Yes'))
    .replace(/\bknown-point\b/gi, label('已知点', 'Known point'))
    .replace(/\bunknown-point\b/gi, label('未知点', 'Unknown point'))
    .replace(/\bknown(?=\s*(?:[|（(]|点|$))/gi, label('已知点', 'Known point'))
    .replace(/\bunknown(?=\s*(?:[|（(]|点|$))/gi, label('未知点', 'Unknown point'))
    .replace(/(\|\s*)id(\s*\|)/gi, label('$1点号$2', '$1Point$2'))
    .replace(/\b(?:typedEvidence|typed)\s*(?:证据)?/gi, label('所选资料', 'selected record'))
    .replace(/类型化证据/g, '所选资料')
    .replace(/经严格读取器认证|被严格读取器认证/g, '完成资料核查')
    .replace(/严格读取器(?:重新验证)?/g, '资料核查')
    .replace(/完整证据引用|当前有效的\s*所选资料\s*引用/g, '相应成果记录')
    .replace(/\bcontext\s*接口/g, '资料核查')
    .replace(/\bcontext\b/gi, label('当前资料', 'current data'))
    .replace(/\badjustment\b(?=\s*[）)])/gi, label('平差成果', 'adjustment result'))
    .replace(/\bnetwork\s*\/\s*(?:unknownPoints|未知点)\[\d+\]\s*\/\s*/gi, label('未知点 ', 'Unknown point '))
    .replace(/\bunknownPoints\[\d+\]/gi, label('未知点资料', 'Unknown-point data'))
    .replace(/源记录锚点/g, '原始记录位置')
    .replace(/由解析器按/g, '按')
    .replace(/\*\*读取边界\*\*：只读；未启动新计算；无审批能力；/g, '**核查范围**：本轮仅核查已有资料，未重新计算；')
    .replace(/精确读取/g, '核查资料')
    .replace(/重新做核查资料/g, '重新核查资料')
    .replace(/(?:项目)?上下文/g, '项目资料')
    .replace(/项目元数据/g, '项目设置')
    .replace(/\b(?:project|network|source|input|output|record|adjustment|parser|calculation)(?:Hash|Revision|Id)\s*(?:[:=：]\s*|\s+)[a-z0-9._-]+(?:…|\.\.\.)?/gi, '')
    .replace(/\b(?:algorithmVersion|parserVersion|parserSourceHash|sourceSha256|contextHash)\s*(?:[:=：]\s*|\s+)[a-z0-9._-]+(?:…|\.\.\.)?/gi, '')
    .replace(/\b(?:sha-?256|hash|revision|rev)\s*(?:[:=：]\s*|\s+)[a-z0-9._-]+(?:…|\.\.\.)?/gi, '')
    .replace(/\b(?:workwise|railwise)-[a-z0-9.-]+\b/gi, '')
    .replace(/\b(?:algorithmVersion|parserVersion)\b\s*/gi, '')
    .replace(/\b(?:inputHash|calculationHash|diagnosticsVersion|adjustmentId)\b(?:\s*[、/，]\s*(?:inputHash|calculationHash|diagnosticsVersion|adjustmentId))*/g, '')
    .replace(/用其精确的\s*所选资料引用读取/g, '从结果页选择对应记录')
    .replace(/提供对应相应成果记录/g, '选择相应成果记录')
    .replace(/（或先核对网络记录\/证据索引为何导致引用失效）/g, '')
    .replace(/我再用资料核查后再给出认证结论/g, '完成核查后再给出专业分析')
    // Translate structured field names before the protocol-line check so that
    // a useful engineering review such as "coordinateSystem=待确认" stays
    // meaningful without exposing the stored object shape.
    .replace(/\bcoordinateSystem\s*[:=：]\s*["“]?([^,，、;；。)）"”]+)["”]?/gi, label('平面坐标系统：$1', 'Coordinate system: $1'))
    .replace(/\bverticalDatum\s*[:=：]\s*["“]?([^,，、;；。)）"”]+)["”]?/gi, label('高程基准：$1', 'Vertical datum: $1'))
    .replace(/\bcoordinateSystem\b/gi, label('平面坐标系统', 'Coordinate system'))
    .replace(/\bverticalDatum\b/gi, label('高程基准', 'Vertical datum'))
    .replace(/\bpoint-precision\b/gi, label('点位精度', 'Point precision'))
    .replace(/\bxyErrorEllipse\b/gi, label('误差椭圆', 'Error ellipse'))
    .replace(/\bcovarianceXY\b/gi, label('协方差', 'Covariance'))
    .replace(/\b(?:precision\.)?maxPointStdDev\b/gi, label('最大点位中误差', 'Maximum point standard error'))
    .replace(/\bdegreesOfFreedom\b/gi, label('自由度', 'Degrees of freedom'))
    .replace(/\bobservationCount\b/gi, label('观测数', 'Observation count'))
    .replace(/\bstationCount\b/gi, label('测站数', 'Station count'))
    .replace(/\bpointCount\b/gi, label('点数', 'Point count'))
    .replace(/\bunknownPoints\b/gi, label('未知点', 'Unknown points'))
    .replace(/\bknownPoints\b/gi, label('已知点', 'Known points'))
    .replace(/\bvarianceFactorEstimated\s*[:=]\s*true\b/gi, label('单位权方差因子为估计值', 'The variance factor is estimated'))
    .replace(/\bvarianceFactorEstimated\s*[:=]\s*false\b/gi, label('单位权方差因子未估计', 'The variance factor has not been estimated'))
    .replace(/\bestimated\s*=\s*是/gi, '为估计值')
    .replace(/\bestimated\s*=\s*否/gi, '非估计值')
    .replace(/\bestimated\s*=\s*true\b/gi, label('为估计值', 'is estimated'))
    .replace(/\bestimated\s*=\s*false\b/gi, label('未估计', 'is not estimated'))
    .replace(/\bvarianceFactorEstimated\b/gi, label('单位权方差因子是否估计', 'Variance factor estimation'))
    .replace(/\bvarianceFactor\b/gi, label('单位权方差因子', 'Variance factor'))
    .replace(/\bstatisticalSummary\s*[:=]\s*null\b/gi, label('未提供统计检验摘要', 'No statistical test summary is available'))
    .replace(/\bstatisticalSummary\b/gi, label('统计摘要', 'Statistical summary'))
    // These limitations are part of the engineering conclusion, even when a
    // historical answer expresses them as stored fields. Never erase them.
    .replace(/\bstandardConformity\s*[:=]\s*not-evaluated\b/gi, label('尚未核查规范符合性', 'Standards conformity has not been evaluated'))
    .replace(/\bhumanSignatureVerification\s*[:=]\s*not-evaluated\b/gi, label('尚未核验专业签认', 'Professional signoff has not been verified'))
    .replace(/\bcallerDeclarationsAuthenticated\s*[:=]\s*false\b/gi, label('所提供声明未经独立核实', 'Provided declarations have not been independently verified'))
    .replace(/\breadOnly\s*[:=]\s*(?:true|false)\b/gi, '')
    .replace(/\brawFields\.recordType\b/gi, label('记录类型', 'Record type'))
    .replace(/\brawFields\.(?=stationCircleOrientation|role|outlier|rawUnit|rawValue|directionReference|coordinateAxisOrder)/gi, '')
    .replace(/\bstationCircleOrientation\s*[:=]\s*true\b/gi, label('采用测站度盘定向模型', 'Station-circle orientation model is used'))
    .replace(/\bstationCircleOrientation\s*[:=]\s*false\b/gi, label('未采用测站度盘定向模型', 'Station-circle orientation model is not used'))
    .replace(/\bstationCircleOrientation\b/gi, label('测站度盘定向', 'Station-circle orientation'))
    .replace(/\brole\s*[:=：]\s*/gi, label('观测作用：', 'Observation role: '))
    .replace(/\b(?:cosa-)?backsight-reset\b/gi, label('后视归零方向', 'Backsight zero direction'))
    .replace(/\bforesight\b/gi, label('前视方向', 'Foresight direction'))
    .replace(/\boutlier\s*[:=]\s*false\b/gi, label('未标记异常观测', 'No outlier flag'))
    .replace(/\boutlier\s*[:=]\s*true\b/gi, label('已标记异常观测，需复核', 'Observation flagged as an outlier; review required'))
    .replace(/\boutlier\b/gi, label('异常观测标记', 'outlier'))
    .replace(/\brawUnit\b/gi, label('原始单位', 'Original unit'))
    .replace(/\brawValue\b/gi, label('原始读数', 'Original reading'))
    .replace(/\bcosa-degree-dot-mmss\b/gi, label('度.分秒（DDD.MMSS）', 'degrees.minutes-seconds (DDD.MMSS)'))
    .replace(/\bdirectionReference\b/gi, label('方向观测基准', 'Direction reference'))
    .replace(/\bcosa-station-circle\b/gi, label('测站度盘方向', 'Station-circle direction'))
    .replace(/\bcoordinateAxisOrder\b/gi, label('坐标轴约定', 'Coordinate axes'))
    .replace(/\bnorth-east\b/gi, label('X 为北坐标、Y 为东坐标', 'X is northing and Y is easting'))
    .replace(/\bpointClass\b/gi, label('点位类别', 'Point class'))
    .replace(/\bknown\s*[:=]\s*true\b/gi, label('是否已知点：是', 'Known control point: yes'))
    .replace(/\bknown\s*[:=]\s*false\b/gi, label('是否已知点：否', 'Known control point: no'))
    .replace(/\bprecision\.passed\s*[:=]\s*true\b/gi, label('精度检查通过', 'Precision check passed'))
    .replace(/\bprecision\.passed\s*[:=]\s*false\b/gi, label('精度检查未通过', 'Precision check failed'))
    .replace(/\bpassed\s*[:=]\s*true\b/gi, label('通过', 'Check passed'))
    .replace(/\bpassed\s*[:=]\s*false\b/gi, label('未通过', 'Check failed'))
    .replace(/\bvalidation\s*[:=]\s*valid\b/gi, label('数值校核通过', 'Numerical validation passed'))
    .replace(/\bvalidation\s*[:=]\s*invalid\b/gi, label('数值校核未通过', 'Numerical validation failed'))
    .replace(/\bseverity\s*[:=]\s*blocking\b/gi, label('阻断问题', 'Blocking issue'))
    .replace(/\bseverity\s*[:=]\s*warning\b/gi, label('警告', 'Warning'))
    .replace(/\bseverity\s*[:=]\s*info\b/gi, label('提示', 'Note'))
    .replace(/\b(?:format_detected|qualityFinding)\b/gi, label('质量提示', 'Quality finding'))
    .replace(/\bstatus\s*[:=]\s*open\b/gi, label('仍待处理', 'Review still required'))
    .replace(/(?:质量标记|Quality flag)\s*[:：]?\s*\[\s*["“']?([^\]"”']+)["”']?\s*\]/gi, `${label('质量标记：', 'Quality flag: ')}$1`)
    .replace(/\bsourceRow\s*\/\s*sourceLocator\b/gi, label('原始记录位置', 'Source record location'))
    .replace(/\bsourceRow\b/gi, label('原始记录行', 'Source record line'))
    .replace(/\bsourceLocator\b/gi, label('原始记录位置', 'Source record location'))
    .replace(/\brecordType\b/gi, label('记录类型', 'Record type'))
    .replace(/\bcosa-station-polar-rigid-initialization\b/gi, label('极坐标刚性初始化', 'Polar rigid initialization'))
    .replace(/\binitialCoordinateMethod\b/gi, label('初始坐标确定方法', 'Initial coordinate method'))
    .replace(/\binitialCoordinateDistanceRmsMetres\b/gi, label('初始坐标距离均方根', 'Initial coordinate distance RMS'))
    .replace(/\bcorrectionState\s*(?:[:=：]\s*)?(?:全部\s*|all\s*)?false\b/gi, label('改正项均未施加', 'No observation corrections have been applied'))
    .replace(/\bcorrectionState\b/gi, label('改正项状态', 'Observation correction status'))
    .replace(/\b(?:projectId|networkId|runId|manifestId|adjustmentId|inputAttachmentHash)\s*[:=：]\s*[a-z0-9_.-]+(?:…|\.\.\.)?/gi, '')
    .replace(/\b(?:planId|plan_id|taskId|task_id|threadId|thread_id|toolId|tool_id|executionTurnId|execution_turn_id|sourceSha256|parserSourceHash|contextHash)\s*[:=：]\s*[^\s,，、;；。)）]+/gi, '')
    .replace(/\b(?:sourceSha256|parserSourceHash|contextHash)\s+[a-z0-9._-]+/gi, '')
    .replace(/\b(?:sourceFileHash|outputHash|storedResultsHash|recomputedResultsHash|sourceContextHash)\s*[:=：]\s*[^,，;；。)）]+/gi, '')
    .replace(/\b(?:algorithmVersion|parserVersion)\s*[:=：]\s*[^\s,，、;；。)）]+/gi, '')
    .replace(/\bmetric\s*[:=：]\s*[a-z0-9_-]+/gi, '')
    .replace(/\ba-posteriori\b/gi, english ? 'posterior' : '后验')
    .replace(/\ba-priori\b/gi, english ? 'prior' : '先验')
    .replace(/\bpositive-x toward positive-y,?\s*mod\s*π/gi, label('从 X 轴正向转向 Y 轴正向，方向角以半周为周期', 'from positive X toward positive Y, modulo a half-turn'))
    .replace(/(?:解析器|\bparser)\s*(?:版本)?\s*[a-z0-9._-]+(?:\s+\d+(?:\.\d+)+)?/gi, '')
    .replace(/\bsurvey_finding_[a-z0-9-]+\b(?:…|\.\.\.)?/gi, '')
    .replace(/\bstatus\s+仍为\s+open\b/gi, '该提示仍待处理')
    .replace(/\b(?:走|采用)\s*(?:策略|strategy)\b/gi, '按当前资料检查规则')
    .replace(/\bknown-point\b/gi, label('已知点', 'Known point'))
    .replace(/\bunknown-point\b/gi, label('未知点', 'Unknown point'))
    .replace(/\bstation\b/gi, label('测站', 'Station'))
    .replace(/`([^`]+)`/g, '$1')
    // Remove the metadata portion while retaining the professional statement
    // around it, e.g. "源文件：COSA.in2（sha256=…）" stays useful to a surveyor.
    .replace(/[（(]([^（）()\n]*)[）)]/g, (parenthesis, contents: string) => {
      const metadata = /contextHash|projectRevision|networkRevision|sourceSha256|parserSourceHash|qualityFinding|callerDeclarationsAuthenticated|humanSignatureVerification|standardConformity|readOnly|sha-?256|\bhash\b|\brevision\b|selector|typedEvidence|rawSourceIntegrity|sourceEligibility|current-admissible|\bparser\b/i
      if (!metadata.test(contents)) return parenthesis
      const professional = contents.split(/[,，、;；]/).filter(clause => !metadata.test(clause) && clause.trim()).join(english ? '; ' : '；')
      return professional ? `${parenthesis[0]}${professional}${parenthesis.at(-1)}` : ''
    })
    .replace(/\b(?:contextHash|projectRevision|networkRevision|sourceSha256|parserSourceHash|callerDeclarationsAuthenticated|humanSignatureVerification|standardConformity|readOnly|inputAttachmentHash)\s*[:=：]\s*[^,，;；。)]+/gi, '')
    .replace(/\brawSourceIntegrity\s*[:=：]?\s*verified\b/gi, label('原始资料完整性已校验', 'Source data integrity has been checked'))
    .replace(/\brawSourceIntegrity\s*[:=：]?\s*failed\b/gi, label('原始资料完整性检查未通过', 'Source data integrity check failed'))
    .replace(/\bsourceEligibility\s*[:=：]?\s*(?:eligible|current-admissible)\b/gi, label('资料可进入计算前检查', 'Data can proceed to pre-calculation checks'))
    .replace(/\bcurrent-admissible\b/gi, label('资料可用于处理', 'Data is available for processing'))
    .replace(/\bverified\b/gi, match => english ? match : '已核验')
    .replace(/\brawFields\.[a-z][a-z0-9_]*\s*[:=]\s*(?:true|false|null|undefined|[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(?=[\s,，;；。)）]|$)/gi, '')
    .replace(/\b(?:sha-?256|hash|revision|parser|selector|typedEvidence|schemaVersion|sourceRecordId)\b(?:\s*[:=：-]?\s*[a-z0-9._-]+)?(?:…|\.\.\.)?/gi, '')
    .replace(internalToken, '')
    .replace(modelToken, '')
    .replace(/\bRuntime\b/gi, '')
    .replace(/(?<![\w./-])(?:JSON|API|MCP|SDK|CLI|UI|DOM|HTTP|IPC)\b/gi, '')
    .replace(/误差椭圆\s*[.:：]\s*协方差/g, '误差椭圆协方差')
    .replace(/\s+([，。；：,.;:)）])/g, '$1')
    .replace(/([（(])\s*[,，;；:：]+/g, '$1')
    .replace(/[,，;；:：]+\s*([）)])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    // Removing identifiers must not leave stray punctuation in the sentence.
    .replace(/(^|[：:；;，,])\s*[-–—]\s*(?=后视归零方向)/g, '$1')
    .replace(/\bpositive-x-toward-positive-y-mod-pi\b/gi, label('从 X 轴正向转向 Y 轴正向，方向角以半周为周期', 'from positive X toward positive Y, modulo a half-turn'))
    .replace(/\bqualityStatus\s*[:=]\s*validated\b/gi, label('资料质量已校核', 'Data quality checked'))
    .replace(/\b(?:sourceAdmission\.)?status\s*[:=]\s*current-admissible\b/gi, label('资料可用于处理', 'Data is available for processing'))
    .replace(/\b(?:sourceAdmission\.)?status\s*[:=]\s*verified\b/gi, label('来源完整性已核验', 'Source integrity checked'))
    .replace(/(?:源|文件|资料)?哈希(?:值)?\s*(?:一致|不一致)/gi, '')
    .replace(/(?:文件|资料)?哈希(?:值)?/gi, '')
    .replace(/(?:解析)?账本\s*\d*\s*条?(?:、无错误)?/gi, '')
    .replace(/(?:生成于|创建于)\s*\d{4}-\d{2}-\d{2}(?:T|\s+)\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z)?/gi, '')
    .replace(/(?:当前记录|当前资料)\s*未过期\s*[:：]?/gi, '')
    .replace(/(?:网络|平差)?修订\s*(?:仍为|为)?\s*\d+/gi, '')
    .replace(/(?:本会话早前读取|来自实时(?:项目)?资料|未做任何计算(?:或替代记录)?)/gi, '')
    .replace(/\bcompleted\s*\/\s*valid\b/gi, label('已完成 / 数值校核通过', 'Completed / numerical validation passed'))
    .replace(/\b(?:status\s*[:=]\s*)?open\b/gi, match => english ? match : '仍待处理')
    .replace(/\b(?:status\s*[:=]\s*)?completed\b/gi, match => english ? match : '已完成')
    .replace(/\bvalid\b/gi, match => english ? match : '有效')
    .replace(/\b(?:status\s*[:=]\s*)?validated\b/gi, label('已校核', 'Validated'))
    .replace(/\b(?:severity\s*[:=]\s*)?warning\b/gi, label('警告', 'Warning'))
    .replace(/\b(?:qualityStatus|sourceAdmission|sourceEligibility|rawSourceIntegrity)\b/g, '')
    .replace(/\bstatus\s*[:=]\s*resolved\b/gi, label('所选资料已找到', 'Selected record found'))
    .replace(/\*{4,}/g, '')
    .replace(/仍为\s*(?=[,，;；)）])/g, '')
    .replace(/[,，;；]\s*[,，;；]+/g, '；')
    .replace(/[（(]\s*[）)]/g, '')
    .replace(/([：:])\s*[，,；;]/g, '$1')
    .replace(/[，,；;]\s*([。.!])/g, '$1')
    .replace(/(已知点|未知点)\s+点/g, '$1')
    .replace(/极坐标刚性初始化（极坐标刚性初始化）/g, '极坐标刚性初始化')
    .replace(/点位精度（点位精度，中误差）/g, '点位中误差')
    .replace(/(?:平差记录|平差成果)（平差成果）/g, '平差成果')
    .replace(/源准入：资料可用性：/g, '资料可用性：')
    .replace(/[（(]\s*[）)]/g, '')
    .trim()
}

/**
 * Older Survey conversations were written before the professional surface
 * existed. Their answers often contain a whole protocol sentence around the
 * useful measurement, and removing individual field names leaves fragments
 * such as "调整、网络，与一致". Rewrite those known sentence shapes before
 * the field-level filter runs so the stored answer remains readable.
 */
function rewriteLegacyProfessionalLine(line: string, language: string, selectedPointId?: string): string {
  const english = language.toLowerCase().startsWith('en')
  const label = (chinese: string, translated: string): string => english ? translated : chinese
  const prefix = line.match(/^(\s*(?:[-*]\s+|\d+[.)]\s+))/)?.[1] ?? ''
  const body = line.slice(prefix.length).trim()
  const pointId = surveyPointId(body) ?? selectedPointId
  const selectedPoint = pointId ?? label('所选点', 'selected point')

  // Historical answers sometimes start with a fetch/revision report and then
  // continue with empty protocol fields after the identifiers are removed.
  // That report does not help a surveyor and should not survive as a broken
  // sentence such as "当前记录未过期：网络修订仍为…".
  if (/^(?:已按|随后我|本轮|本次).*(?:精确|遗留|选择器|选择|读取|核查).*(?:当前记录|当前资料|实时资料|生成于|创建于|修订|哈希|版本|未过期|不变|未做任何计算)/i.test(body)
    && !/\d+(?:\.\d+)?\s*(?:mm|m\b|rad\b|[°′″μ]|毫米|米|秒)/i.test(body)) return ''
  if (/^(?:观测|记录|资料)(?:明细|内容)?\s*(?:来自|读取自).*(?:本会话|实时|早前|已解析记录)/i.test(body)) return ''

  // The format-catalog warning is a professional preflight action. Keep the
  // action and blocking rule while hiding catalog names and strategy IDs.
  if (/(?:format_detected|qualityFinding|质量提示|质量发现)/i.test(body)
    && /(?:adjustment-ready|可以开始计算|策略|需继续完成|继续完成).*(?:基准|控制点|观测|拓扑|闭合|精度)/i.test(body)) {
    return `${prefix}${label(
      '资料质量提示仍待处理：请继续完成基准、控制点、观测角色、拓扑、闭合和精度校验；任一条件不满足都会阻断平差。',
      'A data-quality review is still required: confirm the datum, control points, observation roles, topology, closure and precision; any failed condition blocks adjustment.'
    )}`
  }

  // Evidence and selector headings should read as survey sections, not as
  // storage-object descriptions.
  if (/(?:本条|该条).*(?:typedEvidence|所选资料|selected record).*(?:network|未知点|unknown).*(?:实际存了什么|内容)/i.test(body)) {
    return `${prefix}${label(`所选记录中的 ${selectedPoint} 初始坐标`, `${selectedPoint} initial coordinates in the selected record`)}`
  }
  if (/平差后的?\s*(?:[A-Za-z][A-Za-z0-9_-]{0,31}|所选点)\s*结果.*(?:平差记录|所选资料|selected record)/i.test(body)) {
    return `${prefix}${label(`平差后的 ${selectedPoint} 结果`, `Adjusted ${selectedPoint} result`)}`
  }
  if (/(?:引用完整保留|selector|选择器|path|identity).*(?:解析成功|存储值|实际存了什么)/i.test(body)) {
    return label(`以下为所选记录中的 ${selectedPoint} 初始坐标（单位：m）：`, `The selected record contains the following ${selectedPoint} initial coordinates (unit: m):`)
  }

  // These lines only describe how the answer was fetched. The professional
  // findings and limitations follow in their own sections.
  if (/tool_storm_suppressed/i.test(body) && /(?:已成功读取|successfully read|(?:[A-Za-z][A-Za-z0-9_-]{0,31}\s+)?仍需复核|still requires review)/i.test(body)) return line
  if (!professionalContent.test(body) && /(?:已按|随后我|本轮.*(?:读取|调用)|当前记录未过期|本次读取的是当前记录|未做任何计算|实时项目资料|严格读取|精确选择器|tool_storm_suppressed|运行时重复调用保护|调用返回)/i.test(body)) return ''
  if (!professionalContent.test(body)
    && /(?:networkRevision|projectRevision|adjustment(?:Id|[_-][a-z0-9]|\s+(?:revision|record))|sourceSha256|inputHash|parserSourceHash|sourceAdmission|sourceEligibility|contextHash|identity\s+id=|metric\s*[:=：])/i.test(body)
    && !/(?:结果|原始依据|需要复核|复核的问题|结果说明)/.test(body)) return ''
  return line
}

function cleanResidualProfessionalFragments(line: string, language: string): string {
  const english = language.toLowerCase().startsWith('en')
  const label = (chinese: string, translated: string): string => english ? translated : chinese
  return line
    .replace(/\bmetric\s*[:=：]\s*([^,，)）]+)/gi, '$1')
    .replace(/\bnetwork\s*\/\s*(?:未知点资料|unknown[- ]point data)\s*(?:\/\s*)?/gi, '')
    .replace(/\bidentity\s+(?:id\s*[=:：]\s*)?["“']?[A-Za-z0-9_-]+["”']?/gi, '')
    .replace(/\b(?:network|adjustment)\s+(?:revision|record|修订)\s*[，,、；;：:]*/gi, '')
    .replace(/\b(?:direction)（方向）/gi, label('方向', 'Direction'))
    .replace(/\b(?:quality flag|质量标记)\s*[:：]?\s*\[\s*["“']?([^\]"”']+)["”']?\s*\]/gi, `${label('质量标记：', 'Quality flag: ')}$1`)
    .replace(/(?:source|来源|源)\s*[。.]$/gi, '。')
    // Historical source lines lose their hash/version clause first. Remove
    // the remaining reader/version label as a whole so it cannot turn into
    // "资料读取 cosa-in2-资料读取 0.3.0" on the work surface.
    .replace(/\b(?:资料读取|data\s+reader)\s+(?:[a-z][a-z0-9-]*)(?:-(?:资料读取|data\s+reader))?\s*(?:版本\s*)?v?\d+(?:\.\d+)+\b/gi, '')
    .replace(/\b(?:[a-z][a-z0-9-]*-(?:资料读取|data\s+reader))\s*(?:版本\s*)?v?\d+(?:\.\d+)+\b/gi, '')
    .replace(/(?:由|按)?\s*(?:资料读取|data\s+reader)(?=\s*(?:按|。|；|;|，|,|$))/gi, '')
    .replace(/[（(]\s*与网络\s*(?:一致)?\s*[）)]/g, '')
    .replace(/[（(]\s*与当前源文件\s*(?:一致)?\s*[）)]/g, '')
    .replace(/\bprecision\.passed\b/gi, label('精度检查', 'Precision check'))
    .replace(/(?:与|、|及)\s*人工签字验证\s*均?未评估/gi, label('规范符合性与专业签认均尚未评估', 'Standards conformity and professional signoff have not been evaluated'))
    .replace(/(?:与|、|及)\s*专业签认(?:核验)?\s*均?未评估/gi, label('规范符合性与专业签认均尚未评估', 'Standards conformity and professional signoff have not been evaluated'))
    .replace(/(?:运行时|本次处理)\s*只(?:做了|核验了?)\s*源完整性(?:核验|检查)?\s*(?:与|和)?/gi, label('本次仅核查了资料完整性', 'Only source completeness was checked'))
    .replace(/(?<!来)源\s*[，,；;]\s*(?=(?:资料读取|data\s+reader|资料可进入|原始资料|资料完整性|data\s+availability))/gi, '')
    .replace(/(?<!来)源\s*[，,；;]\s*/gi, '')
    .replace(/资料可进入计算前检查\s*[、，,]\s*无\s*其他问题/gi, label('资料可进入计算前检查', 'Data can proceed to pre-calculation checks'))
    // Historical answers sometimes offer to start an internal project-change
    // operation. That is a product action, not a survey conclusion; remove the
    // complete sentence so the answer ends with the professional finding.
    .replace(/(?:^|(?<=[。！？.!?]))\s*(?:如果你需要|如需|如果希望|如需就)[^。！？.!?\n]*(?:我可以|可以发起|发起计划)[^。！？.!?\n]*[。！？.!?]?/gi, '')
    .replace(/(?:请告诉我|请告知)(?:你希望|你要|需要)?(?:修改的)?字段/gi, '')
    .replace(/(?:我可以|可以)\s*发起\s*[；;，,]?\s*请(?:告诉我|告知)(?:你希望|需要)?(?:修改的)?字段/gi, label('请告知需要修改的字段', 'Tell me which fields to change'))
    .replace(/(?:我可以|可以)\s*发起\s*[；;，,]?/gi, '')
    .replace(/(?:开放\s*)?其他问题\s*的后续处理发起计划，?请告诉我/gi, '请告诉我是否需要继续处理')
    .replace(/(精度检查|Precision check)\s+(?=只表示|only\b)/gi, '$1')
    // Historical answers can leave an internal flag or field list behind
    // after the field name has been removed. Collapse those fragments so a
    // surveyor never sees empty object punctuation in a conclusion.
    .replace(/(?:运行时|本次处理)\s*只做了?\s*源完整性核验\s*[（(](?:未提供|、|，|,|;|；|:|：)?[）)]/gi, label('本次仅核查了资料完整性', 'Only source completeness was checked for this review'))
    .replace(/（\s*(?:、|，|,|;|；|:|：)\s*）/g, '（未提供）')
    .replace(/\(\s*(?:,|;|:)\s*\)/g, '(not provided)')
    .replace(/（\s*[、，,；;：:]\s*/g, '（')
    .replace(/\(\s*[,;:]\s*/g, '(')
    .replace(/\s*[、，,；;：:]\s*）/g, '）')
    .replace(/\s*[,;:]\s*\)/g, ')')
    .replace(/运行时(?:阈值|检查|判定)/g, '当前检查阈值')
    .replace(/\b(?:runtime|Runtime)\s+(?:threshold|check|判定)/gi, english ? 'current check threshold' : '当前检查阈值')
    .replace(/\b(?:runtime|Runtime)\b/gi, english ? 'current processing' : '本次处理')
    .replace(/\bestimated\b/gi, english ? 'estimated' : '为估计值')
    .replace(/点位补读被\s*(?:抑制|阻止)/g, '点位补读未完成')
    .replace(/\b(?:findings?)\b/gi, label('其他问题', 'other findings'))
    .replace(/\b(?:strategy|策略)\b/g, '')
    .replace(/\b(?:unknown|known|adjustment|plane-control|validated|verified|completed|valid|warning|open)\b/gi, match => {
      const translations: Record<string, [string, string]> = {
        unknown: ['未知', 'unknown'], known: ['已知', 'known'], adjustment: ['平差', 'adjustment'],
        'plane-control': ['平面控制网', 'plane control network'], validated: ['已校核', 'validated'],
        verified: ['已核验', 'verified'], completed: ['已完成', 'completed'], valid: ['有效', 'valid'],
        warning: ['警告', 'warning'], open: ['仍待处理', 'open']
      }
      const translated = translations[match.toLowerCase()]
      return translated ? (english ? translated[1] : translated[0]) : match
    })
    .replace(/经\s+确认/g, '确认')
    .replace(/\(\s*确认\s*\)/g, '')
    .replace(/\s*([，。；：,.;:)）])/g, '$1')
    .replace(/([（(])\s*([，。；：,.;:)）])/g, '$1')
    .replace(/[，,；;：:]\s*([。.!！？])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/(^|[：:；;，,])\s*[-–—]\s*(?=后视归零方向)/g, '$1')
    .trim()
}

/**
 * Remove implementation wording that can survive the field-level cleanup in
 * older saved answers. These phrases describe how a record was fetched or
 * stored, rather than what a surveyor should decide from the measurements.
 */
function cleanSurveyorVocabulary(line: string, language: string): string {
  if (language.toLowerCase().startsWith('en')) return line
  return line
    .replace(/源准入(?:状态)?/g, '资料可用性')
    .replace(/源准入：/g, '资料可用性：')
    .replace(/存储值（单位\s*m(?:，记录)?）/g, '所选记录中的初始坐标（单位：m）')
    .replace(/存储值\s*（/g, '所选记录中的数值（')
    .replace(/本次读取明确返回/g, '专业核查说明')
    .replace(/本轮新读取到的统计口径/g, '统计说明')
    .replace(/本次读取未附带统计摘要/g, '本次未提供统计摘要')
    .replace(/网络记录与平差记录口径不同/g, '初始坐标与平差成果口径不同')
    .replace(/网络记录存的是初始坐标/g, '当前记录存的是初始坐标')
    .replace(/网络记录/g, '控制网记录')
    .replace(/网络证据/g, '控制网资料')
    .replace(/存储证据的解释/g, '资料说明')
    .replace(/这条网络资料里/g, '当前资料中')
    .replace(/这条网络证据里/g, '当前资料中')
    .replace(/平差记录中精度指标/g, '平差成果中的精度指标')
    .replace(/网络项目资料/g, '控制网资料')
    .replace(/解析后的初始坐标/g, '初始坐标')
    // A user supplied English declaration must stay intact. Translating only
    // the middle word of a sentence such as "Coordinate datum still requires
    // review" creates a mixed-language statement and changes its meaning.
    .replace(/\bRMS\b/gi, '均方根')
    .replace(/证据边界（[^）]*）/g, '专业核查边界')
    .replace(/证据边界\(([^)]*)\)/g, '专业核查边界')
    .replace(/引用“?([A-Za-z][A-Za-z0-9_-]{0,31}) 结果”?必须取平差记录的调整值/g, (_, point: string) => `报告中的 ${point} 成果应采用平差后的坐标`)
    .replace(/引用"([A-Za-z][A-Za-z0-9_-]{0,31}) 结果"必须取平差记录的调整值/g, (_, point: string) => `报告中的 ${point} 成果应采用平差后的坐标`)
    .replace(/两份记录并存/g, '初始坐标和调整成果同时保留')
    .replace(/本次读取的是当前记录/g, '本次核查针对当前资料')
    .replace(/（与网络\s*一致）/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/（\s*）/g, '')
    .trim()
}

/** Convert an assistant transcript to user-facing survey findings and actions. */
export function engineeringProfessionalText(text: string, language = appI18n.language): string {
  if (!text.trim()) return text
  const surveyAnswer = text.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think\s*>|$)/gi, '')
  if (!surveyAnswer.trim()) return ''
  const visible: string[] = []
  const selectedPointId = surveyPointId(surveyAnswer)
  // A suppressed evidence read is a substantive limitation. Keep that fact
  // without exposing its internal diagnostic or implying fresh verification.
  if (/tool_storm_suppressed/i.test(surveyAnswer)) visible.push(language.toLowerCase().startsWith('en')
    ? 'Further verification of the selected record was not completed. The related conclusions still require review.'
    : '本次对所选记录的进一步核查未完成，相关结论仍需复核。')
  let fence: 'code' | 'text' | null = null
  for (const rawLine of surveyAnswer.split(/\r?\n/)) {
    // Markdown tables and paragraphs need their original blank separators;
    // dropping them can turn the following engineering conclusion into a row.
    if (!rawLine.trim()) {
      if (fence !== 'code') visible.push('')
      continue
    }
    const historicalLine = historicalEvidenceStatement(rawLine.trim(), language).trim()
    const sourceLine = rewriteLegacyProfessionalLine(historicalLine, language, selectedPointId).trim()
    if (!sourceLine) continue
    // AI may repeat a source diagnostic in its explanation. Apply the same
    // professional wording used by the Survey work surface before rendering it.
    const line = /\bP0\b[^\n]*(?:格式(?:目录|受理目录)|format catalog|admission catalog)/i.test(sourceLine)
      ? surveyDiagnosticText({ message: sourceLine }, language)
      : /\bsurvey_parser_contract\b/i.test(sourceLine)
        ? surveyRuntimeErrorText(JSON.stringify({ error: { message: sourceLine } }), language)
        : sourceLine
    const fenceHeader = /^(?:```|~~~)\s*([A-Za-z0-9_-]*)\s*$/i.exec(line)
    if (fenceHeader) {
      const fenceLanguage = (fenceHeader[1] ?? '').toLowerCase()
      fence = fence ? null : ['text', 'plaintext', 'csv', 'tsv', 'markdown', 'md'].includes(fenceLanguage) ? 'text' : 'code'
      continue
    }
    // Code fences can contain measurement-looking fields alongside JSON or
    // source syntax. Do not let a unit token make structured data user-visible.
    if (fence === 'code') continue
    // Some model responses omit the fence around a JSON object. A quoted
    // field name or object delimiter is enough to identify the payload; keep
    // the surrounding prose and measurement conclusions visible.
    if (structuredPayloadLine.test(line)) continue
    // A declaration or control-flow line is source code even when a string or
    // numeric literal happens to contain a survey unit such as "12 mm".
    if (internalOnlyLine.test(line) || developerSyntaxLine.test(line)) continue
    // A model can return a shell command, source path, or endpoint as a
    // standalone line. These are implementation details, not a survey finding.
    if (codeLikeLine.test(line) && !professionalContent.test(line)) continue
    if (/^(?:Selected Survey evidence|选中的测量证据|Selected evidence)\b/i.test(line)) continue
    if (/^(?:已启用技能|技能|模型|提供商|调用|思考|执行耗时|处理耗时|工具|tool|执行协议|execution\s+(?:plan|protocol)|源代码|source\s+code)\b/i.test(line)
      && !professionalContent.test(line)) continue
    if (/(?:\bmanifest(?:\.json)?\b|execution\s+(?:plan|protocol)|执行协议|源代码|source\s+code)\b/i.test(line)
      && !professionalContent.test(line)) continue
    // Older answers can describe fixtures, parsers, or format catalogs in a
    // standalone sentence. That is developer trace text, even when the
    // sentence also mentions a runtime state; drop it unless it carries a
    // measurement or an actionable survey conclusion.
    if (/(?:\bfixture\b|\bformat\s+(?:catalog|admission)\b|\bsample\s+data\b|\bdata\s+reader\b|格式目录|受理目录|示例资料|资料读取)/i.test(line)
      && !professionalContent.test(line)) continue
    const developerSafeLine = removeInlineDeveloperPayload(removeInlineDeveloperReferences(line))
    if (!developerSafeLine) continue
    const cleaned = cleanSurveyorVocabulary(cleanResidualProfessionalFragments(stripInternalFragments(developerSafeLine, language), language), language)
      // A trace token in a mixed sentence is not grounds to discard measured
      // values or a blocking conclusion. Remove the residual token only.
      .replace(new RegExp(internalPhrase.source, 'gi'), '')
      .replace(/\b(?:execution|processing)\s+(?:completed|started|failed)\b/gi, '')
      .replace(/\b(?:true|false|null|undefined|not-evaluated)\b/gi, (value) => {
        const states: Record<string, [string, string]> = {
          true: ['是', 'Yes'], false: ['否', 'No'], null: ['未提供', 'Not provided'],
          undefined: ['未提供', 'Not provided'], 'not-evaluated': ['尚未评估', 'Not evaluated']
        }
        return states[value.toLowerCase()][language.toLowerCase().startsWith('en') ? 1 : 0]
      })
      .replace(/\s{2,}/g, ' ')
      .trim()
    // Older model answers can use generic implementation vocabulary without
    // the structured identifiers caught above. Drop implementation-only lines
    // and remove the residual words from mixed lines while preserving survey
    // quantities and conclusions.
    const hasResidualImplementationVocabulary = residualImplementationVocabulary.test(cleaned)
    residualImplementationVocabulary.lastIndex = 0
    if (hasResidualImplementationVocabulary && !professionalContent.test(cleaned)) continue
    const professionalCleaned = cleaned
      .replace(residualImplementationVocabulary, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.;:，。；：])/g, '$1')
      .replace(/([,.;:，。；：])\s*([,.;:，。；：])/g, '$1')
      .trim()
    // A previous cleanup pass can remove the verb and leave a fragment such
    // as "如需…，计划，请告诉我". Drop the whole historical offer when its
    // sentence is still recognisably an internal product action.
    if (/^(?:如需|如果你(?:需要|希望)|如果希望)/.test(cleaned)
      && /(?:我可以|发起|请告诉我|请告知|修改建议)/.test(cleaned)) continue
    // Model-only lines can arrive with a presentation prefix (for example
    // "文本 deepseek-v4-pro"). Removing the model must not leave that
    // placeholder visible to the surveyor.
    if (!professionalCleaned || /^(?:text|文本|assistant|助手)\s*[:：]?\s*$/i.test(professionalCleaned) || (codeLikeLine.test(professionalCleaned) && !professionalContent.test(professionalCleaned)) || /^[\s\d.,;:()[\]{}_\-，。；：、]+$/.test(professionalCleaned)) continue
    if (visible.at(-1) !== professionalCleaned) visible.push(professionalCleaned)
  }
  return visible.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Preserve the user's own words; hide only the legacy system-added selection. */
export function engineeringProfessionalUserText(text: string): string {
  const marker = /\n\nSelected Survey evidence \(reference(?: IDs)? only, not execution approval(?:; resolve current records before answering)?\): (\{[^\n]*\})(?:\nRead (?:this exact typedEvidence|these exact legacy selectors)[^\n]*)?\s*$/
  const selection = marker.exec(text)
  if (selection) {
    try {
      const reference: unknown = JSON.parse(selection[1])
      if (!reference || typeof reference !== 'object' || Array.isArray(reference) || !('section' in reference || 'projectId' in reference || 'networkId' in reference || 'typedEvidence' in reference)) return text
      return text.slice(0, selection.index)
    } catch { return text }
  }
  // Historical turns stored the user question followed by a plain instruction
  // line. It is runtime routing metadata, not part of the surveyor's message.
  const legacyInstruction = /\n(?:Read (?:these exact legacy selectors|this exact typedEvidence)[^\n]*|读取给定 legacy 选择器[^\n]*)[\s\S]*$/i
  const instruction = legacyInstruction.exec(text)
  if (instruction && instruction.index > 0) return text.slice(0, instruction.index).trimEnd()
  return text
}

/**
 * Presentation copy for user bubbles on the Survey surface. The original
 * question remains the source of truth, while generated survey record IDs are
 * translated to the terminology a surveyor can act on.
 */
export function engineeringProfessionalUserSurfaceText(text: string, language = appI18n.language): string {
  const cleaned = engineeringProfessionalUserText(text)
  if (!cleaned.trim()) return ''
  const english = language.toLowerCase().startsWith('en')
  const label = (chinese: string, translated: string): string => english ? translated : chinese
  return cleaned
    .replace(/\bcosa-in[12]-\d+-backsight-reset\b/gi, label('后视归零方向', 'backsight zero direction'))
    .replace(/\bcosa-in[12]-\d+-(?:direction|distance|height-difference)\b/gi, label('原始观测', 'source observation'))
    .replace(/\bplane-control\b/gi, label('平面控制网', 'plane control network'))
    .replace(/\bunit-mahalanobis\b/gi, label('单位马氏半径', 'unit Mahalanobis radius'))
    .replace(/\b(?:survey_read_context|survey_read_evidence)\b/gi, label('资料核查', 'record verification'))
}

/** Apply survey diagnostic wording before filtering an assistant response. */
export function engineeringProfessionalAnswerText(text: string, language = appI18n.language): string {
  const dispositionEnvelope = /(?:^|[\s：:。.;；])((?:archive-only|converter-required|gnss-processing-required|adjustment-ready): [a-z][a-z0-9_]* —[\s\S]*)/i
  const professionalDiagnostics = text.split(/\r?\n/)
    .map((line) => {
      const disposition = dispositionEnvelope.exec(line)?.[1]
      if (!disposition) return surveyDiagnosticText({ message: line }, language)
      // An embedded diagnostic does not replace the measurements preceding it.
      const prefix = line.slice(0, line.indexOf(disposition))
      return prefix + surveyDiagnosticText({ message: disposition }, language)
    })
    .join('\n')
  return engineeringProfessionalText(professionalDiagnostics, language)
}

/** Keep plan labels readable when a runtime returns an internal step name. */
export function engineeringProfessionalStepText(text: string, language: string): string {
  const translated = text.trim()
  const labels: Record<string, [string, string]> = {
    'read_survey_context': ['读取测量资料', 'Read survey data'],
    'survey_read_context': ['读取测量资料', 'Read survey data'],
    'survey_network_validate': ['校核测量网络与基准', 'Validate survey network and datum'],
    'survey_quality_check': ['检查资料质量', 'Check data quality'],
    'survey_adjustment': ['进行测量平差', 'Run survey adjustment'],
    'survey_adjustment_read': ['检查测量资料', 'Check survey data'],
    'control_network_adjustment': ['进行控制网平差', 'Adjust control network'],
    'generate_review_draft': ['生成审查稿', 'Generate review draft'],
    'report_export': ['准备成果文件', 'Prepare deliverables']
  }
  const known = labels[translated.toLowerCase()]
  if (known) return language.toLowerCase().startsWith('en') ? known[1] : known[0]
  const cleaned = engineeringProfessionalText(translated, language)
  if (cleaned && !/[_.:-]/.test(cleaned)) return cleaned
  return language.toLowerCase().startsWith('en') ? 'Complete survey processing' : '完成测量处理'
}
