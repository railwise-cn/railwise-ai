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
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem, makeUserItem } from '../domain/item.js'
import { ExecutionGrantSchema, type ExecutionGrant } from '../contracts/permissions.js'
import { WebArtifactEvidenceInputSchema } from '../contracts/web-artifact-evidence.js'
import { buildManagedArtifactToolProviders } from '../adapters/tool/managed-artifact-tool-provider.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { assessWebArtifactEvidence, webArtifactRequirementHash } from './web-artifact-evidence.js'
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
function feedInput() {
  const proof = input(), reference = { url: origins[0] + '/notice/1', resultHash: sha(document) }
  return WebArtifactEvidenceInputSchema.parse({ ...proof, coverage: [reference], noMatches: [], items: [{ ...proof.items[0], source: reference, discovery: reference, classification: 'source' }] })
}
async function fixture(primaryOutput: Record<string, unknown> = {}, basis?: 'observed_feed') {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-web-artifact-evidence-')); roots.push(temporary)
  const root = await realpath(temporary), workspace = join(root, '只读 工作区'); await mkdir(workspace)
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')), threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', workspace, title: 'Web source evidence', model: 'synthetic-no-model' }); await threadStore.upsert(thread)
  const now = () => fixtureTime
  const controller = new TaskController({ repository, threadStore, sessionStore, nowIso: now, dataDir: root })
  const task = controller.ensureTask({ thread, turnId: 'old-turn', request: { prompt: '使用浏览器采集两个平台的工程测量招标公告正文并交付 report.html。' } })
  repository.update(task.id, task.revision, current => ({ ...current, acceptance: { ...current.acceptance, ...(basis ? { webEvidenceBasis: basis } : {}), requiredSourceOrigins: basis ? [origins[0]!] : origins } }))
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
  const source = async (url: string, html: string, target?: string, output: Record<string, unknown> = {}) => {
    const call = { callId: `source-${++next}`, toolName: 'browser_get_html', providerId: 'browser-skill', arguments: { sessionId: 'owned', ...(target ? { target } : {}) } }
    const operation = controller.beginToolOperation(grant.turnId, call, grant)!
    await sessionStore.appendItem(thread.id, makeToolCallItem({ id: `call-${call.callId}`, threadId: thread.id, turnId: grant.turnId, ...call }))
    const item = makeToolResultItem({ id: `item-${call.callId}`, threadId: thread.id, turnId: grant.turnId, callId: call.callId, toolName: call.toolName,
      output: { status: 'succeeded', sourceUrl: url, html, resultHash: sha(html), truncated: false, readScope: target ? 'element' : 'document', evidence: { verified: true, contentRead: true }, ...(url.endsWith('/notice/1') ? primaryOutput : {}), ...output } })
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
  const proof = basis ? feedInput() : input()
  const publication = await call('publish_artifact', { path: 'report.html', report: { title: '招标报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } })
  const current = repository.get(task.id)!; controller.pauseTask(task.id, current.revision); controller.prepareResume(task.id, repository.get(task.id)!.revision)
  controller.ensureTask({ thread: (await threadStore.get(thread.id))!, turnId: 'new-turn', continuationTaskId: task.id, request: { prompt: '继续核验同一报告。' } })
  await bind('new-turn', 'current-f84', 4)
  await sessionStore.appendItem(thread.id, makeAssistantTextItem({ id: 'final', threadId: thread.id, turnId: grant!.turnId, text: 'HTML 报告已保存并核对来源。', status: 'completed' }))
  return { repository, threadStore, sessionStore, thread, task, controller, call, root, publication, path: join(controller.managedArtifactRoot(task.id)!, 'report.html'),
    source, async assessment(html: string, proof = input()) { return assessWebArtifactEvidence(repository, repository.get(task.id)!, await sessionStore.loadItems(thread.id), (await threadStore.get(thread.id))!.turns, html, proof) } }
}

async function observedCollectionFixture(legacyFailures = false, explicitResume = true) {
  const f = await fixture({}, 'observed_feed'), proof = feedInput(), task = f.repository.get(f.task.id)!
  const stored = (await f.threadStore.get(f.thread.id))!, key = 'explicit-collection-continue'
  if (explicitResume) {
    await f.threadStore.upsert({ ...stored, turns: stored.turns.map(turn => turn.id === 'new-turn' ? { ...turn, idempotencyKey: `task:${task.id}:resume:${key}` } : turn) })
    f.repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'resume', request: { expectedRevision: task.revision, idempotencyKey: key }, nowIso: fixtureTime })
    f.repository.finishOperation(task.id, key, { status: 'succeeded', result: { task, turn: { threadId: task.threadId, turnId: 'new-turn', userMessageItemId: 'explicit-user-continue' } } }, fixtureTime)
  }
  const legacySourceFingerprint = operationFingerprint([
    JSON.stringify({ url: origins[0] + '/list', resultHash: sha(discovery), full: false }),
    JSON.stringify({ url: origins[0] + '/notice/1', resultHash: sha(document), full: true })
  ].sort())
  if (legacyFailures) for (let index = 0; index < 2; index++) {
    const idempotencyKey = `legacy-feed-field-failure-${index}`, request = { artifactPath: f.path, artifactHash: f.publication.sha256,
      requirementHash: webArtifactRequirementHash(task), evidenceFingerprint: legacySourceFingerprint, turnId: 'old-turn', input: proof }
    f.repository.beginOperation({ ownerId: task.id, idempotencyKey, kind: 'web_artifact_evidence', request, nowIso: fixtureTime })
    f.repository.finishOperation(task.id, idempotencyKey, { status: 'failed', result: { complete: false, reasons: ['字段缺少正文与成果的精确依据：notice-1/budget'], failureKinds: ['field_evidence:budget'] } }, fixtureTime)
  }
  const oldFailures = f.repository.operations(task.id, 'web_artifact_evidence')
  return { ...f, proof, legacySourceFingerprint, oldFailures }
}

it('refuses an observed-feed old snapshot after explicit Continue before any new publish or verification, while keeping the old draft readable', async () => {
  const f = await observedCollectionFixture()
  try {
    const bytes = await readFile(f.path, 'utf8'), before = f.repository.get(f.task.id)!
    expect(await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', f.proof.path, f.proof)).toMatchObject({ ready: false,
      collectionFreshness: { collectionTurnId: 'new-turn', currentCollectionReady: false } })
    expect(await f.call('publish_artifact', { path: f.proof.path, report: { title: '本轮列表报告', evidence: { coverage: f.proof.coverage, items: f.proof.items, noMatches: f.proof.noMatches } } })).toMatchObject({ ready: false })
    expect(await readFile(f.path, 'utf8')).toBe(bytes)
    const reference = f.publication.verificationInput as { path: string; manifestRef: string }
    expect(await f.controller.resolveWebArtifactPublicationManifest(f.task.id, 'new-turn', reference.path, reference.manifestRef, String(f.publication.sha256))).toEqual(f.proof)
    expect(await f.call('verify_web_artifact', reference)).toMatchObject({ complete: false })
    expect(f.repository.get(f.task.id)!.budget).toEqual(before.budget)
    expect(f.repository.get(f.task.id)!.attempts).toBe(before.attempts)
  } finally { f.repository.close() }
})

