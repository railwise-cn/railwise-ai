import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import type { BrowserVerificationResult } from '../src/services/browser-operation-verification.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import type { ExecutionGrant } from '../src/contracts/permissions.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'

const page = vi.hoisted(() => ({ session: false, url: 'about:blank', writes: 0, reads: 0, stopped: 0, context: 0,
  htmlChanged: false, targetChanged: false, acknowledge: false, readbackBroken: false, hiddenHtmlVersion: 0, observationRefVersion: 1, controlValue: '轨道监测',
  largePage: false, emptyObservation: false, emptyPage: false, targetTruncated: false, lastFill: {} as Record<string, unknown>,
  modelCallsAtUnknown: 0, navigations: 0, clickUnknown: false, notSent: false, beforeUnknown: undefined as (() => void) | undefined }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: page.clickUnknown ? '1.9' : '1.7', pid: 7,
      browsers: [{ instance_id: 'review-browser', browser_name: 'Chrome', label: '本地合成验收', extension_version: page.clickUnknown ? '0.5.0' : '0.4.0', extension_protocol_version: page.clickUnknown ? '1.9' : '1.7' }],
      sessions: page.session ? [{ session_id: 'review-session', browser_instance_id: 'review-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: {} }
    if (args[0] === 'session' && args[1] === 'start') { page.session = true; return { ok: true, output: { session_id: 'review-session', browser_instance_id: 'review-browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') { page.session = false; page.stopped++; return { ok: true, output: { stopped: ['review-session'] } } }
    if (!page.session) return { ok: false, code: 'session_not_found' }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 1, url: page.url, title: '合成公开查询' }] } }
    if (args[0] === 'navigate') { page.url = args[1]!; page.navigations++; return { ok: true, output: {} } }
    if (args[0] === 'cooperate' && page.writes && page.readbackBroken) return { ok: false, code: 'readback_temporarily_unavailable' }
    if (args[0] === 'cooperate') {
      page.reads++
      if (page.clickUnknown) { expect(args).toContain('--settle'); expect(args[args.indexOf('--policy') + 1]).toBe('target') }
      else { expect(args).not.toContain('--policy'); expect(args).not.toContain('--settle') }
      return { ok: true, output: { context_id: `review-context-${++page.context}`, ...(page.clickUnknown ? { control_policy: 'target' } : {}),
        observation: { text: page.emptyObservation ? ' ' : page.htmlChanged ? '@e1 查询结果已更新。'
          : page.clickUnknown ? `@e${page.observationRefVersion} button 查询公开公告。仅供合成公开查询。` : `@e${page.observationRefVersion} searchbox "公开关键词输入框" value="${page.controlValue}"，已填写${page.controlValue}。` } } }
    }
    if (args[0] === 'read') {
      expect(page.clickUnknown).toBe(true)
      expect(args[args.indexOf('--ref') + 1]).toBe('@e1')
      const fields = JSON.parse(args[args.indexOf('--fields-json') + 1]!) as Array<{ key: string; read: string; attribute?: string }>
      const values = Object.fromEntries(fields.map(field => [field.key, field.read === 'exists' ? true : field.read === 'text' ? '查询公开公告' : field.attribute === 'aria-label' ? '查询公开公告' : null]))
      return { ok: true, output: { tab_id: 1, page_url: page.url, frame_url: page.url, scope: 'current_dom', truncated: false,
        items: [{ ref: '@e999', values, redacted: [] }] } }
    }
    if (args[0] === 'get-html') { page.reads++; return { ok: true, output: { tab_id: 1, truncated: args.includes('--ref') ? page.targetTruncated : page.largePage,
      html: args.includes('--ref') ? page.targetChanged ? '<input name="password">' : page.clickUnknown ? '<button aria-label="查询公开公告">查询公开公告</button>' : '<input aria-label="公开关键词">'
        : page.emptyPage ? '' : page.largePage ? '<html><head><title>合成公开查询</title><script>' + 'x'.repeat(524000)
          : `<html><title>合成公开查询</title><body data-render="${page.hiddenHtmlVersion}"><!-- build ${page.hiddenHtmlVersion} --><script>window.renderNonce=${page.hiddenHtmlVersion}</script>${page.htmlChanged ? '页面已改变' : '公开查询结果'}<input aria-label="公开关键词"></body></html>`,
      byte_size: page.largePage && !args.includes('--ref') ? 3_283_929 : undefined } } }
    if (args[0] === 'fill') { page.beforeUnknown?.(); page.writes++; return page.acknowledge ? { ok: true, output: { filled: true } } : { ok: false, code: 'simulated_lost_ack', outcomeUnknown: true } }
    if (args[0] === 'click') { expect(args).not.toContain('--depends-on'); expect(JSON.parse(args[args.indexOf('--expect') + 1]!)).toEqual([
      { target: '@e1', field: 'exists', equals: true }, { target: '@e1', field: 'text', equals: '查询公开公告' },
      { target: '@e1', field: 'attribute', attribute: 'aria-label', equals: '查询公开公告' }
    ]); page.beforeUnknown?.(); page.writes++; if (page.notSent) return { ok: false, code: 'permission_denied', outcomeUnknown: false,
      output: { code: 'permission_denied', data: { reason: 'target_covered', effect_state: 'unknown', press_sent: false, phase: 'preparation', operation_id: 'op-fixture' } } }
      return { ok: false, code: 'permission_denied', outcomeUnknown: true,
      vendorReason: 'cooperation_sync_required', effectState: 'unknown', vendorFailureKind: 'observed_content_changed' } }
    throw new Error('Unexpected synthetic browser command')
  })
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.useRealTimers(); vi.unstubAllEnvs(); Object.assign(page, { session: false, url: 'about:blank', writes: 0, reads: 0, stopped: 0, context: 0, htmlChanged: false, targetChanged: false, acknowledge: false, readbackBroken: false, hiddenHtmlVersion: 0, observationRefVersion: 1, controlValue: '轨道监测',
  largePage: false, emptyObservation: false, emptyPage: false, targetTruncated: false, lastFill: {}, modelCallsAtUnknown: 0, navigations: 0, clickUnknown: false, notSent: false, beforeUnknown: undefined }) })

