import type { Router } from '../router.js';
import { jsonResponse, type JsonResponse } from '../response.js';
import { ERRORS } from './runtime-error.js';
import { QUALITY_WORKFLOW_LIMITS as L } from '../../contracts/survey-quality-workflow.js';
import { SurveyQualityWorkflowError, type SurveyQualityWorkflowService } from '../../engineering/survey-quality-workflow.js';
import { parseAdvancedTrialJson } from '../../engineering/survey-advanced-trials-json.js';
const noStore = (response: JsonResponse): JsonResponse => { response.headers['cache-control'] = 'no-store'; return response; };
async function body(request: Request): Promise<unknown> {
    if (Number(request.headers.get('content-length')) > L.requestBytes)
        throw new SurveyQualityWorkflowError('limit');
    if (!request.body)
        throw new SurveyQualityWorkflowError('validation');
    const reader = request.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => undefined); reject(new SurveyQualityWorkflowError('validation')); }, 20000); timer.unref?.(); });
    try {
        while (true) {
            const next = await Promise.race([reader.read(), timeout]);
            if (next.done)
                break;
            bytes += next.value.length;
            if (bytes > L.requestBytes) {
                await reader.cancel().catch(() => undefined);
                throw new SurveyQualityWorkflowError('limit');
            }
            chunks.push(next.value);
        }
        try {
            return parseAdvancedTrialJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
        }
        catch {
            throw new SurveyQualityWorkflowError('validation');
        }
    }
    finally {
        clearTimeout(timer);
        reader.releaseLock();
    }
}
export function registerSurveyQualityWorkflowRoutes(router: Router, dependencies: {
    getService: () => SurveyQualityWorkflowService | undefined;
    authorize: (request: Request) => boolean;
}): void {
    const base = '/v1/engineering/projects/:projectId/quality-workflows';
    for (const operation of ['create', 'list', 'detail', 'append'] as const) {
        const method = operation === 'create' || operation === 'append' ? 'POST' : 'GET';
        const path = base + (operation === 'detail' || operation === 'append' ? `/:workflowId${operation === 'append' ? '/events' : ''}` : '');
        router.add(method, path, async (request, context) => {
            if (!dependencies.authorize(request))
                return noStore(ERRORS.unauthorized());
            const service = dependencies.getService();
            if (!service)
                return noStore(ERRORS.unavailable('quality workflow unavailable'));
            const query = new URL(request.url).searchParams;
            for (const [name, value] of query)
                if (operation !== 'list' || !['limit', 'offset'].includes(name) || query.getAll(name).length !== 1 || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)) || (name === 'limit' ? Number(value) < 1 || Number(value) > L.pageSize : Number(value) > L.workflowsPerProject))
                    return noStore(ERRORS.validation('invalid workflow query'));
            try {
                const pid = context.params.projectId!, id = context.params.workflowId!;
                const value = operation === 'create' ? service.createWorkflow(pid, await body(request)) : operation === 'append' ? service.appendEvent(pid, id, await body(request)) : operation === 'list' ? service.listWorkflows(pid, Number(query.get('limit') ?? 10), Number(query.get('offset') ?? 0)) : service.getWorkflow(pid, id);
                return noStore(jsonResponse(value, method === 'POST' ? 201 : 200));
            }
            catch (error) {
                const reason = error instanceof SurveyQualityWorkflowError ? error.reason : 'integrity';
                const status = reason === 'validation' ? 400 : reason === 'not-found' ? 404 : reason === 'limit' ? 429 : reason === 'unavailable' ? 503 : 409;
                return noStore(jsonResponse({ code: `quality_workflow_${reason.replaceAll('-', '_')}`, message: 'Declared workflow unavailable; no approval or signature is implied.' }, status));
            }
        });
    }
}
