import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'

// Real Runtime/HTTP/SQLite and immutable Turn grants; only the external model
// stream and fixed official CLI protocol are synthetic. No browser is launched.
const cli = vi.hoisted(() => ({ live: '', starts: 0, fills: 0, stops: 0, context: 0, url: 'about:blank',
  expired: false, terminalReason: 'session_idle_timeout', mode: 'clear' as 'clear' | 'unknown' | 'ack_pending' | 'observed_idle' }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 7,
      browsers: [{ instance_id: 'expiry-browser', browser_name: 'Chrome', label: 'Synthetic expiry fixture', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: cli.live ? [{ session_id: cli.live, browser_instance_id: 'expiry-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: {} }
    if (args[0] === 'session' && args[1] === 'start') {
      cli.live = `expiry-session-${++cli.starts}`; cli.url = 'about:blank'
      return { ok: true, output: { session_id: cli.live, browser_instance_id: 'expiry-browser' } }
    }
    if (args[0] === 'session' && args[1] === 'stop') {
      if (args[2] !== cli.live) return { ok: false, code: 'not_found', output: { code: 'not_found' } }
      cli.stops++; const id = cli.live; cli.live = ''; return { ok: true, output: { stopped: [id], failed: [] } }
    }
    if (args[0] === 'tab' && args[1] === 'list' && args[args.indexOf('--session') + 1] === 'expiry-session-1' && cli.expired) {
      if (cli.terminalReason === 'bare_not_found') return { ok: false, code: 'not_found', exitCode: 1, outcomeUnknown: false, output: { code: 'not_found', message: 'session not registered or already stopped' } }
      return { ok: false, code: 'not_found', exitCode: 1, outcomeUnknown: false,
        output: { code: 'not_found', message: 'session not registered or already stopped', data: { reason: cli.terminalReason, ended_unix_ms: Date.now() } } }
    }
    if (!cli.live) return { ok: false, code: 'not_found', output: { code: 'not_found' } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 1, url: cli.url, title: 'Synthetic public query' }] } }
    if (args[0] === 'navigate') { cli.url = args[1]!; return { ok: true, output: {} } }
    if (args[0] === 'cooperate') {
      if (cli.fills && cli.mode === 'ack_pending') return { ok: false, code: 'synthetic_readback_unavailable', output: {} }
      return { ok: true, output: { context_id: `expiry-context-${++cli.context}`, control_policy: 'strict',
        observation: { text: '@e1 searchbox "公开关键词输入框"，轨道监测公开查询。' } } }
    }
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 1, truncated: false,
      html: args.includes('--ref') ? '<input aria-label="公开关键词">' : '<html><title>公开查询</title><body><input aria-label="公开关键词"></body></html>' } }
    if (args[0] === 'fill') { cli.fills++; return cli.mode === 'ack_pending' ? { ok: true, output: { filled: true } }
      : { ok: false, code: 'synthetic_lost_ack', outcomeUnknown: true, output: {} } }
    throw new Error(`Unexpected synthetic CLI command: ${args[0]}`)
  })
}))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  Object.assign(cli, { live: '', starts: 0, fills: 0, stops: 0, context: 0, url: 'about:blank', expired: false, terminalReason: 'session_idle_timeout', mode: 'clear' })
})

