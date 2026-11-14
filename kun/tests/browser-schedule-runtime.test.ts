import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import type { TaskRun } from '../src/contracts/tasks.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import type { BrowserScheduleAction } from '../src/contracts/browser-schedule-actions.js'
import { listApprovedBrowserScheduleActions } from '../src/services/browser-schedule-action-authority.js'

const browser = vi.hoisted(() => ({ next: 0, latest: '', modern: false, sessions: new Map<string, { url: string; context: string; tab: number; value: string }>(),
  writes: [] as Array<{ sessionId: string; action: string; targetRef: string; dependsOn: string[]; expect?: unknown[] }>, elementChanged: false }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    const id = args[args.indexOf('--session') + 1]
    const session = browser.sessions.get(id ?? '')
    if (args[0] === 'status') return { ok: true, output: { protocol_version: browser.modern ? '1.9' : '1.7', pid: 7,
      browsers: [{ instance_id: 'synthetic-browser', browser_name: 'Chrome', label: '合成公开页面', extension_version: browser.modern ? '0.5.0' : '0.4.0', extension_protocol_version: browser.modern ? '1.9' : '1.7' }],
      sessions: [...browser.sessions.keys()].map(session_id => ({ session_id, browser_instance_id: 'synthetic-browser' })) } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'prepared' } }
    if (args[0] === 'session' && args[1] === 'start') {
      const sessionId = `synthetic-session-${++browser.next}`
      browser.latest = sessionId
      browser.sessions.set(sessionId, { url: 'about:blank', context: 'context-0', tab: browser.next, value: '' })
      return { ok: true, output: { session_id: sessionId, browser_instance_id: 'synthetic-browser' } }
    }
    if (args[0] === 'session' && args[1] === 'stop') { browser.sessions.delete(args[2]!); return { ok: true, output: { stopped: [args[2]], failed: [] } } }
    if (!session) throw new Error('Synthetic browser session was not created')
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: session.tab, active: true, url: session.url, title: '合成公告查询', scope: 'agent' }] } }
    if (args[0] === 'navigate') { session.url = args.find(value => value.startsWith('https://'))!; return { ok: true, output: { final_url: session.url } } }
    if (args[0] === 'cooperate') {
      if (browser.modern) { expect(args).toContain('--settle'); expect(args[args.indexOf('--policy') + 1]).toBe('target') }
      else { expect(args).not.toContain('--policy'); expect(args).not.toContain('--settle') }
      session.context = `context-${Number(session.context.split('-')[1]) + 1}`
      return { ok: true, output: { ready: true, context_id: session.context, ...(browser.modern ? { control_policy: 'target' } : {}),
        observation: { text: '公开工程公告查询页面。@e1 关键词输入框，@e2 查询按钮。合成招标公告可读取并核对来源。' } } }
    }
    if (args[0] === 'read') {
      expect(browser.modern).toBe(true)
      const target = args[args.indexOf('--ref') + 1], input = target === '@e1'
      const fields = JSON.parse(args[args.indexOf('--fields-json') + 1]!) as Array<{ key: string; read: string; attribute?: string }>
      const attributes: Record<string, string | null> = input ? { name: 'keyword', 'aria-label': '公告关键词' } : { id: 'search' }
      const values = Object.fromEntries(fields.map(field => [field.key, field.read === 'exists' ? true : field.read === 'value' ? session.value : field.read === 'text' ? '查询公告' : attributes[field.attribute ?? ''] ?? null]))
      return { ok: true, output: { tab_id: session.tab, page_url: session.url, frame_url: session.url, scope: 'current_dom', truncated: false,
        items: [{ ref: '@e999', values, redacted: [] }] } }
    }
    if (args[0] === 'get-html') {
      const html = args.includes('@e1') ? '<input name="keyword" aria-label="公告关键词">'
        : browser.elementChanged ? '<button id="delete">删除记录</button>' : '<button id="search">查询公告</button>'
      return { ok: true, output: { tab_id: session.tab, html, byte_size: Buffer.byteLength(html), truncated: false } }
    }
    if (args[0] === 'fill' || args[0] === 'click') {
      browser.writes.push({ sessionId: id!, action: args[0], targetRef: args.find(value => /^@?e\d+$/.test(value))!,
        dependsOn: args.flatMap((value, index) => value === '--depends-on' ? [args[index + 1]!] : []),
        ...(args.includes('--expect') ? { expect: JSON.parse(args[args.indexOf('--expect') + 1]!) } : {}) })
      if (args[0] === 'fill') session.value = args[args.indexOf('--value') + 1]!
      return { ok: true, output: { tab_id: session.tab } }
    }
    throw new Error(`Unexpected synthetic browser command ${args[0]}`)
  })
}))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  browser.next = 0; browser.latest = ''; browser.sessions.clear(); browser.writes = []; browser.elementChanged = false; browser.modern = false
})

