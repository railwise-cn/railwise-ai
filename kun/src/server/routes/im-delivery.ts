import { ImDeliveryObservationSchema } from '../../contracts/im-delivery.js'
import type { ServerRuntime } from './server-runtime.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

export async function recordImDelivery(runtime: ServerRuntime, threadId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.taskRepository) return ERRORS.unavailable('Task repository unavailable.')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = ImDeliveryObservationSchema.safeParse(body.value)
  if (!parsed.success || parsed.data.runtimeThreadId !== threadId) return ERRORS.validation('Invalid IM delivery observation.')
  if (parsed.data.status === 'succeeded' && !parsed.data.remoteOperationId && !(parsed.data.provider === 'weixin' && parsed.data.clientOperationId)) return ERRORS.validation('A delivered operation requires its acknowledged identifier.')
  const thread = await runtime.threadService.get(threadId)
  if (!thread?.turns.some(turn => turn.id === parsed.data.runtimeTurnId)) return ERRORS.notFound('The original IM thread and turn are unavailable.')
  try { return jsonResponse(runtime.taskRepository.recordImDeliveryObservation(parsed.data)) }
  catch (error) {
    return (error as { code?: string })?.code === 'idempotency_conflict'
      ? ERRORS.conflict('The delivery operation is already bound to another request.') : ERRORS.internal('Unable to record delivery observation.')
  }
}
