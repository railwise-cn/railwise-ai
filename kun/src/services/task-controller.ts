import { externalTaskIntent } from './external-task-capability.js'
import { verifiedEffectReceipts, externalOperationForTool, externalTarget } from './external-effect-evidence.js'
import { HostShellAuthorizationSchema, type ExecutionGrant } from '../contracts/permissions.js'
import { randomUUID as executionUUID } from 'node:crypto'
import type { ExecutionToken, InputDelivery, ProcessIdentity } from '../contracts/execution.js'
import { processIdentity, inspectProcess } from './process-identity.js'
import type { ToolCallLike, ToolHostResult } from '../ports/tool-host.js'
import { makeToolResultItem } from '../domain/item.js'
import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { TurnItem } from '../contracts/items.js'
import type { ThreadRecord } from '../contracts/threads.js'
import type { StartTurnRequest, Turn } from '../contracts/turns.js'
import type {
  TaskAcceptance,
  TaskArtifact,
  TaskCheckpoint,
  TaskRun,
  TaskRunStatus,
  TaskInput,
  OperationReceipt,
  RequiredEffect
} from '../contracts/tasks.js'
import { RequiredEffectSchema } from '../contracts/tasks.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import {
  completionIntentText,
  declaredFileOutputPaths,
  fileOutputPaths,
  looksLikeExternalCapabilityBlockedReply,
  looksLikeProgressOnlyReply,
  looksLikeWebAccessFailureReply,
  promptRequiresExternalEffect,
  promptRequiresFileDeliverable,
  requiredFileExtensionsForPrompt,
  toolCanProveExternalEffect,
  verifiedShellDeliverablePaths
} from '../loop/turn-completion-guard.js'
import { TaskLeaseLostError, TaskRunRepository, operationFingerprint, type TaskLeaseGuard } from './task-run-repository.js'
import { sanitizeTurnItemForPersistence } from '../security/tool-persistence-security.js'
import { validateArtifactFile } from './artifact-validator.js'
import type { RuntimeSpanService } from './runtime-span-service.js'
import { verifyTaskDelivery } from '../delivery/verification.js'

const DEFAULT_MAX_ATTEMPTS = 8
const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000
const TERMINAL = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled'])
const BARE_TASK_CONTINUATION_PATTERN = /^(?:(?:请)?继续(?:执行|完成|处理|推进|做|生成|制作|重试|下一步)?|继续(?:完成)?(?:尚未完成的)?(?:任务|工作)(?:，|,|\s)*(?:推进)?|重试|再试(?:一次|一下)?|重新尝试|(?:确认|同意(?:授权)?|允许|可以(?:了)?)(?:，|,|\s)*(?:开始(?:执行|处理|推进)?|继续(?:执行|完成|处理|推进|做|生成|制作|重试)?|执行|推进|启动)|go\s+ahead|continue|resume|retry|try\s+again|proceed)[。.!！\s]*$/i
const AUTOMATIC_RECOVERY_PATTERN = /^Continue the persisted task automatically after an application restart\./i

export type TaskCandidateDecision =
  | { kind: 'completed'; task: TaskRun }
  | { kind: 'continue'; task: TaskRun; reason: string }
  | { kind: 'waiting_user'; task: TaskRun; reason: string }
  | { kind: 'stalled'; task: TaskRun; reason: string }
  | { kind: 'failed'; task: TaskRun; reason: string }

export type TaskControllerDeps = {
  repository: TaskRunRepository
  threadStore: ThreadStore
  sessionStore: SessionStore
  nowIso: () => string
  ownerId?: string
  spans?: RuntimeSpanService
  completionGuard?: (input: { thread?: ThreadRecord; turn?: Turn; task: TaskRun }) => { reason: string; fingerprint: string; retryable?: boolean } | null
}

export type TaskWatchdogOptions = {
  intervalMs?: number
  leaseMs?: number
  initialRecoveryTaskIds?: ReadonlySet<string>
  onLeaseLost?: (task: TaskRun) => void
  onRecoveryNeeded?: (tasks: TaskRun[]) => void | Promise<void>
}

type SharedWorkBudgetState={aborts:Map<string,(reason:string)=>void>;active:Map<string,{rootTaskId:string;turnId:string}>;timers:Map<string,ReturnType<typeof setTimeout>>}
const sharedWorkBudgets=new WeakMap<TaskRunRepository,SharedWorkBudgetState>()

export class TaskController {
  private readonly repository: TaskRunRepository
  private readonly threadStore: ThreadStore
  private readonly sessionStore: SessionStore
  private readonly nowIso: () => string
  private readonly ownerId: string
  private readonly spans?: RuntimeSpanService
  private readonly completionGuard?: TaskControllerDeps['completionGuard']
  private readonly leases = new Map<string, { leaseRevision: number; turnId?: string }>()
  private readonly attemptTokens = new Map<string, ExecutionToken>()
  private readonly identity: ProcessIdentity = processIdentity() ?? { pid: process.pid, fingerprint: `unverified:${executionUUID()}` }
  private readonly fencedTasks = new Set<string>()
  private watchdogTimer?: ReturnType<typeof setInterval>
  private watchdogRunning = false
  private recoveryInFlight = new Set<string>()
  private watchdogOptions: TaskWatchdogOptions = {}
  private readonly executionAborts:SharedWorkBudgetState['aborts']
  private readonly activeWork:SharedWorkBudgetState['active']
  private readonly rootBudgetTimers:SharedWorkBudgetState['timers']

  constructor(deps: TaskControllerDeps) {
    this.repository = deps.repository
    let sharedBudget=sharedWorkBudgets.get(deps.repository)
    if(!sharedBudget){sharedBudget={aborts:new Map(),active:new Map(),timers:new Map()};sharedWorkBudgets.set(deps.repository,sharedBudget)}
    this.executionAborts=sharedBudget.aborts;this.activeWork=sharedBudget.active;this.rootBudgetTimers=sharedBudget.timers
    this.threadStore = deps.threadStore
    this.sessionStore = deps.sessionStore
    this.nowIso = deps.nowIso
    this.ownerId = deps.ownerId ?? `runtime-${process.pid}-${randomUUID()}`
    this.spans = deps.spans
    this.completionGuard = deps.completionGuard
  }

  ensureTask(input: {
    thread: ThreadRecord
    turnId: string
    request: StartTurnRequest
    engineeringExecution?: boolean
    engineeringPlanId?: string
    continuationTaskId?: string
  }): TaskRun {
    const active = this.repository.findActiveByThread(input.thread.id)
    const now = this.nowIso()
    const consultation = input.thread.domain === 'engineering' && !input.engineeringExecution
    if (input.continuationTaskId && active?.id !== input.continuationTaskId) {
      throw Object.assign(new Error('the task to resume is no longer active for this thread'), { code: 'invalid_state' })
    }
    const intent = input.request.taskIntent ?? 'auto'
    if (active && intent === 'status') return active
    if (active && (input.continuationTaskId || intent === 'supplement' || (!consultation && intent !== 'new' && shouldContinueActiveTask(input.request.prompt)))) {
      return this.repository.update(active.id, active.revision, (current) => ({
        ...current,
        activeTurnId: input.turnId,
        model: input.request.model ?? current.model,
        providerId: input.request.providerId ?? current.providerId,
        reasoningEffort: input.request.reasoningEffort ?? current.reasoningEffort,
        engineeringPlanId: input.engineeringPlanId ?? current.engineeringPlanId,
        updatedAt: now
      }), {
        key: `turn-attached:${input.turnId}`,
        kind: 'turn_attached',
        payload: { turnId: input.turnId },
        createdAt: now
      })
    }
    // A new message never implicitly revokes or cancels another task.
    const priorTurn = active?.activeTurnId ? input.thread.turns.find(turn=>turn.id===active.activeTurnId) : undefined
    const legacyUnexecutedReply = active?.status === 'queued' && active.attempts === 0 && priorTurn?.status === 'completed'
    if (active && intent !== 'new' && !consultation && !legacyUnexecutedReply) throw Object.assign(new Error('active task requires explicit supplement or new-task routing'), { code: 'task_intent_required' })

    return this.createTask(input)
  }

  /** Save a blocked goal without allocating a fictitious Turn or execution attempt. */
  createWaitingTask(input: { id: string; thread: ThreadRecord; request: StartTurnRequest; reason: string }): TaskRun {
    const existing = this.repository.get(input.id)
    if (existing) return existing
    return this.repository.transact(() => {
      const task = this.createTask(input)
      return this.repository.update(task.id, task.revision, current => ({
        ...current, status: 'waiting_user', waitingReason: input.reason,
        nodes: current.nodes.map(node => ({ ...node, status: 'blocked' as const }))
      }), { key: 'capability-blocked', kind: 'capability_required', payload: { reason: input.reason } })
    })
  }

