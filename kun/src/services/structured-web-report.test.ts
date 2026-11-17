import { expect, it } from 'vitest'
import { renderStructuredWebReport, StructuredWebReportSchema, type StructuredWebReport } from './structured-web-report.js'

const report = () => ({ title: '工程监测招标资料', collectedAt: '2026-11-16T04:00:00+08:00', evidence: {
  coverage: [{ url: 'https://public.example.test/list?a=1&b=2', resultHash: 'a'.repeat(64) }],
  items: [{ sectionId: 'notice-1', title: '工程监测服务项目公开招标公告', source: { url: 'https://public.example.test/detail?id=1&kind=notice', resultHash: 'b'.repeat(64) },
    discovery: { url: 'https://public.example.test/list?a=1&b=2', resultHash: 'a'.repeat(64) }, classification: 'opportunity' as const,
    fields: [{ field: 'title' as const, value: '工程监测服务项目公开招标公告', quote: '工程监测服务项目公开招标公告' },
      { field: 'budget' as const, value: '808870元（含税）', quote: '本项目预算为808870元（含税），资金已落实。' },
      { field: 'deadline' as const, value: '2026年11月18日14时00分', quote: '投标截止时间为2026年11月18日14时00分。' }], unverifiedFields: [] }], noMatches: []
} })

it('keeps dates and money literal and returns the exact same evidence manifest', () => {
  const value = report(), rendered = renderStructuredWebReport('report.html', value)
  expect(rendered.verificationInput).toEqual({ path: 'report.html', ...value.evidence })
  expect(rendered.content).toContain('data-evidence-field="deadline">2026年11月18日14时00分</span>')
  expect(rendered.content).toContain('data-evidence-field="budget">808870元（含税）</span>')
  expect(rendered.content).toContain('原文摘录与待核验项')
  expect(rendered.content).toContain('来源核验以应用任务中的验证回执为准')
  expect(rendered.content).toContain('报告标注时间：')
  expect(rendered.content).not.toContain('草稿 · 来源尚待核验')
  expect(rendered.content).not.toContain('采集时间：')
  expect(rendered).not.toHaveProperty('complete')
  expect(rendered).not.toHaveProperty('verified')
})

