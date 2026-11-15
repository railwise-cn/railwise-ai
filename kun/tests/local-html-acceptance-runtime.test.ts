import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'

const originalSvgRequest = '创建一个完整、独立运行的 HTML 文件，使用 SVG 绘制一只正在骑自行车的鹈鹕，并制作成二维动画。要求鹈鹕和自行车都能清晰辨认，车轮持续转动，鹈鹕的双腿能够自然地踩动踏板，身体、车轮、踏板之间的运动关系合理协调。所有代码都包含在同一个 HTML 文件中，不依赖外部图片或动画素材，打开浏览器即可直接查看动画效果。'
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>鹈鹕骑车合成验收</title><style>.wheel{transform-box:fill-box;transform-origin:center;animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 300"><title>用于执行链测试的合成鹈鹕与自行车</title><g class="wheel"><circle cx="150" cy="200" r="50" fill="none" stroke="black"/></g><circle cx="350" cy="200" r="50" fill="none" stroke="black"/><path d="M150 200L230 120L350 200H150" fill="none" stroke="blue"/><ellipse cx="230" cy="90" rx="45" ry="28" fill="white" stroke="black"/><path d="M255 80L310 88L255 95" fill="orange"/></svg><p>仅为隔离执行与文件验收的合成输入，不代表实际产品视觉验收。</p></body></html>'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function fixture(prompt = originalSvgRequest, legacyContract = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'local-html-runtime-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const nodeObservations: Array<Array<{ kind: string; status: string }>> = []
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests++
    const calls = new Set<string>(body.messages.flatMap((message: { tool_calls?: Array<{ id: string }> }) => (message.tool_calls ?? []).map(call => call.id)))
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    expect(names).not.toContain('browser_observe')
    const task = runtime?.taskRepository?.list()[0]
    if (legacyContract && task?.acceptance.sourceInferenceVersion !== undefined) {
      const { sourceInferenceVersion: _version, ...old } = task.acceptance
      runtime!.taskRepository!.update(task.id, task.revision, value => ({ ...value, acceptance: { ...old, requiresWebEvidence: true, requiredSourceOrigins: [] } }))
    }
    if (task) nodeObservations.push(task.nodes.map(node => ({ kind: node.kind, status: node.status })))
    let next: string | undefined, id: string | undefined, args: Record<string, unknown> = {}
    if (!calls.has('local-publish')) { next = 'publish_artifact'; id = 'local-publish'; args = { path: 'pelican-bicycle.html', content: html } }
    else if (!calls.has('local-read')) { next = 'read_artifact'; id = 'local-read'; args = { path: 'pelican-bicycle.html' } }
    if (next) expect(names).toContain(next)
    const delta = next ? { tool_calls: [{ index: 0, id, type: 'function', function: { name: next, arguments: JSON.stringify(args) } }] }
      : { content: '已生成并重新读取独立 HTML/SVG 动画 pelican-bicycle.html，可在任务成果中预览。' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'local-html-fixture', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }))
  const port = (server.address() as import('node:net').AddressInfo).port
  runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'local-html-test-token',
    apiKey: 'synthetic-local-only', baseUrl: `http://127.0.0.1:${port}/v1`, endpointFormat: 'chat_completions', model: 'local-html-fixture',
    approvalPolicy: 'on-request', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' } })
  const active = runtime; cleanup.push(async () => active.shutdown?.())
  const router = buildRouter(active)
  const api = (path: string, body?: unknown) => dispatchRequest(router, new Request('http://localhost' + path, { method: 'POST',
    headers: { authorization: 'Bearer local-html-test-token', 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }))
  const origin = await active.threadService.create({ workspace, mode: 'agent', model: 'local-html-fixture', approvalPolicy: 'on-request' })
  const started = await active.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'local-svg', request: { prompt } })
  expect(started.kind).not.toBe('capability_required')
  const taskId = started.task!.id
  return { root, runtime: active, api, taskId, nodeObservations, requests: () => requests }
}

