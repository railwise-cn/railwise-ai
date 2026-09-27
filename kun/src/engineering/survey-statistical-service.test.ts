import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { SurveyStatisticalDiagnosticsV1 } from '../contracts/survey-statistics.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

const allocated: Array<{ root: string; service: SurveyService }> = []
afterEach(async () => {
  for (const { root, service } of allocated.splice(0)) {
    await service.flush()
    service.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture(options: { count?: number; perfect?: boolean; routeWeights?: boolean; mixed?: boolean; covariance?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'survey-statistics-'))
  const service = new SurveyService({ rootDir: root })
  allocated.push({ root, service })
  const values = Array.from({ length: options.count ?? 4 }, (_, i) => [0.1001, 0.1002, 0.1004, 0.1008][i % 4]!)
  const relativeWeights = values.map((_, i) => [1, 0.5, 2, 1.5][i % 4]!)
  const network = await importWorkwiseSurveyNetwork(service, {
    projectId: 'project-statistics', expectedRevision: 0, idempotencyKey: 'statistics-import', networkType: 'leveling',
    network: {
      networkType: 'leveling', knownPoints: [{ id: 'BM', known: true, height: 10 }],
      unknownPoints: [{ id: 'P', known: false, height: options.perfect ? 10.125 : 10.1 }],
      observations: values.map((value, i) => ({
        id: `dh-${i}`, type: 'height-difference', from: 'BM', to: 'P', value: options.perfect ? 0.125 : value,
        unit: 'm', routeLength: 1 / relativeWeights[i]!,
        ...(!options.routeWeights && !(options.mixed && i === 0) ? { sigma: 0.001 / Math.sqrt(relativeWeights[i]!), sigmaUnit: 'm' } : {}),
        ...(options.covariance ? { covariance: [1e-6] } : {})
      })), instrumentParameters: {}
    }
  })
  const created = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'statistics-adjust' })
  expect(created.result.validation).toBe('valid')
  return { root, service, network, created, values, relativeWeights }
}

