import { afterEach, describe, expect, it } from 'vitest'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { sourceFixedFixture as fixture } from './survey-source-fixed-model-test-helpers.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
async function sourceFixedFixture(absolute = true, options: Parameters<typeof fixture>[1] = {}) { const f = await fixture(absolute, options); services.push(f); return f }

const services: Array<{ service: SurveyService; root: string }> = []
afterEach(async () => { for (const { service, root } of services.splice(0)) { await service.flush(); service.close(); await rm(root, { recursive: true, force: true }) } })

describe('source-backed fixed water-level model', () => {
  it('exports all admitted rows, exact correction equations and unscaled full prior covariance without modifying formal evidence', async () => {
    const f = await sourceFixedFixture(), before = JSON.stringify(f.service.getAdjustment(f.adjustment.run.id))
    const request = { adjustmentId: f.adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: f.network.revision }
    const source = f.service.getSourceFixedModel(f.project.id, request)!
    expect(source.binding).toMatchObject({ projectId: f.project.id, networkId: f.network.id, networkRevision: f.network.revision, runId: f.adjustment.run.id })
    expect(source.model.parameterIds).toEqual(['P'])
    expect(source.model.designMatrix).toEqual([[1], [1], [1]])
    expect(source.model.observations.map(row => row.id)).toEqual(['dh0', 'dh1', 'dh2'])
    expect(source.model.observations.every(row => row.sourceAnchor.length > 0)).toBe(true)
    expect(source.model.observations[1]!.value - source.model.observations[0]!.value).toBeCloseTo(.001, 14)
    expect(source.model.observationCovariance).toEqual([[4e-6,0,0],[0,4e-6,0],[0,0,4e-6]])
    expect(source.model.priorParameterCovariance[0]![0]).toBeCloseTo(4e-6 / 3, 14)
    expect(source.model.priorParameterCovariance[0]![0]).not.toEqual(f.adjustment.result!.points.find(p => p.id === 'P')!.standardError! ** 2)
    expect(f.service.getSourceFixedModel(f.project.id, request)).toEqual(source)
    expect(JSON.stringify(f.service.getAdjustment(f.adjustment.run.id))).toBe(before)
  })
  it('does not relabel route-length relative weights as known absolute observation covariance', async () => {
    const f = await sourceFixedFixture(false)
    expect(() => f.service.getSourceFixedModel(f.project.id, { adjustmentId: f.adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: f.network.revision })).toThrow(/absolute-prior/)
  })
  it('preserves the off-diagonal prior parameter covariance in a two-height network with unequal precision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-full-prior-')), project = { id: 'two-height-project', revision: 1, workspace: root }
    const service = new SurveyService({ rootDir: root, getProject: id => id === project.id ? project : null }); services.push({ root, service })
    const network = await importWorkwiseSurveyNetwork(service, { projectId: project.id, expectedRevision: 0, idempotencyKey: 'full-prior-import', networkType: 'leveling',
      network: { networkType: 'leveling', knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
        unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }, { id: 'Q', pointClass: 'unknown', known: false, height: 10.2 }],
        observations: [
          { id: 'bp-1', from: 'BM', to: 'P', value: .100, sigma: .002 }, { id: 'pq-1', from: 'P', to: 'Q', value: .1005, sigma: .003 },
          { id: 'bq-1', from: 'BM', to: 'Q', value: .1995, sigma: .004 }, { id: 'bp-2', from: 'BM', to: 'P', value: .101, sigma: .002 },
          { id: 'pq-2', from: 'P', to: 'Q', value: .099, sigma: .003 }
        ].map(o => ({ ...o, type: 'height-difference', unit: 'm', sigmaUnit: 'm' })), instrumentParameters: {} } })
    const adjustment = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'full-prior-adjust' })
    const source = service.getSourceFixedModel(project.id, { adjustmentId: adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: network.revision })!
    expect(source.model.parameterIds).toEqual(['P', 'Q'])
    expect(source.model.designMatrix).toEqual([[1,0],[-1,1],[0,1],[1,0],[-1,1]])
    // Independent closed inverse of AᵀPA. In particular, reconstructing only
    // point standard deviations would lose this nonzero cross covariance.
    const a = 2 / .002 ** 2 + 2 / .003 ** 2, b = -2 / .003 ** 2, d = 2 / .003 ** 2 + 1 / .004 ** 2, determinant = a * d - b * b
    const expected = [[d / determinant, -b / determinant], [-b / determinant, a / determinant]]
    source.model.priorParameterCovariance.forEach((row, i) => row.forEach((value, j) => expect(value).toBeCloseTo(expected[i]![j]!, 14)))
    expect(source.model.priorParameterCovariance[0]![1]).toBeGreaterThan(0)
    expect(source.model.degreesOfFreedom).toBe(3)
    expect(source.model.observationCovariance[1]![1]).toBe(.003 ** 2)
    expect(source.model.observationCovariance[2]![2]).toBe(.004 ** 2)
  })
  it('isolates exact project and refuses stale project or network selections', async () => {
    const f = await sourceFixedFixture(), request = { adjustmentId: f.adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: f.network.revision }
    expect(f.service.getSourceFixedModel('another-project', request)).toBeNull()
    expect(() => f.service.getSourceFixedModel(f.project.id, { ...request, expectedProjectRevision: 2 })).toThrow(/stale/)
    expect(() => f.service.getSourceFixedModel(f.project.id, { ...request, expectedNetworkRevision: 99 })).toThrow(/stale/)
  })
  it('normalizes millimetre observations and prior sigmas while declaring a missing approximation', async () => {
    const f = await sourceFixedFixture(true, { mm: true, missingHeight: true })
    const source = f.service.getSourceFixedModel(f.project.id, { adjustmentId: f.adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: f.network.revision })!
    expect(source.model.observationCovariance).toEqual([[4e-6,0,0],[0,4e-6,0],[0,0,4e-6]])
    expect(source.model.observations[0]).toMatchObject({ heightDifference: .1, sigma: .002, value: 10.1 })
    expect(source.model.referencePoints.find(p => p.id === 'P')).toMatchObject({ height: 0, heightBasis: 'zero-initial-approximation' })
    expect(source.model.formalCorrections[0]).toBeCloseTo(10.1, 12)
  })
  it.each([{ mixedSigma: true }, { correlation: true }])('refuses partially declared or correlated prior precision (%j)', async options => {
    const f = await sourceFixedFixture(true, options)
    expect(() => f.service.getSourceFixedModel(f.project.id, { adjustmentId: f.adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: f.network.revision })).toThrow()
  })
  it('rejects an admitted nonlinear COSA planar result instead of claiming a fixed height model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'source-planar-rejection-')), project = { id: 'planar-project', revision: 1, workspace: root }
    const service = new SurveyService({ rootDir: root, getProject: id => id === project.id ? project : null }); services.push({ root, service })
    const bytes = await readFile(new URL('./fixtures/survey-formats/cosa-in2/golden-plane-control-e2e.in2', import.meta.url))
    const network = await service.importNetwork({ projectId: project.id, expectedRevision: 0, idempotencyKey: 'planar-import', name: 'network.in2', networkType: 'plane-control', referenceDeclaration: { coordinateSystem: '公开合成样例独立坐标系' }, dataBase64: bytes.toString('base64') })
    const adjusted = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'planar-adjust' })
    expect(adjusted.run.status).toBe('completed')
    expect(() => service.getSourceFixedModel(project.id, { adjustmentId: adjusted.run.id, expectedProjectRevision: 1, expectedNetworkRevision: network.revision })).toThrow(/nonlinear/)
  })
  it.each(['raw-bytes', 'parser', 'observation'] as const)('rejects altered source %s even when historical results remain readable', async alteration => {
    const f = await sourceFixedFixture(), before = JSON.stringify(f.service.getAdjustment(f.adjustment.run.id)?.result)
    if (alteration === 'raw-bytes') await writeFile(join(f.root, 'sources', f.network.sourceFile!.sha256, 'original'), 'changed source')
    else {
      const db = new Database(join(f.root, 'survey.sqlite3'))
      try {
        const changed = structuredClone(f.network)
        if (alteration === 'parser') changed.sourceFile!.parserVersion = 'different-parser'
        else changed.observations[0]!.sourceRecordId = 'forged-anchor'
        db.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify(changed), f.network.id)
      } finally { db.close() }
    }
    expect(() => f.service.getSourceFixedModel(f.project.id, { adjustmentId: f.adjustment.run.id, expectedProjectRevision: 1, expectedNetworkRevision: f.network.revision })).toThrow()
    expect(JSON.stringify(f.service.getAdjustment(f.adjustment.run.id)?.result)).toBe(before)
  })
})
