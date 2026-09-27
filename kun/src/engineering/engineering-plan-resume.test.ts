import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TaskController } from '../services/task-controller.js'
import { TaskRunRepository } from '../services/task-run-repository.js'
import { TurnService, type TurnServiceDeps } from '../services/turn-service.js'
import { EngineeringAiOrchestrator } from './engineering-ai-orchestrator.js'
import { EngineeringAiRepository } from './engineering-ai-repository.js'
import { EngineeringContextService } from './engineering-context-service.js'
import { EngineeringService } from './engineering-service.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function fixture(status: 'stalled' | 'waiting_user' | 'waiting_approval' = 'stalled') {
  const root = await mkdtemp(join(tmpdir(), 'engineering-resume-failure-'))
  const engineering = new EngineeringService({ rootDir: root })
  const repository = new EngineeringAiRepository({ rootDir: root })
  const taskRepository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  cleanup.push(async () => { taskRepository.close(); repository.close(); engineering.close(); await rm(root, { recursive: true, force: true }) })
  const project = engineering.createProject({ name: 'Resume recovery fixture', workspace: root, expectedRevision: 0, idempotencyKey: 'resume-project' })
  await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'resume-dataset', name: 'data.csv', dataBase64: Buffer.from('point,time,value\nA,2026-01-01,1').toString('base64') })
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const eventBus = new InMemoryEventBus()
  const nowIso = () => new Date().toISOString()
  const events = new RuntimeEventRecorder({ eventBus, sessionStore, allocateSeq: id => eventBus.allocateSeq(id), nowIso })
  const tasks = new TaskController({ repository: taskRepository, threadStore, sessionStore, nowIso })
  const resolveModelSelection = vi.fn<NonNullable<TurnServiceDeps['resolveModelSelection']>>(request => ({ model: request.model, providerId: request.providerId }))
  const turns = new TurnService({ threadStore, sessionStore, events, tasks, resolveModelSelection,
    inflight: new InflightTracker(), steering: new SteeringQueue(), compactor: new ContextCompactor(), ids: new SequentialIdGenerator(), nowIso })
  await threadStore.upsert({ ...createThreadRecord({ id: 'thread', title: 'Resume', workspace: root, model: 'original-model' }), domain: 'engineering', projectId: project.id })
  const runTurn = vi.fn()
  const orchestrator = new EngineeringAiOrchestrator({ context: new EngineeringContextService(engineering), repository, threadStore, turns, tasks, runTurn })
  const draft = await orchestrator.createPlan({ threadId: 'thread', projectId: project.id, goal: '检查本期数据并生成报告', idempotencyKey: 'resume-plan' })
  const approved = orchestrator.approvePlan(draft.plan.id, { expectedRevision: draft.plan.revision, contextHash: draft.plan.contextHash, stepIds: draft.approval.stepIds, token: draft.approval.token, idempotencyKey: 'resume-approve' })
  const started = await orchestrator.startPlan(approved.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, model: 'original-model', providerId: 'original-provider', reasoningEffort: 'off', idempotencyKey: 'resume-start' })
  const thread = (await threadStore.get('thread'))!
  await threadStore.upsert({ ...thread, status: 'idle', turns: thread.turns.map(turn => ({ ...turn, status: 'completed' })) })
  const active = tasks.activeTask('thread')!
  const previous = taskRepository.update(active.id, active.revision, task => ({ ...task, status, noProgressCount: 3,
    waitingReason: 'Original waiting reason', stalledReason: 'Original stalled reason',
    nodes: task.nodes.map(node => ({ ...node, status: 'failed', errorCode: 'original_error', errorMessage: 'Original node failure' })) }))
  runTurn.mockClear()
  const request = { expectedRevision: started.plan.revision, contextHash: started.plan.contextHash, model: 'replacement-model', providerId: 'replacement-provider', reasoningEffort: 'high' as const, idempotencyKey: 'resume-attempt' }
  return { orchestrator, repository, taskRepository, tasks, turns, threadStore, sessionStore, resolveModelSelection, runTurn, previous, plan: started.plan, request }
}

