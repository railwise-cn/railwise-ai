import { BrowserScheduleActionAuthority } from '../src/services/browser-schedule-action-authority.js'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { CapabilityPreflightSchema } from '../src/contracts/harness.js'
import { makeAssistantTextItem, makeToolResultItem } from '../src/domain/item.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'
import { saveTaskPublicQueryAction } from '../src/services/browser-public-query-authority.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function fixture() {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-browser-block-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const network = vi.fn(() => { throw new Error('Synthetic permission replay forbids external calls') })
  vi.stubGlobal('fetch', network)
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'synthetic-browser-block',
    apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic-no-model', tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}), approvalPolicy: 'auto' as const, sandboxMode: 'read-only' as const }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => runtime.shutdown?.())
  const origin = await runtime.threadService.create({ title: '原始浏览器任务', workspace, mode: 'agent', model: 'synthetic-no-model' })
  const worker = await runtime.threadService.create({ title: '内部执行', workspace, mode: 'agent', model: 'synthetic-no-model' })
  const prompt = '使用 BrowserSkill 读取 https://example.test 的信息。'
  const turn = await runtime.turnService.startTurn({ threadId: worker.id,
    request: { prompt, taskIntent: 'new', taskVisibility: 'task', taskOriginThreadId: origin.id } })
  const task = runtime.taskRepository!.findByTurn(turn.turnId)!
  runtime.taskController!.beginAttempt(worker.id, turn.turnId)
  async function toolFailure(code: string, turnId = turn.turnId) {
    await runtime.sessionStore.appendItem(worker.id, makeToolResultItem({ id: `browser-block-${code}`, threadId: worker.id,
      turnId, callId: 'browser-call', toolName: 'browser_interact', isError: true, output: { code } }))
  }
  async function restart() {
    await runtime.turnService.finishTurn({ threadId: worker.id, turnId: turn.turnId, status: 'completed' })
    runtime.taskController!.endRun(turn.turnId)
    await runtime.shutdown?.()
    runtime = await createKunServeRuntime(options)
  }
  return { get runtime() { return runtime }, origin, worker, turn, task, prompt, workspace, network, toolFailure, restart }
}

