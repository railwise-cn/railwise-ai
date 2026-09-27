import { describe, expect, it } from 'vitest'
import { surveyDiagnosticText, surveyLegacyDiagnosticText, surveyRuntimeErrorText } from './survey-diagnostic-text'
import { lexLeicaGsi } from '../../../../../kun/src/engineering/survey-leica-gsi-lexer'

describe('Survey diagnostic presentation compatibility', () => {
  it('translates the rejected-source envelope through nested eligibility without rewriting IDs', () => {
    const message = '无法通过内容签名安全识别测量文件；不会回退为通用 CSV'
    const envelope = `archive-only: unknown_format — ${message}`
    expect(surveyLegacyDiagnosticText(envelope, 'en')).toBe('archive-only: unknown_format — The source format cannot be safely identified from its content signature; generic CSV fallback is disabled.')
    expect(surveyLegacyDiagnosticText(`源文件处置为 archive-only，不得进入平差：${envelope}`, 'en')).not.toMatch(/\p{Script=Han}/u)
    expect(surveyLegacyDiagnosticText(envelope, 'zh')).toBe(envelope)
    const unknown = 'archive-only: custom_code — 原始用户文本'
    expect(surveyLegacyDiagnosticText(unknown, 'en')).toBe(unknown)
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
        expect(surveyLegacyDiagnosticText(wrapped, 'zh')).toBe(wrapped)
      }
      expect(JSON.stringify(result)).toBe(original)
    }
  })
  it('preserves parser point names, record coordinates and numeric limits', () => {
    expect(surveyLegacyDiagnosticText('COSA .in1 已知点 桥墩甲 重复。', 'en')).toBe('COSA .in1 known point 桥墩甲 is duplicated.')
    expect(surveyLegacyDiagnosticText('COSA .in1 已知点 数据字段 重复。', 'en')).toBe('COSA .in1 known point 数据字段 is duplicated.')
    expect(surveyLegacyDiagnosticText('平面观测 网络没有观测记录 的点 信息字符 缺少 X/Y 坐标', 'en')).toBe('Point 信息字符 in planar observation 网络没有观测记录 has no X/Y coordinates.')
    expect(surveyLegacyDiagnosticText('COSA .in1 第 73 行必须是 from,to,height-difference(m),distance(km)，且 distance > 0。', 'en')).toBe('COSA .in1 line 73 must contain from,to,height-difference(m),distance(km), with distance > 0.')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'survey_source_invalid', message: '测量源文件超过 8 MiB 上限' } }), 'en')).toBe('survey_source_invalid: The survey source exceeds the limit of 8 MiB.')
    expect(surveyLegacyDiagnosticText('Leica GSI 第 17 行第 4 个 word 的WI51 第一组件含有不允许的字符 0x3a。', 'en')).toBe('Leica GSI line 17, word 4: WI51 first component contains the disallowed character 0x3a.')
  })
  it('selects English explanations and recovery without mutating original evidence', () => {
    const diagnostic = Object.freeze({ message: '原始诊断记录', suggestedAction: '原始恢复操作', localized: { en: { message: 'Record 19 has duplicate WI83 fields.', suggestedAction: 'Re-export record 19 with one WI83 final-height field.' } } })
    expect(surveyDiagnosticText(diagnostic, 'en-US')).toBe('Record 19 has duplicate WI83 fields.')
    expect(surveyDiagnosticText(diagnostic, 'en', 'action')).toContain('record 19')
    expect(surveyDiagnosticText(diagnostic, 'zh-CN')).toBe('原始诊断记录')
    expect(diagnostic.message).toBe('原始诊断记录')
  })
  it('translates historical strategy diagnostics while retaining identifiers, units and tolerances', () => {
    expect(surveyLegacyDiagnosticText('观测 angle-07 的中误差单位 arcmin 没有已确认的换算定义，不能进入平差。', 'en')).toBe('Observation angle-07 has no confirmed conversion for standard-error unit arcmin; adjustment is blocked.')
    expect(surveyLegacyDiagnosticText('水准闭合差 0.000127 超过限差 0.0001', 'en')).toBe('Leveling closure 0.000127 exceeds tolerance 0.0001.')
    expect(surveyLegacyDiagnosticText('平面控制网在 30 次迭代后未收敛', 'en')).toBe('The plane control network did not converge after 30 iterations.')
    expect(surveyLegacyDiagnosticText('平面观测 obs-7 的点 桥墩甲 缺少 X/Y 坐标', 'en')).toBe('Point 桥墩甲 in planar observation obs-7 has no X/Y coordinates.')
    expect(surveyLegacyDiagnosticText('来源准入证据无效：持久化记录哈希不匹配。', 'en')).toBe('Source admission evidence is invalid: The persisted record hash does not match.')
    expect(surveyLegacyDiagnosticText('原始资料完整性校验失败：自定义错误内容', 'en')).toContain('自定义错误内容')
  })
  it('preserves stable Runtime error codes and leaves unknown envelopes untouched', () => {
    expect(surveyRuntimeErrorText(JSON.stringify({ error: { code: 'survey_invalid', message: '网络没有观测记录' } }), 'en')).toBe('survey_invalid: The network has no observation records.')
    expect(surveyRuntimeErrorText(JSON.stringify({ error: 'survey_invalid', message: '网络没有观测记录' }), 'en')).toBe('survey_invalid: The network has no observation records.')
    expect(surveyRuntimeErrorText('{"unknown":"原始内容"}', 'en')).toBe('{"unknown":"原始内容"}')
    expect(surveyLegacyDiagnosticText('网络没有观测记录', 'zh')).toBe('网络没有观测记录')
  })

  it('keeps a specific legacy failure when no translation is available', () => {
    expect(surveyDiagnosticText({ message: 'WI83 第 19 行无效', suggestion: '检查第 19 行' }, 'en')).toBe('WI83 第 19 行无效')
    expect(surveyDiagnosticText({ message: 'failure', suggestion: '检查第 19 行', localized: { en: { message: 'failure' } } }, 'en', 'action')).toBe('检查第 19 行')
  })
  it('translates only recognized legacy templates and preserves numeric details', () => {
    expect(surveyLegacyDiagnosticText('识别为 COSA(科傻) / cosa-in2，置信度 98%', 'en')).toBe('Detected COSA / cosa-in2; confidence 98%')
    expect(surveyLegacyDiagnosticText('文本编码 gb18030', 'en')).toBe('Text encoding: gb18030')
    expect(surveyLegacyDiagnosticText('文本编码 项目自定义', 'en')).toBe('文本编码 项目自定义')
    expect(surveyLegacyDiagnosticText('constructor', 'en')).toBe('constructor')
  })
})
