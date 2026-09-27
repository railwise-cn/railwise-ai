import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { DeliverableManifestV1 } from '../contracts/engineering.js'
import { SurveyQualityEventV1 } from '../contracts/survey-standard-quality.js'
import {
  SURVEY_QUALITY_WORKSPACE_LIMITS as LIMITS, SurveyQualityPlanCreateV1, SurveyQualityPlanV1,
  SurveyQualityArtifactV1, SurveyQualityEvidenceCreateV1, SurveyQualityEvidenceV1,
  SurveyQualityRecordCreateV1, SurveyQualityRecordV1, SurveyQualityCheckAppendV1,
  SurveyQualityWorkspaceVerificationV1, type SurveyQualityWorkspaceRecordReadV1, type SurveyQualityWorkspaceUnavailableV1
} from '../contracts/survey-quality-workspace.js'
import { appendSurveyQualityEvent, verifySurveyQualityRecord, SURVEY_QUALITY_CHAIN_GENESIS } from './survey-quality-record.js'

type Project = { id: string; revision: number; workspace: string }
type Kind = 'plan' | 'artifact' | 'evidence' | 'record'
type ObjectRow = { kind: Kind; id: string; project_id: string; idempotency_key: string; request_hash: string; record_hash: string; created_at: string; data_json: string }
type EventEnvelope = { recordId: string; projectId: string; evidenceId: string | null; requestHash: string; idempotencyKey: string; event: SurveyQualityEventV1 }
export class SurveyQualityWorkspaceError extends Error {
  constructor(readonly reason: 'not-found' | 'stale' | 'integrity' | 'conflict' | 'limit' | 'invalid-reference') { super(`quality_workspace_${reason}`) }
}
const fail = (reason: SurveyQualityWorkspaceError['reason']): never => { throw new SurveyQualityWorkspaceError(reason) }
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
function contained(root: string, target: string): boolean {
  const child = relative(root, target)
  return child !== '' && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child)
}

/** Local evidence workspace only. No provider, human identity, standards
 * approval, external checkpoint or automatic deliverable approval is implied. */
