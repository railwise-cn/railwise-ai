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
  const coordinator = { command: vi.fn(async (_command: unknown, _options?: unknown) => ({ kind: 'task_started' })) }
  const service = new TaskScheduleService({ flows, repository, tasks: { activeTask: () => task } as never,
    coordinator: coordinator as never, threads: { get: async () => ({ workspace: '/workspace', agentRevision: 1, agentProfile: { trustLevel: 'workspace-write' }, approvalPolicy: 'on-request' }) } as never,
    workspaceTrust: { get: async () => workspace } as never, connectorIdentities: () => identities, nowIso: () => new Date().toISOString() })
  flows.setTaskScheduleDispatcher(input => service.dispatch(input))
  const context = { threadId: 'execution', turnId: 'turn', workspace: '/workspace', executionGrant: grant, validateExecutionGrant: vi.fn() } as unknown as ToolHostContext
  return { service, flows, flowRepository, repository, task, context, coordinator, identities, workspace }
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
})
