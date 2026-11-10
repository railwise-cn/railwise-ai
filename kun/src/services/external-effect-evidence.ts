import { ResultEvidenceSchema, type ResultEvidence } from '../contracts/harness.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import { externalTaskIntent } from './external-task-capability.js'

/** A resolution can only be accepted with its separately persisted readback receipt. */
function resolutionEvidence(receipt: OperationReceipt, receipts: OperationReceipt[]): ResultEvidence | undefined {
  const resolution = receipt.resolution
  if (receipt.status !== 'outcome_unknown' || !resolution) return undefined
  const proof = receipts.find(item => item.id === resolution.receiptId && item.ownerId === receipt.ownerId && item.kind === 'effect_verification' && item.status === 'succeeded')
  if (proof?.request?.originalReceiptId !== receipt.id || proof.request.originalFingerprint !== receipt.fingerprint) return undefined
  const parsed = ResultEvidenceSchema.safeParse((proof.result as {evidence?: unknown} | undefined)?.evidence)
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(resolution.evidence)) return undefined
  return parsed.data
}

/** This finite catalog is owned by the runtime, never guessed from model prose. */
const TOOL_OPERATIONS: Record<string, {provider: string; operation: string}> = {
  lark_task_list: {provider: 'lark', operation: 'list'}, lark_task_get: {provider: 'lark', operation: 'detail'},
  lark_task_complete: {provider: 'lark', operation: 'complete'}, lark_approval_list: {provider: 'lark', operation: 'list'},
  lark_approval_get: {provider: 'lark', operation: 'detail'}, lark_approval_approve: {provider: 'lark', operation: 'approve'},
  lark_approval_reject: {provider: 'lark', operation: 'reject'},
  dingtalk_list_tasks: {provider: 'dingtalk', operation: 'list'}, dingtalk_get_task: {provider: 'dingtalk', operation: 'detail'},
  dingtalk_complete_task: {provider: 'dingtalk', operation: 'complete'}, dingtalk_list_approvals: {provider: 'dingtalk', operation: 'list'},
  dingtalk_get_approval: {provider: 'dingtalk', operation: 'detail'}, dingtalk_approve: {provider: 'dingtalk', operation: 'approve'},
  dingtalk_get_approval_tasks: {provider:'dingtalk',operation:'detail'},
  dingtalk_reject: {provider: 'dingtalk', operation: 'reject'}, dingtalk_transfer: {provider: 'dingtalk', operation: 'transfer'}
}
export function externalOperationForTool(name: string): {provider: string; operation: string} | undefined { return TOOL_OPERATIONS[name] }
export function externalTarget(args: Record<string, unknown>, toolName?: string): string | undefined {
  for (const key of ['task_id', 'taskId', 'task_guid', 'approval_id', 'approvalId', 'instanceCode', 'instance_id', 'instanceId', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return toolName && externalOperationForTool(toolName)?.operation === 'list' ? 'current_user' : undefined
}
export function verifiedEffectReceipts(task: TaskRun, receipts: OperationReceipt[], trustedAttemptTurnIds: ReadonlySet<string> = new Set()): ResultEvidence[] {
  const intent = externalTaskIntent(task.goal)
  const accepted = task.acceptance.effect
  const required = accepted?.requiredEffects?.length
    ? accepted.requiredEffects
    : accepted?.provider && accepted.operation !== 'process' && accepted.target?.trim()
      ? [{ provider: accepted.provider, operation: accepted.operation, target: accepted.target.trim() }]
      : !accepted && intent?.provider && intent.operation && intent.target?.trim()
        ? [{ provider: intent.provider, operation: intent.operation, target: intent.target.trim() }]
        : []
  // A broad process request has no finite acceptance boundary until its
  // reviewed target set is persisted as requiredEffects. One successful write
  // receipt cannot prove that every requested item was handled.
  if (required.length === 0 || !task.activeTurnId) return []

  const verified = receipts.flatMap(receipt => {
    const resolution = resolutionEvidence(receipt, receipts)
    if (receipt.ownerId !== task.id || receipt.kind !== 'tool' || (receipt.status !== 'succeeded' && !resolution)) return []
    const request = receipt.request
    const requestTurnId = typeof request?.turnId === 'string' ? request.turnId : undefined
    const receiptTurnId = typeof receipt.turnId === 'string' ? receipt.turnId : undefined
    const turnId = requestTurnId ?? receiptTurnId
    if (!turnId || (turnId !== task.activeTurnId && !trustedAttemptTurnIds.has(turnId)) || (receiptTurnId && receiptTurnId !== turnId)) return []
    const toolName = typeof request?.toolName === 'string' ? request.toolName : ''
    const spec = externalOperationForTool(toolName)
    if (!spec || request?.provider !== spec.provider) return []
    const expectedProviderId = spec.provider === 'lark' ? 'lark-cli' : 'dingtalk'
    if (request.providerId !== undefined && request.providerId !== expectedProviderId) return []
    if (request.operation !== spec.operation || (receipt.provider && receipt.provider !== spec.provider)
      || (receipt.toolName && receipt.toolName !== toolName)) return []
    if (typeof request.target !== 'string' || !request.target.trim()) return []
    if (receipt.target && receipt.target !== request.target) return []
    const originalResult = receipt.result as {item?: {isError?: boolean; output?: unknown}; approved?: boolean} | undefined
    const approval = receipt.dispatchApproval
    const approved = originalResult?.approved === true || Boolean(approval && approval.toolName === toolName && approval.requestHash === request.approvalRequestHash)
    const result = resolution ? { approved, item: { isError: false, output: { ok: true, status: 'succeeded', evidence: resolution } } } : originalResult
    if (!result?.item || result.item.isError || result.approved === false) return []
    const output = result.item.output as Record<string, unknown> | undefined
    if (!output || output.ok !== true || output.status !== 'succeeded') return []
    const parsed = ResultEvidenceSchema.safeParse(output.evidence)
    if (!parsed.success) return []
    const evidence = parsed.data
    if (!evidence.verified || evidence.kind !== 'external_operation' || evidence.provider !== spec.provider || evidence.operation !== spec.operation) return []
    if (evidence.target !== request.target) return []
    // Writes require a specific target, verified provider readback, and explicit
    // confirmation. A transport request ID is not a remote operation ID.
    if (['approve', 'reject', 'complete', 'send', 'transfer'].includes(spec.operation) &&
      (!request?.target || !evidence.status || !evidence.resultHash || result.approved !== true)) return []
    return [evidence]
  })

  const requiredKeys = new Set(required.map(effectKey))
  const matched = new Map(verified.map(evidence => [effectKey(evidence), evidence]))
  if ([...requiredKeys].some(key => !matched.has(key))) return []
  return [...requiredKeys].flatMap(key => {
    const evidence = matched.get(key)
    return evidence ? [evidence] : []
  })
}

function effectKey(effect: { provider: string; operation: string; target: string }): string {
  return JSON.stringify([effect.provider, effect.operation, effect.target])
}
