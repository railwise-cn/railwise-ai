import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
import sax from 'sax'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { SurveySegmentComparisonV1 } from '../contracts/survey-monitoring.js'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

async function fixture(periodCount = 2) {
  const root = await mkdtemp(join(tmpdir(), 'survey-segment-delivery-'))
  let engineering!: EngineeringService
  const survey = new SurveyService({ rootDir: join(root, 'survey'), getProject: id => engineering.getProject(id) })
  let comparisonLookup: ((record: SurveySegmentComparisonV1) => SurveySegmentComparisonV1) | undefined
  engineering = new EngineeringService({
    rootDir: join(root, 'engineering'),
    getAdjustmentEvidence: (projectId, ids) => ids.flatMap(id => {
      const stored = survey.getAdjustmentForProjectNewUse(projectId, id)
      return stored?.result ? [{ run: stored.run, result: stored.result }] : []
    }),
    getProfessionalReview: (projectId, id) => {
      const review = survey.getProfessionalReview(id)
      return review?.projectId === projectId ? review : null
    },
    getSegmentComparison: (projectId, id) => {
      const record = survey.getPeriodSegmentComparisonForNewUse(projectId, id)
      return record && comparisonLookup ? comparisonLookup(record) : record
    },
    getSegmentContinuity: (projectId, ids) => survey.getContinuousSegmentSummaryForNewUse(projectId, ids),
    getSurveySources: (projectId, ids) => ids.flatMap(id => {
      const network = survey.getNetwork(id)
      return network?.projectId === projectId ? [{ networkId: id, sourceFile: network.sourceFile,
        sourceEligibility: survey.getSourceEligibility(id), rawSourceIntegrity: survey.getRawSourceIntegrity(id),
        observations: network.observations, points: [...network.knownPoints, ...network.unknownPoints] }] : []
    })
  })
  onTestFinished(() => { survey.close(); engineering.close() })
  const project = engineering.createProject({ name: 'Repeat leveling', taskType: 'leveling-network', workspace: join(root, 'workspace'), expectedRevision: 0, idempotencyKey: 'segment-project' })
  const outputs: Array<ReturnType<SurveyService['createAdjustment']>> = []
  for (let period = 0; period < periodCount; period++) {
    const network = await importWorkwiseSurveyNetwork(survey, { projectId: project.id, expectedRevision: project.revision,
      idempotencyKey: `segment-import-${period}`, networkType: 'leveling', network: {
        coordinateSystem: 'LOCAL', verticalDatum: 'LOCAL-BM', observationEpoch: `2026-09-0${period + 1}T00:00:00.000Z`,
        knownPoints: [{ id: 'BM', height: 10, known: true }], unknownPoints: [{ id: 'P', height: 11 }],
        observations: [
          { id: 'forward', type: 'height-difference', from: 'BM', to: 'P', value: 1 - period * 0.002, unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
          { id: 'back', type: 'height-difference', from: 'P', to: 'BM', value: -1 + period * 0.002, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }
        ]
      } })
    const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `segment-check-${period}` })
    outputs.push(survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `segment-adjust-${period}` }))
  }
  const segmentRequest = (referenceIndex: number, currentIndex: number, idempotencyKey: string) => survey.comparePeriodSegments(project.id, {
    referenceAdjustmentId: outputs[referenceIndex]!.run.id, currentAdjustmentId: outputs[currentIndex]!.run.id,
    segments: [{ id: 'BM-P', from: 'BM', to: 'P', referenceObservationIds: ['forward'], currentObservationIds: ['back'] }], idempotencyKey
  })
  const comparisons = [segmentRequest(0, 1, 'compare')]
  if (periodCount > 2) comparisons.push(segmentRequest(1, 2, 'compare-2'))
  const comparison = comparisons[0]!
  const request = { projectId: project.id, expectedRevision: project.revision, adjustmentIds: outputs.map(item => item.run.id), segmentComparisonIds: comparisons.map(item => item.id), idempotencyKey: 'segment-preview' }
  return { root, survey, engineering, project, outputs, comparison, comparisons, request, setLookup: (lookup: typeof comparisonLookup) => { comparisonLookup = lookup } }
}

