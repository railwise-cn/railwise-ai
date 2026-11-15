import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'

const page = vi.hoisted(() => ({
  mode: 'recover', session: false, url: 'about:blank', context: 0, ready: false,
  shell: '<!doctype html><html><head><title>公开页面</title><script src="https://cdn.example.test/blocking.js"></script></head></html>',
  emptyObservation: '@vom 1\n@view 1920x835\n@layers 1 focus=L1\nL1 page\n  RootWebArea ""',
  calls: [] as string[][], beforeRead: undefined as (() => void) | undefined
}))
const URL = 'https://read.example.test/detail'
const BODY = '<!doctype html><html><head><title>公开公告详情</title></head><body><article><h1>轨道控制网测量公开公告详情</h1><p>预算金额（元）：400000；这是完整原文读取的合成验收正文。</p></article></body></html>'
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    page.calls.push([...args])
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 10,
      browsers: [{ instance_id: 'read-browser', browser_name: 'Chrome', label: '读取状态夹具', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: page.session ? [{ session_id: 'read-session', browser_instance_id: 'read-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: {} }
    if (args[0] === 'session' && args[1] === 'start') { page.session = true; return { ok: true, output: { session_id: 'read-session', browser_instance_id: 'read-browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') { page.session = false; return { ok: true, output: { stopped: ['read-session'], failed: [] } } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 1, url: page.url, title: '公开页面', scope: 'agent' }] } }
    if (args[0] === 'navigate') {
      page.url = args[1]!
      return { ok: false, code: 'browser_navigation_timeout', exitCode: 4,
        navigation: { tab_id: 1, url: page.url, final_url: page.url, reached: 'timeout', error_text: 'timed out waiting for lifecycle load after 30000ms' }, output: {} }
    }
    if (args[0] === 'wait-for-element') {
      if (page.mode === 'recover') page.ready = true
      if (page.mode === 'changed') page.url = 'https://read.example.test/different-document'
      return { ok: true, output: { tab_id: 1, used_selector: 'body', satisfied: ['recover', 'changed'].includes(page.mode), attached: ['recover', 'changed'].includes(page.mode), elapsed_ms: page.mode === 'shell' ? 5000 : 1 } }
    }
    if (args[0] === 'cooperate') return { ok: true, output: { control_policy: 'target', tab_id: 1,
      context_id: `read-context-${++page.context}`, observation_id: `read-observation-${page.context}`,
      observation: { text: page.ready ? '@vom 1\nRootWebArea "已加载的真实合成公告"\n  StaticText "预算金额400000"' : page.emptyObservation,
        truncated: false, ref_count: 0 } } }
    if (args[0] === 'get-html') {
      page.beforeRead?.(); page.beforeRead = undefined
      const html = args.includes('--ref') ? '<a href="/detail">公开详情</a>' : page.ready ? BODY : page.shell
      return { ok: true, output: { tab_id: 1, html, byte_size: Buffer.byteLength(html), truncated: false } }
    }
    throw new Error(`Unexpected browser command: ${args[0]}/${args[1] ?? ''}`)
  })
}))
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks() })

