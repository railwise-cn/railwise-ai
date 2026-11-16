import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKunServeRuntime } from '../server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../contracts/capabilities.js'
import { createEgoBrowserFixture } from '../../tests/ego-browser-test-fixture.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { makeAssistantTextItem } from '../domain/item.js'
import { TaskController } from './task-controller.js'
import { RuntimeSpanService } from './runtime-span-service.js'
import type { TurnItem } from '../contracts/items.js'

async function fixture() {
  const f = await createEgoBrowserFixture()
  await f.execute('ego_browser_open', { url: 'https://feed.test/list' })
  const original = f.repo.get(f.task.id)!
  f.repo.update(original.id, original.revision, task => ({ ...task, acceptance: { ...task.acceptance, kind: 'answer', requiredFormats: undefined, minimumArtifacts: undefined } }))
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: f.task.threadId, workspace: f.task.workspaceRoot, title: 'Controlled Ego finish', model: 'no-model' })
  await threadStore.upsert({ ...thread, turns: [{ ...createTurnRecord({ id: f.grant().turnId, threadId: thread.id, prompt: f.task.goal }), executionGrant: f.grant() }] })
  for (const receipt of f.repo.operations(f.task.id, 'tool')) await sessionStore.appendItem(thread.id, (receipt.result as { item: TurnItem }).item)
  const spans = new RuntimeSpanService(f.repo, () => '2026-11-16T00:00:01.000Z')
  const controller = new TaskController({ repository: f.repo, threadStore, sessionStore, spans, nowIso: () => '2026-11-16T00:00:01.000Z' })
  controller.beginAttempt(thread.id, f.grant().turnId)
  const snapshot = () => JSON.stringify({ task: f.repo.get(f.task.id), operations: f.repo.operations(f.task.id), spans: spans.diagnostics(f.task.id) })
  return { ...f, controller, threadStore, sessionStore, thread, snapshot }
}

it('can finish a genuine read/answer task without requiring an HTML file or mutating ledgers/spans', async () => {
  const f = await fixture()
  try {
    const before = f.snapshot()
    expect(await f.controller.egoFinishReadiness(f.task.id, f.grant().turnId)).toEqual({ ready: true })
    expect(f.snapshot()).toBe(before)
  } finally { await f.dispose() }
})

it('does not complete a genuine Ego-source answer before the actual finish, and identifies finish rather than missing origins', async () => {
  const f = await fixture()
  try {
    await f.sessionStore.appendItem(f.thread.id, makeAssistantTextItem({ id: 'final-answer', threadId: f.thread.id, turnId: f.grant().turnId,
      text: '读取结果：测绘监测项目，列表日期为2026-11-16。', status: 'completed' }))
    const decision = await f.controller.assessCandidate(f.thread.id, f.grant().turnId)
    expect(decision).toMatchObject({ kind: 'continue', reason: expect.stringContaining('ego_browser_finish') })
    expect(f.repo.get(f.task.id)!.status).not.toBe('completed')
    expect(f.repo.events(f.task.id).some(event => event.kind === 'task_completed')).toBe(false)
  } finally { await f.dispose() }
})

