import { ResultEvidenceSchema, type ResultEvidence } from '../contracts/harness.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import { externalTaskIntent } from './external-task-capability.js'

/** This finite catalog is owned by the runtime, never guessed from model prose. */
const TOOL_OPERATIONS: Record<string, {provider: string; operation: string}> = {
  lark_task_list: {provider: 'lark', operation: 'list'}, lark_task_get: {provider: 'lark', operation: 'detail'},
  lark_task_complete: {provider: 'lark', operation: 'complete'}, lark_approval_list: {provider: 'lark', operation: 'list'},
  lark_approval_get: {provider: 'lark', operation: 'detail'}, lark_approval_approve: {provider: 'lark', operation: 'approve'},
  lark_approval_reject: {provider: 'lark', operation: 'reject'},
  dingtalk_list_tasks: {provider: 'dingtalk', operation: 'list'}, dingtalk_get_task: {provider: 'dingtalk', operation: 'detail'},
  dingtalk_complete_task: {provider: 'dingtalk', operation: 'complete'}, dingtalk_list_approvals: {provider: 'dingtalk', operation: 'list'},
  dingtalk_get_approval: {provider: 'dingtalk', operation: 'detail'}, dingtalk_approve: {provider: 'dingtalk', operation: 'approve'},
  dingtalk_reject: {provider: 'dingtalk', operation: 'reject'}, dingtalk_transfer: {provider: 'dingtalk', operation: 'transfer'}
}
export function externalOperationForTool(name: string): {provider: string; operation: string} | undefined { return TOOL_OPERATIONS[name] }
export function externalTarget(args: Record<string, unknown>): string | undefined {
  for (const key of ['task_id', 'taskId', 'task_guid', 'approval_id', 'approvalId', 'instanceCode', 'instance_id', 'instanceId', 'target']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}
export function verifiedEffectReceipts(task: TaskRun, receipts: OperationReceipt[]): ResultEvidence[] {
  const intent = externalTaskIntent(task.goal)
  const accepted = task.acceptance.effect
  const required = accepted?.requiredEffects?.length
    ? accepted.requiredEffects
    : accepted?.provider && accepted.operation !== 'process' && accepted.target?.trim()
      ? [{ provider: accepted.provider, operation: accepted.operation, target: accepted.target.trim() }]
      : !accepted && intent?.provider && intent.operation && intent.target?.trim()
        ? [{ provider: intent.provider, operation: intent.operation, target: intent.target.trim() }]
        : []
  if (required.length === 0 || !task.activeTurnId) return []

  const verified = receipts.flatMap(receipt => {
    if (receipt.ownerId !== task.id || receipt.kind !== 'tool' || receipt.status !== 'succeeded') return []
    const request = receipt.request
    const requestTurnId = typeof request?.turnId === 'string' ? request.turnId : undefined
    const receiptTurnId = typeof receipt.turnId === 'string' ? receipt.turnId : undefined
    const turnId = requestTurnId ?? receiptTurnId
    if (!turnId || turnId !== task.activeTurnId || (receiptTurnId && receiptTurnId !== turnId)) return []
    const toolName = typeof request?.toolName === 'string' ? request.toolName : ''
    const spec = externalOperationForTool(toolName)
    if (!spec || request?.provider !== spec.provider) return []
    const expectedProviderId = spec.provider === 'lark' ? 'lark-cli' : 'dingtalk'
    if (request.providerId !== undefined && request.providerId !== expectedProviderId) return []
    if (request.operation !== spec.operation || (receipt.provider && receipt.provider !== spec.provider)
      || (receipt.toolName && receipt.toolName !== toolName)) return []
    if (typeof request.target !== 'string' || !request.target.trim()) return []
    if (receipt.target && receipt.target !== request.target) return []
    const result = receipt.result as {item?: {isError?: boolean; output?: unknown}; approved?: boolean} | undefined
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
