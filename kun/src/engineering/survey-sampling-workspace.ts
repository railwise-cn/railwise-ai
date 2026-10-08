import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import * as C from '../contracts/survey-quality-sampling-workspace.js'
import { createQualitySamplingPlan, qualitySamplingPopulationHash } from './survey-quality-sampling.js'

type Project = { id: string; revision: number; workspace: string }
type Kind = 'population' | 'run'
type PopulationRow = { id: string; project_id: string; idempotency_key: string; request_hash: string; record_hash: string; created_at: string; data_json: string; definition_bytes: Buffer }
type RunRow = { id: string; project_id: string; population_id: string; stage: string; idempotency_key: string; request_hash: string; record_hash: string; created_at: string; data_json: string }
const runColumns = 'id,project_id,population_id,stage,idempotency_key,request_hash,record_hash,created_at,data_json'
const allRuns = `(SELECT ${runColumns} FROM sampling_runs UNION ALL SELECT ${runColumns} FROM sampling_reinspection_runs)`
export class SurveySamplingWorkspaceError extends Error {
  constructor(readonly reason: 'not-found' | 'stale' | 'integrity' | 'conflict' | 'limit') { super(`sampling_workspace_${reason}`) }
}
const fail = (reason: SurveySamplingWorkspaceError['reason']): never => { throw new SurveySamplingWorkspaceError(reason) }
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

/** Frozen caller-declared unit products and a locally generated, replayable
 * draw. This does not authenticate population completeness, seed custody,
 * spatial uniformity, professional identity or a quality acceptance decision. */
