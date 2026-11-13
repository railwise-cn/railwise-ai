import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskRunSchema, type OperationReceipt } from '../../../kun/src/contracts/tasks'
import { TaskRunRepository } from '../../../kun/src/services/task-run-repository'
import { browserDaemonPreservation, disposeBrowserAfterRuntimeStop } from './browser-daemon-preservation'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).forEach(dispose => dispose()))
const now = '2026-11-14T01:00:00.000Z'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-exit-'))
  const path = join(root, 'tasks.sqlite3')
  const repository = new TaskRunRepository(path)
  let closed = false
  const close = () => { if (!closed) { repository.close(); closed = true } }
  cleanup.push(() => { close(); rmSync(root, { recursive: true, force: true }) })
  repository.create(TaskRunSchema.parse({ id: 'task', threadId: 'thread', childTaskIds: [], workspaceRoot: root,
    goal: 'Synthetic public page', status: 'waiting_user', agentId: 'default',
    acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false },
    budget: { maxAttempts: 3, maxDurationMs: 600000 }, attempts: 1, replans: 0, noProgressCount: 0, nodes: [], artifacts: [],
    revision: 0, createdAt: now, updatedAt: now }))
  const operation = (status: OperationReceipt['status'], kind = 'browser_action_dispatch', request = { sessionId: 'session-one', toolName: 'browser_fill', action: 'fill' } as Record<string, unknown>, key = 'dispatch') => {
    repository.beginOperation({ ownerId: 'task', idempotencyKey: key, kind, request, nowIso: now })
    if (status !== 'prepared') repository.finishOperation('task', key, { status }, now)
    return repository.operation('task', key)!
  }
  const resolve = (receipt: OperationReceipt) => {
    const evidence = { kind: 'human_confirmation' as const, provider: 'browser-skill', operation: 'fill', target: 'session-one',
      status: 'confirmed_applied', verified: true, verifiedAt: now, resultHash: 'a'.repeat(64) }
    const proof = repository.beginOperation({ ownerId: 'task', idempotencyKey: 'readback', kind: 'effect_verification',
      request: { originalReceiptId: receipt.id, originalFingerprint: receipt.fingerprint }, nowIso: now }).receipt
    repository.finishOperation('task', proof.idempotencyKey, { status: 'succeeded', result: { evidence } }, now)
    repository.resolveOperation('task', receipt.idempotencyKey, { status: 'verified', receiptId: proof.id, evidence, resolvedAt: now })
    return proof
  }
  const replace = (receipt: OperationReceipt) => repository.connection().prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?')
    .run(JSON.stringify(receipt), receipt.ownerId, receipt.idempotencyKey)
  return { root, path, repository, close, operation, resolve, replace }
}

