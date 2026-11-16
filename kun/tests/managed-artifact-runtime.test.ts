import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { makeAssistantTextItem } from '../src/domain/item.js'
import { getTaskArtifactProof } from '../src/server/routes/tasks.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-managed-artifacts-'))
  cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary), workspace = join(root, '只读 工作区')
  await mkdir(workspace)
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic',
    apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused-synthetic', approvalPolicy: 'auto', sandboxMode: 'read-only',
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
  cleanup.push(async () => runtime.shutdown?.())
  const thread = await runtime.threadService.create({ workspace, mode: 'agent', model: 'unused-synthetic' })
  const started = await runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: '生成报告并交付 report.html 文件。' } })
  const task = runtime.taskRepository!.findActiveByThread(thread.id)!
  const grant = ExecutionGrantSchema.parse({ id: 'grant-artifact', taskId: task.id, threadId: thread.id, turnId: started.turnId, workspaceRoot: workspace,
    workspaceTrust: 'read-only', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'read-only', allowedToolNames: ['publish_artifact', 'write'],
    pathAllowlist: [workspace], readPathAllowlist: [workspace], writePathAllowlist: [], managedArtifactRoot: runtime.taskController!.managedArtifactRoot(task.id),
    workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant-artifact', issuedAt: new Date().toISOString() })
  await runtime.turnService.updateTurnMetadata(thread.id, started.turnId, { executionGrant: grant })
  const turn = (await runtime.threadService.get(thread.id))!.turns.find(turn => turn.id === started.turnId)!
  runtime.taskController!.beginAttempt(thread.id, turn.id)
  const context = { threadId: thread.id, turnId: turn.id, workspace, threadMode: 'agent' as const, approvalPolicy: 'auto' as const, sandboxMode: 'read-only' as const,
    abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' as const, executionGrant: grant }
  let next = 0
  async function publish(path: string, content: string) {
    const call = { callId: `artifact-${++next}`, toolName: 'publish_artifact', toolKind: 'file_change' as const, arguments: { path, content } }
    const operation = runtime.taskController!.beginToolOperation(turn.id, call, grant)!
    const result = await runtime.toolHost!.execute(call, context)
    runtime.taskController!.finishToolOperation(operation.token, operation.key, result)
    await runtime.sessionStore.appendItem(thread.id, result.item)
    return result
  }
  return { runtime, root, workspace, thread, task, grant, turn, context, publish }
}

describe('managed artifact production assembly with real SQLite and file tools', () => {
  it('runs the normal coordinator and model-tool loop from a read-only HTML request to a verified artifact', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'railwise-html-loop-'))
    cleanup.push(() => rm(temporary, { recursive: true, force: true }))
    const root = await realpath(temporary), workspace = join(root, 'workspace')
    await mkdir(workspace)
    const catalogs: string[][] = []
    let step = 0
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ function: { name: string } }> }
      catalogs.push(body.tools?.map(tool => tool.function.name) ?? [])
      const tool = step++ === 0
      const delta = tool ? { tool_calls: [{ index: 0, id: 'publish-html', type: 'function', function: { name: 'publish_artifact', arguments: JSON.stringify({ path: '报告.html', content: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>合成报告</title></head><body><h1>合成验收报告</h1></body></html>' }) } }] } : { content: '报告网页已保存到任务成果中，可在右侧查看。' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: `fixture-${step}`, choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
    const port = (server.address() as { port: number }).port
    const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic',
      apiKey: 'synthetic-local-only', baseUrl: `http://127.0.0.1:${port}/v1`, endpointFormat: 'chat_completions', model: 'synthetic-protocol', approvalPolicy: 'auto', sandboxMode: 'read-only',
      tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
    cleanup.push(async () => runtime.shutdown?.())
    const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic-protocol' })
    const result = await runtime.taskCoordinator!.command({ threadId: origin.id, idempotencyKey: 'html-delivery', request: { prompt: '请生成并交付一份 HTML 网页报告。' } })
    expect(result.task).toBeDefined()
    await expect.poll(() => runtime.taskRepository!.get(result.task!.id)?.status, { timeout: 10_000 }).toBe('completed')
    const task = runtime.taskRepository!.get(result.task!.id)!
    expect(task.status, JSON.stringify({ waitingReason: task.waitingReason, calls: step, toolNames: catalogs[0], operations: runtime.taskRepository!.operations(task.id, 'tool').map(receipt => ({ status: receipt.status, error: receipt.error })) })).toBe('completed')
    expect(task.artifacts).toMatchObject([{ format: 'html', validation: 'valid' }])
    expect(catalogs[0]).toContain('publish_artifact')
    expect(catalogs[0]).not.toContain('write')
    const thread = await runtime.threadService.get(task.threadId)
    expect(thread?.turns[0]?.executionGrant?.writePathAllowlist).toEqual([])
    expect(thread?.turns[0]?.executionGrant?.managedArtifactRoot).toBe(task.artifacts[0]!.authorizedRoot)
    expect(runtime.taskRepository!.operations(task.id, 'tool').filter(receipt => receipt.status === 'succeeded')).toHaveLength(1)
  })

  it('persists a verified HTML deliverable and registered assets under a narrow output Grant in a read-only workspace', async () => {
    const f = await fixture()
    const tools = await f.runtime.toolHost!.listTools(f.context)
    expect(tools.map(tool => tool.name)).toContain('publish_artifact')
    expect(tools.map(tool => tool.name)).not.toContain('write')
    expect((await f.publish('assets/report.css', 'body { color: #123; }')).item).toMatchObject({ status: 'completed', isError: false })
    expect((await f.publish('report.html', '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="assets/report.css"></head><body>合成报告</body></html>')).approved).toBe(true)
    await f.runtime.sessionStore.appendItem(f.thread.id, makeAssistantTextItem({ id: 'final', turnId: f.turn.id, threadId: f.thread.id, text: '报告网页已保存到任务成果中。', status: 'completed' }))
    const result = await f.runtime.taskController!.assessCandidate(f.thread.id, f.turn.id)
    expect(result.kind).toBe('completed')
    expect(result.task.artifacts).toHaveLength(2)
    expect(result.task.artifacts.every(file => file.validation === 'valid' && file.authorizedRoot === f.grant.managedArtifactRoot)).toBe(true)
    const html = result.task.artifacts.find(file => file.format === 'html')!
    expect(await readFile(html.absolutePath!, 'utf8')).toContain('合成报告')
    expect((await getTaskArtifactProof(f.runtime, f.task.id, html.id)).status).toBe(200)
    expect(f.grant.writePathAllowlist).toEqual([])
    await writeFile(html.absolutePath!, 'changed after delivery')
    expect((await getTaskArtifactProof(f.runtime, f.task.id, html.id)).status).toBe(409)
  })

  it('rejects path traversal, absolute paths, Windows aliases, symlinks and another task root', async () => {
    const f = await fixture()
    for (const path of ['../outside.html', '/outside.html', 'C:\\outside.html', 'assets/../x.html', 'NUL.html', 'x.html.']) {
      expect((await f.publish(path, 'x')).approved).toBe(false)
    }
    await f.publish('first.html', '<html>first</html>')
    await symlink(f.workspace, join(f.grant.managedArtifactRoot!, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const escaped = await f.publish('escape/secret.html', 'x')
    expect(escaped.item).toMatchObject({ isError: true })
    const altered = { ...f.context, executionGrant: { ...f.grant, managedArtifactRoot: dirname(f.grant.managedArtifactRoot!) } }
    const result = await f.runtime.toolHost!.execute({ callId: 'forged', toolName: 'publish_artifact', arguments: { path: 'wrong.html', content: 'x' } }, altered)
    expect(result.approved).toBe(false)
  })

  it('does not accept a code block or only CSS as the required HTML deliverable', async () => {
    const f = await fixture()
    await f.publish('assets/report.css', 'body{}')
    await f.runtime.sessionStore.appendItem(f.thread.id, makeAssistantTextItem({ id: 'only-prose', turnId: f.turn.id, threadId: f.thread.id, text: '```html\n<html>报告</html>\n```', status: 'completed' }))
    const result = await f.runtime.taskController!.assessCandidate(f.thread.id, f.turn.id)
    expect(result.kind).not.toBe('completed')
    expect(result.task.artifacts.some(file => file.format === 'html')).toBe(false)
  })
})
