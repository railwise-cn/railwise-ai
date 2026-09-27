import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { QUALITY_WORKFLOW_LIMITS as L } from '../contracts/survey-quality-workflow.js';
import { workflowFixture } from './survey-quality-workflow-test-helpers.js';
import type { SurveyQualityWorkflowReadV1 } from '../contracts/survey-quality-workflow.js';
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of clean.splice(0))
    await c(); });
async function fixture() { const f = await workflowFixture(); clean.push(f.close); return f; }
type F = Awaited<ReturnType<typeof fixture>>;
const check = (f: F, head: string, key = 'event-check-1', checkId = 'check-1') => ({ expectedHeadHash: head, idempotencyKey: key, event: { kind: 'check' as const, checkId, outcome: 'failed' as const, evidence: f.original.evidence } });
function opened(f: F) { let w = f.service.createWorkflow(f.project.id, f.request); w = f.service.appendEvent(f.project.id, w.workflow.id, check(f, w.headHash)); return f.service.appendEvent(f.project.id, w.workflow.id, { expectedHeadHash: w.headHash, idempotencyKey: 'event-open-1', event: { kind: 'issue-opened', issueId: 'issue-1', checkId: 'check-1', evidence: f.original.evidence } }); }
const correction = (f: F, w: SurveyQualityWorkflowReadV1) => ({ expectedHeadHash: w.headHash, idempotencyKey: 'event-correct-1', event: { kind: 'correction-recorded' as const, issueId: 'issue-1', correctionId: 'correction-1', corrected: f.corrected.ref, evidence: f.corrected.evidence } });
describe('durable caller-declared quality workflow', () => {
    it('binds actual retained bytes, persists correction/recheck, reopens and never changes retention or draft approval', async () => {
        const f = await fixture(), before = f.retention.getRecord(f.project.id, f.original.record.record.id), open = opened(f);
        expect(open.openIssueCount).toBe(1);
        const corrected = f.service.appendEvent(f.project.id, open.workflow.id, correction(f, open));
        const request = { expectedHeadHash: corrected.headHash, idempotencyKey: 'event-recheck-1', event: { kind: 'issue-rechecked' as const, issueId: 'issue-1', correctionId: 'correction-1', rechecked: f.corrected.ref, outcome: 'resolved' as const, evidence: f.corrected.evidence } };
        const done = f.service.appendEvent(f.project.id, open.workflow.id, request);
        expect(done).toMatchObject({ openIssueCount: 0, recordedCheckCount: 1, recordIntegrity: true, deliveryApproval: 'not-granted', semantics: 'caller-declared-workflow-only', humanSignatureVerification: 'not-evaluated', standardConformity: 'not-evaluated' });
        expect(done.entries[2]!.event.event).toMatchObject({ correctedArtifactSha256: f.corrected.plan.artifact.bundleHash, evidenceSha256: f.corrected.manifest.outputs[0]!.sha256 });
        expect(f.service.appendEvent(f.project.id, open.workflow.id, request)).toEqual(done);
        expect(f.service.createWorkflow(f.project.id, f.request)).toEqual(done);
        expect(f.reopen().getWorkflow(f.project.id, open.workflow.id)).toEqual(done);
        expect(f.service.listWorkflows(f.project.id).workflows).toEqual([done]);
        expect(f.retention.getRecord(f.project.id, f.original.record.record.id)).toEqual(before);
        expect(f.original.manifest.reviewStatus).toBe('draft');
        expect(f.corrected.manifest.reviewStatus).toBe('draft');
    });
    it('enforces transitions, exact target and unresolved state', async () => {
        const f = await fixture(), open = opened(f);
        expect(() => f.service.appendEvent(f.project.id, open.workflow.id, { ...correction(f, open), event: { ...correction(f, open).event, corrected: f.original.ref } })).toThrow('invalid-transition');
        const corrected = f.service.appendEvent(f.project.id, open.workflow.id, correction(f, open));
        const recheck = { expectedHeadHash: corrected.headHash, idempotencyKey: 'event-recheck-1', event: { kind: 'issue-rechecked' as const, issueId: 'issue-1', correctionId: 'correction-1', rechecked: f.corrected.ref, outcome: 'unresolved' as const, evidence: f.corrected.evidence } };
        expect(() => f.service.appendEvent(f.project.id, open.workflow.id, { ...recheck, event: { ...recheck.event, rechecked: f.original.ref } })).toThrow('invalid-transition');
        const unresolved = f.service.appendEvent(f.project.id, open.workflow.id, recheck);
        expect(unresolved.openIssueCount).toBe(1);
        expect(() => f.service.appendEvent(f.project.id, open.workflow.id, { expectedHeadHash: unresolved.headHash, idempotencyKey: 'duplicate-issue-key', event: { kind: 'issue-opened', issueId: 'issue-1', checkId: 'check-1', evidence: f.original.evidence } })).toThrow('invalid-transition');
    });
    it('rejects unknown checks, naked hashes, actor claims, missing members and cross-project access', async () => {
        const f = await fixture(), w = f.service.createWorkflow(f.project.id, f.request);
        expect(() => f.service.appendEvent(f.project.id, w.workflow.id, { expectedHeadHash: w.headHash, idempotencyKey: 'open-no-check-key', event: { kind: 'issue-opened', issueId: 'i', checkId: 'missing', evidence: f.original.evidence } })).toThrow('invalid-transition');
        for (const extra of [{ actor: { kind: 'human', id: 'approver' } }, { event: { kind: 'check', checkId: 'c', outcome: 'passed', evidence: f.original.evidence } }, { event: { kind: 'check', checkId: 'c', outcome: 'failed', evidenceSha256: 'a'.repeat(64) } }])
            expect(() => f.service.appendEvent(f.project.id, w.workflow.id, { ...check(f, w.headHash), ...extra })).toThrow('validation');
        expect(() => f.service.appendEvent(f.project.id, w.workflow.id, { ...check(f, w.headHash), event: { ...check(f, w.headHash).event, evidence: { ...f.original.evidence, memberId: 'missing' } } })).toThrow('invalid-reference');
        expect(() => f.service.getWorkflow('other-project', w.workflow.id)).toThrow('not-found');
        expect(() => f.service.createWorkflow('other-project', f.request)).toThrow('not-found');
    });
    it('serializes two connections and rejects stale heads or idempotency argument conflicts', async () => {
        const f = await fixture(), w = f.service.createWorkflow(f.project.id, f.request), peer = f.reopen(), request = check(f, w.headHash);
        const one = f.service.appendEvent(f.project.id, w.workflow.id, request);
        expect(() => peer.appendEvent(f.project.id, w.workflow.id, check(f, w.headHash, 'event-check-2', 'check-2'))).toThrow('stale');
        expect(() => peer.appendEvent(f.project.id, w.workflow.id, { ...request, expectedHeadHash: one.headHash })).toThrow('conflict');
        expect(() => peer.createWorkflow(f.project.id, { ...f.request, planId: f.corrected.ref.planId, recordId: f.corrected.ref.recordId })).toThrow('conflict');
        expect(peer.appendEvent(f.project.id, w.workflow.id, check(f, one.headHash, 'event-check-2', 'check-2')).entries).toHaveLength(2);
    });
    it('revalidates project revision/workspace and strict original and correction sources on every read', async () => {
        const f = await fixture(), w = opened(f), originalWorkspace = f.project.workspace;
        f.project.revision++;
        expect(() => f.service.getWorkflow(f.project.id, w.workflow.id)).toThrow('stale');
        f.project.revision--;
        f.project.workspace = '/changed/workspace';
        expect(() => f.service.getWorkflow(f.project.id, w.workflow.id)).toThrow('stale');
        f.project.workspace = originalWorkspace;
        const corrected = f.service.appendEvent(f.project.id, w.workflow.id, correction(f, w));
        await writeFile(f.corrected.output, 'tampered');
        expect(() => f.service.getWorkflow(f.project.id, corrected.workflow.id)).toThrow('stale');
        expect(f.service.listWorkflows(f.project.id).unavailable).toEqual([{ id: w.workflow.id, reason: 'stale' }]);
    });
    it('rejects changed retention heads and rolls back new writes on source changes before commit', async () => {
        const f = await fixture(), w = f.service.createWorkflow(f.project.id, f.request), read = f.sources.retentionSnapshot;
        let calls = 0;
        f.sources.retentionSnapshot = (...args) => { const result = read(...args); if (++calls === 3)
            f.retention.appendCheck(f.project.id, f.original.record.record.id, { expectedHeadHash: f.original.ref.expectedRetentionHeadHash, idempotencyKey: 'late-retention-check', checkId: 'artifact-bytes' }); return result; };
        expect(() => f.service.appendEvent(f.project.id, w.workflow.id, check(f, w.headHash))).toThrow('source-changed');
        const db = f.db();
        try {
            expect(db.prepare("SELECT count(*) AS n FROM workflow_records WHERE kind='event'").get()).toEqual({ n: 0 });
            expect(db.prepare('SELECT count(*) AS n FROM workflow_heads').get()).toEqual({ n: 1 });
        }
        finally {
            db.close();
        }
    });
    it('detects SQL/JSON identity tampering and truncated heads, with append-only triggers', async () => {
        const f = await fixture(), w = opened(f), db = f.db();
        try {
            expect(() => db.prepare('DELETE FROM workflow_records').run()).toThrow('append-only');
            expect(() => db.prepare("UPDATE workflow_records SET data_json='{}'").run()).toThrow('append-only');
            db.exec('DROP TRIGGER workflow_records_no_update');
            db.prepare("UPDATE workflow_records SET project_id='other' WHERE kind='event'").run();
            expect(() => f.service.getWorkflow(f.project.id, w.workflow.id)).toThrow('integrity');
        }
        finally {
            db.close();
        }
        const g = await fixture(), v = opened(g), other = g.db();
        try {
            other.exec('DROP TRIGGER workflow_heads_no_delete');
            other.prepare('DELETE FROM workflow_heads WHERE sequence=2').run();
            expect(() => g.service.getWorkflow(g.project.id, v.workflow.id)).toThrow('integrity');
        }
        finally {
            other.close();
        }
    });
    it('rolls back an event when the atomic head write fails and rejects an edited JSON envelope', async () => {
        const f = await fixture(), w = f.service.createWorkflow(f.project.id, f.request), db = f.db();
        try {
            db.exec("CREATE TRIGGER fail_workflow_head BEFORE INSERT ON workflow_heads WHEN NEW.sequence=1 BEGIN SELECT RAISE(ABORT,'simulated full disk'); END");
            expect(() => f.service.appendEvent(f.project.id, w.workflow.id, check(f, w.headHash))).toThrow('simulated full disk');
            expect(f.service.getWorkflow(f.project.id, w.workflow.id)).toEqual(w);
            db.exec('DROP TRIGGER fail_workflow_head');
            f.service.appendEvent(f.project.id, w.workflow.id, check(f, w.headHash));
            db.exec('DROP TRIGGER workflow_records_no_update');
            db.prepare("UPDATE workflow_records SET data_json='{}' WHERE kind='event'").run();
            expect(() => f.service.getWorkflow(f.project.id, w.workflow.id)).toThrow('integrity');
        }
        finally {
            db.close();
        }
    });
    it('uses two page-wide passes and shortens source-budget pages without dropping the next item', async () => {
        const f = await fixture();
        for (let i = 0; i < 20; i++)
            f.service.createWorkflow(f.project.id, { ...f.request, idempotencyKey: `same-source-workflow-${i}` });
        const read = f.sources.retentionSnapshot;
        let calls = 0;
        f.sources.retentionSnapshot = (...args) => { calls++; return read(...args); };
        expect(f.service.listWorkflows(f.project.id, 20).workflows).toHaveLength(20);
        expect(calls).toBe(2);
        const g = await fixture();
        for (let i = 0; i < L.sourcesPerWorkflow + 1; i++) {
            const source = await g.make(`page-${i}`);
            g.service.createWorkflow(g.project.id, { ...source.ref, expectedProjectRevision: 1, idempotencyKey: `page-workflow-${i}` });
        }
        const page = g.service.listWorkflows(g.project.id, 20);
        expect(page.workflows).toHaveLength(L.sourcesPerWorkflow);
        expect(page.unavailable).toEqual([]);
        expect(page.nextOffset).toBe(L.sourcesPerWorkflow);
        const next = g.service.listWorkflows(g.project.id, 20, page.nextOffset!);
        expect(next.workflows).toHaveLength(1);
        expect(next.nextOffset).toBeNull();
    });
    it('isolates unavailable history and rejects creation from mismatched source heads', async () => {
        const f = await fixture(), first = f.service.createWorkflow(f.project.id, f.request);
        const other = f.service.createWorkflow(f.project.id, { ...f.corrected.ref, expectedProjectRevision: 1, idempotencyKey: 'other-source-workflow' });
        await writeFile(f.original.output, 'changed');
        const page = f.service.listWorkflows(f.project.id);
        expect(page.workflows.map(w => w.workflow.id)).toEqual([other.workflow.id]);
        expect(page.unavailable).toEqual([{ id: first.workflow.id, reason: 'stale' }]);
        expect(() => f.service.createWorkflow(f.project.id, { ...f.corrected.ref, expectedRetentionHeadHash: 'f'.repeat(64), expectedProjectRevision: 1, idempotencyKey: 'bad-head-workflow' })).toThrow('source-changed');
    });
    it('bounds body, pagination, per-project creation and event capacity with cached source verification', async () => {
        const f = await fixture();
        expect(() => f.service.createWorkflow(f.project.id, { ...f.request, extra: 'x'.repeat(L.requestBytes) })).toThrow('limit');
        for (let i = 0; i < L.workflowsPerProject; i++)
            f.service.createWorkflow(f.project.id, { ...f.request, idempotencyKey: `workflow-capacity-${i}` });
        expect(() => f.service.createWorkflow(f.project.id, f.request)).toThrow('limit');
        const page = f.service.listWorkflows(f.project.id, 2);
        expect(page.workflows).toHaveLength(2);
        expect(page.nextOffset).toBe(2);
        expect(() => f.service.listWorkflows(f.project.id, L.pageSize + 1)).toThrow('limit');
        const g = await fixture();
        let w = g.service.createWorkflow(g.project.id, g.request);
        for (let i = 0; i < L.eventsPerWorkflow; i++)
            w = g.service.appendEvent(g.project.id, w.workflow.id, check(g, w.headHash, `capacity-event-${i}`, `check-${i}`));
        expect(() => g.service.appendEvent(g.project.id, w.workflow.id, check(g, w.headHash, 'capacity-event-overflow', 'over'))).toThrow('limit');
        const read = g.sources.retentionSnapshot;
        let calls = 0;
        g.sources.retentionSnapshot = (...args) => { calls++; return read(...args); };
        expect(g.service.getWorkflow(g.project.id, w.workflow.id).entries).toHaveLength(L.eventsPerWorkflow);
        expect(calls).toBe(2);
        expect(g.service.listWorkflows(g.project.id).workflows[0]!.entries).toHaveLength(L.eventsPerWorkflow);
    }, 30000);
});