type EscapeTool = 'browser_navigate' | 'browser_session_stop' | 'browser_observe' | 'echo' | 'schedule_task'
async function fixture(mode: 'unknown' | 'ack_pending' = 'unknown', escape?: { tool: EscapeTool; when: 'same_batch' | 'next_model'; action: 'click' | 'fill'; notSent?: boolean }) {
  page.acknowledge = mode === 'ack_pending'; page.readbackBroken = mode === 'ack_pending'
  page.clickUnknown = escape?.action === 'click'
  page.notSent = escape?.notSent === true
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-browser-review-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '只读 中文 工作区'); await mkdir(workspace)
  let modelCalls = 0
  let hold = false
  let holdReadback = false
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    modelCalls++
    if (hold) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting for controlled acceptance shutdown\n\n'); return }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (JSON.stringify(body.messages).includes('independent-control-marker')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'independent-model', choices: [{ index: 0, delta: { content: '独立任务已完成。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    const called = new Set((body.messages ?? []).flatMap((m: { tool_calls?: Array<{ id: string }> }) => m.tool_calls?.map(t => t.id) ?? []))
    const steps = [['start', 'browser_session_start'], ['navigate', 'browser_navigate'], ['authorize', 'browser_authorize_action'], ['fill', page.clickUnknown ? 'browser_click' : 'browser_fill'],
      ...(mode === 'ack_pending' ? [['reuse', 'browser_session_start'], ['read-after-ack', 'browser_observe'], ['artifact', 'publish_artifact']] : []),
      ...(escape?.when === 'next_model' ? [['after-unknown', escape.tool]] : [])]
    const next = mode === 'ack_pending' && page.writes > 0 && page.readbackBroken && !holdReadback ? undefined
      : steps.find(([id]) => !called.has(`review-${id}`))
    if (holdReadback && next?.[0] === 'read-after-ack') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting before explicit cancel\n\n'); return }
    let args: Record<string, unknown> = {}
    if (next?.[0] === 'navigate') args = { sessionId: 'review-session', url: 'https://public.example.test/query' }
    if (next?.[0] === 'authorize' || next?.[0] === 'fill') args = { sessionId: 'review-session', contextId: `review-context-${page.context}`,
      target: '@e1', ...(!page.clickUnknown ? { value: '轨道监测' } : {}), ...(next[0] === 'authorize' ? { action: page.clickUnknown ? 'click' : 'fill', scope: mode === 'ack_pending' ? 'task' : 'schedule', ...(mode === 'unknown' ? { scheduleAccess: 'public_query' } : {}) } : {}) }
    if (next?.[0] === 'read-after-ack') args = { sessionId: 'review-session' }
    if (next?.[0] === 'artifact') args = { path: 'report.html', content: '<!doctype html><html lang="zh-CN"><head><title>回读报告</title></head><body><h1>原查询页面已回读</h1><a href="https://public.example.test/query">来源</a></body></html>' }
    if (next?.[0] === 'fill') page.lastFill = args
    const escapeArgs = escape?.tool === 'browser_navigate' ? { sessionId: 'review-session', url: 'https://public.example.test/left-original' }
      : escape?.tool === 'browser_session_stop' || escape?.tool === 'browser_observe' ? { sessionId: 'review-session' }
        : escape?.tool === 'schedule_task' ? {}
          : { text: 'must-not-run' }
    if (next?.[0] === 'after-unknown') args = escapeArgs
    if (next?.[0] === 'fill') page.modelCallsAtUnknown = modelCalls
    const delta = next ? { tool_calls: [{ index: 0, id: `review-${next[0]}`, type: 'function', function: { name: next[1], arguments: JSON.stringify(args) } },
      ...(next[0] === 'fill' && escape?.when === 'same_batch' ? [{ index: 1, id: 'review-after-unknown', type: 'function', function: { name: escape.tool, arguments: JSON.stringify(escapeArgs) } }] : [])] }
      : { content: mode === 'ack_pending' ? '已只读核对原公开查询页面，HTML报告已保存并交付。' : '原公开查询动作结果待核实，未重放。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'review-model', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'review-test', apiKey: 'synthetic-local-only',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions' as const, model: 'review-model',
    approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const, tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready',
      executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64), version: page.clickUnknown ? '0.5.0' : '0.4.0',
      daemonProtocolVersion: page.clickUnknown ? '1.9' : '1.7',
      browsers: [{ id: 'review-browser', name: 'Chrome', label: '本地合成验收', connected: true, versionSkew: false,
        extensionVersion: page.clickUnknown ? '0.5.0' : '0.4.0', protocolVersion: page.clickUnknown ? '1.9' : '1.7' }], browserInstanceId: 'review-browser',
      origins: ['https://public.example.test'], interaction: 'interact', revision: 1 } }) }
  let runtime = await createKunServeRuntime(options)
  let closed = false
  const closeRuntime = async () => { if (!closed) { closed = true; await runtime.shutdown?.() } }
  cleanup.push(closeRuntime)
  let router = buildRouter(runtime)
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, {
    method, headers: { authorization: 'Bearer review-test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  let restarting = false
  const approvalTimer = setInterval(() => { if (!restarting) for (const approval of runtime.approvalGate.pending()) void api(`/v1/approvals/${approval.id}`, 'POST', { decision: 'allow' }) }, 10)
  cleanup.push(async () => { clearInterval(approvalTimer) })
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'review-model', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'review-source',
    request: { prompt: `使用BrowserSkill读取 https://public.example.test/query ，${page.clickUnknown ? '点击查询公开公告按钮' : '在公开查询框填写轨道监测'}，生成HTML报告${mode === 'unknown' ? '，每天09:00执行。' : '。'}` } })
  const id = started.task!.id
  if (escape && !page.notSent) page.beforeUnknown = () => {
    const task = runtime.taskRepository!.get(id)!
    runtime.taskController!.appendInput(id, task.revision, 'pending-after-unknown', '保留此补充，核验前不要投递模型。')
  }
  expect(started).toMatchObject({ kind: 'capability_required', capability: { errorCode: 'browser_verification_policy_required' } })
  expect(modelCalls).toBe(0)
  expect((await runtime.threadService.get(started.task!.threadId))!.turns).toHaveLength(0)
  const binding = await (await api(`/v1/tasks/${id}/browser-binding`, 'GET')).json() as BrowserTaskBindingSnapshot
  const verificationPolicy = page.clickUnknown ? 'public_query_target' : 'strict'
  const bound = await api(`/v1/tasks/${id}/browser-binding`, 'POST', { expectedTaskRevision: binding.taskRevision,
    expectedBrowserRevision: binding.browserRevision, browserInstanceId: binding.browserInstanceId,
    origins: binding.origins, interaction: 'interact', verificationPolicy, confirmed: true, idempotencyKey: 'review-fixture-explicit-policy' })
  expect(bound.status, await bound.clone().text()).toBe(200)
  expect(await bound.json()).toMatchObject({ resumed: false, binding: { verificationPolicy } })
  expect(modelCalls).toBe(0)
  expect(runtime.taskRepository!.get(id)!.status).toBe('waiting_user')
  const resumed = await api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: runtime.taskRepository!.get(id)!.revision, idempotencyKey: 'review-fixture-explicit-resume' })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  if (page.notSent) await expect.poll(() => runtime.taskRepository!.operations(id, 'tool').find(item => item.request?.callId === 'review-after-unknown')?.status, { timeout: 10000 }).toBe('succeeded')
  else await expect.poll(() => runtime.taskRepository!.get(id)?.status, { timeout: 10000 }).toBe(mode === 'ack_pending' ? 'waiting_user' : 'stalled')
  const task = () => runtime.taskRepository!.get(id)!
  const unknownTool = page.clickUnknown ? 'browser_click' : 'browser_fill'
  const unknown = runtime.taskRepository!.operations(id, 'tool').find(item => item.request?.toolName === unknownTool && item.status === (mode === 'ack_pending' || page.notSent ? 'failed' : 'outcome_unknown'))!
  expect(unknown.request?.toolName).toBe(unknownTool)
  expect(page.writes).toBe(1)
  const verify = async (key = 'review-once') => {
    const response = await api(`/v1/tasks/${id}/receipts/${unknown.id}/verify`, 'POST', { expectedRevision: task().revision, idempotencyKey: key })
    expect(response.status, await response.clone().text()).toBe(200)
    const result = await response.json() as BrowserVerificationResult
    expect(result.errorCode, JSON.stringify(result)).toBeUndefined()
    return result
  }
  const confirm = (review: BrowserVerificationResult, key = 'confirm-once', revision = task().revision, decision = 'confirmed_complete') => api(`/v1/tasks/${id}/receipts/${unknown.id}/browser-confirm`, 'POST',
    { expectedRevision: revision, idempotencyKey: key, reviewId: review.browserReview?.id, decision })
  const restart = async () => { restarting = true; await closeRuntime(); runtime = await createKunServeRuntime(options); closed = false; router = buildRouter(runtime); restarting = false }
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
  const independent = async () => {
    const other = await runtime.threadService.create({ workspace, mode: 'agent', model: 'review-model', approvalPolicy: 'on-request' })
    const started = await runtime.taskCoordinator!.command({ threadId: other.id, intent: 'new', idempotencyKey: 'independent-control',
      request: { prompt: 'independent-control-marker：请只回复已完成，不调用工具。' } })
    await expect.poll(() => runtime.taskRepository!.get(started.task!.id)?.status, { timeout: 10000 }).toBe('completed')
    return started.task!.id
  }
  return { get runtime() { return runtime }, task, unknown, api, verify, confirm, restart, closeRuntime, expireOriginalGrant, independent, modelCalls: () => modelCalls, options, holdModel: () => { hold = true }, holdBeforeReadback: () => { holdReadback = true }, repairReadback: () => { page.readbackBroken = false } }
}

