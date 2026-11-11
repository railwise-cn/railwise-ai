import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { TaskRunRepository, operationFingerprint } from './task-run-repository.js'
import { TaskController } from './task-controller.js'
import { ExternalOperationVerificationService } from './external-operation-verification.js'
import { RequiredEffectSchema } from '../contracts/tasks.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { LarkCapabilityConfig } from '../contracts/capabilities.js'
import { DingTalkCapabilityConfig } from '../contracts/dingtalk.js'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { buildLarkCliToolProvider } from '../adapters/tool/lark-cli-tool-provider.js'
import { buildDingTalkToolProvider } from '../adapters/tool/dingtalk-tool-provider.js'
import { verifiedEffectReceipts } from './external-effect-evidence.js'
import { larkTestBinding, withLarkTestIdentity } from '../../tests/helpers/lark-identity.js'

const stores: Array<{ root: string; repository: TaskRunRepository }> = []
const now = '2026-11-10T08:00:00.000Z'
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now) })
afterEach(async () => { vi.useRealTimers(); for (const { root, repository } of stores.splice(0)) { repository.close(); await rm(root, { recursive: true, force: true }) } })

async function fixture(options: { provider?: 'lark' | 'dingtalk'; operation?: 'complete' | 'approve' | 'transfer'; approved?: boolean; remote?: Record<string, unknown> } = {}) {
  const provider = options.provider ?? 'lark', operation = options.operation ?? 'complete'
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-readback-')))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  stores.push({ root, repository })
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', workspace: root, title: 'synthetic', model: 'test' })
  thread.turns.push(createTurnRecord({ id: 'turn', threadId: thread.id, prompt: '处理待办', createdAt: now, status: 'completed' }))
  await threadStore.upsert(thread)
  const controller = new TaskController({ repository, threadStore, sessionStore, nowIso: () => now })
  const task = controller.ensureTask({ thread, turnId: 'turn', request: { prompt: provider === 'lark' ? '处理飞书待办和审批' : '处理钉钉待办和审批' } })
  controller.beginAttempt(thread.id, 'turn')
  const target = operation === 'complete' ? 'todo-42' : '42'
  controller.confirmEffectScope('turn', 0, 'approved-scope', [RequiredEffectSchema.parse({ provider, operation, target })])
  const scopes = provider === 'lark' ? ['task:task:read', 'task:task:write', 'approval:task:read', 'approval:task:write', 'approval:instance:read'] : ['Todo.Todo.Read', 'Todo.Todo.Write', 'Workflow.Instance.Read', 'Workflow.Instance.Write']
  const toolName = provider === 'lark' ? operation === 'complete' ? 'lark_task_complete' : 'lark_approval_approve'
    : operation === 'complete' ? 'dingtalk_complete_task' : operation === 'approve' ? 'dingtalk_approve' : 'dingtalk_transfer'
  const readToolName = provider === 'lark' ? operation === 'complete' ? 'lark_task_get' : 'lark_approval_get' : operation === 'complete' ? 'dingtalk_get_task' : 'dingtalk_get_approval'
  const grant = ExecutionGrantSchema.parse({ id: 'original-grant', taskId: task.id, threadId: thread.id, turnId: 'turn', workspaceRoot: root,
    workspaceTrust: 'workspace-write', agentTrust: 'full-access', sandboxMode: 'workspace-write', approvalPolicy: 'auto',
    allowedProviderIds: [provider === 'lark' ? 'lark-cli' : provider], allowedToolNames: [toolName, readToolName],
    networkAllowlist: [provider === 'lark' ? 'https://open.feishu.cn' : 'https://api.dingtalk.com'], connectorScopes: scopes,
    ...(provider === 'lark' ? {connectorIdentityFingerprints:{'lark-cli':larkTestBinding.identityFingerprint}} : {}),
    externalTargets: [], workspaceRevision: 1, agentRevision: 0, revision: 1, idempotencyKey: 'grant-key', issuedAt: '2026-11-09T00:00:00.000Z', expiresAt: '2026-11-09T00:01:00.000Z' })
  const args = operation === 'complete' ? { taskId: target } : provider === 'lark' ? { taskId: target, instanceCode: 'instance-42' }
    : { taskId: target, instanceId: 'instance-42', ...(operation === 'transfer' ? { toUserId: 'recipient-1' } : {}) }
  const call = { callId: 'write', toolName, providerId: provider === 'lark' ? 'lark-cli' : provider, arguments: args }
  const started = controller.beginToolOperation('turn', call, grant)!
  if (options.approved !== false) {
    controller.recordToolApproval(started.token, started.key, { toolName, requestHash: createHash('sha256').update(JSON.stringify(args)).digest('hex') })
    controller.recordToolDispatch(started.token, started.key)
  } else {
    // Historical receipts did not record the host dispatch boundary or approval proof.
    const legacy = repository.operation(task.id, started.key)!
    const { dispatchTracking: _dispatchTracking, ...request } = legacy.request!
    repository.connection().prepare('UPDATE operation_receipts SET data_json = ? WHERE owner_id = ? AND idempotency_key = ?')
      .run(JSON.stringify({ ...legacy, request, fingerprint: operationFingerprint(request) }), task.id, started.key)
  }
  controller.finishToolOperation(started.token, started.key)
  const running = repository.get(task.id)!
  repository.update(task.id, running.revision, current => ({ ...current, status: 'waiting_user' }))
  const remote = options.remote ?? (provider === 'lark' ? operation === 'complete' ? { task: { guid: target, completed_at: '123' } }
    : { instance_code: 'instance-42', tasks: [{ id: target, status: 'APPROVED' }] }
    : operation === 'complete' ? { id: target, done: true } : { processInstanceId: 'instance-42', tasks: [{ taskId: target, status: 'COMPLETED', result: 'AGREE' }] })
  const runner = vi.fn(async () => ({ ok: true, output: { code: 0, data: remote } }))
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(operation === 'complete' ? remote : { result: remote }), { status: 200 }))
  const adapter = provider === 'lark' ? buildLarkCliToolProvider(LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', ...larkTestBinding, scopes }), withLarkTestIdentity(runner))!
    : buildDingTalkToolProvider({ config: DingTalkCapabilityConfig.parse({ enabled: true, credentialRef: 'user-ref', workflowCredentialRef: 'workflow-ref', unionId: 'union-1', userId: 'user-1', userScopes: scopes.filter(scope => scope.startsWith('Todo.')), scopes: scopes.filter(scope => scope.startsWith('Workflow.')), allowedWriteUserIds: ['user-1'] }),
      getCredential: async ref => ({ kind: ref === 'user-ref' ? 'user' : 'internal-app', accessToken: 'private-token', expiresAt: '2026-11-11T00:00:00Z', unionId: 'union-1', userId: 'user-1', scopes }), fetch: fetcher as typeof fetch, nowIso: () => now })
  const registry = new CapabilityRegistry([adapter]), toolHost = new LocalToolHost({ registry })
  const execute = vi.spyOn(toolHost, 'execute')
  const refreshProvider = vi.fn(async () => undefined)
  let trustRevision = 1
  const service = new ExternalOperationVerificationService({ repository, controller, threadStore, toolHost, nowIso: () => now,
    workspaceTrust: { get: async () => ({ canonicalRoot: root, level: 'workspace-write', revision: trustRevision }) }, refreshProvider })
  const receipt = repository.operation(task.id, started.key)!
  expect(receipt.status).toBe('outcome_unknown')
  const input = () => ({ expectedRevision: repository.get(task.id)!.revision, idempotencyKey: 'readback-1' })
  return { root, repository, controller, service, threadStore, task, receipt, target, runner, fetcher, execute, refreshProvider, registry, input, setTrustRevision: (value: number) => { trustRevision = value } }
}

