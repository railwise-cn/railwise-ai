import type { AttentionItem, TaskRun, TaskUserPresentation } from '../contracts/tasks.js'

export function presentTaskRun(task: TaskRun): TaskRun & { presentation?: TaskUserPresentation } {
  const presentation = taskPresentation(task)
  return presentation ? { ...task, presentation } : task
}

function taskPresentation(task: TaskRun): TaskUserPresentation | undefined {
  switch (task.status) {
    case 'queued': return { reason: 'queued', actions: ['open_thread'] }
    case 'retrying': return { reason: 'retrying', actions: ['open_thread'] }
    case 'paused': return { reason: 'paused', actions: ['resume', 'supplement', 'open_thread'] }
    case 'waiting_approval': return { reason: 'approval_required', actions: ['open_thread'] }
    case 'waiting_user':
      if (task.blockCode === 'approval_expired') return { reason: 'approval_expired', actions: ['resume', 'supplement', 'open_thread'] }
      if (task.blockCode === 'execution_failed') return { reason: 'execution_failed', actions: ['supplement', 'resume', 'open_thread'] }
      return { reason: 'input_required', actions: ['supplement', 'open_thread'] }
    case 'stalled':
      if (task.blockCode === 'outcome_unknown') return { reason: 'outcome_unknown', actions: ['verify', 'open_thread'] }
      return { reason: task.blockCode ?? 'stalled', actions: ['resume', 'supplement', 'open_thread'] }
    case 'failed':
      if (task.nodes.some(node => node.errorCode === 'duration_budget_exhausted' || node.errorCode === 'execution_budget_exhausted')) {
        return { reason: 'execution_budget', actions: ['extend_budget', 'retry', 'open_thread'] }
      }
      return { reason: task.blockCode ?? 'execution_failed', actions: ['retry', 'open_thread'] }
  }
}

export function presentTaskAttention(item: AttentionItem): AttentionItem & { presentation: TaskUserPresentation } {
  const approval = item.payload?.approval as { toolName?: string } | undefined
  let presentation: TaskUserPresentation
  if (item.kind === 'approval') {
    const actions: TaskUserPresentation['actions'] = item.status === 'pending' ? ['approve', 'deny', 'open_thread'] : ['open_thread']
    if (item.status === 'expired') presentation = { reason: 'approval_expired', actions }
    else if (approval?.toolName === 'request_host_shell') presentation = { reason: 'approval_host_shell', scope: 'host', actions }
    else if (approval?.toolName === 'browser_authorize_action') presentation = { reason: 'approval_browser', scope: 'browser', actions }
    else presentation = { reason: 'approval_required', scope: 'unknown', actions }
  } else if (item.kind === 'question') {
    presentation = { reason: 'input_required', actions: ['answer', 'open_thread'] }
  } else if (Array.isArray(item.payload?.operationIds)) {
    presentation = { reason: 'outcome_unknown', actions: ['verify', 'open_thread'] }
  } else {
    presentation = { reason: 'blocked', actions: ['open_thread'] }
  }
  return { ...item, presentation }
}

export function taskStatusSummary(task: TaskRun): string {
  const reason = taskPresentation(task)?.reason
  if (reason === 'response_interrupted') return '模型回复中断，可以从原任务继续。'
  if (reason === 'outcome_unknown') return '上次操作的结果仍待核验。'
  if (reason === 'approval_expired') return '本次授权已失效，请重新检查后继续。'
  if (reason === 'tool_repeated_failure') return '同一操作连续失败，已停止重复尝试。'
  if (reason === 'execution_budget') return '任务已达到执行时间上限。'
  return {
    queued: '任务已排队。', running: '任务正在执行。', retrying: '任务正在恢复。', paused: '任务已暂停。',
    waiting_user: '任务需要你补充信息或处理卡点。', waiting_approval: '任务正在等待你确认操作。',
    completed: '任务已完成。', stalled: '任务遇到阻塞，请打开任务查看可用操作。',
    failed: '任务未完成，请打开任务查看可用操作。', cancelled: '任务已取消。'
  }[task.status]
}
