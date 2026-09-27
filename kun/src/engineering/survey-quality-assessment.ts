import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import * as C from '../contracts/survey-quality-assessment.js'
import { DeliverableManifestV1 } from '../contracts/engineering.js'
import { SurveyQualityWorkspacePlanReadV1, SurveyQualityWorkspaceRecordReadV1 } from '../contracts/survey-quality-workspace.js'
import { SurveySamplingPopulationDetailV1, SurveySamplingRunSummaryV1, SurveySamplingSamplePageV1 } from '../contracts/survey-quality-sampling-workspace.js'
import { SurveyQualityScoringRecordV1 } from '../contracts/survey-quality-scoring-workspace.js'
import { QUALITY_PROFILE_VERSION, QUALITY_STANDARD_DIGEST } from '../contracts/survey-quality-scoring.js'
import { parseAdvancedTrialJson } from './survey-advanced-trials-json.js'
const L = C.QUALITY_ASSESSMENT_LIMITS
export class SurveyQualityAssessmentError extends Error {
  constructor(readonly reason: 'validation'|'not-found'|'stale'|'integrity'|'conflict'|'source-changed'|'unsupported-scope'|'limit'|'rate-limit'|'unavailable'|'replay-environment') { super(`quality_assessment_${reason}`) }
}
const fail = (reason: SurveyQualityAssessmentError['reason']): never => { throw new SurveyQualityAssessmentError(reason) }
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
export function assessmentCanonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(assessmentCanonical).join(',')}]`
  if (v !== null && typeof v === 'object') { const o = v as Record<string, unknown>; return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${assessmentCanonical(o[k])}`).join(',')}}` }
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v)
  return fail('integrity')
}
export const assessmentDigest = (v: unknown) => sha(assessmentCanonical(v))
const equal = (a: unknown, b: unknown) => assessmentCanonical(a) === assessmentCanonical(b)
const environment = () => ({ node: process.versions.node, v8: process.versions.v8, platform: process.platform, arch: process.arch, bun: process.versions.bun ?? null })
type Project = z.infer<typeof C.AssessmentProjectV1>
type Retention = z.infer<typeof SurveyQualityWorkspacePlanReadV1> & SurveyQualityWorkspaceRecordReadV1
type Kind = 'assessment_plans' | 'assessments'
type RecordType = C.SurveyQualityAssessmentPlanV1 | C.SurveyQualityAssessmentV1
type Row = { id: string; project_id: string; project_revision: number; project_binding_hash: string; idempotency_key: string;
  request_hash: string; content_hash: string; created_at: string; data_json: string; request_bytes: Buffer; storage_hash: string }
/** Fixed read-only capabilities; deliberately cannot approve, append, create a score,
 * finalize a deliverable or call its audit-writing verification operation. */
export interface AssessmentSources {
  getProject: (pid: string) => Project | null
  getManifest: (pid: string, id: string) => DeliverableManifestV1 | null
  retentionSnapshot: (pid: string, planId: string, recordId: string) => Retention
  getPopulation: (pid: string, id: string) => SurveySamplingPopulationDetailV1
  getRun: (pid: string, id: string) => SurveySamplingRunSummaryV1
  listSamples: (pid: string, id: string, limit: number, offset: number) => z.infer<typeof SurveySamplingSamplePageV1>
  getScore: (pid: string, id: string) => SurveyQualityScoringRecordV1
}
/** Explicit schema positions only: arbitrary nested fields never become evidence. */
export function assessmentEvidenceReferences(record: SurveyQualityScoringRecordV1): string[] {
  const input = record.declaration
  if (input.operation !== 'unit') return fail('validation')
  const refs = [...input.evidenceRefs]
  for (const leaf of input.leaves) {
    if (leaf.state !== 'checked') refs.push(...leaf.evidenceRefs)
    else if (leaf.record.kind === 'deduction') refs.push(...leaf.record.defects.evidenceRefs)
    else {
      const model = leaf.record.model
      refs.push(...model.aEvidenceRefs)
      for (const item of model.items) refs.push(...item.evidenceRefs)
      if (model.aggregation.kind === 'weighted') refs.push(...model.aggregation.evidenceRefs)
    }
  }
  return [...new Set(refs)]
}
type ScoreProjection = { binding: z.infer<typeof C.AssessmentSourceVectorV1>['scoring'][number]; score: NonNullable<z.infer<typeof C.AssessmentUnitRowV1>['score']>; references: string[] }
export function evaluateAssessment(plan: C.SurveyQualityAssessmentPlanCreateV1, retention: Retention, scores: Map<string, ScoreProjection>): C.AssessmentResultV1 {
  const unitRows = plan.unitMaterials.map(unit => {
    const materials = unit.requirements.map(req => { const check = retention.verification.checks.find(c => c.checkId === req.retentionCheckId)
      return { ...req, status: check?.status === 'passed' ? 'retained-bytes-linked' as const : 'missing-retention-check' as const, eventId: check?.eventId ?? null } })
    const selected = scores.get(unit.unitId)
    return { unitId: unit.unitId, materials, score: selected?.score ?? null, references: (selected?.references ?? []).map(reference => ({ reference,
      resolved: materials.some(m => m.reference === reference && m.status === 'retained-bytes-linked') })),
    fullProfileResult: selected?.score.scopeAssessment === 'complete-declared-product-profile' && ['calculated','nonconforming'].includes(selected.score.result.state) }
  })
  const counts = { expectedUnits: unitRows.length, linkedScores: scores.size, fullProfileUnits: unitRows.filter(u => u.fullProfileResult).length,
    requiredMaterialMappings: unitRows.reduce((n,u) => n+u.materials.length,0), satisfiedMaterialMappings: unitRows.reduce((n,u) => n+u.materials.filter(m=>m.status==='retained-bytes-linked').length,0),
    unresolvedReferences: unitRows.reduce((n,u)=>n+u.references.filter(r=>!r.resolved).length,0) }
  const retained = retention.verification.checks.every(c => c.status === 'passed') && counts.requiredMaterialMappings === counts.satisfiedMaterialMappings
  const complete = counts.fullProfileUnits === counts.expectedUnits
  return C.AssessmentResultV1.parse({ bindingIntegrity: 'verified-current-local-records', unitRows, counts, originalRetentionChecks: retention.verification.checks,
    retentionCoverage: retained ? 'complete-declared-requirements' : 'incomplete-declared-requirements', scoreCoverage: complete ? 'complete-full-profile-unit-results' : 'incomplete-full-profile-unit-results',
    declaredResultSummary: unitRows.some(u=>u.score?.result.state === 'nonconforming') ? 'contains-declared-nonconforming' : complete && unitRows.every(u=>u.score?.result.state==='calculated') ? 'all-declared-unit-results-calculated' : 'unresolved',
    overallLinkage: retained && complete && counts.unresolvedReferences === 0 ? 'complete-declared-linkage' : 'incomplete-declared-linkage' })
}
export class SurveyQualityAssessmentService {
  private readonly db: Database.Database
  private readonly rates = new Map<string,{ since: number; units: number }>()
  constructor(private readonly options: { rootDir: string; sources: Readonly<AssessmentSources>; nowIso?: () => string; clockMs?: () => number }) {
    mkdirSync(resolve(options.rootDir), { recursive: true, mode: 0o700 })
    this.db = new Database(join(options.rootDir, 'survey-quality-assessment.sqlite3'))
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000')
    for (const table of ['assessment_plans','assessments']) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_revision INTEGER NOT NULL, project_binding_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, data_json TEXT NOT NULL, request_bytes BLOB NOT NULL, storage_hash TEXT NOT NULL,
      UNIQUE(project_id,idempotency_key));
      CREATE INDEX IF NOT EXISTS ${table}_project ON ${table}(project_id,created_at,id);
      CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'assessment records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'assessment records are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id OR (project_id=NEW.project_id AND idempotency_key=NEW.idempotency_key)) BEGIN SELECT RAISE(ABORT,'assessment records are append-only'); END;`)
  }
  close(): void { this.db.close(); this.rates.clear() }
  private now(): string { return this.options.nowIso?.() ?? new Date().toISOString() }
  private project(pid: string): Project {
    const p = this.source(() => this.options.sources.getProject(pid))
    if (!p || p.id !== pid) return fail('not-found')
    const parsed = C.AssessmentProjectV1.safeParse({ id: p.id, revision: p.revision, workspace: p.workspace })
    if (!parsed.success || !isAbsolute(p.workspace)) return fail('integrity')
    return parsed.data
  }
  private source<T>(action: () => T): T {
    try { return action() } catch (error) {
      if (error instanceof SurveyQualityAssessmentError) throw error
      if (error instanceof z.ZodError || error instanceof SyntaxError) return fail('integrity')
      const reason = error !== null && typeof error === 'object' && 'reason' in error ? error.reason : null
      if (reason === 'rate-limit' || reason === 'limit') return fail(reason)
      if (reason === 'not-found' || reason === 'stale' || reason === 'integrity' || reason === 'replay-environment') return fail(reason)
      if (reason === 'invalid-reference' || reason === 'validation') return fail('validation')
      return fail('unavailable')
    }
  }
  private charge(pid: string, units: number): void {
    const now = this.options.clockMs?.() ?? Date.now()
    for (const [key,v] of this.rates) if (now-v.since>=60_000 || now<v.since) this.rates.delete(key)
    const entry = this.rates.get(pid) ?? { since: now, units: 0 }
    if (entry.units + units > L.workUnitsPerMinute || !this.rates.has(pid) && this.rates.size >= 512) return fail('rate-limit')
    entry.units += units; this.rates.set(pid,entry)
  }
  private parse<K extends Kind>(kind: K, raw: Uint8Array) {
    if (raw.byteLength > L.requestBytes) return fail('limit')
    try {
      const requestJson = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)
      if (!Buffer.from(requestJson).equals(raw)) return fail('validation')
      const request = (kind === 'assessment_plans' ? C.SurveyQualityAssessmentPlanCreateV1 : C.SurveyQualityAssessmentCreateV1).parse(parseAdvancedTrialJson(requestJson))
      return { requestJson, request }
    } catch { return fail('validation') }
  }
  private storageHash(row: Omit<Row,'storage_hash'>): string { const {request_bytes,...rest}=row; return assessmentDigest({...rest,request_bytes_sha256:sha(request_bytes)}) }
  private readOwn(kind: Kind,pid: string,id: string): RecordType {
    const row = this.db.prepare(`SELECT id,project_id,project_revision,project_binding_hash,idempotency_key,request_hash,content_hash,created_at,storage_hash,
      CASE WHEN length(CAST(data_json AS BLOB))<=? THEN data_json END AS data_json, CASE WHEN length(request_bytes)<=? THEN request_bytes END AS request_bytes FROM ${kind} WHERE project_id=? AND id=?`).get(L.recordBytes,L.requestBytes,pid,id) as Row|undefined
    if (!row) return fail('not-found')
    try {
      if (typeof row.data_json !== 'string' || !Buffer.isBuffer(row.request_bytes)) return fail('integrity')
      const {storage_hash,...unsignedRow}=row
      if (this.storageHash(unsignedRow)!==storage_hash) return fail('integrity')
      const record = (kind === 'assessment_plans' ? C.SurveyQualityAssessmentPlanV1 : C.SurveyQualityAssessmentV1).parse(parseAdvancedTrialJson(row.data_json))
      const contentHash = 'snapshot' in record ? record.planHash : record.recordHash
      const unsigned = {...record} as Record<string,unknown>; delete unsigned['snapshot' in record ? 'planHash':'recordHash']
      const parsed=this.parse(kind,row.request_bytes)
      if (assessmentDigest(unsigned)!==contentHash || contentHash!==row.content_hash || record.id!==row.id || record.projectId!==row.project_id || record.projectRevision!==row.project_revision
        || record.projectBindingHash!==row.project_binding_hash || record.createdAt!==row.created_at || record.request.idempotencyKey!==row.idempotency_key || record.requestSha256!==row.request_hash
        || sha(row.request_bytes)!==record.requestSha256 || row.request_bytes.length!==record.requestSizeBytes || record.requestJson!==parsed.requestJson || !equal(record.request,parsed.request)
        || record.request.expectedProjectRevision!==record.projectRevision) return fail('integrity')
      const project = 'snapshot' in record ? record.snapshot.project : record.projectSnapshot
      if (project.id!==pid || project.revision!==record.projectRevision || assessmentDigest(project)!==record.projectBindingHash) return fail('integrity')
      if ('snapshot' in record) {
        if (record.snapshot.retentionPlanDigest!==assessmentDigest(record.snapshot.retentionPlan) || record.snapshot.sampleIdsHash!==assessmentDigest(record.snapshot.selectedUnitIds)
          || !equal(record.request.unitMaterials.map(u=>u.unitId),record.snapshot.selectedUnitIds) || record.request.retentionPlanId!==record.snapshot.retentionPlan.id
          || record.request.retentionRecordId!==record.snapshot.retentionRecordId || record.request.samplingRunId!==record.snapshot.run.id || record.request.productProfileId!==record.snapshot.profile.profileId) return fail('integrity')
      } else {
        const plan=this.readOwn('assessment_plans',pid,record.assessmentPlanId) as C.SurveyQualityAssessmentPlanV1
        if (record.resultHash!==assessmentDigest(record.result) || record.request.assessmentPlanId!==record.assessmentPlanId || record.request.expectedPlanHash!==record.planHash || plan.planHash!==record.planHash
          || !equal(record.result.unitRows.map(u=>u.unitId),plan.snapshot.selectedUnitIds)) return fail('integrity')
        if (!equal(record.replayEnvironment,environment())) return fail('replay-environment')
      }
      if (!equal(this.project(pid),project)) return fail('stale')
      return record
    } catch(error) { if(error instanceof SurveyQualityAssessmentError && ['stale','not-found','rate-limit','unavailable','replay-environment'].includes(error.reason)) throw error; return fail('integrity') }
  }
  private sourcePass(pid: string, request: C.SurveyQualityAssessmentPlanCreateV1, scoreRequest?: C.SurveyQualityAssessmentCreateV1) {
    const project=this.project(pid)
    if(project.revision!==request.expectedProjectRevision) return fail('stale')
    const raw=this.source(()=>this.options.sources.retentionSnapshot(pid,request.retentionPlanId,request.retentionRecordId))
    const retention={...SurveyQualityWorkspacePlanReadV1.parse({plan:raw.plan,artifact:raw.artifact}),...SurveyQualityWorkspaceRecordReadV1.parse({record:raw.record,events:raw.events,verification:raw.verification})}
    const {plan,artifact,record,verification}=retention
    if(plan.id!==request.retentionPlanId || record.id!==request.retentionRecordId || record.planId!==plan.id || plan.projectId!==pid || artifact.projectId!==pid || record.projectId!==pid
      || plan.projectRevision!==project.revision || plan.projectBindingHash!==assessmentDigest(project) || record.planHash!==assessmentDigest(plan)
      || artifact.id!==plan.artifactId || artifact.bundleHash!==plan.artifactHash || artifact.manifestId!==plan.manifestId || artifact.manifestHash!==plan.manifestHash
      || verification.recordId!==record.id || verification.planId!==plan.id || !equal(verification.checks.map(c=>c.checkId),plan.requiredCheckIds)) return fail('integrity')
    const manifest=this.source(()=>this.options.sources.getManifest(pid,plan.manifestId))
    if(!manifest) return fail('not-found')
    if(manifest.projectId!==pid || manifest.id!==plan.manifestId) return fail('integrity')
    for(const unit of request.unitMaterials) for(const mapping of unit.requirements) {
      const required=plan.requiredEvidence.find(e=>`evidence:${e.id}`===mapping.retentionCheckId)
      if(!required || required.memberId!==mapping.memberId || !artifact.members.some(m=>m.id===mapping.memberId)) return fail('validation')
    }
    const run=SurveySamplingRunSummaryV1.parse(this.source(()=>this.options.sources.getRun(pid,request.samplingRunId)))
    if(run.sampleSize>L.units || run.round!==1) return fail('unsupported-scope')
    const population=SurveySamplingPopulationDetailV1.parse(this.source(()=>this.options.sources.getPopulation(pid,run.populationId)))
    const samples=SurveySamplingSamplePageV1.parse(this.source(()=>this.options.sources.listSamples(pid,run.id,100,0)))
    if(run.id!==request.samplingRunId || run.projectId!==pid || population.projectId!==pid || population.id!==run.populationId || samples.projectId!==pid || samples.runId!==run.id || samples.planHash!==run.planHash
      || run.populationHash!==population.populationHash || run.definitionEvidenceSha256!==population.definitionEvidenceSha256 || run.projectBindingHash!==assessmentDigest(project) || population.projectBindingHash!==assessmentDigest(project)
      || samples.total!==run.sampleSize || samples.samples.length!==run.sampleSize || samples.offset!==0 || samples.nextOffset!==null) return fail('integrity')
    const selectedUnitIds=samples.samples.map(s=>s.unitProductId)
    if(selectedUnitIds.some(u=>u.length>160)) return fail('unsupported-scope')
    if(!equal(selectedUnitIds,request.unitMaterials.map(u=>u.unitId))) return fail('validation')
    const profile=C.AssessmentProfileV1.parse({profileId:request.productProfileId,profileVersion:QUALITY_PROFILE_VERSION,standardCode:'GB/T 24356-2023',sourceSha256:QUALITY_STANDARD_DIGEST,
      weightTable:request.productProfileId==='planar-control-point'?43:45,classificationTable:request.productProfileId==='planar-control-point'?44:46,
      dependencyAlgorithmVersions:{sampling:run.algorithmVersion,scoring:'gbt24356-declared-exact-quality-scoring-1'}})
    const snapshot=C.AssessmentSnapshotV1.parse({project,retentionPlan:plan,retentionPlanDigest:assessmentDigest(plan),artifact,retentionRecordId:record.id,population,run,selectedUnitIds,sampleIdsHash:assessmentDigest(selectedUnitIds),profile})
    const scores=new Map<string,ScoreProjection>()
    if(scoreRequest) {
      if(scoreRequest.unitScores.some(s=>!selectedUnitIds.includes(s.unitId))) return fail('validation')
      // One full source record at a time; only compact result/reference/hash projections survive.
      for(const unitId of selectedUnitIds) {
        const selected=scoreRequest.unitScores.find(s=>s.unitId===unitId)
        if(!selected) continue
        const score=SurveyQualityScoringRecordV1.parse(this.source(()=>this.options.sources.getScore(pid,selected.scoringRecordId)))
        const d=score.declaration
        if(score.id!==selected.scoringRecordId || score.projectId!==pid || score.projectBindingHash!==assessmentDigest(project)) return fail('integrity')
        if(d.operation!=='unit' || score.kind!=='unit' || d.unitId!==unitId || d.productProfileId!==profile.profileId || d.productProfileVersion!==profile.profileVersion
          || d.profileWeightTable!==profile.weightTable || d.profileClassificationTable!==profile.classificationTable || d.sourceDigest!==profile.sourceSha256) return fail('validation')
        scores.set(unitId,{binding:{unitId,recordId:score.id,requestSha256:score.requestSha256,declarationSha256:score.declarationSha256,modelHash:score.modelHash,resultHash:score.resultHash,recordHash:score.recordHash},
          score:{recordId:score.id,associationTiming:'existing-record-linked-after-calculation',declaredTargetAssociation:'caller-declared-not-authenticated',scopeAssessment:score.scopeAssessment,result:score.result.result},references:assessmentEvidenceReferences(score)})
      }
    }
    const sourceVector=C.AssessmentSourceVectorV1.parse({manifestId:manifest.id,manifestHash:plan.manifestHash,artifactId:artifact.id,bundleHash:artifact.bundleHash,retentionPlanId:plan.id,retentionPlanDigest:snapshot.retentionPlanDigest,
      retentionRecordId:record.id,retentionEventCount:retention.events.length,retentionHeadHash:verification.headHash,populationId:population.id,populationHash:population.populationHash,populationDefinitionHash:population.definitionEvidenceSha256,
      samplingRunId:run.id,samplingRunHash:run.runHash,samplingPlanHash:run.planHash,sampleIdsHash:snapshot.sampleIdsHash,scoring:[...scores.values()].map(s=>s.binding),profile})
    return {snapshot,sourceVector,result:evaluateAssessment(request,retention,scores),manifestReviewStatus:manifest.reviewStatus}
  }
  private replay(pid: string, request: C.SurveyQualityAssessmentPlanCreateV1, scoreRequest?: C.SurveyQualityAssessmentCreateV1) {
    // Two bounded optimistic passes, not a cross-database transaction or ABA guarantee.
    const a=this.sourcePass(pid,request,scoreRequest), b=this.sourcePass(pid,request,scoreRequest)
    if(!equal(a,b)) return fail('source-changed')
    if(!equal(this.project(pid),a.snapshot.project)) return fail('stale')
    return a
  }
  private persist(kind: Kind, record: RecordType, raw: Uint8Array): void {
    this.db.transaction(()=>{
      const usage=this.db.prepare(`SELECT count(*) AS count FROM ${kind} WHERE project_id=?`).get(record.projectId) as {count:number}
      const bytes=this.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM (SELECT length(CAST(data_json AS BLOB))+length(request_bytes) AS bytes FROM assessment_plans WHERE project_id=? UNION ALL SELECT length(CAST(data_json AS BLOB))+length(request_bytes) AS bytes FROM assessments WHERE project_id=?)').get(record.projectId,record.projectId) as {bytes:number}
      const data=JSON.stringify(record)
      if(usage.count>=L.recordsPerProject || Buffer.byteLength(data)>L.recordBytes || bytes.bytes+Buffer.byteLength(data)+raw.byteLength>L.storedBytesPerProject) return fail('limit')
      if(assessmentDigest(this.project(record.projectId))!==record.projectBindingHash) return fail('stale')
      const row={id:record.id,project_id:record.projectId,project_revision:record.projectRevision,project_binding_hash:record.projectBindingHash,idempotency_key:record.request.idempotencyKey,
        request_hash:record.requestSha256,content_hash:'snapshot' in record?record.planHash:record.recordHash,created_at:record.createdAt,data_json:data,request_bytes:Buffer.from(raw)}
      this.db.prepare(`INSERT INTO ${kind}(id,project_id,project_revision,project_binding_hash,idempotency_key,request_hash,content_hash,created_at,data_json,request_bytes,storage_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
        .run(row.id,row.project_id,row.project_revision,row.project_binding_hash,row.idempotency_key,row.request_hash,row.content_hash,row.created_at,row.data_json,row.request_bytes,this.storageHash(row))
      // Internal read only; never a third dependency replay.
      this.readOwn(kind,record.projectId,record.id)
    }).immediate()
  }
  private old(kind: Kind,pid:string,key:string,raw:Uint8Array): string|null {
    const row=this.db.prepare(`SELECT id,request_hash FROM ${kind} WHERE project_id=? AND idempotency_key=?`).get(pid,key) as {id:string;request_hash:string}|undefined
    if(!row) return null
    const record=this.readOwn(kind,pid,row.id)
    if(row.request_hash!==sha(raw) || !Buffer.from(record.requestJson).equals(raw)) return fail('conflict')
    return row.id
  }
  createPlan(pid:string,raw:Uint8Array): C.SurveyQualityAssessmentPlanV1 {
    this.project(pid);this.charge(pid,4)
    const {requestJson,request:parsed}=this.parse('assessment_plans',raw),request=C.SurveyQualityAssessmentPlanCreateV1.parse(parsed)
    const old=this.old('assessment_plans',pid,request.idempotencyKey,raw)
    if(old) return this.verifyPlan(pid,old)
    const {snapshot}=this.replay(pid,request)
    const unsigned={schemaVersion:1,id:`assessment_plan_${randomUUID()}`,projectId:pid,projectRevision:snapshot.project.revision,projectBindingHash:assessmentDigest(snapshot.project),createdAt:this.now(),
      requestSha256:sha(raw),requestSizeBytes:raw.byteLength,requestJson,request,snapshot,algorithmPolicyVersion:C.QUALITY_ASSESSMENT_ALGORITHM,...C.QUALITY_ASSESSMENT_BOUNDARIES}
    const plan=C.SurveyQualityAssessmentPlanV1.parse({...unsigned,planHash:assessmentDigest(unsigned)})
    this.persist('assessment_plans',plan,raw);return plan
  }
  private verifyPlan(pid:string,id:string): C.SurveyQualityAssessmentPlanV1 {
    const plan=this.readOwn('assessment_plans',pid,id) as C.SurveyQualityAssessmentPlanV1
    const current=this.replay(pid,plan.request)
    if(!equal(plan.snapshot,current.snapshot)) return fail('source-changed')
    return plan
  }
  getPlan(pid:string,id:string): C.SurveyQualityAssessmentPlanV1 { this.project(pid);this.charge(pid,4);return this.verifyPlan(pid,id) }
  createAssessment(pid:string,raw:Uint8Array): C.SurveyQualityAssessmentV1 {
    this.project(pid);this.charge(pid,4)
    const {requestJson,request:parsed}=this.parse('assessments',raw),request=C.SurveyQualityAssessmentCreateV1.parse(parsed)
    const old=this.old('assessments',pid,request.idempotencyKey,raw)
    if(old) return this.verifyAssessment(pid,old)
    const plan=this.readOwn('assessment_plans',pid,request.assessmentPlanId) as C.SurveyQualityAssessmentPlanV1
    if(request.expectedProjectRevision!==plan.projectRevision) return fail('stale')
    if(request.expectedPlanHash!==plan.planHash) return fail('conflict')
    const current=this.replay(pid,plan.request,request)
    if(!equal(current.snapshot,plan.snapshot)) return fail('source-changed')
    const unsigned={schemaVersion:1,id:`assessment_${randomUUID()}`,projectId:pid,projectRevision:plan.projectRevision,projectBindingHash:plan.projectBindingHash,createdAt:this.now(),
      requestSha256:sha(raw),requestSizeBytes:raw.byteLength,requestJson,request,projectSnapshot:plan.snapshot.project,assessmentPlanId:plan.id,planHash:plan.planHash,
      sourceVector:current.sourceVector,result:current.result,resultHash:assessmentDigest(current.result),manifestReviewStatus:current.manifestReviewStatus,replayEnvironment:environment(),
      algorithmPolicyVersion:C.QUALITY_ASSESSMENT_ALGORITHM,...C.QUALITY_ASSESSMENT_BOUNDARIES}
    const record=C.SurveyQualityAssessmentV1.parse({...unsigned,recordHash:assessmentDigest(unsigned)})
    this.persist('assessments',record,raw);return record
  }
  private verifyAssessment(pid:string,id:string): C.SurveyQualityAssessmentV1 {
    const record=this.readOwn('assessments',pid,id) as C.SurveyQualityAssessmentV1,plan=this.readOwn('assessment_plans',pid,record.assessmentPlanId) as C.SurveyQualityAssessmentPlanV1
    const current=this.replay(pid,plan.request,record.request)
    if(!equal(current.snapshot,plan.snapshot) || !equal(current.sourceVector,record.sourceVector)) return fail('source-changed')
    if(!equal(current.result,record.result) || current.manifestReviewStatus!==record.manifestReviewStatus) return fail('integrity')
    return record
  }
  getAssessment(pid:string,id:string): C.SurveyQualityAssessmentV1 {this.project(pid);this.charge(pid,4);return this.verifyAssessment(pid,id)}
  reverifyAssessment(pid:string,id:string) { return C.SurveyQualityAssessmentVerificationV1.parse({record:this.getAssessment(pid,id),checkedAt:this.now()}) }
  list(pid:string,kind:Kind,limit=10,offset=0): z.infer<typeof C.SurveyQualityAssessmentListV1> {
    this.project(pid);this.charge(pid,1)
    if(!Number.isInteger(limit)||limit<1||limit>L.pageSize||!Number.isInteger(offset)||offset<0||offset>L.recordsPerProject) return fail('validation')
    const rows=this.db.prepare(`SELECT CASE WHEN length(id)<=160 THEN id END AS id,CAST(rowid AS TEXT) AS slot FROM ${kind} WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(pid,limit+1,offset) as Array<{id:string|null;slot:string}>
    const records: z.infer<typeof C.AssessmentListSummaryV1>[]=[],unavailable:z.infer<typeof C.SurveyQualityAssessmentListV1>['unavailable']=[]
    for(const row of rows.slice(0,limit)) {
      const validId = kind === 'assessment_plans' ? /^assessment_plan_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ : /^assessment_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      if(!row.id || !validId.test(row.id)) {unavailable.push({id:`unavailable-slot-${row.slot}`,reason:'integrity'});continue}
      try {const r=this.readOwn(kind,pid,row.id);records.push({id:r.id,projectId:pid,projectRevision:r.projectRevision,createdAt:r.createdAt,contentHash:'snapshot' in r?r.planHash:r.recordHash,result:'result' in r?r.result:null,view:'saved-summary-only',dependencyVerification:'not-performed-on-list'})}
      catch(error){if(error instanceof SurveyQualityAssessmentError && ['rate-limit','unavailable'].includes(error.reason))throw error;unavailable.push({id:row.id,reason:error instanceof SurveyQualityAssessmentError && ['stale','replay-environment'].includes(error.reason)?error.reason as 'stale'|'replay-environment':'integrity'})}
    }
    return C.SurveyQualityAssessmentListV1.parse({records,unavailable,nextOffset:rows.length>limit?offset+limit:null,view:'saved-summary-only',dependencyVerification:'not-performed-on-list'})
  }
}