it('does not migrate an observed-feed legacy stall into a fresh collection merely by starting or querying the resumed Turn', async () => {
  const f = await observedCollectionFixture(true)
  try {
    const before = JSON.stringify(f.repository.operations(f.task.id)), task = f.repository.get(f.task.id)!
    const gate = await f.controller.webArtifactPublicationGate(task.id, 'new-turn', f.proof.path, f.proof)
    expect(gate).toMatchObject({ ready: false, evidenceFingerprint: f.legacySourceFingerprint, semanticRepair: { failureCount: 2, stalled: true },
      collectionFreshness: { currentCollectionReady: false } })
    expect(JSON.stringify(f.repository.operations(f.task.id))).toBe(before)
    expect(f.repository.get(task.id)).toEqual(task)
  } finally { f.repository.close() }
})

it('admits an explicit new collection with an actual same-hash Host read, seals its new receipt, and keeps repeated same-Turn reads in one repair epoch', async () => {
  const f = await observedCollectionFixture(true)
  try {
    expect(await f.call('publish_artifact', { path: f.proof.path, report: { title: '尚未采集的旧列表', evidence: { coverage: f.proof.coverage, items: f.proof.items, noMatches: f.proof.noMatches } } })).toMatchObject({ code: 'web_source_reads_required', stalled: false, semanticRepair: { failureCount: 2, stalled: true } })
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toBeNull()
    await f.source(origins[0] + '/notice/1', document)
    const gate = await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', f.proof.path, f.proof)
    expect(gate).toMatchObject({ ready: true, collectionFreshness: { currentCollectionReady: true } })
    const publication = await f.call('publish_artifact', { path: f.proof.path, report: { title: '本轮列表报告', evidence: { coverage: f.proof.coverage, items: f.proof.items, noMatches: f.proof.noMatches } } })
    const request = publication.verificationInput as { path: string; manifestRef: string }
    const manifest = f.repository.operation(f.task.id, request.manifestRef)!
    const ids = manifest.request!.sourceProof as Array<{ receiptId: string }>
    expect(ids.every(source => f.repository.operationById(f.task.id, source.receiptId)!.request!.turnId === 'new-turn')).toBe(true)
    const invalid = structuredClone(f.proof); invalid.items[0]!.fields.find(field => field.field === 'budget')!.quote = '预算金额为100001元'
    invalid.items[0]!.fields.find(field => field.field === 'budget')!.value = '100001元'
    expect(await f.call('verify_web_artifact', invalid)).toMatchObject({ complete: false, semanticRepair: { failureCount: 1 } })
    expect(await f.call('verify_web_artifact', invalid)).toMatchObject({ complete: false, semanticRepair: { failureCount: 2, stalled: true } })
    await f.source(origins[0] + '/notice/1', document)
    expect(await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', f.proof.path, invalid)).toMatchObject({ semanticRepair: { failureCount: 2, stalled: true } })
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').filter(row => f.oldFailures.some(old => old.id === row.id))).toEqual(f.oldFailures)
  } finally { f.repository.close() }
})

it('cannot mint a new observed-feed repair epoch from an automatic Turn with no persisted explicit continuation authority', async () => {
  const f = await observedCollectionFixture(true, false)
  try {
    await f.source(origins[0] + '/notice/1', document)
    expect(await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', f.proof.path, f.proof)).toMatchObject({ evidenceFingerprint: f.legacySourceFingerprint, semanticRepair: { failureCount: 2, stalled: true } })
  } finally { f.repository.close() }
})

it('keeps legacy field failures while allowing one current-read repair after the first premature publish, then bounds a second attempt across filenames', async () => {
  const f = await observedCollectionFixture(true)
  try {
    const evidence = { coverage: f.proof.coverage, items: f.proof.items, noMatches: f.proof.noMatches }, before = f.repository.get(f.task.id)!
    expect(await f.call('publish_artifact', { path: 'new-name-one.html', report: { title: '本轮列表', evidence } })).toMatchObject({ code: 'web_source_reads_required', stalled: false,
      collectionFreshness: { currentCollectionReady: false }, semanticRepair: { failureCount: 2, stalled: true } })
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toBeNull()
    expect(f.repository.get(f.task.id)!.status).toBe('running')
    expect(await f.call('publish_artifact', { path: 'new-name-two.html', report: { title: '改名仍非读取', evidence } })).toMatchObject({ stalled: true, collectionReadFailures: 2,
      semanticRepair: { failureCount: 2, stalled: true } })
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toMatchObject({ kind: 'waiting_user', reason: expect.stringContaining('本轮订阅列表尚未重新读取') })
    const waiting = f.repository.get(f.task.id)!
    expect(waiting.waitingReason).not.toMatch(/notice-1|field_evidence|budget/)
    expect(waiting.budget).toEqual(before.budget); expect(waiting.attempts).toBe(before.attempts)
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence')).toEqual(f.oldFailures)
  } finally { f.repository.close() }
})

it('restores a pre-freshness sealed manifest with explicitly legacy source-proof bytes, without turning that history into current collection evidence', async () => {
  const f = await observedCollectionFixture()
  try {
    const source = f.repository.operations(f.task.id, 'tool').find(row => row.request?.turnId === 'old-turn' && row.request.toolName === 'browser_get_html' &&
      (row.result as { item: { output: { sourceUrl: string } } }).item.output.sourceUrl === origins[0] + '/notice/1')!
    const writer = f.repository.operations(f.task.id, 'tool').find(row => row.request?.turnId === 'old-turn' && row.request.toolName === 'publish_artifact')!
    const legacyProof = [{ receiptId: source.id, receiptHash: operationFingerprint({ request: source.request, status: source.status, result: source.result }) }]
    const request = { taskId: f.task.id, threadId: f.thread.id, path: f.proof.path, artifactPath: f.path, artifactHash: f.publication.sha256,
      inputHash: operationFingerprint(f.proof), writerReceiptId: writer.id, requirementHash: webArtifactRequirementHash(f.repository.get(f.task.id)!), input: f.proof, sourceProof: legacyProof }
    const key = `web-manifest:${operationFingerprint(request)}`
    if (!f.repository.operation(f.task.id, key)) {
      f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: key, kind: 'web_artifact_publication_manifest', request, nowIso: fixtureTime })
      f.repository.finishOperation(f.task.id, key, { status: 'succeeded', result: { sealed: true, inputHash: request.inputHash, artifactHash: request.artifactHash } }, fixtureTime)
    }
    expect(Object.keys(legacyProof[0]!)).toEqual(['receiptId', 'receiptHash'])
    expect(await f.controller.resolveWebArtifactPublicationManifest(f.task.id, 'new-turn', f.proof.path, key, String(f.publication.sha256))).toEqual(f.proof)
    expect(await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', f.proof.path, f.proof)).toMatchObject({ ready: false })
    await f.source(origins[0] + '/notice/1', document)
    const assessment = await f.assessment(renderStructuredWebReport(f.proof.path, { title: '本轮列表', evidence: { coverage: f.proof.coverage, items: f.proof.items, noMatches: [] } }, 'observed_feed').content, f.proof)
    expect(assessment.complete).toBe(true)
    expect(assessment.sourceReceipts.every(source => !('startedAt' in source))).toBe(true)
  } finally { f.repository.close() }
})

it.each(['loading', 'empty', 'truncated'] as const)('does not replace the old stalled epoch with an incomplete current %s read', async variation => {
  const f = await observedCollectionFixture(true)
  try {
    await f.source(origins[0] + '/notice/1', document, undefined, variation === 'loading' ? { loadingObserved: true } : variation === 'empty' ? { emptyObserved: true } : { truncated: true })
    expect(await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', f.proof.path, f.proof)).toMatchObject({ evidenceFingerprint: f.legacySourceFingerprint,
      collectionFreshness: { currentCollectionReady: false }, semanticRepair: { failureCount: 2, stalled: true } })
  } finally { f.repository.close() }
})