it.each(['same_batch', 'next_model'] as const)('allows %s readonly replanning after the exact CLI proves a public click was not sent, without retry or success evidence', async when => {
  const f = await fixture('unknown', { tool: 'browser_observe', when, action: 'click', notSent: true })
  const repository = f.runtime.taskRepository!, id = f.task().id
  await expect.poll(f.modelCalls).toBeGreaterThan(page.modelCallsAtUnknown)
  expect(f.unknown).toMatchObject({ status: 'failed', result: { item: { isError: true, output: {
    status: 'failed', code: 'browser_action_not_dispatched', effectState: 'unknown', vendorPressSent: false, actionDispatch: 'not_sent' } } } })
  expect(repository.operations(id, 'tool').find(item => item.request?.callId === 'review-after-unknown')).toMatchObject({ status: 'succeeded' })
  expect(repository.operations(id, 'browser_action_dispatch')).toMatchObject([{ status: 'failed', result: { notDispatched: true, vendorPressSent: false } }])
  expect(repository.unsettledOperations(id).filter(item => item.kind === 'tool')).toHaveLength(0)
  expect(repository.operations(id, 'browser_schedule_action_outcome').some(item => item.status === 'outcome_unknown')).toBe(false)
  expect(f.task().resultEvidence ?? []).not.toContainEqual(expect.objectContaining({ provider: 'browser-skill', operation: 'click', verified: true }))
  expect(page.writes).toBe(1) // One CLI click request, explicitly rejected before native input; no retry.
  expect(page.session).toBe(true); expect(page.navigations).toBe(1)
}, 20000)

