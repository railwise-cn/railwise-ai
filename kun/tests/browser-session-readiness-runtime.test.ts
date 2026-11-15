import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'
import type { BrowserCommandRunner } from '../src/services/browser-skill-cli.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'

const browser = vi.hoisted(() => ({ run: undefined as BrowserCommandRunner | undefined }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn((config, args, signal) => browser.run!(config, args, signal))
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); browser.run = undefined })

it('prepares observe({}) through the real Runtime and resumes the same Task after a normal restart without replaying any action', async () => {
  // Real Runtime, HTTP model stream, SQLite receipts and served document;
  // only the official CLI protocol is controlled here, not a real Chrome.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-readiness-runtime-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let phase = 1, heldResponse: import('node:http').ServerResponse | undefined
  const requests: Array<{ phase: number; tools: string[]; next: string }> = []
  let origin = ''
  const html = '<!doctype html><html lang="zh-CN"><head><title>会话接续技术验收</title></head><body><h1>只读来源正文</h1><p>此页面由本机测试服务实际提供，不涉及业务提交。</p></body></html>'
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const tools = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
    const output = (id: string) => {
      const result = body.messages.find((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === id)
      if (!result) return undefined
      const text = String(result.content), start = text.indexOf('{'), end = text.lastIndexOf('}')
      return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    }
    const id = 'readiness-observe-' + phase, observed = output(id)
    let name: string | undefined, callId: string | undefined, args: Record<string, unknown> = {}
    if (!observed) { name = 'browser_observe'; callId = id }
    else if (phase === 1) { requests.push({ phase, tools, next: 'held-after-observe' }); heldResponse = response; return }
    else if (!output('readiness-navigate')) { name = 'browser_navigate'; callId = 'readiness-navigate'; args = { sessionId: observed.sessionId, url: origin + '/document' } }
    else if (!output('readiness-read')) { name = 'browser_get_html'; callId = 'readiness-read'; args = { sessionId: observed.sessionId } }
    requests.push({ phase, tools, next: name ?? 'final' })
    const delta = name ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      : { content: '已通过本任务授权会话实际读取网页，标题为“会话接续技术验收”。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'readiness-fixture', choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  type Session = { url: string; tab: number; sync: number }
  const sessions = new Map<string, Session>(), commands: string[][] = []
  let starts = 0, maximumLiveSessions = 0, documentReads = 0
  browser.run = async (_config, args) => {
    commands.push([...args])
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 7,
      browsers: [{ instance_id: 'synthetic-browser', browser_name: 'Chrome', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: [...sessions.keys()].map(session_id => ({ session_id, browser_instance_id: 'synthetic-browser' })) } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'prepared' } }
    if (args[0] === 'session' && args[1] === 'start') {
      const number = ++starts, sessionId = 'owned-fixture-session-' + number
      sessions.set(sessionId, { tab: number, url: 'about:blank', sync: 0 }); maximumLiveSessions = Math.max(maximumLiveSessions, sessions.size)
      return { ok: true, output: { session_id: sessionId, browser_instance_id: 'synthetic-browser' } }
    }
    if (args[0] === 'session' && args[1] === 'stop') {
      expect(sessions.delete(args[2]!)).toBe(true)
      return { ok: true, output: { stopped: [args[2]], failed: [] } }
    }
    const sessionId = args[args.indexOf('--session') + 1]!, session = sessions.get(sessionId)!
    expect(session).toBeTruthy()
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: session.tab, active: true, scope: 'agent', url: session.url,
      title: session.url === 'about:blank' ? '' : '会话接续技术验收' }] } }
    if (args[0] === 'cooperate') return { ok: true, output: { ready: true, context_id: sessionId + '-context-' + (++session.sync),
      observation_id: sessionId + '-observation-' + session.sync, tab_id: session.tab, control_policy: 'target', observation: { text: '只读来源正文' } } }
    if (args[0] === 'navigate') { expect(args[1]).toBe(origin + '/document'); session.url = args[1]!; return { ok: true, output: { final_url: session.url } } }
    if (args[0] === 'get-html') {
      const fetched = await fetch(session.url), content = await fetched.text(); documentReads++
      expect(fetched.status).toBe(200)
      return { ok: true, output: { tab_id: session.tab, html: content, byte_size: Buffer.byteLength(content), truncated: false } }
    }
    throw new Error('Unexpected protocol command: ' + args[0])
  }
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-readiness-token', apiKey: 'synthetic-local-only', baseUrl: origin + '/v1',
    endpointFormat: 'chat_completions' as const, model: 'readiness-fixture', approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const,
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: {
      enabled: true, state: 'ready', executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64), version: '0.5.0', daemonProtocolVersion: '1.9',
      browserInstanceId: 'synthetic-browser', origins: [origin], interaction: 'interact', revision: 1,
      browsers: [{ id: 'synthetic-browser', name: 'Chrome', label: 'Controlled protocol fixture', connected: true, versionSkew: false, extensionVersion: '0.5.0', protocolVersion: '1.9' }] }
    }) }
  let runtime = await createKunServeRuntime(options), router = buildRouter(runtime)
  cleanup.push(async () => runtime.shutdown?.())
  const api = (path: string, body?: unknown, method = 'POST') => dispatchRequest(router, new Request('http://localhost' + path, {
    method, headers: { authorization: 'Bearer synthetic-readiness-token', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const thread = await runtime.threadService.create({ workspace, mode: 'agent', model: 'readiness-fixture', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: thread.id, intent: 'new', idempotencyKey: 'readiness-source',
    request: { prompt: `使用browser-skill查询 ${origin}/document 的公开网页，实际读取正文并告诉我标题，无需账号。` } })
  expect(started.kind).toBe('capability_required')
  const taskId = started.task!.id
  const snapshot = await (await api(`/v1/tasks/${taskId}/browser-binding`, undefined, 'GET')).json() as BrowserTaskBindingSnapshot
  expect((await api(`/v1/tasks/${taskId}/browser-binding`, { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
    expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
    interaction: 'interact', verificationPolicy: 'public_query_target', publicQueryAuthorization: 'task', idempotencyKey: 'confirm-readiness' })).status).toBe(200)
  const resume = async (key: string) => expect((await api(`/v1/tasks/${taskId}/resume`, { expectedRevision: runtime.taskRepository!.get(taskId)!.revision, idempotencyKey: key })).status).toBe(202)
  await resume('readiness-first')
  await expect.poll(() => heldResponse !== undefined).toBe(true)
  expect(runtime.taskRepository!.operations(taskId, 'browser_session_readiness')).toMatchObject([{ status: 'succeeded', result: { observationCompleted: true, actualAction: 'start' } }])
  const firstObserve = runtime.taskRepository!.operations(taskId, 'tool').find(receipt => receipt.request?.toolName === 'browser_observe')!
  expect(firstObserve.result).toMatchObject({ item: { output: { sourceUrl: 'about:blank', sessionId: 'owned-fixture-session-1',
    observation: { context_id: 'owned-fixture-session-1-context-1' }, evidence: { verified: false, contentRead: false, businessOutcomeVerified: false } } } })
  const firstTurn = runtime.taskRepository!.get(taskId)!.activeTurnId
  expect((await api(`/v1/tasks/${taskId}/pause`, { expectedRevision: runtime.taskRepository!.get(taskId)!.revision, idempotencyKey: 'pause-before-restart' })).status).toBe(200)
  heldResponse!.end()
  await expect.poll(() => sessions.size).toBe(0)
  await runtime.shutdown?.()
  expect(sessions.size).toBe(0)
  phase = 2
  runtime = await createKunServeRuntime(options); router = buildRouter(runtime)
  expect(runtime.taskRepository!.get(taskId)!.status).toBe('paused')
  await resume('readiness-second')
  await expect.poll(() => runtime.taskRepository!.get(taskId)!.status, { timeout: 15_000 }).toBe('completed')
  const task = runtime.taskRepository!.get(taskId)!, receipts = runtime.taskRepository!.operations(taskId)
  const preparations = receipts.filter(receipt => receipt.kind === 'browser_session_readiness')
  expect(preparations).toHaveLength(2)
  expect(new Set(preparations.map(receipt => receipt.request?.turnId)).size).toBe(2)
  expect(task.activeTurnId).not.toBe(firstTurn)
  expect(preparations.map(receipt => receipt.result)).toMatchObject([
    { sessionId: 'owned-fixture-session-1', observationCompleted: true }, { sessionId: 'owned-fixture-session-2', observationCompleted: true }
  ])
  for (const preparation of preparations) {
    const host = receipts.find(receipt => receipt.id === preparation.request?.hostOperationId)!
    expect(host).toMatchObject({ kind: 'tool', status: 'succeeded', request: { toolName: 'browser_observe', argumentsHash: operationFingerprint({}), providerId: 'browser-skill' } })
    expect(preparation.request?.grantFingerprint).toBe(operationFingerprint(host.request!.executionGrant))
    expect(preparation.request?.turnId).toBe(host.request?.turnId)
  }
  expect(receipts.some(receipt => receipt.kind === 'tool' && receipt.request?.toolName === 'browser_session_start')).toBe(false)
  expect(receipts.some(receipt => receipt.status === 'outcome_unknown' || receipt.kind === 'browser_action_dispatch')).toBe(false)
  expect(requests.every(request => request.tools.includes('browser_session_start') && request.tools.includes('browser_observe'))).toBe(true)
  expect(starts).toBe(2); expect(maximumLiveSessions).toBe(1); expect(documentReads).toBe(1)
  expect(commands.some(args => ['click', 'fill', 'press'].includes(args[0]!))).toBe(false)
  expect(runtime.approvalGate.pending()).toHaveLength(0)
}, 30_000)
