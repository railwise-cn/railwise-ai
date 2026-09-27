import { surveyLegacyDiagnosticText } from './survey-diagnostic-text'

/** Display adapter for the exact legacy Runtime receipt; stored messages stay unchanged. */
export function engineeringPlanTranscriptText(text: string, language: string): string {
  if (!language.startsWith('en') || text.length > 32_768) return text
  const parts = text.split('\n\n')
  if (parts.length !== 5
    || parts[0] !== '已生成工程测量 Typed Plan，当前仅供审查，尚未执行。'
    || !/^计划编号：eplan_[a-zA-Z0-9-]+$/.test(parts[1]!)
    || !/^上下文哈希：sha256-[a-f0-9]{64}$/.test(parts[2]!)
    || parts[4] !== '审批并明确启动前，不会创建 TaskRun、调用模型或执行任何工具。') return text
  const lines = parts[3]!.split('\n')
  if (!lines.length || lines.length > 32) return text
  const steps: string[] = []
  for (const [index, line] of lines.entries()) {
    const match = /^(\d+)\. (.+)（([a-zA-Z0-9_.]+)，(只读|需单独审批)）$/.exec(line)
    if (!match || Number(match[1]) !== index + 1) return text
    steps.push(`${index + 1}. ${surveyLegacyDiagnosticText(match[2]!, language)} (${match[3]}, ${match[4] === '只读' ? 'read-only' : 'individual approval required'})`)
  }
  return [
    'Survey Typed Plan created for review. Nothing has been executed.',
    `Plan ID: ${parts[1]!.slice('计划编号：'.length)}`,
    `Context hash: ${parts[2]!.slice('上下文哈希：'.length)}`,
    steps.join('\n'),
    'No TaskRun, model call or tool execution occurs until approval and explicit start.'
  ].join('\n\n')
}
