import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { TaskRun } from '../../contracts/tasks.js'
import { TaskRunRepository } from '../../services/task-run-repository.js'
import { buildDocumentDeliveryToolProviders } from './document-delivery-tool-provider.js'
import { TaskContextRepository } from '../../services/task-context-repository.js'
import { TaskContextRuntime } from '../../services/task-context-runtime.js'
import { EngineeringService } from '../../engineering/engineering-service.js'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function task(workspaceRoot: string): TaskRun {
  return {
    id: 'task-candidate', threadId: 'thread-candidate', childTaskIds: [], workspaceRoot,
    goal: '生成候选报告', status: 'running', agentId: 'document-delivery',
    acceptance: { kind: 'files', requiredNodeKinds: ['deliver'], requireFinalResponse: true, requireActionableArtifactCard: true },
    budget: { maxAttempts: 2, maxDurationMs: 60_000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [{ id: 'deliver', taskId: 'task-candidate', kind: 'deliver', title: '交付', status: 'running', dependsOn: [], attempt: 1, maxAttempts: 2, idempotencyKey: 'deliver', evidence: [], revision: 0 }],
    artifacts: [], createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', revision: 0
  }
}

function context(workspace: string): ToolHostContext {
  return {
    threadId: 'thread-candidate', turnId: 'turn-candidate', workspace, threadMode: 'agent',
    approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal,
    awaitApproval: async () => 'allow'
  }
}

function grantedContext(workspace: string, pathAllowlist = [workspace]): ToolHostContext {
  return { ...context(workspace), executionGrant: ExecutionGrantSchema.parse({
    id: 'delivery-grant', taskId: 'task-candidate', threadId: 'thread-candidate', turnId: 'turn-candidate',
    workspaceRoot: workspace, workspaceTrust: 'workspace-write', agentTrust: 'workspace-write',
    approvalPolicy: 'auto', sandboxMode: 'workspace-write', pathAllowlist,
    workspaceRevision: 1, agentRevision: 1, revision: 1, idempotencyKey: 'delivery-grant', issuedAt: new Date().toISOString()
  }) }
}

describe('document delivery tool provider', () => {
  it('keeps the canonical Turn authority when a historical task uses a filesystem alias', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'railwise-delivery-alias-')); roots.push(outer)
    const original = join(outer, 'original'); await mkdir(original)
    const canonical = await realpath(original)
    const alias = join(outer, 'alias'); await symlink(original, alias, 'dir')
    await writeFile(join(canonical, 'source.md'), 'source content')
    await writeFile(join(canonical, 'project.json'), JSON.stringify({ name: 'Synthetic monitoring', monitoringType: 'deformation', unit: 'mm', thresholds: { default: 10 } }))
    await writeFile(join(canonical, 'data.csv'), 'point,time,value,unit\nP1,2026-11-01,1,mm\nP1,2026-11-02,3,mm\n')
    const repository = new TaskRunRepository(join(outer, 'tasks.sqlite3')); repository.create(task(alias))
    const engineeringService = new EngineeringService({ rootDir: join(outer, 'engineering') })
    const tools = buildDocumentDeliveryToolProviders(repository, { engineeringService })[0]!.tools
    const scoped = grantedContext(canonical)
    const oldUrl = process.env.RAILWISE_DOCUMENT_EXPORT_URL; const oldToken = process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      expect(body.workspaceRoot).toBe(canonical)
      expect(body.sourcePath.startsWith(`${canonical}/`)).toBe(true)
      expect(body.targetPath.startsWith(`${canonical}/`)).toBe(true)
      const bytes = Buffer.from('synthetic canonical export')
      await mkdir(join(canonical, '.workwise/delivery-exports/task-candidate'), { recursive: true }); await writeFile(body.targetPath, bytes)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: body.targetPath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    process.env.RAILWISE_DOCUMENT_EXPORT_URL = `http://127.0.0.1:${address.port}/export`; process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = 'synthetic-token'
    try {
      expect(await tools.find(tool => tool.name === 'read_delivery_sources')!.execute({ path: 'source.md' }, scoped)).toMatchObject({ output: { content: 'source content' } })
      const proposed = (await tools.find(tool => tool.name === 'propose_document')!.execute({ path: 'report.md', content: '# Report', source_refs: [{ path: 'source.md' }], idempotency_key: 'alias-candidate' }, scoped)).output as { path: string }
      expect(await readFile(join(canonical, proposed.path), 'utf8')).toBe('# Report')
      const metadata = JSON.parse(await readFile(join(canonical, `${proposed.path}.sources.json`), 'utf8'))
      expect(metadata.sources[0].workspaceRoot).toBe(canonical)
      expect(await tools.find(tool => tool.name === 'analyze_delivery_monitoring')!.execute({ path: 'data.csv', project_path: 'project.json', idempotency_key: 'alias-analysis' }, scoped)).toMatchObject({ output: { status: 'analyzed' } })
      expect(engineeringService.listProjects()[0]?.workspace).toBe(canonical)
      expect(await tools.find(tool => tool.name === 'export_document')!.execute({ path: proposed.path, formats: ['docx'], idempotency_key: 'alias-export' }, scoped)).toMatchObject({ output: { status: 'exported' } })
      expect(repository.get('task-candidate')?.workspaceRoot).toBe(alias)
      expect(scoped.executionGrant?.pathAllowlist).toEqual([canonical])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (oldUrl === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_URL; else process.env.RAILWISE_DOCUMENT_EXPORT_URL = oldUrl
      if (oldToken === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN; else process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = oldToken
      await engineeringService.flush(); engineeringService.close(); repository.close()
    }
  })

  it('rejects another workspace and retargeted aliases without broadening restricted paths', async () => {
    const outer = await mkdtemp(join(tmpdir(), 'railwise-delivery-alias-boundary-')); roots.push(outer)
    const first = join(outer, 'first'); const second = join(outer, 'second')
    await mkdir(first); await mkdir(second); await mkdir(join(first, 'inputs'))
    await writeFile(join(first, 'inputs/source.md'), 'permitted'); await writeFile(join(first, 'private.md'), 'private')
    const canonical = await realpath(first); const other = await realpath(second)
    const alias = join(outer, 'alias'); await symlink(first, alias, 'dir')
    const repository = new TaskRunRepository(join(outer, 'tasks.sqlite3')); repository.create(task(alias))
    const engineeringService = new EngineeringService({ rootDir: join(outer, 'engineering') })
    try {
      const tools = buildDocumentDeliveryToolProviders(repository, { engineeringService })[0]!.tools
      const read = tools.find(tool => tool.name === 'read_delivery_sources')!
      const propose = tools.find(tool => tool.name === 'propose_document')!
      const limited = grantedContext(canonical, [join(canonical, 'inputs')])
      expect(await read.execute({ path: 'inputs/source.md' }, limited)).toMatchObject({ output: { content: 'permitted' } })
      await expect(read.execute({ path: 'private.md' }, limited)).rejects.toMatchObject({ code: 'workspace_path_blocked' })
      await expect(propose.execute({ path: 'report.md', content: '# Denied', idempotency_key: 'restricted-candidate' }, limited)).rejects.toMatchObject({ code: 'workspace_path_blocked' })
      for (const tool of tools) {
        await expect(tool.execute({ path: 'source.md', content: '# Denied', project_path: 'project.json', formats: ['docx'], idempotency_key: `other-${tool.name}` }, grantedContext(other))).rejects.toMatchObject({ code: 'workspace_path_blocked' })
      }
      await rm(alias); await symlink(second, alias, 'dir')
      await expect(read.execute({ path: 'inputs/source.md' }, grantedContext(canonical))).rejects.toMatchObject({ code: 'workspace_path_blocked' })
      expect(repository.get('task-candidate')?.workspaceRoot).toBe(alias)
    } finally { await engineeringService.flush(); engineeringService.close(); repository.close() }
  })

  it('writes a task-owned candidate and replays the same result idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-tool-')); roots.push(root)
    await writeFile(join(root, 'source.md'), 'source content')
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const tool = buildDocumentDeliveryToolProviders(repository)[0]!.tools.find(item => item.name === 'propose_document')!
    const args = { path: 'report.md', content: '# Report\n', idempotency_key: 'candidate-1', source_refs: [{ path: 'source.md', location: 'L1' }] }
    const first = await tool.execute(args, context(root))
    const replay = await tool.execute(args, context(root))
    expect(first.output).toEqual(replay.output)
    expect(await readFile(join(root, '.workwise/delivery-candidates/task-candidate/report.md'), 'utf8')).toBe('# Report\n')
    expect(repository.operation('task-candidate', 'candidate-1')?.status).toBe('succeeded')
    repository.close()
  })

  it('preserves the target baseline and current model context, hashes scoped sources and rejects source drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-provenance-')); roots.push(root)
    await writeFile(join(root, 'source.md'), 'source v1')
    await writeFile(join(root, 'report.md'), '# User original')
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const contexts = new TaskContextRepository(repository.sharedDatabase(), { objectRoot: join(root, 'objects'), inlineLimitBytes: 8 })
    const runtime = new TaskContextRuntime(contexts, repository)
    const bundle = runtime.prepareModelRequest({ threadId: 'thread-candidate', turnId: 'turn-candidate', model: 'synthetic', prefix: [], tools: [], abortSignal: new AbortController().signal, history: [{ id: 'source-read', kind: 'tool_result', threadId: 'thread-candidate', role: 'tool', status: 'completed', createdAt: '2026-11-09T00:00:00Z', toolKind: 'tool_call', turnId: 'turn-candidate', callId: 'source-call', toolName: 'read_delivery_sources', isError: false, output: { path: 'source.md', sha256: createHash('sha256').update('source v1').digest('hex') } }] })!
    const tools = buildDocumentDeliveryToolProviders(repository, { contextRuntime: runtime })[0]!.tools
    const tool = tools.find(item => item.name === 'propose_document')!
    const recall = tools.find(item => item.name === 'read_task_context')!
    const recalled = await recall.execute({ bundle_id: bundle.id, object_id: bundle.objects[0].objectId, offset: 0, max_bytes: 32 }, context(root))
    expect(recalled.output).toMatchObject({ totalBytes: bundle.objects[0].sizeBytes, sha256: bundle.objects[0].sha256, nextOffset: 32 })
    await expect(recall.execute({ bundle_id: 'other-task-bundle', object_id: bundle.objects[0].objectId }, context(root))).rejects.toThrow(/authority/)
    const result = await tool.execute({ path: 'report.md', target_path: 'report.md', content: '# Candidate', idempotency_key: 'provenance-1' }, context(root))
    expect(result.output).toMatchObject({ contextBundleId: bundle.id, targetPath: 'report.md', candidateHash: createHash('sha256').update('# Candidate').digest('hex') })
    const metadata = JSON.parse(await readFile(join(root, '.workwise/delivery-candidates/task-candidate/report.md.sources.json'), 'utf8'))
    expect(metadata.baseline.content).toBe('# User original')
    expect(metadata.sources[0]).toMatchObject({ path: 'source.md', workspaceRoot: root, sha256: createHash('sha256').update('source v1').digest('hex') })
    expect(await readFile(join(root, 'report.md'), 'utf8')).toBe('# User original')
    await writeFile(join(root, 'source.md'), 'source v2')
    await expect(tool.execute({ path: 'changed-explicit.md', content: '# stale', source_refs: [{ path: 'source.md', location: 'L1' }], idempotency_key: 'provenance-explicit-drift' }, context(root))).rejects.toThrow(/Source changed/)
    await expect(tool.execute({ path: 'changed.md', content: '# stale', idempotency_key: 'provenance-2' }, context(root))).rejects.toThrow(/Source changed/)
    await expect(tool.execute({ path: 'escape.md', content: '# escape', source_refs: [{ path: '../secret.md' }], idempotency_key: 'provenance-3' }, context(root))).rejects.toThrow(/escapes/)
    repository.close()
  })

  it('regenerates only affected sections against an exact candidate baseline and keeps old text, sources and target baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-sections-')); roots.push(root)
    await writeFile(join(root, 'risk.md'), 'risk source v1'); await writeFile(join(root, 'conclusion.md'), 'conclusion source v1')
    await writeFile(join(root, 'report.md'), '# User original')
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const contexts = new TaskContextRepository(repository.sharedDatabase(), { objectRoot: join(root, 'objects') })
    const runtime = new TaskContextRuntime(contexts, repository)
    const prepare = (riskText: string) => runtime.prepareModelRequest({ threadId: 'thread-candidate', turnId: 'turn-candidate', model: 'synthetic', prefix: [], tools: [], abortSignal: new AbortController().signal,
      history: [['risk.md', riskText], ['conclusion.md', 'conclusion source v1']].map(([path, text], index) => ({ id: `source-${index}-${text}`, kind: 'tool_result', threadId: 'thread-candidate', role: 'tool', status: 'completed', createdAt: new Date().toISOString(), toolKind: 'tool_call', turnId: 'turn-candidate', callId: `call-${index}`, toolName: 'read_delivery_sources', isError: false, output: { path, sha256: createHash('sha256').update(text!).digest('hex'), content: text } })) })
    prepare('risk source v1')
    const tool = buildDocumentDeliveryToolProviders(repository, { contextRuntime: runtime })[0]!.tools.find(item => item.name === 'propose_document')!
    const original = '# 报告\n保持引言。\n## 风险\n旧风险。\n## 结论\n保持结论。\n'
    const first = (await tool.execute({ path: 'draft.md', target_path: 'report.md', content: original, source_refs: [{ path: 'risk.md', sections: ['风险'] }, { path: 'conclusion.md', sections: ['结论'] }], idempotency_key: 'section-first' }, context(root))).output as { path: string; candidateHash: string; sections: Array<{ heading: string; sourcePaths: string[] }> }
    expect(first.sections.find(item => item.heading === '风险')?.sourcePaths).toEqual(['risk.md'])
    await writeFile(join(root, 'risk.md'), 'risk source v2')
    await writeFile(join(root, 'report.md'), '# External user change')
    prepare('risk source v2')
    const args = { path: 'draft-v2.md', base_candidate_path: first.path, expected_candidate_hash: first.candidateHash, section_patches: [{ heading: '风险', content: '按新来源重写风险。\n' }], idempotency_key: 'section-second' }
    const second = (await tool.execute(args, context(root))).output as { path: string; candidateHash: string; candidateVersion: number; supersedesCandidatePath: string }
    expect(second).toMatchObject({ candidateVersion: 2, supersedesCandidatePath: first.path })
    expect(await readFile(join(root, second.path), 'utf8')).toBe(original.replace('旧风险。\n', '按新来源重写风险。\n'))
    expect(await readFile(join(root, first.path), 'utf8')).toBe(original)
    expect(await readFile(join(root, 'report.md'), 'utf8')).toBe('# External user change')
    const metadata = JSON.parse(await readFile(join(root, `${second.path}.sources.json`), 'utf8'))
    expect(metadata.baseline.content).toBe('# User original')
    expect(metadata.sources.find((source: { path: string }) => source.path === 'risk.md').sha256).toBe(createHash('sha256').update('risk source v2').digest('hex'))
    expect(metadata.sources.find((source: { path: string }) => source.path === 'conclusion.md').sha256).toBe(createHash('sha256').update('conclusion source v1').digest('hex'))
    expect(await tool.execute(args, context(root))).toMatchObject({ output: second })
    await expect(tool.execute({ ...args, path: 'bad-hash.md', expected_candidate_hash: '0'.repeat(64), idempotency_key: 'bad-hash' }, context(root))).rejects.toThrow(/Baseline candidate changed/)
    await expect(tool.execute({ ...args, path: 'wrong-section.md', section_patches: [{ heading: '结论', content: 'unrelated rewrite' }], idempotency_key: 'wrong-section' }, context(root))).rejects.toThrow(/every affected section/)
    const removed = (await tool.execute({ ...args, path: 'removed-risk-v3.md', source_refs: [], section_patches: [{ heading: '风险', content: '此节已删除相关事实，等待新资料。\n' }], idempotency_key: 'section-remove-source' }, context(root))).output as { sources: Array<{ path: string }> }
    expect(removed.sources.some(source => source.path === 'risk.md')).toBe(false)
    expect(removed.sources.some(source => source.path === 'conclusion.md')).toBe(true)
    contexts.close(); repository.close()
  })

  it('keeps unchanged local image links and assets when a new task revises an older exact candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-cross-task-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const sourceDir = join(root, '.workwise/delivery-candidates/task-candidate')
    await mkdir(sourceDir, { recursive: true }); await writeFile(join(sourceDir, 'chart.svg'), '<svg>verified asset</svg>')
    const tool = buildDocumentDeliveryToolProviders(repository)[0]!.tools.find(item => item.name === 'propose_document')!
    const oldContent = '# 报告\n## 风险\n旧风险。\n## 结论\n保持原文。\n![图](chart.svg)\n'
    const first = (await tool.execute({ path: 'report.md', content: oldContent, idempotency_key: 'cross-task-original' }, context(root))).output as { path: string; candidateHash: string }
    const nextTask = { ...task(root), id: 'task-next', threadId: 'thread-next', nodes: task(root).nodes.map(node => ({ ...node, id: `${node.id}-next`, taskId: 'task-next' })) }
    repository.create(nextTask)
    const second = (await tool.execute({ path: 'report-v2.md', base_candidate_path: first.path, expected_candidate_hash: first.candidateHash, section_patches: [{ heading: '风险', content: '新风险。\n' }], idempotency_key: 'cross-task-next' }, { ...context(root), threadId: 'thread-next' })).output as { path: string }
    expect(second.path).toContain('/task-next/')
    expect(await readFile(join(root, second.path), 'utf8')).toBe(oldContent.replace('旧风险。', '新风险。'))
    expect(await readFile(join(root, '.workwise/delivery-candidates/task-next/chart.svg'), 'utf8')).toBe('<svg>verified asset</svg>')
    expect(await readFile(join(root, first.path), 'utf8')).toBe(oldContent)
    repository.close()
  })

  it('returns pending exports when the application bridge is absent and verifies partial real bridge receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-export-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const tools = buildDocumentDeliveryToolProviders(repository)[0]!.tools
    const candidate = await tools.find(item => item.name === 'propose_document')!.execute({ path: 'report.md', content: '# Report', idempotency_key: 'export-source' }, context(root))
    const path = (candidate.output as { path: string }).path
    const exporter = tools.find(item => item.name === 'export_document')!
    const oldUrl = process.env.RAILWISE_DOCUMENT_EXPORT_URL; const oldToken = process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN
    delete process.env.RAILWISE_DOCUMENT_EXPORT_URL; delete process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN
    expect((await exporter.execute({ path, formats: ['docx', 'pdf'], idempotency_key: 'export-no-bridge' }, context(root))).output).toMatchObject({ status: 'pending_export', generatedFiles: [] })
    let requests = 0
    const server = createServer(async (req, res) => {
      requests += 1
      expect(req.headers.authorization).toBe('Bearer private-test-token')
      if (req.method === 'GET') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'No export receipt' })); return }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.format === 'pdf') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: 'PDF renderer unavailable' })); return }
      const bytes = Buffer.from('synthetic export protocol fixture')
      await mkdir(join(root, '.workwise/delivery-exports/task-candidate'), { recursive: true }); await writeFile(body.targetPath, bytes)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, path: body.targetPath, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    process.env.RAILWISE_DOCUMENT_EXPORT_URL = `http://127.0.0.1:${address.port}/export`; process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = 'private-test-token'
    try {
      const args = { path, formats: ['docx', 'pdf'], idempotency_key: 'export-two-formats' }
      const result = await exporter.execute(args, context(root))
      expect(result.output).toMatchObject({ status: 'partial', results: [{ format: 'docx', status: 'exported' }, { format: 'pdf', status: 'outcome_unknown' }] })
      expect((result.output as { generatedFiles: unknown[] }).generatedFiles).toHaveLength(1)
      await exporter.execute(args, context(root)); expect(requests).toBe(3)
      const exportedPath = (result.output as { generatedFiles: Array<{ relativePath: string }> }).generatedFiles[0]!.relativePath
      await writeFile(join(root, exportedPath), 'external change')
      const stale = await exporter.execute(args, context(root))
      expect(stale.output).toMatchObject({ status: 'partial', results: [{ format: 'docx', status: 'failed' }, { format: 'pdf', status: 'outcome_unknown' }], generatedFiles: [] })
      expect(requests).toBe(4) // Only the pending PDF receipt lookup; no repeated render/write.
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (oldUrl === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_URL; else process.env.RAILWISE_DOCUMENT_EXPORT_URL = oldUrl
      if (oldToken === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN; else process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = oldToken
      repository.close()
    }
  })

  it('runs the real deterministic monitoring service from scoped source files with immutable arithmetic evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-monitoring-')); roots.push(root)
    await writeFile(join(root, 'project.json'), JSON.stringify({ name: 'Synthetic monitoring', monitoringType: 'deformation', unit: 'mm', thresholds: { default: 10 }, taskContext: { standard: 'Synthetic only', standardVersion: 'test-v1' } }))
    await writeFile(join(root, 'data.csv'), 'point,time,value,unit\nP1,2026-11-01,1,mm\nP1,2026-11-02,3,mm\nP1,2026-11-03,4,mm\n')
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const engineeringService = new EngineeringService({ rootDir: join(root, 'engineering') })
    try {
      const analyze = buildDocumentDeliveryToolProviders(repository, { engineeringService })[0]!.tools.find(item => item.name === 'analyze_delivery_monitoring')!
      const args = { path: 'data.csv', project_path: 'project.json', idempotency_key: 'monitoring-real-1' }
      const result = await analyze.execute(args, context(root))
      expect(result.output).toMatchObject({ status: 'analyzed', analysis: { results: [{ currentValue: 4, previousValue: 3, cumulativeChange: 3, changeRate: 1 }] }, chart: { validation: 'valid' } })
      const chart = (result.output as { chart: { relativePath: string } }).chart
      expect(await readFile(join(root, chart.relativePath), 'utf8')).toContain('<svg')
      expect((await analyze.execute(args, context(root))).output).toEqual(result.output)
      expect(engineeringService.listProjects()).toHaveLength(1)
    } finally { await engineeringService.flush(); engineeringService.close(); repository.close() }
  })

  it('recovers a lost export response through a read-only receipt lookup without rerendering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-export-receipt-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const tools = buildDocumentDeliveryToolProviders(repository)[0]!.tools
    const candidate = await tools.find(item => item.name === 'propose_document')!.execute({ path: 'report.md', content: '# Report', idempotency_key: 'lost-response-source' }, context(root))
    const path = (candidate.output as { path: string }).path
    const exporter = tools.find(item => item.name === 'export_document')!
    const oldUrl = process.env.RAILWISE_DOCUMENT_EXPORT_URL; const oldToken = process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN
    let writes = 0; let lookups = 0
    let saved: { ok: boolean; path: string; format: string; sha256: string; size: number } | undefined
    const server = createServer(async (req, res) => {
      if (req.method === 'GET') {
        lookups += 1
        const url = new URL(req.url!, 'http://localhost')
        expect(url.searchParams.get('workspaceRoot')).toBe(root)
        expect(url.searchParams.get('sourcePath')).toBe(join(root, path))
        expect(url.searchParams.get('idempotencyKey')).toBe('task-candidate:lost-response-export:docx')
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(saved)); return
      }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const bytes = Buffer.from('synthetic receipt recovery bytes')
      await mkdir(join(root, '.workwise/delivery-exports/task-candidate'), { recursive: true }); await writeFile(body.targetPath, bytes)
      saved = { ok: true, path: body.targetPath, format: body.format, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
      writes += 1
      req.socket.destroy()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    process.env.RAILWISE_DOCUMENT_EXPORT_URL = `http://127.0.0.1:${address.port}/export`; process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = 'receipt-recovery-token'
    try {
      const args = { path, formats: ['docx'], idempotency_key: 'lost-response-export' }
      expect((await exporter.execute(args, context(root))).output).toMatchObject({ status: 'partial', results: [{ status: 'outcome_unknown' }] })
      expect((await exporter.execute(args, context(root))).output).toMatchObject({ status: 'exported', results: [{ status: 'exported' }] })
      expect(writes).toBe(1); expect(lookups).toBe(1)
      expect(repository.operation('task-candidate', 'lost-response-export:docx')?.status).toBe('succeeded')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (oldUrl === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_URL; else process.env.RAILWISE_DOCUMENT_EXPORT_URL = oldUrl
      if (oldToken === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN; else process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = oldToken
      repository.close()
    }
  })

  it('rejects traversal and conflicting idempotency keys without overwriting content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-path-')); roots.push(root)
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const tool = buildDocumentDeliveryToolProviders(repository)[0]!.tools.find(item => item.name === 'propose_document')!
    await expect(tool.execute({ path: '../escape.md', content: '# bad', idempotency_key: 'escape-1' }, context(root)))
      .resolves.toMatchObject({ isError: true })
    await tool.execute({ path: 'report.md', content: '# Original', idempotency_key: 'candidate-2' }, context(root))
    await expect(tool.execute({ path: 'report.md', content: '# Changed', idempotency_key: 'candidate-2' }, context(root)))
      .rejects.toThrow(/different request|different content/)
    expect(await readFile(join(root, '.workwise/delivery-candidates/task-candidate/report.md'), 'utf8')).toBe('# Original')
    repository.close()
  })

  it('rejects an existing symlink parent that resolves outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-symlink-'))
    const outside = await mkdtemp(join(tmpdir(), 'railwise-delivery-outside-'))
    roots.push(root, outside)
    await writeFile(join(outside, 'sentinel.md'), 'keep')
    const { mkdir, symlink } = await import('node:fs/promises')
    await mkdir(join(root, '.workwise/delivery-candidates/task-candidate'), { recursive: true })
    await symlink(outside, join(root, '.workwise/delivery-candidates/task-candidate/linked'))
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3')); repository.create(task(root))
    const tool = buildDocumentDeliveryToolProviders(repository)[0]!.tools.find(item => item.name === 'propose_document')!
    await expect(tool.execute({ path: 'linked/report.md', content: '# unsafe', idempotency_key: 'symlink-1' }, context(root)))
      .rejects.toThrow(/outside|unsafe_path/)
    expect(await readFile(join(outside, 'sentinel.md'), 'utf8')).toBe('keep')
    repository.close()
  })
})
