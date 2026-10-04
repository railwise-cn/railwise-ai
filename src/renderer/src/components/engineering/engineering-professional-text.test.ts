import { beforeEach, describe, expect, it } from 'vitest'
import appI18n from '../../i18n'
import { engineeringProfessionalAnswerText, engineeringProfessionalText, engineeringProfessionalUserText } from './engineering-professional-text'
import historicalSyntheticAnswers from './fixtures/historical-survey-synthetic-answers.json'

describe('engineeringProfessionalText', () => {
  beforeEach(async () => { await appI18n.changeLanguage('zh-CN') })
  it.each([
    ['zh-CN', '尚未核查规范符合性', '尚未核验专业签认', '所提供声明未经独立核实', '未提供统计检验摘要'],
    ['en-US', 'Standards conformity has not been evaluated', 'Professional signoff has not been verified', 'Provided declarations have not been independently verified', 'No statistical test summary is available']
  ])('preserves unevaluated professional limitations in %s', (language, standards, signoff, declarations, statistics) => {
    const answer = engineeringProfessionalAnswerText('standardConformity=not-evaluated；humanSignatureVerification=not-evaluated；callerDeclarationsAuthenticated=false。\nstatisticalSummary=null。', language)
    expect(answer).toContain(standards)
    expect(answer).toContain(signoff)
    expect(answer).toContain(declarations)
    expect(answer).toContain(statistics)
    expect(answer).not.toMatch(/standardConformity|humanSignatureVerification|callerDeclarationsAuthenticated|statisticalSummary|not-evaluated|null|false/)
  })

  it('uses English survey labels and preserves numbers, sources and failed precision checks', () => {
    const answer = engineeringProfessionalAnswerText('coordinateSystem=Pending; verticalDatum=Pending.\nvarianceFactor=1.14e-8; degreesOfFreedom=2; precision.passed=false.\nsourceRow / sourceLocator: 5 / COSA.in2:5; pointClass=station.\ncorrectionState 全部 false。', 'en-US')
    expect(answer).toContain('Coordinate system: Pending')
    expect(answer).toContain('Vertical datum: Pending')
    expect(answer).toContain('Variance factor=1.14e-8')
    expect(answer).toContain('Degrees of freedom=2')
    expect(answer).toContain('Precision check failed')
    expect(answer).toContain('COSA.in2:5')
    expect(answer).toContain('Station')
    expect(answer).toContain('No observation corrections have been applied')
    expect(answer).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('preserves the user question verbatim while removing only an appended selection envelope', () => {
    const question = '请解释 standardConformity=not-evaluated。\n{"point":"S1","x":50}\nsourceSha256 是什么？'
    expect(engineeringProfessionalUserText(question)).toBe(question)
    expect(engineeringProfessionalUserText(`${question}\n\nSelected Survey evidence (reference only, not execution approval): {"section":"survey","pointId":"S1"}\nRead this exact typedEvidence using survey_read_evidence before answering. Do not substitute another record or execute a calculation. If unavailable or stale, report that limitation.`)).toBe(question)
    expect(engineeringProfessionalUserText(`${question}\n\nSelected Survey evidence (reference IDs only, not execution approval; resolve current records before answering): {"projectId":"p","networkId":"n"}\nRead these exact legacy selectors using survey_read_context before answering. This selection has no typedEvidence; do not invent a typed reference or pass it to survey_read_evidence.`)).toBe(question)
    expect(engineeringProfessionalUserText(`${question}\nRead these exact legacy selectors using survey_read_context before answering. This selection has no typedEvidence.`)).toBe(question)
  })

  it('keeps professional restrictions embedded in a metadata parenthesis', () => {
    const answer = engineeringProfessionalAnswerText('本条资料的结论（readOnly=true；standardConformity=not-evaluated；humanSignatureVerification=not-evaluated）：仅供复核。', 'zh-CN')
    expect(answer).toContain('尚未核查规范符合性')
    expect(answer).toContain('尚未核验专业签认')
    expect(answer).toContain('仅供复核')
    expect(answer).not.toContain('readOnly')
  })

  it('keeps source references and numeric findings on the same line as internal details', () => {
    const answer = engineeringProfessionalAnswerText('原始依据：COSA.in2 第 5 行；algorithmVersion=workwise-2；S1 点位中误差为 1.35×10⁻⁷ m，坐标基准尚未确认。', 'zh-CN')
    expect(answer).toContain('COSA.in2 第 5 行')
    expect(answer).toContain('S1 点位中误差为 1.35×10⁻⁷ m')
    expect(answer).toContain('坐标基准尚未确认')
    expect(answer).not.toContain('algorithmVersion')
  })

  it('preserves missing-evidence limitations when a legacy answer reports a suppressed read', () => {
    const answer = engineeringProfessionalAnswerText('本轮新读取被 tool_storm_suppressed 抑制，未返回新的点位行。\n点位坐标暂参考历史记录。', 'zh-CN')
    expect(answer).toContain('本次对所选记录的进一步核查未完成')
    expect(answer).toContain('点位坐标暂参考历史记录')
    expect(answer).not.toContain('tool_storm_suppressed')
  })

  it.each([
    ['zh-CN', '采用测站度盘定向模型', '后视归零方向', '原始单位', '度.分秒', 'X 为北坐标、Y 为东坐标', '未标记异常观测'],
    ['en-US', 'Station-circle orientation model is used', 'Backsight zero direction', 'Original unit', 'degrees.minutes-seconds', 'X is northing and Y is easting', 'No outlier flag']
  ])('translates legacy observation semantics without losing values or source records in %s', (language, orientation, role, unit, angleFormat, axes, outlier) => {
    const answer = engineeringProfessionalAnswerText([
      'S1 → A：rawFields.stationCircleOrientation=true；role=backsight-reset；outlier=false。',
      'COSA.in2:6；rawUnit=cosa-degree-dot-mmss；rawValue=270.00000；单位 rad，角度 4.71238898038469 rad。',
      'directionReference=cosa-station-circle；coordinateAxisOrder=north-east。'
    ].join('\n'), language)
    for (const expected of [orientation, role, unit, angleFormat, axes, outlier, 'COSA.in2:6', '270.00000', '4.71238898038469 rad']) expect(answer).toContain(expected)
    expect(answer).not.toMatch(/stationCircleOrientation|rawFields|role=|backsight-reset|outlier=false|rawUnit|rawValue|coordinateAxisOrder|north-east|directionReference|cosa-/)
  })

  it('hides runtime protocol details while retaining professional findings', () => {
    const result = engineeringProfessionalText([
      '已按 survey_read_context 读取当前记录（projectRevision 2、sourceSha256 abc）。',
      '1. 需要复核的问题',
      'varianceFactor 1.1387×10⁻⁸，precision.passed=true。',
      '建议确认坐标基准并复核观测改正项。'
    ].join('\n'))
    expect(result).not.toContain('survey_read_context')
    expect(result).not.toContain('sourceSha256')
    expect(result).not.toContain('projectRevision')
    expect(result).toContain('单位权方差因子')
    expect(result).toContain('精度检查通过')
    expect(result).toContain('建议确认坐标基准')
  })

  it('removes tool storm and evidence protocol lines without changing values', () => {
    const result = engineeringProfessionalText('tool_storm_suppressed\n调用了 2 个工具\n点位标准误差 1.35×10⁻⁷ m')
    expect(result).toContain('本次对所选记录的进一步核查未完成')
    expect(result).toContain('点位标准误差 1.35×10⁻⁷ m')
    expect(result).not.toMatch(/tool_storm_suppressed|调用了 2 个工具/)
  })

  it('does not expose the model or local execution service in the professional answer', () => {
    const result = engineeringProfessionalText('Runtime 已完成计算。deepseek-v4-pro\n结果需要复核。')
    expect(result).toContain('已完成计算。')
    expect(result).not.toContain('Runtime')
    expect(result).not.toContain('deepseek-v4-pro')
  })

  it('hides product storage and model-routing labels while retaining the survey conclusion', () => {
    const answer = engineeringProfessionalAnswerText([
      '附件由 Attachment Store 托管。',
      '本地计算服务结果（不是模型猜测）：平差高程为 100.250 m。',
      '模型只接收摘要和证据索引；S1 残差为 0.4 mm，未超过限差。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('平差高程')
    expect(answer).toContain('100.250 m')
    expect(answer).toContain('S1 残差为 0.4 mm')
    expect(answer).not.toMatch(/Attachment Store|local processing service|model guess|模型只接收|证据索引/i)
  })

  it('hides English implementation prefixes without dropping measured values', () => {
    const answer = engineeringProfessionalAnswerText([
      'The local calculation service returned the adjusted elevation for BM-01: 100.250 m.',
      'The model receives summaries and evidence indexes only.',
      'The residual is +0.3 mm and remains below the project tolerance.'
    ].join('\n'), 'en-US')

    expect(answer).toContain('The adjusted elevation for BM-01: 100.250 m.')
    expect(answer).toContain('The residual is +0.3 mm and remains below the project tolerance.')
    expect(answer).not.toMatch(/local calculation service|model receives summaries|evidence indexes/i)
  })

  it('filters protocol-heavy explanations while keeping the survey conclusion', () => {
    const result = engineeringProfessionalText([
      '已按精确选择器读取当前记录（projectRevision 2、sourceSha256 4281）。',
      '文本 deepseek-v4-pro',
      '已按 typedEvidence 调用 survey_read_evidence，返回 status=resolved。',
      '平差总体：validation=valid；precision.passed=true。',
      '建议确认平面基准，并复核气象和投影归算改正项。',
      'schemaVersion=1，algorithmVersion=workwise-engineering-2。'
    ].join('\n'))
    expect(result).toContain('数值校核通过')
    expect(result).toContain('精度检查通过')
    expect(result).toContain('建议确认平面基准')
    expect(result).not.toMatch(/精确选择器|typedEvidence|survey_read_evidence|status=resolved|schemaVersion|algorithmVersion|deepseek/i)
  })

  it('hides fenced structured data even when a field contains a measurement', () => {
    const answer = engineeringProfessionalAnswerText([
      '计算结论如下：',
      '```json',
      '{',
      '  "residual": "12 mm",',
      '  "sourceSha256": "private-hash"',
      '}',
      '```',
      'S1 残差为 12 mm，未超过本项目限差。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('S1 残差为 12 mm，未超过本项目限差。')
    expect(answer).not.toMatch(/```|"residual"|sourceSha256|private-hash|\{/)
  })

  it('hides tilde fences and unfenced JSON fields while keeping the professional conclusion', () => {
    const answer = engineeringProfessionalAnswerText([
      '~~~json',
      '{',
      '  "residual": "12 mm",',
      '  "tool": "survey_adjustment"',
      '}',
      '~~~',
      '{"residual":"9 mm","contextHash":"private-hash"}',
      'S1 残差为 0.4 mm，未超过本项目限差。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('S1 残差为 0.4 mm，未超过本项目限差。')
    expect(answer).not.toMatch(/~~~|"residual"|survey_adjustment|contextHash|private-hash|\{/)
  })

  it('hides declaration lines and inline payloads even when they contain measurements', () => {
    const answer = engineeringProfessionalText([
      'const result = { residual: "12 mm", contextHash: "private-hash" };',
      'return { point: "S1", value: "0.4 mm" };',
      'S1 残差为 0.4 mm，未超过本项目限差。'
    ].join('\n'), 'zh-CN')

    expect(answer).toBe('S1 残差为 0.4 mm，未超过本项目限差。')
    expect(answer).not.toMatch(/const|return|residual|contextHash|private-hash/)
  })

  it('turns evidence field names into survey language and removes trace identifiers', () => {
    const result = engineeringProfessionalText([
      '项目 coordinateSystem="待确认"、verticalDatum="待确认"。',
      'point-precision 1.35×10⁻⁷ m；xyErrorEllipse.covarianceXY 单位为 m²。',
      'sourceRow / sourceLocator：5 / COSA.in2:5；recordType=station。',
      'initialCoordinateMethod=cosa-station-polar-rigid-initialization，initialCoordinateDistanceRmsMetres=1.2×10⁻⁸。',
      'inputAttachmentHash=abc，projectId=project-a，networkRevision=2。',
      '建议补认平面坐标系统和高程基准。'
    ].join('\n'))
    expect(result).toContain('平面坐标系统')
    expect(result).toContain('高程基准')
    expect(result).toContain('点位精度')
    expect(result).toContain('原始记录位置')
    expect(result).not.toMatch(/coordinateSystem|verticalDatum|point-precision|xyErrorEllipse|covarianceXY|sourceRow|sourceLocator|recordType|initialCoordinateMethod|inputAttachmentHash|projectId|networkRevision/i)
    expect(result).not.toContain('cosa-station-polar-rigid-initialization')
  })

  it('keeps the survey conclusion while hiding implementation fields from a full point explanation', () => {
    const result = engineeringProfessionalText([
      '平差总体指标：validation=valid；precision.maxPointStdDev=1.3592×10⁻⁷ m，passed=true。',
      '未知数 3、观测 5、degreesOfFreedom 2；observationCount=5、stationCount=1。',
      'rawFields.recordType=station，known=false，pointClass=station。',
      'qualityFinding format_detected，severity=warning，status=open。',
      'sourceFileHash=abc，storedResultsHash=def，recomputedResultsHash=ghi。',
      '建议补认平面坐标系统，并复核观测改正项。'
    ].join('\n'))
    expect(result).toContain('最大点位中误差')
    expect(result).toContain('自由度 2')
    expect(result).toContain('建议补认平面坐标系统')
    expect(result).not.toMatch(/precision\.maxPointStdDev|degreesOfFreedom|observationCount|stationCount|rawFields|recordType|known=false|pointClass|qualityFinding|format_detected|status=open|sourceFileHash|storedResultsHash|recomputedResultsHash/i)
  })

  it('drops standalone developer commands, endpoints, and source paths', () => {
    const result = engineeringProfessionalText([
      'npm run build',
      'POST /v1/engineering/ai/plans',
      '/Users/wangjiawei/Documents/WorkWise/src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx:663',
      '平差结果已完成，最大点位中误差满足限差。'
    ].join('\n'))
    expect(result).toBe('平差结果已完成，最大点位中误差满足限差。')
  })

  it('removes model think blocks before they can be rendered as process details', () => {
    const result = engineeringProfessionalAnswerText([
      '<think>Let me compare the network geometry and consider the weighting assumptions carefully.</think>',
      'S1 平差后点位标准误差为 1.36×10⁻⁷ m；自由度为 2，建议补充冗余观测。'
    ].join('\n'), 'zh-CN')

    expect(result).toContain('S1 平差后点位标准误差为 1.36×10⁻⁷ m')
    expect(result).toContain('建议补充冗余观测')
    expect(result).not.toMatch(/<think>|weighting assumptions|Let me compare/i)
  })

  it('keeps survey conclusions while removing inline developer commands and source paths', () => {
    const result = engineeringProfessionalText('平差结果已完成；如需排查，请运行 `pnpm test` 并查看 `src/foo.ts`。\n原始依据来自 COSA.in2 第 5 行。')

    expect(result).toContain('平差结果已完成')
    expect(result).toContain('原始依据来自 COSA.in2 第 5 行')
    expect(result).not.toMatch(/pnpm test|src\/foo\.ts/)
  })

  it('removes selected evidence payloads and internal catalog identifiers from the user-facing transcript', () => {
    const result = engineeringProfessionalText([
      '请解释 S1 的结果、原始依据及需要复核的问题。',
      'Selected Survey evidence (reference IDs only, not execution approval): {"projectId":"project-a","sourceSha256":"abc","parserId":"cosa-in2-parser"}',
      '开放的格式能力提示仍待处理：survey_finding_123 指出当前能力策略为 adjustment-ready。',
      '建议补认平面坐标系统，并复核观测改正项。'
    ].join('\n'))
    expect(result).toContain('请解释 S1 的结果')
    expect(result).toContain('建议补认平面坐标系统')
    expect(result).not.toMatch(/Selected Survey evidence|projectId|sourceSha256|parserId|survey_finding_|adjustment-ready|workwise-survey-format-catalog/i)
  })

  it('professionalizes format-catalog diagnostics repeated in an AI answer', () => {
    const source = 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；P0 格式目录 workwise-survey-format-catalog-1.7.0 当前资料可进入计算前检查：严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断平差。解析器 cosa-in2-parser 0.3.0（parserSourceHash 14b059f…，sourceSha256 4281cc7a…）。'
    const chinese = engineeringProfessionalText(source, 'zh-CN')
    const english = engineeringProfessionalText(source, 'en-US')

    expect(chinese).toContain('请确认坐标基准、控制点、观测关系、闭合差和精度条件')
    expect(english).toContain('Confirm the datum, control points, observation relationships, closure and precision')
    for (const result of [chinese, english]) {
      expect(result).not.toMatch(/P0|格式目录|解析对象|策略校验|解析器|workwise-survey-format-catalog|cosa-in2-parser|parserSourceHash|sourceSha256|哈希/i)
    }
  })

  it('removes developer catalog and sample-data vocabulary from mixed answers', () => {
    const answer = engineeringProfessionalAnswerText([
      'The fixture parser accepted this format catalog; runtime hash revision remains pending.',
      'S1 residual is 0.4 mm and remains below the project tolerance.'
    ].join('\n'), 'en-US')

    expect(answer).toContain('S1 residual is 0.4 mm')
    expect(answer).not.toMatch(/fixture|format catalog|parser|runtime|hash|revision/i)

    const measured = engineeringProfessionalAnswerText(
      'The fixture parser reports S1 residual 0.4 mm, below the project tolerance.',
      'en-US'
    )
    expect(measured).toContain('S1 residual 0.4 mm')
    expect(measured).not.toMatch(/fixture|parser/i)

    const catalogMeasurement = engineeringProfessionalAnswerText(
      'Format catalog reports S1 residual 0.4 mm; the parser kept the source record.',
      'en-US'
    )
    expect(catalogMeasurement).toContain('S1 residual 0.4 mm')
    expect(catalogMeasurement).not.toMatch(/format catalog|parser/i)
  })

  it('preserves prior and posterior variance meaning in Chinese and English answers', () => {
    const chinese = engineeringProfessionalText('a-priori 协方差采用先验基准；a-posteriori 方差采用后验基准。', 'zh-CN')
    const english = engineeringProfessionalText('Use the a-priori covariance and a-posteriori variance basis.', 'en-US')

    expect(chinese).toContain('先验')
    expect(chinese).toContain('后验')
    expect(chinese).not.toContain('后验协方差')
    expect(english).toContain('prior covariance')
    expect(english).toContain('posterior variance basis')
  })

  it('removes unfamiliar API and request-trace wording without losing survey results', () => {
    const answer = engineeringProfessionalAnswerText([
      'The API endpoint /v2/engineering/projects/rail-001/context returned HTTP 200.',
      'requestId=req-834; workflowId=plan-10; correlationId=trace-23.',
      'The adjusted elevation for BM-01 is 100.250 m; the residual is +0.3 mm.'
    ].join('\n'), 'en-US')

    expect(answer).not.toMatch(/API endpoint|\/v2\/engineering|HTTP 200|requestId|workflowId|correlationId|req-834|trace-23/)
    expect(answer).toContain('The adjusted elevation for BM-01 is 100.250 m')
    expect(answer).toContain('the residual is +0.3 mm')
  })

  it('turns embedded disposition codes into survey actions and removes execution identifiers', () => {
    const source = [
      '资料判断：archive-only: unknown_format — 当前文件暂不能处理。',
      'taskId=task-123、planId=eplan-7、threadId=thread-a、tool_id=survey_read_context、sourceSha256 abc123',
      '建议先把来源资料转换为受支持格式，再核对单位和坐标基准。'
    ].join('\n')
    const chinese = engineeringProfessionalAnswerText(source, 'zh-CN')
    const english = engineeringProfessionalAnswerText('converter-required: unsupported_format — converter missing', 'en-US')
    const pointIdentity = engineeringProfessionalAnswerText('RESULT-01 点位精度满足本项目限差；Network-1 仍需补测一条边。', 'zh-CN')

    expect(chinese).toContain('此格式当前仅支持查看与质量检查')
    expect(chinese).toContain('建议先把来源资料转换为受支持格式')
    expect(chinese).not.toMatch(/archive-only|unknown_format|taskId|planId|threadId|tool_id|survey_read_context|sourceSha256|abc123|eplan-7/)
    expect(chinese).not.toMatch(/^\s*、|、\s*、/m)
    expect(english).toBe('Convert this file to a supported survey format before importing it again.')
    expect(pointIdentity).toContain('RESULT-01')
    expect(pointIdentity).toContain('Network-1')
  })

  it('renders parser contract errors as a survey-facing diagnosis', () => {
    const result = engineeringProfessionalAnswerText('survey_parser_contract: unsupported field WI83', 'zh-CN')

    expect(result).toBe('测量记录包含当前不支持的字段 WI83。请检查仪器导出格式，或使用兼容格式重新导入。')
    expect(result).not.toContain('survey_parser_contract')
  })

  it('keeps the measurement interpretation from a real session while hiding execution internals', () => {
    const answer = engineeringProfessionalAnswerText([
      '已按你给出的精确选择器读取当前记录（projectRevision 2、networkRevision 2、sourceSha256 4281cc7a…、adjustment_caf219cb…）。该选择没有 typedEvidence，全部来自 survey_read_context 的实时上下文读取。',
      '平差坐标与改正数（COSA.in2 第 5 行，station 点）：平差后 X 49.99999999284098 m，Y 49.999999963710295 m，点位标准误差 1.3592×10⁻⁷ m。',
      '总体指标：validation=valid；未知数 3、观测 5、自由度 2；最大标准化残差 0.000136σ。',
      '源文件：COSA.in2（sha256 4281cc7a…）；解析器 cosa-in2-parser 0.3.0（parserSourceHash 14b059f…）。sourceEligibility eligible，rawSourceIntegrity verified。',
      'standardConformity=not-evaluated；humanSignatureVerification=not-evaluated；callerDeclarationsAuthenticated=false。',
      '需要复核：坐标基准尚未确认；该控制网只有 2 个自由度，稳健性有限。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('49.99999999284098 m')
    expect(answer).toContain('最大标准化残差 0.000136σ')
    expect(answer).toContain('坐标基准尚未确认')
    expect(answer).toContain('自由度 2')
    expect(answer).not.toMatch(/精确选择器|projectRevision|networkRevision|sourceSha256|adjustment_caf|typedEvidence|survey_read_context|cosa-in2-parser|parserSourceHash|rawSourceIntegrity|sourceEligibility|standardConformity|humanSignatureVerification|callerDeclarationsAuthenticated|not-evaluated|sha256|14b059f|4281cc7a/i)
  })

  it('keeps professional limitations from historical evidence-reader answers', () => {
    const answer = engineeringProfessionalAnswerText([
      '已按要求用 survey_read_context 读取给定 legacy 选择器解析当前记录。',
      '1. 类型化证据引用无效：返回 invalid-reference；下面内容只能作为当前记录快照，不能视为对选定证据的验证。',
      '2. 平差输入与所选源文件的版本一致性：平差记录 revision 1 与当前源文件不同，需确认后再引用。',
      '3. 质量发现未关闭：存在 warning，需完成基准、控制点、观测关系、拓扑、闭合和精度校验。',
      '4. 坐标框架待确认：coordinateSystem、verticalDatum 均为“待确认”。',
      '5. 初始坐标不等于成果坐标：所选记录只含初始坐标，不含点位精度。'
    ].join('\n'), 'zh-CN')
    expect(answer).toContain('所选资料目前无法完成核查')
    expect(answer).toContain('平差资料一致性需要复核')
    expect(answer).toContain('质量发现未关闭')
    expect(answer).toContain('平面坐标系统')
    expect(answer).toContain('所选记录只含初始坐标')
    expect(answer).not.toMatch(/survey_read_context|invalid-reference|coordinateSystem|verticalDatum|revision|warning/)
  })

  it('removes residual fetch metadata and translates estimation flags', () => {
    const answer = engineeringProfessionalAnswerText([
      '已按你给出的精确遗留读取当前记录（生成于 2026-10-02T11:32:26，networkRevision 2、adjustment revision 1、源哈希一致）。',
      '观测明细来自本会话早前读取的已解析记录；未做任何计算或替代记录。',
      '单位权方差因子 1.14×10⁻⁸，estimated=是、未提供统计检验摘要。',
      '原始资料完整性已校验（解析账本 2 条、无错误）。',
      '质量标记 ["后视归零方向"]。'
    ].join('\n'), 'zh-CN')

    expect(answer).not.toMatch(/精确遗留读取|生成于|networkRevision|adjustment revision|哈希|解析账本|本会话早前读取|未做任何计算|estimated=/i)
    expect(answer).toContain('单位权方差因子 1.14×10⁻⁸')
    expect(answer).toContain('为估计值')
    expect(answer).not.toContain('["后视归零方向"]')
    expect(answer).toContain('质量标记：后视归零方向')
  })

  it('removes bare estimation and runtime fragments left by legacy evidence fields', () => {
    const answer = engineeringProfessionalAnswerText([
      '平差精度通过只表示数值通过运行时阈值；与人工签字验证均未评估。',
      '单位权方差因子 1.14×10⁻⁸（estimated），未提供统计检验摘要。',
      'A 的基准坐标未经独立验证：运行时只做了源完整性核验（、），未验证上级联测关系。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('当前检查阈值')
    expect(answer).toContain('单位权方差因子 1.14×10⁻⁸（为估计值）')
    expect(answer).toContain('本次仅核查了资料完整性')
    expect(answer).not.toMatch(/\bestimated\b|运行时|（、）|\(,\)/i)
  })

  it('removes legacy reader versions, empty source clauses and protocol remnants', () => {
    const answer = engineeringProfessionalAnswerText([
      '源文件：COSA.in2（与网络 一致）；资料读取 cosa-in2-资料读取 0.3.0。源，资料可进入计算前检查、无 其他问题。',
      '口径与结论边界：precision.passed 只表示当前检查阈值通过；、人工签字验证均未评估。',
      'A 的基准坐标未经独立验证：运行时只核验了源完整性与，未验证上级联测关系。',
      '如需补认基准参数，我可以发起 ；请告诉我需要修改的字段。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('源文件：COSA.in2')
    expect(answer).toContain('精度检查只表示当前检查阈值通过')
    expect(answer).toContain('规范符合性与专业签认均尚未评估')
    expect(answer).toContain('本次仅核查了资料完整性')
    expect(answer).not.toMatch(/我可以发起|请告诉我|请告知需要修改的字段|后续处理发起计划/)
    expect(answer).not.toMatch(/资料读取|0\.3\.0|与网络|源，|precision\.passed|运行时|、人工签字验证|我可以发起|发起\s*[；;]/i)
  })

  it('removes internal project-change offers from historical professional answers', () => {
    const answer = engineeringProfessionalAnswerText([
      '基准参数仍待确认，正式成果前应补充坐标系统声明。',
      '如需补认 A 的坐标系统/基准声明等参数（经界面确认，不执行计算、不改观测或坐标），我可以发起；请告诉我你希望修改的字段。',
      '如果你希望把待确认的基准参数正式提出修改建议，我可以发起计划，请告诉我。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('基准参数仍待确认')
    expect(answer).not.toMatch(/我可以发起|发起计划|请告诉我|请告知需要修改的字段/)
  })

  it('renders all captured synthetic-session answers without implementation fields or broken remnants', () => {
    const answers = historicalSyntheticAnswers.map(answer => engineeringProfessionalAnswerText(answer, 'zh-CN'))
    const combined = answers.join('\n')
    expect(combined).not.toMatch(/workwise-survey|typedEvidence|survey_read_|invalid-reference|calculationHash|sourceSha256|inputHash|parserSourceHash|revision|qualityStatus|sourceAdmission|coordinateSystem|verticalDatum|standardError|unit-mahalanobis|positive-x-toward|precision\.passed|\b(?:unknown|known|adjustment|plane-control|validated|verified|completed|valid|warning|open|thresholds)\b|strict reader|严格读取器|调用方声明|解析器|资料读取|运行时|我可以发起|\| id \|/i)
    expect(combined).not.toMatch(/均为\s*[。；]|\*{4}|，）|，；|-后视归零方向/)
    for (const retained of ['49.99999999284098', '49.999999963710295', '1.3592e-7 m', '−2.37e-10 rad', 'COSA.in2:6–10', 'COSA.in2:5', '1 mm + 1 ppm', '不应外推', '不能作为已验证结论引用', '规范符合性尚未评估', '人员签认尚未核验']) expect(combined).toContain(retained)
    expect(answers[1]).toContain('1. 所选资料目前无法完成核查')
    expect(answers[1]).toContain('2. 平差资料一致性需要复核')
    expect(answers[3]).toContain('1. 所选记录只含初始坐标，不含平差后点位精度')
    expect(answers[3]).toContain('3. 资料更新后需要重新核查')
    expect(answers[3]).toContain('规范符合性与人员签认均尚未评估')
    expect(answers[1]).toContain('|\n\n即：')
  })

  it('repairs protocol-heavy legacy wording captured from the installed Survey session', () => {
    const answer = engineeringProfessionalAnswerText([
      '已按你给出的 survey_read_context 读取当前记录（projectRevision 2、networkRevision 2、sourceSha256 abc、adjustmentId adjustment_123），结果与依据如下。该选择没有 typedEvidence，全部来自 survey_read_context 的实时项目资料读取；未做任何计算或替代记录。',
      '1. 本条 typedEvidence（network / unknownPoints[0] / identity id=S1）实际存了什么',
      '引用完整保留：schemaVersion 1、projectRevision 2、networkRevision 2、selector path=["unknownPoints",0] + identity {"id":"S1"}，解析成功。存储值（单位 m）：',
      '2. 平差后的 S1 结果（来自平差记录，上一轮已按 survey_read_context 读取，非本次 typedEvidence 内容）',
      '3. 开放的格式能力提示（未关闭）：qualityFinding survey_finding_123（format_detected，severity=warning，status=open）指出 cosa-in2 走 adjustment-ready 策略，要求继续完成基准、控制点、观测角色、拓扑、闭合与精度校验；任一不满足会阻断平差。',
      '源文件：COSA.in2 第 2 行声明 A(50,150) 为 known-point；sourceSha256 abc。',
      '1. A 的结果（metric：已知点）',
      '如需提交项目参数修改建议（经 UI 确认），请先复核坐标基准。'
    ].join('\n'), 'zh-CN')
    expect(answer).toContain('1. 所选记录中的 S1 初始坐标')
    expect(answer).toContain('2. 平差后的 S1 结果')
    expect(answer).toContain('资料质量提示仍待处理：请继续完成基准、控制点、观测角色、拓扑、闭合和精度校验；任一条件不满足都会阻断平差。')
    expect(answer).toContain('源文件：COSA.in2 第 2 行声明 A(50,150)')
    expect(answer).toContain('1. A 的结果（已知点）')
    expect(answer).not.toMatch(/survey_read_|typedEvidence|projectRevision|networkRevision|sourceSha256|adjustmentId|unknownPoints|identity|format_detected|qualityFinding|adjustment-ready|metric\s*[:=：]|经\s*确认|结果与依据如下|实时项目资料|未做任何计算或/)
    expect(answer).not.toMatch(/调整\s*[、，,；]\s*网络|质量提示.*策略|，）|，；|源。/)
  })

  it.each(['zh-CN', 'en-US'])('keeps recovery and applicability restrictions in %s', language => {
    const answer = engineeringProfessionalAnswerText([
      '1. 类型化证据引用无效：缺 inputHash，当前结论不能作为已验证依据。',
      '2. 本证据只含初始坐标，不含精度：需要另行引用平差证据（含 adjustmentId、inputHash）。',
      '3. 源快照一致性：若源文件变更，需按 revision/hash 精确核对。'
    ].join('\n'), language)
    expect(answer).not.toMatch(/inputHash|adjustmentId|revision|hash|类型化证据|typedEvidence/)
    expect(answer).toContain(language === 'en-US' ? 'The selected record could not be verified' : '所选资料目前无法完成核查')
    expect(answer).toContain(language === 'en-US' ? 'not adjusted point precision' : '不含平差后点位精度')
    expect(answer).toContain(language === 'en-US' ? 'Recheck after source data changes' : '资料更新后需要重新核查')
  })

  it('preserves confirmed consistency instead of turning it into a pending review', () => {
    const answer = engineeringProfessionalAnswerText('1. 平差输入与当前源文件已确认一致（networkRevision 2）。S1 点位中误差 0.8 mm，可用于本次分析。', 'zh-CN')
    expect(answer).toContain('已确认一致')
    expect(answer).toContain('0.8 mm')
    expect(answer).toContain('可用于本次分析')
    expect(answer).not.toContain('一致性需要复核')
  })

  it('does not invent initial-coordinate content for a different evidence mismatch', () => {
    const answer = engineeringProfessionalAnswerText('2. 证据语义与问题目标不匹配：该引用是方向观测 270°，不是点位精度；当前没有初始坐标。', 'zh-CN')
    expect(answer).toContain('方向观测 270°')
    expect(answer).toContain('当前没有初始坐标')
    expect(answer).not.toContain('所选记录只含初始坐标')
  })

  it('retains retry success and numerical facts in the same paragraph as an old reader failure', () => {
    const answer = engineeringProfessionalAnswerText('先前读取返回 invalid-reference。重新读取成功，S1 高程为 100.250 m，残差 0.4 mm。', 'zh-CN')
    expect(answer).toContain('重新读取成功')
    expect(answer).toContain('100.250 m')
    expect(answer).toContain('0.4 mm')
    expect(answer).not.toContain('目前无法完成核查')
    expect(answer).not.toContain('invalid-reference')
  })

  it('keeps numerical findings and blocking decisions beside an unrecognized trace field', () => {
    const answer = engineeringProfessionalAnswerText('sourceEligibility.status=blocked；S1 残差 12 mm，禁止出成果。rawFields.customFlag=1；BM-02 高差 -1.250 m。', 'zh-CN')
    expect(answer).toContain('资料暂不能用于计算')
    expect(answer).toContain('S1 残差 12 mm')
    expect(answer).toContain('禁止出成果')
    expect(answer).toContain('BM-02 高差 -1.250 m')
    expect(answer).not.toMatch(/rawFields|customFlag/)
  })

  it('does not promote a valid declaration to a numerical validation conclusion', () => {
    const answer = engineeringProfessionalAnswerText('基准声明 valid，仍未开展平差。', 'zh-CN')
    expect(answer).toContain('基准声明 有效')
    expect(answer).toContain('仍未开展平差')
    expect(answer).not.toContain('数值校核通过')
    expect(engineeringProfessionalAnswerText('The datum declaration is valid; adjustment has not started.', 'en-US')).toBe('The datum declaration is valid; adjustment has not started.')
  })

  it.each([
    'Input: S1 残差 12 mm 超过 3 mm，禁止出成果。',
    '```text\nS1 残差 12 mm 超过 3 mm，禁止出成果。\n```',
    'API 返回 S1 残差 12 mm 超过 3 mm，禁止出成果。'
  ])('retains quantities and restrictions even when wrapped in developer presentation: %s', input => {
    const answer = engineeringProfessionalAnswerText(input, 'zh-CN')
    for (const part of ['S1', '12 mm', '3 mm', '禁止出成果']) expect(answer).toContain(part)
    expect(answer).not.toContain('API')
    expect(answer).not.toContain('```')
  })

  it('preserves source URLs, filenames, record identities and their numerical facts', () => {
    const answer = engineeringProfessionalAnswerText('https://example.org/report.pdf 第 5 页指出 S1 沉降 12 mm。\n源文件 x.json 第 6 行记录 cosa-control-1 观测残差为 -1.2 mm。', 'zh-CN')
    for (const part of ['https://example.org/report.pdf', '第 5 页', '沉降 12 mm', 'x.json', '第 6 行', 'cosa-control-1', '-1.2 mm']) expect(answer).toContain(part)
  })

  it.each([
    ['zh-CN', '资料可用性', '暂不能用于计算', '规范符合性', '尚未评估', '精度检查是否通过', '否'],
    ['en-US', 'Data eligibility', 'Blocked from calculation', 'Standards conformity', 'Not evaluated', 'Precision check passed', 'No']
  ])('translates tabular eligibility and professional limitations without losing their meaning in %s', (language, eligibility, blocked, standard, pending, precision, failed) => {
    const answer = engineeringProfessionalAnswerText('| 字段 | 值 |\n| --- | --- |\n| sourceEligibility | blocked |\n| standardConformity | not-evaluated |\n| precision.passed | false |', language)
    for (const part of [eligibility, blocked, standard, pending, precision, failed]) expect(answer).toContain(part)
    expect(answer).not.toMatch(/sourceEligibility|standardConformity|precision\.passed|not-evaluated|\| false \|/)
  })

  it('translates failed source eligibility without hiding a blocking conclusion', () => {
    const answer = engineeringProfessionalAnswerText('sourceEligibility.eligible=false；sourceAdmission.status=blocked；原始资料有冲突，禁止出成果。', 'zh-CN')
    expect(answer).toContain('资料暂不能用于计算')
    expect(answer).toContain('原始资料有冲突，禁止出成果')
    expect(answer).not.toMatch(/sourceEligibility|sourceAdmission|\.eligible|\.status|blocked|false/)
  })

  it('reports incomplete further verification without denying an earlier successful read', () => {
    const answer = engineeringProfessionalAnswerText('已成功读取项目摘要，点位补读被 tool_storm_suppressed 抑制；S1 仍需复核。', 'zh-CN')
    expect(answer).toContain('已成功读取项目摘要')
    expect(answer).toContain('进一步核查未完成')
    expect(answer).toContain('S1 仍需复核')
    expect(answer).not.toContain('未取得新的核查资料')
    expect(answer).not.toContain('tool_storm_suppressed')
  })

  it('retains measured failures before an embedded source diagnostic', () => {
    const answer = engineeringProfessionalAnswerText('S1 残差 12 mm，禁止出成果。资料说明：archive-only: unknown_format — 当前文件暂不能处理。', 'zh-CN')
    expect(answer).toContain('S1 残差 12 mm，禁止出成果')
    expect(answer).toContain('不能直接用于平差')
    expect(answer).not.toMatch(/archive-only|unknown_format/)
    const adjacent = engineeringProfessionalAnswerText('S1 残差 12 mm，禁止出成果。archive-only: unsupported_format — 当前文件暂不能处理。', 'zh-CN')
    expect(adjacent).toContain('S1 残差 12 mm，禁止出成果')
    expect(adjacent).toContain('不能直接用于平差')
    expect(adjacent).not.toMatch(/archive-only|unsupported_format/)
  })

  it('translates failed source integrity without removing the coordinate discrepancy', () => {
    const answer = engineeringProfessionalAnswerText('来源完整性 rawSourceIntegrity=failed，坐标差 12 mm，禁止出成果。', 'zh-CN')
    expect(answer).toContain('原始资料完整性检查未通过')
    expect(answer).toContain('坐标差 12 mm，禁止出成果')
    expect(answer).not.toMatch(/rawSourceIntegrity|=failed/)
  })

  it.each([
    ['tool: survey_read_context；S1 残差 0.4 mm，未超过限差。', 'survey_read_context'],
    ['Tool name = survey_adjustment；S1 残差 0.4 mm，未超过限差。', 'survey_adjustment'],
    ['工具名称：survey_quality_check；S1 残差 0.4 mm，未超过限差。', 'survey_quality_check']
  ])('removes standalone tool fields while keeping the survey conclusion', (input, internalLabel) => {
    const answer = engineeringProfessionalAnswerText(input, 'zh-CN')
    expect(answer).toContain('S1 残差 0.4 mm，未超过限差')
    expect(answer).not.toContain(internalLabel)
    expect(answer).not.toMatch(/工具名称|Tool name|tool:/i)
  })

  it('keeps historical AI answers focused on survey decisions instead of record mechanics', () => {
    const answer = engineeringProfessionalAnswerText([
      '源文件：COSA.in2（与网络 一致）。源准入状态 资料可用于处理，原始资料完整性已校验。',
      '关键点：这条网络证据里 S1 的坐标是解析后的初始坐标，不是平差最终成果。',
      '存储值（单位 m，记录）：X = 50.0000000123 m，Y = 49.9999997678 m。',
      '证据边界（本次读取明确返回）：尚未核查规范符合性；尚未核验专业签认。',
      '本轮新读取到的统计口径：单位权方差因子 1.14×10⁻⁸，本次读取未附带统计摘要。',
      '网络记录与平差记录口径不同：报告中的 S1 成果应采用平差后的坐标。',
      'S1 点位中误差为 0.14 mm，建议补认平面坐标系统。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('资料可用性')
    expect(answer).toContain('所选记录中的初始坐标')
    expect(answer).toContain('专业核查边界')
    expect(answer).toContain('统计说明')
    expect(answer).toContain('初始坐标与平差成果口径不同')
    expect(answer).toContain('平面坐标系统')
    expect(answer).not.toMatch(/源准入|存储值|网络证据|解析后的初始坐标|本次读取明确返回|本轮新读取到的统计口径|本次读取未附带|\bdatum\b|\bRMS\b|与网络\s*一致/i)
  })

  it('removes plain delivery and execution protocol lines while keeping survey findings', () => {
    const answer = engineeringProfessionalAnswerText([
      'manifest.json 已生成，TaskRun completed。',
      'Execution protocol: tool=survey_read_context；execution plan approved。',
      '源代码：src/renderer/src/components/engineering/SurveyAdjustmentPanel.tsx。',
      'S1 残差 0.4 mm，未超过限差；建议复核观测改正项。'
    ].join('\n'), 'zh-CN')

    expect(answer).toContain('S1 残差 0.4 mm，未超过限差')
    expect(answer).toContain('建议复核观测改正项')
    expect(answer).not.toMatch(/manifest(?:\.json)?|TaskRun|Execution protocol|execution plan|survey_read_context|源代码|src\/renderer/i)
  })
})
