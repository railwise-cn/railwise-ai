import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { LarkCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'
import { assertGrantAllowsNetwork, assertGrantConnectorScopes } from './sandbox-policy.js'

const execFileAsync = promisify(execFile)
export type LarkCommandResult = { ok: boolean; output: unknown; isError?: boolean }
export type LarkCliRunner = (executablePath: string, args: string[], signal: AbortSignal) => Promise<LarkCommandResult>

const defaultRunner: LarkCliRunner = async (executablePath, args, signal) => {
  try {
    const result = await execFileAsync(executablePath, args, { signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    return normalizeLarkResult({ ok: true, output: parseJsonOutput(String(result.stdout ?? '')) })
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: parseJsonOutput(String(value.stdout || value.stderr || value.message || 'Lark CLI failed')), isError: true }
  }
}

const textId = z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f]/u.test(value), 'Invalid identifier')
const taskId = z.object({ taskId: textId }).strict()
const instanceId = z.object({ instanceCode: textId }).strict()
const taskQuery = z.object({ query: z.string().trim().max(1000).optional() }).strict()
const approvalQuery = z.object({ keyword: z.string().trim().max(1000).optional(), pageToken: textId.optional() }).strict()
const approvalAction = z.object({ instanceCode: textId, taskId: textId, comment: z.string().max(500).optional() }).strict()
const jsonFlags = ['--format', 'json', '--as', 'user']
const idSchema = { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, required: ['taskId'], additionalProperties: false }
const instanceSchema = { type: 'object', properties: { instanceCode: { type: 'string', minLength: 1 } }, required: ['instanceCode'], additionalProperties: false }
const actionSchema = { type: 'object', properties: { instanceCode: { type: 'string', minLength: 1 }, taskId: { type: 'string', minLength: 1 }, comment: { type: 'string', maxLength: 500 } }, required: ['instanceCode', 'taskId'], additionalProperties: false }