it.each(['browser_interaction_scope_required', 'browser_binding_changed'])('persists and replays one actionable %s browser card through real Runtime stores', async code => {
  const f = await fixture()
  await f.toolFailure(code)
  await f.runtime.sessionStore.appendItem(f.worker.id, makeAssistantTextItem({ id: 'explanation', threadId: f.worker.id,
    turnId: f.turn.turnId, text: '请确认浏览器范围后继续。', status: 'completed' }))
  expect(await f.runtime.taskController!.assessCandidate(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  const taskRevision = f.runtime.taskRepository!.get(f.task.id)!.revision
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  expect(f.runtime.taskRepository!.get(f.task.id)!.revision).toBe(taskRevision)
  const attention = f.runtime.taskRepository!.inbox(f.workspace).filter(item => item.taskId === f.task.id)
  expect(attention).toHaveLength(1)
  const capability = CapabilityPreflightSchema.parse(attention[0]!.payload!.capability)
  const action = { kind: 'grant', route: 'task/browser-binding', label: '确认当前任务的浏览器范围' }
  expect(capability).toMatchObject({ provider: 'browser-skill', status: 'needs_authorization', errorCode: code,
    approvalState: 'required', action, resolution: action })
  expect(f.runtime.taskRepository!.connection().prepare("SELECT COUNT(*) AS count FROM runtime_outbox WHERE kind='task_command_message'").get()).toEqual({ count: 1 })
  await f.runtime.taskCoordinator!.flushCommandMessages()
  await f.runtime.taskCoordinator!.flushCommandMessages()
  const history = await f.runtime.sessionStore.loadItems(f.origin.id)
  const cards = history.filter(item => item.kind === 'assistant_text' && item.capabilityCard)
  expect(cards).toMatchObject([{ capabilityCard: { threadId: f.origin.id, taskId: f.task.id,
    attentionId: attention[0]!.id, prompt: f.prompt, capability: { provider: 'browser-skill', errorCode: code } } }])
  expect(history.filter(item => item.kind === 'user_message')).toHaveLength(0)
  expect(f.runtime.taskRepository!.events(f.task.id).filter(event => event.kind === 'task_waiting_user')).toHaveLength(1)
  await f.restart()
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).toBe('waiting_user')
  expect(f.runtime.taskRepository!.latestCheckpoint(f.task.id)?.resumeSummary).toBe(capability.message)
  expect(f.runtime.taskRepository!.inbox(f.workspace).filter(item => item.taskId === f.task.id)).toHaveLength(1)
  expect((await f.runtime.sessionStore.loadItems(f.origin.id)).filter(item => item.kind === 'assistant_text' && item.capabilityCard)).toHaveLength(1)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})

it('creates the browser scope card when a model failure leaves no final explanatory reply', async () => {
  const f = await fixture()
  await f.toolFailure('browser_interaction_scope_required')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  await f.runtime.taskCoordinator!.flushCommandMessages()
  const history = await f.runtime.sessionStore.loadItems(f.origin.id)
  expect(history.filter(item => item.kind === 'assistant_text' && item.capabilityCard)).toMatchObject([
    { capabilityCard: { taskId: f.task.id, capability: { provider: 'browser-skill', status: 'needs_authorization',
      errorCode: 'browser_interaction_scope_required', resolution: { route: 'task/browser-binding' } } } }
  ])
  expect(f.runtime.taskRepository!.get(f.task.id)).toMatchObject({ status: 'waiting_user', goal: f.prompt })
  expect(f.network).not.toHaveBeenCalled()
})

it('keeps a new periodic source scope requirement on the original task without inventing a Flow', async () => {
  const f = await fixture()
  await f.toolFailure('browser_schedule_action_scope_required')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  const attention = f.runtime.taskRepository!.attention(`capability_${f.task.id}`)!
  expect(attention).toMatchObject({ payload: { capability: { provider: 'schedule', errorCode: 'browser_schedule_action_scope_required',
    resolution: { kind: 'retry', route: 'task/schedule-review', label: '继续原任务并审阅周期动作' } } } })
  expect(attention.message).toContain('重新观察页面')
  await f.runtime.taskCoordinator!.flushCommandMessages()
  await f.restart()
  expect(f.runtime.taskRepository!.attention(attention.id)).toEqual(attention)
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).toBe('waiting_user')
  expect(f.network).not.toHaveBeenCalled()
})

it('persists a single public-query action review on the original task without inventing an authorization or resuming pause', async () => {
  const f = await fixture()
  await f.toolFailure('browser_public_query_action_required')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  const attention = f.runtime.taskRepository!.attention(`capability_${f.task.id}`)!
  expect(attention).toMatchObject({ payload: { capability: { provider: 'browser-skill', status: 'needs_authorization', errorCode: 'browser_public_query_action_required',
    resolution: { kind: 'retry', route: 'task/browser-action-review', label: '继续原任务并审阅公开查询动作' } } } })
  expect(f.runtime.taskRepository!.operations(f.task.id, 'browser_action_authorization')).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(f.task.id, 'browser_action_dispatch')).toHaveLength(0)
  const waiting = f.runtime.taskRepository!.get(f.task.id)!
  const paused = f.runtime.taskController!.pauseTask(waiting.id, waiting.revision, '用户明确暂停')
  await f.runtime.taskCoordinator!.flushCommandMessages()
  expect(f.runtime.taskRepository!.get(f.task.id)).toEqual(paused)
  expect(f.runtime.approvalGate.pending()).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})

