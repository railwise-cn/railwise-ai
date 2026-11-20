import {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse
} from '../../contracts/approvals.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'
import type { ApprovalGate } from '../../ports/approval-gate.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'

/**
 * POST /v1/approvals/{approvalId}. Resolves a pending approval
 * request and emits a runtime event for the renderer to consume.
 */
export async function decideApproval(input: {
  approvalId: string
  request: Request
  gate: ApprovalGate
  events: RuntimeEventRecorder
}): Promise<JsonResponse | Response> {
  const body = await readJsonBody(input.request)
  if (!body.ok) return body.response
  const parsed = ApprovalDecisionRequest.safeParse(body.value)
  if (!parsed.success) {
    return ERRORS.validation('invalid approval body', parsed.error.issues)
  }
  const approval = input.gate.get(input.approvalId)
  if (!approval) {
    return ERRORS.notFound(`approval not found: ${input.approvalId}`)
  }
  const response: ApprovalDecisionResponse = {
    approvalId: input.approvalId,
    decision: parsed.data.decision,
    status: parsed.data.decision === 'allow' ? 'allowed' : 'denied'
  }
  // A repeated click or a transport retry acknowledges the original decision only.
  if (approval.status === response.status) return jsonResponse(response)
  if (approval.status === 'expired') return ERRORS.conflict('本次授权已失效，请在原对话重新检查后继续。')
  if (approval.status !== 'pending') {
    return ERRORS.conflict('This approval is no longer available. Refresh the task to see its current state.')
  }
  const accepted = input.gate.decide(input.approvalId, parsed.data.decision, parsed.data.reason)
  const expired = !accepted && input.gate.get(input.approvalId)?.status === 'expired'
  if (!accepted && !expired) return ERRORS.conflict('This approval is no longer available. Refresh the task to see its current state.')
  await input.events.record({
    kind: 'approval_resolved' as const,
    threadId: approval.threadId,
    turnId: approval.turnId,
    itemId: undefined,
    approvalId: input.approvalId,
    toolName: approval.toolName,
    status: expired ? 'expired' : response.status,
    summary: approval.summary
  })
  return expired ? ERRORS.conflict('本次授权已失效，请在原对话重新检查后继续。') : jsonResponse(response)
}
