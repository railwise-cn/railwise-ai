import { describe, expect, it } from 'vitest'
import type { TaskProgressV1, TaskRunV1 } from '@shared/agent-workbench'
import { createThreadRunActivity, projectTaskRunActivity } from './ag-ui-activity'
import type { CoreRuntimeEventJson } from './runtime-contract'

function event(seq: number, kind: string, data: Partial<CoreRuntimeEventJson> = {}): CoreRuntimeEventJson {
  return { seq, kind, threadId: 'thread', turnId: 'turn', ...data }
}

describe('AG-UI activity projection', () => {
  it('keeps all outstanding approvals on the same run and deduplicates replay', () => {
    const activity = createThreadRunActivity('thread', 0)
    expect(activity.apply([event(1, 'turn_started')])).toMatchObject({ runId: 'turn', status: 'running' })
    const request = event(2, 'approval_requested', { approvalId: 'first', summary: 'cookie=private' })
    expect(activity.apply([request, event(3, 'approval_requested', { approvalId: 'second' })])).toEqual({
      threadId: 'thread', runId: 'turn', status: 'waiting_approval', phase: 'working'
    })
    expect(activity.apply([event(4, 'approval_resolved', { approvalId: 'first' }), request])).toBeUndefined()
    expect(activity.apply([event(5, 'approval_resolved', { approvalId: 'second' })])).toMatchObject({ runId: 'turn', status: 'running' })
    expect(activity.apply([event(6, 'turn_aborted')])).toMatchObject({ runId: 'turn', status: 'cancelled' })
    expect(activity.apply([event(7, 'tool_call_started')])).toBeUndefined()
  })

  it('reconstructs on reconnect and ignores superseded turns and other threads', () => {
    const activity = createThreadRunActivity('thread', 10)
    expect(activity.apply([event(11, 'tool_call_ready', { toolName: 'browser_search', message: 'private' })])).toEqual({
      threadId: 'thread', runId: 'turn', status: 'running', phase: 'researching'
    })
    expect(activity.apply([event(12, 'turn_failed', { threadId: 'other' })])).toBeUndefined()
    expect(activity.apply([event(13, 'turn_failed', { details: { token: 'private' } })])).toMatchObject({ status: 'failed' })
    expect(activity.apply([event(14, 'turn_started', { turnId: 'new-turn' })])).toMatchObject({ runId: 'new-turn', status: 'running' })
    expect(activity.apply([event(15, 'turn_completed')])).toBeUndefined()
    activity.reset(22)
    expect(activity.apply([event(22, 'turn_started')])).toBeUndefined()
    expect(activity.apply([event(23, 'user_input_requested', { inputId: 'input' })])).toMatchObject({ status: 'waiting_user' })
  })

  it('uses only the current leased task phase, task status and registered artifact count', () => {
    const task = { id: 'task', status: 'running' } as TaskRunV1
    const sample: TaskProgressV1 = {
      taskId: 'task', taskRevision: 1, turnId: 'turn', sampledAt: '2026-11-18T00:00:00Z',
      executionId: 'execution', leaseRevision: 1, active: true, leaseExpiresAt: '2999-01-01', activity: { phase: 'verifying' }
    }
    expect(projectTaskRunActivity(task, sample, 2)).toEqual({ status: 'running', phase: 'verifying', artifactCount: 2 })
    expect(projectTaskRunActivity(task, { ...sample, leaseExpiresAt: '2001-01-01' }, 2)?.phase).toBeUndefined()
    expect(projectTaskRunActivity({ ...task, status: 'waiting_approval' }, undefined, 2)).toMatchObject({ status: 'waiting_approval', artifactCount: 2 })
  })
})
