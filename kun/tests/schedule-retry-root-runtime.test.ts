import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.unstubAllEnvs() })
// Real Runtime/HTTP/control-retry/SQLite/Flow/Host; only the model is a local
// protocol fixture. No application, browser or actual account is operated.
it('an explicit UI retry reads its unique Root plan using a new Grant and preserves the sealed history', async () => {
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-schedule-retry-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let phase = 0, reached!: () => void, releaseFailure!: () => void
  const failureReady = new Promise<void>(resolve => { releaseFailure = resolve })
  const barrier = new Promise<void>(resolve => { reached = resolve })
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const input = JSON.parse(Buffer.concat(chunks).toString()), current = phase++
    if (current === 2) { reached(); await failureReady; response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'Controlled model failure after the saved schedule', type: 'authentication_error' } })); return }
    const name = current === 0 || current === 3 ? 'schedule_task' : current === 1 || current === 4 ? 'list_schedules' : undefined
    if (name) expect(input.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain(name)
    const delta = name ? { tool_calls: [{ index: 0, id: `retry-plan-${current}`, type: 'function', function: { name, arguments: '{}' } }] }
      : { content: '原每日计划已读回核对，仍在北京时间08:30和16:30启动。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: `response-${current}`, choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => { model.close(error => error ? reject(error) : resolve()); model.closeAllConnections() }))
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: root, runtimeToken: 'retry-test-token', apiKey: 'local-model-only',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}`, model: 'fixture-model', approvalPolicy: 'on-request', sandboxMode: 'read-only',
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' } })
  cleanup.push(async () => runtime.shutdown?.())
  const repository = runtime.taskRepository!, flows = runtime.flowService!, router = buildRouter(runtime)
  const api = (path: string, body: unknown) => dispatchRequest(router, new Request('http://localhost' + path, { method: 'POST',
    headers: { authorization: 'Bearer retry-test-token', 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const origin = await runtime.threadService.create({ workspace, model: 'fixture-model', mode: 'agent', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'schedule-source',
    request: { prompt: '每天9:00和17:00前提醒我检查工程资料。', model: 'fixture-model', mode: 'agent' } })
  expect(started.kind).toBe('task_started')
  const taskId = 'task' in started ? started.task!.id : ''
  await barrier
  const flowId = `schedule_${taskId}`, before = JSON.stringify(flows.get(flowId))
  expect(flows.get(flowId)).toBeTruthy()
  const original = repository.operations(taskId).map(row => JSON.stringify(row)), rootGrant = (await runtime.threadService.get(repository.get(taskId)!.threadId))!.turns.at(-1)!.executionGrant!
  // Exercise the production terminal transition without fabricating a Task or receipt.
  const originalTask = repository.get(taskId)!
  runtime.taskController!.recordAttemptFailure(originalTask.threadId, originalTask.activeTurnId!, 'max_tokens', 'Controlled model budget failure after schedule readback')
  await runtime.turnService.finishTurn({ threadId: originalTask.threadId, turnId: originalTask.activeTurnId!, status: 'failed' })
  runtime.taskController!.endRun(originalTask.activeTurnId!); releaseFailure()
  await expect.poll(() => repository.get(taskId)!.status).toBe('failed')
  const retried = await api(`/v1/tasks/${taskId}/retry`, { expectedRevision: repository.get(taskId)!.revision, idempotencyKey: 'explicit-ui-retry' })
  expect(retried.status, await retried.clone().text()).toBe(202)
  await expect.poll(() => repository.list().find(task => task.retryOfTaskId === taskId)?.status, { timeout: 30_000 }).toBe('completed').catch(error => { const task=repository.list().find(item=>item.retryOfTaskId===taskId); throw new Error(JSON.stringify({phase, task, operations:task&&repository.operations(task.id)},null,2),{cause:error}) })
  const retry = repository.list().find(task => task.retryOfTaskId === taskId)!
  expect(retry.rootTaskId).toBe(taskId); expect(flows.list().map(flow => flow.id)).toEqual([flowId]); expect(JSON.stringify(flows.get(flowId))).toBe(before)
  for (const saved of original) expect(repository.operations(taskId).map(row => JSON.stringify(row))).toContain(saved)
  expect(repository.operations(retry.id, 'schedule_authority')).toHaveLength(0)
  const readback = repository.operations(retry.id, 'schedule_readback')
  expect(readback).toHaveLength(1); expect(readback[0]!.status).toBe('succeeded')
  expect((readback[0]!.result as { schedules: unknown[] }).schedules).toEqual([expect.objectContaining({ id: flowId, sourceTaskId: taskId,
    schedule: expect.objectContaining({ times: ['08:30', '16:30'] }) })])
  const retryThread = (await runtime.threadService.get(retry.threadId))!, retryGrant = retryThread.turns.at(-1)!.executionGrant!
  expect(retryGrant.taskId).toBe(retry.id); expect(retryGrant.id).not.toBe(rootGrant.id); expect(retryGrant.turnId).not.toBe(rootGrant.turnId)
  expect(retryThread.turns.at(-1)!.items.filter(item => item.kind === 'tool_result' && item.isError)).toHaveLength(0)
  const duplicate = await api(`/v1/tasks/${taskId}/retry`, { expectedRevision: repository.get(taskId)!.revision, idempotencyKey: 'explicit-ui-retry' })
  expect(duplicate.status).toBe(202); expect(repository.list().filter(task => task.retryOfTaskId === taskId)).toHaveLength(1)
  expect(JSON.stringify(flows.get(flowId))).toBe(before)
  // An unchanged Root plan still dispatches one independent occurrence after Retry.
  const nextRunAt = flows.repository.getTriggerState(flowId, 'schedule')!.nextRunAt!
  await flows.tickSchedules(new Date(nextRunAt)); await flows.tickSchedules(new Date(nextRunAt))
  await expect.poll(() => repository.list().filter(task => task.scheduledBy?.scheduleId === flowId).map(task => task.status), { timeout: 15_000 }).toEqual(['completed'])
  const due = repository.list().find(task => task.scheduledBy?.scheduleId === flowId)!
  expect(due.id).not.toBe(retry.id); expect(due.id).not.toBe(taskId)
  const dueThread = (await runtime.threadService.get(due.threadId))!, dueGrant = dueThread.turns.at(-1)!.executionGrant!
  expect(dueGrant.taskId).toBe(due.id); expect(dueGrant.id).not.toBe(rootGrant.id); expect(dueGrant.id).not.toBe(retryGrant.id)
  expect(JSON.stringify(flows.get(flowId))).toBe(before)
}, 45_000)
