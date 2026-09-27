export {
  SURVEY_QUALITY_WORKSPACE_LIMITS, SurveyQualityPlanCreateV1, SurveyQualityArtifactMemberV1,
  SurveyQualityArtifactV1, SurveyQualityPlanV1, SurveyQualityEvidenceCreateV1, SurveyQualityEvidenceV1,
  SurveyQualityRecordCreateV1, SurveyQualityRecordV1, SurveyQualityCheckAppendV1,
  SurveyQualityWorkspaceVerificationV1, SurveyQualityWorkspaceRecordReadV1, SurveyQualityWorkspacePlanReadV1
} from '../../kun/src/contracts/survey-quality-workspace.js'

export function runtimeSurveyQualityPath(projectId: string, collection: 'plans' | 'records' | 'evidence', id?: string, action?: 'checks' | 'verify'): string {
  return `/v1/engineering/projects/${encodeURIComponent(projectId)}/quality-${collection}${id ? `/${encodeURIComponent(id)}` : ''}${action ? `/${action}` : ''}`
}
