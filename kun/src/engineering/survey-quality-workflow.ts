import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import * as C from '../contracts/survey-quality-workflow.js';
import { SurveyQualityWorkspacePlanReadV1, SurveyQualityWorkspaceRecordReadV1 } from '../contracts/survey-quality-workspace.js';
import { appendSurveyQualityEvent, verifySurveyQualityRecord, SURVEY_QUALITY_CHAIN_GENESIS } from './survey-quality-record.js';
import { assessmentDigest } from './survey-quality-assessment.js';
import { parseAdvancedTrialJson } from './survey-advanced-trials-json.js';
import type { SurveyQualityEventV1 } from '../contracts/survey-standard-quality.js';
const L = C.QUALITY_WORKFLOW_LIMITS;
const digest = assessmentDigest;
const projectSchema = z.object({ id: z.string().min(1).max(160), revision: z.number().int().positive(), workspace: z.string().min(1).max(4096) }).strict();
type Project = z.infer<typeof projectSchema>;
type Workflow = z.infer<typeof C.SurveyQualityWorkflowV1>;
type BoundSource = {
    binding: C.SurveyQualityWorkflowBindingV1;
    artifact: z.infer<typeof SurveyQualityWorkspacePlanReadV1>['artifact'];
};
type SourceCache = {
    bindings: Map<string, BoundSource>;
    bytes: number;
};
const sourceCache = (): SourceCache => ({ bindings: new Map(), bytes: 0 });
type Row = {
    kind: string;
    id: string;
    project_id: string;
    workflow_id: string;
    sequence: number;
    idempotency_key: string;
    request_hash: string;
    data_json: string;
    storage_hash: string;
};
type Failure = 'validation' | 'not-found' | 'stale' | 'integrity' | 'conflict' | 'source-changed' | 'limit' | 'invalid-transition' | 'invalid-reference' | 'unavailable';
export class SurveyQualityWorkflowError extends Error {
    constructor(readonly reason: Failure) { super(`quality_workflow_${reason}`); }
}
const fail = (reason: Failure): never => { throw new SurveyQualityWorkflowError(reason); };
const same = (a: unknown, b: unknown): boolean => digest(a) === digest(b);
export interface SurveyQualityWorkflowSources {
    getProject(projectId: string): Project | null;
    retentionSnapshot(projectId: string, planId: string, recordId: string): unknown;
}
/** Local, caller-declared remediation history. The service has read-only source
 * capabilities and cannot approve, sign or mutate a retained deliverable. */
