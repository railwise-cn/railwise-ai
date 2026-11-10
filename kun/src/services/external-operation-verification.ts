import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ExecutionGrant } from '../contracts/permissions.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { ResultEvidenceSchema, type ResultEvidence } from '../contracts/harness.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import type { ToolHost, ToolHostContext } from '../ports/tool-host.js'
import type { ThreadStore } from '../ports/thread-store.js'
import { canonicalTrustRoot, type WorkspaceTrustReader } from './workspace-trust-reader.js'
import type { TaskController } from './task-controller.js'
import type { TaskRunRepository } from './task-run-repository.js'
import { externalOperationForTool } from './external-effect-evidence.js'
import { externalTargetGrantKey } from '../adapters/tool/sandbox-policy.js'

// eslint-disable-next-line no-control-regex
const safeId = z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f]/u.test(value))
const locatorSchema = z.object({ taskId: safeId, instanceCode: safeId.optional(), instanceId: safeId.optional(), toUserId: safeId.optional() }).strict()
type Locator = z.infer<typeof locatorSchema>
type VerificationInput = { expectedRevision: number; idempotencyKey: string }
export type OperationVerificationResult = { taskId: string; receiptId: string; status: 'verified' | 'outcome_unknown'; evidence?: ResultEvidence; errorCode?: string }
type Dependencies = {
  repository: TaskRunRepository; controller: TaskController; toolHost: ToolHost; threadStore: ThreadStore
  workspaceTrust: WorkspaceTrustReader; refreshProvider(provider: string,originalGrant?:ExecutionGrant): Promise<unknown>; nowIso(): string
}

/** User-triggered, bounded readback of one already-dispatched action. Never dispatches a mutation or model Turn. */
export class ExternalOperationVerificationService {
  constructor(private readonly deps: Dependencies) {}

