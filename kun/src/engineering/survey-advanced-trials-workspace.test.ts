import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { SurveyAdvancedTrialsWorkspaceService } from './survey-advanced-trials-workspace.js'
import * as C from '../contracts/survey-advanced-trials-workspace.js'
import { advancedTrialTestRequest, maximumNewAdvancedTrialRequest, maximumReferenceDatumRequest, maximumStaticIncrementalRequest } from './survey-advanced-trials-test-helpers.js'
import { parseAdvancedTrialJson } from './survey-advanced-trials-json.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanup.splice(0)) await f() })
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const digest = (v: unknown) => sha(canonical(v))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'advanced-trials-'))
  let project = { id: 'project-test', revision: 1, workspace: join(root, 'workspace') }
  let ms = Date.parse('2026-09-20T00:00:00.000Z')
  const options = { rootDir: root, getProject: (id: string) => id === project.id ? project : null, nowIso: () => new Date(ms).toISOString(), clockMs: () => ms }
  const services: SurveyAdvancedTrialsWorkspaceService[] = []
  const reopen = () => { const s = new SurveyAdvancedTrialsWorkspaceService(options); services.push(s); return s }
  const service = reopen()
  cleanup.push(async () => { services.forEach(s => s.close()); await rm(root, { recursive: true, force: true }) })
  const db = () => new Database(join(root, 'survey-advanced-trials.sqlite3'))
  return { service, reopen, db, root, pid: project.id, setProject: (p: Partial<typeof project>) => { project = { ...project, ...p } },
    advance: (delta = 60_001) => { ms += delta }, raw: (kind: C.SurveyAdvancedTrialKindV1, key?: string) => Buffer.from(JSON.stringify(advancedTrialTestRequest(kind, key))) }
}
function forge(db: Database.Database, id: string, mutate: (row: Record<string, unknown>, record: C.SurveyAdvancedTrialRecordV1) => void, rehash = false) {
  const row = db.prepare('SELECT * FROM advanced_trials WHERE id=?').get(id) as Record<string, unknown>
  const record = JSON.parse(row.data_json as string) as C.SurveyAdvancedTrialRecordV1
  mutate(row, record)
  if (rehash) {
    const { recordHash: _r, ...unsigned } = record
    record.recordHash = digest(unsigned); row.record_hash = record.recordHash
    row.data_json = JSON.stringify(record)
    const { storage_hash: _s, request_bytes, declaration_bytes, ...metadata } = row
    row.storage_hash = digest({ ...metadata, request_bytes_sha256: sha(request_bytes as Buffer), declaration_bytes_sha256: sha(declaration_bytes as Buffer) })
  }
  db.exec('DROP TRIGGER IF EXISTS advanced_trials_no_update')
  const keys = Object.keys(row)
  db.prepare(`UPDATE advanced_trials SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => row[k]), id)
}

describe('project-scoped immutable advanced trials', () => {
  it.each(['generalized-w', 'vce', 'huber', 'statistical-family', 'reference-datum', 'static-incremental'] as const)('preserves exact UTF-8 and replays %s across restart with the same id', async kind => {
    const f = await fixture(), raw = Buffer.concat([Buffer.from(' \n'), f.raw(kind), Buffer.from('\r\n')])
    const summary = f.service.createTrial(f.pid, raw)
    expect(summary).toMatchObject({ kind, requestSha256: sha(raw), modelAssumptions: 'not-verified', formalResultsModified: false })
    expect(summary).not.toHaveProperty('result')
    expect(f.service.createTrial(f.pid, raw)).toEqual(summary)
    const record = f.service.getTrial(f.pid, summary.id)
    expect(record.requestJson).toBe(raw.toString())
    expect(record.declarationJson).toBe(advancedTrialTestRequest(kind).declarationJson)
    expect(record.modelBasisStatement).toBe(advancedTrialTestRequest(kind).modelBasisStatement)
    expect(C.SurveyAdvancedTrialRecordV1.safeParse(record).success).toBe(true)
    const db = f.db()
    try {
      const row = db.prepare('SELECT request_bytes,declaration_bytes FROM advanced_trials').get() as { request_bytes: Buffer; declaration_bytes: Buffer }
      expect(row.request_bytes).toEqual(raw)
      expect(row.declaration_bytes).toEqual(Buffer.from(record.declarationJson))
      expect(db.prepare('SELECT count(*) AS count FROM advanced_trials').get()).toEqual({ count: 1 })
    } finally { db.close() }
    f.service.close()
    const reopened = f.reopen()
    expect(reopened.getTrial(f.pid, summary.id)).toEqual(record)
    expect(reopened.listTrials(f.pid).trials).toEqual([summary])
    expect(reopened.reverifyTrial(f.pid, summary.id)).toMatchObject({ recordIntegrity: 'verified', recomputed: true, recordHash: record.recordHash })
    expect(reopened.createTrial(f.pid, raw)).toEqual(summary)
  })
  it('isolates projects, revision and workspace including retries and restored records', async () => {
    const f = await fixture(), raw = f.raw('vce'), created = f.service.createTrial(f.pid, raw)
    expect(() => f.service.getTrial('other', created.id)).toThrow('not-found')
    expect(() => f.service.createTrial('other', raw)).toThrow('not-found')
    expect(() => f.service.listTrials('other')).toThrow('not-found')
    f.setProject({ revision: 2 })
    expect(() => f.service.getTrial(f.pid, created.id)).toThrow('stale')
    expect(() => f.service.createTrial(f.pid, raw)).toThrow('stale')
    expect(f.service.listTrials(f.pid).unavailable).toEqual([{ id: created.id, reason: 'stale' }])
    f.setProject({ revision: 1, workspace: join(f.root, 'different') })
    expect(() => f.reopen().getTrial(f.pid, created.id)).toThrow('stale')
  })
  it('treats same-key different raw request bytes or model basis as conflict', async () => {
    const f = await fixture(), raw = f.raw('vce')
    f.service.createTrial(f.pid, raw)
    expect(() => f.service.createTrial(f.pid, Buffer.concat([Buffer.from(' '), raw]))).toThrow('conflict')
    const req = advancedTrialTestRequest('vce'); req.modelBasisStatement += ' changed'
    expect(() => f.service.createTrial(f.pid, Buffer.from(JSON.stringify(req)))).toThrow('conflict')
    expect(f.service.listTrials(f.pid).trials).toHaveLength(1)
  })
  it('serializes distinct instances through SQLite uniqueness and exact idempotency', async () => {
    const f = await fixture(), other = f.reopen(), raw = f.raw('generalized-w')
    const first = f.service.createTrial(f.pid, raw)
    expect(other.createTrial(f.pid, raw)).toEqual(first)
    expect(() => other.createTrial(f.pid, Buffer.concat([raw, Buffer.from(' ')]))).toThrow('conflict')
  })
  it('stores raw declaration separately from schema normalization', async () => {
    const f = await fixture(), req = advancedTrialTestRequest('vce')
    const model = JSON.parse(req.declarationJson); model.parameterIds[0] = ' height '
    req.declarationJson = JSON.stringify(model)
    const out = f.service.createTrial(f.pid, Buffer.from(JSON.stringify(req)))
    const record = f.service.getTrial(f.pid, out.id)
    expect(record.declarationJson).toContain(' height ')
    expect(record.kind).toBe('vce')
    if (record.kind !== 'vce') throw new Error('Expected VCE record')
    expect(record.declaration.parameterIds).toEqual(['height'])
    expect(record.modelHash).toBe(digest(record.declaration))
    expect(record.declarationSha256).toBe(sha(req.declarationJson))
  })
  it.each(['no-ack', 'old-revision', 'wrong-kind', 'unknown-field', 'invalid-model', 'invalid-utf8', 'duplicate-key', 'surrogate', 'nested-duplicate', 'oversized-basis'])('rejects inadmissible creation: %s', async mode => {
    const f = await fixture(), req = advancedTrialTestRequest('vce')
    let raw: Buffer
    if (mode === 'no-ack') Object.assign(req, { acknowledged: false })
    if (mode === 'old-revision') req.expectedProjectRevision = 9
    if (mode === 'wrong-kind') req.kind = 'generalized-w'
    if (mode === 'unknown-field') Object.assign(req, { decision: 'accepted' })
    if (mode === 'invalid-model') req.declarationJson = '{}'
    if (mode === 'surrogate') req.declarationJson = req.declarationJson.replace('synthetic', '\\ud800')
    if (mode === 'nested-duplicate') req.declarationJson = req.declarationJson.replace('"maxIterations": 100', '"maxIterations": 100, "maxIterations": 1')
    if (mode === 'oversized-basis') req.modelBasisStatement = '汉'.repeat(C.SURVEY_ADVANCED_TRIAL_LIMITS.basisBytes)
    raw = Buffer.from(JSON.stringify(req))
    if (mode === 'invalid-utf8') raw = Buffer.from([0xff])
    if (mode === 'duplicate-key') raw = Buffer.from(raw.toString().replace('"acknowledged":true', '"acknowledged":false,"acknowledged":true'))
    expect(() => f.service.createTrial(f.pid, raw)).toThrow()
    expect(f.service.listTrials(f.pid).trials).toEqual([])
  })
  it('bounds nesting and escaped-equivalent JSON keys before normalization', () => {
    expect(() => parseAdvancedTrialJson('{"acknowledged":false,"\\u0061cknowledged":true}')).toThrow('Ambiguous')
    expect(() => parseAdvancedTrialJson('['.repeat(33) + '0' + ']'.repeat(33))).toThrow('nesting')
  })
  it('enforces append-only SQL including INSERT OR REPLACE', async () => {
    const f = await fixture(); f.service.createTrial(f.pid, f.raw('vce'))
    const db = f.db()
    try {
      expect(() => db.exec("UPDATE advanced_trials SET data_json='{}'")).toThrow('append-only')
      expect(() => db.exec('DELETE FROM advanced_trials')).toThrow('append-only')
      expect(() => db.exec('INSERT OR REPLACE INTO advanced_trials SELECT * FROM advanced_trials')).toThrow('append-only')
    } finally { db.close() }
  })
  it.each(['project_id', 'kind', 'project_revision', 'project_binding_hash', 'idempotency_key', 'request_hash', 'created_at', 'data_json', 'request_bytes', 'declaration_bytes'])('rejects tampered SQL %s and preserves healthy history', async column => {
    const f = await fixture(), bad = f.service.createTrial(f.pid, f.raw('vce')), good = f.service.createTrial(f.pid, f.raw('generalized-w', 'healthy-key'))
    const db = f.db()
    try { forge(db, bad.id, row => {
      row[column] = column.endsWith('_bytes') ? Buffer.from('changed') : column === 'project_revision' ? 999 : 'tampered'
    }) } finally { db.close() }
    expect(() => f.service.getTrial(f.pid, bad.id)).toThrow()
    const page = f.service.listTrials(f.pid)
    expect(page.trials.map(r => r.id)).toEqual([good.id])
    expect(page.unavailable).toHaveLength(column === 'project_id' ? 0 : 1)
  })
  it.each(['generalized-w', 'vce'] as const)('strictly recomputes %s after coherent output+unkeyed hash rewriting', async kind => {
    const f = await fixture(), created = f.service.createTrial(f.pid, f.raw(kind)), db = f.db()
    try { forge(db, created.id, (_row, record) => {
      if (record.kind === 'generalized-w' && record.result.modelStatus === 'resolved') record.result.parameters[0]! += .01
      if (record.kind === 'vce') record.result.finalFit!.parameters[0]! += .01
      record.resultHash = digest(record.result)
    }, true) } finally { db.close() }
    expect(() => f.service.getTrial(f.pid, created.id)).toThrow('integrity')
    expect(() => f.service.createTrial(f.pid, f.raw(kind))).toThrow('integrity')
  })
  it.each(['kind', 'idempotency_key', 'request_bytes', 'declaration_bytes'])('checks SQL/raw identity even after rehashing storage for %s', async column => {
    const f = await fixture(), created = f.service.createTrial(f.pid, f.raw('vce')), db = f.db()
    try { forge(db, created.id, row => { row[column] = column.endsWith('_bytes') ? Buffer.from('forged') : 'forged' }, true) }
    finally { db.close() }
    expect(() => f.service.getTrial(f.pid, created.id)).toThrow('integrity')
  })
  it('quarantines unsupported replay environment without changing history', async () => {
    const f = await fixture(), created = f.service.createTrial(f.pid, f.raw('vce')), db = f.db()
    try { forge(db, created.id, (_row, record) => { record.replayEnvironment.node = 'future-engine'; record.replayEnvironmentHash = digest(record.replayEnvironment) }, true) }
    finally { db.close() }
    expect(() => f.service.getTrial(f.pid, created.id)).toThrow('replay-environment')
    expect(f.service.listTrials(f.pid).unavailable).toEqual([{ id: created.id, reason: 'replay-environment' }])
  })
  it.each([' ', 'x'.repeat(200)])('keeps healthy rows accessible with a malformed SQL id', async invalid => {
    const f = await fixture(), bad = f.service.createTrial(f.pid, f.raw('vce')), good = f.service.createTrial(f.pid, f.raw('vce', 'healthy-key'))
    const db = f.db()
    try { forge(db, bad.id, row => { row.id = invalid }) } finally { db.close() }
    const page = f.service.listTrials(f.pid)
    expect(page.trials).toEqual([good]); expect(page.unavailable[0]!.id).toMatch(/^unavailable-slot-/)
  })
  it('pages unavailable rows without concealing good rows on the next page', async () => {
    const f = await fixture(), first = f.service.createTrial(f.pid, f.raw('vce')); f.advance(1000)
    const second = f.service.createTrial(f.pid, f.raw('generalized-w', 'second-key')), db = f.db()
    try { forge(db, second.id, row => { row.data_json = 'not json' }) } finally { db.close() }
    const page = f.service.listTrials(f.pid, 1)
    expect(page.trials).toEqual([]); expect(page.nextOffset).toBe(1)
    expect(f.service.listTrials(f.pid, 1, 1)).toEqual({ trials: [first], unavailable: [], nextOffset: null })
  })
  it('rejects oversized persisted content before materializing or parsing it', async () => {
    const f = await fixture(), bad = f.service.createTrial(f.pid, f.raw('vce')), good = f.service.createTrial(f.pid, f.raw('vce', 'healthy-key'))
    const db = f.db()
    try { db.exec('DROP TRIGGER advanced_trials_no_update'); db.prepare('UPDATE advanced_trials SET data_json=? WHERE id=?').run('x'.repeat(C.SURVEY_ADVANCED_TRIAL_LIMITS.recordBytes + 1), bad.id) }
    finally { db.close() }
    expect(() => f.service.getTrial(f.pid, bad.id)).toThrow('integrity')
    expect(f.service.listTrials(f.pid).trials).toEqual([good])
  })
  it('enforces per-project count quota with all unusable history still counted', async () => {
    const f = await fixture(), created = f.service.createTrial(f.pid, f.raw('vce')), db = f.db()
    try {
      for (let i = 1; i < C.SURVEY_ADVANCED_TRIAL_LIMITS.trialsPerProject; i++) db.prepare(`INSERT INTO advanced_trials
        SELECT ?,project_id,kind,project_revision,project_binding_hash,?,request_hash,record_hash,created_at,data_json,request_bytes,declaration_bytes,storage_hash FROM advanced_trials WHERE id=?`)
        .run(`quota-row-${i}`, `quota-key-${i}`, created.id)
    } finally { db.close() }
    f.advance()
    expect(() => f.service.createTrial(f.pid, f.raw('vce', 'over-quota-key'))).toThrow('limit')
  })
  it('reads a full ten-row page at the maximum declared VCE cost without overcharging', async () => {
    const f = await fixture()
    const request = advancedTrialTestRequest('vce')
    const model = {
      schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm',
      parameterIds: Array.from({ length: 32 }, (_, i) => `x${i}`),
      groups: Array.from({ length: 8 }, (_, i) => ({ id: `g${i}`, initialVariance: 1, sourceAnchor: 'cost-limit-fixture' })),
      observations: Array.from({ length: 128 }, (_, i) => ({ id: `o${i}`, value: i, coefficients: Array(32).fill(1), groupId: `g${Math.floor(i / 16)}`, relativeVariance: 1, sourceAnchor: 'cost-limit-fixture' })),
      maxIterations: 100, relativeTolerance: 1e-12
    }
    // Deliberately rank deficient: the real kernel records that outcome. The
    // admission/replay charge must still use the full declared size, not the
    // fast failure path or a forged cached result.
    request.declarationJson = JSON.stringify(model)
    for (let i = 0; i < 10; i++) {
      f.advance()
      request.idempotencyKey = `maximum-cost-${i}`
      expect(f.service.createTrial(f.pid, Buffer.from(JSON.stringify(request))).outcome).toBe('functional-rank-or-conditioning')
    }
    f.advance()
    const page = f.service.listTrials(f.pid, 10)
    expect(page.trials).toHaveLength(10); expect(page.unavailable).toEqual([]); expect(page.nextOffset).toBeNull()
    // 1 + 10*(3+20) = 231 of 240 units: the maximum admitted page fits once.
    expect(() => f.service.getTrial(f.pid, page.trials[0]!.id)).toThrow('rate-limit')
  })
  it.each(['huber', 'statistical-family'] as const)('reads ten maximum-cost %s records and enforces the remaining replay budget', async kind => {
    const f = await fixture()
    for (let i = 0; i < 10; i++) {
      f.advance()
      f.service.createTrial(f.pid, Buffer.from(JSON.stringify(maximumNewAdvancedTrialRequest(kind, `maximum-new-${i}`))))
    }
    f.advance()
    const page = f.service.listTrials(f.pid)
    expect(page.trials).toHaveLength(10); expect(page.unavailable).toEqual([])
    // Huber: 1+10*(3+20)=231; family: 1+10*(3+16)=191.
    if (kind === 'huber') expect(() => f.service.getTrial(f.pid, page.trials[0]!.id)).toThrow('rate-limit')
    else {
      expect(f.service.getTrial(f.pid, page.trials[0]!.id).kind).toBe(kind)
      expect(f.service.getTrial(f.pid, page.trials[0]!.id).kind).toBe(kind)
      expect(() => f.service.getTrial(f.pid, page.trials[0]!.id)).toThrow('rate-limit')
    }
  }, 60_000)
  it.each(['huber', 'statistical-family'] as const)('detects rehashed %s result substitution through numerical replay', async kind => {
    const f = await fixture(), summary = f.service.createTrial(f.pid, f.raw(kind)), db = f.db()
    try { forge(db, summary.id, (_row, record) => {
      if (record.kind === 'huber') record.result.states[0]!.objective += 1
      else if (record.kind === 'statistical-family' && record.result.outcome === 'evaluated') record.result.request.familyId = 'forged-family'
      record.resultHash = digest(record.result)
    }, true) } finally { db.close() }
    expect(() => f.service.getTrial(f.pid, summary.id)).toThrow('integrity')
    expect(f.service.listTrials(f.pid).unavailable).toEqual([{ id: summary.id, reason: 'integrity' }])
  })
  it('enforces persistent write rate and per-process bounded replay work', async () => {
    const f = await fixture()
    for (let i = 0; i < 8; i++) f.service.createTrial(f.pid, f.raw('vce', `rate-key-${i}`))
    expect(() => f.reopen().createTrial(f.pid, f.raw('vce', 'rate-key-9'))).toThrow('rate-limit')
    f.advance()
    f.service.createTrial(f.pid, f.raw('vce', 'rate-key-9'))
    for (let i = 0; i < 6; i++) f.service.listTrials(f.pid)
    expect(() => f.service.listTrials(f.pid)).toThrow('rate-limit')
  })
})


describe('declared reference datum integration', () => {
  it('keeps point counts distinct and refuses new count fields on legacy kinds', async () => {
    const f = await fixture(), summary = f.service.createTrial(f.pid, f.raw('reference-datum'))
    expect(summary).toMatchObject({ pointCount: 3, referenceCount: 2, observationCount: 0, parameterCount: 0, outcome: 'calculated' })
    expect(C.SurveyAdvancedTrialSummaryV1.safeParse({ ...summary, referenceCount: 4 }).success).toBe(false)
    expect(C.SurveyAdvancedTrialSummaryV1.safeParse({ ...summary, familyMemberCount: 3 }).success).toBe(false)
    const old = f.service.createTrial(f.pid, f.raw('vce', 'legacy-count-check'))
    expect(old).not.toHaveProperty('pointCount')
    expect(C.SurveyAdvancedTrialSummaryV1.safeParse({ ...old, pointCount: 3, referenceCount: 2 }).success).toBe(false)
  })
  it('retains GLS singular unavailability and requires an explicit equal-reference declaration', async () => {
    const f = await fixture(), req = advancedTrialTestRequest('reference-datum')
    const model = JSON.parse(req.declarationJson)
    model.firstEpoch.covariance = model.secondEpoch.covariance = [[1,-1,0],[-1,1,0],[0,0,1]]
    req.declarationJson = JSON.stringify(model)
    const first = f.service.createTrial(f.pid, Buffer.from(JSON.stringify(req)))
    expect(f.service.getTrial(f.pid, first.id).result).toMatchObject({ outcome: 'unavailable', code: 'reference-covariance-rank-or-conditioning' })
    model.method = 'equal-reference-mean'; req.idempotencyKey = 'equal-reference-new'; req.declarationJson = JSON.stringify(model)
    const second = f.service.createTrial(f.pid, Buffer.from(JSON.stringify(req)))
    expect(f.service.getTrial(f.pid, second.id).result).toMatchObject({ outcome: 'calculated', covarianceCheck: { classification: 'semidefinite-or-unresolved-within-numerical-tolerance' }, referencePhysicalStability: 'not-evaluated' })
    expect(f.service.listTrials(f.pid).trials).toHaveLength(2)
  })
  it('strictly replays ten complete 32-point cross-covariance records within the history budget', async () => {
    const f = await fixture()
    for (let i = 0; i < 10; i++) {
      f.advance()
      const summary = f.service.createTrial(f.pid, Buffer.from(JSON.stringify(maximumReferenceDatumRequest(`reference-maximum-${i}`))))
      const record = f.service.getTrial(f.pid, summary.id)
      expect(record.kind).toBe('reference-datum')
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(C.SURVEY_ADVANCED_TRIAL_LIMITS.recordBytes)
    }
    f.service.close()
    const reopened = f.reopen()
    expect(reopened.listTrials(f.pid).trials).toHaveLength(10)
    const db = f.db()
    const first = db.prepare('SELECT id FROM advanced_trials LIMIT 1').get() as { id: string }; db.close()
    expect(reopened.getTrial(f.pid, first.id).outcome).toBe('calculated')
    expect(reopened.getTrial(f.pid, first.id).outcome).toBe('calculated')
    expect(() => reopened.getTrial(f.pid, first.id)).toThrow('rate-limit')
  })
  it('rejects rehashed reference output tampering while keeping healthy history', async () => {
    const f = await fixture(), first = f.service.createTrial(f.pid, f.raw('reference-datum'))
    const good = f.service.createTrial(f.pid, f.raw('huber', 'huber-stays-readable'))
    const db = f.db()
    try { forge(db, first.id, (_row, record) => {
      if (record.kind !== 'reference-datum' || record.result.outcome !== 'calculated') throw new Error('Expected calculated reference')
      record.result.displacements[2]! += .001
      record.resultHash = digest(record.result)
    }, true) } finally { db.close() }
    expect(() => f.service.getTrial(f.pid, first.id)).toThrow('integrity')
    expect(f.service.listTrials(f.pid)).toMatchObject({ trials: [good], unavailable: [{ id: first.id, reason: 'integrity' }] })
  })
})


describe('static append workspace integration', () => {
  it('preserves distinct base/appended/total counts and keeps legacy 128-row summary limits', async () => {
    const f = await fixture(), req = maximumStaticIncrementalRequest()
    const summary = f.service.createTrial(f.pid, Buffer.from(JSON.stringify(req)))
    expect(summary).toMatchObject({ kind: 'static-incremental', observationCount: 256, baseObservationCount: 128, appendedObservationCount: 128, parameterCount: 16 })
    expect(C.SurveyAdvancedTrialSummaryV1.safeParse({ ...summary, observationCount: 255 }).success).toBe(false)
    expect(C.SurveyAdvancedTrialSummaryV1.safeParse({ ...summary, baseObservationCount: undefined }).success).toBe(false)
    const old = f.service.createTrial(f.pid, f.raw('huber', 'old-huber-test'))
    expect(C.SurveyAdvancedTrialSummaryV1.safeParse({ ...old, observationCount: 129 }).success).toBe(false)
    expect(C.SurveyAdvancedTrialSummaryV1.safeParse({ ...old, baseObservationCount: 2, appendedObservationCount: 1 }).success).toBe(false)
    const record = f.service.getTrial(f.pid, summary.id)
    if (record.kind !== 'static-incremental' || record.result.outcome !== 'calculated') throw new Error('Expected static result')
    expect(record.result.steps).toHaveLength(128)
    expect(record.result.updatedFit.aprioriParameterCovariance[0]![0]).toBeCloseTo(1 / 16, 14)
    expect(record.result.formalResultsModified).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(C.SURVEY_ADVANCED_TRIAL_LIMITS.recordBytes)
  })
  it('loads 10 maximum 256-row records in one rate window and enforces its bounded work charge', async () => {
    const f = await fixture()
    for (let i = 0; i < 10; i++) {
      f.advance(); f.service.createTrial(f.pid, Buffer.from(JSON.stringify(maximumStaticIncrementalRequest(`maximum-static-${i}`))))
    }
    f.advance()
    const page = f.service.listTrials(f.pid)
    expect(page.trials).toHaveLength(10); expect(page.unavailable).toEqual([])
    expect(page.trials.every(t => t.observationCount === 256)).toBe(true)
    // 1 + 10 * (3 + 16) = 191. Two details at 5 + 16 fit; the third does not.
    f.service.getTrial(f.pid, page.trials[0]!.id); f.service.getTrial(f.pid, page.trials[1]!.id)
    expect(() => f.service.getTrial(f.pid, page.trials[2]!.id)).toThrow('rate-limit')
  })
  it('stores a stale declared base fingerprint as an explicit unavailable trial', async () => {
    const f = await fixture(), req = advancedTrialTestRequest('static-incremental')
    const model = JSON.parse(req.declarationJson); model.base.observations[0].value += 1
    req.declarationJson = JSON.stringify(model)
    const summary = f.service.createTrial(f.pid, Buffer.from(JSON.stringify(req)))
    const record = f.service.getTrial(f.pid, summary.id)
    expect(record.result).toMatchObject({ outcome: 'unavailable', code: 'base-fingerprint-mismatch', formalResultsModified: false })
    expect(record.result).not.toHaveProperty('updatedFit')
  })
  it('recomputes coherently rehashed static output and rejects alteration of accepted parameters', async () => {
    const f = await fixture(), summary = f.service.createTrial(f.pid, f.raw('static-incremental')), db = f.db()
    try { forge(db, summary.id, (_row, record) => {
      if (record.kind !== 'static-incremental' || record.result.outcome !== 'calculated') throw new Error('Expected static')
      record.result.updatedFit.parameters[0]! += 1
      record.resultHash = digest(record.result)
    }, true) } finally { db.close() }
    expect(() => f.service.getTrial(f.pid, summary.id)).toThrow('integrity')
  })
})
