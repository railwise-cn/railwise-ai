import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { CapabilityPreflightSchema } from '../src/contracts/harness.js'
import { makeAssistantTextItem, makeToolResultItem } from '../src/domain/item.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function fixture() {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-browser-block-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const network = vi.fn(() => { throw new Error('Synthetic permission replay forbids external calls') })
  vi.stubGlobal('fetch', network)
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'synthetic-browser-block',
    apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic-no-model', tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}), approvalPolicy: 'auto' as const, sandboxMode: 'read-only' as const }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => runtime.shutdown?.())
  const origin = await runtime.threadService.create({ title: '原始浏览器任务', workspace, mode: 'agent', model: 'synthetic-no-model' })
  const worker = await runtime.threadService.create({ title: '内部执行', workspace, mode: 'agent', model: 'synthetic-no-model' })
  const prompt = '使用 BrowserSkill 读取 https://example.test 的信息。'
  const turn = await runtime.turnService.startTurn({ threadId: worker.id,
    request: { prompt, taskIntent: 'new', taskVisibility: 'task', taskOriginThreadId: origin.id } })
  const task = runtime.taskRepository!.findByTurn(turn.turnId)!
  runtime.taskController!.beginAttempt(worker.id, turn.turnId)
  async function toolFailure(code: string, turnId = turn.turnId) {
    await runtime.sessionStore.appendItem(worker.id, makeToolResultItem({ id: `browser-block-${code}`, threadId: worker.id,
      turnId, callId: 'browser-call', toolName: 'browser_interact', isError: true, output: { code } }))
  }
  async function restart() {
    await runtime.turnService.finishTurn({ threadId: worker.id, turnId: turn.turnId, status: 'completed' })
    runtime.taskController!.endRun(turn.turnId)
    await runtime.shutdown?.()
    runtime = await createKunServeRuntime(options)
  }
  return { get runtime() { return runtime }, origin, worker, turn, task, prompt, workspace, network, toolFailure, restart }
}

