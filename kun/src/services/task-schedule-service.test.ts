import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowRepository } from '../flow/repository.js'
import { FlowRuntimeService } from '../flow/service.js'
import { buildCoreFlowAdapters } from '../flow/core-adapters.js'
import { buildFlowNodeRegistry } from '../flow/node-registry.js'
import { TaskRunRepository } from './task-run-repository.js'
import { TaskRunSchema } from '../contracts/tasks.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { ThreadSchema } from '../contracts/threads.js'
import { TaskScheduleService } from './task-schedule-service.js'
import { buildTaskScheduleToolProvider } from '../adapters/tool/task-schedule-tool-provider.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { BrowserCapabilityConfig } from '../contracts/browser-skill.js'
import { BrowserScheduleActionAuthority } from './browser-schedule-action-authority.js'
import { browserApprovalSummary } from '../security/browser-approval-summary.js'
import type { OperationReceipt } from '../contracts/tasks.js'

const cleanup: Array<() => void> = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const browserTargetHtml = { click: '<button>查询公告</button>', fill: '<input aria-label="关键词">' }
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T00:00:00Z'))
  const root = mkdtempSync(join(tmpdir(), 'railwise-schedule-test-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
  const flowRepository = new FlowRepository(':memory:')
  const flows = new FlowRuntimeService(flowRepository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
  cleanup.push(() => { flows.shutdown(); repository.close(); rmSync(root, { recursive: true, force: true }) })
  const task = repository.create(TaskRunSchema.parse({ id: 'task-test', threadId: 'execution', originThreadId: 'origin', activeTurnId: 'turn',
    childTaskIds: [], workspaceRoot: '/workspace', goal: '抓取网页并生成HTML，每天9点和17点前执行。', status: 'running',
    acceptance: { kind: 'files', requiredNodeKinds: ['execute', 'verify', 'deliver'], requireFinalResponse: true, requireActionableArtifactCard: true,
      schedule: { kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 } },
    agentId: 'general', budget: { maxAttempts: 10, maxDurationMs: 600000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [], artifacts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 }))
  const grant = ExecutionGrantSchema.parse({ id: 'grant', taskId: task.id, threadId: 'execution', turnId: 'turn', workspaceRoot: '/workspace',
    workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
    pathAllowlist: ['/workspace'], networkAllowlist: ['https://example.test'], connectorIdentityFingerprints: { 'mcp:test': 'a'.repeat(64) },
    workspaceRevision: 1, agentRevision: 1, revision: 1, idempotencyKey: 'grant', issuedAt: new Date().toISOString() })
  const identities = { 'mcp:test': 'a'.repeat(64) }
  const browser = BrowserCapabilityConfig.parse({ enabled: true, state: 'ready', browserInstanceId: 'browser-one', revision: 1,
    origins: ['https://example.test'], interaction: 'interact' })
  const workspace = { canonicalRoot: '/workspace', level: 'workspace-write', revision: 1 }
  const execution = ThreadSchema.parse({ id: 'execution', title: 'test', workspace: '/workspace', model: 'test', mode: 'agent', status: 'idle',
    agentRevision: 1, agentProfile: { id: 'general', name: 'General', role: 'General', color: 'blue', systemPrompt: 'Test', toolAllowlist: ['*'], mcpAllowlist: ['*'], trustLevel: 'workspace-write', budget: { maxAttempts: 10, maxDurationMs: 600000 }, revision: 1 }, approvalPolicy: 'on-request', sandboxMode: 'workspace-write', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const origin = { ...execution, id: 'origin', approvalPolicy: 'never' as const }
  const threads = new Map([['execution', execution], ['origin', origin]])
  const coordinator = { command: vi.fn(async (_command: unknown, _options?: unknown) => ({ kind: 'task_started' })) }
  const service = new TaskScheduleService({ flows, repository, tasks: { activeTask: () => repository.get(task.id) } as never,
    coordinator: coordinator as never, threads: { get: async (id: string) => threads.get(id), upsert: async (value: typeof execution) => { threads.set(value.id, value); return value } } as never,
    workspaceTrust: { get: async () => workspace } as never, connectorIdentities: () => identities, browserState: () => browser, nowIso: () => new Date().toISOString() })
  flows.setTaskScheduleDispatcher(input => service.dispatch(input))
  const context = { threadId: 'execution', turnId: 'turn', workspace: '/workspace', executionGrant: grant, validateExecutionGrant: vi.fn(), abortSignal: new AbortController().signal, awaitApproval: vi.fn(async () => 'allow') } as unknown as ToolHostContext
  function temporaryPaths() {
    const current = repository.get(task.id)!
    repository.update(task.id, current.revision, value => ({ ...value, authority: { source: 'user', workspaceRoot: '/workspace', externalTargets: [], grantedAt: new Date().toISOString(),
      taskApprovalGrant: { id: 'temporary', taskId: task.id, threadId: 'execution', previousPolicy: 'never', approvalPolicy: 'on-request', workspaceRoot: '/workspace', workspaceRevision: 1, workspaceTrust: 'workspace-write', agentRevision: 1, scopeFingerprint: 'a'.repeat(64), status: 'active', confirmed: true, confirmedAt: new Date().toISOString(), expiresAt: '2026-11-13T00:15:00.000Z', idempotencyKey: 'temporary', scope: { readPaths: ['/workspace'], writePaths: ['/workspace/reports'] }, workspaceWriteException: true, duration: 'task' } } }))
    grant.workspaceWriteException = true
    grant.readPathAllowlist = ['/workspace']
    grant.writePathAllowlist = ['/workspace/reports']
  }
  function approveBrowserAction(action: 'click' | 'fill') {
    grant.browserScope = { browserInstanceId: 'browser-one', revision: 1, origins: ['https://example.test'], interaction: 'interact' }
    const current = repository.get(task.id)!
    if (!current.authority?.browserScope) repository.update(current.id, current.revision, value => ({ ...value, authority: {
      source: 'user', workspaceRoot: '/workspace', externalTargets: [], grantedAt: new Date().toISOString(), browserScope: grant.browserScope
    } }))
    const browserAuthority = new BrowserScheduleActionAuthority({ repository })
    const candidate = browserAuthority.prepare(task.id, grant.browserScope, { action, pageUrl: 'https://example.test/search',
      elementHash: digest(browserTargetHtml[action]), ...(action === 'fill' ? { valueHash: digest('工程监测') } : {}) })
    return browserAuthority.save(candidate, `approved-${action}`, browserApprovalSummary({ action, origin: 'https://example.test',
      targetHtml: browserTargetHtml[action], value: action === 'fill' ? '工程监测' : undefined,
      requestHash: candidate.id }))
  }
  function browserTool(toolName: string, options: { status?: OperationReceipt['status']; output?: Record<string, unknown>; request?: Record<string, unknown>; approved?: boolean } = {}) {
    grant.browserScope ??= { browserInstanceId: 'browser-one', revision: 1, origins: ['https://example.test'], interaction: 'interact' }
    const key = `tool-${repository.operations(task.id).length}`
    repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'tool', nowIso: new Date().toISOString(), request: {
      toolName, callId: key, turnId: 'turn', argumentsHash: digest(key), approvalRequestHash: digest(key), executionGrant: grant, ...options.request
    } })
    return repository.finishOperation(task.id, key, { status: options.status ?? 'succeeded', result: { approved: options.approved ?? true,
      item: { kind: 'tool_result', toolName, output: { status: options.status ?? 'succeeded', provider: 'browser-skill', sessionId: 'session-one', ...options.output } }
    } })
  }
  function browserDispatch(action: 'click' | 'fill', status: OperationReceipt['status'] = 'succeeded', request: Record<string, unknown> = {}) {
    const key = `dispatch-${repository.operations(task.id).length}`
    repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'browser_action_dispatch', nowIso: new Date().toISOString(), request: {
      action, toolName: `browser_${action}`, turnId: 'turn', argumentsHash: digest(key), pageUrl: 'https://example.test/search',
      elementHash: digest(browserTargetHtml[action]), ...(action === 'fill' ? { valueHash: digest('工程监测') } : {}),
      browserInstanceId: 'browser-one', browserRevision: 1, ...request
    } })
    return repository.finishOperation(task.id, key, { status })
  }
  return { service, flows, flowRepository, repository, task, context, coordinator, identities, workspace, threads, temporaryPaths, approveBrowserAction, browserTool, browserDispatch }
}

describe('task-owned recurring execution', () => {
  it('uses discoverable tools to create and read back both times before accepting completion', async () => {
    const f = fixture()
    const tools = buildTaskScheduleToolProvider(() => f.service).tools
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
    await tools.find(tool => tool.name === 'schedule_task')!.execute({}, f.context)
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
    const read = await tools.find(tool => tool.name === 'list_schedules')!.execute({}, f.context)
    expect(read.output).toMatchObject({ schedules: [{ schedule: { kind: 'daily', times: ['08:30', '16:30'], timezone: 'Asia/Shanghai' }, nextRunAt: '2026-11-13T00:30:00.000Z' }] })
    expect(f.service.assessCompletion(f.task)).toBeNull()
    await f.service.create(f.context)
    expect(f.flows.list()).toHaveLength(1)
  })
  it('dispatches both occurrences through the task coordinator with a durable dedupe key', async () => {
    const f = fixture()
    await f.service.create(f.context)
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    expect(f.coordinator.command).toHaveBeenCalledTimes(1)
    expect(f.coordinator.command.mock.calls[0]?.[0]).toMatchObject({ threadId: 'origin', intent: 'new', idempotencyKey: 'schedule:schedule_task-test:2026-11-13T00:30:00.000Z' })
    await f.flows.tickSchedules(new Date('2026-11-13T08:30:00Z'))
    expect(f.coordinator.command).toHaveBeenCalledTimes(2)
    expect(f.flowRepository.pendingOutbox('scheduled_task_dispatch')).toHaveLength(0)
    expect(f.flows.history('schedule_task-test')).toHaveLength(0)
  })
  it('preserves a pending occurrence when connector identity changes and recovers without replay', async () => {
    const f = fixture()
    await f.service.create(f.context)
    f.identities['mcp:test'] = 'b'.repeat(64)
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.flowRepository.pendingOutbox('scheduled_task_dispatch')).toHaveLength(1)
    f.identities['mcp:test'] = 'a'.repeat(64)
    await f.flows.flushSourceEvents()
    await f.flows.flushSourceEvents()
    expect(f.coordinator.command).toHaveBeenCalledTimes(1)
  })
  it('recalculates nextRunAt after changing the actual schedule fields', async () => {
    const f = fixture()
    await f.service.create(f.context)
    const flow = f.flows.get('schedule_task-test')!
    f.flows.update({ ...flow, nodes: flow.nodes.map(node => ({ ...node, config: { kind: 'daily', times: ['10:15'], timezone: 'Asia/Shanghai' } })) }, flow.revision)
    f.flows.publish(flow.id)
    expect(f.flowRepository.getTriggerState(flow.id, 'schedule')?.nextRunAt).toBe('2026-11-13T02:15:00.000Z')
    f.service.readback(f.context)
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
  })
  it('keeps an explicitly confirmed recurring path scope after the temporary task grant expires', async () => {
    const f = fixture()
    f.temporaryPaths()
    const saved = await f.service.create(f.context)
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(vi.mocked(f.context.awaitApproval).mock.calls[0]?.[0].summary).toContain('/workspace/reports')
    expect(saved.authorization).toMatchObject({ kind: 'confirmed_scope', until: 'disabled', expiresAt: null })
    expect(saved.scope).toMatchObject({ workspaceWriteException: true, permissionScope: { writePaths: ['/workspace/reports'] } })
    expect(saved.scope.expiresAt).toBeUndefined()
    vi.setSystemTime(new Date('2026-11-14T00:30:00Z'))
    await f.flows.tickSchedules(new Date())
    expect(f.coordinator.command).toHaveBeenCalledOnce()
    const hooks = f.coordinator.command.mock.calls[0]?.[1] as { prepareExecutionThread(thread: unknown): Promise<void> }
    const occurrence = { ...f.threads.get('origin')!, id: 'occurrence', turns: [] }
    f.threads.set('occurrence', occurrence)
    await hooks.prepareExecutionThread(occurrence)
    expect(f.threads.get('origin')?.approvalPolicy).toBe('never')
    expect(f.threads.get('occurrence')?.approvalPolicy).toBe('on-request')
    expect(await f.service.executionScopeForThread('occurrence')).toMatchObject({ workspaceWriteException: true, writePathAllowlist: ['/workspace/reports'] })
    await hooks.prepareExecutionThread(f.threads.get('occurrence'))
    expect(f.repository.operations('occurrence', 'scheduled_task_prepare')).toHaveLength(1)
    f.threads.get('occurrence')!.approvalPolicy = 'never'
    await expect(hooks.prepareExecutionThread(f.threads.get('occurrence'))).rejects.toThrow('权限已变化')
  })
  it('does not create or complete a plan when durable path scope is denied', async () => {
    const f = fixture()
    f.temporaryPaths()
    vi.mocked(f.context.awaitApproval).mockResolvedValue('deny')
    await expect(f.service.create(f.context)).rejects.toThrow('持续计划权限未获确认')
    expect(f.flows.list()).toHaveLength(0)
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
  })
  it.each(['origin', 'execution', 'revoked', 'scope'])('blocks recurrence when its %s authority changes', async change => {
    const f = fixture()
    f.temporaryPaths()
    await f.service.create(f.context)
    if (change === 'origin' || change === 'execution') f.threads.get(change)!.agentRevision += 1
    else {
      const current = f.repository.get(f.task.id)!
      f.repository.update(current.id, current.revision, value => ({ ...value, authority: { ...value.authority!, taskApprovalGrant: { ...value.authority!.taskApprovalGrant!,
        ...(change === 'revoked' ? { revokedAt: new Date().toISOString() } : { scope: { writePaths: ['/other'] } }) } } }))
    }
    await f.flows.tickSchedules(new Date('2026-11-14T00:30:00Z'))
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.flowRepository.pendingOutbox('scheduled_task_dispatch')).toHaveLength(1)
  })
  it('rejects a scope forged through editable Flow variables', async () => {
    const f = fixture()
    await f.service.create(f.context)
    const flow = f.flows.get('schedule_task-test')!
    const authority = flow.variables.taskSchedule as { scope: { writePathAllowlist?: string[] } }
    authority.scope.writePathAllowlist = ['*']
    f.flows.update({ ...flow, variables: { ...flow.variables, taskSchedule: authority } }, flow.revision)
    await expect(f.service.create(f.context)).rejects.toThrow('原始确认不一致')
  })
  it('explicitly versions added browser actions, preserves disabled state and old receipts, and rejects an old occurrence', async () => {
    const f = fixture()
    f.approveBrowserAction('click')
    const original = await f.service.create(f.context)
    const previous = f.flows.get(original.id)!
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(vi.mocked(f.context.awaitApproval).mock.calls[0]![0].summary).toContain('确认周期浏览器权限')
    await f.service.dispatch({ scheduleId: original.id, versionId: previous.publishedVersionId!, dueAt: '2026-11-13T00:30:00.000Z' })
    const hooks = f.coordinator.command.mock.calls[0]![1] as { prepareExecutionThread(thread: unknown): Promise<void> }
    const occurrence = { ...f.threads.get('origin')!, id: 'occurrence', turns: [] }
    f.threads.set(occurrence.id, occurrence)
    await hooks.prepareExecutionThread(occurrence)
    const originalReceipt = f.repository.operations(f.task.id, 'schedule_authority')[0]!
    const firstScope = await f.service.executionScopeForThread(occurrence.id)
    expect(firstScope?.browserScheduleBinding).toMatchObject({ scheduleId: original.id, versionId: previous.publishedVersionId })
    f.flows.update({ ...previous, variables: { ...previous.variables, enabled: false } }, previous.revision)
    f.approveBrowserAction('fill')
    f.browserDispatch('fill')
    const updated = await f.service.create(f.context)
    expect(updated.enabled).toBe(false)
    expect(updated.scope.browserScheduleActions).toHaveLength(2)
    expect(f.flows.list()).toHaveLength(1)
    expect(f.flows.get(original.id)!.publishedVersionId).not.toBe(previous.publishedVersionId)
    expect(f.context.awaitApproval).toHaveBeenCalledTimes(2)
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toHaveLength(2)
    expect(f.repository.operation(f.task.id, originalReceipt.idempotencyKey)).toEqual(originalReceipt)
    expect(await f.service.create(f.context)).toEqual(updated)
    expect(f.context.awaitApproval).toHaveBeenCalledTimes(2)
    await expect(f.service.executionScopeForThread(occurrence.id)).rejects.toThrow('计划已禁用或范围已变化')
  })
  it('does not silently promote an old temporary browser action into recurring authority', async () => {
    const f = fixture()
    f.repository.beginOperation({ ownerId: f.task.id, kind: 'browser_action_authorization', idempotencyKey: 'old-15-minutes', request: { action: 'click' }, nowIso: new Date().toISOString() })
    f.repository.finishOperation(f.task.id, 'old-15-minutes', { status: 'succeeded', result: { expiresAt: '2026-11-13T00:15:00.000Z' } })
    const saved = await f.service.create(f.context)
    expect(saved.scope.browserScheduleActions).toBeUndefined()
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'browser_action_authorization')).toHaveLength(1)
  })
  it.each(['browser_click', 'browser_fill', 'browser_press'])('blocks legacy successful %s before plan approval or publication', async toolName => {
    const f = fixture()
    f.browserTool(toolName)
    const publish = vi.spyOn(f.flows, 'publish')
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toHaveLength(0)
  })
  it('requires an exact continuous review for a dispatched action and then creates its plan idempotently', async () => {
    const f = fixture()
    const dispatch = f.browserDispatch('fill')
    f.browserTool('browser_fill', { request: { argumentsHash: dispatch.request!.argumentsHash }, output: { dispatchReceiptId: dispatch.id } })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    f.approveBrowserAction('fill')
    const publish = vi.spyOn(f.flows, 'publish')
    const saved = await f.service.create(f.context)
    expect(saved.scope.browserScheduleActions).toHaveLength(1)
    expect(await f.service.create(f.context)).toEqual(saved)
    expect(publish).toHaveBeenCalledOnce()
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(f.repository.operations(f.task.id, 'browser_action_dispatch')).toEqual([dispatch])
  })
  it.each(['browser_navigate', 'browser_observe', 'browser_get_html'])('allows a read-only %s history without action descriptors', async toolName => {
    const f = fixture()
    f.browserTool(toolName)
    expect((await f.service.create(f.context)).scope.browserScheduleActions).toBeUndefined()
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it('ignores an explicitly nondispatched browser attempt', async () => {
    const f = fixture()
    f.browserTool('browser_fill', { status: 'failed', output: { status: 'failed', code: 'browser_schedule_action_scope_required' } })
    f.browserTool('browser_click', { status: 'failed', approved: false, request: { dispatchTracking: 'host-v1' }, output: { code: 'operation_not_dispatched' } })
    expect((await f.service.create(f.context)).scope.browserScheduleActions).toBeUndefined()
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it.each(['tool', 'journal'])('blocks an unknown %s outcome even after explicit continuous review', async kind => {
    const f = fixture()
    f.approveBrowserAction('click')
    if (kind === 'tool') f.browserTool('browser_click', { status: 'outcome_unknown' })
    else f.browserDispatch('click', 'outcome_unknown')
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
    expect(f.flows.list()).toHaveLength(0)
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    expect(f.coordinator.command).not.toHaveBeenCalled()
  })
  it.each(['pageUrl', 'elementHash', 'valueHash', 'browserInstanceId', 'browserRevision'])('rejects a dispatched fill with a different %s', async field => {
    const f = fixture()
    f.approveBrowserAction('fill')
    f.browserDispatch('fill', 'succeeded', { [field]: field === 'browserRevision' ? 2 : 'different' })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it('rejects a tool result linked to a different dispatch request', async () => {
    const f = fixture()
    f.approveBrowserAction('fill')
    const dispatch = f.browserDispatch('fill')
    f.browserTool('browser_fill', { output: { dispatchReceiptId: dispatch.id } })
    await expect(f.service.create(f.context)).rejects.toThrow('执行凭据与原工具请求不匹配')
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it.each(['matched', 'missing_observation', 'wrong_request', 'wrong_target'])('migrates a legacy action only with provable %s target evidence', async variant => {
    const f = fixture()
    if (variant !== 'missing_observation') f.browserTool('browser_observe', { output: { sourceUrl: 'https://example.test/search', observation: { context_id: 'context-one' } } })
    const operation = f.browserTool('browser_click', { output: { sourceUrl: 'https://example.test/redirected' } })
    const requestHash = String(operation.request!.approvalRequestHash)
    const summary = browserApprovalSummary({ action: 'click', origin: 'https://example.test',
      targetHtml: variant === 'wrong_target' ? '<button>删除</button>' : browserTargetHtml.click, requestHash })
    f.repository.saveHumanRequest({ id: `appr_${operation.request!.callId}`, kind: 'approval', threadId: f.task.threadId, turnId: 'turn',
      message: summary, payload: { approval: { toolName: 'browser_click', callId: operation.request!.callId,
        requestHash: variant === 'wrong_request' ? digest('wrong') : requestHash, summary } }, status: 'answered', resolution: { decision: 'allow' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    f.approveBrowserAction('click')
    if (variant === 'matched') {
      expect((await f.service.create(f.context)).scope.browserScheduleActions?.[0]?.pageUrl).toBe('https://example.test/search')
      expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    } else {
      await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
      expect(f.context.awaitApproval).not.toHaveBeenCalled()
    }
    expect(f.repository.operation(f.task.id, operation.idempotencyKey)).toEqual(operation)
  })
  it('rechecks browser evidence after plan approval before persisting or publishing', async () => {
    const f = fixture()
    f.approveBrowserAction('click')
    vi.mocked(f.context.awaitApproval).mockImplementation(async () => { f.browserDispatch('click', 'outcome_unknown'); return 'allow' })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toHaveLength(0)
    expect(f.flows.list()).toHaveLength(0)
  })
  it('blocks recurrence of a previously published plan after an unreviewed browser action', async () => {
    const f = fixture()
    f.browserTool('browser_observe')
    const saved = await f.service.create(f.context)
    const versionId = f.flows.get(saved.id)!.publishedVersionId!
    f.browserDispatch('click')
    await expect(f.service.dispatch({ scheduleId: saved.id, versionId, dueAt: '2026-11-13T00:30:00.000Z' }))
      .rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.repository.attention(`schedule:${saved.id}`)?.status).toBe('pending')
  })
  it('recovers an approved managed draft after publication fails without another approval or receipt', async () => {
    const f = fixture()
    f.approveBrowserAction('click')
    vi.spyOn(f.flows, 'publish').mockImplementationOnce(() => { throw new Error('Synthetic crash before Flow publication') })
    await expect(f.service.create(f.context)).rejects.toThrow('Synthetic crash')
    expect(f.service.readback(f.context).schedules).toHaveLength(0)
    const receipt = f.repository.operations(f.task.id, 'schedule_authority')[0]!
    const recovered = await f.service.create(f.context)
    expect(recovered.enabled).toBe(true)
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toEqual([receipt])
    expect(f.flows.list()).toHaveLength(1)
  })
  it.each(['revoked', 'unknown'])('does not dispatch when recurring browser authorization is %s', async condition => {
    const f = fixture()
    f.approveBrowserAction('click')
    const saved = await f.service.create(f.context)
    if (condition === 'revoked') {
      const approval = f.repository.operations(f.task.id, 'browser_schedule_action_authorization')[0]!
      f.repository.finishOperation(f.task.id, approval.idempotencyKey, { status: 'failed', error: 'Synthetic revoked authorization' })
    } else {
      f.repository.beginOperation({ ownerId: f.task.id, kind: 'browser_schedule_action_outcome', idempotencyKey: 'unknown-action', request: { scheduleId: saved.id }, nowIso: new Date().toISOString() })
      f.repository.finishOperation(f.task.id, 'unknown-action', { status: 'outcome_unknown', error: 'Synthetic unknown result' })
    }
    const versionId = f.flows.get(saved.id)!.publishedVersionId!
    await expect(f.service.dispatch({ scheduleId: saved.id, versionId, dueAt: '2026-11-13T00:30:00.000Z' })).rejects.toThrow()
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.repository.attention(`schedule:${saved.id}`)?.status).toBe('pending')
  })
})
