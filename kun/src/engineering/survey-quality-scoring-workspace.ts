import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import * as C from '../contracts/survey-quality-scoring-workspace.js'
import { SurveyQualityScoringInputV1 } from '../contracts/survey-quality-scoring.js'
import { scoreSurveyQualityV1 } from './survey-quality-scoring.js'
import { parseAdvancedTrialJson } from './survey-advanced-trials-json.js'

const L = C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS
type Project = { id: string; revision: number; workspace: string }
type Row = { id: string; project_id: string; kind: string; project_revision: number; project_binding_hash: string;
  idempotency_key: string; request_hash: string; record_hash: string; created_at: string; data_json: string;
  request_bytes: Buffer; declaration_bytes: Buffer; storage_hash: string }
export class SurveyQualityScoringError extends Error {
  constructor(readonly reason: 'validation' | 'not-found' | 'stale' | 'integrity' | 'conflict' | 'limit' | 'rate-limit' | 'replay-environment') { super(`quality_scoring_${reason}`) }
}
const fail = (reason: SurveyQualityScoringError['reason']): never => { throw new SurveyQualityScoringError(reason) }
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  return fail('integrity')
}
const digest = (value: unknown): string => sha(canonical(value))
const environment = () => C.SurveyQualityScoringReplayEnvironmentV1.parse({ node: process.versions.node, v8: process.versions.v8,
  platform: process.platform, arch: process.arch, bun: process.versions.bun ?? null })
const boundaries = { status: 'declared-inspection-trial-only', evidenceAuthenticity: 'not-verified', classificationAuthenticity: 'not-verified', priorQualificationAuthenticity: 'not-verified', engineeringDecision: 'not-evaluated',
  formalResultsModified: false, declarationTrust: 'caller-declared-not-authenticated', checkpointTrust: 'local-records-only' } as const

/** Independent append-only declared-inspection scoring, with no SurveyService write
 * dependency. Hashes/replay detect local inconsistencies, not external custody. */
