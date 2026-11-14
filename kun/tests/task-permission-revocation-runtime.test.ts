import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { TaskRun } from '../src/contracts/tasks.js'
import type { TaskPermissionResult, TaskPermissionSnapshot } from '../src/services/task-permission-service.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

/** Synthetic provider waits indefinitely so revocation exercises the real in-flight Runtime. */
async function fixture(duration: 'task' | 'next_operation' = 'task') {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-permission-revoke-'))
  cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary), workspace = join(root, 'workspace')
  await mkdir(workspace)
  let modelRequests = 0, closedRequests = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the synthetic request */ }
    modelRequests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': synthetic pending model\n\n')
    response.on('close', () => { closedRequests++ })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic',
    apiKey: 'synthetic-local-only', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions',
    model: 'synthetic-protocol', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }) })
  cleanup.push(async () => { await runtime.taskCoordinator!.flushCommandMessages(); await runtime.shutdown?.() })
  const router = buildRouter(runtime)
  const api = (path: string, method = 'GET', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, {
    method, headers: { authorization: 'Bearer synthetic', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
  }))
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic-protocol' })
  const blocked = await runtime.taskCoordinator!.command({ threadId: origin.id, idempotencyKey: 'initial', request: { prompt: '保存到 report.html' } })
  expect(blocked.kind).toBe('capability_required')
  const task = blocked.task!
  const snapshot = await (await api(`/v1/tasks/${task.id}/permissions`)).json() as TaskPermissionSnapshot
  const grantResponse = await api(`/v1/tasks/${task.id}/permissions`, 'POST', { expectedRevision: snapshot.taskRevision, idempotencyKey: 'grant', scopeHash: snapshot.scopeHash,
    confirmed: true, approvalPolicy: 'on-request', ttlSeconds: 900, duration, scope: { readPaths: [workspace], writePaths: [workspace] } })
  expect(grantResponse.status).toBe(200)
  const granted = await grantResponse.json() as TaskPermissionResult
  const permissionId = granted.permission.grant!.id
  const current = () => runtime.taskRepository!.currentExecution(task.id)!
  const revokeBody = (key = 'revoke') => ({ expectedRevision: current().revision, permissionId, idempotencyKey: key })
  const start = async () => {
    const resumed = await runtime.taskCoordinator!.command({ threadId: origin.id, taskId: current().id, intent: 'resume', idempotencyKey: `resume:${current().id}`, request: { prompt: '继续' } })
    expect(resumed.kind).toBe('task_started')
    await expect.poll(() => modelRequests, { timeout: 10_000 }).toBeGreaterThan(0)
    return (await runtime.threadService.get(current().threadId))!.turns.find(turn => turn.id === current().activeTurnId)!
  }
  return { runtime, router, api, task, current, workspace, origin, permissionId, revokeBody, start, requests: () => modelRequests, closed: () => closedRequests }
}