describe('typed unknown-operation readback', () => {
  it.each(['lark', 'dingtalk'] as const)('verifies %s completion with one readonly tool, preserves unknown evidence, and does not resume', async provider => {
    const f = await fixture({ provider })
    const input = f.input()
    expect(f.receipt.request?.executionGrant).toMatchObject({ externalTargets: [] })
    expect(f.receipt.result).toBeUndefined()
    const result = await f.service.verify(f.task.id, f.receipt.id, input)
    expect(result).toMatchObject({ status: 'verified', evidence: { provider, operation: 'complete', target: f.target, verified: true, status: 'done' } })
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls[0][0].toolName).toBe(provider === 'lark' ? 'lark_task_get' : 'dingtalk_get_task')
    expect(f.execute.mock.calls[0][1].executionGrant).toMatchObject({ sandboxMode: 'read-only', externalTargets: [], allowedToolNames: [provider === 'lark' ? 'lark_task_get' : 'dingtalk_get_task'] })
    if (provider === 'dingtalk') expect(f.fetcher.mock.calls[0][1]?.method).toBe('GET')
    const saved = f.repository.operation(f.task.id, f.receipt.idempotencyKey)!
    expect(saved.status).toBe('outcome_unknown')
    expect(saved.resolution).toMatchObject({ status: 'verified', evidence: result.evidence })
    expect(f.repository.unsettledOperations(f.task.id)).toHaveLength(0)
    expect(f.repository.get(f.task.id)?.status).toBe('waiting_user')
    expect(verifiedEffectReceipts(f.repository.get(f.task.id)!, f.repository.operations(f.task.id))).toEqual([result.evidence])
    expect(await f.service.verify(f.task.id, f.receipt.id, input)).toEqual(result)
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it.each(['lark', 'dingtalk'] as const)('uses %s approval instance locator and exact task result', async provider => {
    const f = await fixture({ provider, operation: 'approve' })
    expect(f.receipt.dispatchApproval?.requestHash).toBe(f.receipt.request?.approvalRequestHash)
    expect(f.receipt.request?.approvalRequestHash).not.toBe(f.receipt.request?.argumentsHash)
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'verified', evidence: { operation: 'approve', target: '42' } })
    expect(f.execute.mock.calls[0][0]).toMatchObject({ toolName: provider === 'lark' ? 'lark_approval_get' : 'dingtalk_get_approval', arguments: provider === 'lark' ? { instanceCode: 'instance-42' } : { instanceId: 'instance-42' } })
  })

  it('does not equate a different approval node or missing transfer recipient with success', async () => {
    const f = await fixture({ provider: 'dingtalk', operation: 'transfer', remote: { processInstanceId: 'instance-42', tasks: [{ taskId: '42', result: 'REDIRECTED', status: 'COMPLETED' }] } })
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'outcome_unknown', errorCode: 'verification_state_unconfirmed' })
    expect(f.repository.unsettledOperations(f.task.id)).toHaveLength(1)
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it('keeps incomplete remote state unknown, without replay or model invocation', async () => {
    const f = await fixture({ remote: { task: { guid: 'todo-42', completed_at: '0' } } })
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'outcome_unknown', errorCode: 'verification_state_unconfirmed' })
    expect(f.repository.operations(f.task.id, 'tool')).toHaveLength(1)
    expect(f.repository.get(f.task.id)?.resultEvidence ?? []).toEqual([])
  })

  it('rejects unknown actions without original approval and validates task revision before any provider call', async () => {
    const f = await fixture({ approved: false })
    await expect(f.service.verify(f.task.id, f.receipt.id, { ...f.input(), expectedRevision: 0 })).rejects.toMatchObject({ code: 'stale_request' })
    await expect(f.service.verify(f.task.id, f.receipt.id, f.input())).rejects.toMatchObject({ code: 'verification_approval_missing' })
    expect(f.refreshProvider).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('checks current provider availability and retains the unknown action when login is missing', async () => {
    const f = await fixture()
    f.refreshProvider.mockRejectedValue(Object.assign(new Error('not logged in'), { code: 'connector_authorization_required' }))
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'outcome_unknown', errorCode: 'connector_authorization_required' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.repository.unsettledOperations(f.task.id)).toHaveLength(1)
  })

  it('cannot verify an old unknown operation using a newly connected Lark account', async () => {
    const f=await fixture()
    const runner=vi.fn()
    f.registry.replaceProvider('lark-cli',buildLarkCliToolProvider(LarkCapabilityConfig.parse({enabled:true,authState:'installed',executablePath:'/managed/lark-cli',
      ...larkTestBinding,userOpenId:'ou-new-account',identityFingerprint:'b'.repeat(64),scopes:['task:task:read']}),runner))
    expect(await f.service.verify(f.task.id,f.receipt.id,f.input())).toMatchObject({status:'outcome_unknown',errorCode:'connector_identity_changed'})
    expect(runner).not.toHaveBeenCalled()
    expect(f.repository.operation(f.task.id,f.receipt.idempotencyKey)?.resolution).toBeUndefined()
    expect(f.repository.unsettledOperations(f.task.id)).toHaveLength(1)
  })

  it('cannot use a missing provider read scope, even when the original write grant allowed it', async () => {
    const f = await fixture()
    f.registry.replaceProvider('lark-cli', buildLarkCliToolProvider(LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', ...larkTestBinding, scopes: ['task:task:write'] })))
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'outcome_unknown', errorCode: 'connector_scope_missing' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('captures current workspace trust in the readonly grant and rejects revocation during readback', async () => {
    const f = await fixture()
    f.setTrustRevision(2)
    f.runner.mockImplementationOnce(async () => {
      f.setTrustRevision(3)
      return { ok: true, output: { code: 0, data: { task: { guid: f.target, completed_at: '123' } } } }
    })
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'outcome_unknown', errorCode: 'execution_grant_revoked' })
    expect(f.execute.mock.calls[0][1].executionGrant?.workspaceRevision).toBe(2)
    expect(f.repository.operation(f.task.id, f.receipt.idempotencyKey)?.resolution).toBeUndefined()
  })

  it('does not accept an idempotency key with a different expected revision', async () => {
    const f = await fixture()
    const input = f.input()
    await f.service.verify(f.task.id, f.receipt.id, input)
    await expect(f.service.verify(f.task.id, f.receipt.id, { ...input, expectedRevision: input.expectedRevision + 1 })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it('accepts a canonical-equivalent workspace alias without widening readback authority', async () => {
    const f = await fixture()
    const thread = (await f.threadStore.get('thread'))!
    await f.threadStore.upsert({ ...thread, workspace: `${f.root}/.` })
    const task = f.repository.get(f.task.id)!
    f.repository.update(task.id, task.revision, current => ({ ...current, workspaceRoot: `${f.root}/.` }))
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'verified' })
    expect(f.execute.mock.calls[0][1].executionGrant?.workspaceRoot).toBe(f.root)
  })

  it('does not accept a late read after cancellation', async () => {
    const f = await fixture()
    f.runner.mockImplementationOnce(async () => {
      const task = f.repository.get(f.task.id)!
      f.repository.update(task.id, task.revision, current => ({ ...current, status: 'cancelled' }))
      return { ok: true, output: { code: 0, data: { task: { guid: f.target, completed_at: '123' } } } }
    })
    expect(await f.service.verify(f.task.id, f.receipt.id, f.input())).toMatchObject({ status: 'outcome_unknown', errorCode: 'execution_grant_revoked' })
    expect(f.repository.operation(f.task.id, f.receipt.idempotencyKey)?.resolution).toBeUndefined()
    expect(f.repository.get(f.task.id)?.status).toBe('cancelled')
  })
})
