import { expect, it } from 'vitest'
import { createEgoBrowserFixture } from '../../tests/ego-browser-test-fixture.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { TaskController } from './task-controller.js'
import { operationFingerprint } from './task-run-repository.js'

async function fixture(controlOwnerId?: string) {
  const f = await createEgoBrowserFixture()
  await f.execute('ego_browser_open', { url: 'https://feed.test/list' })
  const binding = f.repo.operation(f.task.id, 'ego-task-space')!, previous = f.repo.get(f.task.id)!
  const oldGrant = f.grant(), turnId = 'explicit-resume-turn', key = 'explicit-user-continue'
  const now = '2026-11-16T00:00:02.000Z'
  if (controlOwnerId) {
    f.repo.create({ ...previous, id: controlOwnerId, threadId: 'root-thread', status: 'failed', activeTurnId: undefined })
    f.repo.update(previous.id, previous.revision, task => ({ ...task, retryOfTaskId: controlOwnerId }))
  }
  const current = f.repo.get(f.task.id)!
  f.repo.update(current.id, current.revision, task => ({ ...task, activeTurnId: turnId, status: 'running' }))
  const grant = { ...oldGrant, id: 'new-resume-grant', turnId, issuedAt: '2026-11-16T00:00:01.000Z' }
  const ownerId = controlOwnerId ?? current.id
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: current.threadId, workspace: current.workspaceRoot, title: 'Controlled closed Ego space', model: 'no-model' })
  const turn = { ...createTurnRecord({ id: turnId, threadId: thread.id, prompt: 'Continue persisted Task', status: 'running', createdAt: now,
    idempotencyKey: `task:${ownerId}:resume:${key}` }), executionGrant: grant }
  await threadStore.upsert({ ...thread, turns: [{ ...createTurnRecord({ id: oldGrant.turnId, threadId: thread.id, prompt: current.goal }), executionGrant: oldGrant }, turn] })
  const controller = new TaskController({ repository: f.repo, threadStore, sessionStore, nowIso: () => now })
  controller.beginAttempt(thread.id, turnId)
  const call = { callId: 'new-open', toolName: 'ego_browser_open', providerId: 'ego-browser', arguments: { url: 'https://feed.test/list' } }
  const host = controller.beginToolOperation(turnId, call, grant)!
  const hostId = f.repo.operation(current.id, host.key)!.id
  const request = { expectedRevision: previous.revision, idempotencyKey: key }
  const resume = f.repo.beginOperation({ ownerId, idempotencyKey: key, kind: 'resume', request, nowIso: now }).receipt
  const result = { task: f.repo.get(current.id)!, turn: { threadId: thread.id, turnId, userMessageItemId: 'resume-user-message' } }
  f.repo.finishOperation(ownerId, key, { status: 'succeeded', result }, now)
  const query = () => controller.egoTaskSpaceReopenAuthorization(current.id, turnId, hostId, binding.id)
  const snapshot = () => JSON.stringify({ task: f.repo.get(current.id), operations: f.repo.operations(current.id), attempts: f.repo.execution.attempts(current.id) })
  return { ...f, controller, threadStore, thread, turn, grant, ownerId, key, resume, binding, hostId, query, result, now, snapshot }
}

it.each([undefined, 'visible-root'])('authorizes only the matching explicit resume and stays read-only (control owner %s)', async owner => {
  const f = await fixture(owner)
  try {
    const before = f.snapshot()
    expect(await f.query()).toEqual({ controlOwnerId: f.ownerId, resumeReceiptId: f.resume.id, turnId: f.turn.id, priorBindingReceiptId: f.binding.id })
    expect(f.snapshot()).toBe(before)
  } finally { await f.dispose() }
})

it.each(['automatic-turn', 'capability-only', 'old-turn', 'wrong-result-task', 'wrong-turn-key', 'tampered-control', 'same-turn-binding', 'consumed', 'expired-grant', 'wrong-host', 'lost-lease'] as const)(
  'refuses %s without changing task, grants, old binding or operation outcomes', async boundary => {
    const f = await fixture()
    try {
      if (boundary === 'automatic-turn') f.repo.connection().prepare('DELETE FROM operation_receipts WHERE owner_id=? AND idempotency_key=?').run(f.ownerId, f.key)
      if (boundary === 'capability-only') f.repo.finishOperation(f.ownerId, f.key, { status: 'succeeded', result: { task: f.result.task, capability: { status: 'blocked' } } }, f.now)
      if (boundary === 'old-turn') f.repo.finishOperation(f.ownerId, f.key, { status: 'succeeded', result: { ...f.result, turn: { ...f.result.turn, turnId: 'old-turn' } } }, f.now)
      if (boundary === 'wrong-result-task') f.repo.finishOperation(f.ownerId, f.key, { status: 'succeeded', result: { ...f.result, task: { ...f.result.task, id: 'another-task' } } }, f.now)
      if (boundary === 'wrong-turn-key') await f.threadStore.upsert({ ...f.thread, turns: [{ ...f.turn, idempotencyKey: 'model-supplied-resume-looking-text' }] })
      if (boundary === 'tampered-control') f.repo.connection().prepare("UPDATE operation_receipts SET data_json=json_set(data_json,'$.fingerprint','forged') WHERE owner_id=? AND idempotency_key=?").run(f.ownerId, f.key)
      if (boundary === 'same-turn-binding') {
        const request = { ...f.binding.request, createdTurnId: f.turn.id }
        f.repo.connection().prepare("UPDATE operation_receipts SET data_json=json_set(data_json,'$.request',json(?),'$.fingerprint',?) WHERE owner_id=? AND idempotency_key='ego-task-space'").run(JSON.stringify(request), operationFingerprint(request), f.task.id)
      }
      if (boundary === 'consumed') f.repo.beginOperation({ ownerId: f.task.id, idempotencyKey: `ego-reopen:${f.resume.id}`, kind: 'ego_task_space_reopen', request: {}, nowIso: f.now })
      if (boundary === 'expired-grant') await f.threadStore.upsert({ ...f.thread, turns: [{ ...f.turn, executionGrant: { ...f.grant, expiresAt: f.now } }] })
      if (boundary === 'wrong-host') f.repo.finishOperation(f.task.id, `tool:${f.turn.id}:new-open`, { status: 'failed' }, f.now)
      if (boundary === 'lost-lease') f.controller.endRun(f.turn.id)
      const before = f.snapshot()
      expect(await f.query()).toBeNull()
      expect(f.snapshot()).toBe(before)
    } finally { await f.dispose() }
  })
