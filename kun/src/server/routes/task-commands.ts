import type { ServerRuntime } from './server-runtime.js'
import { TaskCommandSchema } from '../../contracts/execution.js'
import { readJsonBody } from '../read-json-body.js'
import { jsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
export async function taskCommand(runtime:ServerRuntime,request:Request) {
  if(!runtime.taskCoordinator) return ERRORS.unavailable('task coordinator is unavailable')
  const body=await readJsonBody(request)
  if(!body.ok) return body.response
  const parsed=TaskCommandSchema.safeParse(body.value)
  if(!parsed.success) return ERRORS.validation('invalid task command',parsed.error.issues)
  try { const result=await runtime.taskCoordinator.command(parsed.data); return jsonResponse(result,result.kind==='snapshot'?200:202) }
  catch(error) {
    const code=(error as {code?:string}).code
    if(code==='not_found') return ERRORS.notFound((error as Error).message)
    if(['idempotency_conflict','stale_request','scope_conflict','turn_in_progress','task_intent_required','invalid_state','outcome_unknown'].includes(code??'')) return ERRORS.conflict((error as Error).message)
    throw error
  }
}
