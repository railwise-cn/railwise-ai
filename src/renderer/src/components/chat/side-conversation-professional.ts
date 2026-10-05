type SurveyThreadDescriptor = {
  domain?: string
  projectId?: string
  title?: string
} | null

export function isProfessionalSurveyThread(thread: SurveyThreadDescriptor): boolean {
  return Boolean(thread && (
    thread.domain === 'engineering'
    || Boolean(thread.projectId?.trim())
    || /survey|测量|内业/i.test(thread.title ?? '')
  ))
}
