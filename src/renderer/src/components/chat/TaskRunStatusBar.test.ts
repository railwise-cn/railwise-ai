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
    expect(taskProgressReason({ ...task('waiting_approval'), waitingReason: packet }, 'Review the pending operation')).toBe('Review the pending operation')
    expect(taskProgressReason({ ...task('stalled'), stalledReason: 'Check the original page' }, 'Review')).toBe('Check the original page')
  })
  it('reports deterministic node progress', () => expect(taskProgress(task('running'))).toEqual({ completed: 1, total: 2 }))
  it('draws attention to stalled and failed tasks', () => {
    expect(taskNeedsAttention(task('stalled'))).toBe(true)
    expect(taskNeedsAttention(task('failed'))).toBe(true)
    expect(taskNeedsAttention(task('running'))).toBe(false)
  })
})
