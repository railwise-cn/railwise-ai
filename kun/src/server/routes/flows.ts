import { z } from 'zod'
import { FlowApiContractsV1, FlowDefinitionV1 } from '../../contracts/flow.js'
import type { FlowRuntimeService } from '../../flow/service.js'
import { FlowRevisionConflictError } from '../../flow/repository.js'
import { RUNTIME_RESOURCE_LIMITS_V1 } from '../../contracts/resource-limits.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'

const FlowCreate = FlowDefinitionV1.omit({ revision: true, createdAt: true, updatedAt: true })
const IdInput = z.object({ id: z.string().min(1) }).strict()
const RetryInput = z.object({ nodeId: z.string().min(1) }).strict()
const WebhookProvisionInput = z.object({ nodeId: z.string().min(1) }).strict()
const LegacyScheduleTask = z.object({
  id: z.string().min(1), title: z.string(), enabled: z.boolean(), prompt: z.string(), workspaceRoot: z.string(), model: z.string(), reasoningEffort: z.string(), mode: z.string(),
  schedule: z.object({ kind: z.string(), everyMinutes: z.number(), timeOfDay: z.string(), atTime: z.string(), times: z.array(z.string()).optional(), timezone: z.string().optional() }).strict(),
  createdAt: z.string(), updatedAt: z.string(), lastRunAt: z.string(), nextRunAt: z.string(), lastStatus: z.string(), lastMessage: z.string(), lastThreadId: z.string()
}).strict()
const LegacyScheduleMigration = z.object({ tasks: z.array(LegacyScheduleTask).max(512) }).strict()

export const flowRoutes = {
  list(service?: FlowRuntimeService): JsonResponse { return service ? jsonResponse({ flows: service.list(), registry: service.registry }) : ERRORS.unavailable('Flow Runtime is unavailable') },
  get(service: FlowRuntimeService | undefined, id: string): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); const flow = service.get(id); return flow ? jsonResponse({ flow }) : ERRORS.notFound('Flow not found') },
  versions(service: FlowRuntimeService | undefined, id: string): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { return jsonResponse({ versions: service.versions(id) }) } catch (error) { return flowError(error) } },
  archive(service: FlowRuntimeService | undefined, id: string): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { return jsonResponse({ flow: service.archive(id), archived: true }) } catch (error) { return flowError(error) } },
  async create(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, FlowCreate, (value) => jsonResponse({ flow: service.create(value) }, 201)) },
  async update(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, FlowApiContractsV1.update, (value) => jsonResponse({ flow: service.update(value.definition, value.expectedRevision) })) },
  async validate(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, FlowApiContractsV1.validate, (value) => jsonResponse(service.validate(value.definition))) },
  async publish(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, IdInput, (value) => { const result = service.publish(value.id); return jsonResponse(result, result.published ? 201 : 400) }) },
  async run(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, FlowApiContractsV1.run, async (value) => jsonResponse({ run: await service.run(value.flowId, value.input, value.invocationStack) }, 202)) },
  async testNode(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); const schema = z.object({ definition: FlowDefinitionV1, nodeId: z.string(), mockInput: z.unknown() }).strict(); return parseAndRun(request, schema, async (value) => jsonResponse({ result: await service.testNode(value.definition, value.nodeId, value.mockInput) })) },
  history(service: FlowRuntimeService | undefined, id: string, request: Request): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100); return jsonResponse({ runs: service.history(id, limit) }) },
  runDetails(service: FlowRuntimeService | undefined, id: string): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); const details = service.runDetails(id); return details ? jsonResponse(details) : ERRORS.notFound('Flow run not found') },
  async action(service: FlowRuntimeService | undefined, id: string, action: 'cancel' | 'resume' | 'retry', request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { if (action === 'cancel') return jsonResponse({ cancelled: service.cancel(id) }); if (action === 'resume') return jsonResponse({ run: await service.resume(id) }, 202); return parseAndRun(request, RetryInput, async (value) => jsonResponse({ run: await service.retryFrom(id, value.nodeId) }, 202)) } catch (error) { return flowError(error) } },
  async decide(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, FlowApiContractsV1.decision, async (value) => jsonResponse({ run: await service.decide(value.runId, value.nodeId, value.decision, value.note) }, 202)) },
  async provisionWebhook(service: FlowRuntimeService | undefined, flowId: string, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, WebhookProvisionInput, async (value) => jsonResponse({ webhook: await service.provisionWebhook(flowId, value.nodeId) }, 201)) },
  async webhook(service: FlowRuntimeService | undefined, triggerId: string, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { return jsonResponse({ run: await service.handleWebhook(triggerId, request) }, 202) } catch (error) { const code = (error as { code?: string }).code ?? ''; const message = error instanceof Error ? error.message : String(error); if (code === 'webhook_rate_limit') return ERRORS.resourceLimit(message); if (code === 'webhook_body_limit') return ERRORS.validation(message); return code.startsWith('webhook_') ? ERRORS.unauthorized(message) : flowError(error) } },
  async migrateSchedules(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, LegacyScheduleMigration, (value) => jsonResponse(service.migrateLegacySchedules(value.tasks))) },
  listLegacySchedules(service?: FlowRuntimeService): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { return jsonResponse({ tasks: service.listLegacySchedules() }) } catch (error) { return flowError(error) } },
  async createLegacySchedule(service: FlowRuntimeService | undefined, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, LegacyScheduleTask, (value) => jsonResponse({ task: service.createLegacySchedule(value) }, 201)) },
  async updateLegacySchedule(service: FlowRuntimeService | undefined, id: string, request: Request): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); return parseAndRun(request, LegacyScheduleTask, (value) => jsonResponse({ task: service.updateLegacySchedule(id, value) })) },
  async runLegacySchedule(service: FlowRuntimeService | undefined, id: string): Promise<JsonResponse> { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { return jsonResponse({ run: await service.runLegacySchedule(id) }, 202) } catch (error) { return flowError(error) } },
  archiveLegacySchedule(service: FlowRuntimeService | undefined, id: string): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { return service.archiveLegacySchedule(id) ? jsonResponse({ archived: true }) : ERRORS.notFound('Schedule task not found') } catch (error) { return flowError(error) } },
  export(service: FlowRuntimeService | undefined, id: string): JsonResponse { if (!service) return ERRORS.unavailable('Flow Runtime is unavailable'); try { return jsonResponse({ flow: service.exportRedacted(id) }) } catch (error) { return flowError(error) } }
}

async function parseAndRun<S extends z.ZodTypeAny>(request: Request, schema: S, run: (value: z.output<S>) => JsonResponse | Promise<JsonResponse>): Promise<JsonResponse> {
  const body = await readJsonBody(request, RUNTIME_RESOURCE_LIMITS_V1.jsonRequestBodyBytes); if (!body.ok) return body.response
  const parsed = schema.safeParse(body.value); if (!parsed.success) return ERRORS.validation('Invalid Flow request', parsed.error.issues)
  try { return await run(parsed.data) } catch (error) { return flowError(error) }
}
function flowError(error: unknown): JsonResponse { if (error instanceof FlowRevisionConflictError) return ERRORS.conflict(error.message); const message = error instanceof Error ? error.message : String(error); return /not found|missing/i.test(message) ? ERRORS.notFound(message) : ERRORS.validation(message) }