export class SurveyQualityScoringWorkspaceService {
  private readonly db: Database.Database
  private readonly rates = new Map<string, { since: number; units: number }>()
  private closed = false
  constructor(private readonly options: { rootDir: string; nowIso?: () => string; clockMs?: () => number; getProject: (projectId: string) => Project | null }) {
    mkdirSync(resolve(options.rootDir), { recursive: true, mode: 0o700 })
    this.db = new Database(join(options.rootDir, 'survey-quality-scoring.sqlite3'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS quality_scoring_records (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      project_revision INTEGER NOT NULL, project_binding_hash TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, record_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, data_json TEXT NOT NULL, request_bytes BLOB NOT NULL,
      declaration_bytes BLOB NOT NULL, storage_hash TEXT NOT NULL, UNIQUE(project_id,idempotency_key));
      CREATE INDEX IF NOT EXISTS quality_scoring_records_project ON quality_scoring_records(project_id,created_at,id);
      CREATE TRIGGER IF NOT EXISTS quality_scoring_records_no_update BEFORE UPDATE ON quality_scoring_records BEGIN SELECT RAISE(ABORT,'quality scoring records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS quality_scoring_records_no_delete BEFORE DELETE ON quality_scoring_records BEGIN SELECT RAISE(ABORT,'quality scoring records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS quality_scoring_records_no_replace BEFORE INSERT ON quality_scoring_records
        WHEN EXISTS(SELECT 1 FROM quality_scoring_records WHERE id=NEW.id OR (project_id=NEW.project_id AND idempotency_key=NEW.idempotency_key))
        BEGIN SELECT RAISE(ABORT,'quality scoring records are append-only'); END;`)
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; this.rates.clear() } }
  private now(): string { return this.options.nowIso?.() ?? new Date().toISOString() }
  private project(pid: string): Project {
    const p = this.options.getProject(pid)
    if (!p || p.id !== pid) return fail('not-found')
    if (!Number.isSafeInteger(p.revision) || p.revision < 1 || !isAbsolute(p.workspace)) return fail('integrity')
    return { id: p.id, revision: p.revision, workspace: p.workspace }
  }
  private charge(pid: string, units: number): void {
    const now = this.options.clockMs?.() ?? Date.now()
    for (const [key, value] of this.rates) if (now - value.since >= 60_000 || now < value.since) this.rates.delete(key)
    const entry = this.rates.get(pid) ?? { since: now, units: 0 }
    if (entry.units + units > L.workUnitsPerMinute || !this.rates.has(pid) && this.rates.size >= 512) fail('rate-limit')
    entry.units += units
    this.rates.set(pid, entry)
  }
  private chargeModel(pid: string, model: C.SurveyQualityScoringRecordV1['declaration']): void {
    const units = model.operation === 'accuracy' ? model.model.items.length
      : model.operation === 'unit' ? model.leaves.reduce((total, leaf) => total + (leaf.state === 'checked' && leaf.record.kind === 'accuracy' ? leaf.record.model.items.length : 1), 0)
        : model.operation === 'sample' ? model.declaredUnitIds.length : 1
    this.charge(pid, Math.max(1, Math.ceil(units / 8)))
  }
  private decode(raw: Uint8Array): string {
    if (raw.byteLength > L.requestBytes) return fail('limit')
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
      if (!Buffer.from(text, 'utf8').equals(raw)) return fail('validation')
      return text
    } catch { return fail('validation') }
  }
  private parseRequest(raw: Uint8Array) {
    const requestJson = this.decode(raw)
    try {
      const request = C.SurveyQualityScoringCreateV1.parse(parseAdvancedTrialJson(requestJson))
      const declared = parseAdvancedTrialJson(request.declarationJson)
      const declaration = SurveyQualityScoringInputV1.parse(declared)
      if (declaration.operation !== request.kind) return fail('validation')
      return { request, declaration, requestJson }
    } catch { return fail('validation') }
  }
  private storageHash(row: Omit<Row, 'storage_hash'>): string {
    const { request_bytes, declaration_bytes, ...metadata } = row
    return digest({ ...metadata, request_bytes_sha256: sha(request_bytes), declaration_bytes_sha256: sha(declaration_bytes) })
  }
  private summary(record: C.SurveyQualityScoringRecordV1): C.SurveyQualityScoringSummaryV1 {
    const { requestJson: _r, declarationJson: _d, declaration: _model, result: _result, projectSnapshot: _p,
      modelBasisStatement: _b, replayEnvironment: _env, ...summary } = record
    return C.SurveyQualityScoringSummaryV1.parse(summary)
  }
  private read(pid: string, id: string): C.SurveyQualityScoringRecordV1 {
    // Bound BLOB/TEXT materialization even when a record was corrupted outside this API.
    const row = this.db.prepare(`SELECT id,project_id,kind,project_revision,project_binding_hash,idempotency_key,request_hash,record_hash,created_at,storage_hash,
      CASE WHEN length(CAST(data_json AS BLOB))<=? THEN data_json END AS data_json,
      CASE WHEN length(request_bytes)<=? THEN request_bytes END AS request_bytes,
      CASE WHEN length(declaration_bytes)<=? THEN declaration_bytes END AS declaration_bytes
      FROM quality_scoring_records WHERE project_id=? AND id=?`).get(L.recordBytes, L.requestBytes, L.declarationBytes, pid, id) as Row | undefined
    if (!row) return fail('not-found')
    try {
      if (!Buffer.isBuffer(row.request_bytes) || !Buffer.isBuffer(row.declaration_bytes) || typeof row.data_json !== 'string') return fail('integrity')
      const { storage_hash, ...unsignedRow } = row
      if (this.storageHash(unsignedRow) !== storage_hash) return fail('integrity')
      const record = C.SurveyQualityScoringRecordV1.parse(parseAdvancedTrialJson(row.data_json))
      const { recordHash, ...unsigned } = record
      if (digest(unsigned) !== recordHash || recordHash !== row.record_hash || record.id !== row.id || record.projectId !== row.project_id
        || record.kind !== row.kind || record.projectRevision !== row.project_revision || record.projectBindingHash !== row.project_binding_hash
        || record.idempotencyKey !== row.idempotency_key || record.requestSha256 !== row.request_hash || record.createdAt !== row.created_at) return fail('integrity')
      const parsed = this.parseRequest(row.request_bytes)
      if (record.requestJson !== parsed.requestJson || sha(row.request_bytes) !== record.requestSha256
        || parsed.declaration.operation !== record.kind || parsed.request.expectedProjectRevision !== record.projectRevision
        || parsed.request.idempotencyKey !== record.idempotencyKey || parsed.request.acknowledged !== record.acknowledged
        || parsed.request.declarationJson !== record.declarationJson || parsed.request.modelBasisStatement !== record.modelBasisStatement
        || !Buffer.from(record.declarationJson).equals(row.declaration_bytes) || sha(row.declaration_bytes) !== record.declarationSha256
        || sha(record.modelBasisStatement) !== record.modelBasisSha256 || digest(parsed.declaration) !== record.modelHash
        || canonical(parsed.declaration) !== canonical(record.declaration) || digest(record.result) !== record.resultHash
        || digest(record.projectSnapshot) !== record.projectBindingHash || digest(record.replayEnvironment) !== record.replayEnvironmentHash) return fail('integrity')
      const project = this.project(pid)
      if (digest(project) !== record.projectBindingHash) return fail('stale')
      if (digest(environment()) !== record.replayEnvironmentHash) return fail('replay-environment')
      this.chargeModel(pid, parsed.declaration)
      const recomputed = scoreSurveyQualityV1(parsed.declaration)
      if (canonical(recomputed) !== canonical(record.result)) return fail('integrity')
      return record
    } catch (error) {
      if (error instanceof SurveyQualityScoringError && ['stale', 'replay-environment', 'not-found', 'rate-limit'].includes(error.reason)) throw error
      return fail('integrity')
    }
  }
  createRecord(pid: string, raw: Uint8Array): C.SurveyQualityScoringSummaryV1 {
    const { request, declaration, requestJson } = this.parseRequest(raw)
    return this.db.transaction(() => {
      const project = this.project(pid)
      this.charge(pid, 10)
      const old = this.db.prepare('SELECT id,request_hash FROM quality_scoring_records WHERE project_id=? AND idempotency_key=?').get(pid, request.idempotencyKey) as { id: string; request_hash: string } | undefined
      if (old) {
        const record = this.read(pid, old.id)
        if (old.request_hash !== sha(raw) || record.requestJson !== requestJson) return fail('conflict')
        return this.summary(record)
      }
      if (project.revision !== request.expectedProjectRevision) return fail('stale')
      const usage = this.db.prepare(`SELECT count(*) AS count,coalesce(sum(length(CAST(data_json AS BLOB))+length(request_bytes)+length(declaration_bytes)),0) AS bytes
        FROM quality_scoring_records WHERE project_id=?`).get(pid) as { count: number; bytes: number }
      if (usage.count >= L.recordsPerProject) return fail('limit')
      const now = this.now(), minuteAgo = new Date(Date.parse(now) - 60_000).toISOString()
      const recent = this.db.prepare('SELECT count(*) AS count FROM quality_scoring_records WHERE project_id=? AND created_at>=?').get(pid, minuteAgo) as { count: number }
      if (recent.count >= 8) return fail('rate-limit')
      this.chargeModel(pid, declaration)
      const result = scoreSurveyQualityV1(declaration)
      const replayEnvironment = environment()
      const unsigned = { schemaVersion: 1, id: `quality_scoring_${randomUUID()}`, projectId: pid, projectRevision: project.revision,
        projectBindingHash: digest(project), kind: declaration.operation, acknowledged: true, idempotencyKey: request.idempotencyKey,
        algorithmVersion: 'gbt24356-declared-exact-quality-scoring-1',
        createdAt: now, requestSha256: sha(raw), declarationSha256: sha(request.declarationJson), modelHash: digest(declaration), resultHash: digest(result),
        requestSizeBytes: raw.byteLength, declarationSizeBytes: Buffer.byteLength(request.declarationJson), modelNormalization: 'schema-normalized',
        modelBasisStatement: request.modelBasisStatement, modelBasisSha256: sha(request.modelBasisStatement), modelBasisSizeBytes: Buffer.byteLength(request.modelBasisStatement),
        replayEnvironment, replayEnvironmentHash: digest(replayEnvironment),
        outcome: result.result.state, scopeAssessment: result.scopeAssessment, ...boundaries,
        requestJson, declarationJson: request.declarationJson, projectSnapshot: project, declaration, result }
      const record = C.SurveyQualityScoringRecordV1.parse({ ...unsigned, recordHash: digest(unsigned) })
      const serialized = JSON.stringify(record)
      if (Buffer.byteLength(serialized) > L.recordBytes || usage.bytes + Buffer.byteLength(serialized) + raw.byteLength + record.declarationSizeBytes > L.storedBytesPerProject) return fail('limit')
      // Refresh binding before the append; a changed project never receives a new usable trial.
      if (digest(this.project(pid)) !== record.projectBindingHash) return fail('stale')
      const row = { id: record.id, project_id: pid, kind: record.kind, project_revision: project.revision, project_binding_hash: record.projectBindingHash,
        idempotency_key: request.idempotencyKey, request_hash: record.requestSha256, record_hash: record.recordHash, created_at: now,
        data_json: serialized, request_bytes: Buffer.from(raw), declaration_bytes: Buffer.from(record.declarationJson) }
      this.db.prepare(`INSERT INTO quality_scoring_records(id,project_id,kind,project_revision,project_binding_hash,idempotency_key,request_hash,record_hash,created_at,data_json,request_bytes,declaration_bytes,storage_hash)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, pid, row.kind, row.project_revision, row.project_binding_hash, row.idempotency_key, row.request_hash, row.record_hash,
        now, serialized, row.request_bytes, row.declaration_bytes, this.storageHash(row))
      return this.summary(this.read(pid, record.id))
    }).immediate()
  }
  getRecord(pid: string, id: string): C.SurveyQualityScoringRecordV1 {
    this.project(pid); this.charge(pid, 5)
    return this.db.transaction(() => this.read(pid, id))()
  }
  listRecords(pid: string, limit = 10, offset = 0): C.SurveyQualityScoringListV1 {
    if (!Number.isInteger(limit) || limit < 1 || limit > L.pageSize || !Number.isInteger(offset) || offset < 0 || offset > L.recordsPerProject) return fail('validation')
    this.project(pid); this.charge(pid, 1)
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT CASE WHEN length(id)<=160 THEN id END AS id, CAST(rowid AS TEXT) AS slot
        FROM quality_scoring_records WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(pid, limit + 1, offset) as Array<{ id: string | null; slot: string }>
      const records: C.SurveyQualityScoringSummaryV1[] = [], unavailable: C.SurveyQualityScoringListV1['unavailable'] = []
      for (const row of rows.slice(0, limit)) {
        this.charge(pid, 3)
        if (typeof row.id !== 'string' || !/^quality_scoring_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id) || row.id.trim() !== row.id || new TextDecoder().decode(new TextEncoder().encode(row.id)) !== row.id) {
          unavailable.push({ id: `unavailable-slot-${row.slot}`, reason: 'integrity' })
          continue
        }
        try { records.push(this.summary(this.read(pid, row.id))) }
        catch (error) {
          if (error instanceof SurveyQualityScoringError && error.reason === 'rate-limit') throw error
          unavailable.push({ id: row.id, reason: error instanceof SurveyQualityScoringError && (error.reason === 'stale' || error.reason === 'replay-environment') ? error.reason : 'integrity' }) }
      }
      return C.SurveyQualityScoringListV1.parse({ records, unavailable, nextOffset: rows.length > limit ? offset + limit : null })
    })()
  }
  reverifyRecord(pid: string, id: string): C.SurveyQualityScoringVerificationV1 {
    const record = this.getRecord(pid, id)
    return C.SurveyQualityScoringVerificationV1.parse({ schemaVersion: 1, projectId: pid, recordId: id, kind: record.kind,
      requestSha256: record.requestSha256, declarationSha256: record.declarationSha256, modelHash: record.modelHash,
      resultHash: record.resultHash, recordHash: record.recordHash, checkedAt: this.now(), recordIntegrity: 'verified', recomputed: true, ...boundaries })
  }
}
