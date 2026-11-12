import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { z } from 'zod'
import { HostShellAuthorizationSchema, type HostShellAuthorization } from '../../contracts/permissions.js'
import type { TaskController } from '../../services/task-controller.js'
import type { TaskRunRepository } from '../../services/task-run-repository.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildToolArgumentSummary, sanitizeToolResultOutput } from '../../security/tool-persistence-security.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import type { LocalTool } from './local-tool-host.js'
import { defineLocalTool } from './local-tool-definition.js'

const requestSchema = z.object({
  command: z.string().min(1).max(1024).refine(command => command.trim().length > 0 && !command.includes('\0')),
  timeout_seconds: z.number().int().min(1).max(300).default(60),
  ttl_seconds: z.number().int().min(1).max(300).default(60),
  idempotency_key: z.string().trim().min(1).max(200)
}).strict().refine(value => value.timeout_seconds <= value.ttl_seconds, { message: 'Command timeout must fit within the reviewed authorization lifetime.' })
const sessionSchema = z.object({ authorization_id: z.string().min(1), action: z.enum(['poll', 'stop']), yield_seconds: z.number().int().min(1).max(10).default(1) }).strict()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
const connectorProxy = /(?:\bdws\b|\bdingtalk\b|\blark(?:-cli)?\b|\bfeishu\b|\blarksuite\b|钉钉|飞书)/i
type ShellResult = Awaited<ReturnType<LocalTool['execute']>>
type SavedResult = { authorization: HostShellAuthorization; shell?: ShellResult }