it.each(['browser_interaction_scope_required', 'browser_binding_changed'])('persists and replays one actionable %s browser card through real Runtime stores', async code => {
  const f = await fixture()
  await f.toolFailure(code)
  await f.runtime.sessionStore.appendItem(f.worker.id, makeAssistantTextItem({ id: 'explanation', threadId: f.worker.id,
    turnId: f.turn.turnId, text: '请确认浏览器范围后继续。', status: 'completed' }))
  expect(await f.runtime.taskController!.assessCandidate(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  const taskRevision = f.runtime.taskRepository!.get(f.task.id)!.revision
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  expect(f.runtime.taskRepository!.get(f.task.id)!.revision).toBe(taskRevision)
  const attention = f.runtime.taskRepository!.inbox(f.workspace).filter(item => item.taskId === f.task.id)
  expect(attention).toHaveLength(1)
  const capability = CapabilityPreflightSchema.parse(attention[0]!.payload!.capability)
  const action = { kind: 'grant', route: 'task/browser-binding', label: '确认当前任务的浏览器范围' }
  expect(capability).toMatchObject({ provider: 'browser-skill', status: 'needs_authorization', errorCode: code,
    approvalState: 'required', action, resolution: action })
  expect(f.runtime.taskRepository!.connection().prepare("SELECT COUNT(*) AS count FROM runtime_outbox WHERE kind='task_command_message'").get()).toEqual({ count: 1 })
  await f.runtime.taskCoordinator!.flushCommandMessages()
  await f.runtime.taskCoordinator!.flushCommandMessages()
  const history = await f.runtime.sessionStore.loadItems(f.origin.id)
  const cards = history.filter(item => item.kind === 'assistant_text' && item.capabilityCard)
  expect(cards).toMatchObject([{ capabilityCard: { threadId: f.origin.id, taskId: f.task.id,
    attentionId: attention[0]!.id, prompt: f.prompt, capability: { provider: 'browser-skill', errorCode: code } } }])
  expect(history.filter(item => item.kind === 'user_message')).toHaveLength(0)
  expect(f.runtime.taskRepository!.events(f.task.id).filter(event => event.kind === 'task_waiting_user')).toHaveLength(1)
  await f.restart()
  expect(f.runtime.taskRepository!.get(f.task.id)?.status).toBe('waiting_user')
  expect(f.runtime.taskRepository!.latestCheckpoint(f.task.id)?.resumeSummary).toBe(capability.message)
  expect(f.runtime.taskRepository!.inbox(f.workspace).filter(item => item.taskId === f.task.id)).toHaveLength(1)
  expect((await f.runtime.sessionStore.loadItems(f.origin.id)).filter(item => item.kind === 'assistant_text' && item.capabilityCard)).toHaveLength(1)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})

it('creates the browser scope card when a model failure leaves no final explanatory reply', async () => {
  const f = await fixture()
  await f.toolFailure('browser_interaction_scope_required')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  await f.runtime.taskCoordinator!.flushCommandMessages()
  const history = await f.runtime.sessionStore.loadItems(f.origin.id)
  expect(history.filter(item => item.kind === 'assistant_text' && item.capabilityCard)).toMatchObject([
    { capabilityCard: { taskId: f.task.id, capability: { provider: 'browser-skill', status: 'needs_authorization',
      errorCode: 'browser_interaction_scope_required', resolution: { route: 'task/browser-binding' } } } }
  ])
  expect(f.runtime.taskRepository!.get(f.task.id)).toMatchObject({ status: 'waiting_user', goal: f.prompt })
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['browser_schedule_authority_changed', 'browser_schedule_action_scope_changed', 'browser_schedule_outcome_unknown'])('persists one actionable %s plan blocker without waking a paused task', async code => {
  const f = await fixture()
  const current = f.runtime.taskRepository!.get(f.task.id)!
  f.runtime.taskRepository!.update(current.id, current.revision, task => ({ ...task, scheduledBy: { scheduleId: 'schedule-source', dueAt: '2026-11-13T01:00:00.000Z' } }))
  await f.toolFailure(code)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  await f.runtime.taskCoordinator!.flushCommandMessages()
  const attention = f.runtime.taskRepository!.attention(`capability_${f.task.id}`)!
  expect(attention).toMatchObject({ status: 'pending', payload: { capability: { provider: 'schedule', status: 'blocked', errorCode: code,
    resolution: { kind: 'grant', route: 'flow/schedule-source', label: '查看并核对定时计划' } } } })
  if (code === 'browser_schedule_outcome_unknown') expect(attention.message).toContain('结果待核实')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user' })
  expect(f.runtime.taskRepository!.attention(attention.id)).toEqual(attention)
  const waiting = f.runtime.taskRepository!.get(f.task.id)!
  const paused = f.runtime.taskController!.pauseTask(waiting.id, waiting.revision, '用户暂停周期任务')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ task: { status: 'paused' } })
  expect(f.runtime.taskRepository!.get(f.task.id)).toEqual(paused)
  expect((await f.runtime.sessionStore.loadItems(f.origin.id)).filter(item => item.kind === 'assistant_text' && item.capabilityCard)).toHaveLength(1)
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['browser_interaction_scope_required', 'browser_binding_changed'])('keeps a paused task paused when a late %s result is assessed', async code => {
  const f = await fixture()
  const current = f.runtime.taskRepository!.get(f.task.id)!
  const paused = f.runtime.taskController!.pauseTask(current.id, current.revision, '用户明确暂停')
  await f.toolFailure(code)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user', task: { status: 'paused' } })
  expect(await f.runtime.taskController!.assessCandidate(f.worker.id, f.turn.turnId)).toMatchObject({ kind: 'waiting_user', task: { status: 'paused' } })
  expect(f.runtime.taskRepository!.get(f.task.id)).toEqual(paused)
  expect(f.runtime.taskRepository!.inbox(f.workspace)).toHaveLength(0)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})

it('ignores an old Turn browser block when assessing the current execution', async () => {
  const f = await fixture()
  await f.toolFailure('browser_binding_changed', 'previous-turn')
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toBeNull()
  expect(f.runtime.taskRepository!.inbox(f.workspace)).toHaveLength(0)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})

it.each(['browser_interaction_scope_required', 'browser_binding_changed'])('keeps a cancelled task terminal after a late %s result', async code => {
  const f = await fixture()
  const current = f.runtime.taskRepository!.get(f.task.id)!
  const cancelled = f.runtime.taskController!.cancelTask(current.id, current.revision, '用户已取消')
  await f.toolFailure(code)
  expect(await f.runtime.taskController!.assessNonRetryableBlock(f.worker.id, f.turn.turnId)).toBeNull()
  expect(f.runtime.taskController!.recordAttemptFailure(f.worker.id, f.turn.turnId, code, '迟到错误')).toBeNull()
  await expect(f.runtime.taskController!.assessCandidate(f.worker.id, f.turn.turnId)).rejects.toMatchObject({ code: 'not_found' })
  expect(f.runtime.taskRepository!.get(f.task.id)).toEqual(cancelled)
  expect(f.runtime.taskRepository!.inbox(f.workspace)).toHaveLength(0)
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(f.network).not.toHaveBeenCalled()
})
