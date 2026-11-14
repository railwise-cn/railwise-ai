import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import type { BrowserVerificationResult } from '../src/services/browser-operation-verification.js'
import type { OperationReceipt } from '../src/contracts/tasks.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'

// The production Runtime, HTTP boundary, Provider, source permission, ledger and
// recovery service run unchanged. Only the external CLI and model are synthetic.
const page = vi.hoisted(() => ({ session: false, url: 'about:blank', action: 'fill' as 'fill' | 'click',
  context: 0, writes: 0, stopped: 0, changed: false, value: '' }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 7,
      browsers: [{ instance_id: 'scope-review-browser', browser_name: 'Chrome', label: 'Synthetic browser', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: page.session ? [{ session_id: 'scope-review-session', browser_instance_id: 'scope-review-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: {} }
    if (args[0] === 'session' && args[1] === 'start') { page.session = true; return { ok: true, output: { session_id: 'scope-review-session', browser_instance_id: 'scope-review-browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') { page.session = false; page.stopped++; return { ok: true, output: { stopped: ['scope-review-session'] } } }
    if (!page.session) return { ok: false, code: 'session_not_found' }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 1, url: page.url, title: 'Synthetic public search' }] } }
    if (args[0] === 'navigate') { page.url = args[1]!; return { ok: true, output: {} } }
    if (args[0] === 'cooperate') return { ok: true, output: { context_id: `scope-context-${++page.context}`, observation_id: `scope-observation-${page.context}`,
      control_policy: 'target', observation: { text: `@e1 ${page.action === 'fill' ? 'searchbox "关键词" [empty]' : 'button "搜索"'}\nparagraph "公开查询结果"` } } }
    const targetHtml = page.action === 'fill' ? '<input type="search" aria-label="关键词">' : '<button type="submit" class="search-button">搜索</button>'
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 1, truncated: false,
      html: args.includes('--ref') ? targetHtml : `<html><title>公开查询</title><body><p>${page.changed ? '不同的公开结果' : '原公开结果'}</p><form role="search">${targetHtml}</form></body></html>` } }
    if (args[0] === 'read') {
      const fields = JSON.parse(args[args.indexOf('--fields-json') + 1]!) as Array<{ key: string; read: string; attribute?: string }>
      const ref = args.includes('--ref')
      const values = Object.fromEntries(fields.map(field => [field.key, ref
        ? field.read === 'exists' ? true : field.read === 'value' ? page.value : field.read === 'text' ? '搜索' : field.attribute === 'type' ? page.action === 'fill' ? 'search' : 'submit' : field.attribute === 'aria-label' && page.action === 'fill' ? '关键词' : null
        : ['present', 'target', 'searchInput'].includes(field.key) ? true : field.key === 'sensitive' ? false : field.key === 'method' ? 'get' : field.key === 'action' ? '/query' : field.key === 'class' ? 'search-form' : ['trigger', 'triggerLabel'].includes(field.key) ? '搜索' : null]))
      return { ok: true, output: { tab_id: 1, page_url: page.url, frame_url: page.url, frame_id: 'MAIN-FRAME', scope: 'current_dom', truncated: false, items: [{ ref: '@e1', values, redacted: [] }] } }
    }
    if (args[0] === 'fill' || args[0] === 'click') {
      page.writes++; expect(args).toContain('--expect')
      return { ok: false, code: 'synthetic_ack_lost', outcomeUnknown: true }
    }
    throw new Error('Unexpected synthetic CLI command')
  })
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.useRealTimers(); vi.unstubAllEnvs(); Object.assign(page, { session: false, url: 'about:blank', action: 'fill', context: 0, writes: 0, stopped: 0, changed: false, value: '' }) })