  private createTask(input: { id?: string; thread: ThreadRecord; turnId?: string; request: StartTurnRequest; engineeringExecution?: boolean; engineeringPlanId?: string }): TaskRun {
    const now = this.nowIso()
    const consultation = input.thread.domain === 'engineering' && !input.engineeringExecution
    const taskGoal = input.request.displayText?.trim() || input.request.prompt
    const acceptance = acceptanceForPrompt(consultation ? 'Answer the Survey question or propose a plan for review.' : taskGoal)
    const id = input.id ?? `task_${randomUUID()}`
    const nodes = nodeBlueprint(id, acceptance)
    const profile = input.thread.agentProfile
    const selectedModel = input.request.model ?? profile?.model ?? input.thread.model
    const maxCostUsd = minimumDefinedPositive(profile?.budget.maxCostUsd, input.thread.costBudgetUsd)
    const created = this.repository.create({
      id,
      threadId: input.thread.id,
      originThreadId: input.request.taskOriginThreadId,
      visibility: input.request.taskVisibility ?? (consultation ? 'chat' : 'task'),
      activeTurnId: input.turnId,
      childTaskIds: [],
      workspaceRoot: input.thread.workspace,
      goal: completionIntentText(taskGoal) || taskGoal,
      status: 'queued',
      acceptance,
      agentId: input.thread.agentId,
      model: selectedModel,
      providerId: input.request.providerId,
      engineeringPlanId: input.engineeringPlanId,
      reasoningEffort: input.request.reasoningEffort,
      authority: {
        source: 'user', workspaceRoot: input.thread.workspace,
        toolAllowlist: profile?.toolAllowlist, mcpAllowlist: profile?.mcpAllowlist,
        approvalPolicy: input.request.approvalPolicy ?? input.thread.approvalPolicy,
        sandboxMode: input.request.sandboxMode ?? input.thread.sandboxMode,
        externalTargets: [], grantedAt: now
      },
      executionMs: 0,
      budget: {
        maxAttempts: profile?.budget.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        maxDurationMs: profile?.budget.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
        ...(input.request.taskOriginThreadId || input.request.taskIntent==='new' ? { version: 2 as const, maxExecutionMs: profile?.budget.maxDurationMs ?? DEFAULT_MAX_DURATION_MS } : {}),
        ...(maxCostUsd !== undefined ? { maxCostUsd } : {})
      },
      attempts: 0,
      replans: 0,
      noProgressCount: 0,
      nodes,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      revision: 0
    })
    this.repository.execution.ensureSession(created, now)
    this.spans?.start({
      id: taskSpanId(created.id),
      taskId: created.id,
      kind: 'task',
      name: 'task-run',
      retryCount: 0,
      model: created.model,
      attributes: {
        acceptance: created.acceptance.kind,
        ...(created.agentId ? { agentId: created.agentId } : {})
      }
    })
    return created
  }

  continuationSelection(thread: ThreadRecord, request: StartTurnRequest, engineeringExecution?: boolean, continuationTaskId?: string): Pick<StartTurnRequest, 'model' | 'providerId' | 'reasoningEffort'> & { engineeringPlanId?: string } {
    if (request.taskIntent === 'new' || request.taskVisibility === 'chat') return {}
    if (!continuationTaskId && thread.domain === 'engineering' && !engineeringExecution) return {}
    const task = this.repository.findActiveByThread(thread.id)
    if (continuationTaskId && task?.id !== continuationTaskId) throw Object.assign(new Error('the task to resume is no longer active for this thread'), { code: 'invalid_state' })
    return task ? { model: task.model, providerId: task.providerId, reasoningEffort: task.reasoningEffort, engineeringPlanId: task.engineeringPlanId } : {}
  }

  activeTask(threadId: string): TaskRun | null {
    return this.repository.findActiveByThread(threadId)
  }

  getTask(taskId: string): TaskRun | null { return this.repository.get(taskId) }