async function fixture(mode: 'recover' | 'shell' | 'changed' | 'target' | 'script_literal') {
  page.mode = mode; page.session = false; page.url = 'about:blank'; page.ready = false; page.context = 0; page.calls = []; page.beforeRead = undefined
  if (process.env.RAILWISE_BROWSER_READ_REPLAY) {
    const raw = JSON.parse(await readFile(process.env.RAILWISE_BROWSER_READ_REPLAY, 'utf8')) as { receipts: Array<{ id: string; result: { item: { output: Record<string, unknown> } } }> }
    page.shell = String(raw.receipts.find(row => row.id === 'operation_eff047ef-2154-46fb-94bd-3cb011192348')!.result.item.output.html)
    const observation = raw.receipts.find(row => row.id === 'operation_522d5db0-115c-4843-9942-dfd54e232897')!.result.item.output.observation as { observation: { text: string } }
    page.emptyObservation = observation.observation.text
    expect(Buffer.byteLength(page.shell)).toBe(5489); expect(page.emptyObservation).toHaveLength(72)
  }
  if (mode === 'script_literal') page.shell = '<html><head><script>const example = "<body>not a DOM body</body>"</script><meta content="<body>"></head></html>'
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-document-read-runtime-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '只读 中文 资料'); await mkdir(workspace)
  let modelCalls = 0
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume only local protocol fixture input. */ }
    const step = modelCalls++
    if (step >= 3) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': held until test shutdown\n\n'); return }
    const name = step === 0 ? 'browser_session_start' : step === 1 ? 'browser_navigate' : 'browser_get_html'
    const args = step === 0 ? {} : step === 1 ? { sessionId: 'read-session', url: URL }
      : { sessionId: 'read-session', ...(mode === 'target' ? { target: '@e1' } : {}) }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'read-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `read-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'document-test',
    apiKey: 'local-fixture-only', baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: 'read-model', endpointFormat: 'chat_completions',
    approvalPolicy: 'on-request', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' },
    capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready', executablePath: join(root, 'synthetic-bsk'), executableHash: 'a'.repeat(64), version: '0.5.0', daemonProtocolVersion: '1.9',
      browsers: [{ id: 'read-browser', name: 'Chrome', label: '读取状态夹具', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }],
      browserInstanceId: 'read-browser', origins: ['https://read.example.test'], interaction: 'observe', revision: 1 } }) })
  cleanups.push(async () => runtime.shutdown?.())
  const router = buildRouter(runtime)
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, {
    method, headers: { authorization: 'Bearer document-test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'read-model', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'document-read', request: { prompt: `使用BrowserSkill读取 ${URL} 的公开公告正文，生成HTML报告。` } })
  const id = started.task!.id
  const bindingResponse = await api(`/v1/tasks/${id}/browser-binding`, 'GET')
  expect(bindingResponse.status, await bindingResponse.clone().text()).toBe(200)
  const binding = await bindingResponse.json() as BrowserTaskBindingSnapshot
  const bound = await api(`/v1/tasks/${id}/browser-binding`, 'POST', { expectedTaskRevision: binding.taskRevision, expectedBrowserRevision: binding.browserRevision,
    browserInstanceId: binding.browserInstanceId, origins: binding.origins, interaction: 'observe', verificationPolicy: 'public_query_target', confirmed: true, idempotencyKey: 'read-fixture-binding' })
  expect(bound.status, await bound.clone().text()).toBe(200)
  if (mode === 'shell' || mode === 'script_literal') page.beforeRead = () => {
    const repo = runtime.taskRepository!
    repo.beginOperation({ ownerId: id, idempotencyKey: 'pending-ack', kind: 'browser_action_dispatch', nowIso: new Date().toISOString(), request: { sessionId: 'read-session', tabId: 1, pageUrl: URL } })
    repo.finishOperation(id, 'pending-ack', { status: 'succeeded', result: { actionAcknowledged: true, readbackPending: true } })
  }
  const resumed = await api(`/v1/tasks/${id}/resume`, 'POST', { expectedRevision: runtime.taskRepository!.get(id)!.revision, idempotencyKey: 'read-fixture-resume' })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  await expect.poll(() => runtime.taskRepository!.operations(id, 'tool').find(row => row.request?.toolName === 'browser_get_html')?.status, { timeout: 10000 }).not.toBe(undefined)
  await expect.poll(() => ['succeeded', 'failed'].includes(runtime.taskRepository!.operations(id, 'tool').find(row => row.request?.toolName === 'browser_get_html')?.status ?? ''), { timeout: 10000 }).toBe(true)
  const receipt = runtime.taskRepository!.operations(id, 'tool').find(row => row.request?.toolName === 'browser_get_html')!
  return { runtime, id, receipt, output: (receipt.result as { item: { output: Record<string, unknown> } }).item.output }
}

it('rechecks the same owned document once after an empty load timeout and only persists the recovered body as source evidence', async () => {
  const f = await fixture('recover')
  expect(f.receipt.status).toBe('succeeded')
  expect(f.output).toMatchObject({ status: 'succeeded', sourceUrl: URL, html: BODY, readScope: 'document', evidence: { verified: true, contentRead: true } })
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(1)
  expect(page.calls.filter(args => args[0] === 'wait-for-element')).toHaveLength(1)
  expect(page.calls.filter(args => args[0] === 'get-html')).toHaveLength(2)
}, 20000)

it.each(['shell', 'script_literal'] as const)('does not certify a persistent $mode head-only shell or settle an acknowledged action from its nonempty HTML', async mode => {
  const f = await fixture(mode)
  expect(f.receipt.status).toBe('failed')
  expect(f.output).toMatchObject({ status: 'failed', code: 'browser_document_not_ready' })
  expect(f.output).not.toHaveProperty('evidence.verified', true)
  expect(f.runtime.taskRepository!.operation(f.id, 'pending-ack')?.result).toMatchObject({ readbackPending: true })
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(1)
  expect(page.calls.filter(args => args[0] === 'get-html')).toHaveLength(1)
}, 20000)

it('rejects a changed page before rereading or associating another document with the original URL', async () => {
  const f = await fixture('changed')
  expect(f.receipt.status).toBe('failed')
  expect(f.output).toMatchObject({ status: 'failed', code: 'browser_page_changed' })
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(1)
  expect(page.calls.filter(args => args[0] === 'get-html')).toHaveLength(1)
}, 20000)

it('retains the explicit element-subtree read contract without requiring a complete document body', async () => {
  const f = await fixture('target')
  expect(f.receipt.status).toBe('succeeded')
  expect(f.output).toMatchObject({ status: 'succeeded', html: '<a href="/detail">公开详情</a>', readScope: 'element' })
  expect(page.calls.filter(args => args[0] === 'wait-for-element')).toHaveLength(0)
}, 20000)
