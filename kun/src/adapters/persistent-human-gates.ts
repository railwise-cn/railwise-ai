import type { ApprovalGate } from '../ports/approval-gate.js'
import type { UserInputGate, UserInputRequest, UserInputResolution } from '../ports/user-input-gate.js'
import type { ApprovalRequest } from '../domain/approval.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { DurableHumanRequest, TaskRunRepository } from '../services/task-run-repository.js'

/** SQLite is authoritative; these maps only wake a currently live tool call. */
export class PersistentApprovalGate implements ApprovalGate {
  private readonly resolvers = new Map<string, { promise: Promise<'allow' | 'deny'>; resolve: (decision: 'allow' | 'deny') => void }>()
  constructor(private readonly repository: TaskRunRepository, private readonly nowIso: () => string) {}

  request(approval: ApprovalRequest): Promise<'allow' | 'deny'> {
    const saved = this.repository.saveHumanRequest({ id: approval.id, kind: 'approval', threadId: approval.threadId, turnId: approval.turnId,
      message: approval.summary, payload: { approval }, status: 'pending', createdAt: approval.createdAt, updatedAt: approval.createdAt })
    const previous = saved.payload.approval as ApprovalRequest | undefined
    if (saved.kind !== 'approval' || !previous || previous.threadId !== approval.threadId || previous.turnId !== approval.turnId ||
        previous.toolName !== approval.toolName || previous.summary !== approval.summary || previous.requestHash !== approval.requestHash ||
        previous.callId !== approval.callId || previous.networkReadOrigin !== approval.networkReadOrigin) {
      return Promise.reject(Object.assign(new Error('Approval identity belongs to a different operation.'), { code: 'approval_request_conflict' }))
    }
    if (saved.status !== 'pending') return Promise.resolve(approvalDecision(saved))
    const live = this.resolvers.get(approval.id)
    if (live) return live.promise
    let resolve!: (decision: 'allow' | 'deny') => void
    const promise = new Promise<'allow' | 'deny'>(settle => { resolve = settle })
    this.resolvers.set(approval.id, { promise, resolve })
    return promise
  }
  decide(id: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const saved = this.repository.humanRequest(id)
    if (!saved || saved.kind !== 'approval') return false
    if (saved.status !== 'pending') return saved.status === 'answered' && approvalDecision(saved) === decision
    const owner = taskRequestOwner(this.repository, saved)
    if (owner === null || owner?.status === 'paused') return false
    const now = this.nowIso()
    const temporaryGrant = owner?.authority?.taskApprovalGrant
    if (decision === 'allow' && owner && (owner.authority?.revokedAt || temporaryGrant && (
      temporaryGrant.status !== 'active' || temporaryGrant.revokedAt || Date.parse(temporaryGrant.expiresAt) <= Date.parse(now)
    ))) {
      this.repository.transact(() => {
        this.repository.update(owner.id, owner.revision, current => ({
          ...current, status: 'waiting_user', blockCode: 'approval_expired',
          waitingReason: '本次任务授权已失效，请重新检查后继续。', updatedAt: now
        }))
        this.repository.resolveHumanRequest(id, { decision: 'deny', reason: 'task_approval_expired' }, 'expired', now)
      })
      this.resolvers.get(id)?.resolve('deny')
      this.resolvers.delete(id)
      return false
    }
    const approval = saved.payload.approval as ApprovalRequest | undefined
    this.repository.transact(() => {
      this.repository.resolveHumanRequest(id, { decision, ...(reason ? { reason } : {}) }, 'answered', now)
      if (decision === 'allow' && owner && approval?.toolName === 'web_fetch' && approval.networkReadOrigin) {
        this.repository.approveTaskWebReadOrigin({ taskId: owner.id, threadId: approval.threadId, turnId: approval.turnId,
          approvalId: approval.id, origin: approval.networkReadOrigin, nowIso: now })
      }
    })
    this.flush()
    return true
  }
  get(id: string): ApprovalRequest | undefined {
    const saved = this.repository.humanRequest(id)
    if (!saved || saved.kind !== 'approval') return undefined
    const approval = saved.payload.approval as ApprovalRequest
    const resolution = saved.resolution as { decision?: string; reason?: string } | undefined
    return { ...approval, status: saved.status === 'pending' ? 'pending' : saved.status === 'expired' ? 'expired' : resolution?.decision === 'allow' ? 'allowed' : 'denied', ...(saved.status === 'pending' ? {} : { decidedAt: saved.updatedAt, reason: resolution?.reason }) }
  }
  pending(threadId?: string): ApprovalRequest[] {
    return this.repository.humanRequests('approval').filter(item => !threadId || item.threadId === threadId).map(item => this.get(item.id)!)
  }
  expireTurn(turnId: string, reason = 'operation_cancelled'): number {
    if (reason === 'application_exit') { this.resolvers.clear(); return 0 }
    let count = 0
    for (const item of this.repository.humanRequests('approval')) {
      if (item.turnId !== turnId) continue
      this.repository.resolveHumanRequest(item.id, { decision: 'deny', reason }, 'expired', this.nowIso())
      this.resolvers.get(item.id)?.resolve('deny')
      this.resolvers.delete(item.id)
      count++
    }
    return count
  }
  expireAll(reason = 'application_exit'): number {
    if (reason === 'application_exit') { this.resolvers.clear(); return 0 }
    return [...new Set(this.pending().map(item => item.turnId))].reduce((count, id) => count + this.expireTurn(id, reason), 0)
  }
  hasLiveResolver(id: string): boolean { return this.resolvers.has(id) }
  flush(): void {
    for (const [id, live] of this.resolvers) {
      const saved = this.repository.humanRequest(id)
      if (!saved || saved.status === 'pending') continue
      const task = taskRequestOwner(this.repository, saved)
      if (task?.status === 'paused') continue
      this.resolvers.delete(id)
      if (task !== null) this.markDelivered(saved, task)
      live.resolve(task === null || saved.status !== 'answered' ? 'deny' : approvalDecision(saved))
    }
  }
  private markDelivered(saved: DurableHumanRequest, task: TaskRun | undefined): void {
    if (!task) return
    markTaskHumanRequestDelivered(this.repository, task, saved.id, this.nowIso())
  }
}