it.each([
  ...(['click', 'fill'] as const).flatMap(action => (['same_batch', 'next_model'] as const).flatMap(when => (['browser_navigate', 'browser_session_stop', 'echo'] as const).map(tool => ({ when, tool, action })))),
  ...(['same_batch', 'next_model'] as const).map(when => ({ when, tool: 'schedule_task' as const, action: 'click' as const }))
])(
  'fences $when $tool after unknown $action before another model or dispatch, preserving the original surface and pending input', async escape => {
    const f = await fixture('unknown', escape), id = f.task().id
    const repository = f.runtime.taskRepository!
    expect(f.modelCalls()).toBe(page.modelCallsAtUnknown)
    expect(page).toMatchObject({ session: true, url: 'https://public.example.test/query', writes: 1, navigations: 1, stopped: 0 })
    expect(repository.operations(id, 'tool').filter(receipt => receipt.request?.callId === 'review-after-unknown')).toHaveLength(0)
    const original = JSON.stringify(repository.operation(id, f.unknown.idempotencyKey))
    const pending = repository.inputs(id, true).find(input => input.idempotencyKey === 'pending-after-unknown')!
    expect(pending).toMatchObject({ text: '保留此补充，核验前不要投递模型。' })
    expect(pending.deliveredAt).toBeUndefined(); expect(pending.consumedAt).toBeUndefined()
    await expect.poll(async () => (await f.runtime.threadService.get(f.task().threadId))!.turns.at(-1)?.status).toBe('failed')
    expect((await f.runtime.threadService.get(f.task().threadId))!.turns.at(-1)?.error).toContain('outcome_unknown')
    expect(repository.latestCheckpoint(id)?.resumeSummary).toContain('结果尚未核实')
    expect(repository.attention(`unknown_${id}`)).toMatchObject({ status: 'pending', title: '核实上次操作结果' })
    const before = f.modelCalls()
    await f.restart()
    const resumed = await f.api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'must-not-replay-unknown' })
    expect(resumed.status, await resumed.clone().text()).toBe(409)
    expect(f.modelCalls()).toBe(before)
    expect(page).toMatchObject({ session: true, url: 'https://public.example.test/query', writes: 1, navigations: 1, stopped: 0 })
    expect(JSON.stringify(f.runtime.taskRepository!.operation(id, f.unknown.idempotencyKey))).toBe(original)
    expect(f.runtime.taskRepository!.inputs(id, true).find(input => input.id === pending.id)).toEqual(pending)
    const review = await f.verify('read-only-after-fence')
    expect(review.browserReview?.pageUrl).toBe('https://public.example.test/query')
    expect(f.modelCalls()).toBe(before); expect(page.writes).toBe(1)
    await f.independent()
    expect(f.modelCalls()).toBe(before + 1)
    expect(f.task().status).toBe('stalled')
  }, 30000)