it('delivers the original local SVG request without BrowserSkill or external source evidence and explicitly revalidates a stopped legacy misclassification', async () => {
  const pure = await fixture()
  await expect.poll(() => pure.runtime.taskRepository!.get(pure.taskId)!.status, { timeout: 10_000 }).toBe('completed')
  const completed = pure.runtime.taskRepository!.get(pure.taskId)!, artifact = completed.artifacts[0]!
  expect(completed.acceptance).toMatchObject({ sourceInferenceVersion: 1, kind: 'files' })
  expect(completed.acceptance.requiresWebEvidence).not.toBe(true)
  expect(artifact).toMatchObject({ validation: 'valid', format: 'html' })
  expect(artifact.sourceEvidenceStatus).toBeUndefined()
  const actual = await readFile(artifact.absolutePath!)
  expect(createHash('sha256').update(actual).digest('hex')).toBe(artifact.sha256)
  expect(pure.nodeObservations.some(nodes => nodes.find(node => node.kind === 'execute')?.status === 'completed' && nodes.find(node => node.kind === 'deliver')?.status !== 'completed')).toBe(true)
  const f = await fixture(originalSvgRequest, true)
  await expect.poll(() => f.runtime.taskRepository!.get(f.taskId)!.status, { timeout: 10_000 }).toBe('stalled')
  const repo = f.runtime.taskRepository!, stopped = repo.get(f.taskId)!
  // Synthetic legacy input only: the actual writer, file and transcript remain real.
  const legacy = repo.update(f.taskId, stopped.revision, task => ({ ...task, status: 'failed',
    artifacts: task.artifacts.map(value => ({ ...value, sourceEvidenceStatus: 'draft' })), nodes: task.nodes.map(node => ({ ...node, status: 'failed' })), stalledReason: '网页采集尚缺实际正文来源证据。' }))
  const usage = repo.connection().prepare('SELECT * FROM task_work_spans WHERE root_id=? ORDER BY id').all(f.taskId)
  const oldSpans = repo.connection().prepare('SELECT id,data_json FROM runtime_spans WHERE task_id=? ORDER BY id').all(f.taskId) as Array<{ id: string; data_json: string }>
  const oldReceipts = repo.operations(f.taskId), beforeCalls = f.requests(), beforeBudget = legacy.budget
  const request = { expectedRevision: legacy.revision, idempotencyKey: 'explicit-local-revalidation', confirmed: true }
  const response = await f.api(`/v1/tasks/${f.taskId}/revalidate-artifacts`, request)
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({ corrected: true, completed: true, task: { id: f.taskId, goal: legacy.goal, status: 'completed', attempts: legacy.attempts } })
  expect(f.requests()).toBe(beforeCalls)
  const saved = repo.get(f.taskId)!
  expect(saved.budget).toEqual(beforeBudget)
  expect(saved.artifacts[0]!.sha256).toBe(artifact.sha256)
  expect(saved.artifacts[0]!.sourceEvidenceStatus).toBeUndefined()
  expect(repo.connection().prepare('SELECT * FROM task_work_spans WHERE root_id=? ORDER BY id').all(f.taskId)).toEqual(usage)
  for (const row of oldReceipts) expect(repo.operation(f.taskId, row.idempotencyKey)).toEqual(row)
  for (const row of oldSpans) expect(repo.connection().prepare('SELECT data_json FROM runtime_spans WHERE id=?').get(row.id)).toEqual({ data_json: row.data_json })
  expect(repo.events(f.taskId).filter(event => event.kind === 'local_artifact_acceptance_revalidated')).toMatchObject([{ payload: { previousAcceptance: { requiresWebEvidence: true }, acceptance: { requiresWebEvidence: false }, resumed: false, preservedUsage: true } }])
  expect((await f.api(`/v1/tasks/${f.taskId}/revalidate-artifacts`, request)).status).toBe(200)
  expect(repo.events(f.taskId).filter(event => event.kind === 'local_artifact_acceptance_revalidated')).toHaveLength(1)
})

