import { z } from 'zod'
import type { ServerRuntime } from './server-runtime.js'
import type { Router } from '../router.js'
import { jsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'

export function registerRuntimeUpdateRoutes(router: Router, runtime: ServerRuntime, authorize: (request: Request) => boolean): void {
  router.add('GET', '/v1/runtime/update', request => {
    if (!authorize(request)) return ERRORS.unauthorized()
    return runtime.updateLifecycle ? jsonResponse(runtime.updateLifecycle.snapshot()) : ERRORS.unavailable('Update handoff is unavailable.')
  })
  router.add('POST', '/v1/runtime/update/prepare', async request => {
    if (!authorize(request)) return ERRORS.unauthorized()
    if (!runtime.updateLifecycle) return ERRORS.unavailable('Update handoff is unavailable.')
    const body = await readJsonBody(request)
    if (!body.ok) return body.response
    const parsed = z.object({ confirmedSnapshotId: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().safeParse(body.value)
    if (!parsed.success) return ERRORS.validation('Invalid update confirmation.')
    try { return jsonResponse(await runtime.updateLifecycle.prepare(parsed.data.confirmedSnapshotId)) }
    catch (error) { return ERRORS.conflict(error instanceof Error ? error.message : String(error)) }
  })
}
