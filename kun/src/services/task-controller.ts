import { settleUnstartedOneOffRetry } from './one-off-public-query-recovery.js'
import { oneOffChildBinding } from './one-off-public-query-proof.js'
import type { BrowserPublicQueryRecoveryBinding } from '../contracts/browser-public-query-recovery.js'
import { verifiedPublicQueryRecovery } from './browser-public-query-recovery-proof.js'
import { retryBrowserScope } from './browser-public-query-authority.js'
import { verifiedTaskRetryLineage } from './task-retry-lineage.js'
import type { OperationResolutionOutcome } from '../contracts/tasks.js'
import { browserTaskOrigins, browserVerificationPolicy } from '../contracts/browser-skill.js'
import { asksForObservedFeedSummary, requiresWebSourceEvidence, legacyLocalArtifactSourceMismatch, requiredLocalHtmlFileNames, TASK_SOURCE_INFERENCE_VERSION } from '../contracts/task-source-intent.js'
import { listApprovedBrowserScheduleActions } from './browser-schedule-action-authority.js'
import { verifiedTaskPublicQueryAction } from './browser-public-query-authority.js'
import { extractScheduleRequirement } from '../contracts/schedule.js'
import { authorizedArtifactWrites } from './task-artifact-proof.js'
import { workspacePermissionCapability } from './workspace-write-preflight.js'
import type { CapabilityPreflight } from '../contracts/harness.js'
import type { ToolEffectResolver } from '../ports/tool-effect.js'
import { externalTaskIntent } from './external-task-capability.js'
import { verifiedEffectReceipts, externalOperationForTool, externalTarget, requestedEffectOperations } from './external-effect-evidence.js'
import { ExecutionGrantSchema, HostShellAuthorizationSchema, type ExecutionGrant } from '../contracts/permissions.js'
import { randomUUID as executionUUID } from 'node:crypto'
import type { ExecutionToken, InputDelivery, ProcessIdentity } from '../contracts/execution.js'
import { processIdentity, inspectProcess } from './process-identity.js'
import type { CurrentToolOperation, ToolCallLike, ToolHostResult } from '../ports/tool-host.js'
import { makeToolResultItem } from '../domain/item.js'
import type { ApprovalRequest } from '../domain/approval.js'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { constants, realpathSync, type Stats } from 'node:fs'
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
import { WebArtifactEvidenceInputSchema, type WebArtifactEvidenceInput } from '../contracts/web-artifact-evidence.js'
import { assessWebArtifactEvidence, verifiedWebArtifactEvidence, webArtifactFailureKinds, webArtifactManifestSourceProof, webArtifactPublicationReadiness, webArtifactRequirementHash, webEvidenceRepair } from './web-artifact-evidence.js'
import { deriveWebArtifactRepairState, type WebArtifactRepairAttempt } from './web-artifact-repair-state.js'