it('requires every requested origin before projecting a current collection as read', async () => {
  const f = await observedCollectionFixture()
  try {
    const task = f.repository.get(f.task.id)!
    f.repository.update(task.id, task.revision, current => ({ ...current, acceptance: { ...current.acceptance, requiredSourceOrigins: origins } }))
    await f.source(origins[0] + '/notice/1', document)
    expect(await f.controller.observedFeedCollectionContext(task.id, 'new-turn')).toMatchObject({ currentCollectionReady: false })
  } finally { f.repository.close() }
})

it('admits a genuine durable user supplement after a current Host read without letting a queued or recalled input mint an epoch', async () => {
  const f = await observedCollectionFixture(true, false)
  try {
    const task = f.repository.get(f.task.id)!, saved = f.controller.appendInput(task.id, task.revision, 'genuine-user-supplement', '只汇总这次实际读取的列表。')
    await f.source(origins[0] + '/notice/1', document)
    expect(await f.controller.webArtifactPublicationGate(task.id, 'new-turn', f.proof.path, f.proof)).toMatchObject({ semanticRepair: { failureCount: 2, stalled: true } })
    const entries = f.controller.pendingDeliveries(f.thread.id, 'new-turn'), delivery = entries.find(entry => entry.input.id === saved.input.id)!.delivery
    const message = { ...makeUserItem({ id: delivery.messageItemId, threadId: f.thread.id, turnId: 'new-turn', text: saved.input.text }), createdAt: fixtureTime, taskInputId: saved.input.id }
    await f.sessionStore.appendItem(f.thread.id, message)
    const digest = sha(JSON.stringify([message]))
    f.controller.markInputsDelivered('new-turn', [delivery], message.id, digest)
    await f.source(origins[0] + '/notice/1', document)
    expect(await f.controller.webArtifactPublicationGate(task.id, 'new-turn', f.proof.path, f.proof)).toMatchObject({ ready: true, collectionFreshness: { currentCollectionReady: true } })
  } finally { f.repository.close() }
})

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

