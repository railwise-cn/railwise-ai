// Data-only schemas and standalone JSON lexer. No Runtime scoring or Node dependency in renderer.
export * from '../../kun/src/contracts/survey-quality-scoring'
export * from '../../kun/src/contracts/survey-quality-scoring-workspace'
export { parseAdvancedTrialJson as parseQualityScoringJson } from '../../kun/src/engineering/survey-advanced-trials-json'
export function runtimeSurveyQualityScoringPath(projectId: string, recordId?: string, action?: 'reverify' | 'export'): string {
  return `/v1/engineering/projects/${encodeURIComponent(projectId)}/quality-scoring${recordId ? `/${encodeURIComponent(recordId)}` : ''}${action ? `/${action}` : ''}`
}
