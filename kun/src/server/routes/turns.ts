import {
  CompactRequest,
  InterruptTurnRequest,
  InterruptTurnResponse,
  StartTurnRequest,
  StartTurnResponse,
  SteerTurnRequest,
  TurnSchema
} from '../../contracts/turns.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'
import type { TurnService } from '../../services/turn-service.js'

export async function startTurn(
  turns: TurnService,
  threadId: string,
  request: Request,
  onStarted?: (response: StartTurnResponse) => void
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = StartTurnRequest.safeParse(body.value)
  if (!parsed.success) {
    return ERRORS.validation('invalid start turn body', parsed.error.issues)
  }
  try {
    const response: StartTurnResponse = await turns.startTurn({
      threadId,
      request: parsed.data
    })
    onStarted?.(response)
    return jsonResponse(response, 202)
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'model_provider_unavailable') {
      return jsonResponse({ code: 'model_provider_unavailable', message: (error as Error).message }, 400)
    }
    if (error instanceof Error && /not found/i.test(error.message)) {
      return ERRORS.notFound(error.message)
    }
    if ((error as { code?: unknown })?.code === 'turn_in_progress') {
      return ERRORS.conflict('a turn is already running for this thread')
    }
    if ((error as { code?: unknown })?.code === 'idempotency_conflict') {
      return ERRORS.conflict('idempotency key is already bound to a different request')
    }
    if ((error as { code?: unknown })?.code === 'resource_limit') {
      return ERRORS.resourceLimit('the application turn concurrency limit has been reached')
    }
    if ((error as { code?: unknown })?.code === 'workspace_reference_invalid') {
      return ERRORS.validation(error instanceof Error ? error.message : 'invalid workspace reference')
    }
    throw error
  }
}

export async function steerTurn(
  turns: TurnService,
  threadId: string,
  turnId: string,
  request: Request
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = SteerTurnRequest.safeParse(body.value)
  if (!parsed.success) {
    return ERRORS.validation('invalid steer turn body', parsed.error.issues)
  }
  await turns.steerTurn({ threadId, turnId, text: parsed.data.text })
  return jsonResponse({ ok: true })
}

export async function interruptTurn(
  turns: TurnService,
  threadId: string,
  turnId: string,
  request: Request
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = InterruptTurnRequest.safeParse(body.value ?? {})
  if (!parsed.success) {
    return ERRORS.validation('invalid interrupt turn body', parsed.error.issues)
  }
  const result = await turns.interruptTurn({ threadId, turnId, discard: parsed.data.discard })
  const payload: InterruptTurnResponse = {
    threadId,
    turnId,
    status: result.status
  }
  return jsonResponse(payload)
}

export async function compactTurn(
  turns: TurnService,
  threadId: string,
  request: Request
): Promise<JsonResponse | Response> {
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = CompactRequest.safeParse(body.value ?? {})
  if (!parsed.success) {
    return ERRORS.validation('invalid compact body', parsed.error.issues)
  }
  try {
    const response = await turns.compact({
      threadId,
      request: parsed.data
    })
    return jsonResponse(response)
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) {
      return ERRORS.notFound(error.message)
    }
    throw error
  }
}

export async function getTurn(
  turns: TurnService,
  threadId: string,
  turnId: string
): Promise<JsonResponse> {
  const turn = await turns.getTurn(threadId, turnId)
  if (!turn) {
    return jsonResponse(
      { code: 'not_found', message: `turn not found: ${turnId}` },
      404
    )
  }
  return jsonResponse(TurnSchema.parse(turn))
}
