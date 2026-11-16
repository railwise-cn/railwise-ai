import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowRepository } from '../flow/repository.js'
import { FlowRuntimeService } from '../flow/service.js'
import { buildCoreFlowAdapters } from '../flow/core-adapters.js'
import { buildFlowNodeRegistry } from '../flow/node-registry.js'
import { TaskRunRepository, operationFingerprint } from './task-run-repository.js'
import { ManagedBrowserSkillRuntime } from './managed-browser-skill-runtime.js'
import { saveTaskPublicQueryAction, verifiedTaskPublicQueryDocumentNavigation } from './browser-public-query-authority.js'
import { TaskRunSchema } from '../contracts/tasks.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { ThreadSchema } from '../contracts/threads.js'
import { TaskScheduleService } from './task-schedule-service.js'
import { buildTaskScheduleToolProvider } from '../adapters/tool/task-schedule-tool-provider.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { BrowserCapabilityConfig } from '../contracts/browser-skill.js'
import { BrowserScheduleActionAuthority } from './browser-schedule-action-authority.js'
import { browserApprovalSummary } from '../security/browser-approval-summary.js'
import type { OperationReceipt } from '../contracts/tasks.js'

const cleanup: Array<() => void> = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const browserTargetHtml = { click: '<button>查询公告</button>', fill: '<input aria-label="关键词">' }
afterEach(() => { cleanup.splice(0).forEach(close => close()); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-13T00:00:00Z'))
  const root = mkdtempSync(join(tmpdir(), 'railwise-schedule-test-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
  const flowRepository = new FlowRepository(':memory:')
  const flows = new FlowRuntimeService(flowRepository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
  cleanup.push(() => { flows.shutdown(); repository.close(); rmSync(root, { recursive: true, force: true }) })
  const task = repository.create(TaskRunSchema.parse({ id: 'task-test', threadId: 'execution', originThreadId: 'origin', activeTurnId: 'turn',
    childTaskIds: [], workspaceRoot: '/workspace', goal: '抓取网页并生成HTML，每天9点和17点前执行。', status: 'running',
    acceptance: { kind: 'files', requiredNodeKinds: ['execute', 'verify', 'deliver'], requireFinalResponse: true, requireActionableArtifactCard: true,
      schedule: { kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 } },
    agentId: 'general', budget: { maxAttempts: 10, maxDurationMs: 600000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [], artifacts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 }))
  const grant = ExecutionGrantSchema.parse({ id: 'grant', taskId: task.id, threadId: 'execution', turnId: 'turn', workspaceRoot: '/workspace',
    workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
    pathAllowlist: ['/workspace'], networkAllowlist: ['https://example.test'], connectorIdentityFingerprints: { 'mcp:test': 'a'.repeat(64) },
    workspaceRevision: 1, agentRevision: 1, revision: 1, idempotencyKey: 'grant', issuedAt: new Date().toISOString() })
  const identities: Record<string, string> = { 'mcp:test': 'a'.repeat(64) }
  const browser = BrowserCapabilityConfig.parse({ enabled: true, state: 'ready', browserInstanceId: 'browser-one', revision: 1,
    origins: ['https://example.test'], interaction: 'interact' })
  const ego = { state: 'installed' as const, executablePath: '/controlled/ego-browser', executableHash: 'b'.repeat(64), version: '0.6.3.14', revision: 2 }
  const workspace = { canonicalRoot: '/workspace', level: 'workspace-write', revision: 1 }
  const execution = ThreadSchema.parse({ id: 'execution', title: 'test', workspace: '/workspace', model: 'test', mode: 'agent', status: 'idle',
    agentRevision: 1, agentProfile: { id: 'general', name: 'General', role: 'General', color: 'blue', systemPrompt: 'Test', toolAllowlist: ['*'], mcpAllowlist: ['*'], trustLevel: 'workspace-write', budget: { maxAttempts: 10, maxDurationMs: 600000 }, revision: 1 }, approvalPolicy: 'on-request', sandboxMode: 'workspace-write', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const origin = { ...execution, id: 'origin', approvalPolicy: 'never' as const }
  const threads = new Map([['execution', execution], ['origin', origin]])
  const coordinator = { command: vi.fn(async (_command: unknown, _options?: unknown) => ({ kind: 'task_started' })) }
  let activeTaskId = task.id
  const service = new TaskScheduleService({ flows, repository, tasks: { activeTask: () => repository.get(activeTaskId) } as never,
    coordinator: coordinator as never, threads: { get: async (id: string) => threads.get(id), upsert: async (value: typeof execution) => { threads.set(value.id, value); return value } } as never,
    workspaceTrust: { get: async () => workspace } as never, connectorIdentities: () => identities, browserState: () => browser, egoBrowserState: () => ego, nowIso: () => new Date().toISOString() })
  flows.setTaskScheduleDispatcher(input => service.dispatch(input))
  const context = { threadId: 'execution', turnId: 'turn', workspace: '/workspace', executionGrant: grant, validateExecutionGrant: vi.fn(), abortSignal: new AbortController().signal, awaitApproval: vi.fn(async () => 'allow') } as unknown as ToolHostContext
  function temporaryPaths() {
    const current = repository.get(task.id)!
    repository.update(task.id, current.revision, value => ({ ...value, authority: { source: 'user', workspaceRoot: '/workspace', externalTargets: [], grantedAt: new Date().toISOString(),
      taskApprovalGrant: { id: 'temporary', taskId: task.id, threadId: 'execution', previousPolicy: 'never', approvalPolicy: 'on-request', workspaceRoot: '/workspace', workspaceRevision: 1, workspaceTrust: 'workspace-write', agentRevision: 1, scopeFingerprint: 'a'.repeat(64), status: 'active', confirmed: true, confirmedAt: new Date().toISOString(), expiresAt: '2026-11-13T00:15:00.000Z', idempotencyKey: 'temporary', scope: { readPaths: ['/workspace'], writePaths: ['/workspace/reports'] }, workspaceWriteException: true, duration: 'task' } } }))
    grant.workspaceWriteException = true
    grant.readPathAllowlist = ['/workspace']
    grant.writePathAllowlist = ['/workspace/reports']
  }
  function approveBrowserAction(action: 'click' | 'fill') {
    grant.browserScope = { browserInstanceId: 'browser-one', revision: 1, origins: ['https://example.test'], interaction: 'interact' }
    const current = repository.get(task.id)!
    if (!current.authority?.browserScope) repository.update(current.id, current.revision, value => ({ ...value, authority: {
      source: 'user', workspaceRoot: '/workspace', externalTargets: [], grantedAt: new Date().toISOString(), browserScope: grant.browserScope
    } }))
    const browserAuthority = new BrowserScheduleActionAuthority({ repository })
    const candidate = browserAuthority.prepare(task.id, grant.browserScope, { action, pageUrl: 'https://example.test/search',
      elementHash: digest(browserTargetHtml[action]), ...(action === 'fill' ? { valueHash: digest('工程监测') } : {}) })
    return browserAuthority.save(candidate, `approved-${action}`, browserApprovalSummary({ action, origin: 'https://example.test',
      targetHtml: browserTargetHtml[action], value: action === 'fill' ? '工程监测' : undefined,
      requestHash: candidate.id }))
  }
  function browserTool(toolName: string, options: { status?: OperationReceipt['status']; output?: Record<string, unknown>; request?: Record<string, unknown>; approved?: boolean } = {}) {
    grant.browserScope ??= { browserInstanceId: 'browser-one', revision: 1, origins: ['https://example.test'], interaction: 'interact' }
    const key = `tool-${repository.operations(task.id).length}`
    repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'tool', nowIso: new Date().toISOString(), request: {
      toolName, callId: key, turnId: 'turn', argumentsHash: digest(key), approvalRequestHash: digest(key), executionGrant: grant, ...options.request
    } })
    return repository.finishOperation(task.id, key, { status: options.status ?? 'succeeded', result: { approved: options.approved ?? true,
      item: { kind: 'tool_result', toolName, output: { status: options.status ?? 'succeeded', provider: 'browser-skill', sessionId: 'session-one', ...options.output } }
    } })
  }
  function browserDispatch(action: 'click' | 'fill', status: OperationReceipt['status'] = 'succeeded', request: Record<string, unknown> = {}) {
    const key = `dispatch-${repository.operations(task.id).length}`
    repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'browser_action_dispatch', nowIso: new Date().toISOString(), request: {
      action, toolName: `browser_${action}`, turnId: 'turn', argumentsHash: digest(key), pageUrl: 'https://example.test/search',
      elementHash: digest(browserTargetHtml[action]), ...(action === 'fill' ? { valueHash: digest('工程监测') } : {}),
      browserInstanceId: 'browser-one', browserRevision: 1, ...request
    } })
    return repository.finishOperation(task.id, key, { status })
  }
  return { selectTask: (id: string) => { activeTaskId = id }, service, flows, flowRepository, repository, task, context, coordinator, identities, workspace, threads, temporaryPaths, approveBrowserAction, browserTool, browserDispatch, browser, ego, root }
}

/** Safe-equivalent of the real c9/rev3 -> f84/rev4 durable binding history. */
function reboundBrowserFixture(options: { resolveOld?: boolean } = {}) {
  const f = fixture(), grant = f.context.executionGrant!
  f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision, task => ({ ...task, status: 'paused',
    goal: '使用浏览器查询公开招标公告并生成HTML，每天9点和17点前执行。' }))
  Object.assign(f.browser, { version: '0.5.0', daemonProtocolVersion: '1.9', browsers: [
    { id: 'browser-one', name: 'Chrome', label: '测试 Chrome', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }
  ] })
  const bind = (duration?: 'schedule') => {
    const runtime = new ManagedBrowserSkillRuntime({ config: f.browser, configPath: join(f.root, 'config.json'), dataDir: f.root,
      repository: f.repository, apply: () => undefined })
    const snapshot = runtime.bindingSnapshot(f.task.id)
    runtime.confirmBinding(f.task.id, { confirmed: true, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
      browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: 'interact', verificationPolicy: 'public_query_target',
      ...(duration ? { publicQueryAuthorization: duration } : {}), idempotencyKey: `bind-${snapshot.browserRevision}` })
    grant.browserScope = structuredClone(f.repository.get(f.task.id)!.authority!.browserScope!)
    f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision, task => ({ ...task, status: 'running', activeTurnId: grant.turnId }))
  }
  bind()
  const authority = new BrowserScheduleActionAuthority({ repository: f.repository })
  const candidate = authority.prepare(f.task.id, grant.browserScope!, { action: 'fill', pageUrl: 'https://example.test/search',
    elementHash: digest(browserTargetHtml.fill), valueHash: digest('工程监测') })
  const approved = authority.save(candidate, 'old-approval', browserApprovalSummary({ action: 'fill', origin: 'https://example.test',
    targetHtml: browserTargetHtml.fill, value: '工程监测', requestHash: candidate.id, verificationPolicy: 'public_query_target' }))
  const scheduleAuthorization = f.repository.operations(f.task.id, 'browser_schedule_action_authorization')[0]!
  f.repository.saveHumanRequest({ id: approved.approvalId, kind: 'approval', threadId: f.task.threadId, turnId: 'turn',
    message: approved.summary, payload: { approval: { toolName: 'browser_authorize_action', requestHash: digest(JSON.stringify(scheduleAuthorization.request)),
      summary: approved.summary } }, status: 'answered', resolution: { decision: 'allow' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const actionRequest = { taskId: f.task.id, sessionId: 'session-one', browserInstanceId: 'browser-one', browserRevision: 1,
    grantRevision: grant.revision, workspaceRevision: grant.workspaceRevision, agentRevision: grant.agentRevision, goalHash: digest(f.repository.get(f.task.id)!.goal),
    origin: 'https://example.test', pageUrl: approved.pageUrl, elementHash: approved.elementHash, valueHash: approved.valueHash,
    action: 'fill', verificationPolicy: 'public_query_target' }
  const authorization = f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: 'old-exact-action', kind: 'browser_action_authorization',
    request: actionRequest, nowIso: new Date().toISOString() }).receipt
  f.repository.finishOperation(f.task.id, authorization.idempotencyKey, { status: 'succeeded', result: {
    approvalId: approved.approvalId, expiresAt: '2026-11-13T00:15:00Z', revoked: false, scheduleActionId: approved.id, access: 'public_query', verificationPolicy: 'public_query_target'
  } })
  const args = digest('same-old-action'), dispatch = f.browserDispatch('fill', 'succeeded', { argumentsHash: args, sessionId: 'session-one',
    authorizationReceiptId: authorization.id, scheduleActionId: approved.id, verificationPolicy: 'public_query_target' })
  f.repository.finishOperation(f.task.id, dispatch.idempotencyKey, { status: 'succeeded', result: {
    actionAcknowledged: true, acknowledgementHash: digest('ack'), readbackPending: false, resultHash: digest('old-page')
  } })
  const original = f.browserTool('browser_fill', { request: { providerId: 'browser-skill', argumentsHash: args },
    output: { dispatchReceiptId: dispatch.id, resultHash: digest('old-page') } })
  if (options.resolveOld) {
    vi.setSystemTime(new Date('2026-11-13T00:00:30Z'))
    const evidence = { kind: 'human_confirmation' as const, provider: 'browser-skill', operation: 'fill', target: approved.pageUrl,
      status: 'public_query_confirmed_by_user', verified: true, verifiedAt: new Date().toISOString(), resultHash: digest('reviewed-page') }
    for (const receipt of [original, dispatch]) {
      f.repository.finishOperation(f.task.id, receipt.idempotencyKey, { status: 'outcome_unknown', result: receipt.result })
      const key = `verified-old-${receipt.id}`
      const proof = f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: key, kind: 'effect_verification',
        request: { originalReceiptId: receipt.id, originalFingerprint: receipt.fingerprint }, nowIso: new Date().toISOString() }).receipt
      f.repository.finishOperation(f.task.id, key, { status: 'succeeded', result: { evidence } })
      f.repository.resolveOperation(f.task.id, receipt.idempotencyKey, { status: 'verified', receiptId: proof.id, evidence, resolvedAt: new Date().toISOString() })
    }
  }
  const oldRows = f.repository.operations(f.task.id).map(row => JSON.stringify(row))
  vi.setSystemTime(new Date('2026-11-13T00:01:00Z'))
  f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision, task => ({ ...task, status: 'paused' }))
  Object.assign(f.browser, { browserInstanceId: 'browser-two', revision: 2, browsers: [
    { id: 'browser-two', name: 'Chrome', label: '测试 Chrome', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }
  ] })
  Object.assign(grant, { id: 'grant-new', turnId: 'turn-new', idempotencyKey: 'grant-new', issuedAt: new Date().toISOString() })
  f.context.turnId = 'turn-new'
  bind('schedule')
  const currentTask = f.repository.get(f.task.id)!, scope = grant.browserScope!
  const currentBinding = f.repository.operations(f.task.id, 'browser_binding').at(-1)!
  const scopeAction = saveTaskPublicQueryAction(f.repository, grant, { taskId: f.task.id, sessionId: 'session-two', browserInstanceId: scope.browserInstanceId,
    browserRevision: scope.revision, pageUrl: 'https://example.test/search', origin: 'https://example.test', action: 'click', elementHash: digest(browserTargetHtml.click),
    verificationPolicy: 'public_query_target' }, 'current-context', 'search_trigger', '已授权公开查询')!
  const currentDispatch = f.browserDispatch('click', 'succeeded', { turnId: 'turn-new', argumentsHash: digest('new-click'), sessionId: 'session-two',
    browserInstanceId: scope.browserInstanceId, browserRevision: scope.revision, verificationPolicy: 'public_query_target',
    authorizationSource: 'task_scope', scopeActionReceiptId: scopeAction.receipt.id, scopeAuthorizationReceiptId: currentBinding.id,
    contextHash: digest('current-context') })
  f.repository.finishOperation(f.task.id, currentDispatch.idempotencyKey, { status: 'succeeded', result: {
    actionAcknowledged: true, acknowledgementHash: digest('new-ack'), readbackPending: false, resultHash: digest('new-page')
  } })
  f.browserTool('browser_click', { request: { providerId: 'browser-skill', turnId: 'turn-new', argumentsHash: digest('new-click') },
    output: { dispatchReceiptId: currentDispatch.id, resultHash: digest('new-page') } })
  return { ...f, oldRows, dispatch, original, authorization, approved, scheduleAuthorization, currentTask, currentBinding, currentDispatch, bind }
}

