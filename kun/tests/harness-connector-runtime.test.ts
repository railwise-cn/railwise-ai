import { createServer } from 'node:http'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { FileThreadStore } from '../src/adapters/file/file-thread-store.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

describe('production managed Lark connector task path', () => {
  it('blocks missing authorization, checks write scopes, refreshes config and hides Lark in ordinary chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-harness-lark-runtime-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const advertisedCatalogs: string[][] = []
    const modelServer = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> }
      advertisedCatalogs.push((payload.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? '').filter(Boolean))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: '已检查待办列表。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { modelServer.close(() => resolve()); modelServer.closeAllConnections() }))
    const address = modelServer.address()
    if (!address || typeof address === 'string') throw new Error('model fixture not listening')
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify({ capabilities: { lark: {
      enabled: true, authState: 'needs_login', executablePath: '/usr/bin/true', brand: 'feishu'
    } } }))
    const runtime = await createKunServeRuntime({
      host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), configPath, runtimeToken: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: '', endpointFormat: 'chat_completions',
      model: 'fixture', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false,
      insecure: false, storage: { backend: 'file' },
      capabilities: KunCapabilitiesConfig.parse({ lark: {
        enabled: true, authState: 'needs_login', executablePath: '/usr/bin/true', brand: 'feishu'
      } })
    })
    cleanup.push(async () => runtime.shutdown?.())
    const origin = await runtime.threadService.create({ workspace: root, model: 'fixture', mode: 'agent' })
    const blocked = await runtime.taskCoordinator!.command({
      threadId: origin.id, idempotencyKey: 'external-start', request: { prompt: '帮我处理飞书待办事项' }
    })
    expect(blocked).toMatchObject({
      kind: 'capability_required', task: { status: 'waiting_user', attempts: 0 },
      capability: { provider: 'lark', status: 'needs_authorization' }
    })
    if (blocked.kind !== 'capability_required' || !blocked.task) throw new Error('expected persistent blocked task')
    expect(blocked.task.activeTurnId).toBeUndefined()
    expect(runtime.taskRepository!.attention(blocked.attentionId!)).toMatchObject({ status: 'pending', taskId: blocked.task.id })
    expect((await runtime.toolDiagnostics?.())?.providers.some(item => item.id === 'lark-cli')).toBe(false)

    await writeFile(configPath, JSON.stringify({ capabilities: { lark: {
      enabled: true, authState: 'installed', executablePath: '/usr/bin/true', brand: 'feishu', scopes: ['task:task:read']
    } } }))
    await runtime.refreshLark?.()
    expect((await runtime.toolDiagnostics?.())?.providers.some(item => item.id === 'lark-cli' && item.available)).toBe(true)
    const missingWriteScope = await runtime.taskCoordinator!.command({
      threadId: origin.id, taskId: blocked.task.id, resolveAttentionId: blocked.attentionId,
      intent: 'resume', idempotencyKey: 'resume-read-only', request: { prompt: '继续读取飞书待办' }
    })
    expect(missingWriteScope).toMatchObject({
      kind: 'capability_required',
      capability: { errorCode: 'connector_scope_missing', requiredScopes: ['task:task:read', 'task:task:write'] }
    })

    await writeFile(configPath, JSON.stringify({ capabilities: { lark: {
      enabled: true, authState: 'installed', executablePath: '/usr/bin/true', brand: 'feishu',
      scopes: ['task:task:read', 'task:task:write']
    } } }))
    await runtime.refreshLark?.()
    const resumed = await runtime.taskCoordinator!.command({
      threadId: origin.id, taskId: blocked.task.id, resolveAttentionId: blocked.attentionId,
      intent: 'resume', idempotencyKey: 'resume-after-login', request: { prompt: '继续读取飞书待办' }
    })
    expect(resumed).toMatchObject({ kind: 'task_started', task: { id: blocked.task.id } })

    const chat = await runtime.taskCoordinator!.command({
      threadId: origin.id, intent: 'auto', idempotencyKey: 'ordinary-chat',
      request: { prompt: '如何使用飞书审批流程？' }
    })
    expect(chat.kind).toBe('chat_started')
    await vi.waitFor(() => expect(advertisedCatalogs).toHaveLength(2), { timeout: 5_000 })
    expect(advertisedCatalogs[0]).toContain('lark_task_list')
    expect(advertisedCatalogs[1]).not.toContain('lark_task_list')
  }, 15_000)

  it('keeps a child Agent inside the parent Turn provider and connector scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-harness-child-scope-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const catalogs: string[][] = []
    let requests = 0
    let runtime: Awaited<ReturnType<typeof createKunServeRuntime>>
    const configPath = join(root, 'config.json')
    const modelServer = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string }; name?: string }> }
      catalogs.push((payload.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? '').filter(Boolean))
      requests += 1
      if (requests === 1) {
        await writeFile(configPath, JSON.stringify({ capabilities: { lark: {
          enabled: true, authState: 'installed', executablePath: '/usr/bin/true', brand: 'feishu', scopes: ['task:task:read']
        } } }))
        await runtime.refreshLark?.()
      }
      const delta = requests === 1
        ? { tool_calls: [{ index: 0, id: 'delegate-child', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ label: 'review', prompt: 'Summarize the request without changing anything.', workspace: root }) } }] }
        : { content: 'The delegated review is complete.' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: `fixture-${requests}`, choices: [{ index: 0, delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { modelServer.close(() => resolve()); modelServer.closeAllConnections() }))
    const address = modelServer.address()
    if (!address || typeof address === 'string') throw new Error('model fixture not listening')
    runtime = await createKunServeRuntime({
      host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), configPath, runtimeToken: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: '', endpointFormat: 'chat_completions',
      model: 'fixture', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false,
      insecure: false, storage: { backend: 'file' },
      capabilities: KunCapabilitiesConfig.parse({
        lark: { enabled: true, authState: 'installed', executablePath: '/usr/bin/true', brand: 'feishu', scopes: ['task:task:read', 'task:task:write'] },
        subagents: { enabled: true, maxParallel: 1, maxChildRuns: 2 }
      })
    })
    cleanup.push(async () => runtime.shutdown?.())
    const origin = await runtime.threadService.create({ workspace: root, model: 'fixture', mode: 'agent' })
    const started = await runtime.taskCoordinator!.command({
      threadId: origin.id, intent: 'new', idempotencyKey: 'external-with-child',
      request: { prompt: 'Use the selected provider and report verified results.', displayText: '帮我处理飞书待办事项' }
    })
    expect(started.kind).toBe('task_started')
    await vi.waitFor(() => expect(catalogs).toHaveLength(3), { timeout: 10_000 })
    expect(catalogs[0]).toContain('lark_task_list')
    expect(catalogs[0]).toContain('delegate_task')
    expect(catalogs[1]).not.toContain('lark_task_list')
    expect(catalogs[1]).not.toContain('lark_task_complete')
    expect(catalogs[1]).not.toContain('request_host_shell')
    expect(catalogs[2]).toContain('lark_task_list')
    expect(catalogs[2]).not.toContain('lark_task_complete')
    const childStore = new FileThreadStore({ dataDir: join(root, 'state', 'child-sessions') })
    const children = await childStore.list({ includeSide: true })
    expect(children).toHaveLength(1)
    const child = await childStore.get(children[0]!.id)
    const childGrant = child?.turns[0]?.executionGrant
    expect(childGrant?.connectorScopes).toEqual(['task:task:read'])
    expect(childGrant?.networkAllowlist).toEqual(['https://open.feishu.cn'])
    expect(childGrant?.pathAllowlist).toEqual([await realpath(root)])
    expect(childGrant?.externalTargets).toEqual([])
  }, 20_000)
})
