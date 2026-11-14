import { lstat, rename, truncate, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { TurnItem } from '../src/contracts/items.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'

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
    workspaceTrust: 'read-only', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'read-only', allowedToolNames: ['publish_artifact', 'write', 'read_artifact', 'read'],
    pathAllowlist: [workspace], readPathAllowlist: [workspace], writePathAllowlist: [], managedArtifactRoot: runtime.taskController!.managedArtifactRoot(task.id),
    workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant-artifact', issuedAt: new Date().toISOString() })
  await runtime.turnService.updateTurnMetadata(thread.id, started.turnId, { executionGrant: grant })
  const turn = (await runtime.threadService.get(thread.id))!.turns.find(turn => turn.id === started.turnId)!
  runtime.taskController!.beginAttempt(thread.id, turn.id)
  const context: ToolHostContext = { threadId: thread.id, turnId: turn.id, workspace, threadMode: 'agent' as const, approvalPolicy: 'auto' as const, sandboxMode: 'read-only' as const,
    abortSignal: new AbortController().signal, awaitApproval: async () => 'allow' as const, executionGrant: grant, validateExecutionGrant: async () => { await runtime.taskPermissionService!.executionRestriction(thread.id, context.executionGrant?.taskPermissionId) } }
  let next = 0
  async function publish(path: string, content: string) {
    const call = { callId: `artifact-${++next}`, toolName: 'publish_artifact', toolKind: 'file_change' as const, arguments: { path, content } }
    const operation = runtime.taskController!.beginToolOperation(turn.id, call, grant)!
    const result = await runtime.toolHost!.execute(call, context)
    runtime.taskController!.finishToolOperation(operation.token, operation.key, result)
    await runtime.sessionStore.appendItem(thread.id, result.item)
    return result
  }
  const call = (toolName: string, args: Record<string, unknown>, ctx = context) => runtime.toolHost!.execute({ callId: `read-${++next}`, toolName, arguments: args }, ctx)
  const read = (path: string, extra: Record<string, unknown> = {}, ctx = context) => call('read_artifact', { path, ...extra }, ctx)
  return { runtime, root, workspace, thread, task, grant, turn, context, publish, call, read }
}

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const output = (result: { item: TurnItem }): Record<string, unknown> => {
  if (result.item.kind !== 'tool_result') throw new Error('Expected a tool result')
  return result.item.output as Record<string, unknown>
}

it('reads actual prepared HTML while generic Read remains workspace-fenced', async () => {
  const f = await fixture(); expect((await f.runtime.toolHost!.listTools(f.context)).map(t => t.name)).toContain('read_artifact')
  const saved = await f.publish('报告.html', '<h1>合成报告</h1>'), bytes = await readFile(join(f.grant.managedArtifactRoot!, '报告.html'))
  expect(saved.item).toMatchObject({ isError: false, output: { name: '报告.html', read_artifact: { path: '报告.html' } } })
  expect((await f.call('read', { path: join(f.grant.managedArtifactRoot!, '报告.html') })).item).toMatchObject({ isError: true, output: { code: 'workspace_path_blocked' } })
  expect((await f.read('报告.html')).item).toMatchObject({ isError: false, output: { content: bytes.toString(), byte_size: bytes.length, sha256: sha(bytes), truncated: false, next_offset_bytes: null } })
  expect(bytes.toString()).toContain('data-railwise-report'); expect(f.grant.readPathAllowlist).toEqual([f.workspace]); expect(f.grant.writePathAllowlist).toEqual([])
  expect(f.runtime.taskRepository!.humanRequests('approval', false)).toHaveLength(0)
})