export class SurveyQualityWorkspaceService {
  private readonly db: Database.Database
  private readonly blobs: string
  constructor(private readonly options: {
    rootDir: string; nowIso?: () => string
    getProject: (projectId: string) => Project | null
    getManifest: (projectId: string, manifestId: string) => DeliverableManifestV1 | null
  }) {
    mkdirSync(resolve(options.rootDir), { recursive: true, mode: 0o700 })
    this.blobs = join(realpathSync(options.rootDir), 'quality-blobs')
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 })
    if (realpathSync(this.blobs) !== this.blobs) fail('integrity')
    this.db = new Database(join(options.rootDir, 'survey-quality.sqlite3'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS quality_objects (
      kind TEXT NOT NULL, id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, record_hash TEXT NOT NULL, created_at TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(project_id,kind,idempotency_key));
      CREATE TABLE IF NOT EXISTS quality_events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, record_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, record_hash TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(record_id,sequence), UNIQUE(project_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS quality_blobs (
      project_id TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(project_id,sha256));
      CREATE TABLE IF NOT EXISTS quality_heads (
      record_id TEXT NOT NULL, event_count INTEGER NOT NULL, head_hash TEXT NOT NULL, record_hash TEXT NOT NULL,
      PRIMARY KEY(record_id,event_count));
      CREATE INDEX IF NOT EXISTS quality_objects_project ON quality_objects(project_id,kind,created_at,id);`)
    for (const table of ['quality_objects', 'quality_events', 'quality_blobs', 'quality_heads']) {
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'quality records are append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'quality records are append-only'); END;`)
      const existing = table === 'quality_objects'
        ? 'id=NEW.id OR (project_id=NEW.project_id AND kind=NEW.kind AND idempotency_key=NEW.idempotency_key)'
        : table === 'quality_events'
          ? 'id=NEW.id OR (record_id=NEW.record_id AND sequence=NEW.sequence) OR (project_id=NEW.project_id AND idempotency_key=NEW.idempotency_key)'
          : table === 'quality_blobs' ? 'project_id=NEW.project_id AND sha256=NEW.sha256' : 'record_id=NEW.record_id AND event_count=NEW.event_count'
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${existing}) BEGIN SELECT RAISE(ABORT,'quality records are append-only'); END;`)
    }
  }
  close(): void { this.db.close() }
  private now(): string { return this.options.nowIso?.() ?? new Date().toISOString() }
  private project(id: string): Project {
    const result = this.options.getProject(id)
    if (!result || result.id !== id) return fail('not-found')
    if (!Number.isInteger(result.revision) || result.revision < 1 || !isAbsolute(result.workspace)) return fail('integrity')
    return { id: result.id, revision: result.revision, workspace: result.workspace }
  }
  private objectHash(row: Omit<ObjectRow, 'record_hash'>): string { return digest(row) }
  private read(kind: Kind, projectId: string, id: string): unknown {
    const row = this.db.prepare('SELECT * FROM quality_objects WHERE kind=? AND project_id=? AND id=?').get(kind, projectId, id) as ObjectRow | undefined
    if (!row) return fail('not-found')
    const { record_hash, ...unsigned } = row
    if (this.objectHash(unsigned) !== record_hash) return fail('integrity')
    const value = JSON.parse(row.data_json) as { id?: string; projectId?: string; createdAt?: string }
    if (value.id !== row.id || value.projectId !== row.project_id || value.createdAt !== row.created_at) return fail('integrity')
    return value
  }
  private save(kind: Kind, projectId: string, key: string, requestHash: string, value: { id: string; projectId: string; createdAt: string }): void {
    const row = { kind, id: value.id, project_id: projectId, idempotency_key: key, request_hash: requestHash, created_at: value.createdAt, data_json: JSON.stringify(value) }
    this.db.prepare('INSERT INTO quality_objects(kind,id,project_id,idempotency_key,request_hash,record_hash,created_at,data_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(kind, value.id, projectId, key, requestHash, this.objectHash(row), value.createdAt, row.data_json)
  }
  private replay(kind: Kind, pid: string, key: string, requestHash: string): string | undefined {
    const row = this.db.prepare('SELECT id,request_hash FROM quality_objects WHERE kind=? AND project_id=? AND idempotency_key=?').get(kind, pid, key) as { id: string; request_hash: string } | undefined
    if (!row) return undefined
    this.read(kind, pid, row.id)
    if (row.request_hash !== requestHash) return fail('conflict')
    return row.id
  }
  private boundCount(kind: Kind, pid: string, maximum: number): void {
    const row = this.db.prepare('SELECT count(*) AS count FROM quality_objects WHERE kind=? AND project_id=?').get(kind, pid) as { count: number }
    if (row.count >= maximum) fail('limit')
  }
  /** Reject symlinks/escape before opening, then compare descriptor and path
   * identity after the bounded read. Freezing repeats all reads before commit. */
  private bytes(path: string, root: string, maximum = LIMITS.fileBytes): Buffer {
    const resolved = resolve(path), realRoot = realpathSync(root)
    if (!contained(realRoot, resolved) || realpathSync(resolved) !== resolved) return fail('integrity')
    // NONBLOCK prevents a concurrently substituted FIFO from blocking before
    // the descriptor's regular-file check can run.
    const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > maximum) return fail('limit')
      const sameFile = (stat: Stats): boolean => stat.isFile() && before.dev === stat.dev && before.ino === stat.ino
        && before.size === stat.size && before.mtimeMs === stat.mtimeMs && before.ctimeMs === stat.ctimeMs
      if (!sameFile(lstatSync(resolved))) return fail('integrity')
      const bounded = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < bounded.length) {
        const count = readSync(fd, bounded, length, bounded.length - length, length)
        if (count === 0) break
        length += count
      }
      const bytes = bounded.subarray(0, length), after = fstatSync(fd)
      if (bytes.length !== before.size || !sameFile(after) || !sameFile(lstatSync(resolved)) || realpathSync(resolved) !== resolved) return fail('integrity')
      return bytes
    } finally { closeSync(fd) }
  }
  private blob(pid: string, expected: string, size: number): Buffer {
    const row = this.db.prepare('SELECT size_bytes FROM quality_blobs WHERE project_id=? AND sha256=?').get(pid, expected) as { size_bytes: number } | undefined
    if (!row || row.size_bytes !== size || !/^[a-f0-9]{64}$/.test(expected)) return fail('integrity')
    const bytes = this.bytes(join(this.blobs, expected), this.blobs)
    if (bytes.length !== size || sha(bytes) !== expected) return fail('integrity')
    return bytes
  }
  private keep(pid: string, bytes: Uint8Array, createdFiles: Set<string>): string {
    if (bytes.byteLength > LIMITS.fileBytes) return fail('limit')
    const hash = sha(bytes)
    const row = this.db.prepare('SELECT size_bytes FROM quality_blobs WHERE project_id=? AND sha256=?').get(pid, hash) as { size_bytes: number } | undefined
    if (row) { this.blob(pid, hash, bytes.byteLength); return hash }
    const total = this.db.prepare('SELECT coalesce(sum(size_bytes),0) AS size FROM quality_blobs WHERE project_id=?').get(pid) as { size: number }
    if (total.size + bytes.byteLength > LIMITS.projectBlobBytes) return fail('limit')
    if (realpathSync(this.blobs) !== this.blobs) return fail('integrity')
    try { writeFileSync(join(this.blobs, hash), bytes, { flag: 'wx', mode: 0o600 }); createdFiles.add(hash) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const existing = this.bytes(join(this.blobs, hash), this.blobs)
    if (sha(existing) !== hash || existing.byteLength !== bytes.byteLength) return fail('integrity')
    this.db.prepare('INSERT INTO quality_blobs(project_id,sha256,size_bytes) VALUES (?,?,?)').run(pid, hash, bytes.byteLength)
    return hash
  }
  private manifest(pid: string, id: string): DeliverableManifestV1 {
    const value = this.options.getManifest(pid, id)
    if (!value) return fail('not-found')
    const parsed = DeliverableManifestV1.parse(value)
    if (parsed.projectId !== pid || parsed.id !== id) return fail('integrity')
    if (!parsed.outputs.length || parsed.outputs.length > LIMITS.outputFiles) return fail('limit')
    return parsed
  }
  private sourceMembers(project: Project, manifest: DeliverableManifestV1): Array<SurveyQualityArtifactV1['members'][number] & { bytes: Buffer }> {
    if ([project.id, manifest.runId].some(value => value === '.' || value === '..' || /[/\\]/.test(value))) return fail('integrity')
    const workspace = realpathSync(project.workspace)
    const deliveryRoot = resolve(workspace, '.workwise', 'deliverables', project.id)
    if (!contained(workspace, deliveryRoot) || realpathSync(deliveryRoot) !== deliveryRoot) return fail('integrity')
    const members: Array<SurveyQualityArtifactV1['members'][number] & { bytes: Buffer }> = []
    const seen = new Set<string>()
    let total = 0
    const read = (id: string, path: string, mediaType: string, expected?: { sha256: string; sizeBytes: number }): void => {
      const absolute = resolve(workspace, path)
      if (!contained(deliveryRoot, absolute) || seen.has(absolute)) return fail('integrity')
      seen.add(absolute)
      const bytes = this.bytes(absolute, deliveryRoot)
      total += bytes.length
      if (total > LIMITS.bundleBytes) return fail('limit')
      const actualHash = sha(bytes)
      if (expected && (expected.sha256 !== actualHash || expected.sizeBytes !== bytes.length)) return fail('stale')
      members.push({ id, path, mediaType, sha256: actualHash, sizeBytes: bytes.length, bytes })
    }
    // Finalization can retain immutable preview-run outputs. Bind every
    // declared member within the same project tree, not only the manifest run.
    read('manifest', relative(workspace, join(deliveryRoot, manifest.runId, 'manifest.json')), 'application/json')
    if (digest(DeliverableManifestV1.parse(JSON.parse(members[0]!.bytes.toString('utf8')))) !== digest(manifest)) return fail('stale')
    manifest.outputs.forEach((output, i) => read(`output-${i + 1}`, output.path, output.mediaType, output))
    return members
  }
  private currentArtifact(pid: string, artifactId: string, cache?: Map<string, SurveyQualityArtifactV1>): SurveyQualityArtifactV1 {
    const prior = cache?.get(artifactId)
    if (prior) return prior
    const artifact = SurveyQualityArtifactV1.parse(this.read('artifact', pid, artifactId))
    const project = this.project(pid), manifest = this.manifest(pid, artifact.manifestId)
    if (digest(manifest) !== artifact.manifestHash) return fail('stale')
    const descriptor = { schemaVersion: 1, projectId: pid, manifestId: artifact.manifestId, manifestHash: artifact.manifestHash, members: artifact.members }
    if (digest(descriptor) !== artifact.bundleHash || sha(canonical(descriptor)) !== artifact.snapshotEvidenceSha256) return fail('integrity')
    this.blob(pid, artifact.snapshotEvidenceSha256, Buffer.byteLength(canonical(descriptor)))
    const source = this.sourceMembers(project, manifest).map(({ bytes: _bytes, ...member }) => member)
    if (digest(source) !== digest(artifact.members)) return fail('stale')
    artifact.members.forEach(member => this.blob(pid, member.sha256, member.sizeBytes))
    cache?.set(artifactId, artifact)
    return artifact
  }
  createPlan(projectId: string, input: unknown) {
    const request = SurveyQualityPlanCreateV1.parse(input), requestHash = digest(request)
    const createdFiles = new Set<string>()
    try { return this.db.transaction(() => {
      const project = this.project(projectId)
      const old = this.replay('plan', projectId, request.idempotencyKey, requestHash)
      if (old) return this.getPlan(projectId, old)
      if (project.revision !== request.expectedProjectRevision) return fail('stale')
      this.boundCount('plan', projectId, LIMITS.plansPerProject)
      const manifest = this.manifest(projectId, request.manifestId), manifestHash = digest(manifest)
      const source = this.sourceMembers(project, manifest)
      if (request.requiredEvidence.some(requirement => !source.some(member => member.id === requirement.memberId))) return fail('invalid-reference')
      const members = source.map(({ bytes, ...member }) => { this.keep(projectId, bytes, createdFiles); return member })
      const descriptor = { schemaVersion: 1, projectId, manifestId: manifest.id, manifestHash, members }
      const bundleHash = digest(descriptor), createdAt = this.now()
      const artifact = SurveyQualityArtifactV1.parse({ ...descriptor, id: `quality_artifact_${randomUUID()}`, bundleHash, snapshotEvidenceSha256: this.keep(projectId, Buffer.from(canonical(descriptor)), createdFiles), createdAt })
      this.save('artifact', projectId, `${request.idempotencyKey}:artifact`, requestHash, artifact)
      const plan = SurveyQualityPlanV1.parse({ schemaVersion: 1, id: `quality_plan_${randomUUID()}`, projectId, projectRevision: project.revision,
        projectBindingHash: digest(project), manifestId: manifest.id, manifestHash, artifactId: artifact.id, artifactHash: bundleHash,
        requiredEvidence: request.requiredEvidence, requiredCheckIds: ['artifact-bytes', ...request.requiredEvidence.map(item => `evidence:${item.id}`)],
        purpose: 'evidence-retention-only', createdAt, standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' })
      this.save('plan', projectId, request.idempotencyKey, requestHash, plan)
      // A second callback + byte pass closes the copy/read window; any change
      // aborts metadata publication; owned unreferenced copies are removed.
      return this.getPlan(projectId, plan.id)
    }).immediate() } catch (error) {
      this.db.transaction(() => {
        for (const hash of createdFiles) {
          if (!this.db.prepare('SELECT 1 FROM quality_blobs WHERE sha256=? LIMIT 1').get(hash)) {
            try { unlinkSync(join(this.blobs, hash)) } catch { /* cleanup must not mask the failed freeze */ }
          }
        }
      }).immediate()
      throw error
    }
  }
  getPlan(projectId: string, planId: string) { return this.readPlan(projectId, planId) }
  private readPlan(projectId: string, planId: string, cache?: Map<string, SurveyQualityArtifactV1>) {
    const project = this.project(projectId), plan = SurveyQualityPlanV1.parse(this.read('plan', projectId, planId))
    if (digest(project) !== plan.projectBindingHash || project.revision !== plan.projectRevision) return fail('stale')
    if (digest(plan.requiredCheckIds) !== digest(['artifact-bytes', ...plan.requiredEvidence.map(item => `evidence:${item.id}`)])) return fail('integrity')
    const artifact = this.currentArtifact(projectId, plan.artifactId, cache)
    if (artifact.bundleHash !== plan.artifactHash || artifact.manifestId !== plan.manifestId || artifact.manifestHash !== plan.manifestHash) return fail('integrity')
    return { plan, artifact }
  }
  private listIds(kind: Kind, pid: string, limit: number, offset: number): string[] {
    this.project(pid)
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.pageSize || !Number.isInteger(offset) || offset < 0 || offset > 10000) return fail('limit')
    return (this.db.prepare('SELECT id FROM quality_objects WHERE kind=? AND project_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(kind, pid, limit + 1, offset) as Array<{ id: string }>).map(item => item.id)
  }
  private history<T>(kind: Kind, pid: string, limit: number, offset: number, read: (id: string) => T) {
    return this.db.transaction(() => {
      const ids = this.listIds(kind, pid, limit, offset), available: T[] = [], unavailable: SurveyQualityWorkspaceUnavailableV1[] = []
      for (const id of ids.slice(0, limit)) {
        try { available.push(read(id)) }
        catch (error) {
          // Never discard stale/corrupt history or expose the corrupted payload.
          // Only IDs selected from this project's SQL index appear in diagnostics.
          unavailable.push({ id, reason: error instanceof SurveyQualityWorkspaceError && error.reason === 'stale' ? 'stale' : 'integrity' })
        }
      }
      return { available, unavailable, nextOffset: ids.length > limit ? offset + limit : null }
    })()
  }
  listPlans(pid: string, limit = 20, offset = 0) {
    const { available: plans, ...page } = this.history('plan', pid, limit, offset, id => this.getPlan(pid, id))
    return { plans, ...page }
  }
  retainEvidence(pid: string, input: unknown): SurveyQualityEvidenceV1 {
    const request = SurveyQualityEvidenceCreateV1.parse(input), requestHash = digest(request)
    return this.db.transaction(() => {
      this.project(pid)
      const old = this.replay('evidence', pid, request.idempotencyKey, requestHash)
      if (old) return this.evidence(pid, old)
      this.boundCount('evidence', pid, LIMITS.evidencePerProject)
      const artifact = this.currentArtifact(pid, request.artifactId), member = artifact.members.find(item => item.id === request.memberId)
      if (!member) return fail('not-found')
      const result = SurveyQualityEvidenceV1.parse({ schemaVersion: 1, id: `quality_evidence_${randomUUID()}`, projectId: pid,
        artifactId: artifact.id, memberId: member.id, sha256: member.sha256, sizeBytes: member.sizeBytes, createdAt: this.now(), semantics: 'retained-bytes-only' })
      this.save('evidence', pid, request.idempotencyKey, requestHash, result)
      return result
    }).immediate()
  }
  private evidence(pid: string, id: string, cache?: Map<string, SurveyQualityArtifactV1>): SurveyQualityEvidenceV1 {
    const result = SurveyQualityEvidenceV1.parse(this.read('evidence', pid, id)), artifact = this.currentArtifact(pid, result.artifactId, cache)
    const member = artifact.members.find(item => item.id === result.memberId)
    if (!member || member.sha256 !== result.sha256 || member.sizeBytes !== result.sizeBytes) return fail('integrity')
    return result
  }
  createRecord(pid: string, input: unknown): SurveyQualityWorkspaceRecordReadV1 {
    const request = SurveyQualityRecordCreateV1.parse(input), requestHash = digest(request)
    return this.db.transaction(() => {
      const { plan } = this.getPlan(pid, request.planId)
      const old = this.replay('record', pid, request.idempotencyKey, requestHash)
      if (old) return this.getRecord(pid, old)
      this.boundCount('record', pid, LIMITS.recordsPerProject)
      const record = SurveyQualityRecordV1.parse({ schemaVersion: 1, id: `quality_record_${randomUUID()}`, projectId: pid,
        planId: plan.id, planHash: digest(plan), artifactId: plan.artifactId, artifactHash: plan.artifactHash, createdAt: this.now() })
      this.save('record', pid, request.idempotencyKey, requestHash, record)
      this.saveHead(record.id, 0, SURVEY_QUALITY_CHAIN_GENESIS)
      return this.getRecord(pid, record.id)
    }).immediate()
  }
  private events(pid: string, record: SurveyQualityRecordV1, plan: SurveyQualityPlanV1, cache: Map<string, SurveyQualityArtifactV1>): EventEnvelope[] {
    const rows = this.db.prepare('SELECT * FROM quality_events WHERE project_id=? AND record_id=? ORDER BY sequence').all(pid, record.id) as Array<{ id: string; project_id: string; record_id: string; sequence: number; idempotency_key: string; request_hash: string; record_hash: string; data_json: string }>
    if (rows.length > LIMITS.eventsPerRecord) return fail('limit')
    const envelopes = rows.map(row => {
      const envelope = JSON.parse(row.data_json) as EventEnvelope
      const event = SurveyQualityEventV1.parse(envelope.event)
      if (digest(envelope) !== row.record_hash || envelope.projectId !== pid || envelope.recordId !== record.id || envelope.requestHash !== row.request_hash || envelope.idempotencyKey !== row.idempotency_key
        || event.id !== row.id || event.sequence !== row.sequence || event.projectId !== pid || event.artifactSha256 !== record.artifactHash
        || event.actor.kind !== 'system' || event.actor.id !== 'survey-quality-workspace' || event.stage !== 'workspace-evidence'
        || !['check', 'artifact-check'].includes(event.event.kind)) return fail('integrity')
      if (event.event.kind !== 'check' && event.event.kind !== 'artifact-check') return fail('integrity')
      if (!plan.requiredCheckIds.includes(event.event.checkId) || event.event.rule || event.event.outcome !== 'passed'
        || event.event.kind === 'artifact-check' && event.event.checkedArtifactSha256 !== record.artifactHash) return fail('integrity')
      if (event.event.checkId === 'artifact-bytes') {
        if (envelope.evidenceId !== null || event.event.evidenceSha256 !== record.artifactHash) return fail('integrity')
      } else {
        if (!envelope.evidenceId) return fail('integrity')
        const evidence = this.evidence(pid, envelope.evidenceId, cache)
        const checkId = event.event.checkId
        const requirement = plan.requiredEvidence.find(item => `evidence:${item.id}` === checkId)
        if (evidence.artifactId !== record.artifactId || evidence.memberId !== requirement?.memberId || evidence.sha256 !== event.event.evidenceSha256) return fail('integrity')
      }
      return { ...envelope, event }
    })
    if (!verifySurveyQualityRecord(envelopes.map(item => item.event)).valid) return fail('integrity')
    const heads = this.db.prepare('SELECT * FROM quality_heads WHERE record_id=? ORDER BY event_count').all(record.id) as Array<{ record_id: string; event_count: number; head_hash: string; record_hash: string }>
    if (heads.length !== envelopes.length + 1) return fail('integrity')
    heads.forEach((head, index) => {
      if (head.event_count !== index || head.head_hash !== (index ? envelopes[index - 1]!.event.thisHash : SURVEY_QUALITY_CHAIN_GENESIS)
        || head.record_hash !== digest({ recordId: record.id, eventCount: index, headHash: head.head_hash })) fail('integrity')
    })
    return envelopes
  }
  private saveHead(recordId: string, eventCount: number, headHash: string): void {
    this.db.prepare('INSERT INTO quality_heads(record_id,event_count,head_hash,record_hash) VALUES (?,?,?,?)')
      .run(recordId, eventCount, headHash, digest({ recordId, eventCount, headHash }))
  }
  getRecord(pid: string, recordId: string): SurveyQualityWorkspaceRecordReadV1 {
    // Events and heads must be read from one SQLite snapshot. Nested callers
    // reuse their write transaction through better-sqlite3's savepoint support.
    return this.db.transaction(() => this.readRecord(pid, recordId))()
  }
  getAssessmentSnapshot(pid: string, planId: string, recordId: string) {
    return this.db.transaction(() => {
      const cache = new Map<string, SurveyQualityArtifactV1>()
      const plan = this.readPlan(pid, planId, cache)
      const record = this.readRecord(pid, recordId, cache)
      if (record.record.planId !== planId) return fail('invalid-reference')
      return { ...plan, ...record }
    })()
  }
  private readRecord(pid: string, recordId: string, cache = new Map<string, SurveyQualityArtifactV1>()): SurveyQualityWorkspaceRecordReadV1 {
    this.project(pid)
    const record = SurveyQualityRecordV1.parse(this.read('record', pid, recordId)), { plan } = this.readPlan(pid, record.planId, cache)
    if (record.planHash !== digest(plan) || record.artifactId !== plan.artifactId || record.artifactHash !== plan.artifactHash) return fail('integrity')
    const events = this.events(pid, record, plan, cache).map(item => item.event)
    const verification = SurveyQualityWorkspaceVerificationV1.parse({ schemaVersion: 1, projectId: pid, recordId, planId: plan.id,
      artifactHash: record.artifactHash, headHash: events.at(-1)?.thisHash ?? SURVEY_QUALITY_CHAIN_GENESIS, checkedAt: this.now(),
      localRecordIntegrity: true, artifactIntegrity: 'verified', checkpointTrust: 'local-records-only', coverageStatus: 'not-evaluated',
      reason: 'independent-checkpoint-unavailable', assessmentBasis: 'recorded-retention-checks-only',
      checks: plan.requiredCheckIds.map(checkId => {
        const item = [...events].reverse().find(event => (event.event.kind === 'check' || event.event.kind === 'artifact-check') && event.event.checkId === checkId)
        return { checkId, status: item ? 'passed' : 'missing', ...(item ? { eventId: item.id } : {}) }
      }), standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' })
    return { record, events, verification }
  }
  listRecords(pid: string, limit = 20, offset = 0) {
    const { available: records, ...page } = this.history('record', pid, limit, offset, id => {
      const value = this.getRecord(pid, id)
      return { record: value.record, verification: value.verification }
    })
    return { records, ...page }
  }
  verifyRecord(pid: string, recordId: string): SurveyQualityWorkspaceVerificationV1 { return this.getRecord(pid, recordId).verification }
  appendCheck(pid: string, recordId: string, input: unknown): SurveyQualityWorkspaceRecordReadV1 {
    const request = SurveyQualityCheckAppendV1.parse(input), requestHash = digest({ recordId, request })
    return this.db.transaction(() => {
      const current = this.getRecord(pid, recordId), { plan } = this.getPlan(pid, current.record.planId)
      const old = this.db.prepare('SELECT record_id,request_hash FROM quality_events WHERE project_id=? AND idempotency_key=?').get(pid, request.idempotencyKey) as { record_id: string; request_hash: string } | undefined
      if (old) {
        if (old.record_id !== recordId || old.request_hash !== requestHash) return fail('conflict')
        return current
      }
      if (current.verification.headHash !== request.expectedHeadHash) return fail('stale')
      if (current.events.length >= LIMITS.eventsPerRecord) return fail('limit')
      if (!plan.requiredCheckIds.includes(request.checkId)) return fail('invalid-reference')
      const isArtifact = request.checkId === 'artifact-bytes'
      if (isArtifact ? request.evidenceId !== undefined : !request.evidenceId) return fail('invalid-reference')
      const evidence = isArtifact ? undefined : this.evidence(pid, request.evidenceId!)
      const requirement = plan.requiredEvidence.find(item => `evidence:${item.id}` === request.checkId)
      if (evidence && (evidence.artifactId !== current.record.artifactId || evidence.memberId !== requirement?.memberId)) return fail('invalid-reference')
      const evidenceHash = evidence?.sha256 ?? current.record.artifactHash
      const hasCheck = current.events.some(item => item.event.kind === 'check' && item.event.checkId === request.checkId)
      const event = appendSurveyQualityEvent(current.events, { schemaVersion: 1, id: `quality_event_${randomUUID()}`, projectId: pid,
        artifactSha256: current.record.artifactHash, occurredAt: this.now(), actor: { id: 'survey-quality-workspace', kind: 'system' }, stage: 'workspace-evidence',
        event: hasCheck ? { kind: 'artifact-check', checkId: request.checkId, checkedArtifactSha256: current.record.artifactHash, outcome: 'passed', evidenceSha256: evidenceHash }
          : { kind: 'check', checkId: request.checkId, outcome: 'passed', evidenceSha256: evidenceHash } }).at(-1)!
      const envelope: EventEnvelope = { recordId, projectId: pid, evidenceId: request.evidenceId ?? null, requestHash, idempotencyKey: request.idempotencyKey, event }
      this.db.prepare('INSERT INTO quality_events(id,project_id,record_id,sequence,idempotency_key,request_hash,record_hash,data_json) VALUES (?,?,?,?,?,?,?,?)')
        .run(event.id, pid, recordId, event.sequence, request.idempotencyKey, requestHash, digest(envelope), JSON.stringify(envelope))
      this.saveHead(recordId, event.sequence, event.thisHash)
      return this.getRecord(pid, recordId)
    }).immediate()
  }
}
