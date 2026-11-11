import { createHash, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { TASK_DELIVERY_TEMPLATES, deliveryFlow, taskDeliveryTemplate, type TaskDeliveryParameters } from '../../delivery/templates.js'
import type { Router } from '../router.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'

const Parameters = z.object({ workspaceRoot: z.string().trim().min(1).max(4096), goal: z.string().trim().min(1).max(20_000),
  sourcePaths: z.array(z.string().trim().min(1).max(4096)).max(100).default([]), outputDirectory: z.string().trim().min(1).max(4096).optional(),
  outputFormats: z.array(z.enum(['md', 'docx', 'pdf'])).min(1).max(3).optional(),
  model: z.string().trim().min(1).max(256).optional(), providerId: z.string().trim().min(1).max(200).optional() })
const Start = Parameters.extend({ idempotencyKey: z.string().trim().min(1).max(256) }).strict()
const Save = Parameters.extend({ name: z.string().trim().min(1).max(160).optional() }).strict()

async function canonicalParameters(parameters: TaskDeliveryParameters): Promise<TaskDeliveryParameters> {
  const root = await realpath(parameters.workspaceRoot)
  if (!(await stat(root)).isDirectory()) throw new Error('Workspace must be a directory')
  const contained = (target: string) => { const rel = relative(root, target); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Task path escapes the workspace'); return target }
  const sources = await Promise.all((parameters.sourcePaths ?? []).map(async path => contained(await realpath(resolve(root, path)))))
  const output = resolve(root, parameters.outputDirectory ?? 'deliverables')
  contained(output)
  if (output === root || relative(root, output).split(sep)[0] === '.workwise') throw new Error('Choose a document output directory inside the workspace')
  // Existing parents must remain inside the canonical workspace, including symlinks.
  let parent = output
  while (parent !== root) {
    try { contained(await realpath(parent)); break } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; parent = resolve(parent, '..') }
  }
  return { ...parameters, workspaceRoot: root, sourcePaths: sources, outputDirectory: relative(root, output) }
}

export function registerTaskDeliveryRoutes(router: Router, runtime: ServerRuntime, authorized: (request: Request) => boolean): void {
  router.add('GET', '/v1/task-templates', async request => {
    if (!authorized(request)) return ERRORS.unauthorized()
    const tools = await runtime.toolHost?.listTools() ?? []
    let exportConfigured = false
    try {
      const url = new URL(process.env.RAILWISE_DOCUMENT_EXPORT_URL ?? '')
      exportConfigured = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && Boolean(process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN)
    } catch { /* The catalog describes configuration without making a network request. */ }
    const availability = { draftAvailable: Boolean(runtime.flowService && tools.some(tool => tool.name === 'propose_document')),
      model: runtime.info().model, exportStatus: exportConfigured ? 'configured' : 'unavailable' }
    return jsonResponse({ templates: TASK_DELIVERY_TEMPLATES.map(({ instruction: _instruction, ...item }) => ({ ...item, availability })) })
  })
  router.add('POST', '/v1/task-templates/:id/start', async (request, context) => {
    if (!authorized(request)) return ERRORS.unauthorized()
    if (!runtime.flowService) return ERRORS.unavailable('Flow Runtime is unavailable')
    const body = await readJsonBody(request); if (!body.ok) return body.response
    const parsed = Start.safeParse(body.value); if (!parsed.success) return ERRORS.validation('Invalid delivery task', parsed.error.issues)
    try {
      taskDeliveryTemplate(context.params.id)
      const { idempotencyKey, ...raw } = parsed.data
      const parameters = await canonicalParameters(raw)
      const graph = deliveryFlow(context.params.id, parameters, `${context.params.id}:${parameters.workspaceRoot}:${idempotencyKey}`)
      const repository = runtime.flowService.repository
      const operation = repository.beginOperation(graph.id, idempotencyKey, { templateId: context.params.id, ...parameters })
      if (!operation.created && operation.operation.status === 'succeeded') return jsonResponse(operation.operation.result)
      if (!repository.get(graph.id)) runtime.flowService.create(graph)
      const published = runtime.flowService.publish(graph.id)
      if (!published.published) return ERRORS.validation('Delivery Flow is invalid', published.validation.issues)
      const existing = repository.listRuns(graph.id, 1)[0]
      const run = existing ?? await runtime.flowService.run(graph.id, { goal: parameters.goal })
      const threadId = `thr_delivery_${createHash('sha256').update(`${run.id}:delivery`).digest('hex').slice(0, 24)}`
      const linked = repository.operation(`${run.id}:delivery`, 'task-start')?.result as { threadId?: string; taskId?: string } | undefined
      const result = { threadId: linked?.threadId ?? threadId, taskId: linked?.taskId ?? runtime.taskRepository?.list({ threadId, limit: 1 })[0]?.id, flowId: graph.id, flowRunId: run.id }
      repository.finishOperation(graph.id, idempotencyKey, 'succeeded', result)
      return jsonResponse(result, 202)
    } catch (error) { return deliveryError(error) }
  })
  router.add('POST', '/v1/task-templates/:id/save', async (request, context) => {
    if (!authorized(request)) return ERRORS.unauthorized()
    if (!runtime.flowService) return ERRORS.unavailable('Flow Runtime is unavailable')
    const body = await readJsonBody(request); if (!body.ok) return body.response
    const parsed = Save.safeParse(body.value); if (!parsed.success) return ERRORS.validation('Invalid delivery template', parsed.error.issues)
    try {
      const { name, ...raw } = parsed.data
      const graph = deliveryFlow(context.params.id, await canonicalParameters(raw), randomUUID(), name)
      return jsonResponse({ flow: runtime.flowService.create({ ...graph, variables: { ...graph.variables, userTemplate: true } }) }, 201)
    } catch (error) { return deliveryError(error) }
  })
}

function deliveryError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if ((error as { code?: string }).code === 'flow_revision_conflict') return ERRORS.conflict(message)
  return ERRORS.validation(message)
}
