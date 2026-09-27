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
  TaskRunStatus
} from '../contracts/tasks.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import {
  completionIntentText,
  fileOutputPaths,
  looksLikeExternalCapabilityBlockedReply,
  looksLikeProgressOnlyReply,
  looksLikeWebAccessFailureReply,
  promptRequiresFileDeliverable,
  requiredFileExtensionsForPrompt,
  verifiedShellDeliverablePaths
} from '../loop/turn-completion-guard.js'
import { TaskRunRepository } from './task-run-repository.js'
import { validateArtifactFile } from './artifact-validator.js'
import type { RuntimeSpanService } from './runtime-span-service.js'

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
  completionGuard?: (input: { thread?: ThreadRecord; turn?: Turn; task: TaskRun }) => { reason: string; fingerprint: string } | null
}

export class TaskController {
  private readonly repository: TaskRunRepository
  private readonly threadStore: ThreadStore
  private readonly sessionStore: SessionStore
  private readonly nowIso: () => string
  private readonly ownerId: string
  private readonly spans?: RuntimeSpanService
  private readonly completionGuard?: TaskControllerDeps['completionGuard']

  constructor(deps: TaskControllerDeps) {
    this.repository = deps.repository
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
    if (active && (input.continuationTaskId || (!consultation && shouldContinueActiveTask(input.request.prompt)))) {
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
    if (active) {
      this.finish(active, 'cancelled', '用户发起了新的请求，旧任务已停止。')
    }

    const acceptance = acceptanceForPrompt(consultation ? 'Answer the Survey question or propose a plan for review.' : input.request.prompt)
    const id = `task_${randomUUID()}`
    const nodes = nodeBlueprint(id, acceptance)
    const profile = input.thread.agentProfile
    const selectedModel = input.request.model ?? profile?.model ?? input.thread.model
    const maxCostUsd = minimumDefinedPositive(profile?.budget.maxCostUsd, input.thread.costBudgetUsd)
    const created = this.repository.create({
      id,
      threadId: input.thread.id,
      activeTurnId: input.turnId,
      childTaskIds: [],
      workspaceRoot: input.thread.workspace,
      goal: completionIntentText(input.request.prompt) || input.request.prompt,
      status: 'queued',
      acceptance,
      agentId: input.thread.agentId,
      model: selectedModel,
      providerId: input.request.providerId,
      engineeringPlanId: input.engineeringPlanId,
      reasoningEffort: input.request.reasoningEffort,
      budget: {
        maxAttempts: profile?.budget.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        maxDurationMs: profile?.budget.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
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
    if (!continuationTaskId && thread.domain === 'engineering' && !engineeringExecution) return {}
    if (!continuationTaskId && !shouldContinueActiveTask(request.prompt)) return {}
    const task = this.repository.findActiveByThread(thread.id)
    if (continuationTaskId && task?.id !== continuationTaskId) throw Object.assign(new Error('the task to resume is no longer active for this thread'), { code: 'invalid_state' })
    return task ? { model: task.model, providerId: task.providerId, reasoningEffort: task.reasoningEffort, engineeringPlanId: task.engineeringPlanId } : {}
  }

  activeTask(threadId: string): TaskRun | null {
    return this.repository.findActiveByThread(threadId)
  }

  getTask(taskId: string): TaskRun | null { return this.repository.get(taskId) }

  beginAttempt(threadId: string, turnId: string): TaskRun | null {
    const task = this.repository.findActiveByThread(threadId)
    if (!task || task.activeTurnId !== turnId || TERMINAL.has(task.status)) return task
    const now = this.nowIso()
    const expiresAt = new Date(Date.parse(now) + 60_000).toISOString()
    const lease = this.repository.acquireLease(task.id, this.ownerId, now, expiresAt)
    if (!lease) {
      throw Object.assign(new Error('task is already running in another runtime'), {
        code: 'task_lease_conflict'
      })
    }
    const started = this.repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: 'running',
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
    })
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
    const [thread, items] = await Promise.all([
      this.threadStore.get(threadId),
      this.sessionStore.loadItems(threadId)
    ])
    const turn = thread?.turns.find((candidate) => candidate.id === turnId)
    const turnItems = items.filter((item) => item.turnId === turnId)
    const pendingReason = pendingWorkReason(turnItems)
    if (pendingReason) return this.retry(task, pendingReason, fingerprint(turnItems), turnId)
    const blocked = this.completionGuard?.({ thread: thread ?? undefined, turn, task })
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
    const completed = this.repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: 'completed',
      waitingReason: undefined,
      stalledReason: undefined,
      finalResponse,
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
    this.repository.releaseLease(task.id, this.ownerId)
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

  recordAttemptFailure(threadId: string, turnId: string, code: string, message: string): TaskCandidateDecision | null {
    const task = this.repository.findActiveByThread(threadId)
    if (!task || task.activeTurnId !== turnId) return null
    if (code === 'operation_cancelled' || code === 'turn_total_timeout') {
      return this.finish(task, code === 'operation_cancelled' ? 'cancelled' : 'failed', message)
    }
    if (code === 'web_access_exhausted' || code === 'max_tokens') {
      return this.finish(task, 'failed', message)
    }
    return this.retry(
      task,
      message,
      `${code}:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`,
      turnId
    )
  }

  cancel(threadId: string, reason: string): TaskRun | null {
    const task = this.repository.findActiveByThread(threadId)
    if (!task) return null
    return this.finish(task, 'cancelled', reason).task
  }

  prepareResume(taskId: string, expectedRevision: number, model?: string): TaskRun {
    const task = this.repository.get(taskId)
    if (!task) throw Object.assign(new Error(`task not found: ${taskId}`), { code: 'not_found' })
    if (!['stalled', 'waiting_user', 'waiting_approval', 'retrying'].includes(task.status)) {
      throw Object.assign(new Error(`task cannot resume from ${task.status}`), { code: 'invalid_state' })
    }
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

  reconcileStartup(): TaskRun[] {
    const now = this.nowIso()
    return this.repository.reconcileExpired(now).map((task) => {
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
    const durationExhausted = Math.max(0, Date.parse(now) - Date.parse(stored.createdAt)) >= stored.budget.maxDurationMs
    const attemptExhausted = stored.attempts >= stored.budget.maxAttempts
    const stalled = replans >= 2 && shouldReplan
    const status: TaskRunStatus = durationExhausted
      ? 'failed'
      : stalled
        ? 'stalled'
        : attemptExhausted
          ? 'failed'
          : 'retrying'
    const next = this.repository.update(stored.id, stored.revision, (current) => ({
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
    if (status !== 'retrying') this.repository.releaseLease(next.id, this.ownerId)
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
    const next = this.repository.update(stored.id, stored.revision, (current) => ({
      ...current,
      status: 'waiting_user',
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
    this.repository.releaseLease(next.id, this.ownerId)
    this.spans?.finishTurn(next.id, turnId, {
      status: 'ok',
      attributes: { nextStatus: 'waiting_user' }
    })
    return { kind: 'waiting_user', task: next, reason }
  }

  private finish(task: TaskRun, status: Extract<TaskRunStatus, 'failed' | 'cancelled'>, reason: string): Extract<TaskCandidateDecision, { kind: 'failed' }> {
    const now = this.nowIso()
    const next = this.repository.update(task.id, task.revision, (current) => ({
      ...current,
      status,
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
    this.repository.releaseLease(task.id, this.ownerId)
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
      ...items.flatMap((item) => item.kind === 'tool_result' && !item.isError
        ? fileOutputPaths(item.output)
        : []),
      ...verifiedShellDeliverablePaths(items, turnId)
    ]
    const root = await realpath(task.workspaceRoot).catch(() => resolve(task.workspaceRoot))
    const required = task.acceptance.requiredFormats?.map((value) => value.toLowerCase())
    const artifacts: TaskArtifact[] = []
    for (const rawPath of [...new Set(paths)]) {
      const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)
      const canonical = await realpath(absolutePath).catch(() => '')
      const relativePath = canonical ? relative(root, canonical) : relative(root, absolutePath)
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

function acceptanceForPrompt(prompt: string): TaskAcceptance {
  const files = promptRequiresFileDeliverable(prompt)
  const requiredFormats = requiredFileExtensionsForPrompt(prompt)
  return {
    kind: files ? 'files' : 'answer',
    requiredNodeKinds: files ? ['execute', 'verify', 'deliver'] : ['deliver'],
    ...(requiredFormats ? { requiredFormats: [...requiredFormats] } : {}),
    ...(files ? { minimumArtifacts: 1 } : {}),
    requireFinalResponse: true,
    requireActionableArtifactCard: files
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