describe('read-only leveling statistical diagnostics', () => {
  it('binds verified production output and matches independent delete-one weighted-mean predictions', async () => {
    const { service, created, network, values, relativeWeights } = await fixture()
    const historical = JSON.stringify(service.getAdjustment(created.run.id))
    const diagnostic = SurveyStatisticalDiagnosticsV1.parse(service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id))
    expect(diagnostic).toMatchObject({ status: 'available', runId: created.run.id, resultId: created.result.id,
      inputHash: created.run.inputHash, algorithmVersion: created.run.algorithmVersion,
      sourceSha256: network.sourceFile!.sha256, decision: 'not-evaluated', assumptionsVerified: false,
      varianceBasis: 'deleted-observation-posterior', fullModelDegreesOfFreedom: 3, degreesOfFreedom: 2 })
    if (diagnostic.status !== 'available') throw new Error('expected available diagnostics')
    values.forEach((value, i) => {
      const remaining = values.flatMap((y, j) => j === i ? [] : [{ y, w: relativeWeights[j]! * 1e6 }])
      const weightSum = remaining.reduce((sum, row) => sum + row.w, 0)
      const deletedMean = remaining.reduce((sum, row) => sum + row.y * row.w, 0) / weightSum
      const deletedSse = remaining.reduce((sum, row) => sum + row.w * (row.y - deletedMean) ** 2, 0)
      const predictionVariance = 1 / (relativeWeights[i]! * 1e6) + 1 / weightSum
      // Production uses adjusted minus observed, opposite to prediction error.
      const reference = (deletedMean - value) / Math.sqrt(deletedSse / 2 * predictionVariance)
      expect(diagnostic.observations[i]!.observationId).toBe(`dh-${i}`)
      expect(diagnostic.observations[i]!.sourceRecordId).toBe(network.observations[i]!.sourceRecordId)
      expect(diagnostic.observations[i]!.sourceRecordId).toBeTruthy()
      expect(diagnostic.observations[i]!.externallyStudentizedResidual).toBeCloseTo(reference, 10)
      expect(diagnostic.observations[i]!.deletedWeightedResidualSum).toBeCloseTo(deletedSse, 11)
    })
    expect(JSON.stringify(service.getAdjustment(created.run.id))).toBe(historical)
    expect(service.getAdjustmentForNewUse(created.run.id)?.result).toEqual(created.result)
    expect(service.getAdjustmentStatisticalDiagnostics(network.projectId, created.result.id)).toEqual(diagnostic)
    expect(SurveyStatisticalDiagnosticsV1.safeParse({ ...diagnostic, degreesOfFreedom: 3 }).success).toBe(false)
    expect(SurveyStatisticalDiagnosticsV1.safeParse({ ...diagnostic, statistic: 'baarda' }).success).toBe(false)
    expect(SurveyStatisticalDiagnosticsV1.safeParse({ ...diagnostic, decision: 'passed' }).success).toBe(false)
  })

  it('uses relative route weights without falsely declaring their scale known a priori', async () => {
    const { service, created, network } = await fixture({ routeWeights: true })
    const diagnostic = service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id)
    expect(diagnostic).toMatchObject({ status: 'available', weightBasis: 'inverse-route-length-with-unit-default', varianceBasis: 'deleted-observation-posterior', assumptionsVerified: false })
  })

  it('reports insufficient redundancy, degenerate deletion, mixed weights and correlation as unavailable', async () => {
    for (const [options, reason] of [
      [{ count: 2 }, 'insufficient-redundancy'],
      [{ perfect: true }, 'zero-or-unresolved-deleted-variance'],
      [{ mixed: true }, 'inconsistent-weight-basis'],
      [{ covariance: true }, 'correlated-observations']
    ] as const) {
      const { service, created, network } = await fixture(options)
      expect(service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id)).toMatchObject({ status: 'unavailable', reason, decision: 'not-evaluated' })
    }
  })

  it('reports the diagnostic matrix limit without allocating a dense covariance', async () => {
    const { service, network, created } = await fixture({ count: 257 })
    expect(service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id)).toMatchObject({ status: 'unavailable', reason: 'dimension-limit' })
  })

  it('does not apply an independent-observation leveling statistic to a GNSS result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'survey-statistics-gnss-'))
    const service = new SurveyService({ rootDir: root })
    allocated.push({ root, service })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-gnss-statistics', expectedRevision: 0, idempotencyKey: 'statistics-gnss-import',
      network: { networkType: 'gnss',
        knownPoints: [{ id: 'A', known: true, x: 0, y: 0, height: 0 }],
        unknownPoints: [{ id: 'P', known: false, x: 1, y: 2, height: 3 }],
        observations: [0, 0.0001].map((offset, i) => ({
          id: `baseline-${i}`, type: 'gnss-baseline', from: 'A', to: 'P', value: 0,
          vectorX: 1 + offset, vectorY: 2, vectorZ: 3, unit: 'm',
          covariance: [1e-6, 0, 0, 0, 1e-6, 0, 0, 0, 1e-6]
        })), instrumentParameters: {} }
    })
    const created = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'statistics-gnss-adjust' })
    expect(created.result.validation).toBe('valid')
    expect(service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id)).toMatchObject({ status: 'unavailable', reason: 'unsupported-network-type' })
  })

  it('does not expose another project and rejects a stale network while leaving historical reads available', async () => {
    const { root, service, created, network } = await fixture()
    expect(service.getAdjustmentStatisticalDiagnostics('other-project', created.run.id)).toBeNull()
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      const row = db.prepare('SELECT data_json FROM survey_networks WHERE id = ?').get(network.id) as { data_json: string }
      const changed = JSON.parse(row.data_json)
      changed.observations[0].value += 0.00001
      db.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify(changed), network.id)
    } finally { db.close() }
    expect(() => service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id)).toThrow()
    expect(service.getAdjustment(created.run.id)?.result).toEqual(created.result)
  })

  it('rejects altered raw source bytes before computing new diagnostics', async () => {
    const { root, service, created, network } = await fixture()
    await writeFile(join(root, 'sources', network.sourceFile!.sha256, 'original'), 'modified source')
    expect(() => service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id)).toThrow()
  })

  it('keeps historical results readable but blocks diagnostics when the preserved source is missing', async () => {
    const { root, service, created, network } = await fixture()
    await rm(join(root, 'sources', network.sourceFile!.sha256, 'original'))
    expect(service.getAdjustment(created.run.id)?.result).toEqual(created.result)
    expect(() => service.getAdjustmentStatisticalDiagnostics(network.projectId, created.run.id)).toThrow()
  })
})