  /** Persist a finite user-reviewed effect set before any mutating dispatch. */
  confirmEffectScope(turnId: string, expectedRevision: number, idempotencyKey: string, effects: RequiredEffect[]): TaskRun {
    const token = this.attemptTokens.get(turnId)
    if (!token) throw Object.assign(new Error('No active task execution for effect scope confirmation.'), { code: 'effect_scope_required' })
    if (!idempotencyKey.trim() || effects.length < 1 || effects.length > 8) throw Object.assign(new Error('Review between one and eight exact external actions.'), { code: 'effect_scope_invalid' })
    const requiredEffects = effects.map(effect => RequiredEffectSchema.parse(effect))
    const keys = requiredEffects.map(effect => JSON.stringify([effect.provider, effect.operation, effect.target]))
    if (new Set(keys).size !== keys.length) throw Object.assign(new Error('The reviewed effect set contains duplicate actions.'), { code: 'effect_scope_invalid' })
    return this.repository.transact(() => {
      this.assertToken(token)
      const task = this.repository.get(token.taskId)!
      const acceptance = task.acceptance.effect
      if (task.acceptance.kind !== 'effect' || !acceptance || task.authority?.revokedAt || requiredEffects.some(effect => effect.provider !== acceptance.provider || !['detail', 'approve', 'reject', 'complete', 'transfer'].includes(effect.operation) || (acceptance.operation !== 'process' && acceptance.operation !== 'connect' && effect.operation !== acceptance.operation))) {
        throw Object.assign(new Error('Every reviewed action must belong to this task provider.'), { code: 'effect_scope_conflict' })
      }
      const key = `effect-scope:${idempotencyKey}`
      const request = { turnId, expectedRevision, requiredEffects }
      const existing = this.repository.operation(task.id, key)
      if (existing) {
        if (existing.fingerprint !== operationFingerprint(request)) throw Object.assign(new Error('Effect scope key is bound to a different request.'), { code: 'idempotency_conflict' })
        if (existing.status === 'succeeded') return task
        throw Object.assign(new Error('Effect scope confirmation is incomplete; inspect its receipt.'), { code: 'outcome_unknown' })
      }
      if ((acceptance.scopeRevision ?? 0) !== expectedRevision) throw Object.assign(new Error('Effect scope changed while reviewing external actions; review it again.'), { code: 'stale_request' })
      if (acceptance.requiredEffects?.length || acceptance.target) throw Object.assign(new Error('The task already has a fixed effect scope; it cannot be replaced or reduced.'), { code: 'effect_scope_conflict' })
      if (this.repository.operations(task.id, 'tool').some(receipt => ['approve', 'reject', 'complete', 'transfer'].includes(String(receipt.request?.operation)))) {
        throw Object.assign(new Error('Effect scope must be established before the first external mutation.'), { code: 'effect_scope_conflict' })
      }
      const now = this.nowIso()
      const prepared = this.repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'effect_scope', request, nowIso: now })
      const updated = this.updateExecution(task.id, task.revision, current => ({ ...current, acceptance: { ...current.acceptance, effect: { ...acceptance, requiredEffects, scopeConfirmationId: prepared.receipt.id, scopeRevision: expectedRevision + 1 } }, updatedAt: now }), {
        key: `effect-scope-confirmed:${prepared.receipt.id}`, kind: 'effect_scope_confirmed', payload: { confirmationId: prepared.receipt.id, requiredEffects }, createdAt: now
      })
      this.repository.finishOperation(task.id, key, { status: 'succeeded', result: { confirmationId: prepared.receipt.id, requiredEffects, taskRevision: updated.revision } }, now)
      return updated
    })
  }

  startWatchdog(options: TaskWatchdogOptions = {}): void {
    this.stopWatchdog()
    this.watchdogOptions = options
    for (const taskId of options.initialRecoveryTaskIds ?? []) this.recoveryInFlight.add(taskId)
    const intervalMs = Math.max(1_000, Math.trunc(options.intervalMs ?? 20_000))
    this.watchdogTimer = setInterval(() => { void this.runWatchdogTick() }, intervalMs)
    this.watchdogTimer.unref?.()
    void this.runWatchdogTick()
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = undefined
    this.watchdogOptions = {}
    this.recoveryInFlight.clear()
  }

  beginAttempt(threadId: string, turnId: string): TaskRun | null {
    const task = this.repository.findActiveByThread(threadId)
    if (!task || task.activeTurnId !== turnId || TERMINAL.has(task.status) || task.status === 'paused') return task
    const now = this.nowIso()
    const leaseMs = Math.max(1_000, Math.trunc(this.watchdogOptions.leaseMs ?? 60_000))
    const expiresAt = new Date(Date.parse(now) + leaseMs).toISOString()
    const lease = this.repository.acquireLease(task.id, this.ownerId, now, expiresAt)
    if (!lease) {
      throw Object.assign(new Error('task is already running in another runtime'), {
        code: 'task_lease_conflict'
      })
    }
    this.fencedTasks.add(task.id)
    this.leases.set(task.id, { leaseRevision: lease.revision, turnId })
    const session = this.repository.execution.ensureSession(task, now)
    const token: ExecutionToken = { taskId: task.id, sessionId: session.id, executionId: `attempt_${executionUUID()}`, turnId, ownerId: this.ownerId, leaseRevision: lease.revision, process: this.identity }
    const previousToken = this.attemptTokens.get(turnId)
    if (previousToken) this.repository.execution.finishAttempt(previousToken.executionId, 'completed', now)
    this.attemptTokens.set(turnId, token)
    this.repository.execution.beginAttempt(token, now)
    this.recoveryInFlight.delete(task.id)
    let started: TaskRun
    try {
      started = this.repository.update(task.id, task.revision, (current) => ({
        ...current,
        status: 'running',
        executionStartedAt: current.executionStartedAt ?? now,
        attempts: current.attempts + 1,
        nodes: current.nodes.map((node) =>
          node.status === 'pending' || node.status === 'failed'
            ? { ...node, status: 'running', attempt: node.attempt + 1, startedAt: node.startedAt ?? now, revision: node.revision + 1 }
            : node
        ),
        updatedAt: now
      }), {
        key: `attempt-started:${task.attempts + 1}`,
        kind: 'attempt_started',
        payload: { turnId, attempt: task.attempts + 1 },
        createdAt: now
      }, this.leaseGuard(task.id))
    } catch (error) {
      this.leases.delete(task.id)
      this.fencedTasks.delete(task.id)
      this.repository.releaseLease(task.id, this.ownerId, lease.revision)
      throw error
    }
    this.spans?.start({
      id: turnSpanId(started.id, turnId, started.attempts),
      taskId: started.id,
      turnId,
      kind: 'turn',
      name: 'task-attempt',
      retryCount: Math.max(0, started.attempts - 1),
      model: started.model,
      attributes: {
        attempt: started.attempts,
        ...(started.agentId ? { agentId: started.agentId } : {})
      }
    })
    return started
  }

  async assessCandidate(threadId: string, turnId: string): Promise<TaskCandidateDecision> {
    const task = this.repository.findActiveByThread(threadId)
    if (!task) {
      throw Object.assign(new Error(`active task not found for thread ${threadId}`), { code: 'not_found' })
    }
    if (task.status === 'paused') return { kind: 'waiting_user', task, reason: task.waitingReason ?? '任务已暂停。' }
    const hostShell = this.hostShellState(task)
    const unsettled = [...this.repository.unsettledOperations(task.id).filter(operation => operation.kind === 'tool'), ...hostShell.unknown]
    if (unsettled.length) return this.stallUnknown(task,unsettled.map(operation=>operation.id))
    const [thread, items] = await Promise.all([
      this.threadStore.get(threadId),
      this.sessionStore.loadItems(threadId)
    ])
    const capturedToken = this.attemptTokens.get(turnId)
    if (capturedToken) this.assertToken(capturedToken)
    if (hostShell.pending.length) return this.retry(task,'已授权命令仍有待核验回执，请使用 host_shell_session 只读轮询原命令，不能重新执行或仅用文字交付。',`host-shell-pending:${hostShell.pending.map(operation => operation.id).join(',')}`,turnId)
    if (this.repository.listShellSessions(task.id).some(session => ['running','starting','outcome_unknown'].includes(session.status))) return this.retry(task,'命令进程尚未确认完成，请轮询已有命令并核实其结果后交付。',`shell-pending:${task.attempts}`,turnId)
    const turn = thread?.turns.find((candidate) => candidate.id === turnId)
    const turnItems = items.filter((item) => item.turnId === turnId)
    if (hostShell.lastFailed) return this.waitForUser(task,'最后一次已授权命令执行失败、被停止或尚无成功退出证据。请先处理失败原因，再明确授权新的检查命令；文字说明不能代替执行成功。',latestAssistantText(turn,turnItems),`host-shell-failed:${hostShell.lastFailed.id}`,turnId)
    const blocked = this.completionGuard?.({ thread: thread ?? undefined, turn, task })
    if (blocked?.retryable === false) return this.waitForUser(task, blocked.reason, latestAssistantText(turn, turnItems), blocked.fingerprint, turnId)
    const pendingReason = pendingWorkReason(turnItems)
    if (pendingReason) return this.retry(task, pendingReason, fingerprint(turnItems), turnId)
    if (blocked) return this.retry(task, blocked.reason, blocked.fingerprint, turnId)

    const finalResponse = latestAssistantText(turn, turnItems)
    if (task.acceptance.requireFinalResponse && !finalResponse.trim()) {
      return this.retry(task, '模型只产生了思考或工具过程，没有最终回复。', fingerprint(turnItems), turnId)
    }
    if (
      task.acceptance.kind === 'files' &&
      looksLikeExternalCapabilityBlockedReply(finalResponse)
    ) {
      return this.waitForUser(
        task,
        '继续前需要在设置中配置可用的图片生成提供商、模型和凭据。',
        finalResponse,
        fingerprint(turnItems),
        turnId
      )
    }
    if (looksLikeProgressOnlyReply(finalResponse)) {
      return this.retry(task, '最终回复仍是进度说明，没有交付具体结果。', fingerprint(turnItems), turnId)
    }
    if (looksLikeWebAccessFailureReply(finalResponse)) {
      return this.finish(
        task,
        'failed',
        'web_access_exhausted: 在线搜索连续失败，无法核实当前资讯。'
      )
    }
    if (task.templateId) {
      const delivery = verifyTaskDelivery(this.repository,task)
      if (!delivery.complete) return this.waitForUser(task,delivery.reasons.join('；'),finalResponse,`delivery:${task.revision}`,turnId)
    }

    if (task.acceptance.kind === 'effect') {
      const evidence = this.verifiedTaskEffects(task)
      const succeeded = evidence.length > 0
      if (!succeeded) {
        return this.waitForUser(
          task,
          '外部操作尚无完整、已确认的目标集合及逐项验证回执，任务不能标记完成。请先明确要处理的具体待办，再核验每项结果。',
          finalResponse,
          `effect-receipt:${task.revision}`,
          turnId
        )
      }
    }

    const artifacts = task.acceptance.kind === 'files'
      ? await this.collectArtifacts(task, turnItems, turnId)
      : []
    if (task.acceptance.kind === 'files') {
      const validArtifacts = artifacts.filter((artifact) => artifact.validation === 'valid')
      const minimum = task.acceptance.minimumArtifacts ?? 1
      if (validArtifacts.length < minimum) {
        const required = task.acceptance.requiredFormats?.map((value) => `.${value}`).join(' / ')
        return this.retry(
          { ...task, artifacts },
          required
            ? `尚未生成并验证用户要求的 ${required} 成果文件。`
            : '尚未生成并验证用户要求的成果文件。',
          fingerprint(turnItems, artifacts),
          turnId
        )
      }
    }

    const now = this.nowIso()
    const completed = this.updateExecution(task.id, task.revision, (current) => ({
      ...current,
      status: 'completed',
      waitingReason: undefined,
      stalledReason: undefined,
      finalResponse,
      ...(task.acceptance.kind==='effect'?{resultEvidence:this.verifiedTaskEffects(task)}:{}),
      artifacts,
      noProgressCount: 0,
      nodes: current.nodes.map((node) => ({
        ...node,
        status: 'completed',
        finishedAt: now,
        evidence: [...new Set([...node.evidence, ...(artifacts.map((artifact) => artifact.relativePath))])],
        revision: node.revision + 1
      })),
      updatedAt: now,
      finishedAt: now
    }), {
      key: `task-terminal:completed`,
      kind: 'task_completed',
      payload: { turnId, artifactCount: artifacts.length },
      createdAt: now
    })
    this.releaseExecutionLease(task.id)
    this.spans?.finishTurn(task.id, turnId, {
      status: 'ok',
      attributes: { artifactCount: artifacts.length }
    })
    this.spans?.finish(taskSpanId(task.id), {
      status: 'ok',
      attributes: { attempts: completed.attempts, artifactCount: artifacts.length }
    })
    return { kind: 'completed', task: completed }
  }

  /** A terminal execution block also wins when the explanatory model call fails. */
  async assessNonRetryableBlock(threadId: string, turnId: string): Promise<TaskCandidateDecision | null> {
    const task = this.repository.findActiveByThread(threadId)
    if (!task || task.activeTurnId !== turnId) return null
    const thread = await this.threadStore.get(threadId)
    const turn = thread?.turns.find(candidate => candidate.id === turnId)
    const blocked = this.completionGuard?.({ thread: thread ?? undefined, turn, task })
    if (blocked?.retryable !== false) return null
    const items = (await this.sessionStore.loadItems(threadId)).filter(item => item.turnId === turnId)
    return this.waitForUser(task, blocked.reason, latestAssistantText(turn, items), blocked.fingerprint, turnId)
  }

  recordAttemptFailure(threadId: string, turnId: string, code: string, message: string): TaskCandidateDecision | null {
    const task = this.repository.findActiveByThread(threadId)
    if (!task || task.activeTurnId !== turnId) return null
    if (task.status === 'paused') return { kind: 'waiting_user', task, reason: task.waitingReason ?? '任务已暂停。' }
    const hostShell = this.hostShellState(task)
    const unsettled = [...this.repository.unsettledOperations(task.id).filter(operation => operation.kind === 'tool'), ...hostShell.unknown]
    if (unsettled.length) return this.stallUnknown(task,unsettled.map(operation=>operation.id))
    if (code === 'operation_cancelled' || code === 'turn_total_timeout') {
      return this.finish(task, code === 'operation_cancelled' ? 'cancelled' : 'failed', message)
    }
    if (code === 'web_access_exhausted' || code === 'max_tokens') {
      return this.finish(task, 'failed', message)
    }
    if (hostShell.lastFailed) return this.waitForUser(task,'最后一次已授权命令没有执行成功。请先处理失败原因，再明确授权新的检查命令。', '', `host-shell-failed:${hostShell.lastFailed.id}`,turnId)
    if (hostShell.pending.length) return this.retry(task,'模型请求中断，但原命令仍有待核验回执。请只读轮询已有命令，不能重新执行。',`host-shell-pending:${hostShell.pending.map(operation => operation.id).join(',')}`,turnId)
    return this.retry(
      task,
      message,
      `${code}:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`,
      turnId
    )
  }

  /** A prose response can never settle a command. Earlier known failures remain history,
   * while an explicitly approved later command with real success evidence can resolve them. */
  private hostShellState(task: TaskRun): { unknown: OperationReceipt[]; pending: OperationReceipt[]; knownSessionIds: Set<string>; lastFailed?: OperationReceipt } {
    const operations = this.repository.operations(task.id,'host_shell')
    const unknown: OperationReceipt[] = [], pending: OperationReceipt[] = [], knownSessionIds = new Set<string>()
    for (const operation of operations) {
      if (operation.status === 'outcome_unknown' || operation.status === 'prepared') { unknown.push(operation); continue }
      if (operation.status !== 'running') continue
      const result = operation.result as { authorization?: unknown; shell?: { output?: { session_id?: unknown } } } | undefined
      const authority = HostShellAuthorizationSchema.safeParse(result?.authorization)
      const sessionId = result?.shell?.output?.session_id
      const session = typeof sessionId === 'string' ? this.repository.getShellSession(sessionId) : null
      if (!authority.success || !session || authority.data.taskId !== task.id || authority.data.threadId !== task.threadId
        || session.taskId !== task.id || session.executionId !== authority.data.executionId || session.ownerId !== authority.data.ownerId
        || session.workspaceRoot !== authority.data.workspaceRoot || !session.pid || !session.processFingerprint
        || ['outcome_unknown','interrupted'].includes(session.status)) {
        unknown.push(operation)
        continue
      }
      // A known process can be verified read-only in a later attempt. Its running
      // receipt still prevents completion even if the process has since exited.
      pending.push(operation)
      knownSessionIds.add(session.id)
    }
    const last = operations.at(-1)
    const result = last?.result as { shell?: { isError?: boolean; output?: { status?: string; exit_code?: number } } } | undefined
    const success = last?.status === 'succeeded' && result?.shell?.isError !== true && result?.shell?.output?.status === 'completed' && result.shell.output.exit_code === 0
    const lastFailed = last && (last.status === 'failed' || last.status === 'succeeded' && !success) ? last : undefined
    return { unknown, pending, knownSessionIds, lastFailed }
  }

  private stallUnknown(task: TaskRun, operationIds: string[]): Extract<TaskCandidateDecision,{kind:'stalled'}> {
    const reason = '操作已派发，但结果尚未核实。请先检查原执行回执，系统不会重复派发。'
    const now=this.nowIso()
    const next=this.updateExecution(task.id,task.revision,current=>({...current,status:'stalled',waitingReason:undefined,stalledReason:reason,updatedAt:now}),{key:`unknown:${task.revision}`,kind:'task_stalled',payload:{operationIds},createdAt:now})
    this.saveCheckpoint(next,reason,`unknown:${task.revision}`)
    this.repository.putAttention({id:`unknown_${task.id}`,ownerKind:'task',ownerId:task.id,taskId:task.id,threadId:task.originThreadId ?? task.threadId,kind:'blocked',title:'核实上次操作结果',message:reason,status:'pending',revision:0,createdAt:now,updatedAt:now,payload:{operationIds}})
    this.releaseExecutionLease(task.id)
    return {kind:'stalled',task:next,reason}
  }

  cancel(threadId: string, reason: string): TaskRun | null {
    const task = this.repository.findActiveByThread(threadId)
    if (!task) return null
    if (task.status === 'paused' || reason === 'application_exit') return task
    return this.finish(task, 'cancelled', reason).task
  }

  pauseTask(taskId: string, expectedRevision: number, reason = '用户暂停了任务。'): TaskRun {
    const task = this.repository.get(taskId)
    if (!task) throw Object.assign(new Error('task not found'), { code: 'not_found' })
    if (TERMINAL.has(task.status)) throw Object.assign(new Error('terminal task cannot pause'), { code: 'invalid_state' })
    const now = this.nowIso()
    const next = this.updateExecution(taskId, expectedRevision, current => ({ ...current, status: 'paused', waitingReason: reason, executionMs: (current.executionMs ?? 0) + activeExecutionMs(current, now), executionStartedAt: undefined, updatedAt: now }), { key: `paused:${expectedRevision}`, kind: 'task_paused', payload: { reason }, createdAt: now })
    this.saveCheckpoint(next, reason, `paused:${expectedRevision}`)
    this.releaseExecutionLease(taskId)
    return next
  }

  tokenForTurn(turnId: string): ExecutionToken | undefined { return this.attemptTokens.get(turnId) }
  registerExecutionAbort(turnId:string,abort:(reason:string)=>void):()=>void {
    this.executionAborts.set(turnId,abort)
    return ()=>{if(this.executionAborts.get(turnId)===abort)this.executionAborts.delete(turnId)}
  }

  endRun(turnId: string): void {
    const token = this.attemptTokens.get(turnId)
    if (!token) return
    // The in-process worker has actually returned; this is stronger evidence
    // than a lease timeout or a stale lock file.
    this.repository.execution.finishAttempt(token.executionId, 'cancelled', this.nowIso())
    this.repository.releaseLease(token.taskId, token.ownerId, token.leaseRevision)
    this.attemptTokens.delete(turnId)
    this.leases.delete(token.taskId)
    this.fencedTasks.delete(token.taskId)
  }

  assertToken(token: ExecutionToken): void {
    const attempt = this.repository.execution.attempt(token.executionId)
    const task = this.repository.get(token.taskId)
    if (!attempt || attempt.status !== 'running' || attempt.turnId !== token.turnId || !task || task.activeTurnId !== token.turnId || task.status === 'paused' || TERMINAL.has(task.status)
      || !this.repository.hasLease({ ownerId: token.ownerId, leaseRevision: token.leaseRevision, nowIso: this.nowIso() }, token.taskId)) throw new TaskLeaseLostError(token.taskId)
  }

  pendingDeliveries(threadId: string, turnId: string): Array<{ delivery: InputDelivery; input: TaskInput }> {
    const token = this.attemptTokens.get(turnId)
    if (!token) return []
    this.assertToken(token)
    const task = this.repository.get(token.taskId)!
    for (const input of this.repository.inputs(task.id, true)) this.repository.execution.enqueue(input.id, task.id, token.sessionId)
    const inputs = new Map(this.repository.inputs(task.id, true).map(input => [input.id, input]))
    return this.repository.execution.pending(token.sessionId).flatMap(delivery => inputs.has(delivery.inputId) ? [{ delivery, input: inputs.get(delivery.inputId)! }] : [])
  }

  markInputsDelivered(turnId:string,deliveries:InputDelivery[],sessionItemId:string,sessionHash:string):void {
    const token=this.attemptTokens.get(turnId)
    if(!token||!deliveries.length)return
    this.repository.transact(()=>{
      this.assertToken(token)
      const now=this.nowIso()
      for(const delivery of deliveries) {
        if(delivery.sessionId!==token.sessionId||delivery.taskId!==token.taskId)throw new TaskLeaseLostError(token.taskId)
        this.repository.execution.delivered(delivery,sessionItemId,sessionHash,now)
        this.repository.markInputDelivered(delivery.inputId,now)
      }
    })
  }

  acknowledgeInputs(turnId: string, deliveries: InputDelivery[], sessionItemId: string, sessionHash: string): void {
    const token = this.attemptTokens.get(turnId)
    if (!token || !deliveries.length) return
    this.repository.transact(() => {
      this.assertToken(token)
      const pending=new Map(this.repository.execution.pending(token.sessionId).map(delivery=>[delivery.id,delivery]))
      for(const delivery of deliveries) {
        const stored=pending.get(delivery.id)
        if(!stored||stored.status!=='delivered'||stored.sessionItemId!==sessionItemId||stored.sessionHash!==sessionHash)throw new Error('input transcript proof does not match checkpoint acknowledgement')
      }
      const task = this.repository.get(token.taskId)!
      const now = this.nowIso()
      const checkpoint = this.repository.saveCheckpoint({
        id: `checkpoint_inputs_${token.executionId}_${deliveries.at(-1)!.sequence}`, taskId: task.id,
        executionId: token.executionId, consumedInputIds: deliveries.map(item => item.inputId), sessionItemId, sessionHash,
        completedNodeIds: task.nodes.filter(node => node.status === 'completed').map(node => node.id),
        pendingNodeIds: task.nodes.filter(node => node.status !== 'completed').map(node => node.id), artifactIds: task.artifacts.map(item => item.id),
        eventSequence: this.repository.events(task.id).at(-1)?.sequence ?? 0,
        resumeSummary: 'Persisted user inputs are included in the execution history.', createdAt: now, revision: task.revision
      })
      for (const delivery of deliveries) { this.repository.execution.acknowledge(delivery, checkpoint.id, now); this.repository.consumeInput(delivery.inputId, now) }
    })
  }

  beginToolOperation(turnId: string, call: ToolCallLike, executionGrant?: ExecutionGrant): { key: string; token: ExecutionToken; prior?: ToolHostResult } | undefined {
    const token = this.attemptTokens.get(turnId)
    if (!token) return undefined
    return this.repository.transact(() => {
      this.assertToken(token)
      const key = `tool:${turnId}:${call.callId}`
      const effect = externalOperationForTool(call.toolName)
      const target = externalTarget(call.arguments, call.toolName)
      if (effect && ['approve', 'reject', 'complete', 'send', 'transfer'].includes(effect.operation)) {
        const task = this.repository.get(token.taskId)!
        this.assertExternalTarget(turnId, effect.provider, effect.operation, target ?? '')
        // Tool call IDs change when a task resumes. The finite reviewed action
        // is still the same action; never repeat it just because a model emits
        // a new call ID or changes the arguments after a successful dispatch.
        const prior = this.repository.operations(task.id, 'tool').find(receipt => receipt.request?.provider === effect.provider && receipt.request?.operation === effect.operation && receipt.request?.target === target)
        if (prior) {
          if (prior.request?.toolName !== call.toolName || prior.request?.argumentsHash !== operationFingerprint(call.arguments)) {
            throw Object.assign(new Error('This reviewed target already has a different operation request. Inspect its receipt before changing the action.'), { code: 'idempotency_conflict' })
          }
          const resolution = this.repository.verifiedOperationResolution(prior)
          if (resolution) return { key: prior.idempotencyKey, token, prior: { approved: true, item: makeToolResultForVerifiedResolution(task, turnId, call, resolution.evidence) } }
          if (prior.status === 'succeeded' && prior.result) {
            const replay = prior.result as ToolHostResult
            return { key: prior.idempotencyKey, token, prior: { ...replay, item: { ...replay.item, id: `item_${call.callId}`, callId: call.callId, turnId, threadId: task.threadId } as ToolHostResult['item'] } }
          }
          throw Object.assign(new Error('The reviewed action has already been dispatched. Verify its outcome before another attempt.'), { code: prior.status === 'failed' ? 'operation_failed' : 'outcome_unknown' })
        }
      }
      // Arguments can contain credentials or external message bodies. Only the
      // canonical digest belongs in the durable operation ledger.
      const scope = effect ? this.repository.get(token.taskId)?.acceptance.effect : undefined
      const verificationLocator = effect ? externalVerificationLocator(call.arguments) : undefined
      const prepared = this.repository.beginOperation({ ownerId: token.taskId, idempotencyKey: key, kind: 'tool', request: { toolName: call.toolName, providerId: call.providerId, ...effect, target, turnId, argumentsHash: operationFingerprint(call.arguments), ...(effect ? { approvalRequestHash: createHash('sha256').update(JSON.stringify(call.arguments)).digest('hex') } : {}), ...(verificationLocator ? { verificationLocator } : {}), ...(executionGrant ? { executionGrant } : {}), ...(scope?.scopeConfirmationId ? { scopeConfirmationId: scope.scopeConfirmationId, scopeRevision: scope.scopeRevision } : {}) }, nowIso: this.nowIso() })
      if (!prepared.created) {
        if (prepared.receipt.status === 'succeeded' && prepared.receipt.result) return { key, token, prior: prepared.receipt.result as ToolHostResult }
        if (['running', 'outcome_unknown'].includes(prepared.receipt.status)) throw Object.assign(new Error('Previous tool outcome must be verified before another dispatch.'), { code: 'outcome_unknown' })
        if (prepared.receipt.status === 'failed') throw Object.assign(new Error('Failed tool operation requires a new explicit attempt.'), { code: 'operation_failed' })
      }
      this.repository.finishOperation(token.taskId, key, { status: 'running' }, this.nowIso())
      return { key, token }
    })
  }

  recordToolApproval(token: ExecutionToken, key: string, approval: { toolName: string; requestHash: string }): void {
    this.repository.transact(() => {
      this.assertToken(token)
      const receipt = this.repository.operation(token.taskId, key)
      if (!receipt?.request?.provider) return
      if (!receipt || receipt.request?.toolName !== approval.toolName || !/^[a-f0-9]{64}$/.test(approval.requestHash)) throw Object.assign(new Error('Approval does not match the dispatched operation.'), { code: 'execution_grant_scope' })
      if (receipt.request.approvalRequestHash !== approval.requestHash) throw Object.assign(new Error('The external request changed before approval. Submit a new typed request.'), { code: 'idempotency_conflict' })
      this.repository.finishOperation(token.taskId, key, { status: receipt.status, dispatchApproval: { ...approval, approvedAt: this.nowIso() } }, this.nowIso())
    })
  }

  assertExternalTarget(turnId: string, provider: string, operation: string, target: string): void {
    const token = this.attemptTokens.get(turnId)
    if (!token) throw Object.assign(new Error('No current task authority for this external action.'), { code: 'effect_scope_required' })
    this.assertToken(token)
    const task = this.repository.get(token.taskId)!
    const accepted = task.acceptance.effect
    const required = accepted?.requiredEffects ?? (accepted?.target ? [{ provider: accepted.provider, operation: accepted.operation, target: accepted.target }] : [])
    if (task.authority?.revokedAt || task.acceptance.kind !== 'effect' || !required.some(item => item.provider === provider && item.operation === operation && item.target === target)) {
      throw Object.assign(new Error('Review and confirm the complete finite external action set with confirm_external_effect_scope before this mutation.'), { code: 'effect_scope_required' })
    }
  }

  private verifiedTaskEffects(task: TaskRun) {
    const session = this.repository.execution.sessionForTask(task.id)
    const trustedTurns = new Set(this.repository.execution.attempts(task.id)
      .filter(attempt => attempt.sessionId === session?.id && attempt.taskId === task.id)
      .map(attempt => attempt.turnId))
    return verifiedEffectReceipts(task, this.repository.operations(task.id), trustedTurns)
  }

  finishToolOperation(token: ExecutionToken, key: string, result?: ToolHostResult): void {
    // An already-dispatched result is immutable evidence even after lease loss.
    const prior = this.repository.operation(token.taskId, key)
    if (!prior || prior.status === 'succeeded') return
    this.repository.finishOperation(token.taskId, key, { status: !result ? 'outcome_unknown' : result.item.kind==='tool_result' && result.item.isError ? ((result.item.output as {status?:string}|undefined)?.status==='outcome_unknown'?'outcome_unknown':'failed') : 'succeeded', ...(result ? { result: { ...result, item: sanitizeTurnItemForPersistence(result.item) } } : {}) }, this.nowIso())
  }

  /** Attach trusted readback evidence without overwriting the original unknown dispatch or resuming execution. */
  recordOperationVerification(taskId: string, expectedRevision: number, receiptId: string, verificationKey: string, evidence: import('../contracts/harness.js').ResultEvidence): void {
    this.repository.transact(() => {
      const task = this.repository.get(taskId)
      const receipt = this.repository.operations(taskId, 'tool').find(item => item.id === receiptId)
      const proof = this.repository.operation(taskId, verificationKey)
      if (!task || !receipt || !proof || proof.kind !== 'effect_verification' || proof.request?.originalReceiptId !== receipt.id || proof.request?.originalFingerprint !== receipt.fingerprint) throw Object.assign(new Error('Readback proof does not belong to this operation.'), { code: 'invalid_state' })
      if (task.revision !== expectedRevision) throw Object.assign(new Error('Task changed while verification was running.'), { code: 'stale_request' })
      if (TERMINAL.has(task.status) || task.authority?.revokedAt) throw Object.assign(new Error('Task authorization was revoked.'), { code: 'execution_grant_revoked' })
      const now = this.nowIso()
      this.repository.finishOperation(taskId, verificationKey, { status: 'succeeded', result: { taskId, receiptId, status: 'verified', evidence } }, now)
      this.repository.resolveOperation(taskId, receipt.idempotencyKey, { status: 'verified', receiptId: proof.id, evidence, resolvedAt: now })
      this.repository.update(taskId, task.revision, current => ({ ...current, updatedAt: now,
        resultEvidence: [...(current.resultEvidence ?? []).filter(item => !(item.provider === evidence.provider && item.operation === evidence.operation && item.target === evidence.target)), evidence] }),
      { key: `operation-verified:${proof.id}`, kind: 'operation_verified', payload: { provider: evidence.provider, operation: evidence.operation, target: evidence.target, receiptId }, createdAt: now })
    })
  }

  beginWork(turnId: string, id: string, kind: string): () => void {
    const token = this.attemptTokens.get(turnId)
    if (!token) return () => undefined
    this.assertToken(token)
    const task = this.repository.get(token.taskId)!
    const root = task.rootTaskId ?? task.parentTaskId ?? task.id
    const rootTask = this.repository.get(root) ?? task
    const used = this.repository.execution.usedExecutionMs(root, Date.parse(this.nowIso()))
    if (rootTask.budget.version === 2 && used >= (rootTask.budget.maxExecutionMs ?? rootTask.budget.maxDurationMs)) throw Object.assign(new Error('Root task execution budget exhausted.'), { code: 'execution_budget_exhausted' })
    if (rootTask.budget.maxCostUsd && this.repository.execution.usedCost(root) >= rootTask.budget.maxCostUsd) throw Object.assign(new Error('Root task cost budget exhausted.'), { code: 'cost_budget_exhausted' })
    this.repository.execution.beginWork(id, root, kind, Date.parse(this.nowIso()), token.executionId)
    this.activeWork.set(id,{rootTaskId:root,turnId})
    this.refreshRootBudget(root)
    let finished=false
    return () => {
      if(finished)return
      finished=true
      this.repository.execution.finishWork(id, Date.parse(this.nowIso()))
      this.activeWork.delete(id)
      this.refreshRootBudget(root)
    }
  }

  /** Concurrent work draws from one root ledger, so each child cannot spend a full copy. */
  private refreshRootBudget(rootTaskId:string):void {
    const old=this.rootBudgetTimers.get(rootTaskId)
    if(old)clearTimeout(old)
    this.rootBudgetTimers.delete(rootTaskId)
    const root=this.repository.get(rootTaskId)
    const active=[...this.activeWork.values()].filter(work=>work.rootTaskId===rootTaskId)
    if(!root||root.budget.version!==2||!active.length)return
    const remaining=(root.budget.maxExecutionMs ?? root.budget.maxDurationMs)-this.repository.execution.usedExecutionMs(rootTaskId,Date.parse(this.nowIso()))
    if(remaining<=0) {
      for(const turnId of new Set(active.map(work=>work.turnId)))this.executionAborts.get(turnId)?.('execution_budget_exhausted')
      return
    }
    const timer=setTimeout(()=>{
      this.rootBudgetTimers.delete(rootTaskId)
      this.refreshRootBudget(rootTaskId)
    },Math.max(1,Math.min(2_147_483_647,Math.ceil(remaining/active.length))))
    timer.unref?.()
    this.rootBudgetTimers.set(rootTaskId,timer)
  }

  workBudget(turnId: string): { rootTaskId: string; serialRoot: boolean; remainingMs?: number } | undefined {
    const token = this.attemptTokens.get(turnId)
    if (!token) return undefined
    const task = this.repository.get(token.taskId)
    if (!task) return undefined
    const rootTaskId = task.rootTaskId ?? task.parentTaskId ?? task.id
    const root = this.repository.get(rootTaskId) ?? task
    return { rootTaskId, serialRoot: root.budget.maxCostUsd !== undefined,
      ...(root.budget.version === 2 ? { remainingMs: Math.max(0,(root.budget.maxExecutionMs ?? root.budget.maxDurationMs) - this.repository.execution.usedExecutionMs(rootTaskId, Date.parse(this.nowIso()))) } : {}) }
  }

  recordCost(turnId: string, id: string, costUsd?: number): void {
    const token = this.attemptTokens.get(turnId)
    if (!token || costUsd === undefined) return
    const task = this.repository.get(token.taskId)!
    this.repository.execution.recordCost(task.rootTaskId ?? task.parentTaskId ?? task.id, id, costUsd)
  }

  pendingInputs(threadId: string): TaskInput[] {
    const task = this.repository.findActiveByThread(threadId)
    return task && task.status !== 'paused' ? this.repository.inputs(task.id, true) : []
  }

  consumeInput(inputId: string): void { this.repository.consumeInput(inputId, this.nowIso()) }

  markInputDelivered(inputId: string): void { this.repository.markInputDelivered(inputId, this.nowIso()) }

  appendInput(taskId: string, expectedRevision: number, idempotencyKey: string, text: string, kind: TaskInput['kind'] = 'supplement', sourceId?: string, references?:Pick<TaskInput,'attachmentIds'|'workspaceReferences'>) {
    return this.repository.appendInput({ taskId, expectedRevision, idempotencyKey, text, kind, sourceId, ...references, nowIso: this.nowIso() })
  }

  prepareResume(taskId: string, expectedRevision: number, model?: string): TaskRun {
    const task = this.repository.get(taskId)
    if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'not_found' })
    if (!['paused', 'stalled', 'waiting_user', 'waiting_approval', 'retrying'].includes(task.status)) {
      throw Object.assign(new Error(`task cannot resume from ${task.status}`), { code: 'invalid_state' })
    }
    const hostShell = this.hostShellState(task)
    if (hostShell.unknown.length || this.repository.unsettledOperations(taskId).some(operation => operation.kind === 'tool') || this.repository.listShellSessions(taskId).some(session => ['outcome_unknown','running','starting'].includes(session.status) && !hostShell.knownSessionIds.has(session.id))) throw Object.assign(new Error('Verify outstanding operation and process outcomes before resuming this task.'), {code:'outcome_unknown'})
    const now = this.nowIso()
    return this.repository.update(task.id, expectedRevision, (current) => ({
      ...current,
      status: 'retrying',
      ...(model ? { model } : {}),
      noProgressCount: 0,
      stalledReason: undefined,
      waitingReason: '用户要求从最近 checkpoint 继续。',
      nodes: current.nodes.map((node) => node.status === 'completed'
        ? node
        : {
            ...node,
            status: 'pending',
            errorCode: undefined,
            errorMessage: undefined,
            revision: node.revision + 1
          }),
      updatedAt: now
    }), {
      key: `task-resumed:${expectedRevision}`,
      kind: 'task_resumed',
      payload: { model: model ?? task.model },
      createdAt: now
    })
  }

  restorePreparedResume(previous: TaskRun, preparedRevision: number): TaskRun | null {
    const current = this.repository.get(previous.id)
    if (!current || current.revision !== preparedRevision || current.status !== 'retrying' || current.activeTurnId !== previous.activeTurnId) return null
    const now = this.nowIso()
    return this.repository.update(previous.id, preparedRevision, (prepared) => ({
      ...previous,
      nodes: previous.nodes.map((node) => {
        const updated = prepared.nodes.find((item) => item.id === node.id)
        return updated && updated.revision !== node.revision ? { ...node, revision: updated.revision + 1 } : node
      }),
      updatedAt: now
    }), {
      key: `task-resume-start-failed:${preparedRevision}`,
      kind: 'task_resume_start_failed',
      payload: { restoredStatus: previous.status },
      createdAt: now
    })
  }

  cancelTask(taskId: string, expectedRevision: number, reason: string): TaskRun {
    const task = this.repository.get(taskId)
    if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'not_found' })
    if (task.revision !== expectedRevision) {
      throw Object.assign(new Error(`task revision conflict: expected ${expectedRevision}, actual ${task.revision}`), {
        code: 'stale_request'
      })
    }
    return this.finish(task, 'cancelled', reason).task
  }

  reconcileStartup(excludeTaskIds: ReadonlySet<string> = new Set(), onlyTaskIds?: ReadonlySet<string>): TaskRun[] {
    const now = this.nowIso()
    const recovered = this.repository.reconcileExpired(now)
      .filter((task) => !excludeTaskIds.has(task.id) && (!onlyTaskIds || onlyTaskIds.has(task.id)))
      .map((task) => {
      const lastAttempt = this.repository.execution.latestAttempt(task.id)
      if (lastAttempt && !['completed','cancelled'].includes(lastAttempt.status) && inspectProcess(lastAttempt.process) !== 'exited') {
        return task
      }
      const lease = this.repository.getLease(task.id)
      if (lastAttempt) this.repository.execution.finishOrphanedWork(lastAttempt.executionId, Math.min(Date.parse(now), Date.parse(lastAttempt.finishedAt ?? lease?.expiresAt ?? task.updatedAt)))
      const unknownShell = this.repository.listShellSessions(task.id).some(session => ['running', 'starting', 'outcome_unknown'].includes(session.status))
      const unknown = this.repository.unsettledOperations(task.id)
      if (unknown.length || unknownShell) {
        return this.repository.update(task.id, task.revision, current => ({ ...current, status: 'stalled', waitingReason: undefined, stalledReason: '上次操作结果尚未确认，请先核实执行回执后继续。', updatedAt: now }), { key: `recovery-unknown:${task.revision}`, kind: 'task_stalled', payload: { operationIds: unknown.map(item => item.id) }, createdAt: now })
      }
      const hostShell = this.hostShellState(task)
      if (hostShell.lastFailed) {
        return this.repository.update(task.id,task.revision,current=>({...current,status:'waiting_user',waitingReason:'上次已授权命令没有执行成功。请先处理失败原因，再明确授权新的检查命令；系统不会自动重放。',stalledReason:undefined,updatedAt:now}),{key:`recovery-shell-failed:${hostShell.lastFailed.id}`,kind:'task_waiting_user',payload:{operationId:hostShell.lastFailed.id},createdAt:now})
      }
      const recovered = this.repository.update(task.id, task.revision, (current) => ({
        ...current,
        status: 'retrying',
        waitingReason: '应用上次退出时任务仍在运行。将从最近检查点自动续跑，已完成的外部操作不得重复。',
        stalledReason: undefined,
        updatedAt: now
      }), {
        key: `startup-auto-recovery:${task.revision}`,
        kind: 'task_auto_recovery',
        createdAt: now
      })
      this.saveCheckpoint(
        recovered,
        recovered.waitingReason ?? '从最近检查点自动恢复。',
        `startup:${task.revision}`
      )
      return recovered
    })
    return recovered
  }

  private async runWatchdogTick(): Promise<void> {
    if (this.watchdogRunning) return
    this.watchdogRunning = true
    try {
      const now = this.nowIso()
      const leaseMs = Math.max(1_000, Math.trunc(this.watchdogOptions.leaseMs ?? 60_000))
      // Startup recovery is suppressed only until the resumed worker owns a
      // fresh lease; a later lease expiry must remain recoverable.
      for (const taskId of this.recoveryInFlight) {
        if (this.leases.has(taskId)) this.recoveryInFlight.delete(taskId)
      }
      for (const [taskId, state] of this.leases) {
        const task = this.repository.get(taskId)
        if (!task || TERMINAL.has(task.status) || task.status === 'paused') {
          this.releaseExecutionLease(taskId)
          continue
        }
        const renewed = this.repository.renewLease(
          taskId,
          this.ownerId,
          state.leaseRevision,
          now,
          new Date(Date.parse(now) + leaseMs).toISOString()
        )
        if (renewed) continue
        this.leases.delete(taskId)
        for (const token of this.attemptTokens.values()) if (token.taskId === taskId) this.repository.execution.finishAttempt(token.executionId, 'lost', now)
        try {
          this.watchdogOptions.onLeaseLost?.(task)
        } catch {
          // A lease-loss observer must not prevent recovery of other tasks.
        }
      }

      const recovery = this.watchdogOptions.onRecoveryNeeded
      if (!recovery) return
      const candidates = this.repository.reconcileExpired(now)
        .filter((task) => !this.leases.has(task.id) && !this.recoveryInFlight.has(task.id))
      if (candidates.length === 0) return
      for (const candidate of candidates) this.recoveryInFlight.add(candidate.id)
      const recovered = this.reconcileStartup(new Set(this.leases.keys()), new Set(candidates.map(task => task.id)))
        .filter((task) => task.status === 'retrying')
      try {
        await recovery(recovered)
      } catch {
        for (const task of recovered) this.recoveryInFlight.delete(task.id)
      }
    } finally {
      this.watchdogRunning = false
    }
  }

  private leaseGuard(taskId: string): TaskLeaseGuard {
    const lease = this.leases.get(taskId)
    if (!lease || !this.fencedTasks.has(taskId)) throw new TaskLeaseLostError(taskId)
    return { ownerId: this.ownerId, leaseRevision: lease.leaseRevision, nowIso: this.nowIso() }
  }

  private updateExecution(
    taskId: string,
    expectedRevision: number,
    mutator: (current: TaskRun) => TaskRun,
    event?: { key: string; kind: string; payload?: Record<string, unknown>; createdAt?: string }
  ): TaskRun {
    return this.fencedTasks.has(taskId)
      ? this.repository.update(taskId, expectedRevision, mutator, event, this.leaseGuard(taskId))
      : this.repository.update(taskId, expectedRevision, mutator, event)
  }

  private releaseExecutionLease(taskId: string): void {
    const lease = this.leases.get(taskId)
    if (lease) this.repository.releaseLease(taskId, this.ownerId, lease.leaseRevision)
    this.leases.delete(taskId)
    for (const [turnId, token] of this.attemptTokens) if (token.taskId === taskId) {
      this.repository.execution.finishAttempt(token.executionId, 'completed', this.nowIso())
      this.attemptTokens.delete(turnId)
    }
    this.fencedTasks.delete(taskId)
  }

  private retry(
    taskInput: TaskRun,
    reason: string,
    progressFingerprint: string,
    turnId?: string
  ): TaskCandidateDecision {
    const stored = this.repository.get(taskInput.id) ?? taskInput
    const sameProgress = stored.nodes.some((node) => node.progressFingerprint === progressFingerprint)
    const noProgressCount = sameProgress ? stored.noProgressCount + 1 : 0
    const shouldReplan = noProgressCount >= 3
    const replans = shouldReplan ? stored.replans + 1 : stored.replans
    const now = this.nowIso()
    const durationExhausted = stored.budget.version === 2
      ? this.repository.execution.usedExecutionMs(stored.rootTaskId ?? stored.id, Date.parse(now)) >= (stored.budget.maxExecutionMs ?? stored.budget.maxDurationMs) || Boolean(stored.budget.maxElapsedMs && Date.parse(now) - Date.parse(stored.createdAt) >= stored.budget.maxElapsedMs)
      : Math.max(0, Date.parse(now) - Date.parse(stored.createdAt)) >= stored.budget.maxDurationMs
    const attemptExhausted = stored.attempts >= stored.budget.maxAttempts
    const stalled = replans >= 2 && shouldReplan
    const status: TaskRunStatus = durationExhausted
      ? 'failed'
      : stalled
        ? 'stalled'
        : attemptExhausted
          ? 'failed'
          : 'retrying'
    const next = this.updateExecution(stored.id, stored.revision, (current) => ({
      ...current,
      status,
      noProgressCount: shouldReplan ? 0 : noProgressCount,
      replans,
      stalledReason: stalled ? reason : undefined,
      waitingReason: status === 'retrying' ? reason : undefined,
      artifacts: taskInput.artifacts,
      nodes: current.nodes.map((node) =>
        node.status === 'completed'
          ? node
          : {
              ...node,
              status: status === 'retrying' ? 'pending' : 'failed',
              progressFingerprint,
              errorCode: status === 'failed'
                ? durationExhausted ? 'duration_budget_exhausted' : 'attempt_budget_exhausted'
                : stalled ? 'task_stalled' : 'acceptance_rejected',
              errorMessage: reason,
              revision: node.revision + 1
            }
      ),
      updatedAt: now,
      ...(status === 'failed' ? { finishedAt: now } : {})
    }), {
      key: `${status}:${stored.attempts}:${progressFingerprint}`,
      kind: status === 'retrying' ? (shouldReplan ? 'task_replanned' : 'attempt_retrying') : `task_${status}`,
      payload: { reason, attempt: stored.attempts, replans },
      createdAt: now
    })
    this.saveCheckpoint(next, reason, progressFingerprint)
    if (turnId) {
      this.spans?.finishTurn(next.id, turnId, {
        status: 'error',
        errorCode: status === 'stalled'
          ? 'task_stalled'
          : status === 'failed'
            ? durationExhausted ? 'duration_budget_exhausted' : 'attempt_budget_exhausted'
            : 'acceptance_rejected',
        attributes: { nextStatus: status, replans, noProgressCount }
      })
    }
    if (status !== 'retrying') this.releaseExecutionLease(next.id)
    if (status === 'failed') {
      this.spans?.finish(taskSpanId(next.id), {
        status: 'error',
        errorCode: durationExhausted ? 'duration_budget_exhausted' : 'attempt_budget_exhausted',
        attributes: { attempts: next.attempts, replans: next.replans }
      })
    }
    if (status === 'failed') return { kind: 'failed', task: next, reason }
    if (status === 'stalled') return { kind: 'stalled', task: next, reason }
    return { kind: 'continue', task: next, reason }
  }

  private waitForUser(
    taskInput: TaskRun,
    reason: string,
    finalResponse: string,
    progressFingerprint: string,
    turnId: string
  ): Extract<TaskCandidateDecision, { kind: 'waiting_user' }> {
    const stored = this.repository.get(taskInput.id) ?? taskInput
    const now = this.nowIso()
    const next = this.updateExecution(stored.id, stored.revision, (current) => ({
      ...current,
      status: 'waiting_user',
      executionMs: (current.executionMs ?? 0) + activeExecutionMs(current, now),
      executionStartedAt: undefined,
      finalResponse,
      waitingReason: reason,
      stalledReason: undefined,
      nodes: current.nodes.map((node) =>
        node.status === 'completed'
          ? node
          : {
              ...node,
              status: 'pending',
              progressFingerprint,
              errorCode: undefined,
              errorMessage: undefined,
              revision: node.revision + 1
            }
      ),
      updatedAt: now
    }), {
      key: `task-waiting-user:${stored.attempts}:${progressFingerprint}`,
      kind: 'task_waiting_user',
      payload: { reason, turnId },
      createdAt: now
    })
    this.saveCheckpoint(next, reason, progressFingerprint)
    this.releaseExecutionLease(next.id)
    this.spans?.finishTurn(next.id, turnId, {
      status: 'ok',
      attributes: { nextStatus: 'waiting_user' }
    })
    return { kind: 'waiting_user', task: next, reason }
  }

  private finish(task: TaskRun, status: Extract<TaskRunStatus, 'failed' | 'cancelled'>, reason: string): Extract<TaskCandidateDecision, { kind: 'failed' }> {
    const now = this.nowIso()
    const next = this.updateExecution(task.id, task.revision, (current) => ({
      ...current,
      status,
      authority: current.authority ? { ...current.authority, ...(status === 'cancelled' ? { revokedAt: now } : {}) } : undefined,
      executionMs: (current.executionMs ?? 0) + activeExecutionMs(current, now),
      executionStartedAt: undefined,
      stalledReason: reason,
      nodes: current.nodes.map((node) =>
        node.status === 'completed' ? node : { ...node, status: 'failed', errorMessage: reason, finishedAt: now, revision: node.revision + 1 }
      ),
      updatedAt: now,
      finishedAt: now
    }), {
      key: `task-terminal:${status}`,
      kind: `task_${status}`,
      payload: { reason },
      createdAt: now
    })
    this.releaseExecutionLease(task.id)
    if (task.activeTurnId) {
      this.spans?.finishTurn(task.id, task.activeTurnId, {
        status: status === 'cancelled' ? 'cancelled' : 'error',
        errorCode: status === 'cancelled' ? 'operation_cancelled' : 'task_failed'
      })
    }
    this.spans?.finish(taskSpanId(task.id), {
      status: status === 'cancelled' ? 'cancelled' : 'error',
      errorCode: status === 'cancelled' ? 'operation_cancelled' : 'task_failed',
      attributes: { attempts: next.attempts, replans: next.replans }
    })
    return { kind: 'failed', task: next, reason }
  }

  private saveCheckpoint(task: TaskRun, reason: string, progressFingerprint: string): TaskCheckpoint {
    const events = this.repository.events(task.id)
    return this.repository.saveCheckpoint({
      id: `checkpoint_${task.id}_${task.attempts}`,
      taskId: task.id,
      completedNodeIds: task.nodes.filter((node) => node.status === 'completed').map((node) => node.id),
      pendingNodeIds: task.nodes.filter((node) => node.status !== 'completed').map((node) => node.id),
      artifactIds: task.artifacts.map((artifact) => artifact.id),
      eventSequence: events.at(-1)?.sequence ?? 0,
      resumeSummary: reason,
      progressFingerprint,
      createdAt: this.nowIso(),
      revision: task.attempts
    })
  }

  private async collectArtifacts(task: TaskRun, items: TurnItem[], turnId: string): Promise<TaskArtifact[]> {
    const paths = [
      ...items.flatMap(declaredFileOutputPaths),
      ...verifiedShellDeliverablePaths(items, turnId)
    ]
    const root = await realpath(task.workspaceRoot).catch(() => resolve(task.workspaceRoot))
    const required = task.acceptance.requiredFormats?.map((value) => value.toLowerCase())
    const artifacts: TaskArtifact[] = []
    const seenTargets=new Set<string>()
    for (const rawPath of [...new Set(paths)]) {
      const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
      const canonical = await realpath(absolutePath).catch(() => '')
      const relativePath = canonical ? relative(root, canonical) : relative(root, absolutePath)
      const targetKey=process.platform==='win32'?(canonical||absolutePath).toLowerCase():canonical||absolutePath
      if(seenTargets.has(targetKey))continue
      seenTargets.add(targetKey)
      const extension = extname(rawPath).slice(1).toLowerCase()
      const inside = relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(relativePath)
      const info = canonical && inside ? await stat(canonical).catch(() => null) : null
      const validFormat = !required || required.includes(extension)
      const validationSpanId = artifactValidationSpanId(task.id, rawPath)
      this.spans?.start({
        id: validationSpanId,
        taskId: task.id,
        turnId: task.activeTurnId,
        kind: 'validation',
        name: 'artifact-validation',
        retryCount: 0,
        attributes: { format: extension || 'unknown' }
      })
      const validation = info?.isFile() && validFormat
        ? await validateArtifactFile(canonical, extension).catch((error) => ({
            valid: false,
            format: extension,
            sizeBytes: info.size,
            sha256: '',
            evidence: [],
            message: error instanceof Error ? error.message : String(error)
          }))
        : null
      const valid = Boolean(validation?.valid)
      this.spans?.finish(validationSpanId, {
        status: valid ? 'ok' : 'error',
        ...(!valid ? {
          errorCode: !inside
            ? 'unsafe_path'
            : !info?.isFile()
              ? 'artifact_not_found'
              : !validFormat
                ? 'artifact_format_mismatch'
                : 'artifact_invalid'
        } : {}),
        attributes: {
          format: validation?.format ?? (extension || 'unknown'),
          valid,
          sizeBytes: validation?.sizeBytes ?? info?.size ?? 0
        }
      })
      artifacts.push({
        id: `artifact_${createHash('sha256').update(`${task.id}:${relativePath}`).digest('hex').slice(0, 16)}`,
        relativePath: inside ? relativePath : rawPath,
        format: extension || undefined,
        sizeBytes: validation?.sizeBytes ?? info?.size,
        sha256: validation?.sha256 || undefined,
        validation: valid ? 'valid' : 'invalid',
        validationMessage: valid
          ? undefined
          : !inside
            ? '成果路径不在工作区内。'
            : !info?.isFile()
              ? '成果文件不存在或不是普通文件。'
              : validFormat
                ? validation?.message ?? '成果文件未通过格式验证。'
                : `成果格式 .${extension || 'unknown'} 不符合要求。`,
        createdAt: this.nowIso()
      })
    }
    return artifacts
  }
}