it.each([undefined, 'public_query_target'] as const)('runs independent scheduled tasks after expiry and restart with policy %s and no repeated approvals', async verificationPolicy => {
  const effectivePolicy = verificationPolicy ?? 'strict'
  browser.modern = verificationPolicy === 'public_query_target'
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-browser-schedule-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  let beforeNextFill: (() => void) | undefined
  let modelRequests = 0
  // This deterministic model and CLI replay verify production wiring, not a live website or model.
  const model = createServer(async (request, response) => {
    modelRequests += 1
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ function: { name: string } }>; messages?: Array<{ tool_calls?: Array<{ id: string }> }> }
    const initial = body.tools?.some(tool => tool.function.name === 'schedule_task')
    const called = new Set(body.messages?.flatMap(message => message.tool_calls?.map(call => call.id) ?? []))
    const steps = [
      ['start', 'browser_session_start'], ['navigate', 'browser_navigate'],
      ...(initial ? [['missing-fill-scope', 'browser_fill'], ['authorize-fill', 'browser_authorize_action']] : []), ['fill', 'browser_fill'],
      ...(initial ? [['authorize-click', 'browser_authorize_action']] : []), ['click', 'browser_click'],
      ['artifact', 'publish_artifact'], ...(initial ? [['schedule', 'schedule_task'], ['verify-schedule', 'list_schedules']] : [])
    ]
    const next = steps.find(([id]) => !called.has(`synthetic-${id}`))
    if (next?.[0] === 'fill' && beforeNextFill) {
      const action = beforeNextFill
      beforeNextFill = undefined
      action()
    }
    const sessionId = browser.latest
    const contextId = browser.sessions.get(sessionId)?.context
    let args: Record<string, unknown> = {}
    if (next?.[0] === 'navigate') args = { sessionId, url: 'https://public.example.test/search' }
    if (next?.[0] === 'fill' || next?.[0] === 'missing-fill-scope' || next?.[0] === 'authorize-fill') args = { sessionId, contextId, target: '@e1', value: '工程监测',
      ...(next[0] === 'authorize-fill' ? { action: 'fill', scope: 'schedule', scheduleAccess: 'public_query' } : {}) }
    if (next?.[0] === 'click' || next?.[0] === 'authorize-click') args = { sessionId, contextId, target: '@e2',
      ...(next[0] === 'authorize-click' ? { action: 'click', scope: 'schedule', scheduleAccess: 'public_query' } : {}) }
    if (next?.[0] === 'artifact') args = { path: 'report.html', content: '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>合成查询报告</title></head><body><h1>工程公告合成报告</h1><p>本报告只用于自动化回归。</p><a href="https://public.example.test/search">合成来源</a></body></html>' }
    const delta = next ? { tool_calls: [{ index: 0, id: `synthetic-${next[0]}`, type: 'function', function: { name: next[1], arguments: JSON.stringify(args) } }] }
      : { content: '已读取合成公开页面并保存HTML成果。计划按已确认范围保存和核验。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'synthetic-browser-schedule', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic', apiKey: 'synthetic-local-only',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions' as const, model: 'synthetic-model',
    approvalPolicy: 'on-request' as const, sandboxMode: 'read-only' as const, tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready',
      executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64), version: browser.modern ? '0.5.0' : '0.4.0',
      daemonProtocolVersion: browser.modern ? '1.9' : '1.7',
      browsers: [{ id: 'synthetic-browser', name: 'Chrome', label: '合成公开页面', connected: true, versionSkew: false,
        extensionVersion: browser.modern ? '0.5.0' : '0.4.0', protocolVersion: browser.modern ? '1.9' : '1.7' }],
      browserInstanceId: 'synthetic-browser', origins: ['https://public.example.test'], interaction: 'interact', revision: 1 } }) }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(async () => runtime.shutdown?.())
  let router = buildRouter(runtime)
  const approvalIds = new Set<string>()
  const approvals: string[] = []
  const unexpected: string[] = []
  let acceptingApprovals = true
  const approvalTimer = setInterval(() => {
    if (!acceptingApprovals) return
    for (const approval of runtime.approvalGate.pending()) {
      if (approvalIds.has(approval.id)) continue
      approvalIds.add(approval.id)
      if (!['browser_authorize_action', 'schedule_task'].includes(approval.toolName)) { unexpected.push(approval.toolName); continue }
      approvals.push(approval.toolName)
      void dispatchRequest(router, new Request(`http://localhost/v1/approvals/${approval.id}`, { method: 'POST',
        headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }) }))
    }
  }, 10)
  cleanup.push(async () => { clearInterval(approvalTimer) })
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic-model', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'public-browser-schedule',
    request: { prompt: '使用BrowserSkill查询 https://public.example.test/search 的公开工程监测公告并生成HTML报告，每天09:00和17:00执行。' } })
  expect(started).toMatchObject({ kind: 'capability_required', capability: { errorCode: 'browser_verification_policy_required' }, task: { status: 'waiting_user' } })
  const sourceId = started.task!.id
  expect((await runtime.threadService.get(started.task!.threadId))!.turns).toHaveLength(0)
  expect(modelRequests).toBe(0)
  const confirmPolicy = async (taskId: string, policy?: 'public_query_target') => {
    const path = `http://localhost/v1/tasks/${taskId}/browser-binding`
    const preview = await dispatchRequest(router, new Request(path, { headers: { authorization: 'Bearer synthetic' } }))
    expect(preview.status).toBe(200)
    const snapshot = await preview.json() as BrowserTaskBindingSnapshot
    expect(snapshot.verificationPolicy).toBe('strict')
    const response = await dispatchRequest(router, new Request(path, { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
      body: JSON.stringify({ confirmed: true, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
        browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: 'interact', ...(policy ? { verificationPolicy: policy } : {}), idempotencyKey: `policy:${taskId}:${policy ?? 'legacy'}` }) }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ resumed: false, binding: { verificationPolicy: policy ?? 'strict' } })
  }
  await confirmPolicy(sourceId, verificationPolicy)
  expect(runtime.taskRepository!.get(sourceId)!.status).toBe('waiting_user')
  expect((await runtime.threadService.get(started.task!.threadId))!.turns).toHaveLength(0)
  expect(modelRequests).toBe(0)
  expect(Object.hasOwn(runtime.taskRepository!.get(sourceId)!.authority!.browserScope!, 'verificationPolicy')).toBe(Boolean(verificationPolicy))
  await runtime.taskCoordinator!.command({ threadId: origin.id, taskId: sourceId, intent: 'resume', idempotencyKey: 'separate-source-resume', request: { prompt: '继续原任务' } })
  const waitCompleted = async (id: string) => {
    await expect.poll(() => {
      const task = runtime.taskRepository!.get(id)!
      return { status: task.status, reason: task.stalledReason ?? task.waitingReason ?? null, unexpected }
    }, { timeout: 15_000 }).toEqual({ status: 'completed', reason: null, unexpected: [] })
  }
  await waitCompleted(started.task!.id)
  expect(approvals).toEqual(['browser_authorize_action', 'browser_authorize_action', 'schedule_task'])
  const source = runtime.taskRepository!.get(started.task!.id)!
  const assertExecutionPolicy = async (task: TaskRun) => {
    const thread = (await runtime.threadService.get(task.threadId))!
    const turns = thread.turns.filter(turn => turn.executionGrant?.taskId === task.id)
    expect(turns).toHaveLength(1)
    const grant = turns[0]!.executionGrant!
    expect(task.authority!.browserScope!.verificationPolicy ?? 'strict').toBe(effectivePolicy)
    expect(grant.browserScope).toEqual(task.authority!.browserScope)
    expect(Object.hasOwn(grant.browserScope!, 'verificationPolicy')).toBe(Boolean(verificationPolicy))
    if (task.scheduledBy) expect(runtime.taskRepository!.attention(`capability_${task.id}`)).toBeNull()
    else expect(runtime.taskRepository!.attention(`capability_${task.id}`)).toMatchObject({ status: 'answered' })
    const dispatches = runtime.taskRepository!.operations(task.id, 'browser_action_dispatch')
    const derived = runtime.taskRepository!.operations(task.id, 'browser_derived_action_authorization')
    const errors = turns.flatMap(turn => turn.items).flatMap(item => item.kind === 'tool_result' && item.isError
      ? [{ toolName: item.toolName, code: (item.output as { code?: string } | undefined)?.code }] : [])
    expect(dispatches, JSON.stringify(errors)).toHaveLength(2)
    expect(derived).toHaveLength(2)
    for (const dispatch of dispatches) {
      const request = dispatch.request!
      expect(dispatch.status).toBe('succeeded')
      expect(request.verificationPolicy).toBe(effectivePolicy)
      expect(request.dependsOn).toEqual([])
      expect(dispatch.result).toMatchObject({ actionAcknowledged: true, readbackPending: false })
      const call = turns[0]!.items.find(item => item.kind === 'tool_call' && item.callId === `synthetic-${String(request.action)}`)
      expect(call?.kind).toBe('tool_call')
      if (call?.kind !== 'tool_call') throw new Error('Missing actual synthetic model action')
      expect(call.toolName).toBe(request.toolName)
      expect(request.targetRef).toBe(request.action === 'fill' ? '@e1' : '@e2')
      const authorization = derived.find(item => item.request?.action === request.action)
      expect(authorization?.status).toBe('succeeded')
      expect(authorization?.request).toMatchObject({ grantId: grant.id, turnId: turns[0]!.id, sessionId: request.sessionId, elementHash: request.elementHash })
      expect(authorization!.request!.verificationPolicy ?? 'strict').toBe(effectivePolicy)
      expect(authorization?.result).toMatchObject({ verificationPolicy: effectivePolicy })
      const inputFacts = (value: string) => [{ target: '@e1', field: 'exists', equals: true }, { target: '@e1', field: 'value', equals: value },
        { target: '@e1', field: 'attribute', attribute: 'name', equals: 'keyword' }, { target: '@e1', field: 'attribute', attribute: 'aria-label', equals: '公告关键词' }]
      const facts = request.action === 'fill' ? inputFacts('') : [{ target: '@e2', field: 'exists', equals: true },
        { target: '@e2', field: 'text', equals: '查询公告' }, { target: '@e2', field: 'attribute', attribute: 'id', equals: 'search' }, ...inputFacts('工程监测')]
      if (verificationPolicy) {
        expect(request.expectationVersion).toBe('native-dom-v1')
        expect(request.expectationHash).toBe(createHash('sha256').update(JSON.stringify(facts)).digest('hex'))
        if (request.action === 'fill') expect((dispatch.result as { publicQueryInput?: unknown }).publicQueryInput).toEqual({
          target: '@e1', value: '工程监测', elementHash: request.elementHash, frameUrl: 'https://public.example.test/search'
        })
      } else {
        expect(request.expectationVersion).toBeUndefined(); expect(request.expectationHash).toBeUndefined()
        expect((dispatch.result as { publicQueryInput?: unknown }).publicQueryInput).toBeUndefined()
      }
      expect(browser.writes.filter(write => write.sessionId === request.sessionId && write.action === request.action)).toEqual([
        { sessionId: request.sessionId, action: request.action, targetRef: request.targetRef, dependsOn: [], ...(verificationPolicy ? { expect: facts } : {}) }
      ])
    }
    return grant
  }
  const sourceGrant = await assertExecutionPolicy(source)
  expect(runtime.taskRepository!.operations(source.id, 'browser_action_scope_request')).toHaveLength(1)
  expect(runtime.taskRepository!.attention(`capability_${source.id}`)).toMatchObject({ status: 'answered' })
  const flow = runtime.flowService!.get(`schedule_${source.id}`)!
  const publishedScope = (flow.variables.taskSchedule as { scope: { browserScope: typeof sourceGrant.browserScope; browserScheduleActions: BrowserScheduleAction[] } }).scope
  expect(publishedScope.browserScope).toEqual(source.authority!.browserScope)
  expect(publishedScope.browserScheduleActions).toHaveLength(2)
  for (const action of publishedScope.browserScheduleActions) {
    expect(action.verificationPolicy).toBe(effectivePolicy)
    expect(action.summary).toContain(`校验范围 "${verificationPolicy ? '公开查询目标及明确依赖' : '完整页面与目标'}"`)
    expect(Object.hasOwn(action, 'dependsOn') || Object.hasOwn(action, 'targetRef')).toBe(false)
  }
  if (verificationPolicy === 'public_query_target') {
    // Restore an old policy-less authorization into a separate waiting task.
    // Explicitly changing that task's policy must retain, but never reuse, the old record.
    const legacyStarted = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'legacy-policy-record', request: { prompt: source.goal } })
    expect(legacyStarted.kind).toBe('capability_required')
    const legacyId = legacyStarted.task!.id
    await confirmPolicy(legacyId)
    const { id: _id, approvalId, summary, verificationPolicy: _policy, ...oldFields } = publishedScope.browserScheduleActions[0]!
    const legacyFields = { ...oldFields, sourceTaskId: legacyId, scheduleId: `schedule_${legacyId}` }
    const legacyAction = { id: createHash('sha256').update(JSON.stringify(legacyFields)).digest('hex'), ...legacyFields, approvalId,
      summary: summary.split('\n').filter(line => !line.startsWith('校验范围 ')).join('\n') }
    const key = `browser-schedule-action:${legacyAction.id}`
    runtime.taskRepository!.beginOperation({ ownerId: legacyId, idempotencyKey: key, kind: 'browser_schedule_action_authorization', request: legacyFields, nowIso: new Date().toISOString() })
    runtime.taskRepository!.finishOperation(legacyId, key, { status: 'succeeded', result: legacyAction })
    expect(listApprovedBrowserScheduleActions(runtime.taskRepository!, runtime.taskRepository!.get(legacyId)!)).toHaveLength(1)
    const oldBytes = JSON.stringify(runtime.taskRepository!.operation(legacyId, key))
    const writesBefore = browser.writes.length, requestsBefore = modelRequests
    await confirmPolicy(legacyId, 'public_query_target')
    expect(listApprovedBrowserScheduleActions(runtime.taskRepository!, runtime.taskRepository!.get(legacyId)!)).toEqual([])
    expect(JSON.stringify(runtime.taskRepository!.operation(legacyId, key))).toBe(oldBytes)
    expect((await runtime.threadService.get(legacyStarted.task!.threadId))!.turns).toHaveLength(0)
    expect(browser.writes).toHaveLength(writesBefore)
    expect(modelRequests).toBe(requestsBefore)
  }
  const dueAt = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(dueAt))
  await runtime.flowService!.tickSchedules(new Date())
  const occurrence = (): TaskRun | undefined => runtime.taskRepository!.list().find(task => task.scheduledBy?.scheduleId === flow.id && task.scheduledBy.dueAt === dueAt)
  await expect.poll(() => occurrence()?.id, { timeout: 5_000 }).toBeTruthy()
  await waitCompleted(occurrence()!.id)
  const first = occurrence()!
  const checkedFirstGrant = await assertExecutionPolicy(first)
  expect(checkedFirstGrant.id).not.toBe(sourceGrant.id)
  const firstGrant = (await runtime.threadService.get(first.threadId))!.turns.find(turn => turn.id === first.activeTurnId)!.executionGrant!
  expect(firstGrant.browserScheduleBinding).toMatchObject({ scheduleId: flow.id, versionId: flow.publishedVersionId, sourceTaskId: source.id })
  expect(runtime.taskRepository!.operations(first.id, 'browser_derived_action_authorization')).toHaveLength(2)
  acceptingApprovals = false
  await runtime.shutdown?.()
  vi.setSystemTime(new Date(Date.parse(dueAt) + 20 * 60_000))
  runtime = await createKunServeRuntime(options)
  router = buildRouter(runtime)
  acceptingApprovals = true
  const secondDue = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  vi.setSystemTime(new Date(secondDue))
  await runtime.flowService!.tickSchedules(new Date())
  const secondTask = () => runtime.taskRepository!.list().find(task => task.scheduledBy?.scheduleId === flow.id && task.id !== first.id)
  await expect.poll(() => secondTask()?.id, { timeout: 5_000 }).toBeTruthy()
  await waitCompleted(secondTask()!.id)
  const secondGrant = await assertExecutionPolicy(secondTask()!)
  expect(secondGrant.id).not.toBe(checkedFirstGrant.id)
  expect(secondGrant.id).not.toBe(sourceGrant.id)
  expect(secondTask()!.threadId).not.toBe(first.threadId)
  expect(new Set(browser.writes.map(write => write.sessionId)).size).toBe(3)
  expect(browser.writes).toHaveLength(6)
  expect(approvals).toHaveLength(3)
  expect(runtime.taskRepository!.operations(secondTask()!.id, 'browser_derived_action_authorization')).toHaveLength(2)
  expect(runtime.taskRepository!.operations(source.id, 'browser_schedule_action_authorization')).toHaveLength(2)
  expect(runtime.taskRepository!.operations(source.id, 'browser_action_authorization').every(receipt =>
    Date.parse((receipt.result as { expiresAt: string }).expiresAt) < Date.now())).toBe(true)
  browser.elementChanged = true
  const changedDue = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  vi.setSystemTime(new Date(changedDue))
  await runtime.flowService!.tickSchedules(new Date())
  const changedTask = () => runtime.taskRepository!.list().find(task => task.scheduledBy?.dueAt === changedDue)
  await expect.poll(() => changedTask()?.status, { timeout: 10_000 }).toBe('waiting_user')
  expect(runtime.taskRepository!.attention(`capability_${changedTask()!.id}`)).toMatchObject({ status: 'pending', payload: {
    capability: { provider: 'browser-skill', errorCode: 'browser_public_query_target_blocked' }
  } })
  expect(browser.writes.filter(write => write.action === 'click')).toHaveLength(3)
  expect(browser.writes).toHaveLength(7)
  expect(approvals).toHaveLength(3)
  expect(unexpected).toEqual([])
  browser.elementChanged = false
  beforeNextFill = () => {
    const saved = runtime.flowService!.get(flow.id)!
    runtime.flowService!.update({ ...saved, variables: { ...saved.variables, enabled: false } }, saved.revision)
  }
  const disabledDue = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  vi.setSystemTime(new Date(disabledDue))
  await runtime.flowService!.tickSchedules(new Date())
  const disabledTask = () => runtime.taskRepository!.list().find(task => task.scheduledBy?.dueAt === disabledDue)
  await expect.poll(() => disabledTask()?.status, { timeout: 10_000 }).toBe('waiting_user')
  expect(runtime.taskRepository!.attention(`capability_${disabledTask()!.id}`)).toMatchObject({ status: 'pending', payload: {
    capability: { provider: 'schedule', errorCode: 'browser_schedule_authority_changed' }
  } })
  expect(browser.writes).toHaveLength(7)
  expect(approvals).toHaveLength(3)
  expect(unexpected).toEqual([])
  const before = runtime.taskRepository!.list().length
  await runtime.flowService!.tickSchedules(new Date(Date.parse(disabledDue) + 24 * 60 * 60_000))
  expect(runtime.taskRepository!.list()).toHaveLength(before)
  expect(browser.writes).toHaveLength(7)
  const stopped = runtime.flowService!.get(flow.id)!
  runtime.flowService!.update({ ...stopped, variables: { ...stopped.variables, enabled: true } }, stopped.revision)
  beforeNextFill = () => {
    // Persistent unknown-outcome boundary injected before any new input.
    runtime.taskRepository!.beginOperation({ ownerId: source.id, idempotencyKey: 'unresolved-source-action', kind: 'browser_schedule_action_outcome',
      request: { scheduleId: flow.id, taskId: source.id, action: 'fill' }, nowIso: new Date().toISOString() })
    runtime.taskRepository!.finishOperation(source.id, 'unresolved-source-action', { status: 'outcome_unknown' })
  }
  const unknownDue = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  vi.setSystemTime(new Date(unknownDue))
  await runtime.flowService!.tickSchedules(new Date())
  const unknownTask = () => runtime.taskRepository!.list().find(task => task.scheduledBy?.dueAt === unknownDue)
  await expect.poll(() => unknownTask()?.status, { timeout: 10_000 }).toBe('waiting_user')
  expect(runtime.taskRepository!.attention(`capability_${unknownTask()!.id}`)).toMatchObject({ status: 'pending', payload: {
    capability: { provider: 'schedule', errorCode: 'browser_schedule_outcome_unknown' }
  } })
  expect(runtime.taskRepository!.operation(source.id, 'unresolved-source-action')?.status).toBe('outcome_unknown')
  expect(browser.writes).toHaveLength(7)
  expect(approvals).toHaveLength(3)
  expect(unexpected).toEqual([])
}, 60_000)
