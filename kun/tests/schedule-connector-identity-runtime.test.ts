import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'

// Runtime/HTTP/Host/SQLite/Flow are real. Only the MCP transport is replaced
// with an inert catalog; no application command, remote connector or browser
// is launched. A bridge tool call is a test failure.
const mcp = vi.hoisted(() => ({ invocations: [] as string[] }))
vi.mock('../src/adapters/tool/mcp-tool-provider.js', async original => {
  const actual = await original<typeof import('../src/adapters/tool/mcp-tool-provider.js')>()
  return { ...actual, buildMcpToolProviders: (config: Parameters<typeof actual.buildMcpToolProviders>[0], options?: Parameters<typeof actual.buildMcpToolProviders>[1]) =>
    actual.buildMcpToolProviders(config, { ...options, clientFactory: async serverId => ({
      listTools: async () => ({ tools: (serverId === 'gui_schedule' || serverId === 'claw_schedule'
        ? ['claw_schedule_list', 'gui_schedule_list', 'claw_schedule_create', 'gui_schedule_create', 'claw_schedule_update', 'gui_schedule_update', 'claw_schedule_delete', 'gui_schedule_delete'] : ['read'])
        .map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } })) }),
      callTool: async () => { mcp.invocations.push(serverId); throw new Error('This acceptance must never invoke the compatibility bridge or any MCP tool') },
      close: async () => {}
    }) }) }
})

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.unstubAllEnvs(); mcp.invocations.length = 0
})

