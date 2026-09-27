export * from '../../kun/src/contracts/survey-quality-assessment'
export { parseAdvancedTrialJson as parseAssessmentJson } from '../../kun/src/engineering/survey-advanced-trials-json'
export function assessmentPath(pid: string, kind: 'plans' | 'assessments', id?: string, action?: 'reverify' | 'export'): string {
  return `/v1/engineering/projects/${encodeURIComponent(pid)}/${kind === 'plans' ? 'quality-assessment-plans' : 'quality-assessments'}${id ? `/${encodeURIComponent(id)}` : ''}${action ? `/${action}` : ''}`
}