it('preserves every original public click receipt field when appending human verification, then permits only a separate continuation', async () => {
  const f = await fixture('unknown', { action: 'click', when: 'next_model', tool: 'echo' })
  const before = f.modelCalls(), id = f.task().id
  const storedReceipt = () => (f.runtime.taskRepository!.connection().prepare('SELECT data_json FROM operation_receipts WHERE owner_id=? AND idempotency_key=?')
    .get(id, f.unknown.idempotencyKey) as { data_json: string }).data_json
  const original = storedReceipt()
  const review = await f.verify('review-original-click')
  expect(review.browserReview?.action).toBe('click')
  const confirmed = await f.confirm(review, 'human-confirm-original-click')
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  expect(f.modelCalls()).toBe(before); expect(page.writes).toBe(1)
  expect(f.task()).toMatchObject({ status: 'waiting_user', waitingReason: '本次公开查询动作已由你核对。任务尚未继续，请单独点击继续。' })
  const { resolution, ...originalFields } = JSON.parse(storedReceipt())
  expect(originalFields).toEqual(JSON.parse(original))
  expect(resolution).toMatchObject({ status: 'verified', evidence: { kind: 'human_confirmation', operation: 'click' } })
  expect(f.runtime.taskRepository!.operation(id, f.unknown.idempotencyKey)).toMatchObject({ status: 'outcome_unknown',
    resolution: { status: 'verified', evidence: { kind: 'human_confirmation', operation: 'click' } } })
  f.holdModel()
  const continued = await f.api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'explicit-continue-after-click-confirmation' })
  expect(continued.status, await continued.clone().text()).toBe(202)
  const turnId = (await continued.json() as { turn: { turnId: string } }).turn.turnId
  await expect.poll(f.modelCalls).toBe(before + 1)
  const delivered = f.runtime.taskRepository!.inputs(id).find(input => input.idempotencyKey === 'pending-after-unknown')!
  expect(delivered.deliveredAt).toBeTruthy(); expect(delivered.consumedAt).toBeTruthy()
  const replay = f.runtime.taskController!.beginToolOperation(turnId, { callId: 'must-not-replay-click', toolName: 'browser_click', arguments: page.lastFill })
  expect(replay?.prior).toMatchObject({ item: { output: { recovered: true, evidence: { kind: 'human_confirmation' } } } })
  expect(page).toMatchObject({ session: true, url: 'https://public.example.test/query', writes: 1, stopped: 0 })
}, 30000)

