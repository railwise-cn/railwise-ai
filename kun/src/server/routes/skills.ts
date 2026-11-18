import { isAbsolute } from 'node:path'
import { ERRORS } from './runtime-error.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import type { ServerRuntime } from './server-runtime.js'

export async function listSkills(runtime: ServerRuntime, request: Request): Promise<JsonResponse> {
  const query = new URL(request.url).searchParams
  let workspace: string | undefined
  const scope = query.get('scope')
  if (scope !== null && scope !== 'available') return ERRORS.validation('invalid Skill catalog scope')
  if (scope === 'available') {
    const threadId = query.get('threadId')
    if (threadId) {
      const thread = await runtime.threadService.get(threadId)
      if (!thread || thread.status === 'deleted') return ERRORS.notFound('thread not found')
      workspace = thread.workspace
    } else {
      workspace = query.get('workspace') ?? ''
      if (workspace && (!isAbsolute(workspace) || workspace.includes('\0'))) {
        return ERRORS.validation('the Skill workspace must be an absolute path')
      }
    }
  }
  const diagnostics = runtime.skills
    ? await runtime.skills(workspace)
    : {
        enabled: false,
        roots: [],
        skills: [],
        validationErrors: [],
        lastActivations: []
      }
  return jsonResponse({
    enabled: diagnostics.enabled,
    skills: diagnostics.skills,
    ...(workspace !== undefined
      ? { scope: 'available' as const }
      : { roots: diagnostics.roots, validationErrors: diagnostics.validationErrors })
  })
}