it('pages exact UTF-8 bytes and rejects middle-byte offsets', async () => {
  const f = await fixture(), text = '甲乙🙂\nZ'; await f.publish('pages.txt', text)
  let offset = 0, combined = ''
  for (let n = 0; n < 4; n++) {
    const result = output(await f.read('pages.txt', { offset_bytes: offset, limit_bytes: 4 }))
    expect(result.sha256).toBe(sha(text)); expect(result.byte_size).toBe(Buffer.byteLength(text)); expect(result.bytes_returned).toBe(Buffer.byteLength(String(result.content)))
    expect(String(result.content)).not.toContain('�'); combined += result.content
    if (!result.truncated) { expect(result.next_offset_bytes).toBeNull(); break }
    expect(Number(result.next_offset_bytes)).toBeGreaterThan(offset); offset = Number(result.next_offset_bytes)
  }
  expect(combined).toBe(text)
  for (const offset_bytes of [1, 99]) expect((await f.read('pages.txt', { offset_bytes })).item).toMatchObject({ isError: true, output: { code: 'artifact_read_range' } })
})

it('does not create a missing root or nested directories', async () => {
  const f = await fixture(); expect((await f.read('missing/sub/report.html')).item).toMatchObject({ isError: true })
  await expect(lstat(f.grant.managedArtifactRoot!)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects foreign task roots, traversal, aliases and links without exposing bytes', async () => {
  const f = await fixture(); await f.publish('owned.html', '<p>own</p>'); await writeFile(join(f.workspace, 'secret.html'), 'FOREIGN_SECRET')
  for (const path of ['../secret.html', '/secret.html', 'C:\\secret.html', 'a/../owned.html', 'NUL.html', 'owned.html.', 'owned.exe']) expect((await f.read(path)).approved).toBe(false)
  await symlink(f.workspace, join(f.grant.managedArtifactRoot!, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  expect((await f.read('escape/secret.html')).item).toMatchObject({ isError: true, output: { code: 'artifact_read_blocked' } })
  for (const change of [{ managedArtifactRoot: dirname(f.grant.managedArtifactRoot!) }, { taskId: 'other-task' }]) expect((await f.read('owned.html', {}, { ...f.context, executionGrant: { ...f.grant, ...change } })).approved).toBe(false)
})

it('rejects expired, persisted revoked and stale-Turn grants', async () => {
  const f = await fixture(); await f.publish('owned.html', '<p>own</p>')
  expect((await f.read('owned.html', {}, { ...f.context, executionGrant: { ...f.grant, expiresAt: new Date(Date.now() - 1_000).toISOString() } })).item).toMatchObject({ isError: true, output: { code: 'execution_grant_expired' } })
  const task = f.runtime.taskRepository!.get(f.task.id)!
  f.runtime.taskRepository!.update(task.id, task.revision, value => ({ ...value, authority: { source: 'user', workspaceRoot: f.workspace, externalTargets: [], grantedAt: new Date().toISOString(), revokedAt: new Date().toISOString() } }))
  await expect(f.read('owned.html')).rejects.toMatchObject({ code: 'task_permission_revoked' })
  const revoked = f.runtime.taskRepository!.get(task.id)!
  f.runtime.taskRepository!.update(task.id, revoked.revision, value => ({ ...value, authority: undefined, activeTurnId: 'replacement-turn' }))
  expect((await f.read('owned.html')).item).toMatchObject({ isError: true, output: { code: 'execution_grant_scope' } })
})

it('rejects mid-read root replacement without returning either file content', async () => {
  const f = await fixture(); await f.publish('owned.html', '<p>original</p>'); let validations = 0
  f.context.validateExecutionGrant = async () => {
    if (++validations === 5) {
      await rename(f.grant.managedArtifactRoot!, f.grant.managedArtifactRoot! + '-old')
      await mkdir(f.grant.managedArtifactRoot!); await writeFile(join(f.grant.managedArtifactRoot!, 'owned.html'), 'REPLACED_SECRET')
    }
  }
  const result = await f.read('owned.html')
  expect(validations).toBeGreaterThanOrEqual(5); expect(result.item).toMatchObject({ isError: true, output: { code: 'artifact_read_changed' } })
  expect(JSON.stringify(output(result))).not.toMatch(/original|REPLACED_SECRET/)
})

it('supports maximum published UTF-8 size, bounds physical files and rejects invalid UTF-8', async () => {
  const f = await fixture(), text = '汉'.repeat(8 * 1024 * 1024); await f.call('publish_artifact', { path: 'large.txt', content: text })
  expect((await f.read('large.txt', { limit_bytes: 4 })).item).toMatchObject({ isError: false, output: { byte_size: Buffer.byteLength(text), sha256: sha(text), content: '汉', bytes_returned: 3, next_offset_bytes: 3, truncated: true } })
  await truncate(join(f.grant.managedArtifactRoot!, 'large.txt'), 32 * 1024 * 1024)
  expect((await f.read('large.txt')).item).toMatchObject({ isError: true, output: { code: 'artifact_read_too_large' } })
  await writeFile(join(f.grant.managedArtifactRoot!, 'large.txt'), Buffer.from([0xff]))
  expect((await f.read('large.txt')).item).toMatchObject({ isError: true, output: { code: 'artifact_read_encoding' } })
})

it.each([true, false])('normal model loop respects reader catalog=%s and publishes once without permission waits', async readerAvailable => {
  const temporary = await mkdtemp(join(tmpdir(), 'artifact-read-loop-')); cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary), workspace = join(root, 'readonly'); await mkdir(workspace)
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>>, requests = 0
  const catalogs: string[][] = [], instructions: string[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ function: { name: string } }>; messages?: unknown[] }; catalogs.push(body.tools?.map(t => t.function.name) ?? []); instructions.push(JSON.stringify(body.messages))
    const step = requests++
    const call = [
      { name: 'publish_artifact', arguments: { path: '报告.html', content: '<h1>必须从实际文件回读的合成报告</h1>' } },
      ...(readerAvailable ? [{ name: 'read_artifact', arguments: { path: '报告.html' } }] : [])
    ][step]
    const delta = call ? { tool_calls: [{ index: 0, id: `artifact-loop-${step}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: readerAvailable ? '已从实际成果文件核对 HTML；报告已交付。' : '报告草稿已保存，未执行额外读取。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ id: `artifact-read-${step}`, choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic', apiKey: 'synthetic',
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, endpointFormat: 'chat_completions', model: 'synthetic', approvalPolicy: 'auto', sandboxMode: 'read-only',
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) }); cleanup.push(async () => runtime.shutdown?.())
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'synthetic' })
  if (!readerAvailable) await runtime.threadService.setAgent(origin.id, { agentId: 'publisher-only', expectedRevision: origin.agentRevision ?? 0, idempotencyKey: 'publisher-only', profile: { id: 'publisher-only', name: 'Synthetic publisher', role: 'Publish a draft', color: 'blue', systemPrompt: 'Save the requested draft.', toolAllowlist: ['publish_artifact'], mcpAllowlist: [], trustLevel: 'workspace-write', budget: { maxAttempts: 3, maxDurationMs: 60_000 }, revision: 1 } })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, idempotencyKey: 'artifact-own-read', request: { prompt: readerAvailable ? '生成 HTML 报告，读取你自己的成果核对后交付。' : '生成 HTML 报告草稿并交付。' } })
  await expect.poll(() => runtime.taskRepository!.get(started.task!.id)?.status, { timeout: 10_000 }).toBe('completed')
  const task = runtime.taskRepository!.get(started.task!.id)!, items = await runtime.sessionStore.loadItems(task.threadId), results = items.filter(item => item.kind === 'tool_result')
  expect(results.filter(item => item.toolName === 'publish_artifact')).toHaveLength(1)
  const bytes = await readFile(task.artifacts[0]!.absolutePath!)
  if (readerAvailable) expect(results.find(item => item.toolName === 'read_artifact')).toMatchObject({ isError: false, output: { content: bytes.toString(), sha256: sha(bytes), byte_size: bytes.length } })
  else expect(results.find(item => item.toolName === 'read_artifact')).toBeUndefined()
  expect(catalogs[0]!.includes('read_artifact')).toBe(readerAvailable)
  expect(instructions[0]!.includes('Inspect saved content with read_artifact')).toBe(readerAvailable)
  expect(instructions[0]).toContain('same relative filename'); expect(requests).toBe(readerAvailable ? 3 : 2); expect(runtime.taskRepository!.humanRequests('approval', false)).toHaveLength(0)
  const thread = await runtime.threadService.get(task.threadId); expect(thread!.turns[0]!.executionGrant!.writePathAllowlist).toEqual([])
})
