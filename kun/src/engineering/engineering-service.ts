import { createHash, randomUUID } from 'node:crypto'
import { RUNTIME_VERSION } from '../runtime-version.js'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { atomicWriteFile, drainAtomicWrites } from '../adapters/file/atomic-write.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import type { SurveySourceEligibility } from './survey-service.js'
import { makeReportPdf, makeProfessionalReportPdf } from './engineering-report-pdf.js'
import { buildProfessionalReportModel, makeProfessionalDocx, makeProfessionalXlsx } from './survey-professional-report.js'
import { buildSurveyProfessionalReview } from './survey-professional-review.js'
import { SurveyProfessionalReviewV1 } from '../contracts/survey-professional.js'
import { SurveySegmentComparisonV1, SurveySegmentContinuityV1 } from '../contracts/survey-monitoring.js'
import { statisticalEvidenceSheets, statisticalReportLines } from './survey-statistical-semantics.js'
import { monitoringTrendInstant, renderMonitoringTrendChart } from './engineering-trend-chart.js'
import { EngineeringVerificationAudit, EngineeringVerificationAuditError } from './engineering-verification-audit.js'
import { calculateMonitoringAnalysisV2 } from './monitoring-analysis.js'
import { buildMonitoringProfessionalReport } from './engineering-monitoring-report.js'
import { MonitoringReplayAudit } from './monitoring-replay-audit.js'
import {
  AnalysisRequest, ChartArtifactV1, ChartRequest, DatasetImportRequest, DatasetValidateRequest, ENGINEERING_TREND_RENDERER_VERSION, ENGINEERING_ANALYSIS_ALGORITHM_VERSION,
  DeliverableManifestV1, DeliverableVerificationV1, EngineeringProjectCreateRequest, EngineeringProjectUpdateRequest, AcceptQualityFindingRequest, FieldMappingV1, FinalizeDeliverableRequest,
  KnowledgeCitationV1, MonitoringAnalysisV1, MonitoringDatasetV1, MonitoringObservationV1, MonitoringReplayVerificationV1,
  QualityFindingV1, RailwiseProjectV1, inferEngineeringTaskType, ReportPreviewRequest, RunMutationRequest, SurveySourceEvidenceV1
} from '../contracts/engineering.js'
import { AdjustmentResultV1, DeformationComparisonV1, type AdjustmentRunV1, type SurveyNetworkV1, type SurveyObservationV1, type SurveyPointV1, type SurveySourceFileV1 } from '../contracts/survey.js'

type Row = Record<string, string>
type StoredDataset = MonitoringDatasetV1 & { observations: MonitoringObservationV1[]; findings: QualityFindingV1[] }
type StoredRun = { id: string; projectId: string; datasetId?: string; analysisId?: string; /** Canonical project/dataset/analysis snapshot bound when report bytes were published. */ deliveryInputHash?: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'; revision: number; idempotencyKey: string; createdAt: string; updatedAt: string; error?: string }
type SurveyAdjustmentLookup = (projectId: string, ids: string[]) => AdjustmentResultV1[]
/**
 * The report-facing adjustment lookup intentionally returns only numerical
 * results.  Deformation evidence needs the live run binding as well: a
 * persisted epoch cannot establish its project ownership from a result alone.
 */
type SurveyAdjustmentEvidence = {
  run: Pick<AdjustmentRunV1, 'id' | 'projectId' | 'networkId' | 'inputHash' | 'status'>
  result: AdjustmentResultV1
}
type SurveyAdjustmentEvidenceLookup = (projectId: string, ids: string[]) => SurveyAdjustmentEvidence[]
type SurveyDeformationLookup = (projectId: string, ids: string[]) => DeformationComparisonV1[]
type SurveyRawSourceIntegritySnapshot = Readonly<{
  status: 'verified' | 'legacy-unverified' | 'failed'
  ledgerEntryCount: number
  errors: readonly string[]
}>
type SurveySourceObservationEvidence = Pick<SurveyObservationV1, 'id' | 'type' | 'sourceRecordId'>
type SurveySourcePointEvidence = Pick<SurveyPointV1, 'id'>
type SurveySourceLookup = (projectId: string, networkIds: string[]) => Array<{
  networkId: string
  sourceFile?: SurveySourceFileV1
  rawSourceIntegrity?: SurveyRawSourceIntegritySnapshot
  /**
   * Current server-derived admission state.  A source file's persisted
   * disposition and raw-byte ledger alone are not enough to establish that a
   * historical network is still safe to use in a newly generated delivery.
   */
  sourceEligibility: SurveySourceEligibility
  /** Required for formalization: source anchor proof is per observation. */
  observations?: readonly SurveySourceObservationEvidence[]
  /** Required for formalization: point IDs must not be ambiguous to a solver. */
  points?: readonly SurveySourcePointEvidence[]
}>

function sourceFormalizationErrors(networkId: string, sourceFile: SurveySourceFileV1 | undefined, observations: readonly SurveySourceObservationEvidence[] | undefined, points: readonly SurveySourcePointEvidence[] | undefined): string[] {
  if (!sourceFile) return [`平差网络 ${networkId} 未提供可进入平差的原始资料来源；请从保留的原始文件重新导入并复核后再生成交付清单。`]

  const errors: string[] = []
  if (sourceFile.disposition !== 'adjustment-ready') {
    errors.push(`平差网络 ${networkId} 的源文件处置为 ${sourceFile.disposition}，而非 adjustment-ready；请完成所需映射、验证、后处理或受审计转换后重新导入。`)
  }
  const hasAuditableLinearEvidence = sourceFile.linearUnitCanonical === 'm'
    && !['legacy-unknown', 'not-declared'].includes(sourceFile.linearUnitRaw)
    && sourceFile.parserSourceHash !== 'legacy-unavailable'
  if (!hasAuditableLinearEvidence) {
    errors.push(`平差网络 ${networkId} 的源文件未提供可审计的米制线性单位证据（linearUnitCanonical=${sourceFile.linearUnitCanonical}，linearUnitRaw=${sourceFile.linearUnitRaw}）。`)
  }
  if (!observations) {
    errors.push(`平差网络 ${networkId} 未提供观测与原始资料记录锚点映射，不能正式化。`)
  }
  if (!points) {
    errors.push(`平差网络 ${networkId} 未提供点号身份映射，不能正式化。`)
  }
  if (!observations || !points) {
    return errors
  }
  const hasAngularObservations = observations.some((observation) => ['direction', 'angle', 'zenith'].includes(observation.type))
  const hasAuditableAngularEvidence = sourceFile.angularUnitCanonical === 'rad'
    && !['legacy-unknown', 'not-declared'].includes(sourceFile.angularUnitRaw)
    && sourceFile.parserSourceHash !== 'legacy-unavailable'
  if (hasAngularObservations && !hasAuditableAngularEvidence) {
    errors.push(`平差网络 ${networkId} 的源文件未提供可审计的弧度角度单位证据（angularUnitCanonical=${sourceFile.angularUnitCanonical}，angularUnitRaw=${sourceFile.angularUnitRaw}）。`)
  }

  const anchorsById = new Map<string, typeof sourceFile.records>()
  for (const anchor of sourceFile.records) anchorsById.set(anchor.id, [...(anchorsById.get(anchor.id) ?? []), anchor])
  for (const observation of observations) {
    const sourceRecordId = observation.sourceRecordId
    if (!sourceRecordId) {
      errors.push(`平差网络 ${networkId} 的观测 ${observation.id} 未关联原始资料记录锚点。`)
      continue
    }
    const anchors = anchorsById.get(sourceRecordId) ?? []
    if (anchors.length !== 1) {
      errors.push(`平差网络 ${networkId} 的观测 ${observation.id} 的原始资料记录锚点 ${sourceRecordId} 不存在或不唯一。`)
      continue
    }
    const anchor = anchors[0]!
    const isWholeFileAnchor = sourceFile.records.length > 1 && anchor.rawOffset === 0 && anchor.rawLength >= sourceFile.fileSize
    if (anchor.rawLength <= 0 || anchor.rawOffset + anchor.rawLength > sourceFile.fileSize || isWholeFileAnchor) {
      errors.push(`平差网络 ${networkId} 的观测 ${observation.id} 的原始资料记录锚点 ${sourceRecordId} 不是非整文件的精确字节范围。`)
    }
  }
  const duplicateIds = (ids: readonly string[]): string[] => {
    const seen = new Set<string>()
    const duplicates = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) duplicates.add(id)
      seen.add(id)
    }
    return [...duplicates].sort()
  }
  const duplicateObservationIds = duplicateIds(observations.map((observation) => observation.id))
  if (duplicateObservationIds.length) errors.push(`平差网络 ${networkId} 的观测编号不唯一（${duplicateObservationIds.slice(0, 10).join('、')}），不能正式化。`)
  const duplicatePointIds = duplicateIds(points.map((point) => point.id))
  if (duplicatePointIds.length) errors.push(`平差网络 ${networkId} 的点号不唯一（${duplicatePointIds.slice(0, 10).join('、')}），不能正式化。`)
  return errors
}

export class EngineeringRevisionConflictError extends Error { readonly code = 'stale_request' }
export class EngineeringIdempotencyError extends Error {
  readonly code = 'idempotency_replay'
  constructor(readonly result: unknown, message = 'idempotency key is already bound to a different or legacy request') { super(message) }
}

type DeliveryIdempotencyOperation = 'report-preview' | 'deliverable-finalize'
type DeliveryIdempotencyRequest = Readonly<{ idempotencyKey: string }>
type DeliveryIdempotencyRow = Readonly<{ operation: string; request_hash: string; result_json: string }>

/**
 * Delivery artifacts cannot safely reuse a bare idempotency key: provenance
 * changes when an adjustment, deformation, citation, or dataset changes.
 * Keep array order (it is report order), sort object keys, and deliberately
 * omit only the key itself from the bound request payload.
 */
function canonicalDeliveryJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalDeliveryJson(item)).join(',')}]`
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalDeliveryJson(object[key])}`).join(',')}}`
  }
  // Parsed delivery requests cannot contain undefined/function/symbol values.
  // Failing closed here is safer than silently making two different payloads
  // share a fingerprint.
  throw new Error(`unsupported delivery idempotency value: ${typeof value}`)
}

function parseSegmentComparisons(value: unknown): SurveySegmentComparisonV1[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('malformed segment comparison evidence')
  return value.map(item => SurveySegmentComparisonV1.parse(item))
}

function deliveryRequestFingerprint(operation: DeliveryIdempotencyOperation, request: DeliveryIdempotencyRequest): string {
  const payload = { ...(request as Record<string, unknown>) }
  delete payload.idempotencyKey
  if (Array.isArray(payload.segmentComparisonIds) && !payload.segmentComparisonIds.length) delete payload.segmentComparisonIds
  return createHash('sha256').update(canonicalDeliveryJson({ operation, payload })).digest('hex')
}

/**
 * Survey provenance is only one part of a report. Bind the complete mutable
 * report input set too, so a dataset/project/analysis update that lands while
 * a document is rendering cannot be published as if it used current data.
 */
function deliveryInputSnapshotHash(project: RailwiseProjectV1, dataset?: StoredDataset, analysis?: MonitoringAnalysisV1): string {
  return createHash('sha256').update(canonicalDeliveryJson({
    schemaVersion: 1,
    project,
    dataset,
    analysis
  })).digest('hex')
}

/** Portable JSON-value digest: length-prefixed UTF-8 strings and IEEE-754
 * doubles avoid JS/Python decimal formatting differences. Object order is UTF-8
 * byte order; -0 equals 0, as in the persisted JSON representation. */
export function verificationSnapshotHash(value: unknown): string {
  const digest = createHash('sha256')
  const visit = (item: unknown): void => {
    if (item === null) { digest.update('n'); return }
    if (typeof item === 'boolean') { digest.update(item ? 't' : 'f'); return }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('non-finite verification snapshot')
      const bytes = Buffer.alloc(8); bytes.writeDoubleBE(item === 0 ? 0 : item)
      digest.update(`d${bytes.toString('hex')}`); return
    }
    if (typeof item === 'string') {
      const bytes = Buffer.from(item, 'utf8')
      if (bytes.toString('utf8') !== item) throw new Error('invalid Unicode verification snapshot')
      digest.update(`s${bytes.length}:`); digest.update(bytes); return
    }
    if (Array.isArray(item)) {
      digest.update(`a${item.length}:[`); item.forEach(visit); digest.update(']'); return
    }
    if (typeof item === 'object') {
      const object = item as Record<string, unknown>
      const keys = Object.keys(object).filter(key => object[key] !== undefined)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      digest.update(`o${keys.length}:{`); keys.forEach(key => { visit(key); visit(object[key]) }); digest.update('}'); return
    }
    throw new Error('unsupported verification snapshot value')
  }
  visit(value)
  return digest.digest('hex')
}

type VerificationBindings = {
  algorithm: 'typed-json-sha256-v1'; complete: boolean
  engineeringRows: Array<{ table: string; id: string; hash: string }>
  surveyNetworks: Array<{ id: string; hash: string }>
  surveyResults: Array<{ id: string; runId: string; networkId: string; inputHash: string; algorithmVersion: string; hash: string }>
  surveyDeformations: Array<{ id: string; hash: string }>
}

/** Keep analysis freshness checks byte-for-byte aligned with createAnalysis. */
function analysisInputHash(project: RailwiseProjectV1, dataset: Pick<StoredDataset, 'observations'>): string {
  return createHash('sha256').update(JSON.stringify({ project, observations: dataset.observations })).digest('hex')
}

export class EngineeringService {
  private readonly db: Database.Database
  private readonly verificationAudit: EngineeringVerificationAudit
  private readonly monitoringReplayAudit: MonitoringReplayAudit
  private readonly nowIso: () => string
  private readonly idempotencyLocks = new Map<string, Promise<void>>()
  private readonly pendingMetadataWrites = new Set<Promise<void>>()
  constructor(private readonly options: { rootDir: string; attachmentStore?: AttachmentStore; runtimeVersion?: string; nowIso?: () => string; getAdjustments?: SurveyAdjustmentLookup; getAdjustmentEvidence?: SurveyAdjustmentEvidenceLookup; getDeformations?: SurveyDeformationLookup; getSurveySources?: SurveySourceLookup; getSurveyNetworkSnapshot?: (projectId: string, networkId: string) => SurveyNetworkV1 | null; getProfessionalReview?: (projectId: string, adjustmentId: string) => SurveyProfessionalReviewV1 | null; getSegmentComparison?: (projectId: string, comparisonId: string) => SurveySegmentComparisonV1 | null; getSegmentContinuity?: (projectId: string, comparisonIds: readonly string[]) => SurveySegmentContinuityV1 | null }) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
    mkdirSync(resolve(options.rootDir), { recursive: true })
    this.db = new Database(resolve(options.rootDir, 'engineering.sqlite3'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS engineering_projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_datasets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_analyses (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_charts (id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_manifests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_verification_attempts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        project_id TEXT NOT NULL, manifest_id TEXT NOT NULL, started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL, outcome TEXT NOT NULL, record_hash TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS engineering_verification_manifest ON engineering_verification_attempts(project_id, manifest_id, sequence);
      CREATE TRIGGER IF NOT EXISTS engineering_verification_no_update BEFORE UPDATE ON engineering_verification_attempts
        BEGIN SELECT RAISE(ABORT, 'verification attempts are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS engineering_verification_no_delete BEFORE DELETE ON engineering_verification_attempts
        BEGIN SELECT RAISE(ABORT, 'verification attempts are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS engineering_verification_no_replace BEFORE INSERT ON engineering_verification_attempts
        WHEN EXISTS (SELECT 1 FROM engineering_verification_attempts WHERE id = NEW.id OR sequence = NEW.sequence)
        BEGIN SELECT RAISE(ABORT, 'verification attempts are append-only'); END;
      CREATE TABLE IF NOT EXISTS engineering_idempotency (key TEXT PRIMARY KEY, result_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engineering_delivery_idempotency (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );`)
    this.verificationAudit = new EngineeringVerificationAudit(this.db, this.nowIso)
    this.monitoringReplayAudit = new MonitoringReplayAudit(this.db, this.nowIso)
    this.db.exec(`CREATE TABLE IF NOT EXISTS engineering_monitoring_sources (
      dataset_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_hash TEXT NOT NULL, source_bytes BLOB NOT NULL,
      context_json TEXT NOT NULL, context_hash TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS monitoring_sources_no_update BEFORE UPDATE ON engineering_monitoring_sources BEGIN SELECT RAISE(ABORT, 'monitoring source is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS monitoring_sources_no_delete BEFORE DELETE ON engineering_monitoring_sources BEGIN SELECT RAISE(ABORT, 'monitoring source is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS monitoring_sources_no_replace BEFORE INSERT ON engineering_monitoring_sources
      WHEN EXISTS(SELECT 1 FROM engineering_monitoring_sources WHERE dataset_id=NEW.dataset_id) BEGIN SELECT RAISE(ABORT, 'monitoring source is append-only'); END;`)
  }
  close(): void { this.db.close() }

  /** Wait for recoverable metadata projections before a workspace is closed or removed. */
  async flush(): Promise<void> {
    while (this.pendingMetadataWrites.size > 0) {
      await Promise.all([...this.pendingMetadataWrites])
    }
    await drainAtomicWrites()
  }

  private readProject(json: string): RailwiseProjectV1 {
    const project = RailwiseProjectV1.parse(JSON.parse(json))
    const taskType = project.taskType ?? inferEngineeringTaskType(project.monitoringType)
    return taskType ? { ...project, taskType } : project
  }

  listProjects(): RailwiseProjectV1[] {
    return (this.db.prepare('SELECT data_json FROM engineering_projects ORDER BY updated_at DESC').all() as Array<{ data_json: string }>).map((r) => this.readProject(r.data_json))
  }
  getProject(id: string): RailwiseProjectV1 | null {
    const row = this.db.prepare('SELECT data_json FROM engineering_projects WHERE id = ?').get(id) as { data_json: string } | undefined
    return row ? this.readProject(row.data_json) : null
  }
  /** Project-scoped metadata only; callers must separately verify retained bytes. */
  getManifestForProject(projectId: string, manifestId: string): DeliverableManifestV1 | null {
    const row = this.db.prepare('SELECT data_json FROM engineering_manifests WHERE id = ? AND project_id = ?').get(manifestId, projectId) as { data_json: string } | undefined
    if (!row) return null
    const manifest = DeliverableManifestV1.parse(JSON.parse(row.data_json))
    if (manifest.id !== manifestId || manifest.projectId !== projectId) throw new Error('deliverable manifest identity mismatch')
    return manifest
  }
  updateProject(id: string, input: unknown): RailwiseProjectV1 {
    const req = EngineeringProjectUpdateRequest.parse(input)
    const replay = this.replay(req.idempotencyKey)
    if (replay) return replay as RailwiseProjectV1
    const project = this.mustProject(id)
    if (req.expectedRevision !== project.revision) throw new EngineeringRevisionConflictError(`project revision conflict: expected ${req.expectedRevision}, actual ${project.revision}`)
    const { expectedRevision: _expectedRevision, idempotencyKey: _idempotencyKey, ...projectPatch } = req
    const next = RailwiseProjectV1.parse({ ...project, ...projectPatch, id: project.id, workspace: project.workspace, revision: project.revision + 1, updatedAt: this.nowIso() })
    this.db.prepare('UPDATE engineering_projects SET revision = ?, data_json = ?, updated_at = ? WHERE id = ?').run(next.revision, JSON.stringify(next), next.updatedAt, next.id)
    this.trackMetadataPersistence(next.workspace, 'projects', next.id, next)
    this.remember(req.idempotencyKey, next)
    return next
  }
  getProjectOverview(id: string): { project: RailwiseProjectV1; datasets: Array<Omit<StoredDataset, 'observations'>>; analyses: MonitoringAnalysisV1[]; runs: StoredRun[]; manifests: DeliverableManifestV1[]; latestPreview?: NonNullable<ReturnType<EngineeringService['getPreviewEvidence']>>; latestPreviewUnavailable?: boolean } {
    const project = this.mustProject(id)
    const datasets = (this.db.prepare('SELECT data_json FROM engineering_datasets WHERE project_id = ? ORDER BY updated_at DESC').all(project.id) as Array<{ data_json: string }>).map((row) => {
      const { observations: _observations, ...dataset } = this.mustStoredDataset(row.data_json)
      return dataset
    })
    const analyses = (this.db.prepare('SELECT data_json FROM engineering_analyses WHERE project_id = ? ORDER BY created_at DESC').all(project.id) as Array<{ data_json: string }>).map((row) => MonitoringAnalysisV1.parse(JSON.parse(row.data_json)))
    const runs = (this.db.prepare('SELECT data_json FROM engineering_runs WHERE project_id = ? ORDER BY updated_at DESC').all(project.id) as Array<{ data_json: string }>).map((row) => JSON.parse(row.data_json) as StoredRun)
    const manifests = (this.db.prepare('SELECT data_json FROM engineering_manifests WHERE project_id = ? ORDER BY created_at DESC').all(project.id) as Array<{ data_json: string }>).map((row) => DeliverableManifestV1.parse(JSON.parse(row.data_json)))
    // Restore recorded output descriptors for AI exports and application restart.
    // This does not reread files, recompute results or claim current verification.
    let latestPreview: ReturnType<EngineeringService['getPreviewEvidence']> = null
    let latestPreviewUnavailable = false
    if (runs[0]?.status === 'completed') {
      try { latestPreview = this.getPreviewEvidence(project.id, runs[0].id) }
      catch { latestPreviewUnavailable = true }
    }
    return { project, datasets, analyses, runs, manifests, ...(latestPreview ? { latestPreview } : {}), ...(latestPreviewUnavailable ? { latestPreviewUnavailable } : {}) }
  }
  createProject(input: unknown): RailwiseProjectV1 {
    const parsed = EngineeringProjectCreateRequest.parse(input)
    if (parsed.expectedRevision !== 0) throw new EngineeringRevisionConflictError(`project revision conflict: expected ${parsed.expectedRevision}, actual 0`)
    const replay = this.replay(parsed.idempotencyKey)
    if (replay) return replay as RailwiseProjectV1
    const now = this.nowIso(); const id = `project_${randomUUID()}`
    const project = RailwiseProjectV1.parse({ schemaVersion: 1, id, name: parsed.name, ...(parsed.taskContext ? { taskContext: parsed.taskContext } : {}), taskType: parsed.taskType ?? (parsed.monitoringType ? inferEngineeringTaskType(parsed.monitoringType) : 'control-network'), monitoringType: parsed.monitoringType ?? parsed.taskType ?? 'control-network', unit: parsed.unit ?? 'mm', signConvention: parsed.signConvention ?? 'positive', thresholds: parsed.thresholds ?? {}, reportPeriod: parsed.reportPeriod ?? {}, workspace: resolve(parsed.workspace), revision: 1, createdAt: now, updatedAt: now })
    this.db.prepare('INSERT INTO engineering_projects(id, revision, data_json, updated_at) VALUES (?, ?, ?, ?)').run(id, 1, JSON.stringify(project), now)
    this.trackMetadataPersistence(project.workspace, 'projects', project.id, project)
    this.remember(parsed.idempotencyKey, project)
    return project
  }

  async importDataset(input: unknown): Promise<StoredDataset> {
    const req = DatasetImportRequest.parse(input)
    return this.withIdempotencyLock(req.idempotencyKey, async () => {
      const replay = this.replay(req.idempotencyKey); if (replay) return replay as StoredDataset
      const project = this.mustProject(req.projectId)
      if (project.revision !== req.expectedRevision && req.expectedRevision !== 0) throw new EngineeringRevisionConflictError(`project revision conflict: expected ${req.expectedRevision}, actual ${project.revision}`)
      let name = req.name ?? 'dataset.csv'; let bytes: Buffer
      if (req.attachmentId) {
        if (!this.options.attachmentStore) throw new Error('attachment store is unavailable')
        const content = await this.options.attachmentStore.resolveContent(req.attachmentId, { workspace: project.workspace })
        bytes = content.data; name = content.name
      } else bytes = Buffer.from(req.dataBase64!, 'base64')
      if (bytes.length > 32 * 1024 * 1024) throw new Error('monitoring source exceeds 32 MiB limit')
      const sourceFileHash = createHash('sha256').update(bytes).digest('hex')
      const rows = await parseTabular(name, bytes, req.fieldMapping)
      const mapping = FieldMappingV1.parse({ ...inferMapping(rows[0] ?? {}), ...(req.fieldMapping ?? {}) })
      const normalized = normalizeRows(rows, mapping, project, sourceFileHash)
      const now = this.nowIso(); const id = `dataset_${randomUUID()}`
      const dataset = { schemaVersion: 1 as const, id, projectId: project.id, sourceAttachmentId: req.attachmentId, sourceFileName: name, sourceFileHash, fieldMapping: mapping, unknownColumns: normalized.unknownColumns, rowCount: rows.length, columnCount: normalized.columnCount, observationCount: normalized.observations.length, timeRange: normalized.timeRange, status: 'imported' as const, revision: 1, createdAt: now, updatedAt: now, observations: normalized.observations.map((observation) => ({ ...observation, datasetId: id })), findings: normalized.findings.map((finding) => ({ ...finding, datasetId: id })) }
      const parsed = validateStoredDataset(dataset)
      const sourceContext = JSON.stringify({ datasetId: id, project, requestedMapping: req.fieldMapping ?? null, fieldMapping: mapping, sourceFileName: name, sourceFileHash })
      if (Buffer.byteLength(sourceContext) > 256 * 1024) throw new Error('monitoring source context exceeds 256 KiB limit')
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO engineering_datasets(id, project_id, revision, data_json, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, project.id, 1, JSON.stringify(parsed), now)
        this.db.prepare('INSERT INTO engineering_monitoring_sources(dataset_id,project_id,source_hash,source_bytes,context_json,context_hash) VALUES(?,?,?,?,?,?)')
          .run(id, project.id, sourceFileHash, bytes, sourceContext, createHash('sha256').update(sourceContext).digest('hex'))
      }).immediate()
      await this.persistMetadata(project.workspace, 'datasets', parsed.id, parsed)
      this.remember(req.idempotencyKey, parsed)
      return parsed
    })
  }

  validateDataset(input: unknown): StoredDataset {
    const req = DatasetValidateRequest.parse(input); const dataset = this.mustDataset(req.datasetId)
    const project = this.mustProject(dataset.projectId)
    if (req.expectedRevision !== dataset.revision && req.expectedRevision !== 0) throw new EngineeringRevisionConflictError(`dataset revision conflict: expected ${req.expectedRevision}, actual ${dataset.revision}`)
    const findings = mergeFindings(dataset.findings, runQualityChecks(dataset.observations, project, this.nowIso)).map((finding) => ({ ...finding, datasetId: dataset.id }))
    const next = { ...dataset, findings, status: 'validated' as const, revision: dataset.revision + 1, updatedAt: this.nowIso() }
    this.saveDataset(next); this.trackMetadataPersistence(project.workspace, 'datasets', next.id, next); this.remember(req.idempotencyKey, next); return next
  }
  acceptWarningFinding(input: unknown): StoredDataset {
    const req = AcceptQualityFindingRequest.parse(input)
    const replay = this.replay(req.idempotencyKey)
    if (replay) return replay as StoredDataset
    const dataset = this.mustDataset(req.datasetId)
    if (req.expectedRevision !== dataset.revision) throw new EngineeringRevisionConflictError(`dataset revision conflict: expected ${req.expectedRevision}, actual ${dataset.revision}`)
    const finding = dataset.findings.find((item) => item.id === req.findingId)
    if (!finding) throw new Error(`quality finding not found: ${req.findingId}`)
    if (finding.severity !== 'warning') throw new Error('only warning findings can be accepted')
    const next = { ...dataset, findings: dataset.findings.map((item) => item.id === finding.id ? { ...item, status: 'accepted' as const } : item), revision: dataset.revision + 1, updatedAt: this.nowIso() }
    this.saveDataset(next)
    this.trackMetadataPersistence(this.mustProject(dataset.projectId).workspace, 'datasets', next.id, next)
    this.remember(req.idempotencyKey, next)
    return next
  }

  createAnalysis(input: unknown): MonitoringAnalysisV1 {
    const req = AnalysisRequest.parse(input); const dataset = this.mustDataset(req.datasetId); const project = this.mustProject(req.projectId)
    if (dataset.projectId !== project.id) throw new Error('dataset does not belong to project')
    if (req.expectedRevision !== 0 && req.expectedRevision !== dataset.revision) throw new EngineeringRevisionConflictError(`dataset revision conflict: expected ${req.expectedRevision}, actual ${dataset.revision}`)
    const inputHash = analysisInputHash(project, dataset)
    const replay = this.replay(req.idempotencyKey)
    if (replay) {
      const replayed = MonitoringAnalysisV1.parse(replay)
      if (replayed.projectId !== project.id || replayed.datasetId !== dataset.id || replayed.inputHash !== inputHash) {
        throw new EngineeringIdempotencyError(replayed, 'analysis idempotency key is bound to stale or different project/dataset inputs')
      }
      const durable = this.getAnalysis(replayed.id)
      if (!durable || canonicalDeliveryJson(durable) !== canonicalDeliveryJson(replayed)) {
        throw new EngineeringIdempotencyError(replayed, 'analysis idempotency result is unavailable or differs from its durable analysis')
      }
      return durable
    }
    const existing = this.db.prepare('SELECT data_json FROM engineering_analyses WHERE dataset_id = ? AND project_id = ? AND json_extract(data_json, \'$.inputHash\') = ? AND json_extract(data_json, \'$.algorithmVersion\') = ? ORDER BY created_at DESC LIMIT 1').get(dataset.id, project.id, inputHash, ENGINEERING_ANALYSIS_ALGORITHM_VERSION) as { data_json: string } | undefined
    if (existing) {
      const cached = MonitoringAnalysisV1.parse(JSON.parse(existing.data_json))
      this.remember(req.idempotencyKey, cached)
      return cached
    }
    const results = calculateMonitoringAnalysisV2(project, dataset.observations)
    const analysis = MonitoringAnalysisV1.parse({ schemaVersion: 1, id: `analysis_${randomUUID()}`, projectId: project.id, datasetId: dataset.id, inputHash, algorithmVersion: ENGINEERING_ANALYSIS_ALGORITHM_VERSION, results, createdAt: this.nowIso() })
    this.db.prepare('INSERT INTO engineering_analyses(id, project_id, dataset_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)').run(analysis.id, project.id, dataset.id, JSON.stringify(analysis), analysis.createdAt)
    this.remember(req.idempotencyKey, analysis); return analysis
  }

  async createChart(input: unknown): Promise<ChartArtifactV1> {
    const req = ChartRequest.parse(input); const analysis = this.getAnalysis(req.analysisId); if (!analysis) throw new Error('analysis not found')
    if (req.chartType !== 'trend') throw new Error('unsupported monitoring chart type; only trend is implemented')
    return this.withIdempotencyLock(req.idempotencyKey, async () => {
      const project = this.mustProject(analysis.projectId)
      const dataset = this.mustDataset(analysis.datasetId)
      this.assertAnalysisCurrent(project, dataset, analysis)
      const replay = this.replay(req.idempotencyKey)
      if (replay) {
        const replayed = ChartArtifactV1.parse(replay)
        if (replayed.analysisId !== analysis.id || replayed.inputHash !== analysis.inputHash || replayed.chartType !== req.chartType) {
          throw new EngineeringIdempotencyError(replayed, 'chart idempotency key is bound to stale or different analysis input')
        }
        const durable = this.getChart(replayed.id)
        if (!durable || canonicalDeliveryJson(durable) !== canonicalDeliveryJson(replayed)) {
          throw new EngineeringIdempotencyError(replayed, 'chart idempotency result is unavailable or differs from its durable chart')
        }
        return durable
      }
      const { svg, dataRange } = renderMonitoringTrendChart(dataset.observations, project)
      const runId = `chart_${randomUUID()}`; const outDir = this.outputDir(project, runId); await mkdir(outDir, { recursive: true })
      const path = join(outDir, `${req.chartType}.svg`); await atomicWriteFile(path, svg); const sha256 = createHash('sha256').update(svg).digest('hex')
      const chart = ChartArtifactV1.parse({ schemaVersion: 1, id: runId, analysisId: analysis.id, chartType: req.chartType, rendererVersion: ENGINEERING_TREND_RENDERER_VERSION, inputHash: analysis.inputHash, dataRange, relativePath: relative(project.workspace, path), sha256, validation: 'valid', createdAt: this.nowIso() })
      this.db.prepare('INSERT INTO engineering_charts(id, analysis_id, data_json, created_at) VALUES (?, ?, ?, ?)').run(chart.id, chart.analysisId, JSON.stringify(chart), chart.createdAt); this.remember(req.idempotencyKey, chart); return chart
    })
  }

  async previewReport(input: unknown): Promise<{ run: StoredRun; files: Array<{ path: string; mediaType: string; sha256: string; sizeBytes: number }>; charts: ChartArtifactV1[]; citations: KnowledgeCitationV1[]; adjustments: AdjustmentResultV1[]; deformations: DeformationComparisonV1[]; segmentComparisons?: SurveySegmentComparisonV1[]; segmentContinuity?: SurveySegmentContinuityV1; surveySources: SurveySourceEvidenceV1[] }> {
    const req = ReportPreviewRequest.parse(input)
    return this.withIdempotencyLock(req.idempotencyKey, async () => {
      const project = this.mustProject(req.projectId)
      const dataset = req.datasetId ? this.mustDataset(req.datasetId) : undefined
      this.assertDeliveryRevision(project, dataset, req.expectedRevision)
      const replay = this.replayDelivery<{
        run: StoredRun
        files: Array<{ path: string; mediaType: string; sha256: string; sizeBytes: number }>
        charts: ChartArtifactV1[]
        citations: KnowledgeCitationV1[]
        adjustments?: AdjustmentResultV1[]
        deformations?: DeformationComparisonV1[]
        segmentComparisons?: SurveySegmentComparisonV1[]
        segmentContinuity?: SurveySegmentContinuityV1
        surveySources?: SurveySourceEvidenceV1[]
      }>('report-preview', req)
      // A bound replay keeps its original analysis; a new automatic request uses the current algorithm.
      const analysisId = req.analysisId ?? replay?.run.analysisId
      const analysis = dataset ? (analysisId ? this.getAnalysis(analysisId) ?? undefined : this.createAnalysis({ expectedRevision: dataset.revision, idempotencyKey: `preview-analysis-${ENGINEERING_ANALYSIS_ALGORITHM_VERSION}-${dataset.id}-${analysisInputHash(project, dataset)}`, projectId: project.id, datasetId: dataset.id })) : undefined
      if (dataset) {
        if (!analysis) throw new Error('analysis not found')
        this.assertAnalysisCurrent(project, dataset, analysis)
      }
      const inputSnapshotHash = deliveryInputSnapshotHash(project, dataset, analysis)
      const adjustments = this.lookupAdjustments(project.id, req.adjustmentIds)
      const deformations = this.lookupDeformations(project.id, req.deformationIds)
      const segmentComparisons = this.lookupSegmentComparisons(project.id, req.segmentComparisonIds, adjustments)
      const segmentContinuity = this.lookupSegmentContinuity(project.id, req.segmentComparisonIds, segmentComparisons)
      this.assertDeformationEpochEvidence(project.id, deformations)
      // A preview is a newly generated computational artifact, not merely a
      // read of its historical inputs. Check current source admission before
      // returning an idempotent result or allocating an output directory.
      this.assertSurveySourcesAdmissible(project.id, adjustments, deformations)
      if (replay) {
        if (replay.run.projectId !== project.id || replay.run.datasetId !== dataset?.id || replay.run.analysisId !== analysis?.id) {
          throw new EngineeringIdempotencyError(replay, 'stored preview does not match its bound delivery request')
        }
        if (!replay.run.deliveryInputHash || replay.run.deliveryInputHash !== inputSnapshotHash) {
          throw new EngineeringIdempotencyError(replay, 'stored preview input snapshot no longer matches the current project, dataset, and analysis')
        }
        this.assertCompletedRunCurrent(replay.run)
        this.assertDeliveryOutputsCurrent(project, replay.files)
        let replayAdjustments: AdjustmentResultV1[]
        try {
          replayAdjustments = (replay.adjustments ?? []).map((item) => AdjustmentResultV1.parse(item))
        } catch {
          throw new EngineeringIdempotencyError(replay, 'stored preview has malformed adjustment evidence')
        }
        this.assertReplayAdjustmentsMatchLive('stored preview', adjustments, replayAdjustments)
        let replayDeformations: DeformationComparisonV1[]
        try {
          replayDeformations = (replay.deformations ?? []).map((item) => DeformationComparisonV1.parse(item))
        } catch {
          throw new EngineeringIdempotencyError(replay, 'stored preview has malformed deformation evidence')
        }
        this.assertReplayDeformationsMatchLive('stored preview', deformations, replayDeformations)
        this.assertSegmentComparisonsMatch('stored preview', segmentComparisons, replay.segmentComparisons)
        this.assertSegmentContinuityMatch('stored preview', segmentContinuity, replay.segmentContinuity)
        this.assertDeformationEpochEvidence(project.id, deformations)
        this.assertSurveySourcesAdmissible(project.id, adjustments, deformations)
        // Re-read source evidence from the replay's own bound inputs.  Never
        // pair an old report file with provenance from a new request.
        const replaySurveySources = this.lookupSurveySources(project.id, this.requiredSurveyNetworkIds(adjustments, deformations))
        return { ...replay, adjustments, deformations, ...(segmentComparisons.length ? { segmentComparisons } : {}), ...(segmentContinuity ? { segmentContinuity } : {}), surveySources: replaySurveySources }
      }
      const surveySources = this.lookupSurveySources(project.id, this.requiredSurveyNetworkIds(adjustments, deformations))
      const runId = `run_${randomUUID()}`
      const outDir = this.outputDir(project, runId)
      // Do not write partially generated reports into the public deliverable
      // tree.  A source/result can change while DOCX/PDF/XLSX generation
      // yields; staged bytes are published only after a final synchronous
      // evidence check, so a rejected preview never leaves readable report
      // files under `.workwise/deliverables`.
      const stagingDir = this.deliveryStagingDir(project, runId)
      await mkdir(stagingDir, { recursive: true })
      let published = false
      try {
        const previousChart = analysis ? this.latestChart(analysis.id) : undefined
        const chart = analysis ? (previousChart?.rendererVersion === ENGINEERING_TREND_RENDERER_VERSION && previousChart.chartType === 'trend'
          ? previousChart : await this.createChart({ expectedRevision: 0, idempotencyKey: `preview-chart-${ENGINEERING_TREND_RENDERER_VERSION}-${analysis.id}`, analysisId: analysis.id, chartType: 'trend' })) : undefined
        const outputs: Array<{ path: string; mediaType: string; sha256: string; sizeBytes: number }> = []
        const stageOutput = async (name: string, mediaType: string, contents: string | Uint8Array): Promise<void> => {
          const stagedPath = join(stagingDir, name)
          await atomicWriteFile(stagedPath, contents)
          const recorded = await fileOutput(stagedPath, mediaType, project.workspace)
          outputs.push({ ...recorded, path: relative(project.workspace, join(outDir, name)) })
        }
        const text = reportText(project, dataset, analysis, req.citations, adjustments, deformations, surveySources)
        const professionalReviews = adjustments.map(adjustment => this.reportProfessionalReview(project.id, adjustment))
        const monitoringReport = dataset ? buildMonitoringProfessionalReport({ project, dataset, analysis, generatedAt: this.nowIso() }) : undefined
        const hasProfessionalProjection = professionalReviews.length > 0 || deformations.length > 0 || segmentComparisons.length > 0 || segmentContinuity !== undefined || monitoringReport !== undefined
        const professionalModel = hasProfessionalProjection ? buildProfessionalReportModel({ project, reviews: professionalReviews.map((review, index) => ({ review, adjustment: adjustments[index], source: surveySources.find(item => item.networkId === review.networkId) })), segmentComparisons, deformations, ...(segmentContinuity ? { segmentContinuity } : {}), ...(monitoringReport ? { monitoringReport } : {}), generatedAt: this.nowIso(), appendix: text.split('\n') }) : undefined
        await stageOutput('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', professionalModel ? await makeProfessionalDocx(professionalModel) : await makeDocx(text))
        await stageOutput('report.pdf', 'application/pdf', professionalModel ? await makeProfessionalReportPdf(professionalModel) : await makeReportPdf(text))
        await stageOutput('evidence.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await makeXlsx(project, dataset, analysis, req.citations, adjustments, deformations, surveySources, this.options.runtimeVersion ?? RUNTIME_VERSION))
        if (professionalModel) {
          await stageOutput('professional.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await makeProfessionalXlsx(professionalModel))
          await stageOutput('professional-review.json', 'application/json', JSON.stringify({ model: professionalModel, reviews: professionalReviews, ...(segmentComparisons.length ? { segmentComparisons } : {}), ...(deformations.length ? { deformations } : {}), ...(segmentContinuity ? { segmentContinuity } : {}), ...(monitoringReport ? { monitoringReport } : {}) }, null, 2))
        }
        if (chart) {
          const chartPath = resolve(project.workspace, chart.relativePath)
          if (await readFile(chartPath).then(() => true).catch(() => false)) outputs.push(await fileOutput(chartPath, 'image/svg+xml', project.workspace))
        }

        // Publish the directory only after a synchronous strict re-read.
        // `publishStagedDeliveryDirectory` deliberately does not await
        // between this verifier and renameSync, closing the in-process TOCTOU
        // interval that existed when verification ran after public writes.
        let completedAdjustments!: AdjustmentResultV1[]
        let completedDeformations!: DeformationComparisonV1[]
        let completedSurveySources!: SurveySourceEvidenceV1[]
        let completedSegmentComparisons!: SurveySegmentComparisonV1[]
        let completedSegmentContinuity!: SurveySegmentContinuityV1 | undefined
        this.publishStagedDeliveryDirectory(stagingDir, outDir, () => {
          this.assertDeliveryInputsCurrent(project, dataset, analysis, inputSnapshotHash)
          completedAdjustments = this.lookupAdjustments(project.id, req.adjustmentIds)
          completedDeformations = this.lookupDeformations(project.id, req.deformationIds)
          completedSegmentComparisons = this.lookupSegmentComparisons(project.id, req.segmentComparisonIds, completedAdjustments)
          completedSegmentContinuity = this.lookupSegmentContinuity(project.id, req.segmentComparisonIds, completedSegmentComparisons)
          this.assertReplayAdjustmentsMatchLive('preview publication', completedAdjustments, adjustments)
          this.assertReplayDeformationsMatchLive('preview publication', completedDeformations, deformations)
          this.assertSegmentComparisonsMatch('preview publication', completedSegmentComparisons, segmentComparisons)
          this.assertSegmentContinuityMatch('preview publication', completedSegmentContinuity, segmentContinuity)
          const currentReviews = completedAdjustments.map(adjustment => this.reportProfessionalReview(project.id, adjustment))
          if (canonicalDeliveryJson(currentReviews) !== canonicalDeliveryJson(professionalReviews)) throw new Error('professional report projection changed while exporting; refresh the evidence and generate a new report')
          this.assertDeformationEpochEvidence(project.id, completedDeformations)
          this.assertSurveySourcesAdmissible(project.id, completedAdjustments, completedDeformations)
          completedSurveySources = this.lookupSurveySources(project.id, this.requiredSurveyNetworkIds(completedAdjustments, completedDeformations))
          // Provider calls above are synchronous but may observe a mutable
          // runtime. Re-check project/dataset/analysis after the complete
          // evidence read, immediately before the no-await publication.
          this.assertDeliveryInputsCurrent(project, dataset, analysis, inputSnapshotHash)
        })
        published = true
        this.assertDeliveryOutputsCurrent(project, outputs)
        const run: StoredRun = { id: runId, projectId: project.id, datasetId: dataset?.id, analysisId: analysis?.id, deliveryInputHash: inputSnapshotHash, status: 'completed', revision: 1, idempotencyKey: req.idempotencyKey, createdAt: this.nowIso(), updatedAt: this.nowIso() }
        const result = { run, files: outputs, charts: chart ? [chart] : [], citations: req.citations, adjustments: completedAdjustments, deformations: completedDeformations, ...(completedSegmentComparisons.length ? { segmentComparisons: completedSegmentComparisons } : {}), ...(completedSegmentContinuity ? { segmentContinuity: completedSegmentContinuity } : {}), surveySources: completedSurveySources }
        // If another Runtime has claimed the idempotency key while this one
        // was rendering, roll back our run rather than leaving a second
        // public directory that is not the replayed delivery.
        return this.db.transaction(() => {
          this.db.prepare('INSERT INTO engineering_runs(id, project_id, data_json, updated_at) VALUES (?, ?, ?, ?)').run(run.id, run.projectId, JSON.stringify(run), run.updatedAt)
          const remembered = this.rememberDelivery('report-preview', req, result)
          if (remembered.run.id !== run.id) {
            throw new EngineeringIdempotencyError(remembered, 'delivery idempotency key was claimed while this preview was publishing')
          }
          return remembered
        }).immediate()
      } catch (error) {
        // This path owns a random, containment-checked staging directory. A
        // failed/revoked preview must not accumulate a second readable copy
        // of its report outside the delivery tree either.
        await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
        if (published) await rm(outDir, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    })
  }

  private reportProfessionalReview(projectId: string, result: AdjustmentResultV1): SurveyProfessionalReviewV1 {
    const review = SurveyProfessionalReviewV1.parse(this.options.getProfessionalReview?.(projectId, result.runId)
      ?? buildSurveyProfessionalReview({ projectId, result, network: this.options.getSurveyNetworkSnapshot?.(projectId, result.networkId), sourceIntegrity: 'not-verified' }))
    if (review.projectId !== projectId || review.networkId !== result.networkId || review.runId !== result.runId
      || review.resultId !== result.id || review.inputHash !== result.inputHash || review.algorithmVersion !== result.algorithmVersion
      || review.resultHash !== createHash('sha256').update(canonicalDeliveryJson(result)).digest('hex')) {
      throw new Error('professional report projection does not match the selected immutable adjustment result')
    }
    if (review.source.status === 'mismatch' || review.source.integrity === 'failed') throw new Error('professional report source binding failed; refresh the original observations before exporting')
    return review
  }

  private lookupSegmentComparisons(projectId: string, ids: readonly string[], adjustments: readonly AdjustmentResultV1[]): SurveySegmentComparisonV1[] {
    if (!ids.length) return []
    if (!this.options.getSegmentComparison) throw new Error('survey segment comparison lookup is unavailable')
    if (new Set(ids).size !== ids.length) throw new Error('duplicate selected segment comparisons')
    return ids.map(id => {
      const stored = this.options.getSegmentComparison!(projectId, id)
      if (!stored) throw new Error('selected segment comparison is unavailable')
      const comparison = SurveySegmentComparisonV1.parse(stored)
      if (comparison.id !== id || comparison.projectId !== projectId) throw new Error('segment comparison does not match its selected project/identity')
      for (const period of ['reference', 'current'] as const) {
        const matches = adjustments.filter(result => result.runId === comparison[`${period}AdjustmentId`])
        if (matches.length !== 1) throw new Error('segment comparison requires both exact adjustment runs in the selected report inputs')
        const review = this.reportProfessionalReview(projectId, matches[0]!)
        if (review.resultHash !== comparison[`${period}ResultHash`] || review.projectionHash !== comparison[`${period}ProjectionHash`]) {
          throw new Error('segment comparison no longer matches the selected result/projection')
        }
      }
      return comparison
    })
  }

  private lookupSegmentContinuity(projectId: string, ids: readonly string[], comparisons: readonly SurveySegmentComparisonV1[]): SurveySegmentContinuityV1 | undefined {
    if (ids.length <= 1) return undefined
    if (comparisons.length !== ids.length || !this.options.getSegmentContinuity) throw new Error('multi-period continuity lookup is unavailable')
    const continuity = this.options.getSegmentContinuity(projectId, ids)
    if (!continuity) throw new Error('selected segment comparison continuity is unavailable')
    const parsed = SurveySegmentContinuityV1.parse(continuity)
    if (parsed.projectId !== projectId || canonicalDeliveryJson(parsed.comparisonIds) !== canonicalDeliveryJson(ids)) throw new Error('segment continuity does not match selected comparisons')
    return parsed
  }

  private assertSegmentComparisonsMatch(label: string, live: readonly SurveySegmentComparisonV1[], stored: readonly SurveySegmentComparisonV1[] = []): void {
    const parsed = stored.map(value => SurveySegmentComparisonV1.parse(value))
    if (canonicalDeliveryJson(live) !== canonicalDeliveryJson(parsed)) throw new Error(`${label} segment comparison evidence no longer matches the selected immutable record`)
  }

  private assertSegmentContinuityMatch(label: string, live: SurveySegmentContinuityV1 | undefined, stored: SurveySegmentContinuityV1 | undefined): void {
    if (canonicalDeliveryJson(live ?? null) !== canonicalDeliveryJson(stored ?? null)) throw new Error(`${label} segment continuity evidence no longer matches the selected immutable record`)
  }

  /** A separate numerical audit; never writes old verification or analysis records. */
  async replayMonitoringDeliverable(projectId: string, manifestId: string): Promise<MonitoringReplayVerificationV1> {
    const attempt = this.monitoringReplayAudit.begin(projectId, manifestId)
    const execution = { runtimeVersion: this.options.runtimeVersion ?? RUNTIME_VERSION, node: process.versions.node, v8: process.versions.v8,
      icu: process.versions.icu ?? 'unknown', platform: process.platform, arch: process.arch,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, timeBasis: 'ISO-unzoned-UTC' as const }
    const analyses: MonitoringReplayVerificationV1['analyses'] = []
    let status: MonitoringReplayVerificationV1['status'] = 'failed'
    let reasonCode: MonitoringReplayVerificationV1['reasonCode'] = 'prerequisite-failed'
    try {
      const before = this.monitoringReplayBindings(projectId, manifestId)
      if (!before.complete || !this.checkDeliverable(projectId, manifestId).valid) throw new Error('prerequisite failed')
      const manifestRow = this.db.prepare('SELECT data_json FROM engineering_manifests WHERE id=? AND project_id=?').get(manifestId, projectId) as { data_json: string }
      const manifest = DeliverableManifestV1.parse(JSON.parse(manifestRow.data_json))
      if (!manifest.analyses.length) { status = 'not-applicable'; reasonCode = 'no-monitoring-analysis' }
      else {
        if (manifest.analyses.length !== 1 || manifest.inputDatasets.length !== 1) throw new Error('invalid monitoring bindings')
        const project = this.mustProject(projectId), analysis = this.getAnalysis(manifest.analyses[0]!)!
        const dataset = this.mustDataset(manifest.inputDatasets[0]!.id)
        this.assertAnalysisCurrent(project, dataset, analysis)
        const digest = (value: unknown): string => createHash('sha256').update(canonicalDeliveryJson(value)).digest('hex')
        const evidence: MonitoringReplayVerificationV1['analyses'][number] = { analysisId: analysis.id, datasetId: dataset.id,
          algorithmVersion: analysis.algorithmVersion, inputHash: analysis.inputHash, storedResultsHash: digest(analysis.results), status: 'failed', reasonCode: 'prerequisite-failed' }
        analyses.push(evidence)
        const setOutcome = (nextStatus: MonitoringReplayVerificationV1['status'], nextReason: MonitoringReplayVerificationV1['reasonCode']): void => {
          status = nextStatus; reasonCode = nextReason; evidence.status = nextStatus; evidence.reasonCode = nextReason
        }
        if (analysis.algorithmVersion !== ENGINEERING_ANALYSIS_ALGORITHM_VERSION) setOutcome('not-evaluated', 'unsupported-algorithm')
        else if (dataset.observations.length > 20000) setOutcome('not-evaluated', 'resource-limit')
        else {
          const sourceSize = this.db.prepare('SELECT length(source_bytes) AS bytes, length(CAST(context_json AS BLOB)) AS contextBytes FROM engineering_monitoring_sources WHERE dataset_id=? AND project_id=?').get(dataset.id, projectId) as { bytes: number; contextBytes: number } | undefined
          if (!sourceSize) setOutcome('not-evaluated', 'source-unavailable')
          else if (sourceSize.bytes > 32 * 1024 * 1024 || sourceSize.contextBytes > 256 * 1024) setOutcome('not-evaluated', 'resource-limit')
          else {
            const readSource = (): { dataset_id: string; project_id: string; source_hash: string; source_bytes: Buffer; context_json: string; context_hash: string } => {
              const size = this.db.prepare('SELECT length(source_bytes) AS bytes, length(CAST(context_json AS BLOB)) AS contextBytes FROM engineering_monitoring_sources WHERE dataset_id=? AND project_id=?').get(dataset.id, projectId) as { bytes: number; contextBytes: number } | undefined
              if (!size || size.bytes > 32 * 1024 * 1024 || size.contextBytes > 256 * 1024) throw new Error('source size changed')
              const row = this.db.prepare('SELECT * FROM engineering_monitoring_sources WHERE dataset_id=? AND project_id=?').get(dataset.id, projectId) as { dataset_id: string; project_id: string; source_hash: string; source_bytes: Buffer; context_json: string; context_hash: string } | undefined
              if (!row || row.dataset_id !== dataset.id || row.project_id !== projectId || row.source_hash !== dataset.sourceFileHash
                || createHash('sha256').update(row.source_bytes).digest('hex') !== row.source_hash
                || createHash('sha256').update(row.context_json).digest('hex') !== row.context_hash) throw new Error('source mismatch')
              return row
            }
            try {
              const source = readSource()
              const context = JSON.parse(source.context_json) as { datasetId: string; project: unknown; requestedMapping: unknown; fieldMapping: unknown; sourceFileName: string; sourceFileHash: string }
              const importProject = RailwiseProjectV1.parse(context.project), mapping = FieldMappingV1.parse(context.fieldMapping)
              const requestedMapping = context.requestedMapping === null ? undefined : FieldMappingV1.parse(context.requestedMapping)
              if (context.datasetId !== dataset.id || importProject.id !== projectId || context.sourceFileName !== dataset.sourceFileName
                || context.sourceFileHash !== dataset.sourceFileHash || canonicalDeliveryJson(mapping) !== canonicalDeliveryJson(dataset.fieldMapping)) throw new Error('source context mismatch')
              evidence.sourceFileHash = source.source_hash; evidence.sourceContextHash = source.context_hash
              const rows = await parseTabular(context.sourceFileName, source.source_bytes, requestedMapping)
              const normalized = normalizeRows(rows, mapping, importProject, source.source_hash)
              const original = normalized.observations.map(observation => ({ ...observation, datasetId: dataset.id }))
              if (rows.length !== dataset.rowCount || original.length !== dataset.observationCount
                || canonicalDeliveryJson(original) !== canonicalDeliveryJson(dataset.observations)) throw new Error('source observations mismatch')
              // Historical analyses did not record collator options. Even ASCII
              // IDs can sort differently with numeric collation, so do not guess ties.
              const ties = new Set<string>()
              let ambiguous = false
              for (const observation of original) {
                const key = JSON.stringify([observation.monitoringItem, observation.point, monitoringTrendInstant(observation.timestamp).instant])
                if (ties.has(key)) ambiguous = true
                ties.add(key)
              }
              if (ambiguous) setOutcome('not-evaluated', 'ambiguous-tie-order')
              else {
                try {
                  const recomputed = MonitoringAnalysisV1.shape.results.parse(calculateMonitoringAnalysisV2(project, original))
                  evidence.recomputedResultsHash = digest(recomputed)
                  const matches = canonicalDeliveryJson(recomputed) === canonicalDeliveryJson(analysis.results)
                  setOutcome(matches ? 'passed' : 'failed', matches ? 'matched' : 'result-mismatch')
                } catch { setOutcome('failed', 'input-invalid') }
              }
              const latestSource = readSource()
              if (latestSource.context_hash !== source.context_hash || latestSource.source_hash !== source.source_hash) throw new Error('source changed during replay')
            } catch (error) {
              if (error instanceof MonitoringSourceResourceLimitError) setOutcome('not-evaluated', 'resource-limit')
              else setOutcome('failed', 'source-mismatch')
            }
          }
        }
      }
      // Parsing can yield; verify all current bindings and actual output bytes again.
      const after = this.monitoringReplayBindings(projectId, manifestId)
      if (!after.complete || verificationSnapshotHash(before) !== verificationSnapshotHash(after) || !this.checkDeliverable(projectId, manifestId).valid) throw new Error('prerequisites changed during replay')
    } catch {
      status = 'failed'; reasonCode = 'prerequisite-failed'
      for (const evidence of analyses) { evidence.status = 'failed'; evidence.reasonCode = 'prerequisite-failed' }
    }
    const result = MonitoringReplayVerificationV1.parse({ schemaVersion: 1, attemptId: attempt.id, projectId, manifestId,
      checkedAt: this.nowIso(), status, reasonCode, comparisonVersion: 'monitoring-results-exact-1', execution, analyses })
    this.monitoringReplayAudit.finish(attempt, result)
    return result
  }

  readMonitoringDatasetEvidence(projectId: string, datasetId: string): StoredDataset | null {
    const row = this.db.prepare('SELECT id, project_id, revision, data_json FROM engineering_datasets WHERE id = ? AND project_id = ?').get(datasetId, projectId) as { id: string; project_id: string; revision: number; data_json: string } | undefined
    if (!row) return null
    const value = validateStoredDataset(JSON.parse(row.data_json))
    if (value.id !== row.id || value.projectId !== row.project_id || value.revision !== row.revision) throw new Error('monitoring dataset identity mismatch')
    return value
  }

  readMonitoringAnalysisEvidence(projectId: string, analysisId: string): MonitoringAnalysisV1 | null {
    const row = this.db.prepare('SELECT id, project_id, dataset_id, data_json FROM engineering_analyses WHERE id = ? AND project_id = ?').get(analysisId, projectId) as { id: string; project_id: string; dataset_id: string; data_json: string } | undefined
    if (!row) return null
    const value = MonitoringAnalysisV1.parse(JSON.parse(row.data_json))
    if (value.id !== row.id || value.projectId !== row.project_id || value.datasetId !== row.dataset_id) throw new Error('monitoring analysis identity mismatch')
    const dataset = this.readMonitoringDatasetEvidence(projectId, value.datasetId)
    if (!dataset) throw new Error('monitoring dataset unavailable')
    this.assertAnalysisCurrent(this.mustProject(projectId), dataset, value)
    return value
  }

  /** Read an existing receipt only; these paths never start a verification. */
  readDeliverableVerificationEvidence(projectId: string, manifestId: string, checkedAt: string): DeliverableVerificationV1 | null {
    const rows = this.db.prepare("SELECT id, record_hash, data_json FROM engineering_verification_attempts WHERE project_id = ? AND manifest_id = ? AND json_extract(data_json, '$.verification.checkedAt') = ? LIMIT 2").all(projectId, manifestId, checkedAt) as Array<{ id: string; record_hash: string; data_json: string }>
    if (!rows.length) return null
    if (rows.length !== 1) throw new Error('ambiguous verification receipt')
    const row = rows[0]!
    if (createHash('sha256').update(row.data_json).digest('hex') !== row.record_hash) throw new Error('verification receipt integrity mismatch')
    const event = JSON.parse(row.data_json)
    if (event.id !== row.id || event.projectId !== projectId || event.manifestId !== manifestId) throw new Error('verification receipt identity mismatch')
    const lifecycle = this.db.prepare('SELECT phase, occurred_at, record_hash, data_json FROM engineering_verification_events WHERE attempt_id = ?').all(row.id) as Array<{ phase: string; occurred_at: string; record_hash: string; data_json: string }>
    if (lifecycle.length) {
      const start = lifecycle.find(item => item.phase === 'started'), finish = lifecycle.find(item => item.phase === 'finished')
      if (lifecycle.length !== 2 || !start || !finish || lifecycle.some(item => createHash('sha256').update(item.data_json).digest('hex') !== item.record_hash)) throw new Error('verification lifecycle integrity mismatch')
      const began = JSON.parse(start.data_json), ended = JSON.parse(finish.data_json)
      if (began.attemptId !== row.id || began.phase !== 'started' || began.previousHash !== null || began.projectId !== projectId || began.manifestId !== manifestId
        || began.occurredAt !== start.occurred_at || began.occurredAt !== event.startedAt || ended.attemptId !== row.id || ended.phase !== 'finished'
        || ended.occurredAt !== finish.occurred_at || ended.occurredAt !== event.completedAt || ended.previousHash !== start.record_hash
        || ended.terminalId !== row.id || ended.terminalRecordHash !== row.record_hash || ended.outcome !== event.outcome) throw new Error('verification lifecycle identity mismatch')
    }
    const value = DeliverableVerificationV1.parse(event.verification)
    if (value.projectId !== projectId || value.manifestId !== manifestId || value.checkedAt !== checkedAt) throw new Error('verification receipt scope mismatch')
    return value
  }

  readMonitoringReplayEvidence(projectId: string, manifestId: string, attemptId: string, checkedAt: string): MonitoringReplayVerificationV1 | null {
    const rows = this.db.prepare('SELECT phase, occurred_at, record_hash, data_json FROM engineering_monitoring_replay_events WHERE project_id = ? AND manifest_id = ? AND attempt_id = ?').all(projectId, manifestId, attemptId) as Array<{ phase: string; occurred_at: string; record_hash: string; data_json: string }>
    const start = rows.find(row => row.phase === 'started'), finish = rows.find(row => row.phase === 'finished')
    if (!finish) return null
    if (!start || rows.length !== 2 || rows.some(row => createHash('sha256').update(row.data_json).digest('hex') !== row.record_hash)) throw new Error('monitoring replay receipt integrity mismatch')
    const began = JSON.parse(start.data_json), event = JSON.parse(finish.data_json)
    const value = MonitoringReplayVerificationV1.parse(event.result)
    if (began.id !== attemptId || began.projectId !== projectId || began.manifestId !== manifestId || began.phase !== 'started' || began.startedAt !== start.occurred_at
      || event.phase !== 'finished' || event.startedAt !== began.startedAt || finish.occurred_at !== checkedAt
      || event.previousHash !== start.record_hash || event.resultHash !== createHash('sha256').update(JSON.stringify(value)).digest('hex')
      || event.id !== attemptId || event.projectId !== projectId || event.manifestId !== manifestId
      || value.attemptId !== attemptId || value.projectId !== projectId || value.manifestId !== manifestId || value.checkedAt !== checkedAt) throw new Error('monitoring replay receipt identity mismatch')
    return value
  }

  private monitoringReplayBindings(projectId: string, manifestId: string): VerificationBindings & { sqlRows: unknown[] } {
    const binding = this.verificationBindings(projectId, manifestId)
    const sqlRows = binding.engineeringRows.map(({ table, id }) => {
      const row = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string, unknown>
      const value = JSON.parse(row.data_json as string) as Record<string, unknown>
      if (row.id !== value.id || ('project_id' in row && row.project_id !== value.projectId)
        || ('revision' in row && row.revision !== value.revision)
        || ('dataset_id' in row && row.dataset_id !== value.datasetId)) throw new Error('monitoring replay SQL identity mismatch')
      return row
    })
    return { ...binding, sqlRows }
  }

  /** Re-read bytes and recompute evidence without changing checked objects.
   * A durable start survives interruption; terminal and finish commit together. */
  verifyDeliverable(projectId: string, manifestId: string): DeliverableVerificationV1 {
    const attempt = this.verificationAudit.begin(projectId, manifestId)
    let failure: unknown
    let result: DeliverableVerificationV1 | undefined
    this.db.transaction(() => {
      const startedAt = attempt.startedAt
      const before = this.verificationBindings(projectId, manifestId)
      try { result = this.checkDeliverable(projectId, manifestId) }
      catch (error) { failure = error }
      const after = this.verificationBindings(projectId, manifestId)
      const bindingStable = before.complete && after.complete && verificationSnapshotHash(before) === verificationSnapshotHash(after)
      const completedAt = this.nowIso()
      const timeValid = Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(completedAt)) && Date.parse(completedAt) >= Date.parse(startedAt)
      const event = {
        schemaVersion: 1, id: attempt.id, projectId, manifestId,
        startedAt, completedAt, runtimeVersion: this.options.runtimeVersion ?? RUNTIME_VERSION,
        outcome: failure ? 'error' : result?.valid ? 'passed' : 'failed',
        bindingStable: bindingStable && timeValid, bindings: before,
        verification: result ?? null,
        error: failure ? (failure instanceof Error ? failure.message : String(failure)) : null
      }
      const serialized = JSON.stringify(event)
      const terminalHash = createHash('sha256').update(serialized).digest('hex')
      try {
        this.db.prepare('INSERT INTO engineering_verification_attempts (id, project_id, manifest_id, started_at, completed_at, outcome, record_hash, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(event.id, projectId, manifestId, startedAt, completedAt, event.outcome, terminalHash, serialized)
        this.verificationAudit.finish(attempt, completedAt, terminalHash)
      } catch {
        throw new EngineeringVerificationAuditError()
      }
    }).immediate()
    if (failure) throw failure
    return result!
  }

  private verificationBindings(projectId: string, manifestId: string): VerificationBindings {
    const binding: VerificationBindings = { algorithm: 'typed-json-sha256-v1', complete: false, engineeringRows: [], surveyNetworks: [], surveyResults: [], surveyDeformations: [] }
    try {
      const read = (table: string, id: string, projectScoped = true): Record<string, unknown> => {
        // All table names and scoping choices are internal constants below.
        const row = this.db.prepare(`SELECT data_json FROM ${table} WHERE id = ?${projectScoped ? ' AND project_id = ?' : ''}`)
          .get(...(projectScoped ? [id, projectId] : [id])) as { data_json: string } | undefined
        if (!row) throw new Error('verification snapshot record unavailable')
        const value = JSON.parse(row.data_json) as Record<string, unknown>
        if (value.id !== id || (projectScoped && value.projectId !== projectId)) throw new Error('verification snapshot identity mismatch')
        binding.engineeringRows.push({ table, id, hash: verificationSnapshotHash(value) })
        return value
      }
      const manifest = DeliverableManifestV1.parse(read('engineering_manifests', manifestId))
      read('engineering_projects', projectId, false)
      read('engineering_runs', manifest.runId)
      for (const item of manifest.inputDatasets) read('engineering_datasets', item.id)
      for (const id of manifest.analyses) read('engineering_analyses', id)
      const results = new Map(manifest.adjustments.map(item => [item.id, item]))
      for (const epoch of manifest.deformations.flatMap(item => item.epochs)) {
        const matches = this.options.getAdjustmentEvidence?.(projectId, [epoch.adjustmentId])
        if (matches?.length !== 1 || matches[0]!.run.projectId !== projectId || matches[0]!.result.id !== epoch.resultId) throw new Error('verification epoch snapshot unavailable')
        results.set(epoch.resultId, matches[0]!.result)
      }
      binding.surveyResults = [...results.values()].map(item => ({ id: item.id, runId: item.runId, networkId: item.networkId, inputHash: item.inputHash, algorithmVersion: item.algorithmVersion, hash: verificationSnapshotHash(item) }))
      binding.surveyDeformations = manifest.deformations.map(item => ({ id: item.id, hash: verificationSnapshotHash(item) }))
      for (const id of this.requiredSurveyNetworkIds(manifest.adjustments, manifest.deformations)) {
        const network = this.options.getSurveyNetworkSnapshot?.(projectId, id)
        if (!network || network.id !== id || network.projectId !== projectId) throw new Error('verification network snapshot unavailable')
        binding.surveyNetworks.push({ id, hash: verificationSnapshotHash(network) })
      }
      binding.complete = true
    } catch {
      // Missing providers or malformed objects do not suppress the attempt.
      // They make the event ineligible for binding-aware metric numerators.
    }
    return binding
  }

  private checkDeliverable(projectId: string, manifestId: string): DeliverableVerificationV1 {
    const row = this.db.prepare('SELECT data_json FROM engineering_manifests WHERE id = ? AND project_id = ?').get(manifestId, projectId) as { data_json: string } | undefined
    if (!row) throw new Error('deliverable manifest not found in project')
    const manifest = DeliverableManifestV1.parse(JSON.parse(row.data_json))
    if (manifest.id !== manifestId || manifest.projectId !== projectId) throw new Error('deliverable manifest identity mismatch')
    const project = this.mustProject(projectId)
    const checks: DeliverableVerificationV1['checks'] = []
    const check = (id: DeliverableVerificationV1['checks'][number]['id'], action: () => void): void => {
      try { action(); checks.push({ id, status: 'passed' }) }
      catch (error) { checks.push({ id, status: 'failed', detail: error instanceof Error ? error.message : String(error) }) }
    }
    check('manifest', () => this.assertPublishedManifestCurrent(project, manifest))
    check('outputs', () => {
      if (!manifest.outputs.length) throw new Error('deliverable manifest has no output files')
      this.assertDeliveryOutputsCurrent(project, manifest.outputs)
    })
    check('inputs', () => {
      const run = this.getRun(manifest.runId)
      if (!run || run.projectId !== projectId || !run.deliveryInputHash) throw new Error('deliverable run has no bound input snapshot')
      if (manifest.inputDatasets.length !== (run.datasetId ? 1 : 0)
        || manifest.inputDatasets[0]?.id !== run.datasetId
        || manifest.analyses.length !== (run.analysisId ? 1 : 0)
        || manifest.analyses[0] !== run.analysisId) throw new Error('deliverable input bindings do not match the completed run')
      const dataset = run.datasetId ? this.mustDataset(run.datasetId) : undefined
      const analysis = run.analysisId ? this.getAnalysis(run.analysisId) ?? undefined : undefined
      if (dataset && (dataset.projectId !== projectId || dataset.sourceFileHash !== manifest.inputDatasets[0]?.hash)) throw new Error('deliverable dataset source hash mismatch')
      this.assertCompletedRunCurrent(run)
      this.assertDeliveryInputsCurrent(project, dataset, analysis, run.deliveryInputHash)
    })
    if (manifest.adjustments.length || manifest.deformations.length) {
      check('surveyReplay', () => {
        // Production providers call SurveyService's project-scoped strict reader,
        // which recomputes with the recorded algorithm and checks its exact hash.
        const adjustments = this.lookupAdjustments(projectId, manifest.adjustments.map(item => item.id))
        const deformations = this.lookupDeformations(projectId, manifest.deformations.map(item => item.id))
        const segmentComparisons = this.lookupSegmentComparisons(projectId, (manifest.segmentComparisons ?? []).map(item => item.id), adjustments)
        const segmentContinuity = this.lookupSegmentContinuity(projectId, (manifest.segmentContinuity?.comparisonIds ?? []), segmentComparisons)
        this.assertReplayAdjustmentsMatchLive('deliverable verification', adjustments, manifest.adjustments)
        this.assertReplayDeformationsMatchLive('deliverable verification', deformations, manifest.deformations)
        this.assertSegmentComparisonsMatch('deliverable verification', segmentComparisons, manifest.segmentComparisons)
        this.assertSegmentContinuityMatch('deliverable verification', segmentContinuity, manifest.segmentContinuity)
        this.assertDeformationEpochEvidence(projectId, deformations)
      })
      check('sources', () => {
        this.assertSurveySourcesAdmissible(projectId, manifest.adjustments, manifest.deformations)
        const sources = this.lookupSurveySources(projectId, this.requiredSurveyNetworkIds(manifest.adjustments, manifest.deformations))
        if (canonicalDeliveryJson(sources) !== canonicalDeliveryJson(manifest.surveySources)) throw new Error('deliverable source provenance no longer matches its recorded evidence')
      })
    } else {
      checks.push({ id: 'surveyReplay', status: 'not-applicable' }, { id: 'sources', status: 'not-applicable' })
    }
    return DeliverableVerificationV1.parse({ schemaVersion: 1, projectId, manifestId, checkedAt: this.nowIso(),
      valid: checks.every(item => item.status !== 'failed'), reviewStatus: manifest.reviewStatus, checks })
  }

  async finalize(input: unknown): Promise<DeliverableManifestV1> {
    const req = FinalizeDeliverableRequest.parse(input)
    return this.withIdempotencyLock(req.idempotencyKey, async () => {
      const project = this.mustProject(req.projectId)
      const dataset = req.datasetId ? this.mustDataset(req.datasetId) : undefined
      this.assertDeliveryRevision(project, dataset, req.expectedRevision)
      const requestedAdjustments = this.lookupAdjustments(project.id, req.adjustmentIds)
      const requestedDeformations = this.lookupDeformations(project.id, req.deformationIds)
      const requestedSegmentComparisons = this.lookupSegmentComparisons(project.id, req.segmentComparisonIds, requestedAdjustments)
      const requestedSegmentContinuity = this.lookupSegmentContinuity(project.id, req.segmentComparisonIds, requestedSegmentComparisons)
      this.assertDeformationEpochEvidence(project.id, requestedDeformations)
      // Review current evidence before consulting the idempotency store. A
      // successful historical manifest remains readable in its table/files,
      // but it cannot be re-issued after source admission has failed.
      this.assertSurveySourcesAdmissible(project.id, requestedAdjustments, requestedDeformations)
      const replay = this.replayDelivery<DeliverableManifestV1>('deliverable-finalize', req)
      if (replay) {
        const manifest = DeliverableManifestV1.parse(replay)
        if (manifest.projectId !== project.id || manifest.inputDatasets.length !== (dataset ? 1 : 0) || manifest.inputDatasets[0]?.id !== dataset?.id) {
          throw new EngineeringIdempotencyError(manifest, 'stored manifest does not match its bound delivery request')
        }
        const manifestRun = this.getRun(manifest.runId)
        const manifestAnalysisId = manifest.analyses.length === 1 ? manifest.analyses[0] : undefined
        const manifestAnalysis = manifestAnalysisId ? this.getAnalysis(manifestAnalysisId) ?? undefined : undefined
        if (!manifestRun
          || manifestRun.projectId !== project.id
          || manifestRun.datasetId !== dataset?.id
          || manifestRun.analysisId !== manifestAnalysisId
          || !manifestRun.deliveryInputHash
          || (dataset ? manifest.analyses.length !== 1 || !manifestAnalysis : manifest.analyses.length !== 0)) {
          throw new EngineeringIdempotencyError(manifest, 'stored manifest lacks a current bound report-input snapshot')
        }
        this.assertCompletedRunCurrent(manifestRun)
        this.assertDeliveryInputsCurrent(project, dataset, manifestAnalysis, manifestRun.deliveryInputHash)
        this.assertDeliveryOutputsCurrent(project, manifest.outputs)
        this.assertPublishedManifestCurrent(project, manifest)
        this.assertReplayAdjustmentsMatchLive('stored deliverable manifest', requestedAdjustments, manifest.adjustments)
        this.assertReplayDeformationsMatchLive('stored deliverable manifest', requestedDeformations, manifest.deformations)
        this.assertSegmentComparisonsMatch('stored deliverable manifest', requestedSegmentComparisons, manifest.segmentComparisons)
        this.assertSegmentContinuityMatch('stored deliverable manifest', requestedSegmentContinuity, manifest.segmentContinuity)
        this.assertDeformationEpochEvidence(project.id, requestedDeformations)
        this.assertSurveySourcesAdmissible(project.id, requestedAdjustments, requestedDeformations)
        return manifest
      }
      const findings = dataset?.findings.filter((finding) => finding.status === 'open') ?? []
      const blocking = findings.filter((finding) => finding.severity === 'blocking')
      const warnings = findings.filter((finding) => finding.severity === 'warning')
      if (blocking.length) throw new Error(`blocking findings remain: ${blocking.length}`)
      if (warnings.length && !req.acknowledgeWarnings) throw new Error(`warnings require acknowledgement: ${warnings.length}`)

      const preview = await this.previewReport({
        expectedRevision: req.expectedRevision,
        idempotencyKey: `finalize-preview-${req.idempotencyKey}`,
        projectId: project.id,
        datasetId: dataset?.id,
        citations: req.citations,
        adjustmentIds: req.adjustmentIds,
        deformationIds: req.deformationIds,
        segmentComparisonIds: req.segmentComparisonIds,
        ...(req.analysisId ? { analysisId: req.analysisId } : {})
      })
      const previewAnalysis = preview.run.analysisId ? this.getAnalysis(preview.run.analysisId) ?? undefined : undefined
      if ((dataset && !previewAnalysis) || (!dataset && preview.run.analysisId) || !preview.run.deliveryInputHash) {
        throw new Error('preview is missing a bound project/dataset/analysis input snapshot')
      }
      this.assertCompletedRunCurrent(preview.run)
      this.assertDeliveryInputsCurrent(project, dataset, previewAnalysis, preview.run.deliveryInputHash)
      this.assertDeliveryOutputsCurrent(project, preview.files)
      // Re-read complete adjustment and deformation payloads immediately
      // before sealing. This also covers adjustment-only delivery: checking
      // only deformation epochs would otherwise leave a stale standalone
      // adjustment in the manifest.
      const completedAdjustments = this.lookupAdjustments(project.id, req.adjustmentIds)
      const completedDeformations = this.lookupDeformations(project.id, req.deformationIds)
      const completedSegmentComparisons = this.lookupSegmentComparisons(project.id, req.segmentComparisonIds, completedAdjustments)
      const completedSegmentContinuity = this.lookupSegmentContinuity(project.id, req.segmentComparisonIds, completedSegmentComparisons)
      this.assertReplayAdjustmentsMatchLive('finalize before manifest', completedAdjustments, preview.adjustments)
      this.assertReplayDeformationsMatchLive('finalize before manifest', completedDeformations, preview.deformations)
      this.assertSegmentComparisonsMatch('finalize before manifest', completedSegmentComparisons, preview.segmentComparisons)
      this.assertSegmentContinuityMatch('finalize before manifest', completedSegmentContinuity, preview.segmentContinuity)
      this.assertDeformationEpochEvidence(project.id, completedDeformations)
      const sourceReview = this.assertSurveySourcesAdmissible(project.id, completedAdjustments, completedDeformations)
      const completedSurveySources = this.lookupSurveySources(project.id, this.requiredSurveyNetworkIds(completedAdjustments, completedDeformations))

      const outputs = [...preview.files]
      const runId = preview.run.id
      const manifest = DeliverableManifestV1.parse({
        schemaVersion: 1,
        id: `manifest_${randomUUID()}`,
        projectId: project.id,
        runId,
        inputDatasets: dataset ? [{ id: dataset.id, hash: dataset.sourceFileHash }] : [],
        analyses: previewAnalysis ? [previewAnalysis.id] : [],
        adjustments: completedAdjustments,
        deformations: completedDeformations,
        ...(completedSegmentComparisons.length ? { segmentComparisons: completedSegmentComparisons } : {}),
        ...(completedSegmentContinuity ? { segmentContinuity: completedSegmentContinuity } : {}),
        surveySources: completedSurveySources,
        charts: preview.charts,
        citations: req.citations,
        outputs,
        validation: {
          valid: true,
          errors: [],
          warnings: [
            ...warnings.map((finding) => finding.message),
            ...sourceReview.warnings,
            '尚未完成复核、审核、批准与签名流程；该成果清单仅供待审查使用，不得作为已批准交付。'
          ]
        },
        // F-QC-21/22 are not implemented yet.  A materialized manifest is a
        // review candidate, never evidence of an approval that did not occur.
        reviewStatus: 'draft',
        runtimeVersion: this.options.runtimeVersion ?? RUNTIME_VERSION,
        createdAt: this.nowIso(),
        finalizedAt: this.nowIso()
      })
      const path = join(this.outputDir(project, runId), 'manifest.json')
      const stagingPath = this.deliveryManifestStagingPath(project, runId, manifest.id)
      let manifestPublished = false
      try {
        await atomicWriteFile(stagingPath, JSON.stringify(manifest, null, 2))
        // Materialize the manifest out of band, then synchronously re-check
        // and rename it into the public run directory. No stale manifest is
        // observable if its strict survey evidence changed during the write.
        this.publishStagedManifest(stagingPath, path, () => {
          this.assertDeliveryInputsCurrent(project, dataset, previewAnalysis, preview.run.deliveryInputHash!)
          this.assertCompletedRunCurrent(preview.run)
          this.assertDeliveryOutputsCurrent(project, manifest.outputs)
          const persistedAdjustments = this.lookupAdjustments(project.id, req.adjustmentIds)
          const persistedDeformations = this.lookupDeformations(project.id, req.deformationIds)
          const persistedSegmentComparisons = this.lookupSegmentComparisons(project.id, req.segmentComparisonIds, persistedAdjustments)
          const persistedSegmentContinuity = this.lookupSegmentContinuity(project.id, req.segmentComparisonIds, persistedSegmentComparisons)
          this.assertReplayAdjustmentsMatchLive('manifest publication', persistedAdjustments, manifest.adjustments)
          this.assertReplayDeformationsMatchLive('manifest publication', persistedDeformations, manifest.deformations)
          this.assertSegmentComparisonsMatch('manifest publication', persistedSegmentComparisons, manifest.segmentComparisons)
          this.assertSegmentContinuityMatch('manifest publication', persistedSegmentContinuity, manifest.segmentContinuity)
          this.assertDeformationEpochEvidence(project.id, persistedDeformations)
          this.assertSurveySourcesAdmissible(project.id, persistedAdjustments, persistedDeformations)
          this.assertDeliveryInputsCurrent(project, dataset, previewAnalysis, preview.run.deliveryInputHash!)
        })
        manifestPublished = true
        this.assertPublishedManifestCurrent(project, manifest)
        return this.db.transaction(() => {
          this.db.prepare('INSERT INTO engineering_manifests(id, project_id, data_json, created_at) VALUES (?, ?, ?, ?)').run(manifest.id, manifest.projectId, JSON.stringify(manifest), manifest.createdAt)
          const remembered = this.rememberDelivery('deliverable-finalize', req, manifest)
          if (remembered.id !== manifest.id) {
            throw new EngineeringIdempotencyError(remembered, 'delivery idempotency key was claimed while this manifest was publishing')
          }
          return remembered
        }).immediate()
      } catch (error) {
        await rm(stagingPath, { force: true }).catch(() => undefined)
        if (manifestPublished) await rm(path, { force: true }).catch(() => undefined)
        throw error
      }
    })
  }
  getRun(id: string): StoredRun | null { const row = this.db.prepare('SELECT data_json FROM engineering_runs WHERE id = ?').get(id) as { data_json: string } | undefined; return row ? JSON.parse(row.data_json) as StoredRun : null }
  /** Historical descriptors only: this read does not reissue or approve artifacts. */
  getPreviewEvidence(projectId: string, runId: string): { run: StoredRun; files: DeliverableManifestV1['outputs']; segmentComparisons?: SurveySegmentComparisonV1[]; segmentContinuity?: SurveySegmentContinuityV1; adjustments?: AdjustmentResultV1[] } | null {
    const run = this.getRun(runId)
    if (!run || run.projectId !== projectId) return null
    const row = this.db.prepare('SELECT result_json FROM engineering_delivery_idempotency WHERE key = ? AND operation = ?').get(run.idempotencyKey, 'report-preview') as { result_json: string } | undefined
    if (!row) return null
    const stored = JSON.parse(row.result_json) as { run?: StoredRun; files?: unknown; segmentComparisons?: unknown; segmentContinuity?: unknown; adjustments?: unknown }
    if (stored.run?.id !== run.id || stored.run.projectId !== projectId) throw new Error('preview evidence does not match its project/run')
    const segmentComparisons = parseSegmentComparisons(stored.segmentComparisons)
    if (segmentComparisons.some(item => item.projectId !== projectId)) throw new Error('preview comparison evidence project mismatch')
    const segmentContinuity = stored.segmentContinuity === undefined ? undefined : SurveySegmentContinuityV1.parse(stored.segmentContinuity)
    if (segmentContinuity && segmentContinuity.projectId !== projectId) throw new Error('preview continuity evidence project mismatch')
    return { run, files: DeliverableManifestV1.shape.outputs.parse(stored.files), ...(segmentComparisons.length ? { segmentComparisons, adjustments: (stored.adjustments as unknown[] ?? []).map(item => AdjustmentResultV1.parse(item)) } : {}), ...(segmentContinuity ? { segmentContinuity } : {}) }
  }
  cancelRun(id: string, input?: unknown): StoredRun { const mutation = input ? RunMutationRequest.parse(input) : undefined; const replay = mutation ? this.replay(mutation.idempotencyKey) : null; if (replay) return replay as StoredRun; const run = this.getRun(id); if (!run) throw new Error('run not found'); if (mutation && mutation.expectedRevision !== 0 && mutation.expectedRevision !== run.revision) throw new EngineeringRevisionConflictError(`run revision conflict: expected ${mutation.expectedRevision}, actual ${run.revision}`); const next = { ...run, status: 'cancelled' as const, revision: run.revision + 1, updatedAt: this.nowIso() }; this.saveRun(next); if (mutation) this.remember(mutation.idempotencyKey, next); return next }
  resumeRun(id: string, input?: unknown): StoredRun { const mutation = input ? RunMutationRequest.parse(input) : undefined; const replay = mutation ? this.replay(mutation.idempotencyKey) : null; if (replay) return replay as StoredRun; const run = this.getRun(id); if (!run) throw new Error('run not found'); if (mutation && mutation.expectedRevision !== 0 && mutation.expectedRevision !== run.revision) throw new EngineeringRevisionConflictError(`run revision conflict: expected ${mutation.expectedRevision}, actual ${run.revision}`); if (run.status === 'completed') return run; const next = { ...run, status: 'queued' as const, revision: run.revision + 1, updatedAt: this.nowIso(), error: undefined }; this.saveRun(next); if (mutation) this.remember(mutation.idempotencyKey, next); return next }
  private saveRun(run: StoredRun): void { this.db.prepare('UPDATE engineering_runs SET data_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(run), run.updatedAt, run.id) }
  private mustStoredDataset(raw: string): StoredDataset { return this.mustDatasetFromRaw(raw) }
  private mustDatasetFromRaw(raw: string): StoredDataset { return validateStoredDataset(JSON.parse(raw)) }
  private latestChart(analysisId: string): ChartArtifactV1 | null { const row = this.db.prepare('SELECT data_json FROM engineering_charts WHERE analysis_id = ? ORDER BY created_at DESC LIMIT 1').get(analysisId) as { data_json: string } | undefined; return row ? ChartArtifactV1.parse(JSON.parse(row.data_json)) : null }
  private lookupAdjustments(projectId: string, ids: string[]): AdjustmentResultV1[] {
    if (!ids.length) return []
    // A numerical result alone cannot prove it is still the completed run that
    // belongs to this project. Formal preview/finalize must use the live
    // run/result pair, even for a result that was previously persisted.
    if (!this.options.getAdjustmentEvidence) throw new Error('survey adjustment evidence lookup is unavailable')
    const uniqueIds = [...new Set(ids)]
    let evidence: SurveyAdjustmentEvidence[]
    try {
      evidence = this.options.getAdjustmentEvidence(projectId, uniqueIds)
    } catch (error) {
      throw new Error(`survey adjustment evidence lookup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const errors: string[] = []
    const selectedRunIds = new Set<string>()
    const results: AdjustmentResultV1[] = []
    for (const id of uniqueIds) {
      // SurveyService permits reading by either run ID or result ID. Preserve
      // that public compatibility, but reject an ambiguous provider response.
      const matches = evidence.filter((item) => item.run.id === id || item.result.id === id)
      if (matches.length !== 1) {
        errors.push(`平差 ${id} 不存在或不唯一，不能用于正式交付。`)
        continue
      }
      const item = matches[0]!
      if (selectedRunIds.has(item.run.id)) {
        errors.push(`平差 ${id} 与已选择的平差运行 ${item.run.id} 重复，不能作为两份独立交付证据。`)
        continue
      }
      selectedRunIds.add(item.run.id)
      errors.push(...this.adjustmentEvidenceErrors(projectId, item).map((message) => `平差 ${id} ${message}`))
      results.push(item.result)
    }
    if (errors.length) throw new Error(`survey adjustment evidence check failed: ${errors.join('; ')}`)
    return results
  }

  /**
   * Validate live run/result binding before a numerical adjustment can be
   * promoted into a new delivery or deformation evidence chain.  This is
   * intentionally separate from raw-source review: source admission cannot
   * prove that a corrupted result still belongs to that source/run.
   */
  private adjustmentEvidenceErrors(projectId: string, item: SurveyAdjustmentEvidence): string[] {
    const { run, result } = item
    const errors: string[] = []
    if (run.projectId !== projectId) errors.push(`所属项目 ${run.projectId} 与当前项目 ${projectId} 不匹配。`)
    if (run.status !== 'completed') errors.push(`运行状态为 ${run.status}，不是 completed。`)
    if (result.validation !== 'valid') errors.push(`数值结果验证状态为 ${result.validation}，不是 valid。`)
    if (result.runId !== run.id) errors.push(`结果运行编号 ${result.runId} 与实时运行 ${run.id} 不匹配。`)
    if (result.networkId !== run.networkId) errors.push(`结果网络编号 ${result.networkId} 与实时运行网络 ${run.networkId} 不匹配。`)
    if (result.inputHash !== run.inputHash || result.inputHash.length < 32 || run.inputHash.length < 32) {
      errors.push('结果输入哈希与实时运行不匹配或不是有效的 SHA-256 证据。')
    }
    return errors
  }

  /** A replayed artifact is only safe to re-issue when its adjustment payloads still equal the current live evidence. */
  private assertReplayAdjustmentsMatchLive(label: string, live: readonly AdjustmentResultV1[], stored: readonly AdjustmentResultV1[]): void {
    if (live.length !== stored.length) {
      throw new EngineeringIdempotencyError({ label, liveCount: live.length, storedCount: stored.length }, `${label} adjustment evidence count no longer matches the bound request`)
    }
    for (let index = 0; index < live.length; index += 1) {
      const liveHash = createHash('sha256').update(canonicalDeliveryJson(live[index]!)).digest('hex')
      const storedHash = createHash('sha256').update(canonicalDeliveryJson(stored[index]!)).digest('hex')
      if (liveHash !== storedHash) {
        throw new EngineeringIdempotencyError({ label, index, liveHash, storedHash }, `${label} adjustment evidence no longer matches the current completed run`)
      }
    }
  }
  /** Cached reports/manifests are historical artifacts, but may only be re-issued while their complete deformation evidence still matches the live comparison record. */
  private assertReplayDeformationsMatchLive(label: string, live: readonly DeformationComparisonV1[], stored: readonly DeformationComparisonV1[]): void {
    if (live.length !== stored.length) {
      throw new EngineeringIdempotencyError({ label, liveCount: live.length, storedCount: stored.length }, `${label} deformation evidence count no longer matches the bound request`)
    }
    for (let index = 0; index < live.length; index += 1) {
      const liveHash = createHash('sha256').update(canonicalDeliveryJson(live[index]!)).digest('hex')
      const storedHash = createHash('sha256').update(canonicalDeliveryJson(stored[index]!)).digest('hex')
      if (liveHash !== storedHash) {
        throw new EngineeringIdempotencyError({ label, index, liveHash, storedHash }, `${label} deformation evidence no longer matches the current live comparison`)
      }
    }
  }
  private lookupDeformations(projectId: string, ids: string[]): DeformationComparisonV1[] {
    if (!ids.length) return []
    if (!this.options.getDeformations) throw new Error('survey deformation lookup is unavailable')
    const uniqueIds = [...new Set(ids)]
    const results = this.options.getDeformations(projectId, uniqueIds)
    const byId = new Map<string, DeformationComparisonV1[]>()
    for (const result of results) byId.set(result.id, [...(byId.get(result.id) ?? []), result])
    const resolved: DeformationComparisonV1[] = []
    const errors: string[] = []
    for (const id of uniqueIds) {
      const matches = byId.get(id) ?? []
      if (matches.length !== 1) {
        errors.push(`变形成果 ${id} 不存在或不唯一，不能用于正式交付。`)
        continue
      }
      const result = matches[0]!
      if (result.projectId !== projectId) {
        errors.push(`变形成果 ${id} 所属项目 ${result.projectId} 与当前项目 ${projectId} 不匹配。`)
        continue
      }
      if (result.inputHash.length < 32) throw new Error(`survey deformation ${result.id} has an invalid input hash`)
      resolved.push(result)
    }
    if (results.length !== uniqueIds.length || byId.size !== uniqueIds.length || errors.length) {
      throw new Error(`survey deformation lookup failed: ${errors.length ? errors.join('; ') : 'provider returned an unexpected deformation identity set'}`)
    }
    return resolved
  }
  /**
   * A deformation comparison is immutable historical evidence, but it can be
   * selected again for a newly generated delivery. Before doing so, bind every
   * persisted epoch back to its current adjustment run and result. This is
   * deliberately separate from source admission: otherwise a tampered epoch
   * could make us review the wrong network IDs.
   */
  private assertDeformationEpochEvidence(projectId: string, deformations: readonly DeformationComparisonV1[]): void {
    if (!deformations.length) return
    if (!this.options.getAdjustmentEvidence) {
      throw new Error('deformation epoch evidence lookup is unavailable')
    }

    const errors: string[] = []
    for (const deformation of deformations) {
      if (deformation.projectId !== projectId) {
        errors.push(`变形成果 ${deformation.id} 不属于当前项目 ${projectId}`)
        continue
      }
      const epochAdjustmentIds = [...new Set(deformation.epochs.map((epoch) => epoch.adjustmentId))]
      let current: SurveyAdjustmentEvidence[]
      try {
        // The provider must perform a project-scoped lookup. We also inspect
        // the returned run.projectId below so a faulty provider cannot turn a
        // cross-project adjustment into delivery evidence.
        current = this.options.getAdjustmentEvidence(projectId, epochAdjustmentIds)
      } catch (error) {
        errors.push(`变形成果 ${deformation.id} 的实时平差证据读取失败：${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const byAdjustmentId = new Map<string, Array<(typeof current)[number]>>()
      for (const item of current) byAdjustmentId.set(item.run.id, [...(byAdjustmentId.get(item.run.id) ?? []), item])

      for (const epoch of deformation.epochs) {
        const matches = byAdjustmentId.get(epoch.adjustmentId) ?? []
        if (matches.length !== 1) {
          errors.push(`变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} 不存在或不唯一，不能用于新交付。`)
          continue
        }
        const { run, result } = matches[0]!
        errors.push(...this.adjustmentEvidenceErrors(projectId, { run, result }).map((message) => `变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} ${message}`))
        if (run.id !== epoch.adjustmentId) errors.push(`变形成果 ${deformation.id} 的期次平差编号不匹配：${epoch.adjustmentId}`)
        if (run.projectId !== projectId) errors.push(`变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} 不属于当前项目。`)
        if (run.networkId !== epoch.networkId || result.networkId !== epoch.networkId) {
          errors.push(`变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} 网络编号与实时结果不匹配。`)
        }
        if (result.runId !== run.id || result.runId !== epoch.adjustmentId) {
          errors.push(`变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} 与实时结果运行编号不匹配。`)
        }
        if (result.id !== epoch.resultId) errors.push(`变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} 结果编号与实时结果不匹配。`)
        if (run.inputHash !== epoch.inputHash || result.inputHash !== epoch.inputHash) {
          errors.push(`变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} 输入哈希与实时结果不匹配。`)
        }
        const resultHash = createHash('sha256').update(JSON.stringify(result)).digest('hex')
        if (resultHash !== epoch.resultHash) errors.push(`变形成果 ${deformation.id} 的期次平差 ${epoch.adjustmentId} 结果哈希与实时结果不匹配。`)
      }
    }
    if (errors.length) throw new Error(`deformation epoch evidence check failed: ${errors.join('; ')}`)
  }
  private requiredSurveyNetworkIds(adjustments: readonly AdjustmentResultV1[], deformations: readonly DeformationComparisonV1[]): string[] {
    return [...new Set([
      ...adjustments.map((item) => item.networkId),
      ...deformations.flatMap((item) => item.epochs.map((epoch) => epoch.networkId))
    ])]
  }
  private lookupSurveySources(projectId: string, networkIds: string[]): SurveySourceEvidenceV1[] {
    if (!networkIds.length || !this.options.getSurveySources) return []
    const uniqueIds = [...new Set(networkIds)]
    return this.options.getSurveySources(projectId, uniqueIds)
      .filter((item) => Boolean(item.sourceFile))
      .map((item) => SurveySourceEvidenceV1.parse({ networkId: item.networkId, source: item.sourceFile! }))
  }
  private reviewSurveySources(projectId: string, networkIds: string[]): { errors: string[]; warnings: string[] } {
    const uniqueIds = [...new Set(networkIds)]
    if (!uniqueIds.length) return { errors: [], warnings: [] }
    if (!this.options.getSurveySources) return {
      errors: uniqueIds.map((networkId) => `平差网络 ${networkId} 未提供原始资料完整性校验；请从保留的原始文件重新导入并复核后再生成交付清单。`),
      warnings: []
    }

    const byNetworkId = new Map(this.options.getSurveySources(projectId, uniqueIds).map((item) => [item.networkId, item]))
    const errors: string[] = []
    const warnings: string[] = []
    for (const networkId of uniqueIds) {
      const source = byNetworkId.get(networkId)
      if (!source) {
        errors.push(`平差网络 ${networkId} 未提供原始资料来源；请从保留的原始文件重新导入并复核后再生成交付清单。`)
        continue
      }
      errors.push(...sourceFormalizationErrors(networkId, source.sourceFile, source.observations, source.points))
      const sourceEligibility = source.sourceEligibility
      const hasCurrentSourceEligibility = sourceEligibility?.eligible === true && Array.isArray(sourceEligibility.findings)
      if (!hasCurrentSourceEligibility) {
        const findings = Array.isArray(sourceEligibility?.findings)
          ? sourceEligibility.findings.slice(0, 10).map((finding) => `[${finding.code}] ${finding.message}`)
          : []
        errors.push(`平差网络 ${networkId} 未通过当前服务端来源资格校验${findings.length ? `：${findings.join('；')}` : '；服务端未提供可用的来源资格证明。'}`)
      }
      const integrity = source.rawSourceIntegrity
      if (!integrity) {
        errors.push(`平差网络 ${networkId} 未在当前运行时重验原始资料；请从保留的原始文件重新导入并复核后再生成交付清单。`)
        continue
      }
      if (integrity.status !== 'verified') {
        if (integrity.status === 'failed') {
          errors.push(`平差网络 ${networkId} 原始资料完整性校验失败：${integrity.errors.join('；')}`)
        } else {
          errors.push(`平差网络 ${networkId} 为旧结构化/兼容输入，原始资料未验证；请从保留的原始文件重新导入并复核后再生成交付清单。`)
        }
      }
    }
    return { errors, warnings }
  }
  private assertSurveySourcesAdmissible(projectId: string, adjustments: readonly AdjustmentResultV1[], deformations: readonly DeformationComparisonV1[]): { errors: string[]; warnings: string[] } {
    const review = this.reviewSurveySources(projectId, this.requiredSurveyNetworkIds(adjustments, deformations))
    if (review.errors.length) throw new Error(`raw survey source integrity check failed: ${review.errors.join('; ')}`)
    return review
  }
  private assertAnalysisCurrent(project: RailwiseProjectV1, dataset: StoredDataset, analysis: MonitoringAnalysisV1): void {
    if (analysis.projectId !== project.id || analysis.datasetId !== dataset.id) {
      throw new Error('analysis does not belong to the current project and dataset')
    }
    if (analysis.inputHash !== analysisInputHash(project, dataset)) {
      throw new Error('analysis no longer matches the current project thresholds or dataset observations; create a new analysis before generating a report')
    }
  }
  private assertDeliveryRevision(project: RailwiseProjectV1, dataset: StoredDataset | undefined, expectedRevision: number): void {
    if (dataset && dataset.projectId !== project.id) throw new Error('dataset does not belong to project')
    const revision = dataset?.revision ?? project.revision
    if (expectedRevision !== 0 && expectedRevision !== revision) {
      throw new EngineeringRevisionConflictError(`${dataset ? 'dataset' : 'project'} revision conflict: expected ${expectedRevision}, actual ${revision}`)
    }
  }
  /** Re-read every non-survey report input at the publication boundary. */
  private assertDeliveryInputsCurrent(project: RailwiseProjectV1, dataset: StoredDataset | undefined, analysis: MonitoringAnalysisV1 | undefined, expectedSnapshotHash: string): void {
    const currentProject = this.mustProject(project.id)
    const currentDataset = dataset ? this.mustDataset(dataset.id) : undefined
    const currentAnalysis = analysis ? this.getAnalysis(analysis.id) ?? undefined : undefined
    if (currentDataset) {
      if (!currentAnalysis) throw new Error('analysis disappeared before report publication')
      this.assertAnalysisCurrent(currentProject, currentDataset, currentAnalysis)
    } else if (currentAnalysis) throw new Error('monitoring analysis requires a dataset')
    if (deliveryInputSnapshotHash(currentProject, currentDataset, currentAnalysis) !== expectedSnapshotHash) {
      throw new Error('report project, dataset, or analysis input changed during generation; regenerate the report from the current revision')
    }
  }
  /** A replayed preview/manifest cannot revive a cancelled or rewritten run. */
  private assertCompletedRunCurrent(expected: StoredRun): void {
    const durable = this.getRun(expected.id)
    if (!durable
      || durable.status !== 'completed'
      || canonicalDeliveryJson(durable) !== canonicalDeliveryJson(expected)) {
      throw new Error(`delivery run ${expected.id} is no longer the current completed run`)
    }
  }
  /**
   * Manifest hashes describe bytes, not just paths. Re-read every already
   * published output at each formalization/replay boundary so a workspace
   * edit cannot silently pair changed files with old manifest evidence.
   */
  private assertDeliveryOutputsCurrent(project: RailwiseProjectV1, outputs: ReadonlyArray<{ path: string; sha256: string; sizeBytes: number }>): void {
    const root = resolve(project.workspace)
    const deliverableRoot = this.nestedWorkspacePath(project, '.workwise', 'deliverables', project.id)
    const seenPaths = new Set<string>()
    for (const output of outputs) {
      const absolute = resolve(root, output.path)
      const pathFromDeliverables = relative(deliverableRoot, absolute)
      if (!pathFromDeliverables || pathFromDeliverables === '..' || pathFromDeliverables.startsWith(`..${sep}`) || isAbsolute(pathFromDeliverables)) {
        throw new Error(`delivery output path escapes the project deliverable tree: ${output.path}`)
      }
      if (seenPaths.has(absolute)) throw new Error(`delivery output list contains duplicate path: ${output.path}`)
      seenPaths.add(absolute)
      let bytes: Buffer
      try {
        bytes = readFileSync(absolute)
      } catch {
        throw new Error(`delivery output is unavailable: ${output.path}`)
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if (bytes.byteLength !== output.sizeBytes || sha256 !== output.sha256) {
        throw new Error(`delivery output no longer matches its recorded hash: ${output.path}`)
      }
    }
  }
  /**
   * The manifest is the formal public wrapper around otherwise-hashed output
   * files. It is not part of `manifest.outputs`, so verify its exact durable
   * bytes separately before returning a fresh or idempotently replayed seal.
   */
  private assertPublishedManifestCurrent(project: RailwiseProjectV1, expected: DeliverableManifestV1): void {
    const publishedPath = join(this.outputDir(project, expected.runId), 'manifest.json')
    let bytes: Buffer
    try {
      bytes = readFileSync(publishedPath)
    } catch {
      throw new Error(`published manifest is unavailable: ${publishedPath}`)
    }
    try {
      DeliverableManifestV1.parse(JSON.parse(bytes.toString('utf8')))
    } catch {
      throw new Error(`published manifest is malformed: ${publishedPath}`)
    }
    const expectedBytes = Buffer.from(JSON.stringify(expected, null, 2))
    if (!bytes.equals(expectedBytes)) {
      throw new Error('published manifest no longer matches its durable manifest evidence')
    }
  }
  private getAnalysis(id: string): MonitoringAnalysisV1 | null { const row = this.db.prepare('SELECT data_json FROM engineering_analyses WHERE id = ?').get(id) as { data_json: string } | undefined; return row ? MonitoringAnalysisV1.parse(JSON.parse(row.data_json)) : null }
  private getChart(id: string): ChartArtifactV1 | null { const row = this.db.prepare('SELECT data_json FROM engineering_charts WHERE id = ?').get(id) as { data_json: string } | undefined; return row ? ChartArtifactV1.parse(JSON.parse(row.data_json)) : null }
  private mustProject(id: string): RailwiseProjectV1 { const project = this.getProject(id); if (!project) throw new Error(`project not found: ${id}`); return project }
  private mustDataset(id: string): StoredDataset { const row = this.db.prepare('SELECT data_json FROM engineering_datasets WHERE id = ?').get(id) as { data_json: string } | undefined; if (!row) throw new Error(`dataset not found: ${id}`); return validateStoredDataset(JSON.parse(row.data_json)) }
  private saveDataset(dataset: StoredDataset): void { this.db.prepare('UPDATE engineering_datasets SET revision = ?, data_json = ?, updated_at = ? WHERE id = ?').run(dataset.revision, JSON.stringify(dataset), dataset.updatedAt, dataset.id) }
  private async persistMetadata(workspace: string, kind: string, id: string, value: unknown): Promise<void> { const root = resolve(workspace); const directory = resolve(root, '.workwise', 'engineering', kind); if (!(directory === root || directory.startsWith(`${root}/`))) throw new Error('workspace containment violation'); await mkdir(directory, { recursive: true }); await atomicWriteFile(join(directory, `${id}.json`), JSON.stringify(value, null, 2)) }
  private trackMetadataPersistence(workspace: string, kind: string, id: string, value: unknown): void {
    const pending = this.persistMetadata(workspace, kind, id, value)
    this.pendingMetadataWrites.add(pending)
    void pending.finally(() => this.pendingMetadataWrites.delete(pending)).catch(() => undefined)
  }
  private nestedWorkspacePath(project: RailwiseProjectV1, ...segments: string[]): string {
    const root = resolve(project.workspace)
    const candidate = resolve(root, ...segments)
    const pathFromRoot = relative(root, candidate)
    if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error('workspace containment violation')
    }
    return candidate
  }
  private outputDir(project: RailwiseProjectV1, runId: string): string {
    return this.nestedWorkspacePath(project, '.workwise', 'deliverables', project.id, runId)
  }
  /** Staging is deliberately a sibling of, never a child of, public deliverables. */
  private deliveryStagingDir(project: RailwiseProjectV1, runId: string): string {
    return this.nestedWorkspacePath(project, '.workwise', '.staging', 'deliverables', project.id, runId)
  }
  private deliveryManifestStagingPath(project: RailwiseProjectV1, runId: string, manifestId: string): string {
    return this.nestedWorkspacePath(project, '.workwise', '.staging', 'manifests', project.id, runId, `${manifestId}.json`)
  }
  /**
   * The verifier and directory rename intentionally run without an `await`
   * between them. Survey callbacks are synchronous strict readers, so no
   * in-process writer can interleave after evidence has been checked and
   * before staged bytes become part of the public delivery tree.
   */
  private publishStagedDeliveryDirectory(stagingDir: string, outputDir: string, verify: () => void): void {
    if (!existsSync(stagingDir)) throw new Error('delivery staging directory is unavailable')
    if (existsSync(outputDir)) throw new Error('delivery output directory already exists')
    mkdirSync(resolve(outputDir, '..'), { recursive: true })
    verify()
    renameSync(stagingDir, outputDir)
  }
  /** Same synchronous publication boundary for a final manifest file. */
  private publishStagedManifest(stagingPath: string, outputPath: string, verify: () => void): void {
    if (!existsSync(stagingPath)) throw new Error('delivery manifest staging file is unavailable')
    if (existsSync(outputPath)) throw new Error('delivery manifest already exists')
    mkdirSync(resolve(outputPath, '..'), { recursive: true })
    verify()
    renameSync(stagingPath, outputPath)
  }
  /**
   * Delivery replay is intentionally separate from the historical generic
   * idempotency table.  The latter contains bare results written before a
   * request fingerprint existed, so replaying one could attach a report or
   * manifest to different adjustment/deformation provenance.
   */
  private replayDelivery<T>(operation: DeliveryIdempotencyOperation, request: DeliveryIdempotencyRequest): T | null {
    const fingerprint = deliveryRequestFingerprint(operation, request)
    const row = this.db.prepare('SELECT operation, request_hash, result_json FROM engineering_delivery_idempotency WHERE key = ?').get(request.idempotencyKey) as DeliveryIdempotencyRow | undefined
    if (row) {
      if (row.operation !== operation || row.request_hash !== fingerprint) {
        throw new EngineeringIdempotencyError({ operation, fingerprint, storedOperation: row.operation, storedFingerprint: row.request_hash })
      }
      return JSON.parse(row.result_json) as T
    }

    // Preserve legacy rows for historical audit/read APIs, but a delivery
    // endpoint must never re-issue an artifact whose original request cannot
    // be verified exactly.
    const legacy = this.db.prepare('SELECT key FROM engineering_idempotency WHERE key = ?').get(request.idempotencyKey) as { key: string } | undefined
    if (legacy) {
      throw new EngineeringIdempotencyError({ operation, fingerprint, legacyKey: legacy.key }, 'idempotency key refers to a legacy unbound result and cannot re-issue a delivery')
    }
    return null
  }
  private rememberDelivery<T>(operation: DeliveryIdempotencyOperation, request: DeliveryIdempotencyRequest, value: T): T {
    const fingerprint = deliveryRequestFingerprint(operation, request)
    const inserted = this.db.prepare('INSERT OR IGNORE INTO engineering_delivery_idempotency(key, operation, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(request.idempotencyKey, operation, fingerprint, JSON.stringify(value), this.nowIso())
    if (inserted.changes === 1) return value
    const replay = this.replayDelivery<T>(operation, request)
    if (replay !== null) return replay
    throw new EngineeringIdempotencyError({ operation, fingerprint }, 'delivery idempotency record could not be stored')
  }
  private replay(key: string): unknown | null { const row = this.db.prepare('SELECT result_json FROM engineering_idempotency WHERE key = ?').get(key) as { result_json: string } | undefined; return row ? JSON.parse(row.result_json) : null }
  private remember(key: string, value: unknown): void { this.db.prepare('INSERT OR IGNORE INTO engineering_idempotency(key, result_json, created_at) VALUES (?, ?, ?)').run(key, JSON.stringify(value), this.nowIso()) }
  private async withIdempotencyLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.idempotencyLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolveGate) => { release = resolveGate })
    const queued = previous.then(() => gate)
    this.idempotencyLocks.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.idempotencyLocks.get(key) === queued) this.idempotencyLocks.delete(key)
    }
  }
}

function validateStoredDataset(value: unknown): StoredDataset { return value as StoredDataset }

const ALIASES: Record<keyof zInferMapping, string[]> = {
  project: ['project', '项目', '工程'], period: ['period', '周期', '期次'], monitoringItem: ['monitoringItem', '监测项', '监测项目', '类型'], point: ['point', '测点', '测点编号', '点号'], timestamp: ['timestamp', 'time', '时间', '日期'], value: ['value', '当前变化', '数值', '观测值'], unit: ['unit', '单位'], cumulative: ['cumulative', '累计变化'], rate: ['rate', '速率'], warningThreshold: ['warningThreshold', '预警阈值', '预警'], alarmThreshold: ['alarmThreshold', '报警阈值', '报警'], controlThreshold: ['controlThreshold', '控制阈值', '控制'], valid: ['valid', '有效性'], note: ['note', '备注']
}
type zInferMapping = { project?: string; period?: string; monitoringItem?: string; point?: string; timestamp?: string; value?: string; unit?: string; cumulative?: string; rate?: string; warningThreshold?: string; alarmThreshold?: string; controlThreshold?: string; valid?: string; note?: string }
function inferMapping(row: Row): FieldMappingV1 { const keys = Object.keys(row); const out: Record<string, string> = {}; for (const [canonical, aliases] of Object.entries(ALIASES)) { const found = keys.find((key) => aliases.some((alias) => key.trim().toLowerCase() === alias.toLowerCase())); if (found) out[canonical] = found } return FieldMappingV1.parse(out) }
function parseMonitoringNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}
function normalizeRows(rows: Row[], mapping: FieldMappingV1, project: RailwiseProjectV1, sourceHash: string): { observations: MonitoringObservationV1[]; findings: QualityFindingV1[]; unknownColumns: string[]; columnCount: number; timeRange: { start?: string; end?: string } } {
  const known = new Set(Object.values(mapping).filter(Boolean)); const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]; const unknownColumns = columns.filter((key) => !known.has(key) && !key.startsWith('__')); const observations: MonitoringObservationV1[] = []; const findings: QualityFindingV1[] = []; let start: string | undefined; let end: string | undefined; let firstInstant = Infinity; let lastInstant = -Infinity; const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const point = mapping.point ? row[mapping.point] : ''; const item = mapping.monitoringItem ? row[mapping.monitoringItem] : project.monitoringType; const timestamp = mapping.timestamp ? row[mapping.timestamp] : ''; const rawValue = mapping.value ? row[mapping.value] : ''; const value = parseMonitoringNumber(rawValue);
    if (!point || !timestamp) findings.push(finding(`missing-${i}`, 'missing_identifier', 'blocking', i + 2, '缺少测点或时间', '补齐测点编号和时间'));
    if (!rawValue?.trim()) findings.push(finding(`missing-value-${i}`, 'missing_value', 'blocking', i + 2, '缺少观测数值', '补齐数值字段'));
    else if (value === undefined) findings.push(finding(`number-${i}`, 'invalid_number', 'blocking', i + 2, '数值无效', '修正数值字段'));
    let instant: number | undefined
    if (timestamp) {
      try { instant = monitoringTrendInstant(timestamp).instant }
      catch { findings.push(finding(`time-invalid-${i}`, 'time_order', 'blocking', i + 2, '时间格式无效', '使用 ISO 8601 日期或时间；未标时区按 UTC')) }
    }
    const key = JSON.stringify([item, point, instant ?? timestamp]); if (seen.has(key)) findings.push(finding(`duplicate-${i}`, 'duplicate_observation', 'warning', i + 2, '存在重复观测', '确认是否保留其中一条')); seen.add(key);
    if (value !== undefined && point && timestamp) {
      const obs = MonitoringObservationV1.parse({ schemaVersion: 1, id: `obs_${sourceHash.slice(0, 12)}_${i}`, projectId: project.id, datasetId: 'pending', monitoringItem: item || project.monitoringType, point, timestamp, value, unit: mapping.unit ? row[mapping.unit] : project.unit, cumulative: mapping.cumulative ? parseMonitoringNumber(row[mapping.cumulative]) : undefined, rate: mapping.rate ? parseMonitoringNumber(row[mapping.rate]) : undefined, sourceRow: i + 2, sourceFields: row }); observations.push(obs)
      if (instant !== undefined && instant < firstInstant) { start = timestamp; firstInstant = instant }
      if (instant !== undefined && instant > lastInstant) { end = timestamp; lastInstant = instant }
    }
  }
  if (rows.length > 500_000) findings.push(finding('row-limit', 'row_limit', 'blocking', 1, '观测记录超过 500,000 条运行上限', '拆分文件或缩小运行范围'))
  if (Object.keys(project.thresholds).length === 0) findings.push(finding('threshold-missing', 'missing_threshold', 'warning', 1, '项目未配置阈值', '在项目设置中补充阈值'))
  return { observations, findings, unknownColumns, columnCount: columns.filter((key) => !key.startsWith('__')).length, timeRange: { ...(start ? { start } : {}), ...(end ? { end } : {}) } }
}
function mergeFindings(existing: QualityFindingV1[], generated: QualityFindingV1[]): QualityFindingV1[] {
  const byKey = new Map<string, QualityFindingV1>()
  for (const item of [...existing, ...generated]) {
    const key = `${item.code}|${item.row ?? 0}|${item.message}`
    const previous = byKey.get(key)
    // Keep a user resolution/acceptance if a re-check produces the same finding.
    byKey.set(key, previous && previous.status !== 'open' ? previous : item)
  }
  return [...byKey.values()]
}
function finding(id: string, code: QualityFindingV1['code'], severity: QualityFindingV1['severity'], row: number, message: string, suggestion: string, createdAt = new Date().toISOString()): QualityFindingV1 { return QualityFindingV1.parse({ schemaVersion: 1, id, datasetId: 'pending', code, severity, row, message, suggestion, status: 'open', createdAt }) }
function runQualityChecks(observations: MonitoringObservationV1[], project: RailwiseProjectV1, nowIso: () => string): QualityFindingV1[] {
  const findings: QualityFindingV1[] = []
  const byPoint = new Map<string, MonitoringObservationV1[]>()
  const instants = new Map<string, number>(), seen = new Set<string>()
  for (const obs of observations) {
    const key = JSON.stringify([obs.monitoringItem, obs.point])
    const list = byPoint.get(key) ?? []
    list.push(obs)
    byPoint.set(key, list)
    try {
      const instant = monitoringTrendInstant(obs.timestamp).instant
      instants.set(obs.id, instant)
      const identity = JSON.stringify([obs.monitoringItem, obs.point, instant])
      if (seen.has(identity)) findings.push(finding(`duplicate-${obs.id}`, 'duplicate_observation', 'warning', obs.sourceRow, '存在重复观测', '确认是否保留其中一条', nowIso()))
      seen.add(identity)
    } catch { findings.push(finding(`time-invalid-${obs.id}`, 'time_order', 'blocking', obs.sourceRow, '时间格式无效', '使用 ISO 8601 日期或时间；未标时区按 UTC', nowIso())) }
    if (obs.unit && obs.unit !== project.unit) findings.push(finding(`unit-${obs.id}`, 'unit_conflict', 'warning', obs.sourceRow, `单位 ${obs.unit} 与项目单位 ${project.unit} 不一致`, '统一单位后重新校核', nowIso()))
  }
  for (const list of byPoint.values()) {
    for (let i = 1; i < list.length; i += 1) {
      const current = instants.get(list[i].id), previous = instants.get(list[i - 1].id)
      if (current !== undefined && previous !== undefined && current < previous) findings.push(finding(`time-${list[i].id}`, 'time_order', 'warning', list[i].sourceRow, '时间顺序异常', '按时间升序整理', nowIso()))
    }
  }
  if (Object.keys(project.thresholds).length === 0) findings.push(finding('threshold-missing', 'missing_threshold', 'warning', 1, '项目未配置阈值', '在项目设置中补充阈值', nowIso()))
  return findings
}
/**
 * Parse the three tabular formats advertised by the engineering workbench.
 * JSON is intentionally normalised into the same row representation as CSV
 * and XLSX so field mapping, provenance and quality checks stay deterministic.
 */