it.each([false, true])('preserves an ACK-pending original session across Runtime restart, then closes it after readback or cancel (cancel=%s)', async cancel => {
  const f = await fixture('ack_pending')
  const id = f.task().id
  const pending = () => f.runtime.taskRepository!.operations(id, 'browser_action_dispatch')
  expect(pending()).toMatchObject([{ status: 'succeeded', result: { actionAcknowledged: true, readbackPending: true } }])
  expect(page.writes).toBe(1)
  await f.restart()
  expect(page.session).toBe(true); expect(page.stopped).toBe(0)
  expect(pending()).toMatchObject([{ status: 'succeeded', result: { readbackPending: true } }])
  if (cancel) f.holdBeforeReadback()
  else f.repairReadback()
  const resumed = await f.api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'resume-ack-readback' })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  if (cancel) {
    await expect.poll(() => f.runtime.taskRepository!.operations(id, 'tool').filter(receipt => receipt.request?.toolName === 'browser_session_start' && receipt.status === 'succeeded').length, { timeout: 10000 }).toBe(2)
    const response = await f.api(`/v1/tasks/${id}/cancel`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'cancel-ack-pending' })
    expect(response.status, await response.clone().text()).toBe(200)
    await expect.poll(() => page.stopped).toBeGreaterThan(0)
    expect(pending()).toMatchObject([{ status: 'succeeded', result: { readbackPending: true } }])
    expect(f.task().status).toBe('cancelled')
  } else {
    await expect.poll(() => f.task().status, { timeout: 10000 }).toBe('completed')
    expect(pending()).toMatchObject([{ status: 'succeeded', result: { actionAcknowledged: true, readbackPending: false } }])
    expect(f.task().artifacts).toMatchObject([{ relativePath: 'report.html', validation: 'valid' }])
    await f.closeRuntime()
    expect(page.stopped).toBe(1)
  }
  expect(page.writes).toBe(1)
  expect(page.session).toBe(false)
}, 30000)

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

