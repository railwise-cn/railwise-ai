import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { surveyAiAdjustmentSemantics } from './survey-ai-adjustment-semantics.js'

const allocated: Array<{ root: string; service: SurveyService }> = []
afterEach(async () => {
  for (const { root, service } of allocated.splice(0)) {
    await service.flush()
    service.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(options: { absolute?: boolean; mixed?: boolean; noRedundancy?: boolean; mm?: boolean; partialRoute?: boolean; noRouteLengths?: boolean; observationUnit?: string; networkUnit?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'survey-weighting-'))
  const service = new SurveyService({ rootDir: root })
  allocated.push({ root, service })
  const scale = options.mm ? 1000 : 1
  const observations = [
    { id: 'out', type: 'height-difference', from: 'BM', to: 'P', value: scale, unit: options.observationUnit ?? (options.mm ? 'mm' : 'm'),
      ...(!options.noRouteLengths ? { routeLength: 1 } : {}),
      ...(options.absolute || options.mixed ? { sigma: .002 * scale, sigmaUnit: options.mm ? 'mm' : 'm' } : {}) },
    ...(!options.noRedundancy ? [{ id: 'back', type: 'height-difference', from: 'P', to: 'BM', value: -.999 * scale, unit: options.observationUnit ?? (options.mm ? 'mm' : 'm'),
      ...(!options.noRouteLengths && !options.partialRoute ? { routeLength: 4 } : {}),
      ...(options.absolute ? { sigma: .004 * scale, sigmaUnit: options.mm ? 'mm' : 'm' } : {}) }] : [])
  ]
  const network = await importWorkwiseSurveyNetwork(service, { projectId: 'weighting', expectedRevision: 0,
    idempotencyKey: 'weighting-import', networkType: 'leveling', network: {
      knownPoints: [{ id: 'BM', known: true, height: 10 }], unknownPoints: [{ id: 'P', known: false, height: 11 }],
      observations, instrumentParameters: {}, ...(options.networkUnit ? { unit: options.networkUnit } : {})
    } })
  const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'weighting-check' })
  const output = service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'weighting-adjust' })
  return { root, service, network: checked, output }
}

