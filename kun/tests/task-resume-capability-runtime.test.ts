import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import type { TaskControlResult } from '../src/services/task-control-service.js'

// Only the external browser process is simulated. HTTP routing, preflight,
// task commands, Turn creation, file history and SQLite persistence are real.
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: string[]) => {
    if (JSON.stringify(args) !== JSON.stringify(['status'])) throw new Error('Unexpected synthetic browser action')
    return { ok: true, output: { protocol_version: '1.7', pid: 7, browsers: [{
      instance_id: 'browser-new', browser_name: 'Chrome', label: 'Synthetic browser',
      extension_version: '0.4.0', extension_protocol_version: '1.7'
    }] } }
  })
}))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllEnvs()
})

async function fixture(kind: 'browser' | 'workspace' | 'dingtalk' = 'browser', initiallyDisabled = false) {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-resume-capability-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  let modelRequests = 0
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the local synthetic request */ }
    modelRequests++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': synthetic model waits for task interruption\n\n')
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  const options = {
    host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-resume',
    apiKey: 'synthetic-local-only', baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    endpointFormat: 'chat_completions' as const, model: 'synthetic-resume', approvalPolicy: 'auto' as const,
    sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: {
      enabled: !initiallyDisabled, state: 'ready', browserInstanceId: 'browser-new', revision: 3,
      executablePath: join(root, 'synthetic-browser-cli'), executableHash: 'a'.repeat(64),
      origins: ['https://example.com', 'https://new.example'], interaction: 'interact'
    } })
  }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => runtime.shutdown?.())
  let router = buildRouter(runtime)
  const api = (path: string, method = 'GET', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, {
    method, headers: { authorization: 'Bearer synthetic-resume', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  }))
  const origin = await runtime.threadService.create({ title: '原始用户任务', workspace, mode: 'agent', model: 'synthetic-resume' })
  const prompt = kind === 'browser' ? '使用 BrowserSkill 读取 https://example.com 的信息。'
    : kind === 'workspace' ? '保存到 report.html' : '帮我处理钉钉待办'
  const initial = initiallyDisabled ? await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new',
    idempotencyKey: 'browser-initially-disabled', request: { prompt } }) : undefined
  if (initial) expect(initial).toMatchObject({ kind: 'capability_required', capability: { errorCode: 'browser_disabled' }, task: { status: 'waiting_user' } })
  const worker = initial?.task ? (await runtime.threadService.get(initial.task.threadId))!
    : await runtime.threadService.create({ title: '内部执行', workspace, mode: 'agent', model: 'synthetic-resume' })
  const waiting = initial?.task ?? runtime.taskController!.createWaitingTask({ id: `task_resume_${kind}`, thread: worker,
    request: { prompt, taskIntent: 'new', taskVisibility: 'task', taskOriginThreadId: origin.id }, reason: 'Synthetic initial blocker' })
  if (kind === 'browser' && !initiallyDisabled) runtime.taskRepository!.update(waiting.id, waiting.revision, task => ({ ...task, authority: {
    source: 'user', workspaceRoot: workspace, grantedAt: runtime.nowIso(), externalTargets: [], browserScope: {
      browserInstanceId: 'browser-old', revision: 1, origins: ['https://example.com'], interaction: 'observe'
    }
  } }))
  const current = () => runtime.taskRepository!.get(waiting.id)!
  const pause = await api(`/v1/tasks/${waiting.id}/pause`, 'POST', { expectedRevision: current().revision, idempotencyKey: 'initial-pause' })
  expect(pause.status, await pause.clone().text()).toBe(200)
  const turnCount = async () => (await runtime.threadService.get(worker.id))!.turns.length
  const cards = async () => (await runtime.sessionStore.loadItems(origin.id)).filter(item => item.kind === 'assistant_text' && item.capabilityCard)
  const outboxCount = () => runtime.taskRepository!.connection().prepare("SELECT COUNT(*) AS count FROM runtime_outbox WHERE kind='task_command_message'").get() as { count: number }
  const restart = async () => {
    await runtime.shutdown?.()
    runtime = await createKunServeRuntime(options)
    router = buildRouter(runtime)
  }
  const enableBrowser = async () => { options.capabilities.browserSkill.enabled = true; await restart() }
  return { get runtime() { return runtime }, api, current, origin, worker, workspace, prompt, turnCount, cards, outboxCount, restart, enableBrowser, requests: () => modelRequests }
}

