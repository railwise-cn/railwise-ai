import { surveyLegacyDiagnosticText } from './survey-diagnostic-text'
import { engineeringProfessionalStepText, engineeringProfessionalText } from './engineering-professional-text'

const PLAN_SCAN_LIMIT = 65_536
const DISPLAY_STEP_LIMIT = 32

function scanText(text: string): string {
  if (text.length <= PLAN_SCAN_LIMIT) return text
  const half = PLAN_SCAN_LIMIT / 2
  return `${text.slice(0, half)}\n${text.slice(-half)}`
}

function isPlanTranscript(text: string): boolean {
  return /工程测量\s+Typed Plan|Typed Plan|计划编号\s*[:：]|上下文哈希\s*[:：]|\beplan_[a-z0-9_-]+\b|\bTaskRun\b|审批并明确启动前|Survey execution plan|Survey Typed Plan/i.test(text)
}

function planSteps(text: string, language: string): string[] {
  const isEnglish = language.toLowerCase().startsWith('en')
  const steps: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\d{1,3}[.)、]\s*(.{1,2048}?)\s*[（(]([^，,()（）]{1,128})[，,]\s*(.{1,64}?)\s*[）)]\s*$/.exec(line)
    if (!match) continue

    const toolLabel = engineeringProfessionalStepText(match[2]!, language)
    const genericLabel = isEnglish ? 'Complete survey processing' : '完成测量处理'
    const title = engineeringProfessionalText(surveyLegacyDiagnosticText(match[1]!, language), language).slice(0, 160)
    const label = toolLabel === genericLabel ? title || genericLabel : toolLabel
    const isReadOnly = /只读|read[\s-]*only|automatic check/i.test(match[3]!)
    const risk = isEnglish
      ? isReadOnly ? 'automatic check' : 'needs confirmation'
      : isReadOnly ? '自动检查' : '需要确认'

    steps.push(`${steps.length + 1}. ${label}${isEnglish ? ` (${risk})` : `（${risk}）`}`)
    if (steps.length >= DISPLAY_STEP_LIMIT) break
  }
  return steps
}

/** Hide plan protocol details while preserving the actions and confirmation state. */
export function engineeringPlanTranscriptText(text: string, language: string): string {
  const scanned = scanText(text)
  if (!isPlanTranscript(scanned)) return text

  const isEnglish = language.toLowerCase().startsWith('en')
  const notStarted = /尚未执行|审批并明确启动前|不会创建 TaskRun|Nothing has been (?:run|executed)|before (?:approval|confirmation)|awaiting approval|awaiting confirmation/i.test(scanned)
  const steps = planSteps(scanned, language)
  const plannedSteps = steps.length
    ? `${isEnglish ? 'Planned actions:' : '待执行步骤：'}\n${steps.join('\n')}`
    : isEnglish ? 'The plan steps need review.' : '计划步骤需要复核。'

  if (notStarted) {
    return isEnglish
      ? ['Survey execution plan is ready for review. Nothing has been run.', plannedSteps, 'Processing starts after your confirmation.'].join('\n\n')
      : ['测量执行方案已生成，等待确认。尚未执行。', plannedSteps, '确认后将开始处理。'].join('\n\n')
  }

  return isEnglish
    ? ['Survey plan details need review. Execution status is not confirmed.', plannedSteps, 'Confirm the plan before continuing.'].join('\n\n')
    : ['测量计划需要复核，执行状态待确认。', plannedSteps, '确认计划后再继续处理。'].join('\n\n')
}
