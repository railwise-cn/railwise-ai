import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemorySessionStore } from '../in-memory-session-store.js'
import { InMemoryThreadStore } from '../in-memory-thread-store.js'
import { PersistentApprovalGate } from '../persistent-human-gates.js'
import { createApprovalRequest } from '../../domain/approval.js'
import { createThreadRecord } from '../../domain/thread.js'
import { waitForApprovalDecision } from '../../ports/approval-gate.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { TaskController } from '../../services/task-controller.js'
import { TaskRunRepository } from '../../services/task-run-repository.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.useRealTimers()
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

async function fixture(maxExecutionMs = 100) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime('2026-11-14T04:00:00.000Z')
  const root = await mkdtemp(join(tmpdir(), 'tool-human-budget-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'budget-thread', title: 'budget', workspace: root, model: 'fixture' })
  await threadStore.upsert(thread)
  const nowIso = () => new Date().toISOString()
  const controller = new TaskController({ repository, threadStore, sessionStore, nowIso })
  const task = controller.ensureTask({ thread, turnId: 'budget-turn', request: { prompt: '合成执行计时回归。' } })
  repository.update(task.id, task.revision, current => ({ ...current, budget: { ...current.budget, version: 2, maxExecutionMs } }))
  controller.beginAttempt(thread.id, 'budget-turn')
  const abort = new AbortController()
  const onBudgetExhausted = vi.fn((reason: string) => abort.abort(reason))
  controller.registerExecutionAbort('budget-turn', onBudgetExhausted)
  const gate = new PersistentApprovalGate(repository, nowIso)
  const requested = deferred<string>()
  let segments = 0
  const context: ToolHostContext = {
    threadId: thread.id, turnId: 'budget-turn', workspace: root, sandboxMode: 'workspace-write', approvalPolicy: 'auto',
    abortSignal: abort.signal,
    beginExecutionWork: () => controller.beginWork('budget-turn', `work:${segments++}`, 'tool'),
    assertExecution: () => controller.assertToken(controller.tokenForTurn('budget-turn')!),
    awaitApproval: request => waitForApprovalDecision(() => {
      const decision = gate.request(request)
      requested.resolve(request.id)
      return decision
    }, abort.signal)
  }
  cleanup.push(async () => {
    controller.endRun('budget-turn')
    repository.close()
    await rm(root, { recursive: true, force: true })
  })
  const request = (id = 'internal-approval') => createApprovalRequest({ id, threadId: thread.id, turnId: 'budget-turn',
    toolName: 'test_wait', summary: '合成动作审批', createdAt: nowIso() })
  const execute = (run: LocalTool['execute'], outer = false, override: Partial<ToolHostContext> = {}) => {
    const host = new LocalToolHost({ tools: [LocalToolHost.defineTool({ name: 'test_wait', description: 'Synthetic work',
      inputSchema: {}, policy: 'auto', requireExplicitApproval: outer, execute: run })] })
    return host.execute({ callId: 'call', toolName: 'test_wait', arguments: {} }, { ...context, ...override })
  }
  return { repository, controller, threadStore, sessionStore, thread, task, gate, abort, onBudgetExhausted, requested,
    context, request, execute, segments: () => segments, nowIso,
    used: () => repository.execution.usedExecutionMs(task.id, Date.now()),
    tick: (ms: number) => vi.advanceTimersByTimeAsync(ms) }
}

describe('tool human waits and the shared SQLite execution budget', () => {
  it('suspends the actual budget timer beyond its remaining time and resumes at the active-time limit', async () => {
    const f = await fixture()
    const resumed = deferred(), release = deferred()
    const outcome = f.execute(async (_args, context) => {
      await f.tick(20)
      await context.awaitApproval(f.request())
      resumed.resolve()
      await release.promise
      return { output: {} }
    }).catch(error => error)
    const approvalId = await f.requested.promise
    expect(f.used()).toBe(20)
    await f.tick(1_000)
    expect(f.onBudgetExhausted).not.toHaveBeenCalled()
    expect(f.used()).toBe(20)
    expect(f.controller.workBudget('budget-turn')?.remainingMs).toBe(80)
    f.gate.decide(approvalId, 'allow')
    await resumed.promise
    expect(f.segments()).toBe(2)
    await f.tick(79)
    expect(f.onBudgetExhausted).not.toHaveBeenCalled()
    await f.tick(1)
    expect(f.onBudgetExhausted).toHaveBeenCalledExactlyOnceWith('execution_budget_exhausted')
    expect(f.used()).toBe(100)
    release.resolve()
    await outcome
  })

  it.each(['allow', 'deny'] as const)('keeps ordinary outer %s approval outside the tool work segment', async decision => {
    const f = await fixture()
    const executed = vi.fn(async () => { await f.tick(10); return { output: {} } })
    const result = f.execute(executed, true)
    const approvalId = await f.requested.promise
    await f.tick(1_000)
    expect(f.segments()).toBe(0)
    expect(f.used()).toBe(0)
    expect(f.onBudgetExhausted).not.toHaveBeenCalled()
    f.gate.decide(approvalId, decision)
    await result
    expect(executed).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0)
    expect(f.used()).toBe(decision === 'allow' ? 10 : 0)
  })

  it('charges only post-denial cleanup when an internal approval is denied', async () => {
    const f = await fixture()
    const result = f.execute(async (_args, context) => {
      await f.tick(10)
      expect(await context.awaitApproval(f.request())).toBe('deny')
      await f.tick(5)
      return { output: { denied: true } }
    })
    const approvalId = await f.requested.promise
    await f.tick(1_000)
    f.gate.decide(approvalId, 'deny')
    await result
    expect(f.used()).toBe(15)
    expect(f.segments()).toBe(2)
    expect(f.onBudgetExhausted).not.toHaveBeenCalled()
  })

  it('does not reopen a work segment after cancellation or a late approval answer', async () => {
    const f = await fixture()
    const result = f.execute(async (_args, context) => {
      await f.tick(10)
      await context.awaitApproval(f.request())
      throw new Error('must not dispatch after cancellation')
    }).catch(error => error)
    const approvalId = await f.requested.promise
    f.abort.abort('user_cancelled')
    expect(await result).toBeInstanceOf(Error)
    f.gate.decide(approvalId, 'allow')
    await f.tick(1_000)
    expect(f.segments()).toBe(1)
    expect(f.used()).toBe(10)
    expect(f.onBudgetExhausted).not.toHaveBeenCalled()
  })

  it('keeps overlapping approval and user-input waits paused until the last one settles', async () => {
    const f = await fixture()
    const first = deferred<'allow' | 'deny'>(), second = deferred<{ status: 'submitted'; answers: [] }>()
    const waiting = deferred(), resumed = deferred(), release = deferred()
    const result = f.execute(async (_args, context) => {
      await f.tick(10)
      const approval = context.awaitApproval(f.request())
      const input = context.awaitUserInput!({ id: 'question', itemId: 'question-item', prompt: '合成问题', questions: [] })
      waiting.resolve()
      await Promise.all([approval, input])
      resumed.resolve()
      await release.promise
      return { output: {} }
    }, false, { awaitApproval: () => first.promise, awaitUserInput: () => second.promise })
    await waiting.promise
    await f.tick(1_000)
    first.resolve('allow')
    await f.tick(1_000)
    expect(f.used()).toBe(10)
    expect(f.segments()).toBe(1)
    expect(f.onBudgetExhausted).not.toHaveBeenCalled()
    second.resolve({ status: 'submitted', answers: [] })
    await resumed.promise
    await f.tick(15)
    release.resolve()
    await result
    expect(f.segments()).toBe(2)
    expect(f.used()).toBe(25)
  })

  it('does not resume abandoned waits after the tool has already failed', async () => {
    const f = await fixture()
    const decision = deferred<'allow' | 'deny'>(), waiting = deferred()
    let abandoned!: Promise<'allow' | 'deny'>
    const result = f.execute(async (_args, context) => {
      await f.tick(10)
      abandoned = context.awaitApproval(f.request())
      waiting.resolve()
      throw new Error('synthetic provider failure')
    }, false, { awaitApproval: () => decision.promise })
    await waiting.promise
    expect((await result).item).toMatchObject({ isError: true })
    decision.resolve('allow')
    await abandoned
    await f.tick(1_000)
    expect(f.segments()).toBe(1)
    expect(f.used()).toBe(10)
  })

  it('continues charging a sibling task and refuses to resume after the shared root budget is consumed', async () => {
    const f = await fixture()
    const result = f.execute(async (_args, context) => {
      await f.tick(10)
      await context.awaitApproval(f.request())
      throw new Error('must not resume an exhausted root')
    })
    const approvalId = await f.requested.promise
    f.repository.create({ ...f.task, id: 'child', threadId: 'child-thread', parentTaskId: f.task.id, rootTaskId: f.task.id,
      activeTurnId: 'child-turn', nodes: f.task.nodes.map(node => ({ ...node, id: `child-${node.id}`, taskId: 'child' })) })
    const child = new TaskController({ repository: f.repository, threadStore: f.threadStore, sessionStore: f.sessionStore, nowIso: f.nowIso })
    child.beginAttempt('child-thread', 'child-turn')
    const childAbort = vi.fn()
    child.registerExecutionAbort('child-turn', childAbort)
    const finish = child.beginWork('child-turn', 'child-model', 'model')
    try {
      await f.tick(90)
      expect(f.used()).toBe(100)
      expect(childAbort).toHaveBeenCalledExactlyOnceWith('execution_budget_exhausted')
      finish()
      f.gate.decide(approvalId, 'allow')
      expect((await result).item).toMatchObject({ isError: true, output: { code: 'execution_budget_exhausted' } })
      expect(f.segments()).toBe(2)
      expect(f.used()).toBe(100)
    } finally {
      finish()
      child.endRun('child-turn')
    }
  })
})