/** A fixed, verified CLI subset. Arguments never pass through a shell or come from model command text. */
export function buildLarkCliToolProvider(config: LarkCapabilityConfig | undefined, runner: LarkCliRunner = defaultRunner): CapabilityToolProvider | undefined {
  if (!config?.enabled || config.authState !== 'installed' || !config.executablePath || !config.brand) return undefined
  const scopes = new Set(config.scopes)
  const provider = 'lark'
  const apiRoot = config.brand === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com'
  const hasScopes = (required: readonly string[]) => required.every(scope => scopes.has(scope))
  const run = async (args: string[], required: string[], context: ToolHostContext) => {
    if (context.abortSignal.aborted) throw new Error('Lark command aborted before start')
    if (!hasScopes(required)) throw new Error('connector_scope_missing')
    assertGrantAllowsNetwork(apiRoot, context)
    assertGrantConnectorScopes(required, context)
    context.assertExecution?.()
    return normalizeLarkResult(await runner(config.executablePath!, args, context.abortSignal))
  }
  type Spec = { name: string; description: string; schema: Record<string, unknown>; parse: z.ZodType<Record<string, unknown>>; scopes: string[]; operation: string; mutation?: boolean; args: (args: Record<string, unknown>) => string[] }
  const define = (spec: Spec) => defineLocalTool({
    name: spec.name, description: spec.description, inputSchema: spec.schema,
    policy: spec.mutation ? 'on-request' : 'auto',
    ...(spec.mutation ? { requireExplicitApproval: true } : {}),
    shouldAdvertise: () => hasScopes(spec.scopes),
    execute: async (raw, context) => {
      const args = spec.parse.parse(raw)
      const target = typeof args.taskId === 'string' ? args.taskId : typeof args.instanceCode === 'string' ? args.instanceCode : 'current_user'
      const result = await run(spec.args(args), spec.scopes, context)
      if (!result.ok) {
        const response = asRecord(result.output)
        const remoteRejected = 'code' in response && response.code !== 0 && response.code !== '0'
        return failure(result.output, spec.mutation && !remoteRejected ? 'outcome_unknown' : 'failed', provider, spec.operation, target)
      }
      let data = dataOf(result.output)
      let remoteStatus: string | undefined
      if (spec.operation === 'complete') {
        remoteStatus = verifiedTaskState(data, target)
        if (!remoteStatus) {
          const check = await run(['task', 'tasks', 'get', '--params', JSON.stringify({ task_guid: target }), ...jsonFlags], ['task:task:write'], context)
          if (check.ok) { data = dataOf(check.output); remoteStatus = verifiedTaskState(data, target) }
        }
      } else if (spec.operation === 'approve' || spec.operation === 'reject') {
        const check = await run(['approval', 'instances', 'get', '--params', JSON.stringify({ instance_code: args.instanceCode }), ...jsonFlags], ['approval:instance:read'], context)
        if (check.ok) {
          const state = dataOf(check.output)
          const tasks = Array.isArray(state.tasks) ? state.tasks : []
          const matched = tasks.map(asRecord).find(task => String(task.id ?? task.task_id ?? '') === target)
          const expected = spec.operation === 'approve' ? 'APPROVED' : 'REJECTED'
          if (matched?.status === expected && (!state.instance_code || state.instance_code === args.instanceCode)) { data = state; remoteStatus = expected }
        }
      } else {
        const validRead = spec.name === 'lark_task_list' ? Array.isArray(data.items)
          : spec.name === 'lark_approval_list' ? Array.isArray(data.tasks)
          : spec.name === 'lark_task_get' ? String(asRecord(data.task).guid ?? '') === target
          : Array.isArray(data.tasks) && (!data.instance_code || data.instance_code === target)
        if (!validRead) return failure({ code: 'invalid_connector_response' }, 'failed', provider, spec.operation, target)
        remoteStatus = 'read'
      }
      if (!remoteStatus) return failure({ code: 'remote_state_unverified', response: result.output }, 'outcome_unknown', provider, spec.operation, target)
      const resultHash = createHash('sha256').update(JSON.stringify(data)).digest('hex')
      const remoteOperationId = stringValue(asRecord(result.output).request_id) ?? stringValue(asRecord(result.output).requestId)
      return { output: { ok: true, provider, operation: spec.operation, target, status: 'succeeded', data,
        ...(remoteOperationId ? { remoteOperationId } : {}),
        evidence: { kind: 'external_operation', provider, operation: spec.operation, target, verified: true, verifiedAt: new Date().toISOString(), resultHash, status: remoteStatus, ...(remoteOperationId ? { remoteOperationId } : {}) }
      } }
    }
  })
  const tools = [
    define({ name: 'lark_task_list', description: 'List pending tasks assigned to the connected Feishu/Lark user.', schema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false }, parse: taskQuery, scopes: ['task:task:read'], operation: 'list', args: args => ['task', '+get-my-tasks', '--complete=false', ...(args.query ? ['--query', String(args.query)] : []), ...jsonFlags] }),
    define({ name: 'lark_task_get', description: 'Read one task by its exact task GUID.', schema: idSchema, parse: taskId, scopes: [scopes.has('task:task:read') ? 'task:task:read' : 'task:task:write'], operation: 'detail', args: args => ['task', 'tasks', 'get', '--params', JSON.stringify({ task_guid: args.taskId }), ...jsonFlags] }),
    define({ name: 'lark_task_complete', description: 'Complete one task by GUID after explicit user approval; verify its final state.', schema: idSchema, parse: taskId, scopes: ['task:task:write'], operation: 'complete', mutation: true, args: args => ['task', '+complete', '--task-id', String(args.taskId), ...jsonFlags] }),
    define({ name: 'lark_approval_list', description: 'Read pending approvals, including task IDs and instance codes.', schema: { type: 'object', properties: { keyword: { type: 'string' }, pageToken: { type: 'string' } }, additionalProperties: false }, parse: approvalQuery, scopes: ['approval:task:read'], operation: 'list', args: args => ['approval', 'tasks', 'query', '--params', JSON.stringify({ topic: '1', ...(args.keyword ? { keyword: args.keyword } : {}), ...(args.pageToken ? { page_token: args.pageToken } : {}) }), ...jsonFlags] }),
    define({ name: 'lark_approval_get', description: 'Read approval instance details and the states of its approval tasks.', schema: instanceSchema, parse: instanceId, scopes: ['approval:instance:read'], operation: 'detail', args: args => ['approval', 'instances', 'get', '--params', JSON.stringify({ instance_code: args.instanceCode }), ...jsonFlags] }),
    ...(['approve', 'reject'] as const).map(operation => define({ name: `lark_approval_${operation}`, description: `${operation === 'approve' ? 'Approve' : 'Reject'} an exact approval task after explicit user approval; verify the task state.`, schema: actionSchema, parse: approvalAction, scopes: ['approval:task:write', 'approval:instance:read'], operation, mutation: true, args: args => ['approval', 'tasks', operation, '--data', JSON.stringify({ instance_code: args.instanceCode, task_id: args.taskId, ...(args.comment ? { comment: args.comment } : {}) }), ...jsonFlags, '--yes'] }))
  ].filter(tool => tool.shouldAdvertise?.({} as ToolHostContext))
  if (tools.length === 0) return undefined
  return { id: 'lark-cli', kind: 'skill', enabled: true, available: true, tools }
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined }
function dataOf(value: unknown): Record<string, unknown> { const record = asRecord(value); return record.data && typeof record.data === 'object' ? asRecord(record.data) : record }
function verifiedTaskState(data: Record<string, unknown>, target: string): string | undefined {
  const task = data.task ? asRecord(data.task) : data
  const completedAt = String(task.completed_at ?? '0')
  return String(task.guid ?? '') === target && completedAt !== '0' && completedAt !== '' && Number.isFinite(Number(completedAt)) && Number(completedAt) > 0 ? 'done' : undefined
}
function failure(data: unknown, status: 'failed' | 'outcome_unknown', provider: string, operation: string, target: string) {
  return { isError: true, output: { ok: false, code: status === 'outcome_unknown' ? 'external_outcome_unknown' : 'connector_request_failed', provider, operation, target, status, data } }
}
function normalizeLarkResult(result: LarkCommandResult): LarkCommandResult {
  const output = asRecord(result.output)
  const invalid = !result.ok || result.isError || Object.keys(output).length === 0 || output.ok === false || output.success === false || Boolean(output.error) || ('code' in output && output.code !== 0 && output.code !== '0')
  return { ok: !invalid, output: result.output, ...(invalid ? { isError: true } : {}) }
}
function parseJsonOutput(raw: string): unknown {
  try { return JSON.parse(raw.trim()) } catch { return { ok: false, error: 'invalid_connector_response' } }
}
export const _larkCliToolProviderInternals = { parseJsonOutput, normalizeLarkResult, verifiedTaskState }
