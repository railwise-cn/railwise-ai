import { createHash, randomUUID } from 'node:crypto'
import { BrowserOperationConfirmation, type BrowserOperationReview, type BrowserCapabilityConfig } from '../contracts/browser-skill.js'
import { BrowserScheduleActionSchema, type BrowserScheduleAction } from '../contracts/browser-schedule-actions.js'
import { ExecutionGrantSchema, type ExecutionGrant } from '../contracts/permissions.js'
import { ResultEvidenceSchema, type ResultEvidence } from '../contracts/harness.js'
import type { OperationReceipt, OperationResolutionOutcome, TaskRun } from '../contracts/tasks.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { ToolHost, ToolHostContext } from '../ports/tool-host.js'
import type { FlowRuntimeService } from '../flow/service.js'
import { canonicalTrustRoot, type WorkspaceTrustReader } from './workspace-trust-reader.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'
import type { TaskController } from './task-controller.js'
import { listApprovedBrowserScheduleActions } from './browser-schedule-action-authority.js'
import { sanitizeBrowserApprovalSummary } from '../security/browser-approval-summary.js'
import { assertGrantAllowsNetwork } from '../adapters/tool/sandbox-policy.js'

type Input = { expectedRevision: number; idempotencyKey: string }
export type BrowserVerificationResult = { taskId: string; receiptId: string; status: 'verified' | 'outcome_unknown';
  evidence?: ResultEvidence; outcome?: OperationResolutionOutcome; errorCode?: string; browserReview?: BrowserOperationReview }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
const code = (error: unknown) => /^[a-z][a-z0-9_]{0,99}$/.test(String(object(error).code)) ? String(object(error).code) : 'browser_review_unavailable'
const waiting = (task: TaskRun) => ['paused', 'stalled', 'waiting_user'].includes(task.status)
const readTools = ['browser_observe', 'browser_get_html']

/** Human review of a finite, already-authorized public query. No page mutation, model, replay or automatic resume. */
export class BrowserOperationVerificationService {
  constructor(private readonly deps: { repository: TaskRunRepository; controller: TaskController; toolHost: ToolHost;
    threadStore: ThreadStore; workspaceTrust: WorkspaceTrustReader; flows: FlowRuntimeService;
    browserState(): BrowserCapabilityConfig; browserIdentity(): string; nowIso(): string;
    validatePermission(threadId: string, permissionId?: string): Promise<unknown> }) {}

  handles(taskId: string, receiptId: string): boolean {
    return this.deps.repository.operations(taskId, 'tool').some(receipt => receipt.id === receiptId && ['browser_click', 'browser_fill'].includes(String(receipt.request?.toolName)))
  }

