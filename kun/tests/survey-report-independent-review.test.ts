import { describe, expect, it } from 'vitest'
import { professionalReportPresentation, type ProfessionalReportModel, type ProfessionalReportTable } from '../src/engineering/survey-professional-report.js'

function topology(network: string, order: string[], firstRow: number): ProfessionalReportTable {
  return { id: `${network}-network-topology`, title: `${network} · 网形与测段索引`, columns: [
    { key: 'observationId', label: '观测号' }, { key: 'from', label: '起点' }, { key: 'source', label: '原始定位' }, { key: 'observed', label: '观测值', numeric: true }
  ], rows: order.map((id, i) => ({ observationId: id, from: 'network-1-east', source: `record_${i} / 第 ${firstRow + i} 行`, observed: .1 + i })) }
}
function fixture(): ProfessionalReportModel {
  const one = 'cosa-in2-6-direction', two = 'cosa-in2-7-distance'
  return { title: '成果册', projectName: 'source identity review', taskType: '控制网', generatedAt: '2026-10-06T00:00:00Z',
    reviewStatus: 'unsigned', reportStatus: 'draft', sourceBinding: [
      { networkId: 'network-1', name: `${one}-reference.in2`, status: 'bound', integrity: 'verified' },
      { networkId: 'network-10', name: 'current.in2', status: 'bound', integrity: 'verified' }
    ], tables: [
      topology('network-1', [one, two], 6), topology('network-10', [two, one], 20),
      { id: 'source-binding', title: '资料与版本绑定', columns: [{ key: 'source', label: '原文件' }], rows: [{ source: `${one}-reference.in2` }] }
    ], notes: [], signoff: [] }
}
describe('independent professional report source identity review', () => {
  it('numbers repeated parser observation identities independently in each source', () => {
    const visible = professionalReportPresentation(fixture())
    for (const table of visible.tables.filter(t => t.id.endsWith('-network-topology'))) {
      expect(table.rows.map(row => row.observationId)).toEqual(['观测 1', '观测 2'])
    }
  })
  it('keeps point names and source filenames exact while hiding internal identities', () => {
    const input = fixture(), visible = professionalReportPresentation(input)
    expect(visible.tables[0]!.rows[0]!.from).toBe('network-1-east')
    expect(visible.tables.find(t => t.id === 'source-binding')!.rows[0]!.source).toBe(input.sourceBinding[0]!.name)
    expect(visible.tables[1]!.title).toBe('资料 2 · current.in2 · 网形与测段索引')
    expect(visible.tables[0]!.rows[0]!.source).toBe(`${input.sourceBinding[0]!.name} · 第 6 行`)
    expect(visible.tables[1]!.rows[0]!.source).toBe('current.in2 · 第 20 行')
    expect(visible.tables[0]!.rows[0]!.observed).toBe(.1)
  })
})
