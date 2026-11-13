import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import type { BrowserVerificationResult } from '../src/services/browser-operation-verification.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import type { ExecutionGrant } from '../src/contracts/permissions.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'

const page = vi.hoisted(() => ({ session: false, url: 'about:blank', writes: 0, reads: 0, stopped: 0, context: 0,
  htmlChanged: false, targetChanged: false, lastFill: {} as Record<string, unknown> }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.7', pid: 7,
      browsers: [{ instance_id: 'review-browser', browser_name: 'Chrome', label: '本地合成验收', extension_version: '0.4.0', extension_protocol_version: '1.7' }],
      sessions: page.session ? [{ session_id: 'review-session', browser_instance_id: 'review-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: {} }
    if (args[0] === 'session' && args[1] === 'start') { page.session = true; return { ok: true, output: { session_id: 'review-session', browser_instance_id: 'review-browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') { page.session = false; page.stopped++; return { ok: true, output: { stopped: ['review-session'] } } }
    if (!page.session) return { ok: false, code: 'session_not_found' }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 1, url: page.url, title: '合成公开查询' }] } }
    if (args[0] === 'navigate') { page.url = args[1]!; return { ok: true, output: {} } }
    if (args[0] === 'cooperate') { page.reads++; return { ok: true, output: { context_id: `review-context-${++page.context}`, observation: { text: '@e1 公开关键词输入框。仅供合成公开查询，已填写轨道监测。' } } } }
    if (args[0] === 'get-html') { page.reads++; return { ok: true, output: { tab_id: 1, truncated: false,
      html: args.includes('--ref') ? page.targetChanged ? '<input name="password">' : '<input aria-label="公开关键词">'
        : `<html><title>合成公开查询</title><body>${page.htmlChanged ? '页面已改变' : '公开查询结果'}<input aria-label="公开关键词"></body></html>` } } }
    if (args[0] === 'fill') { page.writes++; return { ok: false, code: 'simulated_lost_ack', outcomeUnknown: true } }
    throw new Error('Unexpected synthetic browser command')
  })
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.useRealTimers(); vi.unstubAllEnvs(); Object.assign(page, { session: false, url: 'about:blank', writes: 0, reads: 0, stopped: 0, context: 0, htmlChanged: false, targetChanged: false, lastFill: {} }) })