async function parseTabular(name: string, bytes: Buffer, requestedMapping?: FieldMappingV1): Promise<Row[]> {
  const extension = extname(name).toLowerCase()
  if (extension === '.xlsx') return parseXlsx(bytes, requestedMapping)
  if (extension === '.json') return parseJsonRows(bytes)
  return parseCsv(bytes)
}

function parseJsonRows(bytes: Buffer): Row[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`invalid JSON dataset: ${error instanceof Error ? error.message : String(error)}`)
  }
  const candidate = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? (() => {
        const object = parsed as Record<string, unknown>
        for (const key of ['rows', 'data', 'records', 'observations']) {
          if (Array.isArray(object[key])) return object[key]
        }
        return undefined
      })()
      : undefined
  if (!candidate) throw new Error('JSON dataset must be an array or an object containing rows, data, records, or observations')
  if (candidate.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('JSON dataset rows must be objects')
  }
  return candidate.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  ])))
}
function parseCsv(bytes: Buffer): Row[] { const text = decodeText(bytes).replace(/^\uFEFF/, ''); const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0); if (!lines.length) return []; const rows = lines.map(parseCsvLine); const headers = rows[0].map((h) => h.trim()); return rows.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']))) }
function parseCsvLine(line: string): string[] { const out: string[] = []; let current = ''; let quoted = false; for (let i = 0; i < line.length; i += 1) { const c = line[i]; if (c === '"' && line[i + 1] === '"') { current += '"'; i += 1 } else if (c === '"') quoted = !quoted; else if (c === ',' && !quoted) { out.push(current); current = '' } else current += c } out.push(current); return out }
function decodeText(bytes: Buffer): string { const utf8 = bytes.toString('utf8').replace(/^\uFEFF/, ''); if (!utf8.includes('\uFFFD')) return utf8; try { return new TextDecoder('gb18030').decode(bytes) } catch { return utf8 } }
class MonitoringSourceResourceLimitError extends Error {
  constructor() { super('monitoring XLSX exceeds the resource limit (32 MiB expanded, 200:1 compression, 2048 entries, 16384 columns)') }
}
async function parseXlsx(bytes: Buffer, requestedMapping?: FieldMappingV1): Promise<Row[]> {
  const zip = await JSZip.loadAsync(bytes, { createFolders: false })
  if (Object.keys(zip.files).length > 2048) throw new MonitoringSourceResourceLimitError()
  let expandedBytes = 0
  const readText = async (entry: JSZip.JSZipObject): Promise<string> => {
    const chunks: Buffer[] = []
    // Count actual output from the public stream API, never archive-declared sizes.
    const stream = entry.nodeStream('nodebuffer') as import('node:stream').Readable
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (raw: Buffer) => {
        expandedBytes += raw.length
        if (expandedBytes > 32 * 1024 * 1024 || expandedBytes > bytes.length * 200) {
          // JSZip's legacy adapter must pause via backpressure: destroying it
          // during a data callback can push the remaining inflate chunk after EOF.
          stream.pause(); chunks.length = 0
          reject(new MonitoringSourceResourceLimitError())
          return
        }
        chunks.push(raw)
      })
      stream.once('error', reject)
      stream.once('end', resolve)
    })
    return Buffer.concat(chunks).toString('utf8')
  }
  const sharedText = zip.file('xl/sharedStrings.xml') ? await readText(zip.file('xl/sharedStrings.xml')!) : ''
  const shared = [...sharedText.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((text) => decodeXml(text[1])).join('')
  )
  const sheetNames = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
  if (!sheetNames.length) throw new Error('xlsx has no worksheet')
  const output: Row[] = []
  let observationSheetCount = 0
  for (const sheetName of sheetNames) {
    const sheet = zip.file(sheetName)
    if (!sheet) continue
    const xml = await readText(sheet)
    const rows: string[][] = []
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = []
      for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const reference = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1]
        if (!reference) continue
        if (reference.length > 3) throw new MonitoringSourceResourceLimitError()
        const col = lettersToIndex(reference)
        if (col >= 16384) throw new MonitoringSourceResourceLimitError()
        const type = cell[1].match(/\bt="([^"]+)"/)?.[1]; const body = cell[2]
        const value = decodeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '')
        cells[col] = type === 's' ? (shared[Number(value)] ?? value) : value
      }
      rows.push(cells)
    }
    const headers = (rows[0] ?? []).map((v, i) => v.trim() || `column_${i + 1}`)
    const headerRow = Object.fromEntries(headers.map((header) => [header, '']))
    const sheetMapping = FieldMappingV1.parse({ ...inferMapping(headerRow), ...(requestedMapping ?? {}) })
    if (!hasRequiredObservationColumns(headers, sheetMapping)) continue
    observationSheetCount += 1
    for (const cells of rows.slice(1)) {
      output.push({ ...Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ''])), __worksheet: sheetName })
    }
  }
  if (observationSheetCount === 0) throw new Error('xlsx has no worksheet containing point, timestamp, and value columns')
  return output
}
function hasRequiredObservationColumns(headers: string[], mapping: FieldMappingV1): boolean {
  const headerSet = new Set(headers)
  return [mapping.point, mapping.timestamp, mapping.value].every((column) => Boolean(column && headerSet.has(column)))
}
function lettersToIndex(value: string): number { let n = 0; for (const c of value) n = n * 26 + c.charCodeAt(0) - 64; return n - 1 }
function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (entity, hex: string) => decodeCodePoint(entity, Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (entity, decimal: string) => decodeCodePoint(entity, Number.parseInt(decimal, 10)))
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
}
function decodeCodePoint(entity: string, codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : entity
}
function reportText(project: RailwiseProjectV1, dataset: StoredDataset | undefined, analysis: MonitoringAnalysisV1 | undefined, citations: KnowledgeCitationV1[] = [], adjustments: AdjustmentResultV1[] = [], deformations: DeformationComparisonV1[] = [], surveySources: SurveySourceEvidenceV1[] = []): string {
  const monitoringReport = dataset ? buildMonitoringProfessionalReport({ project, dataset, analysis, generatedAt: new Date().toISOString() }) : undefined
  const period = project.reportPeriod.start || project.reportPeriod.end
    ? `${project.reportPeriod.start ?? '-'} ~ ${project.reportPeriod.end ?? '-'}`
    : `${dataset?.timeRange.start ?? '-'} ~ ${dataset?.timeRange.end ?? '-'}`
  const thresholdLines = Object.entries(project.thresholds).map(([name, value]) => `${name}: ${value} ${project.unit}`)
  const measurement = (value: number | undefined, unit: string): string => value === undefined ? '-' : `${value} ${unit}`
  const statisticalUnit = (unit: 'dimensionless' | 'sigma'): string => unit === 'dimensionless' ? '无量纲' : 'sigma'
  const taskLabels = { 'control-network': '控制网', 'leveling-network': '水准网', 'traverse-network': '导线网', resection: '任意设站', deformation: '变形监测', gnss: 'GNSS' }
  const taskType = project.taskType ?? inferEngineeringTaskType(project.monitoringType)
  const signLabels: Record<string, string> = { positive: '正值为正向变形', negative: '负值为正向变形', custom: '自定义（以项目约定为准）' }
  const trendLabels = { rising: '上升', falling: '下降', stable: '稳定', unknown: '待确认' }
  const thresholdLabels = { normal: '正常', warning: '提示', alarm: '报警', control: '控制', unresolved: '待确认' }
  return [
    `项目：${project.name}`,
    ...(dataset ? [
    '监测分析报告（待审查）',
    `任务类型：${taskType ? taskLabels[taskType] : project.monitoringType}`,
    `报告周期：${period}`,
    `单位：${project.unit}；符号约定：${signLabels[project.signConvention] ?? project.signConvention}`,
    `数据来源：${dataset.sourceFileName}`,
    `源文件 SHA-256：${dataset.sourceFileHash}`,
    `字段映射：${JSON.stringify(dataset.fieldMapping)}`,
    `观测记录：${dataset.observationCount}（原始行 ${dataset.rowCount}，列 ${dataset.columnCount}）`,
    ] : ['测量平差成果报告（待审查）', '单位：长度 m；角度 rad；统计量按各项标注。']),
    '',
    '专业测量源文件',
    ...(surveySources.length ? surveySources.map(({ networkId, source }) => `网络 ${networkId}: ${source.name}；厂商=${source.detection.vendor}；格式=${source.detection.format}${source.detection.version ? ` ${source.detection.version}` : ''}；置信度=${Math.round(source.detection.confidence * 100)}%；状态=${source.disposition}；解析器=${source.parserId}/${source.parserVersion}；SHA-256=${source.sha256}${source.converter ? `；转换器=${source.converter.id}/${source.converter.version}（${source.converter.status}，网络=${source.converter.networkAccess}）` : ''}`) : ['本报告关联的平差网络未记录专业源文件，可能来自结构化或旧版兼容输入']),
    '',
    ...(analysis ? ['阈值配置',
    ...(thresholdLines.length ? thresholdLines : ['待确认']),
    '',
    '分析结果',
    ...analysis.results.map((r) => { const unit = r.unit ?? project.unit; const unitStatus = r.unitStatus === 'source-differs' ? '来源单位与项目单位不一致' : r.unitStatus === 'conflict' ? '历史记录单位冲突' : r.unitStatus === 'aligned' ? '已与项目单位统一' : '单位状态未记录'; const historicalSuffix = r.unitStatus === undefined ? '；历史分析未记录单位状态，结论待复核' : ''; return `${r.monitoringItem} / ${r.point}: 当前=${measurement(r.currentValue, unit)} 上期=${measurement(r.previousValue, unit)} 累计=${measurement(r.cumulativeChange, unit)} 速率=${measurement(r.changeRate, `${unit}/d`)} 趋势=${trendLabels[r.trend]} 异常=${r.anomaly ? '是' : '否'} 阈值=${thresholdLabels[r.thresholdStatus]} 单位状态=${unitStatus}${historicalSuffix}` }),
    `分析输入 SHA-256：${analysis.inputHash}`,
    `算法版本：${analysis.algorithmVersion}`,
    ] : []),
    ...(monitoringReport ? ['', '监测日报专业表', '监测项 | 测点 | 初始期/值 | 上期/值 | 本期/值 | 本次变化 | 累计变化 | 累计口径 | 速率 | 阈值状态 | 连续性 | 来源/项目单位 | 单位状态 | 原始行', ...monitoringReport.rows.map((row) => [row.monitoringItem, row.point, `${row.initialTimestamp} / ${row.initialValue} ${row.initialUnit ?? row.unit}`, row.previousTimestamp ? `${row.previousTimestamp} / ${row.previousValue} ${row.previousUnit ?? row.unit}` : '不可用', `${row.currentTimestamp} / ${row.currentValue} ${row.unit}`, row.periodChange === undefined ? '不可用' : `${row.periodChange} ${row.unit}`, row.cumulativeChange === undefined ? '不可用' : `${row.cumulativeChange} ${row.unit}`, row.cumulativeBasis === 'source-cumulative' ? '来源累计字段' : row.cumulativeBasis === 'observed-value' ? '观测值首末差' : row.cumulativeBasis === 'mixed-unavailable' ? '累计字段混用，待确认' : '未记录', row.ratePerDay === undefined ? '不可用' : `${row.ratePerDay} ${row.unit}/d`, row.thresholdStatus, row.continuity, row.unitAlignment === 'source-differs' ? `来源≠项目（${row.unit}/${row.projectUnit ?? '未记录'}）` : row.unitAlignment === 'not-declared' ? '来源未声明' : row.unitAlignment === 'aligned' ? '一致' : '未记录', row.unitStatus === 'conflict' ? `冲突（${row.unitConflictUnits?.join('/') ?? '待确认'}）` : '一致', row.sourceRows.join(',')].join(' | '))] : []),
    '',
    '测量平差结果',
    ...(adjustments.length ? adjustments.flatMap((adjustment) => [
      `平差运行 ${adjustment.runId}：网络=${adjustment.networkId}，策略=${adjustment.strategyId ?? 'legacy'}${adjustment.transformType ? `/${adjustment.transformType}` : ''}，观测=${adjustment.observationCount}，未知数=${adjustment.unknownCount}，多余观测=${adjustment.redundancy}`,
      `单位权中误差=${adjustment.unitWeightStdDev}（${statisticalUnit(adjustment.unitWeightStdDevUnit)}）；方差因子=${adjustment.varianceFactor}（${statisticalUnit(adjustment.varianceFactorUnit)}，${adjustment.varianceFactorEstimated ? '后验估计' : '先验值'}），最大点位中误差=${adjustment.precision.maxPointStdDev} ${adjustment.linearUnit}，状态=${adjustment.validation}，输入 SHA-256=${adjustment.inputHash}`,
      ...statisticalReportLines(adjustment),
      `历史结果量=${Object.entries(adjustment.closure).map(([key, value]) => `${key}:${value} ${adjustment.closureUnits[key] ?? '单位未记录'}`).join('；') || '无'}（独立闭合检核见专业成果表；残差范数不等同闭合差）`,
      `解算参数=${Object.entries(adjustment.parameters).map(([key, value]) => `${key}:${value} ${adjustment.parameterUnits[key] ?? '单位未记录'}`).join('；') || '无'}`,
      ...(adjustment.points.length ? adjustment.points.map((point) => `点位 ${point.id}: X=${measurement(point.x, adjustment.linearUnit)} Y=${measurement(point.y, adjustment.linearUnit)} H=${measurement(point.height, adjustment.linearUnit)}${point.latitude === undefined ? '' : ` B=${point.latitude}°`}${point.longitude === undefined ? '' : ` L=${point.longitude}°`}`) : ['点位成果：无']),
      ...adjustment.points.flatMap((point) => point.xyErrorEllipse ? [`点位 ${point.id} XY 标准误差椭圆：长半轴=${point.xyErrorEllipse.semiMajor} m；短半轴=${point.xyErrorEllipse.semiMinor} m；轴向=${point.xyErrorEllipse.orientationRad === null ? '无唯一轴向' : `${point.xyErrorEllipse.orientationRad} rad`}（+X 转向 +Y，模 π）；${point.xyErrorEllipse.varianceBasis === 'a-posteriori' ? '后验方差' : '先验方差'}；单位马氏半径，非置信百分比；解算 XY 平面，GNSS 不代表当地东/北；算法=${point.xyErrorEllipse.algorithmVersion}`] : []),
      ...(adjustment.displacements.length ? adjustment.displacements.map((item) => `位移 ${item.pointId}: dX=${measurement(item.dX, adjustment.linearUnit)} dY=${measurement(item.dY, adjustment.linearUnit)} dH=${measurement(item.dH, adjustment.linearUnit)} 模长=${measurement(item.magnitude, adjustment.linearUnit)}`) : ['位移结果：无可用初始坐标/高程'])
    ]) : ['本报告未关联测量平差运行']),
    '',
    '变形期次比较',
    ...(deformations.length ? deformations.flatMap((comparison) => [
      `比较 ${comparison.id}: ${comparison.referenceEpoch} → ${comparison.currentEpoch}（${comparison.durationDays} d），算法=${comparison.algorithmVersion}，输入 SHA-256=${comparison.inputHash}`,
      ...comparison.points.map((point) => `测点 ${point.pointId}: dX=${measurement(point.dX, point.unit)} dY=${measurement(point.dY, point.unit)} dH=${measurement(point.dH, point.unit)} 沉降=${measurement(point.settlement, point.unit)} 水平位移=${measurement(point.horizontalDisplacement, point.unit)} 三维位移=${measurement(point.spatialDisplacement, point.unit)} 速率=${measurement(point.rates.spatialPerDay, point.rateUnit)} 趋势=${point.trend}${point.standardizedDisplacement === undefined ? '' : ` 显著性=${point.standardizedDisplacement}σ`}`),
      ...comparison.pairs.map((pair) => pair.kind === 'tilt'
        ? `倾斜 ${pair.id}（${pair.firstPointId}-${pair.secondPointId}）: 差异沉降=${measurement(pair.differentialSettlement, pair.linearUnit)} 基线=${measurement(pair.baselineM, pair.linearUnit)} 倾斜=${measurement(pair.tilt, pair.tiltUnit)}`
        : `收敛 ${pair.id}（${pair.firstPointId}-${pair.secondPointId}）: 初始距离=${measurement(pair.referenceDistance, pair.linearUnit)} 当前距离=${measurement(pair.currentDistance, pair.linearUnit)} 收敛=${measurement(pair.convergence, pair.linearUnit)} 速率=${measurement(pair.convergenceRatePerDay, pair.rateUnit)}`)
    ]) : ['本报告未关联变形期次比较']),
    '',
    '质量问题',
    ...(dataset?.findings.map((f) => `${f.severity}: ${f.message}（第 ${f.row ?? '-'} 行，${f.code}，${f.status}）`) ?? []),
    ...adjustments.flatMap((adjustment) => adjustment.qualityFindings.map((f) => `${adjustment.runId}: ${f.severity}: ${f.message}（${f.code}，${f.status}）`)),
    '',
    '来源引用',
    ...(citations.length ? citations.map((citation) => `${citation.id}: ${citation.sourceType} ${citation.source}${citation.page ? ` 第 ${citation.page} 页` : ''}${citation.worksheet ? ` 工作表 ${citation.worksheet}` : ''}${citation.row ? ` 第 ${citation.row} 行` : ''}${citation.locator ? ` (${citation.locator})` : ''}`) : ['无']),
    '',
    '审查记录：本报告由 RailWise AI 确定性工程分析生成；当前为待审查草稿，不代表专业复核、批准或签名。'
  ].join('\n')
}
async function fileOutput(path: string, mediaType: string, workspace: string): Promise<{ path: string; mediaType: string; sha256: string; sizeBytes: number }> { const data = await readFile(path); return { path: relative(workspace, path), mediaType, sha256: createHash('sha256').update(data).digest('hex'), sizeBytes: data.byteLength } }
async function makeDocx(text: string): Promise<Buffer> { const zip = new JSZip(); zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'); zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'); zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`); return zip.generateAsync({ type: 'nodebuffer' }) }
async function makeXlsx(project: RailwiseProjectV1, dataset: StoredDataset | undefined, analysis: MonitoringAnalysisV1 | undefined, citations: KnowledgeCitationV1[], adjustments: AdjustmentResultV1[], deformations: DeformationComparisonV1[], surveySources: SurveySourceEvidenceV1[], runtimeVersion: string): Promise<Buffer> {
  const zip = new JSZip()
  const sheets: Array<{ name: string; rows: string[][] }> = [
    ...(dataset && analysis ? [
    { name: 'monitoring_daily', rows: [['monitoringItem', 'point', 'initialTimestamp', 'previousTimestamp', 'currentTimestamp', 'initialValue', 'previousValue', 'currentValue', 'periodChange', 'cumulativeChange', 'cumulativeBasis', 'ratePerDay', 'unit', 'projectUnit', 'unitAlignment', 'threshold', 'thresholdStatus', 'continuity', 'unitStatus', 'unitConflictUnits', 'sourceRows', 'sourceFileHash', 'initialUnit', 'previousUnit'], ...buildMonitoringProfessionalReport({ project, dataset, analysis, generatedAt: new Date().toISOString() }).rows.map((row) => [row.monitoringItem, row.point, row.initialTimestamp, row.previousTimestamp ?? '', row.currentTimestamp, String(row.initialValue), String(row.previousValue ?? ''), String(row.currentValue), String(row.periodChange ?? ''), String(row.cumulativeChange ?? ''), row.cumulativeBasis ?? 'legacy-not-recorded', String(row.ratePerDay ?? ''), row.unit, row.projectUnit ?? project.unit, row.unitAlignment ?? 'not-declared', String(row.threshold ?? ''), row.thresholdStatus, row.continuity, row.unitStatus ?? 'consistent', row.unitConflictUnits?.join(',') ?? '', row.sourceRows.join(','), row.sourceFileHash, row.initialUnit ?? row.unit, row.previousUnit ?? row.unit])] },
    { name: 'field_mapping', rows: [['canonical_field', 'source_column'], ...Object.entries(dataset.fieldMapping).map(([key, value]) => [key, value ?? ''])] },
    { name: 'normalized_data', rows: [['id', 'monitoringItem', 'point', 'timestamp', 'value', 'unit', 'cumulative', 'rate', 'sourceRow', 'sourceFileHash'], ...dataset.observations.map((o) => [o.id, o.monitoringItem, o.point, o.timestamp, String(o.value), o.unit ?? '', String(o.cumulative ?? ''), String(o.rate ?? ''), String(o.sourceRow), dataset.sourceFileHash])] },
    { name: 'quality_findings', rows: [['id', 'severity', 'code', 'row', 'status', 'message', 'suggestion'], ...dataset.findings.map((f) => [f.id, f.severity, f.code, String(f.row ?? ''), f.status, f.message, f.suggestion])] },
    { name: 'analysis_results', rows: [['monitoringItem', 'point', 'currentValue', 'previousValue', 'cumulativeChange', 'cumulativeBasis', 'changeRate', 'trend', 'anomaly', 'thresholdStatus', 'unit', 'unitStatus', 'inputHash'], ...analysis.results.map((r) => [r.monitoringItem, r.point, String(r.currentValue ?? ''), String(r.previousValue ?? ''), String(r.cumulativeChange ?? ''), r.cumulativeBasis ?? 'legacy-not-recorded', String(r.changeRate ?? ''), r.trend, String(r.anomaly), r.thresholdStatus, r.unit ?? project.unit, r.unitStatus ?? 'legacy-not-recorded', analysis.inputHash])] },
    { name: 'threshold_status', rows: [['monitoringItem', 'point', 'thresholdStatus', 'configuredThreshold', 'unit', 'unitStatus', 'interpretation'], ...analysis.results.map((r) => [r.monitoringItem, r.point, r.thresholdStatus, r.unitStatus === 'aligned' || r.unitStatus === undefined ? String(project.thresholds[r.monitoringItem] ?? project.thresholds.default ?? '') : '', r.unit ?? project.unit, r.unitStatus ?? 'legacy-not-recorded', r.unitStatus === undefined ? 'legacy-unverified' : 'current'])] },
    { name: 'chart_data', rows: [['monitoringItem', 'point', 'observationTimestamp', 'observationValue', 'unit', 'timestampUtc', 'timestampBasis', 'observationId', 'sourceRow', 'sourceFileHash'], ...dataset.observations.map(observation => ({ observation, time: monitoringTrendInstant(observation.timestamp) })).sort((a, b) => JSON.stringify([a.observation.monitoringItem, a.observation.unit || project.unit, a.observation.point]).localeCompare(JSON.stringify([b.observation.monitoringItem, b.observation.unit || project.unit, b.observation.point])) || a.time.instant - b.time.instant || a.observation.id.localeCompare(b.observation.id)).map(({ observation: o, time }) => [o.monitoringItem, o.point, o.timestamp, String(o.value), o.unit?.trim() ? o.unit : project.unit, new Date(time.instant).toISOString(), time.assumedUtc ? 'unzoned-as-UTC' : 'explicit-offset-to-UTC', o.id, String(o.sourceRow), dataset.sourceFileHash])] },
    ] : []),
    { name: 'survey_adjustments', rows: [['runId', 'networkId', 'resultId', 'strategyId', 'transformType', 'algorithmVersion', 'observationCount', 'unknownCount', 'redundancy', 'unitWeightStdDev', 'unitWeightStdDevUnit', 'varianceFactor', 'varianceFactorUnit', 'varianceFactorEstimated', 'maxPointStdDev', 'maxPointStdDevUnit', 'validation', 'inputHash'], ...adjustments.map((a) => [a.runId, a.networkId, a.id, a.strategyId ?? '', a.transformType ?? '', a.algorithmVersion, String(a.observationCount), String(a.unknownCount), String(a.redundancy), String(a.unitWeightStdDev), a.unitWeightStdDevUnit, String(a.varianceFactor), a.varianceFactorUnit, String(a.varianceFactorEstimated), String(a.precision.maxPointStdDev), a.linearUnit, a.validation, a.inputHash])] },
    { name: 'survey_sources', rows: [['networkId', 'sourceName', 'sha256', 'vendor', 'format', 'version', 'confidence', 'disposition', 'parserId', 'parserVersion', 'recordCount', 'originalPreserved', 'extension', 'extensionConflict', 'matchedSignatures', 'converterId', 'converterVersion', 'converterLicense', 'converterExecutableHash', 'converterInputHash', 'converterOutputHash', 'converterNetworkAccess', 'converterStatus'], ...surveySources.map(({ networkId, source }) => [networkId, source.name, source.sha256, source.detection.vendor, source.detection.format, source.detection.version ?? '', String(source.detection.confidence), source.disposition, source.parserId, source.parserVersion, String(source.recordCount), String(source.originalPreserved), source.detection.extension ?? '', String(source.detection.extensionConflict), source.detection.matchedSignatures.join(';'), source.converter?.id ?? '', source.converter?.version ?? '', source.converter?.origin === 'workwise-bundled' ? source.converter.license : '', source.converter?.executableHash ?? '', source.converter?.inputHash ?? '', source.converter?.outputHash ?? '', source.converter?.networkAccess ?? '', source.converter?.status ?? ''])] },
    { name: 'survey_source_diagnostics', rows: [['networkId', 'sourceName', 'code', 'severity', 'message', 'sourceRecord', 'byteOffset'], ...surveySources.flatMap(({ networkId, source }) => source.diagnostics.map((item) => [networkId, source.name, item.code, item.severity, item.message, String(item.sourceRecord ?? ''), String(item.byteOffset ?? '')]))] },
    { name: 'survey_raw_anchors', rows: [['networkId', 'sourceName', 'anchorId', 'sourceRecord', 'line', 'byteOffset', 'byteLength', 'section', 'recordType'], ...surveySources.flatMap(({ networkId, source }) => source.rawRecordAnchors.map((item) => [networkId, source.name, item.id, String(item.sourceRecord), String(item.line ?? ''), String(item.byteOffset ?? ''), String(item.byteLength ?? ''), item.section ?? '', item.recordType ?? '']))] },
    { name: 'survey_closures', rows: [['runId', 'closureKey', 'value', 'unit'], ...adjustments.flatMap((a) => Object.entries(a.closure).map(([key, value]) => [a.runId, key, String(value), a.closureUnits[key] ?? '']))] },
    { name: 'survey_parameters', rows: [['runId', 'parameterKey', 'value', 'unit'], ...adjustments.flatMap((a) => Object.entries(a.parameters).map(([key, value]) => [a.runId, key, String(value), a.parameterUnits[key] ?? '']))] },
    { name: 'survey_points', rows: [['runId', 'pointId', 'x', 'y', 'height', 'latitudeDeg', 'longitudeDeg', 'correctionX', 'correctionY', 'correctionHeight', 'standardError', 'linearUnit'], ...adjustments.flatMap((a) => a.points.map((point) => [a.runId, point.id, String(point.x ?? ''), String(point.y ?? ''), String(point.height ?? ''), String(point.latitude ?? ''), String(point.longitude ?? ''), String(point.correctionX ?? ''), String(point.correctionY ?? ''), String(point.correctionHeight ?? ''), String(point.standardError ?? ''), a.linearUnit]))] },
    { name: 'survey_error_ellipses', rows: [['runId', 'pointId', 'algorithmVersion', 'coordinatePlane', 'semiMajor_m', 'semiMinor_m', 'orientation_rad', 'orientationConvention', 'varianceBasis', 'scale', 'Cxx_m2', 'Cxy_m2', 'Cyx_m2', 'Cyy_m2'], ...adjustments.flatMap((a) => a.points.flatMap((point) => point.xyErrorEllipse ? [[a.runId, point.id, point.xyErrorEllipse.algorithmVersion, point.xyErrorEllipse.coordinatePlane, String(point.xyErrorEllipse.semiMajor), String(point.xyErrorEllipse.semiMinor), point.xyErrorEllipse.orientationRad === null ? '' : String(point.xyErrorEllipse.orientationRad), point.xyErrorEllipse.orientationConvention, point.xyErrorEllipse.varianceBasis, point.xyErrorEllipse.scale, ...point.xyErrorEllipse.covarianceXY.map(String)]] : []))] },
    { name: 'survey_residuals', rows: [['runId', 'observationId', 'correction', 'residual', 'unit', 'standardizedResidual', 'standardizedResidualUnit', 'outlier', 'sourceRow', 'sourceRecordId'], ...adjustments.flatMap((a) => a.observations.map((o) => [a.runId, o.observationId, String(o.correction), String(o.residual), o.unit ?? '', String(o.standardizedResidual ?? ''), o.standardizedResidualUnit, String(o.outlier), String(o.sourceRow ?? ''), o.sourceRecordId ?? '']))] },
    { name: 'survey_displacements', rows: [['runId', 'pointId', 'dX', 'dY', 'dH', 'magnitude', 'unit', 'kind'], ...adjustments.flatMap((a) => a.displacements.map((d) => [a.runId, d.pointId, String(d.dX ?? ''), String(d.dY ?? ''), String(d.dH ?? ''), String(d.magnitude), a.linearUnit, d.kind]))] },
    { name: 'deformation_epochs', rows: [['comparisonId', 'adjustmentId', 'resultId', 'networkId', 'observationEpoch', 'inputHash', 'resultHash'], ...deformations.flatMap((comparison) => comparison.epochs.map((epoch) => [comparison.id, epoch.adjustmentId, epoch.resultId, epoch.networkId, epoch.observationEpoch, epoch.inputHash, epoch.resultHash]))] },
    { name: 'deformation_points', rows: [['comparisonId', 'pointId', 'dX', 'dY', 'dH', 'settlement', 'horizontalDisplacement', 'spatialDisplacement', 'dXPerDay', 'dYPerDay', 'dHPerDay', 'settlementPerDay', 'horizontalPerDay', 'spatialPerDay', 'trend', 'combinedStandardError', 'standardizedDisplacement', 'significant', 'unit', 'rateUnit'], ...deformations.flatMap((comparison) => comparison.points.map((point) => [comparison.id, point.pointId, String(point.dX ?? ''), String(point.dY ?? ''), String(point.dH ?? ''), String(point.settlement ?? ''), String(point.horizontalDisplacement ?? ''), String(point.spatialDisplacement), String(point.rates.dXPerDay ?? ''), String(point.rates.dYPerDay ?? ''), String(point.rates.dHPerDay ?? ''), String(point.rates.settlementPerDay ?? ''), String(point.rates.horizontalPerDay ?? ''), String(point.rates.spatialPerDay), point.trend, String(point.combinedStandardError ?? ''), String(point.standardizedDisplacement ?? ''), String(point.significant ?? ''), point.unit, point.rateUnit]))] },
    { name: 'deformation_pairs', rows: [['comparisonId', 'pairId', 'kind', 'firstPointId', 'secondPointId', 'distanceMode', 'referenceDistance', 'currentDistance', 'convergence', 'convergenceRatePerDay', 'baselineM', 'differentialSettlement', 'tilt', 'linearUnit', 'rateUnit', 'tiltUnit'], ...deformations.flatMap((comparison) => comparison.pairs.map((pair) => [comparison.id, pair.id, pair.kind, pair.firstPointId, pair.secondPointId, pair.distanceMode, String(pair.referenceDistance ?? ''), String(pair.currentDistance ?? ''), String(pair.convergence ?? ''), String(pair.convergenceRatePerDay ?? ''), String(pair.baselineM ?? ''), String(pair.differentialSettlement ?? ''), String(pair.tilt ?? ''), pair.linearUnit, pair.rateUnit, pair.tiltUnit]))] },
    { name: 'citations', rows: [['id', 'sourceType', 'source', 'page', 'worksheet', 'row', 'url', 'locator'], ...citations.map((c) => [c.id, c.sourceType, c.source, String(c.page ?? ''), c.worksheet ?? '', String(c.row ?? ''), c.url ?? '', c.locator ?? ''])] },
    { name: 'manifest_summary', rows: [['schemaVersion', 'projectId', 'datasetId', 'sourceFileHash', 'analysisId', 'analysisInputHash', 'adjustmentIds', 'deformationIds', 'surveySourceHashes', 'runtimeVersion', 'generatedAt'], ['1', project.id, dataset?.id ?? '', dataset?.sourceFileHash ?? '', analysis?.id ?? '', analysis?.inputHash ?? '', adjustments.map((a) => a.id).join(','), deformations.map((item) => item.id).join(','), surveySources.map((item) => item.source.sha256).join(','), runtimeVersion, new Date().toISOString()]] }
  ]
  sheets.push(...statisticalEvidenceSheets(adjustments))
  const xmlEscape = (value: string): string => escapeXml(value)
  const sheetXml = (rows: string[][]): string => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, ri) => `<row r="${ri + 1}">${row.map((value, ci) => `<c r="${columnName(ci)}${ri + 1}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`)
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
  zip.file('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`)
  zip.file('xl/workbook.xml', `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`)
  sheets.forEach((sheet, index) => zip.file(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows)))
  return zip.generateAsync({ type: 'nodebuffer' })
}
function columnName(index: number): string { let n = index + 1; let result = ''; while (n > 0) { const remainder = (n - 1) % 26; result = String.fromCharCode(65 + remainder) + result; n = Math.floor((n - 1) / 26) } return result }
function escapeXml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') }
