import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { SurveyService } from './survey-service.js'
import { SurveyFreeLevelingTrialV1 } from '../contracts/survey-free-leveling.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

const allocated: Array<{ root: string; service: SurveyService }> = []
afterEach(async () => { for (const entry of allocated.splice(0)) { await entry.service.flush(); entry.service.close(); await rm(entry.root, { recursive: true, force: true }) } })
const request = (revision: number, key = 'trial-1') => ({ expectedRevision: revision, idempotencyKey: key, constraint: 'sum-height-corrections-zero', acknowledgeDatumRelease: true, weightPolicy: 'source-or-unit-fallback' })
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

async function fixture(options: { sigma?: boolean; mm?: boolean; missingHeight?: boolean; mixed?: boolean; correlation?: boolean; nonLevel?: boolean; routeLengths?: boolean; partialRoute?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'free-leveling-service-'))
  const service = new SurveyService({ rootDir: root })
  const entry = { root, service }; allocated.push(entry)
  const network = await importWorkwiseSurveyNetwork(service, {
    projectId: 'trial-project', expectedRevision: 0, idempotencyKey: 'trial-import',
    network: { networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'A', known: true, pointClass: 'known', height: 0 }],
      unknownPoints: [{ id: 'B', known: false, ...(options.missingHeight ? {} : { height: 0 }) }, { id: 'C', known: false, height: 0 }],
      observations: [['A', 'B', 1], ['B', 'C', 2], ['C', 'A', -2.7]].map(([from, to, value], i) => ({
        id: `e${i}`, type: options.nonLevel && i === 1 ? 'distance' : 'height-difference', from, to,
        value: Number(value) * (options.mm ? 1000 : 1), unit: options.mm ? 'mm' : 'm',
        ...(options.sigma && !(options.mixed && i === 0) ? { sigma: options.mm ? 1000 : 1, sigmaUnit: options.mm ? 'mm' : 'm' } : {}),
        ...(options.correlation ? { covariance: [1] } : {}),
        ...(options.routeLengths && !(options.partialRoute && i === 0) ? { routeLength: [1000, 2000, 4000][i] } : {})
      })), instrumentParameters: {} }
  })
  return { entry, root, service, network }
}