async function fixture() {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-browser-review-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '只读 中文 工作区'); await mkdir(workspace)
  let modelCalls = 0
  let hold = false
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    modelCalls++
    if (hold) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting for controlled acceptance shutdown\n\n'); return }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const called = new Set((body.messages ?? []).flatMap((m: { tool_calls?: Array<{ id: string }> }) => m.tool_calls?.map(t => t.id) ?? []))
    const steps = [['start', 'browser_session_start'], ['navigate', 'browser_navigate'], ['authorize', 'browser_authorize_action'], ['fill', 'browser_fill']]
    const next = steps.find(([id]) => !called.has(`review-${id}`))
    let args: Record<string, unknown> = {}
    if (next?.[0] === 'navigate') args = { sessionId: 'review-session', url: 'https://public.example.test/query' }
    if (next?.[0] === 'authorize' || next?.[0] === 'fill') args = { sessionId: 'review-session', contextId: `review-context-${page.context}`,
      target: '@e1', value: '轨道监测', ...(next[0] === 'authorize' ? { action: 'fill', scope: 'schedule', scheduleAccess: 'public_query' } : {}) }
    if (next?.[0] === 'fill') page.lastFill = args
    const delta = next ? { tool_calls: [{ index: 0, id: `review-${next[0]}`, type: 'function', function: { name: next[1], arguments: JSON.stringify(args) } }] }
      : { content: '原公开查询动作结果待核实，未重放。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'review-model', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'review-test', apiKey: 'synthetic-local-only',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions' as const, model: 'review-model',
    approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const, tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready',
      executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64), version: '0.4.0', browserInstanceId: 'review-browser',
      origins: ['https://public.example.test'], interaction: 'interact', revision: 1 } }) }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => runtime.shutdown?.())
  let router = buildRouter(runtime)
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, {
    method, headers: { authorization: 'Bearer review-test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  let restarting = false
  const approvalTimer = setInterval(() => { if (!restarting) for (const approval of runtime.approvalGate.pending()) void api(`/v1/approvals/${approval.id}`, 'POST', { decision: 'allow' }) }, 10)
  cleanup.push(async () => { clearInterval(approvalTimer) })
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'review-model', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'review-source',
    request: { prompt: '使用BrowserSkill读取 https://public.example.test/query ，在公开查询框填写轨道监测，生成HTML报告，每天09:00执行。' } })
  const id = started.task!.id
  await expect.poll(() => runtime.taskRepository!.get(id)?.status, { timeout: 10000 }).toBe('stalled')
  const task = () => runtime.taskRepository!.get(id)!
  const unknown = runtime.taskRepository!.operations(id, 'tool').find(item => item.status === 'outcome_unknown')!
  expect(unknown.request?.toolName).toBe('browser_fill')
  expect(page.writes).toBe(1)
  const verify = async (key = 'review-once') => {
    const response = await api(`/v1/tasks/${id}/receipts/${unknown.id}/verify`, 'POST', { expectedRevision: task().revision, idempotencyKey: key })
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json() as BrowserVerificationResult
    expect(result.errorCode, JSON.stringify(result)).toBeUndefined()
    return result
  }
  const confirm = (review: BrowserVerificationResult, key = 'confirm-once', revision = task().revision) => api(`/v1/tasks/${id}/receipts/${unknown.id}/browser-confirm`, 'POST',
    { expectedRevision: revision, idempotencyKey: key, reviewId: review.browserReview?.id, decision: 'confirmed_complete' })
  const restart = async () => { restarting = true; await runtime.shutdown?.(); runtime = await createKunServeRuntime(options); router = buildRouter(runtime); restarting = false }
  const expireOriginalGrant = async () => {
    // Persistence-boundary fixture: the historical short Turn grant expired;
    // current task/browser authorization remains independently active.
    const receipt = runtime.taskRepository!.operation(id, unknown.idempotencyKey)!
    const grant = { ...(receipt.request!.executionGrant as ExecutionGrant), expiresAt: new Date(Date.now() - 1000).toISOString() }
    const request = { ...receipt.request, executionGrant: grant }
    runtime.taskRepository!.connection().prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?')
      .run(JSON.stringify({ ...receipt, request, fingerprint: operationFingerprint(request) }), id, receipt.idempotencyKey)
    await runtime.turnService.updateTurnMetadata(task().threadId, task().activeTurnId!, { executionGrant: grant })
  }
  return { get runtime() { return runtime }, task, unknown, api, verify, confirm, restart, expireOriginalGrant, modelCalls: () => modelCalls, options, holdModel: () => { hold = true } }
}

it('retains an unknown browser surface across pause/restart, reads without mutation, and requires human confirmation before separate resume', async () => {
  const f = await fixture()
  const id = f.task().id
  await f.api(`/v1/tasks/${id}/pause`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'keep-paused' })
  await f.restart()
  expect(page.session).toBe(true); expect(page.stopped).toBe(0)
  await f.expireOriginalGrant()
  const before = f.modelCalls()
  const list = await (await f.api(`/v1/tasks/${id}/receipts`, 'GET')).json() as Array<{ purpose: string; browser?: { canReview: boolean } }>
  expect(list.find(item => item.purpose === 'browser_action')?.browser?.canReview).toBe(true)
  const review = await f.verify()
  expect(review).toMatchObject({ status: 'outcome_unknown', browserReview: { action: 'fill', value: '轨道监测', pageUrl: 'https://public.example.test/query' } })
  expect(page.reads).toBeGreaterThan(0); expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
  expect(f.task().status).toBe('paused')
  const revision = f.task().revision
  const response = await f.confirm(review)
  expect(response.status, await response.clone().text()).toBe(200)
  const confirmed = await response.json()
  expect(confirmed).toMatchObject({ status: 'verified', evidence: { kind: 'human_confirmation', status: 'public_query_confirmed_by_user' } })
  expect(f.task().status).toBe('paused'); expect(f.modelCalls()).toBe(before); expect(page.writes).toBe(1)
  const repository = f.runtime.taskRepository!
  const original = repository.operations(id, 'tool').find(item => item.id === f.unknown.id)!
  expect(original.status).toBe('outcome_unknown'); expect(repository.verifiedOperationResolution(original)).toBeTruthy()
  expect(repository.operations(id, 'browser_schedule_action_outcome').every(item => repository.verifiedOperationResolution(item))).toBe(true)
  const retry = await f.confirm(review, 'confirm-once', revision)
  expect(retry.status).toBe(200); expect(await retry.json()).toEqual(confirmed)
  f.holdModel()
  const continued = await f.api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'separate-continue' })
  expect(continued.status, await continued.clone().text()).toBe(202)
  const resumedTurnId = (await continued.json() as { turn?: { turnId: string } }).turn?.turnId
  expect(resumedTurnId).toBeTruthy()
  await expect.poll(f.modelCalls, { timeout: 5000 }).toBeGreaterThan(before)
  const replay = f.runtime.taskController!.beginToolOperation(resumedTurnId!, { callId: 'must-not-replay', toolName: 'browser_fill', arguments: page.lastFill })
  expect(replay?.prior).toMatchObject({ item: { output: { recovered: true, evidence: { kind: 'human_confirmation' } } } })
  const thread = (await f.runtime.threadService.get(f.task().threadId))!
  const grant = thread.turns.find(turn => turn.id === resumedTurnId)!.executionGrant!
  const context: ToolHostContext = { threadId: thread.id, turnId: resumedTurnId!, workspace: thread.workspace, executionGrant: grant,
    sandboxMode: grant.sandboxMode, approvalPolicy: grant.approvalPolicy, abortSignal: new AbortController().signal,
    awaitApproval: async () => { throw new Error('A confirmed action must not request another mutation approval') } }
  await f.runtime.toolHost!.execute({ callId: 'fresh-context', toolName: 'browser_observe', arguments: { sessionId: 'review-session' } }, context)
  const logicalReplay = await f.runtime.toolHost!.execute({ callId: 'changed-context-must-not-replay', toolName: 'browser_fill',
    arguments: { ...page.lastFill, contextId: `review-context-${page.context}` } }, context)
  expect(logicalReplay).toMatchObject({ item: { output: { recovered: true, evidence: { kind: 'human_confirmation' } } } })
  expect(page.writes).toBe(1)
}, 30000)

