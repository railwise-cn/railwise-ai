import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { DeliverableManifestV1 } from '../contracts/engineering.js';
import { SurveyQualityWorkspaceService } from './survey-quality-workspace.js';
import { SurveyQualityWorkflowService } from './survey-quality-workflow.js';
import type { SurveyQualityWorkflowSources } from './survey-quality-workflow.js';
export async function workflowFixture() {
    const root = await mkdtemp(join(tmpdir(), 'quality-workflow-')), workspace = join(root, 'workspace');
    const project = { id: 'project-a', revision: 1, workspace }, manifests = new Map<string, DeliverableManifestV1>();
    const retention = new SurveyQualityWorkspaceService({ rootDir: root, getProject: pid => pid === project.id ? project : null, getManifest: (pid, id) => pid === project.id ? manifests.get(id) ?? null : null, nowIso: () => '2026-09-24T01:00:00.000Z' });
    const make = async (suffix: string) => {
        const output = join(workspace, '.workwise', 'deliverables', project.id, `run-${suffix}`, 'report.txt'), bytes = Buffer.from(`retained report ${suffix}`);
        await mkdir(join(output, '..'), { recursive: true });
        await writeFile(output, bytes);
        const manifest = DeliverableManifestV1.parse({ schemaVersion: 1, id: `manifest-${suffix}`, projectId: project.id, runId: `run-${suffix}`, inputDatasets: [], analyses: [], charts: [], citations: [], adjustments: [], deformations: [], surveySources: [], outputs: [{ path: relative(workspace, output), mediaType: 'text/plain', sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length }], validation: { valid: true, errors: [], warnings: [] }, reviewStatus: 'draft', runtimeVersion: 'test', createdAt: '2026-09-24T01:00:00.000Z' });
        manifests.set(manifest.id, manifest);
        await writeFile(join(output, '..', 'manifest.json'), JSON.stringify(manifest));
        const plan = retention.createPlan(project.id, { manifestId: manifest.id, expectedProjectRevision: 1, idempotencyKey: `plan-key-${suffix}`, requiredEvidence: [] });
        const record = retention.createRecord(project.id, { planId: plan.plan.id, idempotencyKey: `record-key-${suffix}` });
        const ref = { planId: plan.plan.id, recordId: record.record.id, expectedRetentionHeadHash: record.verification.headHash };
        return { manifest, output, plan, record, ref, evidence: { ...ref, memberId: 'output-1' } };
    };
    const original = await make('original'), corrected = await make('corrected');
    const sources: SurveyQualityWorkflowSources = { getProject: pid => pid === project.id ? project : null, retentionSnapshot: (pid, p, r) => retention.getAssessmentSnapshot(pid, p, r) };
    const options = { rootDir: root, sources, nowIso: () => '2026-09-24T01:00:01.000Z' }, services = [new SurveyQualityWorkflowService(options)];
    const service = services[0]!, request = { ...original.ref, expectedProjectRevision: 1, idempotencyKey: 'workflow-create-1' };
    return { root, project, original, corrected, retention, sources, service, request, make,
        reopen: () => { const s = new SurveyQualityWorkflowService(options); services.push(s); return s; },
        db: (): Database.Database => new Database(join(root, 'survey-quality-workflow.sqlite3')),
        close: async () => { services.forEach(s => s.close()); retention.close(); await rm(root, { recursive: true, force: true }); } };
}
