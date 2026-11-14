import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'

vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: string[]) => {
    if (JSON.stringify(args) !== '["status"]') throw new Error('No browser action is permitted in this permission fixture')
    return { ok: true, output: { protocol_version: '1.9', pid: 7, browsers: [{ instance_id: 'synthetic-browser', browser_name: 'Chrome', label: 'Synthetic', extension_version: '0.5.0', extension_protocol_version: '1.9' }] } }
  })
}))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-permission-resume-'))
  cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary), workspace = join(root, 'workspace')
  await mkdir(workspace)
  let requests = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* local synthetic model only */ }
    requests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': synthetic pending model\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic',
    apiKey: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions' as const,
    model: 'synthetic', approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: {
      enabled: true, state: 'ready', browserInstanceId: 'synthetic-browser', revision: 1, executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64),
      version: '0.5.0', daemonProtocolVersion: '1.9', browsers: [{ id: 'synthetic-browser', name: 'Chrome', label: 'Synthetic', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }],
      origins: ['https://example.com'], interaction: 'observe'
    } }) }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => { await runtime.taskCoordinator!.flushCommandMessages(); await runtime.shutdown?.() })
  let router = buildRouter(runtime)
  const api = (path: string, method = 'GET', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, {
    method, headers: { authorization: 'Bearer synthetic', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
  }))
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic' })
  const worker = await runtime.threadService.fork(origin.id, { relation: 'side' })
  const task = runtime.taskController!.createWaitingTask({ id: 'permission-task', thread: worker,
    request: { prompt: '整理已获取的公开资料，制作摘要', taskIntent: 'new', taskVisibility: 'task', taskOriginThreadId: origin.id }, reason: 'Synthetic original waiting task' })
  const current = () => runtime.taskRepository!.get(task.id)!
  const snapshot = () => runtime.taskPermissionService!.snapshot(task.id)
  const before = await snapshot()
  const permission = await runtime.taskPermissionService!.confirm(task.id, { expectedRevision: before.taskRevision, scopeHash: before.scopeHash,
    idempotencyKey: 'original-permission', confirmed: true, approvalPolicy: 'on-request', ttlSeconds: 900, duration: 'task', scope: { readPaths: [workspace] } })
  await runtime.taskControlService!.mutate(task.id, 'pause', { expectedRevision: current().revision, idempotencyKey: 'pause' })
  const expire = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(permission.permission.grant!.expiresAt) + 1000) }
  const resume = (idempotencyKey = 'one-continue') => api(`/v1/tasks/${task.id}/resume`, 'POST', { expectedRevision: current().revision, idempotencyKey })
  const turns = async () => (await runtime.threadService.get(worker.id))!.turns
  const restart = async () => { await runtime.shutdown?.(); runtime = await createKunServeRuntime(options); router = buildRouter(runtime) }
  const legacyFailure = async () => {
    expire()
    const prepared = runtime.taskController!.prepareResume(task.id, current().revision)
    const started = await runtime.turnService.startTurn({ threadId: worker.id, continuationTaskId: task.id, request: { prompt: prepared.goal, idempotencyKey: 'old-version-continue' } })
    // Drive the old production Controller transitions; no fabricated terminal Task or model response.
    for (let attempt = 0; attempt < 8; attempt++) {
      runtime.taskController!.beginAttempt(worker.id, started.turnId)
      runtime.taskController!.recordAttemptFailure(worker.id, started.turnId, 'turn_attempt_exception', '当前任务的临时审批权限已到期，请重新确认后重查原任务。')
    }
    await runtime.turnService.finishTurn({ threadId: worker.id, turnId: started.turnId, status: 'failed' })
    runtime.taskController!.endRun(started.turnId)
    expect(current()).toMatchObject({ status: 'failed', attempts: 8 })
    return started
  }
  return { get runtime() { return runtime }, api, current, snapshot, expire, resume, turns, restart, legacyFailure, requests: () => requests, workspace, origin }
}

