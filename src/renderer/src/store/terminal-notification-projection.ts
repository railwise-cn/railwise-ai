export type TerminalNotificationReason =
  | 'completed'
  | 'error'
  | 'aborted'
  | 'blocked'
  | 'max_tokens'
  | 'waiting_approval'
  | 'response_interrupted'

export type TerminalNotificationInput = {
  reason: TerminalNotificationReason
  threadId?: string | null
  turnId?: string | null
  approvalId?: string | null
}

export type TerminalNotificationContext = {
  activeThreadId?: string | null
  currentTurnId?: string | null
  watched?: boolean
}

export function terminalNotificationDedupeKey(input: TerminalNotificationInput): string {
  const threadId = input.threadId?.trim() || 'unknown-thread'
  if (input.reason === 'waiting_approval') {
    const approvalId = input.approvalId?.trim() || input.turnId?.trim() || 'unknown-approval'
    return `terminal:approval:${threadId}:${approvalId}`
  }
  return `terminal:turn:${threadId}:${input.turnId?.trim() || 'unknown-turn'}`
}

export function shouldProjectTerminalNotification(
  input: TerminalNotificationInput,
  context: TerminalNotificationContext
): boolean {
  const threadId = input.threadId?.trim()
  if (!threadId) return false
  if (input.reason === 'waiting_approval' && !input.approvalId?.trim()) return false
  if (context.watched === true) return true
  if (context.activeThreadId?.trim() !== threadId || !input.turnId?.trim()) return false
  return context.currentTurnId?.trim() === input.turnId?.trim()
}

export function terminalReasonForFailure(code?: string, message?: string): Exclude<TerminalNotificationReason, 'completed' | 'aborted' | 'waiting_approval'> {
  const value = `${code ?? ''} ${message ?? ''}`.toLowerCase()
  if (code === 'response_interrupted' || message?.startsWith('模型响应中断')) return 'response_interrupted'
  if (value.includes('max_tokens') || value.includes('max tokens') || value.includes('token limit')) return 'max_tokens'
  if (value.includes('blocked') || value.includes('budget_limited') || value.includes('policy_blocked')) return 'blocked'
  return 'error'
}

export function terminalReasonForTurnSnapshot(
  status?: string,
  error?: string
): Exclude<TerminalNotificationReason, 'waiting_approval'> {
  switch (status?.trim().toLowerCase()) {
    case 'completed':
      return 'completed'
    case 'aborted':
    case 'cancelled':
    case 'canceled':
      return 'aborted'
    case 'blocked':
      return 'blocked'
    case 'max_tokens':
      return 'max_tokens'
    case 'failed':
    case 'error':
      return terminalReasonForFailure(undefined, error)
    default:
      return error?.trim()
        ? terminalReasonForFailure(undefined, error)
        : 'completed'
  }
}
