import { describe, expect, it } from 'vitest'
import { surveyDiagnosticText, surveyLegacyDiagnosticText, surveyRuntimeErrorText, surveySourceDiagnosticText } from './survey-diagnostic-text'
import { lexLeicaGsi } from '../../../../../kun/src/engineering/survey-leica-gsi-lexer'
import parserEnglish from '../../locales/en/survey-parser-diagnostics.json'

describe('Survey diagnostic presentation compatibility', () => {
  it('keeps every parser translation free of implementation vocabulary on the user surface', () => {
    const implementationVocabulary = /P0|SHA-?256|parser diagnostics|parser|JSON|hash|binary|contract|attachment store|local processing service|anchor|deterministic|solver rank|structural probe|gate|runtime|execution receipt|fixture|frozen|SourceFile|preservedRawFields|F-FMT|physical lex|semantic pars|golden|WorkWise/i
    for (const [source, translation] of Object.entries(parserEnglish)) {
      const displayedEnglish = surveyLegacyDiagnosticText(translation, 'en')
      expect(displayedEnglish, `translation for ${source}`).not.toMatch(implementationVocabulary)
    }
  })

  it('translates the rejected-source envelope through nested eligibility without rewriting IDs', () => {
    const message = '无法通过内容签名安全识别测量文件；不会回退为通用 CSV'
    const envelope = `archive-only: unknown_format — ${message}`
    const archiveOnlyZh = '此格式当前仅支持查看与质量检查，不能直接用于平差。如需计算，请转换或导出为受支持的测量格式后再导入。'
    const archiveOnlyEn = 'This format can be reviewed but not adjusted directly. Convert or export it to a supported survey format before importing it for calculation.'
    expect(surveyLegacyDiagnosticText(envelope, 'en')).toContain(archiveOnlyEn)
    expect(surveyLegacyDiagnosticText(`源文件处置为 archive-only，不得进入平差：${envelope}`, 'en')).toContain(archiveOnlyEn)
    expect(surveyLegacyDiagnosticText(envelope, 'zh')).toContain(archiveOnlyZh)
    const unknown = 'archive-only: custom_code — 原始用户文本'
    expect(surveyLegacyDiagnosticText(unknown, 'en')).toBe(`${archiveOnlyEn} 原始用户文本`)
    expect(surveyLegacyDiagnosticText(unknown, 'zh')).toBe(`${archiveOnlyZh}原始用户文本`)
    expect(surveyLegacyDiagnosticText('converter-required: unsupported_format — 转换器未安装', 'zh'))
      .toBe('此资料需先转换为受支持的测量格式，再重新导入。')
    expect(surveyLegacyDiagnosticText('gnss-processing-required: rinex_observation — 尚需完成基线解算', 'en'))
      .toBe('Complete GNSS baseline processing and import its results before continuing.')
    expect(surveyLegacyDiagnosticText(`COSA .in1 已知点 ${envelope} 重复。`, 'en')).toBe(`COSA .in1 known point ${envelope} is duplicated.`)
  })
  it('renders actual rejected GSI records in English without changing their audit anchors', () => {
    for (const source of ['', '中文', 'AA0001+00000001', '110001+1234', '110001+00000001;210001+00000002', '510001+1234']) {
      const result = lexLeicaGsi(source)
      expect(result.state).toBe('blocked')
      const original = JSON.stringify(result)
      for (const diagnostic of result.diagnostics) {
        const wrapped = `Leica GSI 物理词法校验失败（${diagnostic.code}）：${diagnostic.message}`
        expect(surveyLegacyDiagnosticText(wrapped, 'en')).not.toMatch(/\p{Script=Han}/u)
        expect(surveyLegacyDiagnosticText(diagnostic.suggestedAction, 'en')).not.toMatch(/\p{Script=Han}/u)
        expect(surveyLegacyDiagnosticText(wrapped, 'zh')).not.toMatch(/empty-source|invalid-|Leica GSI 物理词法校验失败/)
      }
      expect(JSON.stringify(result)).toBe(original)
    }
  })
  it('preserves parser point names, record coordinates and numeric limits', () => {
    expect(surveyLegacyDiagnosticText('COSA .in1 已知点 桥墩甲 重复。', 'en')).toBe('COSA .in1 known point 桥墩甲 is duplicated.')
    expect(surveyLegacyDiagnosticText('COSA .in1 已知点 数据字段 重复。', 'en')).toBe('COSA .in1 known point 数据字段 is duplicated.')
    expect(surveyLegacyDiagnosticText('平面观测 网络没有观测记录 的点 信息字符 缺少 X/Y 坐标', 'en')).toBe('Point 信息字符 in planar observation 网络没有观测记录 has no X/Y coordinates.')
    expect(surveyLegacyDiagnosticText('COSA .in1 第 73 行必须是 from,to,height-difference(m),distance(km)，且 distance > 0。', 'en')).toBe('COSA .in1 line 73 must contain start point, end point, height difference (m) and section distance (km); distance must be greater than 0. Correct the record and import again.')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'survey_source_invalid', message: '测量源文件超过 8 MiB 上限' } }), 'en')).toBe('The survey source exceeds the limit of 8 MiB.')
    expect(surveyLegacyDiagnosticText('Leica GSI 第 17 行第 4 个 word 的WI51 第一组件含有不允许的字符 0x3a。', 'en')).toBe('Leica GSI line 17, word 4: WI51 first component contains the disallowed character 0x3a.')
  })
  it('selects English explanations and recovery without mutating original evidence', () => {
    const diagnostic = Object.freeze({ message: '原始诊断记录', suggestedAction: '原始恢复操作', localized: { en: { message: 'Record 19 has duplicate WI83 fields.', suggestedAction: 'Re-export record 19 with one WI83 final-height field.' } } })
    expect(surveyDiagnosticText(diagnostic, 'en-US')).toBe('Record 19 has duplicate WI83 fields.')
    expect(surveyDiagnosticText(diagnostic, 'en', 'action')).toContain('record 19')
    expect(surveyDiagnosticText(diagnostic, 'zh-CN')).toBe('原始诊断记录')
    expect(diagnostic.message).toBe('原始诊断记录')
  })
  it('preserves specific localized record locations when the original label is generic', () => {
    const diagnostic = {
      message: '字段映射需要确认。',
      suggestedAction: '确认字段映射、单位和基准后重新导入。',
      localized: { en: { message: 'Field mapping requires confirmation for record 19.', suggestedAction: 'Confirm units for record 19 and reimport.' } }
    }
    expect(surveyDiagnosticText(diagnostic, 'en')).toBe('Field mapping requires confirmation for record 19.')
    expect(surveyDiagnosticText(diagnostic, 'en', 'action')).toBe('Confirm units for record 19 and reimport.')
  })
  it('translates historical strategy diagnostics while retaining identifiers, units and tolerances', () => {
    expect(surveyLegacyDiagnosticText('观测 angle-07 的中误差单位 arcmin 没有已确认的换算定义，不能进入平差。', 'en')).toBe('Observation angle-07 has no confirmed conversion for standard-error unit arcmin; adjustment is blocked.')
    expect(surveyLegacyDiagnosticText('水准闭合差 0.000127 超过限差 0.0001', 'en')).toBe('Leveling closure 0.000127 exceeds tolerance 0.0001.')
    expect(surveyLegacyDiagnosticText('平面控制网在 30 次迭代后未收敛', 'en')).toBe('The plane control network did not converge after 30 iterations.')
    expect(surveyLegacyDiagnosticText('平面观测 obs-7 的点 桥墩甲 缺少 X/Y 坐标', 'en')).toBe('Point 桥墩甲 in planar observation obs-7 has no X/Y coordinates.')
    expect(surveyLegacyDiagnosticText('来源准入证据无效：持久化记录哈希不匹配。', 'en')).toBe('Original data does not meet calculation requirements: The saved data does not match the original record. Check the original file and import it again.')
    expect(surveyLegacyDiagnosticText('原始资料完整性校验失败：自定义错误内容', 'en')).toContain('自定义错误内容')
  })
  it('keeps format policy diagnostics out of the professional work surface', () => {
    const chinese = 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；P0 格式目录 workwise-survey-format-catalog-1.7.0 当前能力策略为 adjustment-ready：严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断平差。'
    const english = 'cosa-in2: auditable parsed objects retained; P0 format catalog workwise-survey-format-catalog-1.7.0 permits adjustment-ready: strict structure parsing, record anchors and unit conversion are required before policy checks.'
    const blocked = 'archive-only: P0 格式目录 workwise-survey-format-catalog-1.7.0 当前能力策略为 archive-only：原始资料需要进一步检查。'

    expect(surveyLegacyDiagnosticText(chinese, 'zh')).toBe('资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件；任一条件未满足时，系统会暂停计算。')
    expect(surveyLegacyDiagnosticText(chinese, 'zh')).not.toMatch(/P0|格式目录|解析对象|策略校验|workwise-survey-format-catalog/)
    expect(surveyLegacyDiagnosticText(english, 'en')).toBe('Survey data recognized. Confirm the datum, control points, observation relationships, closure and precision before calculation. Calculation pauses when any check is incomplete.')
    expect(surveyLegacyDiagnosticText(english, 'en')).not.toMatch(/P0|format catalog|parsed objects|workwise-survey-format-catalog/)
    expect(surveyLegacyDiagnosticText(blocked, 'zh')).toBe('此格式当前仅支持查看与质量检查，不能直接用于平差。如需计算，请转换或导出为受支持的测量格式后再导入。')
  })

  it('removes the historical quality-gate wording shown in the installed 0.5.1 build', () => {
    const installedBuildMessage = 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；P0 格式目录 workwise-survey-format-catalog-1.7.0 当前能力策略为 adjustment-ready：严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断。'
    const displayed = surveySourceDiagnosticText({ code: 'format_detected', message: installedBuildMessage }, 'zh-CN', 'adjustment-ready', true)

    expect(displayed).toBe('资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件；任一条件未满足时，系统会暂停计算。')
    expect(displayed).not.toMatch(/P0|格式目录|解析对象|策略校验|adjustment-ready|workwise-survey-format-catalog|解析器|fixture/)
  })
  it('professionalizes catalog wording when legacy records omit the P0 prefix', () => {
    const legacy = 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；严格结构解析、记录锚点和单位转换成功后可进入策略校验。'
    const chinese = surveySourceDiagnosticText({ code: 'format_detected', message: legacy }, 'zh-CN', 'adjustment-ready', true)
    const english = surveySourceDiagnosticText({ code: 'format_detected', message: 'cosa-in2: auditable parsed objects retained; strict structure parsing and unit conversion permit strategy validation.' }, 'en', 'adjustment-ready', true)

    expect(chinese).toContain('资料已识别')
    expect(chinese).not.toMatch(/可审计|解析对象|策略校验|cosa-in2/)
    expect(english).toMatch(/Survey data (?:recognized|is ready for professional checks)/)
    expect(english).not.toMatch(/auditable parsed objects|strategy validation|cosa-in2/i)
  })

  it.each([
    ['zh-CN', 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；严格结构解析、记录锚点和单位转换成功后可进入策略校验。', 'COSA.in2 第 19 行 S1 残差 12 mm，限差 3 mm，禁止出成果。'],
    ['en', 'cosa-in2: auditable parsed objects retained; strict structure parsing and unit conversion permit strategy validation.', 'COSA.in2 line 19: S1 residual 12 mm exceeds the 3 mm tolerance. Do not issue results.']
  ])('retains measured failures beside legacy catalog copy without a priority prefix (%s)', (language, policy, failure) => {
    const displayed = surveySourceDiagnosticText({ code: 'format_detected', message: `${policy}${failure}` }, language, 'adjustment-ready', true)

    expect(displayed).toContain(failure)
    expect(displayed).not.toMatch(/P0|格式目录|解析对象|解析器|fixture|记录锚点|策略校验|auditable parsed objects|strategy validation|adjustment-ready/)
  })
  it('filters implementation vocabulary from legacy findings that bypass the catalog branch', () => {
    const legacy = '资料检查：P0 格式目录未完成；解析对象及原始记录锚点已保留，解析器按 adjustment-ready 策略校验。S1 残差 2 mm，未超过 3 mm 限差。'
    const displayed = surveyLegacyDiagnosticText(legacy, 'zh-CN')

    expect(displayed).toContain('S1 残差 2 mm')
    expect(displayed).toContain('3 mm 限差')
    expect(displayed).not.toMatch(/P0|格式目录|解析对象|原始记录锚点|解析器|策略校验|adjustment-ready/)
  })
  it('turns tabular mapping gates into a professional recovery action', () => {
    const source = 'archive-only: CSV / 分隔文本 尚未附带 F-FMT-10 所需的已保存列映射、线性单位、角度格式和用户确认记录；不得以表头猜测代替确认后进入平差。'
    const action = '先在 F-FMT-10 映射工作流中选择列、线性单位和角度格式，保存映射方案并完成用户确认；该流程尚未实现时请使用受冻结 WorkWise JSON 合同的输入。'

    expect(surveyLegacyDiagnosticText(source, 'zh')).toBe('此表格资料尚未完成列映射、单位和角度格式确认。请在导入预检中完成并保存映射后重新导入。')
    expect(surveyLegacyDiagnosticText(source, 'en')).toBe('This table still needs column, unit and angle-format confirmation. Complete and save the mapping in import preflight before importing it for adjustment.')
    expect(surveyLegacyDiagnosticText(action, 'zh')).toBe('请在导入预检中确认点号、观测类型、单位和角度格式，保存映射后重新导入。')
    expect(surveyLegacyDiagnosticText(action, 'en')).toBe('In import preflight, confirm the point identifiers, observation type, units and angle format, save the mapping, and import the file again.')
    expect(surveyLegacyDiagnosticText(action, 'zh')).not.toMatch(/F-FMT|WorkWise|JSON|工作流|尚未实现/)
  })
  it('keeps measurements and blocking conclusions beside a catalog explanation', () => {
    const policy = 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；P0 格式目录 workwise-survey-format-catalog-1.7.0 当前能力策略为 adjustment-ready。'
    const finding = 'S1 残差 12 mm 超过 3 mm 限差，禁止出成果。'
    for (const message of [`${policy}${finding}`, `${finding}${policy}`, `资料预检说明：${policy}${finding}`]) {
      for (const language of ['zh', 'en']) {
        const displayed = surveyLegacyDiagnosticText(message, language)
        expect(displayed).toContain(finding)
        expect(displayed).not.toMatch(/P0|workwise-survey-format-catalog|adjustment-ready|解析对象/)
      }
    }
    const englishFinding = 'S1 residual 12 mm exceeds the 3 mm tolerance. Do not issue results.'
    const englishPolicy = 'cosa-in2: auditable parsed objects retained; P0 format catalog workwise-survey-format-catalog-1.7.0 permits adjustment-ready: strict structure parsing, record anchors and unit conversion are required before policy checks.'
    expect(surveyLegacyDiagnosticText(`${englishPolicy} ${englishFinding}`, 'en')).toContain(englishFinding)
    // No punctuation between the finding and vendor label must not make the
    // vendor-removal expression consume the preceding engineering evidence.
    expect(surveyLegacyDiagnosticText(`S1 residual 12 mm COSA / cosa-in2 已保留原始源文件；${policy}`, 'en')).toContain('S1 residual 12 mm')
  })
  it('preserves concrete failures inside source-disposition and table-mapping wrappers', () => {
    const finding = 'COSA.in2 第 19 行 S1 残差 12 mm，限差 3 mm，禁止出成果。'
    const messages = [
      `archive-only: custom_code — ${finding}`,
      `源文件处置为 archive-only，不得进入平差：archive-only: custom_code — ${finding}`,
      `archive-only: unknown_format — 无法通过内容签名安全识别测量文件；不会回退为通用 CSV${finding}`,
      `archive-only: CSV / 分隔文本 尚未附带 F-FMT-10 所需的已保存列映射、线性单位、角度格式和用户确认记录；不得以表头猜测代替确认后进入平差。${finding}`,
      `先在 F-FMT-10 映射工作流中选择列、线性单位和角度格式，保存映射方案并完成用户确认；该流程尚未实现时请使用受冻结 WorkWise JSON 合同的输入。${finding}`
    ]
    for (const message of messages) {
      for (const language of ['zh', 'en']) {
        const displayed = surveyLegacyDiagnosticText(message, language)
        expect(displayed).toContain(finding)
        expect(displayed).not.toMatch(/custom_code|unknown_format|F-FMT-10|JSON|archive-only/)
      }
    }
  })
  it('retains engineering evidence when current source eligibility overrides the catalog', () => {
    const finding = 'S1 残差 12 mm 超过 3 mm 限差，禁止出成果。'
    const message = `P0 格式目录 workwise-survey-format-catalog-1.7.0 当前能力策略为 adjustment-ready。${finding}`
    const item = Object.freeze({ code: 'format_detected', message })
    for (const language of ['zh', 'en']) {
      for (const [disposition, eligible] of [['archive-only', true], ['adjustment-ready', false]] as const) {
        const displayed = surveySourceDiagnosticText(item, language, disposition, eligible)
        expect(displayed).toContain(finding)
        expect(displayed).not.toMatch(/P0|workwise-survey-format-catalog|adjustment-ready|Survey data recognized|资料已识别/)
        expect(displayed).toMatch(/不能直接用于平差|不具备平差条件|not adjusted directly|not passed the checks/)
      }
    }
    expect(item.message).toBe(message)
  })
  it('explains missing survey declarations even when a stored English explanation uses code fields', () => {
    const message = 'WorkWise JSON 声明 coordinate-transform 但未显式声明 transformType；不得由导入请求决定变换模型。'
    const diagnostic = Object.freeze({ message, localized: { en: { message: 'WorkWise JSON declares coordinate-transform without an explicit transformType.' } } })
    expect(surveyDiagnosticText(diagnostic, 'zh')).toContain('坐标转换资料未声明转换方法，暂不能计算')
    expect(surveyDiagnosticText(diagnostic, 'en')).toContain('transformation method, so calculation is blocked')
    expect(surveyDiagnosticText(diagnostic, 'en')).not.toMatch(/JSON|transformType|coordinate-transform/)
    expect(diagnostic.message).toBe(message)
  })
  it('keeps rejected point and observation identifiers and unsupported units as original evidence', () => {
    const point = 'networkType-桥墩甲'
    const observation = 'obs_07'
    const unit = '现场单位'
    for (const language of ['zh', 'en']) {
      const pointText = surveyLegacyDiagnosticText(`WorkWise JSON 已知点/未知点中存在重复点号 ${point}；点位映射不唯一，不能进入平差。`, language)
      const observationText = surveyLegacyDiagnosticText(`WorkWise JSON 中存在重复观测编号 ${observation}；残差与原始资料映射不唯一，不能进入平差。`, language)
      const unitText = surveyLegacyDiagnosticText(`WorkWise JSON 网络坐标/高程单位 ${unit} 尚无冻结的点位换算合同；不得把点位数值标记为米制或进入平差。`, language)
      expect(pointText).toContain(point)
      expect(observationText).toContain(observation)
      expect(unitText).toContain(unit)
      for (const text of [pointText, observationText, unitText]) expect(text).toMatch(/暂不能平差|adjustment is blocked/)
    }
  })
  it('does not suggest calculation for recognized formats still requiring conversion or baseline processing', () => {
    for (const [state, zh, en] of [
      ['archive-only', '不能直接用于平差', 'not adjusted directly'],
      ['converter-required', '先转换', 'Convert this file'],
      ['gnss-processing-required', 'GNSS 基线解算', 'GNSS baseline processing']
    ]) {
      const original = `已保留原始源文件，但 格式 test 不在当前 P0 厂商格式受理目录中；解析器或 fixture 识别仅用于审计和预检，不构成 adjustment-ready 许可。当前处置为 ${state}。`
      expect(surveyDiagnosticText({ message: original }, 'zh')).toContain(zh)
      expect(surveyDiagnosticText({ message: original }, 'en')).toContain(en)
    }
  })
  it('keeps readable runtime causes while hiding internal error codes and payloads', () => {
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'survey_invalid', message: '网络没有观测记录' } }), 'en')).toBe('The network has no observation records.')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: 'survey_invalid', message: '网络没有观测记录' }), 'en')).toBe('The network has no observation records.')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'survey_invalid', message: '网络没有观测记录' } }), 'zh')).toBe('网络没有观测记录')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'calculation_failed', message: 'The closure difference exceeds the project tolerance.' } }), 'en'))
      .toBe('The closure difference exceeds the project tolerance.')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'survey_invalid', message: 'survey_parser_contract: unsupported field WI83' } }), 'en'))
      .toBe('The survey record contains unsupported field WI83. Check the instrument export format or reimport a compatible export.')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'survey_invalid', message: 'survey_parser_contract: unsupported field WI83' } }), 'zh'))
      .toBe('测量记录包含当前不支持的字段 WI83。请检查仪器导出格式，或使用兼容格式重新导入。')
    expect(surveyRuntimeErrorText('{"unknown":"原始内容"}', 'en')).toBe('This action could not be completed. Please try again.')
    expect(surveyLegacyDiagnosticText('网络没有观测记录', 'zh')).toBe('网络没有观测记录')
  })

  it('explains connection and generic service failures without startup implementation details', () => {
    const failures = [
      '无法连接到 RailWise AI Runtime。请稍后重试。',
      'Unable to connect to RailWise AI Runtime.',
      'Managed runtime did not report ready before startup timed out',
      JSON.stringify({ error: { message: 'Runtime startup timed out after 45000ms', code: 'runtime_unavailable' } })
    ]
    for (const failure of failures) {
      expect(surveyRuntimeErrorText(failure, 'zh')).toBe('测量服务尚未连接，请重试连接；已有任务资料会保留。')
      expect(surveyRuntimeErrorText(failure, 'en')).toBe('The survey service is not connected. Try reconnecting; your task data will remain saved.')
    }
    for (const failure of ['Runtime request failed (503)', 'Runtime request failed.', JSON.stringify({ error: { message: 'Runtime request failed (502)' } })]) {
      expect(surveyRuntimeErrorText(failure, 'zh')).toBe('本次操作未能完成，请稍后重试。')
      expect(surveyRuntimeErrorText(failure, 'en')).toBe('This action could not be completed. Please try again.')
    }
  })

  it('keeps a specific legacy failure when no translation is available', () => {
    expect(surveyDiagnosticText({ message: 'WI83 第 19 行无效', suggestion: '检查第 19 行' }, 'en')).toBe('WI83 第 19 行无效')
    expect(surveyDiagnosticText({ message: 'failure', suggestion: '检查第 19 行', localized: { en: { message: 'failure' } } }, 'en', 'action')).toBe('检查第 19 行')
  })
  it('translates only recognized legacy templates and preserves numeric details', () => {
    expect(surveyLegacyDiagnosticText('识别为 COSA(科傻) / cosa-in2，置信度 98%', 'en')).toBe('Recognized COSA IN2; confidence 98%')
    expect(surveyLegacyDiagnosticText('识别为 COSA(科傻) / cosa-in2，置信度 98%', 'zh')).toBe('识别为 科傻 COSA IN2，置信度 98%')
    expect(surveyLegacyDiagnosticText('文本编码 gb18030', 'en')).toBe('Text encoding: gb18030')
    expect(surveyLegacyDiagnosticText('文本编码 项目自定义', 'en')).toBe('文本编码 项目自定义')
    expect(surveyLegacyDiagnosticText('constructor', 'en')).toBe('constructor')
  })

  it('removes the installed quality-gate wording even when the catalog version is omitted', () => {
    const installed = 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；P0 格式目录 当前资料可进入计算前检查：严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断。'
    const displayed = surveySourceDiagnosticText({ code: 'format_detected', message: installed }, 'zh-CN', 'adjustment-ready', true)
    expect(displayed).toBe('资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件；任一条件未满足时，系统会暂停计算。')
    expect(displayed).not.toMatch(/P0|格式目录|解析对象|策略校验|解析器|cosa-in2|adjustment-ready/)
  })

  it('removes the complete needs-attention copy captured from the installed app', () => {
    const captured = 'COSA(科傻) / cosa-in2 已保留可审计的解析对象；P0 格式目录 当前资料可进入计算前检查：严格结构解析、记录锚点和单位转换成功后可进入策略校验；解析、基准、拓扑、闭合或精度条件不满足时仍会被阻断平差。'
    const displayed = surveySourceDiagnosticText({ code: 'format_detected', message: captured }, 'zh-CN', 'adjustment-ready', true)

    expect(displayed).toBe('资料已识别。开始计算前，请确认坐标基准、控制点、观测关系、闭合差和精度条件；任一条件未满足时，系统会暂停计算。')
    expect(displayed).not.toMatch(/COSA|cosa-in2|P0|格式目录|解析对象|解析器|fixture|记录锚点|策略校验|adjustment-ready|workwise-survey-format-catalog/)
  })

  it.each([
    ['tool: survey_read_context；S1 残差 0.4 mm，未超过限差。', 'survey_read_context'],
    ['工具名：survey_adjustment；S1 残差 0.4 mm，未超过限差。', 'survey_adjustment']
  ])('filters tool fields in diagnostic text without dropping measurements', (input, internalLabel) => {
    const displayed = surveyLegacyDiagnosticText(input, 'zh-CN')
    expect(displayed).toContain('S1 残差 0.4 mm，未超过限差')
    expect(displayed).not.toContain(internalLabel)
    expect(displayed).not.toMatch(/tool:|工具名/i)
  })

  it('preserves point labels named P0 while hiding catalog policy wording', () => {
    expect(surveyLegacyDiagnosticText('P0 残差 0.4 mm，未超过限差。', 'zh-CN')).toContain('P0 残差')
    expect(surveyLegacyDiagnosticText('P0 格式目录当前策略需要复核。', 'zh-CN')).not.toContain('P0')
  })
})