async function singleActionLedger(scenario: 'matching' | 'different-target' | 'old-policy' | 'revoked' | 'expired' | 'unknown') {
  const f = await fixture()
  const repository = f.runtime.taskRepository!
  const initial = repository.get(f.task.id)!
  const browserScope = { browserInstanceId: 'reviewed-browser', revision: 1, interaction: 'interact' as const,
    origins: ['https://example.test'], verificationPolicy: 'public_query_target' as const }
  const task = repository.update(initial.id, initial.revision, current => ({ ...current,
    authority: { source: 'user', workspaceRoot: f.workspace, externalTargets: [], grantedAt: f.runtime.nowIso(), browserScope } }))
  const target = { action: 'fill' as const, pageUrl: 'https://example.test/search', elementHash: 'a'.repeat(64), valueHash: 'b'.repeat(64),
    browserInstanceId: browserScope.browserInstanceId, browserRevision: browserScope.revision, verificationPolicy: browserScope.verificationPolicy }
  repository.beginOperation({ ownerId: task.id, idempotencyKey: `tool:${f.turn.turnId}:single-missing`, kind: 'tool',
    request: { toolName: 'browser_fill', turnId: f.turn.turnId, argumentsHash: 'c'.repeat(64) }, nowIso: f.runtime.nowIso() })
  repository.finishOperation(task.id, `tool:${f.turn.turnId}:single-missing`, { status: 'failed' })
  repository.beginOperation({ ownerId: task.id, idempotencyKey: 'single-scope-request', kind: 'browser_action_scope_request',
    request: { ...target, toolName: 'browser_fill', turnId: f.turn.turnId, argumentsHash: 'c'.repeat(64) }, nowIso: f.runtime.nowIso() })
  repository.finishOperation(task.id, 'single-scope-request', { status: 'succeeded' })
  await f.runtime.sessionStore.appendItem(f.worker.id, makeToolResultItem({ id: 'single-missing', threadId: f.worker.id, turnId: f.turn.turnId,
    callId: 'single-missing', toolName: 'browser_fill', isError: true, output: { code: 'browser_public_query_action_required' } }))
  const actual = { ...target, ...(scenario === 'different-target' ? { elementHash: 'd'.repeat(64) } : {}) }
  const { verificationPolicy: _policy, ...legacy } = actual
  const authorization = repository.beginOperation({ ownerId: task.id, idempotencyKey: 'single-authorization', kind: 'browser_action_authorization',
    request: scenario === 'old-policy' ? legacy : actual, nowIso: f.runtime.nowIso() }).receipt
  repository.finishOperation(task.id, 'single-authorization', { status: 'succeeded', result: { approvalId: 'explicit-single-query-review', access: 'public_query',
    expiresAt: new Date(Date.now() + (scenario === 'expired' ? -60_000 : 15 * 60_000)).toISOString(), revoked: scenario === 'revoked' } })
  const dispatch = repository.beginOperation({ ownerId: task.id, idempotencyKey: 'single-dispatch', kind: 'browser_action_dispatch',
    request: { ...actual, authorizationReceiptId: authorization.id, turnId: f.turn.turnId, toolName: 'browser_fill', argumentsHash: 'f'.repeat(64), dependsOn: ['@e1'] }, nowIso: f.runtime.nowIso() }).receipt
  repository.finishOperation(task.id, 'single-dispatch', { status: scenario === 'unknown' ? 'outcome_unknown' : 'succeeded',
    result: { actionAcknowledged: true, readbackPending: false, resultHash: 'e'.repeat(64) } })
  repository.beginOperation({ ownerId: task.id, idempotencyKey: `tool:${f.turn.turnId}:single-later`, kind: 'tool',
    request: { toolName: 'browser_fill', turnId: f.turn.turnId, callId: 'single-later', argumentsHash: 'f'.repeat(64) }, nowIso: f.runtime.nowIso() })
  repository.finishOperation(task.id, `tool:${f.turn.turnId}:single-later`, { status: scenario === 'unknown' ? 'outcome_unknown' : 'succeeded' })
  await f.runtime.sessionStore.appendItem(f.worker.id, makeToolResultItem({ id: 'single-later', threadId: f.worker.id, turnId: f.turn.turnId,
    callId: 'single-later', toolName: 'browser_fill', isError: scenario === 'unknown', output: { dispatchReceiptId: dispatch.id, resultHash: 'e'.repeat(64) } }))
  return f
}

it('clears the earlier single public-query scope blocker only after matching task authorization, dispatch and readback in the same Turn', async () => {
  const f = await singleActionLedger('matching')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toBeNull()
  expect(f.runtime.taskRepository!.attention(`capability_${f.task.id}`)).toBeNull()
  expect(f.runtime.taskRepository!.operations(f.task.id, 'browser_schedule_action_authorization')).toHaveLength(0)
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).toBe('running')
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['different-target', 'old-policy', 'revoked', 'expired'] as const)('does not clear the single public-query blocker for %s authorization or dispatch evidence', async scenario => {
  const f = await singleActionLedger(scenario)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  expect(f.runtime.taskRepository!.attention(`capability_${f.task.id}`)).toMatchObject({ status: 'pending', payload: { capability: { errorCode: 'browser_public_query_action_required' } } })
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).not.toBe('completed')
  expect(f.network).not.toHaveBeenCalled()
})

