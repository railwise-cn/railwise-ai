import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { SurveyQualityScoringWorkspaceService } from './survey-quality-scoring-workspace.js'
import * as C from '../contracts/survey-quality-scoring-workspace.js'
import { qualityScoringTestRequest } from './survey-quality-scoring-test-helpers.js'
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
  const services: SurveyQualityScoringWorkspaceService[] = []
  const reopen = () => { const s = new SurveyQualityScoringWorkspaceService(options); services.push(s); return s }
  const service = reopen()
  cleanup.push(async () => { services.forEach(s => s.close()); await rm(root, { recursive: true, force: true }) })
  const db = () => new Database(join(root, 'survey-quality-scoring.sqlite3'))
  return { service, reopen, db, root, pid: project.id, setProject: (p: Partial<typeof project>) => { project = { ...project, ...p } },
    advance: (delta = 60_001) => { ms += delta }, raw: (kind: 'unit' | 'accuracy', key?: string) => Buffer.from(JSON.stringify(qualityScoringTestRequest(kind, key))) }
}
function forge(db: Database.Database, id: string, mutate: (row: Record<string, unknown>, record: C.SurveyQualityScoringRecordV1) => void, rehash = false) {
  const row = db.prepare('SELECT * FROM quality_scoring_records WHERE id=?').get(id) as Record<string, unknown>
  const record = JSON.parse(row.data_json as string) as C.SurveyQualityScoringRecordV1
  mutate(row, record)
  if (rehash) {
    const { recordHash: _r, ...unsigned } = record
    record.recordHash = digest(unsigned); row.record_hash = record.recordHash
    row.data_json = JSON.stringify(record)
    const { storage_hash: _s, request_bytes, declaration_bytes, ...metadata } = row
    row.storage_hash = digest({ ...metadata, request_bytes_sha256: sha(request_bytes as Buffer), declaration_bytes_sha256: sha(declaration_bytes as Buffer) })
  }
  db.exec('DROP TRIGGER IF EXISTS quality_scoring_records_no_update')
  const keys = Object.keys(row)
  db.prepare(`UPDATE quality_scoring_records SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => row[k]), id)
}

describe('project-scoped immutable advanced trials', () => {
  it.each(['accuracy', 'unit'] as const)('preserves exact UTF-8 and replays %s across restart with the same id', async kind => {
    const f = await fixture(), raw = Buffer.concat([Buffer.from(' \n'), f.raw(kind), Buffer.from('\r\n')])
    const summary = f.service.createRecord(f.pid, raw)
    expect(summary).toMatchObject({ kind, requestSha256: sha(raw), evidenceAuthenticity: 'not-verified', formalResultsModified: false })
    expect(summary).not.toHaveProperty('result')
    expect(f.service.createRecord(f.pid, raw)).toEqual(summary)
    const record = f.service.getRecord(f.pid, summary.id)
    expect(record.requestJson).toBe(raw.toString())
    expect(record.declarationJson).toBe(qualityScoringTestRequest(kind).declarationJson)
    expect(record.modelBasisStatement).toBe(qualityScoringTestRequest(kind).modelBasisStatement)
    expect(C.SurveyQualityScoringRecordV1.safeParse(record).success).toBe(true)
    const db = f.db()
    try {
      const row = db.prepare('SELECT request_bytes,declaration_bytes FROM quality_scoring_records').get() as { request_bytes: Buffer; declaration_bytes: Buffer }
      expect(row.request_bytes).toEqual(raw)
      expect(row.declaration_bytes).toEqual(Buffer.from(record.declarationJson))
      expect(db.prepare('SELECT count(*) AS count FROM quality_scoring_records').get()).toEqual({ count: 1 })
    } finally { db.close() }
    f.service.close()
    const reopened = f.reopen()
    expect(reopened.getRecord(f.pid, summary.id)).toEqual(record)
    expect(reopened.listRecords(f.pid).records).toEqual([summary])
    expect(reopened.reverifyRecord(f.pid, summary.id)).toMatchObject({ recordIntegrity: 'verified', recomputed: true, recordHash: record.recordHash })
    expect(reopened.createRecord(f.pid, raw)).toEqual(summary)
  })
  it.each(['full', 'child-veto', 'pending', 'multiple-sixty'] as const)('replays the packaged-acceptance declaration unchanged: %s', async name => {
    const f = await fixture(), declarationJson = readFileSync(new URL(`../../../docs/qa/evidence/railwise-quality-scoring-workspace/fixtures/quality-${name}.json`, import.meta.url), 'utf8')
    const kind = name === 'multiple-sixty' ? 'accuracy' : 'unit'
    const request = { ...qualityScoringTestRequest(kind), declarationJson }
    const summary = f.service.createRecord(f.pid, Buffer.from(JSON.stringify(request)))
    const record = f.service.getRecord(f.pid, summary.id)
    expect(record.declarationJson).toBe(declarationJson)
    expect(record.result.result).toMatchObject(name === 'full' ? { state: 'calculated', score: { numerator: '9141', denominator: '100' }, grade: 'excellent' }
      : name === 'child-veto' ? { state: 'nonconforming', score: null, grade: null } : { state: 'unavailable', score: null, grade: null })
    if (name === 'child-veto') expect(record.result.trace.find(item => item.nodeId === 'observation-quality')!.result.rawScore).toEqual({ numerator: '52', denominator: '1' })
    if (name === 'pending') expect(record.result.pendingSubelementIds).toEqual(['completeness'])
    if (name === 'multiple-sixty') expect(record.result.result.reason).toBe('multiple_accuracy_equality_60')
  })
  it('isolates projects, revision and workspace including retries and restored records', async () => {
    const f = await fixture(), raw = f.raw('unit'), created = f.service.createRecord(f.pid, raw)
    expect(() => f.service.getRecord('other', created.id)).toThrow('not-found')
    expect(() => f.service.createRecord('other', raw)).toThrow('not-found')
    expect(() => f.service.listRecords('other')).toThrow('not-found')
    f.setProject({ revision: 2 })
    expect(() => f.service.getRecord(f.pid, created.id)).toThrow('stale')
    expect(() => f.service.createRecord(f.pid, raw)).toThrow('stale')
    expect(f.service.listRecords(f.pid).unavailable).toEqual([{ id: created.id, reason: 'stale' }])
    f.setProject({ revision: 1, workspace: join(f.root, 'different') })
    expect(() => f.reopen().getRecord(f.pid, created.id)).toThrow('stale')
  })
  it('treats same-key different raw request bytes or model basis as conflict', async () => {
    const f = await fixture(), raw = f.raw('unit')
    f.service.createRecord(f.pid, raw)
    expect(() => f.service.createRecord(f.pid, Buffer.concat([Buffer.from(' '), raw]))).toThrow('conflict')
    const req = qualityScoringTestRequest('unit'); req.modelBasisStatement += ' changed'
    expect(() => f.service.createRecord(f.pid, Buffer.from(JSON.stringify(req)))).toThrow('conflict')
    expect(f.service.listRecords(f.pid).records).toHaveLength(1)
  })
  it('serializes distinct instances through SQLite uniqueness and exact idempotency', async () => {
    const f = await fixture(), other = f.reopen(), raw = f.raw('accuracy')
    const first = f.service.createRecord(f.pid, raw)
    expect(other.createRecord(f.pid, raw)).toEqual(first)
    expect(() => other.createRecord(f.pid, Buffer.concat([raw, Buffer.from(' ')]))).toThrow('conflict')
  })
  it('stores raw declaration separately from schema normalization', async () => {
    const f = await fixture(), req = qualityScoringTestRequest('unit')
    const model = JSON.parse(req.declarationJson); model.evidenceRefs[0] = 'literal-source'
    req.declarationJson = JSON.stringify(model)
    const out = f.service.createRecord(f.pid, Buffer.from(JSON.stringify(req)))
    const record = f.service.getRecord(f.pid, out.id)
    expect(record.declarationJson).toContain('literal-source')
    expect(record.declaration.evidenceRefs).toEqual(['literal-source'])
    expect(record.modelHash).toBe(digest(record.declaration))
    expect(record.declarationSha256).toBe(sha(req.declarationJson))
  })
  it.each(['no-ack', 'old-revision', 'wrong-kind', 'unknown-field', 'invalid-model', 'invalid-utf8', 'duplicate-key', 'surrogate', 'nested-duplicate', 'oversized-basis'])('rejects inadmissible creation: %s', async mode => {
    const f = await fixture(), req = qualityScoringTestRequest('unit')
    let raw: Buffer
    if (mode === 'no-ack') Object.assign(req, { acknowledged: false })
    if (mode === 'old-revision') req.expectedProjectRevision = 9
    if (mode === 'wrong-kind') req.declarationJson = req.declarationJson.replace('explicit-profile-leaves', 'declared-overview-only')
    if (mode === 'unknown-field') Object.assign(req, { decision: 'accepted' })
    if (mode === 'invalid-model') req.declarationJson = '{}'
    if (mode === 'surrogate') req.declarationJson = req.declarationJson.replace('synthetic', '\\ud800')
    if (mode === 'nested-duplicate') req.declarationJson = req.declarationJson.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1')
    if (mode === 'oversized-basis') req.modelBasisStatement = '汉'.repeat(C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS.basisBytes)
    raw = Buffer.from(JSON.stringify(req))
    if (mode === 'invalid-utf8') raw = Buffer.from([0xff])
    if (mode === 'duplicate-key') raw = Buffer.from(raw.toString().replace('"acknowledged":true', '"acknowledged":false,"acknowledged":true'))
    expect(() => f.service.createRecord(f.pid, raw)).toThrow()
    expect(f.service.listRecords(f.pid).records).toEqual([])
  })
  it('bounds nesting and escaped-equivalent JSON keys before normalization', () => {
    expect(() => parseAdvancedTrialJson('{"acknowledged":false,"\\u0061cknowledged":true}')).toThrow('Ambiguous')
    expect(() => parseAdvancedTrialJson('['.repeat(33) + '0' + ']'.repeat(33))).toThrow('nesting')
  })
  it('enforces append-only SQL including INSERT OR REPLACE', async () => {
    const f = await fixture(); f.service.createRecord(f.pid, f.raw('unit'))
    const db = f.db()
    try {
      expect(() => db.exec("UPDATE quality_scoring_records SET data_json='{}'")).toThrow('append-only')
      expect(() => db.exec('DELETE FROM quality_scoring_records')).toThrow('append-only')
      expect(() => db.exec('INSERT OR REPLACE INTO quality_scoring_records SELECT * FROM quality_scoring_records')).toThrow('append-only')
    } finally { db.close() }
  })
  it.each(['project_id', 'kind', 'project_revision', 'project_binding_hash', 'idempotency_key', 'request_hash', 'created_at', 'data_json', 'request_bytes', 'declaration_bytes'])('rejects tampered SQL %s and preserves healthy history', async column => {
    const f = await fixture(), bad = f.service.createRecord(f.pid, f.raw('unit')), good = f.service.createRecord(f.pid, f.raw('accuracy', 'healthy-key'))
    const db = f.db()
    try { forge(db, bad.id, row => {
      row[column] = column.endsWith('_bytes') ? Buffer.from('changed') : column === 'project_revision' ? 999 : 'tampered'
    }) } finally { db.close() }
    expect(() => f.service.getRecord(f.pid, bad.id)).toThrow()
    const page = f.service.listRecords(f.pid)
    expect(page.records.map(r => r.id)).toEqual([good.id])
    expect(page.unavailable).toHaveLength(column === 'project_id' ? 0 : 1)
  })
  it.each(['accuracy', 'unit'] as const)('strictly recomputes %s after coherent output+unkeyed hash rewriting', async kind => {
    const f = await fixture(), created = f.service.createRecord(f.pid, f.raw(kind)), db = f.db()
    try { forge(db, created.id, (_row, record) => {
      record.result.result.score = { numerator: '99', denominator: '1' }
      record.resultHash = digest(record.result)
    }, true) } finally { db.close() }
    expect(() => f.service.getRecord(f.pid, created.id)).toThrow('integrity')
    expect(() => f.service.createRecord(f.pid, f.raw(kind))).toThrow('integrity')
  })
  it.each(['kind', 'idempotency_key', 'request_bytes', 'declaration_bytes'])('checks SQL/raw identity even after rehashing storage for %s', async column => {
    const f = await fixture(), created = f.service.createRecord(f.pid, f.raw('unit')), db = f.db()
    try { forge(db, created.id, row => { row[column] = column.endsWith('_bytes') ? Buffer.from('forged') : 'forged' }, true) }
    finally { db.close() }
    expect(() => f.service.getRecord(f.pid, created.id)).toThrow('integrity')
  })
  it('quarantines unsupported replay environment without changing history', async () => {
    const f = await fixture(), created = f.service.createRecord(f.pid, f.raw('unit')), db = f.db()
    try { forge(db, created.id, (_row, record) => { record.replayEnvironment.node = 'future-engine'; record.replayEnvironmentHash = digest(record.replayEnvironment) }, true) }
    finally { db.close() }
    expect(() => f.service.getRecord(f.pid, created.id)).toThrow('replay-environment')
    expect(f.service.listRecords(f.pid).unavailable).toEqual([{ id: created.id, reason: 'replay-environment' }])
  })
  it.each([' ', 'x'.repeat(200)])('keeps healthy rows accessible with a malformed SQL id', async invalid => {
    const f = await fixture(), bad = f.service.createRecord(f.pid, f.raw('unit')), good = f.service.createRecord(f.pid, f.raw('unit', 'healthy-key'))
    const db = f.db()
    try { forge(db, bad.id, row => { row.id = invalid }) } finally { db.close() }
    const page = f.service.listRecords(f.pid)
    expect(page.records).toEqual([good]); expect(page.unavailable[0]!.id).toMatch(/^unavailable-slot-/)
  })
  it('pages unavailable rows without concealing good rows on the next page', async () => {
    const f = await fixture(), first = f.service.createRecord(f.pid, f.raw('unit')); f.advance(1000)
    const second = f.service.createRecord(f.pid, f.raw('accuracy', 'second-key')), db = f.db()
    try { forge(db, second.id, row => { row.data_json = 'not json' }) } finally { db.close() }
    const page = f.service.listRecords(f.pid, 1)
    expect(page.records).toEqual([]); expect(page.nextOffset).toBe(1)
    expect(f.service.listRecords(f.pid, 1, 1)).toEqual({ records: [first], unavailable: [], nextOffset: null })
  })
  it('rejects oversized persisted content before materializing or parsing it', async () => {
    const f = await fixture(), bad = f.service.createRecord(f.pid, f.raw('unit')), good = f.service.createRecord(f.pid, f.raw('unit', 'healthy-key'))
    const db = f.db()
    try { db.exec('DROP TRIGGER quality_scoring_records_no_update'); db.prepare('UPDATE quality_scoring_records SET data_json=? WHERE id=?').run('x'.repeat(C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS.recordBytes + 1), bad.id) }
    finally { db.close() }
    expect(() => f.service.getRecord(f.pid, bad.id)).toThrow('integrity')
    expect(f.service.listRecords(f.pid).records).toEqual([good])
  })
  it('enforces per-project count quota with all unusable history still counted', async () => {
    const f = await fixture(), created = f.service.createRecord(f.pid, f.raw('unit')), db = f.db()
    try {
      for (let i = 1; i < C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS.recordsPerProject; i++) db.prepare(`INSERT INTO quality_scoring_records
        SELECT ?,project_id,kind,project_revision,project_binding_hash,?,request_hash,record_hash,created_at,data_json,request_bytes,declaration_bytes,storage_hash FROM quality_scoring_records WHERE id=?`)
        .run(`quota-row-${i}`, `quota-key-${i}`, created.id)
    } finally { db.close() }
    f.advance()
    expect(() => f.service.createRecord(f.pid, f.raw('unit', 'over-quota-key'))).toThrow('limit')
  })
  it('fits a full maximum-precision-item page within the replay budget', async () => {
    const f = await fixture(), request = qualityScoringTestRequest('accuracy')
    const declaration = JSON.parse(request.declarationJson)
    declaration.model.items = Array.from({ length: 64 }, (_, i) => ({ ...declaration.model.items[0], id: `precision-${i}` }))
    request.declarationJson = JSON.stringify(declaration)
    for (let i = 0; i < 10; i++) {
      f.advance(); request.idempotencyKey = `maximum-cost-${i}`
      expect(f.service.createRecord(f.pid, Buffer.from(JSON.stringify(request))).outcome).toBe('calculated')
    }
    f.advance()
    const page = f.service.listRecords(f.pid, 10)
    expect(page.records).toHaveLength(10); expect(page.unavailable).toEqual([]); expect(page.nextOffset).toBeNull()
  })
  it('enforces persistent write rate and per-process bounded replay work', async () => {
    const f = await fixture()
    for (let i = 0; i < 8; i++) f.service.createRecord(f.pid, f.raw('unit', `rate-key-${i}`))
    expect(() => f.reopen().createRecord(f.pid, f.raw('unit', 'rate-key-9'))).toThrow('rate-limit')
    f.advance()
    f.service.createRecord(f.pid, f.raw('unit', 'rate-key-9'))
    let limited = false
    for (let i = 0; i < 10; i++) { try { f.service.listRecords(f.pid) } catch (error) { expect(String(error)).toContain('rate-limit'); limited = true; break } }
    expect(limited).toBe(true)
  })
})
