import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { buildProfessionalReportModel, makeProfessionalDocx, makeProfessionalXlsx, professionalReportCellText, type ProfessionalReportModel } from './survey-professional-report.js'
import { makeProfessionalReportPdf } from './engineering-report-pdf.js'
import { readReportPdf } from '../../tests/helpers/report-pdf.js'
import { SurveyService } from './survey-service.js'
import { buildSurveyProfessionalReview } from './survey-professional-review.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { MonitoringProfessionalReportV1 } from '../contracts/engineering-monitoring-report.js'
import { buildMonitoringProfessionalReport } from './engineering-monitoring-report.js'
import type { MonitoringObservationV1, RailwiseProjectV1 } from '../contracts/engineering.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'survey-report-'))
  const survey = new SurveyService({ rootDir: root })
  try {
    const network = await importWorkwiseSurveyNetwork(survey, { projectId: 'professional-report', expectedRevision: 0, idempotencyKey: 'report-network-import', networkType: 'leveling', network: {
      coordinateSystem: 'LOCAL', projection: 'none', ellipsoid: 'none', verticalDatum: '1985-height',
      knownPoints: [{ id: 'BM01', height: 100, known: true, pointClass: 'known' }], unknownPoints: [{ id: 'P01', height: 101, known: false, pointClass: 'unknown' }],
      observations: [
        { id: 'forward', type: 'height-difference', from: 'BM01', to: 'P01', value: 1.23456789, unit: 'm', sigma: 0.002, sigmaUnit: 'm', routeLength: 1 },
        { id: 'back', type: 'height-difference', from: 'P01', to: 'BM01', value: -1.23356789, unit: 'm', sigma: 0.004, sigmaUnit: 'm', routeLength: 4 }
      ], instrumentParameters: { closureTolerance: 0.002 }
    } })
    const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'report-network-check' })
    const output = survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'report-network-adjust' })
    const review = buildSurveyProfessionalReview({ projectId: 'professional-report', result: output.result, network: survey.getNetwork(network.id), sourceIntegrity: 'verified' })
    const model = buildProfessionalReportModel({ project: { name: '水准复测合成验收', monitoringType: 'leveling-network', workspace: root }, reviews: [{ review, adjustment: output.result }], generatedAt: '2026-09-30T08:00:00.000Z' })
    return { review, model }
  } finally { survey.close() }
}

async function comparisonFixture() {
  const root = await mkdtemp(join(tmpdir(), 'survey-comparison-report-'))
  const survey = new SurveyService({ rootDir: root })
  try {
    const outputs = []
    for (let period = 0; period < 2; period += 1) {
      const network = await importWorkwiseSurveyNetwork(survey, { projectId: 'comparison-report', expectedRevision: 0, idempotencyKey: `comparison-import-${period}`, name: `period-${period + 1}.json`, network: {
        networkType: 'leveling', coordinateSystem: 'LOCAL', verticalDatum: 'LOCAL-BM', observationEpoch: `2026-09-0${period + 1}T00:00:00.000Z`,
        knownPoints: [{ id: 'BM', height: 10, known: true }], unknownPoints: [{ id: 'P', height: 11 }],
        observations: [
          { id: 'fwd', type: 'height-difference', from: 'BM', to: 'P', value: period ? 0.998 : 1.003, unit: 'm', routeLength: 100 },
          { id: 'back', type: 'height-difference', from: 'P', to: 'BM', value: period ? -0.996 : -1, unit: 'm', routeLength: 100 }
        ]
      } })
      const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `comparison-validate-${period}` })
      outputs.push(survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `comparison-adjust-${period}` }))
    }
    const comparison = survey.comparePeriodSegments('comparison-report', {
      referenceAdjustmentId: outputs[0]!.run.id, currentAdjustmentId: outputs[1]!.run.id,
      segments: [{ id: 'BM-P', from: 'BM', to: 'P', referenceObservationIds: ['fwd'], currentObservationIds: ['back'] }],
      idempotencyKey: 'comparison-report-signed-route'
    })
    const input = { project: { name: '两期水准测段成果验收', monitoringType: 'leveling-network', workspace: root },
      reviews: outputs.map(output => ({ review: survey.getProfessionalReview(output.run.id)!, adjustment: output.result })),
      segmentComparisons: [comparison], generatedAt: '2026-10-01T00:00:00.000Z' }
    return { input, comparison, model: buildProfessionalReportModel(input) }
  } finally { survey.close() }
}

