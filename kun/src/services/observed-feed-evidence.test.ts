import { createHash } from 'node:crypto'
import { mkdtemp, realpath, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { TaskController } from './task-controller.js'
import { TaskRunRepository, operationFingerprint } from './task-run-repository.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { makeToolResultItem } from '../domain/item.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { WebArtifactEvidenceInputSchema } from '../contracts/web-artifact-evidence.js'
import { assessWebArtifactEvidence, webArtifactPublicationReadiness } from './web-artifact-evidence.js'
import { renderStructuredWebReport } from './structured-web-report.js'
import { buildManagedArtifactToolProviders } from '../adapters/tool/managed-artifact-tool-provider.js'
import type { ToolHostContext } from '../ports/tool-host.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const url = 'https://feed.example.test/#/subscribe/bidding'
const title = '睿威工程测量及变形监测服务招标信息'
const goal = `读取我已订阅的平台招标列表 ${url}，按工程测量、测绘、监测筛选，每天汇总为 HTML；只核对列表数据，不需要打开公告正文。`
const row = `<article><a href="/notice/one">${title}</a><time>发布日期：2026-11-16</time></article>`
const otherRow = '<article><a href="/notice/two">无关设备采购信息</a><time>发布日期：2026-11-15</time></article>'
const document = `<html><body><main>${row}${otherRow}</main></body></html>`
const rawProof = () => ({ path: 'feed.html', coverage: [{ url, resultHash: sha(document) }], items: [{ sectionId: 'record-one', title,
  source: { url, resultHash: sha(document) }, discovery: { url, resultHash: sha(document) }, recordUrl: 'https://feed.example.test/notice/one', classification: 'source',
  fields: [{ field: 'title', value: title, quote: title }, { field: 'publication_date', value: '2026-11-16', quote: '发布日期：2026-11-16' }],
  unverifiedFields: ['budget', 'deadline', 'status', 'qualification'] }], noMatches: [] })

async function fixture(prompt = goal, provider: 'browser-skill' | 'ego-browser' = 'browser-skill') {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-observed-feed-')); roots.push(temporary)
  const root = await realpath(temporary), workspace = join(root, 'read-only'); await mkdir(workspace)
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')), threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'feed-thread', workspace, title: 'Controlled subscription fixture', model: 'no-model' }); await threadStore.upsert(thread)
  const controller = new TaskController({ repository, threadStore, sessionStore, dataDir: root, nowIso: () => new Date().toISOString() })
  const task = controller.ensureTask({ thread, turnId: 'feed-turn', request: { prompt } })
  const grant = ExecutionGrantSchema.parse({ id: 'feed-grant', taskId: task.id, threadId: thread.id, turnId: 'feed-turn', workspaceRoot: workspace,
    workspaceTrust: 'read-only', agentTrust: 'workspace-write', sandboxMode: 'read-only', approvalPolicy: 'auto', pathAllowlist: [workspace], readPathAllowlist: [workspace], writePathAllowlist: [],
    allowedProviderIds: [provider, 'managed-artifacts'], allowedToolNames: ['ego_browser_read', 'browser_get_html', 'publish_artifact', 'read_artifact', 'verify_web_artifact'],
    managedArtifactRoot: controller.managedArtifactRoot(task.id), browserScope: { ...(provider === 'ego-browser' ? { provider } : {}), browserInstanceId: 'fixture-browser', origins: ['https://feed.example.test'], interaction: 'observe', revision: 1 },
    connectorIdentityFingerprints: { [provider]: 'a'.repeat(64) }, workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'feed-grant', issuedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' })
  await threadStore.upsert({ ...thread, turns: [{ ...createTurnRecord({ id: 'feed-turn', threadId: thread.id, prompt }), executionGrant: grant }] })
  controller.beginAttempt(thread.id, 'feed-turn')
  let next = 0
  const source = async (output: Record<string, unknown> = {}, ownerTaskId = task.id) => {
    const call = { callId: 'source-'+(++next), toolName: 'browser_get_html', providerId: 'browser-skill', arguments: { sessionId: 'fixture-owned' } }
    const activeGrant = { ...grant, taskId: ownerTaskId }
    const operation = controller.beginToolOperation(grant.turnId, call, activeGrant)!
    const item = makeToolResultItem({ id: 'result-'+call.callId, threadId: thread.id, turnId: grant.turnId, callId: call.callId, toolName: call.toolName,
      output: { status: 'succeeded', provider: 'browser-skill', sourceUrl: url, html: document, resultHash: sha(document), truncated: false, readScope: 'document', evidence: { verified: true, contentRead: true }, ...output } })
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await sessionStore.appendItem(thread.id, item)
  }
  const assess = async (proof = WebArtifactEvidenceInputSchema.parse(rawProof()), html?: string) => assessWebArtifactEvidence(repository, repository.get(task.id)!,
    await sessionStore.loadItems(thread.id), (await threadStore.get(thread.id))!.turns, html ?? renderStructuredWebReport(proof.path, { title: '订阅列表汇总', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } }, 'observed_feed').content, proof)
  const tools = buildManagedArtifactToolProviders(controller)[0]!.tools
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const request = { callId: 'artifact-'+(++next), toolName, providerId: 'managed-artifacts', arguments: args }, operation = controller.beginToolOperation(grant.turnId, request, grant)!
    const context: ToolHostContext = { threadId: thread.id, turnId: grant.turnId, workspace, threadMode: 'agent', sandboxMode: 'read-only', approvalPolicy: 'auto',
      executionGrant: grant, abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', currentToolOperation: () => controller.currentToolOperation(operation.token, operation.key, request, grant) }
    const tool = tools.find(tool => tool.name === toolName)!; tool.validateArguments?.(args, context)
    const response = await tool.execute(args, context), item = makeToolResultItem({ id: 'result-'+request.callId, threadId: thread.id, turnId: grant.turnId,
      callId: request.callId, toolName, output: response.output, isError: response.isError })
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await sessionStore.appendItem(thread.id, item)
    return response
  }
  return { root, repository, controller, threadStore, sessionStore, thread, task, grant, source, assess, call }
}

it('seals observed-feed only from the explicit user subscription-list summary intent and keeps it through restart', async () => {
  const f = await fixture()
  try {
    expect(f.repository.get(f.task.id)?.acceptance).toMatchObject({ kind: 'files', requiredFormats: ['html'], minimumArtifacts: 1, requiresWebEvidence: true, webEvidenceBasis: 'observed_feed' })
    const acceptance = f.repository.get(f.task.id)!.acceptance, before = operationFingerprint(acceptance)
    f.repository.close()
    const reopened = new TaskRunRepository(join(f.root, 'tasks.sqlite3'))
    try { expect(operationFingerprint(reopened.get(f.task.id)!.acceptance)).toBe(before) } finally { reopened.close() }
  } finally { /* repository already closed above */ }
})

it('publishes a neutral list draft from actual same-record fields, explicitly verifies it, and does not auto-complete', async () => {
  const f = await fixture()
  try {
    await f.source()
    const proof = WebArtifactEvidenceInputSchema.parse(rawProof())
    expect((await f.assess(proof)).complete).toBe(true)
    const publication = await f.call('publish_artifact', { path: proof.path, report: { title: '睿威订阅列表汇总', evidence: { coverage: proof.coverage, items: proof.items, noMatches: [] } } })
    expect(publication.isError).not.toBe(true)
    const output = publication.output as Record<string, unknown>
    expect(output.nextStep).toContain('草稿')
    expect(output).not.toHaveProperty('complete')
    const saved = await readFile(join(f.controller.managedArtifactRoot(f.task.id)!, proof.path), 'utf8')
    expect(saved).toContain('列表数据 / 正文未核验')
    expect(saved).toContain('条目链接（正文未读取）')
    expect(saved).not.toContain('公告原文</a>')
    const verified = await f.call('verify_web_artifact', output.verificationInput as Record<string, unknown>)
    expect(verified.output).toMatchObject({ complete: true })
    expect(f.repository.get(f.task.id)?.status).toBe('running')
  } finally { f.repository.close() }
})

it.each(['cross-row-date', 'fabricated-link', 'wrong-hash', 'truncated', 'element-only', 'wrong-task', 'not-a-read'] as const)('rejects unproven feed evidence: %s', async boundary => {
  const f = await fixture()
  try {
    await f.source(boundary === 'truncated' ? { truncated: true } : boundary === 'element-only' ? { readScope: 'element' } : boundary === 'not-a-read' ? { status: 'failed', code: 'browser_navigation_timeout' } : {}, boundary === 'wrong-task' ? 'other-task' : f.task.id)
    const raw = rawProof()
    if (boundary === 'cross-row-date') raw.items[0]!.fields[1] = { field: 'publication_date', value: '2026-11-15', quote: '发布日期：2026-11-15' }
    if (boundary === 'fabricated-link') raw.items[0]!.recordUrl = 'https://feed.example.test/invented'
    if (boundary === 'wrong-hash') raw.items[0]!.source.resultHash = 'f'.repeat(64)
    expect((await f.assess(WebArtifactEvidenceInputSchema.parse(raw))).complete).toBe(false)
  } finally { f.repository.close() }
})

it('does not let manifest shape or classification lower an old primary-document task', async () => {
  const f = await fixture(`读取 ${url} 的工程监测招标公告，逐条打开公告正文并生成 HTML。`)
  try {
    await f.source()
    expect(f.repository.get(f.task.id)!.acceptance).not.toHaveProperty('webEvidenceBasis')
    expect((await f.assess()).complete).toBe(false)
  } finally { f.repository.close() }
})

it('requires neutral source classification and real zero-result reads for feed reports', async () => {
  const f = await fixture()
  try {
    await f.source()
    const raw = rawProof();raw.items[0]!.classification = 'opportunity'
    expect((await f.assess(WebArtifactEvidenceInputSchema.parse(raw))).complete).toBe(false)
    const empty = WebArtifactEvidenceInputSchema.parse({ path: 'feed.html', coverage: raw.coverage, items: [], noMatches: [{ source: raw.coverage[0], query: '工程测量', quote: '工程测量：共找到0条内容' }] })
    const ready = webArtifactPublicationReadiness(f.repository, f.repository.get(f.task.id)!, await f.sessionStore.loadItems(f.thread.id), (await f.threadStore.get(f.thread.id))!.turns, empty)
    expect(ready.ready).toBe(false)
  } finally { f.repository.close() }
})

it('can verify an actual unique list record with no independent href without inventing a link', async () => {
  const f = await fixture()
  try {
    const html = `<html><body><section><h3>${title}</h3><p>发布日期：2026-11-16</p></section>${otherRow}</body></html>`
    await f.source({ html, resultHash: sha(html) })
    const raw = rawProof(), { recordUrl: _url, ...item } = raw.items[0]!
    const proof = WebArtifactEvidenceInputSchema.parse({ ...raw, coverage: [{ url, resultHash: sha(html) }], items: [{ ...item, source: { url, resultHash: sha(html) }, discovery: { url, resultHash: sha(html) } }] })
    const rendered = renderStructuredWebReport(proof.path, { title: '订阅列表', evidence: { coverage: proof.coverage, items: proof.items, noMatches: [] } }, 'observed_feed')
    expect(rendered.content).toContain('无独立条目链接（正文未读取）')
    expect(rendered.content).not.toContain('data-evidence-record')
    expect((await f.assess(proof, rendered.content)).complete).toBe(true)
    const wrongDate = structuredClone(proof); wrongDate.items[0]!.fields[1] = { field: 'publication_date', value: '2026-11-15', quote: '发布日期：2026-11-15' }
    expect((await f.assess(wrongDate)).complete).toBe(false)
  } finally { f.repository.close() }
})

it('does not accept a broad body or duplicate title as a no-link record container', async () => {
  const f = await fixture()
  try {
    for (const html of [`<html><body><h3>${title}</h3><p>发布日期：2026-11-16</p></body></html>`, `<html><body><section><h3>${title}</h3><p>发布日期：2026-11-16</p></section><section><h3>${title}</h3><p>发布日期：2026-11-15</p></section></body></html>`]) {
      await f.source({ html, resultHash: sha(html) })
      const raw = rawProof(), { recordUrl: _url, ...item } = raw.items[0]!
      const proof = WebArtifactEvidenceInputSchema.parse({ ...raw, coverage: [{ url, resultHash: sha(html) }], items: [{ ...item, source: { url, resultHash: sha(html) }, discovery: { url, resultHash: sha(html) } }] })
      expect((await f.assess(proof)).complete).toBe(false)
    }
  } finally { f.repository.close() }
})

it('preserves a feed basis through an ordinary retry instead of inferring it from model continuation prose', async () => {
  const f = await fixture()
  try {
    const current = f.repository.get(f.task.id)!
    const terminal = f.repository.update(current.id, current.revision, task => ({ ...task, status: 'failed' }))
    const retry = f.controller.createRetryTask({ id: 'feed-retry', sourceTaskId: current.id, expectedRevision: terminal.revision, thread: (await f.threadStore.get(f.thread.id))!,
      request: { prompt: '继续，不改变来源用途。' } })
    expect(retry.id).not.toBe(current.id)
    expect(retry.acceptance.webEvidenceBasis).toBe('observed_feed')
    expect(retry.goal).toBe(current.goal)
  } finally { f.repository.close() }
})

it.each(['valid', 'wrong-turn', 'wrong-provider', 'forged-grant', 'wrong-config', 'unknown-host', 'missing-transcript'] as const)('consumes only a durable same-Turn real Ego Host wait after execute has returned: %s', async boundary => {
  const f = await fixture('使用Ego读取已订阅列表 https://feed.example.test/ 并汇总摘要。', 'ego-browser')
  try {
    const code = 'ego_browser_task_space_unconfirmed', request = { callId: 'real-ego-host', toolName: 'ego_browser_read', providerId: boundary === 'wrong-provider' ? 'mcp:forged' : 'ego-browser', arguments: {} }
    const operation = f.controller.beginToolOperation(f.grant.turnId, request, f.grant)!
    const host = f.repository.operation(f.task.id, operation.key)!
    const waitRequest = { taskId: f.task.id, turnId: boundary === 'wrong-turn' ? 'previous-turn' : f.grant.turnId, code, hostOperationId: host.id, callId: request.callId,
      grantFingerprint: boundary === 'forged-grant' ? 'f'.repeat(64) : operationFingerprint(f.grant), configurationFingerprint: boundary === 'wrong-config' ? 'f'.repeat(64) : 'a'.repeat(64) }
    const key = 'ego-wait:'+f.grant.turnId
    f.repository.beginOperation({ ownerId: f.task.id, idempotencyKey: key, kind: 'ego_browser_wait', request: waitRequest, nowIso: new Date().toISOString() })
    f.repository.finishOperation(f.task.id, key, { status: 'succeeded', result: { code, message: '原TaskSpace需要用户核对。' } }, new Date().toISOString())
    // The callback is deliberately harmless while the Host invocation is in flight.
    expect(await f.controller.suspendWebArtifactProgress(f.thread.id, f.grant.turnId)).toBeNull()
    expect(f.repository.get(f.task.id)!.status).toBe('running')
    const item = makeToolResultItem({ id: 'ego-host-result', threadId: f.thread.id, turnId: f.grant.turnId, callId: request.callId, toolName: request.toolName,
      isError: true, output: { provider: 'ego-browser', code, status: boundary === 'unknown-host' ? 'outcome_unknown' : 'failed' } })
    f.controller.finishToolOperation(operation.token, operation.key, { approved: true, item })
    if (boundary !== 'missing-transcript') await f.sessionStore.appendItem(f.thread.id, item)
    const raw = JSON.stringify(f.repository.operations(f.task.id))
    const result = await f.controller.suspendWebArtifactProgress(f.thread.id, f.grant.turnId)
    if (boundary === 'valid') {
      expect(result).toMatchObject({ kind: 'waiting_user' })
      const attention = f.repository.attention('capability_'+f.task.id)!
      expect(attention.payload).toMatchObject({ capability: { provider: 'ego-browser', errorCode: code } })
      expect(await f.controller.suspendWebArtifactProgress(f.thread.id, f.grant.turnId)).toBeNull()
      expect(f.repository.attention(attention.id)?.revision).toBe(attention.revision)
      f.controller.prepareResume(f.task.id, f.repository.get(f.task.id)!.revision)
      const nextGrant = ExecutionGrantSchema.parse({ ...f.grant, id: 'resumed-ego-grant', turnId: 'resumed-ego-turn' })
      const thread = (await f.threadStore.get(f.thread.id))!
      await f.threadStore.upsert({ ...thread, turns: [...thread.turns, { ...createTurnRecord({ id: nextGrant.turnId, threadId: thread.id, prompt: '继续原任务。' }), executionGrant: nextGrant }] })
      f.controller.ensureTask({ thread: (await f.threadStore.get(f.thread.id))!, turnId: nextGrant.turnId, continuationTaskId: f.task.id, request: { prompt: '继续原任务。' } })
      f.controller.beginAttempt(f.thread.id, nextGrant.turnId)
      expect(await f.controller.suspendWebArtifactProgress(f.thread.id, nextGrant.turnId)).toBeNull()
      expect(f.repository.get(f.task.id)?.status).toBe('running')
    } else {
      expect(result).toBeNull()
      expect(f.repository.get(f.task.id)!.status).toBe('running')
      expect(JSON.stringify(f.repository.operations(f.task.id))).toBe(raw)
    }
  } finally { f.repository.close() }
})

it.each(['document', 'element'] as const)('consumes an actual sealed Ego %s read for feed records, keeping element ineligible for primary', async scope => {
  const { createEgoBrowserFixture } = await import('../../tests/ego-browser-test-fixture.js')
  const f = await createEgoBrowserFixture()
  try {
    const opened = await f.execute('ego_browser_open', { url: 'https://feed.test/list' })
    const output = scope === 'element' ? await f.execute('ego_browser_read', { selector: 'article', observationId: opened.observationId }) : opened
    const ref = { url: String(output.sourceUrl), resultHash: String(output.resultHash) }, title = '测绘监测项目'
    const proof = WebArtifactEvidenceInputSchema.parse({ path: 'ego-feed.html', coverage: [ref], items: [{ sectionId: 'record-one', title, source: ref, discovery: ref, classification: 'source',
      fields: [{ field: 'title', value: title, quote: '测绘监测项目2026-11-16' }, { field: 'publication_date', value: '2026-11-16', quote: '测绘监测项目2026-11-16' }], unverifiedFields: ['budget', 'deadline', 'status', 'qualification'] }] })
    const items = f.repo.operations(f.task.id, 'tool').map(receipt => (receipt.result as { item: import('../contracts/items.js').TurnItem }).item)
    const turns = [{ ...createTurnRecord({ id: f.grant().turnId, threadId: f.task.threadId, prompt: f.task.goal }), executionGrant: f.grant() }]
    const rendered = renderStructuredWebReport(proof.path, { title: '订阅列表', evidence: { coverage: proof.coverage, items: proof.items, noMatches: [] } }, 'observed_feed')
    expect(assessWebArtifactEvidence(f.repo, f.task, items, turns, rendered.content, proof)).toMatchObject({ complete: true })
    expect(webArtifactPublicationReadiness(f.repo, f.task, items, turns, proof).ready).toBe(true)
    const primary = { ...f.task, goal: '采集工程招标公告正文并生成 HTML。', acceptance: { ...f.task.acceptance, webEvidenceBasis: undefined } }
    expect(assessWebArtifactEvidence(f.repo, primary, items, turns, rendered.content, proof).complete).toBe(false)
    const forged = items.map(item => item.kind === 'tool_result' ? { ...item, output: { ...(item.output as object), sourceKind: 'fullDOM', readScope: 'document' } } : item)
    expect(assessWebArtifactEvidence(f.repo, f.task, forged, turns, rendered.content, proof).complete).toBe(false)
  } finally { await f.dispose() }
})

it('never climbs from one no-link div record into a multi-record list to borrow another date', async () => {
  const f = await fixture()
  try {
    const html = `<body><div><div><h3>${title}</h3><span>发布日期：2026-11-16</span></div><div><h3>另一个设备项目</h3><span>发布日期：2026-11-15</span></div></div></body>`
    await f.source({ html, resultHash: sha(html) })
    const raw = rawProof(), { recordUrl: _url, ...item } = raw.items[0]!
    const proof = WebArtifactEvidenceInputSchema.parse({ ...raw, coverage: [{ url, resultHash: sha(html) }], items: [{ ...item, source: { url, resultHash: sha(html) }, discovery: { url, resultHash: sha(html) } }] })
    proof.items[0]!.fields[1] = { field: 'publication_date', value: '2026-11-15', quote: '发布日期：2026-11-15' }
    expect((await f.assess(proof)).complete).toBe(false)
  } finally { f.repository.close() }
})

it('accepts only a complete actual zero-result feed read, never a truncated substitute', async () => {
  const f = await fixture()
  try {
    const html = '<body><main>工程测量：共找到0条内容</main></body>', ref = { url, resultHash: sha(html) }
    await f.source({ html, resultHash: ref.resultHash })
    const proof = WebArtifactEvidenceInputSchema.parse({ path: 'feed.html', coverage: [ref], items: [], noMatches: [{ source: ref, query: '工程测量', quote: '工程测量：共找到0条内容' }] })
    expect((await f.assess(proof)).complete).toBe(true)
    const incomplete = '<body><main>工程测量：共找到0条内容</main></body><!--cut-->', broken = { url, resultHash: sha(incomplete) }
    await f.source({ html: incomplete, resultHash: broken.resultHash, truncated: true })
    const wrong = WebArtifactEvidenceInputSchema.parse({ ...proof, coverage: [broken], noMatches: [{ ...proof.noMatches[0], source: broken }] })
    expect((await f.assess(wrong)).complete).toBe(false)
  } finally { f.repository.close() }
})

it.each(['<body>加载中……工程测量：共找到0条内容</body>', '<body aria-busy="true">工程测量：共找到0条内容</body>', '<body></body>'])('does not treat loading or empty SPA DOM as an actual zero: %s', async html => {
  const f = await fixture()
  try {
    await f.source({ html, resultHash: sha(html) })
    const ref = { url, resultHash: sha(html) }, proof = WebArtifactEvidenceInputSchema.parse({ path: 'feed.html', coverage: [ref], items: [], noMatches: [{ source: ref, query: '工程测量', quote: '工程测量：共找到0条内容' }] })
    expect((await f.assess(proof)).complete).toBe(false)
  } finally { f.repository.close() }
})

it('renders bounded coverage and literal matching excerpts without claiming all daily opportunities', () => {
  const proof = WebArtifactEvidenceInputSchema.parse(rawProof())
  proof.items[0]!.fields.push({ field: 'other', value: '工程测量', quote: title })
  const rendered = renderStructuredWebReport(proof.path, { title: '订阅列表', evidence: { coverage: proof.coverage, items: proof.items, noMatches: [] } }, 'observed_feed')
  expect(rendered.content).toContain('本报告列出 1 条列表记录，关联 1 个来源页面')
  expect(rendered.content).toContain('后续分页覆盖尚未确认，不代表今日全量')
  expect(rendered.content).toContain('列表原文摘录')
  expect(rendered.content).toContain('列表标注日期')
  expect(rendered.content).not.toContain('当前机会</p>')
})

it('binds a title-plus-category wrapper and sibling date inside the same nearest article record', async () => {
  const f = await fixture()
  try {
    const html = `<body><main><article><div><a href="/notice/one">${title}</a><span>招标公告</span></div><time>发布日期：2026-11-16</time></article>${otherRow}</main></body>`
    await f.source({ html, resultHash: sha(html) })
    const raw = rawProof(), ref = { url, resultHash: sha(html) }
    const proof = WebArtifactEvidenceInputSchema.parse({ ...raw, coverage: [ref], items: [{ ...raw.items[0], source: ref, discovery: ref }] })
    expect((await f.assess(proof)).complete).toBe(true)
    proof.items[0]!.fields[1] = { field: 'publication_date', value: '2026-11-15', quote: '发布日期：2026-11-15' }
    expect((await f.assess(proof)).complete).toBe(false)
  } finally { f.repository.close() }
})
