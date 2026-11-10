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
  const expected = task.acceptance.effect ?? (intent?.provider ? {provider: intent.provider, operation: intent.operation, target: intent.target} : undefined)
  if (!expected) return []
  return receipts.flatMap(receipt => {
    if (receipt.ownerId !== task.id || receipt.kind !== 'tool' || receipt.status !== 'succeeded') return []
    const request = receipt.request
    const toolName = typeof request?.toolName === 'string' ? request.toolName : ''
    const spec = externalOperationForTool(toolName)
    if (!spec || spec.provider !== expected.provider || (expected.operation==='process' ? !['approve','reject','complete','transfer','send'].includes(spec.operation) : spec.operation !== expected.operation)) return []
    if (request?.provider && request.provider !== spec.provider) return []
    const result = receipt.result as {item?: {isError?: boolean; output?: unknown}; approved?: boolean} | undefined
    if (!result?.item || result.item.isError || result.approved === false) return []
    const output = result.item.output as Record<string, unknown> | undefined
    if (!output || output.ok !== true || output.status !== 'succeeded') return []
    const parsed = ResultEvidenceSchema.safeParse(output.evidence)
    if (!parsed.success) return []
    const evidence = parsed.data
    if (!evidence.verified || evidence.kind !== 'external_operation' || evidence.provider !== spec.provider || evidence.operation !== spec.operation) return []
    if (expected.target && evidence.target !== expected.target) return []
    if (request?.target && evidence.target !== request.target) return []
    // Writes require a specific target, a remote operation reference and explicit
    // confirmation. A successful list can never prove an approval or completion.
    if (['approve', 'reject', 'complete', 'send', 'transfer'].includes(spec.operation) &&
      (!request?.target || !evidence.remoteOperationId || result.approved !== true)) return []
    return [evidence]
  })
}