  async verify(taskId: string, receiptId: string, input: Input): Promise<BrowserVerificationResult> {
    const result: BrowserVerificationResult = { taskId, receiptId, status: 'outcome_unknown' }
    const key = `browser-review:${receiptId}:${input.idempotencyKey}`
    try {
      const binding = await this.binding(taskId, receiptId, input.expectedRevision)
      const resolved = this.deps.repository.verifiedOperationResolution(binding.receipt)
      if (resolved) return { ...result, status: 'verified', evidence: resolved.evidence, outcome: resolved.outcome ?? 'succeeded' }
      const previous = this.deps.repository.operation(taskId, key)
      if (previous) {
        if (previous.request?.expectedRevision !== input.expectedRevision) fail('idempotency_conflict')
        const review = object(previous.result).review as BrowserOperationReview | undefined
        if (previous.status !== 'succeeded' || !review || Date.parse(review.expiresAt) <= Date.parse(this.deps.nowIso()) || object(previous.result).consumedAt) fail('browser_review_expired')
        return { ...result, browserReview: review }
      }
      this.deps.repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'browser_action_review',
        request: { expectedRevision: input.expectedRevision, originalReceiptId: receiptId, originalFingerprint: binding.receipt.fingerprint }, nowIso: this.deps.nowIso() })
      const snapshot = await this.read(binding)
      await this.binding(taskId, receiptId, input.expectedRevision)
      const summary = summaryFields(binding.action.summary)
      const review: BrowserOperationReview = { id: `browser_review_${randomUUID()}`, action: binding.action.action,
        expiresAt: new Date(Date.parse(this.deps.nowIso()) + 120_000).toISOString(), pageUrl: binding.action.pageUrl,
        observationText: snapshot.text, targetLabel: summary['目标'],
        ...(binding.action.action === 'fill' && operationFingerprint(summary['输入内容']) === operationFingerprint(binding.value) ? { value: binding.value } : {}) }
      this.deps.repository.finishOperation(taskId, key, { status: 'succeeded', result: { review, snapshotHash: snapshot.hash,
        coverage: snapshot.coverage, bindingHash: binding.hash, dispatchId: binding.dispatch.id } }, this.deps.nowIso())
      return { ...result, browserReview: review }
    } catch (error) {
      const prior = this.deps.repository.operation(taskId, key)
      if (prior?.status === 'prepared') this.deps.repository.finishOperation(taskId, key, { status: 'failed', error: code(error) }, this.deps.nowIso())
      return { ...result, errorCode: code(error) }
    }
  }

  async confirm(taskId: string, receiptId: string, raw: BrowserOperationConfirmation): Promise<BrowserVerificationResult> {
    const input = BrowserOperationConfirmation.parse(raw)
    const outcome: OperationResolutionOutcome = input.decision === 'not_completed' ? 'not_completed' : 'succeeded'
    const key = `browser-confirm:${receiptId}:${input.idempotencyKey}`
    const request = { originalReceiptId: receiptId, ...input }
    const prior = this.deps.repository.operation(taskId, key)
    if (prior) {
      if (operationFingerprint(prior.request) !== operationFingerprint(request)) fail('idempotency_conflict')
      if (prior.status !== 'succeeded') fail('browser_review_pending')
      return prior.result as BrowserVerificationResult
    }
    const binding = await this.binding(taskId, receiptId, input.expectedRevision)
    const saved = this.deps.repository.operations(taskId, 'browser_action_review').find(receipt => object(object(receipt.result).review).id === input.reviewId)
    const state = object(saved?.result)
    const review = state.review as BrowserOperationReview | undefined
    if (!saved || saved.status !== 'succeeded' || saved.request?.originalReceiptId !== receiptId || saved.request.originalFingerprint !== binding.receipt.fingerprint ||
      saved.request.expectedRevision !== input.expectedRevision || state.bindingHash !== binding.hash || state.dispatchId !== binding.dispatch.id) fail('browser_review_mismatch')
    if (!review || state.consumedAt || Date.parse(review.expiresAt) <= Date.parse(this.deps.nowIso())) fail('browser_review_expired')
    const snapshot = await this.read(binding)
    if (snapshot.hash !== state.snapshotHash) fail('browser_review_page_changed')
    const current = await this.binding(taskId, receiptId, input.expectedRevision)
    if (current.hash !== binding.hash) fail('browser_review_mismatch')
    return this.deps.repository.transact(() => {
      const task = this.deps.repository.get(taskId)!
      if (task.revision !== input.expectedRevision || !waiting(task) || object(this.deps.repository.operation(taskId, saved.idempotencyKey)?.result).consumedAt) fail('stale_request')
      const now = this.deps.nowIso()
      if (Date.parse(review.expiresAt) <= Date.parse(now)) fail('browser_review_expired')
      const evidence = ResultEvidenceSchema.parse({ kind: 'human_confirmation', provider: 'browser-skill', operation: binding.action.action,
        target: binding.action.pageUrl, status: outcome === 'not_completed' ? 'public_query_reviewed_incomplete' : 'public_query_confirmed_by_user', verified: true, verifiedAt: now,
        resultHash: operationFingerprint({ reviewId: review.id, snapshotHash: snapshot.hash, receiptId, decision: input.decision }) })
      this.deps.repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'browser_confirmation', request, nowIso: now })
      const proofKey = this.proof(binding.receipt, evidence, key, taskId, outcome)
      this.deps.controller.recordOperationVerification(taskId, input.expectedRevision, receiptId, proofKey, evidence, outcome)
      this.resolve(binding.dispatch, evidence, key, taskId, outcome)
      // A turn/action outcome may cover more than one dispatch; keep it blocked until each exact dispatch is reviewed.
      const remaining = this.deps.repository.operations(taskId, 'browser_action_dispatch').some(item => item.status === 'outcome_unknown' &&
        item.request?.turnId === binding.receipt.request?.turnId && item.request?.action === binding.action.action && !this.deps.repository.verifiedOperationResolution(item))
      if (!remaining) for (const lock of this.deps.repository.operations(binding.action.sourceTaskId, 'browser_schedule_action_outcome')) {
        if (lock.status === 'outcome_unknown' && lock.request?.taskId === taskId && lock.request?.turnId === binding.receipt.request?.turnId &&
          lock.request?.action === binding.action.action && lock.request?.scheduleId === binding.action.scheduleId) this.resolve(lock, evidence, key, taskId, outcome)
      }
      this.deps.repository.finishOperation(taskId, saved.idempotencyKey, { status: 'succeeded', result: { ...state, consumedAt: now } }, now)
      const updated = this.deps.repository.get(taskId)!
      const clear = !this.deps.repository.unsettledOperations(taskId).some(item => item.kind === 'tool')
      this.deps.repository.update(taskId, updated.revision, value => ({ ...value, updatedAt: now,
        ...(clear ? { waitingReason: outcome === 'not_completed' ? '你已核对本次公开查询动作未完成。原记录保留；请单独点击继续，由任务重新规划。' : '本次公开查询动作已由你核对。任务尚未继续，请单独点击继续。',
          stalledReason: outcome === 'not_completed' && value.status === 'stalled' ? '公开查询已核对未完成，等待你单独继续并重新规划。' : undefined,
          status: outcome === 'not_completed' ? value.status : value.status === 'paused' ? 'paused' : 'waiting_user' } : {}) }),
      { key: `browser-confirmed:${review.id}`, kind: 'browser_action_human_confirmed', payload: { receiptId, reviewId: review.id, outcome }, createdAt: now })
      const attention = this.deps.repository.attention(`unknown_${taskId}`)
      if (clear && attention) this.deps.repository.putAttention({ ...attention, status: 'answered', revision: attention.revision + 1, updatedAt: now })
      const result: BrowserVerificationResult = { taskId, receiptId, status: 'verified', evidence, outcome }
      this.deps.repository.finishOperation(taskId, key, { status: 'succeeded', result }, now)
      return result
    })
  }

  private proof(receipt: OperationReceipt, evidence: ResultEvidence, confirmationKey: string, confirmationOwnerId: string, outcome: OperationResolutionOutcome): string {
    const key = `${confirmationKey}:proof:${receipt.id}`
    // Legacy readers recognize only effect_verification as successful proof.
    // A negative review must remain unknown to those readers rather than look completed.
    this.deps.repository.beginOperation({ ownerId: receipt.ownerId, idempotencyKey: key, kind: outcome === 'not_completed' ? 'effect_verification_incomplete' : 'effect_verification',
      request: { originalReceiptId: receipt.id, originalFingerprint: receipt.fingerprint, confirmationKey, confirmationOwnerId }, nowIso: this.deps.nowIso() })
    this.deps.repository.finishOperation(receipt.ownerId, key, { status: 'succeeded', result: { evidence, outcome } }, this.deps.nowIso())
    return key
  }
  private resolve(receipt: OperationReceipt, evidence: ResultEvidence, key: string, confirmationOwnerId: string, outcome: OperationResolutionOutcome): void {
    if (this.deps.repository.verifiedOperationResolution(receipt)) return
    const proof = this.deps.repository.operation(receipt.ownerId, this.proof(receipt, evidence, key, confirmationOwnerId, outcome))!
    this.deps.repository.resolveOperation(receipt.ownerId, receipt.idempotencyKey, { status: 'verified', receiptId: proof.id, evidence, outcome, resolvedAt: this.deps.nowIso() })
  }

  private async binding(taskId: string, receiptId: string, revision: number) {
    const repository = this.deps.repository
    const task = repository.get(taskId)
    if (!task) fail('not_found')
    if (task.revision !== revision) fail('stale_request')
    if (!waiting(task) || task.authority?.revokedAt || repository.getLease(taskId) && Date.parse(repository.getLease(taskId)!.expiresAt) > Date.parse(this.deps.nowIso())) fail('browser_review_task_not_waiting')
    const receipt = repository.operations(taskId, 'tool').find(item => item.id === receiptId)
    if (!receipt || receipt.status !== 'outcome_unknown' || !['browser_fill', 'browser_click'].includes(String(receipt.request?.toolName))) fail('browser_review_receipt_unavailable')
    const grant = ExecutionGrantSchema.safeParse(receipt.request?.executionGrant)
    if (!grant.success || grant.data.taskId !== taskId || grant.data.threadId !== task.threadId || grant.data.turnId !== receipt.request?.turnId ||
      task.activeTurnId !== grant.data.turnId || !grant.data.browserScope || !grant.data.connectorIdentityFingerprints?.['browser-skill']) fail('browser_review_authority_missing')
    const original = grant.data
    const action = receipt.request!.toolName === 'browser_fill' ? 'fill' : 'click'
    const dispatches = repository.operations(taskId, 'browser_action_dispatch').filter(item => item.status === 'outcome_unknown' && item.request?.turnId === original.turnId &&
      item.request?.toolName === receipt.request?.toolName && item.request?.argumentsHash === receipt.request?.argumentsHash)
    if (dispatches.length !== 1) fail('browser_review_dispatch_missing')
    const dispatch = dispatches[0]!
    const request = dispatch.request!
    if (typeof request.sessionId !== 'string' || typeof request.tabId !== 'number' || typeof request.targetRef !== 'string' || !/^@?e\d+$/.test(request.targetRef)) fail('browser_review_locator_missing')
    const sourceId = original.browserScheduleBinding?.sourceTaskId ?? taskId
    const source = repository.get(sourceId)
    if (!source || source.authority?.revokedAt) fail('browser_review_authority_revoked')
    const approved = listApprovedBrowserScheduleActions(repository, source).find(item => item.action === action && item.pageUrl === request.pageUrl &&
      item.elementHash === request.elementHash && item.valueHash === request.valueHash && item.browserInstanceId === request.browserInstanceId &&
      item.browserRevision === request.browserRevision && item.id === request.scheduleActionId)
    if (!approved) fail('browser_review_public_query_scope_missing')
    const parsed = BrowserScheduleActionSchema.parse(approved)
    const approval = repository.humanRequest(parsed.approvalId)
    const approvedRequest = object(approval?.payload.approval)
    const authorityReceipt = repository.operations(sourceId, 'browser_schedule_action_authorization').find(item => item.status === 'succeeded' && object(item.result).id === parsed.id)
    if (approval?.status !== 'answered' || object(approval.resolution).decision !== 'allow' || approval.threadId !== source.threadId ||
      !authorityReceipt || approvedRequest.toolName !== 'browser_authorize_action' || approvedRequest.requestHash !== sha(JSON.stringify(authorityReceipt.request)) || approvedRequest.summary !== parsed.summary) fail('browser_review_approval_missing')
    const fields = summaryFields(parsed.summary)
    const value = fields['输入内容']
    if (action === 'fill' && (typeof value !== 'string' || sha(value) !== parsed.valueHash)) fail('browser_review_input_unavailable')
    if (original.browserScheduleBinding) {
      const binding = original.browserScheduleBinding
      const flow = this.deps.flows.get(binding.scheduleId)
      const authority = object(flow?.variables.taskSchedule)
      const scope = object(authority.scope)
      const published = flow?.publishedVersionId ? this.deps.flows.repository.getVersion(flow.publishedVersionId) : null
      if (!flow || flow.variables.enabled === false || flow.variables.archived === true || flow.publishedVersionId !== binding.versionId ||
        !published || operationFingerprint(published.definition.variables.taskSchedule) !== operationFingerprint(authority) ||
        authority.sourceAuthorityHash !== sha(JSON.stringify(source.authority ?? null)) ||
        object(authority.authorization).scopeHash !== binding.scopeHash || sha(JSON.stringify(scope.browserScheduleActions)) !== binding.actionsHash ||
        operationFingerprint(scope.browserScheduleActions) !== operationFingerprint(listApprovedBrowserScheduleActions(repository, source)) ||
        !Array.isArray(scope.browserScheduleActions) || !scope.browserScheduleActions.some(item => operationFingerprint(item) === operationFingerprint(parsed))) fail('browser_review_plan_changed')
    }
    await this.validate(task, original, parsed)
    const session = repository.operations(taskId, 'browser_session').find(item => object(item.result).sessionId === request.sessionId)
    if (!session || session.status !== 'succeeded' || object(session.result).stopped || object(session.result).tabId !== request.tabId ||
      object(session.result).browserInstanceId !== parsed.browserInstanceId) fail('browser_review_session_unavailable')
    return { task, receipt, dispatch, action: parsed, original, value, sessionId: request.sessionId, targetRef: request.targetRef,
      hash: operationFingerprint({ receipt: receipt.fingerprint, dispatch: dispatch.fingerprint, original, action: parsed }) }
  }

  private async validate(task: TaskRun, original: ExecutionGrant, action: BrowserScheduleAction): Promise<void> {
    const browser = this.deps.browserState()
    if (!browser.enabled || browser.state !== 'ready' || browser.browserInstanceId !== action.browserInstanceId || browser.revision !== action.browserRevision ||
      original.connectorIdentityFingerprints?.['browser-skill'] !== this.deps.browserIdentity() || browser.origins.length > 0 && !browser.origins.includes(action.origin) ||
      operationFingerprint(task.authority?.browserScope) !== operationFingerprint(original.browserScope)) fail('browser_binding_changed')
    const thread = await this.deps.threadStore.get(task.threadId)
    if (!thread || thread.status === 'deleted' || !thread.turns.some(turn => turn.id === original.turnId && operationFingerprint(turn.executionGrant) === operationFingerprint(original)) || await canonicalTrustRoot(thread.workspace) !== original.workspaceRoot ||
      (thread.agentRevision ?? 0) !== original.agentRevision || (thread.agentProfile?.trustLevel ?? 'full-access') !== original.agentTrust ||
      task.authority?.sandboxMode && thread.sandboxMode !== task.authority.sandboxMode || thread.approvalPolicy !== original.approvalPolicy) fail('execution_grant_revoked')
    const workspace = await this.deps.workspaceTrust.get(thread.workspace)
    if (workspace.canonicalRoot !== original.workspaceRoot || workspace.revision !== original.workspaceRevision || workspace.level !== original.workspaceTrust) fail('workspace_trust_changed')
    const allowed = thread.agentProfile?.toolAllowlist
    if (allowed?.length && !allowed.includes('*') && !readTools.every(name => allowed.includes(name)) ||
      original.allowedToolNames && !readTools.every(name => original.allowedToolNames!.includes(name)) ||
      original.allowedProviderIds && !original.allowedProviderIds.includes('browser-skill')) fail('execution_grant_scope')
    // The click explicitly requests a fresh read-only check. An expired Turn
    // Grant is historical scope, never revived for mutation. Any task-level
    // permission must independently remain active (or be explicitly renewed).
    const restriction = object(await this.deps.validatePermission(task.threadId))
    if (original.taskPermissionId && typeof restriction.taskPermissionId !== 'string') fail('task_permission_revoked')
    const network = object(restriction.permissionScope).networkOrigins
    if (Array.isArray(network) && !network.includes(action.origin)) fail('network_scope_blocked')
    const providers = object(restriction.permissionScope).providerIds
    if (Array.isArray(providers) && !providers.includes('browser-skill')) fail('execution_grant_scope')
    assertGrantAllowsNetwork(action.pageUrl, { executionGrant: original } as ToolHostContext)
  }

  private async read(binding: Awaited<ReturnType<BrowserOperationVerificationService['binding']>>) {
    const { task, original, action, sessionId, targetRef } = binding
    const validate = async () => { await this.binding(task.id, binding.receipt.id, task.revision) }
    const grant: ExecutionGrant = { ...original, id: `browser-readback:${randomUUID()}`, sandboxMode: 'read-only', allowedToolNames: readTools,
      allowedProviderIds: ['browser-skill'], pathAllowlist: [], readPathAllowlist: [], writePathAllowlist: [], externalTargets: [],
      browserScope: { ...original.browserScope!, interaction: 'observe' }, issuedAt: this.deps.nowIso(),
      expiresAt: new Date(Date.parse(this.deps.nowIso()) + 45_000).toISOString() }
    const context: ToolHostContext = { threadId: task.threadId, turnId: original.turnId, workspace: original.workspaceRoot,
      executionGrant: grant, allowedToolNames: readTools, allowedProviderIds: ['browser-skill'], sandboxMode: 'read-only', approvalPolicy: original.approvalPolicy,
      abortSignal: AbortSignal.timeout(45_000), awaitApproval: async () => 'deny', validateExecutionGrant: validate }
    const read = async (toolName: string, args: Record<string, unknown>) => {
      const result = await this.deps.toolHost.execute({ toolName, providerId: 'browser-skill', callId: `browser-review-${randomUUID()}`, arguments: args }, context)
      const output = object(result.item.kind === 'tool_result' ? result.item.output : undefined)
      if (result.item.kind !== 'tool_result' || result.item.isError || output.status !== 'succeeded' || output.sourceUrl !== action.pageUrl) fail(typeof output.code === 'string' ? output.code : 'browser_review_read_failed')
      return output
    }
    const observation = await read('browser_observe', { sessionId })
    const target = await read('browser_get_html', { sessionId, target: targetRef, maxBytes: 8192 })
    if (target.truncated || typeof target.html !== 'string' || sha(target.html) !== action.elementHash) fail('browser_review_target_changed')
    const page = await read('browser_get_html', { sessionId, maxBytes: 524288 })
    const observedText = object(object(observation.observation).observation).text
    const hasObservation = typeof observedText === 'string' && Boolean(observedText.trim())
    // A large page can still supply a fresh visible observation and the exact
    // authorized target. Never derive review text from an incomplete HTML prefix.
    if (typeof page.html !== 'string' || page.truncated && !hasObservation) fail('browser_review_read_failed')
    const sourceText = hasObservation ? observedText as string
      : page.html.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!sourceText.trim()) fail('browser_review_read_failed')
    const coverage = { source: hasObservation ? 'visible_observation' : 'html', htmlTruncated: page.truncated === true,
      textTruncated: sourceText.length > 12000 }
    const text = `只读核验范围：当前页面摘要与原目标。${coverage.htmlTruncated ? '页面 HTML 超出读取上限，未读取整页。' : ''}${coverage.textTruncated ? '摘要仅展示前 12000 个字符。' : ''}这不是完整页面扫描，也不证明原操作已成功；请核对下面的实际内容后再决定是否确认。\n\n${sourceText.slice(0, 12000)}`
    return { text, coverage, hash: operationFingerprint({ pageUrl: action.pageUrl, html: page.html, text, coverage, elementHash: action.elementHash }) }
  }
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function summaryFields(summary: string): Record<string, string> {
  if (sanitizeBrowserApprovalSummary(summary) !== summary) fail('browser_review_approval_missing')
  return Object.fromEntries(summary.split('\n').slice(1).map(line => { const at = line.indexOf(' '); return [line.slice(0, at), JSON.parse(line.slice(at + 1)) as string] }))
}

export function browserReceiptProjection(repository: TaskRunRepository, receipt: OperationReceipt) {
  const toolName = String(receipt.request?.toolName ?? '')
  if (!['browser_click', 'browser_fill'].includes(toolName)) return []
  const dispatch = repository.operations(receipt.ownerId, 'browser_action_dispatch').find(item => item.request?.turnId === receipt.request?.turnId &&
    item.request?.toolName === toolName && item.request?.argumentsHash === receipt.request?.argumentsHash)
  const pageUrl = typeof dispatch?.request?.pageUrl === 'string' ? dispatch.request.pageUrl : undefined
  const resolution = repository.verifiedOperationResolution(receipt)
  return [{ id: receipt.id, taskId: receipt.ownerId, purpose: 'browser_action', provider: 'browser-skill', operation: toolName.slice('browser_'.length), toolName,
    requestHash: receipt.fingerprint, status: receipt.status, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
    browser: { action: toolName === 'browser_fill' ? 'fill' : 'click', pageUrl,
      canReview: Boolean(receipt.status === 'outcome_unknown' && !resolution && dispatch?.request?.sessionId && dispatch.request.targetRef) },
    ...(resolution ? { resolution } : {}) }]
}
