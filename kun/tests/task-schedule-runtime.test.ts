import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import type { TaskPermissionSnapshot } from '../src/services/task-permission-service.js'

it.each([false, true])('delivers HTML, saves and executes the schedule through production tools (explicit paths %s)', async explicitPaths => {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-scheduled-task-runtime-'))
  const root = await realpath(temporary)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const catalogs: string[][] = []
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as {
      tools?: Array<{ function: { name: string } }>
      messages?: Array<{ tool_calls?: Array<{ function: { name: string } }> }>
    }
    const names = body.tools?.map(tool => tool.function.name) ?? []
    catalogs.push(names)
    const called = new Set(body.messages?.flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []))
    const next = [...(explicitPaths ? ['write'] : []), 'publish_artifact', 'schedule_task', 'list_schedules'].find(name => names.includes(name) && !called.has(name))
    const args = next === 'publish_artifact' || next === 'write' ? { path: next === 'write' ? join(workspace, 'report.html') : 'report.html', content: '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>合成报告</title></head><body><h1>合成任务成果</h1></body></html>' } : {}
    const delta = next ? { tool_calls: [{ index: 0, id: `call-${next}`, type: 'function', function: { name: next, arguments: JSON.stringify(args) } }] }
      : { content: 'HTML报告已保存并核验，可查看本次成果。每日计划已按当前任务要求处理。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'synthetic-schedule-model', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const port = (model.address() as { port: number }).port
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic',
    apiKey: 'synthetic-local-only', baseUrl: `http://127.0.0.1:${port}/v1`, endpointFormat: 'chat_completions', model: 'synthetic-protocol',
    approvalPolicy: 'auto', sandboxMode: explicitPaths ? 'workspace-write' : 'read-only', tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
  const router = buildRouter(runtime)
  const api = (path: string, method = 'GET', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, { method,
    headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const approved = new Set<string>()
  const approvalTimer = setInterval(() => {
    for (const approval of runtime.approvalGate.pending()) {
      if (approved.has(approval.id)) continue
      expect(['write', 'schedule_task']).toContain(approval.toolName)
      approved.add(approval.id)
      void api(`/v1/approvals/${approval.id}`, 'POST', { decision: 'allow' })
    }
  }, 20)
  try {
    const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic-protocol', ...(explicitPaths ? { approvalPolicy: 'never' } : {}) })
    let started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'html-daily',
      request: { prompt: `请生成并交付一份HTML网页报告${explicitPaths ? `，保存到 ${join(workspace, 'report.html')}。` : '。'}每天09:00和17:00执行。` } })
    if (explicitPaths) {
      expect(started.kind).toBe('capability_required')
      const snapshot = await (await api(`/v1/tasks/${started.task!.id}/permissions`)).json() as TaskPermissionSnapshot
      const response = await api(`/v1/tasks/${started.task!.id}/permissions`, 'POST', { expectedRevision: snapshot.taskRevision, idempotencyKey: 'temporary-paths',
        scopeHash: snapshot.scopeHash, confirmed: true, approvalPolicy: 'on-request', ttlSeconds: 900, duration: 'task', scope: { readPaths: [workspace], writePaths: [workspace] } })
      expect(response.status, await response.clone().text()).toBe(200)
      started = await runtime.taskCoordinator!.command({ threadId: origin.id, taskId: started.task!.id, intent: 'resume', idempotencyKey: 'resume-paths', request: { prompt: '继续' } })
    }
    expect(started.task).toBeDefined()
    await expect.poll(() => {
      const task = runtime.taskRepository!.get(started.task!.id)!
      return { status: task.status, reason: task.stalledReason ?? null }
    }, { timeout: 20000 }).toEqual({ status: 'completed', reason: null })
    const initial = runtime.taskRepository!.get(started.task!.id)!
    expect(initial.artifacts.some(file => file.format === 'html' && file.validation === 'valid')).toBe(true)
    const file = initial.artifacts.find(item => item.format === 'html' && item.absolutePath)!
    expect(await readFile(file.absolutePath!, 'utf8')).toContain('合成任务成果')
    expect(runtime.taskRepository!.operations(initial.id, 'schedule_readback')).toHaveLength(1)
    const flow = runtime.flowService!.get(`schedule_${initial.id}`)!
    expect(flow.nodes[0]?.config).toEqual({ kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai' })
    const dueAt = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
    if (explicitPaths) {
      const saved = flow.variables.taskSchedule as { authorization: { kind: string; expiresAt: null } }
      expect(saved.authorization).toMatchObject({ kind: 'confirmed_scope', expiresAt: null })
      expect((await runtime.threadService.get(origin.id))!.approvalPolicy).toBe('never')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60_000))
    }
    await runtime.flowService!.tickSchedules(new Date(dueAt))
    await expect.poll(() => {
      const task = runtime.taskRepository!.list().find(task => task.scheduledBy?.scheduleId === flow.id)
      return { status: task?.status, reason: task?.stalledReason ?? task?.waitingReason ?? null }
    }, { timeout: 20000 }).toEqual({ status: 'completed', reason: null })
    const occurrence = runtime.taskRepository!.list().find(task => task.scheduledBy?.scheduleId === flow.id)!
    expect(occurrence.acceptance.schedule).toBeUndefined()
    expect(occurrence.artifacts.some(item => item.validation === 'valid')).toBe(true)
    if (explicitPaths) {
      expect(await readFile(join(workspace, 'report.html'), 'utf8')).toContain('合成任务成果')
      const turn = (await runtime.threadService.get(occurrence.threadId))!.turns.find(item => item.id === occurrence.activeTurnId)!
      expect(turn.executionGrant).toMatchObject({ workspaceWriteException: true, writePathAllowlist: [workspace] })
      expect(turn.executionGrant?.taskPermissionId).toBeUndefined()
    }
    await runtime.flowService!.tickSchedules(new Date(dueAt))
    expect(runtime.taskRepository!.list().filter(task => task.scheduledBy?.scheduleId === flow.id)).toHaveLength(1)
    expect(catalogs.some(names => names.includes('schedule_task') && names.includes('list_schedules'))).toBe(true)
  } finally {
    clearInterval(approvalTimer)
    vi.useRealTimers()
    await runtime.shutdown?.()
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() })
    await rm(temporary, { recursive: true, force: true })
  }
}, 30000)
