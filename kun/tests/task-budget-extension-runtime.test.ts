import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { TaskRunSchema } from '../src/contracts/tasks.js'
import { TaskRunRepository } from '../src/services/task-run-repository.js'
import { TaskControlService } from '../src/services/task-control-service.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks() })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'railwise-budget-extension-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-budget-token',
    apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic-model', endpointFormat: 'chat_completions' as const,
    approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}) }
  const runtime = await createKunServeRuntime(options)
  cleanup.push(async () => runtime.shutdown?.())
  const repository = runtime.taskRepository!
  const now = new Date().toISOString()
  const task = repository.create(TaskRunSchema.parse({ id: 'root-task', threadId: 'execution-thread', workspaceRoot: root,
    childTaskIds: [], goal: '合成预算验收', status: 'paused', agentId: 'default',
    acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false },
    budget: { version: 2, maxExecutionMs: 1_800_000, maxDurationMs: 1_800_000, maxAttempts: 100, maxCostUsd: 2 },
    attempts: 13, executionMs: 1_682_941, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 4, createdAt: now, updatedAt: now }))
  repository.execution.beginWork('already-used', task.id, 'model', 100)
  repository.execution.finishWork('already-used', 1_683_041)
  repository.execution.recordCost(task.id, 'cost', 0.5)
  const router = buildRouter(runtime)
  const api = (data: unknown, token = 'synthetic-budget-token') => dispatchRequest(router, new Request(`http://localhost/v1/tasks/${task.id}/budget`,
    { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(data) }))
  return { root, runtime, repository, task, api, options }
}

it('extends the actual paused root through authenticated Runtime HTTP, preserving usage and authority and replaying durably', async () => {
  const { runtime, repository, task, api } = await setup()
  const runTurn = vi.spyOn(runtime, 'runTurn')
  const request = { expectedRevision: task.revision, idempotencyKey: 'extend-once', additionalExecutionMs: 600_000 }
  const response = await api(request)
  expect(response.status).toBe(200)
  const next = await response.json()
  expect(next).toMatchObject({ id: task.id, status: 'paused', attempts: 13, executionMs: task.executionMs, revision: 5,
    budget: { ...task.budget, maxExecutionMs: 2_400_000 } })
  expect(repository.execution.usedExecutionMs(task.id, Date.now())).toBe(1_682_941)
  expect(repository.execution.usedCost(task.id)).toBe(0.5)
  expect(repository.execution.attempts(task.id)).toEqual([])
  expect(runTurn).not.toHaveBeenCalled()
  expect(repository.events(task.id).find(event => event.kind === 'task_execution_budget_extended')?.payload)
    .toMatchObject({ previousMaxExecutionMs: 1_800_000, additionalExecutionMs: 600_000, usedExecutionMs: 1_682_941, resumed: false })
  expect(await (await api(request)).json()).toEqual(next)
  expect((await api({ ...request, additionalExecutionMs: 1_200_000 })).status).toBe(409)
  expect((await api({ ...request, idempotencyKey: 'stale' })).status).toBe(409)
  expect(repository.get(task.id)?.budget.maxExecutionMs).toBe(2_400_000)
  const receipt = repository.operation(task.id, request.idempotencyKey)!
  expect(receipt).toMatchObject({ status: 'succeeded', kind: 'extend_budget', result: { revision: 5 } })
  // A second real connection (another Runtime/process after a lost response)
  // reads the committed receipt; it cannot append the same allowance again.
  const reopened = new TaskRunRepository(join(runtime.taskRepository!.sharedDatabase().name))
  try {
    const controls = new TaskControlService({ repository: reopened, tasks: runtime.taskController!, threads: runtime.threadService,
      turns: runtime.turnService, runTurn, nowIso: () => new Date().toISOString() })
    expect((await controls.mutate(task.id, 'extend_budget', request)).task).toEqual(next)
    expect(reopened.get(task.id)?.budget.maxExecutionMs).toBe(2_400_000)
    expect(reopened.execution.usedExecutionMs(task.id, Date.now())).toBe(1_682_941)
  } finally { reopened.close() }
})

it('rejects unauthorized, malformed, excessive and legacy requests without changing the ledger or starting a Turn', async () => {
  const { repository, task, api } = await setup()
  const request = { expectedRevision: task.revision, idempotencyKey: 'invalid', additionalExecutionMs: 600_000 }
  expect((await api(request, 'wrong-token')).status).toBe(401)
  for (const additionalExecutionMs of [0, -1, 0.5, 59_999, 3_600_001]) expect((await api({ ...request, additionalExecutionMs })).status).toBe(400)
  expect((await api({ ...request, model: 'other-model' })).status).toBe(400)
  repository.update(task.id, task.revision, value => ({ ...value, budget: { ...value.budget, version: undefined } }), { key: 'legacy', kind: 'synthetic' })
  expect((await api({ ...request, expectedRevision: 5 })).status).toBe(409)
  expect(repository.get(task.id)?.budget.maxExecutionMs).toBe(1_800_000)
  expect(repository.operations(task.id)).toEqual([])
})

