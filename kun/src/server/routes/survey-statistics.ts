import type { SurveyService } from '../../engineering/survey-service.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

export function getStatisticalDiagnostics(service: SurveyService | undefined, projectId: string, adjustmentId: string, download = false): JsonResponse {
  if (!service) return ERRORS.unavailable('survey adjustment service is unavailable')
  try {
    const diagnostic = service.getAdjustmentStatisticalDiagnostics(projectId, adjustmentId)
    if (!diagnostic) return ERRORS.notFound('adjustment not found in project')
    const response = jsonResponse(diagnostic)
    response.headers['cache-control'] = 'no-store'
    if (download) response.headers['content-disposition'] = 'attachment; filename="survey-statistical-diagnostics.json"'
    return response
  } catch {
    // Admission errors may quote source findings or instrument identifiers.
    return ERRORS.conflict('adjustment evidence is stale, unavailable, or inconsistent; statistical diagnostics were not generated')
  }
}
