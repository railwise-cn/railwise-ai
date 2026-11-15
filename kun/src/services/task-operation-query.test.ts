import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { TaskRunRepository } from './task-run-repository.js'
import type { OperationReceipt } from '../contracts/tasks.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'operation-query-'))
  const repo = new TaskRunRepository(join(root, 'legacy.sqlite3'))
  cleanup.push(async () => { repo.connection().close(); await rm(root, { recursive: true, force: true }) })
  const save = (ownerId: string, key: string, kind: string, status: OperationReceipt['status'] = 'succeeded', request: Record<string, unknown> = {}) => {
    repo.beginOperation({ ownerId, idempotencyKey: key, kind, request, nowIso: '2026-11-15T00:00:00Z' })
    return repo.finishOperation(ownerId, key, { status }, '2026-11-15T00:00:00Z')
  }
  const replace = (row: OperationReceipt, data: unknown) => repo.connection().prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?').run(typeof data === 'string' ? data : JSON.stringify(data), row.ownerId, row.idempotencyKey)
  return { repo, save, replace }
}

it('keeps owner and kind boundaries and first-row lookup semantics even when ids repeat', async () => {
  const f = await fixture(), first = f.save('a', 'one', 'binding'), second = f.save('a', 'two', 'tool'), foreign = f.save('b', 'three', 'binding')
  f.replace(second, { ...second, id: first.id }); f.replace(foreign, { ...foreign, id: first.id })
  expect(f.repo.operationById('a', first.id)).toEqual(first)
  expect(f.repo.operationById('a', first.id, 'tool')).toEqual({ ...second, id: first.id })
  expect(f.repo.operationById('b', first.id)).toEqual({ ...foreign, id: first.id })
  expect(f.repo.operationById('missing', first.id)).toBeNull()
  expect(f.repo.operationById('a', first.id, 'different-kind')).toBeNull()
  expect(f.repo.operations('a', '')).toEqual(f.repo.operations('a'))
})

it('preserves all legacy prepared/null dispatch-tracking and unsettled status semantics', async () => {
  const f = await fixture()
  for (const [key, kind, status, request] of [
    ['missing', 'tool', 'prepared', {}], ['null', 'tool', 'prepared', { dispatchTracking: null }],
    ['host', 'tool', 'prepared', { dispatchTracking: 'host-v1' }], ['old', 'tool', 'prepared', { dispatchTracking: 'legacy' }],
    ['running', 'tool', 'running', {}], ['unknown', 'tool', 'outcome_unknown', {}],
    ['failed', 'tool', 'failed', {}], ['success', 'tool', 'succeeded', {}], ['other', 'authorization', 'prepared', {}],
    ['im', 'im_delivery', 'outcome_unknown', {}]
  ] as const) f.save('a', key, kind, status, request)
  const legacy = f.repo.operations('a').filter(item => item.kind !== 'im_delivery' && (
    ['running', 'outcome_unknown'].includes(item.status) || item.kind === 'tool' && item.status === 'prepared' && item.request?.dispatchTracking !== 'host-v1'
  ) && !f.repo.verifiedOperationResolution(item))
  expect(f.repo.unsettledOperations('a')).toEqual(legacy)
  expect(legacy.map(row => row.idempotencyKey)).toEqual(['missing', 'null', 'old', 'running', 'unknown'])
})

it.each(['before', 'after'] as const)('fails closed for a corrupt safety envelope %s the exact target', async placement => {
  const f = await fixture()
  const old = f.save('a', 'old', 'tool'), target = f.save('a', 'target', 'binding'), next = f.save('a', 'next', 'tool')
  f.replace(placement === 'before' ? old : next, { ...(placement === 'before' ? old : next), status: null })
  expect(() => f.repo.operationById('a', target.id, target.kind)).toThrow()
  expect(() => f.repo.operations('a', 'binding')).toThrow()
  expect(() => f.repo.unsettledOperations('a')).toThrow()
})

it.each(['missing-kind', 'null-kind', 'numeric-kind', 'missing-status', 'null-status', 'unknown-status', 'wrong-owner', 'bad-json'] as const)('does not hide %s behind a filtered read', async corruption => {
  const f = await fixture(), target = f.save('a', 'target', 'binding'), other = f.save('a', 'other', 'tool')
  const data: Record<string, unknown> = { ...other }
  if (corruption === 'missing-kind') delete data.kind
  if (corruption === 'null-kind') data.kind = null
  if (corruption === 'numeric-kind') data.kind = 12
  if (corruption === 'missing-status') delete data.status
  if (corruption === 'null-status') data.status = null
  if (corruption === 'unknown-status') data.status = 'unrecognized'
  if (corruption === 'wrong-owner') data.ownerId = 'b'
  f.replace(other, corruption === 'bad-json' ? '{"broken":' : data)
  expect(() => f.repo.operationById('a', target.id, 'binding')).toThrow()
  expect(() => f.repo.operations('a', 'binding')).toThrow()
  expect(() => f.repo.unsettledOperations('a')).toThrow()
})

it('reads existing rows without a schema migration, an index, or any receipt rewrite', async () => {
  const f = await fixture(), target = f.save('a', 'target', 'binding')
  f.save('a', 'large-history', 'tool', 'succeeded', { html: '<main>' + 'read-only history'.repeat(10000) + '</main>' })
  const before = Buffer.from(f.repo.connection().serialize())
  expect(f.repo.operationById('a', target.id, 'binding')).toEqual(target)
  expect(f.repo.operations('a', 'binding')).toEqual([target])
  expect(f.repo.unsettledOperations('a')).toEqual([])
  expect(f.repo.connection().serialize()).toEqual(before)
})
