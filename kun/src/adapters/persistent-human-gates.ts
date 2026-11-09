import type { ApprovalGate } from '../ports/approval-gate.js'
import type { UserInputGate, UserInputRequest, UserInputResolution } from '../ports/user-input-gate.js'
import type { ApprovalRequest } from '../domain/approval.js'
import type { DurableHumanRequest, TaskRunRepository } from '../services/task-run-repository.js'

/** SQLite is authoritative; these maps only wake a currently live tool call. */
export class PersistentApprovalGate implements ApprovalGate {
  private readonly resolvers = new Map<string, (decision: 'allow' | 'deny') => void>()
  constructor(private readonly repository: TaskRunRepository, private readonly nowIso: () => string) {}

  request(approval: ApprovalRequest): Promise<'allow' | 'deny'> {
    const saved = this.repository.saveHumanRequest({ id: approval.id, kind: 'approval', threadId: approval.threadId, turnId: approval.turnId,
      message: approval.summary, payload: { approval }, status: 'pending', createdAt: approval.createdAt, updatedAt: approval.createdAt })
    if (saved.status !== 'pending') return Promise.resolve(approvalDecision(saved))
    return new Promise(resolve => this.resolvers.set(approval.id, resolve))
  }
  decide(id: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const saved = this.repository.humanRequest(id)
    if (!saved || saved.kind !== 'approval') return false
    this.repository.resolveHumanRequest(id, { decision, ...(reason ? { reason } : {}) }, 'answered', this.nowIso())
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
      this.resolvers.get(item.id)?.('deny')
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
    for (const [id, resolve] of this.resolvers) {
      const saved = this.repository.humanRequest(id)
      if (!saved || saved.status === 'pending') continue
      const task = this.repository.findActiveByThread(saved.threadId)
      if (task?.status === 'paused') continue
      this.markDelivered(saved)
      this.resolvers.delete(id)
      resolve(approvalDecision(saved))
    }
  }
  private markDelivered(saved: DurableHumanRequest): void {
    const task = this.repository.findActiveByThread(saved.threadId)
    if (!task) return
    if (['waiting_approval', 'waiting_user'].includes(task.status)) this.repository.update(task.id, task.revision, current => ({ ...current, status: 'running', waitingReason: undefined, executionStartedAt: this.nowIso(), updatedAt: this.nowIso() }))
    this.repository.acknowledgeOutbox(`human:${saved.id}`, this.nowIso())
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
    if (!saved || saved.kind !== 'question') return false
    this.repository.resolveHumanRequest(id, answer, answer.status === 'submitted' ? 'answered' : 'cancelled', this.nowIso())
    this.flush()
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
      const task = this.repository.findActiveByThread(saved.threadId)
      if (task?.status === 'paused') continue
      this.resolvers.delete(id)
      if (task) {
        if (['waiting_user', 'waiting_approval'].includes(task.status)) this.repository.update(task.id, task.revision, current => ({ ...current, status: 'running', waitingReason: undefined, executionStartedAt: this.nowIso(), updatedAt: this.nowIso() }))
      }
      this.repository.acknowledgeOutbox(`human:${id}`, this.nowIso())
      resolver.resolve(saved.resolution as UserInputResolution)
    }
  }
  reset(): void {
    // Detach live calls on shutdown; persisted questions remain answerable after restart.
    for (const resolver of this.resolvers.values()) resolver.reject(new Error('user input runtime stopped'))
    this.resolvers.clear()
  }
}

function approvalDecision(saved: DurableHumanRequest): 'allow' | 'deny' {
  return (saved.resolution as { decision?: string } | undefined)?.decision === 'allow' ? 'allow' : 'deny'
}