describe('Engineering plan resume start recovery', () => {
  it.each(['stalled', 'waiting_user', 'waiting_approval'] as const)('restores a %s Task after the actual TurnService model resolver rejects before creating a turn', async status => {
    const f = await fixture(status)
    const before = (await f.threadStore.get('thread'))!
    const failure = new Error('selected provider is unavailable')
    f.resolveModelSelection.mockImplementationOnce(() => { throw failure })
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    const restored = f.tasks.getTask(f.previous.id)!
    expect(restored).toMatchObject({ ...f.previous, revision: f.previous.revision + 2, updatedAt: expect.any(String),
      nodes: f.previous.nodes.map(node => ({ ...node, revision: node.revision + 2 })) })
    expect((await f.threadStore.get('thread'))!.turns).toEqual(before.turns)
    expect(f.repository.getPlan(f.plan.id)).toEqual(f.plan)
    expect(f.taskRepository.events(restored.id).at(-1)).toMatchObject({ kind: 'task_resume_start_failed', payload: { restoredStatus: status } })
    expect(f.runTurn).not.toHaveBeenCalled()
    const resumed = await f.orchestrator.resumePlan(f.plan.id, f.request)
    expect(resumed.plan).toMatchObject({ taskId: f.previous.id, revision: f.plan.revision + 1 })
    expect(f.tasks.getTask(f.previous.id)).toMatchObject({ status: 'retrying', activeTurnId: resumed.turn.turnId, model: f.request.model, providerId: f.request.providerId, reasoningEffort: f.request.reasoningEffort })
    expect(f.runTurn).toHaveBeenCalledExactlyOnceWith('thread', resumed.turn.turnId)
  })

  it('restores the prepared Task when the initial thread write fails before persisting a turn', async () => {
    const f = await fixture()
    const failure = new Error('thread store write failed')
    vi.spyOn(f.threadStore, 'upsert').mockRejectedValueOnce(failure)
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    expect(f.tasks.getTask(f.previous.id)).toMatchObject({ status: 'stalled', activeTurnId: f.previous.activeTurnId, model: f.previous.model })
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('does not overwrite a concurrent cancellation after resume preparation', async () => {
    const f = await fixture()
    const failure = new Error('model selection failed after cancellation')
    f.resolveModelSelection.mockImplementationOnce(() => {
      const current = f.tasks.getTask(f.previous.id)!
      f.tasks.cancelTask(current.id, current.revision, 'Concurrent cancellation')
      throw failure
    })
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    expect(f.tasks.getTask(f.previous.id)).toMatchObject({ status: 'cancelled' })
    expect(f.taskRepository.events(f.previous.id).some(event => event.kind === 'task_resume_start_failed')).toBe(false)
  })

  it('preserves a compensated failed Turn while restoring the still-unattached Task after session fan-out fails', async () => {
    const f = await fixture()
    const failure = new Error('session write failed')
    const restore = vi.spyOn(f.tasks, 'restorePreparedResume')
    vi.spyOn(f.sessionStore, 'appendItem').mockRejectedValueOnce(failure)
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    const failedTurn = (await f.threadStore.get('thread'))!.turns.at(-1)!
    expect(failedTurn).toMatchObject({ status: 'failed', error: failure.message })
    expect(restore).toHaveBeenCalledOnce()
    expect(f.tasks.getTask(f.previous.id)).toMatchObject({ status: 'stalled', activeTurnId: f.previous.activeTurnId, model: f.previous.model })
    expect(f.runTurn).not.toHaveBeenCalled()
    const resumed = await f.orchestrator.resumePlan(f.plan.id, f.request)
    expect(resumed.plan.taskId).toBe(f.previous.id)
    expect(resumed.turn.turnId).not.toBe(failedTurn.id)
    expect((await f.threadStore.get('thread'))!.turns.find(turn => turn.id === failedTurn.id)).toEqual(failedTurn)
    expect(f.runTurn).toHaveBeenCalledExactlyOnceWith('thread', resumed.turn.turnId)
  })

  it('does not restore the old Task when failed fan-out compensation leaves the new Turn running', async () => {
    const f = await fixture()
    const failure = new Error('session fan-out failed')
    const restore = vi.spyOn(f.tasks, 'restorePreparedResume')
    const upsert = f.threadStore.upsert.bind(f.threadStore)
    vi.spyOn(f.threadStore, 'upsert').mockImplementationOnce(upsert).mockRejectedValueOnce(new Error('compensation persistence failed'))
    vi.spyOn(f.sessionStore, 'appendItem').mockRejectedValueOnce(failure)
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    expect((await f.threadStore.get('thread'))!.turns.at(-1)?.status).toBe('running')
    expect(restore).not.toHaveBeenCalled()
    expect(f.tasks.getTask(f.previous.id)?.status).toBe('retrying')
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('does not restore over a newer revision even when the Task is still retrying on the same turn', async () => {
    const f = await fixture()
    const failure = new Error('resolver failed after a concurrent task update')
    f.resolveModelSelection.mockImplementationOnce(() => {
      const current = f.tasks.getTask(f.previous.id)!
      f.taskRepository.update(current.id, current.revision, task => ({ ...task, waitingReason: 'Concurrent progress' }))
      throw failure
    })
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    expect(f.tasks.getTask(f.previous.id)).toMatchObject({ status: 'retrying', waitingReason: 'Concurrent progress', activeTurnId: f.previous.activeTurnId, revision: f.previous.revision + 2 })
    expect(f.taskRepository.events(f.previous.id).some(event => event.kind === 'task_resume_start_failed')).toBe(false)
  })

  it('terminates the unlaunched resumed Turn and Task after plan persistence fails, preserving history for replanning', async () => {
    const f = await fixture()
    const failure = new Error('plan write failed')
    const restore = vi.spyOn(f.tasks, 'restorePreparedResume')
    vi.spyOn(f.repository, 'saveTransition').mockImplementationOnce(() => { throw failure })
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    const turn = (await f.threadStore.get('thread'))!.turns.at(-1)!
    expect(turn).toMatchObject({ status: 'failed', error: failure.message })
    expect((await f.threadStore.get('thread'))!.status).toBe('idle')
    expect(f.turns.getAbortController(turn.id)).toBeUndefined()
    expect(f.tasks.getTask(f.previous.id)).toMatchObject({ status: 'cancelled', activeTurnId: turn.id, model: f.request.model })
    expect(f.repository.getPlan(f.plan.id)).toEqual(f.plan)
    expect(f.runTurn).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    const replanned = await f.orchestrator.createPlan({ threadId: 'thread', projectId: f.plan.projectId, goal: f.plan.goal, replanOf: f.plan.id, idempotencyKey: 'replan-after-save-failure' })
    expect(replanned.plan.status).toBe('awaiting_approval')
    expect(replanned.plan.steps.every(step => step.approval === 'pending')).toBe(true)
    expect(f.tasks.getTask(f.previous.id)?.status).toBe('cancelled')
  })

  it('terminates an unlaunched initial Turn after plan persistence fails and allows the approved plan to start again', async () => {
    const f = await fixture()
    const draft = await f.orchestrator.createPlan({ threadId: 'thread', projectId: f.plan.projectId, goal: f.plan.goal, replanOf: f.plan.id, idempotencyKey: 'fresh-plan' })
    const approved = f.orchestrator.approvePlan(draft.plan.id, { expectedRevision: draft.plan.revision, contextHash: draft.plan.contextHash, stepIds: draft.approval.stepIds, token: draft.approval.token, idempotencyKey: 'fresh-approval' })
    const request = { expectedRevision: approved.revision, contextHash: approved.contextHash, model: 'fresh-model', idempotencyKey: 'fresh-start' }
    const failure = new Error('initial plan write failed')
    vi.spyOn(f.repository, 'saveTransition').mockImplementationOnce(() => { throw failure })
    await expect(f.orchestrator.startPlan(approved.id, request)).rejects.toBe(failure)
    const failedTurn = (await f.threadStore.get('thread'))!.turns.at(-1)!
    expect(failedTurn).toMatchObject({ status: 'failed', error: failure.message })
    expect((await f.threadStore.get('thread'))!.status).toBe('idle')
    const failedTask = f.taskRepository.list({ threadId: 'thread' }).find(task => task.activeTurnId === failedTurn.id)!
    expect(failedTask.status).toBe('cancelled')
    expect(f.turns.getAbortController(failedTurn.id)).toBeUndefined()
    expect(f.repository.getPlan(approved.id)).toEqual(approved)
    expect(f.runTurn).not.toHaveBeenCalled()
    const started = await f.orchestrator.startPlan(approved.id, request)
    expect(started.turn.turnId).not.toBe(failedTurn.id)
    expect(started.plan.taskId).not.toBe(failedTask.id)
    expect(f.runTurn).toHaveBeenCalledExactlyOnceWith('thread', started.turn.turnId)
    expect(f.tasks.getTask(failedTask.id)?.status).toBe('cancelled')
  })

  it('retains the original plan write error if finishing the failed Turn also rejects', async () => {
    const f = await fixture()
    const failure = new Error('original plan persistence failure')
    vi.spyOn(f.repository, 'saveTransition').mockImplementationOnce(() => { throw failure })
    vi.spyOn(f.turns, 'finishTurn').mockRejectedValueOnce(new Error('turn cleanup failure'))
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
    expect(f.tasks.getTask(f.previous.id)?.status).toBe('cancelled')
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('preserves the original failure when restoring the prepared Task also fails', async () => {
    const f = await fixture()
    const failure = new Error('original model failure')
    f.resolveModelSelection.mockImplementationOnce(() => { throw failure })
    vi.spyOn(f.tasks, 'restorePreparedResume').mockImplementationOnce(() => { throw new Error('recovery write failed') })
    await expect(f.orchestrator.resumePlan(f.plan.id, f.request)).rejects.toBe(failure)
  })
})