it('keeps a task created without Browser capability unbound until preview, confirmation and a separate resume', async () => {
  const f = await fixture('browser', true)
  expect(f.current().authority?.browserScope).toBeUndefined()
  expect(await f.turnCount()).toBe(0)
  expect(f.requests()).toBe(0)
  await f.enableBrowser()
  const original = f.current()
  const response = await f.api(`/v1/tasks/${original.id}/resume`, 'POST', {
    expectedRevision: original.revision, idempotencyKey: 'connected-before-first-turn'
  })
  expect(response.status, await response.clone().text()).toBe(202)
  const blocked = await response.json() as TaskControlResult
  expect(blocked).toMatchObject({ task: { id: original.id, status: 'paused' }, capability: {
    status: 'needs_authorization', errorCode: 'browser_task_scope_required', workspaceRoot: f.workspace,
    resolution: { kind: 'grant', route: 'task/browser-binding' }
  } })
  expect(f.current().authority?.browserScope).toBeUndefined()
  expect(await f.turnCount()).toBe(0)
  expect(f.requests()).toBe(0)
  const preview = await f.api(`/v1/tasks/${original.id}/browser-binding`)
  expect(preview.status).toBe(200)
  const snapshot = await preview.json() as BrowserTaskBindingSnapshot
  const confirm = await f.api(`/v1/tasks/${original.id}/browser-binding`, 'POST', {
    expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
    browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: snapshot.interaction,
    confirmed: true, idempotencyKey: 'first-browser-binding'
  })
  expect(confirm.status, await confirm.clone().text()).toBe(200)
  expect(await confirm.json()).toMatchObject({ resumed: false })
  expect(f.current().status).toBe('paused')
  expect(await f.turnCount()).toBe(0)
  expect(f.requests()).toBe(0)
  const resumed = await f.api(`/v1/tasks/${original.id}/resume`, 'POST', {
    expectedRevision: f.current().revision, idempotencyKey: 'start-first-turn-after-review'
  })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  const started = await resumed.json() as TaskControlResult
  expect(started.task.id).toBe(original.id)
  expect(started.turn?.turnId).toBeTruthy()
  await expect.poll(f.requests, { timeout: 10_000 }).toBe(1)
  expect(await f.turnCount()).toBe(1)
  const turn = (await f.runtime.threadService.get(f.worker.id))!.turns.find(item => item.id === started.turn!.turnId)!
  expect(turn.executionGrant?.browserScope).toMatchObject({ browserInstanceId: snapshot.browserInstanceId,
    origins: snapshot.origins, revision: snapshot.browserRevision, interaction: snapshot.interaction })
})

