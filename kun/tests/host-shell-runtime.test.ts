import { createServer } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
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
})
