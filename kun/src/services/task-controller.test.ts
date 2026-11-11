import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it,vi } from 'vitest'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { TaskController } from './task-controller.js'
import { TaskLeaseLostError, TaskRunRepository } from './task-run-repository.js'
import { RuntimeSpanService } from './runtime-span-service.js'
import { createApprovalRequest } from '../domain/approval.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { makeAssistantTextItem, makeToolResultItem } from '../domain/item.js'

const cleanup: string[] = []
const PERSISTENCE_TEST_TIMEOUT_MS = 15_000

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(prompt = '完成可靠性测试。') {
  const root = await mkdtemp(join(tmpdir(), 'workwise-task-controller-'))
  cleanup.push(root)
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({
    id: 'thread_reliability',
    title: 'reliability',
    workspace: root,
    model: 'fixture'
  })
  await threadStore.upsert(thread)
  let now = '2026-07-18T00:00:00.000Z'
  const spans = new RuntimeSpanService(repository, () => now)
  const controller = new TaskController({
    repository,
    threadStore,
    sessionStore,
    nowIso: () => now,
    ownerId: 'test-runtime',
    spans
  })
  const task = controller.ensureTask({
    thread,
    turnId: 'turn_reliability',
    request: { prompt }
  })
  return {
    root,
    thread,
    threadStore,
    repository,
    sessionStore,
    spans,
    controller,
    task,
    setNow(value: string) { now = value }
  }
}

