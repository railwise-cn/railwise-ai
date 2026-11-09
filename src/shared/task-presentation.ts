import type { TaskRunV1 } from './agent-workbench'

/** Older delivery tasks stored execution instructions as their visible goal. */
export function taskDisplayGoal(task: Pick<TaskRunV1, 'goal' | 'templateId'>): string {
  if (task.templateId && /^完成(?:监测报告|招投标技术文件|研究与文档)任务，持续推进到可审阅成果。\r?\n\r?\n用户目标：/.test(task.goal)) {
    const match = /^完成[^\r\n]+\r?\n\r?\n用户目标：([\s\S]*?)\r?\n\r?\n工作区：/.exec(task.goal)
    if (match?.[1].trim()) return match[1].trim()
  }
  return task.goal
}
