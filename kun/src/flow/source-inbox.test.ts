import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowRepository } from './repository.js'
import { FlowExecutor } from './executor.js'
import { FlowRuntimeService } from './service.js'
import { buildCoreFlowAdapters } from './core-adapters.js'
import { buildFlowNodeRegistry } from './node-registry.js'
import { EncryptedFileFlowSecretStore, FlowWebhookSecurity } from './webhook-security.js'
import { TaskRunRepository } from '../services/task-run-repository.js'
import { TaskContextRepository } from '../services/task-context-repository.js'
import { TaskContextRuntime } from '../services/task-context-runtime.js'
import { TaskViewService } from '../services/task-view-service.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const node = { id: 'hook', type: 'webhook_trigger', label: 'hook', position: { x: 0, y: 0 }, bindings: {}, config: {}, policy: { timeoutMs: 1000, retryAttempts: 0, retryBackoffMs: 0, errorBehavior: 'fail' as const, concurrencyLimit: 1, resumable: true, breakpoint: false }, disabled: false }

describe('durable Flow source inbox', () => {
  it('keeps accepted source work pending during rollback and dispatches it once when re-enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-rollback-')); roots.push(root)
    const repository = new FlowRepository(join(root, 'flow.sqlite'))
    repository.create({ schemaVersion: 1, id: 'flow', name: 'record-only rollback', description: '', nodes: [node], edges: [], variables: {}, workspace: root })
    const version = repository.publish('flow')
    const accepted = repository.acceptSourceEvent({ source: 'webhook', sourceKey: 'rollback-source', fingerprint: 'receipt', flowId: 'flow', versionId: version.id, workspaceRoot: root, input: {} })
    const sink = vi.fn(async () => undefined)
    const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters(), undefined, undefined, 'deepseek', false)
    service.setSourceEventSink(sink)
    try {
      await service.flushSourceEvents()
      expect(repository.getRun(accepted.event.runId)?.status).toBe('queued')
      expect(repository.listNodeRuns(accepted.event.runId)).toHaveLength(0)
      expect(repository.pendingOutbox('flow_source_dispatch')).toHaveLength(1)
      expect(sink).not.toHaveBeenCalled()
      expect(await service.tickSchedules()).toBe(0)
      service.setBackgroundDispatchEnabled(true)
      await service.flushSourceEvents()
      await vi.waitFor(() => expect(repository.getRun(accepted.event.runId)?.status).toBe('succeeded'))
      expect(sink).toHaveBeenCalledTimes(1)
      expect(repository.pendingOutbox('flow_source_dispatch')).toHaveLength(0)
    } finally { service.shutdown() }
  })
  it('drains an attention revision committed while the destination consumer is still awaiting acknowledgement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-attention-race-')); roots.push(root)
    const repository = new FlowRepository(join(root, 'flow.sqlite'))
    repository.create({ schemaVersion: 1, id: 'flow', name: 'standalone', description: '', nodes: [{ ...node, type: 'human_approval' }], edges: [], variables: {}, workspace: root })
    repository.publish('flow')
    const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    const received: string[] = []
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const consuming = new Promise<void>(resolve => { started = resolve })
    service.setAttentionSink(async event => {
      if (event.status === 'pending') { started(); await gate }
      received.push(event.status)
    })
    try {
      const run = await service.run('flow', {})
      await vi.waitFor(() => expect(repository.getRun(run.id)?.status).toBe('waiting_approval'))
      await consuming
      await service.decide(run.id, 'hook', 'approve')
      await vi.waitFor(() => expect(repository.getRun(run.id)?.status).toBe('succeeded'))
      release()
      await vi.waitFor(() => expect(received).toEqual(['pending', 'answered']))
      expect(repository.pendingOutbox('flow_attention')).toHaveLength(0)
    } finally { release(); service.shutdown() }
  })
  it('recovers standalone Flow approval attention across databases and rejects duplicate or late reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-attention-')); roots.push(root)
    const path = join(root, 'flow.sqlite')
    let flowRepository = new FlowRepository(path)
    const approval = { ...node, type: 'human_approval', label: '确认合成成果', config: { message: '检查成果后继续。' } }
    flowRepository.create({ schemaVersion: 1, id: 'flow', name: 'standalone', description: '', nodes: [approval], edges: [], variables: {}, workspace: root })
    flowRepository.publish('flow')
    let service = new FlowRuntimeService(flowRepository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    const run = await service.run('flow', {})
    await vi.waitFor(() => expect(flowRepository.getRun(run.id)?.status).toBe('waiting_approval'))
    const pending = flowRepository.pendingOutbox('flow_attention')[0]!.payload as import('./repository.js').FlowAttentionEvent
    expect(pending.status).toBe('pending')
    service.shutdown()
    const tasks = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    const contexts = new TaskContextRepository(tasks.sharedDatabase(), { objectRoot: join(root, 'objects') })
    const runtime = new TaskContextRuntime(contexts, tasks)
    const view = new TaskViewService(tasks)
    flowRepository = new FlowRepository(path)
    service = new FlowRuntimeService(flowRepository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    service.setAttentionSink(event => runtime.acceptFlowAttention(event))
    await service.flushSourceEvents()
    expect(tasks.inbox(root)).toMatchObject([{ ownerKind: 'flow', workspaceRoot: root, flowId: 'flow', flowRunId: run.id, nodeId: 'hook', status: 'pending' }])
    expect(tasks.inbox(join(root, 'another-project'))).toHaveLength(0)
    await runtime.acceptFlowAttention(pending)
    expect(view.changes(0).filter(item => item.kind === 'attention_changed')).toHaveLength(1)
    await service.decide(run.id, 'hook', 'approve')
    await vi.waitFor(() => expect(flowRepository.getRun(run.id)?.status).toBe('succeeded'))
    await service.flushSourceEvents()
    expect(tasks.inbox(root)).toHaveLength(0)
    expect(tasks.attention(pending.id)?.status).toBe('answered')
    await runtime.acceptFlowAttention(pending)
    expect(tasks.inbox(root)).toHaveLength(0)
    expect(view.changes(0).filter(item => item.kind === 'attention_changed')).toHaveLength(2)
    service.shutdown(); contexts.close(); tasks.close()
  })
  it('cancels a waiting Flow durably and requires a new decision for a new occurrence of the same node', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-controls-')); roots.push(root)
    const repository = new FlowRepository(join(root, 'flow.sqlite'))
    repository.create({ schemaVersion: 1, id: 'flow', name: 'standalone', description: '', nodes: [{ ...node, type: 'human_approval' }], edges: [], variables: {}, workspace: root })
    repository.publish('flow')
    const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    try {
      const run = await service.run('flow', {})
      await vi.waitFor(() => expect(repository.getRun(run.id)?.status).toBe('waiting_approval'))
      const original = repository.listNodeRuns(run.id).at(-1)!
      await service.decide(run.id, 'hook', 'approve')
      await vi.waitFor(() => expect(repository.getRun(run.id)?.status).toBe('succeeded'))
      expect(await service.decide(run.id, 'hook', 'approve')).toMatchObject({ status: 'succeeded' })
      await service.retryFrom(run.id, 'hook')
      await vi.waitFor(() => expect(repository.getRun(run.id)?.status).toBe('waiting_approval'))
      const second = repository.listNodeRuns(run.id).at(-1)!
      expect(second.id).not.toBe(original.id)
      await service.decide(run.id, 'hook', 'reject')
      expect(repository.getRun(run.id)?.status).toBe('failed')
      expect(repository.operation(run.id, `decision:hook:${original.id}`)?.status).toBe('succeeded')
      expect(repository.operation(run.id, `decision:hook:${second.id}`)?.result).toMatchObject({ decision: 'reject' })
      const waiting = await service.run('flow', {})
      await vi.waitFor(() => expect(repository.getRun(waiting.id)?.status).toBe('waiting_approval'))
      expect(service.cancel(waiting.id)).toBe(true)
      expect(repository.getRun(waiting.id)?.status).toBe('cancelled')
      expect(repository.pendingOutbox('flow_attention').at(-1)?.payload).toMatchObject({ status: 'cancelled' })
      expect(() => service.decide(waiting.id, 'hook', 'approve')).toThrow(/approval wait/)
      expect(repository.getRun(waiting.id)?.status).toBe('cancelled')
      expect(service.cancel(waiting.id)).toBe(false)
    } finally { service.shutdown() }
  })
  it('claims a queued source run once across two database connections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-claim-')); roots.push(root)
    const path = join(root, 'flow.sqlite')
    const first = new FlowRepository(path)
    first.create({ schemaVersion: 1, id: 'flow', name: 'test', description: '', nodes: [node], edges: [], variables: {} })
    const version = first.publish('flow')
    const accepted = first.acceptSourceEvent({ source: 'webhook', sourceKey: 'one', fingerprint: 'fingerprint', flowId: 'flow', versionId: version.id, input: {} })
    const second = new FlowRepository(path)
    let release!: () => void
    const called = vi.fn(() => new Promise<{ kind: 'output'; output: string }>(resolve => { release = () => resolve({ kind: 'output', output: 'done' }) }))
    const adapters = new Map([['webhook_trigger', called]])
    const a = new FlowExecutor(first, adapters)
    const b = new FlowExecutor(second, adapters)
    a.dispatchQueued(accepted.event.runId)
    b.dispatchQueued(accepted.event.runId)
    expect(called).toHaveBeenCalledTimes(1)
    expect(b.reconcileStartup()).toBe(0)
    release(); await vi.waitFor(() => expect(second.getRun(accepted.event.runId)?.status).toBe('succeeded'))
    first.close(); second.close()
  })
  it('commits nonce, accepted version, queued run and outbox together before dispatch, then recovers once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-inbox-')); roots.push(root)
    const path = join(root, 'flow.sqlite')
    let repository = new FlowRepository(path)
    repository.create({ schemaVersion: 1, id: 'flow', name: 'test', description: '', nodes: [node], edges: [], variables: {}, workspace: root })
    const version = repository.publish('flow')
    const now = Date.now()
    const security = new FlowWebhookSecurity(repository, new EncryptedFileFlowSecretStore(join(root, 'secrets'), Buffer.alloc(32, 1)), () => now)
    const credentials = await security.provision('flow', 'hook')
    const timestamp = String(Math.floor(now / 1000)); const nonce = 'receipt_1234567890abcdef'; const body = JSON.stringify({ synthetic: true })
    const signature = createHmac('sha256', Buffer.from(credentials.secret, 'base64url')).update(`${timestamp}.${nonce}.${body}`).digest('hex')
    const request = () => new Request('http://localhost/hook', { method: 'POST', body, headers: { 'x-workwise-timestamp': timestamp, 'x-workwise-nonce': nonce, 'x-workwise-signature': signature } })
    const first = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters(), undefined, security)
    vi.spyOn(first.executor, 'dispatchQueued').mockImplementation(() => { throw new Error('crash after inbox commit') })
    await expect(first.handleWebhook(credentials.triggerId, request())).rejects.toThrow('crash after inbox commit')
    const received = repository.getSourceEvent('webhook', `${credentials.triggerId}:${nonce}`)!
    expect(received.versionId).toBe(version.id)
    expect(repository.getRun(received.runId)?.status).toBe('queued')
    expect(repository.pendingOutbox('flow_source_dispatch')).toHaveLength(1)
    const draft = repository.get('flow')!; repository.update({ ...draft, name: 'published later' }, draft.revision); repository.publish('flow')
    repository.close()
    repository = new FlowRepository(path)
    const second = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    await second.flushSourceEvents()
    await vi.waitFor(() => expect(repository.getRun(received.runId)?.status).toBe('succeeded'))
    expect(repository.getRun(received.runId)?.versionId).toBe(version.id)
    await second.flushSourceEvents()
    expect(repository.listRuns('flow')).toHaveLength(1)
    expect(repository.pendingOutbox('flow_source_dispatch')).toHaveLength(0)
    repository.close()
  })

  it('rolls back the nonce, run and event when the atomic acceptance fails', async () => {
    const repository = new FlowRepository(':memory:')
    repository.create({ schemaVersion: 1, id: 'flow', name: 'test', description: '', nodes: [node], edges: [], variables: {} })
    const version = repository.publish('flow')
    const input = { source: 'webhook' as const, sourceKey: 'hook:nonce', fingerprint: 'same', flowId: 'flow', versionId: version.id, input: {} }
    expect(() => repository.acceptSourceEvent(input, { triggerId: 'hook', value: 'nonce', acceptedAt: 1 }, () => { throw new Error('crash before commit') })).toThrow('crash before commit')
    expect(repository.getSourceEvent('webhook', input.sourceKey)).toBeNull()
    expect(repository.listRuns('flow')).toHaveLength(0)
    expect(repository.pendingOutbox('flow_source_dispatch')).toHaveLength(0)
    expect(repository.acceptSourceEvent(input, { triggerId: 'hook', value: 'nonce', acceptedAt: 1 }).created).toBe(true)
    expect(repository.acceptSourceEvent(input).created).toBe(false)
    expect(() => repository.acceptSourceEvent({ ...input, fingerprint: 'changed' })).toThrow(/another request/)
    repository.close()
  })

  it('preserves a due schedule and destination outbox across dispatch failure without catching up every missed period', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-schedule-inbox-')); roots.push(root)
    const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const trigger = { ...node, id: 'schedule', type: 'schedule_trigger', config: { kind: 'interval', everyMinutes: 15 } }
    repository.create({ schemaVersion: 1, id: 'schedule', name: 'test', description: '', nodes: [trigger], edges: [], variables: {}, workspace: root })
    repository.publish('schedule')
    repository.saveTriggerState({ flowId: 'schedule', nodeId: trigger.id, enabled: true, nextRunAt: '2026-11-01T00:00:00.000Z', state: {} })
    const service = new FlowRuntimeService(repository, buildFlowNodeRegistry(), buildCoreFlowAdapters())
    const dispatch = vi.spyOn(service.executor, 'dispatchQueued').mockImplementation(() => { throw new Error('dispatch unavailable') })
    await expect(service.tickSchedules(new Date('2026-11-09T00:00:00.000Z'))).rejects.toThrow('dispatch unavailable')
    expect(repository.getTriggerState('schedule', trigger.id)?.nextRunAt).toBe('2026-11-09T00:15:00.000Z')
    expect(repository.listRuns('schedule')).toHaveLength(1)
    expect(repository.pendingOutbox('flow_source_dispatch')).toHaveLength(1)
    dispatch.mockRestore()
    await service.flushSourceEvents()
    await vi.waitFor(() => expect(repository.listRuns('schedule')[0]?.status).toBe('succeeded'))
    expect(await service.tickSchedules(new Date('2026-11-09T00:01:00.000Z'))).toBe(0)
    const sink = vi.fn(async () => { throw new Error('destination unavailable') })
    service.setSourceEventSink(sink)
    await expect(service.flushSourceEvents()).rejects.toThrow('destination unavailable')
    expect(repository.pendingOutbox('task_source_event')).toHaveLength(1)
    service.setSourceEventSink(async () => undefined)
    await service.flushSourceEvents()
    expect(repository.pendingOutbox('task_source_event')).toHaveLength(0)
    repository.close()
  })
})
