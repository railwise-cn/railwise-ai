import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { AgentLoop } from '../src/loop/agent-loop.js'
import { FileThreadStore } from '../src/adapters/file/file-thread-store.js'
import { buildRouter } from '../src/server/routes/index.js'
import { startNodeHttpServer } from '../src/server/node-http-server.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { EngineeringAiRepository } from '../src/engineering/engineering-ai-repository.js'
import { importWorkwiseSurveyNetwork } from '../src/engineering/survey-test-helpers.js'
import { resolvedStepParameters } from '../src/engineering/engineering-plan-execution.js'
import type { EngineeringRunPlanV1 } from '../src/contracts/engineering-ai.js'

const cleanup: Array<() => Promise<unknown> | void> = []
// Resume includes real HTTP, durable writes, a stalled attempt and four tool executions.
const PERSISTENCE_TEST_TIMEOUT_MS = 15_000
// Restart adds two bounded 10-second recovery polls plus initialization and tool I/O.
const RESTART_TEST_TIMEOUT_MS = 30_000
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })

async function fixture(initialMode: 'text' | 'partial' | 'all') {
  const root = await mkdtemp(join(tmpdir(), 'engineering-completion-gate-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const runs = new Map<string, ReturnType<AgentLoop['runTurn']>>()
  const runTurn = AgentLoop.prototype.runTurn
  vi.spyOn(AgentLoop.prototype, 'runTurn').mockImplementation(function (this: AgentLoop, threadId, turnId) {
    const pending = runTurn.call(this, threadId, turnId)
    runs.set(turnId, pending)
    return pending
  })
  let mode = initialMode
  let plan: EngineeringRunPlanV1 | undefined
  let repository: EngineeringAiRepository
  let modelCalls = 0
  let repeatCompleted = false
  const calledSteps: string[] = []
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the actual local HTTP request. */ }
    modelCalls += 1
    let step = mode === 'all' && plan ? plan.steps.find(item => !repository.stepEvidence(plan!.id, item.id))
      : mode === 'partial' && !calledSteps.length ? plan?.steps[0] : undefined
    if (repeatCompleted && plan) { step = plan.steps[0]; repeatCompleted = false }
    const delta = step && plan ? { tool_calls: [{ index: 0, id: `call-${modelCalls}`, type: 'function', function: { name: step.tool,
      arguments: JSON.stringify(resolvedStepParameters(step, id => repository.stepEvidence(plan!.id, id)?.handles ?? null)) } }] }
      : { content: 'The approved survey work is complete. All observations have been processed and the results are ready.' }
    if (step) calledSteps.push(step.id)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: `fixture-${modelCalls}`, choices: [{ index: 0, delta, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address() as { port: number }
  const options: Parameters<typeof createKunServeRuntime>[0] = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-only', apiKey: '', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-model', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) }
  let runtime = await createKunServeRuntime(options)
  cleanup.push(() => runtime.shutdown?.())
  repository = new EngineeringAiRepository({ rootDir: join(root, 'runtime', 'engineering') })
  cleanup.push(() => repository.close())
  cleanup.push(async () => { await Promise.allSettled(runs.values()) })
  const project = runtime.engineeringService!.createProject({ name: 'Synthetic completion gate', workspace: root, expectedRevision: 0, idempotencyKey: 'fixture-project' })
  const network = await importWorkwiseSurveyNetwork(runtime.surveyService!, { projectId: project.id, expectedRevision: 1, idempotencyKey: 'fixture-network', networkType: 'leveling', network: {
    knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }], unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
    observations: [{ id: 'one', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }, { id: 'two', type: 'height-difference', from: 'BM', to: 'P', value: 0.1001, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
  } })
  const thread = await runtime.threadService.create({ workspace: root, model: 'synthetic-model', mode: 'agent', domain: 'engineering', projectId: project.id })
  const created = await runtime.engineeringAi!.createPlan({ threadId: thread.id, projectId: project.id, goal: '水准网平差和成果', idempotencyKey: 'fixture-plan' })
  expect(created.plan.status).toBe('awaiting_approval')
  plan = runtime.engineeringAi!.approvePlan(created.plan.id, { expectedRevision: created.plan.revision, contextHash: created.plan.contextHash, stepIds: created.approval.stepIds, token: created.approval.token, idempotencyKey: 'fixture-approval' })
  const waitTurn = async (turnId: string) => {
    expect(runs.has(turnId)).toBe(true)
    await runs.get(turnId)
    return runtime.turnService.getTurn(thread.id, turnId)
  }
  return { get runtime() { return runtime }, repository, root, project, network, thread, calledSteps,
    get plan() { return plan! }, setMode(value: typeof mode) { mode = value }, repeatCompleted() { repeatCompleted = true },
    async start() { const started = await runtime.engineeringAi!.startPlan(plan!.id, { expectedRevision: plan!.revision, contextHash: plan!.contextHash, model: 'synthetic-model', idempotencyKey: 'fixture-start' }); plan = started.plan; await waitTurn(started.turn.turnId); return started }, waitTurn,
    async restartInterruptedTask(legacy: boolean) {
      const task = runtime.taskRepository!.get(plan!.taskId!)!
      runtime.taskRepository!.update(task.id, task.revision, current => ({ ...current, status: 'running', attempts: 1, replans: 0, noProgressCount: 0, ...(legacy ? { engineeringPlanId: undefined } : {}) }))
      const store = new FileThreadStore({ dataDir: options.dataDir })
      const persisted = (await store.get(thread.id))!
      await store.upsert({ ...persisted, turns: persisted.turns.map(turn => turn.id === task.activeTurnId ? { ...turn, status: 'running', error: undefined, finishedAt: undefined, ...(legacy ? { engineeringExecution: undefined, engineeringPlanId: undefined } : {}) } : turn) })
      await runtime.shutdown?.()
      runtime = await createKunServeRuntime(options)
      await expect.poll(() => runtime.taskRepository!.get(task.id)?.activeTurnId, { timeout: 10_000 }).not.toBe(task.activeTurnId)
      const recovered = runtime.taskRepository!.get(task.id)!
      await expect.poll(() => runs.has(recovered.activeTurnId!), { timeout: 10_000 }).toBe(true)
      await waitTurn(recovered.activeTurnId!)
      return runtime.taskRepository!.get(task.id)!
    }
  }
}

describe('Engineering successful-step completion gate', () => {
  it.each(['text', 'partial'] as const)('rejects %s-only completion and projects an old false-completed task as needs_attention', async mode => {
    const f = await fixture(mode)
    const { plan, turn } = await f.start()
    const task = f.runtime.taskRepository!.get(plan.taskId!)!
    expect(task.status).toBe('stalled')
    expect(task.stalledReason).toContain('engineering_plan_steps_incomplete')
    expect((await f.runtime.turnService.getTurn(f.thread.id, turn.turnId))?.status).toBe('failed')
    const view = f.runtime.engineeringAi!.getPlan(plan.id)!
    expect(view.execution.completedStepIds).toEqual(mode === 'partial' ? [plan.steps[0]!.id] : [])
    expect(view.execution.complete).toBe(false)
    expect(f.runtime.surveyService!.listAdjustments(f.project.id)).toHaveLength(0)
    f.runtime.taskRepository!.update(task.id, task.revision, current => ({ ...current, status: 'completed' }))
    expect(f.runtime.engineeringAi!.getPlan(plan.id)).toMatchObject({ status: 'needs_attention', execution: { complete: false } })
    expect(f.repository.getPlan(plan.id)?.status).toBe('started')
  })

  it('completes only after all four real tools succeed', async () => {
    const f = await fixture('all')
    const { plan } = await f.start()
    expect(f.runtime.taskRepository!.get(plan.taskId!)?.status).toBe('completed')
    expect(f.calledSteps).toEqual(plan.steps.map(step => step.id))
    expect(f.runtime.engineeringAi!.getPlan(plan.id)).toMatchObject({ status: 'completed', execution: { complete: true, completedStepIds: plan.steps.map(step => step.id), pendingStepIds: [] } })
    expect(f.runtime.surveyService!.listAdjustments(f.project.id)).toHaveLength(1)
  })

  it('does not record a successful step receipt when the actual tool fails', async () => {
    const f = await fixture('partial')
    vi.spyOn(f.runtime.surveyService!, 'validateNetwork').mockImplementation(() => { throw new Error('Synthetic validation failure') })
    const { plan } = await f.start()
    expect(f.repository.stepEvidence(plan.id, plan.steps[0]!.id)).toBeNull()
    expect(f.runtime.taskRepository!.get(plan.taskId!)?.status).toBe('stalled')
    expect(f.runtime.engineeringAi!.getPlan(plan.id)?.execution.completedStepIds).toEqual([])
  })

  it('resumes the same task with persisted receipts and idempotently replays a successful step', async () => {
    const f = await fixture('partial')
    const started = await f.start()
    const receipt = f.repository.stepEvidence(f.plan.id, f.plan.steps[0]!.id)
    const revision = f.runtime.surveyService!.getNetwork(f.network.id)!.revision
    f.setMode('all'); f.repeatCompleted()
    const resumed = await f.runtime.engineeringAi!.resumePlan(f.plan.id, { expectedRevision: f.plan.revision, contextHash: f.plan.contextHash, idempotencyKey: 'fixture-resume' })
    await f.waitTurn(resumed.turn.turnId)
    expect(resumed.plan.taskId).toBe(started.plan.taskId)
    expect(f.runtime.taskRepository!.get(started.plan.taskId!)?.status).toBe('completed')
    expect(f.runtime.surveyService!.getNetwork(f.network.id)!.revision).toBe(revision)
    expect(f.repository.stepEvidence(f.plan.id, f.plan.steps[0]!.id)).toEqual(receipt)
    expect(f.runtime.surveyService!.listAdjustments(f.project.id)).toHaveLength(1)
    expect(f.runtime.engineeringAi!.getPlan(f.plan.id)?.execution.complete).toBe(true)
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('fails closed for an execution turn without its plan binding, while ordinary consultation still completes', async () => {
    const f = await fixture('text')
    const broken = await f.runtime.turnService.startTurn({ threadId: f.thread.id, engineeringExecution: true, request: { prompt: 'What is 2+3?' } })
    expect(await f.runtime.runTurn(f.thread.id, broken.turnId)).toBe('failed')
    expect(f.runtime.taskRepository!.findActiveByThread(f.thread.id)?.stalledReason).toBe('engineering_plan_binding_missing')
    const consultation = await f.runtime.turnService.startTurn({ threadId: f.thread.id, request: { prompt: 'What is 2+3?' } })
    expect(await f.runtime.runTurn(f.thread.id, consultation.turnId)).toBe('completed')
  })

  it.each([false, true])('recovers the same task after a real Runtime restart (legacy binding: %s)', async legacy => {
    const f = await fixture('partial')
    await f.start()
    const firstReceipt = f.repository.stepEvidence(f.plan.id, f.plan.steps[0]!.id)
    f.setMode('all')
    const recovered = await f.restartInterruptedTask(legacy)
    expect(recovered).toMatchObject({ id: f.plan.taskId, status: 'completed', engineeringPlanId: f.plan.id })
    const turn = await f.runtime.turnService.getTurn(f.thread.id, recovered.activeTurnId!)
    expect(turn).toMatchObject({ engineeringExecution: true, engineeringPlanId: f.plan.id })
    expect(f.calledSteps).toEqual(f.plan.steps.map(step => step.id))
    expect(f.repository.stepEvidence(f.plan.id, f.plan.steps[0]!.id)).toEqual(firstReceipt)
    expect(f.runtime.surveyService!.listAdjustments(f.project.id)).toHaveLength(1)
    expect(f.runtime.engineeringAi!.getPlan(f.plan.id)?.execution.complete).toBe(true)
  }, RESTART_TEST_TIMEOUT_MS)

  it.each([false, true])('rejects generic HTTP resume and retry for engineering execution (legacy binding: %s)', async legacy => {
    const f = await fixture('text')
    await f.start()
    const server = await startNodeHttpServer({ router: buildRouter(f.runtime), host: '127.0.0.1', port: 0 })
    cleanup.push(() => server.close())
    let task = f.runtime.taskRepository!.get(f.plan.taskId!)!
    if (legacy) task = f.runtime.taskRepository!.update(task.id, task.revision, current => ({ ...current, engineeringPlanId: undefined }))
    const before = await f.runtime.threadService.get(f.thread.id)
    for (const action of ['resume', 'retry']) {
      if (action === 'retry') task = f.runtime.taskRepository!.update(task.id, task.revision, current => ({ ...current, status: 'failed' }))
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/tasks/${task.id}/${action}`, { method: 'POST', headers: { authorization: 'Bearer synthetic-only', 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: task.revision, idempotencyKey: `generic-${action}` }) })
      expect(response.status).toBe(409)
      expect(await response.text()).toContain('engineering_plan_typed_resume_required')
    }
    expect((await f.runtime.threadService.get(f.thread.id))?.turns).toHaveLength(before!.turns.length)
    expect(f.runtime.engineeringAi!.getPlan(f.plan.id)?.execution.complete).toBe(false)
  })
})
