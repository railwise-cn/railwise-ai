import type { Router } from '../router.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import { getSurveyStandardBasisCatalog, resolveSurveyStandardBasis, SurveyStandardBasisError } from '../../engineering/survey-standard-basis.js'

const noStore = (response: JsonResponse): JsonResponse => { response.headers['cache-control'] = 'no-store'; return response }
const queryNames = ['standardCode', 'standardVersion', 'sourceSha256', 'algorithmVersion', 'profileId', 'profileVersion'] as const

/** Authenticated metadata reads only. Never routes to a quality executor or writes a project. */
export function registerSurveyStandardBasisRoutes(router: Router, dependencies: { authorize: (request: Request) => boolean }): void {
  const base = '/v1/engineering/standard-basis'
  router.add('GET', base, request => {
    if (!dependencies.authorize(request)) return noStore(ERRORS.unauthorized())
    if (new URL(request.url).search) return noStore(ERRORS.validation('standard basis catalog does not accept query parameters'))
    return noStore(jsonResponse(getSurveyStandardBasisCatalog()))
  })
  router.add('GET', `${base}/:ruleId/:ruleVersion`, (request, context) => {
    if (!dependencies.authorize(request)) return noStore(ERRORS.unauthorized())
    const query = new URL(request.url).searchParams
    if (query.size !== queryNames.length || queryNames.some(name => query.getAll(name).length !== 1)) {
      return noStore(ERRORS.validation('exact standard basis identity is required'))
    }
    try {
      return noStore(jsonResponse(resolveSurveyStandardBasis({ ...Object.fromEntries(query), ...context.params })))
    } catch (error) {
      const reason = error instanceof SurveyStandardBasisError ? error.reason : 'validation'
      return noStore(jsonResponse({ code: `standard_basis_${reason.replaceAll('-', '_')}`,
        message: 'The exact requested basis is unavailable; no newer version, approval or conformity is inferred.' },
      reason === 'validation' ? 400 : reason === 'exact-rule-version-unavailable' ? 404 : 409))
    }
  })
}