it.each(['files-not-written', 'hard-wait', 'unknown-operation', 'wrong-host', 'wrong-turn'] as const)('refuses premature cleanup without writes or releasing the execution lease: %s', async boundary => {
  const f = await fixture()
  try {
    const current = f.repo.get(f.task.id)!, now = '2026-11-16T00:00:01.000Z'
    if (boundary === 'files-not-written') f.repo.update(current.id, current.revision, task => ({ ...task, acceptance: { ...task.acceptance, kind: 'files', requiredFormats: ['html'], minimumArtifacts: 1 },
      artifacts: [{ id: 'missing-report', relativePath: 'report.html', format: 'html', validation: 'invalid', createdAt: now }] }))
    if (boundary === 'hard-wait') {
      f.repo.beginOperation({ ownerId: current.id, idempotencyKey: 'ego-wait:'+f.grant().turnId, kind: 'ego_browser_wait', request: { turnId: f.grant().turnId }, nowIso: now })
      f.repo.finishOperation(current.id, 'ego-wait:'+f.grant().turnId, { status: 'succeeded' }, now)
    }
    if (boundary === 'unknown-operation') {
      f.repo.beginOperation({ ownerId: current.id, idempotencyKey: 'unresolved-original', kind: 'tool', request: { toolName: 'ego_browser_read', turnId: f.grant().turnId }, nowIso: now })
      f.repo.finishOperation(current.id, 'unresolved-original', { status: 'outcome_unknown' }, now)
    }
    const before = f.snapshot(), token = f.controller.tokenForTurn(f.grant().turnId)
    expect(await f.controller.egoFinishReadiness(current.id, boundary === 'wrong-turn' ? 'wrong-turn' : f.grant().turnId,
      boundary === 'wrong-host' ? 'not-an-actual-host' : undefined)).toMatchObject({ ready: false })
    expect(f.snapshot()).toBe(before)
    expect(f.controller.tokenForTurn(f.grant().turnId)).toBe(token)
  } finally { await f.dispose() }
})


// Offline SDK transport injection: the real Factory/Coordinator/Host/Grant pipeline
// runs unchanged. No external CLI, browser, user profile or paid source is used.
const closedSpaceSdk = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[], names: new Map<number, string>(), closed: false,
  closeOnFirstRead: true, finishes: [] as number[], onStatus: undefined as (() => void) | undefined,
  html: '<body><article><h2>离线恢复后的测绘监测项目</h2><time>2026-11-16</time></article></body>'
}))
vi.mock('./ego-browser-cli.js', async original => ({
  ...await original<typeof import('./ego-browser-cli.js')>(),
  runEgoBrowserScript: vi.fn(async (_config: unknown, script: string) => {
    const first = script.split('\n')[0]!
    const p = JSON.parse(first.slice(first.startsWith('const p = ') ? 10 : 8, -1)) as Record<string, unknown>
    closedSpaceSdk.calls.push(p)
    if (p.action === 'space_status') {
      closedSpaceSdk.onStatus?.()
      expect(p.spaceId).toBe(27)
      expect(p.spaceName).toBe(closedSpaceSdk.names.get(27))
      return { ok: true, kind: 'ego_space_status', version: 1, taskSpaceId: 27, spaceName: p.spaceName,
        idMatch: false, nameMatches: 0, spaceStatus: 'closed' }
    }
    if (!p.action) {
      expect(p.spaceId).toBe(28)
      closedSpaceSdk.finishes.push(Number(p.spaceId))
      return { ok: true, taskSpaceId: 28, spaceName: p.spaceName, finishResolved: true, keep: [] }
    }
    let id = Number(p.spaceId)
    if (!id) {
      expect(p.action).toBe('open')
      id = closedSpaceSdk.names.size ? 28 : 27
      expect(closedSpaceSdk.names.has(id)).toBe(false)
      closedSpaceSdk.names.set(id, String(p.spaceName))
    }
    if (id === 27 && (closedSpaceSdk.closed || closedSpaceSdk.closeOnFirstRead && p.action === 'read')) {
      closedSpaceSdk.closed = true
      // Native-like loss before taskSpace(id) supplies identity; no source proof.
      return { ok: false, code: 'ego_browser_task_space_missing', failurePhase: 'control' }
    }
    expect(p.spaceName).toBe(closedSpaceSdk.names.get(id))
    return { ok: true, taskSpaceId: id, spaceName: p.spaceName, ownership: 'agent', pageLabel: 'p1',
      sourceUrl: 'https://feed.test/list', html: closedSpaceSdk.html, documentHtml: closedSpaceSdk.html,
      truncated: false, loadingObserved: false, visibleText: true, candidates: [] }
  })
}))