export class PersistentUserInputGate implements UserInputGate {
  private readonly resolvers = new Map<string, { resolve: (answer: UserInputResolution) => void; reject: (error: Error) => void }>()
  constructor(private readonly repository: TaskRunRepository, private readonly nowIso: () => string) {}
  request(input: UserInputRequest): Promise<UserInputResolution> {
    const now = this.nowIso()
    const saved = this.repository.saveHumanRequest({ id: input.id, kind: 'question', threadId: input.threadId, turnId: input.turnId,
      message: input.prompt, payload: { input, questions: input.questions }, status: 'pending', createdAt: now, updatedAt: now })
    if (saved.status !== 'pending') return Promise.resolve(saved.resolution as UserInputResolution)
    return new Promise((resolve, reject) => this.resolvers.set(input.id, { resolve, reject }))
  }
  get(id: string): UserInputRequest | undefined {
    const saved = this.repository.humanRequest(id)
    return saved?.kind === 'question' ? saved.payload.input as UserInputRequest : undefined
  }
  resolve(id: string, answer: UserInputResolution): boolean {
    const saved = this.repository.humanRequest(id)
    if (!saved || saved.kind !== 'question' || saved.status !== 'pending') return false
    if (taskRequestOwner(this.repository, saved) === null) return false
    this.repository.resolveHumanRequest(id, answer, answer.status === 'submitted' ? 'answered' : 'cancelled', this.nowIso())
    this.flush()
    return true
  }
  resolveForTurnRestart(id: string): boolean {
    const saved = this.repository.humanRequest(id)
    if (!saved || saved.kind !== 'question' || saved.status !== 'pending') return false
    // Restart cancels this exact pending request. Settle its live tool call even
    // if the task owner has already become stale.
    this.repository.cancelQuestionForTurnRestart(id, this.nowIso())
    const resolver = this.resolvers.get(id)
    if (resolver) {
      this.resolvers.delete(id)
      resolver.resolve({ status: 'cancelled' })
    }
    return true
  }
  pending(threadId?: string): UserInputRequest[] {
    return this.repository.humanRequests('question').filter(item => !threadId || item.threadId === threadId).map(item => item.payload.input as UserInputRequest)
  }
  hasLiveResolver(id: string): boolean { return this.resolvers.has(id) }
  flush(): void {
    for (const [id, resolver] of this.resolvers) {
      const saved = this.repository.humanRequest(id)
      if (!saved || saved.status === 'pending') continue
      const task = taskRequestOwner(this.repository, saved)
      if (task?.status === 'paused') continue
      this.resolvers.delete(id)
      if (task) markTaskHumanRequestDelivered(this.repository, task, id, this.nowIso())
      resolver.resolve(task === null ? { status: 'cancelled' } : saved.resolution as UserInputResolution)
    }
  }
  reset(): void {
    // Detach live calls on shutdown; persisted questions remain answerable after restart.
    for (const resolver of this.resolvers.values()) resolver.reject(new Error('user input runtime stopped'))
    this.resolvers.clear()
  }
}

/** An unbound request belongs to a normal chat. A stale task request cannot wake another run. */
function taskRequestOwner(repository: TaskRunRepository, request: DurableHumanRequest): TaskRun | null | undefined {
  const attention = repository.attention(request.id)
  if (!attention?.taskId) return undefined
  const task = repository.get(attention.taskId)
  if (!task || task.threadId !== request.threadId || (task.activeTurnId && task.activeTurnId !== request.turnId) ||
      ['completed', 'failed', 'cancelled'].includes(task.status) || repository.currentExecution(task.id)?.id !== task.id) return null
  return task
}

function markTaskHumanRequestDelivered(repository: TaskRunRepository, task: TaskRun, requestId: string, now: string): void {
  const stillWaiting = repository.inbox(task.workspaceRoot).some(item => item.taskId === task.id &&
    (item.kind === 'approval' || item.kind === 'question'))
  if (!stillWaiting && ['waiting_user', 'waiting_approval'].includes(task.status)) {
    repository.update(task.id, task.revision, current => ({
      ...current, status: 'running', blockCode: undefined, waitingReason: undefined, executionStartedAt: now, updatedAt: now
    }))
  }
  repository.acknowledgeOutbox(`human:${requestId}`, now)
}

function approvalDecision(saved: DurableHumanRequest): 'allow' | 'deny' {
  return (saved.resolution as { decision?: string } | undefined)?.decision === 'allow' ? 'allow' : 'deny'
}
