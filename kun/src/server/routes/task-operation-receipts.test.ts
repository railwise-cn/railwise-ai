import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskRun } from '../../contracts/tasks.js'
import { TaskRunRepository } from '../../services/task-run-repository.js'
import type { ServerRuntime } from './server-runtime.js'
import { buildRouter } from './index.js'

const now = '2026-11-10T00:00:00.000Z'
const stores: Array<{ store: TaskRunRepository; path: string }> = []
afterEach(() => { for (const { store, path } of stores.splice(0)) { store.close(); rmSync(path, { recursive: true, force: true }) } })

function task(id: string): TaskRun {
  return { id, threadId: `hidden-thread-${id}`, activeTurnId: `hidden-turn-${id}`, childTaskIds: [], workspaceRoot: '/workspace',
    goal: '处理飞书待办', status: 'waiting_user', agentId: 'general',
    acceptance: { kind: 'effect', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false },
    budget: { maxAttempts: 8, maxDurationMs: 60_000 }, attempts: 0, replans: 0, noProgressCount: 0,
    nodes: [], artifacts: [], createdAt: now, updatedAt: now, revision: 0 }
}

function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'railwise-receipt-projection-'))
  const store = new TaskRunRepository(join(path, 'tasks.sqlite3'))
  stores.push({ store, path })
  store.create(task('task-1')); store.create(task('task-2'))
  const verify = vi.fn(async (taskId: string, receiptId: string) => ({ taskId, receiptId, status: 'outcome_unknown' as const, errorCode: 'verification_state_unconfirmed' }))
  const router = buildRouter({ runtimeToken: 'test-token', insecure: false, taskRepository: store, verifyTaskOperationReceipt: verify } as unknown as ServerRuntime)
  const request = (taskId = 'task-1', authorized = true) => {
    const match = router.match('GET', `/v1/tasks/${taskId}/receipts`)!
    return match.handler(new Request(`http://runtime/v1/tasks/${taskId}/receipts`, {
      headers: authorized ? { authorization: 'Bearer test-token' } : {}
    }), { params: match.params })
  }
  return { store, router, request, verify }
}

const evidence = { kind: 'external_operation', provider: 'lark', operation: 'complete', target: 'todo-1', status: 'done',
  verified: true, verifiedAt: now, resultHash: 'result-sha256', remoteOperationId: 'remote-1' }

describe('read-only task operation receipt projection', () => {
  it('returns scoped receipt evidence while removing raw requests, outputs and internal execution identities', async () => {
    const { store, request } = fixture()
    const seed = (ownerId: string, key: string, target: string) => {
      store.beginOperation({ ownerId, idempotencyKey: key, kind: 'tool', nowIso: now, request: {
        toolName: 'lark_task_complete', provider: 'lark', operation: 'complete', target,
        turnId: 'hidden-turn-identifier', executionGrant: { credential: 'SUPER_SECRET' }, body: 'private request body'
      } })
      store.finishOperation(ownerId, key, { status: 'succeeded', result: { approved: true, item: {
        threadId: 'hidden-thread-identifier', isError: false,
        output: { ok: true, status: 'succeeded', evidence: { ...evidence, target, credential: 'SUPER_SECRET' }, data: { token: 'SUPER_SECRET' } }
      } } }, now)
    }
    seed('task-1', 'hidden-turn-key', 'todo-1')
    seed('task-2', 'unrelated-key', 'another-task-target')
    const revision = store.get('task-1')!.revision
    const response = await request()
    expect(response.status).toBe(200)
    const body = typeof response.body === 'string' ? JSON.parse(response.body) : await (response as Response).json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ taskId: 'task-1', provider: 'lark', operation: 'complete', target: 'todo-1', status: 'succeeded', evidence, remoteOperationId: 'remote-1' })
    expect(body[0].requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(body)).not.toMatch(/SUPER_SECRET|private request body|hidden-turn|hidden-thread|another-task-target|executionGrant|idempotencyKey/)
    expect(store.get('task-1')!.revision).toBe(revision)
    expect(store.operations('task-1')).toHaveLength(1)
  })

  it('preserves unknown or unconfirmed outcomes without presenting them as verified evidence', async () => {
    const { store, request } = fixture()
    for (const [key, status, approved] of [['unknown', 'outcome_unknown', true], ['unconfirmed', 'succeeded', false]] as const) {
      store.beginOperation({ ownerId: 'task-1', idempotencyKey: key, kind: 'tool', nowIso: now,
        request: { toolName: 'lark_task_complete', provider: 'lark', operation: 'complete', target: 'todo-1' } })
      store.finishOperation('task-1', key, { status, result: { approved, item: { output: { ok: true, status: 'succeeded', evidence, code: 'external_outcome_unknown' } } } }, now)
    }
    const response = await request()
    const body = typeof response.body === 'string' ? JSON.parse(response.body) : await (response as Response).json()
    expect(body.map((item: { status: string }) => item.status)).toEqual(['outcome_unknown', 'succeeded'])
    expect(body.every((item: { evidence?: unknown }) => item.evidence === undefined)).toBe(true)
    expect(body[0].errorCode).toBe('external_outcome_unknown')
  })

  it('requires authorization, checks task ownership and offers no write endpoint', async () => {
    const { request, router } = fixture()
    expect((await request('task-1', false)).status).toBe(401)
    expect((await request('missing')).status).toBe(404)
    expect(router.match('POST', '/v1/tasks/task-1/receipts')).toBeUndefined()
  })

  it('authenticates and validates the explicit readback command before dispatch', async () => {
    const { router, verify } = fixture()
    const match = router.match('POST', '/v1/tasks/task-1/receipts/operation-1/verify')!
    const invoke = (body: unknown, auth: boolean) => match.handler(new Request('http://runtime/v1/tasks/task-1/receipts/operation-1/verify', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer test-token' } : {}) }, body: JSON.stringify(body)
    }), { params: match.params })
    expect((await invoke({ expectedRevision: 0, idempotencyKey: 'verify-1' }, false)).status).toBe(401)
    expect((await invoke({ expectedRevision: 0, idempotencyKey: 'verify-1', grant: { allowedTools: ['bash'] } }, true)).status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
    expect((await invoke({ expectedRevision: 0, idempotencyKey: 'verify-1' }, true)).status).toBe(200)
    expect(verify).toHaveBeenCalledExactlyOnceWith('task-1', 'operation-1', { expectedRevision: 0, idempotencyKey: 'verify-1' })
  })
})