async function fixture(action: 'fill' | 'click' = 'fill', duration: 'task' | 'schedule' = 'task') {
  page.action = action
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-task-scope-review-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let modelCalls = 0, hold = false
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    modelCalls++; response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (hold) { response.write(': synthetic model hold\n\n'); return }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const called = new Set((body.messages ?? []).flatMap((message: { tool_calls?: Array<{ id: string }> }) => message.tool_calls?.map(call => call.id) ?? []))
    const next = [['start', 'browser_session_start'], ['navigate', 'browser_navigate'], ['act', `browser_${action}`]].find(([id]) => !called.has(`scope-review-${id}`))
    const args = next?.[0] === 'navigate' ? { sessionId: 'scope-review-session', url: 'https://public.example.test/query' }
      : next?.[0] === 'act' ? { sessionId: 'scope-review-session', contextId: `scope-context-${page.context}`, target: '@e1', ...(action === 'fill' ? { value: '工程测量' } : {}) } : {}
    const delta = next ? { tool_calls: [{ index: 0, id: `scope-review-${next[0]}`, type: 'function', function: { name: next[1], arguments: JSON.stringify(args) } }] } : { content: '等待核验，未重放。' }
    response.end(`data: ${JSON.stringify({ id: 'scope-review-model', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-scope-review', apiKey: 'synthetic-local-only',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions' as const, model: 'scope-review-model',
    approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const },
    capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready', executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64), version: '0.5.0',
      daemonProtocolVersion: '1.9', browserInstanceId: 'scope-review-browser', origins: ['https://public.example.test'], interaction: 'interact', revision: 1,
      browsers: [{ id: 'scope-review-browser', name: 'Chrome', label: 'Synthetic', connected: true, versionSkew: false, extensionVersion: '0.5.0', protocolVersion: '1.9' }] } }) }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => runtime.shutdown?.())
  let router = buildRouter(runtime)
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, { method,
    headers: { authorization: 'Bearer synthetic-scope-review', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: options.model, approvalPolicy: 'on-request' })
  const initial = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'initial', request: {
    prompt: `使用BrowserSkill在 https://public.example.test/query 公开搜索工程测量${duration === 'schedule' ? '，每天09:00执行。' : '。'}` } })
  const id = initial.task!.id, task = () => runtime.taskRepository!.get(id)!
  expect(initial.kind).toBe('capability_required'); expect(modelCalls).toBe(0)
  const preview = await (await api(`/v1/tasks/${id}/browser-binding`, 'GET')).json() as BrowserTaskBindingSnapshot
  const confirmed = await api(`/v1/tasks/${id}/browser-binding`, 'POST', { confirmed: true, expectedTaskRevision: preview.taskRevision,
    expectedBrowserRevision: preview.browserRevision, browserInstanceId: preview.browserInstanceId, origins: preview.origins,
    interaction: 'interact', verificationPolicy: 'public_query_target', publicQueryAuthorization: duration, idempotencyKey: 'bind-scope' })
  expect(confirmed.status, await confirmed.clone().text()).toBe(200); expect(modelCalls).toBe(0)
  const resumed = await api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: task().revision, idempotencyKey: 'start' })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  await expect.poll(() => task().status, { timeout: 10000 }).toBe('stalled')
  const unknown = () => runtime.taskRepository!.operations(id, 'tool').find(receipt => receipt.request?.toolName === `browser_${action}` && receipt.status === 'outcome_unknown')!
  expect(unknown()?.status).toBe('outcome_unknown'); expect(page.writes).toBe(1); expect(runtime.approvalGate.pending()).toHaveLength(0)
  expect(runtime.taskRepository!.operations(id, 'browser_schedule_action_authorization')).toHaveLength(0)
  expect(runtime.taskRepository!.operations(id, 'browser_scope_action_authorization').length).toBeGreaterThan(0)
  const verify = async () => {
    const response = await api(`/v1/tasks/${id}/receipts/${unknown().id}/verify`, 'POST', { expectedRevision: task().revision, idempotencyKey: 'review' })
    expect(response.status, await response.clone().text()).toBe(200)
    return await response.json() as BrowserVerificationResult
  }
  const confirm = (review: BrowserVerificationResult, decision: 'completed' | 'not_completed') => api(`/v1/tasks/${id}/receipts/${unknown().id}/browser-confirm`, 'POST',
    { expectedRevision: task().revision, idempotencyKey: 'confirm', reviewId: review.browserReview!.id, decision })
  const restart = async () => { await runtime.shutdown?.(); runtime = await createKunServeRuntime(options); router = buildRouter(runtime) }
  const alterReceipt = (receipt: OperationReceipt, patch: Partial<OperationReceipt>) => runtime.taskRepository!.connection().prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?')
    .run(JSON.stringify({ ...receipt, ...patch }), receipt.ownerId, receipt.idempotencyKey)
  return { get runtime() { return runtime }, task, unknown, api, verify, confirm, restart, alterReceipt, modelCalls: () => modelCalls, hold: () => { hold = true } }
}