describe('professional survey report formats', () => {
  it('uses one frozen projection for professional rows and keeps unavailable values explicit', async () => {
    const { review, model } = await fixture()
    expect(model.taskType).toBe('水准网')
    expect(model.reviewStatus).toBe('unsigned')
    expect(model).not.toHaveProperty('comparisonBinding')
    const points = model.tables.find(table => table.id.endsWith('-points'))!
    expect(points.columns.map(column => column.key)).not.toContain('x')
    expect(points.columns.map(column => column.key)).toContain('height')
    expect(points.rows[1]?.height).toBe(review.points[1]?.height)
    const reference = model.tables.find(table => table.id.endsWith('-reference'))!
    expect(reference.note).toContain('高程基准：1985-height；单位：m')
    expect(reference.note).not.toContain('投影')
    expect(reference.note).not.toContain('rad')
    const observations = model.tables.find(table => table.id.endsWith('-observations'))!
    expect(observations.rows.map(row => row.observed)).toEqual(review.observations.map(row => row.observed))
    expect(observations.rows.map(row => row.adjusted)).toEqual(review.observations.map(row => row.adjusted))
    const topology = model.tables.find(table => table.id.endsWith('-network-topology'))!
    expect(topology.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ observationId: 'forward', from: 'BM01', to: 'P01', routeLength: 1, closurePath: expect.stringContaining('leveling-cycle:forward（正向）'), source: expect.stringContaining('workwise-json-observation-1') }),
      expect.objectContaining({ observationId: 'back', from: 'P01', to: 'BM01', routeLength: 4, closurePath: expect.stringContaining('leveling-cycle:forward（正向）') })
    ]))
    expect(model.tables.find(table => table.id.endsWith('-closures'))?.rows[0]).toMatchObject({ length: 5, stationCount: undefined, toleranceBasis: 'network.instrumentParameters.closureTolerance' })
    expect(professionalReportCellText(undefined)).toBe('不可用')
    expect(professionalReportCellText(0)).toBe('0')
    expect(model.signoff.every(item => item.name === '' && item.date === '' && item.signature === '')).toBe(true)
    expect(model.tables.find(table => table.id.endsWith('-checks'))?.rows).toContainEqual(expect.objectContaining({ id: '规范符合性', status: '未评估' }))
  })

  it('renders real DOCX tables with repeating headers, blank signoff and page fields', async () => {
    const { model } = await fixture()
    const zip = await JSZip.loadAsync(await makeProfessionalDocx(model))
    const document = await zip.file('word/document.xml')!.async('text')
    const footer = await zip.file('word/footer1.xml')!.async('text')
    expect(document).toContain('<w:tbl>')
    expect(document).toContain('<w:tblHeader/>')
    expect(document).toContain('高程 (m)')
    expect(document).toContain('网形与测段索引')
    expect(document).toContain('闭合/附合路径')
    expect(document).toContain('残差范数仅作描述性统计，不等同闭合差')
    expect(document).toContain('未评估')
    expect(document).toContain('签认栏')
    expect(document).toContain('<w:tc><w:p/></w:tc>')
    expect(footer).toContain('w:instr="PAGE"')
    expect(footer).toContain('w:instr="NUMPAGES"')
  })

  it('keeps monitoring daily rows structured when survey results share the professional report', async () => {
    const { review } = await fixture()
    const monitoringReport = MonitoringProfessionalReportV1.parse({
      schemaVersion: 1, projectId: 'professional-report', datasetId: 'dataset-1', sourceFileHash: 'a'.repeat(64), algorithmVersion: 'analysis-1', status: 'draft', generatedAt: '2026-10-01T00:00:00.000Z',
      rows: [{ schemaVersion: 1, projectId: 'professional-report', datasetId: 'dataset-1', monitoringItem: '沉降', point: 'P-01', initialTimestamp: '2026-09-01', previousTimestamp: '2026-09-30', currentTimestamp: '2026-10-01', initialValue: 0, previousValue: 1.2, currentValue: 1.8, periodChange: 0.6, cumulativeChange: 1.8, ratePerDay: 0.6, unit: 'mm', threshold: 10, thresholdStatus: 'normal', continuity: 'continuous', sourceRows: [2, 3, 4], sourceFileHash: 'a'.repeat(64) }]
    })
    const model = buildProfessionalReportModel({ project: { id: 'professional-report', name: '结构化日报', monitoringType: 'leveling-network', workspace: '/tmp' }, reviews: [{ review }], monitoringReport, generatedAt: '2026-10-01T00:00:00.000Z' })
    const daily = model.tables.find(table => table.id === 'monitoring-daily')!
    expect(daily.rows[0]).toMatchObject({ point: 'P-01', cumulative: 1.8, source: expect.stringContaining('a'.repeat(64)) })
    const docx = await JSZip.loadAsync(await makeProfessionalDocx(model))
    expect(await docx.file('word/document.xml')!.async('text')).toContain('监测日报与累计变化')
    const xlsx = await JSZip.loadAsync(await makeProfessionalXlsx(model))
    expect(await xlsx.file('xl/workbook.xml')!.async('text')).toContain('监测日报与累计变化')
  })

  it('keeps numeric cells, Chinese table names, frozen headers and printing definitions in XLSX', async () => {
    const { model } = await fixture()
    const zip = await JSZip.loadAsync(await makeProfessionalXlsx(model))
    const workbook = await zip.file('xl/workbook.xml')!.async('text')
    expect(workbook).toContain('点位成果与精度')
    expect(workbook).toContain('网形与测段索引')
    expect(workbook).toContain('_xlnm.Print_Titles')
    expect(workbook).toContain('_xlnm.Print_Area')
    const sheets = await Promise.all(Object.keys(zip.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(name => zip.file(name)!.async('text')))
    const observationSheet = sheets.find(sheet => sheet.includes('观测号') && sheet.includes('<v>1.23456789</v>'))!
    expect(observationSheet).toContain('state="frozen"')
    expect(observationSheet).toContain('<v>1.23456789</v>')
    expect(observationSheet).toContain('orientation="landscape"')
    expect(sheets.some(sheet => sheet.includes('不可用'))).toBe(true)
    expect(observationSheet).not.toContain('<t>1.23456789</t>')
    expect(sheets.some(sheet => sheet.includes('签认状态') && sheet.includes('未签认'))).toBe(true)
  })

  it('prints all rows beyond one page with repeated headers and the bundled Chinese font', async () => {
    const { model } = await fixture()
    const table = model.tables.find(item => item.id.endsWith('-observations'))!
    const long: ProfessionalReportModel = { ...model, tables: [{ ...table, rows: Array.from({ length: 145 }, (_, index) => ({ ...table.rows[0], id: `观测-${String(index).padStart(3, '0')}`, source: `第 ${index + 1} 行` })) }] }
    const bytes = await makeProfessionalReportPdf(long)
    const read = await readReportPdf(bytes)
    expect(read.pageCount).toBeGreaterThan(2)
    expect(read.text).toContain('观测-000')
    expect(read.text).toContain('观测-144')
    expect(read.text).toContain('1.2345678900')
    expect(read.text.match(/观测号/g)!.length).toBeGreaterThan(2)
    expect(read.text).toContain('签认栏（空白 / 未签认）')
    expect(bytes.toString('latin1')).toContain('/FontFile2')
    expect(bytes.toString('latin1')).toContain('/ToUnicode')
  }, 20000)

  it('binds both periods and projects stored segment differences with ordered observation sources', async () => {
    const { input, comparison, model } = await comparisonFixture()
    const before = JSON.stringify(input)
    const observed = model.tables.find(table => table.id === `${comparison.id}-segment-observed`)!
    const adjusted = model.tables.find(table => table.id === `${comparison.id}-segment-adjusted`)!
    expect(observed.rows[0]).toMatchObject({ id: 'BM-P', from: 'BM', to: 'P', reference: 1.003, current: 0.996, change: expect.closeTo(-7, 10), standards: '未评估' })
    expect(adjusted.rows[0]).toMatchObject({ reference: expect.closeTo(1.0015, 10), current: expect.closeTo(0.997, 10), change: expect.closeTo(-4.5, 10), standards: '未评估' })
    expect(observed.columns).toContainEqual(expect.objectContaining({ key: 'change', unit: 'mm', decimals: 4 }))
    expect(observed.note).toContain('本期减原测的测段高差变化，不代表测点绝对沉降')
    expect(model.comparisonBinding?.[0]).toMatchObject({ comparisonId: comparison.id, inputHash: comparison.inputHash,
      reference: { adjustmentId: comparison.referenceAdjustmentId, epoch: comparison.referenceEpoch, resultHash: comparison.referenceResultHash, projectionHash: comparison.referenceProjectionHash, sourceSha256: input.reviews[0]!.review.source.sha256 },
      current: { adjustmentId: comparison.currentAdjustmentId, epoch: comparison.currentEpoch, resultHash: comparison.currentResultHash, projectionHash: comparison.currentProjectionHash, sourceSha256: input.reviews[1]!.review.source.sha256 } })
    const members = model.tables.find(table => table.id === `${comparison.id}-segment-members`)!
    expect(members.rows).toMatchObject([{ period: '原测期', observationId: 'fwd', sourceRecordId: 'workwise-json-observation-1' }, { period: '本期', observationId: 'back', sourceRecordId: 'workwise-json-observation-2' }])
    const versions = model.tables.find(table => table.id === 'version-appendix')!
    expect(versions.rows).toContainEqual({ networkId: comparison.id, kind: '比较输入', hash: comparison.inputHash })
    expect(versions.rows).toContainEqual({ networkId: comparison.id, kind: '本期源文件', hash: input.reviews[1]!.review.source.sha256 })
    expect(JSON.stringify(input)).toBe(before)
    expect(() => buildProfessionalReportModel({ ...input, reviews: input.reviews.slice(1) })).toThrow('matching frozen')
    expect(() => buildProfessionalReportModel({ ...input, segmentComparisons: [{ ...comparison, currentProjectionHash: '0'.repeat(64) }] })).toThrow('matching frozen')
    expect(() => buildProfessionalReportModel({ ...input, segmentComparisons: [comparison, comparison] })).toThrow('duplicate')
    expect(() => buildProfessionalReportModel({ ...input, segmentComparisons: [{ ...comparison, segments: [{ ...comparison.segments[0]!, currentObservationIds: ['missing'] }] }] })).toThrow('not anchored')
  })

  it('exports the same signed differences, units and source bindings to DOCX, PDF and XLSX', async () => {
    const { model, comparison } = await comparisonFixture()
    const docx = await JSZip.loadAsync(await makeProfessionalDocx(model))
    const document = await docx.file('word/document.xml')!.async('text')
    const xlsx = await JSZip.loadAsync(await makeProfessionalXlsx(model))
    const workbook = await xlsx.file('xl/workbook.xml')!.async('text')
    const sheets = await Promise.all(Object.keys(xlsx.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(name => xlsx.file(name)!.async('text')))
    const comparisonSheets = sheets.filter(sheet => sheet.includes('本期减原测 (mm)'))
    expect(comparisonSheets).toHaveLength(2)
    for (const [index, sheet] of comparisonSheets.entries()) {
      const segment = comparison.segments[0]!
      expect(sheet).toContain(`<v>${(index === 0 ? segment.observedChangeMetres : segment.adjustedChangeMetres) * 1000}</v>`)
      expect(sheet).toContain(`<v>${index === 0 ? segment.currentObservedMetres : segment.currentAdjustedMetres}</v>`)
      expect(sheet).toContain('未评估')
    }
    expect(workbook).toContain('测段观测高差比较')
    expect(workbook).toContain('测段平差高差比较')
    const pdf = await readReportPdf(await makeProfessionalReportPdf(model))
    for (const text of ['测段观测高差比较', '测段平差高差比较', '本期减原测', '-7.0000', '-4.5000', 'fwd', 'back', comparison.inputHash]) {
      expect(document.replace(/<[^>]+>/g, '')).toContain(text)
      expect(pdf.text.replace(/\s+/g, '')).toContain(text.replace(/\s+/g, ''))
    }
    expect(pdf.text).toContain('规范符合性未评估')
    expect(pdf.text.replace(/\s+/g, '')).toContain('不代表测点绝对沉降')
    expect(document).toContain('<w:tc><w:p/></w:tc>')
  }, 20000)

  it('projects the monitoring daily report into the professional formats and version appendix', async () => {
    const sourceFileHash = 'b'.repeat(64)
    const monitoringReport: MonitoringProfessionalReportV1 = {
      schemaVersion: 1, projectId: 'monitoring-project', datasetId: 'monitoring-dataset', sourceFileHash,
      algorithmVersion: 'monitoring-analysis-v2', status: 'draft', generatedAt: '2026-09-11T02:00:00.000Z',
      rows: [{ schemaVersion: 1, projectId: 'monitoring-project', datasetId: 'monitoring-dataset', monitoringItem: '沉降', point: 'P-01',
        initialTimestamp: '2026-09-01T00:00:00Z', previousTimestamp: '2026-09-10T00:00:00Z', currentTimestamp: '2026-09-11T00:00:00Z',
        initialValue: 100, previousValue: 2, currentValue: 5, periodChange: 3, cumulativeChange: 5, ratePerDay: 3, unit: 'mm', threshold: 10,
        thresholdStatus: 'normal', continuity: 'continuous', sourceRows: [2, 3], sourceFileHash }]
    }
    const model = buildProfessionalReportModel({ project: { id: 'monitoring-project', name: '监测日报验收', monitoringType: 'deformation', workspace: '/tmp/professional-report' }, reviews: [], monitoringReport })
    expect(model.monitoringReport).toEqual(monitoringReport)
    expect(model.tables.find(table => table.id === 'monitoring-daily')?.rows[0]).toMatchObject({ item: '沉降', point: 'P-01', current: 5, periodChange: 3, unit: 'mm' })
    expect(model.tables.find(table => table.id === 'version-appendix')?.rows).toContainEqual({ networkId: 'monitoring-dataset', kind: '监测数据集源文件', hash: sourceFileHash })
    const docx = await JSZip.loadAsync(await makeProfessionalDocx(model))
    expect(await docx.file('word/document.xml')!.async('text')).toContain('监测日报与累计变化')
    const xlsx = await JSZip.loadAsync(await makeProfessionalXlsx(model))
    const workbook = await xlsx.file('xl/workbook.xml')!.async('text')
    expect(workbook).toContain('监测日报与累计变化')
    const pdf = await readReportPdf(await makeProfessionalReportPdf(model))
    expect(pdf.text.replace(/\s+/g, '')).toContain('监测日报与累计变化')
    expect(pdf.text).toContain(sourceFileHash)
  }, 20000)

  it('retains conflicting period units in all professional formats without publishing cross-unit conclusions', async () => {
    const project: RailwiseProjectV1 = { schemaVersion: 1, id: 'unit-conflict', name: '混合单位待审查', taskType: 'deformation', monitoringType: 'deformation', unit: 'mm', signConvention: 'positive', thresholds: { default: 10 }, reportPeriod: {}, workspace: '/tmp/unit-conflict', revision: 1, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
    const observations: MonitoringObservationV1[] = ['mm', 'm', 'mm'].map((unit, index) => ({ schemaVersion: 1, id: `unit-${index}`, projectId: project.id, datasetId: 'dataset-unit', monitoringItem: '沉降', point: 'P-01', timestamp: `2026-09-0${index + 1}`, value: [2, 5, 7][index]!, unit, sourceRow: index + 2, sourceFields: {} }))
    const monitoringReport = buildMonitoringProfessionalReport({ project, dataset: { schemaVersion: 1, id: 'dataset-unit', projectId: project.id, sourceFileName: 'mixed.csv', sourceFileHash: 'd'.repeat(64), fieldMapping: {}, unknownColumns: [], rowCount: 3, columnCount: 5, observationCount: 3, timeRange: { start: '2026-09-01', end: '2026-09-03' }, status: 'imported', revision: 1, createdAt: '2026-10-01', updatedAt: '2026-10-01', observations }, generatedAt: '2026-10-01' })
    const model = buildProfessionalReportModel({ project, reviews: [], monitoringReport })
    expect(model.tables.find(table => table.id === 'monitoring-daily')?.rows[0]).toMatchObject({ initial: undefined, previous: undefined, current: 7, periodChange: undefined, cumulative: undefined, rate: undefined, threshold: undefined, status: '待确认', projectUnit: 'mm', unitAlignment: '来源单位与项目单位不一致', unitStatus: '冲突', unitConflictUnits: 'm / mm' })
    expect(model.tables.find(table => table.id === 'monitoring-unit-conflicts')?.rows).toMatchObject([{ period: '初始期', value: 2, unit: 'mm', source: 2 }, { period: '上期', value: 5, unit: 'm', source: 3 }, { period: '本期', value: 7, unit: 'mm', source: 4 }])
    const docx = await JSZip.loadAsync(await makeProfessionalDocx(model))
    const document = await docx.file('word/document.xml')!.async('text')
    const xlsx = await JSZip.loadAsync(await makeProfessionalXlsx(model))
    const sheets = await Promise.all(Object.keys(xlsx.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(name => xlsx.file(name)!.async('text')))
    const conflictSheet = sheets.find(sheet => sheet.includes('原始值') && sheet.includes('原始单位'))!
    expect(conflictSheet).toContain('<v>5</v>')
    expect(conflictSheet).toContain('>m</t>')
    const pdf = await readReportPdf(await makeProfessionalReportPdf(model))
    for (const text of ['监测单位冲突原始期次', '冲突', '待确认', '原始单位']) {
      expect(document.replace(/<[^>]+>/g, '')).toContain(text)
      expect(pdf.text.replace(/\s+/g, '')).toContain(text)
    }
  }, 20000)

  it('projects frozen multi-epoch deformation points, pairs and evidence hashes', async () => {
    const { review } = await fixture()
    const deformation = {
      schemaVersion: 1 as const,
      id: 'deformation-report-001', projectId: 'professional-report', referenceAdjustmentId: 'adjustment-reference', currentAdjustmentId: 'adjustment-current',
      adjustmentIds: ['adjustment-reference', 'adjustment-current'], referenceEpoch: '2026-09-01T00:00:00.000Z', currentEpoch: '2026-09-11T00:00:00.000Z', durationDays: 10,
      epochs: [
        { adjustmentId: 'adjustment-reference', resultId: 'result-reference', networkId: 'network-reference', observationEpoch: '2026-09-01T00:00:00.000Z', inputHash: 'input-reference', resultHash: 'result-reference-hash' },
        { adjustmentId: 'adjustment-current', resultId: 'result-current', networkId: 'network-current', observationEpoch: '2026-09-11T00:00:00.000Z', inputHash: 'input-current', resultHash: 'result-current-hash' }
      ],
      points: [{ pointId: 'P01', dX: 0.001, dY: -0.002, dH: -0.003, settlement: 0.003, horizontalDisplacement: Math.sqrt(0.000005), spatialDisplacement: Math.sqrt(0.000014), rates: { dXPerDay: 0.0001, dYPerDay: -0.0002, dHPerDay: -0.0003, settlementPerDay: 0.0003, horizontalPerDay: Math.sqrt(0.000005) / 10, spatialPerDay: Math.sqrt(0.000014) / 10 }, trend: 'settling' as const, combinedStandardError: 0.0005, standardizedDisplacement: 7, significant: true, unit: 'm' as const, rateUnit: 'm/day' as const }],
      pairs: [
        { id: 'convergence-001', firstPointId: 'P01', secondPointId: 'P02', kind: 'convergence' as const, distanceMode: 'horizontal' as const, referenceDistance: 10, currentDistance: 9.999, convergence: 0.001, convergenceRatePerDay: 0.0001, linearUnit: 'm' as const, rateUnit: 'm/day' as const, tiltUnit: 'ratio' as const },
        { id: 'tilt-001', firstPointId: 'P01', secondPointId: 'P02', kind: 'tilt' as const, distanceMode: 'horizontal' as const, baselineM: 20, differentialSettlement: 0.002, tilt: 0.0001, linearUnit: 'm' as const, rateUnit: 'm/day' as const, tiltUnit: 'ratio' as const }
      ],
      stabilityRateMPerDay: 0.00001, inputHash: 'deformation-input-hash', algorithmVersion: 'workwise-survey-deformation-1', createdAt: '2026-09-11T01:00:00.000Z'
    }
    const input = { project: { name: '变形专业成果验收', monitoringType: 'leveling-network', workspace: '/tmp/professional-report' }, reviews: [{ review }], deformations: [deformation], generatedAt: '2026-09-11T02:00:00.000Z' }
    const model = buildProfessionalReportModel(input)
    const epochs = model.tables.find(table => table.id === 'deformation-report-001-deformation-epochs')!
    const points = model.tables.find(table => table.id === 'deformation-report-001-deformation-points')!
    const pairs = model.tables.find(table => table.id === 'deformation-report-001-deformation-pairs')!
    expect(epochs.rows).toMatchObject([{ period: '原测期', inputHash: 'input-reference', resultHash: 'result-reference-hash' }, { period: '本期', inputHash: 'input-current', resultHash: 'result-current-hash' }])
    expect(points.rows[0]).toMatchObject({ pointId: 'P01', settlement: 3, horizontalDisplacement: expect.closeTo(Math.sqrt(5), 8), spatialDisplacement: expect.closeTo(Math.sqrt(14), 8), settlementPerDay: 0.3, trend: '沉降', significant: '显著' })
    expect(pairs.rows).toEqual(expect.arrayContaining([expect.objectContaining({ pairId: 'convergence-001', kind: '收敛', referenceDistance: 10, currentDistance: 9.999, convergence: 1, convergenceRatePerDay: 0.1 }), expect.objectContaining({ pairId: 'tilt-001', kind: '倾斜', baselineM: 20, differentialSettlement: 2, tilt: 0.0001 })]))
    const versions = model.tables.find(table => table.id === 'version-appendix')!
    expect(versions.rows).toContainEqual({ networkId: deformation.id, kind: '变形比较输入', hash: deformation.inputHash })
    expect(versions.rows).toContainEqual({ networkId: deformation.id, kind: '变形本期结果', hash: 'result-current-hash' })
    const before = JSON.stringify(model.tables)
    deformation.points[0]!.settlement = 99
    expect(JSON.stringify(model.tables)).toBe(before)
    const docx = await JSZip.loadAsync(await makeProfessionalDocx(model))
    expect(await docx.file('word/document.xml')!.async('text')).toContain('点位变形成果')
    const xlsx = await JSZip.loadAsync(await makeProfessionalXlsx(model))
    const sheets = await Promise.all(Object.keys(xlsx.files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).map(name => xlsx.file(name)!.async('text')))
    expect(sheets.some(sheet => sheet.includes('沉降 (mm)') && sheet.includes('3'))).toBe(true)
    const pdf = await readReportPdf(await makeProfessionalReportPdf(model))
    expect(pdf.text.replace(/\s+/g, '')).toContain('点位变形成果')
    expect(pdf.text).toContain('变形本期结果')
  }, 20000)
})