it('keeps ONE Continue with an expired persisted grant before any Turn, attempt or model and persists an idempotent repair card', async () => {
  const f = await fixture()
  f.expire()
  expect((await f.snapshot()).grant?.status).toBe('expired')
  const before = f.current()
  const response = await f.resume()
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({ task: { id: before.id, status: 'paused', attempts: 0 }, capability: { provider: 'workspace', errorCode: 'task_permission_expired', resolution: { route: 'task-permissions' } } })
  expect(await f.turns()).toHaveLength(0)
  expect(f.requests()).toBe(0)
  expect(f.current().budget).toEqual(before.budget)
  expect(f.current().revision).toBe(before.revision)
  await f.resume()
  await f.resume('fresh-recheck')
  await f.runtime.taskCoordinator!.flushCommandMessages()
  expect(f.runtime.taskRepository!.execution.attempts(before.id)).toHaveLength(0)
  const cards = (await f.runtime.sessionStore.loadItems(f.origin.id)).filter(item => item.kind === 'assistant_text' && item.capabilityCard)
  expect(cards).toHaveLength(1)
  await f.restart()
  expect(f.current().status).toBe('paused')
  expect(f.runtime.taskRepository!.attention(`capability_${before.id}`)?.status).toBe('pending')
  expect(await f.turns()).toHaveLength(0)
  const snap = await f.snapshot()
  const confirm = await f.api(`/v1/tasks/${before.id}/permissions`, 'POST', { expectedRevision: snap.taskRevision, scopeHash: snap.scopeHash, idempotencyKey: 'renew-explicitly',
    confirmed: true, approvalPolicy: 'on-request', ttlSeconds: 900, duration: 'task', scope: { readPaths: [f.workspace] } })
  expect(confirm.status, await confirm.clone().text()).toBe(200)
  expect(await confirm.json()).toMatchObject({ resumed: false, task: { id: before.id, status: 'paused', attempts: 0 } })
  expect(f.requests()).toBe(0)
  expect((await f.resume('separate-continue')).status).toBe(202)
  await expect.poll(f.requests).toBe(1)
  expect(f.current()).toMatchObject({ id: before.id, attempts: 1, status: 'running' })
})

it.each(['revoked', 'prepared', 'consumed'] as const)('blocks a %s permission before admission even when the goal has no file-write preflight', async state => {
  const f = await fixture()
  const task = f.current(), grant = task.authority!.taskApprovalGrant!
  if (state === 'revoked') {
    expect((await f.api(`/v1/tasks/${task.id}/permissions`, 'DELETE', { expectedRevision: task.revision, permissionId: grant.id, idempotencyKey: 'revoke' })).status).toBe(200)
  } else {
    f.runtime.taskRepository!.update(task.id, task.revision, value => ({ ...value, authority: { ...value.authority!, taskApprovalGrant: { ...grant,
      ...(state === 'prepared' ? { status: 'prepared' as const } : { duration: 'next_operation' as const, consumedOperationId: 'prior-operation', consumedAt: f.runtime.nowIso() }) } } }))
  }
  const result = await (await f.resume()).json()
  expect(result).toMatchObject({ capability: { errorCode: state === 'consumed' ? 'task_permission_consumed' : 'task_permission_revoked' }, task: { status: 'paused', attempts: 0 } })
  expect(await f.turns()).toHaveLength(0)
  expect(f.requests()).toBe(0)
})

it.each(['before-attempt', 'after-attempt'] as const)('handles an expiry race %s without a model request or automatic retry', async boundary => {
  const f = await fixture()
  const service = f.runtime.taskPermissionService!
  const original = service.executionRestriction.bind(service)
  let checked = 0
  vi.spyOn(service, 'executionRestriction').mockImplementation(async (...args) => {
    checked++
    if (checked >= (boundary === 'before-attempt' ? 2 : 3)) throw Object.assign(new Error('Synthetic permission expired during admission'), { code: 'task_permission_expired' })
    return original(...args)
  })
  await f.resume()
  await expect.poll(() => f.current().status).toBe('waiting_user')
  expect(f.current().attempts).toBe(boundary === 'before-attempt' ? 0 : 1)
  expect(f.requests()).toBe(0)
  expect(f.runtime.taskRepository!.attention(`capability_${f.current().id}`)?.payload?.capability).toMatchObject({ errorCode: 'task_permission_expired' })
  expect(f.runtime.taskRepository!.events(f.current().id).filter(event => ['attempt_retrying', 'task_replanned'].includes(event.kind))).toHaveLength(0)
})

