import { createServer } from 'node:http'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { TaskDeliveryCoordinator } from '../src/delivery/runtime.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
})

async function settleDispatch(runtime: Awaited<ReturnType<typeof createKunServeRuntime>>): Promise<void> {
  // Flow.run returns before its adapter has finished creating the task/Turn.
  // Join those producers before checking their checkpoint or closing SQLite.
  await runtime.flowService!.executor.awaitIdle()
  await runtime.flowService!.awaitSourceDispatch()
  await runtime.turnService.awaitPendingStarts()
  await runtime.taskCoordinator!.flushCommandMessages()
}

async function fixture(parallel = false) {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-flow-retry-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let failModel = true, modelCalls = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the synthetic protocol request. */ }
    modelCalls++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: `synthetic-${modelCalls}`, choices: [{ index: 0, delta: { content: '合成资料已汇总。' }, finish_reason: failModel ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'state'),
    workspaceTrustPath: join(root, 'trust.json'), runtimeToken: 'synthetic-only', apiKey: '',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'synthetic-protocol',
    tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}), approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => { await settleDispatch(runtime); await runtime.shutdown?.() })
  let coordinator = new TaskDeliveryCoordinator(runtime)
  const policy = { timeoutMs: 10_000, retryAttempts: 0, retryBackoffMs: 0, concurrencyLimit: parallel ? 2 : 1,
    errorBehavior: 'fail' as const, resumable: true, breakpoint: false }
  const definition = { schemaVersion: 1 as const, id: 'synthetic-flow', name: '合成流程重试', description: '', workspace: root, variables: {},
    nodes: [
      { id: 'start', type: 'manual_trigger', label: '开始', position: { x: 0, y: 0 }, bindings: {}, config: {}, policy, disabled: false },
      { id: 'agent', type: 'agent', label: '汇总', position: { x: 200, y: 0 }, bindings: {}, config: { prompt: '请汇总这段合成资料。' }, policy, disabled: false }
    ], edges: [{ id: 'start-agent', sourceNodeId: 'start', sourcePortId: 'output', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' as const }] }
  if (parallel) {
    definition.nodes.push({ ...definition.nodes[1]!, id: 'second-agent', label: '并行汇总', config: { prompt: '请独立汇总另一段合成资料。' } })
    definition.edges.push({ ...definition.edges[0]!, id: 'start-second', targetNodeId: 'second-agent' })
  }
  runtime.flowService!.create(definition)
  expect(runtime.flowService!.publish(definition.id).published).toBe(true)
  const flow = await runtime.flowService!.run(definition.id, {})
  await settleDispatch(runtime)
  expect(runtime.flowService!.repository.getRun(flow.id)?.status).toBe('paused')
  await expect.poll(() => runtime.taskRepository!.list({ workspaceRoot: root }).filter(task => task.status === 'failed').length).toBe(parallel ? 2 : 1)
  const source = runtime.taskRepository!.get(String(runtime.flowService!.repository.getRun(flow.id)!.checkpoint!.taskId))!
  await expect.poll(async () => (await runtime.threadService.get(source.threadId))?.turns[0]?.status).not.toBe('running')
  const retry = async (task = source) => {
    failModel = false
    return runtime.taskControlService!.mutate(task.id, 'retry', { expectedRevision: runtime.taskRepository!.get(task.id)!.revision, idempotencyKey: 'retry-flow-task' })
  }
  const restart = async () => {
    await settleDispatch(runtime)
    await runtime.shutdown?.()
    runtime = await createKunServeRuntime(options)
    coordinator = new TaskDeliveryCoordinator(runtime)
  }
  return { get runtime() { return runtime }, get coordinator() { return coordinator }, source, flow, definition, retry, restart, modelCalls: () => modelCalls }
}

describe('Flow task retry through the production Runtime and synthetic model protocol', () => {
  it.each([false, true])('tracks the retried execution when old failure outbox was acknowledged=%s', async acknowledged => {
    const f = await fixture()
    if (acknowledged) {
      await f.coordinator.tick()
      expect(f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('failed')
      expect(f.runtime.flowService!.repository.pendingOutbox('delivery_task')).toHaveLength(0)
    }
    const retried = await f.retry()
    await expect.poll(() => f.runtime.taskRepository!.get(retried.task.id)?.status).toBe('completed')
    await f.coordinator.tick()
    await expect.poll(() => f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('succeeded')
    const completed = f.runtime.flowService!.repository.getRun(f.flow.id)!
    expect(completed.output).toMatchObject({ agent: { taskId: retried.task.id } })
    expect(f.runtime.taskRepository!.list({ workspaceRoot: f.source.workspaceRoot })).toHaveLength(2)
    const calls = f.modelCalls()
    await f.coordinator.tick()
    expect(f.modelCalls()).toBe(calls)
    expect(f.runtime.taskRepository!.get(f.source.id)?.status).toBe('failed')
  })

  it('recovers a committed Flow rebind after Task outbox acknowledgement is interrupted and Runtime restarts', async () => {
    const f = await fixture()
    await f.coordinator.tick()
    const retried = await f.retry()
    await expect.poll(() => f.runtime.taskRepository!.get(retried.task.id)?.status).toBe('completed')
    const acknowledgement = vi.spyOn(f.runtime.taskRepository!, 'acknowledgeOutbox').mockImplementationOnce(() => { throw new Error('Synthetic crash after Flow commit') })
    await f.coordinator.tick()
    acknowledgement.mockRestore()
    expect(f.runtime.taskRepository!.pendingOutbox('flow_task_retry')).toHaveLength(1)
    expect(f.runtime.flowService!.repository.pendingOutbox('delivery_task')).toHaveLength(1)
    const calls = f.modelCalls()
    await f.restart()
    await f.coordinator.tick()
    await expect.poll(() => f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('succeeded')
    await f.coordinator.tick()
    expect(f.runtime.taskRepository!.pendingOutbox('flow_task_retry')).toHaveLength(0)
    expect(f.runtime.flowService!.repository.pendingOutbox('delivery_task')).toHaveLength(0)
    expect(f.runtime.taskRepository!.list({ workspaceRoot: f.source.workspaceRoot })).toHaveLength(2)
    expect(f.modelCalls()).toBe(calls)
  })

  it.each(['rootTaskId', 'flowId'] as const)('refuses a retry whose %s no longer matches the original Flow', async field => {
    const f = await fixture()
    await f.coordinator.tick()
    const retried = await f.retry()
    await expect.poll(() => f.runtime.taskRepository!.get(retried.task.id)?.status).toBe('completed')
    const latest = f.runtime.taskRepository!.get(retried.task.id)!
    f.runtime.taskRepository!.update(latest.id, latest.revision, task => ({ ...task, [field]: 'unrelated-synthetic-owner' }))
    const calls = f.modelCalls()
    await f.coordinator.tick()
    expect(f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('failed')
    expect(f.runtime.taskRepository!.pendingOutbox('flow_task_retry')).toHaveLength(0)
    expect(f.runtime.taskRepository!.operations(retried.task.id, 'flow_retry_delivery')).toMatchObject([{ status: 'failed' }])
    expect(f.modelCalls()).toBe(calls)
  })

  it('allows retry after the user resumed a Flow whose same task had already failed', async () => {
    const f = await fixture()
    await f.runtime.flowService!.resume(f.flow.id)
    await expect.poll(() => f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('failed')
    expect(f.runtime.flowService!.repository.getRun(f.flow.id)?.output).not.toHaveProperty('taskId')
    const retried = await f.retry()
    await expect.poll(() => f.runtime.taskRepository!.get(retried.task.id)?.status).toBe('completed')
    await f.coordinator.tick()
    await expect.poll(() => f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('succeeded')
  })

  it('rejects a sibling retry before dispatch and isolates an old incompatible outbox while another Flow completes', async () => {
    const f = await fixture(true)
    await f.coordinator.tick()
    const failedOwnerId = (f.runtime.flowService!.repository.getRun(f.flow.id)!.output as { taskId: string }).taskId
    expect(f.runtime.taskRepository!.get(failedOwnerId)?.status).toBe('failed')
    const sibling = f.runtime.taskRepository!.list({ workspaceRoot: f.source.workspaceRoot }).find(task => task.id !== failedOwnerId)!
    const before = (await f.runtime.threadService.get(sibling.threadId))!.turns.length
    await expect(f.retry(sibling)).rejects.toMatchObject({ code: 'flow_retry_failure_conflict' })
    expect((await f.runtime.threadService.get(sibling.threadId))!.turns).toHaveLength(before)
    // Reproduce a persisted retry emitted by an older build, before admission checked the failed node.
    const legacy = f.runtime.taskController!.createRetryTask({ id: 'legacy-incompatible-retry', sourceTaskId: sibling.id,
      expectedRevision: sibling.revision, thread: (await f.runtime.threadService.get(sibling.threadId))!, request: { prompt: sibling.goal } })
    const otherDefinition = { ...f.definition, id: 'independent-flow', name: '独立合成流程',
      nodes: f.definition.nodes.slice(0, 2), edges: f.definition.edges.slice(0, 1) }
    f.runtime.flowService!.create(otherDefinition)
    expect(f.runtime.flowService!.publish(otherDefinition.id).published).toBe(true)
    const other = await f.runtime.flowService!.run(otherDefinition.id, {})
    await settleDispatch(f.runtime)
    expect(f.runtime.flowService!.repository.getRun(other.id)?.status).toBe('paused')
    await expect.poll(() => f.runtime.taskRepository!.list({ workspaceRoot: f.source.workspaceRoot }).find(task => task.flowRunId === other.id)?.status).toBe('completed')
    await f.coordinator.tick()
    await expect.poll(() => f.runtime.flowService!.repository.getRun(other.id)?.status).toBe('succeeded')
    expect(f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('failed')
    expect(f.runtime.taskRepository!.pendingOutbox('flow_task_retry')).toHaveLength(0)
    expect(f.runtime.taskRepository!.operations(legacy.id, 'flow_retry_delivery')).toMatchObject([{ status: 'failed', result: { code: 'flow_retry_failure_conflict' } }])
    expect(f.runtime.taskRepository!.attention(`flow-retry-rejected:flow-task-retry:${legacy.id}`)?.status).toBe('pending')
    const calls = f.modelCalls()
    await f.coordinator.tick()
    expect(f.modelCalls()).toBe(calls)
  })

  it('keeps an explicitly cancelled Flow cancelled and allocates no retry Turn', async () => {
    const f = await fixture()
    expect(f.runtime.flowService!.cancel(f.flow.id)).toBe(true)
    const before = (await f.runtime.threadService.get(f.source.threadId))!.turns.length
    await expect(f.retry()).rejects.toMatchObject({ code: 'flow_cancelled' })
    expect((await f.runtime.threadService.get(f.source.threadId))!.turns).toHaveLength(before)
    expect(f.runtime.flowService!.repository.getRun(f.flow.id)?.status).toBe('cancelled')
  })
})