it('prioritizes verification of a persisted unknown operation over offering another public-query authorization', async () => {
  const f = await singleActionLedger('unknown')
  const before = JSON.stringify(f.runtime.taskRepository!.operations(f.task.id))
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'stalled' })
  expect(f.runtime.taskRepository!.attention(`unknown_${f.task.id}`)).toMatchObject({ status: 'pending', title: '核实上次操作结果' })
  expect(f.runtime.taskRepository!.attention(`capability_${f.task.id}`)).toBeNull()
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).toBe('stalled')
  expect(JSON.stringify(f.runtime.taskRepository!.operations(f.task.id))).toBe(before)
  expect(f.network).not.toHaveBeenCalled()
})

type ScopedCompletionScenario = 'matching' | 'authorization-only' | 'different-target' | 'different-input' | 'different-browser' | 'old-policy' | 'old-grant' | 'readback-pending' | 'unknown' | 'missing-tool-output' | 'unverified-evidence' | 'revoked'
async function scopedCompletionLedger(scenario: ScopedCompletionScenario, code = 'browser_public_query_action_required') {
  const f = await fixture(), repository = f.runtime.taskRepository!, now = f.runtime.nowIso()
  const initial = repository.get(f.task.id)!, duration = code === 'browser_schedule_action_scope_required' ? 'schedule' as const : 'task' as const
  const schedule = { kind: 'daily' as const, times: ['09:00'], timezone: 'Asia/Shanghai' }
  const scope = { browserInstanceId: 'reviewed-browser', revision: 1, interaction: 'interact' as const,
    origins: ['https://example.test'], verificationPolicy: 'public_query_target' as const }
  const binding = repository.beginOperation({ ownerId: initial.id, idempotencyKey: 'task-scope-binding', kind: 'browser_binding',
    request: { confirmed: true, publicQueryAuthorization: duration, expectedTaskRevision: initial.revision, expectedBrowserRevision: scope.revision,
      browserInstanceId: scope.browserInstanceId, origins: scope.origins, interaction: scope.interaction, verificationPolicy: scope.verificationPolicy }, nowIso: now }).receipt
  const browserScope = { ...scope, publicQueryAuthorization: { receiptId: binding.id, duration, purposeHash: operationFingerprint({ purpose: initial.goal }),
    ...(duration === 'schedule' ? { requirementHash: operationFingerprint({ requirement: schedule }) } : {}) } }
  repository.finishOperation(initial.id, binding.idempotencyKey, { status: 'succeeded', result: { taskId: initial.id, purpose: initial.goal,
    browserInstanceId: scope.browserInstanceId, browserRevision: scope.revision, origins: scope.origins, interaction: scope.interaction,
    verificationPolicy: scope.verificationPolicy, publicQueryAuthorization: browserScope.publicQueryAuthorization } })
  const task = repository.update(initial.id, initial.revision, current => ({ ...current,
    acceptance: { ...current.acceptance, ...(duration === 'schedule' ? { schedule } : {}) },
    authority: { source: 'user', workspaceRoot: f.workspace, externalTargets: [], grantedAt: now, browserScope } }))
  const currentGrant = ExecutionGrantSchema.parse({ id: 'current-turn-grant', taskId: task.id, threadId: f.worker.id, turnId: f.turn.turnId,
    workspaceRoot: f.workspace, workspaceTrust: 'read-only', agentTrust: 'read-only', approvalPolicy: 'on-request', sandboxMode: 'read-only',
    workspaceRevision: 0, agentRevision: 0, revision: task.revision, idempotencyKey: 'current-turn-grant', issuedAt: now, browserScope })
  await f.runtime.turnService.updateTurnMetadata(f.worker.id, f.turn.turnId, { executionGrant: currentGrant })
  const target = { action: 'fill' as const, pageUrl: 'https://example.test/search', elementHash: 'a'.repeat(64), valueHash: 'b'.repeat(64),
    browserInstanceId: scope.browserInstanceId, browserRevision: scope.revision, verificationPolicy: scope.verificationPolicy }
  const deniedKey = `tool:${f.turn.turnId}:scoped-missing`
  repository.beginOperation({ ownerId: task.id, idempotencyKey: deniedKey, kind: 'tool', request: {
    toolName: 'browser_fill', turnId: f.turn.turnId, argumentsHash: 'c'.repeat(64), executionGrant: currentGrant }, nowIso: now })
  repository.finishOperation(task.id, deniedKey, { status: 'failed' })
  repository.beginOperation({ ownerId: task.id, idempotencyKey: 'scoped-request', kind: 'browser_action_scope_request', request: {
    ...target, ...(scenario === 'old-policy' ? { verificationPolicy: 'strict' } : {}), toolName: 'browser_fill', turnId: f.turn.turnId, argumentsHash: 'c'.repeat(64) }, nowIso: now })
  repository.finishOperation(task.id, 'scoped-request', { status: 'succeeded' })
  await f.runtime.sessionStore.appendItem(f.worker.id, makeToolResultItem({ id: 'scoped-missing', threadId: f.worker.id, turnId: f.turn.turnId,
    callId: 'scoped-missing', toolName: 'browser_fill', isError: true, output: { code } }))
  const grant = scenario === 'old-grant' ? { ...currentGrant, id: 'different-grant', idempotencyKey: 'different-grant' } : currentGrant
  const actual = { ...target, ...(scenario === 'different-target' ? { elementHash: 'd'.repeat(64) } : {}),
    ...(scenario === 'different-input' ? { valueHash: 'd'.repeat(64) } : {}), ...(scenario === 'different-browser' ? { browserInstanceId: 'different-browser' } : {}) }
  const approved = saveTaskPublicQueryAction(repository, grant, { ...actual, taskId: task.id, sessionId: 'synthetic-session', origin: scope.origins[0]! }, 'fresh-context', 'search_input', '已审任务范围中的公开查询')!
  expect(approved).toBeTruthy()
  expect(repository.operations(task.id, 'browser_action_authorization')).toHaveLength(0)
  expect(repository.operations(task.id, 'browser_schedule_action_authorization')).toHaveLength(0)
  if (scenario === 'authorization-only') return f
  const dispatch = repository.beginOperation({ ownerId: task.id, idempotencyKey: 'scoped-dispatch', kind: 'browser_action_dispatch', request: {
    ...approved.receipt.request, scopeActionReceiptId: approved.receipt.id, authorizationSource: 'task_scope', toolName: 'browser_fill', argumentsHash: 'f'.repeat(64) }, nowIso: now }).receipt
  repository.finishOperation(task.id, dispatch.idempotencyKey, { status: scenario === 'unknown' ? 'outcome_unknown' : 'succeeded', result: {
    actionAcknowledged: true, readbackPending: scenario === 'readback-pending', sourceUrl: target.pageUrl, resultHash: 'e'.repeat(64) } })
  const resultItem = makeToolResultItem({ id: 'scoped-later', threadId: f.worker.id, turnId: f.turn.turnId,
    callId: 'scoped-later', toolName: 'browser_fill', isError: scenario === 'unknown', output: { status: 'succeeded', provider: 'browser-skill',
      dispatchReceiptId: dispatch.id, sourceUrl: target.pageUrl, resultHash: 'e'.repeat(64), evidence: { kind: 'browser_observation',
        sourceUrl: target.pageUrl, resultHash: 'e'.repeat(64), verified: scenario !== 'unverified-evidence', contentRead: true, actionAcknowledged: true } } })
  const actualKey = `tool:${f.turn.turnId}:scoped-later`
  repository.beginOperation({ ownerId: task.id, idempotencyKey: actualKey, kind: 'tool', request: { toolName: 'browser_fill',
    providerId: 'browser-skill', turnId: f.turn.turnId, callId: 'scoped-later', argumentsHash: 'f'.repeat(64), executionGrant: grant }, nowIso: now })
  repository.finishOperation(task.id, actualKey, { status: scenario === 'unknown' ? 'outcome_unknown' : 'succeeded',
    ...(scenario === 'missing-tool-output' ? {} : { result: { approved: true, item: resultItem } }) })
  await f.runtime.sessionStore.appendItem(f.worker.id, resultItem)
  if (scenario === 'revoked') repository.update(task.id, task.revision, current => ({ ...current, authority: { ...current.authority!, revokedAt: now } }))
  return f
}

