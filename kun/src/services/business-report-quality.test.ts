import { describe, expect, it } from 'vitest'
import { businessReportQualityFeedback, requestsBusinessScreening } from './business-report-quality.js'
import { StructuredWebReportSchema } from './structured-web-report.js'

const source = { url: 'https://public.example.test/list', resultHash: 'a'.repeat(64) }
const report = () => StructuredWebReportSchema.parse({
  title: '工程服务订阅筛选日报',
  evidence: { coverage: [source], noMatches: [], items: ['one', 'two', 'three'].map(sectionId => ({
    sectionId, title: '匿名工程服务采购信息', source, discovery: source, classification: 'source',
    fields: [{ field: 'title', value: '匿名工程服务采购信息', quote: '匿名工程服务采购信息发布记录' }],
    unverifiedFields: ['budget', 'deadline', 'status', 'qualification']
  })) }
})
const goal = '按工程测量、测绘和监测服务筛选订阅信息'

describe('business report presentation feedback', () => {
  it('requires explicit screening only when business filtering is requested', () => {
    expect(requestsBusinessScreening(goal)).toBe(true)
    expect(requestsBusinessScreening('Filter subscriptions relevant to our company services')).toBe(true)
    expect(requestsBusinessScreening('读取订阅列表并按日期汇总')).toBe(false)
    expect(businessReportQualityFeedback('读取订阅列表并按日期汇总', report())).toBeUndefined()
    expect(businessReportQualityFeedback(goal, report())).toMatchObject({
      code: 'artifact_business_presentation_required', ready: false,
      issues: [{ kind: 'screening_required', sectionId: 'one' }, { kind: 'screening_required', sectionId: 'two' }, { kind: 'screening_required', sectionId: 'three' }]
    })
  })

  it('accepts complete mixed judgments without changing source evidence or unknown facts', () => {
    const value = report()
    value.presentation = { summary: '仅说明已列示的记录，未确认后续分页。', screening: [
      { sectionId: 'one', decision: 'relevant', reason: '标题包含工程测量服务范围', businessTypes: ['工程测量'], region: '地区未确认' },
      { sectionId: 'two', decision: 'excluded', reason: '采购范围属于其他设备供应' },
      { sectionId: 'three', decision: 'pending', reason: '仅凭列表信息还无法判断' }
    ] }
    const before = JSON.stringify(value)
    expect(businessReportQualityFeedback(goal, value)).toBeUndefined()
    expect(JSON.stringify(value)).toBe(before)
    expect(value.evidence.items.every(item => item.classification === 'source' && item.unverifiedFields.includes('qualification'))).toBe(true)
  })

  it('returns actionable issues for coverage prose in title and vague or incomplete judgments', () => {
    const value = report()
    value.title = '采集范围说明'.repeat(20)
    value.presentation = { screening: [{ sectionId: 'one', decision: 'relevant', reason: '相关' }] }
    expect(businessReportQualityFeedback(goal, value)?.issues).toEqual([
      { kind: 'concise_title_required' },
      { kind: 'reason_required', sectionId: 'one' },
      { kind: 'business_type_required', sectionId: 'one' },
      { kind: 'screening_required', sectionId: 'two' },
      { kind: 'screening_required', sectionId: 'three' }
    ])
  })

  it('does not invent screening rows for an actually empty result manifest', () => {
    const value = report()
    value.evidence.items = []
    expect(businessReportQualityFeedback(goal, value)).toBeUndefined()
  })
})
