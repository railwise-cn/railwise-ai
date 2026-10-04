import { readJsonBody } from '../read-json-body.js'
import { jsonResponse } from '../response.js'
import type { Router } from '../router.js'
import type { SurveyService } from '../../engineering/survey-service.js'
import { ERRORS } from './runtime-error.js'

export function registerSurveyMonitoringRoutes(router: Router, options: {
  authorize: (request: Request) => boolean; getService: () => SurveyService | undefined
}): void {
  const base = '/v1/engineering/projects/:projectId/survey'
  router.add('GET', `${base}/initial-values`, async (request, context) => {
    if (!options.authorize(request)) return ERRORS.unauthorized()
    const service = options.getService()
    if (!service) return ERRORS.unavailable('survey service unavailable')
    if (new URL(request.url).search) return ERRORS.validation('initial value history does not accept query parameters')
    try { return jsonResponse({ events: service.listInitialValueEvents(context.params.projectId) }) }
    catch (error) { return ERRORS.validation(error instanceof Error ? error.message : 'initial value history unavailable') }
  })
  for (const [suffix, operation] of [
    ['initial-values', (service: SurveyService, projectId: string, input: unknown) => ({ event: service.changeInitialValue(projectId, input) })],
    ['segment-comparisons', (service: SurveyService, projectId: string, input: unknown) => ({ comparison: service.comparePeriodSegments(projectId, input) })]
  ] as const) {
    router.add('POST', `${base}/${suffix}`, async (request, context) => {
      if (!options.authorize(request)) return ERRORS.unauthorized()
      const service = options.getService()
      if (!service) return ERRORS.unavailable('survey service unavailable')
      if (new URL(request.url).search) return ERRORS.validation('monitoring operations do not accept query parameters')
      const body = await readJsonBody(request, 256 * 1024)
      if (!body.ok) return body.response
      try { return jsonResponse(operation(service, context.params.projectId, body.value), 201) }
      catch (error) { return ERRORS.validation(error instanceof Error ? error.message : 'monitoring operation failed') }
    })
  }
}
