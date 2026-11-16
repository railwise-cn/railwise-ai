import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebArtifactEvidenceInputSchema } from '../../contracts/web-artifact-evidence.js'
import { prepareHtmlArtifact } from '../../services/html-artifact.js'
import type { TaskRun } from '../../contracts/tasks.js'
import type { ObservedFeedCollectionFreshness } from '../../services/web-artifact-evidence.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildManagedArtifactToolProviders } from './managed-artifact-tool-provider.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const title = '工程测量监测服务采购项目公开招标公告'
function report() {
  const source = { url: 'https://a.example.test/notice/1', resultHash: 'a'.repeat(64) }
  return { title: '监测采购信息', collectedAt: '2026-11-16T03:25:00+08:00', evidence: { coverage: [source],
    items: [{ sectionId: 'notice-1', title, source,
      discovery: { url: 'https://a.example.test/list', resultHash: 'b'.repeat(64) }, classification: 'opportunity',
      fields: [{ field: 'title', value: title, quote: title },
        { field: 'deadline', value: '2026年12月1日14时00分', quote: '投标文件递交的截止时间为2026年12月1日14时00分。' }],
      unverifiedFields: ['publication_date', 'budget', 'status', 'qualification'] }], noMatches: [] } }
}
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'managed-artifact-report-'))); temporary.push(base)
  const root = join(base, 'task-artifacts', 'task-test'), verifyWebArtifact = vi.fn()
  const tasks = { managedArtifactRoot: (taskId: string) => taskId === 'task-test' ? root : undefined,
    getTask: () => null, verifyWebArtifact }
  const tool = buildManagedArtifactToolProviders(tasks)[0]!.tools.find(tool => tool.name === 'publish_artifact')!
  const context = { threadId: 'thread-test', turnId: 'turn-test', abortSignal: new AbortController().signal,
    executionGrant: { taskId: 'task-test', threadId: 'thread-test', turnId: 'turn-test', managedArtifactRoot: root } } as ToolHostContext
  return { root, tool, context, verifyWebArtifact }
}

