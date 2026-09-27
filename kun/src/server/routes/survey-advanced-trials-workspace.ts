import type { Router } from '../router.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import { SURVEY_ADVANCED_TRIAL_LIMITS as L, SurveyAdvancedTrialReverifyRequestV1 } from '../../contracts/survey-advanced-trials-workspace.js'
import { SurveyAdvancedTrialsError, type SurveyAdvancedTrialsWorkspaceService } from '../../engineering/survey-advanced-trials-workspace.js'
import { parseAdvancedTrialJson } from '../../engineering/survey-advanced-trials-json.js'

const noStore = (response: JsonResponse): JsonResponse => { response.headers['cache-control'] = 'no-store'; return response }
async function body(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length')) > L.requestBytes) throw new SurveyAdvancedTrialsError('limit')
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
    void reader.cancel('advanced trial body timeout').catch(() => undefined)
    reject(new SurveyAdvancedTrialsError('validation'))
  }, 20_000); timer.unref?.() })
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), timeout])
      if (done) break
      length += value.byteLength
      if (length > L.requestBytes) { await reader.cancel('advanced trial body limit').catch(() => undefined); throw new SurveyAdvancedTrialsError('limit') }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally { clearTimeout(timer); reader.releaseLock() }
}
function failure(error: unknown): JsonResponse {
  const reason = error instanceof SurveyAdvancedTrialsError ? error.reason : 'integrity'
  const status = reason === 'not-found' ? 404 : reason === 'validation' ? 400 : reason === 'rate-limit' ? 429 : reason === 'limit' ? 413 : 409
  const response = noStore(jsonResponse({ code: `advanced_trials_${reason.replaceAll('-', '_')}`,
    message: 'The declared-model trial is unavailable or could not be verified; no engineering decision is implied.' }, status))
  if (reason === 'rate-limit') response.headers['retry-after'] = '60'
  return response
}

export function registerSurveyAdvancedTrialsWorkspaceRoutes(router: Router, dependencies: {
  getService: () => SurveyAdvancedTrialsWorkspaceService | undefined; authorize: (request: Request) => boolean
}): void {
  const base = '/v1/engineering/projects/:projectId/advanced-trials'
  for (const operation of ['create', 'list', 'detail', 'reverify', 'export'] as const) {
    const method = operation === 'create' || operation === 'reverify' ? 'POST' : 'GET'
    const path = base + (operation === 'create' || operation === 'list' ? '' : '/:trialId' + (operation === 'detail' ? '' : `/${operation}`))
    router.add(method, path, async (request, context) => {
      if (!dependencies.authorize(request)) return noStore(ERRORS.unauthorized())
      const service = dependencies.getService()
      if (!service) return noStore(ERRORS.unavailable('advanced trial workspace is unavailable'))
      const query = new URL(request.url).searchParams
      for (const [name, value] of query) {
        if (operation !== 'list' || !['limit', 'offset'].includes(name) || query.getAll(name).length !== 1 || !/^(0|[1-9]\d*)$/.test(value)
          || !Number.isSafeInteger(Number(value)) || (name === 'limit' ? Number(value) < 1 || Number(value) > L.pageSize : Number(value) > L.trialsPerProject)) {
          return noStore(ERRORS.validation('invalid advanced trials query'))
        }
      }
      const pid = context.params.projectId!, id = context.params.trialId!
      try {
        let value: unknown
        if (operation === 'create') value = service.createTrial(pid, await body(request))
        else if (operation === 'list') value = service.listTrials(pid, Number(query.get('limit') ?? 10), Number(query.get('offset') ?? 0))
        else if (operation === 'reverify') {
          const raw = await body(request)
          try { SurveyAdvancedTrialReverifyRequestV1.parse(parseAdvancedTrialJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw))) }
          catch { throw new SurveyAdvancedTrialsError('validation') }
          value = service.reverifyTrial(pid, id)
        } else value = service.getTrial(pid, id)
        const response = noStore(jsonResponse(value, operation === 'create' ? 201 : 200))
        if (operation === 'export') response.headers['content-disposition'] = 'attachment; filename="survey-advanced-trial.json"'
        return response
      } catch (error) { return failure(error) }
    })
  }
}