it.each(['paused', 'stalled'] as const)('records an incomplete public query review while preserving %s and the original unknown, across restart and separate continue', async status => {
  const f = await fixture(), id = f.task().id
  if (status === 'paused') await f.api(`/v1/tasks/${id}/pause`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'negative-pause' })
  const repository = f.runtime.taskRepository!
  repository.beginOperation({ ownerId: id, idempotencyKey: 'unrelated-negative-lock', kind: 'browser_schedule_action_outcome',
    request: { scheduleId: `schedule_${id}`, taskId: 'another-task', turnId: f.unknown.request!.turnId, action: 'fill' }, nowIso: f.runtime.nowIso() })
  const other = repository.finishOperation(id, 'unrelated-negative-lock', { status: 'outcome_unknown' }, f.runtime.nowIso())
  const original = repository.operation(id, f.unknown.idempotencyKey)!
  const before = f.modelCalls(), review = await f.verify('negative-review'), revision = f.task().revision
  const response = await f.confirm(review, 'negative-confirm', revision, 'not_completed')
  expect(response.status, await response.clone().text()).toBe(200)
  const result = await response.json()
  expect(result).toMatchObject({ status: 'verified', outcome: 'not_completed', evidence: {
    kind: 'human_confirmation', status: 'public_query_reviewed_incomplete', verified: true } })
  expect(f.task().status).toBe(status); expect(f.modelCalls()).toBe(before); expect(page.writes).toBe(1)
  const after = repository.operation(id, f.unknown.idempotencyKey)!
  expect({ ...after, resolution: undefined, updatedAt: original.updatedAt }).toEqual({ ...original, resolution: undefined })
  expect(after.status).toBe('outcome_unknown')
  expect(repository.verifiedOperationResolution(after)).toMatchObject({ outcome: 'not_completed' })
  const dispatch = repository.operations(id, 'browser_action_dispatch').find(item => item.status === 'outcome_unknown')!
  expect(repository.verifiedOperationResolution(dispatch)).toMatchObject({ outcome: 'not_completed' })
  expect(repository.operations(id, 'effect_verification')).toHaveLength(0)
  expect(repository.operations(id, 'effect_verification_incomplete')).toHaveLength(3)
  const locks = repository.operations(id, 'browser_schedule_action_outcome')
  expect(locks.filter(item => item.id !== other.id).every(item => repository.verifiedOperationResolution(item)?.outcome === 'not_completed')).toBe(true)
  expect(repository.verifiedOperationResolution(repository.operation(id, other.idempotencyKey)!)).toBeUndefined()
  const duplicate = await f.confirm(review, 'negative-confirm', revision, 'not_completed')
  expect(duplicate.status).toBe(200); expect(await duplicate.json()).toEqual(result)
  expect((await f.confirm(review, 'negative-confirm', revision, 'completed')).status).toBe(409)
  expect(f.task().artifacts).toHaveLength(0)
  expect(f.task().resultEvidence ?? []).not.toContainEqual(expect.objectContaining({ status: 'public_query_reviewed_incomplete' }))
  await f.restart()
  expect(f.task().status).toBe(status)
  const projected = await (await f.api(`/v1/tasks/${id}/receipts`, 'GET')).json() as Array<{ id: string; resolution?: { outcome?: string }; browser?: { canReview: boolean } }>
  expect(projected.find(item => item.id === f.unknown.id)).toMatchObject({ resolution: { outcome: 'not_completed' }, browser: { canReview: false } })
  f.holdModel()
  const resumed = await f.api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'negative-separate-continue' })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  await expect.poll(f.modelCalls).toBeGreaterThan(before)
  expect(page.writes).toBe(1)
}, 30000)

it.each(['completed', 'not_completed'])('compares the displayed semantic review, allowing hidden HTML and generated refs to change for %s', async decision => {
  const f = await fixture()
  await f.api(`/v1/tasks/${f.task().id}/pause`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'semantic-pause' })
  const before = f.modelCalls(), review = await f.verify('semantic-review')
  page.hiddenHtmlVersion++
  page.observationRefVersion = 202
  const response = await f.confirm(review, 'semantic-confirm', f.task().revision, decision)
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'verified', outcome: decision === 'not_completed' ? 'not_completed' : 'succeeded' })
  expect(f.task().status).toBe('paused'); expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
}, 20000)

