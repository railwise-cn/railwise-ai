export {
  QUALITY_WORKFLOW_LIMITS,
  SurveyQualityWorkflowSourceV1,
  SurveyQualityWorkflowEvidenceV1,
  SurveyQualityWorkflowCreateV1,
  SurveyQualityWorkflowDeclaredEventV1,
  SurveyQualityWorkflowAppendV1,
  SurveyQualityWorkflowBindingV1,
  SurveyQualityWorkflowV1,
  SurveyQualityWorkflowEntryV1,
  SurveyQualityWorkflowReadV1,
  SurveyQualityWorkflowListV1
} from '../../kun/src/contracts/survey-quality-workflow.js'

export function runtimeSurveyQualityWorkflowPath(
  projectId: string,
  workflowId?: string,
  action?: 'events'
): string {
  return `/v1/engineering/projects/${encodeURIComponent(projectId)}/quality-workflows${workflowId ? `/${encodeURIComponent(workflowId)}` : ''}${action ? `/${action}` : ''}`
}

export { parseAdvancedTrialJson as parseQualityWorkflowJson } from '../../kun/src/engineering/survey-advanced-trials-json'
