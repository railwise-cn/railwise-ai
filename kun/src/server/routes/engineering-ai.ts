import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'
import {
  EngineeringAiError,
  EngineeringPlanApprovalRequest,
  EngineeringPlanDraftRequest,
  EngineeringPlanStartRequest,
  EngineeringPlanValidateRequest,
  EngineeringPlanCancelRequest,
  EngineeringPlanResumeRequest
} from '../../engineering/engineering-ai-orchestrator.js'
import { z } from 'zod'

const EngineeringWatchDraftRequest = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  expression: z.string().trim().min(1).max(500),
  enabled: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(200)
}).strict()

function unavailable(): JsonResponse { return ERRORS.unavailable('engineering AI is unavailable') }

function mapError(error: unknown): JsonResponse {
  if ((error as { code?: unknown })?.code === 'model_provider_unavailable') {
    return jsonResponse({ code: 'model_provider_unavailable', message: (error as Error).message }, 400)
  }
  if (error instanceof EngineeringAiError) {
    if (error.code === 'engineering_plan_stale') return jsonResponse({ code: error.code, message: error.message }, 409)
    if (error.code === 'not_found') return ERRORS.notFound(error.message)
    if (error.code.includes('stale') || error.code.includes('conflict')) return ERRORS.conflict(error.message)
    return ERRORS.validation(error.message)
  }
  if (error instanceof Error && /not found/i.test(error.message)) return ERRORS.notFound(error.message)
  return ERRORS.validation(error instanceof Error ? error.message : String(error))
}

export async function projectSuggestions(runtime: ServerRuntime, request: Request): Promise<JsonResponse> {
  if (!runtime.engineeringAi) return unavailable()
  const query = new URL(request.url).searchParams
  const threadId = query.get('threadId')?.trim(), projectId = query.get('projectId')?.trim()
  if (!threadId || !projectId) return ERRORS.validation('threadId and projectId are required')
  try { return jsonResponse({ suggestions: await runtime.engineeringAi.projectSuggestions(threadId, projectId) }) } catch (error) { return mapError(error) }
}

export async function decideProjectChange(runtime: ServerRuntime, id: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringAi) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = z.object({ token: z.string().min(16).max(200), decision: z.enum(['apply', 'reject']) }).strict().safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid project suggestion decision')
  try { return jsonResponse({ suggestion: await runtime.engineeringAi.decideProjectChange(id, parsed.data) }) } catch (error) { return mapError(error) }
}

export function context(runtime: ServerRuntime, projectId: string): JsonResponse {
  if (!runtime.engineeringContext) return unavailable()
  try { return jsonResponse(runtime.engineeringContext.snapshot(projectId)) } catch (error) { return mapError(error) }
}

export function evidence(runtime: ServerRuntime, projectId: string): JsonResponse {
  if (!runtime.engineeringContext) return unavailable()
  try { return jsonResponse({ projectId, cards: runtime.engineeringContext.evidence(projectId) }) } catch (error) { return mapError(error) }
}

export async function createWatchDraft(runtime: ServerRuntime, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringContext) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EngineeringWatchDraftRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid engineering watch draft body', parsed.error.issues)
  try { return jsonResponse({ watch: await runtime.engineeringContext.addWatchDraft(parsed.data) }, 201) } catch (error) { return mapError(error) }
}

export async function createPlan(runtime: ServerRuntime, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringAi) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EngineeringPlanDraftRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid engineering plan body', parsed.error.issues)
  try { return jsonResponse(await runtime.engineeringAi.createPlan(parsed.data), 201) } catch (error) { return mapError(error) }
}

export async function latestPlan(runtime: ServerRuntime, request: Request): Promise<JsonResponse> {
  if (!runtime.engineeringAi) return unavailable()
  const query = new URL(request.url).searchParams
  const threadId = query.get('threadId')?.trim() ?? ''
  const projectId = query.get('projectId')?.trim() ?? ''
  if (!threadId || !projectId) return ERRORS.validation('threadId and projectId are required')
  try {
    const result = await runtime.engineeringAi.latestPlan({ threadId, projectId })
    return result ? jsonResponse(result) : ERRORS.notFound('engineering plan not found for thread')
  } catch (error) {
    return mapError(error)
  }
}

export function getPlan(runtime: ServerRuntime, planId: string): JsonResponse {
  const plan = runtime.engineeringAi?.getPlan(planId)
  return plan ? jsonResponse(plan) : ERRORS.notFound(`engineering plan not found: ${planId}`)
}

export async function validatePlan(runtime: ServerRuntime, planId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringAi) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EngineeringPlanValidateRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid engineering plan validation body', parsed.error.issues)
  try { return jsonResponse(runtime.engineeringAi.validatePlan(planId, parsed.data)) } catch (error) { return mapError(error) }
}

export async function approvePlan(runtime: ServerRuntime, planId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringAi) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EngineeringPlanApprovalRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid engineering approval body', parsed.error.issues)
  try { return jsonResponse(runtime.engineeringAi.approvePlan(planId, parsed.data)) } catch (error) { return mapError(error) }
}

export async function startPlan(runtime: ServerRuntime, planId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringAi) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EngineeringPlanStartRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid engineering plan start body', parsed.error.issues)
  try { return jsonResponse(await runtime.engineeringAi.startPlan(planId, parsed.data), 202) } catch (error) { return mapError(error) }
}

export async function cancelPlan(runtime: ServerRuntime, planId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringAi) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EngineeringPlanCancelRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid engineering plan cancel body', parsed.error.issues)
  try { return jsonResponse(await runtime.engineeringAi.cancelPlan(planId, parsed.data)) } catch (error) { return mapError(error) }
}

export async function resumePlan(runtime: ServerRuntime, planId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.engineeringAi) return unavailable()
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = EngineeringPlanResumeRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid engineering plan resume body', parsed.error.issues)
  try { return jsonResponse(await runtime.engineeringAi.resumePlan(planId, parsed.data), 202) } catch (error) { return mapError(error) }
}
