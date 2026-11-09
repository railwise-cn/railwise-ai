import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRun } from '../contracts/tasks.js'
import type { ModelClient, ModelRequest } from '../ports/model-client.js'
import { TaskRunRepository } from './task-run-repository.js'
import { TaskContextRepository } from './task-context-repository.js'
import { TaskContextRuntime } from './task-context-runtime.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function task(root: string, id = 'task'): TaskRun {
  return { id, threadId: `thread_${id}`, childTaskIds: [], workspaceRoot: root, goal: '合成研究报告', status: 'running', agentId: 'general', acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false }, budget: { maxAttempts: 3, maxDurationMs: 60_000 }, attempts: 1, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'railwise-context-runtime-')); roots.push(root)
  const tasks = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  const context = new TaskContextRepository(tasks.sharedDatabase(), { objectRoot: join(root, 'objects'), inlineLimitBytes: 8 })
  const wake = vi.fn(); const runtime = new TaskContextRuntime(context, tasks, undefined, wake)
  tasks.create(task(root))
  return { root, tasks, context, runtime, wake }
}

describe('TaskContextRuntime production adapters', () => {
  it('uses the same transaction for source fan-out and task input, deduplicates overlapping subscriptions, and respects pause', async () => {
    const { root, tasks, context, runtime, wake } = await setup()
    const current = tasks.get('task')!; const session = tasks.execution.ensureSession(current, new Date().toISOString())
    for (const id of ['one', 'overlap']) context.saveSubscription({ schemaVersion: 1, id, workerId: session.id, taskId: current.id, source: 'webhook', enabled: true, mode: 'route', allowedFields: ['payload.public'], workspaceRoot: root, createdAt: current.createdAt, updatedAt: current.updatedAt, revision: 0 })
    const event = { source: 'webhook' as const, idempotencyKey: 'event', workspaceRoot: root, payload: { public: '加入风险章节', private: 'must not leak' } }
    const rules = [{ id: 'existing', enabled: true, sources: ['webhook' as const], mode: 'route' as const, eventTypes: [], subjectIncludes: [], labelsAny: [], workspaceRoots: [root], maxPayloadBytes: 1000 }]
    expect(() => tasks.transact(() => { runtime.ingest(event, rules); throw new Error('crash') })).toThrow('crash')
    expect(context.listSourceEvents()).toHaveLength(0); expect(tasks.inputs('task')).toHaveLength(0)
    runtime.ingest(event, rules); runtime.ingest(event, rules)
    expect(tasks.inputs('task')).toHaveLength(1)
    expect(tasks.inputs('task')[0].text).toContain('加入风险章节')
    expect(tasks.inputs('task')[0].text).not.toContain('must not leak')
    const latest = tasks.get('task')!; tasks.update(latest.id, latest.revision, value => ({ ...value, status: 'paused' }))
    wake.mockClear(); runtime.ingest({ ...event, idempotencyKey: 'paused' }, rules)
    expect(tasks.inputs('task')).toHaveLength(2); expect(wake).not.toHaveBeenCalled()
    expect(tasks.get('task')?.status).toBe('paused')
    context.close(); expect(tasks.get('task')).not.toBeNull(); tasks.close()
  })

  it('captures actual model context before streaming, spills and recalls with authorization, and marks changed sources stale', async () => {
    const { root, tasks, context, runtime } = await setup()
    await writeFile(join(root, 'source.md'), 'source version one')
    const request: ModelRequest = { threadId: 'thread_task', turnId: 'turn', model: 'synthetic', prefix: [], tools: [{ name: 'read_task_context', description: 'bounded context recall', inputSchema: {} }], abortSignal: new AbortController().signal, history: [{ id: 'tool-result', kind: 'tool_result', turnId: 'turn', toolName: 'read_file', callId: 'call', output: { path: 'source.md', sha256: createHash('sha256').update('source version one').digest('hex') }, isError: false } as ModelRequest['history'][number]] }
    const client: ModelClient = { provider: 'test', model: 'synthetic', async *stream(actual) { expect(context.listContextBundles('task')).toHaveLength(1); expect(actual.contextInstructions?.join('')).toContain('read_task_context'); yield { kind: 'completed', stopReason: 'stop' } } }
    for await (const _chunk of runtime.wrapModel(client).stream(request)) { /* actual wrapper path */ }
    const first = context.listContextBundles('task')[0]
    expect(first.stale).not.toBe(true)
    expect(first.objects[0].storage).toBe('spill')
    expect(runtime.readObject('task', first.id, first.objects[0].objectId).toString()).toContain('source.md')
    expect(() => runtime.readObject('other-task', first.id, first.objects[0].objectId)).toThrow(/authority/)
    await writeFile(join(root, 'source.md'), 'source version two')
    runtime.prepareModelRequest({ ...request, turnId: 'turn2' })
    expect(context.getContextBundle(first.id)?.stale).toBe(true)
    tasks.close()
  })

  it('keeps the read version when a source changes before model dispatch, and refreshes only after an actual reread', async () => {
    const { root, tasks, context, runtime } = await setup()
    const readHash = createHash('sha256').update('old evidence').digest('hex')
    await writeFile(join(root, 'source.md'), 'new external evidence')
    const readResult = (id: string, text: string): ModelRequest['history'][number] => ({ id, threadId: 'thread_task', kind: 'tool_result', role: 'tool', status: 'completed', createdAt: new Date().toISOString(), toolKind: 'tool_call', turnId: 'turn', toolName: 'read', callId: id, output: { path: 'source.md', sha256: createHash('sha256').update(text).digest('hex'), content: text }, isError: false })
    const request: ModelRequest = { threadId: 'thread_task', turnId: 'turn', model: 'synthetic', prefix: [], tools: [], abortSignal: new AbortController().signal, history: [readResult('read-old', 'old evidence')] }
    const stale = runtime.prepareModelRequest(request)!
    expect(stale.documents[0].sha256).toBe(readHash)
    expect(stale.stale).toBe(true)
    const next = runtime.prepareModelRequest({ ...request, history: [...request.history, readResult('read-new', 'new external evidence')] })!
    expect(next.stale).not.toBe(true)
    expect(next.documents[0].sha256).not.toBe(readHash)
    context.close(); tasks.close()
  })

  it('does not turn directory metadata or generated output paths into document evidence', async () => {
    const { tasks, context, runtime } = await setup()
    const request: ModelRequest = { threadId: 'thread_task', turnId: 'turn', model: 'synthetic', prefix: [], tools: [], abortSignal: new AbortController().signal, history: ['ls', 'find', 'stat', 'propose_document'].map(toolName => ({ id: toolName, threadId: 'thread_task', kind: 'tool_result', role: 'tool', status: 'completed', createdAt: new Date().toISOString(), toolKind: 'tool_call', turnId: 'turn', toolName, callId: toolName, output: { path: 'runtime/tasks.sqlite3-shm', entries: [{ path: 'source.md', sha256: '0'.repeat(64) }] }, isError: false })) }
    expect(runtime.prepareModelRequest(request)?.documents).toEqual([])
    expect(context.listContextBundles('task')[0].stale).not.toBe(true)
    context.close(); tasks.close()
  })

  it('sends bounded historical excerpts while preserving current instructions, tool pairs and exact recall bytes', async () => {
    const { root, tasks, context, runtime } = await setup()
    const evidence = '合成来源原文与测点记录。'.repeat(9000)
    const oldText = '历史讨论中的详细背景。'.repeat(8000)
    const sourceHash = createHash('sha256').update(evidence).digest('hex')
    await writeFile(join(root, 'source.md'), evidence)
    const common = { threadId: 'thread_task', status: 'completed' as const, createdAt: new Date().toISOString() }
    const request: ModelRequest = {
      threadId: 'thread_task', turnId: 'current', model: 'synthetic', systemPrompt: 'immutable system identity',
      contextInstructions: ['Current authorized Skill instructions stay intact.'],
      prefix: [{ ...common, id: 'prefix', turnId: 'prefix-turn', role: 'user', kind: 'user_message', text: 'immutable cached prefix' }],
      history: [
        { ...common, id: 'old-message', turnId: 'old', role: 'user', kind: 'user_message', text: oldText },
        { ...common, id: 'current-request', turnId: 'current', role: 'user', kind: 'user_message', text: '仅用合成资料整理报告，不改写原文件。' },
        { ...common, id: 'read-call', turnId: 'current', role: 'assistant', kind: 'tool_call', toolName: 'read', callId: 'read', toolKind: 'tool_call', arguments: { path: 'source.md' } },
        { ...common, id: 'read-result', turnId: 'current', role: 'tool', kind: 'tool_result', toolName: 'read', callId: 'read', toolKind: 'tool_call', output: { path: 'source.md', sha256: sourceHash, content: evidence }, isError: false },
        { ...common, id: 'recall-result', turnId: 'current', role: 'tool', kind: 'tool_result', toolName: 'read_task_context', callId: 'recall', toolKind: 'tool_call', output: { text: '刚召回的上下文。'.repeat(3000) }, isError: false }
      ],
      tools: [{ name: 'read_task_context', description: 'bounded recall', inputSchema: {} }], abortSignal: new AbortController().signal
    }
    let outgoing: ModelRequest | undefined
    const client: ModelClient = { provider: 'test', model: 'synthetic', async *stream(actual) { outgoing = actual; yield { kind: 'completed', stopReason: 'stop' } } }
    for await (const _ of runtime.wrapModel(client).stream(request)) { /* production projection boundary */ }
    expect(outgoing).toBeDefined()
    expect(outgoing!.systemPrompt).toBe(request.systemPrompt)
    expect(outgoing!.prefix).toBe(request.prefix)
    expect(outgoing!.contextInstructions?.[0]).toBe(request.contextInstructions![0])
    expect(outgoing!.history[1]).toBe(request.history[1])
    expect(outgoing!.history[2]).toBe(request.history[2])
    expect(outgoing!.history[4]).toBe(request.history[4])
    expect(Buffer.byteLength(JSON.stringify(outgoing!.history))).toBeLessThan(Buffer.byteLength(JSON.stringify(request.history)) / 2)
    expect((request.history[0] as { text: string }).text).toBe(oldText)
    const result = outgoing!.history[3]
    expect(result.kind).toBe('tool_result')
    if (result.kind !== 'tool_result') throw new Error('expected tool result')
    expect(result.callId).toBe('read')
    const projected = result.output as { contextSpill: { bundle_id: string; object_id: string; sha256: string }; complete: boolean }
    expect(projected.complete).toBe(false)
    const bytes = runtime.readObject('task', projected.contextSpill.bundle_id, projected.contextSpill.object_id)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(projected.contextSpill.sha256)
    expect(JSON.parse(bytes.toString()).content).toBe(evidence)
    const bundle = context.getContextBundle(projected.contextSpill.bundle_id)!
    expect(bundle.documents).toContainEqual(expect.objectContaining({ path: 'source.md', sha256: sourceHash }))
    expect(bundle.stale).not.toBe(true)
    const projection = bundle.objects.find(object => object.kind === 'model-request-projection')!
    const actualContext = JSON.parse(runtime.readObject('task', bundle.id, projection.objectId).toString())
    expect(actualContext.history).toEqual(outgoing!.history)
    expect(actualContext.prefix).toEqual(request.prefix)
    expect(() => runtime.readObject('other-task', bundle.id, projected.contextSpill.object_id)).toThrow(/authority/)
    const current = tasks.get('task')!
    tasks.update(current.id, current.revision, task => ({ ...task, authority: { source: 'user', grantedAt: current.createdAt, workspaceRoot: root, externalTargets: [], revokedAt: new Date().toISOString() } }))
    expect(() => runtime.readObject('task', bundle.id, projected.contextSpill.object_id)).toThrow(/authority/)
    context.close(); tasks.close()
  })

  it('keeps full history when the authorized profile has no recall tool', async () => {
    const { tasks, context, runtime } = await setup()
    const request: ModelRequest = { threadId: 'thread_task', turnId: 'turn', model: 'synthetic', prefix: [], tools: [], abortSignal: new AbortController().signal,
      history: [{ id: 'old', threadId: 'thread_task', turnId: 'old', role: 'user', kind: 'user_message', status: 'completed', createdAt: new Date().toISOString(), text: '不能静默移除的历史内容。'.repeat(5000) }] }
    const client: ModelClient = { provider: 'test', model: 'synthetic', async *stream(actual) { expect(actual).toBe(request); yield { kind: 'completed', stopReason: 'stop' } } }
    for await (const _ of runtime.wrapModel(client).stream(request)) { /* no inaccessible references */ }
    expect(context.listContextBundles('task')[0].objects).toHaveLength(1)
    context.close(); tasks.close()
  })
})
