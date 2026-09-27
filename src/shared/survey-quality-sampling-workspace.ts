export {
  SURVEY_SAMPLING_WORKSPACE_LIMITS, SurveySamplingPopulationCreateV1, SurveySamplingPopulationSummaryV1,
  SurveySamplingPopulationDetailV1, SurveySamplingRunCreateV1, SurveySamplingRunSummaryV1,
  SurveySamplingPopulationListV1, SurveySamplingRunListV1, SurveySamplingUnitPageV1,
  SurveySamplingSamplePageV1, SurveySamplingVerificationV1, SurveySamplingVerifyRequestV1
} from '../../kun/src/contracts/survey-quality-sampling-workspace.js'

export function runtimeSurveySamplingPath(projectId: string, collection: 'populations' | 'runs', id?: string, action?: 'units' | 'samples' | 'verify'): string {
  return `/v1/engineering/projects/${encodeURIComponent(projectId)}/sampling-${collection}${id ? `/${encodeURIComponent(id)}` : ''}${action ? `/${action}` : ''}`
}
