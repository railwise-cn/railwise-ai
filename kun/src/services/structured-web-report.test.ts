import { expect, it } from 'vitest'
import { renderStructuredWebReport } from './structured-web-report.js'

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
