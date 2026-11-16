import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { TaskDeliveryCoordinator } from '../src/delivery/runtime.js'

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

it('drains an in-flight Flow task dispatch before normal shutdown closes SQLite', async () => {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-shutdown-flow-')))
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'synthetic-shutdown',
    apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}), approvalPolicy: 'auto', sandboxMode: 'read-only' })
  const entered = barrier(), permit = barrier(), draining = barrier()
  const failures: string[] = []
  const originalCommand = runtime.taskCoordinator!.command.bind(runtime.taskCoordinator)
  const command = vi.spyOn(runtime.taskCoordinator!, 'command').mockImplementation(async (...args) => {
    entered.release()
    await permit.promise
    try { return await originalCommand(...args) }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); throw error }
  })
  const originalIdle = runtime.flowService!.executor.awaitIdle.bind(runtime.flowService!.executor)
  const idle = vi.spyOn(runtime.flowService!.executor, 'awaitIdle').mockImplementation(async () => {
    draining.release()
    await originalIdle()
  })
  let stopping: Promise<void> | undefined
  try {
    const policy = { timeoutMs: 10_000, retryAttempts: 0, retryBackoffMs: 0, concurrencyLimit: 1,
      errorBehavior: 'fail' as const, resumable: true, breakpoint: false }
    const definition = { schemaVersion: 1 as const, id: 'shutdown-flow', name: '合成退出回归', description: '', workspace: root, variables: {},
      nodes: [
        { id: 'start', type: 'manual_trigger', label: '开始', position: { x: 0, y: 0 }, bindings: {}, config: {}, policy, disabled: false },
        { id: 'agent', type: 'agent', label: '汇总', position: { x: 200, y: 0 }, bindings: {}, config: { prompt: '汇总合成资料。' }, policy, disabled: false }
      ], edges: [{ id: 'start-agent', sourceNodeId: 'start', sourcePortId: 'output', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' as const }] }
    runtime.flowService!.create(definition)
    expect(runtime.flowService!.publish(definition.id).published).toBe(true)
    const flow = await runtime.flowService!.run(definition.id, {})
    await entered.promise
    stopping = runtime.shutdown!()
    const boundary = await Promise.race([stopping.then(() => 'closed'), draining.promise.then(() => 'draining')])
    const databaseWasOpen = runtime.taskRepository!.connection().open
    permit.release()
    await stopping
    await originalIdle()
    expect(boundary, JSON.stringify(failures)).toBe('draining')
    expect(databaseWasOpen).toBe(true)
    expect(failures.every(message => !message.includes('database connection is not open'))).toBe(true)
    const tasks = new Database(join(root, 'state/tasks.sqlite3'), { readonly: true })
    const flows = new Database(join(root, 'state/flow.sqlite'), { readonly: true })
    try {
      expect(tasks.prepare('SELECT COUNT(*) AS count FROM execution_attempts').get()).toEqual({ count: 0 })
      const row = flows.prepare('SELECT run_json FROM flow_runs WHERE id = ?').get(flow.id) as { run_json: string }
      expect(JSON.parse(row.run_json)).toMatchObject({ status: 'interrupted', checkpoint: { reason: 'application_exit', resumable: true } })
      expect(tasks.pragma('quick_check', { simple: true })).toBe('ok')
      expect(flows.pragma('quick_check', { simple: true })).toBe('ok')
    } finally { tasks.close(); flows.close() }
  } finally {
    permit.release()
    await stopping
    await originalIdle()
    command.mockRestore()
    idle.mockRestore()
    if (!stopping) await runtime.shutdown?.()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it('joins an already-dispatched durable human answer before normal shutdown closes its task database', async () => {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-shutdown-answer-')))
  let coordinator!: TaskDeliveryCoordinator
  // Drive the same production timer callback once, without a clock delay.
  const start = vi.spyOn(TaskDeliveryCoordinator.prototype, 'start').mockImplementation(function (this: TaskDeliveryCoordinator) { coordinator = this })
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'synthetic-shutdown',
    apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused', tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}), approvalPolicy: 'auto', sandboxMode: 'read-only' })
  const entered = barrier(), permit = barrier(), draining = barrier()
  const originalIdle = coordinator.awaitIdle.bind(coordinator)
  const idle = vi.spyOn(coordinator, 'awaitIdle').mockImplementation(async () => { draining.release(); await originalIdle() })
  let tick: Promise<void> | undefined, stopping: Promise<void> | undefined
  const messages: string[] = []
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { messages.push(String(chunk)); return true })
  const thread = await runtime.threadService.create({ title: '合成待答任务', workspace: root, mode: 'agent', model: 'unused' })
  const task = runtime.taskController!.createWaitingTask({ id: 'waiting-during-shutdown', thread, request: { prompt: '等待用户补充合成资料。' }, reason: '等待补充' })
  const now = runtime.nowIso()
  runtime.taskRepository!.saveHumanRequest({ id: 'question-shutdown', kind: 'question', threadId: thread.id, turnId: 'synthetic-old-turn',
    message: '补充合成资料', payload: {}, status: 'pending', createdAt: now, updatedAt: now })
  runtime.taskRepository!.resolveHumanRequest('question-shutdown', { answer: '已提供' }, 'answered', now)
  const originalGet = runtime.threadService.get.bind(runtime.threadService)
  const get = vi.spyOn(runtime.threadService, 'get').mockImplementation(async id => {
    if (id === thread.id) { entered.release(); await permit.promise }
    return originalGet(id)
  })
  try {
    tick = coordinator.tick()
    await entered.promise
    stopping = runtime.shutdown!()
    expect(await Promise.race([stopping.then(() => 'closed'), draining.promise.then(() => 'draining')])).toBe('draining')
    expect(runtime.taskRepository!.connection().open).toBe(true)
    permit.release()
    await stopping
    await tick
    expect(messages.filter(message => message.includes('database connection is not open'))).toEqual([])
    const database = new Database(join(root, 'state/tasks.sqlite3'), { readonly: true })
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM execution_attempts').get()).toEqual({ count: 0 })
      const row = database.prepare('SELECT data_json FROM task_runs WHERE id=?').get(task.id) as { data_json: string }
      expect(JSON.parse(row.data_json).status).toBe('waiting_user')
      expect(database.prepare("SELECT COUNT(*) AS count FROM runtime_outbox WHERE kind='human_answer' AND delivered_at IS NULL").get()).toEqual({ count: 1 })
    } finally { database.close() }
  } finally {
    permit.release()
    await tick
    await stopping
    get.mockRestore()
    idle.mockRestore()
    start.mockRestore()
    stderr.mockRestore()
    if (!stopping) await runtime.shutdown?.()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
