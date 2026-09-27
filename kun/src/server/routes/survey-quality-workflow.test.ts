import { afterEach, describe, expect, it } from 'vitest';
import { Router } from '../router.js';
import type { JsonResponse } from '../response.js';
import { registerSurveyQualityWorkflowRoutes } from './survey-quality-workflow.js';
import { workflowFixture } from '../../engineering/survey-quality-workflow-test-helpers.js';
import { QUALITY_WORKFLOW_LIMITS as L } from '../../contracts/survey-quality-workflow.js';
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0))
    await close(); });
async function fixture() {
    const f = await workflowFixture();
    clean.push(f.close);
    const router = new Router();
    registerSurveyQualityWorkflowRoutes(router, { getService: () => f.service, authorize: r => r.headers.get('authorization') === 'Bearer test-secret' });
    const base = `/v1/engineering/projects/${f.project.id}/quality-workflows`;
    const call = async (path = base, method = 'GET', body?: string, auth = true) => { const match = router.match(method, path.split('?')[0]!)!; return await match.handler(new Request(`http://localhost${path}`, { method, body, headers: auth ? { authorization: 'Bearer test-secret' } : {} }), { params: match.params }) as JsonResponse; };
    return { ...f, router, base, call };
}
describe('authenticated declared workflow HTTP routes', () => {
    it('authorizes before service access and request-body reads', async () => {
        const router = new Router();
        registerSurveyQualityWorkflowRoutes(router, { getService: () => { throw new Error('service must not resolve'); }, authorize: () => false });
        const path = '/v1/engineering/projects/p/quality-workflows', match = router.match('POST', path)!, request = new Request(`http://localhost${path}`, { method: 'POST', body: '{}' });
        Object.defineProperty(request, 'body', { get() { throw new Error('body must not read'); } });
        const r = await match.handler(request, { params: match.params }) as JsonResponse;
        expect(r.status).toBe(401);
        expect(r.headers['cache-control']).toBe('no-store');
    });
    it('creates, appends, reads and lists strict caller-declared records with no-store', async () => {
        const f = await fixture(), created = await f.call(f.base, 'POST', JSON.stringify(f.request));
        expect(created.status).toBe(201);
        expect(created.headers['cache-control']).toBe('no-store');
        const w = JSON.parse(created.body), path = `${f.base}/${w.workflow.id}`;
        const appended = await f.call(`${path}/events`, 'POST', JSON.stringify({ expectedHeadHash: w.headHash, idempotencyKey: 'http-event-key', event: { kind: 'check', checkId: 'declared', outcome: 'failed', evidence: f.original.evidence } }));
        expect(appended.status).toBe(201);
        expect(JSON.parse(appended.body)).toMatchObject({ deliveryApproval: 'not-granted', recordedCheckCount: 1 });
        expect((await f.call(path)).body).toBe(appended.body);
        const listed = await f.call(`${f.base}?limit=1&offset=0`);
        expect(listed.status).toBe(200);
        expect(JSON.parse(listed.body).workflows).toHaveLength(1);
        expect((await f.call(f.base, 'POST', JSON.stringify(f.request), false)).status).toBe(401);
        expect((await f.call(`${f.base}/missing`)).status).toBe(404);
    });
    it('rejects unknown/duplicate fields, malformed UTF-8, oversized body and query injection', async () => {
        const f = await fixture();
        for (const body of ['{}', '{"planId":"a","planId":"b"}', JSON.stringify({ ...f.request, actor: 'human' }), '[1,2]'])
            expect((await f.call(f.base, 'POST', body)).status).toBe(400);
        expect((await f.call(f.base, 'POST', 'x'.repeat(L.requestBytes + 1))).status).toBe(429);
        for (const q of ['limit=21', 'offset=129', 'limit=1&limit=2', 'limit=01', 'foo=1'])
            expect((await f.call(`${f.base}?${q}`)).status).toBe(400);
        const match = f.router.match('POST', f.base)!, response = await match.handler(new Request(`http://localhost${f.base}`, { method: 'POST', headers: { authorization: 'Bearer test-secret' }, body: new Uint8Array([0xff]) }), { params: match.params }) as JsonResponse;
        expect(response.status).toBe(400);
    });
    it('reports source failures using fixed codes and hides source exception text', async () => {
        const f = await fixture();
        f.sources.retentionSnapshot = () => { throw new Error('/private/secret must not leak'); };
        const failure = await f.call(f.base, 'POST', JSON.stringify(f.request));
        expect(failure.status).toBe(503);
        expect(failure.body).not.toContain('secret');
        expect(JSON.parse(failure.body).code).toBe('quality_workflow_unavailable');
        const router = new Router();
        registerSurveyQualityWorkflowRoutes(router, { getService: () => undefined, authorize: () => true });
        const match = router.match('GET', f.base)!;
        expect((await match.handler(new Request(`http://localhost${f.base}`), { params: match.params }) as JsonResponse).status).toBe(503);
    });
});
