import { SurveyFreeLevelingServiceError, type SurveyService } from '../../engineering/survey-service.js'
import { FreeLevelingError } from '../../engineering/survey-free-leveling.js'
import { SurveyFreeLevelingTrialRequestV1 } from '../../contracts/survey-free-leveling.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

function result(value: unknown, status = 200): JsonResponse {
  const response = value === null ? ERRORS.notFound('trial or network not found in project') : jsonResponse(value, status)
  response.headers['cache-control'] = 'no-store'
  return response
}
function conflict(error: unknown): JsonResponse {
  const reason = error instanceof SurveyFreeLevelingServiceError ? error.reason : error instanceof FreeLevelingError ? error.reason : 'stale'
  const diagnostics = error instanceof FreeLevelingError ? Object.fromEntries(Object.entries(error.diagnostics).filter(([key, value]) =>
    ['criterion', 'rank', 'requiredRank', 'relativePivotTolerance', 'value', 'maximum'].includes(key)
      && (typeof value === 'number' && Number.isFinite(value) || value === null || key === 'criterion' && typeof value === 'string'))) : undefined
  const response = jsonResponse({ code: `free_leveling_${reason.replaceAll('-', '_')}`, message: 'free leveling trial could not be used', details: { reason, ...(diagnostics ? { diagnostics } : {}) } }, 409)
  response.headers['cache-control'] = 'no-store'
  return response
}

export async function createFreeLevelingTrial(service: SurveyService | undefined, request: Request, projectId: string, networkId: string): Promise<JsonResponse | Response> {
  if (!service) return ERRORS.unavailable('survey trial service is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = SurveyFreeLevelingTrialRequestV1.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid free leveling trial request; explicit datum release and weight policy are required')
  try { return result(service.createFreeLevelingTrial(projectId, networkId, parsed.data), 201) } catch (error) { return conflict(error) }
}

export function listFreeLevelingTrials(service: SurveyService | undefined, request: Request, projectId: string, networkId: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey trial service is unavailable')
  const url = new URL(request.url)
  const limit = Number(url.searchParams.get('limit') ?? 20), offset = Number(url.searchParams.get('offset') ?? 0)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(offset) || offset < 0 || offset > 100_000) return ERRORS.validation('invalid trial pagination')
  try { return result(service.listFreeLevelingTrials(projectId, networkId, limit, offset)) } catch (error) { return conflict(error) }
}

export function getFreeLevelingTrial(service: SurveyService | undefined, request: Request, projectId: string, networkId: string, trialId: string): JsonResponse {
  if (!service) return ERRORS.unavailable('survey trial service is unavailable')
  try {
    const response = result(service.getFreeLevelingTrial(projectId, networkId, trialId))
    if (response.status === 200 && new URL(request.url).searchParams.get('download') === '1') response.headers['content-disposition'] = 'attachment; filename="survey-free-leveling-trial.json"'
    return response
  } catch (error) { return conflict(error) }
}
