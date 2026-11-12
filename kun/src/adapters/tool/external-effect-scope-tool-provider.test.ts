import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../in-memory-thread-store.js'
import { InMemorySessionStore } from '../in-memory-session-store.js'
import { PersistentApprovalGate } from '../persistent-human-gates.js'
import type { ApprovalRequest } from '../../domain/approval.js'
import { createThreadRecord } from '../../domain/thread.js'
import { makeAssistantTextItem, makeToolResultItem } from '../../domain/item.js'
import { TaskController } from '../../services/task-controller.js'
import { TaskRunRepository } from '../../services/task-run-repository.js'
import { verifiedEffectReceipts } from '../../services/external-effect-evidence.js'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { ToolEffectResolver } from '../../ports/tool-effect.js'
import { CapabilityRegistry } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { buildExternalEffectScopeToolProviders } from './external-effect-scope-tool-provider.js'
import { buildDwsToolProvider } from './dws-tool-provider.js'
import { dwsTestConfig } from '../../../tests/helpers/dws-identity.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture(prompt = '帮我处理飞书待办。', resolveToolEffect?: ToolEffectResolver) {
  const root = await mkdtemp(join(tmpdir(), 'railwise-effect-scope-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  cleanup.push(async () => { repository.close(); await rm(root, { recursive: true, force: true }) })
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', title: 'effect scope fixture', workspace: root, model: 'fixture' })
  await threadStore.upsert(thread)
  const nowIso = () => '2026-11-10T00:00:00.000Z'
  const tasks = new TaskController({ repository, threadStore, sessionStore, nowIso, resolveToolEffect })
  const task = tasks.ensureTask({ thread, turnId: 'turn', request: { prompt } })
  tasks.beginAttempt(thread.id, 'turn')
  const providers = buildExternalEffectScopeToolProviders(tasks)
  const host = new LocalToolHost({ registry: new CapabilityRegistry(providers) })
  const awaitApproval = vi.fn(async (_approval: ApprovalRequest) => 'allow' as const)
  const context: ToolHostContext = {
    threadId: thread.id, turnId: 'turn', workspace: root, approvalPolicy: 'auto', sandboxMode: 'workspace-write',
    abortSignal: new AbortController().signal, awaitApproval,
    executionGrant: ExecutionGrantSchema.parse({ id: 'grant', taskId: task.id, threadId: thread.id, turnId: 'turn', workspaceRoot: root,
      workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'workspace-write',
      allowedProviderIds: ['effect-scope', 'lark-cli'], allowedToolNames: ['get_external_effect_scope', 'confirm_external_effect_scope', 'lark_task_complete'],
      connectorScopes: ['task:task:read', 'task:task:write'], revision: 0, workspaceRevision: 0, agentRevision: 0, idempotencyKey: 'grant', issuedAt: nowIso() })
  }
  const request = () => ({ expected_revision: repository.get(task.id)!.acceptance.effect!.scopeRevision ?? 0, idempotency_key: 'review-1', effects: [{ tool_name: 'lark_task_complete', target: 'a' }, { tool_name: 'lark_task_complete', target: 'b' }] })
  const complete = (target: string) => {
    const operation = tasks.beginToolOperation('turn', { callId: `complete-${target}`, toolName: 'lark_task_complete', providerId: 'lark-cli', arguments: { taskId: target } }, context.executionGrant)!
    tasks.finishToolOperation(operation.token, operation.key, { approved: true, item: makeToolResultItem({
      id: `result-${target}`, threadId: thread.id, turnId: 'turn', callId: `complete-${target}`, toolName: 'lark_task_complete',
      output: { ok: true, status: 'succeeded', evidence: { kind: 'external_operation', provider: 'lark', operation: 'complete', target, status: 'completed', verified: true, verifiedAt: nowIso(), resultHash: `hash-${target}` } }
    }) })
  }
  return { root, repository, tasks, task, thread, sessionStore, providers, host, context, awaitApproval, request, complete }
}

describe('finite reviewed external effect scope', () => {
  it('rejects an incomplete combined scope before showing an approval card', async () => {
    const f = await fixture('请先批准飞书审批，再上传测试文件。', name => {
      if (name === 'lark_approval_approve') return { provider: 'lark', operation: 'approve', mutation: true, targetFields: ['taskId'], requiredScopes: [] }
      if (name === 'lark_drive_upload') return { provider: 'lark', operation: 'upload', mutation: true, targetFields: ['folderToken'], requiredScopes: [] }
      return undefined
    })
    const context = { ...f.context, executionGrant: { ...f.context.executionGrant!, allowedToolNames: [
      'get_external_effect_scope', 'confirm_external_effect_scope', 'lark_approval_approve', 'lark_drive_upload'
    ] } }
    const request = { expected_revision: 0, idempotency_key: 'mixed', effects: [{ tool_name: 'lark_approval_approve', target: 'task-a' }] }
    const incomplete = await f.host.execute({ callId: 'incomplete', toolName: 'confirm_external_effect_scope', arguments: request }, context)
    expect(incomplete).toMatchObject({ approved: false, item: { isError: true, output: { code: 'effect_scope_incomplete' } } })
    expect(f.awaitApproval).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'effect_scope')).toHaveLength(0)
    const complete = await f.host.execute({ callId: 'complete', toolName: 'confirm_external_effect_scope', arguments: {
      ...request, effects: [...request.effects, { tool_name: 'lark_drive_upload', target: 'folder-a' }]
    } }, context)
    expect(complete.item).toMatchObject({ output: { status: 'scope_confirmed' } })
    expect(f.awaitApproval).toHaveBeenCalledOnce()
    expect(f.repository.get(f.task.id)?.acceptance.effect?.requiredEffects).toHaveLength(2)
  })

  it('returns malformed scope arguments to the model before creating a user approval', async () => {
    const f = await fixture()
    for (const effects of [[], [{ tool_name: 'lark_drive_upload', target: 'folder-token/RailWise-验收.txt' }]]) {
      const result = await f.host.execute({ callId: 'invalid-scope', toolName: 'confirm_external_effect_scope', arguments: { ...f.request(), effects } }, f.context)
      expect(result).toMatchObject({ approved: false, item: { isError: true, output: { code: 'invalid_tool_arguments' } } })
    }
    expect(f.awaitApproval).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'effect_scope')).toHaveLength(0)
  })

  it('reviews an upload using the folder token without appending a filename', async () => {
    const f = await fixture('请帮我处理飞书任务。', name => name === 'lark_drive_upload'
      ? { provider: 'lark', providerId: 'lark-cli', operation: 'upload', mutation: true, targetFields: ['folderToken'], requiredScopes: ['drive:file:upload'] }
      : undefined)
    const context = { ...f.context, executionGrant: { ...f.context.executionGrant!,
      allowedToolNames: ['get_external_effect_scope', 'confirm_external_effect_scope', 'lark_drive_upload'], connectorScopes: ['drive:file:upload'] } }
    const result = await f.host.execute({ callId: 'upload-scope', toolName: 'confirm_external_effect_scope', arguments: {
      expected_revision: 0, idempotency_key: 'upload-scope', effects: [{ tool_name: 'lark_drive_upload', target: 'folder-token' }]
    } }, context)
    expect(result).toMatchObject({ approved: true, item: { output: { status: 'scope_confirmed' } } })
    expect(f.awaitApproval).toHaveBeenCalledOnce()
    expect(f.awaitApproval.mock.calls[0]![0].summary).toContain('Action 1: lark upload folder-token')
  })

  it('confirms an exact DWS task using its real descriptor without inventing OpenAPI scopes', async () => {
    const runner = vi.fn()
    const provider = buildDwsToolProvider(dwsTestConfig, runner)!
    const registry = new CapabilityRegistry([provider])
    const f = await fixture('请完成钉钉待办，准确 taskId 为 synthetic-task。', name => registry.describeEffect(name))
    const host = new LocalToolHost({ registry: new CapabilityRegistry([...f.providers, provider]) })
    const context: ToolHostContext = { ...f.context, executionGrant: { ...f.context.executionGrant!,
      allowedProviderIds: ['effect-scope', 'dingtalk'],
      allowedToolNames: ['get_external_effect_scope', 'confirm_external_effect_scope', 'dingtalk_complete_task'],
      connectorScopes: [], connectorBackends: { dingtalk: 'dws' },
      connectorIdentityFingerprints: { dingtalk: dwsTestConfig.identityFingerprint! } } }
    const args = { expected_revision: 0, idempotency_key: 'dws-review', effects: [{ tool_name: 'dingtalk_complete_task', target: 'synthetic-task' }] }
    expect(f.task.acceptance.effect).toMatchObject({ provider: 'dingtalk', operation: 'complete' })
    expect(f.task.acceptance.effect!.target).toBeUndefined()
    expect(() => f.tasks.assertExternalTarget('turn', 'dingtalk', 'complete', 'synthetic-task')).toThrow(/confirm_external_effect_scope/)
    const denied = await host.execute({ callId: 'deny-dws-review', toolName: 'confirm_external_effect_scope', arguments: args }, { ...context, awaitApproval: async () => 'deny' })
    expect(denied.approved).toBe(false)
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects).toBeUndefined()
    const result = await host.execute({ callId: 'allow-dws-review', toolName: 'confirm_external_effect_scope', arguments: args }, context)
    expect(result.item).toMatchObject({ output: { status: 'scope_confirmed', requiredEffects: [
      { provider: 'dingtalk', operation: 'complete', target: 'synthetic-task', requiredScopes: [] }
    ] } })
    expect(f.awaitApproval).toHaveBeenCalledOnce()
    expect(f.awaitApproval.mock.calls[0]![0].summary).toContain('Action 1: dingtalk complete synthetic-task')
    expect(() => f.tasks.assertExternalTarget('turn', 'dingtalk', 'complete', 'synthetic-task')).not.toThrow()
    expect(() => f.tasks.assertExternalTarget('turn', 'dingtalk', 'complete', 'another-task')).toThrow(/confirm_external_effect_scope/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('blocks mutations until the entire finite set receives a real explicit approval', async () => {
    const f = await fixture()
    expect(() => f.complete('a')).toThrow(/confirm_external_effect_scope/)
    expect(f.repository.operations(f.task.id, 'tool')).toHaveLength(0)
    const tool = f.providers[0]!.tools.find(tool => tool.name === 'confirm_external_effect_scope')!
    await expect(tool.execute(f.request(), f.context)).rejects.toMatchObject({ code: 'effect_scope_confirmation_required' })
    const denied = await f.host.execute({ callId: 'deny', toolName: tool.name, arguments: f.request() }, { ...f.context, awaitApproval: async () => 'deny' })
    expect(denied.approved).toBe(false)
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects).toBeUndefined()
    const allowed = await f.host.execute({ callId: 'allow', toolName: tool.name, arguments: f.request() }, f.context)
    expect(allowed.approved).toBe(true)
    expect(f.awaitApproval).toHaveBeenCalledOnce()
    expect(f.awaitApproval.mock.calls[0]![0]).toMatchObject({ summary: expect.stringContaining('Action 2: lark complete b') })
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects?.map(effect => effect.target)).toEqual(['a', 'b'])
    expect(f.repository.operations(f.task.id, 'effect_scope')).toMatchObject([{ status: 'succeeded', request: { turnId: 'turn' } }])
  })

  it('keeps the confirmed set immutable, enforces revision/idempotency, and blocks out-of-set mutations', async () => {
    const f = await fixture(), args = f.request()
    await f.host.execute({ callId: 'confirm', toolName: 'confirm_external_effect_scope', arguments: args }, f.context)
    const current = f.repository.get(f.task.id)!
    expect(f.tasks.confirmEffectScope('turn', args.expected_revision, args.idempotency_key, current.acceptance.effect!.requiredEffects!)).toMatchObject({ revision: current.revision })
    expect(() => f.tasks.confirmEffectScope('turn', current.revision, args.idempotency_key, [current.acceptance.effect!.requiredEffects![0]!])).toThrow(/different request/)
    expect(() => f.tasks.confirmEffectScope('turn', current.acceptance.effect!.scopeRevision!, 'replace', [current.acceptance.effect!.requiredEffects![0]!])).toThrow(/cannot be replaced/)
    expect(() => f.tasks.confirmEffectScope('turn', current.acceptance.effect!.scopeRevision!, 'expand', [...current.acceptance.effect!.requiredEffects!, { ...current.acceptance.effect!.requiredEffects![0]!, target: 'c' }])).toThrow(/cannot be replaced/)
    expect(() => f.complete('outside')).toThrow(/complete finite external action set/)
    f.complete('a')
    expect(f.repository.operations(f.task.id, 'tool')).toHaveLength(1)
  })

  it('requires both verified target receipts before the actual TaskController completes the task', async () => {
    const f = await fixture()
    await f.host.execute({ callId: 'confirm', toolName: 'confirm_external_effect_scope', arguments: f.request() }, f.context)
    f.complete('a')
    expect(verifiedEffectReceipts(f.repository.get(f.task.id)!, f.repository.operations(f.task.id, 'tool'))).toEqual([])
    f.complete('b')
    await f.sessionStore.appendItem(f.thread.id, makeAssistantTextItem({ id: 'final', threadId: f.thread.id, turnId: 'turn', text: '已完成本次确认范围中的 a 和 b 两项飞书待办。', status: 'completed' }))
    await expect(f.tasks.assessCandidate(f.thread.id, 'turn')).resolves.toMatchObject({ kind: 'completed', task: { resultEvidence: [{ target: 'a' }, { target: 'b' }] } })
    expect(f.repository.events(f.task.id).filter(event => event.kind === 'effect_scope_confirmed')).toHaveLength(1)
  })

  it('rejects stale review and actions outside the current connector grant without persisting scope', async () => {
    const f = await fixture(), stale = { ...f.request(), expected_revision: 1 }
    const result = await f.host.execute({ callId: 'stale', toolName: 'confirm_external_effect_scope', arguments: stale }, f.context)
    expect(result.item).toMatchObject({ isError: true, output: { code: 'stale_request' } })
    const blocked = await f.host.execute({ callId: 'missing-scope', toolName: 'confirm_external_effect_scope', arguments: f.request() }, { ...f.context, executionGrant: { ...f.context.executionGrant!, connectorScopes: [] } })
    expect(blocked.item).toMatchObject({ isError: true, output: { code: 'connector_scope_missing' } })
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects).toBeUndefined()
  })

  it('confirms through the production persistent gate despite waiting/answer status revision changes', async () => {
    const f = await fixture()
    const gate = new PersistentApprovalGate(f.repository, () => '2026-11-10T00:00:00.000Z')
    const scopeRevision = f.repository.get(f.task.id)!.acceptance.effect!.scopeRevision ?? 0
    const beforeTaskRevision = f.repository.get(f.task.id)!.revision
    const pending = f.host.execute({ callId: 'persistent-confirm', toolName: 'confirm_external_effect_scope', arguments: f.request() }, { ...f.context, awaitApproval: approval => gate.request(approval) })
    await vi.waitFor(() => expect(gate.pending()).toHaveLength(1))
    expect(f.repository.get(f.task.id)!).toMatchObject({ status: 'waiting_approval' })
    expect(f.repository.get(f.task.id)!.revision).toBeGreaterThan(beforeTaskRevision)
    expect(gate.decide(gate.pending()[0]!.id, 'allow')).toBe(true)
    await expect(pending).resolves.toMatchObject({ approved: true, item: { output: { status: 'scope_confirmed', revision: scopeRevision + 1 } } })
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects).toHaveLength(2)
    expect(f.repository.get(f.task.id)!.revision).toBeGreaterThan(beforeTaskRevision + 1)
  })

  it('does not bind a target set changed after the approval summary was generated', async () => {
    const f = await fixture(), args = f.request()
    const result = await f.host.execute({ callId: 'changed', toolName: 'confirm_external_effect_scope', arguments: args }, {
      ...f.context, awaitApproval: async () => { args.effects[0]!.target = 'changed-after-review'; return 'allow' }
    })
    expect(result.item).toMatchObject({ isError: true, output: { code: 'approval_request_changed' } })
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects).toBeUndefined()
  })

  it('does not change a Lark task into a DingTalk task or accept duplicate reviewed targets', async () => {
    const f = await fixture()
    const wrongProvider = await f.host.execute({ callId: 'wrong-provider', toolName: 'confirm_external_effect_scope', arguments: { ...f.request(), effects: [{ tool_name: 'dingtalk_complete_task', target: 'a' }] } }, f.context)
    expect(wrongProvider.item).toMatchObject({ isError: true, output: { code: 'execution_grant_scope' } })
    const duplicate = await f.host.execute({ callId: 'duplicate', toolName: 'confirm_external_effect_scope', arguments: { ...f.request(), effects: [{ tool_name: 'lark_task_complete', target: 'a' }, { tool_name: 'lark_task_complete', target: 'a' }] } }, f.context)
    expect(duplicate.item).toMatchObject({ isError: true, output: { code: 'effect_scope_invalid' } })
    expect(f.repository.operations(f.task.id, 'effect_scope')).toHaveLength(0)
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects).toBeUndefined()
  })

  it('binds an unresolved approval-detail task to the reviewed instance using only read scopes', async () => {
    const f = await fixture('查看飞书审批详情。')
    expect(f.task.acceptance.effect).toMatchObject({ provider: 'lark', operation: 'detail' })
    expect(f.task.acceptance.effect!.target).toBeUndefined()
    const readContext: ToolHostContext = { ...f.context, executionGrant: { ...f.context.executionGrant!,
      allowedToolNames: ['get_external_effect_scope', 'confirm_external_effect_scope', 'lark_approval_get'], connectorScopes: ['approval:instance:read'] } }
    const result = await f.host.execute({ callId: 'detail-scope', toolName: 'confirm_external_effect_scope', arguments: {
      expected_revision: 0, idempotency_key: 'detail-review', effects: [{ tool_name: 'lark_approval_get', target: 'approval-instance-1' }]
    } }, readContext)
    expect(result.item).toMatchObject({ output: { status: 'scope_confirmed', requiredEffects: [{ provider: 'lark', operation: 'detail', target: 'approval-instance-1', requiredScopes: ['approval:instance:read'] }] } })
    expect(f.awaitApproval.mock.calls[0]![0].summary).toContain('Action 1: lark detail approval-instance-1')
    const operation = f.tasks.beginToolOperation('turn', { callId: 'read-detail', toolName: 'lark_approval_get', providerId: 'lark-cli', arguments: { instanceCode: 'approval-instance-1' } }, readContext.executionGrant)!
    f.tasks.finishToolOperation(operation.token, operation.key, { approved: true, item: makeToolResultItem({
      id: 'detail-result', threadId: f.thread.id, turnId: 'turn', callId: 'read-detail', toolName: 'lark_approval_get',
      output: { ok: true, status: 'succeeded', evidence: { kind: 'external_operation', provider: 'lark', operation: 'detail', target: 'approval-instance-1', status: 'read', verified: true, verifiedAt: '2026-11-10T00:00:00.000Z', resultHash: 'detail-instance-1' } }
    }) })
    await f.sessionStore.appendItem(f.thread.id, makeAssistantTextItem({ id: 'detail-final', threadId: f.thread.id, turnId: 'turn', text: '已读取并整理该审批实例的详情及节点状态。', status: 'completed' }))
    await expect(f.tasks.assessCandidate(f.thread.id, 'turn')).resolves.toMatchObject({ kind: 'completed', task: { resultEvidence: [{ operation: 'detail', target: 'approval-instance-1' }] } })
  })

  it('keeps list operations outside finite detail/effect scope confirmation', async () => {
    const f = await fixture('查看飞书审批详情。')
    const result = await f.host.execute({ callId: 'list-scope', toolName: 'confirm_external_effect_scope', arguments: {
      expected_revision: 0, idempotency_key: 'invalid-list-review', effects: [{ tool_name: 'lark_approval_list', target: 'current_user' }]
    } }, f.context)
    expect(result.item).toMatchObject({ isError: true })
    expect(f.repository.get(f.task.id)!.acceptance.effect!.requiredEffects).toBeUndefined()
  })
})
