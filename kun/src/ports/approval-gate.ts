import type { ApprovalRequest } from '../domain/approval.js'

/** Cancels the live wait while the persistent gate retains its recovery record. */
export async function waitForApprovalDecision(request: () => Promise<'allow' | 'deny'>, signal: AbortSignal): Promise<'allow' | 'deny'> {
  const cancelled = () => Object.assign(new Error('Tool approval wait was interrupted before dispatch.'), { code: 'operation_cancelled' })
  if (signal.aborted) throw cancelled()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  const decision = Promise.resolve().then(() => {
    if (signal.aborted) throw cancelled()
    return request()
  })
  try { return await Promise.race([decision, aborted]) }
  finally { signal.removeEventListener('abort', onAbort) }
}

/**
 * Port for the approval flow used by tool execution. The local gate
 * is the in-process registry; a remote gate could integrate with an
 * external service. The loop awaits a `decide` resolution before
 * proceeding with a tool call.
 */
export interface ApprovalGate {
  request(approval: ApprovalRequest): Promise<'allow' | 'deny'>
  decide(approvalId: string, decision: 'allow' | 'deny', reason?: string): boolean
  pending(threadId?: string): ApprovalRequest[]
  get(approvalId: string): ApprovalRequest | undefined
  expireTurn(turnId: string, reason?: string): number
  expireAll(reason?: string): number
}