it.each([false, true])('resumes the same Task through a fresh Grant, provider-proven closed Space successor, verified report, daily readback and current-Space finish (old draft first=%s)', async resumeWithOldDraft => {
  closedSpaceSdk.calls = []; closedSpaceSdk.names.clear(); closedSpaceSdk.closed = false; closedSpaceSdk.finishes = []
  closedSpaceSdk.closeOnFirstRead = !resumeWithOldDraft
  closedSpaceSdk.html = '<body><article><h2>离线恢复后的测绘监测项目</h2><time>2026-11-16</time></article>' +
    (resumeWithOldDraft ? '<article><h2>另一条离线记录</h2><time>2026-11-16</time><p>预算人民币300元</p></article>' : '') + '</body>'
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ego-closed-space-fullchain-')))
  const cleanup: Array<() => Promise<unknown>> = [() => rm(root, { recursive: true, force: true })]
  try {
    const workspace = join(root, 'workspace'); await mkdir(workspace)
    let resumed = false, reachedReadBarrier = false, releaseNativeRead = () => {}
    const nativeReadAllowed = new Promise<void>(resolve => { releaseNativeRead = resolve })
    let cachedSourceRef: Record<string, unknown> | undefined
    const initialReads = [['open', 'ego_browser_open'], ['read', 'ego_browser_read']]
    const initialSteps = resumeWithOldDraft ? [...initialReads,
      ['publish-bad-1', 'publish_artifact'], ['read-bad-1', 'read_artifact'], ['verify-bad-1', 'verify_web_artifact'],
      ['publish-bad-2', 'publish_artifact'], ['read-bad-2', 'read_artifact'], ['verify-bad-2', 'verify_web_artifact']] : initialReads
    const recoverySteps = [...(resumeWithOldDraft ? [['publish-cached', 'publish_artifact']] : []), ...initialReads,
      ['publish', 'publish_artifact'], ['read-file', 'read_artifact'], ['verify', 'verify_web_artifact'],
      ['schedule', 'schedule_task'], ['read-schedule', 'list_schedules'], ['finish', 'ego_browser_finish']]
    const reportFor = (ref: Record<string, unknown>, badBudget: boolean) => {
      const title = '离线恢复后的测绘监测项目', quote = title + ' 2026-11-16'
      return { path: 'recovered-feed.html', report: { title: '订阅列表恢复汇总', evidence: { coverage: [ref],
        items: [{ sectionId: 'one-record', title, source: ref, discovery: ref, classification: 'source',
          fields: [{ field: 'title', value: title, quote }, { field: 'publication_date', value: '2026-11-16', quote }],
          unverifiedFields: ['budget', 'deadline', 'status', 'qualification'] }, ...(resumeWithOldDraft ? [{
          sectionId: 'second-record', title: '另一条离线记录', source: ref, discovery: ref, classification: 'source',
          fields: [{ field: 'title', value: '另一条离线记录', quote: '另一条离线记录 2026-11-16' },
            { field: 'publication_date', value: '2026-11-16', quote: '另一条离线记录 2026-11-16' },
            { field: 'budget', value: badBudget ? '人民币999元' : '人民币300元',
              quote: badBudget ? '预算报价人民币999元，来源原文。' : '另一条离线记录 2026-11-16 预算人民币300元' }],
          unverifiedFields: ['deadline', 'status', 'qualification'] }] : [])], noMatches: [] } } }
    }
    const model = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: Array<{ tool_call_id?: string; content?: string; tool_calls?: Array<{ id: string }> }> }
      const prefix = resumed ? 'recovered-' : 'original-'
      const called = new Set(body.messages?.flatMap(message => message.tool_calls?.map(call => call.id) ?? []))
      const next = (resumed ? recoverySteps : initialSteps).find(([id]) => !called.has(prefix + id))
      const result = (id: string) => {
        const content = body.messages?.find(message => message.tool_call_id === prefix + id)?.content
        if (!content) throw new Error('Missing real Host result: ' + id)
        return JSON.parse(content.slice(content.indexOf('{'))) as Record<string, unknown>
      }
      if (resumeWithOldDraft && resumed && next?.[0] === 'open') {
        reachedReadBarrier = true
        await nativeReadAllowed
      }
      let args: Record<string, unknown> = {}
      if (next?.[0] === 'open') args = { url: 'https://feed.test/list' }
      if (next?.[1] === 'publish_artifact') {
        const read = next[0] === 'publish-cached' ? undefined : result('read')
        const ref = read ? { url: read.sourceUrl, resultHash: read.resultHash } : cachedSourceRef!
        if (!resumed) cachedSourceRef = ref
        args = reportFor(ref, next[0] !== 'publish')
      }
      if (next?.[1] === 'read_artifact') args = { path: 'recovered-feed.html' }
      if (next?.[0] === 'verify') args = result('publish').verificationInput as Record<string, unknown>
      if (next?.[0].startsWith('verify-bad-')) args = result(next[0].replace('verify-', 'publish-')).verificationInput as Record<string, unknown>
      const delta = next ? { tool_calls: [{ index: 0, id: prefix + next[0], type: 'function',
        function: { name: next[1], arguments: JSON.stringify(args) } }] } :
        { content: '已保存并核验订阅列表HTML，按每日09:00建立并读回计划，Ego任务空间已完成收尾。列表正文、预算与资质未核验。' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'offline-closed-space', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
    const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'),
      runtimeToken: 'offline', apiKey: 'offline-model-fixture', baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
      endpointFormat: 'chat_completions', model: 'offline', approvalPolicy: 'on-request', sandboxMode: 'read-only',
      insecure: false, tokenEconomyMode: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({ egoBrowser: {
        state: 'installed', executablePath: '/controlled/ego-browser', executableHash: 'a'.repeat(64), version: '0.6.3.14', revision: 0 } }) })
    cleanup.push(async () => runtime.shutdown?.())
    cleanup.push(async () => releaseNativeRead())
    const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'offline', approvalPolicy: 'on-request' })
    const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'closed-space-original', request: {
      prompt: '每天09:00使用Ego浏览器只读 https://feed.test/list 我已订阅的招标列表，按工程测量、测绘、监测筛选汇总为HTML，只核对列表，不需要公告正文。' } })
    const taskId = started.task!.id, repo = runtime.taskRepository!
    await expect.poll(() => repo.get(taskId)?.status, { timeout: 5000 }).toBe('waiting_user')
    const before = repo.get(taskId)!, oldTurnId = before.activeTurnId!, oldBinding = repo.operation(taskId, 'ego-task-space')!
    await expect.poll(async () => (await runtime.threadService.get(before.threadId))!.turns.filter(turn => ['queued', 'running'].includes(turn.status)).length, { timeout: 5000 }).toBe(0)
    expect(oldBinding.status).toBe('succeeded'); expect(oldBinding.result).toMatchObject({ taskSpaceId: 27 })
    expect(repo.operations(taskId, 'ego_document_read')).toHaveLength(resumeWithOldDraft ? 2 : 1)
    const priorTools = repo.operations(taskId, 'tool'), oldFailure = repo.operations(taskId, 'web_artifact_evidence').at(-1)
    const oldSemantic = (oldFailure?.result as { semanticRepair?: Record<string, unknown> } | undefined)?.semanticRepair
    const oldDraft = resumeWithOldDraft ? await readFile(before.artifacts[0]!.absolutePath!) : undefined
    if (resumeWithOldDraft) {
      expect(oldSemantic).toMatchObject({ failureCount: 2, stalled: true })
      expect(repo.operations(taskId, 'web_artifact_evidence')).toHaveLength(2)
      closedSpaceSdk.closed = true
    }
    const raw = (owner: string, key: string) => (repo.connection().prepare('SELECT data_json FROM operation_receipts WHERE owner_id=? AND idempotency_key=?').get(owner, key) as { data_json: string }).data_json
    const preserved = repo.operations(taskId).map(receipt => ({ key: receipt.idempotencyKey, raw: raw(taskId, receipt.idempotencyKey) }))
    const unknownOwner = 'unrelated-preserved-unknown'
    repo.create({ ...before, id: unknownOwner, threadId: unknownOwner, activeTurnId: undefined, childTaskIds: [], nodes: [], artifacts: [], status: 'failed' })
    repo.beginOperation({ ownerId: unknownOwner, idempotencyKey: 'old-unknown', kind: 'tool', request: { callId: 'old-unrelated', toolName: 'ego_browser_open' }, nowIso: runtime.nowIso() })
    repo.finishOperation(unknownOwner, 'old-unknown', { status: 'outcome_unknown' }, runtime.nowIso())
    const oldUnknown = raw(unknownOwner, 'old-unknown'), oldGrant = (await runtime.threadService.get(before.threadId))!.turns.find(turn => turn.id === oldTurnId)!.executionGrant!
    if (!resumeWithOldDraft) expect(repo.operations(taskId, 'tool').map(receipt => receipt.status)).toEqual(['succeeded', 'failed'])
    closedSpaceSdk.onStatus = () => {
      expect(repo.operation(taskId, 'explicit-same-task-resume')).toMatchObject({ kind: 'resume', status: 'succeeded' })
      expect(repo.get(taskId)!.activeTurnId).not.toBe(oldTurnId)
    }
    resumed = true
    const continued = await runtime.taskControlService!.mutate(taskId, 'resume', { expectedRevision: repo.get(taskId)!.revision, idempotencyKey: 'explicit-same-task-resume' })
    expect(continued.task.id).toBe(taskId); expect(continued.turn!.turnId).not.toBe(oldTurnId)
    if (resumeWithOldDraft) {
      const premature = () => repo.operations(taskId, 'tool').find(receipt => receipt.request?.turnId === continued.turn!.turnId && receipt.request.callId === 'recovered-publish-cached')
      const output = () => (premature()?.result as { item?: { output?: Record<string, unknown> } } | undefined)?.item?.output
      await expect.poll(() => ({ status: repo.get(taskId)?.status, code: output()?.code, stalled: output()?.stalled }), { timeout: 5000 })
        .toEqual({ status: 'running', code: 'web_source_reads_required', stalled: false })
      expect(output()).toMatchObject({ collectionFreshness: { currentCollectionReady: false }, semanticRepair: oldSemantic })
      expect(premature()!.status).toBe('failed')
      expect(await readFile(before.artifacts[0]!.absolutePath!)).toEqual(oldDraft)
      expect(repo.operations(taskId, 'web_artifact_publication_manifest')).toHaveLength(2)
      expect(repo.get(taskId)!.budget).toEqual(before.budget)
      expect(closedSpaceSdk.calls).toHaveLength(2)
      await expect.poll(() => reachedReadBarrier, { timeout: 5000 }).toBe(true)
      expect(repo.get(taskId)!.status).toBe('running')
      releaseNativeRead()
    }
    await expect.poll(() => ({ status: repo.get(taskId)?.status, codes: repo.operations(taskId, 'tool').slice(priorTools.length).filter(receipt => receipt.status !== 'succeeded').map(receipt => (receipt.result as { item?: { output?: { code?: string } } }).item?.output?.code) }), { timeout: 10000 })
      .toEqual({ status: 'completed', codes: resumeWithOldDraft ? ['web_source_reads_required'] : [] })
    const task = repo.get(taskId)!, bindings = repo.operations(taskId, 'ego_task_space'), currentBinding = bindings.find(binding => binding.id !== oldBinding.id)!
    expect(bindings).toHaveLength(2); expect(currentBinding.status).toBe('succeeded')
    expect(currentBinding.request).toMatchObject({ priorBindingReceiptId: oldBinding.id, createdTurnId: continued.turn!.turnId, origins: oldBinding.request!.origins })
    expect(currentBinding.request!.spaceName).not.toBe(oldBinding.request!.spaceName)
    expect(currentBinding.result).toMatchObject({ taskSpaceId: 28 })
    expect(repo.operations(taskId, 'ego_task_space_reopen')).toEqual([expect.objectContaining({ status: 'succeeded',
      request: expect.objectContaining({ priorBindingReceiptId: oldBinding.id, resumeReceiptId: repo.operation(taskId, 'explicit-same-task-resume')!.id }),
      result: expect.objectContaining({ closed: true, idMatch: false, nameMatches: 0 }) })])
    expect(closedSpaceSdk.calls.filter(call => call.action === 'space_status')).toHaveLength(1)
    expect(closedSpaceSdk.calls.filter(call => call.action === 'open' && !call.spaceId)).toHaveLength(2)
    expect(closedSpaceSdk.finishes).toEqual([28])
    expect(repo.operations(taskId, 'ego_task_space_finish')).toEqual([expect.objectContaining({ status: 'succeeded', request: expect.objectContaining({ bindingReceiptId: currentBinding.id }) })])
    expect(task.nodes.filter(node => ['execute', 'verify', 'deliver'].includes(node.kind)).map(node => [node.kind, node.status])).toEqual([['execute', 'completed'], ['verify', 'completed'], ['deliver', 'completed']])
    expect(task.artifacts).toEqual([expect.objectContaining({ relativePath: 'recovered-feed.html', validation: 'valid', sourceEvidenceStatus: 'verified' })])
    const artifactBytes = await readFile(task.artifacts[0]!.absolutePath!)
    expect(createHash('sha256').update(artifactBytes).digest('hex')).toBe(task.artifacts[0]!.sha256)
    const toolOutput = (name: string) => (repo.operations(taskId, 'tool').filter(receipt => receipt.request?.toolName === name).at(-1)!.result as { item: { output: Record<string, unknown> } }).item.output
    expect(toolOutput('ego_browser_read')).toMatchObject({ evidence: { bindingReceiptId: currentBinding.id, taskSpaceId: 28, turnId: continued.turn!.turnId } })
    expect(toolOutput('verify_web_artifact')).toMatchObject({ complete: true })
    if (resumeWithOldDraft) {
      const reads = repo.operations(taskId, 'ego_document_read')
      expect(new Set(reads.map(read => (read.result as { resultHash: string }).resultHash)).size).toBe(1)
      const evidence = repo.operations(taskId, 'web_artifact_evidence').at(-1)!
      expect(evidence.request?.sourceReceiptIds).not.toEqual(oldFailure!.request?.sourceReceiptIds)
      for (const id of evidence.request!.sourceReceiptIds as string[]) expect(repo.operationById(taskId, id)!.request?.turnId).toBe(continued.turn!.turnId)
    }
    expect(toolOutput('list_schedules')).toMatchObject({ schedules: [expect.objectContaining({ enabled: true, requirement: expect.objectContaining({ kind: 'daily', times: ['09:00'] }) })] })
    const thread = (await runtime.threadService.get(task.threadId))!, grant = thread.turns.find(turn => turn.id === continued.turn!.turnId)!.executionGrant!
    expect(grant.id).not.toBe(oldGrant.id); expect(grant).toMatchObject({ taskId, turnId: continued.turn!.turnId, browserScope: oldGrant.browserScope })
    expect(thread.turns.find(turn => turn.id === oldTurnId)!.executionGrant).toEqual(oldGrant)
    expect(task.budget).toEqual(before.budget); expect(task.attempts).toBe(before.attempts + 1); expect(task.childTaskIds).toEqual(before.childTaskIds)
    for (const receipt of preserved) expect(raw(taskId, receipt.key)).toBe(receipt.raw)
    expect(raw(unknownOwner, 'old-unknown')).toBe(oldUnknown)
    expect(repo.events(taskId).some(event => event.kind === 'task_execution_budget_extended')).toBe(false)
  } finally {
    closedSpaceSdk.onStatus = undefined
    while (cleanup.length) await cleanup.pop()!()
  }
}, 20000)
