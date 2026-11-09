import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryEventBus } from '../src/adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { buildDelegationToolProviders } from '../src/adapters/tool/delegation-tool-provider.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { DelegationRuntime, FileDelegationStore } from '../src/delegation/delegation-runtime.js'
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { TaskRunRepository } from '../src/services/task-run-repository.js'
import type { TaskRun } from '../src/contracts/tasks.js'

describe('DelegationRuntime', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kun-delegation-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates child runs, persists records, and emits child event metadata', async () => {
    const sessionStore = new InMemorySessionStore()
    const externalUsage: unknown[] = []
    const runtime = createRuntime({ sessionStore, recordExternalUsage: (_threadId, usage) => externalUsage.push(usage) })
    const result = await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      label: 'research',
      prompt: 'Research A',
      workspace: '/tmp/ws',
      signal: new AbortController().signal
    })

    expect(result).toMatchObject({ status: 'completed', summary: 'done: Research A' })
    expect((await runtime.diagnostics('thr_1')).childRuns).toHaveLength(1)
    const events = await sessionStore.loadEventsSince('thr_1', 0)
    expect(events.some((event) => event.child?.childId === result.id && event.child.childStatus === 'completed')).toBe(true)
    expect(externalUsage).toHaveLength(1)
    expect(externalUsage[0]).toMatchObject({ totalTokens: 3 })
  })

  it('denies disabled delegation and exhausted child budgets', async () => {
    const disabled = createRuntime({ enabled: false })
    await expect(disabled.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'x',
      signal: new AbortController().signal
    })).rejects.toThrow(/disabled/)

    const budgeted = createRuntime({ maxChildRuns: 1 })
    await budgeted.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'first',
      signal: new AbortController().signal
    })
    await expect(budgeted.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'second',
      signal: new AbortController().signal
    })).rejects.toThrow(/budget/)
  })

  it('executes delegate_task through the normal tool host', async () => {
    const runtime = createRuntime()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const result = await host.execute({
      callId: 'call_1',
      toolName: 'delegate_task',
      arguments: { label: 'A', prompt: 'Investigate A' }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      delegationPolicy: { enabled: true, maxParallel: 1, maxChildRuns: 3 },
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
    if (result.item.kind === 'tool_result') {
      expect(result.item.output).toMatchObject({
        status: 'completed',
        summary: 'done: Investigate A',
        usage: { totalTokens: 3 }
      })
    }
  })

  it('warns when delegate_task is spawned repeatedly in one parent thread', async () => {
    const runtime = createRuntime()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const context = {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      delegationPolicy: { enabled: true, maxParallel: 1, maxChildRuns: 3 },
      approvalPolicy: 'auto' as const,
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const
    }
    await host.execute({
      callId: 'call_1',
      toolName: 'delegate_task',
      arguments: { prompt: 'first' }
    }, context)
    const second = await host.execute({
      callId: 'call_2',
      toolName: 'delegate_task',
      arguments: { prompt: 'second' }
    }, context)

    expect(second.item.kind === 'tool_result' ? second.item.output : {}).toMatchObject({
      warning: expect.stringContaining('spawn #2')
    })
  })

  it('rejects child model overrides outside the effective Agent policy', async () => {
    const runtime = createRuntime()
    const host = new LocalToolHost({
      registry: new CapabilityRegistry(buildDelegationToolProviders(runtime))
    })
    const result = await host.execute({
      callId: 'call_model_policy',
      toolName: 'delegate_task',
      arguments: { prompt: 'research', model: 'unapproved-model' }
    }, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      workspace: '/tmp/ws',
      model: {
        id: 'parent-model',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsToolCalling: true,
        messageParts: ['text']
      },
      delegationPolicy: { enabled: true, allowedModels: [] },
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    })

    expect(result.item.kind === 'tool_result' ? result.item.output : {}).toMatchObject({
      error: expect.stringContaining('outside the effective Agent policy')
    })
  })

  it('aggregates child runs by label and model for dashboards', async () => {
    const runtime = createRuntime()
    await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      label: 'research',
      prompt: 'first',
      model: 'deepseek-v4-flash',
      signal: new AbortController().signal
    })
    await runtime.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      label: 'research',
      prompt: 'second',
      model: 'deepseek-v4-flash',
      signal: new AbortController().signal
    })

    const diagnostics = await runtime.diagnostics('thr_1')
    expect(diagnostics.aggregates[0]).toMatchObject({
      key: 'research:deepseek-v4-flash',
      runs: 2,
      completed: 2,
      totalTokens: 6,
      averageTotalTokens: 3
    })
  })

  it('records child failure and parent interruption states', async () => {
    const failed = createRuntime({
      executor: async () => {
        throw new Error('child failed')
      }
    })
    await expect(failed.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'fail',
      signal: new AbortController().signal
    })).resolves.toMatchObject({ status: 'failed', error: 'child failed' })

    const controller = new AbortController()
    controller.abort()
    const aborted = createRuntime({
      executor: async ({ signal }) => {
        if (signal.aborted) throw new Error('aborted')
        return { summary: 'unreachable' }
      }
    })
    await expect(aborted.runChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'abort',
      signal: controller.signal
    })).resolves.toMatchObject({ status: 'aborted' })
  })

  it('links detached child tasks, enforces budgets, and terminates them durably', async () => {
    const taskRepository = new TaskRunRepository(join(dir, 'tasks.sqlite3'))
    taskRepository.create(parentTask())
    const runtime = createRuntime({
      taskRepository,
      executor: ({ signal }) => new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('terminated'))
          return
        }
        signal.addEventListener('abort', () => reject(new Error('terminated')), { once: true })
      })
    })
    const child = await runtime.startChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'long child task',
      workspace: '/tmp/ws',
      executionMode: 'detached'
    })

    expect(child.executionMode).toBe('detached')
    expect(child.taskId).toBeTruthy()
    expect(taskRepository.get('task_parent')?.childTaskIds).toContain(child.taskId)
    expect(taskRepository.get(child.taskId!)?.parentTaskId).toBe('task_parent')

    const terminated = await runtime.terminateChild(child.id)
    expect(terminated?.status).toBe('aborted')
    expect(taskRepository.get(child.taskId!)?.status).toBe('cancelled')
    taskRepository.close()
  })

  it('rejects child assignments outside the parent workspace authority', async () => {
    const taskRepository = new TaskRunRepository(join(dir, 'tasks-authority.sqlite3'))
    taskRepository.create(parentTask())
    const runtime = createRuntime({ taskRepository })
    await expect(runtime.startChild({
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'escape',
      workspace: join(dir, 'outside'),
      executionMode: 'detached'
    })).rejects.toThrow(/outside parent task authority/)
    taskRepository.close()
  })

  it('recovers an interrupted detached child without losing its durable record', async () => {
    const store = new FileDelegationStore(join(dir, 'children-recovery'))
    await store.upsert({
      id: 'child_recover',
      ownerPid: 2147483646,
      ownerStartedAt: `${process.platform}:verified-exited-process`,
      parentThreadId: 'thr_1',
      parentTurnId: 'turn_1',
      prompt: 'resume research',
      status: 'running',
      executionMode: 'detached',
      attempt: 1,
      maxDurationMs: 60_000,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      revision: 1
    })
    const config = KunCapabilitiesConfig.parse({
      subagents: { enabled: true, maxParallel: 1, maxChildRuns: 3 }
    }).subagents
    const runtime = new DelegationRuntime({
      config,
      store,
      executor: async ({ prompt }) => ({ summary: prompt.includes('Resume this interrupted') ? 'recovered' : 'wrong' })
    })

    const recovered = await runtime.recoverInterrupted()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: 'child_recover', status: 'queued', attempt: 1 })
    await expect(runtime.waitForChild('child_recover')).resolves.toMatchObject({
      status: 'completed',
      summary: 'recovered',
      attempt: 2
    })
    expect(await store.get('child_recover')).toMatchObject({ status: 'completed' })
  })

  it('does not replay a legacy running child whose original process cannot be identified', async () => {
    const store = new FileDelegationStore(join(dir, 'children-unknown'))
    await store.upsert({ id: 'child_unknown', parentThreadId: 'thr_1', parentTurnId: 'turn_1', prompt: 'preserve old operation', status: 'running', executionMode: 'detached', attempt: 1, maxDurationMs: 60_000, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 1 })
    let calls = 0
    const runtime = new DelegationRuntime({ config: KunCapabilitiesConfig.parse({ subagents: { enabled: true, maxParallel: 1, maxChildRuns: 3 } }).subagents, store, executor: async () => { calls += 1; return { summary: 'must not run' } } })
    const recovered = await runtime.recoverInterrupted()
    expect(recovered[0]).toMatchObject({ status: 'interrupted', error: expect.stringContaining('outcome_unknown') })
    expect(calls).toBe(0)
  })

  function createRuntime(options: {
    enabled?: boolean
    maxChildRuns?: number
    sessionStore?: InMemorySessionStore
    executor?: ConstructorParameters<typeof DelegationRuntime>[0]['executor']
    recordExternalUsage?: ConstructorParameters<typeof DelegationRuntime>[0]['recordExternalUsage']
    taskRepository?: TaskRunRepository
  } = {}) {
    const sessionStore = options.sessionStore ?? new InMemorySessionStore()
    const bus = new InMemoryEventBus()
    const recorder = new RuntimeEventRecorder({
      eventBus: bus,
      sessionStore,
      allocateSeq: (threadId) => bus.allocateSeq(threadId),
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })
    const config = KunCapabilitiesConfig.parse({
      subagents: {
        enabled: options.enabled ?? true,
        maxParallel: 1,
        maxChildRuns: options.maxChildRuns ?? 3
      }
    }).subagents
    return new DelegationRuntime({
      config,
      store: new FileDelegationStore(join(dir, 'children')),
      events: recorder,
      nowIso: () => '2026-06-03T00:00:00.000Z',
      idGenerator: () => `child_${Math.random().toString(36).slice(2, 8)}`,
      recordExternalUsage: options.recordExternalUsage,
      taskRepository: options.taskRepository,
      executor: options.executor ?? (async ({ prompt }) => ({
        summary: `done: ${prompt}`,
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }
      }))
    })
  }
})

function parentTask(): TaskRun {
  return {
    id: 'task_parent',
    threadId: 'thr_1',
    activeTurnId: 'turn_1',
    childTaskIds: [],
    workspaceRoot: '/tmp/ws',
    goal: 'parent task',
    status: 'running',
    acceptance: {
      kind: 'answer',
      requiredNodeKinds: ['deliver'],
      requireFinalResponse: true,
      requireActionableArtifactCard: false
    },
    agentId: 'general',
    budget: { maxAttempts: 8, maxDurationMs: 60_000 },
    attempts: 1,
    replans: 0,
    noProgressCount: 0,
    nodes: [{
      id: 'parent_deliver',
      taskId: 'task_parent',
      kind: 'deliver',
      title: 'deliver',
      status: 'running',
      dependsOn: [],
      attempt: 1,
      maxAttempts: 8,
      idempotencyKey: 'task_parent:deliver',
      evidence: [],
      revision: 0
    }],
    artifacts: [],
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:00.000Z',
    revision: 0
  }
}
