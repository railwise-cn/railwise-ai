import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskRun } from '../contracts/tasks.js'
import { TaskRunRepository } from '../services/task-run-repository.js'
import { TaskDeliveryCoordinator } from './runtime.js'
import type { ServerRuntime } from '../server/routes/server-runtime.js'
import { createApprovalRequest } from '../domain/approval.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function makeTask(): TaskRun {
  return {
    id: 'task-human-recovery', threadId: 'thread-human-recovery', childTaskIds: [], workspaceRoot: '/tmp/workspace',
    goal: '完成报告', status: 'waiting_user', agentId: 'general',
    acceptance: { kind: 'answer', requiredNodeKinds: ['deliver'], requireFinalResponse: true, requireActionableArtifactCard: false },
    budget: { maxAttempts: 3, maxDurationMs: 60_000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [{ id: 'deliver', taskId: 'task-human-recovery', kind: 'deliver', title: '交付', status: 'blocked', dependsOn: [], attempt: 1, maxAttempts: 3, idempotencyKey: 'deliver', evidence: [], revision: 1 }],
    artifacts: [], createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', revision: 0
  }
}

describe('TaskDeliveryCoordinator durable recovery', () => {
  it.each(['question', 'declined-host-approval', 'allowed-other-tool'] as const)('starts a continuation turn for an answered request after restart (%s)', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-recovery-'))
    roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    repository.create(makeTask())
    const decision = kind === 'declined-host-approval' ? 'deny' : 'allow'
    const approval = createApprovalRequest({ id: 'answer-recovery', threadId: 'thread-human-recovery', turnId: 'turn-old',
      toolName: kind === 'declined-host-approval' ? 'request_host_shell' : 'write', summary: '确认操作' })
    repository.saveHumanRequest({
      id: approval.id, kind: kind === 'question' ? 'question' : 'approval', threadId: approval.threadId, turnId: approval.turnId,
      message: kind === 'question' ? '请选择格式' : approval.summary, payload: kind === 'question' ? { questions: [] } : { approval },
      status: 'pending', createdAt: '2026-11-09T00:00:01.000Z', updatedAt: '2026-11-09T00:00:01.000Z'
    })
    repository.resolveHumanRequest(approval.id, kind === 'question'
      ? { status: 'submitted', answers: [{ id: 'format', label: '格式', value: 'PDF' }] } : { decision }, 'answered', '2026-11-09T00:00:02.000Z')
    const started: Array<{ taskId: string; intent: string }> = []
    const runtime = {
      flowService: { flushSourceEvents: async () => undefined, repository: { pendingOutbox: () => [], getRun: () => null } },
      taskRepository: repository,
      approvalGate: { get: () => ({ ...approval, status: decision === 'deny' ? 'denied' as const : 'allowed' as const }) },
      threadService: { get: async () => ({ id: 'thread-human-recovery', turns: [], workspace: '/tmp/workspace' }) },
      turnService: {
        getAbortController: () => undefined,
        finishTurn: async () => undefined,
      },
      taskCoordinator: {
        command: async (input: { taskId: string; intent: string }) => {
          started.push(input)
          return { kind: 'task_started', task: repository.get(input.taskId) }
        }
      },
      runTurn: async (_threadId: string, _turnId: string) => 'completed' as const,
      nowIso: () => '2026-11-09T00:00:03.000Z'
    } as unknown as ServerRuntime
    const coordinator = new TaskDeliveryCoordinator(runtime)
    await coordinator.tick()
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ taskId: 'task-human-recovery', intent: 'resume' })
    expect(repository.pendingOutbox('human_answer')).toHaveLength(0)
    // Starting a continuation is not proof that the worker checkpoint consumed the answer.
    expect(repository.inputs('task-human-recovery', true)).toHaveLength(1)
    repository.close()
  })
})