async function fixture(mode: typeof cli.mode = 'clear') {
  cli.mode = mode
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-session-expiry-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let phase = 1, calls = 0, repeatedStartReply = ''
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    calls++; response.writeHead(200, { 'content-type': 'text/event-stream' })
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const repeated = (body.messages ?? []).find((message: { tool_call_id?: string }) => message.tool_call_id === 'expiry-repeat-start')
    if (repeated) repeatedStartReply = String(repeated.content)
    const called = new Set((body.messages ?? []).flatMap((message: { tool_calls?: Array<{ id: string }> }) => message.tool_calls?.map(call => call.id) ?? []))
    const steps = phase === 1 ? [['first-start', 'browser_session_start'], ...(mode === 'clear' ? [] : mode === 'observed_idle' ? [['idle-observe', 'browser_observe']] : [['navigate', 'browser_navigate'], ['authorize', 'browser_authorize_action'], ['fill', 'browser_fill']])]
      : [['new-start', 'browser_session_start'], ['repeat-start', 'browser_session_start']]
    const next = steps.find(([id]) => !called.has(`expiry-${id}`))
    if (!next) { response.write(': synthetic model hold until explicit pause\n\n'); return }
    if (next[0] === 'idle-observe') { cli.expired = true; cli.live = '' }
    const args = next[0] === 'idle-observe' ? { sessionId: 'expiry-session-1' } : next[0] === 'navigate' ? { sessionId: 'expiry-session-1', url: 'https://public.example.test/query' }
      : ['authorize', 'fill'].includes(next[0]!) ? { sessionId: 'expiry-session-1', contextId: `expiry-context-${cli.context}`, target: '@e1', value: '轨道监测',
        ...(next[0] === 'authorize' ? { action: 'fill', scope: 'task' } : {}) } : {}
    response.end(`data: ${JSON.stringify({ id: 'expiry-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `expiry-${next[0]}`, type: 'function',
      function: { name: next[1], arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-expiry', apiKey: 'synthetic-local-only',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions' as const, model: 'expiry-model',
    approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const },
    capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready', executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64), version: '0.5.0',
      daemonProtocolVersion: '1.9', browserInstanceId: 'expiry-browser', origins: ['https://public.example.test'], interaction: 'interact', revision: 1,
      browsers: [{ id: 'expiry-browser', name: 'Chrome', label: 'Synthetic', connected: true, versionSkew: false, extensionVersion: '0.5.0', protocolVersion: '1.9' }] } }) }
  let runtime = await createKunServeRuntime(options), router = buildRouter(runtime)
  cleanup.push(async () => runtime.shutdown?.())
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, { method,
    headers: { authorization: 'Bearer synthetic-expiry', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  let restarting = false
  const approvalTimer = setInterval(() => { if (!restarting) for (const approval of runtime.approvalGate.pending()) void api(`/v1/approvals/${approval.id}`, 'POST', { decision: 'allow' }) }, 10)
  cleanup.push(async () => { clearInterval(approvalTimer) })
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: options.model, approvalPolicy: 'on-request' })
  const created = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'create', request: {
    prompt: '使用BrowserSkill读取 https://public.example.test/query 的公开信息并核对原查询。' } })
  expect(created.kind).toBe('capability_required'); expect(calls).toBe(0)
  const id = created.task!.id, task = () => runtime.taskRepository!.get(id)!
  const preview = await (await api(`/v1/tasks/${id}/browser-binding`, 'GET')).json() as BrowserTaskBindingSnapshot
  const bound = await api(`/v1/tasks/${id}/browser-binding`, 'POST', { confirmed: true, expectedTaskRevision: preview.taskRevision,
    expectedBrowserRevision: preview.browserRevision, browserInstanceId: preview.browserInstanceId, origins: preview.origins,
    interaction: 'interact', verificationPolicy: 'strict', idempotencyKey: 'bind-strict' })
  expect(bound.status, await bound.clone().text()).toBe(200); expect(calls).toBe(0)
  const resume = (key: string) => api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: task().revision, idempotencyKey: key })
  expect((await resume('first-turn')).status).toBe(202)
  await expect.poll(() => runtime.taskRepository!.operations(id, 'tool').find(receipt => receipt.request?.callId === 'expiry-first-start')?.status, { timeout: 10000 }).toBe('succeeded')
  if (mode === 'unknown') await expect.poll(() => task().status, { timeout: 10000 }).toBe('stalled')
  if (mode === 'ack_pending') await expect.poll(() => runtime.taskRepository!.operations(id, 'browser_action_dispatch')[0]?.result, { timeout: 10000 }).toMatchObject({actionAcknowledged:true,readbackPending:true})
  if (mode === 'observed_idle') await expect.poll(() => runtime.taskRepository!.operations(id, 'tool').find(receipt => receipt.request?.callId === 'expiry-idle-observe')?.status, { timeout: 10000 }).toBe('failed')
  const oldSession = runtime.taskRepository!.operations(id, 'browser_session')[0]!
  const oldJson = JSON.stringify(oldSession), oldGrant = (await runtime.threadService.get(task().threadId))!.turns[0]!.executionGrant!
  cli.expired = true; cli.live = ''
  const paused = await api(`/v1/tasks/${id}/pause`, 'POST', { expectedRevision: task().revision, idempotencyKey: 'pause-before-expiry-recovery' })
  expect(paused.status).toBe(200)
  expect(runtime.taskRepository!.operation(id, oldSession.idempotencyKey)?.result).not.toHaveProperty('stopped', true)
  phase = 2
  const restart = async () => { restarting = true; try { await runtime.shutdown?.(); runtime = await createKunServeRuntime(options); router = buildRouter(runtime) } finally { restarting = false } }
  return { get runtime() { return runtime }, task, api, resume, restart, calls: () => calls, repeatedReply: () => repeatedStartReply, oldSession, oldJson, oldGrant }
}

it('retires a proven idle-expired session and creates exactly one fresh session in the next Turn without rewriting history', async () => {
  const f = await fixture(), id = f.task().id
  await f.restart()
  expect((await f.resume('fresh-turn')).status).toBe(202)
  await expect.poll(() => cli.starts, { timeout: 10000 }).toBe(2)
  await expect.poll(f.repeatedReply, { timeout: 10000 }).toContain('expiry-session-2')
  const sessions = f.runtime.taskRepository!.operations(id, 'browser_session')
  expect(sessions).toHaveLength(2)
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id, f.oldSession.idempotencyKey))).toBe(f.oldJson)
  const retirements = f.runtime.taskRepository!.operations(id, 'browser_session_retirement')
  expect(retirements).toHaveLength(1)
  const retired = retirements[0]!
  expect(retired).toMatchObject({status:'succeeded',request:{sessionReceiptId:f.oldSession.id,sessionFingerprint:f.oldSession.fingerprint,sessionId:'expiry-session-1',browserInstanceId:'expiry-browser',revision:1,verificationPolicy:'strict',threadId:f.task().threadId,executableHash:'a'.repeat(64),evidence:{source:'cli_readonly',reason:'session_idle_timeout',code:'not_found',exitCode:1}},result:{retired:true,reason:'session_idle_timeout'}})
  expect(retired.fingerprint).toBe(operationFingerprint(retired.request))
  expect((retired.result as {evidenceHash:string}).evidenceHash).toBe(operationFingerprint(retired.request!.evidence))
  const thread = (await f.runtime.threadService.get(f.task().threadId))!, grant = thread.turns.at(-1)!.executionGrant!
  expect(grant.taskId).toBe(id); expect(grant.id).not.toBe(f.oldGrant.id); expect(grant.turnId).not.toBe(f.oldGrant.turnId)
  expect(grant.browserScope).toEqual(f.oldGrant.browserScope)
  expect(cli).toMatchObject({ starts: 2, fills: 0, live: 'expiry-session-2' })
}, 20000)

it('keeps an unknown action locked after session expiry and Runtime restart without replaying it', async () => {
  const f = await fixture('unknown'), id = f.task().id
  const receipt = f.runtime.taskRepository!.operations(id, 'browser_action_dispatch')[0]!, original = JSON.stringify(receipt), before = f.calls()
  expect(receipt.status).toBe('outcome_unknown')
  await f.restart()
  const response = await f.resume('must-not-bypass-unknown')
  expect(response.status, await response.clone().text()).toBe(409)
  expect(f.calls()).toBe(before); expect(cli).toMatchObject({ starts: 1, fills: 1, live: '', stops: 0 })
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id, receipt.idempotencyKey))).toBe(original)
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id, f.oldSession.idempotencyKey))).toBe(f.oldJson)
  expect(f.runtime.taskRepository!.operations(id, 'browser_session_retirement')).toHaveLength(0)
}, 20000)

it('does not retire an expired ACK-pending session or create a replacement before its original readback is resolved', async () => {
  const f = await fixture('ack_pending'), id = f.task().id
  const receipt = f.runtime.taskRepository!.operations(id, 'browser_action_dispatch')[0]!, original = JSON.stringify(receipt)
  expect(receipt).toMatchObject({ status: 'succeeded', result: { actionAcknowledged: true, readbackPending: true } })
  await f.restart()
  expect((await f.resume('readback-still-required')).status).toBe(202)
  await expect.poll(() => f.runtime.taskRepository!.operations(id, 'tool').find(item => item.request?.callId === 'expiry-new-start')?.status, { timeout: 10000 }).toBe('failed')
  expect(cli).toMatchObject({ starts: 1, fills: 1, live: '', stops: 0 })
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id, receipt.idempotencyKey))).toBe(original)
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id, f.oldSession.idempotencyKey))).toBe(f.oldJson)
  expect(f.runtime.taskRepository!.operations(id, 'browser_session_retirement')).toHaveLength(0)
}, 20000)

it('does not interpret a bare or unrecognized not-found reason as a verified idle retirement', async () => {
  const f = await fixture(), id = f.task().id
  cli.terminalReason = 'unverified-session-absence'
  await f.restart()
  expect((await f.resume('unverified-absence')).status).toBe(202)
  await expect.poll(() => f.runtime.taskRepository!.operations(id, 'tool').find(item => item.request?.callId === 'expiry-new-start')?.status, { timeout: 10000 }).toBe('failed')
  expect(cli).toMatchObject({ starts: 1, fills: 0, live: '' })
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id, f.oldSession.idempotencyKey))).toBe(f.oldJson)
  expect(f.runtime.taskRepository!.operations(id, 'browser_session_retirement')).toHaveLength(0)
}, 20000)

it('uses the persisted failed readonly observation after the official tombstone is lost, without rewriting that receipt', async () => {
  const f = await fixture('observed_idle'), id = f.task().id
  const observed = f.runtime.taskRepository!.operations(id, 'tool').find(receipt=>receipt.request?.callId==='expiry-idle-observe')!, original = JSON.stringify(observed)
  expect(observed).toMatchObject({status:'failed',request:{toolName:'browser_observe',argumentsHash:operationFingerprint({sessionId:'expiry-session-1'})},result:{item:{isError:true,output:{status:'failed',code:'not_found',vendorCode:'not_found',vendorReason:'session_idle_timeout'}}}})
  cli.terminalReason = 'bare_not_found'
  await f.restart()
  expect((await f.resume('trusted-historical-idle')).status).toBe(202)
  await expect.poll(f.repeatedReply,{timeout:10000}).toContain('expiry-session-2')
  expect(cli).toMatchObject({starts:2,fills:0,live:'expiry-session-2'})
  const retired = f.runtime.taskRepository!.operations(id,'browser_session_retirement')
  expect(retired).toHaveLength(1)
  expect(retired[0]).toMatchObject({status:'succeeded',request:{sessionReceiptId:f.oldSession.id,sessionFingerprint:f.oldSession.fingerprint,evidence:{source:'trusted_tool_receipt',receiptId:observed.id,fingerprint:observed.fingerprint,code:'not_found',reason:'session_idle_timeout'}},result:{retired:true,reason:'session_idle_timeout'}})
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id,observed.idempotencyKey))).toBe(original)
  expect(JSON.stringify(f.runtime.taskRepository!.operation(id,f.oldSession.idempotencyKey))).toBe(f.oldJson)
},20000)
