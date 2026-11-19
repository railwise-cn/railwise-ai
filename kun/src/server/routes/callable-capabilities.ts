import { isAbsolute } from 'node:path'
import { CallableCapabilityScopeSchema } from '../../contracts/callable-capabilities.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'

export async function listCallableCapabilities(runtime: ServerRuntime, request: Request): Promise<JsonResponse> {
  if (!runtime.callableCapabilities) return ERRORS.unavailable('Callable capability catalog is unavailable.')
  const body = await readJsonBody(request, 96 * 1024)
  if (!body.ok) return body.response
  const parsed = CallableCapabilityScopeSchema.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('Invalid callable capability scope.')
  const scope = parsed.data
  if (!scope.threadId && scope.workspace && (!isAbsolute(scope.workspace) || scope.workspace.includes('\0'))) {
    return ERRORS.validation('The capability workspace must be an absolute path.')
  }
  try {
    return jsonResponse({ choices: await runtime.callableCapabilities(scope) })
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'not_found') return ERRORS.notFound('Thread not found.')
    throw error
  }
}