export class SurveyQualityWorkflowService {
    private readonly db: Database.Database;
    constructor(private readonly options: {
        rootDir: string;
        sources: Readonly<SurveyQualityWorkflowSources>;
        nowIso?: () => string;
    }) {
        mkdirSync(resolve(options.rootDir), { recursive: true, mode: 0o700 });
        this.db = new Database(join(options.rootDir, 'survey-quality-workflow.sqlite3'));
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_records (
      kind TEXT NOT NULL, id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, data_json TEXT NOT NULL, storage_hash TEXT NOT NULL,
      UNIQUE(project_id,idempotency_key), UNIQUE(workflow_id,sequence));
      CREATE INDEX IF NOT EXISTS workflow_records_project ON workflow_records(project_id,kind,id);
      CREATE TABLE IF NOT EXISTS workflow_heads (workflow_id TEXT NOT NULL, sequence INTEGER NOT NULL, head_hash TEXT NOT NULL, storage_hash TEXT NOT NULL,
      PRIMARY KEY(workflow_id,sequence));`);
        for (const table of ['workflow_records', 'workflow_heads']) {
            const duplicate = table === 'workflow_records' ? 'id=NEW.id OR (project_id=NEW.project_id AND idempotency_key=NEW.idempotency_key) OR (workflow_id=NEW.workflow_id AND sequence=NEW.sequence)' : 'workflow_id=NEW.workflow_id AND sequence=NEW.sequence';
            this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'workflow is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'workflow is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${duplicate}) BEGIN SELECT RAISE(ABORT,'workflow is append-only'); END;`);
        }
    }
    close(): void { this.db.close(); }
    private now(): string { return this.options.nowIso?.() ?? new Date().toISOString(); }
    private source<T>(read: () => T): T {
        try {
            return read();
        }
        catch (error) {
            if (error instanceof SurveyQualityWorkflowError)
                throw error;
            const reason = error && typeof error === 'object' && 'reason' in error ? error.reason : null;
            if (['not-found', 'stale', 'integrity', 'limit'].includes(String(reason)))
                return fail(reason as Failure);
            if (error instanceof z.ZodError || error instanceof SyntaxError)
                return fail('integrity');
            return fail('unavailable');
        }
    }
    private project(pid: string): Project {
        const p = this.source(() => this.options.sources.getProject(pid));
        if (!p)
            return fail('not-found');
        const parsed = projectSchema.safeParse({ id: p.id, revision: p.revision, workspace: p.workspace });
        if (!parsed.success || p.id !== pid || !isAbsolute(p.workspace))
            return fail('integrity');
        return parsed.data;
    }
    private binding(pid: string, ref: C.SurveyQualityWorkflowSourceV1, cache?: SourceCache): BoundSource {
        const key = digest({ pid, planId: ref.planId, recordId: ref.recordId, head: ref.expectedRetentionHeadHash });
        const previous = cache?.bindings.get(key);
        if (previous)
            return previous;
        if (cache && cache.bindings.size >= L.sourcesPerWorkflow)
            return fail('limit');
        const project = this.project(pid);
        const raw = this.source(() => this.options.sources.retentionSnapshot(pid, ref.planId, ref.recordId));
        const parsed = z.object({ ...SurveyQualityWorkspacePlanReadV1.shape, ...SurveyQualityWorkspaceRecordReadV1.shape }).strict().safeParse(raw);
        if (!parsed.success)
            return fail('integrity');
        const { plan, artifact, record, verification, events } = parsed.data;
        if (plan.id !== ref.planId || record.id !== ref.recordId || plan.projectId !== pid || record.projectId !== pid || artifact.projectId !== pid
            || record.planId !== plan.id || record.planHash !== digest(plan) || record.artifactId !== artifact.id || record.artifactHash !== artifact.bundleHash
            || plan.artifactId !== artifact.id || plan.artifactHash !== artifact.bundleHash || plan.manifestId !== artifact.manifestId || plan.manifestHash !== artifact.manifestHash
            || plan.projectRevision !== project.revision || plan.projectBindingHash !== digest(project)
            || verification.projectId !== pid || verification.recordId !== record.id || verification.planId !== plan.id || verification.artifactHash !== artifact.bundleHash
            || verification.headHash !== (events.at(-1)?.thisHash ?? SURVEY_QUALITY_CHAIN_GENESIS) || !verifySurveyQualityRecord(events).valid)
            return fail('integrity');
        if (verification.headHash !== ref.expectedRetentionHeadHash)
            return fail('source-changed');
        const binding = C.SurveyQualityWorkflowBindingV1.parse({ projectId: pid, projectRevision: project.revision, projectBindingHash: digest(project),
            planId: plan.id, planHash: digest(plan), recordId: record.id, recordHash: digest(record), retentionHeadHash: verification.headHash,
            artifactId: artifact.id, artifactHash: artifact.bundleHash, manifestId: plan.manifestId, manifestHash: plan.manifestHash });
        const result = { binding, artifact };
        if (cache) {
            cache.bytes += artifact.members.reduce((sum, member) => sum + member.sizeBytes, 0);
            if (cache.bytes > L.sourceBytesPerPass)
                return fail('limit');
            cache.bindings.set(key, result);
        }
        return result;
    }
    private parse<T>(schema: z.ZodType<T>, input: unknown): T {
        try {
            const json = JSON.stringify(input);
            if (Buffer.byteLength(json) > L.requestBytes)
                return fail('limit');
            return schema.parse(parseAdvancedTrialJson(json));
        }
        catch (e) {
            if (e instanceof SurveyQualityWorkflowError)
                throw e;
            return fail('validation');
        }
    }
    private row(row: Row): unknown {
        try {
            if (!row || typeof row.data_json !== 'string' || Buffer.byteLength(row.data_json) > L.recordBytes)
                return fail('integrity');
            const { storage_hash, ...unsigned } = row;
            if (storage_hash !== digest(unsigned))
                return fail('integrity');
            return parseAdvancedTrialJson(row.data_json);
        }
        catch {
            return fail('integrity');
        }
    }
    private rows(pid: string, id: string): Row[] {
        const rows = this.db.prepare('SELECT kind,id,project_id,workflow_id,sequence,idempotency_key,request_hash,storage_hash, CASE WHEN length(CAST(data_json AS BLOB))<=? THEN data_json END AS data_json FROM workflow_records WHERE project_id=? AND workflow_id=? ORDER BY sequence LIMIT ?').all(L.recordBytes, pid, id, L.eventsPerWorkflow + 2) as Row[];
        if (!rows.length)
            return fail('not-found');
        if (rows.length > L.eventsPerWorkflow + 1)
            return fail('integrity');
        return rows;
    }
    private save(kind: string, pid: string, id: string, workflowId: string, sequence: number, key: string, request: unknown, data: unknown): void {
        const row = { kind, id, project_id: pid, workflow_id: workflowId, sequence, idempotency_key: key, request_hash: digest(request), data_json: JSON.stringify(data) };
        if (Buffer.byteLength(row.data_json) > L.recordBytes)
            return fail('limit');
        this.db.prepare('INSERT INTO workflow_records(kind,id,project_id,workflow_id,sequence,idempotency_key,request_hash,data_json,storage_hash) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(kind, id, pid, workflowId, sequence, key, row.request_hash, row.data_json, digest(row));
    }
    private head(id: string, sequence: number, hash: string): void {
        const value = { workflow_id: id, sequence, head_hash: hash };
        this.db.prepare('INSERT INTO workflow_heads(workflow_id,sequence,head_hash,storage_hash) VALUES (?,?,?,?)').run(id, sequence, hash, digest(value));
    }
    private eventSources(pid: string, request: C.SurveyQualityWorkflowAppendV1, cache?: SourceCache) {
        const e = request.event, evidence = this.binding(pid, e.evidence, cache);
        const member = evidence.artifact.members.find(m => m.id === e.evidence.memberId);
        if (!member)
            return fail('invalid-reference');
        const target = e.kind === 'correction-recorded' ? this.binding(pid, e.corrected, cache).binding : e.kind === 'issue-rechecked' ? this.binding(pid, e.rechecked, cache).binding : null;
        let event: SurveyQualityEventV1['event'];
        const evidenceSha256 = member.sha256;
        if (e.kind === 'check')
            event = { kind: e.kind, checkId: e.checkId, outcome: e.outcome, evidenceSha256 };
        else if (e.kind === 'issue-opened')
            event = { kind: e.kind, issueId: e.issueId, checkId: e.checkId, evidenceSha256 };
        else if (e.kind === 'correction-recorded')
            event = { kind: e.kind, issueId: e.issueId, correctionId: e.correctionId, correctedArtifactSha256: target!.artifactHash, evidenceSha256 };
        else
            event = { kind: e.kind, issueId: e.issueId, correctionId: e.correctionId, recheckedArtifactSha256: target!.artifactHash, outcome: e.outcome, evidenceSha256 };
        return { event, evidenceBinding: evidence.binding, targetBinding: target };
    }
    private verifySources(pid: string, first: SourceCache): void {
        const second = sourceCache();
        for (const expected of first.bindings.values()) {
            const b = expected.binding;
            const actual = this.binding(pid, { planId: b.planId, recordId: b.recordId, expectedRetentionHeadHash: b.retentionHeadHash }, second);
            if (!same(actual, expected))
                return fail('source-changed');
        }
    }
    private read(pid: string, id: string, firstCache = sourceCache(), reverify = true): C.SurveyQualityWorkflowReadV1 {
        const rows = this.rows(pid, id), root = rows[0]!;
        const workflow = C.SurveyQualityWorkflowV1.parse(this.row(root));
        if (root.kind !== 'workflow' || root.id !== id || root.workflow_id !== id || root.project_id !== pid || root.sequence !== 0 || workflow.id !== id || workflow.projectId !== pid
            || workflow.request.idempotencyKey !== root.idempotency_key || root.request_hash !== digest(workflow.request))
            return fail('integrity');
        const baseline = this.binding(pid, workflow.request, firstCache).binding;
        if (!same(baseline, workflow.binding) || workflow.request.expectedProjectRevision !== baseline.projectRevision)
            return fail('stale');
        const entries: C.SurveyQualityWorkflowEntryV1[] = [];
        for (const [index, row] of rows.slice(1).entries()) {
            const entry = C.SurveyQualityWorkflowEntryV1.parse(this.row(row)), event = entry.event;
            if (row.kind !== 'event' || row.id !== event.id || row.project_id !== pid || row.workflow_id !== id || row.sequence !== index + 1 || event.sequence !== index + 1
                || row.request_hash !== digest(entry.request) || row.idempotency_key !== entry.request.idempotencyKey || event.projectId !== pid || event.artifactSha256 !== workflow.binding.artifactHash
                || event.actor.id !== 'survey-quality-workflow' || event.actor.kind !== 'system' || event.stage !== 'declared-workflow' || Date.parse(event.occurredAt) < Date.parse(workflow.createdAt)
                || entry.request.expectedHeadHash !== (entries.at(-1)?.event.thisHash ?? SURVEY_QUALITY_CHAIN_GENESIS))
                return fail('integrity');
            const sources = this.eventSources(pid, entry.request, firstCache);
            if (!same(sources.evidenceBinding, entry.evidenceBinding) || !same(sources.targetBinding, entry.targetBinding))
                return fail('source-changed');
            if (!same(sources.event, event.event))
                return fail('integrity');
            entries.push(entry);
        }
        const check = verifySurveyQualityRecord(entries.map(e => e.event));
        if (!check.valid)
            return fail('integrity');
        const heads = this.db.prepare('SELECT * FROM workflow_heads WHERE workflow_id=? ORDER BY sequence LIMIT ?').all(id, L.eventsPerWorkflow + 2) as Array<{
            workflow_id: string;
            sequence: number;
            head_hash: string;
            storage_hash: string;
        }>;
        if (heads.length !== rows.length)
            return fail('integrity');
        heads.forEach((head, i) => {
            const { storage_hash, ...unsigned } = head;
            if (head.sequence !== i || head.workflow_id !== id || head.head_hash !== (i ? entries[i - 1]!.event.thisHash : SURVEY_QUALITY_CHAIN_GENESIS) || storage_hash !== digest(unsigned))
                fail('integrity');
        });
        // Source callbacks are separate stores: two bounded optimistic passes detect
        // changes during a read; this is not an external authenticated checkpoint.
        if (reverify)
            this.verifySources(pid, firstCache);
        const result = C.SurveyQualityWorkflowReadV1.parse({ workflow, entries, headHash: entries.at(-1)?.event.thisHash ?? SURVEY_QUALITY_CHAIN_GENESIS,
            recordIntegrity: true, openIssueCount: check.openIssueCount, recordedCheckCount: check.recordedCheckCount,
            semantics: 'caller-declared-workflow-only', checkpointTrust: 'local-records-only', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated', deliveryApproval: 'not-granted' });
        if (Buffer.byteLength(JSON.stringify(result)) > L.recordBytes)
            return fail('limit');
        return result;
    }
    getWorkflow(pid: string, id: string): C.SurveyQualityWorkflowReadV1 {
        return this.db.transaction(() => { try {
            return this.read(pid, id);
        }
        catch (e) {
            if (e instanceof SurveyQualityWorkflowError)
                throw e;
            return fail('integrity');
        } })();
    }
    createWorkflow(pid: string, input: unknown): C.SurveyQualityWorkflowReadV1 {
        const request = this.parse(C.SurveyQualityWorkflowCreateV1, input);
        return this.db.transaction(() => {
            const binding = this.binding(pid, request).binding;
            if (binding.projectRevision !== request.expectedProjectRevision)
                return fail('stale');
            const old = this.db.prepare('SELECT workflow_id,kind,request_hash FROM workflow_records WHERE project_id=? AND idempotency_key=?').get(pid, request.idempotencyKey) as {
                workflow_id: string;
                kind: string;
                request_hash: string;
            } | undefined;
            if (old) {
                if (old.kind !== 'workflow' || old.request_hash !== digest(request))
                    return fail('conflict');
                return this.getWorkflow(pid, old.workflow_id);
            }
            const count = this.db.prepare("SELECT count(*) AS n FROM workflow_records WHERE project_id=? AND kind='workflow'").get(pid) as {
                n: number;
            };
            if (count.n >= L.workflowsPerProject)
                return fail('limit');
            const workflow: Workflow = C.SurveyQualityWorkflowV1.parse({ schemaVersion: 1, id: `quality_workflow_${randomUUID()}`, projectId: pid, createdAt: this.now(), binding, request, semantics: 'caller-declared-workflow-only' });
            this.save('workflow', pid, workflow.id, workflow.id, 0, request.idempotencyKey, request, workflow);
            this.head(workflow.id, 0, SURVEY_QUALITY_CHAIN_GENESIS);
            return this.getWorkflow(pid, workflow.id);
        }).immediate();
    }
    appendEvent(pid: string, id: string, input: unknown): C.SurveyQualityWorkflowReadV1 {
        const request = this.parse(C.SurveyQualityWorkflowAppendV1, input);
        return this.db.transaction(() => {
            const current = this.getWorkflow(pid, id);
            const old = this.db.prepare('SELECT workflow_id,kind,request_hash FROM workflow_records WHERE project_id=? AND idempotency_key=?').get(pid, request.idempotencyKey) as {
                workflow_id: string;
                kind: string;
                request_hash: string;
            } | undefined;
            if (old) {
                if (old.kind !== 'event' || old.workflow_id !== id || old.request_hash !== digest(request))
                    return fail('conflict');
                return current;
            }
            if (request.expectedHeadHash !== current.headHash)
                return fail('stale');
            if (current.entries.length >= L.eventsPerWorkflow)
                return fail('limit');
            const sources = this.eventSources(pid, request);
            let event: SurveyQualityEventV1;
            try {
                event = appendSurveyQualityEvent(current.entries.map(e => e.event), { schemaVersion: 1, id: `quality_workflow_event_${randomUUID()}`, projectId: pid,
                    artifactSha256: current.workflow.binding.artifactHash, occurredAt: this.now(), actor: { kind: 'system', id: 'survey-quality-workflow' }, stage: 'declared-workflow', event: sources.event }).at(-1)!;
            }
            catch {
                return fail('invalid-transition');
            }
            const entry = C.SurveyQualityWorkflowEntryV1.parse({ request, event, evidenceBinding: sources.evidenceBinding, targetBinding: sources.targetBinding });
            this.save('event', pid, event.id, id, event.sequence, request.idempotencyKey, request, entry);
            this.head(id, event.sequence, event.thisHash);
            return this.getWorkflow(pid, id);
        }).immediate();
    }
    listWorkflows(pid: string, limit = 10, offset = 0) {
        this.project(pid);
        if (!Number.isInteger(limit) || limit < 1 || limit > L.pageSize || !Number.isInteger(offset) || offset < 0 || offset > L.workflowsPerProject)
            return fail('limit');
        return this.db.transaction(() => {
            const rows = this.db.prepare("SELECT id FROM workflow_records WHERE project_id=? AND kind='workflow' ORDER BY id LIMIT ? OFFSET ?").all(pid, limit + 1, offset) as Array<{
                id: string;
            }>;
            const workflows: C.SurveyQualityWorkflowReadV1[] = [], unavailable: Array<{
                id: string;
                reason: 'stale' | 'integrity' | 'source-changed' | 'not-found' | 'unavailable';
            }> = [];
            const cache = sourceCache();
            let consumed = 0, responseBytes = 1024;
            for (const row of rows.slice(0, limit)) {
                const previousBindings = new Map(cache.bindings), previousBytes = cache.bytes;
                try {
                    const item = this.read(pid, row.id, cache, false);
                    const size = Buffer.byteLength(JSON.stringify(item));
                    if (responseBytes + size > L.recordBytes && consumed > 0) {
                        cache.bindings = previousBindings;
                        cache.bytes = previousBytes;
                        break;
                    }
                    workflows.push(item);
                    responseBytes += size;
                }
                catch (e) {
                    const reason = e instanceof SurveyQualityWorkflowError ? e.reason : 'integrity';
                    cache.bindings = previousBindings;
                    cache.bytes = previousBytes;
                    // Shorten the page at the resource boundary instead of labelling a
                    // healthy next record corrupt. Its offset is retried on the next page.
                    if (reason === 'limit' && consumed > 0)
                        break;
                    unavailable.push({ id: row.id, reason: reason === 'limit' ? 'unavailable' : ['stale', 'source-changed', 'not-found', 'unavailable'].includes(reason) ? reason as 'stale' : 'integrity' });
                }
                consumed++;
            }
            // All first-pass reads precede the shared second pass, including when
            // multiple workflows reference the same retained bundle.
            this.verifySources(pid, cache);
            return C.SurveyQualityWorkflowListV1.parse({ workflows, unavailable, nextOffset: rows.length > consumed ? offset + consumed : null });
        })();
    }
}
