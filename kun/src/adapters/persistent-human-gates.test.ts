import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalRequest } from '../domain/approval.js'
import type { TaskRun } from '../contracts/tasks.js'
import { decideApproval } from '../server/routes/approvals.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TaskRunRepository } from '../services/task-run-repository.js'
import { InMemoryEventBus } from './in-memory-event-bus.js'
import { InMemorySessionStore } from './in-memory-session-store.js'
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

  it('rejects approval ID reuse across operations and shares an identical live decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-gate-conflict-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task())
    const gate = new PersistentApprovalGate(repository, () => '2026-11-09T00:00:01Z')
    const approval = createApprovalRequest({ id: 'approval-conflict', threadId: 'thread-gate', turnId: 'turn-1', toolName: 'write', summary: '写入文档', requestHash: 'a'.repeat(64), callId: 'same-call' })
    const waiting = gate.request(approval)
    const duplicate = gate.request(approval)
    expect(duplicate).toBe(waiting)
    for (const changed of [{ turnId: 'turn-2' }, { threadId: 'other-thread' }, { toolName: 'send' }, { requestHash: 'b'.repeat(64) }, { summary: 'different content' }]) {
      await expect(gate.request({ ...approval, ...changed })).rejects.toMatchObject({ code: 'approval_request_conflict' })
    }
    gate.decide(approval.id, 'allow')
    await expect(waiting).resolves.toBe('allow')
    await expect(duplicate).resolves.toBe('allow')
    await expect(gate.request({ ...approval, turnId: 'turn-2' })).rejects.toMatchObject({ code: 'approval_request_conflict' })
    repository.close()
  })

  it('rejects an old decision after pause or cancellation and accepts duplicates only for the same decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-gate-stale-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    repository.create({ ...task(), activeTurnId: 'turn-1' })
    const date = '2026-11-09T00:00:01Z'
    const gate = new PersistentApprovalGate(repository, () => date)
    const approval = createApprovalRequest({ id: 'approval-paused', threadId: 'thread-gate', turnId: 'turn-1',
      toolName: 'request_host_shell', summary: 'exact reviewed operation', createdAt: date })
    void gate.request(approval)
    const updateStatus = (status: TaskRun['status']) => {
      const current = repository.get('task-gate')!
      repository.update(current.id, current.revision, row => ({ ...row, status, updatedAt: date }))
    }
    updateStatus('paused')
    expect(gate.decide(approval.id, 'allow')).toBe(false)
    updateStatus('cancelled')
    expect(gate.decide(approval.id, 'allow')).toBe(false)
    expect(repository.pendingOutbox('human_answer')).toHaveLength(0)

    const independent = { ...approval, id: 'approval-independent', threadId: 'chat-without-task' }
    const waiting = gate.request(independent)
    expect(gate.decide(independent.id, 'deny')).toBe(true)
    expect(gate.decide(independent.id, 'deny')).toBe(true)
    expect(gate.decide(independent.id, 'allow')).toBe(false)
    await expect(waiting).resolves.toBe('deny')
    repository.close()
  })

  it('persists an exact-origin read grant only after a web_fetch approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-web-read-grant-')); roots.push(root)
    const path = join(root, 'tasks.sqlite3')
    const before = '2026-11-09T00:00:01Z'
    const repository = new TaskRunRepository(path)
    repository.create({ ...task(), activeTurnId: 'turn-1', authority: {
      source: 'user', workspaceRoot: '/tmp/ws', externalTargets: [], grantedAt: before
    } })
    const gate = new PersistentApprovalGate(repository, () => before)
    const allowed = createApprovalRequest({ id: 'approval-web-read', threadId: 'thread-gate', turnId: 'turn-1',
      toolName: 'web_fetch', summary: '读取网站内容', networkReadOrigin: 'https://www.railwise.cn', createdAt: before })
    const allowedResult = gate.request(allowed)
    expect(gate.decide(allowed.id, 'allow')).toBe(true)
    await expect(allowedResult).resolves.toBe('allow')

    const denied = createApprovalRequest({ id: 'approval-web-denied', threadId: 'thread-gate', turnId: 'turn-1',
      toolName: 'web_fetch', summary: '读取另一个网站', networkReadOrigin: 'https://private.example', createdAt: before })
    const deniedResult = gate.request(denied)
    expect(gate.decide(denied.id, 'deny')).toBe(true)
    await expect(deniedResult).resolves.toBe('deny')
    expect(repository.get('task-gate')?.authority?.approvedWebReadOrigins).toEqual([{
      origin: 'https://www.railwise.cn', approvalId: allowed.id, turnId: 'turn-1', approvedAt: before
    }])
    repository.close()

    const reopened = new TaskRunRepository(path)
    expect(reopened.get('task-gate')?.authority?.approvedWebReadOrigins?.map(item => item.origin)).toEqual(['https://www.railwise.cn'])
    reopened.close()
  })

  it.each(['expired', 'revoked', 'prepared'] as const)('settles a %s task approval once after restart without granting it', async reason => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-gate-invalid-')); roots.push(root)
    const path = join(root, 'tasks.sqlite3')
    const before = '2026-11-09T00:00:01Z'
    const after = '2026-11-09T00:02:00Z'
    const first = new TaskRunRepository(path)
    first.create({ ...task(), activeTurnId: 'turn-1', authority: {
      source: 'user', workspaceRoot: '/tmp/ws', externalTargets: [], grantedAt: before,
      taskApprovalGrant: {
        id: 'temporary-permission', taskId: 'task-gate', threadId: 'thread-gate', previousPolicy: 'never',
        approvalPolicy: 'on-request', workspaceRoot: '/tmp/ws', workspaceTrust: 'workspace-write',
        workspaceRevision: 0, agentRevision: 0, scopeFingerprint: 'a'.repeat(64),
        status: reason === 'prepared' ? 'prepared' : 'active', confirmed: true, confirmedAt: before,
        expiresAt: reason === 'expired' ? '2026-11-09T00:01:00Z' : '2026-11-09T00:03:00Z',
        idempotencyKey: 'permission', ...(reason === 'revoked' ? { revokedAt: before } : {})
      }
    } })
    const approval = createApprovalRequest({ id: 'approval-reopen', threadId: 'thread-gate', turnId: 'turn-1',
      toolName: 'write', summary: '写入验收文件', createdAt: before })
    void new PersistentApprovalGate(first, () => before).request(approval)
    expect(first.get('task-gate')?.status).toBe('waiting_approval')
    first.close()

    const reopened = new TaskRunRepository(path)
    try {
      const gate = new PersistentApprovalGate(reopened, () => after)
      const eventBus = new InMemoryEventBus()
      const sessionStore = new InMemorySessionStore()
      const events = new RuntimeEventRecorder({ eventBus, sessionStore, allocateSeq: id => eventBus.allocateSeq(id), nowIso: () => after })
      const submit = () => decideApproval({ approvalId: approval.id, gate, events,
        request: new Request('http://127.0.0.1/v1/approvals/approval-reopen', { method: 'POST', body: '{"decision":"allow"}' }) })
      expect((await submit()).status).toBe(409)
      expect((await submit()).status).toBe(409)
      expect(gate.get(approval.id)).toMatchObject({ status: 'expired', reason: 'task_approval_expired' })
      expect(reopened.attention(approval.id)?.status).toBe('expired')
      expect(reopened.get('task-gate')).toMatchObject({ status: 'waiting_user', blockCode: 'approval_expired' })
      expect(reopened.inputs('task-gate')).toHaveLength(1)
      expect(reopened.inputs('task-gate')[0]).toMatchObject({ kind: 'approval_resolution', sourceId: approval.id })
      expect(await sessionStore.highestSeq('thread-gate')).toBe(1)
    } finally { reopened.close() }
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

  it('settles the exact pending tool question when a turn restart finds a stale task owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-question-restart-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    repository.create({ ...task(), activeTurnId: 'turn-1' })
    const gate = new PersistentUserInputGate(repository, () => '2026-11-09T00:00:01Z')
    const pending = gate.request({ id: 'question-restart', threadId: 'thread-gate', turnId: 'turn-1', itemId: 'item-question',
      prompt: '请提供网址', questions: [{ id: 'url', header: '网址', question: '请提供网址', options: [] }] })
    const retry = task()
    repository.create({ ...retry, id: 'task-retry', activeTurnId: 'turn-2', retryOfTaskId: 'task-gate',
      nodes: retry.nodes.map(node => ({ ...node, id: 'node-retry', taskId: 'task-retry' })),
      createdAt: '2026-11-09T00:00:02Z', updatedAt: '2026-11-09T00:00:02Z' })
    expect(repository.currentExecution('task-gate')?.id).toBe('task-retry')

    expect(gate.resolveForTurnRestart('question-restart')).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(repository.humanRequest('question-restart')).toMatchObject({ status: 'cancelled' })
    expect(repository.attention('question-restart')?.status).toBe('cancelled')
    repository.close()
  })
})
