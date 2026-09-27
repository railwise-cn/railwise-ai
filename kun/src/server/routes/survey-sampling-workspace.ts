import type { Router } from '../router.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import { SurveySamplingWorkspaceError, type SurveySamplingWorkspaceService } from '../../engineering/survey-sampling-workspace.js'
import { SURVEY_SAMPLING_WORKSPACE_LIMITS as LIMITS, SurveySamplingPopulationCreateV1, SurveySamplingRunCreateV1, SurveySamplingVerifyRequestV1 } from '../../contracts/survey-quality-sampling-workspace.js'

/** Per-route raw byte bound and fatal UTF-8 decoding preserve the submitted
 * definition text. The global request limit is intentionally unchanged. */
async function body(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: JsonResponse }> {
  const tooLarge = () => ({ ok: false as const, response: jsonResponse({ code: 'payload_too_large', message: 'sampling request exceeds the allowed UTF-8 size', details: { limit: LIMITS.requestBytes } }, 413) })
  if (Number(request.headers.get('content-length')) > LIMITS.requestBytes) return tooLarge()
  if (!request.body) return { ok: true, value: {} }
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > LIMITS.requestBytes) { await reader.cancel('sampling body limit').catch(() => undefined); return tooLarge() }
      chunks.push(value)
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return { ok: true, value: text.length ? JSON.parse(text) : {} }
  } catch { return { ok: false, response: ERRORS.validation('invalid sampling JSON or UTF-8 body') } }
  finally { reader.releaseLock() }
}

export function registerSurveySamplingWorkspaceRoutes(router: Router, dependencies: {
  getService: () => SurveySamplingWorkspaceService | undefined
  authorize: (request: Request) => boolean
}): void {
  const base = '/v1/engineering/projects/:projectId'
  const add = (method: 'GET' | 'POST', path: string, paged: boolean,
    action: (service: SurveySamplingWorkspaceService, pid: string, params: Record<string, string>, input: unknown, page: [number, number]) => unknown,
    status = 200): void => {
    router.add(method, base + path, async (request, context) => {
      if (!dependencies.authorize(request)) return ERRORS.unauthorized()
      const service = dependencies.getService()
      if (!service) return ERRORS.unavailable('survey sampling workspace is unavailable')
      const query = new URL(request.url).searchParams
      for (const [name, value] of query) {
        if (!paged || !['limit', 'offset'].includes(name) || query.getAll(name).length !== 1
          || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))
          || (name === 'limit' ? Number(value) < 1 || Number(value) > LIMITS.pageSize : Number(value) > LIMITS.unitsPerPopulation)) {
          return ERRORS.validation('invalid sampling workspace query')
        }
      }
      const page: [number, number] = [Number(query.get('limit') ?? 20), Number(query.get('offset') ?? 0)]
      let input: unknown
      if (method === 'POST') {
        const read = await body(request)
        if (!read.ok) return read.response
        const schema = path === '/sampling-populations' ? SurveySamplingPopulationCreateV1
          : path === '/sampling-runs' ? SurveySamplingRunCreateV1 : SurveySamplingVerifyRequestV1
        const parsed = schema.safeParse(read.value)
        if (!parsed.success) return ERRORS.validation('invalid sampling workspace request')
        input = parsed.data
      }
      let response: JsonResponse
      try { response = jsonResponse(action(service, context.params.projectId!, context.params, input, page), status) }
      catch (error) {
        if (error instanceof SurveySamplingWorkspaceError && error.reason === 'not-found') response = ERRORS.notFound('sampling reference not found in project')
        else response = jsonResponse({ code: `sampling_workspace_${error instanceof SurveySamplingWorkspaceError ? error.reason.replaceAll('-', '_') : 'integrity'}`,
          message: 'sampling evidence is unavailable or changed; no conformity or professional approval is implied' }, 409)
      }
      response.headers['cache-control'] = 'no-store'
      return response
    })
  }
  add('POST', '/sampling-populations', false, (service, pid, _params, input) => service.createPopulation(pid, input), 201)
  add('GET', '/sampling-populations', true, (service, pid, _params, _input, page) => service.listPopulations(pid, ...page))
  add('GET', '/sampling-populations/:populationId', false, (service, pid, params) => service.getPopulation(pid, params.populationId!))
  add('GET', '/sampling-populations/:populationId/units', true, (service, pid, params, _input, page) => service.listUnits(pid, params.populationId!, ...page))
  add('POST', '/sampling-runs', false, (service, pid, _params, input) => service.createRun(pid, input), 201)
  add('GET', '/sampling-runs', true, (service, pid, _params, _input, page) => service.listRuns(pid, ...page))
  add('GET', '/sampling-runs/:runId', false, (service, pid, params) => service.getRun(pid, params.runId!))
  add('GET', '/sampling-runs/:runId/samples', true, (service, pid, params, _input, page) => service.listSamples(pid, params.runId!, ...page))
  add('POST', '/sampling-runs/:runId/verify', false, (service, pid, params) => service.verifyRun(pid, params.runId!))
}
