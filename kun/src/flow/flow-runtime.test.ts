import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { FlowDefinitionV1 } from '../contracts/flow.js'
import { buildCoreFlowAdapters } from './core-adapters.js'
import { FlowExecutor } from './executor.js'
import { buildFlowNodeRegistry, portsCompatible } from './node-registry.js'
import { FlowRepository, FlowRevisionConflictError } from './repository.js'
import { validateFlowDefinition } from './validator.js'
import { FlowRuntimeService } from './service.js'

function definition(nodes: FlowDefinitionV1['nodes'], edges: FlowDefinitionV1['edges'] = []): FlowDefinitionV1 {
  return { schemaVersion: 1, id: 'flow_1', name: 'Tender flow', description: '', revision: 1, nodes, edges, variables: {}, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }
}
function node(id: string, type: string): FlowDefinitionV1['nodes'][number] {
  return { id, type, label: id, position: { x: 0, y: 0 }, bindings: {}, config: type === 'loop' ? { maxIterations: 3 } : {}, policy: { timeoutMs: 1000, retryAttempts: 0, retryBackoffMs: 0, errorBehavior: 'fail', concurrencyLimit: 2, resumable: false, breakpoint: false }, disabled: false }
}
function draftInput(graph: FlowDefinitionV1): Omit<FlowDefinitionV1, 'revision' | 'createdAt' | 'updatedAt'> {
  const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = graph
  return input
}

describe('Flow registry and validation', () => {
  it('keeps unavailable catalogue nodes visible with a precise configuration route', () => {
    const registry = buildFlowNodeRegistry({ feishu: { available: false, reason: 'Connect Feishu', configurationRoute: 'settings/integrations/feishu' } })
    expect(registry.find((entry) => entry.type === 'feishu_trigger')).toMatchObject({ available: false, disabledReason: 'Connect Feishu', configurationRoute: 'settings/integrations/feishu' })
    expect(registry.length).toBeGreaterThanOrEqual(32)
  })
  it('accepts only identical or explicit typed conversions', () => {
    expect(portsCompatible('string', 'string')).toBe(true)
    expect(portsCompatible('file', 'document', 'file-to-document')).toBe(true)
    expect(portsCompatible('file', 'document')).toBe(false)
    expect(portsCompatible('image', 'table', 'image-to-file')).toBe(false)
  })
  it('rejects incompatible edges and illegal cycles', () => {
    const graph = definition([node('trigger', 'manual_trigger'), node('agent', 'agent')], [
      { id: 'edge_1', sourceNodeId: 'trigger', sourcePortId: 'output', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' },
      { id: 'edge_2', sourceNodeId: 'agent', sourcePortId: 'message', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' }
    ])
    const result = validateFlowDefinition(graph, buildFlowNodeRegistry())
    expect(result.valid).toBe(false)
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['incompatible_ports', 'illegal_cycle']))
  })
  it('executes condition, parallel, merge, switch, and bounded loop core adapters', async () => {
    const adapters = buildCoreFlowAdapters(); const base = { run: {} as never, definition: {} as never, signal: new AbortController().signal }
    await expect(adapters.get('condition')!({ ...base, node: { ...node('condition', 'condition'), config: { path: 'ok', operator: 'truthy' } }, input: { ok: true } })).resolves.toMatchObject({ output: { branch: true } })
    await expect(adapters.get('switch')!({ ...base, node: { ...node('switch', 'switch'), config: { path: 'kind', cases: [{ value: 'a', branch: 'alpha' }] } }, input: { kind: 'a' } })).resolves.toMatchObject({ output: { branch: 'alpha' } })
    await expect(adapters.get('parallel')!({ ...base, node: node('parallel', 'parallel'), input: { value: 1 } })).resolves.toEqual({ kind: 'output', output: { value: 1 } })
    await expect(adapters.get('merge')!({ ...base, node: node('merge', 'merge'), input: { a: 1, b: 2 } })).resolves.toEqual({ kind: 'output', output: { a: 1, b: 2 } })
    await expect(adapters.get('loop')!({ ...base, node: { ...node('loop', 'loop'), config: { maxIterations: 4 } }, input: 'x' })).resolves.toMatchObject({ output: { maxIterations: 4 } })
  })
})

