import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalRequest } from '../domain/approval.js'
import type { TaskRun } from '../contracts/tasks.js'
import { TaskRunRepository } from '../services/task-run-repository.js'
import { PersistentApprovalGate, PersistentUserInputGate } from './persistent-human-gates.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function task(): TaskRun {
  return {
    id: 'task-gate', threadId: 'thread-gate', childTaskIds: [], workspaceRoot: '/tmp/ws', goal: 'gate', status: 'running', agentId: 'general',
    acceptance: { kind: 'answer', requiredNodeKinds: ['deliver'], requireFinalResponse: true, requireActionableArtifactCard: false },
    budget: { maxAttempts: 1, maxDurationMs: 60_000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [{ id: 'node', taskId: 'task-gate', kind: 'deliver', title: 'deliver', status: 'running', dependsOn: [], attempt: 1, maxAttempts: 1, idempotencyKey: 'deliver', evidence: [], revision: 1 }],
    artifacts: [], createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', revision: 0
  }
}

describe('persistent human gates', () => {
  it('keeps an unanswered approval after the runtime is recreated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-gate-')); roots.push(root)
    const first = new TaskRunRepository(join(root, 'tasks.sqlite3')); first.create(task())
    const gate = new PersistentApprovalGate(first, () => '2026-11-09T00:00:01Z')
    const pending = createApprovalRequest({ id: 'approval-1', threadId: 'thread-gate', turnId: 'turn-1', toolName: 'write', summary: '写入文档', createdAt: '2026-11-09T00:00:01Z' })
    void gate.request(pending)
    expect(gate.pending('thread-gate')).toHaveLength(1)
    first.close()
    const second = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    const restored = new PersistentApprovalGate(second, () => '2026-11-09T00:00:02Z')
    expect(restored.pending('thread-gate')[0]?.id).toBe('approval-1')
    expect(restored.decide('approval-1', 'allow')).toBe(true)
    restored.flush()
    expect(restored.get('approval-1')?.status).toBe('allowed')
    second.close()
  })

  it('persists structured question payloads for reconnecting UIs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-question-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task())
    const gate = new PersistentUserInputGate(repository, () => '2026-11-09T00:00:01Z')
    void gate.request({ id: 'question-1', threadId: 'thread-gate', turnId: 'turn-1', itemId: 'item-1', prompt: '选择格式', questions: [{ id: 'format', header: '格式', question: '导出什么格式？', options: [{ label: 'PDF', description: '便于分发' }] }] })
    const restored = new PersistentUserInputGate(repository, () => '2026-11-09T00:00:02Z')
    expect(restored.get('question-1')?.questions[0]?.id).toBe('format')
    expect(restored.resolve('question-1', { status: 'submitted', answers: [{ id: 'format', label: '格式', value: 'PDF' }] })).toBe(true)
    restored.flush()
    expect(repository.humanRequest('question-1')?.status).toBe('answered')
    repository.close()
  })
})
