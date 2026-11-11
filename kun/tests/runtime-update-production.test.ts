import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'
import { FileWorkspaceTrustReader } from '../src/services/workspace-trust-reader.js'

function options(root: string) {
  return { host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'synthetic-update', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}) }
}

describe('update handoff through production Runtime and SQLite', () => {
  it.each([
    { toolName: 'write', prompt: '保存合成资料到 summary.md', arguments: { path: 'summary.md', content: '# 合成资料' } },
    { toolName: 'request_host_shell', prompt: '执行一次合成只读命令检查', arguments: { command: 'printf railwise-synthetic', timeout_seconds: 5, ttl_seconds: 60, idempotency_key: 'synthetic-shell' } }
  ])('stops a real host approval wait for $toolName safely and restores its pending request without an unknown write', async ({ toolName, prompt, arguments: toolArguments }) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-update-approval-')))
    let modelCalls = 0
    const model = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume the synthetic model request. */ }
      modelCalls++
      const chunk = { id: 'synthetic-approval-turn', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'synthetic-write', type: 'function',
        function: { name: toolName, arguments: JSON.stringify(toolArguments) } }] }, finish_reason: 'tool_calls' }] }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    const address = model.address() as { port: number }
    const settings = { ...options(root), baseUrl: `http://127.0.0.1:${address.port}/v1`, approvalPolicy: 'on-request' as const }
    const trust = vi.spyOn(FileWorkspaceTrustReader.prototype, 'get').mockImplementation(async workspace => ({ canonicalRoot: workspace, level: 'workspace-write', revision: 1 }))
    let runtime = await createKunServeRuntime(settings)
    try {
      const origin = await runtime.threadService.create({ workspace: root, mode: 'agent', model: 'unused', approvalPolicy: 'on-request', sandboxMode: 'workspace-write' })
      const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'approval-handoff', request: { prompt } })
      if (started.kind !== 'task_started' || !started.task) throw new Error('Expected a real task Turn')
      const taskId = started.task.id
      await vi.waitFor(() => {
        const current = runtime.taskRepository!.get(taskId)
        expect(runtime.approvalGate.pending(started.turn.threadId), JSON.stringify({ status: current?.status, reason: current?.stalledReason, modelCalls,
          operations: runtime.taskRepository!.operations(taskId, 'tool').map(receipt => ({ status: receipt.status, result: receipt.result })) })).toHaveLength(1)
      }, { timeout: 5_000 })
      const approval = runtime.approvalGate.pending(started.turn.threadId)[0]!
      expect(runtime.taskRepository!.get(taskId)?.status).toBe('waiting_approval')
      expect(runtime.taskRepository!.operations(taskId, 'tool')).toMatchObject([{ status: 'prepared', request: { dispatchTracking: 'host-v1', toolName } }])
      expect(runtime.taskRepository!.operations(taskId, 'host_shell')).toHaveLength(0)
      expect(runtime.updateLifecycle!.snapshot().activeWork).toHaveLength(0)
      await expect(runtime.updateLifecycle!.prepare()).resolves.toMatchObject({ ok: true })
      expect(runtime.approvalGate.get(approval.id)?.status).toBe('pending')
      expect(runtime.taskRepository!.get(taskId)?.status).toBe('waiting_approval')
      expect(runtime.taskRepository!.operations(taskId, 'tool')).toMatchObject([{ status: 'failed', result: { approved: false, item: { output: { code: 'operation_not_dispatched' } } } }])
      expect(runtime.taskRepository!.unsettledOperations(taskId)).toHaveLength(0)
      expect(runtime.taskRepository!.listActiveShellSessions()).toHaveLength(0)
      await expect(stat(join(root, 'summary.md'))).rejects.toMatchObject({ code: 'ENOENT' })
      await runtime.shutdown?.()
      runtime = await createKunServeRuntime(settings)
      expect(runtime.taskRepository!.get(taskId)?.status).toBe('waiting_approval')
      expect(runtime.approvalGate.get(approval.id)?.status).toBe('pending')
      expect(runtime.taskRepository!.unsettledOperations(taskId)).toHaveLength(0)
      expect((await runtime.threadService.get(started.turn.threadId))!.turns).toHaveLength(1)
      expect(modelCalls).toBe(1)
    } finally {
      await runtime.shutdown?.()
      trust.mockRestore()
      model.closeAllConnections()
      await new Promise<void>(resolve => model.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
  it('finds active work beyond user pagination and blocks new dispatch through both routes and services', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-update-runtime-'))
    const runtime = await createKunServeRuntime(options(root))
    try {
      const thread = await runtime.threadService.create({ workspace: root, mode: 'agent', model: 'unused' })
      const template = runtime.taskController!.createWaitingTask({ id: 'waiting', thread, request: { prompt: '合成更新检查' }, reason: '待用户授权' })
      runtime.taskRepository!.create({ ...template, nodes: [], id: 'older-active', status: 'running', updatedAt: '2020-01-01T00:00:00.000Z' })
      for (let i = 0; i < 620; i += 1) runtime.taskRepository!.create({ ...template, nodes: [], id: `finished-${i}`, status: 'completed' })
      const router = buildRouter(runtime)
      const snapshotRoute = router.match('GET', '/v1/runtime/update')!
      const response = await snapshotRoute.handler(new Request('http://runtime/v1/runtime/update', { headers: { Authorization: 'Bearer synthetic-update' } }), { params: {} })
      const snapshot = JSON.parse(String((response as { body: unknown }).body))
      expect(snapshot.activeWork).toEqual([expect.objectContaining({ id: 'older-active' })])
      const prepare = router.match('POST', '/v1/runtime/update/prepare')!
      const prepared = await prepare.handler(new Request('http://runtime/v1/runtime/update/prepare', { method: 'POST', headers: { Authorization: 'Bearer synthetic-update', 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmedSnapshotId: snapshot.snapshotId }) }), { params: {} })
      expect(JSON.parse(String((prepared as { body: unknown }).body)).ok).toBe(true)
      await expect(runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'Do not execute' } })).rejects.toThrow('preparing an update')
      await expect(runtime.flowService!.run('missing', {})).rejects.toThrow('preparing an update')
      const newThread = router.match('POST', '/v1/threads')!
      const blocked = await newThread.handler(new Request('http://runtime/v1/threads', { method: 'POST', headers: { Authorization: 'Bearer synthetic-update' }, body: '{}' }), { params: {} })
      expect((blocked as { status: number }).status).toBe(503)
      expect(runtime.taskRepository!.get('waiting')?.status).toBe('waiting_user')
      expect((await runtime.threadService.get(thread.id))?.turns).toHaveLength(0)
    } finally { await runtime.shutdown?.(); await rm(root, { recursive: true, force: true }) }
  })

  it('preserves waiting and paused work through handoff and restart without creating a Turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-update-waiting-'))
    let runtime = await createKunServeRuntime(options(root))
    try {
      const thread = await runtime.threadService.create({ workspace: root, mode: 'agent', model: 'unused' })
      const waiting = runtime.taskController!.createWaitingTask({ id: 'waiting', thread, request: { prompt: '合成等待事项' }, reason: '待授权' })
      runtime.taskRepository!.create({ ...waiting, nodes: [], id: 'paused', status: 'paused' })
      expect(runtime.updateLifecycle!.snapshot().activeWork).toHaveLength(0)
      await runtime.updateLifecycle!.prepare()
      await runtime.shutdown?.()
      runtime = await createKunServeRuntime(options(root))
      expect(runtime.taskRepository!.get('waiting')?.status).toBe('waiting_user')
      expect(runtime.taskRepository!.get('paused')?.status).toBe('paused')
      expect((await runtime.threadService.get(thread.id))?.turns).toHaveLength(0)
    } finally { await runtime.shutdown?.(); await rm(root, { recursive: true, force: true }) }
  })
})
