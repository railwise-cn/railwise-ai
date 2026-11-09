import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskRun } from '../contracts/tasks.js'
import { TaskRunRepository } from './task-run-repository.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function makeTask(): TaskRun {
  return {
    id: 'task-durable', threadId: 'thread-durable', childTaskIds: [],
    workspaceRoot: '/tmp/workspace', goal: '写一份报告', status: 'running', agentId: 'general',
    acceptance: { kind: 'answer', requiredNodeKinds: ['deliver'], requireFinalResponse: true, requireActionableArtifactCard: false },
    budget: { maxAttempts: 3, maxDurationMs: 60_000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [{ id: 'node', taskId: 'task-durable', kind: 'deliver', title: '交付', status: 'running', dependsOn: [], attempt: 1, maxAttempts: 3, idempotencyKey: 'deliver', evidence: [], revision: 1 }],
    artifacts: [], createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z', revision: 0
  }
}

describe('durable task inputs and operation receipts', () => {
  it('deduplicates the same input and rejects a reused key with different content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-durable-'))
    roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    repository.create(makeTask())
    const first = repository.appendInput({ taskId: 'task-durable', expectedRevision: 0, idempotencyKey: 'input-1', text: '补充风险章节', nowIso: '2026-11-09T00:00:01.000Z' })
    const replay = repository.appendInput({ taskId: 'task-durable', expectedRevision: first.task.revision, idempotencyKey: 'input-1', text: '补充风险章节', nowIso: '2026-11-09T00:00:02.000Z' })
    expect(replay.input.id).toBe(first.input.id)
    expect(repository.inputs('task-durable')).toHaveLength(1)
    expect(() => repository.appendInput({ taskId: 'task-durable', expectedRevision: first.task.revision, idempotencyKey: 'input-1', text: '覆盖原文', nowIso: '2026-11-09T00:00:03.000Z' })).toThrow(/different request/)
    repository.close()
  })

  it('returns the original receipt on replay and persists outbox delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-receipt-'))
    roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    const first = repository.beginOperation({ ownerId: 'task-durable', idempotencyKey: 'pause-1', kind: 'pause', request: { reason: '稍后继续' }, nowIso: '2026-11-09T00:00:01.000Z' })
    const replay = repository.beginOperation({ ownerId: 'task-durable', idempotencyKey: 'pause-1', kind: 'pause', request: { reason: '稍后继续' }, nowIso: '2026-11-09T00:00:02.000Z' })
    expect(replay.created).toBe(false)
    expect(replay.receipt.id).toBe(first.receipt.id)
    repository.enqueueOutbox({ id: 'outbox-1', ownerId: 'task-durable', kind: 'input', payload: { ok: true }, createdAt: '2026-11-09T00:00:01.000Z' })
    expect(repository.pendingOutbox()).toHaveLength(1)
    repository.acknowledgeOutbox('outbox-1', '2026-11-09T00:00:02.000Z')
    expect(repository.pendingOutbox()).toHaveLength(0)
    repository.close()
  })
})