it('reviews a large page using a fresh visible observation and exact target without claiming a full-page scan or resolving automatically', async () => {
  const f = await fixture()
  await f.api(`/v1/tasks/${f.task().id}/pause`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'large-page-paused' })
  page.largePage = true
  const before = f.modelCalls()
  const review = await f.verify('large-page-review')
  expect(review.status).toBe('outcome_unknown')
  expect(review.browserReview?.observationText).toContain('仅包含实际读取部分')
  expect(review.browserReview?.observationText).toContain('检查不会重复执行操作')
  expect(review.browserReview?.observationText).toContain('已填写轨道监测')
  expect(review.browserReview?.observationText).not.toContain('x'.repeat(100))
  const saved = f.runtime.taskRepository!.operations(f.task().id, 'browser_action_review').find(item => item.status === 'succeeded')!
  expect(saved.result).toMatchObject({ coverage: { source: 'visible_observation', htmlTruncated: true, textTruncated: false } })
  expect(f.runtime.taskRepository!.verifiedOperationResolution(f.unknown)).toBeUndefined()
  expect(f.task().status).toBe('paused'); expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
  const response = await f.confirm(review, 'large-page-confirm')
  expect(response.status, await response.clone().text()).toBe(200)
  expect(f.task().status).toBe('paused'); expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
  const original = f.runtime.taskRepository!.operation(f.task().id, f.unknown.idempotencyKey)!
  expect(original.status).toBe('outcome_unknown')
  expect(f.runtime.taskRepository!.verifiedOperationResolution(original)?.evidence.kind).toBe('human_confirmation')
}, 20000)

it.each(['missing-observation', 'empty', 'target-truncated', 'target-changed', 'different-url', 'revoked'] as const)('refuses unsafe %s large-page review and leaves the original unknown', async condition => {
  const f = await fixture()
  page.largePage = true
  if (condition === 'missing-observation') page.emptyObservation = true
  if (condition === 'empty') { page.emptyObservation = true; page.emptyPage = true }
  if (condition === 'target-truncated') page.targetTruncated = true
  if (condition === 'target-changed') page.targetChanged = true
  if (condition === 'different-url') page.url = 'https://public.example.test/another-page'
  if (condition === 'revoked') f.runtime.taskRepository!.update(f.task().id, f.task().revision, task => ({ ...task, authority: { ...task.authority!, revokedAt: new Date().toISOString() } }))
  const before = f.modelCalls()
  const response = await f.api(`/v1/tasks/${f.task().id}/receipts/${f.unknown.id}/verify`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: `unsafe-${condition}` })
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'outcome_unknown', errorCode: expect.any(String) })
  const original = f.runtime.taskRepository!.operation(f.task().id, f.unknown.idempotencyKey)!
  expect(original.status).toBe('outcome_unknown'); expect(original.resolution).toBeUndefined()
  expect(f.task().status).toBe('stalled'); expect(page.writes).toBe(1); expect(f.modelCalls()).toBe(before)
}, 20000)

it.each((['expired', 'target', 'page', 'input', 'revoked', 'cancelled', 'browser'] as const).flatMap(condition => ['confirmed_complete', 'not_completed'].map(decision => ({ condition, decision }))))('keeps $condition $decision review unknown without replay or resumption', async ({ condition, decision }) => {
  const f = await fixture()
  const review = await f.verify()
  expect(review.browserReview).toBeTruthy()
  const before = f.modelCalls()
  if (condition === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 121000) }
  if (condition === 'target') page.targetChanged = true
  if (condition === 'page') page.htmlChanged = true
  if (condition === 'input') page.controlValue = '另一项查询'
  if (condition === 'revoked') f.runtime.taskRepository!.update(f.task().id, f.task().revision, task => ({ ...task, authority: { ...task.authority!, revokedAt: new Date().toISOString() } }))
  if (condition === 'cancelled') await f.api(`/v1/tasks/${f.task().id}/cancel`, 'POST', { expectedRevision: f.task().revision, idempotencyKey: 'cancel' })
  if (condition === 'browser') f.options.capabilities.browserSkill.browserInstanceId = 'other-browser'
  if (condition === 'browser') await f.restart()
  const response = await f.confirm(review, 'confirm-once', f.task().revision, decision)
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
