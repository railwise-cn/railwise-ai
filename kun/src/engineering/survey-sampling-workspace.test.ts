import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SURVEY_SAMPLING_WORKSPACE_LIMITS as LIMITS } from '../contracts/survey-quality-sampling-workspace.js'
import { SurveySamplingWorkspaceService } from './survey-sampling-workspace.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const flatDigest = (value: Record<string, unknown>) => sha(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))
async function fixture(count = 101) {
  const root = await mkdtemp(join(tmpdir(), 'survey-sampling-workspace-'))
  const project = { id: 'project-a', revision: 1, workspace: join(root, 'workspace') }
  const options = { rootDir: root, nowIso: () => '2026-09-20T01:00:00.000Z',
    getProject: (id: string) => id === project.id ? project : id === 'project-b' ? { ...project, id } : null }
  const services = [new SurveySamplingWorkspaceService(options)], service = services[0]!
  cleanup.push(async () => { services.splice(0).forEach(item => item.close()); await rm(root, { recursive: true, force: true }) })
  const request = { idempotencyKey: 'population-key-1', expectedProjectRevision: 1, productType: '工程测量', unitProductType: '单位成果',
    definitionStatement: '  每个单位为独立提交并编号的工程测量成果。\n编号顺序是冻结的总体顺序。\n',
    orderedUnitProductIds: Array.from({ length: count }, (_, index) => `单位-${index + 1}`) }
  const freeze = () => service.createPopulation(project.id, request)
  const reopen = () => { const value = new SurveySamplingWorkspaceService(options); services.push(value); return value }
  const restart = () => { services.splice(0).forEach(item => item.close()); return reopen() }
  const db = () => new Database(join(root, 'survey-sampling.sqlite3'))
  return { root, project, options, service, request, freeze, reopen, restart, db }
}

