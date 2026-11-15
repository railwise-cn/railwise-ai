import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
async function fixture() {
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
      output: { status: 'succeeded', sourceUrl: url, html, resultHash: sha(html), truncated: false, readScope: target ? 'element' : 'document', evidence: { verified: true, contentRead: true } } })
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await sessionStore.appendItem(thread.id, item)
  }
  const tools = buildManagedArtifactToolProviders(controller)[0]!.tools
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.name === toolName)!, call = { callId: `artifact-${++next}`, toolName, providerId: 'managed-artifacts', arguments: args }
    const operation = controller.beginToolOperation(grant.turnId, call, grant)!
    const context: ToolHostContext = { threadId: thread.id, turnId: grant.turnId, workspace, threadMode: 'agent', sandboxMode: 'read-only', approvalPolicy: 'auto',
      abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', executionGrant: grant }
    tool.validateArguments?.(args, context)
    const result = await tool.execute(args, context), item = makeToolResultItem({ id: `item-${call.callId}`, threadId: thread.id, turnId: grant.turnId, callId: call.callId,
      toolName, output: result.output, isError: result.isError, toolKind: tool.toolKind })
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item }); await sessionStore.appendItem(thread.id, item)
    return (item as { output: unknown }).output as Record<string, unknown>
  }
  await source(origins[0] + '/list', discovery, 'e1'); await source(origins[1] + '/list', empty, 'e1'); await source(origins[0] + '/notice/1', document)
  await call('publish_artifact', { path: 'report.html', content: report() })
  const current = repository.get(task.id)!; controller.pauseTask(task.id, current.revision); controller.prepareResume(task.id, repository.get(task.id)!.revision)
  controller.ensureTask({ thread: (await threadStore.get(thread.id))!, turnId: 'new-turn', continuationTaskId: task.id, request: { prompt: '继续核验同一报告。' } })
  await bind('new-turn', 'current-f84', 4)
  await sessionStore.appendItem(thread.id, makeAssistantTextItem({ id: 'final', threadId: thread.id, turnId: grant!.turnId, text: 'HTML 报告已保存并核对来源。', status: 'completed' }))
  return { repository, threadStore, sessionStore, thread, task, controller, call, root, path: join(controller.managedArtifactRoot(task.id)!, 'report.html'),
    source, async assessment(html: string, proof = input()) { return assessWebArtifactEvidence(repository, repository.get(task.id)!, await sessionStore.loadItems(thread.id), (await threadStore.get(thread.id))!.turns, html, proof) } }
}

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