it('persists a blocked browser resume across restart, confirms its scope while paused, and starts a Turn only on a separate resume', async () => {
  const f = await fixture()
  const paused = f.current()
  const body = { expectedRevision: paused.revision, idempotencyKey: 'blocked-resume' }
  const first = await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', body)
  expect(first.status, await first.clone().text()).toBe(202)
  const blocked = await first.json() as TaskControlResult
  expect(blocked).toMatchObject({ task: { id: paused.id, status: 'paused', revision: paused.revision },
    capability: { provider: 'browser-skill', errorCode: 'browser_binding_changed', status: 'needs_authorization' }, attentionId: `capability_${paused.id}` })
  expect(blocked.turn).toBeUndefined()
  expect(f.current()).toEqual(paused)
  expect(await f.turnCount()).toBe(0)
  expect(f.requests()).toBe(0)
  const attention = f.runtime.taskRepository!.attention(blocked.attentionId!)!
  expect(attention).toMatchObject({ status: 'pending', threadId: f.origin.id, taskId: paused.id,
    payload: { kind: 'capability_required', request: { prompt: f.prompt } } })
  expect(attention.payload!.resumeFingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(attention.payload!.resumeCommandId).toMatch(/^[a-f0-9]{32}$/)
  expect(f.outboxCount()).toEqual({ count: 1 })
  expect(f.runtime.taskRepository!.pendingOutbox('task_command_message')).toHaveLength(0)
  expect(await f.cards()).toHaveLength(1)

  const repeated = await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', body)
  expect(await repeated.json()).toEqual(blocked)
  expect(f.runtime.taskRepository!.operations(paused.id, 'resume')).toHaveLength(1)
  expect((await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', { ...body, idempotencyKey: 'second-resume' })).status).toBe(202)
  expect(f.current()).toEqual(paused)
  expect(f.runtime.taskRepository!.attention(blocked.attentionId!)).toEqual(attention)
  expect(f.outboxCount()).toEqual({ count: 1 })
  expect(await f.cards()).toHaveLength(1)
  expect(f.runtime.taskRepository!.operations(paused.id, 'resume')).toHaveLength(2)

  const chat = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, taskId: paused.id, intent: 'resume',
    idempotencyKey: 'chat-resume', request: { prompt: '继续' } })
  expect(chat).toMatchObject({ kind: 'capability_required', attentionId: blocked.attentionId,
    receipt: { resultMessageItemId: `item_command_${attention.payload!.resumeCommandId}_receipt`,
      userMessageItemId: `item_command_${attention.payload!.resumeCommandId}_user` } })
  expect(f.runtime.taskRepository!.attention(blocked.attentionId!)).toEqual(attention)
  expect(f.outboxCount()).toEqual({ count: 1 })
  expect(await f.cards()).toHaveLength(1)
  await f.restart()
  expect(f.current()).toEqual(paused)
  expect(f.runtime.taskRepository!.attention(blocked.attentionId!)).toEqual(attention)
  expect(await f.cards()).toHaveLength(1)
  expect(await f.turnCount()).toBe(0)
  expect(f.requests()).toBe(0)
  expect(await (await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', body)).json()).toEqual(blocked)

  const snapshot = await (await f.api(`/v1/tasks/${paused.id}/browser-binding`)).json() as BrowserTaskBindingSnapshot
  expect(snapshot).toMatchObject({ taskRevision: paused.revision, previousBrowserInstanceId: 'browser-old',
    browserInstanceId: 'browser-new', browserRevision: 3, origins: ['https://example.com'] })
  const confirmation = { expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
    browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: 'observe', confirmed: true,
    idempotencyKey: 'confirm-reviewed-browser' }
  const confirmed = await f.api(`/v1/tasks/${paused.id}/browser-binding`, 'POST', confirmation)
  expect(confirmed.status, await confirmed.clone().text()).toBe(200)
  expect(await confirmed.json()).toMatchObject({ resumed: false, binding: { origins: ['https://example.com'], interaction: 'observe' } })
  expect(f.current()).toMatchObject({ status: 'paused', revision: paused.revision + 1, authority: { browserScope: {
    browserInstanceId: 'browser-new', origins: ['https://example.com'], revision: 3, interaction: 'observe'
  } } })
  expect((await f.api(`/v1/tasks/${paused.id}/browser-binding`, 'POST', confirmation)).status).toBe(200)
  expect(f.runtime.taskRepository!.operations(paused.id, 'browser_binding')).toHaveLength(1)
  expect(await f.turnCount()).toBe(0)
  expect(f.requests()).toBe(0)
  expect((await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', { ...body, idempotencyKey: 'stale-resume' })).status).toBe(409)
  expect(await f.turnCount()).toBe(0)

  const resumeRequest = { expectedRevision: f.current().revision, idempotencyKey: 'explicit-resume-after-confirm' }
  const resumed = await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', resumeRequest)
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  const result = await resumed.json() as TaskControlResult
  expect(result.turn?.turnId).toBeTruthy()
  await expect.poll(f.requests, { timeout: 10_000 }).toBe(1)
  expect(await f.turnCount()).toBe(1)
  const turn = (await f.runtime.threadService.get(f.worker.id))!.turns.find(item => item.id === result.turn!.turnId)!
  expect(turn.executionGrant?.browserScope).toEqual({ browserInstanceId: 'browser-new', origins: ['https://example.com'], revision: 3, interaction: 'observe' })
  expect(f.runtime.taskRepository!.attention(blocked.attentionId!)?.status).toBe('answered')
  expect(await f.cards()).toHaveLength(1)
  expect(await (await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', resumeRequest)).json()).toEqual(result)
  expect(await f.turnCount()).toBe(1)
  expect(f.requests()).toBe(1)
})

it.each(['workspace', 'dingtalk'] as const)('persists and deduplicates a paused %s resume blocker without creating a Turn', async kind => {
  const f = await fixture(kind)
  const paused = f.current()
  const body = { expectedRevision: paused.revision, idempotencyKey: 'blocked-resume' }
  const first = await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', body)
  expect(first.status, await first.clone().text()).toBe(202)
  const blocked = await first.json() as TaskControlResult
  expect(blocked).toMatchObject({ task: { status: 'paused', revision: paused.revision }, attentionId: `capability_${paused.id}`,
    capability: { provider: kind } })
  expect(blocked.capability?.status).not.toBe('available')
  const attention = f.runtime.taskRepository!.attention(blocked.attentionId!)!
  expect((await f.api(`/v1/tasks/${paused.id}/resume`, 'POST', { ...body, idempotencyKey: 'another-resume' })).status).toBe(202)
  expect(f.runtime.taskRepository!.attention(blocked.attentionId!)).toEqual(attention)
  expect(f.current()).toEqual(paused)
  expect(f.outboxCount()).toEqual({ count: 1 })
  await f.restart()
  expect(f.current()).toEqual(paused)
  expect(await f.cards()).toHaveLength(1)
  expect(await f.turnCount()).toBe(0)
  expect(f.requests()).toBe(0)
})