it('checks the complete family and live work rather than the first page of tasks', async () => {
  const { repository, task, api } = await setup()
  for (let index = 0; index < 501; index++) repository.create({ ...task, id: `other-${index}`, threadId: `other-thread-${index}`, status: 'paused' })
  const child = repository.create({ ...task, id: 'child', threadId: 'child-thread', parentTaskId: task.id, rootTaskId: task.id, status: 'running' })
  const request = { expectedRevision: task.revision, idempotencyKey: 'family-busy', additionalExecutionMs: 600_000 }
  expect((await api(request)).status).toBe(409)
  repository.update(child.id, child.revision, value => ({ ...value, status: 'paused' }), { key: 'child-stop', kind: 'synthetic' })
  repository.execution.beginWork('open-child-work', task.id, 'model', Date.now())
  expect((await api(request)).status).toBe(409)
  repository.execution.finishWork('open-child-work', Date.now())
  repository.execution.beginAttempt({ taskId: child.id, sessionId: 'session', executionId: 'still-running', turnId: 'child-turn', ownerId: 'other-runtime',
    leaseRevision: 3, process: { pid: process.pid, fingerprint: 'synthetic' } }, new Date().toISOString())
  expect((await api(request)).status).toBe(409)
  repository.execution.finishAttempt('still-running', 'cancelled', new Date().toISOString())
  const shell = repository.createShellSession({ id: 'child-shell', taskId: child.id, nodeId: 'shell-node', workspaceRoot: task.workspaceRoot,
    commandSummary: 'synthetic read-only wait', cwd: task.workspaceRoot, status: 'running', outputPath: join(task.workspaceRoot, 'synthetic.log'),
    outputBytes: 0, createdAt: task.createdAt, revision: 0 })
  expect((await api(request)).status).toBe(409)
  repository.updateShellSession(shell.id, shell.revision, current => ({ ...current, status: 'completed', exitCode: 0, finishedAt: new Date().toISOString() }))
  expect((await api(request)).status).toBe(200)
  expect(repository.get(child.id)?.budget).toEqual(child.budget)
})

it('enforces the total cap and terminal/child restrictions at the repository transaction boundary', async () => {
  const { repository, task } = await setup()
  for (const status of ['running', 'completed', 'cancelled'] as const) {
    const candidate = repository.create({ ...task, id: status, status })
    expect(() => repository.extendExecutionBudget(candidate.id, candidate.revision, 600_000, status, new Date().toISOString())).toThrow()
  }
  const child = repository.create({ ...task, id: 'child', parentTaskId: task.id })
  expect(() => repository.extendExecutionBudget(child.id, child.revision, 600_000, 'child', new Date().toISOString())).toThrow()
  const capped = repository.update(task.id, task.revision, value => ({ ...value, budget: { ...value.budget, maxExecutionMs: 28_800_000 } }), { key: 'cap', kind: 'synthetic' })
  expect(() => repository.extendExecutionBudget(task.id, capped.revision, 60_000, 'cap', new Date().toISOString())).toThrow()
})


it('extends a stopped failed root without clearing failure, attempts, history, authority or shared usage', async () => {
  const { runtime, repository, task, api } = await setup()
  const failed = repository.update(task.id, task.revision, value => ({ ...value, status: 'failed', attempts: 14,
    budget: { ...value.budget, maxAttempts: 8 }, stalledReason: 'Previous source verification failed' }), { key: 'failed-before-retry', kind: 'synthetic' })
  const original = repository.beginOperation({ ownerId: task.id, kind: 'tool', idempotencyKey: 'historical-unknown', request: { toolName: 'synthetic_write' }, nowIso: task.createdAt }).receipt
  repository.finishOperation(task.id, original.idempotencyKey, { status: 'outcome_unknown' }, task.createdAt)
  const historical = repository.operation(task.id, original.idempotencyKey)
  const work = repository.connection().prepare('SELECT * FROM task_work_spans WHERE root_id=?').all(task.id)
  const runTurn = vi.spyOn(runtime, 'runTurn')
  const request = { expectedRevision: failed.revision, idempotencyKey: 'failed-extension', additionalExecutionMs: 600_000 }
  const response = await api(request)
  expect(response.status).toBe(200)
  const next = TaskRunSchema.parse(await response.json())
  expect(next).toMatchObject({ status: 'failed', attempts: 14, stalledReason: failed.stalledReason,
    budget: { ...failed.budget, maxExecutionMs: 2_400_000 } })
  expect(next.authority).toEqual(failed.authority)
  expect(repository.execution.usedExecutionMs(task.id, Date.now())).toBe(1_682_941)
  expect(repository.execution.usedCost(task.id)).toBe(0.5)
  expect(repository.connection().prepare('SELECT * FROM task_work_spans WHERE root_id=?').all(task.id)).toEqual(work)
  expect(repository.operation(task.id, original.idempotencyKey)).toEqual(historical)
  expect(runTurn).not.toHaveBeenCalled()
  expect(await (await api(request)).json()).toEqual(next)
  expect(repository.events(task.id).filter(event => event.kind === 'task_execution_budget_extended')).toHaveLength(1)
})