describe('repeat-survey comparison delivery', () => {
  it('freezes selected periods, restores their descriptors and preserves evidence in draft/replay/verification', async () => {
    const { root, engineering, project, comparison, request } = await fixture()
    const preview = await engineering.previewReport(request)
    expect(preview.segmentComparisons).toEqual([comparison])
    const output = preview.files.find(file => file.path.endsWith('professional-review.json'))!
    const frozen = JSON.parse(await readFile(join(project.workspace, output.path), 'utf8'))
    expect(frozen.segmentComparisons).toEqual([comparison])
    expect(frozen.model.comparisonBinding[0].reference.adjustmentId).toBe(comparison.referenceAdjustmentId)
    const table = frozen.model.tables.find((item: { id: string }) => item.id.endsWith('-segment-observed'))
    expect(table.rows[0].change).toBeCloseTo(-2, 10)
    expect(engineering.getPreviewEvidence(project.id, preview.run.id)?.segmentComparisons).toEqual([comparison])
    expect(await engineering.previewReport(request)).toEqual(preview)
    const reopened = new EngineeringService({ rootDir: join(root, 'engineering') })
    expect(reopened.getProjectOverview(project.id).latestPreview?.segmentComparisons).toEqual([comparison])
    reopened.close()
    const manifest = await engineering.finalize({ ...request, idempotencyKey: 'segment-finalize', acknowledgeWarnings: true })
    expect(manifest.segmentComparisons).toEqual([comparison])
    expect(manifest.reviewStatus).toBe('draft')
    expect(await engineering.finalize({ ...request, idempotencyKey: 'segment-finalize', acknowledgeWarnings: true })).toEqual(manifest)
    expect(engineering.verifyDeliverable(project.id, manifest.id).valid).toBe(true)
    await expect(engineering.previewReport({ ...request, segmentComparisonIds: [] })).rejects.toThrow('idempotency')
  }, 20000)

  it('carries multi-period continuity through professional exports and the finalized manifest', async () => {
    const { root, engineering, project, comparisons, request } = await fixture(3)
    const preview = await engineering.previewReport(request)
    expect(preview.segmentComparisons).toEqual(comparisons)
    expect(preview.segmentContinuity).toMatchObject({
      projectId: project.id,
      comparisonIds: comparisons.map(item => item.id),
      firstEpoch: '2026-09-01T00:00:00.000Z',
      currentEpoch: '2026-09-03T00:00:00.000Z',
      segments: [{ id: 'BM-P', observedCumulativeChangeMetres: expect.closeTo(-0.004, 12), adjustedCumulativeChangeMetres: expect.closeTo(-0.004, 12) }]
    })

    const professionalReviewPath = join(project.workspace, preview.files.find(file => file.path.endsWith('professional-review.json'))!.path)
    const professionalReview = JSON.parse(await readFile(professionalReviewPath, 'utf8')) as {
      model: { segmentContinuity?: typeof preview.segmentContinuity; tables: Array<{ id: string; rows: Array<Record<string, unknown>> }> }
      segmentContinuity?: typeof preview.segmentContinuity
    }
    expect(professionalReview.segmentContinuity).toEqual(preview.segmentContinuity)
    expect(professionalReview.model.segmentContinuity).toEqual(preview.segmentContinuity)
    expect(professionalReview.model.tables.find(table => table.id === 'segment-continuity')).toMatchObject({
      rows: [{ id: 'BM-P', observed: expect.closeTo(-4, 10), adjusted: expect.closeTo(-4, 10), periods: expect.stringContaining('2026-09-01T00:00:00.000Z') }]
    })

    const professionalXlsxPath = join(project.workspace, preview.files.find(file => file.path.endsWith('professional.xlsx'))!.path)
    const professionalXlsx = await JSZip.loadAsync(await readFile(professionalXlsxPath))
    const workbookXml = await professionalXlsx.file('xl/workbook.xml')!.async('text')
    const workbookParser = sax.parser(true)
    let continuitySheetId: string | undefined
    workbookParser.onopentag = node => {
      if (node.name === 'sheet' && String(node.attributes.name).includes('多期测段累计变化')) continuitySheetId = String(node.attributes.sheetId)
    }
    workbookParser.write(workbookXml).close()
    expect(continuitySheetId).toBeDefined()
    const sheetParser = sax.parser(true)
    const cells = new Map<string, string>()
    let cellAddress = ''
    sheetParser.onopentag = node => { if (node.name === 'c') cellAddress = String(node.attributes.r) }
    sheetParser.ontext = value => { if (cellAddress) cells.set(cellAddress, (cells.get(cellAddress) ?? '') + value) }
    sheetParser.onclosetag = name => { if (name === 'c') cellAddress = '' }
    sheetParser.write(await professionalXlsx.file(`xl/worksheets/sheet${continuitySheetId}.xml`)!.async('text')).close()
    expect(cells.get('A2')).toBe('BM-P')
    expect(Number(cells.get('D2'))).toBeCloseTo(-4, 10)
    expect(Number(cells.get('E2'))).toBeCloseTo(-4, 10)
    expect(cells.get('F2')).toContain('2026-09-03T00:00:00.000Z')
    expect(engineering.getPreviewEvidence(project.id, preview.run.id)?.segmentContinuity).toEqual(preview.segmentContinuity)
    expect(await engineering.previewReport(request)).toEqual(preview)
    const reopened = new EngineeringService({ rootDir: join(root, 'engineering') })
    expect(reopened.getProjectOverview(project.id).latestPreview?.segmentContinuity).toEqual(preview.segmentContinuity)
    reopened.close()

    const manifest = await engineering.finalize({ ...request, idempotencyKey: 'segment-continuity-finalize', acknowledgeWarnings: true })
    expect(manifest.segmentComparisons).toEqual(comparisons)
    expect(manifest.segmentContinuity).toEqual(preview.segmentContinuity)
    expect(JSON.parse(await readFile(join(project.workspace, '.workwise', 'deliverables', project.id, manifest.runId, 'manifest.json'), 'utf8')).segmentContinuity).toEqual(preview.segmentContinuity)
    const finalizedProfessionalReviewPath = join(project.workspace, manifest.outputs.find(file => file.path.endsWith('professional-review.json'))!.path)
    expect(JSON.parse(await readFile(finalizedProfessionalReviewPath, 'utf8')).segmentContinuity).toEqual(preview.segmentContinuity)
    expect(await engineering.finalize({ ...request, idempotencyKey: 'segment-continuity-finalize', acknowledgeWarnings: true })).toEqual(manifest)
    expect(engineering.verifyDeliverable(project.id, manifest.id)).toMatchObject({ valid: true, reviewStatus: 'draft' })
  }, 30000)

  it('requires both exact runs and rejects unknown, duplicate, foreign or changed bindings', async () => {
    const { engineering, comparison, request, setLookup } = await fixture()
    await expect(engineering.previewReport({ ...request, adjustmentIds: request.adjustmentIds.slice(1) })).rejects.toThrow('both exact')
    await expect(engineering.previewReport({ ...request, segmentComparisonIds: ['missing'] })).rejects.toThrow('unavailable')
    await expect(engineering.previewReport({ ...request, segmentComparisonIds: [comparison.id, comparison.id] })).rejects.toThrow('duplicate')
    setLookup(record => ({ ...record, projectId: 'foreign' }))
    await expect(engineering.previewReport(request)).rejects.toThrow('project/identity')
    setLookup(record => ({ ...record, currentResultHash: 'a'.repeat(64) }))
    await expect(engineering.previewReport(request)).rejects.toThrow('result/projection')
  })

  it('rejects changed comparison evidence before publication and cleans unpublished artifacts', async () => {
    const { engineering, project, request, setLookup } = await fixture()
    let reads = 0
    setLookup(record => ++reads === 1 ? record : { ...record, segments: record.segments.map(segment => ({ ...segment, observedChangeMetres: 99 })) })
    await expect(engineering.previewReport(request)).rejects.toThrow('preview publication segment comparison')
    expect(engineering.getProjectOverview(project.id).runs).toHaveLength(0)
    const path = join(project.workspace, '.workwise', 'deliverables', project.id)
    expect(await readdir(path).catch(() => [])).toEqual([])
  }, 20000)

  it('keeps old request fingerprints and manifest bytes unchanged when no comparison is selected', async () => {
    const { engineering, request } = await fixture()
    const { segmentComparisonIds: _omitted, ...legacy } = request
    const preview = await engineering.previewReport(legacy)
    expect(preview).not.toHaveProperty('segmentComparisons')
    expect(await engineering.previewReport({ ...legacy, segmentComparisonIds: [] })).toEqual(preview)
    const manifest = await engineering.finalize({ ...legacy, idempotencyKey: 'legacy-finalize' })
    expect(manifest).not.toHaveProperty('segmentComparisons')
    expect(engineering.verifyDeliverable(manifest.projectId, manifest.id).valid).toBe(true)
  }, 20000)

  it('rejects a changed cached preview comparison while preserving its historical files', async () => {
    const { root, engineering, project, request } = await fixture()
    const preview = await engineering.previewReport(request)
    const db = new Database(join(root, 'engineering', 'engineering.sqlite3'))
    onTestFinished(() => { db.close() })
    const row = db.prepare('SELECT result_json FROM engineering_delivery_idempotency WHERE key=?').get('segment-preview') as { result_json: string }
    const cached = JSON.parse(row.result_json)
    cached.segmentComparisons[0].segments[0].adjustedChangeMetres = 0
    db.prepare('UPDATE engineering_delivery_idempotency SET result_json=? WHERE key=?').run(JSON.stringify(cached), 'segment-preview')
    await expect(engineering.previewReport(request)).rejects.toThrow('stored preview segment comparison')
    expect((await readFile(join(project.workspace, preview.files[0]!.path))).byteLength).toBeGreaterThan(0)
  }, 20000)
})
