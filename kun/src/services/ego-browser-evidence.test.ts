import { expect, it } from 'vitest'
import { createEgoBrowserFixture } from '../../tests/ego-browser-test-fixture.js'
import { currentEgoTaskSpaceBinding, validEgoDocumentEvidence } from './ego-browser-evidence.js'
import { operationFingerprint } from './task-run-repository.js'

async function fixture() {
  const f = await createEgoBrowserFixture(), output = await f.execute('ego_browser_open', { url: 'https://feed.test/list' })
  const old = f.repo.operation(f.task.id, 'ego-task-space')!, grant = { ...f.grant(), turnId: 'continued-turn' }
  const resume = f.repo.beginOperation({ ownerId: f.task.id, idempotencyKey: 'explicit-continue', kind: 'resume',
    request: { expectedRevision: 1, idempotencyKey: 'explicit-continue' }, nowIso: old.updatedAt }).receipt
  f.repo.finishOperation(f.task.id, resume.idempotencyKey, { status: 'succeeded', result: { task: f.task, turn: { threadId: f.task.threadId, turnId: grant.turnId, userMessageItemId: 'explicit-continue-user' } } })
  const host = f.repo.beginOperation({ ownerId: f.task.id, idempotencyKey: 'new-open-host', kind: 'tool',
    request: { turnId: grant.turnId, callId: 'reopen-call', providerId: 'ego-browser', toolName: 'ego_browser_open', executionGrant: grant }, nowIso: old.updatedAt }).receipt
  const key = `ego-task-space:resume:${resume.id}`, nonce = 'new-server-nonce', spaceName = `RailWise read-only ${f.task.id} ${nonce}`
  const request = { controlOwnerId: f.task.id, resumeReceiptId: resume.id, turnId: grant.turnId, priorBindingReceiptId: old.id,
    newBindingKey: key, spaceName, nonce, hostOperationId: host.id, callId: 'reopen-call', grantFingerprint: operationFingerprint(grant),
    configurationFingerprint: old.request!.configurationFingerprint, priorTaskSpaceId: 7, priorSpaceName: old.request!.spaceName }
  const consume = f.repo.beginOperation({ ownerId: f.task.id, idempotencyKey: `ego-reopen:${resume.id}`, kind: 'ego_task_space_reopen', request, nowIso: old.updatedAt }).receipt
  const binding = f.repo.beginOperation({ ownerId: f.task.id, idempotencyKey: key, kind: 'ego_task_space', request: { ...old.request,
    createdTurnId: grant.turnId, nonce, spaceName, controlOwnerId: f.task.id, resumeReceiptId: resume.id, priorBindingReceiptId: old.id, reopenReceiptId: consume.id }, nowIso: old.updatedAt }).receipt
  f.repo.finishOperation(f.task.id, consume.idempotencyKey, { status: 'succeeded', result: { closed: true, priorTaskSpaceId: 7, priorSpaceName: old.request!.spaceName, idMatch: false, nameMatches: 0 } })
  return { ...f, old, consume, binding, output }
}

it('keeps a prepared latest incarnation current and still verifies the original source by its original binding id', async () => {
  const f = await fixture()
  try {
    expect(currentEgoTaskSpaceBinding(f.repo, f.task.id)?.id).toBe(f.binding.id)
    expect(currentEgoTaskSpaceBinding(f.repo, f.task.id)?.status).toBe('prepared')
    expect(validEgoDocumentEvidence(f.repo, f.task, f.output, f.grant())).toBe(true)
    expect(f.repo.operationById(f.task.id, f.old.id)).toEqual(f.old)
  } finally { await f.dispose() }
})

it.each(['fork', 'unconfirmed-close', 'unknown-consumption', 'wrong-host', 'wrong-resume-task'] as const)('rejects %s rather than falling back to the old space', async boundary => {
  const f = await fixture()
  try {
    if (boundary === 'fork') f.repo.beginOperation({ ownerId: f.task.id, idempotencyKey: 'forged-third-generation', kind: 'ego_task_space', request: { ...f.binding.request }, nowIso: f.binding.updatedAt })
    if (boundary === 'unconfirmed-close') f.repo.finishOperation(f.task.id, f.consume.idempotencyKey, { status: 'succeeded', result: { ...(f.consume.result as object), closed: false } })
    if (boundary === 'unknown-consumption') f.repo.finishOperation(f.task.id, f.consume.idempotencyKey, { status: 'outcome_unknown' })
    if (boundary === 'wrong-host') {
      const request = { ...f.consume.request, hostOperationId: 'not-a-host' }
      f.repo.connection().prepare('UPDATE operation_receipts SET data_json=json_set(data_json,\'$.request\',json(?),\'$.fingerprint\',?) WHERE owner_id=? AND idempotency_key=?').run(JSON.stringify(request), operationFingerprint(request), f.task.id, f.consume.idempotencyKey)
    }
    if (boundary === 'wrong-resume-task') f.repo.finishOperation(f.task.id, 'explicit-continue', { status: 'succeeded', result: { task: { ...f.task, id: 'different-task' }, turn: { threadId: f.task.threadId, turnId: 'continued-turn' } } })
    expect(() => currentEgoTaskSpaceBinding(f.repo, f.task.id)).toThrowError(expect.objectContaining({ code: 'ego_browser_task_space_unconfirmed' }))
    expect(f.repo.operationById(f.task.id, f.old.id)).toEqual(f.old)
  } finally { await f.dispose() }
})
