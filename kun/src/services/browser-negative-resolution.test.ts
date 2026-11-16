import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import type { OperationReceipt } from '../contracts/tasks.js'
import { ResultEvidenceSchema } from '../contracts/harness.js'
import { TaskController } from './task-controller.js'
import { operationFingerprint, TaskRunRepository } from './task-run-repository.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const now = '2026-11-14T06:00:00.000Z'
const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

async function fixture(outcome: 'succeeded' | 'not_completed' = 'not_completed') {
  const root = await mkdtemp(join(tmpdir(), 'browser-negative-resolution-'))
  const path = join(root, 'tasks.sqlite')
  let repository = new TaskRunRepository(path)
  cleanup.push(async () => { repository.close(); await rm(root, { recursive: true, force: true }) })
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', title: '有限公开查询', workspace: root, model: 'controlled' })
  await threadStore.upsert(thread)
  const makeController = () => new TaskController({ repository, threadStore, sessionStore, nowIso: () => now, ownerId: 'runtime' })
  let controller = makeController()
  const task = controller.ensureTask({ thread, turnId: 'turn', request: { prompt: '读取公开公告，每天08:30查询工程监测。' } })
  const scope = { browserInstanceId: 'browser', origins: ['https://public.example'], interaction: 'interact' as const, revision: 1 }
  repository.update(task.id, task.revision, current => ({ ...current, status: 'stalled', authority: { source: 'user', workspaceRoot: root,
    externalTargets: [], grantedAt: now, browserScope: scope } }))
  const grant = ExecutionGrantSchema.parse({ id: 'grant', taskId: task.id, threadId: thread.id, turnId: 'turn', workspaceRoot: root,
    workspaceTrust: 'read-only', agentTrust: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request', networkAllowlist: scope.origins,
    browserScope: scope, workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant', issuedAt: now })
  const call = { callId: 'original', toolName: 'browser_click', arguments: { sessionId: 'session', contextId: 'old-context', target: '@e1' } }
  const begin = (ownerId: string, key: string, kind: string, request: Record<string, unknown>, status: OperationReceipt['status'] = 'succeeded', result?: unknown) => {
    repository.beginOperation({ ownerId, idempotencyKey: key, kind, request, nowIso: now })
    if (status !== 'prepared') repository.finishOperation(ownerId, key, { status, result }, now)
    return repository.operation(ownerId, key)!
  }
  const original = begin(task.id, 'original', 'tool', { toolName: call.toolName, providerId: 'browser-skill', turnId: 'turn',
    argumentsHash: operationFingerprint(call.arguments), executionGrant: grant }, 'outcome_unknown')
  const approved = { id: sha('action'), sourceTaskId: task.id, scheduleId: `schedule_${task.id}`, purposeHash: sha(task.goal),
    requirementHash: sha(task.acceptance.schedule), browserInstanceId: 'browser', browserRevision: 1, origin: scope.origins[0],
    pageUrl: 'https://public.example/query', elementHash: sha('button'), action: 'click', accountState: 'unknown', access: 'public_query',
    approvalId: 'approval', summary: '点击公开查询按钮' }
  const authorizationRequest = { action: 'click', elementHash: approved.elementHash }
  begin(task.id, 'authorization', 'browser_schedule_action_authorization', authorizationRequest, 'succeeded', approved)
  repository.saveHumanRequest({ id: 'approval', kind: 'approval', threadId: thread.id, turnId: 'turn', message: '已审阅', status: 'answered',
    resolution: { decision: 'allow' }, payload: { approval: { toolName: 'browser_authorize_action', summary: approved.summary, requestHash: sha(authorizationRequest) } }, createdAt: now, updatedAt: now })
  const dispatch = begin(task.id, 'dispatch', 'browser_action_dispatch', { turnId: 'turn', action: 'click',
    argumentsHash: original.request!.argumentsHash, pageUrl: approved.pageUrl, elementHash: approved.elementHash, scheduleActionId: approved.id }, 'outcome_unknown', { effectState: 'unknown' })
  begin(task.id, 'review', 'browser_action_review', { originalReceiptId: original.id, originalFingerprint: original.fingerprint, expectedRevision: 1 },
    'succeeded', { review: { id: 'review-id' }, dispatchId: dispatch.id })
  begin(task.id, 'confirmation', 'browser_confirmation', { originalReceiptId: original.id, expectedRevision: 1, reviewId: 'review-id', decision: 'not_completed' }, 'prepared')
  const evidence = ResultEvidenceSchema.parse({ kind: 'human_confirmation', provider: 'browser-skill', operation: 'click', target: approved.pageUrl,
    verified: true, verifiedAt: now, status: outcome === 'not_completed' ? 'public_query_reviewed_incomplete' : 'public_query_confirmed_by_user', resultHash: sha('review') })
  const proof = begin(task.id, 'proof', outcome === 'not_completed' ? 'effect_verification_incomplete' : 'effect_verification', {
    originalReceiptId: original.id, originalFingerprint: original.fingerprint, confirmationOwnerId: task.id, confirmationKey: 'confirmation' },
  'succeeded', { evidence, ...(outcome === 'not_completed' ? { outcome } : {}) })
  return { task, call, original, dispatch, evidence, proof, begin, get repository() { return repository }, get controller() { return controller },
    restart() { repository.close(); repository = new TaskRunRepository(path); controller = makeController() } }
}

it('keeps a negative human resolution durable, failed on reuse, and invisible to the legacy positive-only reader', async () => {
  const f = await fixture()
  expect(() => f.controller.prepareResume(f.task.id, 1)).toThrow(/Verify outstanding/)
  f.controller.recordOperationVerification(f.task.id, 1, f.original.id, 'proof', f.evidence, 'not_completed')
  const saved = f.repository.operation(f.task.id, 'original')!
  expect(saved.status).toBe('outcome_unknown')
  expect(f.repository.verifiedOperationResolution(saved)).toMatchObject({ outcome: 'not_completed' })
  // v0.5.6 and 3a only look in this positive proof kind. They must conservatively retain unknown.
  const legacyProof = f.repository.operations(f.task.id, 'effect_verification').find(item => item.id === saved.resolution!.receiptId)
  expect(legacyProof).toBeUndefined()
  expect(f.repository.get(f.task.id)).toMatchObject({ status: 'stalled' })
  expect(f.repository.get(f.task.id)!.resultEvidence ?? []).toHaveLength(0)
  f.restart()
  expect(f.repository.verifiedOperationResolution(f.repository.operation(f.task.id, 'original')!)).toMatchObject({ outcome: 'not_completed' })
  f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
  f.controller.beginAttempt(f.task.threadId, 'turn')
  const reuse = f.controller.beginToolOperation('turn', { ...f.call, callId: 'new-id' })
  expect(reuse?.prior).toMatchObject({ item: { isError: true, output: { ok: false, status: 'failed', code: 'browser_action_not_completed', outcome: 'not_completed' } } })
  // A fresh observation is a new operation; no old click is dispatched and no global block remains.
  expect(f.controller.beginToolOperation('turn', { callId: 'observe', toolName: 'browser_observe', arguments: { sessionId: 'session' } })?.prior).toBeUndefined()
  expect(f.repository.operation(f.task.id, 'original')!.status).toBe('outcome_unknown')
})

it('keeps missing-outcome positive proof compatible without rewriting legacy resolution JSON', async () => {
  const f = await fixture('succeeded')
  const resolution = { status: 'verified' as const, receiptId: f.proof.id, evidence: f.evidence, resolvedAt: now }
  f.repository.resolveOperation(f.task.id, 'original', resolution)
  const saved = f.repository.operation(f.task.id, 'original')!
  expect(saved.resolution).not.toHaveProperty('outcome')
  expect(f.repository.verifiedOperationResolution(saved)?.outcome).toBe('succeeded')
  f.controller.prepareResume(f.task.id, 1); f.controller.beginAttempt(f.task.threadId, 'turn')
  expect(f.controller.beginToolOperation('turn', f.call)?.prior).toMatchObject({ item: { output: { ok: true, status: 'succeeded' } } })
})

it.each(['positive-kind', 'wrong-outcome', 'wrong-nonce', 'wrong-owner', 'business-action', 'stale-revision', 'unknown-scope'] as const)(
  'fails closed and rolls back an untrusted negative proof: %s', async invalid => {
    const f = await fixture()
    if (invalid === 'positive-kind') f.begin(f.task.id, 'forged', 'effect_verification', f.proof.request!, 'succeeded', { evidence: f.evidence, outcome: 'not_completed' })
    if (invalid === 'wrong-outcome') f.repository.finishOperation(f.task.id, 'proof', { status: 'succeeded', result: { evidence: f.evidence, outcome: 'succeeded' } })
    if (['wrong-nonce', 'wrong-owner'].includes(invalid)) f.begin(f.task.id, 'forged', 'effect_verification_incomplete', { ...f.proof.request,
      ...(invalid === 'wrong-nonce' ? { confirmationKey: 'missing' } : { confirmationOwnerId: 'other-task' }) }, 'succeeded', { evidence: f.evidence, outcome: 'not_completed' })
    if (invalid === 'business-action') {
      const authority = f.repository.operation(f.task.id, 'authorization')!
      f.repository.finishOperation(f.task.id, 'authorization', { status: 'succeeded', result: { ...authority.result as object, access: 'business_write' } })
    }
    if (invalid === 'unknown-scope') f.repository.update(f.task.id, 1, task => ({ ...task, authority: { ...task.authority!, browserScope: undefined } }))
    expect(() => f.controller.recordOperationVerification(f.task.id, invalid === 'stale-revision' ? 0 : f.repository.get(f.task.id)!.revision,
      f.original.id, ['positive-kind', 'wrong-nonce', 'wrong-owner'].includes(invalid) ? 'forged' : 'proof', f.evidence, 'not_completed')).toThrow()
    expect(f.repository.operation(f.task.id, 'original')!.resolution).toBeUndefined()
    expect(f.repository.get(f.task.id)!.resultEvidence ?? []).toHaveLength(0)
    expect(() => f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)).toThrow(/Verify outstanding/)
  })

it('does not replace a verified resolution or clear another unknown receipt', async () => {
  const f = await fixture()
  f.controller.recordOperationVerification(f.task.id, 1, f.original.id, 'proof', f.evidence, 'not_completed')
  const saved = f.repository.operation(f.task.id, 'original')!
  expect(() => f.repository.resolveOperation(f.task.id, 'original', saved.resolution!)).not.toThrow()
  expect(() => f.repository.resolveOperation(f.task.id, 'original', { ...saved.resolution!, outcome: 'succeeded' })).toThrow(/immutable/)
  const other = f.begin(f.task.id, 'other', 'tool', { toolName: 'other_write' }, 'outcome_unknown')
  expect(f.repository.verifiedOperationResolution(other)).toBeUndefined()
  expect(() => f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)).toThrow(/Verify outstanding/)
})

