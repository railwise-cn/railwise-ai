import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

// Only external transports are simulated. The production factory, task admission,
// model catalogs, immutable grants, LocalToolHost and native schedule store are real.
const browserFixture = vi.hoisted(() => ({ url: 'about:blank', started: false }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: string[]) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.7', pid: 7, browsers: [{ instance_id: 'synthetic-browser',
      browser_name: 'Chrome', extension_version: '0.4.0', extension_protocol_version: '1.7' }],
      sessions: browserFixture.started ? [{ session_id: 'synthetic-session', browser_instance_id: 'synthetic-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'ready', session: { session_id: 'synthetic-session', browser_instance_id: 'synthetic-browser' } } }
    if (args[0] === 'session' && args[1] === 'start') { browserFixture.started = true; return { ok: true, output: { session_id: 'synthetic-session', browser_instance_id: 'synthetic-browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') { browserFixture.started = false; return { ok: true, output: { stopped: ['synthetic-session'], failed: [] } } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 7, active: true, url: browserFixture.url, title: '合成正文来源', scope: 'agent' }] } }
    if (args[0] === 'navigate') { browserFixture.url = args[1]; return { ok: true, output: { final_url: args[1] } } }
    if (args[0] === 'cooperate') return { ok: true, output: { context_id: 'synthetic-context', observation: { text: '合成网页正文，仅供定时调度边界回归。' } } }
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 7, html: '<html><body>合成网页正文</body></html>', byte_size: 45, truncated: false } }
    throw new Error(`Unexpected browser dispatch in schedule-boundary test: ${args[0]}`)
  })
}))

it('keeps browser HTML task schedules native while rejecting every legacy bridge replay before transport dispatch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-schedule-bridge-')))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const bridgeTools = ['claw', 'gui'].flatMap(prefix => ['list', 'create', 'update', 'delete'].map(action => `${prefix}_schedule_${action}`))
  vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
  vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: bridgeTools.map(name => ({ name, inputSchema: { type: 'object' as const } })) })
  const legacyDispatch = vi.spyOn(Client.prototype, 'callTool').mockResolvedValue({ content: [{ type: 'text', text: 'synthetic compatibility response' }] })
  const catalogs: string[][] = []
  let releaseFirstRequest!: () => void
  const firstRequest = new Promise<void>(resolve => { releaseFirstRequest = resolve })
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: Array<{ function: { name: string } }>
      messages?: Array<{ tool_calls?: Array<{ function: { name: string } }> }>
    }
    const names = body.tools?.map(tool => tool.function.name) ?? []
    catalogs.push(names)
    if (catalogs.length === 1) await firstRequest
    const called = new Set(body.messages?.flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []))
    const next = ['browser_session_start', 'browser_navigate', 'browser_get_html', 'browser_session_stop', 'publish_artifact', 'schedule_task', 'list_schedules'].find(name => names.includes(name) && !called.has(name))
    const args = next === 'publish_artifact' ? { path: 'boundary.html', content: '<!doctype html><html><body>合成调度边界成果</body></html>' }
      : next === 'browser_navigate' ? { sessionId: 'synthetic-session', url: 'https://example.test/' }
        : next === 'browser_get_html' || next === 'browser_session_stop' ? { sessionId: 'synthetic-session' } : {}
    const delta = next ? { tool_calls: [{ index: 0, id: `call-${next}`, type: 'function', function: { name: next, arguments: JSON.stringify(args) } }] }
      : { content: '合成HTML已交付，每日计划已建立并读回。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'synthetic-boundary', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
  try {
    runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic', apiKey: 'synthetic',
      baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions', model: 'synthetic-boundary',
      approvalPolicy: 'auto', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' },
      capabilities: KunCapabilitiesConfig.parse({ mcp: { enabled: true, servers: { gui_schedule: {
        enabled: true, transport: 'stdio', command: 'never-spawned-synthetic-bridge', trustScope: 'user' }
      } }, browserSkill: { enabled: true, state: 'ready', browserInstanceId: 'synthetic-browser', revision: 1,
        executablePath: join(root, 'never-executed-browser'), executableHash: 'a'.repeat(64), origins: ['https://example.test'], interaction: 'observe' } }) })
    const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic-boundary' })
    const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'browser-html-daily',
      request: { prompt: '使用 BrowserSkill 读取 https://example.test ，生成并交付HTML报告，每天09:00和17:00执行。' } })
    expect(started.kind).toBe('task_started')
    await expect.poll(() => catalogs.length, { timeout: 10000 }).toBeGreaterThan(0)
    expect(catalogs[0]).toEqual(expect.arrayContaining(['browser_session_start', 'schedule_task', 'list_schedules', 'publish_artifact']))
    expect(catalogs.every(names => names.every(name => !name.startsWith('mcp_gui_schedule_')))).toBe(true)
    const task = runtime.taskRepository!.get(started.task!.id)!
    const worker = (await runtime.threadService.get(task.threadId))!
    const turn = worker.turns.find(item => item.id === task.activeTurnId)!
    expect(turn.executionGrant).toMatchObject({ taskId: task.id, browserScope: { browserInstanceId: 'synthetic-browser', origins: ['https://example.test'] } })
    const context: ToolHostContext = { threadId: worker.id, turnId: turn.id, workspace, threadMode: 'agent',
      approvalPolicy: 'auto', sandboxMode: 'read-only', executionGrant: turn.executionGrant,
      abortSignal: new AbortController().signal, awaitApproval: vi.fn(async () => 'allow' as const) }
    for (const name of bridgeTools) {
      const rejected = await runtime.toolHost!.execute({ callId: `replayed-${name}`, toolName: `mcp_gui_schedule_${name}`, arguments: {} }, context)
      expect(rejected.item).toMatchObject({ kind: 'tool_result', isError: true,
        output: { code: 'execution_grant_scope', error: expect.stringContaining('schedule_task') } })
    }
    expect(context.awaitApproval).not.toHaveBeenCalled()
    expect(legacyDispatch).not.toHaveBeenCalled()
    releaseFirstRequest()
    await expect.poll(() => {
      const current = runtime!.taskRepository!.get(task.id)!
      return { status: current.status, reason: current.stalledReason ?? current.waitingReason ?? null }
    }, { timeout: 15000 }).toEqual({ status: 'completed', reason: null })
    expect(runtime.taskRepository!.operations(task.id, 'schedule_readback')).toHaveLength(1)
    expect(runtime.flowService!.get(`schedule_${task.id}`)?.variables.taskSchedule).toBeDefined()
    expect(runtime.flowService!.get(`schedule_${task.id}`)?.nodes[0]?.config).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
    expect(legacyDispatch).not.toHaveBeenCalled()
    const compatibility = { ...context, executionGrant: undefined }
    expect((await runtime.toolHost!.listTools(compatibility)).filter(tool => tool.providerId === 'mcp:gui_schedule')).toHaveLength(8)
    await runtime.toolHost!.execute({ callId: 'non-task-list', toolName: 'mcp_gui_schedule_gui_schedule_list', arguments: {} }, compatibility)
    expect(legacyDispatch).toHaveBeenCalledOnce()
  } finally {
    releaseFirstRequest()
    await runtime?.shutdown?.()
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() })
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
