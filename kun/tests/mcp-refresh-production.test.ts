import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startKunServe } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'

it('hot-applies the trusted MCP snapshot through real HTTP without restarting a waiting task or mutating Runtime environment', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-mcp-refresh-')))
  const observedAuthorization: string[] = []
  let toolCalls = 0
  const mcp = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: string | number; method: string; params?: { protocolVersion?: string } }
    if (message.id === undefined) { response.writeHead(202); response.end(); return }
    observedAuthorization.push(String(request.headers.authorization ?? ''))
    const result = message.method === 'initialize' ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-mcp', version: '1' } }
      : message.method === 'tools/list' ? { tools: [{ name: 'read', description: 'Read a synthetic fixture', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
      : { content: [{ type: 'text', text: 'synthetic fixture' }] }
    if (message.method === 'tools/call') toolCalls++
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve))
  const address = mcp.address() as { port: number }
  const runtime = await startKunServe({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-main-token',
    apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused-synthetic', approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
  const endpoint = `http://127.0.0.1:${runtime.port}/v1/runtime/mcp-config`
  const previousEnvironment = process.env.WORKWISE_MCP_SECRET_SYNTHETIC_REFRESH
  try {
    const origin = await runtime.runtime.threadService.create({ workspace: root, model: 'unused-synthetic', mode: 'agent' })
    const waiting = await runtime.runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'waiting', request: { prompt: '帮我处理钉钉待办' } })
    if (waiting.kind !== 'capability_required' || !waiting.task) throw new Error('Expected a waiting task')
    const startedAt = runtime.runtime.info().startedAt
    const config = KunCapabilitiesConfig.parse({ mcp: { enabled: true, search: { enabled: false }, servers: { synthetic: { enabled: true,
      transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mcp`, trustScope: 'user',
      headers: { Authorization: '${WORKWISE_MCP_SECRET_SYNTHETIC_REFRESH}' }, toolPolicy: { allowedTools: ['read'], readOnlyTools: ['read'] }
    } } } }).mcp
    const request = { config, environment: { WORKWISE_MCP_SECRET_SYNTHETIC_REFRESH: 'Bearer synthetic-credential' }, revision: 1 }
    expect((await fetch(endpoint, { method: 'POST', body: JSON.stringify(request) })).status).toBe(401)
    const apply = async (body: unknown) => fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer synthetic-main-token', 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const response = await apply(request)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, connectedServers: 1, toolCount: 1 })
    expect(runtime.runtime.info().capabilities?.mcp).toMatchObject({ available: true, connectedServers: 1, toolCount: 1 })
    const context = { threadId: origin.id, turnId: 'synthetic-read', workspace: root, approvalPolicy: 'on-request' as const,
      abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' as const }
    const result = await runtime.runtime.toolHost!.execute({ callId: 'synthetic-read', toolName: 'mcp_synthetic_read', arguments: {} }, context)
    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(toolCalls).toBe(1)
    expect(observedAuthorization.length).toBeGreaterThan(0)
    expect(observedAuthorization.every(value => value === 'Bearer synthetic-credential')).toBe(true)
    expect(process.env.WORKWISE_MCP_SECRET_SYNTHETIC_REFRESH).toBe(previousEnvironment)
    const disabled = { ...config, servers: { synthetic: { ...config.servers.synthetic!, enabled: false } } }
    expect(await (await apply({ config: disabled, environment: {}, revision: 2 })).json()).toMatchObject({ ok: true, connectedServers: 0, toolCount: 0 })
    expect((await runtime.runtime.toolHost!.listTools(context)).some(tool => tool.name === 'mcp_synthetic_read')).toBe(false)
    expect(runtime.runtime.info().startedAt).toBe(startedAt)
    expect(runtime.runtime.taskRepository!.get(waiting.task.id)?.status).toBe('waiting_user')
    expect((await runtime.runtime.threadService.get(waiting.task.threadId))!.turns).toHaveLength(0)
  } finally {
    runtime.server.closeAllConnections()
    await runtime.close()
    mcp.closeAllConnections()
    await new Promise<void>(resolve => mcp.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