describe('immutable project-scoped free leveling trials', () => {
  it('releases datum only in the versioned trial, preserves all anchors, and leaves formal results untouched', async () => {
    const { service, network } = await fixture({ sigma: true })
    const formal = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'formal-adjustment' })
    const networkBefore = JSON.stringify(service.getNetwork(network.id)), formalBefore = JSON.stringify(service.getAdjustment(formal.run.id))
    const record = SurveyFreeLevelingTrialV1.parse(service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision)))
    expect(record).toMatchObject({ algorithmVersion: 'free-leveling-trial-1', networkRevision: network.revision, weightBasis: 'inverse-declared-sigma-squared', degreesOfFreedom: 1 })
    expect(record.output).toMatchObject({ status: 'trial-only', engineeringDecision: 'not-evaluated', aprioriCovariance: null, datumDefect: 1 })
    expect(record.originalPointRoles[0]).toMatchObject({ id: 'A', known: true, collection: 'knownPoints', originalPoint: network.knownPoints[0] })
    expect(record.output.points[0]!.height).toBeCloseTo(-37 / 30, 12)
    expect(record.output.observations.map(o => o.sourceAnchor)).toEqual(network.observations.map(o => o.sourceRecordId))
    expect(record.output.observations).toHaveLength(network.observations.length)
    expect(JSON.stringify(service.getNetwork(network.id))).toBe(networkBefore)
    expect(JSON.stringify(service.getAdjustment(formal.run.id))).toBe(formalBefore)
    expect(service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))).toEqual(record)
    expect(service.getFreeLevelingTrial(network.projectId, network.id, record.id)).toEqual(record)
  })

  it('records explicit unit-weight and zero-H0 fallbacks rather than hiding them', async () => {
    const { service, network } = await fixture({ missingHeight: true })
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    expect(record.weightBasis).toBe('inverse-route-length-with-unit-default')
    expect(record.defaultWeightObservationIds).toEqual(['e0', 'e1', 'e2'])
    expect(record.output.observations.every(o => o.weightSource === 'explicit-unit-weight-fallback')).toBe(true)
    expect(record.originalPointRoles.find(p => p.id === 'B')!.referenceHeightBasis).toBe('zero-initial-approximation')
  })

  it('normalizes observation and sigma millimetres consistently with existing leveling', async () => {
    const { service, network } = await fixture({ sigma: true, mm: true })
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    expect(record.output.points[0]!.height).toBeCloseTo(-37 / 30, 12)
    expect(record.output.observations.map(o => o.weight)).toEqual([1, 1, 1])
    expect(record.output.weightedSSE).toBeCloseTo(0.03, 12)
  })

  it.each([{ sigma: true, mixed: true }, { correlation: true }, { nonLevel: true }, { routeLengths: true, partialRoute: true }])('rejects an unsupported observation set as a whole (%j)', async options => {
    const { service, network } = await fixture(options)
    expect(() => service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))).toThrow()
    expect(service.listFreeLevelingTrials(network.projectId, network.id)!.trials).toEqual([])
  })

  it('uses inverse route lengths consistently and records no default weights when all routes are declared', async () => {
    const { service, network } = await fixture({ routeLengths: true })
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    expect(record.defaultWeightObservationIds).toEqual([])
    expect(record.output.observations.map(o => o.weight)).toEqual([1 / 1000, 1 / 2000, 1 / 4000])
    record.output.observations.forEach((o, i) => expect(o.residual).toBeCloseTo(0.3 * [1, 2, 4][i]! / 7, 12))
    expect(record.output.aprioriCovariance).toBeNull()
  })

  it('requires exact revision and both acknowledgements', async () => {
    const { service, network } = await fixture()
    for (const change of [{ expectedRevision: 0 }, { expectedRevision: 999 }, { acknowledgeDatumRelease: false }, { weightPolicy: undefined }, { constraint: 'fixed' }]) {
      expect(() => service.createFreeLevelingTrial(network.projectId, network.id, { ...request(network.revision), ...change })).toThrow()
    }
    expect(service.listFreeLevelingTrials(network.projectId, network.id)!.trials).toEqual([])
  })

  it('restores records after restart, pages bounded summaries and isolates both project and network', async () => {
    const { entry, root, service, network } = await fixture()
    const records = [0, 1, 2].map(i => service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision, `trial-${i}`))!)
    await service.flush(); service.close(); entry.service = new SurveyService({ rootDir: root })
    const reopened = entry.service
    expect(reopened.getFreeLevelingTrial(network.projectId, network.id, records[0]!.id)).toEqual(records[0])
    const first = reopened.listFreeLevelingTrials(network.projectId, network.id, 2, 0)!
    expect(first.trials).toHaveLength(2); expect(first.nextOffset).toBe(2)
    expect(first.trials[0]).not.toHaveProperty('output'); expect(first.trials[0]).not.toHaveProperty('originalPointRoles')
    expect(reopened.listFreeLevelingTrials(network.projectId, network.id, 2, 2)!.trials).toHaveLength(1)
    expect(reopened.getFreeLevelingTrial('other', network.id, records[0]!.id)).toBeNull()
    expect(reopened.getFreeLevelingTrial(network.projectId, 'other', records[0]!.id)).toBeNull()
    expect(reopened.createFreeLevelingTrial('other', network.id, request(network.revision))).toBeNull()
    expect(reopened.listFreeLevelingTrials('other', network.id)).toBeNull()
    expect(() => reopened.listFreeLevelingTrials(network.projectId, network.id, 51)).toThrow()
  })

  it('blocks stale/missing raw bytes for create, replay, list and detail', async () => {
    const { root, service, network } = await fixture()
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    await writeFile(join(root, 'sources', network.sourceFile!.sha256, 'original'), 'changed-source')
    for (const action of [
      () => service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision)),
      () => service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision, 'new')),
      () => service.listFreeLevelingTrials(network.projectId, network.id),
      () => service.getFreeLevelingTrial(network.projectId, network.id, record.id)
    ]) expect(action).toThrow()
    await rm(join(root, 'sources', network.sourceFile!.sha256, 'original'))
    expect(() => service.getFreeLevelingTrial(network.projectId, network.id, record.id)).toThrow()
  })

  it('rejects network mutation and stale revision while preserving the stored record', async () => {
    const { root, service, network } = await fixture()
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      const altered = { ...network, revision: network.revision + 1 }
      db.prepare('UPDATE survey_networks SET data_json = ?, revision = ? WHERE id = ?').run(JSON.stringify(altered), altered.revision, network.id)
      expect(() => service.getFreeLevelingTrial(network.projectId, network.id, record.id)).toThrow()
      expect(() => service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))).toThrow()
      expect(JSON.parse((db.prepare('SELECT data_json FROM survey_free_leveling_trials WHERE id = ?').get(record.id) as { data_json: string }).data_json)).toEqual(record)
    } finally { db.close() }
  })

  it.each(['sourceRecordId', 'value'] as const)('rejects mutated observation %s instead of trusting a truthy anchor or saved input hash', async field => {
    const { root, service, network } = await fixture()
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      const changed = structuredClone(network)
      if (field === 'sourceRecordId') changed.observations[0]!.sourceRecordId = 'forged-source-record'
      else changed.observations[0]!.value += 0.01
      db.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify(changed), network.id)
      expect(() => service.getFreeLevelingTrial(network.projectId, network.id, record.id)).toThrow('source-ineligible')
      expect(() => service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision, 'new'))).toThrow('source-ineligible')
    } finally { db.close() }
  })

  it('enforces append-only storage, including SQLite REPLACE, and rejects altered output after trigger bypass', async () => {
    const { root, service, network } = await fixture()
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      expect(() => db.prepare('UPDATE survey_free_leveling_trials SET data_json = ? WHERE id = ?').run('{}', record.id)).toThrow('append-only')
      expect(() => db.prepare('DELETE FROM survey_free_leveling_trials WHERE id = ?').run(record.id)).toThrow('append-only')
      expect(() => db.exec('INSERT OR REPLACE INTO survey_free_leveling_trials SELECT * FROM survey_free_leveling_trials')).toThrow('append-only')
      db.exec('DROP TRIGGER survey_free_leveling_trials_no_update')
      const changed = structuredClone(record); changed.output.points[0]!.height += 1
      db.prepare('UPDATE survey_free_leveling_trials SET data_json = ? WHERE id = ?').run(JSON.stringify(changed), record.id)
      expect(() => service.getFreeLevelingTrial(network.projectId, network.id, record.id)).toThrow()
      expect(() => service.listFreeLevelingTrials(network.projectId, network.id)).toThrow()
      expect(() => service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))).toThrow()
    } finally { db.close() }
  })

  it('recomputes numerical output even when an attacker rewrites both unkeyed hashes', async () => {
    const { root, service, network } = await fixture()
    const record = service.createFreeLevelingTrial(network.projectId, network.id, request(network.revision))!
    const changed = structuredClone(record)
    changed.output.points[0]!.height += 0.1
    changed.outputHash = hash({ weightBasis: changed.weightBasis, originalPointRoles: changed.originalPointRoles, defaultWeightObservationIds: changed.defaultWeightObservationIds, output: changed.output })
    const { recordHash: _oldHash, ...payload } = changed
    changed.recordHash = hash(payload)
    const db = new Database(join(root, 'survey.sqlite3'))
    try {
      db.exec('DROP TRIGGER survey_free_leveling_trials_no_update')
      db.prepare('UPDATE survey_free_leveling_trials SET data_json = ?, record_hash = ? WHERE id = ?').run(JSON.stringify(changed), changed.recordHash, changed.id)
      expect(() => service.getFreeLevelingTrial(network.projectId, network.id, record.id)).toThrow('replay mismatch')
    } finally { db.close() }
  })
})