  async verify(taskId: string, receiptId: string, input: VerificationInput): Promise<OperationVerificationResult> {
    const { repository } = this.deps
    const key = `verify:${receiptId}:${input.idempotencyKey}`
    const request = { originalReceiptId: receiptId, expectedRevision: input.expectedRevision }
    const prior = repository.operation(taskId, key)
    if (prior) {
      if (prior.request?.expectedRevision !== input.expectedRevision) throw failure('idempotency_conflict', '核验键已用于其他请求。')
      if (prior.status === 'running' || prior.status === 'prepared') throw failure('outcome_unknown', '此核验仍在进行，请读取任务状态。')
      const saved = object(prior.result)
      const evidence = ResultEvidenceSchema.safeParse(saved.evidence)
      return { taskId, receiptId, status: prior.status === 'succeeded' && evidence.success ? 'verified' : 'outcome_unknown',
        ...(prior.status === 'succeeded' && evidence.success ? { evidence: evidence.data } : { errorCode: typeof saved.errorCode === 'string' ? saved.errorCode : 'verification_readback_failed' }) }
    }
    const task = repository.get(taskId)
    if (!task) throw failure('not_found', '任务不存在。')
    if (task.revision !== input.expectedRevision) throw failure('stale_request', '任务已更新，请刷新后核验。')
    if (['completed', 'failed', 'cancelled'].includes(task.status)) throw failure('invalid_state', '已结束的任务不能派发核验。')
    const receipt = repository.operations(taskId, 'tool').find(item => item.id === receiptId)
    if (!receipt) throw failure('not_found', '操作回执不存在。')
    const resolved = repository.verifiedOperationResolution(receipt)
    if (resolved) return { taskId, receiptId, status: 'verified', evidence: resolved.evidence }
    if (receipt.status !== 'outcome_unknown') throw failure('invalid_state', '仅可核验结果未知的操作。')
    const spec = externalOperationForTool(String(receipt.request?.toolName ?? ''))
    const target = receipt.request?.target
    if (!spec || !['complete', 'approve', 'reject', 'transfer'].includes(spec.operation) || receipt.request?.provider !== spec.provider ||
      receipt.request?.operation !== spec.operation || typeof target !== 'string' || !target) throw failure('verification_unsupported', '此操作缺少可靠的只读核验方式。')
    const locator = locatorSchema.safeParse(receipt.request?.verificationLocator)
    if (!locator.success || locator.data.taskId !== target) throw failure('verification_locator_missing', '旧回执缺少准确目标定位，不能自动核验或重放。')
    const plan = readPlan(spec.provider, spec.operation, locator.data)
    if (!plan) throw failure('verification_locator_missing', '回执缺少审批实例定位，不能猜测核验目标。')
    const dispatchApproval = receipt.dispatchApproval
    const approved = (receipt.result as { approved?: boolean } | undefined)?.approved === true ||
      (dispatchApproval?.toolName === receipt.request?.toolName && dispatchApproval?.requestHash === receipt.request?.approvalRequestHash)
    if (!approved) throw failure('verification_approval_missing', '缺少原操作的确认回执，请保留现场并取消或配置任务。')
    repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'effect_verification',
      request: { ...request, originalFingerprint: receipt.fingerprint, provider: spec.provider, operation: spec.operation, target, readToolName: plan.toolName }, nowIso: this.deps.nowIso() })
    repository.finishOperation(taskId, key, { status: 'running' }, this.deps.nowIso())
    let result: OperationVerificationResult
    try {
      const originalGrant=ExecutionGrantSchema.safeParse(receipt.request?.executionGrant)
      if(!originalGrant.success)throw failure('execution_grant_missing','原操作缺少有效权限记录，无法核验。')
      await this.deps.refreshProvider(spec.provider,originalGrant.data)
      const context = await this.context(task, receipt, spec.provider, spec.operation, target, plan.toolName)
      const catalog = await this.deps.toolHost.listTools(context)
      const providerId = spec.provider === 'lark' ? 'lark-cli' : 'dingtalk'
      if (!catalog.some(tool => tool.name === plan.toolName && tool.providerId === providerId)) throw failure('connector_scope_missing', '连接器未登录或缺少核验读取权限，请先配置。')
      const read = await this.deps.toolHost.execute({ callId: `verification_${randomUUID()}`, toolName: plan.toolName, providerId, arguments: plan.arguments }, context)
      const output = read.item.kind === 'tool_result' ? object(read.item.output) : {}
      if (read.item.kind === 'tool_result' && read.item.isError && typeof output.code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(output.code)) throw failure(output.code, '远端只读核验失败，原操作仍为结果未知。')
      const readEvidence = ResultEvidenceSchema.safeParse(output.evidence)
      if (read.item.kind !== 'tool_result' || read.item.isError || output.ok !== true || output.status !== 'succeeded' ||
        !readEvidence.success || !readEvidence.data.verified || readEvidence.data.kind !== 'external_operation' || readEvidence.data.provider !== spec.provider ||
        readEvidence.data.operation !== 'detail' || readEvidence.data.target !== plan.readTarget) throw failure('verification_readback_failed', '远端只读核验失败，原操作仍为结果未知。')
      const status = verifiedState(spec.provider, spec.operation, target, locator.data, object(output.data))
      if (!status) throw failure('verification_state_unconfirmed', '尚未观察到目标操作的成功状态，原操作仍为结果未知。')
      const evidence = ResultEvidenceSchema.parse({ ...readEvidence.data, operation: spec.operation, target, status, verifiedAt: this.deps.nowIso() })
      // Recheck cancellation, workspace revocation and scope after the network call.
      await context.validateExecutionGrant?.()
      this.deps.controller.recordOperationVerification(taskId, input.expectedRevision, receiptId, key, evidence)
      return { taskId, receiptId, status: 'verified', evidence }
    } catch (error) {
      const errorCode = safeCode(error)
      result = { taskId, receiptId, status: 'outcome_unknown', errorCode }
      repository.finishOperation(taskId, key, { status: 'failed', result, error: errorCode }, this.deps.nowIso())
      return result
    }
  }

  private async context(task: TaskRun, receipt: OperationReceipt, provider: string, operation: string, target: string, readToolName: string): Promise<ToolHostContext> {
    const parsed = ExecutionGrantSchema.safeParse(receipt.request?.executionGrant)
    if (!parsed.success) throw failure('execution_grant_missing', '原操作缺少有效权限记录，无法核验。')
    const original = parsed.data
    const turnId = receipt.request?.turnId
    const providerId = provider === 'lark' ? 'lark-cli' : 'dingtalk'
    if (original.taskId !== task.id || original.threadId !== task.threadId || original.turnId !== turnId || original.workspaceRoot !== await canonicalTrustRoot(task.workspaceRoot) ||
      !this.scopeAllows(task, receipt, provider, operation, target, original) ||
      (original.allowedProviderIds && !original.allowedProviderIds.includes(providerId)) ||
      (original.allowedToolNames && !original.allowedToolNames.includes(readToolName))) throw failure('execution_grant_scope', '原操作权限与当前任务、平台或目标不一致。')
    const initialThread = await this.deps.threadStore.get(task.threadId)
    if (!initialThread) throw failure('execution_grant_revoked', '任务对话已删除。')
    const initialWorkspace = await this.deps.workspaceTrust.get(initialThread.workspace)
    const agentRevision = initialThread.agentRevision ?? 0
    const currentAgentTrust = initialThread.agentProfile?.trustLevel ?? 'full-access'
    const currentApprovalPolicy = initialThread.approvalPolicy ?? 'auto'
    const allowlist = initialThread.agentProfile?.toolAllowlist
    if (allowlist?.length && !allowlist.includes('*') && !allowlist.includes(readToolName)) throw failure('execution_grant_scope', '当前 Agent 不允许此核验读取工具。')
    const validate = async () => {
      const currentTask = this.deps.repository.get(task.id)
      if (!currentTask || currentTask.authority?.revokedAt || ['cancelled', 'failed', 'completed'].includes(currentTask.status)) throw failure('execution_grant_revoked', '任务已结束或授权已撤销。')
      const accepted = currentTask.acceptance.effect
      const effects = accepted?.requiredEffects ?? (accepted?.target ? [accepted] : [])
      if (!effects.some(item => item.provider === provider && item.operation === operation && item.target === target)) throw failure('effect_scope_required', '目标已离开当前确认范围。')
      const thread = await this.deps.threadStore.get(task.threadId)
      if (!thread || !thread.turns.some(turn => turn.id === original.turnId) || await canonicalTrustRoot(thread.workspace) !== original.workspaceRoot ||
        (thread.agentRevision ?? 0) !== agentRevision || (thread.agentProfile?.trustLevel ?? 'full-access') !== currentAgentTrust ||
        (thread.approvalPolicy ?? 'auto') !== currentApprovalPolicy) throw failure('execution_grant_revoked', 'Agent 或任务授权发生变化，请先重新配置。')
      const workspace = await this.deps.workspaceTrust.get(thread.workspace)
      if (workspace.canonicalRoot !== original.workspaceRoot || workspace.level !== initialWorkspace.level || workspace.revision !== initialWorkspace.revision) throw failure('execution_grant_revoked', '工作区权限发生变化，请先重新配置。')
    }
    await validate()
    const grant: ExecutionGrant = { ...original, id: `readback:${receipt.id}:${randomUUID()}`, sandboxMode: 'read-only',
      allowedToolNames: [readToolName], allowedProviderIds: [providerId], pathAllowlist: [], externalTargets: [],
      workspaceTrust: leastTrust(original.workspaceTrust, initialWorkspace.level), agentTrust: leastTrust(original.agentTrust, currentAgentTrust),
      workspaceRevision: initialWorkspace.revision, agentRevision, revision: initialWorkspace.revision,
      approvalPolicy: stricterPolicy(original.approvalPolicy, currentApprovalPolicy),
      issuedAt: this.deps.nowIso(), expiresAt: new Date(Date.parse(this.deps.nowIso()) + 60_000).toISOString(), idempotencyKey: `readback:${receipt.id}` }
    return { threadId: grant.threadId, turnId: grant.turnId, workspace: grant.workspaceRoot, sandboxMode: 'read-only',
      executionGrant: grant, allowedToolNames: [readToolName], allowedProviderIds: [providerId], approvalPolicy: grant.approvalPolicy,
      abortSignal: AbortSignal.timeout(45_000), validateExecutionGrant: validate,
      assertExecution: () => { const current = this.deps.repository.get(task.id); if (!current || current.authority?.revokedAt || ['cancelled', 'failed', 'completed'].includes(current.status)) throw failure('execution_grant_revoked', '任务授权已撤销。') },
      awaitApproval: async () => 'deny' }
  }

  private scopeAllows(task: TaskRun, receipt: OperationReceipt, provider: string, operation: string, target: string, grant: ExecutionGrant): boolean {
    if (grant.externalTargets.includes(externalTargetGrantKey(provider, operation, target))) return true
    const accepted = task.acceptance.effect
    if (!accepted?.scopeConfirmationId || accepted.scopeConfirmationId !== receipt.request?.scopeConfirmationId || accepted.scopeRevision !== receipt.request?.scopeRevision) return false
    const confirmation = this.deps.repository.operations(task.id, 'effect_scope').find(item => item.id === accepted.scopeConfirmationId && item.status === 'succeeded')
    const result = object(confirmation?.result)
    return result.confirmationId === accepted.scopeConfirmationId && Array.isArray(result.requiredEffects) && result.requiredEffects.some(raw => {
      const item = object(raw)
      return item.provider === provider && item.operation === operation && item.target === target
    })
  }
}