it.each(['expired', 'target', 'page', 'revoked', 'cancelled', 'browser'] as const)('keeps %s review unknown without replay or resumption', async condition => {
  const f = await fixture()
  const review = await f.verify()
  expect(review.browserReview).toBeTruthy()
  const before = f.modelCalls()
  if (condition === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 121000) }
  if (condition === 'target') page.targetChanged = true
  if (condition === 'page') page.htmlChanged = true
  if (condition === 'revoked') f.runtime.taskRepository!.update(f.task().id, f.task().revision, task => ({ ...task, authority: { ...task.authority!, revokedAt: new Date().toISOString() } }))
  if (condition === 'cancelled') await f.api(`/v1/tasks/${f.task().id}/cancel`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'cancel' })
  if (condition === 'browser') f.options.capabilities.browserSkill.browserInstanceId = 'other-browser'
  if (condition === 'browser') await f.restart()
  const response = await f.confirm(review)
  expect(response.status).not.toBe(200)
  const receipt = f.runtime.taskRepository!.operations(f.task().id, 'tool').find(item => item.id === f.unknown.id)!
  expect(receipt.resolution).toBeUndefined()
  expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
}, 20000)

it('isolates receipt reviews, leaves other task/action locks unknown, and rejects concurrent/foreign confirmations', async () => {
  const f = await fixture()
  const repository = f.runtime.taskRepository!
  const taskId = f.task().id
  const locks = []
  for (const other of [{ taskId, turnId: f.unknown.request!.turnId, action: 'click' }, { taskId: 'another-task', turnId: f.unknown.request!.turnId, action: 'fill' }]) {
    const key = `unrelated-${other.taskId}-${other.action}`
    repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'browser_schedule_action_outcome',
      request: { scheduleId: `schedule_${taskId}`, ...other }, nowIso: f.runtime.nowIso() })
    locks.push(repository.finishOperation(taskId, key, { status: 'outcome_unknown' }, f.runtime.nowIso()))
  }
  const review = await f.verify('first-review')
  const secondReview = await f.verify('second-review')
  const foreign = await f.api(`/v1/tasks/another-task/receipts/${f.unknown.id}/browser-confirm`, 'POST', {
    expectedRevision: f.task().revision, idempotencyKey: 'foreign-confirm', reviewId: review.browserReview!.id, decision: 'confirmed_complete' })
  expect(foreign.status).toBe(404)
  const revision = f.task().revision
  const responses = await Promise.all([f.confirm(review, 'first-confirm', revision), f.confirm(secondReview, 'second-confirm', revision)])
  expect(responses.map(result => result.status).sort()).toEqual([200, 409])
  for (const lock of locks) expect(repository.operation(taskId, lock.idempotencyKey)?.resolution).toBeUndefined()
  expect(repository.operations(taskId, 'effect_verification').filter(proof => proof.request?.originalReceiptId === f.unknown.id)).toHaveLength(1)
  expect(page.writes).toBe(1)
}, 20000)
