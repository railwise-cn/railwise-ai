export { SurveyStaticIncrementalInputV1, SurveyStaticIncrementalOutputV1 } from '../../kun/src/contracts/survey-static-incremental.js'
export { SurveyReferenceDatumInputV1, SurveyReferenceDatumOutputV1 } from '../../kun/src/contracts/survey-reference-datum.js'
// Data-only schemas. Runtime algorithms and node:crypto never enter the renderer.
export { SurveyGeneralizedWRequestV1, SurveyGeneralizedWResultV1 } from '../../kun/src/contracts/survey-generalized-w.js'
export { SurveyVceTrialInputV1, SurveyVceTrialOutputV1 } from '../../kun/src/contracts/survey-vce-trial.js'
export { SurveyHuberTrialInputV1, SurveyHuberTrialOutputV1 } from '../../kun/src/contracts/survey-huber-trial.js'
export { SurveyStatisticalFamilyInputV1, SurveyStatisticalFamilyOutputV1 } from '../../kun/src/contracts/survey-statistical-family.js'
// This standalone lexer has no imports, Node APIs or numerical implementation.
export { parseAdvancedTrialJson } from '../../kun/src/engineering/survey-advanced-trials-json.js'
export {
  SURVEY_ADVANCED_TRIAL_LIMITS, SurveyAdvancedTrialCreateV1, SurveyAdvancedTrialKindV1,
  SurveyAdvancedTrialSummaryV1, SurveyAdvancedTrialRecordV1, SurveyAdvancedTrialListV1,
  SurveyAdvancedTrialReverifyRequestV1, SurveyAdvancedTrialVerificationV1
} from '../../kun/src/contracts/survey-advanced-trials-workspace.js'

export function runtimeSurveyAdvancedTrialsPath(projectId: string, trialId?: string, action?: 'reverify' | 'export'): string {
  return `/v1/engineering/projects/${encodeURIComponent(projectId)}/advanced-trials${trialId ? `/${encodeURIComponent(trialId)}` : ''}${action ? `/${action}` : ''}`
}
