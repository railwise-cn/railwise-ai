import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskRun } from '../contracts/tasks.js'
import { TaskLeaseLostError, TaskRevisionConflictError, TaskRunRepository } from './task-run-repository.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function repository(): Promise<TaskRunRepository> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-task-repository-'))
  cleanup.push(root)
  return new TaskRunRepository(join(root, 'tasks.sqlite3'))
}

function task(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'task_1',
    threadId: 'thread_1',
    activeTurnId: 'turn_1',
    childTaskIds: [],
    workspaceRoot: '/tmp/workspace',
    goal: '完成任务',
    status: 'queued',
    acceptance: {
      kind: 'answer',
      requiredNodeKinds: ['deliver'],
      requireFinalResponse: true,
      requireActionableArtifactCard: false
    },
    agentId: 'general',
    budget: { maxAttempts: 8, maxDurationMs: 60_000 },
    attempts: 0,
    replans: 0,
    noProgressCount: 0,
    nodes: [{
      id: 'node_1',
      taskId: 'task_1',
      kind: 'deliver',
      title: '交付成果',
      status: 'pending',
      dependsOn: [],
      attempt: 0,
      maxAttempts: 8,
      idempotencyKey: 'task_1:deliver',
      evidence: [],
      revision: 0
    }],
    artifacts: [],
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    revision: 0,
    ...overrides
  }
}

describe('TaskRunRepository', () => {
  it('migrates all durable task tables and serializes revision-safe transitions', async () => {
    const store = await repository()
    const created = store.create(task())
    const running = store.update(created.id, created.revision, (current) => ({
      ...current,
      status: 'running',
      updatedAt: '2026-07-18T00:00:01.000Z'
    }), { key: 'running-once', kind: 'task_running' })

    expect(running).toMatchObject({ status: 'running', revision: 1 })
    expect(store.findActiveByThread('thread_1')?.id).toBe('task_1')
    expect(store.events('task_1').map((event) => event.kind)).toEqual(['task_created', 'task_running'])
    expect(() => store.update(created.id, created.revision, (current) => current))
      .toThrow(TaskRevisionConflictError)
    store.close()
  })

  it('writes checkpoints and exactly-once terminal events', async () => {
    const store = await repository()
    const created = store.create(task())
    const completed = store.update(created.id, created.revision, (current) => ({
      ...current,
      status: 'completed',
      finalResponse: '完成',
      updatedAt: '2026-07-18T00:00:02.000Z',
      finishedAt: '2026-07-18T00:00:02.000Z'
    }), { key: 'task-terminal:completed', kind: 'task_completed' })
    store.saveCheckpoint({
      id: 'checkpoint_1',
      taskId: created.id,
      completedNodeIds: [],
      pendingNodeIds: ['node_1'],
      artifactIds: [],
      eventSequence: 2,
      resumeSummary: 'resume',
      createdAt: completed.updatedAt,
      revision: 1
    })

    expect(store.latestCheckpoint(created.id)?.resumeSummary).toBe('resume')
    expect(store.events(created.id).filter((event) => event.kind === 'task_completed')).toHaveLength(1)
    expect(() => store.update(completed.id, completed.revision, (current) => ({
      ...current,
      status: 'running',
      updatedAt: '2026-07-18T00:00:03.000Z'
    }))).toThrowError(/terminal task/)
    store.close()
  })

  it('prevents duplicate runners and exposes expired runs for safe recovery', async () => {
    const store = await repository()
    const created = store.create(task({ status: 'running' }))
    expect(store.acquireLease(created.id, 'owner-a', '2026-07-18T00:00:00.000Z', '2026-07-18T00:01:00.000Z'))
      .toMatchObject({ ownerId: 'owner-a' })
    expect(store.acquireLease(created.id, 'owner-b', '2026-07-18T00:00:30.000Z', '2026-07-18T00:01:30.000Z'))
      .toBeNull()
    expect(store.reconcileExpired('2026-07-18T00:02:00.000Z').map((run) => run.id)).toEqual([created.id])
    store.close()
  })

  it('renews a lease only for its current owner and fences stale revisions', async () => {
    const store = await repository()
    const created = store.create(task({ status: 'running' }))
    const first = store.acquireLease(created.id, 'owner-a', '2026-07-18T00:00:00.000Z', '2026-07-18T00:01:00.000Z')!

    expect(store.renewLease(
      created.id,
      first.ownerId,
      first.revision,
      '2026-07-18T00:00:30.000Z',
      '2026-07-18T00:01:30.000Z'
    )).toMatchObject({ ownerId: 'owner-a', revision: first.revision, expiresAt: '2026-07-18T00:01:30.000Z' })
    expect(store.renewLease(
      created.id,
      'owner-b',
      first.revision,
      '2026-07-18T00:00:30.000Z',
      '2026-07-18T00:01:30.000Z'
    )).toBeNull()

    const revisionBeforeTakeover = store.get(created.id)!.revision
    expect(store.acquireLease(created.id, 'owner-b', '2026-07-18T00:02:00.000Z', '2026-07-18T00:03:00.000Z'))
      .toMatchObject({ ownerId: 'owner-b', revision: first.revision + 1 })
    expect(store.releaseLease(created.id, 'owner-a', first.revision)).toBe(false)
    expect(store.getLease(created.id)?.ownerId).toBe('owner-b')
    expect(() => store.update(
      created.id,
      revisionBeforeTakeover,
      current => ({ ...current, updatedAt: '2026-07-18T00:02:01.000Z' }),
      undefined,
      { ownerId: 'owner-a', leaseRevision: first.revision, nowIso: '2026-07-18T00:02:01.000Z' }
    )).toThrow(TaskLeaseLostError)
    store.close()
  })

  it('keeps an unverified unfinished process outcome unknown on restart', async () => {
    const store = await repository()
    store.create(task({ status: 'running' }))
    const created = store.createShellSession({
      id: 'bash_1',
      taskId: 'task_1',
      nodeId: 'node_1',
      workspaceRoot: '/tmp/workspace',
      commandSummary: 'npm test',
      cwd: '/tmp/workspace',
      status: 'running',
      outputPath: '/tmp/workwise-shell/bash_1.log',
      outputBytes: 0,
      createdAt: '2026-07-18T00:00:00.000Z',
      startedAt: '2026-07-18T00:00:00.000Z',
      revision: 0
    })

    const interrupted = store.reconcileShellSessionsStartup('2026-07-18T00:01:00.000Z')
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]).toMatchObject({
      id: created.id,
      status: 'outcome_unknown',
      revision: 1,
      finishedAt: '2026-07-18T00:01:00.000Z'
    })
    expect(() => store.updateShellSession(created.id, 0, (current) => current))
      .toThrow(TaskRevisionConflictError)
    store.close()
  })
})
