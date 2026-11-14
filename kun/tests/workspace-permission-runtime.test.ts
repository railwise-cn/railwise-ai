import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { makeAssistantTextItem } from '../src/domain/item.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { getTaskArtifactProof } from '../src/server/routes/tasks.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-permission-loop-'))
  cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const requests: unknown[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    const tool = requests.length === 1
    const delta = tool ? { tool_calls: [{ index: 0, id: 'write-report', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'report.html', content: '<!doctype html><html lang="zh-CN"><body>LOCAL-EVIDENCE-42</body></html>' }) } }] } : { content: '报告网页已保存到指定工作区。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: `fixture-${requests.length}`, choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic',
    apiKey: 'synthetic-local-only', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions',
    model: 'synthetic-protocol', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false,
    storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }) })
  cleanup.push(async () => runtime.shutdown?.())
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic-protocol' })
  return { runtime, root, workspace, origin, requests }
}

describe('workspace permission production admission and recovery', () => {
  it.each([false, true])('blocks before a Turn and resumes the original prompt and attachment after scoped authorization (legacy waiting record %s)', async legacy => {
    const f = await fixture()
    const attachment = await f.runtime.attachmentStore!.createDocument({ name: 'source.txt', mimeType: 'text/plain', kind: 'text', data: Buffer.from('LOCAL-EVIDENCE-42'), workspace: f.workspace, threadId: f.origin.id })
    await f.runtime.attachmentStore!.updateV2(attachment.id, { state: 'ready', summary: '合成文本附件，包含 LOCAL-EVIDENCE-42。' })
    const original = '根据附加资料中的 LOCAL-EVIDENCE-42 标记生成报告，保存到 report.html。'
    const command = { threadId: f.origin.id, idempotencyKey: 'save-explicit', request: { prompt: original, displayText: '保存到 report.html', attachmentIds: [attachment.id] } }
    const blocked = await f.runtime.taskCoordinator!.command(command)
    expect(blocked).toMatchObject({ kind: 'capability_required', capability: { provider: 'workspace', errorCode: 'workspace_path_blocked' }, task: { status: 'waiting_user' } })
    const task = blocked.task!
    expect((await f.runtime.threadService.get(task.threadId))?.turns).toHaveLength(0)
    expect(f.requests).toHaveLength(0)
    expect(f.runtime.taskRepository!.inputs(task.id)).toMatchObject([{ text: original, attachmentIds: [attachment.id], sourceId: 'capability-original' }])
    await f.runtime.taskCoordinator!.command(command)
    expect(f.runtime.taskRepository!.inputs(task.id)).toHaveLength(1)
    if (legacy) {
      // Reproduce 0.5.6's waiting record, where the original request lived only in the attention payload.
      const db = f.runtime.taskRepository!.connection()
      db.prepare('DELETE FROM input_deliveries WHERE input_id IN (SELECT id FROM task_inputs WHERE task_id = ?)').run(task.id)
      db.prepare('DELETE FROM task_inputs WHERE task_id = ?').run(task.id)
    }
    const permission = await f.runtime.taskPermissionService!.snapshot(task.id)
    const confirmed = await f.runtime.taskPermissionService!.confirm(task.id, { expectedRevision: permission.taskRevision, idempotencyKey: 'allow-workspace', scopeHash: permission.scopeHash, confirmed: true, approvalPolicy: 'on-request', ttlSeconds: 900, duration: 'task', scope: { readPaths: [f.workspace], writePaths: [f.workspace] } })
    expect(confirmed.resumed).toBe(false)
    expect(f.requests).toHaveLength(0)
    const resumed = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, taskId: task.id, intent: 'resume', idempotencyKey: 'resume-save', request: { prompt: '继续' } })
    expect(resumed.kind, JSON.stringify(resumed)).toBe('task_started')
    expect(resumed.task?.id).toBe(task.id)
    await expect.poll(() => f.runtime.taskRepository!.get(task.id)?.status, { timeout: 10_000 }).toBe('completed')
    expect(f.runtime.approvalGate.pending()).toHaveLength(0)
    expect(await readFile(join(f.workspace, 'report.html'), 'utf8')).toContain('LOCAL-EVIDENCE-42')
    const completed = f.runtime.taskRepository!.get(task.id)!
    const alias = join(f.root, 'workspace-alias')
    await symlink(f.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
    f.runtime.taskRepository!.update(task.id, completed.revision, task => ({ ...task, workspaceRoot: alias }))
    expect((await getTaskArtifactProof(f.runtime, task.id, completed.artifacts[0]!.id)).status).toBe(200)
    expect(JSON.stringify(f.requests)).toContain(original)
    const input = f.runtime.taskRepository!.inputs(task.id)[0]!
    expect(input.consumedAt).toBeDefined()
    const history = await f.runtime.sessionStore.loadItems(task.threadId)
    expect(history.filter(item => item.kind === 'user_message' && item.attachmentIds?.includes(attachment.id))).toHaveLength(1)
  })

  it('turns a real typed file rejection into one durable permission card without adding a user message', async () => {
    const f = await fixture()
    const thread = await f.runtime.threadService.create({ workspace: f.workspace, mode: 'agent', model: 'synthetic-protocol' }, { id: 'permission-worker', title: 'synthetic' })
    const started = await f.runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: '生成 report.html 文件', taskIntent: 'new', taskVisibility: 'task', taskOriginThreadId: f.origin.id } })
    const task = f.runtime.taskRepository!.findByTurn(started.turnId)!
    const grant = ExecutionGrantSchema.parse({ id: 'grant', taskId: task.id, threadId: thread.id, turnId: started.turnId, workspaceRoot: f.workspace, workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', sandboxMode: 'workspace-write', approvalPolicy: 'auto', pathAllowlist: [f.workspace], writePathAllowlist: [f.workspace], workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant', issuedAt: new Date().toISOString() })
    await f.runtime.turnService.updateTurnMetadata(thread.id, started.turnId, { executionGrant: grant })
    f.runtime.taskController!.beginAttempt(thread.id, started.turnId)
    const call = { callId: 'outside', toolName: 'write', toolKind: 'file_change' as const, arguments: { path: join(f.root, 'outside.html'), content: 'x' } }
    const operation = f.runtime.taskController!.beginToolOperation(started.turnId, call, grant)!
    const tool = await f.runtime.toolHost!.execute(call, { threadId: thread.id, turnId: started.turnId, workspace: f.workspace, threadMode: 'agent', approvalPolicy: 'auto', sandboxMode: 'workspace-write', executionGrant: grant, abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' })
    expect(tool.item).toMatchObject({ isError: true, output: { code: 'workspace_path_blocked' } })
    f.runtime.taskController!.finishToolOperation(operation.token, operation.key, tool)
    await f.runtime.sessionStore.appendItem(thread.id, tool.item)
    await f.runtime.sessionStore.appendItem(thread.id, makeAssistantTextItem({ id: 'explanation', turnId: started.turnId, threadId: thread.id, text: '无法保存。', status: 'completed' }))
    expect((await f.runtime.taskController!.assessCandidate(thread.id, started.turnId)).kind).toBe('waiting_user')
    await f.runtime.taskCoordinator!.flushCommandMessages()
    await f.runtime.taskCoordinator!.flushCommandMessages()
    const history = await f.runtime.sessionStore.loadItems(f.origin.id)
    expect(history.filter(item => item.kind === 'assistant_text' && item.capabilityCard)).toHaveLength(1)
    expect(history.filter(item => item.kind === 'user_message')).toHaveLength(0)
    expect(f.runtime.taskRepository!.inbox(f.workspace).filter(item => item.taskId === task.id)).toHaveLength(1)
  })
})