it('preserves the historical negative proof when a new browser scope replaces the old authority', async () => {
  const f = await fixture()
  f.controller.recordOperationVerification(f.task.id, 1, f.original.id, 'proof', f.evidence, 'not_completed')
  const current = f.repository.get(f.task.id)!
  f.repository.update(f.task.id, current.revision, task => ({ ...task, authority: { ...task.authority!, browserScope: {
    ...task.authority!.browserScope!, browserInstanceId: 'visible-personal-browser', revision: 2
  } } }))
  f.restart()
  const original = f.repository.operation(f.task.id, 'original')!
  expect(f.repository.verifiedOperationResolution(original)).toMatchObject({ outcome: 'not_completed' })
  expect(original.request!.executionGrant).toMatchObject({ browserScope: { browserInstanceId: 'browser', revision: 1 } })
  expect(f.repository.get(f.task.id)!.authority!.browserScope).toMatchObject({ browserInstanceId: 'visible-personal-browser', revision: 2 })
  f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
  f.controller.beginAttempt(f.task.threadId, 'turn')
  expect(f.controller.beginToolOperation('turn', f.call)?.prior).toMatchObject({ item: { isError: true, output: { status: 'failed', outcome: 'not_completed' } } })
  expect(f.repository.get(f.task.id)!.resultEvidence ?? []).toHaveLength(0)
})

it('does not revoke a historical finding when the original authority is later revoked', async () => {
  const f = await fixture()
  f.controller.recordOperationVerification(f.task.id, 1, f.original.id, 'proof', f.evidence, 'not_completed')
  const current = f.repository.get(f.task.id)!
  f.repository.update(f.task.id, current.revision, task => ({ ...task, authority: { ...task.authority!, revokedAt: now } }))
  f.restart()
  expect(f.repository.verifiedOperationResolution(f.repository.operation(f.task.id, 'original')!)).toMatchObject({ outcome: 'not_completed' })
  expect(f.repository.get(f.task.id)!.resultEvidence ?? []).toHaveLength(0)
})
