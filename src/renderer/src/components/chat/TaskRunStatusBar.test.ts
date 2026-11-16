import { describe, expect, it } from 'vitest'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { taskNeedsAttention, taskProgress } from './TaskRunStatusBar'
import { taskProgressReason } from '@shared/task-presentation'

function task(status: TaskRunV1['status']): TaskRunV1 {
  return {
    id: 'task-1', threadId: 'thread-1', childTaskIds: [], workspaceRoot: '/workspace', goal: 'deliver', status,
    acceptance: { kind: 'files', requiredNodeKinds: ['execute', 'verify', 'deliver'], requireFinalResponse: true, requireActionableArtifactCard: true },
    agentId: 'general', budget: { maxAttempts: 8, maxDurationMs: 1000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [
      { id: 'n1', taskId: 'task-1', kind: 'execute', title: 'Create', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 2, idempotencyKey: 'n1', evidence: [], revision: 1 },
      { id: 'n2', taskId: 'task-1', kind: 'verify', title: 'Verify', status: 'pending', dependsOn: ['n1'], attempt: 0, maxAttempts: 2, idempotencyKey: 'n2', evidence: [], revision: 1 }
    ], artifacts: [], createdAt: '2026-07-18T00:00:00Z', updatedAt: '2026-07-18T00:00:00Z', revision: 1
  }
}

describe('task run presentation', () => {
  it('keeps raw approval commands and hashes out of compact progress while preserving actionable non-approval reasons', () => {
    const packet = `确认浏览器操作\n输入摘要 "${'a'.repeat(64)}"\nrequest_host_shell {"command":"private command"}`
    expect(taskProgressReason({ ...task('waiting_approval'), waitingReason: packet, stalledReason: packet }, 'Review the pending operation')).toBe('Review the pending operation')
    expect(taskProgressReason({ ...task('stalled'), stalledReason: 'Check the original page' }, 'Review')).toBe('Check the original page')
  })
  it.each(['queued', 'running', 'retrying'] as const)('does not project internal retry instructions as user actions while %s', status => {
    const repair = '请用 schedule_task 建立本任务的每日计划，再用 list_schedules 读回并核对执行时刻、时区和下一次执行时间。'
    const previousFailure = '请调用 ego_browser_finish 结束原空间后继续交付。'
    for (const diagnostic of [{ waitingReason: repair }, { stalledReason: previousFailure }, { waitingReason: repair, stalledReason: previousFailure }]) {
      const current = { ...task(status), ...diagnostic }
      const original = structuredClone(current)
      expect(taskProgressReason(current, 'Review the pending operation')).toBeUndefined()
      expect(current).toEqual(original)
    }
  })
  it.each(['waiting_user', 'stalled', 'failed', 'paused'] as const)('preserves actionable reasons verbatim while %s', status => {
    const waitingReason = '请授权读取原始资料后继续；资料中的 schedule_task 字段仍需核对。'
    const stalledReason = '原始页面无法访问，请恢复登录后继续。'
    expect(taskProgressReason({ ...task(status), waitingReason }, 'Review')).toBe(waitingReason)
    expect(taskProgressReason({ ...task(status), stalledReason }, 'Review')).toBe(stalledReason)
    expect(taskProgressReason({ ...task(status), waitingReason, stalledReason }, 'Review')).toBe(stalledReason)
  })
  it('reports deterministic node progress', () => expect(taskProgress(task('running'))).toEqual({ completed: 1, total: 2 }))
  it('draws attention to stalled and failed tasks', () => {
    expect(taskNeedsAttention(task('stalled'))).toBe(true)
    expect(taskNeedsAttention(task('failed'))).toBe(true)
    expect(taskNeedsAttention(task('running'))).toBe(false)
  })
})