describe('post-exit browser daemon preservation', () => {
  it.each(['prepared', 'running', 'outcome_unknown'] as const)('preserves the driver for durable %s browser dispatches', status => {
    const f = fixture()
    f.operation(status)
    f.close()
    expect(browserDaemonPreservation(f.path, true)).toEqual({ preserveDaemon: true, reason: 'unsettled_browser_action' })
  })

  it('allows normal cleanup for fully acknowledged actions and explicit cancellation', () => {
    const f = fixture()
    f.operation('succeeded')
    expect(browserDaemonPreservation(f.path, true)).toEqual({ preserveDaemon: false, reason: 'clear' })
    f.operation('outcome_unknown', 'browser_action_dispatch', { action: 'fill' }, 'cancelled-action')
    f.repository.update('task', 0, task => ({ ...task, status: 'cancelled' }))
    const cancelled = f.repository.operation('task', 'cancelled-action')!
    f.replace({ ...cancelled, fingerprint: 'historical-fingerprint-unavailable' })
    f.close()
    expect(browserDaemonPreservation(f.path, true)).toEqual({ preserveDaemon: false, reason: 'clear' })
  })

  it('verifies the persisted proof and leaves the original unknown receipt and database bytes intact', () => {
    const f = fixture()
    const receipt = f.operation('outcome_unknown')
    f.resolve(receipt)
    const before = f.repository.operation('task', receipt.idempotencyKey)
    expect(before?.status).toBe('outcome_unknown')
    expect(browserDaemonPreservation(f.path, true)).toEqual({ preserveDaemon: false, reason: 'clear' })
    expect(f.repository.operation('task', receipt.idempotencyKey)).toEqual(before)
    f.close()
    const hash = () => createHash('sha256').update(readFileSync(f.path)).digest('hex')
    const originalHash = hash()
    expect(browserDaemonPreservation(f.path, true).preserveDaemon).toBe(false)
    expect(hash()).toBe(originalHash)
  })

  it.each(['missing-proof', 'failed-proof', 'wrong-original', 'wrong-fingerprint', 'changed-evidence', 'wrong-owner'] as const)('preserves when resolution has %s', change => {
    const f = fixture()
    const receipt = f.operation('outcome_unknown')
    const proof = f.resolve(receipt)
    const saved = f.repository.operation('task', proof.idempotencyKey)!
    if (change === 'missing-proof') f.repository.connection().prepare('DELETE FROM operation_receipts WHERE owner_id=? AND idempotency_key=?').run('task', proof.idempotencyKey)
    if (change === 'failed-proof') f.replace({ ...saved, status: 'failed' })
    if (change === 'wrong-original') f.replace({ ...saved, request: { ...saved.request, originalReceiptId: 'other' } })
    if (change === 'wrong-fingerprint') f.replace({ ...saved, request: { ...saved.request, originalFingerprint: 'b'.repeat(64) } })
    if (change === 'changed-evidence') f.replace({ ...saved, result: { evidence: { ...(saved.result as { evidence: Record<string, unknown> }).evidence, resultHash: 'b'.repeat(64) } } })
    if (change === 'wrong-owner') f.repository.connection().prepare('UPDATE operation_receipts SET owner_id=?,data_json=? WHERE owner_id=? AND idempotency_key=?')
      .run('other-task', JSON.stringify({ ...saved, ownerId: 'other-task' }), 'task', proof.idempotencyKey)
    f.close()
    expect(browserDaemonPreservation(f.path, true).preserveDaemon).toBe(true)
  })

  it('scans beyond the thread-list page size and protects legacy unknown browser tool records', () => {
    const f = fixture()
    for (let index = 0; index < 550; index += 1) f.operation('succeeded', 'tool', { toolName: 'read' }, `read-${index}`)
    f.operation('outcome_unknown', 'tool', { toolName: 'browser_fill' }, 'legacy-browser')
    f.close()
    expect(browserDaemonPreservation(f.path, true)).toEqual({ preserveDaemon: true, reason: 'unsettled_browser_action' })
  })

  it('cleans an undispatched host-tracked approval but preserves missing task or legacy dispatch history', () => {
    const f = fixture()
    f.operation('prepared', 'tool', { toolName: 'browser_fill', dispatchTracking: 'host-v1' })
    expect(browserDaemonPreservation(f.path, true).preserveDaemon).toBe(false)
    const receipt = f.operation('outcome_unknown', 'browser_action_dispatch', {}, 'missing-task')
    f.repository.connection().prepare('UPDATE operation_receipts SET owner_id=?,data_json=? WHERE owner_id=? AND idempotency_key=?')
      .run('missing', JSON.stringify({ ...receipt, ownerId: 'missing' }), 'task', receipt.idempotencyKey)
    f.close()
    expect(browserDaemonPreservation(f.path, true)).toEqual({ preserveDaemon: true, reason: 'unverified_history' })
  })

  it('preserves on missing, corrupt or unsupported database records without creating a database', () => {
    const f = fixture()
    const missing = join(f.root, 'missing.sqlite3')
    expect(browserDaemonPreservation(missing, true)).toEqual({ preserveDaemon: true, reason: 'database_unavailable' })
    expect(existsSync(missing)).toBe(false)
    writeFileSync(missing, 'invalid SQLite')
    expect(browserDaemonPreservation(missing, true).preserveDaemon).toBe(true)
    f.operation('outcome_unknown')
    f.repository.connection().prepare('UPDATE operation_receipts SET data_json=?').run('{}')
    f.close()
    expect(browserDaemonPreservation(f.path, true)).toEqual({ preserveDaemon: true, reason: 'unverified_history' })
  })

  it('passes the actual exit outcome to disposal and skips all reads after a quit deadline', async () => {
    const f = fixture()
    f.close()
    const databasePath = vi.fn(async () => f.path)
    const dispose = vi.fn(async (_options: { preserveDaemon: boolean }) => undefined)
    expect(await disposeBrowserAfterRuntimeStop({ runtimeStopped: false, databasePath, dispose }))
      .toEqual({ preserveDaemon: true, reason: 'runtime_exit_unconfirmed' })
    expect(databasePath).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenLastCalledWith({ preserveDaemon: true })
    expect(await disposeBrowserAfterRuntimeStop({ runtimeStopped: true, databasePath, dispose }))
      .toEqual({ preserveDaemon: false, reason: 'clear' })
    expect(dispose).toHaveBeenLastCalledWith({ preserveDaemon: false })
    databasePath.mockRejectedValueOnce(new Error('unavailable settings'))
    expect((await disposeBrowserAfterRuntimeStop({ runtimeStopped: true, databasePath, dispose })).preserveDaemon).toBe(true)
    expect(dispose).toHaveBeenLastCalledWith({ preserveDaemon: true })
  })
})