function minimumDefinedPositive(...values: Array<number | undefined>): number | undefined {
  const positive = values.filter((value): value is number => typeof value === 'number' && value > 0)
  return positive.length ? Math.min(...positive) : undefined
}

function turnSpanId(taskId: string, turnId: string, attempt: number): string {
  return `span_${createHash('sha256').update(`${taskId}:${turnId}:${attempt}`).digest('hex').slice(0, 24)}`
}

function taskSpanId(taskId: string): string {
  return `span_task_${createHash('sha256').update(taskId).digest('hex').slice(0, 24)}`
}

function artifactValidationSpanId(taskId: string, rawPath: string): string {
  return `span_validation_${createHash('sha256').update(`${taskId}:${rawPath}`).digest('hex').slice(0, 24)}`
}

function shouldContinueActiveTask(prompt: string): boolean {
  const intent = completionIntentText(prompt).trim()
  return AUTOMATIC_RECOVERY_PATTERN.test(intent) ||
    (intent.length <= 80 && BARE_TASK_CONTINUATION_PATTERN.test(intent))
}

function externalVerificationLocator(args: Record<string, unknown>): Record<string, string> | undefined {
  const locator: Record<string, string> = {}
  for (const field of ['taskId', 'instanceCode', 'instanceId', 'toUserId']) {
    const value = args[field]
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value.trim())) locator[field] = value.trim()
  }
  return Object.keys(locator).length ? locator : undefined
}