describe('TaskController reliability boundaries', () => {
  it.each(['exact', 'unknown', 'missing_hash', 'arguments', 'provider', 'target', 'account', 'backend', 'workspace', 'scope', 'denied', 'forged_transfer'])('transfers an undispatched approval only for the exact reviewed operation (%s)', async variation => {
    const { repository, controller, task, thread } = await fixture()
    try {
      controller.beginAttempt(thread.id, 'turn_reliability')
      const grant = ExecutionGrantSchema.parse({ id: 'new-grant', taskId: task.id, threadId: thread.id, turnId: 'turn_reliability',
        workspaceRoot: thread.workspace, workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', sandboxMode: 'workspace-write', approvalPolicy: 'on-request',
        workspaceRevision: 1, agentRevision: 1, revision: 1, idempotencyKey: 'new-grant', issuedAt: '2026-07-18T00:00:00.000Z',
        expiresAt: '2026-07-18T00:15:00.000Z', connectorBackends: { dingtalk: 'dws' }, connectorIdentityFingerprints: { dingtalk: 'a'.repeat(64) } })
      const current = controller.beginToolOperation('turn_reliability', { callId: 'new-call', toolName: 'write', arguments: { path: 'summary.md', content: 'reviewed' } }, grant)!
      const request = repository.operation(task.id, current.key)!.request!
      const oldGrant = { ...grant, id: 'old-grant', turnId: 'previous-turn', idempotencyKey: 'old-grant',
        // Reauthorization uses a valid new Grant even if the interrupted Turn expired.
        expiresAt: '2026-07-17T23:59:00.000Z' }
      const oldRequest: Record<string, unknown> = { ...request, turnId: 'previous-turn', callId: 'old-call', executionGrant: oldGrant }
      if (variation === 'missing_hash') delete oldRequest.approvalRequestHash
      if (variation === 'arguments') oldRequest.argumentsHash = 'changed'
      if (variation === 'provider') oldRequest.providerId = 'different-provider'
      if (variation === 'target') oldRequest.target = 'different-target'
      if (variation === 'account') oldGrant.connectorIdentityFingerprints = { dingtalk: 'b'.repeat(64) }
      if (variation === 'backend') oldGrant.connectorBackends = { dingtalk: 'openapi' }
      if (variation === 'workspace') oldGrant.workspaceRevision = 2
      if (variation === 'scope') oldRequest.scopeRevision = 2
      repository.beginOperation({ ownerId: task.id, idempotencyKey: 'old-operation', kind: 'tool', request: oldRequest, nowIso: '2026-07-17T23:30:00.000Z' })
      repository.finishOperation(task.id, 'old-operation', { status: variation === 'unknown' ? 'outcome_unknown' : 'failed', result: {
        approved: false, item: makeToolResultItem({ id: 'old-result', threadId: thread.id, turnId: 'previous-turn', callId: 'old-call', toolName: 'write',
          isError: true, output: { code: 'operation_not_dispatched' } }) } }, '2026-07-17T23:31:00.000Z')
      const oldApproval = createApprovalRequest({ id: 'appr_old-call', threadId: thread.id, turnId: 'previous-turn', toolName: 'write', summary: 'Write reviewed summary' })
      repository.saveHumanRequest({ id: oldApproval.id, kind: 'approval', threadId: thread.id, turnId: oldApproval.turnId,
        message: oldApproval.summary, payload: { approval: oldApproval, ...(variation === 'forged_transfer' ? { continuedFromApprovalId: 'unverified-parent' } : {}) }, status: 'answered', resolution: { decision: variation === 'denied' ? 'deny' : 'allow' },
        createdAt: '2026-07-17T23:30:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z' })
      const approval = createApprovalRequest({ id: 'new-approval', threadId: thread.id, turnId: 'turn_reliability', toolName: 'write', summary: 'Write reviewed summary',
        callId: 'new-call', requestHash: request.approvalRequestHash as string })
      expect(controller.claimUndispatchedApproval(current.token, current.key, approval)).toBe(variation === 'exact')
      expect(repository.operations(task.id, 'approval_transfer')).toHaveLength(variation === 'exact' ? 1 : 0)
      expect(repository.inbox(undefined, true)).toHaveLength(0)
      if (variation === 'exact') {
        expect(controller.claimUndispatchedApproval(current.token, current.key, approval)).toBe(true)
        const repeated = controller.beginToolOperation('turn_reliability', { callId: 'another-call', toolName: 'write', arguments: { path: 'summary.md', content: 'reviewed' } }, grant)!
        expect(controller.claimUndispatchedApproval(repeated.token, repeated.key, { ...approval, id: 'another-approval', callId: 'another-call' })).toBe(false)
        expect(repository.humanRequest(approval.id)?.payload.continuedFromApprovalId).toBe(oldApproval.id)
      }
    } finally { repository.close() }
  })

  it('charges concurrent work against one root execution budget and aborts at the shared limit',async()=>{
    const {repository,controller,task,thread,setNow,threadStore,sessionStore}=await fixture()
    repository.update(task.id,task.revision,current=>({...current,budget:{...current.budget,version:2,maxExecutionMs:100}}))
    controller.beginAttempt(thread.id,'turn_reliability')
    let childNow='2026-07-18T00:00:00.000Z'
    repository.create({...task,id:'child-budget',threadId:'child-thread',parentTaskId:task.id,rootTaskId:task.id,activeTurnId:'child-turn',nodes:task.nodes.map(node=>({...node,id:`child-${node.id}`,taskId:'child-budget'}))})
    const child=new TaskController({repository,threadStore,sessionStore,nowIso:()=>childNow})
    child.beginAttempt('child-thread','child-turn')
    const abort=vi.fn(),childAbort=vi.fn()
    controller.registerExecutionAbort('turn_reliability',abort)
    child.registerExecutionAbort('child-turn',childAbort)
    vi.useFakeTimers()
    const first=controller.beginWork('turn_reliability','parallel-1','model')
    const second=child.beginWork('child-turn','parallel-2','tool')
    setNow('2026-07-18T00:00:00.050Z')
    childNow='2026-07-18T00:00:00.050Z'
    await vi.advanceTimersByTimeAsync(50)
    expect(abort).toHaveBeenCalledExactlyOnceWith('execution_budget_exhausted')
    expect(childAbort).toHaveBeenCalledExactlyOnceWith('execution_budget_exhausted')
    expect(repository.execution.usedExecutionMs(task.id,Date.parse('2026-07-18T00:00:00.050Z'))).toBe(100)
    first();second()
    expect(()=>controller.beginWork('turn_reliability','over-budget','model')).toThrow(/execution budget exhausted/)
    repository.close()
  })

  it('acknowledges durable input only with a checkpoint under the current immutable lease', async () => {
    const {repository,controller,task,thread,setNow}=await fixture()
    controller.beginAttempt(thread.id,'turn_reliability')
    const running=repository.get(task.id)!
    const saved=controller.appendInput(task.id,running.revision,'input-boundary','再加一章风险分析')
    const deliveries=controller.pendingDeliveries(thread.id,'turn_reliability')
    expect(deliveries).toHaveLength(1)
    expect(repository.inputs(task.id,true)).toHaveLength(1)
    expect(repository.execution.pending(repository.execution.sessionForTask(task.id)!.id)[0]?.status).toBe('queued')
    expect(()=>controller.acknowledgeInputs('turn_reliability',deliveries.map(item=>item.delivery),'item_checkpoint','a'.repeat(64))).toThrow(/transcript proof/)
    controller.markInputsDelivered('turn_reliability',deliveries.map(item=>item.delivery),'item_checkpoint','a'.repeat(64))
    expect(repository.execution.pending(repository.execution.sessionForTask(task.id)!.id)[0]).toMatchObject({status:'delivered',sessionItemId:'item_checkpoint',sessionHash:'a'.repeat(64)})
    expect(repository.inputs(task.id,true)).toHaveLength(1)
    controller.acknowledgeInputs('turn_reliability',deliveries.map(item=>item.delivery),'item_checkpoint','a'.repeat(64))
    expect(repository.inputs(task.id,true)).toHaveLength(0)
    expect(repository.latestCheckpoint(task.id)).toMatchObject({consumedInputIds:[saved.input.id],sessionItemId:'item_checkpoint',sessionHash:'a'.repeat(64)})
    const next=controller.appendInput(task.id,repository.get(task.id)!.revision,'input-stale','不要覆盖原文')
    const stale=controller.pendingDeliveries(thread.id,'turn_reliability')
    setNow('2026-07-18T00:02:00.000Z')
    repository.acquireLease(task.id,'new-runtime','2026-07-18T00:02:00.000Z','2026-07-18T00:03:00.000Z')
    expect(()=>controller.acknowledgeInputs('turn_reliability',stale.map(item=>item.delivery),'stale','b'.repeat(64))).toThrow(TaskLeaseLostError)
    expect(repository.inputs(task.id,true).map(input=>input.id)).toContain(next.input.id)
    expect(repository.latestCheckpoint(task.id)?.sessionItemId).toBe('item_checkpoint')
    repository.close()
  })

  it('preserves an old dispatch receipt after fencing and blocks unknown replay and resume',async()=>{
    const {repository,controller,task,thread,setNow}=await fixture()
    controller.beginAttempt(thread.id,'turn_reliability')
    const operation=controller.beginToolOperation('turn_reliability',{callId:'external',toolName:'send_message',arguments:{token:'secret-token',message:'private body'}})!
    expect(JSON.stringify(repository.operation(task.id,operation.key))).not.toContain('secret-token')
    expect(JSON.stringify(repository.operation(task.id,operation.key))).not.toContain('private body')
    controller.recordToolDispatch(operation.token, operation.key)
    controller.finishToolOperation(operation.token,operation.key)
    const stalled=controller.recordAttemptFailure(thread.id,'turn_reliability','tool_exception','connection dropped')!
    expect(stalled.kind).toBe('stalled')
    expect(()=>controller.prepareResume(task.id,stalled.task.revision)).toThrow(/Verify outstanding/)
    setNow('2026-07-18T00:02:00.000Z')
    repository.acquireLease(task.id,'other','2026-07-18T00:02:00.000Z','2026-07-18T00:03:00.000Z')
    expect(()=>controller.assertToken(operation.token)).toThrow(TaskLeaseLostError)
    controller.finishToolOperation(operation.token,operation.key,{approved:true,item:makeToolResultItem({id:'result',threadId:thread.id,turnId:'turn_reliability',callId:'external',toolName:'send_message',output:{status:'sent',message:'private body',token:'secret-token'}})})
    expect(repository.operation(task.id,operation.key)?.status).toBe('succeeded')
    expect(JSON.stringify(repository.operation(task.id,operation.key)?.result)).not.toContain('private body')
    expect(repository.get(task.id)?.status).toBe('stalled')
    repository.close()
  })

  it('distinguishes a cancelled approval from a dispatched operation with a lost reply', async () => {
    const { repository, controller, task } = await fixture()
    controller.beginAttempt(task.threadId, 'turn_reliability')
    const waiting = controller.beginToolOperation('turn_reliability', { callId: 'awaiting-approval', toolName: 'pending_write', arguments: {} })!
    expect(repository.operation(task.id, waiting.key)?.status).toBe('prepared')
    controller.finishToolOperation(waiting.token, waiting.key)
    expect(repository.operation(task.id, waiting.key)).toMatchObject({ status: 'failed', result: { approved: false, item: { output: { code: 'operation_not_dispatched' } } } })
    const started = controller.beginToolOperation('turn_reliability', { callId: 'actual-dispatch', toolName: 'pending_write', arguments: { target: 'test' } })!
    controller.recordToolDispatch(started.token, started.key)
    expect(repository.operation(task.id, started.key)?.status).toBe('running')
    controller.finishToolOperation(started.token, started.key)
    expect(repository.operation(task.id, started.key)?.status).toBe('outcome_unknown')
    repository.close()
  })

  it.each([false, true])('recovers a prepared receipt with host dispatch tracking=%s without replaying an uncertain legacy action', async tracked => {
    const f = await fixture()
    f.controller.beginAttempt(f.thread.id, 'turn_reliability')
    f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: 'prepared-before-restart', kind: 'tool',
      request: { toolName: 'synthetic_write', callId: 'original', turnId: 'turn_reliability', ...(tracked ? { dispatchTracking: 'host-v1' } : {}) },
      nowIso: '2026-07-18T00:00:00.000Z' })
    expect(f.repository.unsettledOperations(f.task.id)).toHaveLength(tracked ? 0 : 1)
    f.controller.endRun('turn_reliability')
    f.repository.close()
    const repository = new TaskRunRepository(join(f.root, 'tasks.sqlite3'))
    const controller = new TaskController({ repository, threadStore: f.threadStore, sessionStore: f.sessionStore,
      nowIso: () => '2026-07-18T00:02:00.000Z', ownerId: 'restarted-runtime' })
    try {
      const recovered = controller.reconcileStartup()
      expect(recovered).toHaveLength(1)
      expect(recovered[0].status).toBe(tracked ? 'retrying' : 'stalled')
      expect(repository.operation(f.task.id, 'prepared-before-restart')?.status).toBe(tracked ? 'failed' : 'outcome_unknown')
      if (!tracked) {
        expect(() => controller.prepareResume(f.task.id, recovered[0].revision)).toThrow(/Verify outstanding/)
        expect(repository.unsettledOperations(f.task.id)).toHaveLength(1)
      }
      expect(repository.operations(f.task.id, 'tool')).toHaveLength(1)
    } finally { repository.close() }
  })

  it('counts cumulative usage once per model request and keeps child work in the root budget',async()=>{
    const {repository,controller,task,thread,setNow}=await fixture()
    repository.update(task.id,task.revision,current=>({...current,budget:{...current.budget,version:2,maxExecutionMs:500,maxCostUsd:1}}))
    controller.beginAttempt(thread.id,'turn_reliability')
    const finish=controller.beginWork('turn_reliability','first-model','model')
    setNow('2026-07-18T00:00:00.200Z'); finish()
    controller.recordCost('turn_reliability','first-model',0.2)
    controller.recordCost('turn_reliability','first-model',0.4)
    expect(repository.execution.usedCost(task.id)).toBe(0.4)
    expect(controller.workBudget('turn_reliability')).toMatchObject({rootTaskId:task.id,remainingMs:300,serialRoot:true})
    repository.execution.beginWork('child-model',task.id,'model',Date.parse('2026-07-18T00:00:00.200Z'))
    setNow('2026-07-18T00:00:00.600Z')
    expect(()=>controller.beginWork('turn_reliability','third-model','model')).toThrow(/execution budget exhausted/)
    repository.close()
  })

  it('captures the selected Agent model and bounded budget in a new task', async () => {
    const { repository, controller, thread, threadStore } = await fixture()
    const selectedThread = {
      ...thread,
      id: 'thread_agent_policy',
      agentId: 'review',
      agentProfile: {
        id: 'review', name: 'Review', role: '审查', color: '#f59e0b',
        systemPrompt: '只读审查。', model: 'review-model',
        toolAllowlist: ['read'], mcpAllowlist: [], trustLevel: 'read-only' as const,
        budget: { maxAttempts: 3, maxDurationMs: 60_000, maxCostUsd: 2 }, revision: 1
      },
      costBudgetUsd: 1
    }
    await threadStore.upsert(selectedThread)
    const task = controller.ensureTask({
      thread: selectedThread,
      turnId: 'turn_agent_policy',
      request: { prompt: '审查当前实现。' }
    })
    expect(task).toMatchObject({
      agentId: 'review',
      model: 'review-model',
      budget: { maxAttempts: 3, maxDurationMs: 60_000, maxCostUsd: 1 }
    })
    repository.close()
  })

  it('keeps the unfinished task and requires explicit routing for unrelated feedback', async () => {
    const { repository, controller, task, thread } = await fixture(
      '请创建并交付 workwise-download-test.txt 文件。'
    )
    repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: 'stalled',
      stalledReason: '文件交付失败。',
      updatedAt: '2026-07-18T00:01:00.000Z'
    }))

    expect(() => controller.ensureTask({
      thread,
      turnId: 'turn_download_feedback',
      request: { prompt: 'TXT 无法下载' }
    })).toThrow(/explicit supplement or new-task routing/)
    expect(repository.get(task.id)).toMatchObject({
      status: 'stalled',
      stalledReason: '文件交付失败。'
    })
    repository.close()
  })

  it('keeps an unfinished file task when the user explicitly asks to continue', async () => {
    const { repository, controller, task, thread } = await fixture(
      '请创建并交付 workwise-download-test.txt 文件。'
    )
    const stalled = repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: 'stalled',
      stalledReason: '等待继续。',
      updatedAt: '2026-07-18T00:01:00.000Z'
    }))

    const resumed = controller.ensureTask({
      thread,
      turnId: 'turn_continue',
      request: { prompt: '同意，继续推进。' }
    })

    expect(resumed.id).toBe(task.id)
    expect(resumed).toMatchObject({
      activeTurnId: 'turn_continue',
      acceptance: stalled.acceptance,
      status: 'stalled'
    })
    expect(repository.list({ threadId: thread.id })).toHaveLength(1)
    repository.close()
  })

  it('does not cancel or retarget an active task for a status intent', async () => {
    const { repository, controller, task, thread } = await fixture('继续整理监测报告。')
    const snapshot = controller.ensureTask({
      thread,
      turnId: 'turn_status',
      request: { prompt: '现在做到哪了？', taskIntent: 'status' }
    })
    expect(snapshot.id).toBe(task.id)
    expect(snapshot.activeTurnId).toBe(task.activeTurnId)
    expect(repository.get(task.id)?.status).toBe('queued')
    expect(repository.list({ threadId: thread.id })).toHaveLength(1)
    repository.close()
  })

  it('replans repeated no-progress attempts and stalls with a recoverable checkpoint', async () => {
    const { repository, controller, task } = await fixture()
    let lastKind = ''
    for (let attempt = 0; attempt < 7; attempt += 1) {
      controller.beginAttempt(task.threadId, 'turn_reliability')
      lastKind = controller.recordAttemptFailure(
        task.threadId,
        'turn_reliability',
        'network_unavailable',
        'network unavailable'
      )?.kind ?? ''
    }

    const stored = repository.get(task.id)
    expect(lastKind).toBe('stalled')
    expect(stored).toMatchObject({ status: 'stalled', replans: 2, attempts: 7 })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_replanned')).toHaveLength(1)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_stalled')).toHaveLength(1)
    expect(repository.latestCheckpoint(task.id)?.resumeSummary).toBe('network unavailable')
    repository.close()
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it.each([undefined, 'Historical stalled reason'])('clears obsolete reasons after resumed completion while preserving failure history (legacy reason: %s)', async legacyReason => {
    const { repository, controller, sessionStore, task } = await fixture('What is 2 + 3?')
    try {
      for (let attempt = 0; attempt < 7; attempt += 1) {
        controller.beginAttempt(task.threadId, 'turn_reliability')
        controller.recordAttemptFailure(task.threadId, 'turn_reliability', 'network_unavailable', 'network unavailable')
      }
      const stalled = repository.get(task.id)!
      expect(stalled.status).toBe('stalled')
      const resumed = controller.prepareResume(task.id, stalled.revision)
      expect(resumed.waitingReason).toBeTruthy()
      controller.beginAttempt(task.threadId, 'turn_reliability')
      if (legacyReason) {
        const running = repository.get(task.id)!
        repository.update(task.id, running.revision, current => ({ ...current, stalledReason: legacyReason }))
      }
      await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
        id: 'item_resumed_answer', threadId: task.threadId, turnId: 'turn_reliability', text: '2 + 3 = 5.', status: 'completed'
      }))
      const history = repository.events(task.id)
      const decision = await controller.assessCandidate(task.threadId, 'turn_reliability')
      expect(decision).toMatchObject({ kind: 'completed', task: { status: 'completed' } })
      const completed = repository.get(task.id)!
      expect(completed.waitingReason).toBeUndefined()
      expect(completed.stalledReason).toBeUndefined()
      expect(repository.events(task.id).slice(0, history.length)).toEqual(history)
      expect(repository.events(task.id).filter(event => event.kind === 'task_stalled')).toHaveLength(1)
      expect(repository.events(task.id).filter(event => event.kind === 'task_completed')).toHaveLength(1)
    } finally {
      repository.close()
    }
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('fails at a hard attempt budget without ever writing a completion event', async () => {
    const { repository, controller, task } = await fixture()
    let decision
    for (let attempt = 0; attempt < 8; attempt += 1) {
      controller.beginAttempt(task.threadId, 'turn_reliability')
      decision = controller.recordAttemptFailure(
        task.threadId,
        'turn_reliability',
        `fixture_${attempt}`,
        `different failure ${attempt}`
      )
    }

    expect(decision?.kind).toBe('failed')
    expect(repository.get(task.id)?.status).toBe('failed')
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(0)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_failed')).toHaveLength(1)
    repository.close()
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('fails a depleted web search immediately instead of silently retrying it', async () => {
    const { repository, controller, task } = await fixture('今天 AI 圈有哪些资讯？')
    controller.beginAttempt(task.threadId, 'turn_reliability')

    const decision = controller.recordAttemptFailure(
      task.threadId,
      'turn_reliability',
      'web_access_exhausted',
      '在线搜索连续失败，无法核实当前资讯。'
    )

    expect(decision).toMatchObject({ kind: 'failed', task: { status: 'failed', attempts: 1 } })
    expect(repository.events(task.id).filter((event) => event.kind === 'attempt_retrying')).toHaveLength(0)
    repository.close()
  })

  it('does not complete a task from an assistant reply that explicitly reports unverified web failure', async () => {
    const { repository, sessionStore, controller, task } = await fixture('今天宁波的天气怎么样？')
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_web_failure',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: '实时网页获取失败，所以目前无法核实宁波今天的准确天气信息。请稍后重试。',
      status: 'completed'
    }))
    controller.beginAttempt(task.threadId, 'turn_reliability')

    await expect(controller.assessCandidate(task.threadId, 'turn_reliability')).resolves.toMatchObject({
      kind: 'failed',
      task: { status: 'failed' },
      reason: expect.stringContaining('web_access_exhausted')
    })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(0)
    repository.close()
  })

  it('waits for a verified external-effect receipt instead of completing a prose-only approval task', async () => {
    const { repository, sessionStore, controller, task, thread } = await fixture('连接钉钉并自动审批我的待办事项。')
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_effect_blocked',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: '当前没有钉钉连接或授权，因此无法执行审批。我可以先提供操作方案。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability')).resolves.toMatchObject({
      kind: 'waiting_user',
      task: { status: 'waiting_user', acceptance: { kind: 'effect' } },
      reason: expect.stringContaining('目标集合及逐项验证回执')
    })
    expect(repository.events(task.id).filter(event => event.kind === 'task_completed')).toHaveLength(0)
    repository.close()
  })

  it('requires verified effects when the task also delivers files', async () => {
    const { repository, sessionStore, controller, task } = await fixture('生成 Markdown 报告并发送到飞书。')
    expect(task.acceptance).toMatchObject({ kind: 'files', requiresExternalEffects: true, effect: { provider: 'lark' } })
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'mixed-final', threadId: task.threadId, turnId: 'turn_reliability',
      text: '报告已生成，包含来源和统计结果。', status: 'completed'
    }))
    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability')).resolves.toMatchObject({ kind: 'waiting_user' })
    expect(repository.events(task.id).some(event => event.kind === 'task_completed')).toBe(false)
    repository.close()
  })

  it('persists transport uncertainty and rejects the same mutation under a new call id', async () => {
    const { repository, controller, task } = await fixture()
    controller.beginAttempt(task.threadId, 'turn_reliability')
    const call = { callId: 'first', toolName: 'mcp_fixture_send', arguments: { target: 'test' } }
    const operation = controller.beginToolOperation('turn_reliability', call)!
    controller.finishToolOperation(operation.token, operation.key, {
      approved: true,
      item: makeToolResultItem({ id: 'uncertain', threadId: task.threadId, turnId: 'turn_reliability', callId: call.callId,
        toolName: call.toolName, output: { code: 'outcome_unknown' }, isError: true })
    })
    expect(repository.operation(task.id, operation.key)?.status).toBe('outcome_unknown')
    expect(() => controller.beginToolOperation('turn_reliability', { ...call, callId: 'second' })).toThrow(/unknown outcome/)
    repository.close()
  })

  it('completes an external-effect task only after a successful effect receipt', async () => {
    const { repository, sessionStore, controller, task, thread } = await fixture('同意钉钉审批。')
    repository.update(task.id, task.revision, current => ({
      ...current,
      acceptance: { ...current.acceptance, effect: { provider: 'dingtalk', operation: 'approve', target: 'synthetic-task', requiredScopes: [], requiresConfirmation: true, successStatus: ['succeeded'], verification: 'provider_readback' } }
    }))
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_effect_done',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: '钉钉待办已审批完成。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    const operation = controller.beginToolOperation('turn_reliability', {
      callId: 'call_dingtalk_approval',
      toolName: 'dingtalk_approve',
      arguments: { taskId: 'synthetic-task' }
    })!
    controller.finishToolOperation(operation.token, operation.key, {
      approved: true,
      item: makeToolResultItem({
        id: 'item_dingtalk_result',
        threadId: thread.id,
        turnId: 'turn_reliability',
        callId: 'call_dingtalk_approval',
        toolName: 'dingtalk_approve',
        output: { ok:true,status:'succeeded',evidence:{kind:'external_operation',provider:'dingtalk',operation:'approve',target:'synthetic-task',verified:true,verifiedAt:'2026-07-18T00:00:00Z',resultHash:'synthetic-hash',status:'approved',remoteOperationId:'synthetic-approval-1'} }
      })
    })

    await expect(controller.assessCandidate(task.threadId, 'turn_reliability')).resolves.toMatchObject({
      kind: 'completed',
      task: { status: 'completed', acceptance: { kind: 'effect' } }
    })
    expect(repository.events(task.id).filter(event => event.kind === 'task_completed')).toHaveLength(1)
    repository.close()
  })

  it('does not dispatch or complete a broad Lark task without a finite reviewed target set', async () => {
    const { repository, sessionStore, controller, task } = await fixture('帮我处理飞书待办。')
    expect(task.acceptance).toMatchObject({ kind: 'effect', effect: { provider: 'lark', operation: 'process', requiresConfirmation: true } })
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_lark_effect_done',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: '已完成飞书待办 task-42。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    expect(() => controller.beginToolOperation('turn_reliability', {
      callId: 'call_lark_complete',
      toolName: 'lark_task_complete',
      arguments: { taskId: 'task-42' }
    })).toThrow(/confirm_external_effect_scope/)
    expect(repository.operations(task.id, 'tool')).toHaveLength(0)

    await expect(controller.assessCandidate(task.threadId, 'turn_reliability')).resolves.toMatchObject({
      kind: 'waiting_user',
      task: { status: 'waiting_user' }
    })
    expect(repository.events(task.id).filter(event => event.kind === 'task_completed')).toHaveLength(0)
    repository.close()
  })

  it('enforces the duration budget and recovers an expired running lease after restart', async () => {
    const { repository, controller, task, setNow } = await fixture()
    const constrained = repository.update(task.id, task.revision, (current) => ({
      ...current,
      budget: { ...current.budget, maxDurationMs: 1 },
      revision: current.revision
    }))
    controller.beginAttempt(constrained.threadId, 'turn_reliability')
    setNow('2026-07-18T00:00:01.000Z')
    const exhausted = controller.recordAttemptFailure(
      constrained.threadId,
      'turn_reliability',
      'temporary',
      'temporary failure'
    )
    expect(exhausted?.task.nodes[0]?.errorCode).toBe('duration_budget_exhausted')

    repository.close()

    const recovery = await fixture()
    recovery.controller.beginAttempt(recovery.task.threadId, 'turn_reliability')
    recovery.setNow('2026-07-18T00:02:00.000Z')
    expect(recovery.controller.reconcileStartup()[0]?.status).toBe('running')
    // A lease timeout alone cannot prove that a worker has exited.
    const attempt = recovery.repository.execution.latestAttempt(recovery.task.id)!
    recovery.repository.execution.finishAttempt(attempt.executionId,'cancelled','2026-07-18T00:01:30.000Z')
    const recovered = recovery.controller.reconcileStartup()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ status: 'retrying' })
    expect(recovery.repository.latestCheckpoint(recovery.task.id)?.resumeSummary).toContain('自动续跑')
    recovery.repository.close()
  }, PERSISTENCE_TEST_TIMEOUT_MS)

  it('renews an active execution lease from the runtime watchdog', async () => {
    const { repository, controller, task, setNow } = await fixture()
    try {
      controller.startWatchdog({ intervalMs: 60_000, leaseMs: 60_000 })
      controller.beginAttempt(task.threadId, task.activeTurnId!)
      setNow('2026-07-18T00:00:30.000Z')
      await (controller as unknown as { runWatchdogTick: () => Promise<void> }).runWatchdogTick()

      expect(repository.getLease(task.id)).toMatchObject({
        ownerId: 'test-runtime',
        expiresAt: '2026-07-18T00:01:30.000Z'
      })
    } finally {
      controller.stopWatchdog()
      repository.close()
    }
  })

  it('fences an execution after another runtime takes over its expired lease', async () => {
    const { repository, controller, task, setNow } = await fixture()
    try {
      controller.startWatchdog({ intervalMs: 60_000, leaseMs: 60_000 })
      controller.beginAttempt(task.threadId, task.activeTurnId!)
      setNow('2026-07-18T00:02:00.000Z')
      expect(repository.acquireLease(task.id, 'other-runtime', '2026-07-18T00:02:00.000Z', '2026-07-18T00:03:00.000Z'))
        .toMatchObject({ ownerId: 'other-runtime' })

      await (controller as unknown as { runWatchdogTick: () => Promise<void> }).runWatchdogTick()
      expect(() => controller.recordAttemptFailure(task.threadId, task.activeTurnId!, 'temporary', 'temporary failure'))
        .toThrow(TaskLeaseLostError)
    } finally {
      controller.stopWatchdog()
      repository.close()
    }
  })

  it('delivers watchdog recovery once and clears the in-flight guard after reacquiring a lease', async () => {
    const { repository, controller, task, setNow } = await fixture()
    try {
      repository.update(task.id, task.revision, current => ({
        ...current,
        status: 'running',
        updatedAt: '2026-07-18T00:00:01.000Z'
      }))
      expect(repository.acquireLease(task.id, 'old-runtime', '2026-07-18T00:00:00.000Z', '2026-07-18T00:01:00.000Z'))
        .toMatchObject({ ownerId: 'old-runtime' })
      setNow('2026-07-18T00:02:00.000Z')

      const recovered: string[] = []
      controller.startWatchdog({
        intervalMs: 60_000,
        leaseMs: 60_000,
        onRecoveryNeeded: (tasks) => {
          recovered.push(...tasks.map(item => item.id))
          for (const item of tasks) controller.beginAttempt(item.threadId, item.activeTurnId!)
        }
      })
      await (controller as unknown as { runWatchdogTick: () => Promise<void> }).runWatchdogTick()
      await (controller as unknown as { runWatchdogTick: () => Promise<void> }).runWatchdogTick()

      expect(recovered).toEqual([task.id])
      expect(repository.getLease(task.id)?.ownerId).toBe('test-runtime')
    } finally {
      controller.stopWatchdog()
      repository.close()
    }
  })

  it('records task, turn, and artifact validation spans without storing the absolute artifact path', async () => {
    const { root, repository, sessionStore, spans, controller, task } = await fixture(
      '请生成并交付 result.md Markdown 文件。'
    )
    await writeFile(join(root, 'result.md'), '# Verified deliverable\n', 'utf8')
    await sessionStore.appendItem(task.threadId, makeToolResultItem({
      id: 'item_tool_result',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      callId: 'call_write',
      toolName: 'write',
      output: { path: join(root, 'result.md') }
    }))
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_assistant',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: 'Markdown 文档已生成并交付。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({ kind: 'completed' })

    const diagnostics = spans.diagnostics(task.id)
    expect(diagnostics.spans.map((span) => span.kind)).toEqual(
      expect.arrayContaining(['task', 'turn', 'validation'])
    )
    expect(diagnostics.spans.every((span) => !JSON.stringify(span).includes(root))).toBe(true)
    expect(diagnostics.spans.find((span) => span.kind === 'validation')).toMatchObject({
      status: 'ok',
      attributes: { format: 'md', valid: true }
    })
    repository.close()
  })

  it('collects only declared outputs, deduplicates canonical paths, and preserves invalid declared artifacts',async()=>{
    const {root,repository,sessionStore,controller,task}=await fixture('请生成并交付 Markdown 报告文件。')
    await writeFile(join(root,'source.md'),'# Source material\n')
    await writeFile(join(root,'candidate.md'),'# Candidate report\n')
    await writeFile(join(root,'candidate.html'),'<!doctype html><html><body><h1>Candidate</h1></body></html>')
    const outputs=[
      {toolName:'ls',output:{path:'.',files:['source.md']}},
      {toolName:'read',output:{path:'source.md',text:'source text'}},
      {toolName:'read_delivery_sources',output:{generatedFiles:[{path:'source.md'}]}},
      {toolName:'mcp_lookup',output:{path:'source.md'}},
      {toolName:'propose_document',output:{path:'candidate.md',generatedFiles:[{relativePath:'candidate.md'},{absolutePath:join(root,'candidate.md')}]}},
      {toolName:'export_document',output:{path:'source.md',generatedFiles:[{relativePath:'candidate.html'}]}},
      {toolName:'write',output:{path:'missing.md'}}
    ]
    for(const [index,output]of outputs.entries())await sessionStore.appendItem(task.threadId,makeToolResultItem({id:`tool-output-${index}`,threadId:task.threadId,turnId:'turn_reliability',callId:`output-${index}`,...output}))
    await sessionStore.appendItem(task.threadId,makeAssistantTextItem({id:'artifact-answer',threadId:task.threadId,turnId:'turn_reliability',text:'已生成报告候选与 HTML 导出，缺失的声明文件单独保留验证结果。',status:'completed'}))
    controller.beginAttempt(task.threadId,'turn_reliability')
    const decision=await controller.assessCandidate(task.threadId,'turn_reliability')
    expect(decision.kind).toBe('completed')
    expect(decision.task.artifacts.map(artifact=>({path:artifact.relativePath,validation:artifact.validation}))).toEqual([
      {path:'candidate.md',validation:'valid'},{path:'candidate.html',validation:'valid'},{path:'missing.md',validation:'invalid'}
    ])
    expect(new Set(decision.task.artifacts.map(artifact=>artifact.id)).size).toBe(3)
    repository.close()
  })

  it('validates a workspace artifact whose absolute path is printed by a successful shell tool', async () => {
    const { root, repository, sessionStore, controller, task } = await fixture(
      '请创建并交付 result.txt 文件。'
    )
    const artifactPath = join(root, 'result.txt')
    await writeFile(artifactPath, 'verified shell deliverable', 'utf8')
    await sessionStore.appendItem(task.threadId, makeToolResultItem({
      id: 'item_shell_result',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      callId: 'call_shell',
      toolName: 'bash',
      toolKind: 'command_execution',
      output: {
        command: "printf 'verified shell deliverable' > result.txt",
        cwd: root,
        exit_code: 0,
        output: `verified shell deliverable\n${artifactPath}\n`,
        full_output_path: join(root, 'runtime', 'shell-output', 'bash_call.log')
      }
    }))
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_shell_assistant',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: 'TXT 文件已创建并验证。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({
        kind: 'completed',
        task: {
          status: 'completed',
          artifacts: [{ relativePath: 'result.txt', validation: 'valid' }]
        }
      })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(1)
    repository.close()
  })

  it('validates a recent relative artifact claimed after a successful shell tool', async () => {
    const { root, repository, sessionStore, controller, task } = await fixture(
      '请创建并交付 result.txt 文件。'
    )
    const startedAt = new Date(Date.now() - 1_000).toISOString()
    await writeFile(join(root, 'result.txt'), 'verified relative shell deliverable', 'utf8')
    const finishedAt = new Date(Date.now() + 1_000).toISOString()
    await sessionStore.appendItem(task.threadId, makeToolResultItem({
      id: 'item_relative_shell_result',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      callId: 'call_relative_shell',
      toolName: 'bash',
      toolKind: 'command_execution',
      output: {
        command: "printf 'verified relative shell deliverable' > result.txt",
        cwd: root,
        exit_code: 0,
        started_at: startedAt,
        finished_at: finishedAt,
        output: 'bytes: 35\nMATCH\n35\n',
        full_output_path: join(root, 'runtime', 'shell-output', 'bash_call.log')
      }
    }))
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_relative_shell_assistant',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: 'TXT 文件 result.txt 已创建并验证。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({
        kind: 'completed',
        task: {
          status: 'completed',
          artifacts: [{ relativePath: 'result.txt', validation: 'valid' }]
        }
      })
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(1)
    repository.close()
  })

  it('waits for provider configuration instead of retrying a blocked file task', async () => {
    const { repository, sessionStore, controller, task } = await fixture(
      '请使用 Document Illustrator 生成并插入一张章节头图文件。'
    )
    await sessionStore.appendItem(task.threadId, makeAssistantTextItem({
      id: 'item_provider_blocked',
      threadId: task.threadId,
      turnId: 'turn_reliability',
      text: '图片生成能力未配置，无法继续。请到设置 → 图片生成配置提供商、模型和凭据后重试。',
      status: 'completed'
    }))

    controller.beginAttempt(task.threadId, 'turn_reliability')
    await expect(controller.assessCandidate(task.threadId, 'turn_reliability'))
      .resolves.toMatchObject({
        kind: 'waiting_user',
        task: {
          status: 'waiting_user',
          attempts: 1,
          waitingReason: expect.stringContaining('配置可用的图片生成提供商')
        }
      })

    expect(repository.events(task.id).filter((event) => event.kind === 'attempt_retrying')).toHaveLength(0)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_waiting_user')).toHaveLength(1)
    expect(repository.events(task.id).filter((event) => event.kind === 'task_completed')).toHaveLength(0)
    expect(repository.latestCheckpoint(task.id)?.resumeSummary).toContain('配置可用的图片生成提供商')
    repository.close()
  })
})