function rewriteReceipt(f: ReturnType<typeof reboundBrowserFixture>, id: string, edit: (value: OperationReceipt) => void) {
  const value = f.repository.operations(f.task.id).find(row => row.id === id)!
  edit(value)
  value.fingerprint = operationFingerprint(value.request)
  f.repository.connection().prepare('UPDATE operation_receipts SET data_json = ? WHERE owner_id = ? AND idempotency_key = ?')
    .run(JSON.stringify(value), value.ownerId, value.idempotencyKey)
}

function twiceReboundBrowserFixture(prepare?: (f: ReturnType<typeof reboundBrowserFixture>) => void) {
  const f = reboundBrowserFixture()
  prepare?.(f)
  const before = f.repository.operations(f.task.id).map(row => JSON.stringify(row))
  vi.setSystemTime(new Date('2026-11-13T00:02:00Z'))
  f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision, task => ({ ...task, status: 'paused' }))
  Object.assign(f.browser, { browserInstanceId: 'browser-three', revision: 3, browsers: [
    { id: 'browser-three', name: 'Chrome', label: '测试 Chrome', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }
  ] })
  Object.assign(f.context.executionGrant!, { id: 'grant-third', turnId: 'turn-third', idempotencyKey: 'grant-third', issuedAt: new Date().toISOString() })
  f.context.turnId = 'turn-third'
  f.bind('schedule')
  return { ...f, before }
}