it.each(['title-value', 'title-quote', 'budget-value', 'raw-arguments'] as const)('rejects %s tampering on the normalized feed manifest under a genuine Host operation', async variation => {
  const f = await observedCollectionFixture()
  try {
    await f.source(origins[0] + '/notice/1', document)
    const proof = structuredClone(f.proof)
    proof.items[0]!.fields = proof.items[0]!.fields.filter(field => field.field !== 'title')
    const args = { path: proof.path, report: { title: '真实原始Host参数', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } }
    const rendered = renderStructuredWebReport(proof.path, args.report, 'observed_feed'), changed = structuredClone(rendered.verificationInput)
    if (variation === 'title-value') changed.items[0]!.fields.find(field => field.field === 'title')!.value = title.slice(0, -1)
    if (variation === 'title-quote') changed.items[0]!.fields.find(field => field.field === 'title')!.quote = `项目名称：${title}`
    if (variation === 'budget-value') changed.items[0]!.fields.find(field => field.field === 'budget')!.value = '1000'
    const grant = (await f.threadStore.get(f.thread.id))!.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const call = { callId: `normalized-${variation}`, toolName: 'publish_artifact', providerId: 'managed-artifacts', arguments: args }
    const operation = f.controller.beginToolOperation('new-turn', call, grant)!
    const host = f.controller.currentToolOperation(operation.token, operation.key, call, grant)
    const before = f.repository.operations(f.task.id, 'web_artifact_publication_manifest'), bytes = await readFile(f.path)
    const claimed = variation === 'raw-arguments' ? { ...args, report: { ...args.report, title: '与真实Host不一致的原始参数' } } : args
    await expect(f.controller.recordWebArtifactPublicationManifest(f.task.id, 'new-turn', proof.path, sha(rendered.content), changed, claimed, host)).rejects.toMatchObject({
      code: variation === 'raw-arguments' ? 'artifact_manifest_writer_required' : 'artifact_manifest_scope' })
    expect(f.repository.operation(f.task.id, operation.key)!.request!.argumentsHash).toBe(operationFingerprint(args))
    expect(f.repository.operations(f.task.id, 'web_artifact_publication_manifest')).toEqual(before)
    expect(await readFile(f.path)).toEqual(bytes)
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

it.each(['other-origin', 'truncated-search', 'homepage', 'element-observation'] as const)('does not clear a missing Gov source failure after %s changes', async variant => {
  const f = await fixture()
  try {
    const gov = origins[0]!, proof = input()
    proof.items[0]!.source.url = gov+'/notice/not-yet-read'
    const args = { path: 'new-report.html', report: { title: '待核验来源报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } }
    const oldBytes = await readFile(f.path, 'utf8')
    expect(await f.call('publish_artifact', args)).toMatchObject({ code: 'web_source_reads_required', semanticRepair: { failureCount: 1, stalled: false } })
    if (variant === 'other-origin') {
      const otherDiscovery = `<main><a href="/notice/other">${title}</a></main>`, otherDocument = document+'<p>另一来源正文。</p>'
      await f.source(origins[1]+'/list-other', otherDiscovery, 'e1')
      await f.source(origins[1]+'/notice/other', otherDocument)
      proof.coverage[1] = { url: origins[1]+'/list-other', resultHash: sha(otherDiscovery) }
      proof.noMatches = []; args.report.evidence.noMatches = proof.noMatches
      proof.items.push({ sectionId: 'notice-other', title,
        source: { url: origins[1]+'/notice/other', resultHash: sha(otherDocument) },
        discovery: { url: origins[1]+'/list-other', resultHash: sha(otherDiscovery) }, classification: 'opportunity',
        fields: values.map(([field, value, quote]) => ({ field, value, quote })), unverifiedFields: [] })
    }
    else if (variant === 'truncated-search') await f.source(gov+'/site/search', '<main>工程测量检索列表。</main>', undefined, { truncated: true })
    else if (variant === 'homepage') await f.source(gov+'/', '<html><body>政府采购首页。</body></html>')
    else await f.source(gov+'/site/detail', '<main>尚未完整核实的观察。</main>', 'e1')
    expect(await f.call('publish_artifact', args)).toMatchObject({ code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 2, stalled: true }, missingOrigins: [gov] })
    expect(await readFile(f.path, 'utf8')).toBe(oldBytes)
    await expect(stat(join(f.controller.managedArtifactRoot(f.task.id)!, args.path))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { f.repository.close() }
})

it('keeps the actual missing-origin deficit when a later publication drops its typed manifest', async () => {
  const f = await fixture()
  try {
    const gov = origins[0]!, proof = input()
    proof.items[0]!.source.url = gov+'/notice/not-yet-read'
    await f.call('publish_artifact', { path: 'new-report.html', report: { title: '待核验来源报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } })
    await f.source(origins[1]+'/list', empty+'<p>列表观察变化。</p>', undefined, { truncated: true })
    expect(await f.call('publish_artifact', { path: 'renamed-report.html', content: report() })).toMatchObject({
      code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 2, stalled: true }
    })
    expect(f.repository.operations(f.task.id, 'web_artifact_source_gate').at(-1)?.result).toMatchObject({
      failureKinds: expect.arrayContaining(['source_manifest_required', `source_origin:${gov}`])
    })
    const decision = await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')
    expect(decision?.task.waitingReason).toContain('尚无已登记成果')
    expect(decision?.task.waitingReason).not.toContain('草稿')
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

it.each(['completed', 'running', 'draft', 'wrong-owner', 'approval', 'other-blocker', 'changed-proof'] as const)(
  'reconciles only the completed Task\'s exact accepted web-source attention at service startup: %s', async boundary => {
    const f = await fixture()
    try {
      expect(await f.call('verify_web_artifact', input())).toMatchObject({ complete: true })
      if (boundary !== 'running') expect(await f.controller.assessCandidate(f.thread.id, 'new-turn')).toMatchObject({ kind: 'completed' })
      if (boundary === 'draft' || boundary === 'changed-proof') {
        const task = f.repository.get(f.task.id)!
        f.repository.update(task.id, task.revision, current => ({ ...current, artifacts: current.artifacts.map(artifact => ({ ...artifact,
          ...(boundary === 'draft' ? { sourceEvidenceStatus: 'draft' as const } : { sha256: 'f'.repeat(64) }) })) }))
      }
      const attention = f.repository.putAttention({ id: `web_evidence_${f.task.id}`, ownerKind: 'task',
        ownerId: boundary === 'wrong-owner' ? 'another-task' : f.task.id, taskId: f.task.id, threadId: f.thread.id,
        kind: boundary === 'approval' ? 'approval' : 'blocked', title: '网页来源核验需要处理', message: '旧来源与字段诊断应保留。',
        status: 'pending', revision: 4, createdAt: fixtureTime, updatedAt: fixtureTime,
        payload: { kind: boundary === 'other-blocker' ? 'permission_required' : 'web_artifact_repair_stalled', reasons: ['旧字段缺少来源'], fingerprint: 'old-repair' } })
      const others = [f.repository.putAttention({ ...attention, id: `capability_${f.task.id}`, kind: 'blocked', payload: { kind: 'capability_required' } }),
        f.repository.putAttention({ ...attention, id: 'another-task-web-attention', ownerId: 'another-task', taskId: 'another-task' })]
      const taskBefore = f.repository.get(f.task.id), operations = JSON.stringify(f.repository.operations(f.task.id)), events = f.repository.events(f.task.id)
      const start = () => new TaskController({ repository: f.repository, threadStore: f.threadStore, sessionStore: f.sessionStore, dataDir: f.root, nowIso: () => fixtureTime })
      start()
      const settled = f.repository.attention(attention.id)!
      if (boundary === 'completed') {
        expect(settled).toMatchObject({ status: 'answered', revision: 5, message: attention.message,
          payload: { ...attention.payload, resolution: { kind: 'completed_web_evidence', taskId: f.task.id, turnId: 'new-turn',
            artifacts: [expect.objectContaining({ sourceEvidenceReceiptId: taskBefore!.artifacts[0]!.sourceEvidenceReceiptId })] } } })
      } else expect(settled).toEqual(attention)
      start()
      expect(f.repository.attention(attention.id)).toEqual(settled)
      expect(f.repository.get(f.task.id)).toEqual(taskBefore)
      expect(JSON.stringify(f.repository.operations(f.task.id))).toBe(operations)
      expect(f.repository.events(f.task.id)).toEqual(events)
      for (const other of others) expect(f.repository.attention(other.id)).toEqual(other)
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

it.each(['列表原文摘录', '匹配依据（列表原文）'])('accepts neutral and legacy feed excerpt captions: %s, while requiring literal owner evidence', async caption => {
  const f = await fixture({}, 'observed_feed')
  try {
    const owner = '业主单位：示例工程建设有限公司', body = document.replace('</article>', `<p>${owner}</p></article>`), proof = feedInput()
    await f.source(origins[0] + '/notice/1', body)
    const reference = { url: origins[0] + '/notice/1', resultHash: sha(body) }
    proof.coverage = [reference]; proof.items[0]!.source = reference; proof.items[0]!.discovery = reference
    proof.items[0]!.fields.push({ field: 'other', value: owner, quote: owner })
    const original = structuredClone(proof), { path, ...evidence } = proof
    const generated = renderStructuredWebReport(path, { title: '订阅列表摘录', evidence }, 'observed_feed')
    const html = generated.content.replace(/<dt>(?:列表原文摘录|匹配依据（列表原文）)<\/dt>/, `<dt>${caption}</dt>`)
    expect(generated.verificationInput).toEqual(original)
    expect(await f.assessment(html, generated.verificationInput)).toMatchObject({ complete: true, reasons: [] })
    const inferred = structuredClone(generated.verificationInput), reason = '符合工程测量监测主营业务'
    inferred.items[0]!.fields.find(field => field.field === 'other')!.value = reason
    expect(await f.assessment(html.replace(owner, reason), inferred)).toMatchObject({ complete: false,
      reasons: expect.arrayContaining(['字段缺少正文与成果的精确依据：notice-1/other']) })
    expect(proof).toEqual(original)
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

it('clears the old-path Gov source blocker after a new exact typed draft supplies its discovered full document', async () => {
  const f = await fixture()
  try {
    const gov = origins[0]!, proof = input(), oldBytes = await readFile(f.path, 'utf8')
    proof.items[0]!.source.url = gov+'/notice/not-yet-read'
    const missing = { path: 'gov-before-read.html', report: { title: '待核验来源报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } }
    expect(await f.call('publish_artifact', missing)).toMatchObject({ code: 'web_source_reads_required', semanticRepair: { failureCount: 1, stalled: false } })
    expect(await f.call('publish_artifact', missing)).toMatchObject({ code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 2, stalled: true }, missingOrigins: [gov] })
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, 'new-turn')).toMatchObject({ code: 'web_artifact_repair_stalled', stalled: true })

    const resolvedDiscovery = `<main><a href="/notice/not-yet-read">${title}</a></main>`
    await f.source(gov+'/list-resolved', resolvedDiscovery, 'e1')
    await f.source(gov+'/notice/not-yet-read', document)
    const exact = input()
    exact.path = 'gov-resolved.html'
    exact.coverage[0] = { url: gov+'/list-resolved', resultHash: sha(resolvedDiscovery) }
    exact.items[0]!.source = { url: gov+'/notice/not-yet-read', resultHash: sha(document) }
    exact.items[0]!.discovery = { url: gov+'/list-resolved', resultHash: sha(resolvedDiscovery) }
    const publication = await f.call('publish_artifact', { path: exact.path, report: { title: '新来源证据草稿', evidence: { coverage: exact.coverage, items: exact.items, noMatches: exact.noMatches } } })
    expect(publication).toMatchObject({ verificationInput: { path: exact.path, manifestRef: expect.stringMatching(/^web-manifest:/) } })
    expect(await readFile(f.path, 'utf8')).toBe(oldBytes)
    expect(await readFile(join(f.controller.managedArtifactRoot(f.task.id)!, exact.path), 'utf8')).toContain('data-evidence-report')
    expect(f.repository.get(f.task.id)!.status).not.toBe('completed')
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence')).toHaveLength(0)
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, 'new-turn')).toMatchObject({ stalled: false, semanticRepair: { failureCount: 0 } })
    expect(await f.call('verify_web_artifact', publication.verificationInput as Record<string, unknown>)).toMatchObject({ complete: true })
  } finally { f.repository.close() }
})

it('preserves the twice-stalled Gov source epoch across normal resume and repository/controller restart', async () => {
  const f = await fixture()
  let reopened: TaskRunRepository | undefined
  try {
    const gov = origins[0]!, proof = input(), oldBytes = await readFile(f.path, 'utf8')
    proof.items[0]!.source.url = gov+'/notice/not-yet-read'
    const args = { path: 'gov-before-restart.html', report: { title: '待核验来源报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } }
    expect(await f.call('publish_artifact', args)).toMatchObject({ code: 'web_source_reads_required', semanticRepair: { failureCount: 1, stalled: false } })
    expect(await f.call('publish_artifact', args)).toMatchObject({ code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 2, stalled: true }, missingOrigins: [gov] })
    const current = f.repository.get(f.task.id)!
    f.controller.pauseTask(f.task.id, current.revision)
    f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
    f.repository.close()
    reopened = new TaskRunRepository(join(f.root, 'tasks.sqlite3'))
    const restarted = new TaskController({ repository: reopened, threadStore: f.threadStore, sessionStore: f.sessionStore, nowIso: () => fixtureTime, dataDir: f.root })
    const thread = (await f.threadStore.get(f.thread.id))!, priorGrant = thread.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const grant = ExecutionGrantSchema.parse({ ...priorGrant, id: 'grant-source-restored', turnId: 'source-restored-turn', idempotencyKey: 'source-restored-grant' })
    await f.threadStore.upsert({ ...thread, turns: [...thread.turns, { ...createTurnRecord({ id: 'source-restored-turn', threadId: thread.id, prompt: '继续核验同一来源缺口。' }), executionGrant: grant }] })
    restarted.ensureTask({ thread: (await f.threadStore.get(thread.id))!, turnId: 'source-restored-turn', continuationTaskId: f.task.id, request: { prompt: '继续核验同一来源缺口。' } })
    restarted.beginAttempt(thread.id, 'source-restored-turn')
    expect(await restarted.webArtifactProgressBlock(thread.id, 'source-restored-turn')).toMatchObject({
      code: 'web_artifact_repair_stalled', stalled: true, missingOrigins: expect.arrayContaining([gov]), semanticRepair: { failureCount: 2, stalled: true }
    })
    expect(await readFile(f.path, 'utf8')).toBe(oldBytes)
    expect(reopened.get(f.task.id)!.status).not.toBe('completed')
    expect(reopened.operations(f.task.id, 'web_artifact_evidence')).toHaveLength(0)
    await expect(stat(join(restarted.managedArtifactRoot(f.task.id)!, args.path))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { (reopened ?? f.repository).close() }
})

it('permits a resumed Turn to read a repair source but stops its first still-premature publication without resetting old failures', async () => {
  const f = await fixture()
  let reopened: TaskRunRepository | undefined
  try {
    const proof = input(), gov = origins[0]!, oldBytes = await readFile(f.path, 'utf8')
    proof.items[0]!.source.url = gov+'/notice/not-yet-read'
    const args = { path: 'before-manual-resume.html', report: { title: '待核验来源报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } } }
    await f.call('publish_artifact', args)
    await f.call('publish_artifact', args)
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toMatchObject({ kind: 'waiting_user' })
    const oldReceipts = f.repository.operations(f.task.id, 'web_artifact_source_gate').map(receipt => JSON.stringify(receipt))
    f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
    f.repository.close()
    reopened = new TaskRunRepository(join(f.root, 'tasks.sqlite3'))
    const restarted = new TaskController({ repository: reopened, threadStore: f.threadStore, sessionStore: f.sessionStore, nowIso: () => fixtureTime, dataDir: f.root })
    const thread = (await f.threadStore.get(f.thread.id))!, previous = thread.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const turnId = 'manual-source-repair', grant = ExecutionGrantSchema.parse({ ...previous, id: 'grant-manual-source-repair', turnId, idempotencyKey: 'grant-manual-source-repair' })
    await f.threadStore.upsert({ ...thread, turns: [...thread.turns, { ...createTurnRecord({ id: turnId, threadId: thread.id, prompt: '继续读取并修复原来源缺口。' }), executionGrant: grant }] })
    restarted.ensureTask({ thread: (await f.threadStore.get(thread.id))!, turnId, continuationTaskId: f.task.id, request: { prompt: '继续读取并修复原来源缺口。' } })
    restarted.beginAttempt(thread.id, turnId)
    expect(await restarted.suspendWebArtifactProgress(thread.id, turnId)).toBeNull()
    const call = { callId: 'manual-source-read', toolName: 'browser_get_html', providerId: 'browser-skill', arguments: { sessionId: 'owned' } }
    const operation = restarted.beginToolOperation(turnId, call, grant)!
    const html = '<main>仍需读取完整公告。</main>'
    const item = makeToolResultItem({ id: 'manual-source-result', threadId: thread.id, turnId, callId: call.callId, toolName: call.toolName,
      output: { status: 'succeeded', sourceUrl: gov+'/site/search', html, resultHash: sha(html), truncated: true, readScope: 'document', evidence: { verified: true, contentRead: true } } })
    restarted.finishToolOperation(operation.token, operation.key, { approved: true, item })
    await f.sessionStore.appendItem(thread.id, item)
    expect(await restarted.suspendWebArtifactProgress(thread.id, turnId)).toBeNull()
    expect(await restarted.recordWebArtifactPublicationBlock(f.task.id, turnId, 'still-premature.html', proof)).toMatchObject({
      stalled: true, semanticRepair: { failureCount: 3, stalled: true }
    })
    expect(await restarted.suspendWebArtifactProgress(thread.id, turnId)).toMatchObject({ kind: 'waiting_user' })
    expect(reopened.operations(f.task.id, 'web_artifact_source_gate').slice(0, 2).map(receipt => JSON.stringify(receipt))).toEqual(oldReceipts)
    expect(reopened.operations(f.task.id, 'web_artifact_source_gate').at(-1)?.request?.turnId).toBe(turnId)
    expect(await readFile(f.path, 'utf8')).toBe(oldBytes)
    await expect(stat(join(restarted.managedArtifactRoot(f.task.id)!, 'still-premature.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(reopened.get(f.task.id)!.status).toBe('waiting_user')
  } finally { (reopened ?? f.repository).close() }
})

it('allows a resumed Turn to correct literal fields without new source bytes while retaining the old failure ledger', async () => {
  const f = await fixture()
  try {
    const invalid = input()
    invalid.items[0]!.fields.find(field => field.field === 'budget')!.quote = '原文没有这段预算100000元的句子。'
    expect(await f.call('verify_web_artifact', invalid)).toMatchObject({ complete: false, semanticRepair: { failureCount: 1, stalled: false } })
    await f.call('publish_artifact', { path: 'report.html', content: report().replace('<head>', '<head><style>body{color:#123}</style>') })
    expect(await f.call('verify_web_artifact', invalid)).toMatchObject({ complete: false, semanticRepair: { failureCount: 2, stalled: true } })
    expect(await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', 'rename-only.html', invalid)).toMatchObject({
      stalled: true, semanticRepair: { failureCount: 2 }
    })
    const oldFailures = f.repository.operations(f.task.id, 'web_artifact_evidence').map(row => JSON.stringify(row))
    const sourceRows = f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'browser_get_html').map(row => JSON.stringify(row))
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toMatchObject({ kind: 'waiting_user' })
    f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
    const thread = (await f.threadStore.get(f.thread.id))!, previous = thread.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const turnId = 'manual-field-repair', grant = ExecutionGrantSchema.parse({ ...previous, id: 'grant-manual-field-repair', turnId, idempotencyKey: 'grant-manual-field-repair' })
    await f.threadStore.upsert({ ...thread, turns: [...thread.turns, { ...createTurnRecord({ id: turnId, threadId: thread.id, prompt: '继续修复同一字段原文绑定。' }), executionGrant: grant }] })
    f.controller.ensureTask({ thread: (await f.threadStore.get(thread.id))!, turnId, continuationTaskId: f.task.id, request: { prompt: '继续修复同一字段原文绑定。' } })
    f.controller.beginAttempt(thread.id, turnId)
    expect(await f.controller.suspendWebArtifactProgress(thread.id, turnId)).toBeNull()
    const tools = buildManagedArtifactToolProviders(f.controller)[0]!.tools
    const call = async (toolName: string, args: Record<string, unknown>) => {
      const tool = tools.find(tool => tool.name === toolName)!, request = { callId: `manual-field-${toolName}`, toolName, providerId: 'managed-artifacts', arguments: args }
      const operation = f.controller.beginToolOperation(turnId, request, grant)!
      const context: ToolHostContext = { threadId: thread.id, turnId, workspace: thread.workspace, threadMode: 'agent', sandboxMode: 'read-only', approvalPolicy: 'auto',
        abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', executionGrant: grant,
        currentToolOperation: () => f.controller.currentToolOperation(operation.token, operation.key, request, grant) }
      tool.validateArguments?.(args, context)
      const result = await tool.execute(args, context), item = makeToolResultItem({ id: request.callId+'-result', threadId: thread.id, turnId, callId: request.callId, toolName,
        output: result.output, isError: result.isError, toolKind: tool.toolKind })
      f.controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await f.sessionStore.appendItem(thread.id, item)
      return (item as { output: unknown }).output as Record<string, unknown>
    }
    const exact = input(); exact.path = 'field-corrected.html'
    expect((await f.assessment(report(), exact)).complete).toBe(true)
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').map(row => JSON.stringify(row))).toEqual(oldFailures)
    expect(f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'browser_get_html').map(row => JSON.stringify(row))).toEqual(sourceRows)
    const publication = await call('publish_artifact', { path: exact.path, report: { title: '修正原文绑定的草稿', evidence: { coverage: exact.coverage, items: exact.items, noMatches: exact.noMatches } } })
    expect(publication).toHaveProperty('bytes_written')
    expect(f.repository.get(f.task.id)!.status).not.toBe('completed')
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').map(row => JSON.stringify(row))).toEqual(oldFailures)
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, turnId)).toBeNull()
    const saved = await readFile(join(f.controller.managedArtifactRoot(f.task.id)!, exact.path), 'utf8')
    const read = await call('read_artifact', { path: exact.path, limit_bytes: 256 * 1024 })
    expect(read).toMatchObject({ content: saved, sha256: publication.sha256, byte_size: Buffer.byteLength(saved),
      bytes_returned: Buffer.byteLength(saved), offset_bytes: 0, truncated: false, next_offset_bytes: null })
    expect(sha(saved)).toBe(publication.sha256)
    expect(await call('verify_web_artifact', publication.verificationInput as Record<string, unknown>)).toMatchObject({ complete: true })
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, turnId)).toBeNull()
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').slice(0, 2).map(row => JSON.stringify(row))).toEqual(oldFailures)
    expect(f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'browser_get_html').map(row => JSON.stringify(row))).toEqual(sourceRows)
  } finally { f.repository.close() }
})

/** New boundary cases retain an intact older writer while two distinct bad quotes stall its field epoch. */
async function resumedLiteralRepairFixture() {
  const f = await fixture()
  try {
    const invalid = input(), field = invalid.items[0]!.fields.find(field => field.field === 'budget')!
    field.quote = '原文没有第一段预算100000元的句子。'
    expect(await f.call('verify_web_artifact', invalid)).toMatchObject({ complete: false, semanticRepair: { failureCount: 1, stalled: false } })
    field.quote = '原文没有第二段预算100000元的句子。'
    expect(await f.call('verify_web_artifact', invalid)).toMatchObject({ complete: false, semanticRepair: { failureCount: 2, stalled: true } })
    const oldFailures = f.repository.operations(f.task.id, 'web_artifact_evidence').map(row => JSON.stringify(row))
    const sourceRows = f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'browser_get_html').map(row => JSON.stringify(row))
    const oldBytes = await readFile(f.path, 'utf8')
    expect(sha(oldBytes)).toBe(f.publication.sha256)
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')).toMatchObject({ kind: 'waiting_user' })
    f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
    const thread = (await f.threadStore.get(f.thread.id))!, previous = thread.turns.find(turn => turn.id === 'new-turn')!.executionGrant!
    const turnId = 'literal-boundary-repair', grant = ExecutionGrantSchema.parse({ ...previous, id: 'grant-literal-boundary', turnId, idempotencyKey: 'grant-literal-boundary' })
    await f.threadStore.upsert({ ...thread, turns: [...thread.turns, { ...createTurnRecord({ id: turnId, threadId: thread.id, prompt: '继续修复同一字段原文绑定。' }), executionGrant: grant }] })
    f.controller.ensureTask({ thread: (await f.threadStore.get(thread.id))!, turnId, continuationTaskId: f.task.id, request: { prompt: '继续修复同一字段原文绑定。' } })
    f.controller.beginAttempt(thread.id, turnId)
    const tools = buildManagedArtifactToolProviders(f.controller)[0]!.tools
    let serial = 0
    const call = async (toolName: string, args: Record<string, unknown>) => {
      const tool = tools.find(tool => tool.name === toolName)!, request = { callId: `literal-boundary-${++serial}`, toolName, providerId: 'managed-artifacts', arguments: args }
      const operation = f.controller.beginToolOperation(turnId, request, grant)!
      const context: ToolHostContext = { threadId: thread.id, turnId, workspace: thread.workspace, threadMode: 'agent', sandboxMode: 'read-only', approvalPolicy: 'auto',
        abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', executionGrant: grant,
        currentToolOperation: () => f.controller.currentToolOperation(operation.token, operation.key, request, grant) }
      tool.validateArguments?.(args, context)
      const result = await tool.execute(args, context), item = makeToolResultItem({ id: request.callId+'-result', threadId: thread.id, turnId, callId: request.callId, toolName,
        output: result.output, isError: result.isError, toolKind: tool.toolKind })
      f.controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await f.sessionStore.appendItem(thread.id, item)
      return (item as { output: unknown }).output as Record<string, unknown>
    }
    return { ...f, turnId, resumedCall: call, oldFailures, sourceRows, oldBytes, invalid }
  } catch (error) { f.repository.close(); throw error }
}

it.each(['bad-literal', 'legacy-content', 'forged-content'] as const)('rejects a resumed literal repair candidate with %s without replacing its stalled field epoch', async variation => {
  const f = await resumedLiteralRepairFixture()
  try {
    const path = variation === 'legacy-content' ? 'report.html' : 'invalid-literal-copy.html'
    const args = variation === 'bad-literal'
      ? { path, report: { title: '仍然错误的原文绑定', evidence: { coverage: f.invalid.coverage, items: f.invalid.items, noMatches: f.invalid.noMatches } } }
      : { path, content: report().replace('100000元', '999999元') }
    expect(await f.resumedCall('publish_artifact', args)).toMatchObject({ code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 3, stalled: true } })
    expect(await readFile(f.path, 'utf8')).toBe(f.oldBytes)
    if (path !== 'report.html') await expect(stat(join(f.controller.managedArtifactRoot(f.task.id)!, path))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, f.turnId)).toMatchObject({ stalled: true, semanticRepair: { failureCount: 3 } })
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, f.turnId)).toMatchObject({ kind: 'waiting_user' })
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').map(row => JSON.stringify(row))).toEqual(f.oldFailures)
    expect(f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'browser_get_html').map(row => JSON.stringify(row))).toEqual(f.sourceRows)
    expect(f.repository.get(f.task.id)!.status).not.toBe('completed')
  } finally { f.repository.close() }
})

it('does not let an intact writer older than the field failures clear a resumed literal repair stall', async () => {
  const f = await resumedLiteralRepairFixture()
  try {
    const request = f.publication.verificationInput as { path: string; manifestRef: string }
    expect(await f.controller.resolveWebArtifactPublicationManifest(f.task.id, f.turnId, request.path, request.manifestRef, String(f.publication.sha256))).toEqual(input())
    const read = await f.resumedCall('read_artifact', { path: request.path, limit_bytes: 256 * 1024 })
    expect(read).toMatchObject({ content: f.oldBytes, sha256: f.publication.sha256, truncated: false })
    expect(await f.controller.webArtifactProgressBlock(f.thread.id, f.turnId)).toMatchObject({ stalled: true, semanticRepair: { failureCount: 2 } })
    expect(await f.controller.webArtifactPublicationGate(f.task.id, f.turnId, request.path, input())).toMatchObject({ stalled: true, semanticRepair: { failureCount: 2 } })
    expect(await f.resumedCall('verify_web_artifact', request)).toMatchObject({ complete: false, code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 3, stalled: true } })
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, f.turnId)).toMatchObject({ kind: 'waiting_user' })
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').map(row => JSON.stringify(row))).toEqual(f.oldFailures)
    expect(await readFile(f.path, 'utf8')).toBe(f.oldBytes)
    expect(f.repository.get(f.task.id)!.status).not.toBe('completed')
  } finally { f.repository.close() }
})

it.each(['cross-path', 'changed-bytes'] as const)('rejects %s reuse of the newly corrected literal repair manifest', async variation => {
  const f = await resumedLiteralRepairFixture()
  try {
    const exact = input(); exact.path = 'new-literal-writer.html'
    const publication = await f.resumedCall('publish_artifact', { path: exact.path, report: { title: '修正原文绑定的草稿', evidence: { coverage: exact.coverage, items: exact.items, noMatches: exact.noMatches } } })
    expect(publication).toHaveProperty('bytes_written')
    const request = publication.verificationInput as { path: string; manifestRef: string }
    const target = join(f.controller.managedArtifactRoot(f.task.id)!, exact.path), bytes = await readFile(target, 'utf8')
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, f.turnId)).toBeNull()
    if (variation === 'cross-path') {
      request.path = 'borrowed-literal-manifest.html'
      await writeFile(join(f.controller.managedArtifactRoot(f.task.id)!, request.path), bytes)
    } else await writeFile(target, bytes.replace('100000元', '999999元'))
    await expect(f.resumedCall('verify_web_artifact', request)).rejects.toMatchObject({ code: 'artifact_manifest_scope' })
    if (variation === 'changed-bytes') expect(await f.controller.webArtifactProgressBlock(f.thread.id, f.turnId)).toMatchObject({ stalled: true, semanticRepair: { failureCount: 2 } })
    expect(f.repository.operations(f.task.id, 'web_artifact_evidence').map(row => JSON.stringify(row))).toEqual(f.oldFailures)
    expect(f.repository.operations(f.task.id, 'tool').filter(row => row.request?.toolName === 'browser_get_html').map(row => JSON.stringify(row))).toEqual(f.sourceRows)
    expect(await readFile(f.path, 'utf8')).toBe(f.oldBytes)
    expect(f.repository.get(f.task.id)!.status).not.toBe('completed')
  } finally { f.repository.close() }
})

it('distinguishes a current captured feed document from report record evidence without treating navigation text as zero results', async () => {
  const f = await observedCollectionFixture()
  try {
    const url = origins[0] + '/#/subscribe/bidding', shell = '<main><nav>工作台 资料 搜索</nav><h1>我的订阅列表</h1></main>'
    await f.source(url, shell)
    const proof = feedInput(), reference = { url, resultHash: sha(shell) }
    proof.coverage = [reference]; proof.items[0]!.source = reference; proof.items[0]!.discovery = reference
    expect(await f.controller.webArtifactPublicationGate(f.task.id, 'new-turn', proof.path, proof)).toMatchObject({ ready: false,
      collectionFreshness: { currentCollectionReady: true, currentDocumentCaptured: true, reportEvidenceReady: false, readinessMeaning: 'current_capture_only' },
      reportReadiness: { typedManifestProvided: true, reportEvidenceReady: false, declaredRecords: 1, boundRecords: 0, gaps: expect.arrayContaining(['record_binding_required']) } })
    expect(await f.controller.recordWebArtifactPublicationBlock(f.task.id, 'new-turn', proof.path, proof)).toMatchObject({
      code: 'web_source_reads_required', semanticRepair: { failureCount: 1, stalled: false } })
    const second = await f.controller.recordWebArtifactPublicationBlock(f.task.id, 'new-turn', 'renamed.html')
    expect(second).toMatchObject({ code: 'web_artifact_repair_stalled', semanticRepair: { failureCount: 2, stalled: true },
      reportReadiness: { typedManifestProvided: false, gaps: expect.arrayContaining(['typed_manifest_required']) } })
    expect(second!.missingOrigins).toContain(origins[0]); expect(second!.nextReads).toEqual([])
    const before = f.repository.get(f.task.id)!, decision = await f.controller.suspendWebArtifactProgress(f.thread.id, 'new-turn')
    expect(decision?.task.waitingReason).toContain('尚无已登记成果')
    expect(decision?.task.waitingReason).not.toMatch(/草稿已保留|字段仍待核验/)
    expect(decision?.task.budget).toEqual(before.budget); expect(decision?.task.attempts).toBe(before.attempts)
  } finally { f.repository.close() }
})

it.each(['active', 'expired', 'finished', 'unknown'] as const)('offers the existing same-Space empty-args document read only for a live scoped Ego execution: %s', async boundary => {
  const f = await observedCollectionFixture()
  try {
    const task = f.repository.get(f.task.id)!, url = origins[0] + '/#/subscribe/bidding', identity = 'e'.repeat(64), nonce = 'offline-recovery-space'
    f.repository.update(task.id, task.revision, row => ({ ...row, goal: '汇总已授权订阅列表 ' + url }))
    const thread = (await f.threadStore.get(f.thread.id))!
    await f.threadStore.upsert({ ...thread, turns: thread.turns.map(turn => turn.id === 'new-turn' ? { ...turn, executionGrant: {
      ...turn.executionGrant!, allowedProviderIds: ['ego-browser'], allowedToolNames: ['ego_browser_read', 'publish_artifact'], connectorIdentityFingerprints: { 'ego-browser': identity },
      browserScope: { ...turn.executionGrant!.browserScope!, provider: 'ego-browser' as const }, expiresAt: boundary === 'expired' ? '2026-11-14T23:59:00.000Z' : '2026-11-15T00:30:00.000Z'
    } } : turn) })
    const binding = f.repository.beginOperation({ ownerId: task.id, kind: 'ego_task_space', idempotencyKey: 'ego-task-space', request: {
      taskId: task.id, threadId: task.threadId, nonce, spaceName: `RailWise read-only ${task.id} ${nonce}`, createdTurnId: 'new-turn', configurationFingerprint: identity, origins
    }, nowIso: fixtureTime }).receipt
    f.repository.finishOperation(task.id, binding.idempotencyKey, { status: 'succeeded', result: { taskSpaceId: 12, pageLabel: 'p1', ownership: 'agent' } }, fixtureTime)
    if (boundary === 'finished' || boundary === 'unknown') {
      const key = boundary === 'finished' ? 'ego-finish:' + binding.id : 'unknown-read'
      f.repository.beginOperation({ ownerId: task.id, kind: boundary === 'finished' ? 'ego_task_space_finish' : 'tool', idempotencyKey: key, request: { turnId: 'new-turn' }, nowIso: fixtureTime })
      f.repository.finishOperation(task.id, key, { status: boundary === 'finished' ? 'succeeded' : 'outcome_unknown', result: {} }, fixtureTime)
    }
    const before = JSON.stringify(f.repository.operations(task.id)), state = f.repository.get(task.id)!
    const gate = await f.controller.webArtifactPublicationGate(task.id, 'new-turn', 'current.html', feedInput())
    if (boundary === 'active') {
      expect(gate).toMatchObject({ readRecovery: { providerId: 'ego-browser', toolName: 'ego_browser_read', arguments: {}, taskId: task.id,
        turnId: 'new-turn', taskSpaceId: 12, requestedUrls: [url], maxCalls: 1 } })
      expect(gate!.collectionFreshness!.nextStep).toContain('ego_browser_read({})'); expect(gate!.readRecovery).not.toHaveProperty('url')
    } else expect(gate!.readRecovery).toBeUndefined()
    expect(JSON.stringify(f.repository.operations(task.id))).toBe(before); expect(f.repository.get(task.id)).toEqual(state)
    if (boundary === 'active') {
      const first = await f.controller.recordWebArtifactPublicationBlock(task.id, 'new-turn', 'current.html', feedInput())
      expect(first).toMatchObject({ stalled: false, readRecovery: { maxCalls: 1 } })
      const second = await f.controller.recordWebArtifactPublicationBlock(task.id, 'new-turn', 'other-name.html')
      expect(second).toMatchObject({ code: 'web_artifact_repair_stalled', collectionReadFailures: 2, stalled: true })
      expect(second!.readRecovery).toBeUndefined()
      expect(f.repository.get(task.id)!.budget).toEqual(state.budget); expect(f.repository.get(task.id)!.attempts).toBe(state.attempts)
      f.controller.pauseTask(task.id, f.repository.get(task.id)!.revision)
      expect(await f.controller.observedFeedCollectionContext(task.id, 'new-turn')).toBeNull()
    }
  } finally { f.repository.close() }
})
