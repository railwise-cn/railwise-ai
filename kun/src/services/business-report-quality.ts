import type { StructuredWebReport } from './structured-web-report.js'

/** Presentation quality is separate from literal source verification. */
export function requestsBusinessScreening(goal: string): boolean {
  return /筛选|过滤|匹配|适合|相关|filter|screen|relevant|suitab/i.test(goal)
    && /业务|公司|服务|经营范围|能力|测绘|工程测量|监测|business|company|service|surveying|monitoring/i.test(goal)
}

type QualityIssue = {
  kind: 'concise_title_required' | 'screening_required' | 'reason_required' | 'business_type_required'
  sectionId?: string
}

export function businessReportQualityFeedback(goal: string, report: StructuredWebReport) {
  if (!requestsBusinessScreening(goal)) return undefined
  const issues: QualityIssue[] = []
  if (Array.from(report.title).length > 80 || /[\r\n]/.test(report.title)) {
    issues.push({ kind: 'concise_title_required' })
  }
  const screening = new Map((report.presentation?.screening ?? []).map(entry => [entry.sectionId, entry]))
  for (const item of report.evidence.items) {
    const assessment = screening.get(item.sectionId)
    if (!assessment) {
      issues.push({ kind: 'screening_required', sectionId: item.sectionId })
      continue
    }
    if (Array.from(assessment.reason.replace(/\s/g, '')).length < 8) {
      issues.push({ kind: 'reason_required', sectionId: item.sectionId })
    }
    if (assessment.decision === 'relevant' && !assessment.businessTypes?.length) {
      issues.push({ kind: 'business_type_required', sectionId: item.sectionId })
    }
  }
  if (!issues.length) return undefined
  return {
    ready: false as const,
    status: 'blocked' as const,
    code: 'artifact_business_presentation_required',
    issues,
    message: '业务筛选报告尚缺清晰的标题或逐条筛选说明，未写入新报告。来源核验与业务判断分别保留。',
    nextStep: '使用不超过80字的简短业务标题，把采集范围和未确认记录写入presentation.summary或coverageNote。为每个evidence.items的sectionId提供presentation.screening：decision为relevant/excluded/pending，reason用至少8字说明与用户业务条件的关系；relevant须列出businessTypes，region不确定时省略。筛选判断为AI分析，不代表资质或投标资格结论。不要改动evidence.classification=source；预算、日期、截止时间、状态和资质仍只能使用有同记录原文依据的fields，缺失时保留unverifiedFields，不得在筛选说明中猜测这些事实。'
  }
}