it.each(['gui_schedule', 'claw_schedule', 'notes'] as const)('keeps an existing plan and its immutable evidence correct when %s configuration changes between real task Turns', async serverId => {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-schedule-identity-runtime-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const requests: Array<{ phase: number; tools: string[] }> = []
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>>
  let phase = 0
  let barrierReached!: () => void
  const barrier = new Promise<void>(resolve => { barrierReached = resolve })
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString())
    const current = phase++
    const tools = (input.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name)
    requests.push({ phase: current, tools })
    expect(tools.some((name: string) => /^mcp_(?:gui_schedule|claw_schedule)_/.test(name))).toBe(false)
    if (current === 2) {
      barrierReached()
      await new Promise<void>(resolve => response.once('close', resolve))
      return
    }
    const toolName = current === 0 || current === 3 ? 'schedule_task' : current === 1 || current === 4 ? 'list_schedules' : undefined
    if (toolName) expect(tools).toContain(toolName)
    const delta = toolName ? { tool_calls: [{ index: 0, id: `schedule-identity-${current}`, type: 'function', function: { name: toolName, arguments: '{}' } }] }
      : { content: '每日检查提醒已建立，已读回核对执行时刻与时区。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: `response-${current}`, choices: [{ index: 0, delta, finish_reason: toolName ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => { model.close(error => error ? reject(error) : resolve()); model.closeAllConnections() }))
  const address = model.address() as { port: number }
  const configuration = (generation: string) => ({ enabled: true, servers: { [serverId]: {
    enabled: true, transport: 'stdio' as const, command: serverId === 'notes' ? '/verified/notes-service' : `/verified/${generation}/RailWise AI Helper`,
    args: serverId === 'notes' ? [] : [`/verified/${generation}/claw-schedule-mcp-node-entry.js`],
    // Executable-provider negative: change only the synthetic account identity,
    // retaining its executable/catalog. Compatibility positives change paths.
    env: serverId === 'notes' ? { ACCOUNT_ID: generation } : {}, headers: {}, trustScope: 'user' as const,
    trustedWorkspaceRoots: [], timeoutMs: 5000
  } } })
  runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: root, runtimeToken: 'local-test-only', apiKey: 'local-model-only',
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'fixture-model', approvalPolicy: 'on-request', sandboxMode: 'read-only', tokenEconomyMode: false,
    insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({ mcp: configuration('old-package') }) })
  cleanups.push(async () => runtime.shutdown?.())
  const router = buildRouter(runtime), repository = runtime.taskRepository!
  const api = (path: string, method = 'GET', body?: unknown) => dispatchRequest(router, new Request('http://localhost' + path, { method,
    headers: { authorization: 'Bearer local-test-only', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const origin = await runtime.threadService.create({ workspace, model: 'fixture-model', mode: 'agent', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'source-schedule',
    request: { prompt: '每天9:00和17:00前提醒我检查工程资料。', model: 'fixture-model', mode: 'agent' } })
  expect(started.kind).toBe('task_started')
  const taskId = 'task' in started ? started.task!.id : ''
  expect(taskId).not.toBe('')
  await barrier
  const flowId = `schedule_${taskId}`, oldFlow = runtime.flowService!.get(flowId)!
  expect(oldFlow, JSON.stringify({ task: repository.get(taskId), tools: repository.operations(taskId, 'tool') })).toBeTruthy()
  const authorityBefore = JSON.stringify(oldFlow.variables.taskSchedule)
  const originalReceipts = repository.operations(taskId, 'schedule_authority').map(row => JSON.stringify(row))
  const readbackBefore = repository.operations(taskId, 'schedule_readback').map(row => JSON.stringify(row))
  expect(originalReceipts).toHaveLength(1); expect(readbackBefore).toHaveLength(1)
  const pause = await api(`/v1/tasks/${taskId}/pause`, 'POST', { expectedRevision: repository.get(taskId)!.revision, idempotencyKey: 'pause-before-config-change' })
  expect(pause.status).toBe(200)
  await expect.poll(() => repository.get(taskId)!.status).toBe('paused')
  const refreshed = await runtime.refreshMcpConfiguration!({ config: KunCapabilitiesConfig.parse({ mcp: configuration('new-package') }).mcp!, environment: {}, revision: 1 })
  expect(refreshed.applied).toBe(true); expect(refreshed.ok).toBe(true)
  const resumed = await api(`/v1/tasks/${taskId}/resume`, 'POST', { expectedRevision: repository.get(taskId)!.revision, idempotencyKey: 'resume-after-config-change' })
  expect(resumed.status).toBe(202)
  await expect.poll(() => repository.get(taskId)!.status, { timeout: 15_000 }).toBe(serverId === 'notes' ? 'waiting_user' : 'completed')
  expect(JSON.stringify(runtime.flowService!.get(flowId)!.variables.taskSchedule)).toBe(authorityBefore)
  expect(repository.operations(taskId, 'schedule_authority').map(row => JSON.stringify(row))).toEqual(originalReceipts)
  const source = repository.get(taskId)!, thread = (await runtime.threadService.get(source.threadId))!
  const newestGrant = thread.turns.at(-1)!.executionGrant!
  expect(newestGrant.connectorIdentityFingerprints![`mcp:${serverId}`]).not.toBe((JSON.parse(authorityBefore).grant as typeof newestGrant).connectorIdentityFingerprints![`mcp:${serverId}`])
  const errors = thread.turns.flatMap(turn => turn.items).filter(item => item.kind === 'tool_result' && item.isError)
  if (serverId === 'notes') {
    expect(errors).toHaveLength(2)
    expect(errors.every(item => item.kind === 'tool_result' && (item.output as { code?: string }).code === 'schedule_authority_changed')).toBe(true)
    expect(repository.operations(taskId, 'schedule_readback').map(row => JSON.stringify(row))).toEqual(readbackBefore)
    expect(source.status).not.toBe('completed')
  } else {
    expect(errors).toHaveLength(0)
    const nextRunAt = runtime.flowService!.repository.getTriggerState(flowId, 'schedule')!.nextRunAt!
    await runtime.flowService!.tickSchedules(new Date(nextRunAt))
    await runtime.flowService!.tickSchedules(new Date(nextRunAt))
    await expect.poll(() => repository.list().filter(task => task.scheduledBy?.scheduleId === flowId).map(task => task.status), { timeout: 15_000 }).toEqual(['completed'])
    const [occurrence] = repository.list().filter(task => task.scheduledBy?.scheduleId === flowId)
    const dueThread = (await runtime.threadService.get(occurrence!.threadId))!
    const dueGrant = dueThread.turns.at(-1)!.executionGrant!
    expect(dueGrant.connectorIdentityFingerprints).not.toHaveProperty(`mcp:${serverId}`)
    expect(dueGrant.allowedProviderIds).not.toContain(`mcp:${serverId}`)
  }
  expect(mcp.invocations).toHaveLength(0)
}, 30_000)