describe('publish_artifact structured report branch', () => {
  it('advertises a top-level object schema for existing model providers', async () => {
    const f = await fixture(), schema = f.tool.inputSchema as Record<string, unknown>
    expect(schema.type).toBe('object')
    expect(schema).not.toHaveProperty('anyOf')
    expect(schema).not.toHaveProperty('oneOf')
    expect(schema.required).toEqual(['path'])
    expect(schema.properties).toHaveProperty('content')
    expect(schema.properties).toHaveProperty('report')
  })

  it('preserves legacy content bytes and output shape for ordinary files', async () => {
    const f = await fixture(), content = '原始文本\nKeep exact bytes.\n'
    const result = await f.tool.execute({ path: 'report.txt', content }, f.context)
    expect(await readFile(join(f.root, 'report.txt'), 'utf8')).toBe(content)
    expect(result.output).not.toHaveProperty('verificationInput')
    expect(result.output).not.toHaveProperty('nextStep')
    expect(f.verifyWebArtifact).not.toHaveBeenCalled()
  })

  it('preserves the existing HTML preparation path for content mode', async () => {
    const f = await fixture(), content = '<!doctype html><html><head><title>原模式</title></head><body>原 HTML</body></html>'
    await f.tool.execute({ path: 'legacy.html', content }, f.context)
    expect(await readFile(join(f.root, 'legacy.html'), 'utf8')).toBe(prepareHtmlArtifact(content))
  })

  it('publishes HTML from one manifest and returns the matching verification input without verifying', async () => {
    const f = await fixture(), data = report()
    f.tool.validateArguments?.({ path: 'report.html', report: data }, f.context)
    const result = await f.tool.execute({ path: 'report.html', report: data }, f.context)
    const output = result.output as Record<string, unknown>, content = await readFile(join(f.root, 'report.html'), 'utf8')
    expect(content).toContain('data-evidence-report')
    expect(content).toContain('data-evidence-item="notice-1"')
    expect(content).toContain('2026年12月1日14时00分')
    expect(output.verificationInput).toEqual(WebArtifactEvidenceInputSchema.parse({ path: 'report.html', ...data.evidence }))
    expect(output.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    expect(output.nextStep).toMatch(/verify_web_artifact/)
    expect(output.nextStep).toMatch(/draft|草稿|未核验|尚未/i)
    expect(output).not.toHaveProperty('complete')
    expect(output).not.toHaveProperty('verified')
    expect(f.verifyWebArtifact).not.toHaveBeenCalled()
  })

  it('rejects content/report ambiguity and missing content', async () => {
    const f = await fixture()
    expect(() => f.tool.validateArguments?.({ path: 'report.html', content: '<p>raw</p>', report: report() }, f.context)).toThrow()
    expect(() => f.tool.validateArguments?.({ path: 'report.html' }, f.context)).toThrow()
  })

  it('limits structured reports to html/htm without changing ordinary-file formats', async () => {
    const f = await fixture()
    expect(() => f.tool.validateArguments?.({ path: 'report.md', report: report() }, f.context)).toThrow()
    expect(() => f.tool.validateArguments?.({ path: 'report.htm', report: report() }, f.context)).not.toThrow()
    expect(() => f.tool.validateArguments?.({ path: 'report.css', content: 'body{}' }, f.context)).not.toThrow()
  })

  it('rejects nonliteral report fields before creating any managed file', async () => {
    const f = await fixture(), data = report()
    data.evidence.items[0]!.fields[1]!.value = '2026-12-01 14:00'
    expect(() => f.tool.validateArguments?.({ path: 'report.html', report: data }, f.context)).toThrow()
    await expect(f.tool.execute({ path: 'report.html', report: data }, f.context)).rejects.toThrow()
    await expect(stat(join(f.root, 'report.html'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})


async function collectionFixture(ready: boolean, basis: 'observed_feed' | 'primary_document' = 'observed_feed') {
  const f = await fixture(), workspace = f.root
  const task: TaskRun = { id: 'task-test', threadId: 'thread-test', activeTurnId: 'turn-test', workspaceRoot: workspace,
    goal: '汇总已授权订阅列表', status: 'running', agentId: 'general', childTaskIds: [],
    acceptance: { kind: 'files', requiredNodeKinds: ['execute', 'verify', 'deliver'], requireFinalResponse: true, requireActionableArtifactCard: true, requiresWebEvidence: true, webEvidenceBasis: basis }, budget: { maxAttempts: 8, maxDurationMs: 900000 },
    attempts: 1, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 0,
    createdAt: '2026-11-16T23:59:00.000Z', updatedAt: '2026-11-16T23:59:00.000Z' }
  const policy: ObservedFeedCollectionFreshness = { basis: 'observed_feed', collectionTurnId: 'turn-test', currentCollectionReady: ready,
    nowUtc: '2026-11-16T23:59:00.000Z', nowBeijing: '2026-11-17T07:59:00+08:00', requestedUrls: ['https://feed.example.test/#/subscribe/bidding'],
    historyNotice: '旧快照仅供历史参考，不代表本轮已采集。', nextStep: ready ? '本轮已实际读取，可以生成列表资料草稿。' : '先使用本任务已授权的原生浏览器打开requestedUrls并读取当前完整列表或唯一记录区域，再生成report。' }
  const observedFeedCollectionContext = vi.fn(async () => policy), verifyWebArtifact = f.verifyWebArtifact
  verifyWebArtifact.mockResolvedValue({ complete: false, reasons: ['匿名字段仍待修正'] })
  const gate = { ready, stalled: !ready, code: ready ? undefined : 'web_artifact_repair_stalled', reasons: ready ? [] : ['保留旧字段停滞'],
    requirementHash: 'a'.repeat(64), evidenceFingerprint: 'b'.repeat(64), failureEvidenceFingerprints: {},
    missingOrigins: ready ? [] : ['https://feed.example.test'], reportManifestRequired: false, nextReads: [] }
  const tasks = { managedArtifactRoot: () => f.root, getTask: () => task, observedFeedCollectionContext,
    webArtifactPublicationGate: vi.fn(async () => gate), verifyWebArtifact }
  const tools = buildManagedArtifactToolProviders(tasks)[0]!.tools
  const context = { ...f.context, workspace, executionGrant: { ...f.context.executionGrant!, workspaceRoot: workspace } }
  const source = { url: policy.requestedUrls[0]!, resultHash: 'c'.repeat(64) }
  const title = '匿名完整可见记录标题附加后缀'
  const data = { title: '匿名列表汇总', evidence: { coverage: [source], items: [{ sectionId: 'one', title, source, discovery: source,
    classification: 'source', fields: [{ field: 'title', value: title, quote: title }, { field: 'publication_date', value: '2026-11-17', quote: '发布日期为2026-11-17' }],
    unverifiedFields: ['budget', 'deadline', 'status', 'qualification'] }], noMatches: [] } }
  return { ...f, tools, context, policy, data, observedFeedCollectionContext, verifyWebArtifact }
}

it('guides a blocked current collection to native reads while retaining old stalled facts and writing no draft', async () => {
  const f = await collectionFixture(false), publish = f.tools.find(tool => tool.name === 'publish_artifact')!
  const result = await publish.execute({ path: 'feed.html', report: f.data }, f.context)
  expect(f.observedFeedCollectionContext).toHaveBeenCalledWith('task-test', 'turn-test')
  expect(result).toMatchObject({ isError: true, output: { stalled: true, collectionFreshness: f.policy } })
  const output = result.output as Record<string, unknown>
  expect(output.message).toMatch(/本轮.*读取/)
  expect(output.nextStep).toMatch(/完整可见标题/)
  expect(output.nextStep).toMatch(/后缀/)
  expect(output.nextStep).toMatch(/CSS/)
  expect(output.nextStep).toMatch(/fields.*title/)
  expect(output.nextStep).toMatch(/recordUrl/)
  await expect(stat(join(f.root, 'feed.html'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('shares truthful current-collection guidance across draft publish, exact artifact read and explicit verify', async () => {
  const f = await collectionFixture(true), tool = (name: string) => f.tools.find(tool => tool.name === name)!
  const published = await tool('publish_artifact').execute({ path: 'feed.html', report: f.data }, f.context)
  const output = published.output as Record<string, unknown>, bytes = await readFile(join(f.root, 'feed.html'))
  expect(output).toMatchObject({ collectionFreshness: f.policy, sha256: createHash('sha256').update(bytes).digest('hex') })
  expect(output.nextStep).toMatch(/草稿/); expect(output).not.toHaveProperty('complete')
  const read = await tool('read_artifact').execute({ path: 'feed.html' }, f.context)
  expect(read.output).toMatchObject({ content: bytes.toString('utf8'), byte_size: bytes.length, sha256: output.sha256, collectionFreshness: f.policy })
  const verified = await tool('verify_web_artifact').execute(output.verificationInput as Record<string, unknown>, f.context)
  expect(verified).toMatchObject({ isError: true, output: { complete: false, collectionFreshness: f.policy, nextStep: expect.stringContaining('完整可见标题') } })
  expect(f.verifyWebArtifact).toHaveBeenCalledOnce()
  expect(await readFile(join(f.root, 'feed.html'))).toEqual(bytes)
})

it('keeps ordinary SVG bytes and legacy primary output free of feed collection guidance', async () => {
  const f = await collectionFixture(true, 'primary_document'), publish = f.tools.find(tool => tool.name === 'publish_artifact')!
  const content = '<svg xmlns="http://www.w3.org/2000/svg"><title>本地示意图</title></svg>'
  const result = await publish.execute({ path: 'diagram.svg', content }, f.context)
  expect(await readFile(join(f.root, 'diagram.svg'), 'utf8')).toBe(content)
  expect(result.output).not.toHaveProperty('collectionFreshness')
  expect(f.observedFeedCollectionContext).not.toHaveBeenCalled()
})
