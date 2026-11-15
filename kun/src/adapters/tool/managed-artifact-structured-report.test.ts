import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebArtifactEvidenceInputSchema } from '../../contracts/web-artifact-evidence.js'
import { prepareHtmlArtifact } from '../../services/html-artifact.js'
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