describe('versioned professional weighting units', () => {
  it.each([false, true])('retains the independent relative-route solution and one-metre reference scale (millimetres=%s)', async mm => {
    const { service, network, output } = await fixture({ mm })
    expect(output.run).toMatchObject({ status: 'completed', algorithmVersion: 'workwise-survey-adjustment-9' })
    expect(output.result).toMatchObject({ weightingBasis: 'relative-route-length', relativeWeightReferenceLengthMetres: 1,
      unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2', varianceFactorEstimated: true })
    // Closure 0.001 m distributed over lengths 1 m and 4 m.
    expect(output.result.points.find(point => point.id === 'P')!.height).toBeCloseTo(10.9998, 12)
    expect(output.result.observations.map(row => row.residual)).toEqual(expect.arrayContaining([
      expect.closeTo(-.0002, 12), expect.closeTo(-.0008, 12)
    ]))
    expect(output.result.varianceFactor).toBeCloseTo(2e-7, 15)
    expect(output.result.unitWeightStdDev).toBeCloseTo(Math.sqrt(2e-7), 15)
    expect(output.result.points.find(point => point.id === 'P')!.standardError).toBeCloseTo(.0004, 12)
    expect(output.result.statisticalSummary).toMatchObject({ numericalStatus: 'not-evaluated', availableCount: 0, unavailableCount: 2,
      varianceBasis: 'estimated-posterior', varianceLog10RatioToUnit: null, standardDeviationLog10RatioToUnit: null })
    output.result.observations.forEach(row => {
      expect(row.standardizedResidual).toBeUndefined()
      expect(row.residualStatistic).toMatchObject({ status: 'not-testable', reason: 'missing-absolute-precision', scaleBasis: 'relative-weight' })
    })
    if (mm) {
      expect(network.observations.map(({ id, value, unit }) => ({ id, value, unit }))).toEqual([
        { id: 'out', value: 1000, unit: 'mm' }, { id: 'back', value: -999, unit: 'mm' }
      ])
      expect(service.getNetwork(network.id)!.observations).toEqual(network.observations)
      const warnings = network.findings.filter(item => item.code === 'unit_conflict')
      expect(warnings).toHaveLength(2)
      warnings.forEach(item => {
        expect(item.severity).toBe('warning')
        expect(item.suggestion).toContain('计算时规范换算为 m')
        expect(item.suggestion).toContain('原始值和单位保留')
        expect(item.localized?.en.suggestedAction).toContain('normalized to m during calculation')
        expect(item.localized?.en.suggestedAction).toContain('original values and units are retained')
      })
      expect(output.result.observations.map(item => item.unit)).toEqual(['m', 'm'])
    }
    expect(service.getAdjustmentForNewUse(output.run.id)?.result).toEqual(output.result)
  })

  it.each(['observation', 'network'] as const)('blocks an unsupported %s unit without claiming it can be normalized', async scope => {
    const { network, output } = await fixture(scope === 'observation'
      ? { observationUnit: 'unknown-unit' } : { mm: true, networkUnit: 'unknown-unit' })
    expect(network.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.validation).toBe('invalid')
    expect(output.result.points).toEqual([])
    const unitFindings = network.findings.filter(item => item.code === 'unit_conflict')
    expect(unitFindings).toContainEqual(expect.objectContaining({ severity: 'blocking' }))
    expect(unitFindings.some(item => item.severity === 'warning')).toBe(false)
  })

  it('records an explicit equal-weight convention when every route length is absent', async () => {
    const { service, output } = await fixture({ noRouteLengths: true })
    expect(output.result).toMatchObject({ validation: 'valid', weightingBasis: 'relative-route-length',
      relativeWeightReferenceLengthMetres: 1, relativeWeightDefaultLengthObservationIds: ['out', 'back'],
      unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2' })
    expect(output.result.points.find(point => point.id === 'P')!.height).toBeCloseTo(10.9995, 12)
    expect(output.result.varianceFactor).toBeCloseTo(5e-7, 15)
    expect(output.result.points.find(point => point.id === 'P')!.standardError).toBeCloseTo(.0005, 12)
    expect(service.getProfessionalReview(output.run.id)!.summary.relativeWeightDefaultLengthObservationIds).toEqual(['out', 'back'])
    expect(service.getAdjustmentForNewUse(output.run.id)?.result).toEqual(output.result)
  })

  it('blocks a partly specified relative route-length model rather than inventing a missing length', async () => {
    const { service, network, output } = await fixture({ partialRoute: true })
    expect(network.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.validation).toBe('invalid')
    expect(output.result.qualityFindings).toContainEqual(expect.objectContaining({ code: 'invalid_observation', severity: 'blocking' }))
    expect(output.result.points).toEqual([])
    expect(() => service.getAdjustmentForNewUse(output.run.id)).toThrow()
  })

  it.each([false, true])('normalizes all declared absolute sigmas (millimetres=%s) and keeps variance ratios dimensionless', async mm => {
    const { service, output } = await fixture({ absolute: true, mm })
    expect(output.result).toMatchObject({ validation: 'valid', weightingBasis: 'absolute-prior',
      unitWeightStdDevUnit: 'dimensionless', varianceFactorUnit: 'dimensionless' })
    expect(output.result.relativeWeightReferenceLengthMetres).toBeUndefined()
    expect(output.result.varianceFactor).toBeCloseTo(.05, 12)
    expect(output.result.points.find(point => point.id === 'P')!.height).toBeCloseTo(10.9998, 12)
    expect(output.result.points.find(point => point.id === 'P')!.standardError).toBeCloseTo(.0004, 12)
    expect(output.result.observations[0]!.residualStatistic).toMatchObject({ status: 'available', value: expect.closeTo(.1, 12), scaleBasis: 'declared-prior' })
    expect(output.result.statisticalSummary).toMatchObject({ numericalStatus: 'clear', varianceLog10RatioToUnit: expect.closeTo(Math.log10(.05), 12) })
    expect(service.getAdjustmentForNewUse(output.run.id)?.result).toEqual(output.result)
  })

  it('blocks formal adjustment when relative and absolute observation weights are mixed', async () => {
    const { service, network, output } = await fixture({ mixed: true })
    expect(network.qualityStatus).toBe('blocked')
    expect(output.run.status).toBe('needs_attention')
    expect(output.result.validation).toBe('invalid')
    expect(output.result.qualityFindings).toContainEqual(expect.objectContaining({ code: 'invalid_observation', severity: 'blocking' }))
    expect(output.result.points).toEqual([])
    expect(() => service.getAdjustmentForNewUse(output.run.id)).toThrow()
  })

  it('computes a nonredundant relative height without inventing absolute precision', async () => {
    const { service, output } = await fixture({ noRedundancy: true })
    expect(output.result).toMatchObject({ validation: 'valid', degreesOfFreedom: 0, weightingBasis: 'relative-route-length', varianceFactorEstimated: false })
    expect(output.result.points.find(point => point.id === 'P')!.height).toBe(11)
    output.result.points.forEach(point => {
      expect(point.standardError).toBeUndefined()
      expect(point.covariance).toBeUndefined()
    })
    expect(output.result.covariance).toBeUndefined()
    expect(output.result.precision.passed).toBe(false)
    expect(output.result.statisticalSummary).toMatchObject({ varianceBasis: 'not-estimated', numericalStatus: 'not-evaluated',
      varianceLog10RatioToUnit: null, standardDeviationLog10RatioToUnit: null })
    const review = service.getProfessionalReview(output.run.id)!
    expect(review.summary.varianceBasis).toBe('not-estimated')
    expect(review.points.find(point => point.id === 'P')!.precisionBasis).toBe('not-recorded')
    expect(review.weakestPoint.status).toBe('not-evaluated')
    expect(service.getAdjustmentForNewUse(output.run.id)?.result).toEqual(output.result)
  })

  it('retains genuinely known absolute prior precision without redundancy', async () => {
    const { service, output } = await fixture({ absolute: true, noRedundancy: true })
    expect(output.result.varianceFactorEstimated).toBe(false)
    expect(output.result.points.find(point => point.id === 'P')!.standardError).toBeCloseTo(.002, 14)
    expect(output.result.statisticalSummary?.varianceBasis).toBe('prior-fallback')
    expect(service.getProfessionalReview(output.run.id)!.points.find(point => point.id === 'P')!.precisionBasis).toBe('a-priori')
  })

  it('publishes relative GSI metadata alongside the independently derived posterior precision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'survey-weighting-gsi-'))
    const service = new SurveyService({ rootDir: root }); allocated.push({ root, service })
    const bytes = await readFile(new URL('./fixtures/survey-formats/professional/leica-gsi-cumulative-leveling.gsi', import.meta.url))
    const network = await service.importNetwork({ projectId: 'gsi-weighting', expectedRevision: 0, idempotencyKey: 'gsi-import', name: 'loop.GSI',
      networkType: 'leveling', referenceDeclaration: { verticalDatum: 'Synthetic BM=100m' }, dataBase64: bytes.toString('base64'), knownPoints: [{ id: 'BM', height: 100 }] })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'gsi-adjust' })
    const summary = service.getProfessionalReview(output.run.id)!.summary
    expect(summary).toMatchObject({ weightingBasis: 'relative-route-length', relativeWeightReferenceLengthMetres: 1,
      unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2', varianceBasis: 'a-posteriori' })
    expect(summary.varianceFactor).toBeCloseTo(1 / 3750000000, 17)
    expect(output.result.points.find(point => point.id === 'P1')!.standardError).toBeCloseTo(.0002, 12)
    expect(service.getProfessionalReview(output.run.id)!.closures[0]!.status).toBe('not-evaluated')
  })

  it('reopens authentic algorithm-8 SQLite evidence without rewriting or upgrading its hash-bound result', async () => {
    const text = gunzipSync(Buffer.from(legacy8Snapshot, 'base64')).toString('utf8')
    expect(createHash('sha256').update(text).digest('hex')).toBe('467ad77976cfcb1e78d72931cf2c454b05d73a5bf89298f983eb41e35713a04e')
    const snapshot = JSON.parse(text) as { runId: string; sourceSha256: string; sourceBase64: string; tables: Record<string, Array<Record<string, string | number>>> }
    const root = await mkdtemp(join(tmpdir(), 'survey-weighting-legacy8-'))
    // Rehydrate exact durable rows captured from the unmodified algorithm-8
    // service, including its append-only source and calculation evidence.
    const schema = new SurveyService({ rootDir: root }); schema.close()
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      db.transaction(() => {
        for (const table of ['survey_networks', 'survey_raw_source_ledger', 'survey_source_admissions', 'survey_adjustments', 'survey_adjustment_evidence']) {
          for (const row of snapshot.tables[table]!) {
            const columns = Object.keys(row)
            db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]!))
          }
        }
      })()
    } finally { db.close() }
    const sourceDir = join(root, 'sources', snapshot.sourceSha256)
    await mkdir(sourceDir, { recursive: true }); await writeFile(join(sourceDir, 'original'), Buffer.from(snapshot.sourceBase64, 'base64'))
    const service = new SurveyService({ rootDir: root }); allocated.push({ root, service })
    const expected = JSON.parse(snapshot.tables.survey_adjustments![0]!.data_json as string)
    const restored = service.getAdjustment(snapshot.runId)!
    expect(restored.result).toEqual(expected.result)
    expect(restored.result!.algorithmVersion).toBe('workwise-survey-adjustment-8')
    expect(restored.result!.weightingBasis).toBeUndefined()
    expect(restored.result!.relativeWeightReferenceLengthMetres).toBeUndefined()
    expect(restored.result!.unitWeightStdDevUnit).toBe('dimensionless')
    expect(restored.result!.observations[0]!.standardizedResidual).toBeCloseTo(.0002, 12)
    expect(service.getAdjustmentForNewUse(snapshot.runId)!.result).toEqual(expected.result)
    const historicalSummary = service.getProfessionalReview(snapshot.runId)!.summary
    expect(historicalSummary.weightingBasis).toBeUndefined()
    expect(historicalSummary.unitWeightStdDevUnit).toBeUndefined()
    expect(historicalSummary.varianceFactorUnit).toBeUndefined()
    expect(historicalSummary.relativeWeightReferenceLengthMetres).toBeUndefined()
    expect(historicalSummary.relativeWeightDefaultLengthObservationIds).toBeUndefined()
    expect(surveyAiAdjustmentSemantics(restored.result!, service.getProfessionalReview(snapshot.runId))).toMatchObject({
      weightingBasis: 'not-recorded', unitWeightStdDevUnit: null, varianceFactorUnit: null,
      unitWeightStdDev: null, varianceFactor: null, precision: { maxPointStdDev: null, passed: null, assessmentStatus: 'not-evaluated' },
      weightingSemantics: { status: 'not-recorded', scaleStatus: 'not-evaluated', precisionStatus: 'not-evaluated' }
    })
    await service.flush()
    const after = new Database(join(root, 'survey.sqlite3'), { readonly: true })
    try {
      for (const table of Object.keys(snapshot.tables)) expect(after.prepare(`SELECT * FROM ${table}`).all()).toEqual(snapshot.tables[table])
    } finally { after.close() }
  })
})

// Logical SQLite rows and original bytes generated by the real algorithm-8
// service on 2026-10-08; no product-9 result was relabeled to fabricate history.
// Gzip keeps the immutable ledger/result duplication small. Integrity and all
// restored row bytes are asserted by the migration regression above.
const legacy8Snapshot = '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'
