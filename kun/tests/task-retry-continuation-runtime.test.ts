import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { ManagedBrowserSkillRuntime } from '../src/services/managed-browser-skill-runtime.js'
import { TaskControlService } from '../src/services/task-control-service.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import { verifiedTaskRetryLineage } from '../src/services/task-retry-lineage.js'
import { taskPublicQueryGrant } from '../src/services/browser-public-query-authority.js'

vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 7, browsers: [{ instance_id: 'retry-browser', browser_name: 'Chrome', label: '合成 Retry', extension_version: '0.5.0', extension_protocol_version: '1.9' }], sessions: [] } }
    throw new Error(`No browser action expected: ${args[0]}`)
  })
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const goal = '使用 BrowserSkill 读取 https://public.example.test 的公开工程资料，生成 report.html，每天九点前、五点前交付。'
async function fixture(actualLoop = false) {
  let requestSeen!: (body: Record<string, unknown>) => void
  const requested = new Promise<Record<string, unknown>>(resolve => { requestSeen = resolve })
  const responses: ServerResponse[] = []
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    responses.push(response); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': controlled fixture holds for inspection and ordinary Pause\n\n'); requestSeen(body)
  })
  if (actualLoop) {
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { for (const response of responses) response.destroy(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())) })
  }
  const endpoint = model.address()
  const baseUrl = endpoint && typeof endpoint === 'object' ? `http://127.0.0.1:${endpoint.port}/v1` : 'http://127.0.0.1:1/v1'

  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-retry-continuation-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '只读 中文目录'); await mkdir(workspace)
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'fixture', apiKey: actualLoop ? 'controlled-model-fixture' : '', baseUrl, model: 'fixture', approvalPolicy: 'auto', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready', executablePath: process.execPath, executableHash: 'a'.repeat(64), version: '0.5.0', browserInstanceId: 'retry-browser', origins: ['https://public.example.test'], interaction: 'interact', revision: 1, daemonProtocolVersion: '1.9', browsers: [{ id: 'retry-browser', name: 'Chrome', label: '合成 Retry', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }] } }) })
  cleanup.push(async () => runtime.shutdown?.())
  const thread = await runtime.threadService.create({ workspace, model: 'fixture', mode: 'agent' })
  const started = await runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: goal, taskIntent: 'new' } })
  const task = runtime.taskRepository!.findByTurn(started.turnId)!, controller = runtime.taskController!, repository = runtime.taskRepository!
  let current = controller.pauseTask(task.id, task.revision, '合成浏览器范围审阅')
  const snapshot = runtime.confirmBrowserTaskBinding ? runtime.browserTaskBinding!(task.id) : undefined
  runtime.confirmBrowserTaskBinding!(task.id, { expectedTaskRevision: snapshot!.taskRevision, expectedBrowserRevision: snapshot!.browserRevision, browserInstanceId: snapshot!.browserInstanceId!, origins: snapshot!.origins, interaction: 'interact', verificationPolicy: 'public_query_target', publicQueryAuthorization: 'schedule', confirmed: true, idempotencyKey: 'reviewed-root-scope' })
  current = repository.get(task.id)!
  controller.prepareResume(task.id, current.revision)
  // A real writer receipt belongs to the original immutable Turn/Task only.
  const grant = ExecutionGrantSchema.parse({ id: 'original-grant', taskId: task.id, threadId: thread.id, turnId: started.turnId, workspaceRoot: workspace, workspaceTrust: 'read-only', agentTrust: 'full-access', approvalPolicy: 'auto', sandboxMode: 'read-only', pathAllowlist: [workspace], readPathAllowlist: [workspace], writePathAllowlist: [], managedArtifactRoot: controller.managedArtifactRoot(task.id), workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'original-grant', issuedAt: new Date().toISOString() })
  await runtime.turnService.updateTurnMetadata(thread.id, started.turnId, { executionGrant: grant })
  controller.beginAttempt(thread.id, started.turnId)
  let n = 0
  function context(g = grant): ToolHostContext { return { threadId: g.threadId, turnId: g.turnId, workspace, threadMode: 'agent', approvalPolicy: 'auto', sandboxMode: 'read-only', executionGrant: g, abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' } }
  async function call(toolName: string, args: Record<string, unknown>, g = grant) {
    const descriptor = (await runtime.toolHost!.listTools(context(g))).find(tool => tool.name === toolName)
    const request = { callId: `actual-host-${++n}`, toolName, arguments: args, providerId: descriptor?.providerId }
    const operation = controller.beginToolOperation(g.turnId, request, g)!
    const result = await runtime.toolHost!.execute(request, context(g))
    controller.finishToolOperation(operation.token, operation.key, result)
    await runtime.sessionStore.appendItem(thread.id, result.item)
    if (toolName === 'publish_artifact') await controller.recordArtifactPublication(operation.token, operation.key)
    return result
  }
  const published = await call('publish_artifact', { path: 'report.html', content: '<html lang="zh-CN"><title>历史草稿</title><body>原任务的真实草稿文件，仍需采集正文及来源核验。</body></html>' })
  expect(published.item.kind === 'tool_result' && published.item.isError).not.toBe(true)
  expect((await call('todo_list', {})).item).toMatchObject({ isError: false })
  expect((await call('todo_write', { todos: [{ content: '核对正文并修复同一报告', status: 'in_progress' }] })).item).toMatchObject({ isError: false })
  controller.recordAttemptFailure(thread.id, started.turnId, 'max_tokens', '合成停止，不含未知动作')
  await runtime.turnService.finishTurn({ threadId: thread.id, turnId: started.turnId, status: 'aborted' })
  const runTurn = vi.fn()
  const controls = new TaskControlService({ repository, tasks: controller, threads: runtime.threadService, turns: runtime.turnService, runTurn, preflightExternalTask: async () => null, nowIso: runtime.nowIso })
  const retry = () => controls.mutate(task.id, 'retry', { expectedRevision: repository.get(task.id)!.revision, idempotencyKey: 'explicit-ui-retry' })
  return { runtime, repository, controller, thread, task: repository.get(task.id)!, root, workspace, grant, call, retry, runTurn, requested, controls }
}
function output(result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['call']>>) {
  if (result.item.kind !== 'tool_result') throw new Error('Expected actual Host tool result')
  return result.item.output as Record<string, unknown>
}
it('derives a fresh Retry Grant from explicit durable schedule consent and reads history without accepting it as a new writer', async () => {
  const f = await fixture(), before = f.repository.get(f.task.id)!
  const result = await f.retry(), child = result.task
  expect(child.authority?.browserScope).toEqual(before.authority!.browserScope)
  expect(child.artifacts).toEqual([])
  expect(f.repository.get(f.task.id)).toEqual(before)
  expect(f.runTurn).toHaveBeenCalledOnce()
  expect((await f.retry()).task.id).toBe(child.id)
  const grant = ExecutionGrantSchema.parse({ ...f.grant, id: 'new-retry-grant', taskId: child.id, turnId: result.turn!.turnId, browserScope: child.authority!.browserScope, managedArtifactRoot: f.controller.managedArtifactRoot(child.id), idempotencyKey: 'new-retry-grant', issuedAt: new Date().toISOString() })
  expect(grant.managedArtifactRoot).not.toBe(f.grant.managedArtifactRoot)
  await f.runtime.turnService.updateTurnMetadata(f.thread.id, grant.turnId, { executionGrant: grant })
  f.controller.beginAttempt(f.thread.id, grant.turnId)
  expect(taskPublicQueryGrant(f.repository, grant, f.repository.get(child.id)!)).toMatchObject({ source: { id: f.task.id } })
  const read = await f.call('read_artifact', { path: 'report.html', source_task_id: f.task.id }, grant)
  expect(output(read)).toMatchObject({ history: true, source_task_id: f.task.id, sha256: before.artifacts[0]!.sha256, content: expect.stringContaining('历史草稿') })
  expect(f.repository.get(child.id)!.artifacts).toEqual([])
  expect((await f.call('read_artifact', { path: 'report.html' }, grant)).item).toMatchObject({ isError: true })
  await f.call('publish_artifact', { path: 'report.html', content: '<html><title>后继独立新稿</title><body>新稿仍需真正正文与计划核验，不是旧成果冒充。</body></html>' }, grant)
  expect(f.repository.get(child.id)!.artifacts[0]).toMatchObject({ executionGrantId: grant.id, sourceEvidenceStatus: 'draft' })
  expect(output(await f.call('read_artifact', { path: 'report.html', source_task_id: f.task.id }, grant)).sha256).toBe(before.artifacts[0]!.sha256)
  expect(f.repository.operations(child.id, 'tool').some(receipt => receipt.request?.executionGrant && (receipt.request.executionGrant as { id: string }).id === f.grant.id)).toBe(false)
})

it.each(['revoked', 'cancelled', 'task-only'] as const)('does not derive persistent consent from a %s predecessor', async reason => {
  const f = await fixture(), source = f.repository.get(f.task.id)!
  if (reason === 'revoked') f.repository.update(source.id, source.revision, value => ({ ...value, authority: { ...value.authority!, revokedAt: new Date().toISOString() } }))
  if (reason === 'cancelled') {
    const original = { ...source, id: 'cancelled-source', status: 'cancelled' as const, revision: 0, artifacts: [], childTaskIds: [], nodes: source.nodes.map(node => ({ ...node, id: `cancelled-${node.id}`, taskId: 'cancelled-source' })) }
    f.repository.create(original)
    const child = f.controller.createRetryTask({ id: 'cancelled-child', sourceTaskId: original.id, expectedRevision: 0, thread: (await f.runtime.threadService.get(f.thread.id))!, request: { prompt: original.goal } })
    expect(child.authority?.browserScope).toBeUndefined()
    return
  }
  if (reason === 'task-only') f.repository.update(source.id, source.revision, value => ({ ...value, authority: { ...value.authority!, browserScope: { ...value.authority!.browserScope!, publicQueryAuthorization: { ...value.authority!.browserScope!.publicQueryAuthorization!, duration: 'task', requirementHash: undefined } } } }))
  expect((await f.retry()).task.authority?.browserScope).toBeUndefined()
})

it('rejects a forged family ID or changed history bytes without importing source/writer evidence', async () => {
  const f = await fixture(), result = await f.retry(), child = result.task
  expect(verifiedTaskRetryLineage(f.repository, child)?.root.id).toBe(f.task.id)
  const fake = f.repository.create({ ...child, id: 'unconfirmed-retry', revision: 0, nodes: child.nodes.map(node => ({ ...node, id: `fake-${node.id}`, taskId: 'unconfirmed-retry' })) })
  expect(verifiedTaskRetryLineage(f.repository, fake)).toBeUndefined()
  await expect(f.controller.historicalArtifact(fake.id, f.task.id, 'report.html')).rejects.toMatchObject({ code: 'artifact_history_scope' })
  const grant = ExecutionGrantSchema.parse({ ...f.grant, id: 'history-reader', taskId: child.id, turnId: result.turn!.turnId, managedArtifactRoot: f.controller.managedArtifactRoot(child.id), browserScope: child.authority!.browserScope, idempotencyKey: 'history-reader' })
  await f.runtime.turnService.updateTurnMetadata(f.thread.id, grant.turnId, { executionGrant: grant })
  f.controller.beginAttempt(f.thread.id, grant.turnId)
  await writeFile(f.task.artifacts[0]!.absolutePath!, '<html><title>未经原 writer 写入的变更</title></html>')
  expect((await f.call('read_artifact', { path: 'report.html', source_task_id: f.task.id }, grant)).item).toMatchObject({ isError: true, output: expect.objectContaining({ code: 'artifact_history_changed' }) })
  expect(f.repository.get(child.id)!.artifacts).toEqual([])
})

it('rejects new work when an ancestor still has an unknown result', async () => {
  const f = await fixture(), root = f.repository.get(f.task.id)!
  f.repository.beginOperation({ ownerId: root.id, idempotencyKey: 'unknown-original-tool', kind: 'tool', request: { toolName: 'browser_click' }, nowIso: f.runtime.nowIso() })
  f.repository.finishOperation(root.id, 'unknown-original-tool', { status: 'outcome_unknown' }, f.runtime.nowIso())
  await expect(f.retry()).rejects.toMatchObject({ code: 'outcome_unknown' })
  expect(f.repository.list({ threadId: f.thread.id })).toHaveLength(1)
  expect(f.runTurn).not.toHaveBeenCalled()
})

it('uses the production control, preflight and AgentLoop to mint a new immutable scope before any model work', async () => {
  const f = await fixture(true), before = f.repository.get(f.task.id)!
  const result = await f.runtime.taskControlService!.mutate(before.id, 'retry', { expectedRevision: before.revision, idempotencyKey: 'real-loop-retry' })
  expect(result.turn, JSON.stringify({ capability: result.capability, task: { status: result.task.status, waitingReason: result.task.waitingReason } })).toBeDefined()
  const request = await Promise.race([f.requested, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No controlled model request reached the actual Loop')), 8000))])
  const turn = (await f.runtime.threadService.get(f.thread.id))!.turns.find(item => item.id === result.turn!.turnId)!
  expect(turn.executionGrant).toMatchObject({ taskId: result.task.id, threadId: f.thread.id, turnId: turn.id, browserScope: before.authority!.browserScope })
  expect(turn.executionGrant!.id).not.toBe(f.grant.id)
  expect(turn.executionGrant!.managedArtifactRoot).not.toBe(f.grant.managedArtifactRoot)
  const tools = request.tools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>
  expect(tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(['browser_session_start', 'browser_observe', 'read_artifact', 'publish_artifact', 'verify_web_artifact']))
  expect(JSON.stringify(request.messages)).toContain('source_task_id')
  expect(taskPublicQueryGrant(f.repository, turn.executionGrant!, f.repository.get(result.task.id)!)).toMatchObject({ source: { id: before.id } })
  expect(f.controller.workBudget(turn.id)).toMatchObject({ rootTaskId: before.id })
  const latest = f.repository.get(result.task.id)!
  await f.runtime.taskControlService!.mutate(before.id, 'pause', { expectedRevision: latest.revision, idempotencyKey: 'stop-controlled-loop' })
  expect(f.repository.get(result.task.id)!.status).toBe('paused')
  expect(f.repository.get(before.id)!.attempts).toBe(before.attempts)
}, 15000)

it('keeps a same-name MCP bookkeeping tool behind the external-effect retry fence', async () => {
  const f = await fixture(), request = { toolName: 'todo_write', providerId: 'mcp:remote-todo', executionGrant: f.grant, turnId: f.grant.turnId, callId: 'remote-todo-write' }
  f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: 'remote-todo', kind: 'tool', request, nowIso: f.runtime.nowIso() })
  f.repository.finishOperation(f.task.id, 'remote-todo', { status: 'succeeded', result: { approved: true, item: { kind: 'tool_result', status: 'completed', isError: false, toolName: request.toolName, callId: request.callId, threadId: f.thread.id, turnId: f.grant.turnId, output: { todos: null } } } }, f.runtime.nowIso())
  await expect(f.retry()).rejects.toMatchObject({ code: 'external_effect_retry_blocked' })
  expect(f.runTurn).not.toHaveBeenCalled()
})

it('expires the fresh Grant and rechecks original consent revocation instead of borrowing the old token', async () => {
  const f = await fixture(), result = await f.retry(), child = result.task
  const grant = ExecutionGrantSchema.parse({ ...f.grant, id: 'expired-retry-grant', taskId: child.id, turnId: result.turn!.turnId, browserScope: child.authority!.browserScope, managedArtifactRoot: f.controller.managedArtifactRoot(child.id), idempotencyKey: 'expired-retry-grant', issuedAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-01T00:01:00Z' })
  await f.runtime.turnService.updateTurnMetadata(f.thread.id, grant.turnId, { executionGrant: grant })
  f.controller.beginAttempt(f.thread.id, grant.turnId)
  expect(taskPublicQueryGrant(f.repository, grant, f.repository.get(child.id)!)).toBeUndefined()
  const fresh = { ...grant, id: 'fresh-but-revoked', issuedAt: new Date().toISOString(), expiresAt: undefined }
  expect(taskPublicQueryGrant(f.repository, fresh, f.repository.get(child.id)!)).toBeDefined()
  const source = f.repository.get(f.task.id)!
  f.repository.update(source.id, source.revision, value => ({ ...value, authority: { ...value.authority!, revokedAt: new Date().toISOString() } }))
  expect(taskPublicQueryGrant(f.repository, fresh, f.repository.get(child.id)!)).toBeUndefined()
})

it('keeps a changed browser revision at the existing authorization entry before allocating the retry Turn', async () => {
  const f = await fixture(), scope = f.task.authority!.browserScope!
  const browser = new ManagedBrowserSkillRuntime({ config: { enabled: true, state: 'ready', executablePath: process.execPath, version: '0.5.0', executableHash: 'a'.repeat(64), homeDirectory: f.root, browserInstanceId: scope.browserInstanceId, origins: scope.origins, interaction: 'interact', revision: scope.revision + 1, browsers: [], daemonProtocolVersion: '1.9' }, configPath: 'unused', dataDir: f.root, repository: f.repository, apply: () => { throw new Error('No actual provider installation allowed') } })
  expect(await browser.preflight(goal, (await f.runtime.threadService.get(f.thread.id))!, undefined, f.task)).toMatchObject({ status: 'needs_authorization', errorCode: 'browser_binding_changed' })
  expect(f.repository.get(f.task.id)).toEqual(f.task)
  expect(f.runTurn).not.toHaveBeenCalled()
})
