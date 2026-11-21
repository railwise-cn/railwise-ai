import { createServer } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime, startKunServe, type KunServeRuntimeOptions } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { TaskRunRepository } from '../src/services/task-run-repository.js'
import { processIdentity } from '../src/services/process-identity.js'

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

  it.each(['resume', 'pause', 'cancel', 'resume-with-stale-lease', 'blocked-skill'] as const)('handles a detached in-chat approval after a Runtime restart (%s)', async action => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-host-approval-restart-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const bridgeScript = join(root, 'scheduler-bridge.cjs')
    await writeFile(bridgeScript, `
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line)
        if (request.id === undefined) return
        const result = request.method === 'initialize' ? {
          protocolVersion: request.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'fixture-scheduler', version: '1' }
        } : { tools: [{ name: 'gui_schedule_list', description: 'Fixture', inputSchema: { type: 'object' } }] }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
      })
    `)
    const bridgeCapabilities = (generation: string) => KunCapabilitiesConfig.parse({ mcp: { enabled: true, servers: {
      gui_schedule: { transport: 'stdio', command: process.execPath, args: [bridgeScript, generation], trustScope: 'user' }
    } } })
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
      sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: bridgeCapabilities('before-restart') }
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

    let oldProcess: ChildProcess | undefined
    const stopOldProcess = async () => {
      if (!oldProcess || oldProcess.exitCode !== null || oldProcess.signalCode !== null) return
      const exited = once(oldProcess, 'exit')
      oldProcess.kill('SIGTERM')
      await exited
    }
    if (action === 'resume-with-stale-lease') {
      // Recreate the rows left by an abruptly exited Runtime, with a real
      // process identity that is initially still alive and may not be stolen.
      oldProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { stdio: 'ignore', windowsHide: true })
      cleanup.push(stopOldProcess)
      await once(oldProcess, 'spawn')
      expect(oldProcess.pid).toBeTypeOf('number')
      const identity = processIdentity(oldProcess.pid)
      expect(identity).not.toBeNull()
      const saved = new TaskRunRepository(join(options.dataDir, 'tasks.sqlite3'))
      try {
        const attempt = saved.execution.latestAttempt(taskId)!
        saved.connection().prepare('UPDATE execution_attempts SET data_json=? WHERE id=?').run(
          JSON.stringify({ ...attempt, process: identity, status: 'running', finishedAt: undefined }), attempt.executionId)
        const now = new Date()
        expect(saved.acquireLease(taskId, attempt.ownerId, now.toISOString(), new Date(now.getTime() + 60_000).toISOString())).not.toBeNull()
      } finally { saved.close() }
    }

    const restarted = await startKunServe({ ...options, capabilities: bridgeCapabilities('after-restart') })
    cleanup.push(() => restarted.close())
    const repository = restarted.runtime.taskRepository!
    if (action === 'resume') {
      expect(repository.execution.latestAttempt(taskId)?.status).toBe('cancelled')
      const stoppedThread = await restarted.runtime.threadService.get(started.turn.threadId)
      expect(stoppedThread?.turns.find(turn => turn.id === started.turn.turnId)?.status).toBe('aborted')
    }
    expect(restarted.runtime.approvalGate.get(requestId)).toMatchObject({ status: 'pending' })
    expect(restarted.runtime.approvalGate.hasLiveResolver?.(requestId)).toBe(false)
    const approve = () => fetch(`http://127.0.0.1:${restarted.port}/v1/approvals/${requestId}`, {
      method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: '{"decision":"allow"}'
    })

    if (action === 'pause' || action === 'cancel') {
      await restarted.runtime.taskControlService!.mutate(taskId, action, { expectedRevision: repository.get(taskId)!.revision, idempotencyKey: action })
      expect((await approve()).status).toBe(409)
      expect(repository.get(taskId)?.status).toBe(action === 'pause' ? 'paused' : 'cancelled')
      expect(repository.operations(taskId, 'resume')).toHaveLength(0)
      expect(repository.operations(taskId, 'host_shell')).toHaveLength(0)
      expect(calls).toBe(1)
      return
    }

    if (action === 'blocked-skill') {
      vi.spyOn(restarted.runtime.turnService, 'startTurn').mockRejectedValueOnce(Object.assign(new Error('Fixture skill is no longer available'), { code: 'skill_unavailable' }))
      expect((await approve()).status).toBe(200)
      expect(repository.get(taskId)).toMatchObject({ status: 'stalled', blockCode: 'execution_failed', stalledReason: '授权已保存。原技能或连接器已不可用，请检查后从本对话继续。' })
      expect(repository.pendingOutbox('human_answer')).toEqual([])
      expect(repository.operations(taskId, 'host_shell')).toEqual([])
      expect(calls).toBe(1)
      return
    }

    const decisions = await Promise.all([approve(), approve()])
    expect(decisions.map(response => response.status)).toEqual([200, 200])
    expect(await decisions[0]!.json()).toMatchObject({ approvalId: requestId, status: 'allowed' })
    if (action === 'resume-with-stale-lease') {
      expect(repository.get(taskId)?.status).toBe('waiting_approval')
      expect(repository.operations(taskId, 'resume')).toHaveLength(0)
      expect(repository.pendingOutbox('human_answer')).toHaveLength(1)
      expect(calls).toBe(1)
      await stopOldProcess()
    }
    await vi.waitFor(async () => expect(await readFile(join(root, 'shell-count.txt'), 'utf8')).toBe('1'), { timeout: 5000 })
    await vi.waitFor(() => expect(repository.get(taskId)?.status).toBe('completed'), { timeout: 5000 })
    expect(repository.operations(taskId, 'resume')).toHaveLength(1)
    expect(repository.operations(taskId, 'approval_transfer')).toHaveLength(1)
    expect(repository.operations(taskId, 'host_shell')).toMatchObject([{ status: 'succeeded' }])
    expect(repository.pendingOutbox('human_answer')).toEqual([])
    expect(repository.execution.commandReceipt(origin.id, `human-answer:${requestId}`)).toBeNull()
    const bridgeFingerprints = repository.operations(taskId, 'tool').filter(operation => operation.request?.toolName === 'request_host_shell')
      .map(operation => ExecutionGrantSchema.parse(operation.request?.executionGrant).connectorIdentityFingerprints?.['mcp:gui_schedule'])
    expect(bridgeFingerprints).toHaveLength(2)
    expect(bridgeFingerprints.every(Boolean)).toBe(true)
    expect(new Set(bridgeFingerprints).size).toBe(2)
    expect(restarted.runtime.approvalGate.pending()).toEqual([])
    expect(calls).toBe(3)
  }, 25_000)
})