export class SurveySamplingWorkspaceService {
  private readonly db: Database.Database
  constructor(private readonly options: { rootDir: string; nowIso?: () => string; getProject: (projectId: string) => Project | null }) {
    mkdirSync(resolve(options.rootDir), { recursive: true, mode: 0o700 })
    this.db = new Database(join(options.rootDir, 'survey-sampling.sqlite3'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS sampling_populations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, record_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      data_json TEXT NOT NULL, definition_bytes BLOB NOT NULL,
      UNIQUE(project_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS sampling_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, population_id TEXT NOT NULL, stage TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, record_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(project_id,idempotency_key), UNIQUE(project_id,population_id,stage));
      CREATE INDEX IF NOT EXISTS sampling_populations_project ON sampling_populations(project_id,created_at,id);
      CREATE INDEX IF NOT EXISTS sampling_runs_project ON sampling_runs(project_id,created_at,id);`)
    // Keep first-round rows and their append-only constraints untouched. Later
    // rounds live in a new table; one child per predecessor prevents rerolls.
    this.db.exec(`CREATE TABLE IF NOT EXISTS sampling_reinspection_runs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, population_id TEXT NOT NULL, stage TEXT NOT NULL,
      previous_run_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, record_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(project_id,idempotency_key), UNIQUE(project_id,previous_run_id));
      CREATE INDEX IF NOT EXISTS sampling_reinspection_runs_project ON sampling_reinspection_runs(project_id,created_at,id);`)
    for (const table of ['sampling_populations', 'sampling_runs']) {
      const exists = 'id=NEW.id OR (project_id=NEW.project_id AND idempotency_key=NEW.idempotency_key)'
        + (table === 'sampling_runs' ? ' OR (project_id=NEW.project_id AND population_id=NEW.population_id AND stage=NEW.stage)' : '')
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'sampling records are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'sampling records are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${exists}) BEGIN SELECT RAISE(ABORT,'sampling records are append-only'); END;`)
    }
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS sampling_reinspection_runs_no_update BEFORE UPDATE ON sampling_reinspection_runs BEGIN SELECT RAISE(ABORT,'sampling records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS sampling_reinspection_runs_no_delete BEFORE DELETE ON sampling_reinspection_runs BEGIN SELECT RAISE(ABORT,'sampling records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS sampling_reinspection_runs_no_replace BEFORE INSERT ON sampling_reinspection_runs
      WHEN EXISTS(SELECT 1 FROM sampling_reinspection_runs WHERE id=NEW.id OR (project_id=NEW.project_id AND (idempotency_key=NEW.idempotency_key OR previous_run_id=NEW.previous_run_id)))
        OR EXISTS(SELECT 1 FROM sampling_runs WHERE id=NEW.id OR (project_id=NEW.project_id AND idempotency_key=NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT,'sampling records are append-only'); END;`)
  }
  close(): void { this.db.close() }
  private now(): string { return this.options.nowIso?.() ?? new Date().toISOString() }
  private project(pid: string): Project {
    const value = this.options.getProject(pid)
    if (!value || value.id !== pid) return fail('not-found')
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !isAbsolute(value.workspace)) return fail('integrity')
    return { id: value.id, revision: value.revision, workspace: value.workspace }
  }
  private bodyBound(input: unknown): void {
    const serialized = JSON.stringify(input)
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > C.SURVEY_SAMPLING_WORKSPACE_LIMITS.requestBytes) fail('limit')
  }
  private countBound(kind: Kind, pid: string, maximum: number): void {
    const table = kind === 'population' ? 'sampling_populations' : allRuns
    const row = this.db.prepare(`SELECT count(*) AS count FROM ${table} WHERE project_id=?`).get(pid) as { count: number }
    if (row.count >= maximum) fail('limit')
  }
  private populationRowDigest(row: Omit<PopulationRow, 'record_hash'>): string {
    const { definition_bytes, ...metadata } = row
    return digest({ ...metadata, definition_bytes_sha256: sha(definition_bytes) })
  }
  private readPopulation(pid: string, id: string) {
    const row = this.db.prepare('SELECT * FROM sampling_populations WHERE project_id=? AND id=?').get(pid, id) as PopulationRow | undefined
    if (!row) return fail('not-found')
    const { record_hash, ...unsigned } = row
    if (!Buffer.isBuffer(row.definition_bytes) || this.populationRowDigest(unsigned) !== record_hash) return fail('integrity')
    const population = C.SurveySamplingPopulationRecordV1.parse(JSON.parse(row.data_json))
    if (population.id !== row.id || population.projectId !== row.project_id || population.createdAt !== row.created_at) return fail('integrity')
    const definition = Buffer.from(population.definitionStatement, 'utf8')
    if (!definition.equals(row.definition_bytes) || sha(definition) !== population.definitionEvidenceSha256
      || qualitySamplingPopulationHash(population.orderedUnitProductIds) !== population.populationHash
      || population.unitCount !== population.orderedUnitProductIds.length) return fail('integrity')
    const project = this.project(pid)
    if (project.revision !== population.projectRevision || digest(project) !== population.projectBindingHash) return fail('stale')
    const request = C.SurveySamplingPopulationCreateV1.parse({ expectedProjectRevision: population.projectRevision,
      idempotencyKey: row.idempotency_key, productType: population.productType, unitProductType: population.unitProductType,
      definitionStatement: population.definitionStatement, orderedUnitProductIds: population.orderedUnitProductIds })
    this.bodyBound(request)
    if (digest(request) !== row.request_hash) return fail('integrity')
    return population
  }
  private populationSummary(population: ReturnType<SurveySamplingWorkspaceService['readPopulation']>) {
    const { definitionStatement: _definition, orderedUnitProductIds: _units, ...summary } = population
    return C.SurveySamplingPopulationSummaryV1.parse(summary)
  }
  createPopulation(pid: string, input: unknown) {
    this.bodyBound(input)
    const request = C.SurveySamplingPopulationCreateV1.parse(input), requestHash = digest(request)
    return this.db.transaction(() => {
      const project = this.project(pid)
      const old = this.db.prepare('SELECT id,request_hash FROM sampling_populations WHERE project_id=? AND idempotency_key=?').get(pid, request.idempotencyKey) as { id: string; request_hash: string } | undefined
      if (old) {
        const result = this.getPopulation(pid, old.id)
        if (old.request_hash !== requestHash) return fail('conflict')
        return result
      }
      if (project.revision !== request.expectedProjectRevision) return fail('stale')
      this.countBound('population', pid, C.SURVEY_SAMPLING_WORKSPACE_LIMITS.populationsPerProject)
      const definition = Buffer.from(request.definitionStatement, 'utf8')
      const population = C.SurveySamplingPopulationRecordV1.parse({ schemaVersion: 1, id: `sampling_population_${randomUUID()}`,
        projectId: pid, projectRevision: project.revision, projectBindingHash: digest(project), productType: request.productType,
        unitProductType: request.unitProductType, definitionStatement: request.definitionStatement,
        definitionEvidenceSha256: sha(definition), definitionSizeBytes: definition.length,
        orderedUnitProductIds: request.orderedUnitProductIds, populationHash: qualitySamplingPopulationHash(request.orderedUnitProductIds),
        unitCount: request.orderedUnitProductIds.length, createdAt: this.now(),
        populationCompleteness: 'caller-declared-not-verified', definitionTrust: 'user-declared-not-professionally-verified' })
      const row = { id: population.id, project_id: pid, idempotency_key: request.idempotencyKey, request_hash: requestHash,
        created_at: population.createdAt, data_json: JSON.stringify(population), definition_bytes: definition }
      this.db.prepare('INSERT INTO sampling_populations(id,project_id,idempotency_key,request_hash,record_hash,created_at,data_json,definition_bytes) VALUES (?,?,?,?,?,?,?,?)')
        .run(row.id, pid, row.idempotency_key, requestHash, this.populationRowDigest(row), row.created_at, row.data_json, definition)
      return this.getPopulation(pid, population.id)
    }).immediate()
  }
  getPopulation(pid: string, id: string) {
    return this.db.transaction(() => {
      const population = this.readPopulation(pid, id), { orderedUnitProductIds: _units, ...detail } = population
      return C.SurveySamplingPopulationDetailV1.parse(detail)
    })()
  }
  private page(limit: number, offset: number): void {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) fail('limit')
  }
  private history<T>(kind: Kind, pid: string, limit: number, offset: number, read: (id: string) => T) {
    this.page(limit, offset)
    return this.db.transaction(() => {
      this.project(pid)
      const table = kind === 'population' ? 'sampling_populations' : allRuns
      const rows = this.db.prepare(`SELECT id FROM ${table} WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(pid, limit + 1, offset) as Array<{ id: string }>
      const available: T[] = [], unavailable: Array<{ id: string; reason: 'stale' | 'integrity' }> = []
      for (const { id } of rows.slice(0, limit)) {
        try { available.push(read(id)) }
        catch (error) { unavailable.push({ id, reason: error instanceof SurveySamplingWorkspaceError && error.reason === 'stale' ? 'stale' : 'integrity' }) }
      }
      return { available, unavailable, nextOffset: rows.length > limit ? offset + limit : null }
    })()
  }
  listPopulations(pid: string, limit = 20, offset = 0) {
    const { available: populations, ...page } = this.history('population', pid, limit, offset, id => this.populationSummary(this.readPopulation(pid, id)))
    return C.SurveySamplingPopulationListV1.parse({ populations, ...page })
  }
  listUnits(pid: string, populationId: string, limit = 100, offset = 0) {
    this.page(limit, offset)
    return this.db.transaction(() => {
      const population = this.readPopulation(pid, populationId)
      return C.SurveySamplingUnitPageV1.parse({ projectId: pid, populationId, populationHash: population.populationHash, total: population.unitCount, offset,
        units: population.orderedUnitProductIds.slice(offset, offset + limit).map((unitProductId, index) => ({ index: offset + index, unitProductId })),
        nextOffset: offset + limit < population.unitCount ? offset + limit : null })
    })()
  }
  private runSummary(record: C.SurveySamplingRunRecordV1): C.SurveySamplingRunSummaryV1 {
    const { plan: _plan, ...summary } = record
    return C.SurveySamplingRunSummaryV1.parse(summary)
  }
  private readRun(pid: string, id: string, depth = 0): C.SurveySamplingRunRecordV1 {
    if (depth >= C.SURVEY_SAMPLING_WORKSPACE_LIMITS.roundsPerStage) return fail('integrity')
    const rows = this.db.prepare(`SELECT * FROM ${allRuns} WHERE project_id=? AND id=?`).all(pid, id) as RunRow[]
    if (rows.length > 1) return fail('integrity')
    const row = rows[0]
    if (!row) return fail('not-found')
    const { record_hash, ...unsigned } = row
    if (digest(unsigned) !== record_hash) return fail('integrity')
    const record = C.SurveySamplingRunRecordV1.parse(JSON.parse(row.data_json))
    if (record.id !== row.id || record.projectId !== row.project_id || record.populationId !== row.population_id
      || record.stage !== row.stage || record.createdAt !== row.created_at) return fail('integrity')
    const population = this.readPopulation(pid, record.populationId)
    if (record.reinspection) {
      const previous = this.readRun(pid, record.reinspection.previousRunId, depth + 1)
      if (previous.populationId !== record.populationId || previous.populationHash !== record.populationHash
        || previous.stage !== record.stage || previous.inspectionMode !== record.inspectionMode || previous.round + 1 !== record.round
        || previous.planHash !== record.reinspection.previousPlanHash || previous.runHash !== record.reinspection.previousRunHash) return fail('integrity')
      const stored = this.db.prepare('SELECT previous_run_id FROM sampling_reinspection_runs WHERE project_id=? AND id=?').get(pid, id) as { previous_run_id: string } | undefined
      if (stored?.previous_run_id !== previous.id) return fail('integrity')
    }
    const expectedRequest = {
      schemaVersion: 1, projectId: pid, populationId: population.id, productType: population.productType,
      unitProductType: population.unitProductType, definitionEvidenceSha256: population.definitionEvidenceSha256,
      orderedUnitProductIds: population.orderedUnitProductIds, populationHash: population.populationHash,
      stage: record.stage, inspectionMode: record.inspectionMode, round: record.round,
      ...(record.reinspection ? { previousPlanHash: record.reinspection.previousPlanHash } : {}),
      ...(record.plan.request.randomSource ? { randomSource: record.plan.request.randomSource } : {})
    }
    if (digest(expectedRequest) !== digest(record.plan.request) || record.projectRevision !== population.projectRevision
      || record.projectBindingHash !== population.projectBindingHash) return fail('integrity')
    const random = record.plan.request.randomSource
    if (random && (random.sourceDescription !== 'Runtime crypto.randomBytes(32); local seed without an independent witness'
      || random.receiptSha256 !== sha(Buffer.from(random.seedHex, 'hex')) || random.trust !== 'caller-declared-not-authenticated')) return fail('integrity')
    // Always recompute the complete draw, including ordered batches, selected
    // IDs, random transcript and all pure-plan/source metadata. No saved status
    // or summary is accepted as proof of a previously successful computation.
    const recomputed = createQualitySamplingPlan(expectedRequest)
    if (canonical(recomputed) !== canonical(record.plan)) return fail('integrity')
    const { runHash, ...summary } = this.runSummary(record)
    if (runHash !== digest(summary)) return fail('integrity')
    const apiRequest = C.SurveySamplingRunCreateV1.parse({ populationId: record.populationId, idempotencyKey: row.idempotency_key,
      stage: record.stage, inspectionMode: record.inspectionMode,
      ...(record.reinspection ? { reinspection: { previousRunId: record.reinspection.previousRunId,
        expectedPreviousPlanHash: record.reinspection.previousPlanHash, reason: record.reinspection.reason } } : {}) })
    if (digest(apiRequest) !== row.request_hash) return fail('integrity')
    return record
  }
  createRun(pid: string, input: unknown): C.SurveySamplingRunSummaryV1 {
    this.bodyBound(input)
    const request = C.SurveySamplingRunCreateV1.parse(input), requestHash = digest(request)
    return this.db.transaction(() => {
      const population = this.readPopulation(pid, request.populationId)
      const old = this.db.prepare(`SELECT id,request_hash FROM ${allRuns} WHERE project_id=? AND idempotency_key=?`).get(pid, request.idempotencyKey) as { id: string; request_hash: string } | undefined
      if (old) {
        const result = this.runSummary(this.readRun(pid, old.id))
        if (old.request_hash !== requestHash) return fail('conflict')
        return result
      }
      const previous = request.reinspection ? this.readRun(pid, request.reinspection.previousRunId) : undefined
      if (previous) {
        if (previous.populationId !== population.id || previous.populationHash !== population.populationHash || previous.stage !== request.stage
          || previous.inspectionMode !== request.inspectionMode) return fail('conflict')
        if (previous.planHash !== request.reinspection!.expectedPreviousPlanHash) return fail('stale')
        if (previous.round >= C.SURVEY_SAMPLING_WORKSPACE_LIMITS.roundsPerStage) return fail('limit')
        if (this.db.prepare('SELECT id FROM sampling_reinspection_runs WHERE project_id=? AND previous_run_id=?').get(pid, previous.id)) return fail('conflict')
      } else if (this.db.prepare('SELECT id FROM sampling_runs WHERE project_id=? AND population_id=? AND stage=?').get(pid, population.id, request.stage)) return fail('conflict')
      this.countBound('run', pid, C.SURVEY_SAMPLING_WORKSPACE_LIMITS.runsPerProject)
      const seed = request.inspectionMode === 'census' ? undefined : randomBytes(32)
      const plan = createQualitySamplingPlan({ schemaVersion: 1, projectId: pid, populationId: population.id,
        productType: population.productType, unitProductType: population.unitProductType,
        definitionEvidenceSha256: population.definitionEvidenceSha256, orderedUnitProductIds: population.orderedUnitProductIds,
        populationHash: population.populationHash, stage: request.stage, inspectionMode: request.inspectionMode, round: previous ? previous.round + 1 : 1,
        ...(previous ? { previousPlanHash: previous.planHash } : {}),
        ...(seed ? { randomSource: { seedHex: seed.toString('hex'),
          sourceDescription: 'Runtime crypto.randomBytes(32); local seed without an independent witness', receiptSha256: sha(seed), trust: 'caller-declared-not-authenticated' } } : {}) })
      const summary = { schemaVersion: 1, id: `sampling_run_${randomUUID()}`, projectId: pid,
        projectRevision: population.projectRevision, projectBindingHash: population.projectBindingHash,
        populationId: population.id, populationHash: population.populationHash, definitionEvidenceSha256: population.definitionEvidenceSha256,
        unitCount: population.unitCount, stage: request.stage, inspectionMode: request.inspectionMode, round: previous ? previous.round + 1 : 1,
        ...(previous ? { reinspection: { previousRunId: previous.id, previousPlanHash: previous.planHash, previousRunHash: previous.runHash,
          reason: request.reinspection!.reason, previousRoundVerification: 'stored-plan-recomputed' } } : {}),
        algorithmVersion: plan.algorithmVersion, source: plan.source, requestHash: plan.requestHash, planHash: plan.planHash,
        sampleSize: plan.sampleSize, batchCount: plan.batches.length,
        batches: plan.batches.map(({ batchIndex, batchSize, nominalTableSampleSize, sampleSize, census }) => ({ batchIndex, batchSize, nominalTableSampleSize, sampleSize, census })),
        randomSource: seed ? 'runtime-generated-local-unwitnessed' : 'not-applicable', createdAt: this.now(),
        decision: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated',
        populationCompleteness: 'caller-declared-not-verified', spatialUniformity: 'not-evaluated' }
      const record = C.SurveySamplingRunRecordV1.parse({ ...summary, runHash: digest(summary), plan })
      const row = { id: record.id, project_id: pid, population_id: population.id, stage: request.stage,
        idempotency_key: request.idempotencyKey, request_hash: requestHash, created_at: record.createdAt, data_json: JSON.stringify(record) }
      if (previous) this.db.prepare('INSERT INTO sampling_reinspection_runs(id,project_id,population_id,stage,idempotency_key,request_hash,record_hash,created_at,data_json,previous_run_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(row.id, pid, row.population_id, row.stage, row.idempotency_key, requestHash, digest(row), row.created_at, row.data_json, previous.id)
      else this.db.prepare('INSERT INTO sampling_runs(id,project_id,population_id,stage,idempotency_key,request_hash,record_hash,created_at,data_json) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(row.id, pid, row.population_id, row.stage, row.idempotency_key, requestHash, digest(row), row.created_at, row.data_json)
      return this.runSummary(this.readRun(pid, record.id))
    }).immediate()
  }
  getRun(pid: string, id: string): C.SurveySamplingRunSummaryV1 {
    return this.db.transaction(() => this.runSummary(this.readRun(pid, id)))()
  }
  listRuns(pid: string, limit = 20, offset = 0) {
    const { available: runs, ...page } = this.history('run', pid, limit, offset, id => this.runSummary(this.readRun(pid, id)))
    return C.SurveySamplingRunListV1.parse({ runs, ...page })
  }
  listSamples(pid: string, runId: string, limit = 100, offset = 0) {
    this.page(limit, offset)
    return this.db.transaction(() => {
      const record = this.readRun(pid, runId)
      const selected = record.plan.batches.flatMap(batch => batch.selectedUnitProductIds.map(unitProductId => ({ batchIndex: batch.batchIndex, unitProductId })))
      return C.SurveySamplingSamplePageV1.parse({ projectId: pid, runId, planHash: record.planHash, total: record.sampleSize, offset,
        samples: selected.slice(offset, offset + limit).map((sample, index) => ({ index: offset + index, ...sample })),
        nextOffset: offset + limit < selected.length ? offset + limit : null })
    })()
  }
  verifyRun(pid: string, id: string): C.SurveySamplingVerificationV1 {
    return this.db.transaction(() => {
      const record = this.readRun(pid, id)
      return C.SurveySamplingVerificationV1.parse({ schemaVersion: 1, projectId: pid, populationId: record.populationId,
        runId: id, planHash: record.planHash, runHash: record.runHash, checkedAt: this.now(), recordIntegrity: 'verified', recomputed: true,
        checkpointTrust: 'local-records-only', decision: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated',
        populationCompleteness: 'caller-declared-not-verified', spatialUniformity: 'not-evaluated' })
    })()
  }
}