describe('Survey sampling frozen workspace', () => {
  it('retains exact UTF-8 definition bytes and ordered units while returning bounded metadata', async () => {
    const f = await fixture(), population = f.freeze()
    expect(f.freeze()).toEqual(population)
    expect(population).toMatchObject({ definitionStatement: f.request.definitionStatement, unitCount: 101,
      definitionTrust: 'user-declared-not-professionally-verified', definitionSizeBytes: Buffer.byteLength(f.request.definitionStatement),
      definitionEvidenceSha256: sha(f.request.definitionStatement), populationCompleteness: 'caller-declared-not-verified' })
    expect(population).not.toHaveProperty('orderedUnitProductIds')
    const page1 = f.service.listUnits(f.project.id, population.id, 100)
    expect(page1.units.map(item => item.unitProductId)).toEqual(f.request.orderedUnitProductIds.slice(0, 100))
    expect(page1.nextOffset).toBe(100)
    expect(f.service.listUnits(f.project.id, population.id, 100, 100)).toMatchObject({ units: [{ index: 100, unitProductId: '单位-101' }], nextOffset: null })
    const history = f.service.listPopulations(f.project.id)
    expect(history.populations[0]).not.toHaveProperty('definitionStatement')
    expect(history.populations[0]).not.toHaveProperty('orderedUnitProductIds')
    const db = f.db()
    try { expect((db.prepare('SELECT definition_bytes FROM sampling_populations').get() as { definition_bytes: Buffer }).definition_bytes).toEqual(Buffer.from(f.request.definitionStatement)) }
    finally { db.close() }
  })

  it('saves a server seed once, prevents same-stage rerolls across connections, and fully replays after a real restart', async () => {
    const f = await fixture(), population = f.freeze(), peer = f.reopen()
    const input = { populationId: population.id, idempotencyKey: 'sample-field-1', stage: 'final-field', inspectionMode: 'table-1-simple-random' }
    const run = f.service.createRun(f.project.id, input), samples = f.service.listSamples(f.project.id, run.id)
    expect(run).toMatchObject({ round: 1, unitCount: 101, sampleSize: 11, batchCount: 1, randomSource: 'runtime-generated-local-unwitnessed', decision: 'not-evaluated' })
    expect(run).not.toHaveProperty('plan')
    expect(JSON.stringify(run)).not.toContain('seedHex')
    expect(new Set(samples.samples.map(sample => sample.unitProductId)).size).toBe(11)
    expect(peer.createRun(f.project.id, input)).toEqual(run)
    expect(() => peer.createRun(f.project.id, { ...input, idempotencyKey: 'reroll-field-2' })).toThrow('conflict')
    expect(() => peer.createRun(f.project.id, { ...input, idempotencyKey: 'reroll-as-census', inspectionMode: 'census' })).toThrow('conflict')
    expect(() => peer.createRun(f.project.id, { ...input, stage: 'acceptance' })).toThrow('conflict')
    const db = f.db()
    let storedSeed: string
    try {
      const rows = db.prepare('SELECT data_json FROM sampling_runs').all() as Array<{ data_json: string }>
      expect(rows).toHaveLength(1)
      const plan = JSON.parse(rows[0]!.data_json).plan
      storedSeed = plan.request.randomSource.seedHex
      expect(storedSeed).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.request.randomSource.receiptSha256).toBe(sha(Buffer.from(storedSeed, 'hex')))
    } finally { db.close() }
    const restarted = f.restart()
    expect(restarted.createRun(f.project.id, input)).toEqual(run)
    expect(restarted.listSamples(f.project.id, run.id)).toEqual(samples)
    expect(restarted.verifyRun(f.project.id, run.id)).toMatchObject({ recordIntegrity: 'verified', recomputed: true, planHash: run.planHash, decision: 'not-evaluated', checkpointTrust: 'local-records-only' })
    const reopened = f.db()
    try { expect(JSON.parse((reopened.prepare('SELECT data_json FROM sampling_runs').get() as { data_json: string }).data_json).plan.request.randomSource.seedHex).toBe(storedSeed!) }
    finally { reopened.close() }
  })

  it('requires census for process and final office while allowing both final-field and acceptance modes', async () => {
    const f = await fixture(), population = f.freeze()
    for (const stage of ['process', 'final-office']) {
      const input = { populationId: population.id, idempotencyKey: `stage-${stage}`, stage, inspectionMode: 'census' }
      expect(() => f.service.createRun(f.project.id, { ...input, inspectionMode: 'table-1-simple-random' })).toThrow()
      const run = f.service.createRun(f.project.id, input)
      expect(run).toMatchObject({ sampleSize: 101, randomSource: 'not-applicable' })
      expect(f.service.listSamples(f.project.id, run.id, 100).samples.map(sample => sample.unitProductId)).toEqual(f.request.orderedUnitProductIds.slice(0, 100))
    }
    for (const [stage, inspectionMode] of [['final-field', 'census'], ['acceptance', 'table-1-simple-random']]) {
      expect(f.service.createRun(f.project.id, { populationId: population.id, idempotencyKey: `stage-${stage}`, stage, inspectionMode })).toMatchObject({ stage, inspectionMode })
    }
    expect(f.service.listRuns(f.project.id).runs).toHaveLength(4)
  })

  it('rejects injected seeds, results, rounds, identities and cross-project references', async () => {
    const f = await fixture(), population = f.freeze()
    const input = { populationId: population.id, idempotencyKey: 'sample-injection', stage: 'acceptance', inspectionMode: 'table-1-simple-random' }
    for (const injection of [{ seedHex: '1'.repeat(64) }, { randomSource: { seedHex: '1'.repeat(64) } }, { sampleSize: 3 }, { round: 2 }, { actor: 'professional' }, { decision: 'passed' }]) {
      expect(() => f.service.createRun(f.project.id, { ...input, ...injection })).toThrow()
    }
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, definitionEvidenceSha256: '0'.repeat(64) })).toThrow()
    const run = f.service.createRun(f.project.id, input)
    for (const action of [() => f.service.createRun('project-b', input), () => f.service.getPopulation('project-b', population.id),
      () => f.service.listUnits('project-b', population.id), () => f.service.getRun('project-b', run.id),
      () => f.service.listSamples('project-b', run.id), () => f.service.verifyRun('project-b', run.id)]) expect(action).toThrow('not-found')
    expect(f.service.listPopulations('project-b')).toEqual({ populations: [], unavailable: [], nextOffset: null })
    expect(f.service.listRuns('project-b')).toEqual({ runs: [], unavailable: [], nextOffset: null })
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, orderedUnitProductIds: [...f.request.orderedUnitProductIds].reverse() })).toThrow('conflict')
  })

  it('freezes up to 10000 units without truncation, bounds UTF-8 input and exposes only paginated output', async () => {
    const f = await fixture(10000), population = f.freeze()
    expect(population.unitCount).toBe(10000)
    expect(f.service.listUnits(f.project.id, population.id, 100, 9900)).toMatchObject({ total: 10000, nextOffset: null })
    expect(f.service.listUnits(f.project.id, population.id, 100, 10000).units).toEqual([])
    const run = f.service.createRun(f.project.id, { populationId: population.id, idempotencyKey: 'large-census-key', stage: 'process', inspectionMode: 'census' })
    expect(run).toMatchObject({ sampleSize: 10000, batchCount: 10 })
    expect(run.batches.every(batch => batch.batchSize === 1000 && batch.sampleSize === 1000)).toBe(true)
    const samples = f.service.listSamples(f.project.id, run.id, 100, 9900)
    expect(samples.samples.at(-1)).toMatchObject({ index: 9999, batchIndex: 9, unitProductId: '单位-10000' })
    expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThan(10000)
    expect(Buffer.byteLength(JSON.stringify(samples))).toBeLessThan(10000)
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, orderedUnitProductIds: [...f.request.orderedUnitProductIds, 'unit-10001'] })).toThrow()
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, definitionStatement: '中'.repeat(Math.ceil(LIMITS.definitionBytes / 3) + 1) })).toThrow()
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, orderedUnitProductIds: Array.from({ length: 10000 }, (_, i) => `${i}-${'中'.repeat(90)}`) })).toThrow('limit')
    for (const [limit, offset] of [[101, 0], [0, 0], [1, 10001], [1.5, 0], [1, -1]]) {
      expect(() => f.service.listUnits(f.project.id, population.id, limit, offset)).toThrow('limit')
      expect(() => f.service.listSamples(f.project.id, run.id, limit, offset)).toThrow('limit')
    }
  })

  it('rejects malformed Unicode and duplicate frames without normalizing distinct valid IDs', async () => {
    const f = await fixture(1)
    for (const orderedUnitProductIds of [['same', 'same'], [' bad '], ['\ud800']]) {
      expect(() => f.service.createPopulation(f.project.id, { ...f.request, orderedUnitProductIds })).toThrow()
    }
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, definitionStatement: '\udfff' })).toThrow()
    const exact = f.service.createPopulation(f.project.id, { ...f.request, orderedUnitProductIds: ['é', 'e\u0301'] })
    expect(f.service.listUnits(f.project.id, exact.id).units.map(item => item.unitProductId)).toEqual(['é', 'e\u0301'])
  })

  it('retains stale history alongside fresh revision data and rolls back mid-freeze revision changes', async () => {
    const f = await fixture(), old = f.freeze()
    const run = f.service.createRun(f.project.id, { populationId: old.id, idempotencyKey: 'old-run-key', stage: 'process', inspectionMode: 'census' })
    f.project.revision++
    expect(() => f.service.getPopulation(f.project.id, old.id)).toThrow('stale')
    const current = f.service.createPopulation(f.project.id, { ...f.request, idempotencyKey: 'fresh-population', expectedProjectRevision: 2 })
    expect(f.service.listPopulations(f.project.id)).toMatchObject({ populations: [{ id: current.id }], unavailable: [{ id: old.id, reason: 'stale' }] })
    expect(f.service.listRuns(f.project.id)).toMatchObject({ runs: [], unavailable: [{ id: run.id, reason: 'stale' }] })
    const read = f.options.getProject
    let reads = 0
    f.options.getProject = id => { if (++reads === 2) f.project.revision++; return read(id) }
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, idempotencyKey: 'race-population', expectedProjectRevision: 2 })).toThrow('stale')
    const db = f.db()
    try { expect(db.prepare('SELECT count(*) AS count FROM sampling_populations').get()).toEqual({ count: 2 }) }
    finally { db.close() }
  })

  it('blocks overwrite/delete/replace and recomputes the plan after an attacker repairs the outer row digest', async () => {
    const f = await fixture(), population = f.freeze()
    const run = f.service.createRun(f.project.id, { populationId: population.id, idempotencyKey: 'tamper-run-key', stage: 'final-field', inspectionMode: 'table-1-simple-random' })
    const db = f.db()
    try {
      for (const table of ['sampling_populations', 'sampling_runs']) {
        expect(() => db.exec(`DELETE FROM ${table}`)).toThrow('append-only')
        expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`)).toThrow('append-only')
        expect(() => db.exec(`UPDATE ${table} SET id='changed'`)).toThrow('append-only')
      }
      db.exec('DROP TRIGGER sampling_runs_no_update')
      const row = db.prepare('SELECT * FROM sampling_runs WHERE id=?').get(run.id) as Record<string, unknown>
      const { record_hash: initialHash, ...initialUnsigned } = row
      expect(flatDigest(initialUnsigned)).toBe(initialHash)
      const record = JSON.parse(row.data_json as string)
      const selected = record.plan.batches[0].selectedUnitProductIds as string[]
      ;[selected[0], selected[1]] = [selected[1]!, selected[0]!]
      row.data_json = JSON.stringify(record)
      const { record_hash: _hash, ...unsigned } = row
      db.prepare('UPDATE sampling_runs SET data_json=?,record_hash=? WHERE id=?').run(row.data_json, flatDigest(unsigned), run.id)
      expect(() => f.service.getRun(f.project.id, run.id)).toThrow('integrity')
      expect(() => f.service.verifyRun(f.project.id, run.id)).toThrow('integrity')
      expect(f.service.listRuns(f.project.id)).toEqual({ runs: [], unavailable: [{ id: run.id, reason: 'integrity' }], nextOffset: null })
    } finally { db.close() }
  })

  it('detects altered retained definition bytes and SQL/JSON scope identity', async () => {
    const f = await fixture(), population = f.freeze(), db = f.db()
    try {
      db.exec('DROP TRIGGER sampling_populations_no_update')
      const row = db.prepare('SELECT * FROM sampling_populations').get() as Record<string, unknown>
      row.definition_bytes = Buffer.from('changed retained bytes')
      const { record_hash: _hash, definition_bytes, ...unsigned } = row
      db.prepare('UPDATE sampling_populations SET definition_bytes=?,record_hash=? WHERE id=?')
        .run(definition_bytes, flatDigest({ ...unsigned, definition_bytes_sha256: sha(definition_bytes as Buffer) }), population.id)
      expect(() => f.service.getPopulation(f.project.id, population.id)).toThrow('integrity')
    } finally { db.close() }
    const another = await fixture(), good = another.freeze(), otherDb = another.db()
    try {
      otherDb.exec('DROP TRIGGER sampling_populations_no_update')
      const row = otherDb.prepare('SELECT * FROM sampling_populations').get() as Record<string, unknown>
      const data = JSON.parse(row.data_json as string); data.projectId = 'project-b'; row.data_json = JSON.stringify(data)
      const { record_hash: _hash, definition_bytes, ...unsigned } = row
      otherDb.prepare('UPDATE sampling_populations SET data_json=?,record_hash=? WHERE id=?')
        .run(row.data_json, flatDigest({ ...unsigned, definition_bytes_sha256: sha(definition_bytes as Buffer) }), good.id)
      expect(() => another.service.getPopulation(another.project.id, good.id)).toThrow('integrity')
      expect(() => another.service.getPopulation('project-b', good.id)).toThrow('not-found')
    } finally { otherDb.close() }
  })

  it('rejects repaired row digests that move a run to another stage or frozen population', async () => {
    for (const column of ['stage', 'population_id', 'request_hash']) {
      const f = await fixture(), population = f.freeze()
      const other = f.service.createPopulation(f.project.id, { ...f.request, idempotencyKey: 'other-frame-key' })
      const run = f.service.createRun(f.project.id, { populationId: population.id, idempotencyKey: 'row-binding-run', stage: 'final-field', inspectionMode: 'table-1-simple-random' })
      const db = f.db()
      try {
        db.exec('DROP TRIGGER sampling_runs_no_update')
        const row = db.prepare('SELECT * FROM sampling_runs WHERE id=?').get(run.id) as Record<string, unknown>
        row[column] = column === 'stage' ? 'acceptance' : column === 'population_id' ? other.id : '0'.repeat(64)
        const { record_hash: _hash, ...unsigned } = row
        db.prepare(`UPDATE sampling_runs SET ${column}=?,record_hash=? WHERE id=?`).run(row[column], flatDigest(unsigned), run.id)
        expect(() => f.service.getRun(f.project.id, run.id)).toThrow('integrity')
      } finally { db.close() }
    }
  })

  it('enforces the persisted per-project population bound while preserving idempotent retries', async () => {
    const f = await fixture(1)
    for (let index = 0; index < LIMITS.populationsPerProject; index++) {
      f.service.createPopulation(f.project.id, { ...f.request, idempotencyKey: `bounded-population-${index}` })
    }
    expect(() => f.service.createPopulation(f.project.id, { ...f.request, idempotencyKey: 'over-population-bound' })).toThrow('limit')
    expect(f.service.createPopulation(f.project.id, { ...f.request, idempotencyKey: 'bounded-population-0' }).unitCount).toBe(1)
    const first = f.service.listPopulations(f.project.id, 100)
    expect(first.populations).toHaveLength(100); expect(first.nextOffset).toBe(100)
    const last = f.service.listPopulations(f.project.id, 100, first.nextOffset!)
    expect(last.populations).toHaveLength(28); expect(last.nextOffset).toBeNull()
  })
})