describe('task permission revocation through authenticated production routes', () => {
  it.each(['running', 'paused'] as const)('revokes a %s task, invalidates its old Grant and keeps an attached image queued', async state => {
    const f = await fixture()
    const turn = await f.start()
    const oldGrant = turn.executionGrant!
    if (state === 'paused') {
      const task = f.current()
      expect((await f.api(`/v1/tasks/${task.id}/pause`, 'POST', { expectedRevision: task.revision, idempotencyKey: 'pause-first' })).status).toBe(200)
    }
    const body = f.revokeBody()
    const first = await f.api(`/v1/tasks/${f.current().id}/permissions`, 'DELETE', body)
    expect(first.status, await first.clone().text()).toBe(200)
    expect(f.current().status).toBe('paused')
    await expect.poll(f.closed, { timeout: 5_000 }).toBe(1)
    await expect(f.runtime.taskPermissionService!.executionRestriction(f.task.threadId, oldGrant.taskPermissionId)).rejects.toMatchObject({ code: 'task_permission_revoked' })
    const pausedEvents = f.runtime.taskRepository!.events(f.current().id).filter(event => event.kind === 'task_paused').length
    expect((await f.api(`/v1/tasks/${f.current().id}/permissions`, 'DELETE', body)).status).toBe(200)
    expect(f.runtime.taskRepository!.events(f.current().id).filter(event => event.kind === 'task_paused')).toHaveLength(pausedEvents)
    expect(f.runtime.taskRepository!.operations(f.current().id, 'task_permission_revoke')).toHaveLength(1)
    const conflicting = await f.api(`/v1/tasks/${f.current().id}/permissions`, 'DELETE', { ...body, permissionId: `${body.permissionId}-different` })
    expect(conflicting.status).toBe(409)
    expect(await conflicting.json()).toMatchObject({ code: 'idempotency_conflict' })
    const png = Buffer.alloc(24); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(1,16); png.writeUInt32BE(1,20)
    const image = await f.runtime.attachmentStore!.create({ name: '合成附图.png', data: png, mimeType: 'image/png', threadId: f.origin.id, workspace: f.workspace })
    const beforeTurns = (await f.runtime.threadService.get(f.task.threadId))!.turns.length
    const input = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, taskId: f.current().id, intent: 'supplement', idempotencyKey: 'image-after-revoke', request: { prompt: '再补充这张图片', attachmentIds: [image.id] } })
    expect(input).toMatchObject({ kind: 'input_queued', task: { status: 'paused' }, input: { attachmentIds: [image.id] } })
    expect(f.runtime.taskRepository!.inputs(f.current().id, true).some(input => input.attachmentIds?.includes(image.id))).toBe(true)
    expect((await f.runtime.threadService.get(f.task.threadId))!.turns).toHaveLength(beforeTurns)
    expect(f.requests()).toBe(1)
    const resumed = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, taskId: f.current().id, intent: 'resume', idempotencyKey: 'resume-revoked', request: { prompt: '继续' } })
    expect(resumed).toMatchObject({ kind: 'capability_required', capability: { errorCode: 'task_permission_revoked' } })
    expect((await f.runtime.threadService.get(f.task.threadId))!.turns).toHaveLength(beforeTurns)
  })

  it('keeps a consumed one-operation Grant revoked and retains unknown operations across attempted reauthorization', async () => {
    const f = await fixture('next_operation')
    const turn = await f.start()
    const operation = f.runtime.taskController!.beginToolOperation(turn.id, { callId: 'uncertain-write', toolName: 'write', arguments: { path: 'report.html', content: 'synthetic' } }, turn.executionGrant!)!
    await f.runtime.taskPermissionService!.claimOperation(f.task.threadId, f.permissionId, operation.key)
    f.runtime.taskRepository!.finishOperation(f.task.id, operation.key, { status: 'outcome_unknown', error: 'Synthetic crash after dispatch' }, f.runtime.nowIso())
    const receipt = f.runtime.taskRepository!.operation(f.task.id, operation.key)!
    const response = await f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', f.revokeBody())
    expect(response.status, await response.clone().text()).toBe(200)
    expect(f.current().status).toBe('paused')
    expect(f.runtime.taskRepository!.operation(f.task.id, operation.key)).toEqual(receipt)
    const grant = f.current().authority!.taskApprovalGrant!
    expect(grant.consumedOperationId).toBe(operation.key)
    expect(grant.revokedAt).toBeDefined()
    await expect(f.runtime.taskPermissionService!.executionRestriction(f.task.threadId, f.permissionId)).rejects.toMatchObject({ code: 'task_permission_revoked' })
    const snapshot = await (await f.api(`/v1/tasks/${f.task.id}/permissions`)).json() as TaskPermissionSnapshot
    const replacement = await f.api(`/v1/tasks/${f.task.id}/permissions`, 'POST', { expectedRevision: snapshot.taskRevision, idempotencyKey: 'cannot-bypass-unknown', scopeHash: snapshot.scopeHash, confirmed: true,
      approvalPolicy: 'on-request', ttlSeconds: 900, duration: 'task', scope: { writePaths: [f.workspace] } })
    expect(replacement.status).toBe(409)
    expect(f.runtime.taskRepository!.operation(f.task.id, operation.key)?.status).toBe('outcome_unknown')
  })

  it('revokes the original owner permission through an active retry without copying or widening its Grant', async () => {
    const f = await fixture()
    const first = await f.start()
    f.runtime.taskController!.recordAttemptFailure(f.task.threadId, first.id, 'max_tokens', 'Synthetic model failure before any effect')
    await f.runtime.turnService.interruptTurn({ threadId: f.task.threadId, turnId: first.id })
    await expect.poll(f.closed, { timeout: 5_000 }).toBe(1)
    expect(f.current().status).toBe('failed')
    expect((await f.runtime.taskPermissionService!.snapshot(f.task.id)).grant?.status).toBe('active')
    const response = await f.api(`/v1/tasks/${f.task.id}/retry`, 'POST', { expectedRevision: f.current().revision, idempotencyKey: 'retry-owner-permission' })
    expect(response.status, await response.clone().text()).toBe(202)
    const retried = await response.json() as { task: TaskRun; turn?: { turnId: string } }
    expect(retried.turn, JSON.stringify(retried)).toBeDefined()
    expect(retried.task.retryOfTaskId).toBe(f.task.id)
    await expect.poll(f.requests, { timeout: 10_000 }).toBe(2)
    const current = f.current()
    const turn = (await f.runtime.threadService.get(current.threadId))!.turns.find(turn => turn.id === current.activeTurnId)!
    expect(turn.executionGrant).toMatchObject({ taskId: current.id, taskPermissionId: f.permissionId, writePathAllowlist: [f.workspace] })
    expect(current.authority?.taskApprovalGrant).toBeUndefined()
    const revoked = await f.api(`/v1/tasks/${current.id}/permissions`, 'DELETE', f.revokeBody('revoke-inherited'))
    expect(revoked.status, await revoked.clone().text()).toBe(200)
    expect(f.current().status).toBe('paused')
    await expect.poll(f.closed, { timeout: 5_000 }).toBe(2)
    expect(f.runtime.taskRepository!.get(f.task.id)!.authority?.taskApprovalGrant?.revokedAt).toBeDefined()
    await expect(f.runtime.taskPermissionService!.executionRestriction(current.threadId, f.permissionId)).rejects.toMatchObject({ code: 'task_permission_revoked' })
  })

  it.each([false, true])('keeps an expired failed-task retry reauthorizable without a Turn (recovered partial retry %s)', async recovered => {
    const f = await fixture()
    const first = await f.start()
    f.runtime.taskController!.recordAttemptFailure(f.task.threadId, first.id, 'max_tokens', 'Synthetic failure before retry')
    await f.runtime.turnService.interruptTurn({ threadId: f.task.threadId, turnId: first.id })
    await expect.poll(f.closed, { timeout: 5_000 }).toBe(1)
    const source = f.current()
    f.runtime.taskRepository!.update(source.id, source.revision, task => ({ ...task, authority: { ...task.authority!, taskApprovalGrant: { ...task.authority!.taskApprovalGrant!, expiresAt: new Date(Date.now() - 1_000).toISOString() } } }))
    const retryRequest = { expectedRevision: f.current().revision, idempotencyKey: 'expired-source' }
    if (recovered) {
      // Reproduce a process exit after the retry record committed and before its waiting outcome committed.
      f.runtime.taskRepository!.beginOperation({ ownerId: source.id, idempotencyKey: retryRequest.idempotencyKey, kind: 'retry', request: retryRequest, nowIso: f.runtime.nowIso() })
      const id = `task_retry_${createHash('sha256').update(`task:${source.id}:retry:${retryRequest.idempotencyKey}`).digest('hex')}`
      f.runtime.taskController!.createRetryTask({ id, sourceTaskId: source.id, expectedRevision: retryRequest.expectedRevision,
        thread: (await f.runtime.threadService.get(source.threadId))!, request: { prompt: source.goal } })
    }
    const response = await f.api(`/v1/tasks/${source.id}/retry`, 'POST', retryRequest)
    expect(response.status).toBe(202)
    const retried = await response.json() as { task: TaskRun; turn?: { turnId: string } }
    expect(retried.turn).toBeUndefined()
    expect(retried.task).toMatchObject({ status: 'waiting_user', retryOfTaskId: source.id })
    const permission = await (await f.api(`/v1/tasks/${retried.task.id}/permissions`)).json() as TaskPermissionSnapshot
    expect(permission.canConfirm).toBe(true)
    expect(f.requests()).toBe(1)
    expect((await f.runtime.threadService.get(source.threadId))!.turns).toHaveLength(1)
    const replay = await (await f.api(`/v1/tasks/${source.id}/retry`, 'POST', retryRequest)).json() as { task: TaskRun }
    expect(replay.task.id).toBe(retried.task.id)
    const granted = await f.api(`/v1/tasks/${retried.task.id}/permissions`, 'POST', { expectedRevision: permission.taskRevision, scopeHash: permission.scopeHash,
      idempotencyKey: 'new-retry-scope', confirmed: true, approvalPolicy: 'on-request', ttlSeconds: 900, duration: 'task', scope: { readPaths: [f.workspace], writePaths: [f.workspace] } })
    expect(granted.status, await granted.clone().text()).toBe(200)
    expect(f.requests()).toBe(1)
    const resumed = await f.api(`/v1/tasks/${retried.task.id}/resume`, 'POST', { expectedRevision: f.current().revision, idempotencyKey: 'resume-authorized-retry' })
    expect(resumed.status, await resumed.clone().text()).toBe(202)
    await expect.poll(f.requests, { timeout: 5_000 }).toBe(2)
    expect(f.current().id).toBe(retried.task.id)
    expect(f.runtime.taskRepository!.list({ workspaceRoot: f.workspace }).filter(task => task.retryOfTaskId === source.id)).toHaveLength(1)
    await expect(f.runtime.taskPermissionService!.executionRestriction(source.threadId, f.permissionId)).rejects.toMatchObject({ code: 'task_permission_revoked' })
  })

  it('recovers after revocation commits but the response snapshot is interrupted', async () => {
    const f = await fixture()
    const body = f.revokeBody('recover-commit')
    vi.spyOn(f.runtime.taskPermissionService!, 'snapshot').mockRejectedValueOnce(new Error('Synthetic interruption after revocation commit'))
    expect((await f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body)).status).toBe(500)
    expect(f.current().authority!.taskApprovalGrant!.revokedAt).toBeDefined()
    const replay = await f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body)
    expect(replay.status, await replay.clone().text()).toBe(200)
    expect(f.current().status).toBe('paused')
  })

  it('coalesces concurrent identical revocation requests into one persisted revocation and pause', async () => {
    const f = await fixture()
    const body = f.revokeBody('concurrent-same-key')
    const responses = await Promise.all([f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body), f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body)])
    expect(await Promise.all(responses.map(async response => ({ status: response.status, code: (await response.json() as { code?: string }).code })))).toEqual([
      expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 })
    ])
    expect(f.runtime.taskRepository!.operations(f.task.id, 'task_permission_revoke')).toHaveLength(1)
    expect(f.runtime.taskRepository!.events(f.task.id).filter(event => event.kind === 'task_paused')).toHaveLength(1)
  })

  it('finishes pausing when a normal supplement advances the task after revocation', async () => {
    const f = await fixture()
    const revoke = f.runtime.taskPermissionService!.revoke.bind(f.runtime.taskPermissionService)
    vi.spyOn(f.runtime.taskPermissionService!, 'revoke').mockImplementationOnce(async (id, request) => {
      const result = await revoke(id, request)
      await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, taskId: id, intent: 'supplement', idempotencyKey: 'interleaved-input', request: { prompt: '再补充一个说明' } })
      return result
    })
    const body = f.revokeBody('interleaving')
    const first = await f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body)
    const replay = first.ok ? first : await f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body)
    expect(replay.status, await replay.clone().text()).toBe(200)
    expect(f.current().status).toBe('paused')
    expect(f.runtime.taskRepository!.inputs(f.task.id).filter(input => input.idempotencyKey === 'interleaved-input')).toHaveLength(1)
  })

  it('retries interruption after the pause receipt was committed before a transient failure', async () => {
    const f = await fixture()
    await f.start()
    vi.spyOn(f.runtime.turnService, 'interruptTurn').mockRejectedValueOnce(new Error('Synthetic interruption service failure'))
    const body = f.revokeBody('retry-interrupt')
    expect((await f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body)).status).toBe(500)
    expect(f.current().status).toBe('paused')
    expect(f.closed()).toBe(0)
    const replay = await f.api(`/v1/tasks/${f.task.id}/permissions`, 'DELETE', body)
    expect(replay.status, await replay.clone().text()).toBe(200)
    await expect.poll(f.closed, { timeout: 5_000 }).toBe(1)
    expect(f.runtime.taskRepository!.events(f.task.id).filter(event => event.kind === 'task_paused')).toHaveLength(1)
  })
})