function readPlan(provider: string, operation: string, locator: Locator) {
  if (operation === 'complete') return { toolName: provider === 'lark' ? 'lark_task_get' : 'dingtalk_get_task', arguments: { taskId: locator.taskId }, readTarget: locator.taskId }
  if (provider === 'lark' && locator.instanceCode) return { toolName: 'lark_approval_get', arguments: { instanceCode: locator.instanceCode }, readTarget: locator.instanceCode }
  if (provider === 'dingtalk' && locator.instanceId && (operation !== 'transfer' || locator.toUserId)) return { toolName: 'dingtalk_get_approval', arguments: { instanceId: locator.instanceId }, readTarget: locator.instanceId }
  return undefined
}
function verifiedState(provider: string, operation: string, target: string, locator: Locator, data: Record<string, unknown>): string | undefined {
  if (operation === 'complete') {
    if (provider === 'dingtalk') return data.id === target && data.done === true ? 'done' : undefined
    const task = data.task ? object(data.task) : data
    return task.guid === target && Number(task.completed_at) > 0 && Number.isFinite(Number(task.completed_at)) ? 'done' : undefined
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks.map(object) : []
  if (provider === 'lark') {
    if (data.instance_code && data.instance_code !== locator.instanceCode) return undefined
    const matched = tasks.find(item => String(item.id ?? item.task_id ?? '') === target)
    const expected = operation === 'approve' ? 'APPROVED' : 'REJECTED'
    return matched?.status === expected ? expected : undefined
  }
  if (data.processInstanceId !== locator.instanceId) return undefined
  const matched = tasks.find(item => String(item.taskId ?? '') === target)
  const expected = operation === 'approve' ? 'AGREE' : operation === 'reject' ? 'REFUSE' : 'REDIRECTED'
  if (!matched || String(matched.result).toUpperCase() !== expected) return undefined
  return operation === 'transfer'
    ? tasks.some(item => item.userId === locator.toUserId && ['NEW', 'RUNNING'].includes(String(item.status))) ? expected : undefined
    : ['COMPLETED', 'TERMINATED'].includes(String(matched.status)) ? expected : undefined
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
function safeCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return /^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : 'verification_readback_failed'
}
function leastTrust(a: ExecutionGrant['workspaceTrust'], b: ExecutionGrant['workspaceTrust']): ExecutionGrant['workspaceTrust'] {
  const levels: ExecutionGrant['workspaceTrust'][] = ['read-only', 'workspace-write', 'trusted', 'full-access']
  return levels[Math.min(levels.indexOf(a), levels.indexOf(b))]!
}
function stricterPolicy(a: ExecutionGrant['approvalPolicy'], b: ExecutionGrant['approvalPolicy']): ExecutionGrant['approvalPolicy'] {
  const levels: ExecutionGrant['approvalPolicy'][] = ['auto', 'suggest', 'on-request', 'untrusted', 'never']
  return levels[Math.max(levels.indexOf(a), levels.indexOf(b))]!
}