/** The proposal is not Bash and grants no ambient Shell access. Only this exact approved command is dispatched. */
export function buildScopedHostShellToolProviders(options: {
  repository: TaskRunRepository
  tasks: TaskController
  bashTool: LocalTool
  nowIso: () => string
  onAuthorized?: (authorization: HostShellAuthorization) => Promise<void>
}): CapabilityToolProvider[] {
  const { repository, tasks, nowIso } = options
  const current = (context: ToolHostContext) => {
    const task = tasks.activeTask(context.threadId)
    return task?.activeTurnId === context.turnId && task.acceptance.kind !== 'effect' && Boolean(context.workspace.trim()) ? task : null
  }
  const assertContext = async (context: ToolHostContext) => {
    const task = current(context), token = tasks.tokenForTurn(context.turnId), grant = context.executionGrant
    if (!task || !token || !grant || grant.taskId !== task.id || grant.threadId !== context.threadId || grant.turnId !== context.turnId) return fail('host_shell_scope_blocked', 'A current task, immutable execution grant and lease are required. Connector tasks must use their typed provider.')
    tasks.assertToken(token)
    await context.validateExecutionGrant?.()
    const workspace = await realpath(context.workspace)
    // The approval must name the actual cwd, not a symlink that can be retargeted while waiting.
    if (context.workspace.length > 2048 || context.workspace !== workspace || grant.workspaceRoot !== workspace) return fail('host_shell_scope_blocked', 'Select the canonical workspace before approving a host command; aliases and changed paths are not accepted.')
    return { task, token, grant, workspace }
  }
  const resultFor = (result: SavedResult | undefined) => result?.shell
    ? { output: { authorizationId: result.authorization.id, commandHash: result.authorization.commandHash, expiresAt: result.authorization.expiresAt, ...objectOutput(result.shell.output) }, ...(result.shell.isError ? { isError: true } : {}) }
    : { output: { status: 'outcome_unknown', code: 'outcome_unknown', authorizationId: result?.authorization.id, message: 'The approved command may have started. Verify its process and output; it will not be replayed.' }, isError: true }
  return [{ id: 'scoped-host-shell', kind: 'built-in', enabled: true, available: true, tools: [
    defineLocalTool({
      name: 'request_host_shell',
      description: 'Propose ONE exact host shell command for explicit user approval. The approval shows the full redacted command, workspace, hashes and lifetime; it grants full host access only for this command, never changes workspace trust, and cannot be used for connector/platform operations. No command executes before approval. Returns real output or a server-owned session. Use host_shell_session only to poll or stop that session; stdin writes are not authorized. Unknown outcomes are never replayed.',
      inputSchema: z.toJSONSchema(requestSchema) as Record<string, unknown>, policy: 'on-request', requireExplicitApproval: true,
      shouldAdvertise: context => Boolean(current(context)) && context.approvalPolicy !== 'never',
      execute: async (raw, context, onUpdate) => {
        const request = requestSchema.parse(raw)
        if (connectorProxy.test(request.command)) return fail('host_shell_connector_proxy_blocked', 'External platform operations must use a configured typed connector, never host Shell.')
        const checked = await assertContext(context)
        const requestHash = hash(JSON.stringify(raw)), key = `host-shell:${request.idempotency_key}`
        const operationRequest = { commandHash: hash(request.command), requestHash, timeoutSeconds: request.timeout_seconds, ttlSeconds: request.ttl_seconds, taskId: checked.task.id, threadId: context.threadId, turnId: context.turnId, workspaceRoot: checked.workspace, grantId: checked.grant.id, executionId: checked.token.executionId, leaseRevision: checked.token.leaseRevision }
        const prior = repository.operation(checked.task.id, key)
        if (prior) {
          // beginOperation checks a matching key against the complete immutable request.
          repository.beginOperation({ ownerId: checked.task.id, idempotencyKey: key, kind: 'host_shell', request: operationRequest, nowIso: nowIso() })
          return resultFor(prior.result as SavedResult | undefined)
        }
        const proof = context.explicitApproval
        if (proof?.toolName !== 'request_host_shell' || proof.requestHash !== requestHash) return fail('host_shell_approval_required', 'This exact command requires a real explicit user approval.')
        const approvalId = proof.approvalId ?? `appr_${proof.callId}`, approved = repository.humanRequest(approvalId)
        const expectedSummary = buildToolArgumentSummary({ toolName: 'request_host_shell', arguments: raw, workspace: context.workspace })
        if (!approved || approved.kind !== 'approval' || approved.threadId !== context.threadId || approved.turnId !== context.turnId || approved.status !== 'answered' || (approved.resolution as { decision?: string })?.decision !== 'allow' || approved.message !== expectedSummary) return fail('host_shell_approval_required', 'No persisted approval matches this command and workspace.')
        const issuedAt = approved.updatedAt ?? approved.createdAt
        const expiresAt = new Date(Date.parse(issuedAt) + request.ttl_seconds * 1000).toISOString()
        if (Date.parse(expiresAt) <= Date.parse(nowIso())) return fail('host_shell_authorization_expired', 'The reviewed command authorization expired; request a new explicit approval.')
        const authorization = HostShellAuthorizationSchema.parse({ id: `host_shell_${randomUUID()}`, taskId: checked.task.id, threadId: context.threadId, turnId: context.turnId,
          executionId: checked.token.executionId, ownerId: checked.token.ownerId, leaseRevision: checked.token.leaseRevision, executionGrantId: checked.grant.id,
          workspaceRoot: checked.workspace, workspaceRevision: checked.grant.workspaceRevision, agentRevision: checked.grant.agentRevision,
          commandHash: operationRequest.commandHash, requestHash, approvalId, idempotencyKey: request.idempotency_key, issuedAt, expiresAt })
        const prepared = repository.transact(() => {
          tasks.assertToken(checked.token)
          const created = repository.beginOperation({ ownerId: checked.task.id, idempotencyKey: key, kind: 'host_shell', request: operationRequest, nowIso: nowIso() })
          if (created.created) repository.finishOperation(checked.task.id, key, { status: 'running', result: { authorization } }, nowIso())
          return created.created
        })
        if (!prepared) return resultFor(repository.operation(checked.task.id, key)?.result as SavedResult | undefined)
        let dispatched = false
        try {
          // Persist the server-owned reference before any host side effect.
          await options.onAuthorized?.(authorization)
          await context.validateExecutionGrant?.()
          tasks.assertToken(checked.token)
          const remaining = Math.floor((Date.parse(expiresAt) - Date.parse(nowIso())) / 1000)
          if (remaining < 1) return fail('host_shell_authorization_expired', 'The command authorization expired before dispatch.')
          dispatched = true
          const shell = await options.bashTool.execute({ action: 'run', command: request.command, timeout: Math.min(request.timeout_seconds, remaining), yield_seconds: 1 }, context, onUpdate)
          const saved = { authorization, shell: { ...shell, output: sanitizeToolResultOutput('request_host_shell', shell.output) } }
          const payload = objectOutput(shell.output)
          repository.finishOperation(checked.task.id, key, { status: payload.status === 'running' ? 'running' : shell.isError ? 'failed' : 'succeeded', result: saved }, nowIso())
          return resultFor(saved)
        } catch (error) {
          if (!dispatched) {
            repository.finishOperation(checked.task.id, key, { status: 'failed', result: { authorization, shell: { output: { status: 'failed', code: 'host_shell_not_dispatched', message: 'The approved command was not dispatched; create a new request if needed.' }, isError: true } }, error: 'Authorization invalidated before dispatch.' }, nowIso())
            return resultFor(repository.operation(checked.task.id, key)!.result as SavedResult)
          }
          repository.finishOperation(checked.task.id, key, { status: 'outcome_unknown', result: { authorization }, error: 'Approved host command outcome requires verification.' }, nowIso())
          return { ...resultFor({ authorization }), output: { ...objectOutput(resultFor({ authorization }).output), code: 'outcome_unknown', cause: error instanceof Error ? error.name : 'error' } }
        }
      }
    }),
    defineLocalTool({
      name: 'host_shell_session',
      description: 'Read output or stop the exact session created by request_host_shell. Read-only poll can verify an earlier attempt in the same task and unchanged workspace/Agent scope. Stop requires the original Turn, grant and immutable lease. Cannot start another command, change scope or write stdin. A recovered process can be polled read-only; uncertain process identity is never terminated.',
      inputSchema: z.toJSONSchema(sessionSchema) as Record<string, unknown>, policy: 'auto',
      shouldAdvertise: context => Boolean(current(context)),
      execute: async (raw, context, onUpdate) => {
        const request = sessionSchema.parse(raw), checked = await assertContext(context)
        const receipt = repository.operations(checked.task.id, 'host_shell').find(item => (item.result as SavedResult | undefined)?.authorization?.id === request.authorization_id)
        const saved = receipt?.result as SavedResult | undefined
        if (!receipt || !saved) return fail('host_shell_scope_blocked', 'No approved command belongs to this task.')
        const authorization = HostShellAuthorizationSchema.parse(saved.authorization)
        if (authorization.taskId !== checked.task.id || authorization.threadId !== context.threadId || authorization.workspaceRoot !== checked.workspace || authorization.workspaceRevision !== checked.grant.workspaceRevision || authorization.agentRevision !== checked.grant.agentRevision) return fail('host_shell_scope_blocked', 'This command authorization belongs to a different task or revoked workspace/Agent scope.')
        if (request.action === 'stop' && (authorization.turnId !== context.turnId || authorization.executionId !== checked.token.executionId || authorization.ownerId !== checked.token.ownerId || authorization.leaseRevision !== checked.token.leaseRevision || authorization.executionGrantId !== checked.grant.id)) return fail('host_shell_scope_blocked', 'Stopping requires the original command execution and its immutable lease; read-only poll can verify an earlier attempt.')
        if (receipt.status === 'succeeded' || receipt.status === 'failed') return resultFor(saved)
        const sessionId = objectOutput(saved.shell?.output).session_id
        if (typeof sessionId !== 'string') return resultFor(saved)
        const session = repository.getShellSession(sessionId)
        if (!session || session.taskId !== checked.task.id || session.executionId !== authorization.executionId || session.ownerId !== authorization.ownerId) return fail('host_shell_scope_blocked', 'Shell process ownership could not be verified; no signal was sent.')
        const shell = await options.bashTool.execute({ action: request.action, session_id: sessionId, yield_seconds: request.yield_seconds }, context, onUpdate)
        const payload = objectOutput(shell.output)
        const recoveredUnknown = payload.recovered === true && (!['completed', 'failed', 'terminated'].includes(session.status) || session.exitCode === undefined)
        const recoveredFailure = payload.recovered === true && !recoveredUnknown && (session.status !== 'completed' || session.exitCode !== 0)
        const next = { authorization, shell: { ...shell, ...(recoveredUnknown || recoveredFailure ? { isError: true } : {}), output: sanitizeToolResultOutput('host_shell_session', { ...payload,
          ...(payload.recovered === true && !recoveredUnknown ? { status: session.status, exit_code: session.exitCode } : {}),
          ...(recoveredUnknown ? { status: 'outcome_unknown', code: 'outcome_unknown' } : {}) }) } }
        repository.finishOperation(checked.task.id, receipt.idempotencyKey, { status: recoveredUnknown || payload.code === 'outcome_unknown' ? 'outcome_unknown' : payload.status === 'running' ? 'running' : next.shell.isError ? 'failed' : 'succeeded', result: next }, nowIso())
        return resultFor(next)
      }
    })
  ] }]
}

function objectOutput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { output: value }
}
