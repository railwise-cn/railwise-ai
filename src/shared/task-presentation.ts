import type { TaskAttentionV1, TaskRunV1 } from './agent-workbench'
import type { ExternalTaskCapability } from './task-command'

/** Translate a structured runtime failure, never matching arbitrary message prose. */
export function isExecutionGrantExpiredCapability(value: unknown): value is ExternalTaskCapability & {
  provider: 'workspace'; status: 'blocked'; errorCode: 'execution_grant_expired'
} {
  if (!value || typeof value !== 'object') return false
  const capability = value as Partial<ExternalTaskCapability>
  return capability.provider === 'workspace' && capability.status === 'blocked' &&
    capability.errorCode === 'execution_grant_expired' && typeof capability.message === 'string'
}

/** An outer attention summary may translate only the exact current typed blocker of its real owner. */
export function isMatchingExecutionGrantExpiredAttention(item: TaskAttentionV1, owner: TaskRunV1 | undefined): boolean {
  const capability = item.payload?.kind === 'capability_required' ? item.payload.capability : undefined
  return Boolean(owner && item.status === 'pending' && item.ownerKind === 'task' && item.ownerId === owner.id && item.taskId === owner.id &&
    ['waiting_user','stalled','failed'].includes(owner.status) && isExecutionGrantExpiredCapability(capability) &&
    item.message === capability.message && [owner.waitingReason,owner.stalledReason].includes(capability.message))
}

/** Admission and attempt counters alone do not prove that any work ran. */
export function taskHasExecutionEvidence(task: TaskRunV1): boolean {
  return task.nodes.some(node => node.status === 'completed' || node.status === 'running' || Boolean(node.startedAt) || node.evidence.length > 0) ||
    task.artifacts.length > 0 || Boolean(task.resultEvidence?.length) || (task.timing?.executionMs ?? 0) > 0
}

/** Active repair diagnostics stay internal; approval packets belong to the review card. */
export function taskProgressReason(task: Pick<TaskRunV1, 'status' | 'waitingReason' | 'stalledReason'>, approvalHint: string): string | undefined {
  if (['queued', 'running', 'retrying'].includes(task.status)) return undefined
  return task.status === 'waiting_approval' ? approvalHint : task.stalledReason || task.waitingReason
}

/** Older delivery tasks stored execution instructions as their visible goal. */
export function taskDisplayGoal(task: Pick<TaskRunV1, 'goal' | 'templateId'>): string {
  if (task.templateId && /^完成(?:监测报告|招投标技术文件|研究与文档)任务，持续推进到可审阅成果。\r?\n\r?\n用户目标：/.test(task.goal)) {
    const match = /^完成[^\r\n]+\r?\n\r?\n用户目标：([\s\S]*?)\r?\n\r?\n工作区：/.exec(task.goal)
    if (match?.[1].trim()) return match[1].trim()
  }
  return task.goal
}

/** Compact business title; the full request remains available in details. */
export function taskDisplayTitle(task: Pick<TaskRunV1, 'goal' | 'templateId'>): string {
  const displayGoal = taskDisplayGoal(task)
  const goal = displayGoal.replace(/\s+/g, ' ').trim()
  const namedTitle = /^(?:新任务|任务名称|任务标题)[ \t]*[：:][ \t]*([^\r\n。；;！!？?]{1,256})/.exec(displayGoal.trim())?.[1]
    ?.replace(/\s*[（(]v?\d+\.\d+(?:\.\d+)?[^()（）]*[）)]\s*$/, '').replace(/\s+/g, ' ').trim()
  const action = /(?:绘制|制作|设计|编写|生成|整理|分析|获取|收集|采集)([^，。；;！!\n]{2,64})/.exec(goal)
  const title = namedTitle || (action ? action[0].replace(/(绘制|制作|设计|编写|生成|整理|分析|获取|收集|采集)(?:一只|一个|一份|一张|一段|一些)/, '$1').replace('正在', '') : goal.split(/[。\n]/)[0])
  return title.length > 42 ? title.slice(0, 41) + '…' : title
}