describe('task-owned recurring execution', () => {
  it.each(['valid', 'forged-destination', 'fake-click-ack', 'unknown'] as const)('retires only a fully verified native document GET across a later browser binding: %s', async mode => {
    let navigation!: OperationReceipt
    const prepare = () => twiceReboundBrowserFixture(base => {
      const grant = structuredClone(base.context.executionGrant!), scope = grant.browserScope!, argsHash = digest('native-document-intent')
      const destination = 'https://example.test/notice/detail?articleId=42', href = '/notice/detail?articleId=42'
      const proof = { hrefHash: digest(href), destinationHash: digest(destination), canonicalTarget: '@e999', frameHash: digest('native-frame') }
      const contextHash = digest('old-document-context'), resultHash = digest('real-owned-document-observation')
      const scoped = saveTaskPublicQueryAction(base.repository, grant, { taskId: base.task.id, sessionId: 'session-two', browserInstanceId: scope.browserInstanceId,
        browserRevision: scope.revision, pageUrl: 'https://example.test/search', origin: 'https://example.test', action: 'click',
        elementHash: digest(`<a href="${href}" target="_blank">公告正文</a>`), verificationPolicy: 'public_query_target', documentLinkProof: proof },
      'old-document-context', 'result_link', 'Native document GET fixture')!
      const key = 'native-document-host', callId = 'native-document-call'
      base.repository.beginOperation({ ownerId: base.task.id, idempotencyKey: key, kind: 'tool', nowIso: new Date().toISOString(), request: {
        toolName: 'browser_click', providerId: 'browser-skill', callId, turnId: grant.turnId, argumentsHash: argsHash, executionGrant: grant } })
      navigation = base.browserDispatch('click', 'succeeded', { turnId: grant.turnId, argumentsHash: argsHash, sessionId: 'session-two', nativeAction: 'navigate',
        navigationDestinationHash: proof.destinationHash, documentLinkProof: proof, browserInstanceId: scope.browserInstanceId, browserRevision: scope.revision,
        verificationPolicy: 'public_query_target', contextHash, elementHash: scoped.receipt.request!.elementHash, scheduleActionId: scoped.result.id,
        authorizationSource: 'task_scope', scopeActionReceiptId: scoped.receipt.id, scopeAuthorizationReceiptId: base.currentBinding.id })
      navigation = base.repository.finishOperation(base.task.id, navigation.idempotencyKey, { status: 'succeeded', result: {
        nativeAction: 'navigate', requestedAction: 'click', clickDispatched: false, actionAcknowledged: false, navigationAcknowledged: true, readbackPending: false,
        navigationDestinationHash: proof.destinationHash, navigationContextHash: digest('fresh-document-context'), sourceUrl: destination, resultHash } })
      const host = base.repository.finishOperation(base.task.id, key, { status: 'succeeded', result: { approved: true, item: {
        kind: 'tool_result', status: 'completed', toolName: 'browser_click', threadId: grant.threadId, turnId: grant.turnId, callId, isError: false,
        output: { provider: 'browser-skill', status: 'succeeded', action: 'navigate', requestedAction: 'click', nativeAction: 'navigate', clickDispatched: false,
          sourceUrl: destination, resultHash, dispatchReceiptId: navigation.id, documentLinkProof: proof }
      } } })
      expect(verifiedTaskPublicQueryDocumentNavigation(base.repository, host, navigation)).toBeTruthy()
      if (mode === 'forged-destination') rewriteReceipt(base, navigation.id, row => { row.request!.navigationDestinationHash = digest('another-document') })
      if (mode === 'fake-click-ack') rewriteReceipt(base, navigation.id, row => { (row.result as Record<string, unknown>).actionAcknowledged = true })
      if (mode === 'unknown') rewriteReceipt(base, navigation.id, row => { row.status = 'outcome_unknown' })
    })
    if (mode === 'unknown') {
      // The normal binding entry blocks an unresolved operation even before a
      // later schedule could attempt to retire it.
      expect(prepare).toThrow('browser_unresolved_operation')
      return
    }
    const f = prepare()
    if (mode !== 'valid') await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    else {
      expect((await f.service.create(f.context)).scope.browserScope).toMatchObject({ browserInstanceId: 'browser-three', revision: 3 })
      const audit = (f.repository.operations(f.task.id, 'schedule_authority')[0].result as { retiredBrowserActions: Array<{ dispatchReceiptId: string }> }).retiredBrowserActions
      expect(audit.some(row => row.dispatchReceiptId === navigation.id)).toBe(true)
      expect(f.repository.operations(f.task.id).slice(0, f.before.length).map(row => JSON.stringify(row))).toEqual(f.before)
    }
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })

  it('retires proven ancestors across two explicit browser rebindings without copying either generation into the new plan', async () => {
    const f = twiceReboundBrowserFixture()
    const saved = await f.service.create(f.context)
    expect(saved.scope.browserScope).toMatchObject({ browserInstanceId: 'browser-three', revision: 3 })
    expect(saved.scope.browserScheduleActions).toEqual([])
    expect(f.repository.operations(f.task.id).slice(0, f.before.length).map(row => JSON.stringify(row))).toEqual(f.before)
    const audit = (f.repository.operations(f.task.id, 'schedule_authority')[0]!.result as { retiredBrowserActions: Array<{ dispatchReceiptId: string }> }).retiredBrowserActions
    expect(audit.map(row => row.dispatchReceiptId).sort()).toEqual([f.dispatch.id, f.currentDispatch.id].sort())
    const first = f.repository.operations(f.task.id, 'browser_binding')[0]!, last = f.repository.operations(f.task.id, 'browser_binding').at(-1)!
    expect(audit.find(row => row.dispatchReceiptId === f.dispatch.id)).toMatchObject({ bindingLineageReceiptIds: [first.id, f.currentBinding.id, last.id] })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })

  it.each(['missing_middle', 'broken_previous', 'changed_purpose', 'changed_requirement', 'missing_identity', 'late_old_success',
    'unknown_ancestor', 'unfinished_middle'] as const)('keeps an unprovable multi-generation lineage blocked: %s', async variant => {
    const f = twiceReboundBrowserFixture()
    if (variant === 'missing_middle') f.repository.connection().prepare('DELETE FROM operation_receipts WHERE owner_id = ? AND idempotency_key = ?')
      .run(f.task.id, f.currentBinding.idempotencyKey)
    if (variant === 'broken_previous') rewriteReceipt(f, f.currentBinding.id, row => { (row.result as Record<string, unknown>).previousBrowserInstanceId = 'unrelated' })
    if (variant === 'changed_purpose') rewriteReceipt(f, f.currentBinding.id, row => { (row.result as Record<string, unknown>).purpose = '另一个目的' })
    if (variant === 'changed_requirement') rewriteReceipt(f, f.currentBinding.id, row => {
      ((row.result as Record<string, unknown>).publicQueryAuthorization as Record<string, unknown>).requirementHash = digest('another-schedule')
    })
    if (variant === 'missing_identity') rewriteReceipt(f, f.dispatch.id, row => { delete row.request!.browserRevision })
    if (variant === 'late_old_success') rewriteReceipt(f, f.dispatch.id, row => { row.createdAt = new Date().toISOString(); row.updatedAt = new Date().toISOString() })
    if (variant === 'unknown_ancestor') rewriteReceipt(f, f.dispatch.id, row => { row.status = 'outcome_unknown' })
    if (variant === 'unfinished_middle') rewriteReceipt(f, f.currentDispatch.id, row => { row.status = 'running' })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: variant === 'unknown_ancestor' || variant === 'unfinished_middle'
      ? 'browser_schedule_outcome_unknown' : 'browser_schedule_action_scope_required' })
    expect(f.flows.list()).toHaveLength(0)
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })

  it('does not infer expanded site authority from a broader browser configuration during rebinding', () => {
    const f = reboundBrowserFixture()
    f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision, task => ({ ...task, status: 'paused' }))
    f.browser.origins.push('https://additional.test')
    const runtime = new ManagedBrowserSkillRuntime({ config: f.browser, configPath: join(f.root, 'config.json'), dataDir: f.root,
      repository: f.repository, apply: () => undefined })
    const snapshot = runtime.bindingSnapshot(f.task.id), before = JSON.stringify(f.repository.get(f.task.id))
    expect(snapshot.origins).toEqual(['https://example.test'])
    expect(() => runtime.confirmBinding(f.task.id, { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId,
      origins: [...snapshot.origins, 'https://additional.test'], interaction: 'interact', verificationPolicy: 'public_query_target',
      publicQueryAuthorization: 'schedule', idempotencyKey: 'cannot-infer-expanded-sites' })).toThrow('browser_binding_changed')
    expect(JSON.stringify(f.repository.get(f.task.id))).toBe(before)
  })

  it.each(['previous_created', 'dispatch_created', 'tool_created', 'tool_updated', 'authorization_created', 'continuous_created',
    'human_created', 'human_updated', 'dispatch_resolution', 'tool_resolution'] as const)('rejects a retired proof with an unparseable %s timestamp', async field => {
    const f = reboundBrowserFixture({ resolveOld: field.endsWith('_resolution') })
    if (field === 'previous_created') rewriteReceipt(f, f.repository.operations(f.task.id, 'browser_binding')[0]!.id, row => { row.createdAt = 'invalid-time' })
    if (field === 'dispatch_created') rewriteReceipt(f, f.dispatch.id, row => { row.createdAt = 'invalid-time' })
    if (field === 'tool_created') rewriteReceipt(f, f.original.id, row => { row.createdAt = 'invalid-time' })
    if (field === 'tool_updated') rewriteReceipt(f, f.original.id, row => { row.updatedAt = 'invalid-time' })
    if (field === 'authorization_created') rewriteReceipt(f, f.authorization.id, row => { row.createdAt = 'invalid-time' })
    if (field === 'continuous_created') rewriteReceipt(f, f.scheduleAuthorization.id, row => { row.createdAt = 'invalid-time' })
    if (field === 'human_created' || field === 'human_updated') {
      const human = f.repository.humanRequest(f.approved.approvalId)!
      human[field === 'human_created' ? 'createdAt' : 'updatedAt'] = 'invalid-time'
      f.repository.connection().prepare('UPDATE human_requests SET data_json = ? WHERE id = ?').run(JSON.stringify(human), human.id)
    }
    if (field === 'dispatch_resolution' || field === 'tool_resolution') rewriteReceipt(f, field === 'dispatch_resolution' ? f.dispatch.id : f.original.id,
      row => { row.resolution!.resolvedAt = 'invalid-time' })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.flows.list()).toHaveLength(0)
  })

  it.each(['verified', 'missing_proof', 'succeeded_ack_pending'] as const)('respects the exact unknown readback resolution contract: %s', async state => {
    const f = fixture()
    f.approveBrowserAction('fill')
    const argumentsHash = digest('readback-unknown')
    const dispatch = f.browserDispatch('fill', state === 'succeeded_ack_pending' ? 'succeeded' : 'outcome_unknown', { argumentsHash })
    f.repository.finishOperation(f.task.id, dispatch.idempotencyKey, { status: dispatch.status, result: { actionAcknowledged: true, readbackPending: true } })
    const tool = f.browserTool('browser_fill', { status: 'outcome_unknown', request: { argumentsHash } })
    const evidence = { kind: 'human_confirmation' as const, provider: 'browser-skill', operation: 'fill', target: String(dispatch.request!.pageUrl),
      status: 'public_query_confirmed_by_user', verified: true, verifiedAt: new Date().toISOString(), resultHash: digest('verified-readback') }
    for (const receipt of [tool, ...(state === 'succeeded_ack_pending' ? [] : [dispatch])]) {
      const key = `readback-proof-${receipt.id}`
      const proof = f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: key, kind: 'effect_verification',
        request: { originalReceiptId: receipt.id, originalFingerprint: receipt.fingerprint }, nowIso: new Date().toISOString() }).receipt
      f.repository.finishOperation(f.task.id, key, { status: 'succeeded', result: { evidence } })
      f.repository.resolveOperation(f.task.id, receipt.idempotencyKey, { status: 'verified', receiptId: proof.id, evidence, resolvedAt: new Date().toISOString() })
    }
    if (state === 'missing_proof') f.repository.connection().prepare('DELETE FROM operation_receipts WHERE owner_id = ? AND idempotency_key = ?')
      .run(f.task.id, `readback-proof-${dispatch.id}`)
    if (state === 'verified') await expect(f.service.create(f.context)).resolves.toMatchObject({ enabled: true })
    else {
      await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_readback_blocked' })
      expect(f.flows.list()).toHaveLength(0)
    }
  })

  it('creates a forward plan from the new durable scope without reauthorizing or copying acknowledged retired-browser actions', async () => {
    const f = reboundBrowserFixture()
    const saved = await f.service.create(f.context)
    expect(saved.scope.browserScope).toMatchObject({ browserInstanceId: 'browser-two', revision: 2 })
    expect(saved.scope.browserScheduleActions).toEqual([])
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id).slice(0, f.oldRows.length).map(row => JSON.stringify(row))).toEqual(f.oldRows)
    expect(f.flows.list()).toHaveLength(1)
  })

  it('records stronger exact proof for a stale legacy derived pointer without rewriting history or writing during read-only validation', async () => {
    const f = reboundBrowserFixture(), staleId = digest('another-page-derived-action')
    rewriteReceipt(f, f.dispatch.id, receipt => { receipt.request!.scheduleActionId = staleId })
    const old = f.repository.operations(f.task.id).map(row => JSON.stringify(row))
    const saved = await f.service.create(f.context)
    const approval = f.repository.operations(f.task.id, 'schedule_authority')[0]!
    expect(approval.result).toMatchObject({ retiredBrowserActions: [{ dispatchReceiptId: f.dispatch.id, toolReceiptId: f.original.id,
      evidenceKind: 'historical_exact_approval', authorizationReceiptId: f.authorization.id, approvedScheduleActionId: f.approved.id,
      recordedScheduleActionId: staleId, legacyActionLinkMismatch: true, currentBindingReceiptId: f.currentBinding.id }] })
    expect(f.repository.operations(f.task.id).slice(0, old.length).map(row => JSON.stringify(row))).toEqual(old)
    const persisted = f.repository.operations(f.task.id).map(row => JSON.stringify(row))
    await f.service.resolveBrowserActions(f.context, f.currentBinding.id)
    f.service.assessCompletion(f.repository.get(f.task.id)!)
    expect((await f.service.create(f.context)).id).toBe(saved.id)
    expect(f.repository.operations(f.task.id).map(row => JSON.stringify(row))).toEqual(persisted)
  })

  it('accepts completed history after its old exact approval and Grant expire without using them for the new plan', async () => {
    const f = reboundBrowserFixture()
    rewriteReceipt(f, f.original.id, tool => { (tool.request!.executionGrant as Record<string, unknown>).expiresAt = '2026-11-13T00:00:30Z' })
    rewriteReceipt(f, f.authorization.id, receipt => { (receipt.result as Record<string, unknown>).expiresAt = '2026-11-13T00:00:30Z' })
    const saved = await f.service.create(f.context)
    expect(saved.scope.browserScope?.browserInstanceId).toBe('browser-two')
    expect(f.flows.get(saved.id)!.variables.taskSchedule).toMatchObject({ grant: { id: 'grant-new', turnId: 'turn-new' } })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })

  it.each(['missing_predecessor', 'unrelated_predecessor', 'old_purpose', 'current_requirement', 'missing_grant', 'wrong_turn',
    'missing_human', 'denied_human', 'human_hash', 'authorization_target', 'missing_ack', 'missing_readback', 'late_dispatch', 'expired_at_dispatch'] as const)('does not discard unprovable retired history: %s', async variant => {
      const f = reboundBrowserFixture(), oldBinding = f.repository.operations(f.task.id, 'browser_binding')[0]!
      if (variant === 'missing_predecessor' || variant === 'unrelated_predecessor') rewriteReceipt(f, f.currentBinding.id, receipt => {
        (receipt.result as Record<string, unknown>).previousBrowserInstanceId = variant === 'missing_predecessor' ? undefined : 'unrelated-browser'
      })
      if (variant === 'old_purpose') rewriteReceipt(f, oldBinding.id, receipt => { (receipt.result as Record<string, unknown>).purpose = '查询其他任务' })
      if (variant === 'current_requirement') f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision,
        task => ({ ...task, acceptance: { ...task.acceptance, schedule: { ...task.acceptance.schedule!, times: ['10:00'] } } }))
      if (variant === 'missing_grant') rewriteReceipt(f, f.original.id, receipt => { delete receipt.request!.executionGrant })
      if (variant === 'wrong_turn') rewriteReceipt(f, f.original.id, receipt => { (receipt.request!.executionGrant as Record<string, unknown>).turnId = 'another-turn' })
      if (variant === 'missing_human') f.repository.connection().prepare('DELETE FROM human_requests WHERE id = ?').run(f.approved.approvalId)
      if (variant === 'denied_human' || variant === 'human_hash') {
        const human = f.repository.humanRequest(f.approved.approvalId)!
        if (variant === 'denied_human') human.resolution = { decision: 'deny' }
        else (human.payload.approval as Record<string, unknown>).requestHash = digest('wrong')
        f.repository.connection().prepare('UPDATE human_requests SET data_json = ? WHERE id = ?').run(JSON.stringify(human), human.id)
      }
      if (variant === 'authorization_target') rewriteReceipt(f, f.authorization.id, receipt => { receipt.request!.elementHash = digest('other-element') })
      if (variant === 'missing_ack') rewriteReceipt(f, f.dispatch.id, receipt => { delete (receipt.result as Record<string, unknown>).acknowledgementHash })
      if (variant === 'missing_readback') rewriteReceipt(f, f.dispatch.id, receipt => { delete (receipt.result as Record<string, unknown>).readbackPending })
      if (variant === 'late_dispatch') rewriteReceipt(f, f.dispatch.id, receipt => { receipt.updatedAt = f.currentBinding.createdAt })
      if (variant === 'expired_at_dispatch') rewriteReceipt(f, f.original.id, receipt => {
        (receipt.request!.executionGrant as Record<string, unknown>).expiresAt = '2026-11-12T23:59:00Z'
      })
      await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
      expect(f.flows.list()).toHaveLength(0)
      expect(f.context.awaitApproval).not.toHaveBeenCalled()
    })

  it.each(['outcome_unknown', 'running', 'readback_pending', 'unknown_tool', 'unknown_schedule', 'unknown_session'] as const)('checks all generations before allowing the new plan: %s', async variant => {
      const f = reboundBrowserFixture()
      if (variant === 'readback_pending') rewriteReceipt(f, f.dispatch.id, receipt => { (receipt.result as Record<string, unknown>).readbackPending = true })
      else if (variant === 'outcome_unknown' || variant === 'running') rewriteReceipt(f, f.dispatch.id, receipt => { receipt.status = variant })
      else {
        const kind = variant === 'unknown_tool' ? 'tool' : variant === 'unknown_schedule' ? 'browser_schedule_action_outcome' : 'browser_session'
        f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: 'unfinished-history', kind,
          request: { turnId: 'old-turn', toolName: 'browser_click', browserInstanceId: 'browser-one', browserRevision: 1 }, nowIso: new Date().toISOString() })
        f.repository.finishOperation(f.task.id, 'unfinished-history', { status: 'outcome_unknown' })
      }
      await expect(f.service.create(f.context)).rejects.toMatchObject({ code: variant === 'readback_pending' ? 'browser_readback_blocked' : 'browser_schedule_outcome_unknown' })
      expect(f.flows.list()).toHaveLength(0)
    })

  it('still requires current actions to have current scope evidence', async () => {
    const f = reboundBrowserFixture()
    f.browserDispatch('click', 'succeeded', { turnId: 'turn-new', browserInstanceId: 'browser-two', browserRevision: 2,
      pageUrl: 'https://example.test/unreviewed', verificationPolicy: 'public_query_target' })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.flows.list()).toHaveLength(0)
  })

  it('does not apply legacy link-mismatch compatibility to the current browser scope', async () => {
    const f = reboundBrowserFixture()
    rewriteReceipt(f, f.currentDispatch.id, receipt => { receipt.request!.scheduleActionId = digest('another-current-action') })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.flows.list()).toHaveLength(0)
  })

  it.each([false, true])('keeps original action scope checks for human-confirmed unknown dispatches (drift=%s)', async drift => {
    const f = fixture()
    f.approveBrowserAction('fill')
    const argumentsHash = 'f'.repeat(64)
    const dispatch = f.browserDispatch('fill', 'outcome_unknown', { argumentsHash,
      ...(drift ? { pageUrl: 'https://example.test/changed' } : {}) })
    const tool = f.browserTool('browser_fill', { status: 'outcome_unknown', request: { argumentsHash } })
    const evidence = { kind: 'human_confirmation' as const, provider: 'browser-skill', operation: 'fill', target: String(dispatch.request!.pageUrl),
      status: 'public_query_confirmed_by_user', verified: true, verifiedAt: new Date().toISOString(), resultHash: 'human-proof' }
    for (const original of [dispatch, tool]) {
      const key = `human-proof-${original.id}`
      const proof = f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: key, kind: 'effect_verification',
        request: { originalReceiptId: original.id, originalFingerprint: original.fingerprint }, nowIso: new Date().toISOString() }).receipt
      f.repository.finishOperation(f.task.id, key, { status: 'succeeded', result: { evidence } })
      f.repository.resolveOperation(f.task.id, original.idempotencyKey, { status: 'verified', receiptId: proof.id, evidence, resolvedAt: new Date().toISOString() })
    }
    if (drift) await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    else await expect(f.service.create(f.context)).resolves.toMatchObject({ enabled: true })
  })
  it('does not persist a plan while an acknowledged browser action still lacks page readback', async () => {
    const f = fixture()
    f.approveBrowserAction('fill')
    const dispatch = f.browserDispatch('fill')
    f.repository.finishOperation(f.task.id, dispatch.idempotencyKey, { status: 'succeeded', result: {
      actionAcknowledged: true, acknowledgementHash: 'ack-hash', readbackPending: true } })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_readback_blocked' })
    expect(f.flows.list()).toHaveLength(0)
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
    f.repository.finishOperation(f.task.id, dispatch.idempotencyKey, { status: 'succeeded', result: {
      actionAcknowledged: true, acknowledgementHash: 'ack-hash', readbackPending: false, readbackHash: 'page-hash' } })
    await expect(f.service.create(f.context)).resolves.toMatchObject({ enabled: true })
  })

  it('uses discoverable tools to create and read back both times before accepting completion', async () => {
    const f = fixture()
    const tools = buildTaskScheduleToolProvider(() => f.service).tools
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
    await tools.find(tool => tool.name === 'schedule_task')!.execute({}, f.context)
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
    const read = await tools.find(tool => tool.name === 'list_schedules')!.execute({}, f.context)
    expect(read.output).toMatchObject({ schedules: [{ schedule: { kind: 'daily', times: ['08:30', '16:30'], timezone: 'Asia/Shanghai' }, nextRunAt: '2026-11-13T00:30:00.000Z' }] })
    expect(f.service.assessCompletion(f.task)).toBeNull()
    await f.service.create(f.context)
    expect(f.flows.list()).toHaveLength(1)
  })
  it('dispatches both occurrences through the task coordinator with a durable dedupe key', async () => {
    const f = fixture()
    await f.service.create(f.context)
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    expect(f.coordinator.command).toHaveBeenCalledTimes(1)
    expect(f.coordinator.command.mock.calls[0]?.[0]).toMatchObject({ threadId: 'origin', intent: 'new', idempotencyKey: 'schedule:schedule_task-test:2026-11-13T00:30:00.000Z' })
    await f.flows.tickSchedules(new Date('2026-11-13T08:30:00Z'))
    expect(f.coordinator.command).toHaveBeenCalledTimes(2)
    expect(f.flowRepository.pendingOutbox('scheduled_task_dispatch')).toHaveLength(0)
    expect(f.flows.history('schedule_task-test')).toHaveLength(0)
  })
  it('preserves a pending occurrence when connector identity changes and recovers without replay', async () => {
    const f = fixture()
    await f.service.create(f.context)
    f.identities['mcp:test'] = 'b'.repeat(64)
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.flowRepository.pendingOutbox('scheduled_task_dispatch')).toHaveLength(1)
    f.identities['mcp:test'] = 'a'.repeat(64)
    await f.flows.flushSourceEvents()
    await f.flows.flushSourceEvents()
    expect(f.coordinator.command).toHaveBeenCalledTimes(1)
  })
  it.each(['gui_schedule', 'claw_schedule'])('does not bind recurring task authority to the permanently task-blocked %s compatibility bridge', async serverId => {
    const f = fixture(), providerId = `mcp:${serverId}`, grant = f.context.executionGrant!
    const previous = '5be1fd564382f42c9d1fb0cc38ea6150df760016bd5dfe333e1577810d387c9d'
    const current = '4c10087a7056b4fc8666d2d065050dc260ab6fc8c9bbde856ec5049a4ecc5c77'
    grant.connectorIdentityFingerprints![providerId] = previous
    grant.allowedProviderIds = ['task-schedule', 'mcp:test', providerId]
    grant.allowedToolNames = ['schedule_task', 'list_schedules', `mcp_${serverId}_gui_schedule_list`, 'mcp_test_read']
    f.identities[providerId] = previous
    const first = await f.service.create(f.context)
    const flow = f.flows.get(first.id)!, authorityBefore = JSON.stringify(flow.variables.taskSchedule)
    const receiptsBefore = JSON.stringify(f.repository.operations(f.task.id, 'schedule_authority'))
    // The immutable original Grant retains its captured identity even though
    // those compatibility tools cannot execute in any task context.
    expect((flow.variables.taskSchedule as { grant: typeof grant }).grant.connectorIdentityFingerprints![providerId]).toBe(previous)
    f.identities[providerId] = current
    expect(await f.service.create(f.context)).toEqual(first)
    const readback = await f.service.readback(f.context)
    expect(readback.schedules).toHaveLength(1)
    expect(readback.schedules[0]!.enabled).toBe(true)
    expect(readback.schedules[0]!.scope.allowedProviderIds).not.toContain(providerId)
    // Tool names alone cannot prove provider ownership (normalization can
    // collide). The registry's exact server policy and provider allowlist
    // make these legacy aliases non-executable without guessing at other MCPs.
    expect(readback.schedules[0]!.scope.allowedToolNames).toEqual(grant.allowedToolNames)
    expect(readback.schedules[0]!.scope.connectorIdentityFingerprints).not.toHaveProperty(providerId)
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    await f.flows.tickSchedules(new Date('2026-11-13T00:30:00Z'))
    expect(f.coordinator.command).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(f.flows.get(first.id)!.variables.taskSchedule)).toBe(authorityBefore)
    expect(JSON.stringify(f.repository.operations(f.task.id, 'schedule_authority'))).toBe(receiptsBefore)
  })
  it.each(['mcp:test', 'mcp:gui_schedule_extra', 'dingtalk', 'browser-skill'])('cannot read back a misleading enabled schedule after the executable %s identity changes', async providerId => {
    const f = fixture(), grant = f.context.executionGrant!
    grant.connectorIdentityFingerprints![providerId] = 'a'.repeat(64)
    f.identities[providerId] = 'a'.repeat(64)
    await f.service.create(f.context)
    await f.service.readback(f.context)
    expect(f.service.assessCompletion(f.repository.get(f.task.id)!)).toBeNull()
    const before = f.repository.operations(f.task.id, 'schedule_readback').length
    f.identities[providerId] = 'b'.repeat(64)
    await expect(Promise.resolve().then(() => f.service.readback(f.context))).rejects.toMatchObject({ code: 'schedule_authority_changed' })
    expect(f.repository.operations(f.task.id, 'schedule_readback')).toHaveLength(before)
    expect(f.service.assessCompletion(f.repository.get(f.task.id)!)).toMatchObject({ retryable: false })
  })
  it('recalculates nextRunAt after changing the actual schedule fields', async () => {
    const f = fixture()
    await f.service.create(f.context)
    const flow = f.flows.get('schedule_task-test')!
    f.flows.update({ ...flow, nodes: flow.nodes.map(node => ({ ...node, config: { kind: 'daily', times: ['10:15'], timezone: 'Asia/Shanghai' } })) }, flow.revision)
    f.flows.publish(flow.id)
    expect(f.flowRepository.getTriggerState(flow.id, 'schedule')?.nextRunAt).toBe('2026-11-13T02:15:00.000Z')
    await f.service.readback(f.context)
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
  })
  it('keeps an explicitly confirmed recurring path scope after the temporary task grant expires', async () => {
    const f = fixture()
    f.temporaryPaths()
    const saved = await f.service.create(f.context)
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(vi.mocked(f.context.awaitApproval).mock.calls[0]?.[0].summary).toContain('/workspace/reports')
    expect(saved.authorization).toMatchObject({ kind: 'confirmed_scope', until: 'disabled', expiresAt: null })
    expect(saved.scope).toMatchObject({ workspaceWriteException: true, permissionScope: { writePaths: ['/workspace/reports'] } })
    expect(saved.scope.expiresAt).toBeUndefined()
    vi.setSystemTime(new Date('2026-11-14T00:30:00Z'))
    await f.flows.tickSchedules(new Date())
    expect(f.coordinator.command).toHaveBeenCalledOnce()
    const hooks = f.coordinator.command.mock.calls[0]?.[1] as { prepareExecutionThread(thread: unknown): Promise<void> }
    const occurrence = { ...f.threads.get('origin')!, id: 'occurrence', turns: [] }
    f.threads.set('occurrence', occurrence)
    await hooks.prepareExecutionThread(occurrence)
    expect(f.threads.get('origin')?.approvalPolicy).toBe('never')
    expect(f.threads.get('occurrence')?.approvalPolicy).toBe('on-request')
    expect(await f.service.executionScopeForThread('occurrence')).toMatchObject({ workspaceWriteException: true, writePathAllowlist: ['/workspace/reports'] })
    await hooks.prepareExecutionThread(f.threads.get('occurrence'))
    expect(f.repository.operations('occurrence', 'scheduled_task_prepare')).toHaveLength(1)
    f.threads.get('occurrence')!.approvalPolicy = 'never'
    await expect(hooks.prepareExecutionThread(f.threads.get('occurrence'))).rejects.toThrow('权限已变化')
  })
  it('does not create or complete a plan when durable path scope is denied', async () => {
    const f = fixture()
    f.temporaryPaths()
    vi.mocked(f.context.awaitApproval).mockResolvedValue('deny')
    await expect(f.service.create(f.context)).rejects.toThrow('持续计划权限未获确认')
    expect(f.flows.list()).toHaveLength(0)
    expect(f.service.assessCompletion(f.task)).not.toBeNull()
  })
  it.each(['origin', 'execution', 'revoked', 'scope'])('blocks recurrence when its %s authority changes', async change => {
    const f = fixture()
    f.temporaryPaths()
    await f.service.create(f.context)
    if (change === 'origin' || change === 'execution') f.threads.get(change)!.agentRevision += 1
    else {
      const current = f.repository.get(f.task.id)!
      f.repository.update(current.id, current.revision, value => ({ ...value, authority: { ...value.authority!, taskApprovalGrant: { ...value.authority!.taskApprovalGrant!,
        ...(change === 'revoked' ? { revokedAt: new Date().toISOString() } : { scope: { writePaths: ['/other'] } }) } } }))
    }
    await f.flows.tickSchedules(new Date('2026-11-14T00:30:00Z'))
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.flowRepository.pendingOutbox('scheduled_task_dispatch')).toHaveLength(1)
  })
  it('rejects a scope forged through editable Flow variables', async () => {
    const f = fixture()
    await f.service.create(f.context)
    const flow = f.flows.get('schedule_task-test')!
    const authority = flow.variables.taskSchedule as { scope: { writePathAllowlist?: string[] } }
    authority.scope.writePathAllowlist = ['*']
    f.flows.update({ ...flow, variables: { ...flow.variables, taskSchedule: authority } }, flow.revision)
    await expect(f.service.create(f.context)).rejects.toThrow('原始确认不一致')
  })
  it('explicitly versions added browser actions, preserves disabled state and old receipts, and rejects an old occurrence', async () => {
    const f = fixture()
    f.approveBrowserAction('click')
    const original = await f.service.create(f.context)
    const previous = f.flows.get(original.id)!
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(vi.mocked(f.context.awaitApproval).mock.calls[0]![0].summary).toContain('确认周期浏览器权限')
    await f.service.dispatch({ scheduleId: original.id, versionId: previous.publishedVersionId!, dueAt: '2026-11-13T00:30:00.000Z' })
    const hooks = f.coordinator.command.mock.calls[0]![1] as { prepareExecutionThread(thread: unknown): Promise<void> }
    const occurrence = { ...f.threads.get('origin')!, id: 'occurrence', turns: [] }
    f.threads.set(occurrence.id, occurrence)
    await hooks.prepareExecutionThread(occurrence)
    const originalReceipt = f.repository.operations(f.task.id, 'schedule_authority')[0]!
    const firstScope = await f.service.executionScopeForThread(occurrence.id)
    expect(firstScope?.browserScheduleBinding).toMatchObject({ scheduleId: original.id, versionId: previous.publishedVersionId })
    f.flows.update({ ...previous, variables: { ...previous.variables, enabled: false } }, previous.revision)
    f.approveBrowserAction('fill')
    f.browserDispatch('fill')
    const updated = await f.service.create(f.context)
    expect(updated.enabled).toBe(false)
    expect(updated.scope.browserScheduleActions).toHaveLength(2)
    expect(f.flows.list()).toHaveLength(1)
    expect(f.flows.get(original.id)!.publishedVersionId).not.toBe(previous.publishedVersionId)
    expect(f.context.awaitApproval).toHaveBeenCalledTimes(2)
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toHaveLength(2)
    expect(f.repository.operation(f.task.id, originalReceipt.idempotencyKey)).toEqual(originalReceipt)
    expect(await f.service.create(f.context)).toEqual(updated)
    expect(f.context.awaitApproval).toHaveBeenCalledTimes(2)
    await expect(f.service.executionScopeForThread(occurrence.id)).rejects.toThrow('计划已禁用或范围已变化')
  })
  it('does not silently promote an old temporary browser action into recurring authority', async () => {
    const f = fixture()
    f.repository.beginOperation({ ownerId: f.task.id, kind: 'browser_action_authorization', idempotencyKey: 'old-15-minutes', request: { action: 'click' }, nowIso: new Date().toISOString() })
    f.repository.finishOperation(f.task.id, 'old-15-minutes', { status: 'succeeded', result: { expiresAt: '2026-11-13T00:15:00.000Z' } })
    const saved = await f.service.create(f.context)
    expect(saved.scope.browserScheduleActions).toBeUndefined()
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'browser_action_authorization')).toHaveLength(1)
  })
  it.each(['browser_click', 'browser_fill', 'browser_press'])('blocks legacy successful %s before plan approval or publication', async toolName => {
    const f = fixture()
    f.browserTool(toolName)
    const publish = vi.spyOn(f.flows, 'publish')
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toHaveLength(0)
  })
  it('requires an exact continuous review for a dispatched action and then creates its plan idempotently', async () => {
    const f = fixture()
    const dispatch = f.browserDispatch('fill')
    f.browserTool('browser_fill', { request: { argumentsHash: dispatch.request!.argumentsHash }, output: { dispatchReceiptId: dispatch.id } })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    f.approveBrowserAction('fill')
    const publish = vi.spyOn(f.flows, 'publish')
    const saved = await f.service.create(f.context)
    expect(saved.scope.browserScheduleActions).toHaveLength(1)
    expect(await f.service.create(f.context)).toEqual(saved)
    expect(publish).toHaveBeenCalledOnce()
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(f.repository.operations(f.task.id, 'browser_action_dispatch')).toEqual([dispatch])
  })
  it.each(['browser_navigate', 'browser_observe', 'browser_get_html'])('allows a read-only %s history without action descriptors', async toolName => {
    const f = fixture()
    f.browserTool(toolName)
    expect((await f.service.create(f.context)).scope.browserScheduleActions).toBeUndefined()
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it('ignores an explicitly nondispatched browser attempt', async () => {
    const f = fixture()
    f.browserTool('browser_fill', { status: 'failed', output: { status: 'failed', code: 'browser_schedule_action_scope_required' } })
    f.browserTool('browser_click', { status: 'failed', approved: false, request: { dispatchTracking: 'host-v1' }, output: { code: 'operation_not_dispatched' } })
    expect((await f.service.create(f.context)).scope.browserScheduleActions).toBeUndefined()
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it.each(['tool', 'journal'])('blocks an unknown %s outcome even after explicit continuous review', async kind => {
    const f = fixture()
    f.approveBrowserAction('click')
    if (kind === 'tool') f.browserTool('browser_click', { status: 'outcome_unknown' })
    else f.browserDispatch('click', 'outcome_unknown')
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
    expect(f.flows.list()).toHaveLength(0)
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
    expect(f.coordinator.command).not.toHaveBeenCalled()
  })
  it.each(['pageUrl', 'elementHash', 'valueHash', 'browserInstanceId', 'browserRevision'])('rejects a dispatched fill with a different %s', async field => {
    const f = fixture()
    f.approveBrowserAction('fill')
    f.browserDispatch('fill', 'succeeded', { [field]: field === 'browserRevision' ? 2 : 'different' })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it('rejects a tool result linked to a different dispatch request', async () => {
    const f = fixture()
    f.approveBrowserAction('fill')
    const dispatch = f.browserDispatch('fill')
    f.browserTool('browser_fill', { output: { dispatchReceiptId: dispatch.id } })
    await expect(f.service.create(f.context)).rejects.toThrow('执行凭据与原工具请求不匹配')
    expect(f.context.awaitApproval).not.toHaveBeenCalled()
  })
  it.each(['matched', 'missing_observation', 'wrong_request', 'wrong_target'])('migrates a legacy action only with provable %s target evidence', async variant => {
    const f = fixture()
    if (variant !== 'missing_observation') f.browserTool('browser_observe', { output: { sourceUrl: 'https://example.test/search', observation: { context_id: 'context-one' } } })
    const operation = f.browserTool('browser_click', { output: { sourceUrl: 'https://example.test/redirected' } })
    const requestHash = String(operation.request!.approvalRequestHash)
    const summary = browserApprovalSummary({ action: 'click', origin: 'https://example.test',
      targetHtml: variant === 'wrong_target' ? '<button>删除</button>' : browserTargetHtml.click, requestHash })
    f.repository.saveHumanRequest({ id: `appr_${operation.request!.callId}`, kind: 'approval', threadId: f.task.threadId, turnId: 'turn',
      message: summary, payload: { approval: { toolName: 'browser_click', callId: operation.request!.callId,
        requestHash: variant === 'wrong_request' ? digest('wrong') : requestHash, summary } }, status: 'answered', resolution: { decision: 'allow' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    f.approveBrowserAction('click')
    if (variant === 'matched') {
      expect((await f.service.create(f.context)).scope.browserScheduleActions?.[0]?.pageUrl).toBe('https://example.test/search')
      expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    } else {
      await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
      expect(f.context.awaitApproval).not.toHaveBeenCalled()
    }
    expect(f.repository.operation(f.task.id, operation.idempotencyKey)).toEqual(operation)
  })
  it('rechecks browser evidence after plan approval before persisting or publishing', async () => {
    const f = fixture()
    f.approveBrowserAction('click')
    vi.mocked(f.context.awaitApproval).mockImplementation(async () => { f.browserDispatch('click', 'outcome_unknown'); return 'allow' })
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toHaveLength(0)
    expect(f.flows.list()).toHaveLength(0)
  })
  it('blocks recurrence of a previously published plan after an unreviewed browser action', async () => {
    const f = fixture()
    f.browserTool('browser_observe')
    const saved = await f.service.create(f.context)
    const versionId = f.flows.get(saved.id)!.publishedVersionId!
    f.browserDispatch('click')
    await expect(f.service.dispatch({ scheduleId: saved.id, versionId, dueAt: '2026-11-13T00:30:00.000Z' }))
      .rejects.toMatchObject({ code: 'browser_schedule_action_scope_required' })
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.repository.attention(`schedule:${saved.id}`)?.status).toBe('pending')
  })
  it('recovers an approved managed draft after publication fails without another approval or receipt', async () => {
    const f = fixture()
    f.approveBrowserAction('click')
    vi.spyOn(f.flows, 'publish').mockImplementationOnce(() => { throw new Error('Synthetic crash before Flow publication') })
    await expect(f.service.create(f.context)).rejects.toThrow('Synthetic crash')
    expect((await f.service.readback(f.context)).schedules).toHaveLength(0)
    const receipt = f.repository.operations(f.task.id, 'schedule_authority')[0]!
    const recovered = await f.service.create(f.context)
    expect(recovered.enabled).toBe(true)
    expect(f.context.awaitApproval).toHaveBeenCalledOnce()
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toEqual([receipt])
    expect(f.flows.list()).toHaveLength(1)
  })
  it.each(['revoked', 'unknown'])('does not dispatch when recurring browser authorization is %s', async condition => {
    const f = fixture()
    f.approveBrowserAction('click')
    const saved = await f.service.create(f.context)
    if (condition === 'revoked') {
      const approval = f.repository.operations(f.task.id, 'browser_schedule_action_authorization')[0]!
      f.repository.finishOperation(f.task.id, approval.idempotencyKey, { status: 'failed', error: 'Synthetic revoked authorization' })
    } else {
      f.repository.beginOperation({ ownerId: f.task.id, kind: 'browser_schedule_action_outcome', idempotencyKey: 'unknown-action', request: { scheduleId: saved.id }, nowIso: new Date().toISOString() })
      f.repository.finishOperation(f.task.id, 'unknown-action', { status: 'outcome_unknown', error: 'Synthetic unknown result' })
    }
    const versionId = f.flows.get(saved.id)!.publishedVersionId!
    await expect(f.service.dispatch({ scheduleId: saved.id, versionId, dueAt: '2026-11-13T00:30:00.000Z' })).rejects.toThrow()
    expect(f.coordinator.command).not.toHaveBeenCalled()
    expect(f.repository.attention(`schedule:${saved.id}`)?.status).toBe('pending')
  })
})


describe('explicit retry keeps one business Root schedule', () => {
  function retry(f: ReturnType<typeof fixture>) {
    const source = f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision, task => ({ ...task, status: 'failed', activeTurnId: undefined }))
    const request = { expectedRevision: source.revision, idempotencyKey: 'explicit-retry' }
    f.repository.beginOperation({ ownerId: source.id, idempotencyKey: 'explicit-retry', kind: 'retry', request, nowIso: new Date().toISOString() })
    const created = f.repository.create(TaskRunSchema.parse({ ...source, id: 'task-retry', retryOfTaskId: source.id, rootTaskId: source.id, status: 'running', activeTurnId: 'retry-turn', revision: 0 }))
    const child = f.repository.update(created.id, created.revision, task => task, { key: `retry-of:${source.id}`, kind: 'task_retried', payload: { retryOfTaskId: source.id, rootTaskId: source.id }, createdAt: new Date().toISOString() })
    f.repository.finishOperation(source.id, 'explicit-retry', { status: 'succeeded', result: { task: child } }, new Date().toISOString())
    f.selectTask(child.id); f.context.turnId = 'retry-turn'
    f.context.executionGrant = { ...structuredClone(f.context.executionGrant!), id: 'retry-grant', taskId: child.id, turnId: 'retry-turn', idempotencyKey: 'retry-grant' }
    return child
  }
  it('returns an unchanged Root plan, writes only attempt readback, and keeps duplicate saves idempotent', async () => {
    const f = fixture(), saved = await f.service.create(f.context), before = JSON.stringify(f.flows.get(saved.id))
    const rows = f.repository.operations(f.task.id).map(row => JSON.stringify(row)), child = retry(f)
    expect(await f.service.create(f.context)).toEqual(saved)
    expect(await f.service.create(f.context)).toEqual(saved)
    expect(f.service.assessCompletion(child)).not.toBeNull()
    expect((await f.service.readback(f.context)).schedules).toEqual([saved])
    expect(f.service.assessCompletion(f.repository.get(child.id)!)).toBeNull()
    expect(f.repository.operations(child.id, 'schedule_authority')).toHaveLength(0)
    expect(f.repository.operations(child.id, 'schedule_readback')).toHaveLength(1)
    expect(f.flows.list()).toHaveLength(1); expect(JSON.stringify(f.flows.get(saved.id))).toBe(before)
    for (const row of rows) expect(f.repository.operations(f.task.id).map(item => JSON.stringify(item))).toContain(row)
  })
  it('creates a missing plan at the business Root ID while sealing only the current retry Grant', async () => {
    const f = fixture(), child = retry(f), saved = await f.service.create(f.context)
    expect(saved.id).toBe(`schedule_${f.task.id}`)
    expect(saved.sourceTaskId).toBe(child.id)
    const authority = f.flows.get(saved.id)!.variables.taskSchedule as { taskId: string; grant: { taskId: string; id: string } }
    expect(authority).toMatchObject({ taskId: child.id, grant: { taskId: child.id, id: 'retry-grant' } })
    expect(f.repository.operations(f.task.id, 'schedule_authority')).toHaveLength(0)
    expect(f.repository.operations(child.id, 'schedule_authority')).toHaveLength(1)
    expect((await f.service.readback(f.context)).schedules).toEqual([saved])
    expect(f.service.assessCompletion(f.repository.get(child.id)!)).toBeNull()
  })
  it('requires the real saved Flow and current identity before retry safety can classify a local plan receipt', async () => {
    const f = fixture(), saved = await f.service.create(f.context)
    const host = f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: 'local-plan-host', kind: 'tool', request: { providerId: 'task-schedule', toolName: 'schedule_task' }, nowIso: new Date().toISOString() }).receipt
    const success = f.repository.finishOperation(f.task.id, host.idempotencyKey, { status: 'succeeded' })
    expect(await f.service.validateRetryLocalSchedule(f.repository.get(f.task.id)!, success)).toBe(true)
    f.identities['mcp:test'] = 'b'.repeat(64)
    await expect(f.service.validateRetryLocalSchedule(f.repository.get(f.task.id)!, success)).rejects.toMatchObject({ code: 'schedule_authority_changed' })
    f.identities['mcp:test'] = 'a'.repeat(64)
    const current = f.flows.get(saved.id)!
    f.flows.update({ ...current, variables: { ...current.variables, enabled: false } }, current.revision)
    expect(await f.service.validateRetryLocalSchedule(f.repository.get(f.task.id)!, success)).toBe(false)
  })
  it('keeps a proven schedule-duration browser binding on a retry without relabelling the Root binding or its Grant', async () => {
    const f = reboundBrowserFixture(), saved = await f.service.create(f.context), before = JSON.stringify(f.flows.get(saved.id))
    const rows = f.repository.operations(f.task.id).map(row => JSON.stringify(row)), oldGrant = structuredClone(f.context.executionGrant!)
    const child = retry(f)
    expect(await f.service.create(f.context)).toEqual(saved)
    expect((await f.service.readback(f.context)).schedules).toEqual([saved])
    expect(f.service.assessCompletion(f.repository.get(child.id)!)).toBeNull()
    expect(f.context.executionGrant!.taskId).toBe(child.id)
    expect(saved.sourceTaskId).toBe(f.task.id)
    expect(f.repository.operations(child.id, 'browser_binding')).toHaveLength(0)
    expect(JSON.stringify(f.flows.get(saved.id))).toBe(before)
    for (const row of rows) expect(f.repository.operations(f.task.id).map(item => JSON.stringify(item))).toContain(row)
    expect(f.context.executionGrant!.id).not.toBe(oldGrant.id)
  })
  it.each(['scope', 'identity', 'lineage', 'old-grant', 'expired', 'revoked', 'workspace', 'sandbox', 'unknown'] as const)('rejects %s without a new plan or misleading readback', async change => {
    const f = fixture(), saved = await f.service.create(f.context), before = JSON.stringify(f.flows.get(saved.id)), child = retry(f)
    if (change === 'scope') f.context.executionGrant!.networkAllowlist = ['https://different.test']
    if (change === 'identity') f.identities['mcp:test'] = 'b'.repeat(64)
    if (change === 'lineage') f.repository.finishOperation(f.task.id, 'explicit-retry', { status: 'failed' })
    if (change === 'old-grant') f.context.executionGrant!.taskId = f.task.id
    if (change === 'workspace') f.context.executionGrant!.workspaceRoot = '/other'
    if (change === 'sandbox') f.context.executionGrant!.sandboxMode = 'danger-full-access'
    if (change === 'expired') f.context.executionGrant!.expiresAt = '2026-11-12T00:00:00Z'
    if (change === 'revoked') f.repository.update(child.id, child.revision, task => ({ ...task, authority: { source: 'user', workspaceRoot: '/workspace', externalTargets: [], grantedAt: new Date().toISOString(), revokedAt: new Date().toISOString() } }))
    if (change === 'unknown') {
      f.repository.beginOperation({ ownerId: child.id, idempotencyKey: 'unknown', kind: 'browser_action_dispatch', request: {}, nowIso: new Date().toISOString() })
      f.repository.finishOperation(child.id, 'unknown', { status: 'outcome_unknown' })
    }
    await expect(f.service.create(f.context)).rejects.toMatchObject({ code: change === 'unknown' ? 'browser_schedule_outcome_unknown' : 'schedule_authority_changed' })
    await expect(f.service.readback(f.context)).rejects.toMatchObject({ code: change === 'unknown' ? 'browser_schedule_outcome_unknown' : 'schedule_authority_changed' })
    expect(f.repository.operations(child.id, 'schedule_readback')).toHaveLength(0)
    expect(f.flows.list()).toHaveLength(1); expect(JSON.stringify(f.flows.get(saved.id))).toBe(before)
  })
})

describe('persistent schedule attention recovery', () => {
  const dueAt = '2026-11-13T00:30:00.000Z'
  async function blocked() {
    const f = fixture(), saved = await f.service.create(f.context), input = { scheduleId: saved.id, versionId: f.flows.get(saved.id)!.publishedVersionId!, dueAt }
    f.identities['mcp:test'] = 'b'.repeat(64)
    await expect(f.service.dispatch(input)).rejects.toMatchObject({ code: 'schedule_authority_changed' })
    return { ...f, saved, input, attentionId: `schedule:${saved.id}` }
  }
  it('keeps one notification generation while pending, resolves successful recovery, and starts a new generation only after resolution', async () => {
    const f = await blocked(), first = f.repository.attention(f.attentionId)!
    f.repository.update(f.task.id, f.repository.get(f.task.id)!.revision, task => ({ ...task, status: 'paused' }))
    const originalTask = JSON.stringify(f.repository.get(f.task.id))
    vi.setSystemTime(new Date('2026-11-13T00:01:00Z'))
    await expect(f.service.dispatch(f.input)).rejects.toThrow()
    const repeated = f.repository.attention(f.attentionId)!
    expect(repeated.createdAt).toBe(first.createdAt)
    expect(`attention:${repeated.id}:${repeated.createdAt}`).toBe(`attention:${first.id}:${first.createdAt}`)
    expect(repeated.revision).toBe(first.revision + 1)
    expect(repeated.payload).toMatchObject({ ...f.input })
    f.identities['mcp:test'] = 'a'.repeat(64)
    await f.service.dispatch(f.input)
    const answered = f.repository.attention(f.attentionId)!
    expect(answered.status).toBe('answered'); expect(answered.createdAt).toBe(first.createdAt)
    expect(answered.revision).toBe(repeated.revision + 1)
    expect(f.repository.inbox().some(item => item.id === f.attentionId)).toBe(false)
    expect(JSON.stringify(f.repository.get(f.task.id))).toBe(originalTask)
    expect(f.coordinator.command).toHaveBeenCalledTimes(1)
    expect(f.coordinator.command.mock.calls[0]![0]).toMatchObject({ intent: 'new', idempotencyKey: `schedule:${f.saved.id}:${dueAt}` })
    // A second failure in the same millisecond must still have a new notification generation.
    vi.setSystemTime(new Date(first.createdAt))
    f.identities['mcp:test'] = 'b'.repeat(64)
    await expect(f.service.dispatch(f.input)).rejects.toThrow()
    const reopened = f.repository.attention(f.attentionId)!
    expect(reopened.status).toBe('pending'); expect(reopened.createdAt).not.toBe(first.createdAt)
    expect(reopened.revision).toBe(answered.revision + 1)
    expect(f.repository.inbox().filter(item => item.id === f.attentionId)).toHaveLength(1)
  })
  it.each(['different-due', 'new-version', 'disabled', 'other-owner', 'newer-failure'] as const)('does not resolve %s that supersedes an in-flight dispatch', async change => {
    const f = await blocked()
    f.identities['mcp:test'] = 'a'.repeat(64)
    let reached!: () => void, finish!: () => void
    const started = new Promise<void>(resolve => { reached = resolve }), barrier = new Promise<void>(resolve => { finish = resolve })
    f.coordinator.command.mockImplementationOnce(async () => { reached(); await barrier; return { kind: 'task_started' } })
    const dispatch = f.service.dispatch(f.input)
    await started
    if (change === 'new-version' || change === 'disabled') {
      const flow = f.flows.get(f.saved.id)!
      f.flows.update({ ...flow, ...(change === 'new-version' ? { name: '同一业务的新计划版本' } : {}), variables: { ...flow.variables, ...(change === 'disabled' ? { enabled: false } : {}) } }, flow.revision)
      if (change === 'new-version') expect(f.flows.publish(flow.id).published).toBe(true)
    } else {
      const pending = f.repository.attention(f.attentionId)!
      f.repository.putAttention({ ...pending, revision: pending.revision + 1,
        ...(change === 'other-owner' ? { ownerId: 'another-flow', flowId: 'another-flow' } : {}),
        payload: { ...pending.payload, ...(change === 'different-due' ? { dueAt: '2026-11-13T08:30:00.000Z' } : {}) } })
    }
    const before = JSON.stringify(f.repository.attention(f.attentionId))
    finish(); await dispatch
    expect(JSON.stringify(f.repository.attention(f.attentionId))).toBe(before)
    expect(f.repository.attention(f.attentionId)!.status).toBe('pending')
  })
  it.each([true, false])('resolves a legacy versionless pending item only when the original durable outbox proves the version (outbox=%s)', async durable => {
    const f = fixture(), saved = await f.service.create(f.context), versionId = f.flows.get(saved.id)!.publishedVersionId!, input = { scheduleId: saved.id, versionId, dueAt }
    f.identities['mcp:test'] = 'b'.repeat(64)
    if (durable) await f.flows.tickSchedules(new Date(dueAt))
    else await expect(f.service.dispatch(input)).rejects.toThrow()
    const attentionId = `schedule:${saved.id}`, pending = f.repository.attention(attentionId)!
    const { versionId: _version, ...legacyPayload } = pending.payload!
    f.repository.putAttention({ ...pending, payload: legacyPayload })
    f.identities['mcp:test'] = 'a'.repeat(64)
    if (durable) await f.flows.flushSourceEvents()
    else await f.service.dispatch(input)
    expect(f.repository.attention(attentionId)!.status).toBe(durable ? 'answered' : 'pending')
  })
  it('does not mark a blocked coordinator result as successful recovery', async () => {
    const f = await blocked()
    f.identities['mcp:test'] = 'a'.repeat(64)
    f.coordinator.command.mockResolvedValueOnce({ kind: 'capability_required' })
    const before = JSON.stringify(f.repository.attention(f.attentionId))
    await f.service.dispatch(f.input)
    expect(JSON.stringify(f.repository.attention(f.attentionId))).toBe(before)
  })
})

it.each(['observed_feed', undefined] as const)('seals the original evidence basis into a schedule occurrence without re-inferring legacy goals: %s', async basis => {
  const f = fixture(), current = f.repository.get(f.task.id)!
  f.repository.update(current.id, current.revision, task => ({ ...task, goal: '汇总已订阅招标列表 https://example.test/list，每天9点生成HTML。',
    acceptance: { ...task.acceptance, requiresWebEvidence: true, ...(basis ? { webEvidenceBasis: basis } : {}) } }))
  const saved = await f.service.create(f.context), flow = f.flows.get(saved.id)!
  expect((flow.variables.taskSchedule as { webEvidenceBasis?: string }).webEvidenceBasis).toBe(basis)
  await f.service.dispatch({ scheduleId: saved.id, versionId: flow.publishedVersionId!, dueAt: '2026-11-13T00:30:00.000Z' })
  const hooks = f.coordinator.command.mock.calls[0]![1] as { prepareTask(task: typeof current): void }
  const child = f.repository.create({ ...f.repository.get(current.id)!, id: 'feed-occurrence', threadId: 'occurrence', revision: 0,
    acceptance: { ...current.acceptance, requiresWebEvidence: true, webEvidenceBasis: 'observed_feed' } })
  hooks.prepareTask(child)
  expect(f.repository.get(child.id)!.acceptance.webEvidenceBasis).toBe(basis)
  expect(f.repository.get(child.id)!.scheduledBy?.scheduleId).toBe(saved.id)
})

it('derives the same Ego backend and evidence basis for a daily occurrence without consulting BSK identity', async () => {
  const f = fixture(), grant = f.context.executionGrant!
  const scope = { provider: 'ego-browser' as const, browserInstanceId: 'ego-browser:'+f.ego.executableHash, origins: ['https://example.test'], interaction: 'observe' as const, revision: f.ego.revision }
  grant.browserScope = scope
  grant.allowedProviderIds = ['ego-browser', 'managed-artifacts', 'task-schedule']
  grant.allowedToolNames = ['ego_browser_open', 'ego_browser_observe', 'ego_browser_read', 'ego_browser_next_page', 'publish_artifact', 'read_artifact', 'verify_web_artifact', 'schedule_task', 'list_schedules']
  grant.connectorIdentityFingerprints!['ego-browser'] = operationFingerprint(f.ego)
  f.identities['ego-browser'] = operationFingerprint(f.ego)
  const current = f.repository.get(f.task.id)!
  f.repository.update(current.id, current.revision, task => ({ ...task, goal: '使用Ego读取已订阅列表 https://example.test，每日汇总HTML。',
    acceptance: { ...task.acceptance, requiresWebEvidence: true, webEvidenceBasis: 'observed_feed' },
    authority: { source: 'user', workspaceRoot: '/workspace', externalTargets: [], grantedAt: new Date().toISOString(), browserScope: scope } }))
  const saved = await f.service.create(f.context), flow = f.flows.get(saved.id)!
  await f.service.dispatch({ scheduleId: saved.id, versionId: flow.publishedVersionId!, dueAt: '2026-11-13T00:30:00.000Z' })
  const hooks = f.coordinator.command.mock.calls[0]![1] as { prepareExecutionThread(thread: unknown): Promise<void>; prepareTask(task: typeof current): void }
  const occurrence = { ...f.threads.get('origin')!, id: 'ego-occurrence', turns: [] };f.threads.set(occurrence.id, occurrence)
  await hooks.prepareExecutionThread(occurrence)
  f.browser.browserInstanceId = 'unrelated-changed-BSK'
  const derived = await f.service.executionScopeForThread(occurrence.id)
  expect(derived?.browserScope).toEqual(scope)
  expect(derived?.allowedProviderIds).toContain('ego-browser')
  expect(derived?.allowedProviderIds).not.toContain('browser-skill')
  expect(derived?.connectorIdentityFingerprints?.['ego-browser']).toBe(operationFingerprint(f.ego))
  const child = f.repository.create({ ...f.repository.get(current.id)!, id: 'ego-due-task', threadId: occurrence.id, revision: 0 })
  hooks.prepareTask(child)
  expect(f.repository.get(child.id)!.acceptance.webEvidenceBasis).toBe('observed_feed')
  f.ego.revision++
  await expect(f.service.executionScopeForThread(occurrence.id)).rejects.toMatchObject({ code: 'schedule_authority_changed' })
})
