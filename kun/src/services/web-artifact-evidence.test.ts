import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskController } from './task-controller.js'
import { TaskRunRepository, operationFingerprint } from './task-run-repository.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem } from '../domain/item.js'
import { ExecutionGrantSchema, type ExecutionGrant } from '../contracts/permissions.js'
import { WebArtifactEvidenceInputSchema } from '../contracts/web-artifact-evidence.js'
import { buildManagedArtifactToolProviders } from '../adapters/tool/managed-artifact-tool-provider.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { assessWebArtifactEvidence } from './web-artifact-evidence.js'
import { renderStructuredWebReport } from './structured-web-report.js'

const roots: string[] = []
const fixtureTime = '2026-11-15T00:00:00.000Z'
beforeEach(() => {
  // The grant, source receipts, and bulletin dates share one deterministic clock.
  // Fake Date only: SQLite/file work and real asynchronous cleanup keep their timers.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(fixtureTime)
})
afterEach(async () => {
  try { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) }
  finally { vi.useRealTimers() }
})
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const origins = ['https://a.example.test', 'https://b.example.test']
const title = '工程测量监测服务项目公开招标公告'
const document = `<article><h1>${title}</h1><p>本项目公告发布日期为2026-11-15。预算金额为100000元。投标文件递交截止时间为2026-12-01。目前状态为正在接受投标。投标人资格要求为测绘资质乙级及以上。</p></article>`
const values = [
  ['title', title, title], ['publication_date', '2026-11-15', '本项目公告发布日期为2026-11-15'],
  ['budget', '100000元', '本项目公告发布日期为2026-11-15。预算金额为100000元'],
  ['deadline', '2026-12-01', '投标文件递交截止时间为2026-12-01'],
  ['status', '正在接受投标', '目前状态为正在接受投标。投标人资格要求为测绘资质乙级及以上'],
  ['qualification', '测绘资质乙级及以上', '投标人资格要求为测绘资质乙级及以上']
] as const
const empty = '<main>工程测量：共找到0条内容</main>'
const discovery = `<main><a href="/notice/1">${title}</a></main>`
function input() {
  return WebArtifactEvidenceInputSchema.parse({ path: 'report.html', coverage: origins.map((url, i) => ({ url: url + '/list', resultHash: sha(i ? empty : discovery) })), noMatches: [{ source: { url: origins[1] + '/list', resultHash: sha(empty) }, query: '工程测量', quote: '工程测量：共找到0条内容' }],
    items: [{ sectionId: 'notice-1', title, source: { url: origins[0] + '/notice/1', resultHash: sha(document) },
      discovery: { url: origins[0] + '/list', resultHash: sha(discovery) }, classification: 'opportunity',
      fields: values.map(([field, value, quote]) => ({ field, value, quote })) }] })
}
function report(extra = '') {
  return `<!doctype html><html lang="zh-CN"><head><title>招标报告</title></head><body><h1>招标报告</h1>${origins.map(origin => `<a href="${origin}/list">检索来源</a>`).join('')}<main data-evidence-report><article id="notice-1" data-evidence-item="notice-1" data-evidence-classification="opportunity">${values.map(([field, value]) => `<span data-evidence-field="${field}">${value}</span>`).join('')}<a data-evidence-source href="${origins[0]}/notice/1">原文</a></article><p>工程测量：共找到0条内容</p>${extra}</main></body></html>`
}
async function fixture(primaryOutput: Record<string, unknown> = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-web-artifact-evidence-')); roots.push(temporary)
  const root = await realpath(temporary), workspace = join(root, '只读 工作区'); await mkdir(workspace)
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')), threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', workspace, title: 'Web source evidence', model: 'synthetic-no-model' }); await threadStore.upsert(thread)
  const now = () => fixtureTime
  const controller = new TaskController({ repository, threadStore, sessionStore, nowIso: now, dataDir: root })
  const task = controller.ensureTask({ thread, turnId: 'old-turn', request: { prompt: '使用浏览器采集两个平台的工程测量招标公告正文并交付 report.html。' } })
  repository.update(task.id, task.revision, current => ({ ...current, acceptance: { ...current.acceptance, requiredSourceOrigins: origins } }))
  let grant: ExecutionGrant
  const bind = async (turnId: string, browserInstanceId: string, revision: number) => {
    grant = ExecutionGrantSchema.parse({ id: `grant-${turnId}`, taskId: task.id, threadId: thread.id, turnId, workspaceRoot: workspace,
      workspaceTrust: 'read-only', agentTrust: 'workspace-write', sandboxMode: 'read-only', approvalPolicy: 'auto', pathAllowlist: [workspace], readPathAllowlist: [workspace], writePathAllowlist: [],
      allowedToolNames: ['browser_get_html', 'publish_artifact', 'read_artifact', 'verify_web_artifact'], managedArtifactRoot: controller.managedArtifactRoot(task.id),
      browserScope: { browserInstanceId, origins, interaction: 'interact', revision }, workspaceRevision: 0, agentRevision: 0, revision: 0,
      idempotencyKey: `grant-${turnId}`, issuedAt: now(), expiresAt: '2026-11-15T00:30:00.000Z' })
    const stored = (await threadStore.get(thread.id))!
    await threadStore.upsert({ ...stored, turns: [...stored.turns, { ...createTurnRecord({ id: turnId, threadId: thread.id, prompt: task.goal }), executionGrant: grant }] })
    const key = `binding-${turnId}`
    repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'browser_binding', request: { browserInstanceId, expectedBrowserRevision: revision }, nowIso: now() })
    repository.finishOperation(task.id, key, { status: 'succeeded', result: { purpose: task.goal, origins, browserInstanceId } }, now())
    controller.beginAttempt(thread.id, turnId)
  }
  await bind('old-turn', 'old-c9', 3)
  let next = 0
  const source = async (url: string, html: string, target?: string) => {
    const call = { callId: `source-${++next}`, toolName: 'browser_get_html', providerId: 'browser-skill', arguments: { sessionId: 'owned', ...(target ? { target } : {}) } }
    const operation = controller.beginToolOperation(grant.turnId, call, grant)!
    await sessionStore.appendItem(thread.id, makeToolCallItem({ id: `call-${call.callId}`, threadId: thread.id, turnId: grant.turnId, ...call }))
    const item = makeToolResultItem({ id: `item-${call.callId}`, threadId: thread.id, turnId: grant.turnId, callId: call.callId, toolName: call.toolName,
      output: { status: 'succeeded', sourceUrl: url, html, resultHash: sha(html), truncated: false, readScope: target ? 'element' : 'document', evidence: { verified: true, contentRead: true }, ...(url.endsWith('/notice/1') ? primaryOutput : {}) } })
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await sessionStore.appendItem(thread.id, item)
  }
  const tools = buildManagedArtifactToolProviders(controller)[0]!.tools
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.name === toolName)!, call = { callId: `artifact-${++next}`, toolName, providerId: 'managed-artifacts', arguments: args }
    const operation = controller.beginToolOperation(grant.turnId, call, grant)!
    const context: ToolHostContext = { threadId: thread.id, turnId: grant.turnId, workspace, threadMode: 'agent', sandboxMode: 'read-only', approvalPolicy: 'auto',
      abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', executionGrant: grant,
      currentToolOperation: () => controller.currentToolOperation(operation.token, operation.key, call, grant) }
    tool.validateArguments?.(args, context)
    const result = await tool.execute(args, context), item = makeToolResultItem({ id: `item-${call.callId}`, threadId: thread.id, turnId: grant.turnId, callId: call.callId,
      toolName, output: result.output, isError: result.isError, toolKind: tool.toolKind })
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await sessionStore.appendItem(thread.id, item)
    return (item as { output: unknown }).output as Record<string, unknown>
  }
  await source(origins[0] + '/list', discovery, 'e1'); await source(origins[1] + '/list', empty, 'e1'); await source(origins[0] + '/notice/1', document)
  const proof = input()
  const publication = await call('publish_artifact', { path: 'report.html', report: { title: '招标报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } })
  const current = repository.get(task.id)!; controller.pauseTask(task.id, current.revision); controller.prepareResume(task.id, repository.get(task.id)!.revision)
  controller.ensureTask({ thread: (await threadStore.get(thread.id))!, turnId: 'new-turn', continuationTaskId: task.id, request: { prompt: '继续核验同一报告。' } })
  await bind('new-turn', 'current-f84', 4)
  await sessionStore.appendItem(thread.id, makeAssistantTextItem({ id: 'final', threadId: thread.id, turnId: grant!.turnId, text: 'HTML 报告已保存并核对来源。', status: 'completed' }))
  return { repository, threadStore, sessionStore, thread, task, controller, call, root, publication, path: join(controller.managedArtifactRoot(task.id)!, 'report.html'),
    source, async assessment(html: string, proof = input()) { return assessWebArtifactEvidence(repository, repository.get(task.id)!, await sessionStore.loadItems(thread.id), (await threadStore.get(thread.id))!.turns, html, proof) } }
}

it('keeps the exact publication manifest private and restores it across a legitimate Turn and controller/database restart', async () => {
  const f = await fixture()
  let reopened: TaskRunRepository | undefined
  try {
    const exact = input(), primaryUrl = `${origins[0]}/notice/1?articleId=article-one&category=public`, observedDiscovery = `<main><a href="${primaryUrl}">${title}</a></main>`
    await f.source(`${origins[0]}/list`, observedDiscovery, 'e1'); await f.source(primaryUrl, document)
    exact.coverage[0]!.resultHash = sha(observedDiscovery)
    exact.items[0]!.discovery.resultHash = sha(observedDiscovery)
    exact.items[0]!.source.url = primaryUrl
    const publication = await f.call('publish_artifact', { path: exact.path, report: { title: '查询参数原文报告', evidence: { coverage: exact.coverage, items: exact.items, noMatches: exact.noMatches } } })
    const request = publication.verificationInput as { path: string; manifestRef: string }
    expect(request).toEqual({ path: 'report.html', manifestRef: expect.stringMatching(/^web-manifest:[a-f0-9]{64}$/) })
    expect(publication.verificationInputHash).toBe(operationFingerprint(exact))
    expect(JSON.stringify(request)).not.toContain('https:')
    expect(f.repository.operation(f.task.id, request.manifestRef)?.request?.input).toEqual(exact)
    expect(await f.controller.resolveWebArtifactPublicationManifest(f.task.id, 'new-turn', request.path, request.manifestRef, String(publication.sha256))).toEqual(exact)
    const current = f.repository.get(f.task.id)!
    f.controller.pauseTask(f.task.id, current.revision)
    f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
    f.repository.close()
    reopened = new TaskRunRepository(join(f.root, 'tasks.sqlite3'))
    const restarted = new TaskController({ repository: reopened, threadStore: f.threadStore, sessionStore: f.sessionStore, nowIso: () => fixtureTime, dataDir: f.root })
    const thread = (await f.threadStore.get(f.thread.id))!, priorGrant = thread.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const grant = ExecutionGrantSchema.parse({ ...priorGrant, id: 'grant-restored', turnId: 'restored-turn', idempotencyKey: 'restored-grant' })
    await f.threadStore.upsert({ ...thread, turns: [...thread.turns, { ...createTurnRecord({ id: 'restored-turn', threadId: thread.id, prompt: '继续核验同一草稿。' }), executionGrant: grant }] })
    restarted.ensureTask({ thread: (await f.threadStore.get(thread.id))!, turnId: 'restored-turn', continuationTaskId: f.task.id, request: { prompt: '继续核验同一草稿。' } })
    restarted.beginAttempt(thread.id, 'restored-turn')
    const restored = await restarted.resolveWebArtifactPublicationManifest(f.task.id, 'restored-turn', request.path, request.manifestRef, String(publication.sha256))
    expect(restored).toEqual(exact)
    expect(await restarted.verifyWebArtifact(f.task.id, 'restored-turn', f.path, String(publication.sha256), await readFile(f.path, 'utf8'), restored)).toMatchObject({ complete: true })
  } finally { (reopened ?? f.repository).close() }
})

it.each(['cross-task', 'cross-path', 'forged-reference', 'changed-bytes', 'changed-source', 'expired-current-grant', 'changed-writer-provider', 'rewritten-identical-bytes'] as const)('does not restore a sealed manifest after %s', async variation => {
  const f = await fixture(), request = f.publication.verificationInput as { path: string; manifestRef: string }
  try {
    let taskId = f.task.id, path = request.path, ref = request.manifestRef, hash = String(f.publication.sha256)
    if (variation === 'cross-task') taskId = 'other-task'
    if (variation === 'cross-path') path = 'different.html'
    if (variation === 'forged-reference') ref = `web-manifest:${'f'.repeat(64)}`
    if (variation === 'changed-bytes') {
      await writeFile(f.path, '<html><body>changed draft</body></html>')
      await expect(f.call('verify_web_artifact', request)).rejects.toMatchObject({ code: 'artifact_manifest_scope' })
      return
    }
    if (variation === 'changed-source' || variation === 'changed-writer-provider') {
      const original = f.repository.operations(f.task.id, 'tool').find(row => row.request?.toolName === (variation === 'changed-source' ? 'browser_get_html' : 'publish_artifact'))!
      const changed = variation === 'changed-source' ? { ...original, status: 'failed' } : { ...original, request: { ...original.request, providerId: 'untrusted-mcp' } }
      const isolated = new Database(join(f.root, 'tasks.sqlite3'))
      try { isolated.prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?').run(JSON.stringify(changed), changed.ownerId, changed.idempotencyKey) } finally { isolated.close() }
    }
    if (variation === 'expired-current-grant') {
      const thread = (await f.threadStore.get(f.thread.id))!
      await f.threadStore.upsert({ ...thread, turns: thread.turns.map(turn => turn.id === 'new-turn' ? { ...turn, executionGrant: { ...turn.executionGrant!, expiresAt: fixtureTime } } : turn) })
    }
    if (variation === 'rewritten-identical-bytes') {
      const proof = input()
      const rewritten = await f.call('publish_artifact', { path: 'report.html', report: { title: '招标报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } })
      hash = String(rewritten.sha256)
      expect(hash).toBe(f.publication.sha256)
    }
    await expect(f.controller.resolveWebArtifactPublicationManifest(taskId, 'new-turn', path, ref, hash)).rejects.toMatchObject({
      code: variation === 'cross-task' ? 'execution_grant_scope' : variation === 'changed-source' ? 'artifact_manifest_source_proof_required' : 'artifact_manifest_scope' })
    expect(f.repository.get(f.task.id)?.status).not.toBe('completed')
  } finally { f.repository.close() }
})

it('does not seal a model or MCP manifest without the actual prepared built-in publication operation', async () => {
  const f = await fixture()
  try {
    const proof = input(), args = { path: proof.path, report: { title: '招标报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } }
    await expect(f.controller.recordWebArtifactPublicationManifest(f.task.id, 'new-turn', proof.path, String(f.publication.sha256), proof, args)).rejects.toMatchObject({ code: 'artifact_manifest_writer_required' })
    const thread = (await f.threadStore.get(f.thread.id))!, grant = thread.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const call = { callId: 'counterfeit', toolName: 'publish_artifact', providerId: 'untrusted-mcp', arguments: args }
    const operation = f.controller.beginToolOperation('new-turn', call, grant)!
    const counterfeitHost = f.controller.currentToolOperation(operation.token, operation.key, call, grant)
    await expect(f.controller.recordWebArtifactPublicationManifest(f.task.id, 'new-turn', proof.path, String(f.publication.sha256), proof, args, counterfeitHost)).rejects.toMatchObject({ code: 'artifact_manifest_writer_required' })
  } finally { f.repository.close() }
})

it('cannot activate a sealed manifest before the original managed writer has actually succeeded', async () => {
  const f = await fixture()
  try {
    const proof = input(), args = { path: proof.path, report: { title: '招标报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } }
    const grant = (await f.threadStore.get(f.thread.id))!.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const call = { callId: 'unsettled-writer', toolName: 'publish_artifact', providerId: 'managed-artifacts', arguments: args }
    const operation = f.controller.beginToolOperation('new-turn', call, grant)!
    f.controller.recordToolDispatch(operation.token, operation.key)
    const host = f.controller.currentToolOperation(operation.token, operation.key, call, grant)
    const sealed = await f.controller.recordWebArtifactPublicationManifest(f.task.id, 'new-turn', proof.path, String(f.publication.sha256), proof, args, host)
    await expect(f.controller.resolveWebArtifactPublicationManifest(f.task.id, 'new-turn', proof.path, sealed.verificationInput.manifestRef, String(f.publication.sha256))).rejects.toMatchObject({ code: 'artifact_manifest_scope' })
    expect(f.repository.get(f.task.id)?.status).not.toBe('completed')
  } finally { f.repository.close() }
})

it('requires exact source-linked evidence before completion, then reuses legitimate prior-Turn/retired-browser reads', async () => {
  const f = await fixture()
  try {
    expect((await f.controller.assessCandidate(f.thread.id, 'new-turn')).kind).toBe('continue')
    expect(f.repository.get(f.task.id)?.status).toBe('retrying')
    f.controller.beginAttempt(f.thread.id, 'new-turn')
    const proof = await f.call('verify_web_artifact', input()); expect(proof.reasons).toEqual([]); expect(proof).toMatchObject({ complete: true, artifactHash: expect.stringMatching(/^[a-f0-9]{64}$/) }); expect(proof.sourceReceipts).toHaveLength(3)
    expect(await f.controller.assessCandidate(f.thread.id, 'new-turn')).toMatchObject({ kind: 'completed' })
    expect(f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'publish_artifact')).toHaveLength(1)
  } finally { f.repository.close() }
})

it('registers a source-ready report as a draft with idempotent writer events until full report verification', async () => {
  const f = await fixture()
  try {
    const proof = input()
    await f.call('publish_artifact', { path: 'report.html', report: { title: '招标报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } })
    const writer = f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'publish_artifact').at(-1)!
    const token = f.controller.tokenForTurn('new-turn')!
    expect(await f.controller.recordArtifactPublication(token, writer.idempotencyKey)).toBe(true)
    const saved = f.repository.get(f.task.id)!
    expect(saved).toMatchObject({ status: 'running', artifacts: [{ sourceEvidenceStatus: 'draft', validation: 'valid' }] })
    const revision = saved.revision
    expect(await f.controller.recordArtifactPublication(token, writer.idempotencyKey)).toBe(true)
    expect(f.repository.get(f.task.id)!.revision).toBe(revision)
    expect(f.repository.events(f.task.id).filter(event => event.kind === 'artifact_published')).toHaveLength(1)
  } finally { f.repository.close() }
})

it('blocks the publish/verify rewrite loop before any new report write when a required origin lacks a primary document', async () => {
  const f = await fixture()
  try {
    const oldBytes = await readFile(f.path, 'utf8'), current = f.repository.get(f.task.id)!
    const missing = 'https://government.example.test'
    f.repository.update(current.id, current.revision, value => ({ ...value, acceptance: { ...value.acceptance, requiredSourceOrigins: [...origins, missing] } }))
    for (let index = 0; index < 13; index++) {
      const proof = input()
      const result = await f.call('publish_artifact', { path: `report-${index}.html`, report: { title: `改名与改标题仍不能代替来源 ${index}`,
        evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } })
      expect(['web_source_reads_required', 'web_artifact_repair_stalled']).toContain(result.code)
      expect(result.missingOrigins).toContain(missing)
      expect(result).toMatchObject({ stalled: index > 0 })
      expect(result).not.toHaveProperty('bytes_written')
      expect(result.nextReads).toEqual([])
    }
    expect(await readFile(f.path, 'utf8')).toBe(oldBytes)
    await expect(stat(join(f.controller.managedArtifactRoot(f.task.id)!, 'report-0.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'publish_artifact' && row.status === 'succeeded')).toHaveLength(1)
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, 'new-turn')).toMatchObject({ code: 'web_artifact_repair_stalled', stalled: true })
  } finally { f.repository.close() }
})

it('allows one field repair then persists a semantic blocker that publishing different HTML cannot clear', async () => {
  const f = await fixture()
  try {
    const invalid = input()
    invalid.items[0]!.fields.find(field => field.field === 'budget')!.quote = '不存在的预算依据写着100000元，但实际正文没有此句。'
    const first = await f.call('verify_web_artifact', invalid)
    expect(first).toMatchObject({ complete: false, semanticRepair: { failureCount: 1, stalled: false } })
    await f.call('publish_artifact', { path: 'report.html', content: report().replace('<head>', '<head><style>body{color:#123}</style>') })
    const second = await f.call('verify_web_artifact', invalid)
    expect(second).toMatchObject({ complete: false, code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 2, stalled: true } })
    expect(second.reasons).toEqual(first.reasons)
    const saved = await readFile(f.path, 'utf8')
    const blocked = await f.call('publish_artifact', { path: 'renamed-report.html', content: report().replace('<head>', '<head><style>body{color:#456}</style>') })
    expect(blocked).toMatchObject({ code: 'web_artifact_repair_stalled', reasons: first.reasons })
    expect(await readFile(f.path, 'utf8')).toBe(saved)
    await expect(stat(join(f.controller.managedArtifactRoot(f.task.id)!, 'renamed-report.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, 'new-turn')).toMatchObject({ code: 'web_artifact_repair_stalled', reasons: first.reasons })
    await f.source(origins[0] + '/notice/1', document)
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, 'new-turn')).toMatchObject({ stalled: true })
    await f.source(origins[0] + '/notice/1', document + '<p>新增真实来源读取内容。</p>')
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, 'new-turn')).toBeNull()
    expect(await f.call('publish_artifact', { path: 'report.html', content: report() })).not.toHaveProperty('code')
  } finally { f.repository.close() }
})

it('requires typed source declarations for a first web report and permits legacy content only with its own trusted verification input', async () => {
  const f = await fixture()
  try {
    const current = f.repository.get(f.task.id)!
    f.repository.update(current.id, current.revision, task => ({ ...task, acceptance: { ...task.acceptance, requiredSourceOrigins: [origins[0]] } }))
    const blocked = await f.call('publish_artifact', { path: 'first-web.html', content: report() })
    expect(blocked).toMatchObject({ code: 'web_source_reads_required', reportManifestRequired: true })
    expect(String(blocked.message)).toContain('report结构化模式')
    await expect(stat(join(f.controller.managedArtifactRoot(f.task.id)!, 'first-web.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    const proof = { ...input(), path: 'first-web.html', coverage: input().coverage.slice(0, 1), noMatches: [] }
    expect(await f.call('publish_artifact', { path: proof.path, report: { title: '招标报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } })).toHaveProperty('bytes_written')
    expect(await f.call('verify_web_artifact', proof)).toMatchObject({ complete: true })
    expect(await f.call('publish_artifact', { path: proof.path, content: report() })).toHaveProperty('bytes_written')
    const unrelated = await f.call('publish_artifact', { path: 'unrelated-copy.html', content: report() })
    expect(unrelated).toMatchObject({ reportManifestRequired: true })
    expect(unrelated).not.toHaveProperty('bytes_written')
  } finally { f.repository.close() }
})

it('does not suspend a task because an arbitrary tool result claims semanticRepair.stalled', async () => {
  const f = await fixture()
  try {
    f.repository.beginOperation({ ownerId: f.task.id, kind: 'tool', idempotencyKey: 'untrusted-marker',
      request: { toolName: 'mcp_fake_marker' }, nowIso: fixtureTime })
    f.repository.finishOperation(f.task.id, 'untrusted-marker', { status: 'failed', result: { code: 'web_artifact_repair_stalled',
      semanticRepair: { stalled: true, failureCount: 99 }, reasons: ['模型或MCP自报阻断'] } }, fixtureTime)
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toBeNull()
    expect(f.repository.get(f.task.id)?.status).toBe('running')
    expect(f.repository.attention(`web_evidence_${f.task.id}`)).toBeNull()
  } finally { f.repository.close() }
})

it('suspends only a trusted persisted semantic stall, keeps its draft and records one concrete attention item', async () => {
  const f = await fixture()
  try {
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toBeNull()
    const invalid = input(); invalid.items[0]!.fields.find(field => field.field === 'budget')!.quote = '原文没有这段预算100000元的伪造说法。'
    await f.call('verify_web_artifact', invalid)
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toBeNull()
    await f.call('publish_artifact', { path: 'report.html', content: report().replace('<head>', '<head><style>body{color:teal}</style>') })
    const failed = await f.call('verify_web_artifact', invalid), bytes = await readFile(f.path, 'utf8')
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toMatchObject({ kind: 'waiting_user', task: { status: 'waiting_user' } })
    const attention = f.repository.attention(`web_evidence_${f.task.id}`)
    expect(attention).toMatchObject({ status: 'pending', payload: { kind: 'web_artifact_repair_stalled', code: 'web_artifact_repair_stalled', reasons: failed.reasons } })
    expect(await readFile(f.path, 'utf8')).toBe(bytes)
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toBeNull()
    expect(f.repository.events(f.task.id).filter(event => event.kind === 'task_completed' || event.kind === 'task_stalled')).toHaveLength(0)
    expect(f.repository.events(f.task.id).filter(event => event.kind === 'task_waiting_user')).toHaveLength(1)
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').filter(row => row.status === 'failed')).toHaveLength(2)
  } finally { f.repository.close() }
})

it('returns only observed missing-source hrefs within the original browser scope', async () => {
  const f = await fixture({ readScope: 'response_document' })
  try {
    await f.source(origins[0] + '/list', discovery + '<a href="https://outside.example.test/guessed-api">外部链接</a>', 'e1')
    const result = await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', 'report.html', input())
    expect(result).toMatchObject({ ready: false, missingOrigins: [origins[0]] })
    expect(result?.nextReads.map(read => read.url)).toEqual([origins[0] + '/notice/1'])
  } finally { f.repository.close() }
})

it('keeps ordinary local HTML and SVG creation outside the web source gate', async () => {
  const f = await fixture()
  try {
    const current = f.repository.get(f.task.id)!
    f.repository.update(current.id, current.revision, task => ({ ...task, acceptance: { ...task.acceptance, requiresWebEvidence: false } }))
    expect(await f.call('publish_artifact', { path: 'local.html', content: '<h1>本地创作</h1>' })).toHaveProperty('bytes_written')
    expect(await f.call('publish_artifact', { path: 'chart.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>' })).toHaveProperty('bytes_written')
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, 'new-turn')).toBeNull()
  } finally { f.repository.close() }
})

it.each(['missing-direct-link', 'index-as-detail', 'forged-quote', 'forged-hash', 'unregistered-item', 'unregistered-field', 'unmarked-row', 'unmarked-prose', 'data-href-is-not-href'])('rejects incomplete or fabricated report provenance: %s', async variation => {
  const f = await fixture()
  try {
    const proof = input(); let html = report()
    if (variation === 'missing-direct-link') html = html.replace('data-evidence-source href=', 'data-evidence-source data-href=')
    if (variation === 'index-as-detail') proof.items[0]!.source = proof.items[0]!.discovery
    if (variation === 'forged-quote') proof.items[0]!.fields[1]!.quote = '这段内容没有被实际平台正文读取并核验。'
    if (variation === 'forged-hash') proof.items[0]!.source.resultHash = 'f'.repeat(64)
    if (variation === 'unregistered-item') html = report('<article data-evidence-item="fake">虚构的另一条招标</article>')
    if (variation === 'unregistered-field') html = report().replace('</article>', '<span data-evidence-field="other">没有来源的预算</span></article>')
    if (variation === 'unmarked-row') html = report('<table><tr><td>未经验证的第七条招标</td></tr></table>')
    if (variation === 'unmarked-prose') html = report('<p>另有七条未经原文验证的项目均可投标。</p>')
    if (variation === 'data-href-is-not-href') { proof.items[0]!.discovery.resultHash = sha(discovery.replace('href=', 'data-href=')) }
    expect((await f.assessment(html, proof)).complete).toBe(false)
  } finally { f.repository.close() }
})

it('invalidates a proof after the exact file or requested goal changes without deleting the draft', async () => {
  const f = await fixture()
  try {
    const proof = await f.call('verify_web_artifact', input()); expect(proof.reasons).toEqual([]); expect(proof.complete).toBe(true)
    const current = f.repository.get(f.task.id)!
    f.repository.update(current.id, current.revision, task => ({ ...task, goal: task.goal + '并核对另一项目。' }))
    expect((await f.controller.assessCandidate(f.thread.id, 'new-turn')).kind).not.toBe('completed')
    expect(await readFile(f.path, 'utf8')).toContain(title)
    await writeFile(f.path, report('<p>外部修改</p>'))
    expect((await f.controller.assessCandidate(f.thread.id, 'new-turn')).kind).not.toBe('completed')
  } finally { f.repository.close() }
})

it('rejects an expired execution grant without making the fixture depend on the host clock', async () => {
  const f = await fixture()
  try {
    vi.setSystemTime('2026-11-15T00:41:00.000Z')
    await expect(f.call('verify_web_artifact', input())).rejects.toMatchObject({ code: 'execution_grant_expired' })
    vi.setSystemTime(fixtureTime)
    expect(await f.call('verify_web_artifact', input())).toMatchObject({ complete: true })
  } finally { f.repository.close() }
})


it('keeps exact SPA fragment routes distinct, while a plain anchor cannot invent a primary document', async () => {
  const f = await fixture()
  try {
    const proof = input(), listing = origins[0] + '/#/list', detail = origins[0] + '/#/notice/1', discovery = `<a href="#/notice/1">${title}</a>`
    await f.source(listing, discovery, 'e1'); await f.source(detail, document)
    proof.coverage[0] = { url: listing, resultHash: sha(discovery) }; proof.items[0]!.discovery = proof.coverage[0]; proof.items[0]!.source = { url: detail, resultHash: sha(document) }
    const html = report().replaceAll(origins[0] + '/list', listing).replaceAll(origins[0] + '/notice/1', detail)
    expect((await f.assessment(html, proof)).reasons).toEqual([])
    proof.items[0]!.source = { url: listing + '#invented', resultHash: sha(discovery) }
    expect((await f.assessment(html, proof)).complete).toBe(false)
  } finally { f.repository.close() }
})

it.each(['missing-second-document', 'expired-deadline', 'invalid-deadline', 'nonfinite-receipt', 'nonfinite-binding', 'forged-fingerprint'])('does not complete a bounded invalid source set: %s', async variation => {
  const f = await fixture()
  try {
    const proof = input(); let html = report()
    if (variation === 'missing-second-document') proof.noMatches = []
    if (variation === 'expired-deadline' || variation === 'invalid-deadline') {
      const value = variation === 'expired-deadline' ? '2025-12-01' : '2026-02-31', body = document.replaceAll('2026-12-01', value)
      await f.source(origins[0] + '/notice/1', body)
      proof.items[0]!.source.resultHash = sha(body)
      const field = proof.items[0]!.fields.find(field => field.field === 'deadline')!; field.value = value; field.quote = field.quote.replace('2026-12-01', value)
      html = html.replaceAll('2026-12-01', value)
    }
    if (['nonfinite-receipt', 'nonfinite-binding', 'forged-fingerprint'].includes(variation)) {
      const kind = variation === 'nonfinite-binding' ? 'browser_binding' : 'tool'
      const source = f.repository.operations(f.task.id, kind).find(row => variation === 'nonfinite-binding' || row.request?.toolName === 'browser_get_html')!
      const raw = { ...source, ...(variation === 'forged-fingerprint' ? { fingerprint: 'f'.repeat(64) } : { updatedAt: 'not-a-time' }) }
      // Corrupt only this isolated SQLite row; never the real acceptance profile.
      const isolated = new Database(join(f.root, 'tasks.sqlite3')); try { isolated.prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?').run(JSON.stringify(raw), raw.ownerId, raw.idempotencyKey) } finally { isolated.close() }
    }
    expect((await f.assessment(html, proof)).complete).toBe(false)
  } finally { f.repository.close() }
})


it('bounds report parsing before scanning arbitrary oversized node trees', async () => {
  const f = await fixture()
  try { expect(await f.assessment(report('<span></span>'.repeat(5001)))).toMatchObject({ complete: false, reasons: [expect.stringContaining('5000')] }) } finally { f.repository.close() }
})


it.each(['configured-observe', 'missing-identity', 'wrong-provider'])('preserves only authenticated configured read-only source history without inventing an interaction binding: %s', async variation => {
  const f = await fixture()
  try {
    const thread = (await f.threadStore.get(f.thread.id))!, old = thread.turns.find(turn => turn.id === 'old-turn')!
    const grant = ExecutionGrantSchema.parse({ ...old.executionGrant!, browserScope: { ...old.executionGrant!.browserScope!, interaction: 'observe' as const },
      connectorIdentityFingerprints: variation === 'missing-identity' ? {} : { 'browser-skill': 'c'.repeat(64) },
      allowedProviderIds: variation === 'wrong-provider' ? ['builtin'] : ['browser-skill', 'managed-artifacts'] })
    await f.threadStore.upsert({ ...thread, turns: thread.turns.map(turn => turn.id === old.id ? { ...turn, executionGrant: grant } : turn) })
    const isolated = new Database(join(f.root, 'tasks.sqlite3'))
    try {
      for (const row of f.repository.operations(f.task.id, 'tool').filter(row => row.request?.turnId === old.id && row.request.toolName === 'browser_get_html')) {
        const request = { ...row.request, executionGrant: grant }
        isolated.prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?').run(JSON.stringify({ ...row, request, fingerprint: operationFingerprint(request) }), row.ownerId, row.idempotencyKey)
      }
      // The initial production observe configuration had no separate browser-binding workflow.
      isolated.prepare('DELETE FROM operation_receipts WHERE owner_id=? AND idempotency_key=?').run(f.task.id, 'binding-old-turn')
    } finally { isolated.close() }
    expect((await f.assessment(report())).complete).toBe(variation === 'configured-observe')
    expect(f.repository.operations(f.task.id, 'browser_action_dispatch')).toHaveLength(0)
    expect(f.repository.operations(f.task.id, 'browser_action_authorization')).toHaveLength(0)
  } finally { f.repository.close() }
})

it.each(['legacy-inert-bridge', 'real-identity-changed', 'other-provider-changed', 'bad-authority-seal'] as const)('preserves sealed legacy occurrence source provenance only for an inert bridge projection: %s', async variation => {
  const f = await fixture()
  try {
    const sourceId = 'legacy-source-task', scheduleId = `schedule_${sourceId}`, scopeHash = sha('legacy-scope'), versionId = 'published-legacy-version', dueAt = fixtureTime
    const task = f.repository.get(f.task.id)!, thread = (await f.threadStore.get(f.thread.id))!, old = thread.turns.find(turn => turn.id === 'old-turn')!
    f.repository.create({ ...task, id: sourceId, threadId: 'source-thread', activeTurnId: undefined, scheduledBy: undefined, nodes: [], artifacts: [] })
    const oldIdentities = { 'mcp:gui_schedule': 'a'.repeat(64), 'browser-skill': variation === 'real-identity-changed' ? 'b'.repeat(64) : 'c'.repeat(64),
      ...(variation === 'other-provider-changed' ? { 'mcp:gui_schedule_extra': 'a'.repeat(64) } : {}) }
    const authority = { taskId: sourceId, prompt: task.goal,
      scope: { browserScope: old.executionGrant!.browserScope, connectorIdentityFingerprints: oldIdentities, browserScheduleActions: [] }, authorization: { scopeHash } }
    const authorityHash = sha(JSON.stringify(authority))
    f.repository.beginOperation({ ownerId: sourceId, kind: 'schedule_authority', idempotencyKey: 'legacy-authority', request: { scopeHash }, nowIso: fixtureTime })
    f.repository.finishOperation(sourceId, 'legacy-authority', { status: 'succeeded', result: { authority, authorityHash } }, fixtureTime)
    f.repository.beginOperation({ ownerId: thread.id, kind: 'scheduled_task_prepare', idempotencyKey: 'scheduled-task-context',
      request: { scheduleId, versionId, dueAt, authorityHash: variation === 'bad-authority-seal' ? 'f'.repeat(64) : authorityHash }, nowIso: fixtureTime })
    f.repository.finishOperation(thread.id, 'scheduled-task-context', { status: 'succeeded', result: { prepared: true } }, fixtureTime)
    f.repository.update(task.id, task.revision, current => ({ ...current, scheduledBy: { scheduleId, dueAt } }))
    // Import an internally consistent legacy test snapshot. It changes only
    // this isolated SQLite fixture, never a real user receipt or profile.
    const grant = ExecutionGrantSchema.parse({ ...old.executionGrant!, connectorIdentityFingerprints: { 'browser-skill': 'c'.repeat(64),
      ...(variation === 'other-provider-changed' ? { 'mcp:gui_schedule_extra': 'b'.repeat(64) } : {}) }, scheduleScopeHash: scopeHash,
      browserScheduleBinding: { scheduleId, versionId, scopeHash, sourceTaskId: sourceId, actionsHash: sha(JSON.stringify([])) } })
    await f.threadStore.upsert({ ...thread, turns: thread.turns.map(turn => turn.id === old.id ? { ...turn, executionGrant: grant } : turn) })
    f.repository.beginOperation({ ownerId: sourceId, kind: 'browser_binding', idempotencyKey: 'legacy-browser-binding',
      request: { browserInstanceId: grant.browserScope!.browserInstanceId, expectedBrowserRevision: grant.browserScope!.revision }, nowIso: fixtureTime })
    f.repository.finishOperation(sourceId, 'legacy-browser-binding', { status: 'succeeded', result: { purpose: task.goal, origins } }, fixtureTime)
    const isolated = new Database(join(f.root, 'tasks.sqlite3'))
    try {
      for (const row of f.repository.operations(task.id, 'tool').filter(row => row.request?.turnId === old.id && row.request.toolName === 'browser_get_html')) {
        const request = { ...row.request, executionGrant: grant }
        isolated.prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?').run(JSON.stringify({ ...row, request, fingerprint: operationFingerprint(request) }), row.ownerId, row.idempotencyKey)
      }
    } finally { isolated.close() }
    const sealedBefore = JSON.stringify(f.repository.operations(sourceId, 'schedule_authority'))
    expect((await f.assessment(report())).complete).toBe(variation === 'legacy-inert-bridge')
    expect(JSON.stringify(f.repository.operations(sourceId, 'schedule_authority'))).toBe(sealedBefore)
  } finally { f.repository.close() }
})


it.each([
  { sourceKind: 'actual_loaded_response', readScope: 'response_document' },
  { sourceKind: 'actual_loaded_response', readScope: 'document', nativeProof: {} },
  { readScope: 'response_document' },
  { readScope: 'document', nativeProof: {} },
  { sourceKind: 'fullDOM', readScope: 'document' }
])('refuses response-source labels or full-DOM claims without the independent native proof: %j', async primaryOutput => {
  const f = await fixture(primaryOutput)
  try {
    expect((await f.assessment(report())).complete).toBe(false)
    expect((await f.call('verify_web_artifact', input())).complete).toBe(false)
  } finally { f.repository.close() }
})


it('does not extend a verbatim Chinese 14时00分 deadline to the end of that day', async () => {
  const f = await fixture()
  try {
    const raw = '2026年12月1日14时00分', body = document.replaceAll('2026-12-01', raw), proof = input()
    await f.source(origins[0] + '/notice/1', body)
    proof.items[0]!.source.resultHash = sha(body)
    const field = proof.items[0]!.fields.find(field => field.field === 'deadline')!
    field.value = raw; field.quote = field.quote.replace('2026-12-01', raw)
    const html = report().replaceAll('2026-12-01', raw)
    const result = assessWebArtifactEvidence(f.repository, f.repository.get(f.task.id)!, await f.sessionStore.loadItems(f.thread.id), (await f.threadStore.get(f.thread.id))!.turns, html, proof, '2026-12-01T06:01:00.000Z')
    expect(result.reasons).toContainEqual(expect.stringContaining('有效截止时间'))
    expect(result.complete).toBe(false)
  } finally { f.repository.close() }
})


it('round trips the structured manifest through the real unchanged source evidence guards', async () => {
  const f = await fixture()
  try {
    const proof = input(), { path: _path, ...evidence } = proof
    const generated = renderStructuredWebReport(proof.path, { title: '工程测量招标资料', evidence })
    expect(generated.verificationInput).toEqual(proof)
    expect((await f.assessment(generated.content, generated.verificationInput)).complete).toBe(true)
    expect((await f.assessment(generated.content.replace('100000元', '999999元'), generated.verificationInput)).complete).toBe(false)
    const missingRequiredSource = { ...generated.verificationInput, noMatches: [] }
    expect((await f.assessment(generated.content, missingRequiredSource)).reasons).toContainEqual(expect.stringContaining('正式公告正文尚未核验'))
  } finally { f.repository.close() }
})

it('renders unknown fields honestly while preserving title, full source, discovery and required origins', async () => {
  const f = await fixture()
  try {
    const proof = input()
    proof.items[0]!.fields = proof.items[0]!.fields.filter(field => field.field !== 'budget' && field.field !== 'qualification')
    proof.items[0]!.unverifiedFields = ['budget', 'qualification']
    const { path, ...evidence } = proof
    const generated = renderStructuredWebReport(path, { title: '含待核验字段的资料草稿', evidence })
    expect(generated.content).toContain('data-evidence-unverified>待核验')
    expect((await f.assessment(generated.content, generated.verificationInput)).complete).toBe(true)
    const forgedZero = structuredClone(generated.verificationInput)
    forgedZero.noMatches[0]!.quote = '工程测量：共找到0条虚构记录'
    expect((await f.assessment(generated.content, forgedZero)).complete).toBe(false)
  } finally { f.repository.close() }
})


it('round trips entity-represented original values through the real verifier', async () => {
  const f = await fixture()
  try {
    const raw = 'R&amp;D测绘资质乙级及以上', body = document.replaceAll('测绘资质乙级及以上', raw), proof = input()
    await f.source(origins[0] + '/notice/1', body)
    proof.items[0]!.source.resultHash = sha(body)
    const field = proof.items[0]!.fields.find(field => field.field === 'qualification')!
    field.value = raw
    for (const entry of proof.items[0]!.fields) entry.quote = entry.quote.replaceAll('测绘资质乙级及以上', raw)
    const { path, ...evidence } = proof
    const generated = renderStructuredWebReport(path, { title: '原文字段实体测试', evidence })
    expect((await f.assessment(generated.content, generated.verificationInput)).complete).toBe(true)
  } finally { f.repository.close() }
})
