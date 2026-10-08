import type { AdjustmentResultV1 } from '../contracts/survey.js'
import type { SurveyProfessionalReviewV1 } from '../contracts/survey-professional.js'

/** Read-only interpretation of historical fields; never changes result bytes. */
export function surveyAiAdjustmentSemantics(result: AdjustmentResultV1, review?: SurveyProfessionalReviewV1 | null) {
  const closureCheck = review?.checks.find(check => check.id === 'closure')
  const verifiedSource = review?.source.status === 'bound' && review.source.integrity === 'verified'
  // Numerical route passes cannot be presented as verified evidence when the
  // retained source is absent, damaged or no longer bound to this result.
  const routes = verifiedSource ? review?.closures ?? [] : []
  const residualNorms = (['m', 'rad'] as const).flatMap(unit => {
    const rows = result.observations.filter(row => row.unit === unit)
    return rows.length ? [{ unit, value: rows.reduce((norm, row) => Math.hypot(norm, row.residual), 0), count: rows.length }] : []
  })
  const fittedPlaneStrategy = ['plane-control', 'triangulation', 'cpiii-free-station', 'cpiii-resection'].includes(result.strategyId ?? '')
  return {
    independentClosureCheck: {
      status: verifiedSource ? closureCheck?.status ?? 'not-evaluated' : 'not-evaluated',
      reason: !review ? 'professional-review-unavailable' : !verifiedSource ? review.source.status === 'mismatch' ? 'input-mismatch' : 'source-unverified' : closureCheck?.reason,
      sourceBinding: review?.source.status ?? 'unavailable',
      computationStage: 'before-adjustment',
      meaning: 'Independent checks from original route observations and declared reference controls. A missing check is not zero or a pass. These do not follow from fitted residuals.',
      routeCount: routes.length,
      routesReturned: Math.min(routes.length, 20),
      routesTruncated: routes.length > 20,
      routes: routes.slice(0, 20).map(route => ({
        ...route,
        members: route.members.slice(0, 20),
        memberCount: route.members.length,
        membersTruncated: route.members.length > 20
      }))
    },
    fittedResidualSummary: {
      status: 'descriptive-only',
      computationStage: 'after-adjustment',
      method: 'euclidean-norm-of-fitted-observation-residuals-grouped-by-unit',
      meaning: 'Describes how well the adjusted model fits observations. Never a pre-adjustment route closure, independent field check, significance test or standards decision.',
      residualNorms,
      observationsWithoutRecordedUnit: result.observations.filter(row => row.unit === undefined).length
    },
    legacyClosureSemantics: {
      authoritativeForProfessionalClosureChecks: false,
      meaning: 'The retained closure container mixes historical meanings. Use independentClosureCheck for route checks and fittedResidualSummary for fitted norms. Do not infer a professional pass from these historical values.',
      entries: Object.keys(result.closure).map(key => ({
        key,
        meaning: fittedPlaneStrategy && ['horizontal', 'angular'].includes(key)
          ? 'fitted-residual-norm-not-pre-adjustment-route-closure'
          : 'legacy-value-use-professional-checks-for-verified-meaning',
        ...(fittedPlaneStrategy && ['horizontal', 'angular'].includes(key) ? { computationStage: 'after-adjustment' } : {})
      }))
    }
  }
}
