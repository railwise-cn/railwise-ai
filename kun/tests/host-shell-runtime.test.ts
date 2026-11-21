import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime, startKunServe, type KunServeRuntimeOptions } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

describe('production one-command host authority', () => {
  it('persists approval and server Turn authorization before running the existing Shell adapter once', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-host-shell-runtime-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const catalogs: string[][] = []
    const command = `"${process.execPath.replaceAll('"', '\\"')}" -e "require('fs').appendFileSync('shell-count.txt','1');process.stdout.write('synthetic-check-ok')"`
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk.toString()
      const body = JSON.parse(raw) as { tools?: Array<{ function?: { name?: string }; name?: string }> }
      catalogs.push((body.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? ''))
      const first = catalogs.length === 1
      const delta = first ? { tool_calls: [{ index: 0, id: 'exact-shell-proposal', type: 'function', function: {
        name: 'request_host_shell', arguments: JSON.stringify({ command, timeout_seconds: 10, ttl_seconds: 60, idempotency_key: 'synthetic-once' })
      } }] } : { content: '本地合成检查已执行，真实输出为 synthetic-check-ok。' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: `fixture-${catalogs.length}`, choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
    const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: '', endpointFormat: 'chat_completions', model: 'fixture', approvalPolicy: 'auto',
      sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
    cleanup.push(async () => runtime.shutdown?.())
    const origin = await runtime.threadService.create({ workspace: root, model: 'fixture', mode: 'agent' })
    const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'shell-fixture', request: { prompt: '运行一次本地合成检查命令，并报告真实输出。', reasoningEffort: 'off' } })
    if (started.kind !== 'task_started' || !started.task) throw new Error('expected a real task')
    await vi.waitFor(() => expect(runtime.approvalGate.pending()).toHaveLength(1), { timeout: 5_000 })
    expect(catalogs[0]).toContain('request_host_shell')
    expect(catalogs[0]).not.toContain('bash')
    await expect(readFile(join(root, 'shell-count.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runtime.taskRepository!.get(started.task.id)).toMatchObject({ status: 'waiting_approval' })
    const approval = runtime.approvalGate.pending()[0]!
    expect(approval.summary).toContain('workspace trust remains unchanged')
    expect(approval.summary).toContain(`Workspace (JSON): ${JSON.stringify(root)}`)
    runtime.approvalGate.decide(approval.id, 'allow')
    await runtime.runTurn(started.turn.threadId, started.turn.turnId)
    await vi.waitFor(async () => expect(await readFile(join(root, 'shell-count.txt'), 'utf8')).toBe('1'))
    const turn = (await runtime.threadService.get(started.turn.threadId))!.turns.find(item => item.id === started.turn.turnId)!
    // The synthetic folder has no trust record. The one-command approval must not elevate it.
    expect(turn.executionGrant).toMatchObject({ workspaceTrust: 'read-only', sandboxMode: 'read-only' })
    expect(turn.hostShellAuthorizations).toMatchObject([{ approvalId: approval.id, workspaceRoot: root, executionGrantId: turn.executionGrant!.id, turnId: turn.id }])
    expect(runtime.taskRepository!.operations(started.task.id, 'host_shell')).toMatchObject([{ status: 'succeeded', result: { shell: { output: { status: 'completed', output: 'synthetic-check-ok', exit_code: 0 } } } }])
    expect(catalogs).toHaveLength(2)
  }, 15_000)

  it.each(['resume', 'pause', 'cancel'] as const)('handles a detached in-chat approval after a Runtime restart (%s)', async action => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-host-approval-restart-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const command = `"${process.execPath.replaceAll('"', '\\"')}" -e "require('fs').appendFileSync('shell-count.txt','1');process.stdout.write('synthetic-check-ok')"`
    const args = { command, timeout_seconds: 10, ttl_seconds: 60, idempotency_key: 'same-reviewed-command' }
    let calls = 0
    let releaseFirstReply!: () => void
    const firstReplyReady = new Promise<void>(resolve => { releaseFirstReply = resolve })
    const model = createServer(async (request, response) => {
      for await (const _ of request) { /* drain request */ }
      const index = ++calls
      if (index === 1) await firstReplyReady
      const proposes = index < 3
      const delta = proposes ? { tool_calls: [{ index: 0, id: `shell-proposal-${index}`, type: 'function', function: {
        name: 'request_host_shell', arguments: JSON.stringify(args)
      } }] } : { content: '已核对，合成检查的真实输出为 synthetic-check-ok。' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: `fixture-${index}`, choices: [{ index: 0, delta, finish_reason: proposes ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
    const address = model.address(); if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
    const options: KunServeRuntimeOptions = { host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: '', endpointFormat: 'chat_completions', model: 'fixture', approvalPolicy: 'auto',
      sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) }
    const first = await startKunServe(options)
    let firstClosed = false
    cleanup.push(async () => { if (!firstClosed) await first.close() })
    const origin = await first.runtime.threadService.create({ workspace: root, model: 'fixture', mode: 'agent' })
    const started = await first.runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'shell-restart-fixture',
      request: { prompt: '运行一次本地合成检查命令，并报告真实输出。', reasoningEffort: 'off' } })
    if (started.kind !== 'task_started' || !started.task) throw new Error('expected a real task')
    const taskId = started.task.id
    let availableWhenAnnounced: boolean | undefined
    const unsubscribe = first.runtime.eventBus.subscribe(started.turn.threadId, event => {
      if (event.kind === 'approval_requested') availableWhenAnnounced = first.runtime.approvalGate.get(event.approvalId)?.status === 'pending'
    })
    releaseFirstReply()
    await vi.waitFor(() => expect(availableWhenAnnounced).toBe(true), { timeout: 5000 })
    unsubscribe()
    await vi.waitFor(() => expect(first.runtime.approvalGate.pending()).toHaveLength(1), { timeout: 5000 })
    const requestId = first.runtime.approvalGate.pending()[0]!.id
    await expect(readFile(join(root, 'shell-count.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await first.close()
    firstClosed = true

    const restarted = await startKunServe(options)
    cleanup.push(() => restarted.close())
    const repository = restarted.runtime.taskRepository!
    expect(restarted.runtime.approvalGate.get(requestId)).toMatchObject({ status: 'pending' })
    expect(restarted.runtime.approvalGate.hasLiveResolver?.(requestId)).toBe(false)
    const approve = () => fetch(`http://127.0.0.1:${restarted.port}/v1/approvals/${requestId}`, {
      method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: '{"decision":"allow"}'
    })

    if (action !== 'resume') {
      await restarted.runtime.taskControlService!.mutate(taskId, action, { expectedRevision: repository.get(taskId)!.revision, idempotencyKey: action })
      expect((await approve()).status).toBe(409)
      expect(repository.get(taskId)?.status).toBe(action === 'pause' ? 'paused' : 'cancelled')
      expect(repository.operations(taskId, 'resume')).toHaveLength(0)
      expect(repository.operations(taskId, 'host_shell')).toHaveLength(0)
      expect(calls).toBe(1)
      return
    }

    const decisions = await Promise.all([approve(), approve()])
    expect(decisions.map(response => response.status)).toEqual([200, 200])
    expect(await decisions[0]!.json()).toMatchObject({ approvalId: requestId, status: 'allowed' })
    await vi.waitFor(async () => expect(await readFile(join(root, 'shell-count.txt'), 'utf8')).toBe('1'), { timeout: 5000 })
    await vi.waitFor(() => expect(repository.get(taskId)?.status).toBe('completed'), { timeout: 5000 })
    expect(repository.operations(taskId, 'resume')).toHaveLength(1)
    expect(repository.operations(taskId, 'approval_transfer')).toHaveLength(1)
    expect(repository.operations(taskId, 'host_shell')).toMatchObject([{ status: 'succeeded' }])
    expect(restarted.runtime.approvalGate.pending()).toEqual([])
    expect(calls).toBe(3)
  }, 25_000)
})