it.each((['fill', 'click'] as const).flatMap(action => (['task', 'schedule'] as const).flatMap(duration => (['completed', 'not_completed'] as const).map(decision => ({ action, duration, decision })))))('recovers $action from $duration task-scope authority with explicit $decision and no fabricated action approval', async ({ action, duration, decision }) => {
  const f = await fixture(action, duration), before = f.modelCalls(), id = f.task().id, original = JSON.stringify(f.unknown())
  const pause = await f.api(`/v1/tasks/${id}/pause`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'pause' })
  expect(pause.status).toBe(200)
  await f.restart()
  const review = await f.verify()
  expect(review.errorCode, JSON.stringify(review)).toBeUndefined()
  expect(review.browserReview).toMatchObject({ action, pageUrl: 'https://public.example.test/query' })
  const result = await f.confirm(review, decision)
  expect(result.status, await result.clone().text()).toBe(200)
  const outcome = decision === 'completed' ? 'succeeded' : 'not_completed'
  expect(await result.json()).toMatchObject({ status: 'verified', outcome, evidence: { kind: 'human_confirmation' } })
  const { resolution, ...originalFields } = f.unknown()
  expect(originalFields).toEqual(JSON.parse(original))
  expect(resolution?.outcome).toBe(outcome)
  expect(f.runtime.taskRepository!.verifiedOperationResolution(f.unknown())?.outcome).toBe(outcome)
  expect(f.runtime.taskRepository!.unsettledOperations(id).filter(receipt => receipt.kind === 'tool')).toHaveLength(0)
  expect(f.task().status).toBe('paused'); expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
  expect(f.runtime.approvalGate.pending()).toHaveLength(0)
  if (decision === 'not_completed') expect(f.runtime.taskRepository!.operations(id, 'effect_verification')).toHaveLength(0)
  await f.restart()
  expect(f.runtime.taskRepository!.verifiedOperationResolution(f.unknown())?.outcome).toBe(outcome)
  f.hold()
  const resumed = await f.api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'separate-continue' })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  await expect.poll(f.modelCalls).toBe(before + 1)
  expect(page.writes).toBe(1)
}, 20000)

it.each(['completed', 'not_completed'] as const)('keeps a valid %s review after later authority revocation and rebind, without changing its historical source', async decision => {
  const f = await fixture('click', 'schedule'), id = f.task().id
  const review = await f.verify()
  expect(review.errorCode).toBeUndefined()
  const response = await f.confirm(review, decision)
  expect(response.status, await response.clone().text()).toBe(200)
  const original = f.unknown(), proof = f.runtime.taskRepository!.verifiedOperationResolution(original)!
  expect(proof.outcome).toBe(decision === 'completed' ? 'succeeded' : 'not_completed')
  const binding = f.runtime.taskRepository!.operations(id, 'browser_binding')[0]!
  const originalBinding = JSON.stringify(binding)
  f.runtime.taskRepository!.update(id, f.task().revision, task => ({ ...task, goal: '另一个未授权的任务目的', authority: {
    ...task.authority!, revokedAt: new Date().toISOString(), browserScope: { ...task.authority!.browserScope!,
      browserInstanceId: 'different-browser', revision: 2, origins: [], interaction: 'observe', publicQueryAuthorization: undefined } } }))
  await f.restart()
  expect(f.runtime.taskRepository!.verifiedOperationResolution(f.unknown())).toEqual(proof)
  expect(JSON.stringify(f.runtime.taskRepository!.operations(id, 'browser_binding')[0])).toBe(originalBinding)
  expect(page.writes).toBe(1)
  expect(f.runtime.approvalGate.pending()).toHaveLength(0)
}, 20000)

