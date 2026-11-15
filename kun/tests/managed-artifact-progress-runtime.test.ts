import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { startNodeHttpServer } from '../src/server/node-http-server.js'
import { buildRouter } from '../src/server/routes/index.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import type { TaskRun } from '../src/contracts/tasks.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')

async function fixture(baseUrl = 'http://127.0.0.1:1/v1') {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-progress-runtime-'))
  cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary), workspace = join(root, '只读 工作区')
  await mkdir(workspace)
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-progress',
    apiKey: baseUrl.includes(':1/') ? '' : 'synthetic-local-only', baseUrl, endpointFormat: 'chat_completions', model: 'synthetic-protocol',
    approvalPolicy: 'auto', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
  cleanup.push(async () => runtime.shutdown?.())
  const server = await startNodeHttpServer({ router: buildRouter(runtime), host: '127.0.0.1', port: 0 })
  cleanup.push(() => { server.server.closeAllConnections(); return server.close() })
  const api = (path: string, method = 'GET', body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers: { authorization: 'Bearer synthetic-progress', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic-protocol' })
  return { runtime, root, workspace, origin, api }
}

async function writerFixture(requiresWebEvidence = false) {
  const f = await fixture()
  const started = await f.runtime.turnService.startTurn({ threadId: f.origin.id, request: { prompt: '生成并保存 report.html 报告。' } })
  let task = f.runtime.taskRepository!.findActiveByThread(f.origin.id)!
  if (requiresWebEvidence) task = f.runtime.taskRepository!.update(task.id, task.revision, current => ({ ...current, acceptance: { ...current.acceptance, requiresWebEvidence: true } }))
  const grant = ExecutionGrantSchema.parse({ id: 'grant-progress', taskId: task.id, threadId: f.origin.id, turnId: started.turnId, workspaceRoot: f.workspace,
    workspaceTrust: 'read-only', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'read-only', allowedToolNames: ['publish_artifact'],
    pathAllowlist: [f.workspace], readPathAllowlist: [f.workspace], writePathAllowlist: [], managedArtifactRoot: f.runtime.taskController!.managedArtifactRoot(task.id),
    workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant-progress', issuedAt: new Date().toISOString() })
  await f.runtime.turnService.updateTurnMetadata(f.origin.id, started.turnId, { executionGrant: grant })
  const context = { threadId: f.origin.id, turnId: started.turnId, workspace: f.workspace, threadMode: 'agent' as const, approvalPolicy: 'auto' as const, sandboxMode: 'read-only' as const,
    abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' as const, executionGrant: grant }
  f.runtime.taskController!.beginAttempt(f.origin.id, started.turnId)
  let count = 0
  async function dispatch(path: string, content: string) {
    const call = { callId: `progress-${++count}`, toolName: 'publish_artifact', arguments: { path, content } }
    const operation = f.runtime.taskController!.beginToolOperation(started.turnId, call, grant)!
    const result = await f.runtime.toolHost!.execute(call, { ...context, assertExecution: () => f.runtime.taskController!.assertToken(operation.token),
      recordToolDispatch: () => f.runtime.taskController!.recordToolDispatch(operation.token, operation.key) })
    return { operation, result }
  }
  async function persist(value: Awaited<ReturnType<typeof dispatch>>, unknown = false) {
    f.runtime.taskController!.finishToolOperation(value.operation.token, value.operation.key, unknown ? undefined : value.result)
    await f.runtime.sessionStore.appendItem(f.origin.id, value.result.item)
  }
  return { ...f, task, grant, started, dispatch, persist }
}

it('registers a successful published draft and exposes its proof over HTTP while the real model loop still awaits its final response', async () => {
  let held = false
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const model = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume this synthetic request without retaining its text. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const step = calls++
    if (step > 0) { held = true; response.write(': held before final model response\n\n'); await barrier }
    const delta = step === 0 ? { tool_calls: [{ index: 0, id: 'publish-progress', type: 'function', function: { name: 'publish_artifact', arguments: JSON.stringify({ path: '报告.html', content: '<h1>正在核对来源的报告草稿</h1>' }) } }] }
      : { content: '报告已保存。' }
    response.end(`data: ${JSON.stringify({ id: 'synthetic-progress', choices: [{ index: 0, delta, finish_reason: step === 0 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { release(); model.close(() => resolve()); model.closeAllConnections() }))
  const f = await fixture(`http://127.0.0.1:${(model.address() as { port: number }).port}/v1`)
  const started = await f.api('/v1/task-commands', 'POST', { threadId: f.origin.id, intent: 'new', idempotencyKey: 'draft-before-final', request: { prompt: '生成并保存一份 HTML 网页报告。' } })
  expect(started.status).toBe(202)
  const command = await started.json() as { task: TaskRun }
  await expect.poll(() => held).toBe(true)
  const task = await (await f.api(`/v1/tasks/${command.task.id}`)).json() as TaskRun
  const receipt = f.runtime.taskRepository!.operations(task.id, 'tool').find(operation => operation.request?.toolName === 'publish_artifact')!
  expect(receipt.status).toBe('succeeded')
  expect((await f.runtime.sessionStore.loadItems(task.threadId)).some(item => item.kind === 'tool_result' && item.toolName === 'publish_artifact' && item.status === 'completed' && !item.isError)).toBe(true)
  expect(task.status).toBe('running')
  expect(task.finalResponse).toBeUndefined()
  expect(task.artifacts, 'A durable successful writer must become previewable before final model completion.').toHaveLength(1)
  const artifact = task.artifacts[0]!
  expect(artifact.validation).toBe('valid')
  expect(artifact.sourceEvidenceStatus).not.toBe('verified')
  expect(artifact.sha256).toBe(sha(await readFile(artifact.absolutePath!)))
  const proof = await f.api(`/v1/tasks/${task.id}/artifacts/${artifact.id}/proof`)
  expect(proof.status).toBe(200)
  expect(await proof.json()).toMatchObject({ taskId: task.id, artifactId: artifact.id, sha256: artifact.sha256, executionGrantId: artifact.executionGrantId })
  expect(f.runtime.taskViewService!.changes(0).some(event => event.kind === 'task_changed' && event.taskId === task.id && (event.payload.artifacts as Array<{ sha256: string }>).some(item => item.sha256 === artifact.sha256))).toBe(true)
  release()
})

it('updates an existing draft fingerprint after a later successful write without requiring another candidate assessment', async () => {
  const f = await writerFixture(), { task, started } = f
  async function publish(content: string) {
    const value = await f.dispatch('report.html', content)
    await f.persist(value)
    await f.runtime.taskController!.recordArtifactPublication(value.operation.token, value.operation.key)
    return value.result
  }
  await publish('<h1>第一版草稿</h1>')
  // Production acceptance collection establishes version A, but the missing final
  // response correctly keeps the task incomplete; a real next attempt follows.
  expect((await f.runtime.taskController!.assessCandidate(f.origin.id, started.turnId)).kind).toBe('continue')
  const original = f.runtime.taskRepository!.get(task.id)!.artifacts[0]!
  expect((await f.api(`/v1/tasks/${task.id}/artifacts/${original.id}/proof`)).status).toBe(200)
  f.runtime.taskController!.beginAttempt(f.origin.id, started.turnId)
  const published = await publish('<h1>第二版草稿，等待正文核对</h1>')
  const output = published.item.kind === 'tool_result' ? published.item.output as { sha256: string } : undefined
  expect(output!.sha256).not.toBe(original.sha256)
  const updated = await (await f.api(`/v1/tasks/${task.id}`)).json() as TaskRun
  const proof = await f.api(`/v1/tasks/${task.id}/artifacts/${original.id}/proof`)
  expect(proof.status, JSON.stringify({ oldSha: original.sha256, newSha: output!.sha256, metadataSha: updated.artifacts[0]?.sha256, taskState: updated.status, proof: await proof.clone().text() })).toBe(200)
  expect(updated.artifacts[0]).toMatchObject({ id: original.id, sha256: output!.sha256, validation: 'valid' })
  expect(updated.status).toBe('running')
  expect(updated.nodes.some(node => node.status !== 'completed')).toBe(true)
})

it.each(['failed', 'outcome_unknown'] as const)('does not register a %s writer even if a file or a success-shaped transcript exists', async status => {
  const f = await writerFixture(true)
  const value = await f.dispatch(status === 'failed' ? '../blocked.html' : 'report.html', '<h1>不能作为成功发布的文件</h1>')
  await f.persist(value, status === 'outcome_unknown')
  expect(f.runtime.taskRepository!.operation(f.task.id, value.operation.key)!.status).toBe(status)
  expect(await f.runtime.taskController!.recordArtifactPublication(value.operation.token, value.operation.key)).toBe(false)
  expect(f.runtime.taskRepository!.get(f.task.id)!.artifacts).toEqual([])
  expect(f.runtime.taskRepository!.events(f.task.id).filter(event => event.kind === 'artifact_published')).toEqual([])
})

it('does not resume a paused task or register a late old-attempt result using a newly acquired token', async () => {
  const f = await writerFixture(true)
  const value = await f.dispatch('report.html', '<h1>等待人工继续的草稿</h1>')
  await f.persist(value)
  const before = f.runtime.taskRepository!.get(f.task.id)!
  f.runtime.taskController!.pauseTask(f.task.id, before.revision)
  expect(await f.runtime.taskController!.recordArtifactPublication(value.operation.token, value.operation.key)).toBe(false)
  expect(f.runtime.taskRepository!.get(f.task.id)).toMatchObject({ status: 'paused', artifacts: [] })
  const paused = f.runtime.taskRepository!.get(f.task.id)!
  f.runtime.taskController!.prepareResume(f.task.id, paused.revision)
  f.runtime.taskController!.beginAttempt(f.origin.id, f.started.turnId)
  const currentToken = f.runtime.taskController!.tokenForTurn(f.started.turnId)!
  expect(currentToken.executionId).not.toBe(value.operation.token.executionId)
  expect(await f.runtime.taskController!.recordArtifactPublication(value.operation.token, value.operation.key)).toBe(false)
  expect(await f.runtime.taskController!.recordArtifactPublication(currentToken, value.operation.key)).toBe(false)
  expect(f.runtime.taskRepository!.get(f.task.id)!.artifacts).toEqual([])
})

it('rechecks the captured fence after real file validation when a pause arrives before the metadata commit', async () => {
  const f = await writerFixture(true)
  const value = await f.dispatch('report.html', '<h1>验证期间收到暂停</h1>')
  await f.persist(value)
  const controller = f.runtime.taskController!
  const validation = controller as unknown as { collectArtifacts: (...args: unknown[]) => Promise<unknown> }
  const collect = validation.collectArtifacts.bind(controller)
  let reached = false, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  validation.collectArtifacts = async (...args) => {
    const actual = await collect(...args)
    reached = true
    await barrier
    return actual
  }
  const pending = controller.recordArtifactPublication(value.operation.token, value.operation.key)
  try {
    await expect.poll(() => reached).toBe(true)
    const task = f.runtime.taskRepository!.get(f.task.id)!
    controller.pauseTask(task.id, task.revision)
    release()
    expect(await pending).toBe(false)
    expect(f.runtime.taskRepository!.get(f.task.id)).toMatchObject({ status: 'paused', artifacts: [] })
    expect(f.runtime.taskRepository!.events(f.task.id).some(event => event.kind === 'artifact_published')).toBe(false)
  } finally { release(); await pending }
})

it('registers a web report only as a draft and preserves task status, pending nodes and idempotent events', async () => {
  const f = await writerFixture(true)
  const value = await f.dispatch('report.html', '<h1>来源尚待核验的草稿</h1>')
  await f.persist(value)
  expect(await f.runtime.taskController!.recordArtifactPublication(value.operation.token, value.operation.key)).toBe(true)
  const saved = f.runtime.taskRepository!.get(f.task.id)!
  expect(saved).toMatchObject({ status: 'running', artifacts: [{ sourceEvidenceStatus: 'draft', validation: 'valid' }] })
  expect(saved.artifacts[0]!.sourceEvidenceReceiptId).toBeUndefined()
  expect(saved.resultEvidence?.some(evidence => evidence.kind === 'file' && evidence.verified)).not.toBe(true)
  expect(saved.nodes.some(node => node.status !== 'completed')).toBe(true)
  const count = f.runtime.taskRepository!.events(f.task.id).filter(event => event.kind === 'artifact_published').length
  const revision = saved.revision
  expect(await f.runtime.taskController!.recordArtifactPublication(value.operation.token, value.operation.key)).toBe(true)
  expect(f.runtime.taskRepository!.get(f.task.id)!.revision).toBe(revision)
  expect(f.runtime.taskRepository!.events(f.task.id).filter(event => event.kind === 'artifact_published')).toHaveLength(count)
  expect((await f.api(`/v1/tasks/${f.task.id}/artifacts/${saved.artifacts[0]!.id}/proof`)).status).toBe(200)
})
