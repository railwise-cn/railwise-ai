import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { EncryptedFileFlowSecretStore } from '../src/flow/webhook-security.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { RequiredEffectSchema } from '../src/contracts/tasks.js'
import { dwsTestConfig } from './helpers/dws-identity.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function fixture(capabilities: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'railwise-dws-runtime-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ capabilities }))
  return { root, configPath, capabilities: KunCapabilitiesConfig.parse(capabilities) }
}

function options(f: Awaited<ReturnType<typeof fixture>>, baseUrl = 'http://127.0.0.1:9/v1') {
  return { host: '127.0.0.1', port: 0, dataDir: join(f.root, 'state'), configPath: f.configPath,
    runtimeToken: 'synthetic', apiKey: '', baseUrl, endpointFormat: 'chat_completions' as const,
    model: 'synthetic', approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const,
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const }, capabilities: f.capabilities }
}

describe('production official DingTalk runtime assembly', () => {
  it('persists an install blocker, then resumes with the exact DWS identity-bound catalog and Grant', async () => {
    const f = await fixture({ dws: { authState: 'not_installed' } })
    const catalogs: string[][] = []
    const server = createServer(async (request, response) => {
      let text = ''
      for await (const chunk of request) text += chunk.toString()
      const body = JSON.parse(text) as { tools?: Array<{ function?: { name: string } }> }
      catalogs.push((body.tools ?? []).map(tool => tool.function?.name ?? ''))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'synthetic', choices: [{ index: 0, delta: { content: '尚未执行任何平台操作。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('local synthetic model did not start')
    const runtime = await createKunServeRuntime(options(f, `http://127.0.0.1:${address.port}/v1`))
    cleanup.push(async () => runtime.shutdown?.())
    const origin = await runtime.threadService.create({ workspace: f.root, model: 'synthetic', mode: 'agent' })
    const blocked = await runtime.taskCoordinator!.command({ threadId: origin.id, idempotencyKey: 'install-required', request: { prompt: '查看钉钉待办列表' } })
    expect(blocked).toMatchObject({ kind: 'capability_required', task: { status: 'waiting_user', attempts: 0 }, capability: { provider: 'dingtalk', status: 'not_installed' } })
    expect(catalogs).toHaveLength(0)
    if (blocked.kind !== 'capability_required' || !blocked.task) throw new Error('expected persisted task')
    expect(blocked.task.activeTurnId).toBeUndefined()
    await writeFile(f.configPath, JSON.stringify({ capabilities: { dws: dwsTestConfig } }))
    expect(await runtime.refreshDws?.()).toMatchObject({ provider: 'dingtalk', backend: 'dws', status: 'available' })
    expect(runtime.info().capabilities.dingtalk).toMatchObject({ available: true, scopes: [] })
    const resumed = await runtime.taskCoordinator!.command({ threadId: origin.id, taskId: blocked.task.id,
      resolveAttentionId: blocked.attentionId, intent: 'resume', idempotencyKey: 'resume-connected', request: { prompt: '继续' } })
    expect(resumed).toMatchObject({ kind: 'task_started', task: { id: blocked.task.id } })
    await vi.waitFor(() => expect(catalogs).toHaveLength(1))
    expect(catalogs[0]).toContain('dingtalk_list_tasks')
    expect(catalogs[0]).not.toContain('bash')
    if (resumed.kind !== 'task_started' || !resumed.task) throw new Error('expected started task')
    const thread = await runtime.threadService.get(resumed.task.threadId)
    expect(thread?.turns[0]?.executionGrant).toMatchObject({ connectorIdentityFingerprints: { dingtalk: dwsTestConfig.identityFingerprint }, connectorScopes: [] })
    await writeFile(f.configPath, JSON.stringify({ capabilities: { dws: { ...dwsTestConfig, enabled: false } } }))
    await runtime.refreshDws?.()
    expect((await runtime.toolDiagnostics?.())?.providers.some(provider => provider.id === 'dingtalk')).toBe(false)
  }, 15_000)

  it.each([false, true])('never reads an unknown operation through a different DingTalk backend (original DWS: %s)', async originalDws => {
    const legacy = { enabled: true, credentialRef: 'synthetic-user', unionId: 'synthetic-union', userId: 'synthetic-user',
      allowedWriteUserIds: ['synthetic-user'], userScopes: ['Todo.Todo.Read', 'Todo.Todo.Write'] }
    const f = await fixture({ dws: originalDws ? dwsTestConfig : { authState: 'not_installed' }, ...(originalDws ? {} : { dingtalk: legacy }) })
    if (!originalDws) {
      const key = Buffer.alloc(32, 1)
      vi.stubEnv('WORKWISE_FLOW_SECRET_STORE_KEY', key.toString('base64url'))
      const secrets = new EncryptedFileFlowSecretStore(join(f.root, 'state', 'flow-secrets'), key)
      await secrets.set('synthetic-user', Buffer.from(JSON.stringify({ kind: 'user', accessToken: 'synthetic-token', unionId: 'synthetic-union',
        scopes: legacy.userScopes, expiresAt: new Date(Date.now() + 60_000).toISOString() })))
      vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        if (String(url) === 'https://api.dingtalk.com/v1.0/contact/users/me') return new Response(JSON.stringify({ unionId: 'synthetic-union' }))
        if (String(url) === 'https://api.dingtalk.com/v1.0/todo/users/synthetic-union/tasks/list') return new Response(JSON.stringify({ todoCards: [] }))
        throw new Error('unexpected network request')
      }))
    }
    const runtime = await createKunServeRuntime(options(f))
    cleanup.push(async () => runtime.shutdown?.())
    const thread = await runtime.threadService.create({ workspace: f.root, model: 'synthetic', mode: 'agent' })
    const task = runtime.taskController!.ensureTask({ thread, turnId: 'synthetic-turn', request: { prompt: '处理钉钉待办' } })
    runtime.taskController!.beginAttempt(thread.id, 'synthetic-turn')
    runtime.taskController!.confirmEffectScope('synthetic-turn', 0, 'scope-confirmation', [RequiredEffectSchema.parse({ provider: 'dingtalk', operation: 'complete', target: 'todo-1' })])
    const grant = ExecutionGrantSchema.parse({
      id: 'original-grant', taskId: task.id, threadId: thread.id, turnId: 'synthetic-turn', workspaceRoot: f.root,
      workspaceTrust: 'workspace-write', agentTrust: 'full-access', sandboxMode: 'workspace-write', approvalPolicy: 'auto',
      networkAllowlist: ['https://api.dingtalk.com', 'https://mcp.dingtalk.com'],
      ...(originalDws ? { connectorIdentityFingerprints: { dingtalk: dwsTestConfig.identityFingerprint } } : {}),
      workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'original-grant', issuedAt: new Date().toISOString()
    })
    const args = { taskId: 'todo-1' }
    const operation = runtime.taskController!.beginToolOperation('synthetic-turn', { callId: 'write', toolName: 'dingtalk_complete_task', providerId: 'dingtalk', arguments: args }, grant)!
    runtime.taskController!.recordToolApproval(operation.token, operation.key, { toolName: 'dingtalk_complete_task', requestHash: createHash('sha256').update(JSON.stringify(args)).digest('hex') })
    runtime.taskController!.finishToolOperation(operation.token, operation.key)
    const receipt = runtime.taskRepository!.operation(task.id, operation.key)!
    await writeFile(f.configPath, JSON.stringify({ capabilities: { dws: originalDws ? { authState: 'needs_login', executablePath: '/managed/dws' } : dwsTestConfig } }))
    await runtime.refreshDws?.()
    const before = runtime.taskRepository!.get(task.id)!
    expect(await runtime.verifyTaskOperationReceipt!(task.id, receipt.id, { expectedRevision: before.revision, idempotencyKey: 'verify-original' })).toMatchObject({
      status: 'outcome_unknown', errorCode: 'connector_backend_changed'
    })
    expect(runtime.taskRepository!.operation(task.id, operation.key)?.resolution).toBeUndefined()
    expect(runtime.taskRepository!.operations(task.id, 'tool')).toHaveLength(1)
  })

  it('retains legacy HTTP tools when DWS is missing and correctly removes them on a legacy disable', async () => {
    const legacy = { enabled: true, credentialRef: 'synthetic-user', unionId: 'synthetic-union', userScopes: ['Todo.Todo.Read'] }
    const f = await fixture({ dingtalk: legacy })
    const key = Buffer.alloc(32, 1)
    vi.stubEnv('WORKWISE_FLOW_SECRET_STORE_KEY', key.toString('base64url'))
    const secrets = new EncryptedFileFlowSecretStore(join(f.root, 'state', 'flow-secrets'), key)
    await secrets.set('synthetic-user', Buffer.from(JSON.stringify({ kind: 'user', accessToken: 'synthetic-token', unionId: 'synthetic-union',
      scopes: ['Todo.Todo.Read'], expiresAt: new Date(Date.now() + 60_000).toISOString() })))
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === 'https://api.dingtalk.com/v1.0/contact/users/me') return new Response(JSON.stringify({ unionId: 'synthetic-union' }))
      if (String(url) === 'https://api.dingtalk.com/v1.0/todo/users/synthetic-union/tasks/list') return new Response(JSON.stringify({ todoCards: [] }))
      throw new Error('unexpected network request')
    })
    vi.stubGlobal('fetch', fetcher)
    const runtime = await createKunServeRuntime(options(f))
    cleanup.push(async () => runtime.shutdown?.())
    expect(runtime.info().capabilities.dingtalk).toMatchObject({ available: true, scopes: ['Todo.Todo.Read'] })
    expect((await runtime.toolDiagnostics?.())?.providers.find(provider => provider.id === 'dingtalk')).toMatchObject({ available: true })
    await writeFile(f.configPath, JSON.stringify({ capabilities: { dingtalk: { ...legacy, enabled: false } } }))
    await runtime.refreshDingTalk?.()
    expect((await runtime.toolDiagnostics?.())?.providers.some(provider => provider.id === 'dingtalk')).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
