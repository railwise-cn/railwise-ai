import { registerHooks } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from '../../../../node_modules/typescript/lib/typescript.js'

// Execute the inspected TypeScript, not an older compiled runtime directory.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/kun/src/')) {
      const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(source)) return { url: source.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.ts') && url.includes('/kun/src/')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false } }).outputText
    }
    return nextLoad(url, context)
  }
})

const { SurveyService } = await import('../../../../kun/src/engineering/survey-service.ts')
const { importWorkwiseSurveyNetwork } = await import('../../../../kun/src/engineering/survey-test-helpers.ts')
const { buildProfessionalReportModel, makeProfessionalDocx, makeProfessionalXlsx, professionalReportPresentation } = await import('../../../../kun/src/engineering/survey-professional-report.ts')
const { makeProfessionalReportPdf } = await import('../../../../kun/src/engineering/engineering-report-pdf.ts')
const { MonitoringProfessionalReportV1 } = await import('../../../../kun/src/contracts/engineering-monitoring-report.ts')
const outputDir = fileURLToPath(new URL('.', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'railwise-report-review-'))
const survey = new SurveyService({ rootDir: root })
const generatedAt = '2026-10-06T00:00:00.000Z'
const project = { id: 'report-audit', name: '公开合成水准复测成果', monitoringType: 'leveling-network', workspace: root }
const outputs = []
try {
  for (let period = 0; period < 2; period += 1) {
    const network = await importWorkwiseSurveyNetwork(survey, { projectId: project.id, expectedRevision: 0, idempotencyKey: `audit-import-${period}`, name: `公开合成水准第${period + 1}期.json`, network: {
      networkType: 'leveling', coordinateSystem: 'LOCAL', projection: 'none', ellipsoid: 'none', verticalDatum: 'LOCAL-BM', observationEpoch: `2026-09-0${period + 1}T00:00:00.000Z`,
      knownPoints: [{ id: 'BM01', height: 100, known: true, pointClass: 'known' }], unknownPoints: [{ id: 'P01', height: 101, known: false, pointClass: 'unknown' }],
      observations: [
        { id: 'forward', type: 'height-difference', from: 'BM01', to: 'P01', value: period ? 0.998 : 1.003, unit: 'm', sigma: 0.002, sigmaUnit: 'm', routeLength: 100 },
        { id: 'back', type: 'height-difference', from: 'P01', to: 'BM01', value: period ? -0.996 : -1, unit: 'm', sigma: 0.004, sigmaUnit: 'm', routeLength: 100 }
      ], instrumentParameters: { closureTolerance: 0.004 }
    } })
    const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `audit-check-${period}` })
    outputs.push(survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `audit-adjust-${period}` }))
  }
  const reviews = outputs.map(output => ({ review: survey.getProfessionalReview(output.run.id), adjustment: output.result }))
  const standard = buildProfessionalReportModel({ project, reviews: [reviews[0]], generatedAt })
  const comparison = survey.comparePeriodSegments(project.id, { referenceAdjustmentId: outputs[0].run.id, currentAdjustmentId: outputs[1].run.id,
    segments: [{ id: 'BM01-P01', from: 'BM01', to: 'P01', referenceObservationIds: ['forward'], currentObservationIds: ['back'] }], idempotencyKey: 'audit-segment-comparison' })
  const segment = buildProfessionalReportModel({ project, reviews, segmentComparisons: [comparison], generatedAt })
  const deformation = {
    schemaVersion: 1, id: 'deformation-internal-audit', projectId: project.id, referenceAdjustmentId: 'adjustment-reference', currentAdjustmentId: 'adjustment-current',
    adjustmentIds: ['adjustment-reference', 'adjustment-current'], referenceEpoch: '2026-09-01T00:00:00.000Z', currentEpoch: '2026-09-11T00:00:00.000Z', durationDays: 10,
    epochs: [{ adjustmentId: 'adjustment-reference', resultId: 'result-reference', networkId: 'network-reference', observationEpoch: '2026-09-01T00:00:00.000Z', inputHash: 'input-reference', resultHash: 'result-reference-hash' },
      { adjustmentId: 'adjustment-current', resultId: 'result-current', networkId: 'network-current', observationEpoch: '2026-09-11T00:00:00.000Z', inputHash: 'input-current', resultHash: 'result-current-hash' }],
    points: [{ pointId: 'P01', dX: 0.001, dY: -0.002, dH: -0.003, settlement: 0.003, horizontalDisplacement: Math.sqrt(0.000005), spatialDisplacement: Math.sqrt(0.000014),
      rates: { dXPerDay: 0.0001, dYPerDay: -0.0002, dHPerDay: -0.0003, settlementPerDay: 0.0003, horizontalPerDay: Math.sqrt(0.000005) / 10, spatialPerDay: Math.sqrt(0.000014) / 10 },
      trend: 'settling', combinedStandardError: 0.0005, standardizedDisplacement: 7, significant: true, unit: 'm', rateUnit: 'm/day' }],
    pairs: [{ id: '断面一', firstPointId: 'P01', secondPointId: 'P02', kind: 'convergence', distanceMode: 'horizontal', referenceDistance: 10, currentDistance: 9.999, convergence: 0.001, convergenceRatePerDay: 0.0001, linearUnit: 'm', rateUnit: 'm/day', tiltUnit: 'ratio' }],
    stabilityRateMPerDay: 0.00001, inputHash: 'deformation-input-hash', algorithmVersion: 'workwise-survey-deformation-1', createdAt: '2026-09-11T01:00:00.000Z'
  }
  const monitoringReport = MonitoringProfessionalReportV1.parse({ schemaVersion: 1, projectId: project.id, datasetId: 'monitoring-internal-audit', sourceFileHash: 'a'.repeat(64), algorithmVersion: 'monitoring-analysis-v2', status: 'draft', generatedAt,
    rows: [{ schemaVersion: 1, projectId: project.id, datasetId: 'monitoring-internal-audit', monitoringItem: '沉降', point: 'P01', initialTimestamp: '2026-09-01', previousTimestamp: '2026-09-10', currentTimestamp: '2026-09-11',
      initialValue: 0, previousValue: 1.2, currentValue: 1.8, periodChange: 0.6, cumulativeChange: 1.8, ratePerDay: 0.6, unit: 'mm', threshold: 10, thresholdStatus: 'normal', continuity: 'continuous', sourceRows: [2, 3, 4], sourceFileHash: 'a'.repeat(64) }] })
  const models = {
    standard,
    segment,
    deformation: buildProfessionalReportModel({ project: { ...project, name: '公开合成点位变形成果', monitoringType: 'deformation' }, reviews: [reviews[0]], deformations: [deformation], generatedAt }),
    monitoring: buildProfessionalReportModel({ project: { ...project, name: '公开合成监测日报', monitoringType: 'deformation' }, reviews: [], monitoringReport, generatedAt }),
    'long-table': { ...standard, title: '145 条观测分页检查', tables: [{ ...standard.tables.find(table => table.id.endsWith('-observations')), rows: Array.from({ length: 145 }, (_, index) => ({ ...standard.tables.find(table => table.id.endsWith('-observations')).rows[0], id: `观测-${String(index + 1).padStart(3, '0')}` })) }] },
    'heading-boundary': { ...standard, title: '标题与首行同页检查', tables: Array.from({ length: 12 }, (_, index) => ({ id: `layout-${index}`, title: `专业检核段 ${index + 1}`, columns: [{ key: 'id', label: '观测编号' }, { key: 'record', label: '原始记录与现场检查说明' }, { key: 'context', label: '复核说明' }, { key: 'status', label: '状态' }],
      rows: [{ id: `CHECK-${index + 1}`, record: '现场记录保留完整且未替换原始观测。'.repeat(14), context: '详细检查资料及基准。'.repeat(12), status: '需要复核' }] })) }
  }
  const hashes = {}
  for (const [name, model] of Object.entries(models)) {
    await writeFile(join(outputDir, `${name}.model.json`), JSON.stringify(model, null, 2))
    await writeFile(join(outputDir, `${name}.presentation.json`), JSON.stringify(professionalReportPresentation(model), null, 2))
    const outputs = { pdf: await makeProfessionalReportPdf(model), ...(!['long-table', 'heading-boundary'].includes(name) ? { docx: await makeProfessionalDocx(model), xlsx: await makeProfessionalXlsx(model) } : {}) }
    for (const [format, bytes] of Object.entries(outputs)) {
      const filename = `${name}.${format}`
      await writeFile(join(outputDir, filename), bytes)
      hashes[filename] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    }
  }
  const sources = ['kun/src/engineering/survey-professional-report.ts', 'kun/src/engineering/engineering-report-pdf.ts', 'kun/src/engineering/survey-professional-report.test.ts'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(`../../../../${path}`, import.meta.url))).digest('hex') }))
  await writeFile(join(outputDir, 'generation-summary.json'), JSON.stringify({ reviewType: 'AI senior survey/software/product source review', generatedAt: new Date().toISOString(), implementation: 'current TypeScript source through loader hooks', sources, outputs: hashes, fixtureBoundary: 'Public synthetic data; no vendor interoperability or professional human signature is asserted.' }, null, 2))
  console.log(JSON.stringify({ outputDir, outputs: Object.keys(hashes), sources }, null, 2))
} finally { survey.close() }