it.each((['revoked', 'interaction', 'purpose', 'origin'] as const).flatMap(condition => (['completed', 'not_completed'] as const).map(decision => ({ condition, decision }))))('rejects new $decision proof after current task authority $condition', async ({ condition, decision }) => {
  const f = await fixture(), before = f.modelCalls(), id = f.task().id
  const review = await f.verify()
  expect(review.errorCode).toBeUndefined()
  f.runtime.taskRepository!.update(id, f.task().revision, task => ({ ...task,
    ...(condition === 'purpose' ? { goal: '不同的查询目的' } : {}), authority: { ...task.authority!,
      ...(condition === 'revoked' ? { revokedAt: new Date().toISOString() } : {}),
      browserScope: { ...task.authority!.browserScope!, ...(condition === 'interaction' ? { interaction: 'observe' as const } : {}),
        ...(condition === 'origin' ? { origins: [] } : {}) } } }))
  const response = await f.confirm(review, decision)
  expect(response.status).toBe(409)
  expect(f.unknown().resolution).toBeUndefined()
  expect(f.runtime.taskRepository!.operations(id, 'effect_verification')).toHaveLength(0)
  expect(f.runtime.taskRepository!.operations(id, 'effect_verification_incomplete')).toHaveLength(0)
  expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
  expect(f.runtime.approvalGate.pending()).toHaveLength(0)
}, 20000)

it.each(['missing-binding', 'changed-purpose', 'unbound-result', 'changed-request'] as const)('rejects %s scope action evidence without falling back to a fabricated human approval', async tamper => {
  const f = await fixture(), id = f.task().id, repository = f.runtime.taskRepository!
  const action = repository.operations(id, 'browser_scope_action_authorization')[0]!
  if (tamper === 'missing-binding') {
    const dispatch = repository.operations(id, 'browser_action_dispatch')[0]!
    f.alterReceipt(dispatch, { request: { ...dispatch.request, scopeAuthorizationReceiptId: 'not-a-binding' } })
  }
  if (tamper === 'changed-purpose') {
    const request = { ...action.request, purposeHash: 'f'.repeat(64) }
    f.alterReceipt(action, { request, fingerprint: operationFingerprint(request), result: { ...action.result as Record<string, unknown>, id: operationFingerprint(request) } })
  }
  if (tamper === 'unbound-result') f.alterReceipt(action, { result: { ...action.result as Record<string, unknown>, sourceTaskId: 'another-task' } })
  if (tamper === 'changed-request') f.alterReceipt(action, { request: { ...action.request, elementHash: 'f'.repeat(64) } })
  const review = await f.verify()
  expect(review).toMatchObject({ status: 'outcome_unknown', errorCode: 'browser_review_public_query_scope_missing' })
  expect(review.browserReview).toBeUndefined(); expect(f.unknown().resolution).toBeUndefined()
  expect(repository.operations(id, 'browser_schedule_action_authorization')).toHaveLength(0)
  expect(f.runtime.approvalGate.pending()).toHaveLength(0); expect(page.writes).toBe(1)
}, 20000)

it('separates historical negative-proof reads from current-authority validation when attaching a resolution', async () => {
  const f = await fixture(), id = f.task().id
  const review = await f.verify(), response = await f.confirm(review, 'not_completed')
  expect(response.status, await response.clone().text()).toBe(200)
  const repository = f.runtime.taskRepository!, resolved = f.unknown(), resolution = resolved.resolution!
  // Model a competing caller attaching the existing proof to its still-unresolved
  // copy. Historical validity must not grant it current authority after revocation.
  f.alterReceipt(resolved, { resolution: undefined })
  repository.update(id, f.task().revision, task => ({ ...task, authority: { ...task.authority!, revokedAt: new Date().toISOString() } }))
  expect(repository.verifiedOperationResolution(resolved)?.outcome).toBe('not_completed')
  expect(() => repository.resolveOperation(id, resolved.idempotencyKey, resolution)).toThrow('Current public-query review authority is missing.')
  expect(f.unknown().resolution).toBeUndefined()
  expect(page.writes).toBe(1)
}, 20000)