it('retains source requirements for a mixed fetch-and-SVG task and does not fail execution after a valid file was saved', async () => {
  const f = await fixture('先抓取 https://example.invalid/data 的网页正文，再创建一个 HTML/SVG 图表。')
  await expect.poll(() => f.runtime.taskRepository!.get(f.taskId)!.status, { timeout: 10_000 }).toBe('stalled')
  const task = f.runtime.taskRepository!.get(f.taskId)!
  expect(task.acceptance.requiresWebEvidence).toBe(true)
  expect(task.nodes.find(node => node.kind === 'execute')?.status).toBe('completed')
  expect(task.nodes.find(node => node.kind === 'verify')?.status).toBe('blocked')
  expect(task.nodes.find(node => node.kind === 'deliver')?.status).toBe('blocked')
  expect((await f.api(`/v1/tasks/${task.id}/revalidate-artifacts`, { expectedRevision: task.revision, idempotencyKey: 'never-downgrade-web', confirmed: true })).status).toBe(409)
  expect(f.runtime.taskRepository!.get(task.id)!.acceptance.requiresWebEvidence).toBe(true)
})

it('preserves a changed legacy file as invalid and rejects revalidation while an execution is active', async () => {
  const f = await fixture(originalSvgRequest, true)
  await expect.poll(() => f.runtime.taskRepository!.get(f.taskId)!.status, { timeout: 10_000 }).toBe('stalled')
  const repo = f.runtime.taskRepository!, original = repo.get(f.taskId)!
  let task = repo.update(original.id, original.revision, value => ({ ...value, status: 'running' }))
  expect((await f.api(`/v1/tasks/${task.id}/revalidate-artifacts`, { expectedRevision: task.revision, idempotencyKey: 'active-reject', confirmed: true })).status).toBe(409)
  task = repo.update(task.id, task.revision, value => ({ ...value, status: 'stalled' }))
  await writeFile(task.artifacts[0]!.absolutePath!, html + '<!-- changed outside the authorized writer -->')
  const response = await f.api(`/v1/tasks/${task.id}/revalidate-artifacts`, { expectedRevision: task.revision, idempotencyKey: 'changed-file', confirmed: true })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ corrected: true, completed: false, task: { id: task.id, status: 'stalled', artifacts: [{ validation: 'invalid' }] } })
  expect(repo.get(task.id)!.artifacts[0]!.sha256).toBe(original.artifacts[0]!.sha256)
})

it.each(['mixed_formats', 'minimum_count', 'explicit_name'] as const)('never completes a legacy local task whose original %s file requirement is unmet', async requirement => {
  const prompt = originalSvgRequest + (requirement === 'mixed_formats' ? '同时生成 PDF 文件。' : requirement === 'explicit_name' ? '文件命名为 other.html。' : '')
  const f = await fixture(prompt, true)
  await expect.poll(() => f.runtime.taskRepository!.get(f.taskId)!.status, { timeout: 10_000 }).toBe('stalled')
  const repo = f.runtime.taskRepository!
  let task = repo.get(f.taskId)!
  // The historical inference may have retained only HTML even when the goal
  // explicitly asks for a second format. Revalidation must not exploit that loss.
  if (requirement === 'mixed_formats') expect(task.goal).toContain('生成 PDF 文件')
  if (requirement === 'minimum_count') task = repo.update(task.id, task.revision, value => ({ ...value, acceptance: { ...value.acceptance, minimumArtifacts: 2 } }))
  const calls = f.requests(), originalArtifact = task.artifacts[0]!
  const response = await f.api(`/v1/tasks/${task.id}/revalidate-artifacts`, { expectedRevision: task.revision, idempotencyKey: 'preserve-file-contract', confirmed: true })
  if (requirement === 'mixed_formats') {
    expect(response.status).toBe(409)
    expect(repo.get(task.id)!.acceptance).toEqual(task.acceptance)
  } else {
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ corrected: true, completed: false, task: { status: 'stalled' } })
  }
  expect(repo.get(task.id)!.status).not.toBe('completed')
  expect(repo.get(task.id)!.artifacts[0]!.sha256).toBe(originalArtifact.sha256)
  expect(f.requests()).toBe(calls)
})