describe('Flow repository and executor', () => {
  it('waits for the actual adapter after checkpointing an interrupted Flow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-update-'))
    const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const graph = definition([node('agent', 'agent')])
    repository.create(draftInput(graph)); repository.publish(graph.id)
    let finish!: () => void
    const executor = new FlowExecutor(repository, new Map([['agent', async () => {
      await new Promise<void>(resolve => { finish = resolve })
      return { kind: 'output' as const, output: 'settled' }
    }]]))
    try {
      const run = await executor.start(graph.id, {})
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      executor.setAdmissionSuspended(true)
      executor.checkpointActiveRuns()
      let idle = false
      const waiting = executor.awaitIdle().then(() => { idle = true })
      await vi.waitFor(() => expect(repository.getRun(run.id)?.status).toBe('interrupted'))
      expect(idle).toBe(false)
      await expect(executor.start(graph.id, {})).rejects.toThrow('preparing an update')
      finish()
      await waiting
      expect(idle).toBe(true)
    } finally { repository.close() }
  })

  it('enforces optimistic revisions and immutable content-hashed versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-repo-')); const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const created = repository.create(draftInput(definition([node('trigger', 'manual_trigger')])))
    const updated = repository.update({ ...created, name: 'Updated' }, 1)
    expect(updated.revision).toBe(2)
    expect(() => repository.update(updated, 1)).toThrow(FlowRevisionConflictError)
    const first = repository.publish(created.id); const second = repository.publish(created.id)
    expect(second.id).toBe(first.id); repository.close()
  })
  it('retries a transient node and persists a successful run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-executor-')); const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const trigger = node('trigger', 'manual_trigger'); const agent = { ...node('agent', 'agent'), policy: { ...node('agent', 'agent').policy, retryAttempts: 1 } }
    const graph = definition([trigger, agent], [{ id: 'edge', sourceNodeId: 'trigger', sourcePortId: 'output', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' }])
    repository.create(draftInput(graph)); repository.publish(graph.id)
    let attempts = 0; const adapter = vi.fn(async () => { attempts += 1; if (attempts === 1) throw new Error('transient'); return { kind: 'output' as const, output: 'done' } })
    const executor = new FlowExecutor(repository, buildCoreFlowAdapters(new Map([['agent', adapter]])))
    const started = await executor.start(graph.id, { tender: true })
    await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('succeeded'))
    expect(adapter).toHaveBeenCalledTimes(2)
    expect(repository.listNodeRuns(started.id).map((run) => run.status)).toEqual(expect.arrayContaining(['failed', 'succeeded']))
    repository.close()
  })
  it('resolves literal, Flow variable, and upstream port bindings into node input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-bindings-')); const repository = new FlowRepository(join(root, 'flow.sqlite')); const agent = { ...node('agent', 'agent'), bindings: { fixed: { kind: 'literal' as const, value: 7 }, region: { kind: 'variable' as const, variable: 'region' }, previous: { kind: 'port' as const, nodeId: 'trigger', portId: 'output' } } }; const graph = { ...definition([node('trigger', 'manual_trigger'), agent], [{ id: 'edge', sourceNodeId: 'trigger', sourcePortId: 'output', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' }]), variables: { region: 'east' } }; repository.create(draftInput(graph)); repository.publish(graph.id)
    const adapter = vi.fn(async ({ input }) => ({ kind: 'output' as const, output: input })); const executor = new FlowExecutor(repository, buildCoreFlowAdapters(new Map([['agent', adapter]]))); const started = await executor.start(graph.id, { tender: true }); await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('succeeded')); expect(adapter).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ input: { tender: true }, fixed: 7, region: 'east', previous: { tender: true } }) })); repository.close()
  })
  it('records node timeout failures without hanging the Flow run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-timeout-')); const repository = new FlowRepository(join(root, 'flow.sqlite')); const agent = { ...node('agent', 'agent'), policy: { ...node('agent', 'agent').policy, timeoutMs: 100 } }; const graph = definition([agent]); repository.create(draftInput(graph)); repository.publish(graph.id)
    const executor = new FlowExecutor(repository, buildCoreFlowAdapters(new Map([['agent', async () => await new Promise<never>(() => undefined)]]))); const started = await executor.start(graph.id, {}); await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('failed')); expect(repository.listNodeRuns(started.id)[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('timed out') }); repository.close()
  })
  it('executes only the selected condition port and records the other branch as skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-condition-')); const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const condition = { ...node('condition', 'condition'), config: { path: 'approved', operator: 'truthy' } }; const yes = node('yes', 'merge'); const no = node('no', 'merge')
    const graph = definition([condition, yes, no], [
      { id: 'yes-edge', sourceNodeId: 'condition', sourcePortId: 'true', targetNodeId: 'yes', targetPortId: 'inputs', branch: 'normal' },
      { id: 'no-edge', sourceNodeId: 'condition', sourcePortId: 'false', targetNodeId: 'no', targetPortId: 'inputs', branch: 'normal' }
    ])
    repository.create(draftInput(graph)); repository.publish(graph.id); const executor = new FlowExecutor(repository, buildCoreFlowAdapters())
    const started = await executor.start(graph.id, { approved: true }); await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('succeeded'))
    expect(repository.listNodeRuns(started.id).find((run) => run.nodeId === 'yes')?.status).toBe('succeeded'); expect(repository.listNodeRuns(started.id).find((run) => run.nodeId === 'no')?.status).toBe('skipped')
    repository.close()
  })
  it('routes exhausted failures to error edges and skips normal successors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-error-')); const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const trigger = node('trigger', 'manual_trigger'); const failing = { ...node('agent', 'agent'), policy: { ...node('agent', 'agent').policy, errorBehavior: 'error_edge' as const } }; const normal = node('normal', 'merge'); const recovery = node('recovery', 'merge')
    const graph = definition([trigger, failing, normal, recovery], [
      { id: 'start', sourceNodeId: 'trigger', sourcePortId: 'output', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' },
      { id: 'normal', sourceNodeId: 'agent', sourcePortId: 'message', targetNodeId: 'normal', targetPortId: 'inputs', branch: 'normal' },
      { id: 'error', sourceNodeId: 'agent', sourcePortId: 'message', targetNodeId: 'recovery', targetPortId: 'inputs', branch: 'error' }
    ])
    repository.create(draftInput(graph)); repository.publish(graph.id); const executor = new FlowExecutor(repository, buildCoreFlowAdapters(new Map([['agent', async () => { throw new Error('boom') }]])))
    const started = await executor.start(graph.id, {}); await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('succeeded'))
    expect(repository.listNodeRuns(started.id).find((run) => run.nodeId === 'normal')?.status).toBe('skipped'); expect(repository.listNodeRuns(started.id).find((run) => run.nodeId === 'recovery')?.status).toBe('succeeded')
    repository.close()
  })
  it('executes a bounded Loop cycle and exits through the done port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-loop-')); const repository = new FlowRepository(join(root, 'flow.sqlite')); const loop = { ...node('loop', 'loop'), config: { maxIterations: 3 } }
    const graph = definition([node('trigger', 'manual_trigger'), loop, node('worker', 'merge'), node('done', 'merge')], [
      { id: 'start', sourceNodeId: 'trigger', sourcePortId: 'output', targetNodeId: 'loop', targetPortId: 'input', branch: 'normal' },
      { id: 'body', sourceNodeId: 'loop', sourcePortId: 'body', targetNodeId: 'worker', targetPortId: 'inputs', branch: 'normal' },
      { id: 'feedback', sourceNodeId: 'worker', sourcePortId: 'output', targetNodeId: 'loop', targetPortId: 'input', branch: 'normal' },
      { id: 'done', sourceNodeId: 'loop', sourcePortId: 'done', targetNodeId: 'done', targetPortId: 'inputs', branch: 'normal' }
    ])
    expect(validateFlowDefinition(graph, buildFlowNodeRegistry()).valid).toBe(true); repository.create(draftInput(graph)); repository.publish(graph.id); const executor = new FlowExecutor(repository, buildCoreFlowAdapters()); const started = await executor.start(graph.id, {})
    await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('succeeded')); const nodeRuns = repository.listNodeRuns(started.id); expect(nodeRuns.filter((item) => item.nodeId === 'loop')).toHaveLength(3); expect(nodeRuns.filter((item) => item.nodeId === 'worker')).toHaveLength(3); expect(nodeRuns.filter((item) => item.nodeId === 'done')).toHaveLength(1); repository.close()
  })
  it('idempotently migrates legacy schedules and preserves their read-only backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-migration-')); const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    const task = { id: 'task-1', title: 'Daily tender', enabled: true, prompt: 'Prepare tender', workspaceRoot: '/workspace', model: 'model-1', reasoningEffort: 'medium', mode: 'workspace', schedule: { kind: 'daily', everyMinutes: 60, timeOfDay: '09:00', atTime: '' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastRunAt: '2026-01-02T00:00:00.000Z', nextRunAt: '2026-01-03T00:00:00.000Z', lastStatus: 'success', lastMessage: 'done', lastThreadId: 'thread-1' }
    expect(service.migrateLegacySchedules([task])).toMatchObject({ migrated: true, result: { mappings: [{ taskId: 'task-1', flowId: 'flow_schedule_task-1' }] } })
    expect(service.migrateLegacySchedules([task])).toMatchObject({ migrated: false, idempotent: true })
    expect(service.get('flow_schedule_task-1')).toMatchObject({ publishedVersionId: expect.any(String), variables: { legacyScheduleTaskId: 'task-1', legacyLastThreadId: 'thread-1' } })
    expect(repository.getTriggerState('flow_schedule_task-1', 'schedule')).toMatchObject({ enabled: true, nextRunAt: task.nextRunAt, state: { lastThreadId: 'thread-1' } })
    const createdTask = { ...task, id: 'task-2', title: 'Second task', lastThreadId: '' }; service.createLegacySchedule(createdTask)
    expect(service.listLegacySchedules().map((item) => item.id)).toEqual(['task-1', 'task-2'])
    expect(service.updateLegacySchedule('task-2', { ...createdTask, title: 'Updated task', enabled: false }).title).toBe('Updated task')
    const started = await service.runLegacySchedule('task-2'); expect(started.flowId).toBe('flow_schedule_task-2')
    expect(service.archiveLegacySchedule('task-2')).toBe(true); expect(service.listLegacySchedules().map((item) => item.id)).toEqual(['task-1'])
    await expect(service.run('flow_schedule_task-2', {})).rejects.toThrow('archived')
    expect((repository.getMigration('schedule-to-flow-v1') as { readOnlyBackup: unknown[] }).readOnlyBackup).toEqual([task])
    service.shutdown()
  })
  it('normalizes existing legacy Flow schedule models before schedule timers can start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-schedule-model-migration-'))
    const path = join(root, 'flow.sqlite')
    let repository = new FlowRepository(path)
    const customProviderService = new FlowRuntimeService(
      repository,
      buildFlowNodeRegistry(),
      buildCoreFlowAdapters(),
      undefined,
      undefined,
      'custom-provider'
    )
    const task = (id: string, model: string) => ({
      id, title: 'Legacy model', enabled: true, prompt: 'Run', workspaceRoot: '/workspace',
      model, reasoningEffort: 'medium', mode: 'agent',
      schedule: { kind: 'daily', everyMinutes: 60, timeOfDay: '09:00', atTime: '' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      lastRunAt: '', nextRunAt: '2026-01-01T00:00:00.000Z', lastStatus: 'idle', lastMessage: '', lastThreadId: ''
    })
    const tasks = [
      task('scheduled-model', 'deepseek-v4-pro'),
      task('scheduled-chat-alias', 'deepseek-chat'),
      task('scheduled-reasoner-alias', 'deepseek-reasoner')
    ]
    customProviderService.migrateLegacySchedules(tasks)
    expect(customProviderService.listLegacySchedules().map((item) => item.model))
      .toEqual(['deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'])
    customProviderService.shutdown()

    repository = new FlowRepository(path)
    const builtInProviderService = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    expect(builtInProviderService.listLegacySchedules().map((item) => item.model))
      .toEqual(['deepseek-flash', 'deepseek-flash', 'deepseek-flash'])
    for (const item of tasks) {
      expect(builtInProviderService.get(`flow_schedule_${item.id}`)?.nodes.find((node) => node.id === 'agent')?.config.model)
        .toBe('deepseek-flash')
    }
    expect((repository.getMigration('schedule-to-flow-v1') as { readOnlyBackup: Array<{ model: string }> }).readOnlyBackup)
      .toMatchObject([{ model: 'deepseek-v4-pro' }, { model: 'deepseek-chat' }, { model: 'deepseek-reasoner' }])
    builtInProviderService.shutdown()
  })
  it('reconciles crashed runs and blocks restart recovery for non-resumable nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-recovery-')); const path = join(root, 'flow.sqlite'); let repository = new FlowRepository(path)
    const graph = definition([{ ...node('agent', 'agent'), policy: { ...node('agent', 'agent').policy, resumable: false } }]); repository.create(draftInput(graph)); const version = repository.publish(graph.id)
    const queued = repository.createRun({ flowId: graph.id, versionId: version.id, input: {}, invocationStack: [graph.id] }); repository.saveRun({ ...queued, status: 'running', updatedAt: new Date().toISOString() }); repository.saveNodeRun({ id: 'node-run', runId: queued.id, nodeId: 'agent', attempt: 1, status: 'running', startedAt: new Date().toISOString() }); repository.close()
    repository = new FlowRepository(path); const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    expect(repository.getRun(queued.id)).toMatchObject({ status: 'interrupted', checkpoint: { reason: 'runtime_restart', resumable: false } }); expect(repository.listNodeRuns(queued.id)[0]?.status).toBe('interrupted')
    await expect(service.resume(queued.id)).rejects.toThrow('not resumable'); service.shutdown()
  })
  it('dispatches due schedule triggers and disables one-time schedules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-schedule-')); const repository = new FlowRepository(join(root, 'flow.sqlite')); const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    service.migrateLegacySchedules([])
    const base = { id: 'once', title: 'Once', enabled: true, prompt: 'Run once', workspaceRoot: '/workspace', model: 'model', reasoningEffort: 'medium', mode: 'workspace', schedule: { kind: 'at', everyMinutes: 60, timeOfDay: '09:00', atTime: '2026-01-01T00:00:00.000Z' }, createdAt: '', updatedAt: '', lastRunAt: '', nextRunAt: '2026-01-01T00:00:00.000Z', lastStatus: 'idle', lastMessage: '', lastThreadId: '' }
    service.createLegacySchedule(base); expect(await service.tickSchedules(new Date('2026-01-02T00:00:00.000Z'))).toBe(1); expect(repository.getTriggerState('flow_schedule_once', 'schedule')).toMatchObject({ enabled: false, lastRunAt: '2026-01-02T00:00:00.000Z' }); await vi.waitFor(() => expect(service.history('flow_schedule_once')[0]?.status).toBe('failed'))
    const interval = { ...base, id: 'interval', title: 'Interval', schedule: { ...base.schedule, kind: 'interval', everyMinutes: 15 }, nextRunAt: '2026-01-02T00:00:00.000Z' }; service.createLegacySchedule(interval); expect(await service.tickSchedules(new Date('2026-01-02T00:01:00.000Z'))).toBe(1); expect(repository.getTriggerState('flow_schedule_interval', 'schedule')).toMatchObject({ enabled: true, nextRunAt: '2026-01-02T00:16:00.000Z' }); await vi.waitFor(() => expect(service.history('flow_schedule_interval')[0]?.status).toBe('failed'))
    service.shutdown()
  })
  it('persists approval waits and resumes after an approval decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-approval-')); const repository = new FlowRepository(join(root, 'flow.sqlite')); const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    const graph = definition([node('manual', 'manual_trigger'), node('approval', 'human_approval'), node('finish', 'merge')], [{ id: 'a', sourceNodeId: 'manual', sourcePortId: 'output', targetNodeId: 'approval', targetPortId: 'input', branch: 'normal' }, { id: 'b', sourceNodeId: 'approval', sourcePortId: 'approved', targetNodeId: 'finish', targetPortId: 'input', branch: 'normal' }]); repository.create(draftInput(graph)); repository.publish(graph.id)
    const started = await service.run(graph.id, {}); await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('waiting_approval')); await service.decide(started.id, 'approval', 'approve'); await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('succeeded')); service.shutdown()
  })
  it('resumes past a breakpoint and cancels adapters that ignore the abort signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-flow-control-')); const repository = new FlowRepository(join(root, 'flow.sqlite')); const breakpoint = { ...node('manual', 'manual_trigger'), policy: { ...node('manual', 'manual_trigger').policy, breakpoint: true } }; const graph = definition([breakpoint]); repository.create(draftInput(graph)); repository.publish(graph.id); const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    const paused = await service.run(graph.id, {}); await vi.waitFor(() => expect(repository.getRun(paused.id)?.status).toBe('paused')); await service.resume(paused.id); await vi.waitFor(() => expect(repository.getRun(paused.id)?.status).toBe('succeeded'))
    const hangingGraph = { ...definition([{ ...node('agent', 'agent'), policy: { ...node('agent', 'agent').policy, timeoutMs: 10_000 } }]), id: 'hanging' }; repository.create(draftInput(hangingGraph)); repository.publish(hangingGraph.id); const hangingService = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters(new Map([['agent', async () => await new Promise<never>(() => undefined)]])))
    const hanging = await hangingService.run(hangingGraph.id, {}); await vi.waitFor(() => expect(repository.getRun(hanging.id)?.status).toBe('running')); expect(hangingService.cancel(hanging.id)).toBe(true); await vi.waitFor(() => expect(repository.getRun(hanging.id)?.status).toBe('cancelled')); hangingService.shutdown()
  })
})
