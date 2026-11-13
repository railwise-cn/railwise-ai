import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

const cleanup: Array<() => void> = []
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
  const workspace = { canonicalRoot: '/workspace', level: 'workspace-write', revision: 1 }
  const execution = ThreadSchema.parse({ id: 'execution', title: 'test', workspace: '/workspace', model: 'test', mode: 'agent', status: 'idle',
    agentRevision: 1, agentProfile: { id: 'general', name: 'General', role: 'General', color: 'blue', systemPrompt: 'Test', toolAllowlist: ['*'], mcpAllowlist: ['*'], trustLevel: 'workspace-write', budget: { maxAttempts: 10, maxDurationMs: 600000 }, revision: 1 }, approvalPolicy: 'on-request', sandboxMode: 'workspace-write', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const origin = { ...execution, id: 'origin', approvalPolicy: 'never' as const }
  const threads = new Map([['execution', execution], ['origin', origin]])
  const coordinator = { command: vi.fn(async (_command: unknown, _options?: unknown) => ({ kind: 'task_started' })) }
  const service = new TaskScheduleService({ flows, repository, tasks: { activeTask: () => repository.get(task.id) } as never,
    coordinator: coordinator as never, threads: { get: async (id: string) => threads.get(id), upsert: async (value: typeof execution) => { threads.set(value.id, value); return value } } as never,
    workspaceTrust: { get: async () => workspace } as never, connectorIdentities: () => identities, nowIso: () => new Date().toISOString() })
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
  return { service, flows, flowRepository, repository, task, context, coordinator, identities, workspace, threads, temporaryPaths }
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
})