it.each(['restore', 'replace'] as const)('recovers the original failed attempt-eight task through explicit %s, keeping history and budget until separate Continue', async action => {
  const f = await fixture()
  const priorScope = { browserInstanceId: 'synthetic-browser', revision: 1, interaction: 'observe' as const, origins: ['https://example.com'] }
  const beforeScope = f.current()
  f.runtime.taskRepository!.update(beforeScope.id, beforeScope.revision, value => ({ ...value, authority: { ...value.authority!, browserScope: priorScope } }))
  await f.legacyFailure()
  const before = f.current(), repo = f.runtime.taskRepository!
  const events = repo.events(before.id)
  const attempts = repo.execution.attempts(before.id)
  const used = repo.execution.usedExecutionMs(before.id, Date.now())
  await f.restart()
  const snap = await f.snapshot()
  expect(snap).toMatchObject({ recoveryEligible: true, canConfirm: true, canRestoreBase: true, grant: { status: 'expired' } })
  const endpoint = `/v1/tasks/${before.id}/permissions`
  const body = action === 'restore' ? { expectedRevision: snap.taskRevision, permissionId: snap.grant!.id, idempotencyKey: 'explicit-repair', restoreBase: true }
    : { expectedRevision: snap.taskRevision, scopeHash: snap.scopeHash, idempotencyKey: 'explicit-repair', confirmed: true, approvalPolicy: 'on-request', ttlSeconds: 900, duration: 'task', scope: { readPaths: [f.workspace] } }
  const result = await f.api(endpoint, action === 'restore' ? 'DELETE' : 'POST', body)
  expect(result.status, await result.clone().text()).toBe(200)
  expect(await result.json()).toMatchObject({ resumed: false, task: { id: before.id, status: 'paused', attempts: 8, budget: before.budget, authority: { browserScope: priorScope } } })
  expect(f.requests()).toBe(0)
  expect(f.runtime.taskRepository!.execution.attempts(before.id)).toEqual(attempts)
  expect(f.runtime.taskRepository!.events(before.id).slice(0, events.length)).toEqual(events)
  expect(f.runtime.taskRepository!.execution.usedExecutionMs(before.id, Date.now())).toBe(used)
  if (action === 'restore') expect(f.current().authority?.taskApprovalGrant).toBeUndefined()
  expect((await f.api(endpoint, action === 'restore' ? 'DELETE' : 'POST', body)).status).toBe(200)
  expect(f.current().status).toBe('paused')
  const resumed = await (await f.resume('explicit-separate-resume')).json()
  expect(resumed).toHaveProperty('turn')
  await expect.poll(() => ({ requests: f.requests(), status: f.current().status, reason: f.current().waitingReason, nodes: f.current().nodes }), { timeout: 3000 }).toMatchObject({ requests: 1 })
  expect(f.current()).toMatchObject({ id: before.id, attempts: 9, status: 'running', budget: before.budget })
})

it.each(['model-work', 'unknown-effect', 'known-dispatch', 'budget', 'different-error'] as const)('does not offer legacy failed-task recovery when %s invalidates the evidence', async reason => {
  const f = await fixture()
  const turn = await f.legacyFailure()
  const repo = f.runtime.taskRepository!, task = f.current()
  if (reason === 'model-work') {
    const attempt = repo.execution.latestAttempt(task.id)!
    repo.execution.beginWork('model-was-invoked', task.id, 'model', Date.now(), attempt.executionId)
    repo.execution.finishWork('model-was-invoked', Date.now())
  } else if (reason === 'unknown-effect' || reason === 'known-dispatch') {
    repo.beginOperation({ ownerId: task.id, idempotencyKey: 'unknown', kind: 'tool', request: { toolName: 'write', turnId: turn.turnId }, nowIso: f.runtime.nowIso() })
    repo.finishOperation(task.id, 'unknown', { status: reason === 'unknown-effect' ? 'outcome_unknown' : 'succeeded' }, f.runtime.nowIso())
  } else if (reason === 'budget') {
    repo.execution.beginWork('prior-exhaustion', task.id, 'model', Date.now() - task.budget.maxExecutionMs!, 'prior-attempt')
    repo.execution.finishWork('prior-exhaustion', Date.now())
  } else {
    repo.update(task.id, task.revision, value => ({ ...value, nodes: value.nodes.map(node => ({ ...node, progressFingerprint: 'max_tokens' })) }))
  }
  const snap = await f.snapshot()
  expect(snap).toMatchObject({ recoveryEligible: false, canRestoreBase: false, canConfirm: false })
  expect((await f.api(`/v1/tasks/${task.id}/permissions`, 'DELETE', { expectedRevision: snap.taskRevision, permissionId: snap.grant!.id, idempotencyKey: 'no-bypass', restoreBase: true })).status).toBe(409)
  expect(f.current().status).toBe('failed')
  expect(f.requests()).toBe(0)
})

it('does not weaken terminal transitions or accept a forged repair event without its prepared permission receipt', async () => {
  const f = await fixture()
  await f.legacyFailure()
  const repo = f.runtime.taskRepository!, task = f.current()
  const grant = task.authority!.taskApprovalGrant!
  expect(() => repo.update(task.id, task.revision, value => ({ ...value, status: 'paused' }))).toThrow('terminal task cannot transition')
  expect(() => repo.update(task.id, task.revision, value => ({ ...value, status: 'paused' }), { key: 'forged', kind: 'task_permission_confirmed', payload: { permissionId: grant.id }, createdAt: f.runtime.nowIso() })).toThrow('terminal task cannot transition')
  expect(f.current().revision).toBe(task.revision)
})

it('fences stale restoration requests and does not revive a paused task after a concurrent scope change', async () => {
  const f = await fixture()
  f.expire()
  const task = f.current(), grant = task.authority!.taskApprovalGrant!
  const request = { expectedRevision: task.revision, permissionId: grant.id, idempotencyKey: 'restore-stale', restoreBase: true }
  f.runtime.taskRepository!.update(task.id, task.revision, value => ({ ...value, waitingReason: 'Synthetic newer user decision' }))
  expect((await f.api(`/v1/tasks/${task.id}/permissions`, 'DELETE', request)).status).toBe(409)
  expect(f.current().authority?.taskApprovalGrant).toEqual(grant)
  expect(f.current().status).toBe('paused')
  expect(f.requests()).toBe(0)
})
