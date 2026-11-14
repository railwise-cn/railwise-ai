import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserCapabilityConfig, BrowserExecutionScope, isPublicBrowserQuery } from '../contracts/browser-skill.js'
import { TaskRunSchema } from '../contracts/tasks.js'
import type { ThreadRecord } from '../contracts/threads.js'
import { TaskRunRepository, operationFingerprint } from './task-run-repository.js'
import { ManagedBrowserSkillRuntime } from './managed-browser-skill-runtime.js'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))
function fixture(versions: { cli?: string; daemon?: string; extension?: string; liveDaemon?: string; liveExtension?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'browser-binding-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
  cleanups.push(() => { repository.close(); rmSync(root, { recursive: true, force: true }) })
  const daemonProtocol = versions.daemon ?? '1.9', extensionProtocol = versions.extension ?? '1.9'
  const config = BrowserCapabilityConfig.parse({ enabled: true, state: 'ready', version: versions.cli ?? '0.5.0', daemonProtocolVersion: daemonProtocol,
    browserInstanceId: 'browser-new', revision: 3, origins: ['https://example.com', 'https://new.example'], interaction: 'interact',
    browsers: [{ id: 'browser-new', name: 'Chrome', label: 'Test', extensionVersion: '0.5.0', protocolVersion: extensionProtocol, connected: true, versionSkew: false }] })
  const old = { browserInstanceId: 'browser-old', revision: 1, origins: ['https://example.com'], interaction: 'observe' as const }
  repository.create(TaskRunSchema.parse({ id: 'task', threadId: 'thread', childTaskIds: [], workspaceRoot: root, goal: '浏览器 https://example.com', status: 'waiting_user', agentId: 'default', acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false }, budget: { maxAttempts: 3, maxDurationMs: 600000 }, attempts: 0, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), authority: { source: 'user', workspaceRoot: root, grantedAt: new Date().toISOString(), browserScope: old } }))
  const runtime = new ManagedBrowserSkillRuntime({ config, configPath: join(root, 'config.json'), dataDir: root, repository, run: async () => ({ ok: true, output: {
    protocol_version: versions.liveDaemon ?? daemonProtocol, pid: 7, browsers: [{ instance_id: 'browser-new', browser_name: 'Chrome', label: 'Test', extension_version: '0.5.0', extension_protocol_version: versions.liveExtension ?? extensionProtocol }] } }), apply: () => undefined })
  return { runtime, repository, old, config }
}
describe('Browser task authority rebinding', () => {
  const literalRequest = '使用broswer-skill，帮我去政采云、阳光采购平台等平台去获取一些招标信息，我们主要是做工程测量、工程监测类的业务，所以需要找的是这一类招标信息，并以html形式将获取到的信息给我汇报，每天执行两次，早上九点前一次，下午五点前一次。'

  it.each([{ cli: '0.4.0' }, { daemon: '1.7' }, { extension: '1.7' }, { daemon: '1.8' }, { extension: '1.8' }, { cli: '' }, { daemon: '' }, { extension: '' }])('keeps strict bindings available but never offers target interaction for incompatible dependencies %j', versions => {
    const f = fixture(versions)
    f.repository.update('task', 0, task => ({ ...task, goal: literalRequest, authority: undefined }))
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot).toMatchObject({ verificationPolicy: 'strict', recommendedVerificationPolicy: 'strict', allowedVerificationPolicies: ['strict'] })
    expect(snapshot.allowedPublicQueryAuthorizations).toEqual([])
    expect(() => f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
      interaction: 'interact', verificationPolicy: 'strict', publicQueryAuthorization: 'task', idempotencyKey: 'unsupported-native-dom-scope' })).toThrow('browser_public_query_authorization_blocked')
    expect(() => f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
      verificationPolicy: 'public_query_target', idempotencyKey: 'unsupported-target' })).toThrow('browser_verification_policy_blocked')
    expect(f.repository.get('task')!.authority).toBeUndefined()
    expect(f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
      verificationPolicy: 'strict', idempotencyKey: 'explicit-strict' })).toMatchObject({ resumed: false, binding: { verificationPolicy: 'strict' } })
  })

  it('allows explicit target interaction and task consent at the native-read 0.5.0 / protocol 1.9 boundary', () => {
    const f = fixture({ cli: '0.5.0', daemon: '1.9', extension: '1.9' })
    f.repository.update('task', 0, task => ({ ...task, goal: literalRequest, authority: undefined }))
    expect(f.runtime.bindingSnapshot('task')).toMatchObject({ verificationPolicy: 'strict', recommendedVerificationPolicy: 'public_query_target',
      allowedVerificationPolicies: ['strict', 'public_query_target'], allowedPublicQueryAuthorizations: ['task'] })
    expect(f.repository.get('task')!.authority).toBeUndefined()
    expect(f.repository.get('task')!.attempts).toBe(0)
  })

  it.each([{ cli: '0.4.0' }, { daemon: '1.7' }, { extension: '1.7' }, { daemon: '1.8' }, { extension: '1.8' }])('routes a new public-query request to a real capability upgrade instead of offering unusable consent %j', async versions => {
    const f = fixture(versions)
    const before = JSON.stringify(f.repository.get('task'))
    expect(await f.runtime.preflight(literalRequest)).toMatchObject({ status: 'blocked', errorCode: 'browser_target_policy_upgrade_required',
      resolution: { kind: 'install', route: 'marketplace' } })
    expect(JSON.stringify(f.repository.get('task'))).toBe(before)
    expect(f.repository.operations('task', 'browser_binding')).toHaveLength(0)
  })

  it.each([{ cli: '0.4.0' }, { liveDaemon: '1.7' }, { liveExtension: '1.7' }, { liveDaemon: '1.8' }, { liveExtension: '1.8' }].flatMap(versions => [
    { ...versions, taskScope: false }, { ...versions, taskScope: true }
  ]))('blocks an existing native-DOM scope before a Turn using live dependency state %j', async versions => {
    const f = fixture(versions)
    f.repository.update('task', 0, task => ({ ...task, goal: literalRequest, status: 'paused', authority: { ...task.authority!, browserScope: {
      ...f.old, browserInstanceId: f.config.browserInstanceId!, revision: f.config.revision, interaction: 'interact', verificationPolicy: versions.taskScope ? 'strict' : 'public_query_target',
      ...(versions.taskScope ? { publicQueryAuthorization: { receiptId: 'historical-scope-reference', duration: 'task' as const, purposeHash: operationFingerprint({ purpose: literalRequest }) } } : {})
    } } }))
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: 'preserve-unknown', kind: 'browser_action_dispatch', request: { sessionId: 'original-session' }, nowIso: new Date().toISOString() })
    f.repository.finishOperation('task', 'preserve-unknown', { status: 'outcome_unknown' })
    const before = JSON.stringify(f.repository.get('task'))
    const blocked = await f.runtime.preflight('继续', { id: 'thread', mode: 'agent' } as ThreadRecord)
    expect(blocked).toMatchObject({ status: 'blocked', errorCode: 'browser_target_policy_upgrade_required',
      resolution: { kind: 'install', route: 'marketplace', label: expect.stringContaining('重新连接扩展') } })
    expect(JSON.stringify(f.repository.get('task'))).toBe(before)
    expect(f.repository.operation('task', 'preserve-unknown')).toMatchObject({ status: 'outcome_unknown' })
  })

  it('does not silently downgrade an existing target binding when the installed CLI is legacy', () => {
    const f = fixture({ cli: '0.4.0', daemon: '1.7', extension: '1.7' })
    f.repository.update('task', 0, task => ({ ...task, goal: literalRequest, authority: { ...task.authority!, browserScope: {
      ...f.old, browserInstanceId: f.config.browserInstanceId!, revision: f.config.revision, verificationPolicy: 'public_query_target'
    } } }))
    const before = JSON.stringify(f.repository.get('task'))
    expect(() => f.runtime.bindingSnapshot('task')).toThrow('browser_target_policy_upgrade_required')
    expect(JSON.stringify(f.repository.get('task'))).toBe(before)
  })

  it('continues an explicitly strict legacy task without requiring target-policy support', async () => {
    const f = fixture({ cli: '0.4.0', daemon: '1.7', extension: '1.7' })
    const snapshot = f.runtime.bindingSnapshot('task')
    f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
      browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, idempotencyKey: 'retain-legacy-strict' })
    expect(await f.runtime.preflight('继续', { id: 'thread', mode: 'agent' } as ThreadRecord)).toMatchObject({ status: 'available' })
    expect(f.repository.get('task')?.authority?.browserScope).not.toHaveProperty('verificationPolicy')
  })

  it('keeps an existing observe-only target binding readable at protocol 1.8 without granting native-query interaction', async () => {
    const f = fixture({ cli: '0.5.0', daemon: '1.8', extension: '1.8' })
    f.repository.update('task', 0, task => ({ ...task, status: 'paused', authority: { ...task.authority!, browserScope: {
      ...f.old, browserInstanceId: f.config.browserInstanceId!, revision: f.config.revision, verificationPolicy: 'public_query_target'
    } } }))
    const before = JSON.stringify(f.repository.get('task'))
    expect(await f.runtime.preflight('继续读取', { id: 'thread', mode: 'agent' } as ThreadRecord)).toMatchObject({ status: 'available' })
    expect(JSON.stringify(f.repository.get('task'))).toBe(before)
  })

  it('requires explicit policy review for the literal URL-free public procurement request', async () => {
    const f = fixture()
    expect(isPublicBrowserQuery(literalRequest)).toBe(true)
    expect(await f.runtime.preflight(literalRequest)).toMatchObject({ status: 'needs_authorization', errorCode: 'browser_verification_policy_required', resolution: { route: 'task/browser-binding' } })
    f.repository.update('task', 0, task => ({ ...task, goal: literalRequest, status: 'paused', authority: undefined,
      acceptance: { ...task.acceptance, requiresWebEvidence: true, requiredSourceOrigins: [] } }))
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot).toMatchObject({ verificationPolicy: 'strict', recommendedVerificationPolicy: 'public_query_target',
      allowedVerificationPolicies: ['strict', 'public_query_target'], purpose: literalRequest, origins: f.config.origins })
    expect(f.repository.get('task')!.authority?.browserScope).toBeUndefined()
    const result = f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
      interaction: 'interact', verificationPolicy: 'public_query_target', idempotencyKey: 'explicit-public-policy' })
    expect(result).toMatchObject({ resumed: false, binding: { verificationPolicy: 'public_query_target' } })
    const task = f.repository.get('task')!
    expect(task.status).toBe('paused')
    expect(task.attempts).toBe(0)
    expect(task.acceptance.requiredSourceOrigins).toEqual(f.config.origins)
    expect(f.runtime.scope(literalRequest, task.authority!.browserScope).browserScope).toEqual(task.authority!.browserScope)
    expect((await f.runtime.preflight(literalRequest, { id: 'thread', mode: 'agent' } as ThreadRecord))?.status).toBe('available')
  })

  it('keeps legacy policy bytes unchanged and treats explicit account work as strict', () => {
    const f = fixture()
    expect(Object.hasOwn(BrowserExecutionScope.parse(f.old), 'verificationPolicy')).toBe(false)
    expect(isPublicBrowserQuery('使用browser-skill搜索公开信息，无需账号，不提交到外部服务')).toBe(true)
    expect(isPublicBrowserQuery('使用browser-skill公开查询，明确申请这两个动作的周期计划范围授权')).toBe(true)
    for (const request of ['使用browser-skill查询后转交待办', '使用browser-skill查询后提交申请', '使用browser-skill查询并修改个人资料']) expect(isPublicBrowserQuery(request)).toBe(false)
    for (const goal of ['使用browser-skill登录账号查询资料', '使用browser-skill输入密码', '使用browser-skill查询并审批付款', '使用browser-skill搜索后发送消息']) {
      expect(isPublicBrowserQuery(goal)).toBe(false)
    }
  })

  it.each(['outcome_unknown', 'readback_pending', 'session_unknown'] as const)('preserves the original policy and review surface while %s is unresolved', state => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, goal: literalRequest, authority: { ...task.authority!, browserScope: {
      browserInstanceId: 'browser-new', revision: 3, origins: ['https://example.com'], interaction: 'interact'
    } } }))
    const request = { sessionId: 'session', action: 'fill' }
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: 'unresolved', kind: state === 'session_unknown' ? 'browser_session' : 'browser_action_dispatch', request, nowIso: new Date().toISOString() })
    f.repository.finishOperation('task', 'unresolved', { status: state === 'readback_pending' ? 'succeeded' : 'outcome_unknown',
      ...(state === 'readback_pending' ? { result: { actionAcknowledged: true, readbackPending: true } } : {}) })
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot).toMatchObject({ allowedVerificationPolicies: ['strict'], policyChangeBlocked: 'browser_unresolved_operation' })
    const before = JSON.stringify(f.repository.get('task')!.authority)
    expect(() => f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
      interaction: 'interact', verificationPolicy: 'public_query_target', idempotencyKey: 'cannot-change-unknown' })).toThrow('browser_unresolved_operation')
    expect(JSON.stringify(f.repository.get('task')!.authority)).toBe(before)
  })

  it('keeps a child policy within the explicitly reviewed parent ceiling', () => {
    const f = fixture()
    const task = f.repository.get('task')!
    const scope = { ...f.old, browserInstanceId: 'browser-new', revision: 3, interaction: 'interact' as const }
    f.repository.create({ ...task, id: 'parent', threadId: 'parent-thread', authority: { ...task.authority!, browserScope: scope } })
    f.repository.update('task', 0, child => ({ ...child, goal: literalRequest, parentTaskId: 'parent', authority: { ...child.authority!, browserScope: scope } }))
    expect(f.runtime.bindingSnapshot('task').allowedVerificationPolicies).toEqual(['strict'])
    f.repository.update('parent', 0, parent => ({ ...parent, authority: { ...parent.authority!, browserScope: { ...scope, verificationPolicy: 'public_query_target' } } }))
    expect(f.runtime.bindingSnapshot('task').allowedVerificationPolicies).toEqual(['strict', 'public_query_target'])
  })

  it.each(['browser-skill', 'broswer-skill', 'browse skill'])('preflights the requested %s capability before a model Turn', async spelling => {
    const f = fixture()
    expect(await f.runtime.preflight(`使用${spelling}，帮我读取 https://example.com`)).toMatchObject({ status: 'available', toolId: 'browser-skill' })
    expect(await f.runtime.preflight(`如何使用${spelling}`)).toBeNull()
  })
  it('accepts the real General wildcard and blocks a changed browser pending explicit task confirmation', async () => {
    const f = fixture()
    const thread = { id: 'thread', mode: 'agent', agentProfile: { toolAllowlist: ['*'] } } as ThreadRecord
    expect(await f.runtime.preflight('继续', thread)).toMatchObject({ errorCode: 'browser_binding_changed', status: 'needs_authorization',
      workspaceRoot: f.repository.get('task')!.workspaceRoot })
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot.origins).toEqual(['https://example.com'])
    const input = { confirmed: true as const, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, idempotencyKey: 'explicit-browser-review' }
    expect(f.runtime.confirmBinding('task', input).resumed).toBe(false)
    expect(f.runtime.confirmBinding('task', input).resumed).toBe(false)
    expect(f.repository.get('task')?.status).toBe('waiting_user')
    expect(f.repository.get('task')?.authority?.browserScope).toEqual({ browserInstanceId: 'browser-new', revision: 3, origins: ['https://example.com'], interaction: 'observe' })
    expect((await f.runtime.preflight('浏览器 https://example.com', thread))?.status).toBe('available')
  })
  it('uses the initiating workspace before a browser task has been created', async () => {
    const f = fixture()
    const thread = { id: 'new-thread', workspace: '/workspace/selected-project', mode: 'agent', agentProfile: { toolAllowlist: ['*'] } } as ThreadRecord
    expect(await f.runtime.preflight('使用browser-skill读取 https://example.com', thread)).toMatchObject({ status: 'available', workspaceRoot: thread.workspace })
  })
  it('requires explicit binding for an existing unbound waiting task after the browser is configured', async () => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, authority: undefined }))
    const thread = { id: 'thread', workspace: '/different-chat-workspace', mode: 'agent', agentProfile: { toolAllowlist: ['*'] } } as ThreadRecord
    expect(await f.runtime.preflight('使用browser-skill读取 https://example.com', thread)).toMatchObject({
      status: 'needs_authorization', errorCode: 'browser_task_scope_required', workspaceRoot: f.repository.get('task')!.workspaceRoot,
      resolution: { kind: 'grant', route: 'task/browser-binding' }
    })
    expect(f.repository.get('task')!.authority?.browserScope).toBeUndefined()
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot).toMatchObject({ origins: ['https://example.com'], previousBrowserInstanceId: undefined })
    expect(f.runtime.confirmBinding('task', { browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, idempotencyKey: 'first-reviewed-binding' }).resumed).toBe(false)
    expect(f.repository.get('task')!.status).toBe('waiting_user')
    expect((await f.runtime.preflight('继续', thread))?.status).toBe('available')
  })
  it('never widens inherited origins from changed global config, prompt or network defaults', () => {
    const f = fixture()
    expect(f.runtime.scope('浏览器 https://new.example', f.old, ['*', 'https://other.example']).browserScope).toEqual(f.old)
  })
  it('offers configured sites for explicit first binding when an unbound task did not name a URL', () => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, goal: '用browser-skill查询公开采购公告', authority: undefined }))
    expect(f.runtime.bindingSnapshot('task').origins).toEqual(f.config.origins)
    expect(f.repository.get('task')!.authority?.browserScope).toBeUndefined()
  })
  it('rejects stale reviewed revisions and active tasks without changing authority', () => {
    const f = fixture()
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(() => f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: 99, expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, idempotencyKey: 'stale' })).toThrow('browser_binding_changed')
    f.repository.update('task', 0, task => ({ ...task, status: 'running' }))
    expect(() => f.runtime.bindingSnapshot('task')).toThrow('browser_task_not_waiting')
    expect(f.repository.get('task')?.authority?.browserScope).toEqual(f.old)
  })
  it('widens a root task interaction only after explicit reviewed confirmation and preserves origins', () => {
    const f = fixture()
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot).toMatchObject({ interaction: 'interact', previousInteraction: 'observe' })
    expect(f.repository.get('task')?.authority?.browserScope).toEqual(f.old)
    const input = { confirmed: true as const, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
      browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: 'interact' as const, idempotencyKey: 'widen-review' }
    expect(f.runtime.confirmBinding('task', input).binding.interaction).toBe('interact')
    expect(f.runtime.confirmBinding('task', input).binding.interaction).toBe('interact')
    expect(f.repository.get('task')?.authority?.browserScope).toMatchObject({ interaction: 'interact', origins: f.old.origins })
    expect(f.repository.get('task')?.status).toBe('waiting_user')
    expect(() => f.runtime.confirmBinding('task', { ...input, interaction: 'observe' })).toThrow()
  })
  it('keeps a child within its current parent browser authority', () => {
    const f = fixture()
    const original = f.repository.get('task')!
    f.repository.create({ ...original, id: 'parent', threadId: 'parent-thread', authority: { ...original.authority!, browserScope: {
      ...f.old, browserInstanceId: 'browser-new', revision: 3
    } } })
    f.repository.update('task', 0, task => ({ ...task, parentTaskId: 'parent' }))
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot.interaction).toBe('observe')
    expect(() => f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
      interaction: 'interact', idempotencyKey: 'child-widen' })).toThrow('browser_interaction_scope_required')
    expect(f.repository.get('task')?.authority?.browserScope).toEqual(f.old)
  })
  it('does not rebind a paused task held by another live Runtime lease', () => {
    const f = fixture()
    f.repository.acquireLease('task', 'other-runtime', new Date().toISOString(), new Date(Date.now() + 60000).toISOString())
    expect(() => f.runtime.bindingSnapshot('task')).toThrow('browser_task_not_waiting')
  })
  it('limits first binding of a child without a URL to the parent and current configuration intersection', () => {
    const f = fixture()
    const original = f.repository.get('task')!
    f.repository.create({ ...original, id: 'parent', threadId: 'parent-thread', authority: { ...original.authority!, browserScope: {
      ...f.old, browserInstanceId: 'browser-new', revision: 3
    } } })
    f.repository.update('task', 0, task => ({ ...task, parentTaskId: 'parent', goal: '用browser-skill查询公开采购公告', authority: undefined }))
    expect(f.runtime.bindingSnapshot('task')).toMatchObject({ origins: ['https://example.com'], interaction: 'observe' })
    expect(f.repository.get('task')!.authority?.browserScope).toBeUndefined()
    f.repository.update('parent', 0, task => ({ ...task, authority: { ...task.authority!, revokedAt: new Date().toISOString() } }))
    expect(() => f.runtime.bindingSnapshot('task')).toThrow('browser_parent_scope_blocked')
  })

  function publicTask(f: ReturnType<typeof fixture>, scheduled = false) {
    return f.repository.update('task', 0, task => ({ ...task, goal: literalRequest, status: 'paused', authority: undefined,
      acceptance: { ...task.acceptance, ...(scheduled ? { schedule: { kind: 'daily' as const, times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 } } : {}) } }))
  }
  function confirmInput(f: ReturnType<typeof fixture>, key = 'public-scope') {
    const snapshot = f.runtime.bindingSnapshot('task')
    return { confirmed: true as const, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
      browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: 'interact' as const,
      verificationPolicy: 'public_query_target' as const, idempotencyKey: key }
  }

  it('does not turn a verification policy or an omitted consent field into public query permission', () => {
    const f = fixture(); publicTask(f)
    const result = f.runtime.confirmBinding('task', confirmInput(f))
    expect(result.binding.publicQueryAuthorization).toBeUndefined()
    const scope = f.repository.get('task')!.authority!.browserScope!
    expect(scope).not.toHaveProperty('publicQueryAuthorization')
    expect(BrowserExecutionScope.parse(f.old)).toEqual(f.old)
    expect(f.runtime.scope(literalRequest, scope).browserScope).toEqual(scope)
  })

  it('persists checkbox-backed task authority in the actual binding receipt without resuming or mutating the inherited scope', () => {
    const f = fixture(); publicTask(f)
    const input = { ...confirmInput(f), publicQueryAuthorization: 'task' as const }
    const result = f.runtime.confirmBinding('task', input)
    const receipt = f.repository.operation('task', 'browser-binding:public-scope')!
    const task = f.repository.get('task')!, authorization = task.authority!.browserScope!.publicQueryAuthorization!
    expect(authorization).toEqual({ receiptId: receipt.id, purposeHash: operationFingerprint({ purpose: task.goal }), duration: 'task' })
    expect(receipt).toMatchObject({ kind: 'browser_binding', status: 'succeeded', request: input, result: { taskId: task.id, purpose: task.goal, publicQueryAuthorization: authorization } })
    expect(result).toMatchObject({ resumed: false, binding: { publicQueryAuthorization: authorization } })
    expect(task).toMatchObject({ status: 'paused', attempts: 0 })
    expect(f.runtime.confirmBinding('task', input)).toEqual(result)
    expect(f.repository.operations('task', 'browser_binding')).toHaveLength(1)
    expect(() => f.runtime.confirmBinding('task', { ...input, publicQueryAuthorization: 'schedule' })).toThrow('key is bound')
    const inherited = f.runtime.scope(literalRequest, task.authority!.browserScope).browserScope!
    expect(inherited).toEqual(task.authority!.browserScope)
    inherited.publicQueryAuthorization!.purposeHash = 'f'.repeat(64)
    expect(task.authority!.browserScope!.publicQueryAuthorization!.purposeHash).toBe(authorization.purposeHash)
  })

  it('offers and binds persistent schedule consent only with exact daily purpose, requirement and displayed start times', () => {
    const f = fixture(); publicTask(f, true)
    expect(f.runtime.bindingSnapshot('task')).toMatchObject({ allowedPublicQueryAuthorizations: ['task', 'schedule'], scheduleReview: {
      times: ['09:00', '17:00'], startTimes: ['08:30', '16:30'], timezone: 'Asia/Shanghai', leadMinutes: 30
    } })
    const result = f.runtime.confirmBinding('task', { ...confirmInput(f), publicQueryAuthorization: 'schedule' })
    expect(result.binding.publicQueryAuthorization).toMatchObject({ duration: 'schedule',
      purposeHash: operationFingerprint({ purpose: literalRequest }),
      requirementHash: operationFingerprint({ requirement: f.repository.get('task')!.acceptance.schedule }) })
    expect(f.repository.get('task')).toMatchObject({ status: 'paused', attempts: 0 })
  })

  it.each(['missing-schedule', 'business', 'read-only', 'child', 'scheduled-occurrence'] as const)('rejects a new public scope beyond the actual %s ceiling with no receipt or revision change', condition => {
    const f = fixture(); publicTask(f)
    if (condition === 'business') f.repository.update('task', 1, task => ({ ...task, goal: '浏览器登录账号并发送消息' }))
    if (condition === 'child') {
      const task = f.repository.get('task')!
      f.repository.create({ ...task, id: 'parent', threadId: 'parent-thread', authority: { source: 'user', workspaceRoot: task.workspaceRoot, externalTargets: [], grantedAt: task.createdAt,
        browserScope: { browserInstanceId: 'browser-new', revision: 3, origins: ['https://example.com'], interaction: 'interact', verificationPolicy: 'public_query_target' } } })
      f.repository.update('task', 1, task => ({ ...task, parentTaskId: 'parent' }))
    }
    if (condition === 'scheduled-occurrence') f.repository.update('task', 1, task => ({ ...task, scheduledBy: { scheduleId: 'existing', dueAt: new Date().toISOString() } }))
    const input = confirmInput(f), before = JSON.stringify(f.repository.get('task'))
    expect(() => f.runtime.confirmBinding('task', { ...input, verificationPolicy: condition === 'business' ? 'strict' : input.verificationPolicy,
      interaction: condition === 'read-only' ? 'observe' : 'interact', publicQueryAuthorization: condition === 'missing-schedule' ? 'schedule' : 'task' })).toThrow('browser_public_query_authorization_blocked')
    expect(JSON.stringify(f.repository.get('task'))).toBe(before)
    expect(f.repository.operations('task', 'browser_binding')).toHaveLength(0)
  })

  it.each(['prepared', 'running', 'outcome_unknown', 'readbackPending'] as const)('cannot grant broader task scope while %s evidence is unresolved', status => {
    const f = fixture(); publicTask(f)
    f.runtime.confirmBinding('task', confirmInput(f, 'old-policy'))
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: 'pending-action', kind: 'browser_action_dispatch', request: { sessionId: 'session' }, nowIso: new Date().toISOString() })
    if (status !== 'prepared') f.repository.finishOperation('task', 'pending-action', { status: status === 'readbackPending' ? 'succeeded' : status,
      ...(status === 'readbackPending' ? { result: { actionAcknowledged: true, readbackPending: true } } : {}) })
    expect(f.runtime.bindingSnapshot('task').allowedPublicQueryAuthorizations).toEqual([])
    const input = confirmInput(f), before = JSON.stringify(f.repository.get('task'))
    expect(() => f.runtime.confirmBinding('task', { ...input, publicQueryAuthorization: 'task' })).toThrow('browser_unresolved_operation')
    expect(JSON.stringify(f.repository.get('task'))).toBe(before)
    expect(f.repository.operations('task', 'browser_binding')).toHaveLength(1)
  })

  it('only retains the same parent public authority reference and never offers a child an expanded grant', () => {
    const f = fixture(); publicTask(f)
    f.runtime.confirmBinding('task', { ...confirmInput(f), publicQueryAuthorization: 'task' })
    const parent = f.repository.get('task')!
    f.repository.create({ ...parent, id: 'child', threadId: 'child-thread', parentTaskId: parent.id, revision: 0, authority: { ...parent.authority!, source: 'inherited',
      browserScope: { ...parent.authority!.browserScope!, origins: ['https://example.com'] } } })
    const snapshot = f.runtime.bindingSnapshot('child')
    expect(snapshot.allowedPublicQueryAuthorizations).toEqual([])
    const input = { confirmed: true as const, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
      browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: 'interact' as const, verificationPolicy: 'public_query_target' as const, idempotencyKey: 'child-confirm' }
    expect(f.runtime.confirmBinding('child', input).binding.publicQueryAuthorization).toEqual(parent.authority!.browserScope!.publicQueryAuthorization)
    f.repository.update('child', 1, child => ({ ...child, goal: '浏览器搜索其他公开资料' }))
    expect(() => f.runtime.confirmBinding('child', { ...input, expectedTaskRevision: 2, idempotencyKey: 'changed-purpose' })).toThrow('browser_parent_scope_blocked')
  })

})