it.each(['browser_public_query_action_required', 'browser_schedule_action_scope_required'])('clears %s only after a matching scope-backed action has actually succeeded and read back in this Turn', async code => {
  const f = await scopedCompletionLedger('matching', code)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toBeNull()
  expect(f.runtime.taskRepository!.attention(`capability_${f.task.id}`)).toBeNull()
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).toBe('running')
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['authorization-only', 'different-target', 'different-input', 'different-browser', 'old-policy', 'old-grant', 'readback-pending', 'missing-tool-output', 'unverified-evidence', 'revoked'] as const)('retains scope-required after %s scope-backed evidence', async scenario => {
  const f = await scopedCompletionLedger(scenario)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).not.toBe('completed')
  expect(f.network).not.toHaveBeenCalled()
})

it('never resolves scope-required using a scope-backed unknown action', async () => {
  const f = await scopedCompletionLedger('unknown')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'stalled' })
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['browser_schedule_authority_changed', 'browser_schedule_action_scope_changed', 'browser_schedule_action_scope_required', 'browser_schedule_outcome_unknown'])('persists one actionable %s plan blocker without waking a paused task', async code => {
  const f = await fixture()
  const current = f.runtime.taskRepository!.get(f.task.id)!
  f.runtime.taskRepository!.update(current.id, current.revision, task => ({ ...task, scheduledBy: { scheduleId: 'schedule-source', dueAt: '2026-11-13T01:00:00.000Z' } }))
  await f.toolFailure(code)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  await f.runtime.taskCoordinator!.flushCommandMessages()
  const attention = f.runtime.taskRepository!.attention(`capability_${f.task.id}`)!
  expect(attention).toMatchObject({ status: 'pending', payload: { capability: { provider: 'schedule', status: 'blocked', errorCode: code,
    resolution: { kind: 'grant', route: 'flow/schedule-source', label: '查看并核对定时计划' } } } })
  if (code === 'browser_schedule_outcome_unknown') expect(attention.message).toContain('结果待核实')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  expect(f.runtime.taskRepository!.attention(attention.id)).toEqual(attention)
  const waiting = f.runtime.taskRepository!.get(f.task.id)!
  const paused = f.runtime.taskController!.pauseTask(waiting.id, waiting.revision, '用户暂停周期任务')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ task: { status: 'paused' } })
  expect(f.runtime.taskRepository!.get(f.task.id)).toEqual(paused)
  expect((await f.runtime.sessionStore.loadItems(f.origin.id)).filter(item => item.kind === 'assistant_text' && item.capabilityCard)).toHaveLength(1)
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['browser_interaction_scope_required', 'browser_binding_changed'])('keeps a paused task paused when a late %s result is assessed', async code => {
  const f = await fixture()
  const current = f.runtime.taskRepository!.get(f.task.id)!
  const paused = f.runtime.taskController!.pauseTask(current.id, current.revision, '用户明确暂停')
  await f.toolFailure(code)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user', task: { status: 'paused' } })
  expect(await f.runtime.taskController!.assessCandidate(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user', task: { status: 'paused' } })
  expect(f.runtime.taskRepository!.get(f.task.id)).toEqual(paused)
  expect(f.runtime.taskRepository!.inbox(f.workspace)).toHaveLength(0)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})

it('ignores an old Turn browser block when assessing the current execution', async () => {
  const f = await fixture()
  await f.toolFailure('browser_binding_changed', 'previous-turn')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toBeNull()
  expect(f.runtime.taskRepository!.inbox(f.workspace)).toHaveLength(0)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['browser_interaction_scope_required', 'browser_binding_changed'])('keeps a cancelled task terminal after a late %s result', async code => {
  const f = await fixture()
  const current = f.runtime.taskRepository!.get(f.task.id)!
  const cancelled = f.runtime.taskController!.cancelTask(current.id, current.revision, '用户已取消')
  await f.toolFailure(code)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toBeNull()
  expect(f.runtime.taskController!.recordAttemptFailure(f.worker.id, f.turn.turnId, code, '迟到错误')).toBeNull()
  await expect(f.runtime.taskController!.assessCandidate(f.worker.id, f.turn.turnId)).rejects.toMatchObject({ code: 'not_found' })
  expect(f.runtime.taskRepository!.get(f.task.id)).toEqual(cancelled)
  expect(f.runtime.taskRepository!.inbox(f.workspace)).toHaveLength(0)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})


it.each(['different-target', 'failed', 'unknown', 'revoked'])('retains a missing periodic scope blocker after %s evidence in the same Turn', async scenario => {
  const f = await fixture()
  const repository = f.runtime.taskRepository!
  const initial = repository.get(f.task.id)!
  const browserScope = { browserInstanceId: 'reviewed-browser', revision: 1, interaction: 'interact' as const, origins: ['https://example.test'] }
  const task = repository.update(initial.id, initial.revision, current => ({ ...current,
    acceptance: { ...current.acceptance, schedule: { kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' } },
    authority: { source: 'user', workspaceRoot: f.workspace, externalTargets: [], grantedAt: f.runtime.nowIso(), browserScope } }))
  const target = { action: 'fill' as const, pageUrl: 'https://example.test/search', elementHash: 'a'.repeat(64), valueHash: 'b'.repeat(64),
    browserInstanceId: browserScope.browserInstanceId, browserRevision: browserScope.revision }
  repository.beginOperation({ ownerId: task.id, idempotencyKey: `tool:${f.turn.turnId}:missing`, kind: 'tool',
    request: { toolName: 'browser_fill', argumentsHash: 'c'.repeat(64) }, nowIso: f.runtime.nowIso() })
  repository.finishOperation(task.id, `tool:${f.turn.turnId}:missing`, { status: 'failed' })
  repository.beginOperation({ ownerId: task.id, idempotencyKey: 'scope-request', kind: 'browser_action_scope_request',
    request: { ...target, toolName: 'browser_fill', turnId: f.turn.turnId, argumentsHash: 'c'.repeat(64) }, nowIso: f.runtime.nowIso() })
  repository.finishOperation(task.id, 'scope-request', { status: 'succeeded' })
  await f.runtime.sessionStore.appendItem(f.worker.id, makeToolResultItem({ id: 'missing', threadId: f.worker.id, turnId: f.turn.turnId,
    callId: 'missing', toolName: 'browser_fill', isError: true, output: { code: 'browser_schedule_action_scope_required' } }))
  const authority = new BrowserScheduleActionAuthority({ repository })
  const actual = { ...target, ...(scenario === 'different-target' ? { elementHash: 'd'.repeat(64) } : {}) }
  const approved = authority.save(authority.prepare(task.id, browserScope, actual), 'explicit-review', 'trusted synthetic review')
  const journal = repository.beginOperation({ ownerId: task.id, idempotencyKey: 'later-dispatch', kind: 'browser_action_dispatch',
    request: { ...actual, scheduleActionId: approved.id, turnId: f.turn.turnId, argumentsHash: 'f'.repeat(64) }, nowIso: f.runtime.nowIso() }).receipt
  repository.finishOperation(task.id, 'later-dispatch', { status: scenario === 'failed' ? 'failed' : 'succeeded', result: { resultHash: 'e'.repeat(64) } })
  repository.beginOperation({ ownerId: task.id, idempotencyKey: `tool:${f.turn.turnId}:later`, kind: 'tool',
    request: { toolName: 'browser_fill', argumentsHash: 'f'.repeat(64) }, nowIso: f.runtime.nowIso() })
  repository.finishOperation(task.id, `tool:${f.turn.turnId}:later`, { status: scenario === 'failed' ? 'failed' : 'succeeded' })
  await f.runtime.sessionStore.appendItem(f.worker.id, makeToolResultItem({ id: 'later', threadId: f.worker.id, turnId: f.turn.turnId,
    callId: 'later', toolName: 'browser_fill', isError: scenario === 'failed', output: { dispatchReceiptId: journal.id, resultHash: 'e'.repeat(64) } }))
  if (scenario === 'unknown') {
    repository.beginOperation({ ownerId: task.id, idempotencyKey: 'unknown', kind: 'browser_schedule_action_outcome', request: { scheduleId: `schedule_${task.id}` }, nowIso: f.runtime.nowIso() })
    repository.finishOperation(task.id, 'unknown', { status: 'outcome_unknown' })
  }
  if (scenario === 'revoked') repository.update(task.id, task.revision, current => ({ ...current, authority: { ...current.authority!, revokedAt: f.runtime.nowIso() } }))
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  expect(repository.attention(`capability_${task.id}`)).toMatchObject({ status: 'pending', payload: { capability: { errorCode: 'browser_schedule_action_scope_required' } } })
  expect(f.network).not.toHaveBeenCalled()
})