import { validEgoDocumentEvidence, verifiedEgoTaskSpaceFinish } from './ego-browser-evidence.js'
import { EGO_PERMISSION_CODES, taskPermissionCapability, taskPermissionFailure } from './task-permission-recovery.js'

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
  dataDir?: string
  repository: TaskRunRepository
  threadStore: ThreadStore
  sessionStore: SessionStore
  nowIso: () => string
  ownerId?: string
  resolveToolEffect?: ToolEffectResolver
  spans?: RuntimeSpanService
  reconcileHostShell?: (taskId: string) => Promise<void>
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
  private admissionSuspended = false

  setAdmissionSuspended(suspended: boolean): void { this.admissionSuspended = suspended }

  private readonly repository: TaskRunRepository
  private readonly artifactDataDir?: string
  private readonly threadStore: ThreadStore
  private readonly sessionStore: SessionStore
  private readonly nowIso: () => string
  private readonly ownerId: string
  private readonly resolveToolEffect: ToolEffectResolver
  private readonly spans?: RuntimeSpanService
  private readonly reconcileHostShell?: TaskControllerDeps['reconcileHostShell']
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
    this.artifactDataDir = deps.dataDir ? realpathSync(deps.dataDir) : undefined
    let sharedBudget=sharedWorkBudgets.get(deps.repository)
    if(!sharedBudget){sharedBudget={aborts:new Map(),active:new Map(),timers:new Map()};sharedWorkBudgets.set(deps.repository,sharedBudget)}
    this.executionAborts=sharedBudget.aborts;this.activeWork=sharedBudget.active;this.rootBudgetTimers=sharedBudget.timers
    this.threadStore = deps.threadStore
    this.sessionStore = deps.sessionStore
    this.nowIso = deps.nowIso
    this.ownerId = deps.ownerId ?? `runtime-${process.pid}-${randomUUID()}`
    this.spans = deps.spans
    this.completionGuard = deps.completionGuard
    this.reconcileHostShell = deps.reconcileHostShell
    this.resolveToolEffect = deps.resolveToolEffect ?? externalOperationForTool
  }

  managedArtifactRoot(taskId: string): string | undefined {
    if (!this.artifactDataDir || !this.repository.get(taskId)) return undefined
    return resolve(this.artifactDataDir, 'task-artifacts', createHash('sha256').update(taskId).digest('hex'))
  }

  /** An explicit Retry may read a proven ancestor draft, but cannot relabel its writer or source proof. */
  async historicalArtifact(taskId: string, sourceTaskId: string, path: string) {
    const task = this.repository.get(taskId), lineage = task && verifiedTaskRetryLineage(this.repository, task)
    const source = lineage?.tasks.slice(1).find(value => value.id === sourceTaskId)
    if (!source) throw Object.assign(new Error('历史成果不属于已核验的重试链。'), { code: 'artifact_history_scope' })
    const artifact = source.artifacts.find(value => value.storage === 'task' && value.relativePath === path)
    const root = this.managedArtifactRoot(source.id), thread = await this.threadStore.get(source.threadId)
    if (!root || !artifact?.absolutePath || !artifact.sha256) throw Object.assign(new Error('没有该历史成果的受管理文件记录。'), { code: 'artifact_history_scope' })
    const writes = await authorizedArtifactWrites(source, this.repository.operations(source.id, 'tool'), thread?.turns ?? [])
    const write = writes.get(await realpath(artifact.absolutePath).catch(() => ''))
    if (!write || write.authorizedRoot !== root || write.sha256 !== artifact.sha256 || write.executionGrantId !== artifact.executionGrantId || resolve(root, path) !== write.absolutePath) {
      throw Object.assign(new Error('历史成果没有匹配的原始写入证据。'), { code: 'artifact_history_scope' })
    }
    return { root, sha256: artifact.sha256, sourceTaskId: source.id, writerReceiptId: write.operationId, executionGrantId: write.executionGrantId }
  }

  retryHistory(taskId: string): string {
    const task = this.repository.get(taskId), lineage = task && verifiedTaskRetryLineage(this.repository, task)
    if (!lineage || lineage.tasks.length < 2) return ''
    const files = lineage.tasks.slice(1).flatMap(source => source.artifacts.filter(file => file.storage === 'task').map(file => ({ source_task_id: source.id, path: file.relativePath, sha256: file.sha256 }))).slice(0, 32)
    return files.length ? `Historical drafts (read-only): ${JSON.stringify(files)}. Use read_artifact with source_task_id and path to inspect them. Publish your own corrected file using the same relative filename. Ancestor bytes are not this execution's file or source verification; re-read sources and verify the new report. Never repeat external side effects.` : ''
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
      const waiting = this.repository.update(task.id, task.revision, current => ({
        ...current, status: 'waiting_user', waitingReason: input.reason,
        nodes: current.nodes.map(node => ({ ...node, status: 'blocked' as const }))
      }), { key: 'capability-blocked', kind: 'capability_required', payload: { reason: input.reason } })
      return this.repository.appendInput({ taskId: waiting.id, expectedRevision: waiting.revision, idempotencyKey: `capability-original:${waiting.id}`,
        text: input.request.prompt, kind: 'supplement', sourceId: 'capability-original', attachmentIds: input.request.attachmentIds,
        workspaceReferences: input.request.workspaceReferences, nowIso: this.nowIso() }).task
    })
  }

  /** Prepare the retry contract before a Turn or model can run. The original ledger stays authoritative. */
  createRetryTask(input: { id: string; sourceTaskId: string; expectedRevision: number; thread: ThreadRecord; request: StartTurnRequest; retryControl?: { ownerId: string; idempotencyKey: string }; publicQueryRecovery?: BrowserPublicQueryRecoveryBinding; oneOffBrowserScope?: import('../contracts/browser-skill.js').BrowserExecutionScope }): TaskRun {
    return this.repository.transact(() => {
      const existing = this.repository.get(input.id)
      if (existing) return existing
      const source = this.repository.get(input.sourceTaskId)
      if (!source || source.revision !== input.expectedRevision) throw Object.assign(new Error('Retry source changed.'), { code: 'stale_request' })
      if (!['failed', 'cancelled'].includes(source.status) || source.threadId !== input.thread.id || source.workspaceRoot !== input.thread.workspace ||
          this.repository.currentExecution(source.id)?.id !== source.id) throw Object.assign(new Error('Retry source is no longer the terminal execution in this workspace.'), { code: 'invalid_state' })
      const control = input.retryControl && this.repository.operation(input.retryControl.ownerId, input.retryControl.idempotencyKey)
      const explicit = control?.kind === 'retry' && control.status === 'prepared' && (control.request?.expectedRevision === input.expectedRevision || input.publicQueryRecovery && control.request?.publicQueryRecoveryReceiptId === input.publicQueryRecovery.receiptId && Number(control.request?.expectedRevision) + 1 === input.expectedRevision)
      const recovery = input.publicQueryRecovery && verifiedPublicQueryRecovery(this.repository,input.publicQueryRecovery,input.publicQueryRecovery.ownerTaskId!==source.id)
      if(input.publicQueryRecovery&&!recovery)throw Object.assign(new Error('公开查询恢复凭据已变化。'),{code:'browser_public_query_recovery_changed'})
      const browserScope = explicit && recovery && input.publicQueryRecovery?.mode==='task_reauthorization' ? input.oneOffBrowserScope : explicit && recovery ? structuredClone(recovery.context.browserScope) : explicit ? retryBrowserScope(this.repository, source) : undefined
      const retry = this.createTask({ ...input, retrySource: source, retryBrowserScope: browserScope })
      if(input.publicQueryRecovery?.mode==='task_reauthorization'&&(!recovery||!oneOffChildBinding(this.repository,retry,input.publicQueryRecovery,recovery.context as import('./one-off-public-query-proof.js').OneOffContext)))throw Object.assign(new Error('Fresh child browser binding is missing'),{code:'browser_public_query_recovery_changed'})
      if (retry.flowRunId && retry.flowId) this.repository.enqueueOutbox({
        id: `flow-task-retry:${retry.id}`, ownerId: retry.id, kind: 'flow_task_retry',
        payload: { sourceTaskId: source.id, taskId: retry.id, flowRunId: retry.flowRunId, flowId: retry.flowId }, createdAt: this.nowIso()
      })
      return this.repository.update(retry.id, retry.revision, task => task,
        { key: `retry-of:${source.id}`, kind: 'task_retried', payload: { retryOfTaskId: source.id, rootTaskId: retry.rootTaskId, ...(browserScope ? { browserScopeDerivation: { sourceTaskId: source.id, authorizationReceiptId: browserScope.publicQueryAuthorization!.receiptId, scopeHash: operationFingerprint(browserScope) } } : {}) }, createdAt: this.nowIso() })
    })
  }

  private createTask(input: { id?: string; thread: ThreadRecord; turnId?: string; request: StartTurnRequest; engineeringExecution?: boolean; engineeringPlanId?: string; retrySource?: TaskRun; retryBrowserScope?: import('../contracts/browser-skill.js').BrowserExecutionScope; publicQueryRecovery?:BrowserPublicQueryRecoveryBinding }): TaskRun {
    const now = this.nowIso()
    const consultation = input.thread.domain === 'engineering' && !input.engineeringExecution
    const source = input.retrySource
    const taskGoal = source?.goal ?? (input.request.displayText?.trim() || input.request.prompt)
    const acceptance = source ? structuredClone(source.acceptance) : acceptanceForPrompt(consultation ? 'Answer the Survey question or propose a plan for review.' : taskGoal)
    const id = input.id ?? `task_${randomUUID()}`
    const nodes = nodeBlueprint(id, acceptance)
    const profile = input.thread.agentProfile
    const selectedModel = input.request.model ?? profile?.model ?? input.thread.model
    const maxCostUsd = minimumDefinedPositive(profile?.budget.maxCostUsd, input.thread.costBudgetUsd)
    const created = this.repository.create({
      id,
      threadId: input.thread.id,
      originThreadId: source?.originThreadId ?? input.request.taskOriginThreadId,
      visibility: source?.visibility ?? input.request.taskVisibility ?? (consultation ? 'chat' : 'task'),
      ...(input.publicQueryRecovery ? {publicQueryRecovery:input.publicQueryRecovery}:{}),
      ...(source?.scheduledBy ? { scheduledBy: structuredClone(source.scheduledBy) } : {}),
      ...(source ? { retryOfTaskId: source.id, rootTaskId: source.rootTaskId ?? source.id, parentTaskId: source.parentTaskId,
        templateId: source.templateId, deliveryFormats: source.deliveryFormats, flowRunId: source.flowRunId, flowId: source.flowId, repositoryRoot: source.repositoryRoot } : {}),
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
        externalTargets: [], grantedAt: now,
        ...(source?.authority ? { source: source.authority.source, toolAllowlist: source.authority.toolAllowlist, mcpAllowlist: source.authority.mcpAllowlist,
          externalTargets: [...source.authority.externalTargets], approvalPolicy: source.authority.approvalPolicy, sandboxMode: source.authority.sandboxMode,
          ...(input.retryBrowserScope ? { browserScope: structuredClone(input.retryBrowserScope) } : {}) } : {})
      },
      executionMs: 0,
      budget: source ? structuredClone(verifiedTaskRetryLineage(this.repository, source)?.root.budget ?? source.budget) : {
        maxAttempts: profile?.budget.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        maxDurationMs: profile?.budget.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
        ...(input.request.taskOriginThreadId || input.request.taskIntent==='new' ? { version: 2 as const, maxExecutionMs: profile?.budget.maxDurationMs ?? DEFAULT_MAX_DURATION_MS } : {}),
        ...(maxCostUsd !== undefined ? { maxCostUsd } : {})
      },
      attempts: 0,
      replans: 0,
      noProgressCount: 0,
      nodes,
      // Ancestor files remain readable history, never a new Task's writer evidence.
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

  /** Read-only validation shared by the pre-approval preview and transactional confirmation. */
  validateEffectScopeOperations(turnId: string, effects: readonly RequiredEffect[]): void {
    const keys = effects.map(effect => JSON.stringify([effect.provider, effect.operation, effect.target]))
    if (!effects.length || effects.length > 8 || new Set(keys).size !== keys.length) {
      throw Object.assign(new Error('Review between one and eight distinct external actions.'), { code: 'effect_scope_invalid' })
    }
    const token = this.attemptTokens.get(turnId)
    if (!token) throw Object.assign(new Error('No active external task.'), { code: 'effect_scope_required' })
    this.assertToken(token)
    const task = this.repository.get(token.taskId)!
    const acceptance = task.acceptance.effect
    const operations = requestedEffectOperations(task)
    if (!acceptance || task.authority?.revokedAt || effects.some(effect => effect.provider !== acceptance.provider ||
      !['detail', 'approve', 'reject', 'complete', 'transfer', 'send', 'upload'].includes(effect.operation) ||
      (operations.length ? effect.operation !== 'detail' && !operations.includes(effect.operation)
        : !['process', 'connect', effect.operation].includes(acceptance.operation)))) {
      throw Object.assign(new Error('Every reviewed action must belong to the requested task operations and provider.'), { code: 'effect_scope_conflict' })
    }
    if (operations.some(operation => !effects.some(effect => effect.operation === operation))) {
      throw Object.assign(new Error(`Confirm the complete requested action set (${operations.join(', ')}).`), { code: 'effect_scope_incomplete' })
    }
  }

  /** Persist a finite user-reviewed effect set before any mutating dispatch. */
  confirmEffectScope(turnId: string, expectedRevision: number, idempotencyKey: string, effects: RequiredEffect[]): TaskRun {
    const token = this.attemptTokens.get(turnId)
    if (!token) throw Object.assign(new Error('No active task execution for effect scope confirmation.'), { code: 'effect_scope_required' })
    if (!idempotencyKey.trim() || effects.length < 1 || effects.length > 8) throw Object.assign(new Error('Review between one and eight exact external actions.'), { code: 'effect_scope_invalid' })
    const requiredEffects = effects.map(effect => RequiredEffectSchema.parse(effect))
    return this.repository.transact(() => {
      this.assertToken(token)
      const task = this.repository.get(token.taskId)!
      const acceptance = task.acceptance.effect!
      this.validateEffectScopeOperations(turnId, requiredEffects)
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

  /** Repair only unreviewed legacy query contracts, preserving any actual write history. */
  private correctedReadAcceptance(task: TaskRun): TaskAcceptance | undefined {
    const accepted = task.acceptance.effect
    const intent = externalTaskIntent(task.goal)
    if (!accepted?.requiresConfirmation || intent?.mutation || intent?.operation !== 'list' || intent.provider !== accepted.provider ||
        accepted.scopeConfirmationId || accepted.requiredEffects?.length || accepted.target && accepted.target !== 'current_user') return undefined
    const supplementalWrite = this.taskInputs(task.id).some(input => input.kind === 'supplement' &&
      externalTaskIntent(`${accepted.provider} ${input.text}`)?.mutation)
    if (supplementalWrite) return undefined
    const unverifiedHistory = this.repository.operations(task.id, 'tool').some(receipt => {
      if (['prepared', 'running', 'outcome_unknown'].includes(receipt.status)) return true
      const notDispatched = receipt.request?.dispatchTracking === 'host-v1' && receipt.status === 'failed' &&
        (receipt.result as { approved?: boolean } | undefined)?.approved === false
      if (notDispatched) return false
      const name = typeof receipt.request?.toolName === 'string' ? receipt.request.toolName : ''
      const effect = this.resolveToolEffect(name) ?? externalOperationForTool(name)
      return !effect || effect.mutation || receipt.request?.mutation === true
    })
    if (unverifiedHistory) return undefined
    return { ...task.acceptance, effect: { ...accepted, operation: 'list', target: 'current_user', requiresConfirmation: false, requiredScopes: [] } }
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
    const correctedAcceptance = this.correctedReadAcceptance(task)
    let started: TaskRun
    try {
      started = this.repository.update(task.id, task.revision, (current) => ({
        ...current,
        ...(correctedAcceptance ? { acceptance: correctedAcceptance } : {}),
        status: 'running',
        executionStartedAt: current.executionStartedAt ?? now,
        attempts: current.attempts + 1,
        nodes: current.nodes.map((node) =>
          (node.status === 'pending' || node.status === 'failed' || node.status === 'blocked') && node.dependsOn.every(id => current.nodes.some(parent => parent.id === id && parent.status === 'completed'))
            ? { ...node, status: 'running', attempt: node.attempt + 1, startedAt: node.startedAt ?? now, revision: node.revision + 1 }
            : node
        ),
        updatedAt: now
      }), {
        key: `attempt-started:${task.attempts + 1}`,
        kind: 'attempt_started',
        payload: { turnId, attempt: task.attempts + 1, ...(correctedAcceptance ? { acceptanceCorrection: { from: task.acceptance.effect?.operation, to: 'list', reason: 'query_state_filter' } } : {}) },
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

  /** Binds source provenance to existing exact artifact bytes; it never fetches or edits sources. */
  private webArtifactRepairAttempts(task: TaskRun): WebArtifactRepairAttempt[] {
    return this.repository.operations(task.id).flatMap(receipt => {
      const result = receipt.result as { complete?: boolean; reasons?: unknown; failureKinds?: unknown } | undefined
      if (!['web_artifact_evidence', 'web_artifact_source_gate'].includes(receipt.kind) || receipt.status !== 'failed' || receipt.fingerprint !== operationFingerprint(receipt.request) || typeof receipt.request?.artifactPath !== 'string' ||
        typeof receipt.request.requirementHash !== 'string' || typeof receipt.request.evidenceFingerprint !== 'string' || result?.complete !== false ||
        !Array.isArray(result.reasons) || !result.reasons.every(value => typeof value === 'string') ||
        !Array.isArray(result.failureKinds) || !result.failureKinds.every(value => typeof value === 'string')) return []
      const rawEpochs = receipt.request.failureEvidenceFingerprints
      const failureEvidenceFingerprints = rawEpochs && typeof rawEpochs === 'object' && !Array.isArray(rawEpochs) &&
        Object.values(rawEpochs).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
        ? rawEpochs as Record<string, string> : undefined
      return [{ id: receipt.id, requirementHash: receipt.request.requirementHash, evidenceFingerprint: receipt.request.evidenceFingerprint,
        ...(typeof receipt.request.turnId === 'string' ? { turnId: receipt.request.turnId } : {}),
        ...(failureEvidenceFingerprints ? { failureEvidenceFingerprints } : {}),
        failureKinds: result.failureKinds, reasons: result.reasons }]
    })
  }

  /** Prior declarations contribute progress only after the original source predicates pass again. */
  private webArtifactProgressInputs(task: TaskRun): WebArtifactEvidenceInput[] {
    const requirementHash = webArtifactRequirementHash(task)
    return this.repository.operations(task.id).flatMap(receipt => {
      if (!['web_artifact_evidence', 'web_artifact_source_gate', 'web_artifact_publication_manifest'].includes(receipt.kind) ||
        !['succeeded', 'failed'].includes(receipt.status) || receipt.fingerprint !== operationFingerprint(receipt.request) ||
        receipt.request?.requirementHash !== requirementHash) return []
      const parsed = WebArtifactEvidenceInputSchema.safeParse(receipt.request.input)
      return parsed.success ? [parsed.data] : []
    })
  }

  /** A field-only repair must be a new real typed writer, never an old draft or a claimed success flag. */
  private async currentWebArtifactFieldRepair(task: TaskRun, turnId: string, path?: string, input?: WebArtifactEvidenceInput): Promise<boolean> {
    const attempts = this.webArtifactRepairAttempts(task), latest = attempts.at(-1)
    if (!latest?.id || latest.requirementHash !== webArtifactRequirementHash(task) || !latest.failureKinds.length ||
      !latest.failureKinds.every(kind => kind.startsWith('field_evidence:')) || !deriveWebArtifactRepairState(attempts).stalled) return false
    const root = this.managedArtifactRoot(task.id), operations = this.repository.operations(task.id)
    if (!root) return false
    const lastFailure = operations.findIndex(receipt => receipt.id === latest.id)
    if (lastFailure < 0 || !operations.some((receipt, index) => index > lastFailure && receipt.kind === 'tool' && receipt.status === 'succeeded' &&
      receipt.request?.turnId === turnId && receipt.request.providerId === 'managed-artifacts' && receipt.request.toolName === 'publish_artifact')) return false
    const [thread, items] = await Promise.all([this.threadStore.get(task.threadId), this.sessionStore.loadItems(task.threadId)])
    const writes = await authorizedArtifactWrites(task, operations.filter(receipt => receipt.kind === 'tool'), thread?.turns ?? [])
    for (const manifest of [...operations].reverse()) {
      const request = manifest.request
      if (manifest.kind !== 'web_artifact_publication_manifest' || manifest.status !== 'succeeded' ||
        manifest.fingerprint !== operationFingerprint(request) || request?.requirementHash !== latest.requirementHash ||
        typeof request.path !== 'string' || path !== undefined && request.path !== path) continue
      const parsed = WebArtifactEvidenceInputSchema.safeParse(request.input)
      if (!parsed.success || input && operationFingerprint(parsed.data) !== operationFingerprint(input)) continue
      const target = resolve(root, request.path), within = relative(root, target)
      if (!within || isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\') || request.artifactPath !== target) continue
      const writerIndex = operations.findIndex(receipt => receipt.id === request.writerReceiptId), writer = operations[writerIndex]
      const write = writes.get(target)
      if (writerIndex <= lastFailure || !writer || writer.request?.turnId !== turnId || writer.request.providerId !== 'managed-artifacts' ||
        !write || write.operationId !== writer.id || write.turnId !== turnId || write.authorizedRoot !== root || write.sha256 !== request.artifactHash) continue
      try {
        const proof = await this.resolveWebArtifactPublicationManifest(task.id, turnId, request.path, manifest.idempotencyKey, write.sha256)
        if (await realpath(root) !== root || await realpath(target) !== target) continue
        const before = await lstat(target), identity = (value: Stats) => [value.dev, value.ino, value.birthtimeMs, value.size, value.mtimeMs, value.ctimeMs].join(':')
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 32 * 1024 * 1024) continue
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
          if (identity(await handle.stat()) !== identity(before)) continue
          const bytes = await handle.readFile(), after = await handle.stat()
          if (identity(after) !== identity(before) || identity(await lstat(target)) !== identity(before) || await realpath(target) !== target ||
            createHash('sha256').update(bytes).digest('hex') !== write.sha256) continue
          const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          if (assessWebArtifactEvidence(this.repository, task, items, thread?.turns ?? [], html, proof, this.nowIso()).complete) {
            const token = this.attemptTokens.get(turnId)
            if (!token || token.taskId !== task.id) return false
            this.assertToken(token)
            return true
          }
        } finally { await handle.close() }
      } catch (error) {
        if (error instanceof TaskLeaseLostError) throw error
        // Missing, changed or unauthenticated draft bytes never clear a blocker.
      }
    }
    return false
  }

  /** A rejected report write/read attempt is durable too; file changes never reset it. */
  async recordWebArtifactPublicationBlock(taskId: string, turnId: string, path: string, evidence?: WebArtifactEvidenceInput, candidate?: { html: string } | null) {
    const gate = await this.webArtifactPublicationGate(taskId, turnId, path, evidence, candidate)
    if (!gate || gate.ready) return gate
    const task = this.repository.get(taskId)!, artifactPath = resolve(this.managedArtifactRoot(taskId)!, path)
    const attempts = this.webArtifactRepairAttempts(task)
    if (gate.stalled && attempts.some(attempt => attempt.turnId === turnId)) return gate
    const failureKinds = gate.stalled && attempts.length ? [...attempts.at(-1)!.failureKinds] : [
      ...(gate.reportManifestRequired ? ['source_manifest_required'] : []),
      ...gate.missingOrigins.map(origin => `source_origin:${origin}`).sort(),
      ...(!gate.reportManifestRequired && !gate.missingOrigins.length ? ['source_read_required'] : [])
    ]
    const request = { artifactPath, requirementHash: gate.requirementHash, evidenceFingerprint: gate.evidenceFingerprint, turnId,
      failureEvidenceFingerprints: gate.failureEvidenceFingerprints,
      ...(evidence ? { input: evidence } : {}) }
    const key = `web-source-gate:${turnId}:${operationFingerprint(request)}:${attempts.length}`
    const receipt = this.repository.beginOperation({ ownerId: taskId, kind: 'web_artifact_source_gate', idempotencyKey: key, request, nowIso: this.nowIso() }).receipt
    const semanticRepair = deriveWebArtifactRepairState(attempts, { id: receipt.id, requirementHash: gate.requirementHash,
      evidenceFingerprint: gate.evidenceFingerprint, failureEvidenceFingerprints: gate.failureEvidenceFingerprints, failureKinds, reasons: gate.reasons })
    this.repository.finishOperation(taskId, key, { status: 'failed', result: { complete: false, failureKinds, reasons: gate.reasons, semanticRepair } }, this.nowIso())
    return { ...gate, stalled: semanticRepair.stalled, code: semanticRepair.stalled ? 'web_artifact_repair_stalled' : gate.code, semanticRepair }
  }

  /** Source-first publication gate; only task-owned receipts can establish progress. */
  async webArtifactPublicationGate(taskId: string, turnId: string, path: string, evidence?: WebArtifactEvidenceInput, candidate?: { html: string } | null) {
    const task = this.repository.get(taskId)
    if (!task?.acceptance.requiresWebEvidence || !/\.html?$/i.test(path)) return null
    const token = this.attemptTokens.get(turnId)
    if (!token || token.taskId !== taskId || task.activeTurnId !== turnId || task.status !== 'running') throw Object.assign(new Error('Active task execution is required.'), { code: 'execution_grant_scope' })
    this.assertToken(token)
    const artifactPath = resolve(this.managedArtifactRoot(taskId)!, path), requirementHash = webArtifactRequirementHash(task)
    const records = this.repository.operations(taskId).filter(receipt => ['web_artifact_evidence', 'web_artifact_source_gate'].includes(receipt.kind))
    const priorInput = [...records].reverse().find(receipt => receipt.kind === 'web_artifact_evidence' && receipt.request?.input && receipt.fingerprint === operationFingerprint(receipt.request) &&
      receipt.request?.artifactPath === artifactPath && receipt.request.requirementHash === requirementHash)?.request?.input
    const parsed = WebArtifactEvidenceInputSchema.safeParse(priorInput)
    const [thread, items] = await Promise.all([this.threadStore.get(task.threadId), this.sessionStore.loadItems(task.threadId)])
    this.assertToken(token)
    const grant = thread?.turns.find(turn => turn.id === turnId)?.executionGrant
    const effectiveEvidence = evidence ?? (parsed.success ? parsed.data : undefined)
    const sourceGate = webArtifactPublicationReadiness(this.repository, task, items, thread?.turns ?? [], effectiveEvidence, grant?.browserScope?.origins ?? [], this.webArtifactProgressInputs(task))
    const attempts = this.webArtifactRepairAttempts(task), latest = attempts.at(-1)
    const semanticRepair = latest ? deriveWebArtifactRepairState(attempts, undefined, { requirementHash,
      evidenceFingerprint: sourceGate.evidenceFingerprint, failureEvidenceFingerprints: sourceGate.failureEvidenceFingerprints }) : undefined
    let stalled = semanticRepair?.stalled === true
    if (stalled && sourceGate.ready && latest?.failureKinds.length && latest.failureKinds.every(kind => kind.startsWith('field_evidence:'))) {
      if (candidate && evidence?.path === path && assessWebArtifactEvidence(this.repository, task, items, thread?.turns ?? [], candidate.html, evidence, this.nowIso()).complete) stalled = false
      else if (candidate === undefined && await this.currentWebArtifactFieldRepair(task, turnId, path, effectiveEvidence)) stalled = false
      this.assertToken(token)
    }
    return { ...sourceGate, ready: sourceGate.ready && !stalled, stalled, requirementHash,
      code: stalled ? 'web_artifact_repair_stalled' : sourceGate.ready ? undefined : 'web_source_reads_required',
      reasons: stalled ? semanticRepair!.reasons : sourceGate.ready ? [] : sourceGate.missingOrigins.length
        ? sourceGate.missingOrigins.map(origin => `${task.acceptance.webEvidenceBasis === 'observed_feed' ? '订阅列表记录尚未核验' : '正式公告正文尚未核验'}：${origin}`) : [task.acceptance.webEvidenceBasis === 'observed_feed' ? '尚缺可信的完整列表或单记录读取；加载/空DOM/截断不代表零条。' : '尚缺可信的完整正文来源读取或实际零匹配页面。'],
      ...(semanticRepair ? { semanticRepair } : {}) }
  }

  /** Trusted query for AgentLoop; tool/MCP output cannot manufacture this blocker. */
  async webArtifactProgressBlock(threadId: string, turnId: string) {
    const task = this.repository.findActiveByThread(threadId)
    if (!task || task.activeTurnId !== turnId || task.status !== 'running' || task.acceptance.kind !== 'files' || !task.acceptance.requiresWebEvidence) return null
    if (await this.currentWebArtifactFieldRepair(task, turnId)) return null
    const paths = [...new Set(this.repository.operations(task.id).filter(receipt => ['web_artifact_evidence', 'web_artifact_source_gate'].includes(receipt.kind)).map(receipt => receipt.request?.artifactPath)
      .filter((path): path is string => typeof path === 'string').map(path => relative(this.managedArtifactRoot(task.id)!, path)))]
    for (const path of paths.reverse()) {
      const gate = await this.webArtifactPublicationGate(task.id, turnId, path)
      if (gate?.stalled) return gate
    }
    if (!task.acceptance.requiredFormats?.some(format => ['html', 'htm'].includes(format)) && !task.artifacts.some(file => /\.html?$/i.test(file.relativePath))) return null
    const gate = await this.webArtifactPublicationGate(task.id, turnId, paths[0] ?? 'report.html')
    return gate && !gate.ready ? gate : null
  }

  /** Stop only the exact persisted semantic stall, preserving every draft and original failure. */
  async suspendWebArtifactProgress(threadId: string, turnId: string): Promise<Extract<TaskCandidateDecision, { kind: 'waiting_user' }> | null> {
    const egoWait = await this.suspendEgoBrowserPermission(threadId, turnId)
    if (egoWait) return egoWait
    const block = await this.webArtifactProgressBlock(threadId, turnId)
    if (!block?.stalled) return null
    const task = this.repository.findActiveByThread(threadId), token = this.attemptTokens.get(turnId)
    if (!task || task.activeTurnId !== turnId || task.status !== 'running' || !token || token.taskId !== task.id) return null
    // A user-authorized new Turn may read and repair the old deficit. Its first
    // still-invalid publication/verification is recorded above and stops it;
    // the old count and every old failure remain intact throughout.
    if (!this.webArtifactRepairAttempts(task).some(attempt => attempt.turnId === turnId)) return null
    this.assertToken(token)
    const fingerprint = `web-artifact-repair:${block.semanticRepair!.fingerprint}`
    const reason = `相同来源或字段问题在一次修复后仍未解决，已停止重复发布；已有草稿和原始核验记录已保留。${block.reasons.join('；')}`
    return this.repository.transact(() => {
      const result = this.waitForUser(task, reason, task.finalResponse ?? '', fingerprint, turnId)
      const id = `web_evidence_${task.id}`, prior = this.repository.attention(id), now = this.nowIso()
      this.repository.putAttention({ id, ownerKind: 'task', ownerId: task.id, taskId: task.id, threadId: task.originThreadId ?? task.threadId,
        workspaceRoot: task.workspaceRoot, kind: 'blocked', title: '网页来源核验需要处理', message: reason, status: 'pending',
        revision: (prior?.revision ?? -1) + 1, createdAt: prior?.createdAt ?? now, updatedAt: now,
        payload: { kind: 'web_artifact_repair_stalled', code: block.code, reasons: block.reasons, missingOrigins: block.missingOrigins,
          nextReads: block.nextReads, fingerprint: block.semanticRepair!.fingerprint } })
      return result
    })
  }

  /** Consume only a provider's task-owned wait after its actual Host result is durable.
   * The provider must not release this attempt while execute() is still in flight. */
  private async suspendEgoBrowserPermission(threadId: string, turnId: string): Promise<Extract<TaskCandidateDecision, { kind: 'waiting_user' }> | null> {
    const task = this.repository.findActiveByThread(threadId), token = this.attemptTokens.get(turnId)
    if (!task || task.status !== 'running' || task.activeTurnId !== turnId || !token || token.taskId !== task.id) return null
    const wait = this.repository.operation(task.id, `ego-wait:${turnId}`)
    const request = wait?.request, result = wait?.result as { code?: string; message?: string } | undefined
    if (!wait || wait.kind !== 'ego_browser_wait' || wait.status !== 'succeeded' || wait.fingerprint !== operationFingerprint(request) ||
      request?.taskId !== task.id || request.turnId !== turnId || !(EGO_PERMISSION_CODES as readonly unknown[]).includes(request.code) ||
      result?.code !== request.code || typeof request.hostOperationId !== 'string') return null
    const host = this.repository.operationById(task.id, request.hostOperationId, 'tool'), original = host?.request
    const saved = host?.result as ToolHostResult | undefined, item = saved?.item
    const grant = ExecutionGrantSchema.safeParse(original?.executionGrant)
    if (!host || host.status !== 'failed' || host.fingerprint !== operationFingerprint(original) || original?.dispatchTracking !== 'host-v1' ||
      original.providerId !== 'ego-browser' || original.callId !== request.callId || original.turnId !== turnId || original.executionId !== token.executionId ||
      !grant.success || grant.data.taskId !== task.id || grant.data.threadId !== threadId || grant.data.turnId !== turnId ||
      operationFingerprint(grant.data) !== request.grantFingerprint || grant.data.browserScope?.provider !== 'ego-browser' ||
      typeof request.configurationFingerprint !== 'string' || request.configurationFingerprint !== grant.data.connectorIdentityFingerprints?.['ego-browser'] ||
      grant.data.allowedProviderIds && !grant.data.allowedProviderIds.includes('ego-browser') || !item || item.kind !== 'tool_result' || !item.isError ||
      item.callId !== original.callId || item.toolName !== original.toolName || item.turnId !== turnId || item.threadId !== threadId ||
      !item.output || typeof item.output !== 'object' || (item.output as Record<string, unknown>).code !== request.code ||
      (item.output as Record<string, unknown>).status === 'outcome_unknown' || this.unknownToolOutcomes(task.id).length) return null
    const [thread, items] = await Promise.all([this.threadStore.get(threadId), this.sessionStore.loadItems(threadId)])
    if (operationFingerprint(thread?.turns.find(turn => turn.id === turnId)?.executionGrant) !== request.grantFingerprint ||
      !items.some(actual => actual.id === item.id && operationFingerprint(actual) === operationFingerprint(item))) return null
    this.assertToken(token)
    const failure = { code: String(request.code), message: typeof result?.message === 'string' ? result.message : String(request.code) }
    return this.waitForCapability(task, turnId, taskPermissionCapability(failure, task, this.nowIso()), failure.code)
  }

  /** Seal an exact typed manifest only for the real in-flight built-in writer. No URL is sent through generic output redaction. */
  async recordWebArtifactPublicationManifest(taskId: string, turnId: string, path: string, artifactHash: string, input: WebArtifactEvidenceInput, args: Record<string, unknown>, hostOperation?: CurrentToolOperation) {
    const token = this.attemptTokens.get(turnId), task = this.repository.get(taskId)
    if (!task || !token || token.taskId !== taskId || task.activeTurnId !== turnId || task.status !== 'running') throw Object.assign(new Error('Active task execution is required.'), { code: 'execution_grant_scope' })
    this.assertToken(token)
    const normalized = WebArtifactEvidenceInputSchema.parse(input), artifactPath = resolve(this.managedArtifactRoot(taskId)!, path)
    if (normalized.path !== path || !/^[a-f0-9]{64}$/.test(artifactHash)) throw Object.assign(new Error('Publication manifest path or hash does not match its writer.'), { code: 'artifact_manifest_scope' })
    const report = args.report && typeof args.report === 'object' ? args.report as Record<string, unknown> : undefined
    const proposed = WebArtifactEvidenceInputSchema.safeParse({ path, ...(report?.evidence && typeof report.evidence === 'object' ? report.evidence : {}) })
    if (!proposed.success || operationFingerprint(proposed.data) !== operationFingerprint(normalized)) throw Object.assign(new Error('Publication manifest differs from the real writer arguments.'), { code: 'artifact_manifest_scope' })
    const writer = hostOperation && this.repository.operation(taskId, hostOperation.idempotencyKey)
    if (!hostOperation || !writer || writer.id !== hostOperation.operationId || writer.kind !== 'tool' || !['prepared', 'running'].includes(writer.status) ||
      writer.fingerprint !== operationFingerprint(writer.request) || writer.request?.dispatchTracking !== 'host-v1' || writer.request.toolName !== 'publish_artifact' ||
      writer.request.providerId !== 'managed-artifacts' || writer.request.turnId !== turnId || writer.request.executionId !== token.executionId ||
      writer.request.argumentsHash !== operationFingerprint(args) || hostOperation.taskId !== taskId || hostOperation.turnId !== turnId ||
      hostOperation.executionId !== token.executionId || hostOperation.argumentsHash !== writer.request.argumentsHash ||
      hostOperation.executionGrantFingerprint !== operationFingerprint(writer.request.executionGrant)) {
      throw Object.assign(new Error('Publication manifest requires the actual managed-artifacts Host invocation.'), { code: 'artifact_manifest_writer_required' })
    }
    const [thread, items] = await Promise.all([this.threadStore.get(task.threadId), this.sessionStore.loadItems(task.threadId)])
    this.assertToken(token)
    const sourceProof = webArtifactManifestSourceProof(this.repository, task, items, thread?.turns ?? [], normalized)
    const inputHash = operationFingerprint(normalized), request = { taskId, threadId: task.threadId, path, artifactPath, artifactHash, inputHash,
      writerReceiptId: writer.id, requirementHash: webArtifactRequirementHash(task), input: normalized, sourceProof }
    const manifestRef = `web-manifest:${operationFingerprint(request)}`
    this.repository.beginOperation({ ownerId: taskId, kind: 'web_artifact_publication_manifest', idempotencyKey: manifestRef, request, nowIso: this.nowIso() })
    this.repository.finishOperation(taskId, manifestRef, { status: 'succeeded', result: { sealed: true, inputHash, artifactHash } }, this.nowIso())
    return { verificationInput: { path, manifestRef }, verificationInputHash: inputHash }
  }

  /** Restore exact URL identity from a private sealed manifest, including across a legitimate later Turn/restart. */
  async resolveWebArtifactPublicationManifest(taskId: string, turnId: string, path: string, manifestRef: string, artifactHash: string): Promise<WebArtifactEvidenceInput> {
    const token = this.attemptTokens.get(turnId), task = this.repository.get(taskId)
    if (!task || !token || token.taskId !== taskId || task.activeTurnId !== turnId || task.status !== 'running') throw Object.assign(new Error('Active task execution is required.'), { code: 'execution_grant_scope' })
    this.assertToken(token)
    const fail = (): never => { throw Object.assign(new Error('发布清单不属于当前任务、原文件字节或可信来源。'), { code: 'artifact_manifest_scope' }) }
    if (!/^web-manifest:[a-f0-9]{64}$/.test(manifestRef)) fail()
    const receipt = this.repository.operation(taskId, manifestRef), request = receipt?.request
    const sealed = receipt?.result as { sealed?: unknown; inputHash?: unknown; artifactHash?: unknown } | undefined
    if (!receipt || receipt.kind !== 'web_artifact_publication_manifest' || receipt.status !== 'succeeded' || receipt.fingerprint !== operationFingerprint(request) ||
      manifestRef !== `web-manifest:${operationFingerprint(request)}` || request?.taskId !== taskId || request.threadId !== task.threadId || request.path !== path ||
      request.artifactPath !== resolve(this.managedArtifactRoot(taskId)!, path) || request.artifactHash !== artifactHash || request.requirementHash !== webArtifactRequirementHash(task) ||
      sealed?.sealed !== true || sealed.inputHash !== request.inputHash || sealed.artifactHash !== artifactHash) fail()
    const input = WebArtifactEvidenceInputSchema.parse(request!.input)
    if (input.path !== path || operationFingerprint(input) !== request!.inputHash) fail()
    const [thread, items] = await Promise.all([this.threadStore.get(task.threadId), this.sessionStore.loadItems(task.threadId)])
    this.assertToken(token)
    const currentGrant = ExecutionGrantSchema.safeParse(thread?.turns.find(turn => turn.id === turnId)?.executionGrant)
    if (!currentGrant.success || currentGrant.data.taskId !== taskId || currentGrant.data.threadId !== task.threadId || currentGrant.data.turnId !== turnId ||
      currentGrant.data.managedArtifactRoot !== this.managedArtifactRoot(taskId) || Date.parse(currentGrant.data.issuedAt) > Date.parse(this.nowIso()) ||
      (currentGrant.data.expiresAt && Date.parse(currentGrant.data.expiresAt) <= Date.parse(this.nowIso())) ||
      (currentGrant.data.allowedToolNames && !currentGrant.data.allowedToolNames.includes('verify_web_artifact'))) fail()
    const writes = await authorizedArtifactWrites(task, this.repository.operations(taskId, 'tool'), thread?.turns ?? [])
    this.assertToken(token)
    const writer = writes.get(String(request!.artifactPath))
    if (!writer || writer.operationId !== request!.writerReceiptId || writer.sha256 !== artifactHash || writer.authorizedRoot !== this.managedArtifactRoot(taskId)) fail()
    const writerReceipt = this.repository.operations(taskId, 'tool').find(row => row.id === writer!.operationId)
    if (!writerReceipt || writerReceipt.fingerprint !== operationFingerprint(writerReceipt.request) || writerReceipt.request?.providerId !== 'managed-artifacts') fail()
    const sourceProof = webArtifactManifestSourceProof(this.repository, task, items, thread?.turns ?? [], input)
    if (operationFingerprint(sourceProof) !== operationFingerprint(request!.sourceProof)) fail()
    return input
  }

  async verifyWebArtifact(taskId: string, turnId: string, artifactPath: string, artifactHash: string, html: string, input: WebArtifactEvidenceInput) {
    const token = this.attemptTokens.get(turnId)
    if (!token || token.taskId !== taskId) throw Object.assign(new Error('Active task execution is required.'), { code: 'execution_grant_scope' })
    this.assertToken(token)
    const task = this.repository.get(taskId)!
    const [thread, items] = await Promise.all([this.threadStore.get(task.threadId), this.sessionStore.loadItems(task.threadId)])
    const writes = await authorizedArtifactWrites(task, this.repository.operations(task.id, 'tool'), thread?.turns ?? [])
    this.assertToken(token)
    const write = writes.get(artifactPath)
    if (!write || write.sha256 !== artifactHash || createHash('sha256').update(html).digest('hex') !== artifactHash) throw Object.assign(new Error('The exact artifact has no matching successful writer receipt.'), { code: 'artifact_write_proof_required' })
    const assessment = assessWebArtifactEvidence(this.repository, task, items, thread?.turns ?? [], html, input, this.nowIso())
    const sourceGate = webArtifactPublicationReadiness(this.repository, task, items, thread?.turns ?? [], input,
      thread?.turns.find(turn => turn.id === turnId)?.executionGrant?.browserScope?.origins ?? [], this.webArtifactProgressInputs(task))
    const request = { artifactPath, artifactHash, writerReceiptId: write.operationId, turnId, requirementHash: webArtifactRequirementHash(task), input,
      sourceReceiptIds: assessment.sourceReceipts.map(source => source.receiptId).sort(), evidenceFingerprint: sourceGate.evidenceFingerprint,
      failureEvidenceFingerprints: sourceGate.failureEvidenceFingerprints }
    const key = `web-artifact-evidence:${operationFingerprint(request)}`
    const receipt = this.repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'web_artifact_evidence', request, nowIso: this.nowIso() }).receipt
    const failureKinds = webArtifactFailureKinds(assessment.reasons)
    const semanticRepair = deriveWebArtifactRepairState(this.webArtifactRepairAttempts(task), {
      id: receipt.id, requirementHash: request.requirementHash, evidenceFingerprint: sourceGate.evidenceFingerprint,
      failureEvidenceFingerprints: sourceGate.failureEvidenceFingerprints, failureKinds, reasons: assessment.reasons })
    const result = { ...assessment, artifactHash, evidenceReceiptId: receipt.id, sourceGate, failureKinds, semanticRepair,
      ...(assessment.complete ? {} : { code: semanticRepair.stalled ? 'web_artifact_repair_stalled' : 'web_artifact_evidence_incomplete', repair: webEvidenceRepair(task) }) }
    this.repository.finishOperation(task.id, key, { status: assessment.complete ? 'succeeded' : 'failed', result }, this.nowIso())
    return result
  }

  /** Pure pre-cleanup check: no model, Task transition, receipt write or validation span. */
  async egoFinishReadiness(taskId: string, turnId: string, hostOperationId?: string): Promise<{ ready: boolean; reason?: string }> {
    const task = this.repository.get(taskId), token = this.attemptTokens.get(turnId)
    const denied = (reason: string) => ({ ready: false, reason })
    if (!task || task.status !== 'running' || task.activeTurnId !== turnId || !token || token.taskId !== taskId) return denied('原任务当前没有有效执行轮次。')
    this.assertToken(token)
    const [thread, items] = await Promise.all([this.threadStore.get(task.threadId), this.sessionStore.loadItems(task.threadId)])
    const turn = thread?.turns.find(candidate => candidate.id === turnId), grant = turn?.executionGrant
    const binding = this.repository.operation(taskId, 'ego-task-space')
    if (grant?.browserScope?.provider !== 'ego-browser' || !binding || binding.kind !== 'ego_task_space' || binding.status !== 'succeeded' ||
      binding.fingerprint !== operationFingerprint(binding.request) || binding.request?.taskId !== taskId ||
      binding.request.configurationFingerprint !== grant.connectorIdentityFingerprints?.['ego-browser']) return denied('原Ego任务空间尚无匹配的可信身份。')
    if (hostOperationId) {
      const host = this.repository.operationById(taskId, hostOperationId, 'tool')
      if (!host || !['prepared', 'running'].includes(host.status) || host.request?.providerId !== 'ego-browser' || host.request.toolName !== 'ego_browser_finish' ||
        host.request.turnId !== turnId || host.request.executionId !== token.executionId || operationFingerprint(host.request.executionGrant) !== operationFingerprint(grant)) return denied('清理请求不是当前真实Host调用。')
    }
    if (this.repository.unsettledOperations(taskId).some(row => row.id !== hostOperationId && ['tool', 'ego_task_space', 'ego_task_space_finish'].includes(row.kind)) ||
      this.unknownToolOutcomes(taskId).length || this.repository.operations(taskId, 'ego_browser_wait').some(row => row.request?.turnId === turnId)) return denied('原操作或用户控制状态尚未核验，不能清理空间。')
    const reads = items.filter(item => item.kind === 'tool_result' && /^ego_browser_(?:open|read|next_page)$/.test(item.toolName) && !item.isError)
    const hasRead = reads.some(item => {
      if (item.kind !== 'tool_result' || !item.output || typeof item.output !== 'object') return false
      const original = thread?.turns.find(candidate => candidate.id === item.turnId)?.executionGrant
      return Boolean(original && validEgoDocumentEvidence(this.repository, task, item.output as Record<string, unknown>, original))
    })
    if (!hasRead) return denied('尚缺本任务真实Ego来源读取，不能把未读取空间当成功清理。')
    const blocked = this.completionGuard?.({ thread: thread ?? undefined, turn, task })
    if (blocked) return denied(blocked.reason)
    if (task.acceptance.kind === 'files') {
      const taskTurns = new Set(this.repository.execution.attempts(taskId).map(attempt => attempt.turnId)); taskTurns.add(turnId)
      const artifacts = await this.collectArtifacts(task, items.filter(item => taskTurns.has(item.turnId)), turnId, undefined, false)
      const writes = await authorizedArtifactWrites(task, this.repository.operations(taskId, 'tool'), thread?.turns ?? [])
      const valid = artifacts.filter(artifact => {
        if (artifact.validation !== 'valid' || task.acceptance.requiredFormats?.length && !task.acceptance.requiredFormats.includes(artifact.format ?? '')) return false
        const writer = writes.get(artifact.absolutePath ?? resolve(task.workspaceRoot, artifact.relativePath))
        if (!writer || writer.sha256 !== artifact.sha256) return false
        return !task.acceptance.requiresWebEvidence || !['html', 'htm'].includes(artifact.format ?? '') || Boolean(verifiedWebArtifactEvidence(this.repository, task, artifact, writer.operationId))
      })
      if (valid.length < (task.acceptance.minimumArtifacts ?? 1)) return denied('先保存并读回当前成果，完成真实来源核验后，再结束Ego任务空间。')
    }
    if ((task.acceptance.effect || task.acceptance.kind === 'effect' || task.acceptance.requiresExternalEffects) && !this.verifiedTaskEffects(task).length) return denied('外部事项尚未取得要求的真实回执。')
    this.assertToken(token)
    return { ready: true }
  }

  async assessCandidate(threadId: string, turnId: string): Promise<TaskCandidateDecision> {
    let task = this.repository.findActiveByThread(threadId)
    if (!task) {
      throw Object.assign(new Error(`active task not found for thread ${threadId}`), { code: 'not_found' })
    }
    if (task.status === 'paused') return { kind: 'waiting_user', task, reason: task.waitingReason ?? '任务已暂停。' }
    await this.reconcileHostShell?.(task.id)
    task = this.repository.get(task.id)!
    const hostShell = this.hostShellState(task)
    const unsettled = [...this.repository.unsettledOperations(task.id).filter(operation => operation.kind === 'tool'), ...hostShell.unknown]
    const [thread, items] = await Promise.all([
      this.threadStore.get(threadId),
      this.sessionStore.loadItems(threadId)
    ])
    const capturedToken = this.attemptTokens.get(turnId)
    if (capturedToken) this.assertToken(capturedToken)
    const taskTurns = new Set(this.repository.execution.attempts(task.id).map(attempt => attempt.turnId))
    taskTurns.add(turnId)
    let artifacts = task.acceptance.kind === 'files'
      ? await this.collectArtifacts(task, items.filter(item => taskTurns.has(item.turnId)), turnId)
      : task.artifacts
    if (task.acceptance.requiresWebEvidence && task.acceptance.kind === 'files') {
      const writes = await authorizedArtifactWrites(task, this.repository.operations(task.id, 'tool'), thread?.turns ?? [])
      const artifactTask = task
      artifacts = artifacts.map(artifact => {
        if (!['html', 'htm'].includes(artifact.format ?? '')) return artifact
        const writer = writes.get(artifact.absolutePath ?? resolve(artifactTask.workspaceRoot, artifact.relativePath))
        const proof = writer && artifact.validation === 'valid' && writer.sha256 === artifact.sha256 ? verifiedWebArtifactEvidence(this.repository, artifactTask, artifact, writer.operationId) : undefined
        const { sourceEvidenceReceiptId: _prior, ...saved } = artifact
        return { ...saved, sourceEvidenceStatus: proof ? 'verified' as const : 'draft' as const, ...(proof ? { sourceEvidenceReceiptId: proof.id } : {}) }
      })
    }
    if (JSON.stringify(artifacts) !== JSON.stringify(task.artifacts)) {
      task = this.updateExecution(task.id, task.revision, current => ({ ...current, artifacts, updatedAt: this.nowIso() }))
    }
    if (unsettled.length) return this.stallUnknown(task, unsettled.map(operation => operation.id))
    if (this.repository.operations(task.id, 'browser_action_dispatch').some(receipt => receipt.status === 'succeeded' && (receipt.result as { readbackPending?: boolean } | undefined)?.readbackPending === true)) {
      return this.waitForCapability(task, turnId, browserRecoveryCapability('browser_readback_blocked', this.nowIso()), 'browser_readback_blocked')
    }
    const permissionBlock = this.waitForToolPermission(task, items.filter(item => item.turnId === turnId), turnId, thread?.turns.find(candidate => candidate.id === turnId)?.executionGrant)
    if (permissionBlock) return permissionBlock
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
    if (task.acceptance.requiresWebEvidence) {
      const origins = new Set<string>()
      const reads = this.repository.operations(task.id, 'tool').filter(receipt => receipt.status === 'succeeded')
      for (const item of items) {
        if (!taskTurns.has(item.turnId) || item.kind !== 'tool_result' || item.isError || !item.output || typeof item.output !== 'object') continue
        if (!reads.some(receipt => receipt.request?.callId === item.callId && receipt.request?.turnId === item.turnId && receipt.request?.toolName === item.toolName)) continue
        const output = item.output as Record<string, unknown>
        const evidence = output.evidence && typeof output.evidence === 'object' ? output.evidence as Record<string,unknown> : {}
        const egoGrant = thread?.turns.find(candidate => candidate.id === item.turnId)?.executionGrant
        const egoSource = /^ego_browser_(?:open|read|next_page)$/.test(item.toolName) && egoGrant && validEgoDocumentEvidence(this.repository, task, output, egoGrant)
        const source = egoSource ? output.sourceUrl : item.toolName === 'web_fetch' && typeof output.text === 'string' && output.text.trim()
          ? output.finalUrl ?? output.url
          : /^browser_(?:navigate|observe|get_html|read|extract)$/.test(item.toolName) && output.status === 'succeeded' && evidence.verified === true && evidence.contentRead === true && typeof output.resultHash === 'string'
            ? output.sourceUrl : undefined
        if (typeof source === 'string') { try { const url = new URL(source); if (['http:', 'https:'].includes(url.protocol)) origins.add(url.origin) } catch { /* Invalid source metadata is not evidence. */ } }
      }
      const missing = task.acceptance.requiredSourceOrigins?.filter(origin => !origins.has(origin)) ?? []
      if (!origins.size || missing.length) return this.retry(task, `网页采集尚缺实际正文来源证据${missing.length ? `（${missing.join('、')}）` : ''}，请使用已授权浏览器或网页读取工具核验后交付。`, `web-evidence:${[...origins].sort().join(',')}:${missing.join(',')}`, turnId)
    }
    if (task.acceptance.requiresWebEvidence && task.acceptance.kind === 'files' && (task.acceptance.requiredFormats?.some(format => ['html', 'htm'].includes(format)) || artifacts.some(artifact => ['html', 'htm'].includes(artifact.format ?? '')))) {
      const html = artifacts.filter(artifact => artifact.validation === 'valid' && ['html', 'htm'].includes(artifact.format ?? ''))
      const verified = html.some(artifact => artifact.sourceEvidenceStatus === 'verified')
      if (!verified) return this.retry(task, webEvidenceRepair(task), `web-artifact-evidence:${webArtifactRequirementHash(task)}:${html.map(artifact => artifact.sha256).join(',')}`, turnId)
    }
    if (task.templateId) {
      const delivery = verifyTaskDelivery(this.repository,task)
      if (!delivery.complete) return this.waitForUser(task,delivery.reasons.join('；'),finalResponse,`delivery:${task.revision}`,turnId)
    }

    if (task.acceptance.effect || task.acceptance.kind === 'effect' || task.acceptance.requiresExternalEffects) {
      const evidence = this.verifiedTaskEffects(task)
      const succeeded = evidence.length > 0
      if (!succeeded) {
        const failed = this.repository.operations(task.id, 'tool').reverse().find(receipt => {
          if (receipt.status !== 'failed' || receipt.request?.turnId !== turnId) return false
          const effect = this.resolveToolEffect(String(receipt.request.toolName ?? ''))
          return effect && receipt.request.provider === effect.provider && receipt.request.operation === effect.operation
        })
        if (failed) {
          const output = (failed.result as ToolHostResult | undefined)?.item
          const error = output?.kind === 'tool_result'
            ? output.output as { code?: unknown; data?: { code?: unknown } } | undefined : undefined
          const code = error?.data?.code ?? error?.code
          const reason = typeof code === 'string' && /^[a-z_][a-z0-9_]{0,79}$/.test(code)
            ? `外部操作执行失败（${code}）。请查看操作回执，解决失败原因后继续原任务。`
            : '外部操作执行失败。请查看操作回执，解决失败原因后继续原任务。'
          return this.waitForUser(task, reason, finalResponse, `effect-failed:${failed.id}`, turnId)
        }
        return this.waitForUser(
          task,
          '外部操作尚无完整、已确认的目标集合及逐项验证回执。请补充执行平台和具体目标，并核验每项操作结果。',
          finalResponse,
          `effect-receipt:${task.revision}`,
          turnId
        )
      }
    }

    if (task.acceptance.kind === 'files') {
      const validArtifacts = artifacts.filter((artifact) => artifact.validation === 'valid' && (!task.acceptance.requiresWebEvidence || !['html', 'htm'].includes(artifact.format ?? '') || artifact.sourceEvidenceStatus === 'verified') && (!task.acceptance.requiredFormats?.length || task.acceptance.requiredFormats.includes(artifact.format ?? '')))
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

    const egoBinding = this.repository.operation(task.id, 'ego-task-space')
    if (egoBinding) {
      const pendingFinish = this.repository.operations(task.id, 'ego_task_space_finish').filter(row => ['prepared', 'running', 'outcome_unknown'].includes(row.status))
      if (pendingFinish.length) return this.stallUnknown(task, pendingFinish.map(row => row.id))
      if (!verifiedEgoTaskSpaceFinish(this.repository, task, items, thread?.turns ?? [])) return this.retry(task,
        '成果及已请求计划已核验；请调用 ego_browser_finish 结束本任务的原Ego空间，再给出最终交付回复。不要在错误或用户接管时清理，也不要另建空间。',
        `ego-finish:${egoBinding.id}`, turnId)
    }

    const now = this.nowIso()
    const completed = this.updateExecution(task.id, task.revision, (current) => ({
      ...current,
      status: 'completed',
      waitingReason: undefined,
      stalledReason: undefined,
      finalResponse,
      ...((task.acceptance.effect || task.acceptance.kind === 'effect' || artifacts.some(artifact => artifact.sourceEvidenceStatus === 'verified')) ? { resultEvidence: [...this.verifiedTaskEffects(task), ...artifacts.filter(artifact => artifact.sourceEvidenceStatus === 'verified').map(artifact => ({ kind: 'file' as const, provider: 'managed-artifacts', operation: 'verify_web_artifact', target: artifact.absolutePath ?? artifact.relativePath, status: 'source_verified', verified: true, verifiedAt: now, resultHash: artifact.sha256!, targetVersion: artifact.sha256, sourceVersion: artifact.sourceEvidenceReceiptId }))] } : {}),
      artifacts,
      noProgressCount: 0,
      nodes: current.nodes.map((node) => ({
        ...node,
        status: 'completed',
        finishedAt: now,
        evidence: [...new Set([...node.evidence, ...(artifacts.filter(artifact => !task.acceptance.requiresWebEvidence || !['html', 'htm'].includes(artifact.format ?? '') || artifact.sourceEvidenceStatus === 'verified').map((artifact) => artifact.relativePath))])],
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
    if (task.status === 'paused') return { kind: 'waiting_user', task, reason: task.waitingReason ?? '任务已暂停。' }
    const unknown = this.suspendUnknownToolOutcome(threadId, turnId)
    if (unknown) return unknown
    const thread = await this.threadStore.get(threadId)
    const turn = thread?.turns.find(candidate => candidate.id === turnId)
    const items = (await this.sessionStore.loadItems(threadId)).filter(item => item.turnId === turnId)
    const permissionBlock = this.waitForToolPermission(task, items, turnId, turn?.executionGrant)
    if (permissionBlock) return permissionBlock
    const blocked = this.completionGuard?.({ thread: thread ?? undefined, turn, task })
    if (blocked?.retryable !== false) return null
    return this.waitForUser(task, blocked.reason, latestAssistantText(turn, items), blocked.fingerprint, turnId)
  }

  private unknownToolOutcomes(taskId: string): OperationReceipt[] {
    return this.repository.unsettledOperations(taskId).filter(operation => operation.kind === 'tool' && operation.status === 'outcome_unknown')
  }

  /** Only trusted, persisted receipts fence the current task; tool prose cannot do so. */
  hasUnknownToolOutcome(threadId: string, turnId: string): boolean {
    const task = this.repository.findActiveByThread(threadId)
    return Boolean(task?.activeTurnId === turnId && this.unknownToolOutcomes(task.id).length)
  }

  suspendUnknownToolOutcome(threadId: string, turnId: string): TaskCandidateDecision | null {
    const task = this.repository.findActiveByThread(threadId)
    if (!task || task.activeTurnId !== turnId) return null
    const operations = this.unknownToolOutcomes(task.id)
    if (!operations.length) return null
    if (task.status === 'paused') return { kind: 'waiting_user', task, reason: task.waitingReason ?? '任务已暂停。' }
    const ids = operations.map(operation => operation.id)
    const prior = this.repository.attention(`unknown_${task.id}`)
    if (task.status === 'stalled' && prior?.status === 'pending' && JSON.stringify(prior.payload?.operationIds) === JSON.stringify(ids)) {
      return { kind: 'stalled', task, reason: task.stalledReason ?? prior.message }
    }
    return this.stallUnknown(task, ids)
  }

  blockTaskPermission(threadId: string, turnId: string, error: unknown): TaskCandidateDecision | null {
    const failure = taskPermissionFailure(error)
    const task = this.repository.findActiveByThread(threadId)
    if (!failure || !task || task.activeTurnId !== turnId) return null
    if (task.status === 'paused') return { kind: 'waiting_user', task, reason: task.waitingReason ?? failure.message }
    const unknown = this.suspendUnknownToolOutcome(threadId, turnId)
    if (unknown) return unknown
    return this.waitForCapability(task, turnId, taskPermissionCapability(failure,task,this.nowIso()), failure.code)
  }

  private waitForToolPermission(task: TaskRun, items: TurnItem[], turnId: string, currentGrant?: ExecutionGrant): Extract<TaskCandidateDecision, { kind: 'waiting_user' }> | null {
    const denied = [...items].reverse().find(item => item.kind === 'tool_result' && item.isError && item.output && typeof item.output === 'object' &&
      ['task_permission_expired', 'task_permission_revoked', 'task_permission_consumed', 'execution_grant_expired', 'execution_grant_revoked', 'execution_grant_scope',
        'sandbox_read_only', 'sandbox_write_blocked', 'workspace_path_blocked', 'network_scope_blocked',
        'browser_interaction_scope_required', 'browser_binding_changed', 'browser_schedule_authority_changed',
        'browser_verification_policy_required', 'browser_verification_policy_blocked', 'browser_public_query_action_required', 'browser_public_query_target_blocked',
        'browser_schedule_action_scope_changed', 'browser_schedule_action_scope_required', 'browser_schedule_outcome_unknown',
        'browser_control_required', 'browser_sync_blocked', 'browser_sync_target_changed', 'browser_readback_blocked'].includes(String((item.output as Record<string, unknown>).code)) &&
      !((item.output as Record<string, unknown>).code === 'browser_readback_blocked' && !this.repository.operations(task.id, 'browser_action_dispatch').some(receipt => (receipt.result as { readbackPending?: boolean } | undefined)?.readbackPending === true)) &&
      !this.resolvedBrowserScopeRequest(task, item, items, turnId, currentGrant))
    if (!denied || denied.kind !== 'tool_result') return null
    const code = String((denied.output as Record<string, unknown>).code)
    const legacyBrowserEvidenceMissing = code === 'browser_schedule_action_scope_required' && String((denied.output as { error?: string }).error ?? '').startsWith('旧操作缺少可核对的执行前页面或逐次目标审批凭据')
    const browserBlock = ['browser_interaction_scope_required', 'browser_binding_changed', 'browser_verification_policy_required', 'browser_verification_policy_blocked'].includes(code)
    let capability: CapabilityPreflight
    if (['browser_control_required', 'browser_sync_blocked', 'browser_sync_target_changed', 'browser_readback_blocked'].includes(code)) {
      capability = browserRecoveryCapability(code, this.nowIso())
    } else if (['browser_public_query_action_required', 'browser_public_query_target_blocked'].includes(code)) {
      const resolution = { kind: 'retry' as const, route: 'task/browser-action-review', label: '继续原任务并审阅公开查询动作' }
      capability = { provider: 'browser-skill', status: 'needs_authorization', errorCode: code,
        message: code === 'browser_public_query_target_blocked' ? '所选目标包含账号操作或业务写入内容。请继续原任务并重新选择公开搜索或翻页目标。业务操作需要单独审阅完整页面范围。' : '公开查询目标模式尚缺当前动作的明确授权。继续原任务后，智能体会重新观察页面，展示具体目标、输入和校验范围供你审阅。',
        credentialState: 'unknown', networkState: 'unknown', workspaceState: 'unknown', sandboxState: 'allowed',
        approvalState: 'required', action: resolution, resolution, checkedAt: this.nowIso() }
    } else if (code.startsWith('browser_schedule_')) {
      const resolution = task.scheduledBy
        ? { kind: 'grant' as const, route: `flow/${task.scheduledBy.scheduleId}`, label: '查看并核对定时计划' }
        : { kind: 'retry' as const, route: 'task/schedule-review', label: '继续原任务并审阅周期动作' }
      capability = { provider: 'schedule', status: 'blocked', errorCode: code,
        message: legacyBrowserEvidenceMissing ? '旧浏览器操作缺少执行前页面或逐次审批的目标凭据，当前记录无法核验。原记录已保留。请核对原始凭据；无法补齐时，从原会话新建独立来源任务，重新执行公开查询并审阅周期范围。'
          : code === 'browser_schedule_action_scope_required' ? '这项周期任务尚缺已核对的持续网页动作范围。继续原任务后，智能体会重新观察页面，并展示具体站点、目标、输入和计划范围供你审阅。'
          : code === 'browser_schedule_outcome_unknown' ? '上次计划的网页动作结果待核实。请查看原操作记录并核验结果后继续。'
          : '计划的浏览器、页面目标、输入内容或授权范围已变化，请审阅定时计划后继续。',
        credentialState: 'unknown', networkState: 'unknown', workspaceState: 'unknown', sandboxState: 'allowed',
        approvalState: 'required', action: resolution, resolution, checkedAt: this.nowIso() }
    } else if (browserBlock) {
      const resolution = { kind: 'grant' as const, route: 'task/browser-binding', label: '确认当前任务的浏览器范围' }
      capability = { provider: 'browser-skill', status: 'needs_authorization', errorCode: code,
        message: code.startsWith('browser_verification_policy_') ? '当前任务的浏览器校验范围需要确认。请审阅公开查询或完整页面校验模式，确认后以新授权继续任务。'
          : code === 'browser_binding_changed'
          ? '浏览器实例或连接配置已变化。请审阅当前任务的浏览器和站点范围，确认后继续原任务。'
          : '当前任务需要网页交互权限。请确认浏览器、允许访问的站点和交互范围，然后继续原任务。',
        credentialState: 'unknown', networkState: 'unknown', workspaceState: 'unknown', sandboxState: 'allowed',
        approvalState: 'required', action: resolution, resolution, checkedAt: this.nowIso() }
    } else {
      capability = workspacePermissionCapability(code, code === 'network_scope_blocked' ? '本次操作的网络目标超出当前任务授权，请确认所需的网络范围后继续原任务。' : '本次文件操作缺少对应的任务权限，请确认目标路径的读写范围后继续原任务。')
    }
    return this.waitForCapability(task, turnId, capability, code)
  }

  private waitForCapability(task: TaskRun, turnId: string, capability: CapabilityPreflight, code: string): Extract<TaskCandidateDecision, { kind: 'waiting_user' }> {
    const attentionId = `capability_${task.id}`
    const fingerprint = `permission:${turnId}:${code}`
    const now = this.nowIso()
    return this.repository.transact(() => {
      const prior = this.repository.attention(attentionId)
      if (task.status === 'waiting_user' && prior?.status === 'pending' && prior.payload?.fingerprint === fingerprint) {
        return { kind: 'waiting_user', task, reason: capability.message }
      }
      const result = this.waitForUser(task, capability.message, '', fingerprint, turnId)
      if (prior?.status === 'pending' && prior.payload?.fingerprint === fingerprint) return result
      this.repository.putAttention({ id: attentionId, ownerKind: 'task', ownerId: task.id, taskId: task.id, threadId: task.originThreadId ?? task.threadId,
        workspaceRoot: task.workspaceRoot, kind: 'blocked', title: '确认任务执行权限', message: capability.message, status: 'pending', revision: (prior?.revision ?? -1) + 1,
        createdAt: prior?.status === 'pending' ? prior.createdAt : now, updatedAt: now, payload: { kind: 'capability_required', capability, fingerprint, request: { prompt: task.goal } } })
      const commandId = createHash('sha256').update(`${task.id}:${fingerprint}`).digest('hex').slice(0, 32)
      this.repository.enqueueOutbox({ id: `command-message:${commandId}`, ownerId: task.originThreadId ?? task.threadId, kind: 'task_command_message', createdAt: now,
        payload: { threadId: task.originThreadId ?? task.threadId, commandId, assistantText: capability.message, createdAt: now,
          capabilityCard: { threadId: task.originThreadId ?? task.threadId, taskId: task.id, attentionId, prompt: task.goal, capability } } })
      return result
    })
  }

  private resolvedBrowserScopeRequest(task: TaskRun, denied: TurnItem, items: TurnItem[], turnId: string, currentGrant?: ExecutionGrant): boolean {
    if (denied.kind !== 'tool_result' || !['browser_schedule_action_scope_required', 'browser_public_query_action_required'].includes(String((denied.output as { code?: string })?.code))) return false
    const operation = this.repository.operation(task.id, `tool:${turnId}:${denied.callId}`)
    const request = this.repository.operations(task.id, 'browser_action_scope_request').find(receipt => receipt.status === 'succeeded' &&
      receipt.request?.turnId === turnId && receipt.request?.toolName === denied.toolName &&
      receipt.request?.argumentsHash === operation?.request?.argumentsHash)?.request
    if (!request || this.repository.operations(task.id, 'browser_schedule_action_outcome').some(receipt => receipt.status === 'outcome_unknown' && !this.repository.verifiedOperationResolution(receipt))) return false
    const sameTarget = (candidate: Record<string, unknown>) => ['action', 'pageUrl', 'elementHash', 'valueHash', 'browserInstanceId', 'browserRevision']
      .every(key => candidate[key] === request[key]) && browserVerificationPolicy(candidate.verificationPolicy) === browserVerificationPolicy(request.verificationPolicy)
    const approved = listApprovedBrowserScheduleActions(this.repository, task).find(action => sameTarget(action))
    const approvedTask = this.repository.operations(task.id, 'browser_action_authorization').find(receipt => {
      const result = receipt.result as { access?: string; revoked?: boolean; expiresAt?: string } | undefined
      return receipt.status === 'succeeded' && result?.access === 'public_query' && result.revoked !== true &&
        Date.parse(result.expiresAt ?? '') > Date.parse(this.nowIso()) && sameTarget(receipt.request ?? {})
    })
    const dispatches = this.repository.operations(task.id, 'browser_action_dispatch')
    return items.slice(items.indexOf(denied) + 1).some(item => {
      if (item.kind !== 'tool_result' || item.isError || !['browser_click', 'browser_fill'].includes(item.toolName)) return false
      const output = item.output as { dispatchReceiptId?: string; resultHash?: string } | undefined
      const dispatch = dispatches.find(receipt => receipt.id === output?.dispatchReceiptId)
      const actual = this.repository.operation(task.id, `tool:${turnId}:${item.callId}`)
      if (dispatch?.status !== 'succeeded' || dispatch.request?.turnId !== turnId || !sameTarget(dispatch.request) ||
        actual?.status !== 'succeeded' || actual.request?.toolName !== item.toolName || actual.request.argumentsHash !== dispatch.request.argumentsHash ||
        typeof output?.resultHash !== 'string' || (dispatch.result as { resultHash?: string } | undefined)?.resultHash !== output.resultHash) return false
      if (dispatch.request.authorizationSource === 'task_scope' || dispatch.request.scopeActionReceiptId !== undefined || dispatch.request.scopeAuthorizationReceiptId !== undefined) {
        // Task binding authority is not a per-action human approval. Require its
        // exact derived action plus this Turn's stored tool result and readback.
        const grant = ExecutionGrantSchema.safeParse(actual.request.executionGrant)
        const source = verifiedTaskPublicQueryAction(this.repository, actual, dispatch)
        const storedItem = (actual.result as ToolHostResult | undefined)?.item
        const result = item.output as { status?: string; provider?: string; sourceUrl?: string; evidence?: { verified?: boolean; contentRead?: boolean; sourceUrl?: string; resultHash?: string } }
        const settled = dispatch.result as { actionAcknowledged?: boolean; readbackPending?: boolean; sourceUrl?: string } | undefined
        if (!source || !currentGrant || !grant.success || operationFingerprint(grant.data) !== operationFingerprint(currentGrant) ||
          actual.request.providerId !== 'browser-skill' || !storedItem || storedItem.kind !== 'tool_result' || storedItem.isError ||
          storedItem.callId !== item.callId || storedItem.turnId !== turnId || storedItem.toolName !== item.toolName ||
          settled?.actionAcknowledged !== true || settled.readbackPending !== false || result.status !== 'succeeded' || result.provider !== 'browser-skill' ||
          !result.sourceUrl || settled.sourceUrl !== result.sourceUrl || result.evidence?.verified !== true || result.evidence.contentRead !== true ||
          result.evidence.sourceUrl !== result.sourceUrl || result.evidence.resultHash !== output.resultHash) return false
        const saved = storedItem.output as Record<string, unknown> | undefined
        return Boolean(saved && saved.dispatchReceiptId === output.dispatchReceiptId && saved.resultHash === output.resultHash && saved.sourceUrl === result.sourceUrl &&
          operationFingerprint(saved.evidence) === operationFingerprint(result.evidence))
      }
      return Boolean(approved ? dispatch.request.scheduleActionId === approved.id : approvedTask && dispatch.request.authorizationReceiptId === approvedTask.id)
    })
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
    const pending = this.taskInputs(task.id, true)
    for (const input of pending) this.repository.execution.enqueue(input.id, task.id, token.sessionId)
    const inputs = new Map(pending.map(input => [input.id, input]))
    return this.repository.execution.pending(token.sessionId).flatMap(delivery => inputs.has(delivery.inputId) ? [{ delivery, input: inputs.get(delivery.inputId)! }] : [])
  }

  /** Resolve control provenance against SQLite, including inputs written by older clients. */
  approvalForInput(input: TaskInput): ApprovalRequest | undefined {
    if (!input.sourceId || !['approval_resolution', 'user_answer'].includes(input.kind)) return undefined
    const request = this.repository.humanRequest(input.sourceId)
    const task = this.repository.get(input.taskId)
    if (!request || request.kind !== 'approval' || request.status === 'pending' || request.threadId !== task?.threadId) return undefined
    const approval = request.payload.approval as ApprovalRequest | undefined
    if (!approval || approval.id !== request.id) return undefined
    const resolution = request.resolution as { decision?: string }
    return { ...approval, status: request.status === 'expired' ? 'expired' : resolution?.decision === 'allow' ? 'allowed' : 'denied', decidedAt: request.updatedAt }
  }

  /** Only DB-linked historical controls are projected; the original transcript stays intact. */
  projectApprovalHistory(threadId: string, items: TurnItem[]): TurnItem[] {
    const deliveries = new Map(this.repository.execution.deliveriesForThread(threadId).map(delivery => [delivery.messageItemId, delivery]))
    return items.map(item => {
      if (item.kind === 'approval' && !item.taskInputId) {
        const request = this.repository.humanRequest(item.approvalId)
        if (request?.kind === 'approval' && request.threadId === threadId && request.status !== 'pending') {
          const resolution = request.resolution as {decision?: string}
          return {...item, status: request.status === 'expired' ? 'expired' : resolution?.decision === 'allow' ? 'allowed' : 'denied'}
        }
      }
      if (item.kind !== 'user_message') return item
      const delivery = deliveries.get(item.id)
      if (!delivery) return item
      const input = this.repository.inputs(delivery.taskId).find(input => input.id === delivery.inputId)
      const approval = input ? this.approvalForInput(input) : undefined
      if (!approval) return item
      const {text: _text, displayText: _displayText, ...base} = item
      return {...base, kind:'approval', role:'system', approvalId:approval.id, toolName:approval.toolName,
        status:approval.status, summary:approval.status === 'allowed' ? '已允许本次操作' : '本次操作未获授权',
        taskInputId:input!.id, sourceRequestId:approval.id}
    })
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

  describeToolEffect(toolName: string) { return this.resolveToolEffect(toolName) }

  beginToolOperation(turnId: string, call: ToolCallLike, executionGrant?: ExecutionGrant): { key: string; token: ExecutionToken; prior?: ToolHostResult } | undefined {
    const token = this.attemptTokens.get(turnId)
    if (!token) return undefined
    return this.repository.transact(() => {
      this.assertToken(token)
      if (this.unknownToolOutcomes(token.taskId).length) {
        throw Object.assign(new Error('A previous tool has an unknown outcome. Verify its original receipt before executing another tool.'), { code: 'outcome_unknown' })
      }
      const key = `tool:${turnId}:${call.callId}`
      const argumentsHash = operationFingerprint(call.arguments)
      if (['browser_click', 'browser_fill'].includes(call.toolName)) {
        const resolved = this.repository.operations(token.taskId, 'tool').find(receipt => receipt.request?.toolName === call.toolName &&
          receipt.request?.argumentsHash === argumentsHash && this.repository.verifiedOperationResolution(receipt)?.evidence.kind === 'human_confirmation')
        const proof = resolved && this.repository.verifiedOperationResolution(resolved)
        if (resolved && proof) return { key: resolved.idempotencyKey, token, prior: { approved: true,
          item: makeToolResultForVerifiedResolution(this.repository.get(token.taskId)!, turnId, call, proof.evidence, proof.outcome) } }
      }
      const unresolved = this.repository.operations(token.taskId, 'tool').find(receipt =>
        receipt.idempotencyKey !== key && receipt.status === 'outcome_unknown' &&
        receipt.request?.toolName === call.toolName && receipt.request?.argumentsHash === argumentsHash &&
        !this.repository.verifiedOperationResolution(receipt))
      if (unresolved) {
        throw Object.assign(new Error('The same tool request has an unknown outcome. Verify its outcome against the original receipt before dispatching again.'), { code: 'outcome_unknown' })
      }
      const effect = this.resolveToolEffect(call.toolName)
      const target = externalTarget(call.arguments, call.toolName, effect)
      if (effect?.mutation) {
        const task = this.repository.get(token.taskId)!
        this.assertExternalTarget(turnId, effect.provider, effect.operation, target ?? '')
        // Tool call IDs change when a task resumes. The finite reviewed action
        // is still the same action; never repeat it just because a model emits
        // a new call ID or changes the arguments after a successful dispatch.
        const prior = this.repository.operations(task.id, 'tool').find(receipt => receipt.request?.provider === effect.provider && receipt.request?.operation === effect.operation && receipt.request?.target === target && !(receipt.status === 'failed' && receipt.request?.turnId !== turnId && (receipt.result as { approved?: boolean } | undefined)?.approved === false))
        if (prior) {
          if (prior.request?.toolName !== call.toolName || prior.request?.argumentsHash !== operationFingerprint(call.arguments)) {
            throw Object.assign(new Error('This reviewed target already has a different operation request. Inspect its receipt before changing the action.'), { code: 'idempotency_conflict' })
          }
          const resolution = this.repository.verifiedOperationResolution(prior)
          if (resolution) return { key: prior.idempotencyKey, token, prior: { approved: true, item: makeToolResultForVerifiedResolution(task, turnId, call, resolution.evidence, resolution.outcome) } }
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
      const prepared = this.repository.beginOperation({ ownerId: token.taskId, idempotencyKey: key, kind: 'tool', request: { toolName: call.toolName, callId: call.callId, executionId: token.executionId, dispatchTracking: 'host-v1', providerId: call.providerId, ...effect, ...(effect ? { effectDefinition: effect } : {}), target, turnId, argumentsHash: operationFingerprint(call.arguments), approvalRequestHash: createHash('sha256').update(JSON.stringify(call.arguments)).digest('hex'), ...(verificationLocator ? { verificationLocator } : {}), ...(executionGrant ? { executionGrant } : {}), ...(scope?.scopeConfirmationId ? { scopeConfirmationId: scope.scopeConfirmationId, scopeRevision: scope.scopeRevision } : {}) }, nowIso: this.nowIso() })
      if (!prepared.created) {
        if (prepared.receipt.status === 'succeeded' && prepared.receipt.result) return { key, token, prior: prepared.receipt.result as ToolHostResult }
        if (['running', 'outcome_unknown'].includes(prepared.receipt.status)) throw Object.assign(new Error('Previous tool outcome must be verified before another dispatch.'), { code: 'outcome_unknown' })
        if (prepared.receipt.status === 'failed') throw Object.assign(new Error('Failed tool operation requires a new explicit attempt.'), { code: 'operation_failed' })
      }
      return { key, token }
    })
  }

  claimUndispatchedApproval(token: ExecutionToken, key: string, approval: ApprovalRequest): boolean {
    return this.repository.transact(() => {
      this.assertToken(token)
      const current = this.repository.operation(token.taskId, key)
      const grant = ExecutionGrantSchema.safeParse(current?.request?.executionGrant)
      if (!current || current.status !== 'prepared' || !grant.success || !approval.requestHash ||
          current.request?.approvalRequestHash !== approval.requestHash || current.request?.toolName !== approval.toolName ||
          current.request?.callId !== approval.callId || approval.turnId !== token.turnId ||
          grant.data.taskId !== token.taskId || grant.data.turnId !== token.turnId) return false
      const now = this.nowIso()
      if (grant.data.expiresAt && Date.parse(grant.data.expiresAt) <= Date.parse(now)) return false
      const approvedRequests = this.repository.humanRequests('approval', false)
      for (const previous of this.repository.operations(token.taskId, 'tool')) {
        const output = (previous.result as ToolHostResult | undefined)?.item
        const originalRequestHash = previous.request?.approvalRequestHash
        if (previous.id === current.id || previous.status !== 'failed' || previous.request?.dispatchTracking !== 'host-v1' ||
            output?.kind !== 'tool_result' || (output.output as { code?: string } | undefined)?.code !== 'operation_not_dispatched' ||
            previous.request.toolName !== current.request?.toolName || previous.request.providerId !== current.request?.providerId ||
            previous.request.target !== current.request?.target || previous.request.scopeConfirmationId !== current.request?.scopeConfirmationId ||
            previous.request.scopeRevision !== current.request?.scopeRevision || previous.request.argumentsHash !== current.request?.argumentsHash ||
            typeof originalRequestHash !== 'string' || !/^[a-f0-9]{64}$/.test(originalRequestHash)) continue
        const priorGrant = ExecutionGrantSchema.safeParse(previous.request.executionGrant)
        if (!priorGrant.success || priorGrant.data.taskId !== token.taskId ||
            approvalAuthorityFingerprint(priorGrant.data) !== approvalAuthorityFingerprint(grant.data)) continue
        const source = approvedRequests.find(request => {
          const original = request.payload.approval as ApprovalRequest | undefined
          const continuedFrom = request.payload.continuedFromApprovalId
          const transfer = typeof continuedFrom === 'string' ? this.repository.operation(token.taskId, `approval-transfer:${continuedFrom}`) : undefined
          if (continuedFrom && (transfer?.status !== 'succeeded' || transfer.request?.destinationOperationId !== previous.id || transfer.request?.approvalId !== request.id)) return false
          return request.status === 'answered' && (request.resolution as { decision?: string })?.decision === 'allow' &&
            request.threadId === approval.threadId &&
            request.turnId === previous.request?.turnId && original?.toolName === approval.toolName &&
            (!approval.toolName.startsWith('browser_') || original.summary === approval.summary) &&
            (original.callId === previous.request?.callId || request.id === `appr_${previous.request?.callId}`) &&
            (!original.requestHash || original.requestHash === originalRequestHash)
        })
        if (!source) continue
        const transferKey = `approval-transfer:${source.id}`
        const existing = this.repository.operation(token.taskId, transferKey)
        if (existing) {
          if (existing.status === 'succeeded' && existing.request?.destinationOperationId === current.id) return true
          continue
        }
        const saved = this.repository.humanRequest(approval.id)
        if (saved) return false
        this.repository.beginOperation({ ownerId: token.taskId, idempotencyKey: transferKey, kind: 'approval_transfer',
          request: { sourceApprovalId: source.id, sourceOperationId: previous.id, destinationOperationId: current.id,
            approvalId: approval.id, executionGrantId: grant.data.id }, nowIso: now })
        this.repository.saveHumanRequest({ id: approval.id, kind: 'approval', threadId: approval.threadId, turnId: approval.turnId,
          message: approval.summary, payload: { approval, continuedFromApprovalId: source.id }, status: 'answered',
          resolution: { decision: 'allow' }, createdAt: now, updatedAt: source.updatedAt })
        this.repository.finishOperation(token.taskId, transferKey, { status: 'succeeded', result: { approvalId: approval.id } }, now)
        return true
      }
      return false
    })
  }

  /** The closure captures the original call/attempt; a later lease cannot lend it authority. */
  currentToolOperation(token: ExecutionToken, key: string, call: ToolCallLike, executionGrant?: ExecutionGrant): CurrentToolOperation {
    this.assertToken(token)
    const receipt = this.repository.operation(token.taskId, key)
    const grant = ExecutionGrantSchema.safeParse(receipt?.request?.executionGrant)
    if (!receipt || receipt.kind !== 'tool' || !['prepared', 'running'].includes(receipt.status) ||
      receipt.request?.dispatchTracking !== 'host-v1' || receipt.request.executionId !== token.executionId ||
      receipt.request.turnId !== token.turnId || receipt.request.callId !== call.callId || receipt.request.toolName !== call.toolName ||
      receipt.request.providerId !== call.providerId || receipt.request.argumentsHash !== operationFingerprint(call.arguments) ||
      !grant.success || !executionGrant || operationFingerprint(receipt.request.executionGrant) !== operationFingerprint(executionGrant) ||
      grant.data.taskId !== token.taskId || grant.data.turnId !== token.turnId ||
      grant.data.threadId !== this.repository.get(token.taskId)?.threadId ||
      grant.data.expiresAt && Date.parse(grant.data.expiresAt) <= Date.parse(this.nowIso())) {
      throw Object.assign(new Error('The current Host invocation no longer matches its original attempt and grant.'), { code: 'execution_grant_scope' })
    }
    return { operationId: receipt.id, idempotencyKey: key, taskId: token.taskId, turnId: token.turnId,
      executionId: token.executionId, callId: call.callId, toolName: call.toolName, providerId: call.providerId,
      argumentsHash: operationFingerprint(call.arguments), executionGrantFingerprint: operationFingerprint(executionGrant) }
  }

  recordToolDispatch(token: ExecutionToken, key: string): void {
    this.repository.transact(() => {
      this.assertToken(token)
      if (this.unknownToolOutcomes(token.taskId).length) {
        throw Object.assign(new Error('An earlier operation requires verification; this tool was not dispatched.'), { code: 'operation_not_dispatched' })
      }
      const receipt = this.repository.operation(token.taskId, key)
      if (!receipt || receipt.status !== 'prepared') throw Object.assign(new Error('This tool operation has already entered dispatch.'), { code: 'outcome_unknown' })
      this.repository.finishOperation(token.taskId, key, { status: 'running' }, this.nowIso())
    })
  }

  recordToolApproval(token: ExecutionToken, key: string, approval: { toolName: string; requestHash: string }): void {
    this.repository.transact(() => {
      this.assertToken(token)
      const receipt = this.repository.operation(token.taskId, key)
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
    if (requestedEffectOperations(task).some(expected => !required.some(effect => effect.operation === expected))) {
      throw Object.assign(new Error('The confirmed scope omits a requested operation and requires review.'), { code: 'effect_scope_incomplete' })
    }
    if (task.authority?.revokedAt || !required.some(item => item.provider === provider && item.operation === operation && item.target === target)) {
      throw Object.assign(new Error('Review and confirm the complete finite external action set with confirm_external_effect_scope before this mutation.'), { code: 'effect_scope_required' })
    }
  }

  private settleUndispatched(taskId: string): void {
    const attempt = this.repository.execution.latestAttempt(taskId)
    const lease = this.repository.getLease(taskId)
    if (attempt?.status === 'running' && inspectProcess(attempt.process) !== 'exited' && lease && Date.parse(lease.expiresAt) > Date.parse(this.nowIso())) return
    const task = this.repository.get(taskId)!
    this.repository.transact(() => {
      for (const receipt of this.repository.operations(taskId, 'tool')) {
        if (receipt.status !== 'prepared') continue
        if (receipt.request?.dispatchTracking !== 'host-v1') {
          this.repository.finishOperation(taskId, receipt.idempotencyKey, { status: 'outcome_unknown', error: 'legacy_dispatch_unverified' }, this.nowIso())
          continue
        }
        this.repository.finishOperation(taskId, receipt.idempotencyKey, { status: 'failed', error: 'operation_not_dispatched',
          result: { approved: false, item: makeToolResultItem({ id: `item_${receipt.request.callId}`, threadId: task.threadId,
            turnId: String(receipt.request.turnId), callId: String(receipt.request.callId), toolName: String(receipt.request.toolName),
            output: { code: 'operation_not_dispatched', status: 'failed' }, isError: true }) }
        }, this.nowIso())
      }
    })
  }

  private verifiedTaskEffects(task: TaskRun) {
    const session = this.repository.execution.sessionForTask(task.id)
    const trustedTurns = new Set(this.repository.execution.attempts(task.id)
      .filter(attempt => attempt.sessionId === session?.id && attempt.taskId === task.id)
      .map(attempt => attempt.turnId))
    return verifiedEffectReceipts(task, this.repository.operations(task.id), trustedTurns, this.resolveToolEffect)
  }

  finishToolOperation(token: ExecutionToken, key: string, result?: ToolHostResult): void {
    // An already-dispatched result is immutable evidence even after lease loss.
    const prior = this.repository.operation(token.taskId, key)
    if (!prior || prior.status === 'succeeded') return
    if (!result && prior.status === 'failed' && prior.result) return
    if (!result && prior.status === 'prepared' && prior.request?.dispatchTracking === 'host-v1') {
      const task = this.repository.get(token.taskId)!
      result = { approved: false, item: makeToolResultItem({ id: `item_${prior.request.callId}`, threadId: task.threadId,
        turnId: token.turnId, callId: String(prior.request.callId), toolName: String(prior.request.toolName),
        output: { code: 'operation_not_dispatched', status: 'failed' }, isError: true }) }
    }
    const output = result?.item.kind === 'tool_result' ? result.item.output as { status?: string; code?: string } | undefined : undefined
    const unknown = !result || output?.status === 'outcome_unknown' || output?.code === 'outcome_unknown' || output?.status === 'pending'
    const failed = result?.approved === false || result?.item.kind === 'tool_result' && result.item.isError
    this.repository.finishOperation(token.taskId, key, {
      status: unknown ? 'outcome_unknown' : failed ? 'failed' : 'succeeded',
      ...(result ? { result: { ...result, item: sanitizeTurnItemForPersistence(result.item) } } : {})
    }, this.nowIso())
  }

  /** Register exact saved bytes after the writer receipt and transcript are durable, without accepting their sources or completing work. */
  async recordArtifactPublication(token: ExecutionToken, key: string): Promise<boolean> {
    try {
      this.assertToken(token)
      const task = this.repository.get(token.taskId)!
      if (task.status !== 'running') return false
      const receipt = this.repository.operation(task.id, key)
      const result = receipt?.result as ToolHostResult | undefined
      const item = result?.item
      if (receipt?.kind !== 'tool' || receipt.status !== 'succeeded' || receipt.request?.toolName !== 'publish_artifact' || receipt.request.turnId !== token.turnId || receipt.request.executionId !== token.executionId ||
        result?.approved !== true || item?.kind !== 'tool_result' || item.toolName !== 'publish_artifact' || item.callId !== receipt.request.callId || item.turnId !== token.turnId || item.status !== 'completed' || item.isError) return false
      const output = item.output && typeof item.output === 'object' ? item.output as Record<string, unknown> : {}
      if (typeof output.path !== 'string' || typeof output.sha256 !== 'string') return false
      const canonical = await realpath(output.path).catch(() => '')
      const thread = await this.threadStore.get(task.threadId)
      const writes = await authorizedArtifactWrites(task, this.repository.operations(task.id, 'tool'), thread?.turns ?? [])
      const write = writes.get(canonical)
      if (!write || write.operationId !== receipt.id || write.turnId !== token.turnId || write.sha256 !== output.sha256 || write.authorizedRoot !== this.managedArtifactRoot(task.id)) return false
      const candidate = (await this.collectArtifacts(task, [item], token.turnId)).find(artifact => artifact.absolutePath === canonical)
      if (!candidate || candidate.validation !== 'valid' || candidate.sha256 !== write.sha256 || candidate.executionGrantId !== write.executionGrantId) return false
      const { sourceEvidenceReceiptId: _proof, sourceEvidenceStatus: _status, ...saved } = candidate
      const artifact: TaskArtifact = { ...saved, ...(task.acceptance.requiresWebEvidence && ['html', 'htm'].includes(saved.format ?? '') ? { sourceEvidenceStatus: 'draft' as const } : {}) }
      return this.repository.transact(() => {
        // Keep the captured attempt, not a later token for the same Turn. A pause
        // or takeover during file validation cannot publish metadata or resume work.
        this.assertToken(token)
        const current = this.repository.get(task.id)!
        if (current.status !== 'running' || current.activeTurnId !== token.turnId) return false
        if (this.repository.events(task.id).some(event => event.eventKey === `artifact-published:${receipt.id}`)) return true
        const now = this.nowIso()
        this.updateExecution(task.id, current.revision, value => ({ ...value,
          artifacts: [...value.artifacts.filter(previous => previous.id !== artifact.id), artifact],
          nodes: this.artifactExecutionNodes(value, [...value.artifacts.filter(previous => previous.id !== artifact.id), artifact], now),
          ...(value.resultEvidence ? { resultEvidence: value.resultEvidence.filter(evidence => evidence.kind !== 'file' || evidence.target !== canonical) } : {}),
          updatedAt: now
        }), { key: `artifact-published:${receipt.id}`, kind: 'artifact_published', payload: { turnId: token.turnId, artifactId: artifact.id, sha256: artifact.sha256, writerReceiptId: receipt.id }, createdAt: now })
        return true
      })
    } catch (error) {
      if (error instanceof TaskLeaseLostError) return false
      throw error
    }
  }

  private artifactExecutionNodes(task: TaskRun, artifacts: TaskArtifact[], now: string): TaskRun['nodes'] {
    if (task.acceptance.kind !== 'files' || task.acceptance.requiresExternalEffects || task.acceptance.effect) return task.nodes
    const valid = artifacts.filter(artifact => artifact.validation === 'valid' && (!task.acceptance.requiredFormats?.length || task.acceptance.requiredFormats.includes(artifact.format ?? '')))
    if (valid.length < (task.acceptance.minimumArtifacts ?? 1)) return task.nodes
    return task.nodes.map(node => node.kind === 'execute' ? { ...node, status: 'completed' as const, finishedAt: now,
      evidence: [...new Set([...node.evidence, ...valid.map(artifact => artifact.relativePath)])], errorCode: undefined, errorMessage: undefined, revision: node.revision + 1 }
      : node.kind === 'verify' && node.status !== 'completed' ? { ...node, status: 'running' as const, errorCode: undefined, errorMessage: undefined, revision: node.revision + 1 }
        : node.kind === 'deliver' && node.status !== 'completed' ? { ...node, status: 'pending' as const, errorCode: undefined, errorMessage: undefined, revision: node.revision + 1 } : node)
  }

  /** Explicit metadata/file recheck for the bounded legacy source-classification defect. Never starts a Turn. */
  async revalidateLocalArtifacts(taskId: string, request: { expectedRevision: number; idempotencyKey: string; confirmed?: boolean }): Promise<{ task: TaskRun; corrected: boolean; completed: boolean; reason?: string }> {
    if (request.confirmed !== true) throw Object.assign(new Error('请明确确认重新检查已有成果。'), { code: 'invalid_state' })
    const previous = this.repository.operation(taskId, request.idempotencyKey)
    if (previous) {
      this.repository.beginOperation({ ownerId: taskId, kind: 'revalidate_artifacts', idempotencyKey: request.idempotencyKey, request, nowIso: this.nowIso() })
      if (previous.status !== 'succeeded') throw Object.assign(new Error('上次成果重验尚未确认，请检查原记录。'), { code: 'outcome_unknown' })
      return previous.result as { task: TaskRun; corrected: boolean; completed: boolean; reason?: string }
    }
    const task = this.repository.get(taskId)
    if (!task) throw Object.assign(new Error('task not found'), { code: 'not_found' })
    const assertStopped = () => {
      const current = this.repository.get(taskId)!
      if (current.revision !== request.expectedRevision) throw Object.assign(new Error('task revision conflict'), { code: 'stale_request' })
      const lease = this.repository.getLease(taskId)
      if (!['paused', 'stalled', 'failed', 'waiting_user'].includes(current.status) || current.childTaskIds.length || current.scheduledBy ||
        lease && Date.parse(lease.expiresAt) > Date.parse(this.nowIso()) || this.repository.execution.attempts(taskId).some(attempt => attempt.status === 'running') ||
        this.repository.connection().prepare('SELECT 1 FROM task_work_spans WHERE root_id=? AND finished_ms IS NULL LIMIT 1').get(current.rootTaskId ?? taskId)) {
        throw Object.assign(new Error('请等待任务停止后再重新检查成果；不会中断当前执行。'), { code: 'turn_in_progress' })
      }
      if (!legacyLocalArtifactSourceMismatch(current) || current.acceptance.effect ||
        this.taskInputs(taskId).some(input => requiresWebSourceEvidence(input.text))) throw Object.assign(new Error('该任务不属于本地 HTML 来源误分类，原有来源验收保持有效。'), { code: 'invalid_state' })
    }
    assertStopped()
    const thread = await this.threadStore.get(task.threadId), items = await this.sessionStore.loadItems(task.threadId)
    const writes = await authorizedArtifactWrites(task, this.repository.operations(taskId, 'tool'), thread?.turns ?? [])
    const collected = await this.collectArtifacts(task, items, task.activeTurnId ?? '', request.idempotencyKey)
    const artifacts = collected.map(artifact => { const { sourceEvidenceStatus: _status, sourceEvidenceReceiptId: _proof, ...local } = artifact; return local })
    const valid = artifacts.filter(artifact => {
      const write = writes.get(artifact.absolutePath ?? resolve(task.workspaceRoot, artifact.relativePath))
      if (!write) return false
      return artifact.validation === 'valid' && write?.sha256 === artifact.sha256 &&
        (!task.acceptance.requireActionableArtifactCard || artifact.storage === 'task' && Boolean(artifact.absolutePath) && write.authorizedRoot === this.managedArtifactRoot(task.id)) &&
        (!task.acceptance.requiredFormats?.length || task.acceptance.requiredFormats.includes(artifact.format ?? ''))
    })
    const namesComplete = requiredLocalHtmlFileNames(task.goal).every(name => valid.some(artifact => artifact.relativePath.replaceAll('\\', '/') === name))
    const finalResponse = latestAssistantText(thread?.turns.find(turn => turn.id === task.activeTurnId), items.filter(item => item.turnId === task.activeTurnId))
    const complete = valid.length >= (task.acceptance.minimumArtifacts ?? 1) && namesComplete && (!task.acceptance.requireFinalResponse ||
      Boolean(finalResponse.trim()) && !looksLikeProgressOnlyReply(finalResponse) && !looksLikeExternalCapabilityBlockedReply(finalResponse) && !looksLikeWebAccessFailureReply(finalResponse)) &&
      !this.repository.unsettledOperations(taskId).length && !this.hostShellState(task).unknown.length
    const reason = complete ? undefined : !namesComplete ? '来源误分类已纠正；尚未找到用户明确命名的 HTML 成果，不能用其他文件代替交付。' : valid.length < (task.acceptance.minimumArtifacts ?? 1)
      ? '来源误分类已纠正；已有文件或授权写入回执尚未通过重验，原成果和历史已保留。'
      : '来源误分类已纠正；尚缺有效交付回复或仍有待核实操作，原任务不会自动继续。'
    const now = this.nowIso()
    return this.repository.transact(() => {
      assertStopped()
      this.repository.beginOperation({ ownerId: taskId, kind: 'revalidate_artifacts', idempotencyKey: request.idempotencyKey, request, nowIso: now })
      const acceptance: TaskAcceptance = { ...task.acceptance, sourceInferenceVersion: TASK_SOURCE_INFERENCE_VERSION, requiresWebEvidence: false, requiredSourceOrigins: [] }
      const checked = this.repository.update(taskId, task.revision, value => ({ ...value, acceptance, artifacts,
        ...(complete ? { status: 'completed' as const, finalResponse, finishedAt: now, waitingReason: undefined, stalledReason: undefined } : { stalledReason: reason }),
        nodes: value.nodes.map(node => ({ ...node, status: complete ? 'completed' as const : node.kind === 'execute' && valid.length >= (acceptance.minimumArtifacts ?? 1) ? 'completed' as const : 'blocked' as const,
          evidence: [...new Set([...node.evidence, ...valid.map(artifact => artifact.relativePath)])], errorCode: complete ? undefined : 'artifact_revalidation_pending', errorMessage: reason,
          ...(complete || node.kind === 'execute' && valid.length ? { finishedAt: now } : {}), revision: node.revision + 1 })), updatedAt: now }), {
        key: `local-artifact-revalidated:${request.idempotencyKey}`, kind: 'local_artifact_acceptance_revalidated', createdAt: now,
        payload: { previousStatus: task.status, previousAcceptance: task.acceptance, previousNodeStates: task.nodes.map(node => ({ kind: node.kind, status: node.status, errorCode: node.errorCode })),
          acceptance, completed: complete, artifacts: valid.map(artifact => ({ id: artifact.id, sha256: artifact.sha256, writerReceiptId: writes.get(artifact.absolutePath ?? resolve(task.workspaceRoot, artifact.relativePath))!.operationId })), preservedUsage: true, resumed: false }
      })
      const result = { task: checked, corrected: true, completed: complete, ...(reason ? { reason } : {}) }
      this.repository.finishOperation(taskId, request.idempotencyKey, { status: 'succeeded', result }, now)
      return result
    })
  }

  /** Attach trusted readback evidence without overwriting the original unknown dispatch or resuming execution. */
  recordOperationVerification(taskId: string, expectedRevision: number, receiptId: string, verificationKey: string, evidence: import('../contracts/harness.js').ResultEvidence, outcome: OperationResolutionOutcome = 'succeeded'): void {
    this.repository.transact(() => {
      const task = this.repository.get(taskId)
      const receipt = this.repository.operations(taskId, 'tool').find(item => item.id === receiptId)
      const proof = this.repository.operation(taskId, verificationKey)
      if (!task || !receipt || !proof || proof.kind !== (outcome === 'not_completed' ? 'effect_verification_incomplete' : 'effect_verification') || proof.request?.originalReceiptId !== receipt.id || proof.request?.originalFingerprint !== receipt.fingerprint) throw Object.assign(new Error('Readback proof does not belong to this operation.'), { code: 'invalid_state' })
      if (task.revision !== expectedRevision) throw Object.assign(new Error('Task changed while verification was running.'), { code: 'stale_request' })
      if (TERMINAL.has(task.status) || task.authority?.revokedAt) throw Object.assign(new Error('Task authorization was revoked.'), { code: 'execution_grant_revoked' })
      const proofOutcome = (proof.result as { outcome?: unknown } | undefined)?.outcome ?? 'succeeded'
      if (proofOutcome !== outcome || outcome === 'not_completed' && (!['paused', 'stalled', 'waiting_user'].includes(task.status) || evidence.kind !== 'human_confirmation' || evidence.provider !== 'browser-skill' || evidence.status !== 'public_query_reviewed_incomplete')) throw Object.assign(new Error('Verification outcome does not match its trusted proof.'), { code: 'invalid_state' })
      const now = this.nowIso()
      this.repository.finishOperation(taskId, verificationKey, { status: 'succeeded', result: { taskId, receiptId, status: 'verified', evidence, outcome } }, now)
      this.repository.resolveOperation(taskId, receipt.idempotencyKey, { status: 'verified', receiptId: proof.id, evidence, outcome, resolvedAt: now })
      this.repository.update(taskId, task.revision, current => ({ ...current, updatedAt: now,
        ...(outcome === 'succeeded' ? { resultEvidence: [...(current.resultEvidence ?? []).filter(item => !(item.provider === evidence.provider && item.operation === evidence.operation && item.target === evidence.target)), evidence] } : {}) }),
      { key: `operation-verified:${proof.id}`, kind: 'operation_verified', payload: { provider: evidence.provider, operation: evidence.operation, target: evidence.target, receiptId, outcome }, createdAt: now })
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

  /** Preserve queued supplements across retry sessions using their original durable input IDs. */
  taskInputs(taskId: string, pendingOnly = false): TaskInput[] {
    const task = this.repository.get(taskId)
    if (!task) return []
    const inputs: TaskInput[] = []
    const visited = new Set<string>()
    let current: TaskRun | null = task
    while (current) {
      if (visited.has(current.id) || current.threadId !== task.threadId || current.workspaceRoot !== task.workspaceRoot ||
          (current.rootTaskId ?? current.id) !== (task.rootTaskId ?? task.id)) {
        throw Object.assign(new Error('Task input retry lineage is invalid.'), { code: 'task_input_scope_conflict' })
      }
      visited.add(current.id)
      if (current.id === task.id) inputs.unshift(...this.repository.inputs(current.id, pendingOnly))
      else {
        // Human answers belong to their original question/attempt. A retry may
        // carry only supplements that were already queued before failure.
        if (current.status !== 'failed') break
        const failedAt = Date.parse(current.finishedAt ?? current.updatedAt)
        inputs.unshift(...this.repository.inputs(current.id, pendingOnly).filter(input => input.kind === 'supplement' &&
          Date.parse(input.createdAt) <= failedAt))
      }
      const parentId: string | undefined = current.retryOfTaskId
      current = parentId ? this.repository.get(parentId) : null
      if (parentId && !current) throw Object.assign(new Error('Task input retry history is missing.'), { code: 'task_input_scope_conflict' })
    }
    return inputs
  }

  pendingInputs(threadId: string): TaskInput[] {
    const task = this.repository.findActiveByThread(threadId)
    return task && task.status !== 'paused' ? this.taskInputs(task.id, true) : []
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
    this.settleUndispatched(task.id)
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
      this.settleUndispatched(task.id)
      const oneOffWaiting=settleUnstartedOneOffRetry(this.repository,task,now)
      if(oneOffWaiting)return oneOffWaiting
      if(task.publicQueryRecovery?.mode==='task_reauthorization'&&!task.activeTurnId&&!lastAttempt)return this.repository.update(task.id,task.revision,current=>({...current,status:'waiting_user',waitingReason:'上次查询启动尚未核实，请检查原任务记录后继续。',updatedAt:now}),{key:`one-off-unstarted-blocked:${task.revision}`,kind:'task_waiting_user',createdAt:now})
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
    if (this.admissionSuspended) return
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
    const rootBudget = this.repository.get(stored.rootTaskId ?? stored.id)?.budget ?? stored.budget
    const durationExhausted = rootBudget.version === 2
      ? this.repository.execution.usedExecutionMs(stored.rootTaskId ?? stored.id, Date.parse(now)) >= (rootBudget.maxExecutionMs ?? rootBudget.maxDurationMs) || Boolean(rootBudget.maxElapsedMs && Date.parse(now) - Date.parse(stored.createdAt) >= rootBudget.maxElapsedMs)
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
              status: current.acceptance.kind === 'files' && current.nodes.some(step => step.kind === 'execute' && step.status === 'completed')
                ? node.kind === 'verify' ? status === 'retrying' ? 'pending' : 'blocked' : 'blocked'
                : node.dependsOn.some(id => current.nodes.some(parent => parent.id === id && parent.status !== 'completed')) ? 'blocked' : status === 'retrying' ? 'pending' : 'failed',
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
        node.status === 'completed' ? node : { ...node, status: node.dependsOn.length ? 'blocked' : 'failed', errorMessage: reason, finishedAt: now, revision: node.revision + 1 }
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

  private async collectArtifacts(task: TaskRun, items: TurnItem[], turnId: string, revalidationKey?: string, recordValidationSpans = true): Promise<TaskArtifact[]> {
    const paths = [
      ...task.artifacts.map(artifact => artifact.absolutePath ?? artifact.relativePath),
      ...items.flatMap(declaredFileOutputPaths),
      ...verifiedShellDeliverablePaths(items, turnId)
    ]
    const root = await realpath(task.workspaceRoot).catch(() => resolve(task.workspaceRoot))
    const thread = await this.threadStore.get(task.threadId)
    const authorizedWrites = await authorizedArtifactWrites(task, this.repository.operations(task.id, 'tool'), thread?.turns ?? [])
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
      const externalWrite = !inside ? authorizedWrites.get(canonical) : undefined
      const allowed = inside || Boolean(externalWrite)
      const info = canonical && allowed ? await stat(canonical).catch(() => null) : null
      const managedOutput = externalWrite?.authorizedRoot === this.managedArtifactRoot(task.id)
      const validFormat = !required || required.includes(extension) || Boolean(externalWrite && managedOutput)
      const validationSpanId = artifactValidationSpanId(task.id, revalidationKey ? `${rawPath}\0revalidation:${revalidationKey}` : rawPath)
      if (recordValidationSpans) this.spans?.start({
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
      const previous = task.artifacts.find(artifact => artifact.absolutePath ? artifact.absolutePath === absolutePath : artifact.relativePath === relativePath)
      const writtenThisTurn = externalWrite ? externalWrite.turnId === turnId && externalWrite.sha256 === validation?.sha256 : items.filter(item => item.turnId === turnId).flatMap(declaredFileOutputPaths)
        .some(path => resolve(root, path) === absolutePath)
      const changedOutsideExecution = Boolean(previous?.sha256 && previous.sha256 !== validation?.sha256 && !writtenThisTurn)
      const receiptMismatch = Boolean(externalWrite && externalWrite.sha256 !== validation?.sha256)
      const valid = Boolean(validation?.valid) && !changedOutsideExecution && !receiptMismatch
      if (recordValidationSpans) this.spans?.finish(validationSpanId, {
        status: valid ? 'ok' : 'error',
        ...(!valid ? {
          errorCode: !allowed
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
        ...(managedOutput && externalWrite ? { storage: 'task' as const } : previous?.storage ? { storage: previous.storage } : {}),
        id: previous?.id ?? `artifact_${createHash('sha256').update(`${task.id}:${inside ? relativePath : absolutePath}`).digest('hex').slice(0, 16)}`,
        relativePath: inside ? relativePath : externalWrite ? relative(externalWrite.authorizedRoot, canonical) || canonical.split(/[\\/]/).at(-1)! : previous?.relativePath ?? rawPath,
        ...(!inside && (externalWrite || previous?.absolutePath) ? {
          absolutePath: externalWrite?.absolutePath ?? previous?.absolutePath,
          authorizedRoot: externalWrite?.authorizedRoot ?? previous?.authorizedRoot,
          executionGrantId: externalWrite?.executionGrantId ?? previous?.executionGrantId
        } : {}),
        format: extension || undefined,
        sizeBytes: validation?.sizeBytes ?? info?.size,
        sha256: externalWrite?.sha256 ?? (changedOutsideExecution ? previous?.sha256 : previous?.absolutePath ? previous.sha256 : validation?.sha256 || undefined),
        validation: valid ? 'valid' : 'invalid',
        validationMessage: changedOutsideExecution || receiptMismatch ? '成果文件在上次验证后发生变化，请重新审阅。' : valid
          ? undefined
          : !allowed
            ? '成果路径缺少对应执行授权或成功写入回执。'
            : !info?.isFile()
              ? '成果文件不存在或不是普通文件。'
              : validFormat
                ? validation?.message ?? '成果文件未通过格式验证。'
                : `成果格式 .${extension || 'unknown'} 不符合要求。`,
        createdAt: previous?.createdAt ?? this.nowIso()
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

function makeToolResultForVerifiedResolution(task: TaskRun, turnId: string, call: ToolCallLike, evidence: NonNullable<OperationReceipt['resolution']>['evidence'], outcome: OperationResolutionOutcome = 'succeeded'): ToolHostResult['item'] {
  if (outcome === 'not_completed') return makeToolResultItem({ id: `item_${call.callId}`, threadId: task.threadId, turnId, callId: call.callId, toolName: call.toolName, isError: true,
    output: { ok: false, status: 'failed', code: 'browser_action_not_completed', outcome, evidence, recovered: true } })
  return makeToolResultItem({ id: `item_${call.callId}`, threadId: task.threadId, turnId, callId: call.callId, toolName: call.toolName, output: { ok: true, status: 'succeeded', evidence, recovered: true } })
}

function acceptanceForPrompt(prompt: string): TaskAcceptance {
  const feedHtml = asksForObservedFeedSummary(prompt) && /\bhtml?\b|汇总网页|汇总页面|生成网页/i.test(prompt)
  const files = promptRequiresFileDeliverable(prompt) || feedHtml
  const web = requiresWebSourceEvidence(prompt)
  const effect = promptRequiresExternalEffect(prompt)
  const intent = effect ? externalTaskIntent(prompt) : null
  const requiredFormats = requiredFileExtensionsForPrompt(prompt) ?? (feedHtml ? ['html'] : undefined)
  return {
    schedule: extractScheduleRequirement(prompt),
    kind: files ? 'files' : effect ? 'effect' : 'answer',
    requiredNodeKinds: files || effect ? ['execute', 'verify', 'deliver'] : ['deliver'],
    sourceInferenceVersion: TASK_SOURCE_INFERENCE_VERSION,
    ...(requiredFormats ? { requiredFormats: [...requiredFormats] } : {}),
    ...(files ? { minimumArtifacts: 1 } : {}),
    ...(web ? {requiresWebEvidence:true,requiredSourceOrigins:browserTaskOrigins(prompt), ...(asksForObservedFeedSummary(prompt) ? { webEvidenceBasis: 'observed_feed' as const } : {})} : {}),
    requireFinalResponse: true,
    requireActionableArtifactCard: files,
    ...(effect ? { requiresExternalEffects: true } : {}),
    ...(intent?.provider ? {
      effect: {
        provider: intent.provider,
        operation: intent.operation ?? (intent.kind === 'connect_provider' ? 'connect' : 'process'),
        ...(intent.operations ? { requiredOperations: intent.operations } : {}),
        target: intent.target ?? (intent.operation === 'list' ? 'current_user' : undefined),
        requiredScopes: [],
        requiresConfirmation: intent.mutation,
        successStatus: ['succeeded'],
        verification: 'provider_readback' as const
      }
    } : {})
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

/** Turn identity changes after restart; all reviewed authority and account bindings must agree. */
function approvalAuthorityFingerprint(grant: ExecutionGrant): string {
  const { id: _id, turnId: _turnId, idempotencyKey: _idempotencyKey, issuedAt: _issuedAt, expiresAt: _expiresAt, ...authority } = grant
  return operationFingerprint(authority)
}

function browserRecoveryCapability(code: string, checkedAt: string): CapabilityPreflight {
  const resolution = { kind: 'connect' as const, route: 'marketplace', label: '查看浏览器连接与控制状态' }
  return { provider: 'browser-skill', status: 'blocked', errorCode: code,
    message: code === 'browser_control_required' ? '浏览器当前由你控制或已暂停自动操作。请在原浏览器的 BrowserSkill 控制条交还控制，检查连接后再单独继续原任务；系统不会抢占控制或重复动作。'
      : code === 'browser_readback_blocked' ? '浏览器已确认网页动作，但后续页面读取失败。请检查原浏览器与连接后继续，系统将只读核对原页面，不能重复动作或交付为已完成。'
        : '原网页观察已失效，系统已进行一次有限刷新并停止继续尝试。请检查原浏览器页面和连接，再单独继续任务；目标或输入变化需重新审阅。',
    credentialState: 'unknown', networkState: 'unknown', workspaceState: 'allowed', sandboxState: 'allowed', approvalState: 'required',
    action: resolution, resolution, checkedAt }
}