it('renders title first for shuffled input without reordering the returned evidence manifest', () => {
  const value = report(); value.evidence.items[0]!.fields.reverse()
  const original = structuredClone(value.evidence)
  const rendered = renderStructuredWebReport('report.html', value)
  expect([...rendered.content.matchAll(/data-evidence-field="([^"]+)"/g)].map(match => match[1])).toEqual(['title', 'budget', 'deadline'])
  expect(rendered.verificationInput).toEqual({ path: 'report.html', ...original })
  expect(value.evidence).toEqual(original)
})

it('escapes report metadata, attribute URLs and values without external scripts or fonts', () => {
  const value = report(); value.title = '</title><script>alert("unsafe")</script><img src=x onerror=alert(1)>'
  const rendered = renderStructuredWebReport('report.html', value)
  expect(rendered.content).not.toContain('<script>')
  expect(rendered.content).not.toContain('<img')
  expect(rendered.content).toContain('&lt;script&gt;')
  expect(rendered.content).toContain('href="https://public.example.test/list?a=1&amp;b=2"')
  expect(rendered.content).not.toMatch(/<link\b|<script\b|@import|url\(/i)
  expect(rendered.content).toContain('@media(max-width:560px)')
})

it('normalizes source entity representation once, then safely escapes visible field text', () => {
  const value = report(); value.evidence.items[0]!.fields[0]!.value = 'R&amp;D工程监测服务项目公开招标公告'; value.evidence.items[0]!.fields[0]!.quote = 'R&amp;D工程监测服务项目公开招标公告'
  const rendered = renderStructuredWebReport('report.html', value)
  expect(rendered.content).toContain('data-evidence-field="title">R&amp;D工程监测服务项目公开招标公告</span>')
  expect(rendered.content).not.toContain('R&amp;amp;D')
  expect(rendered.verificationInput.items[0]!.fields[0]!.value).toBe('R&amp;D工程监测服务项目公开招标公告')
})

it('renders a feed item name and proposes literal title evidence from the required title without attesting it', () => {
  const value = report(); value.evidence.items[0]!.fields.shift()
  const original = structuredClone(value)
  const rendered = renderStructuredWebReport('feed.html', value, 'observed_feed')
  const item = rendered.verificationInput.items[0]!
  expect(rendered.content).toContain(`data-evidence-field="title">${item.title}</span>`)
  expect(item.fields.find(field => field.field === 'title')).toEqual({ field: 'title', value: item.title, quote: item.title })
  expect(value).toEqual(original)
  expect(rendered).not.toHaveProperty('complete')
  expect(rendered).not.toHaveProperty('verified')
})

it('keeps explicit title quotes and the legacy primary-document manifest unchanged', () => {
  const value = report(); value.evidence.items[0]!.fields[0]!.quote = `项目名称：${value.evidence.items[0]!.title}，详见公告。`
  expect(renderStructuredWebReport('feed.html', value, 'observed_feed').verificationInput).toEqual({ path: 'feed.html', ...value.evidence })
  value.evidence.items[0]!.fields.shift()
  expect(renderStructuredWebReport('primary.html', value).verificationInput).toEqual({ path: 'primary.html', ...value.evidence })
})

it('labels an observed-feed other owner excerpt neutrally without changing its literal evidence', () => {
  const value: StructuredWebReport = report(), owner = '业主单位：示例工程建设有限公司'
  value.evidence.items[0]!.classification = 'source'
  value.evidence.items[0]!.fields.push({ field: 'other', value: owner, quote: owner })
  const original = structuredClone(value)
  const rendered = renderStructuredWebReport('feed.html', value, 'observed_feed')
  expect(rendered.content).toContain(`<dt>列表原文摘录</dt><dd><span data-evidence-field="other">${owner}</span>`)
  expect(rendered.content).not.toContain('匹配依据（列表原文）')
  expect(rendered.verificationInput).toEqual({ path: 'feed.html', ...original.evidence })
  expect(value).toEqual(original)
  expect(renderStructuredWebReport('primary.html', value).content).toContain(`<dt>原文</dt><dd><span data-evidence-field="other">${owner}</span>`)
})

it('requires an actual longer source quote for a short feed title instead of manufacturing padding', () => {
  const value = report(); value.evidence.items[0]!.title = '测绘服务'; value.evidence.items[0]!.fields.shift()
  expect(() => renderStructuredWebReport('feed.html', value, 'observed_feed')).toThrow(/标题.*原文/)
  value.evidence.items[0]!.fields[0]!.quote = '本次测绘服务项目预算为808870元（含税）。'
  expect(renderStructuredWebReport('feed.html', value, 'observed_feed').verificationInput.items[0]!.fields.find(field => field.field === 'title')?.quote).toBe(value.evidence.items[0]!.fields[0]!.quote)
})

function screenedReport(count = 19): StructuredWebReport {
  const value: StructuredWebReport = report(), source = value.evidence.coverage[0]!
  value.evidence.items = Array.from({ length: count }, (_, index) => {
    const title = `合成工程服务列表记录第${index + 1}项`
    return { sectionId: `record-${index + 1}`, title, source, discovery: source, classification: 'source',
      fields: [{ field: 'title', value: title, quote: title },
        { field: 'publication_date', value: '2026年11月18日', quote: '列表标注日期：2026年11月18日' }],
      unverifiedFields: ['budget', 'deadline', 'status', 'qualification'] }
  })
  value.presentation = { summary: '本次按工程服务范围整理列表，保留筛选判断与来源字段的区别。',
    coverageNote: '本报告仅代表所列记录，不声称平台全部记录已覆盖。',
    screening: value.evidence.items.map((item, index) => ({ sectionId: item.sectionId,
      decision: index < 6 ? 'excluded' : 'relevant', reason: index < 6 ? 'AI判断与本次工程服务范围不符。' : 'AI判断与本次工程服务范围相关。',
      businessTypes: ['工程服务'], region: '区域待人工确认' })) }
  return value
}

function formalRegion(content: string): string {
  return content.split('<main data-evidence-report>')[1]!.split('</main>')[0]!
}

it('groups mixed AI screening outside the formal region and retains every source item exactly once', () => {
  const value = screenedReport(), original = structuredClone(value)
  const rendered = renderStructuredWebReport('screened.html', value, 'observed_feed'), main = formalRegion(rendered.content)
  const sourceIds = [...main.matchAll(/data-evidence-item="([^"]+)"/g)].map(match => match[1])
  const screeningIds = [...rendered.content.matchAll(/data-report-screening-item="([^"]+)"/g)].map(match => match[1])
  const expectedOrder = [...value.evidence.items.slice(6), ...value.evidence.items.slice(0, 6)].map(item => item.sectionId)
  expect(sourceIds).toEqual(expectedOrder)
  expect(screeningIds).toEqual(expectedOrder)
  expect(new Set(sourceIds).size).toBe(19)
  expect(new Set(screeningIds).size).toBe(19)
  expect(rendered.content).toContain('data-screening-count="relevant">相关记录：13</span>')
  expect(rendered.content).toContain('data-screening-count="pending">待判断：0</span>')
  expect(rendered.content).toContain('data-screening-count="excluded">排除附录：6</span>')
  expect(rendered.content.indexOf('data-screening-group="relevant"')).toBeLessThan(rendered.content.indexOf('data-screening-group="excluded"'))
  expect(rendered.content).toContain('AI筛选判断，不代表已核验事实、资质认定或投标资格')
  expect(rendered.content).toContain('AI筛选理由：')
  expect(rendered.content).toContain('AI业务类型判断：')
  expect(rendered.content).toContain('AI区域判断：')
  expect(rendered.content).toContain('来源字段附录')
  for (const id of sourceIds) expect(rendered.content).toContain(`href="#${id}"`)
  expect(main).not.toMatch(/data-report-screening|AI筛选|AI业务|AI区域|本次工程服务范围/)
  expect([...main.matchAll(/data-evidence-classification="source"/g)]).toHaveLength(19)
  expect(rendered.verificationInput).toEqual({ path: 'screened.html', ...value.evidence })
  expect(rendered.verificationInput).not.toHaveProperty('presentation')
  expect(value).toEqual(original)
})

it('places missing screening decisions in pending without manufacturing reasons or source facts', () => {
  const value = screenedReport(3)
  value.presentation!.screening = [{ sectionId: 'record-2', decision: 'relevant', reason: 'AI判断需要进一步核对服务范围。' }]
  const rendered = renderStructuredWebReport('partial.html', value, 'observed_feed'), main = formalRegion(rendered.content)
  expect(rendered.content).toContain('data-screening-count="relevant">相关记录：1</span>')
  expect(rendered.content).toContain('data-screening-count="pending">待判断：2</span>')
  expect(rendered.content).toContain('待判断（2）')
  expect(rendered.content).toContain('本条尚未提供AI筛选判断。')
  expect(rendered.content).toContain('AI业务类型判断：</strong>未判断')
  expect(rendered.content).toContain('AI区域判断：</strong>未判断')
  expect([...main.matchAll(/data-evidence-unverified>待核验/g)]).toHaveLength(12)
  expect(main).not.toContain('data-evidence-field="region"')
  expect(main).not.toContain('data-evidence-field="businessTypes"')
  expect(rendered.verificationInput.items).toEqual(value.evidence.items)
})

it('treats an explicitly empty screening list as pending for every declared record', () => {
  const value = screenedReport(2); value.presentation!.screening = []
  const rendered = renderStructuredWebReport('pending.html', value, 'observed_feed')
  expect(rendered.content).toContain('data-screening-count="pending">待判断：2</span>')
  expect([...rendered.content.matchAll(/data-report-screening-item="[^"]+" data-screening-decision="pending"/g)]).toHaveLength(2)
  expect([...formalRegion(rendered.content).matchAll(/data-evidence-item=/g)]).toHaveLength(2)
})

it('rejects duplicate or unknown screening section IDs rather than detaching analysis from source rows', () => {
  const value = screenedReport(2)
  value.presentation!.screening!.push({ ...value.presentation!.screening![0]! })
  expect(StructuredWebReportSchema.safeParse(value).success).toBe(false)
  value.presentation!.screening = [{ sectionId: 'not-in-the-report', decision: 'pending', reason: '合成判断说明' }]
  expect(StructuredWebReportSchema.safeParse(value).success).toBe(false)
  value.presentation!.screening = [{ sectionId: 'record-1', decision: 'pending', reason: '合成判断说明' }]
  expect(StructuredWebReportSchema.safeParse(value).success).toBe(true)
})

it('bounds presentation strings, classifications and collection sizes without extending literal evidence fields', () => {
  const value = screenedReport(1)
  const invalid = [
    { ...value, presentation: { summary: '字'.repeat(1201) } },
    { ...value, presentation: { coverageNote: '字'.repeat(1201) } },
    { ...value, presentation: { screening: Array.from({ length: 101 }, () => value.presentation!.screening![0]!) } },
    { ...value, presentation: { screening: [{ sectionId: 'record-1', decision: 'opportunity', reason: '合成判断' }] } },
    { ...value, presentation: { screening: [{ sectionId: 'record-1', decision: 'pending', reason: ' ' }] } },
    { ...value, presentation: { screening: [{ sectionId: 'record-1', decision: 'pending', reason: '字'.repeat(1201) }] } },
    { ...value, presentation: { screening: [{ sectionId: 'record-1', decision: 'pending', reason: '合成判断', businessTypes: ['字'.repeat(81)] }] } },
    { ...value, presentation: { screening: [{ sectionId: 'record-1', decision: 'pending', reason: '合成判断', businessTypes: Array(9).fill('工程服务') }] } },
    { ...value, presentation: { screening: [{ sectionId: 'record-1', decision: 'pending', reason: '合成判断', region: '字'.repeat(121) }] } },
    { ...value, presentation: { screening: [{ sectionId: 'record-1', decision: 'pending', reason: '合成判断', budget: '推测金额' }] } }
  ]
  for (const candidate of invalid) expect(StructuredWebReportSchema.safeParse(candidate).success).toBe(false)
})

it('escapes AI presentation text and keeps summary, coverage and report time separate from the heading', () => {
  const value = screenedReport(1); value.title = '合成筛选日报'
  value.presentation!.summary = '合成摘要<script>alert(1)</script>'
  value.presentation!.coverageNote = '合成覆盖范围 <今日记录>'
  value.presentation!.screening = [{ sectionId: 'record-1', decision: 'pending', reason: '<img src=x onerror=alert(1)>', businessTypes: ['R&D服务'], region: '<未知区域>' }]
  const rendered = renderStructuredWebReport('escaped.html', value, 'observed_feed')
  expect(rendered.content).toContain('<h1>合成筛选日报</h1>')
  expect(rendered.content).toContain('data-report-presentation="summary">合成摘要&lt;script&gt;')
  expect(rendered.content).toContain('覆盖说明（AI整理）：')
  expect(rendered.content).toContain('报告标注时间：')
  expect(rendered.content).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(rendered.content).toContain('R&amp;D服务')
  expect(rendered.content).toContain('&lt;未知区域&gt;')
  expect(rendered.content).not.toMatch(/<script\b|<img\b|<link\b|@import|url\(/i)
  expect(formalRegion(rendered.content)).not.toContain('合成摘要')
})

it('preserves legacy report structure while offering single-column mobile and readable print styles', () => {
  const value = report(); value.title = '字'.repeat(160)
  const rendered = renderStructuredWebReport('legacy.html', value)
  expect(rendered.content).toContain(`<h1>${value.title}</h1>`)
  expect(rendered.content).not.toContain('data-report-presentation=')
  expect(rendered.content).not.toContain('data-report-screening-item=')
  expect([...rendered.content.matchAll(/<main data-evidence-report>/g)]).toHaveLength(1)
  expect(formalRegion(rendered.content)).toContain('data-evidence-classification="opportunity"')
  expect(rendered.verificationInput).toEqual({ path: 'legacy.html', ...value.evidence })
  expect(rendered.content).toContain('@media(max-width:560px)')
  expect(rendered.content).toContain('.screening-cards{grid-template-columns:1fr}')
  expect(rendered.content).toContain('@media print')
  expect(rendered.content).toContain('break-inside:avoid')
})

it('keeps a maximum-sized screening report below the existing evidence parser node bound', () => {
  const value = screenedReport(100)
  value.presentation!.screening!.forEach(entry => { entry.businessTypes = Array(8).fill('合成业务类别') })
  const rendered = renderStructuredWebReport('bounded.html', value, 'observed_feed')
  expect([...rendered.content.matchAll(/<[a-z][a-z0-9:-]*\b/gi)].length).toBeLessThan(5000)
  expect([...formalRegion(rendered.content).matchAll(/data-evidence-item=/g)]).toHaveLength(100)
})