function makeToolResultForVerifiedResolution(task: TaskRun, turnId: string, call: ToolCallLike, evidence: NonNullable<OperationReceipt['resolution']>['evidence']): ToolHostResult['item'] {
  return makeToolResultItem({ id: `item_${call.callId}`, threadId: task.threadId, turnId, callId: call.callId, toolName: call.toolName, output: { ok: true, status: 'succeeded', evidence, recovered: true } })
}

function acceptanceForPrompt(prompt: string): TaskAcceptance {
  const files = promptRequiresFileDeliverable(prompt)
  const effect = !files && promptRequiresExternalEffect(prompt)
  const intent = effect ? externalTaskIntent(prompt) : null
  const requiredFormats = requiredFileExtensionsForPrompt(prompt)
  return {
    kind: files ? 'files' : effect ? 'effect' : 'answer',
    requiredNodeKinds: files || effect ? ['execute', 'verify', 'deliver'] : ['deliver'],
    ...(requiredFormats ? { requiredFormats: [...requiredFormats] } : {}),
    ...(files ? { minimumArtifacts: 1 } : {}),
    requireFinalResponse: true,
    requireActionableArtifactCard: files,
    ...(intent?.provider?{effect:{provider:intent.provider,operation:intent.operation ?? (intent.kind==='connect_provider'?'connect':'process'),target:intent.target ?? (intent.operation === 'list' ? 'current_user' : undefined),requiredScopes:[],requiresConfirmation:intent.mutation,successStatus:['succeeded'],verification:'provider_readback' as const}}:{})
  }
}

