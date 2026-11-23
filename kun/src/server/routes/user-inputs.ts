import { z } from 'zod'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'
import type { UserInputAnswer, UserInputGate } from '../../ports/user-input-gate.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'

const UserInputAnswerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().default('')
})

const UserInputResolveRequest = z.object({
  answers: z.array(UserInputAnswerSchema).optional(),
  cancelled: z.boolean().optional()
})

export async function resolveUserInput(input: {
  inputId: string
  request: Request
  gate: UserInputGate
  events: RuntimeEventRecorder
  submitTaskUserInputAnswer?: (inputId: string, answers: UserInputAnswer[]) => Promise<'not_applicable' | 'submitted' | 'stale'>
}): Promise<JsonResponse | Response> {
  const body = await readJsonBody(input.request)
  if (!body.ok) return body.response
  const parsed = UserInputResolveRequest.safeParse(body.value)
  if (!parsed.success) {
    return ERRORS.validation('invalid user input body', parsed.error.issues)
  }
  const pending = input.gate.get(input.inputId)
  if (!pending) {
    return ERRORS.notFound(`user input not found: ${input.inputId}`)
  }
  const resolution = parsed.data.cancelled
    ? { status: 'cancelled' as const }
    : { status: 'submitted' as const, answers: parsed.data.answers ?? [] }
  if (resolution.status === 'submitted') {
    const taskAnswer = await input.submitTaskUserInputAnswer?.(input.inputId, resolution.answers)
    if (taskAnswer === 'stale') return ERRORS.conflict('这条任务问题已失效，请回到原对话查看最新进度。')
    if (taskAnswer === 'submitted') {
      return jsonResponse({ inputId: input.inputId, status: resolution.status, answers: resolution.answers })
    }
  }
  const ok = input.gate.resolve(input.inputId, resolution)
  if (!ok) {
    return ERRORS.conflict(`user input already resolved: ${input.inputId}`)
  }
  await input.events.record({
    kind: 'user_input_resolved',
    threadId: pending.threadId,
    turnId: pending.turnId,
    itemId: pending.itemId,
    inputId: pending.id,
    status: resolution.status,
    prompt: pending.prompt
  })
  return jsonResponse({
    inputId: input.inputId,
    status: resolution.status,
    ...(resolution.status === 'submitted' ? { answers: resolution.answers } : {})
  })
}
