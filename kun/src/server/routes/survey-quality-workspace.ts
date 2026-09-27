import { z } from 'zod'
import type { Router } from '../router.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import { SurveyQualityWorkspaceError, type SurveyQualityWorkspaceService } from '../../engineering/survey-quality-workspace.js'
import { SurveyQualityPlanCreateV1, SurveyQualityEvidenceCreateV1, SurveyQualityRecordCreateV1, SurveyQualityCheckAppendV1 } from '../../contracts/survey-quality-workspace.js'

/** All handlers authenticate before resolving the optional service or reading
 * bodies. Neither auth token possession nor a posted actor authenticates a
 * professional signer; this API exposes local evidence retention only. */
export function registerSurveyQualityWorkspaceRoutes(router: Router, dependencies: {
  getService: () => SurveyQualityWorkspaceService | undefined
  authorize: (request: Request) => boolean
}): void {
  const base = '/v1/engineering/projects/:projectId'
  const inputs: Record<string, z.ZodType> = {
    '/quality-plans': SurveyQualityPlanCreateV1, '/quality-evidence': SurveyQualityEvidenceCreateV1,
    '/quality-records': SurveyQualityRecordCreateV1, '/quality-records/:recordId/checks': SurveyQualityCheckAppendV1,
    '/quality-records/:recordId/verify': z.object({}).strict()
  }
  const add = (method: 'GET' | 'POST', path: string, action: (service: SurveyQualityWorkspaceService, pid: string, params: Record<string, string>, request: Request, body: unknown) => unknown, status = 200): void => {
    router.add(method, base + path, async (request, context) => {
      if (!dependencies.authorize(request)) return ERRORS.unauthorized()
      const service = dependencies.getService()
      if (!service) return ERRORS.unavailable('survey quality evidence workspace is unavailable')
      const query = new URL(request.url).searchParams
      const collection = method === 'GET' && (path === '/quality-plans' || path === '/quality-records')
      for (const [name, value] of query) {
        if (!collection || !['limit', 'offset'].includes(name) || query.getAll(name).length !== 1
          || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))
          || (name === 'limit' ? Number(value) < 1 || Number(value) > 50 : Number(value) > 10000)) {
          return ERRORS.validation('invalid quality workspace query')
        }
      }
      let body: unknown
      if (method === 'POST') {
        const read = await readJsonBody(request)
        if (!read.ok) return read.response
        const parsed = inputs[path]!.safeParse(read.value)
        if (!parsed.success) return ERRORS.validation('invalid quality workspace request')
        body = parsed.data
      }
      let response: JsonResponse
      try { response = jsonResponse(action(service, context.params.projectId!, context.params, request, body), status) }
      catch (error) {
        if (error instanceof SurveyQualityWorkspaceError && error.reason === 'not-found') response = ERRORS.notFound('quality workspace reference not found in project')
        else response = jsonResponse({ code: `quality_workspace_${error instanceof SurveyQualityWorkspaceError ? error.reason.replaceAll('-', '_') : 'integrity'}`,
          message: 'quality workspace evidence is unavailable or changed; no approval or conformity is implied' }, 409)
      }
      response.headers['cache-control'] = 'no-store'
      return response
    })
  }
  const page = (request: Request): [number, number] => {
    const params = new URL(request.url).searchParams
    return [Number(params.get('limit') ?? 20), Number(params.get('offset') ?? 0)]
  }
  add('POST', '/quality-plans', (service, pid, _params, _request, body) => service.createPlan(pid, body), 201)
  add('GET', '/quality-plans', (service, pid, _params, request) => service.listPlans(pid, ...page(request)))
  add('GET', '/quality-plans/:planId', (service, pid, params) => service.getPlan(pid, params.planId!))
  add('POST', '/quality-evidence', (service, pid, _params, _request, body) => service.retainEvidence(pid, body), 201)
  add('POST', '/quality-records', (service, pid, _params, _request, body) => service.createRecord(pid, body), 201)
  add('GET', '/quality-records', (service, pid, _params, request) => service.listRecords(pid, ...page(request)))
  add('GET', '/quality-records/:recordId', (service, pid, params) => service.getRecord(pid, params.recordId!))
  add('POST', '/quality-records/:recordId/checks', (service, pid, params, _request, body) => service.appendCheck(pid, params.recordId!, body), 201)
  add('POST', '/quality-records/:recordId/verify', (service, pid, params, _request, body) => {
    z.object({}).strict().parse(body)
    return service.verifyRecord(pid, params.recordId!)
  })
}