function nodeBlueprint(taskId: string, acceptance: TaskAcceptance): TaskRun['nodes'] {
  return acceptance.requiredNodeKinds.map((kind, index) => ({
    id: `node_${taskId}_${kind}`,
    taskId,
    kind,
    title: kind === 'execute' ? '执行任务' : kind === 'verify' ? '验证成果' : kind === 'deliver' ? '交付成果' : '规划任务',
    status: 'pending',
    dependsOn: index > 0 ? [`node_${taskId}_${acceptance.requiredNodeKinds[index - 1]}`] : [],
    attempt: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    idempotencyKey: `${taskId}:${kind}`,
    evidence: [],
    revision: 0
  }))
}

function pendingWorkReason(items: TurnItem[]): string | null {
  for (const item of items) {
    if ((item.kind === 'tool_call' || item.kind === 'tool_result') && (item.status === 'pending' || item.status === 'running')) {
      return '仍有工具正在运行。'
    }
    if (item.kind === 'approval' && item.status === 'pending') return '仍在等待审批。'
    if (item.kind === 'user_input' && item.status === 'pending') return '仍在等待必要输入。'
  }
  return null
}

function latestAssistantText(turn: Turn | undefined, items: TurnItem[]): string {
  const candidates = [...(turn?.items ?? []), ...items]
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const item = candidates[index]
    if (item?.kind === 'assistant_text' && item.text.trim()) return item.text.trim()
  }
  return ''
}


function fingerprint(items: TurnItem[], artifacts: TaskArtifact[] = []): string {
  const normalized = items.map((item) => {
    if (item.kind === 'assistant_reasoning') return { kind: item.kind }
    if (item.kind === 'assistant_text') return { kind: item.kind, text: item.text.trim() }
    if (item.kind === 'tool_result') return { kind: item.kind, toolName: item.toolName, isError: item.isError, paths: fileOutputPaths(item.output) }
    return { kind: item.kind, status: item.status }
  })
  const unique = [...new Map(normalized.map((entry) => [JSON.stringify(entry), entry])).values()]
  return createHash('sha256').update(JSON.stringify({ normalized: unique, artifacts })).digest('hex').slice(0, 24)
}

function activeExecutionMs(task: TaskRun, now: string): number {
  return task.executionStartedAt ? Math.max(0, Date.parse(now) - Date.parse(task.executionStartedAt)) : 0
}
