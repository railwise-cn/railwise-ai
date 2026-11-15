import type { TaskRunV1 } from './agent-workbench'

/** Approval packets belong to the review card, never to compact progress surfaces. */
export function taskProgressReason(task: Pick<TaskRunV1, 'status' | 'waitingReason' | 'stalledReason'>, approvalHint: string): string | undefined {
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
  const goal = taskDisplayGoal(task).replace(/\s+/g, ' ').trim()
  const action = /(?:绘制|制作|设计|编写|生成|整理|分析|获取|收集|采集)([^，。；;！!\n]{2,64})/.exec(goal)
  const title = action ? action[0].replace(/(绘制|制作|设计|编写|生成|整理|分析|获取|收集|采集)(?:一只|一个|一份|一张|一段|一些)/, '$1').replace('正在', '') : goal.split(/[。\n]/)[0]
  return title.length > 42 ? title.slice(0, 41) + '…' : title
}
