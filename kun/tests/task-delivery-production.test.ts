import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { deliveryFlow, type TaskDeliveryTemplateId } from '../src/delivery/templates.js'
import type { ServerRuntime } from '../src/server/routes/server-runtime.js'

/** Protocol replay tests production assembly and tools; it is not a live-model quality claim. */
describe('task delivery production assembly with synthetic model protocol', () => {
  it('starts a fresh task from a completed hidden execution and regenerates an exact old candidate through the real tool boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-regenerate-production-'))
    let runtime: ServerRuntime | undefined
    let step = 0
    let baseline: { path: string; candidateHash: string } | undefined
    let revised: { path: string; candidateHash: string } | undefined
    const original = '# 合成报告\n## 风险\n旧风险。\n## 结论\n保持结论。\n'
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages?: Array<{ role: string; content?: string }> }
      for (const message of body.messages ?? []) if (message.role === 'tool') {
        let value: Record<string, unknown> = {}; try { value = JSON.parse(message.content ?? '{}') } catch { /* synthetic protocol */ }
        if (value.status === 'candidate' && typeof value.path === 'string' && typeof value.candidateHash === 'string') {
          if (value.path.endsWith('/report.md')) baseline = value as typeof baseline
          if (value.path.endsWith('/report-v2.md')) revised = value as typeof revised
        }
      }
      const tool = step === 0 || step === 3 ? { name: 'read_delivery_sources', args: { path: 'source.md' } }
        : step === 1 ? { name: 'propose_document', args: { path: 'report.md', content: original, source_refs: [{ path: 'source.md', sections: ['风险'] }], idempotency_key: 'initial-candidate' } }
        : step === 4 ? { name: 'propose_document', args: { path: 'report-v2.md', base_candidate_path: baseline!.path, expected_candidate_hash: baseline!.candidateHash, section_patches: [{ heading: '风险', content: '按新资料更新风险。\n' }], source_refs: [{ path: 'source.md', sections: ['风险'] }], idempotency_key: 'regenerated-candidate' } } : undefined
      step += 1
      const delta = tool ? { tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: '合成事实回答已完成，候选仅用于本地功能验收。' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: `synthetic-regenerate-${step}`, choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await writeFile(join(root, 'source.md'), 'source v1')
      const address = server.address() as { port: number }
      runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-only', apiKey: '', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-protocol', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
      const origin = await runtime.threadService.create({ workspace: root, model: 'synthetic-protocol', mode: 'agent' })
      const first = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'first', request: { prompt: '概述固定资料中的合成事实。' } })
      if (first.kind !== 'task_started') throw new Error('Expected an actual task')
      expect(await runtime.runTurn(first.turn.threadId, first.turn.turnId)).toBe('completed')
      expect(runtime.taskRepository!.get(first.task!.id)?.status).toBe('completed')
      expect(baseline).toBeDefined()
      await writeFile(join(root, 'source.md'), 'source v2')
      const second = await runtime.taskCoordinator!.command({ threadId: first.turn.threadId, intent: 'new', idempotencyKey: 'regenerate', request: { prompt: `概述更新后的合成事实。重新读取 source.md，再按候选 ${baseline!.path}、哈希 ${baseline!.candidateHash} 只更新风险正文。` } })
      if (second.kind !== 'task_started') throw new Error('Expected a new regeneration task')
      expect(second.task!.id).not.toBe(first.task!.id)
      expect(await runtime.runTurn(second.turn.threadId, second.turn.turnId)).toBe('completed')
      expect(revised).toBeDefined()
      expect(await readFile(join(root, revised!.path), 'utf8')).toBe(original.replace('旧风险。', '按新资料更新风险。'))
      expect(await readFile(join(root, baseline!.path), 'utf8')).toBe(original)
      expect(runtime.taskRepository!.get(first.task!.id)?.status).toBe('completed')
      expect((await runtime.threadService.list()).map(item => item.id)).toEqual([origin.id])
    } finally {
      await runtime?.shutdown?.()
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
  it.each(['approval', 'breakpoint'] as const)('projects standalone Flow %s into the durable task inbox at the production assembly boundary', async kind => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-inbox-production-'))
    const options = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-only', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'unused-synthetic', approvalPolicy: 'auto' as const, sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const }, capabilities: KunCapabilitiesConfig.parse({}) }
    let runtime: ServerRuntime | undefined
    try {
      runtime = await createKunServeRuntime(options)
      const service = runtime.flowService!
      const policy = { timeoutMs: 1000, retryAttempts: 0, retryBackoffMs: 0, errorBehavior: 'fail' as const, concurrencyLimit: 1, resumable: true, breakpoint: false }
      service.create({ schemaVersion: 1, id: 'standalone', name: '合成成果检查', description: '', workspace: root, variables: {},
        edges: kind === 'approval' ? [{ id: 'to-review', sourceNodeId: 'start', sourcePortId: 'output', targetNodeId: 'review', targetPortId: 'input', branch: 'normal' }] : [],
        nodes: [...(kind === 'approval' ? [{ id: 'start', type: 'manual_trigger', label: '开始', config: {}, bindings: {}, position: { x: 0, y: 0 }, disabled: false, policy }] : []), { id: 'review', type: kind === 'approval' ? 'human_approval' : 'manual_trigger', label: '检查合成成果', config: { message: '请核对合成资料。' }, bindings: {}, position: { x: 0, y: 0 }, disabled: false, policy: { ...policy, breakpoint: kind === 'breakpoint' } }] })
      expect(service.publish('standalone').published).toBe(true)
      const run = await service.run('standalone', {})
      await vi.waitFor(() => expect(runtime!.taskRepository!.inbox(root)).toMatchObject([{ ownerKind: 'flow', flowId: 'standalone', flowRunId: run.id, nodeId: 'review', workspaceRoot: root, status: 'pending' }]))
      expect(runtime.taskRepository!.inbox(join(root, 'other-project'))).toHaveLength(0)
      expect(runtime.taskViewService!.changes(0).some(item => item.kind === 'attention_changed')).toBe(true)
      await runtime.shutdown?.()
      runtime = await createKunServeRuntime(options)
      expect(runtime.taskRepository!.inbox(root)).toHaveLength(1)
      if (kind === 'approval') await runtime.flowService!.decide(run.id, 'review', 'approve')
      else await runtime.flowService!.resume(run.id)
      await vi.waitFor(() => expect(runtime!.flowService!.runDetails(run.id)?.run.status).toBe('succeeded'))
      await vi.waitFor(() => expect(runtime!.taskRepository!.inbox(root)).toHaveLength(0))
      // A pure local Flow checkpoint has no Agent task, Turn, or model request.
      expect(runtime.taskRepository!.list({ limit: 10 })).toHaveLength(0)
      expect(await runtime.threadService.list()).toHaveLength(0)
    } finally {
      await runtime?.shutdown?.()
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each(['monitoring-report', 'tender-document', 'research-document'] as TaskDeliveryTemplateId[])('runs %s through Flow, persisted task, model HTTP, real tools and context provenance', async templateId => {
    const root = await mkdtemp(join(tmpdir(), `railwise-${templateId}-`))
    const oldUrl = process.env.RAILWISE_DOCUMENT_EXPORT_URL; const oldToken = process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN
    delete process.env.RAILWISE_DOCUMENT_EXPORT_URL; delete process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN
    let runtime: ServerRuntime | undefined
    let step = 0
    const called: string[] = []
    let candidatePath = ''
    let chartPath = ''
    const sourcePath = templateId === 'monitoring-report' ? 'data.csv' : 'source.md'
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: Array<{ function: { name: string } }>; messages?: Array<{ role: string; content?: string }> }
      for (const forbidden of ['bash', 'write', 'edit', 'run_flow', 'memory_create']) expect(body.tools?.some(item => item.function.name === forbidden)).toBe(false)
      const history = body.messages?.filter(item => item.role === 'tool').map(item => { try { return JSON.parse(item.content ?? '{}') as Record<string, unknown> } catch { return {} } }) ?? []
      for (const output of history) if (typeof output.path === 'string' && output.status === 'candidate') candidatePath = output.path
      for (const output of history) if (output.chart && typeof output.chart === 'object' && 'relativePath' in output.chart) chartPath = String(output.chart.relativePath)
      let tool: { name: string; args: Record<string, unknown> } | undefined
      if (step === 0) tool = templateId === 'monitoring-report'
        ? { name: 'analyze_delivery_monitoring', args: { path: 'data.csv', project_path: 'project.json', idempotency_key: 'production-analysis' } }
        : { name: 'read_delivery_sources', args: { path: 'source.md' } }
      if (step === 1) tool = { name: 'propose_document', args: { path: 'deliverables/report.md', content: `# ${templateId}\n\n合成资料形成的待审阅草稿。\n\n| 项目 | 状态 |\n| --- | --- |\n| 草稿 | 待审阅 |\n\n${chartPath ? `![确定性监测趋势](${chartPath})\n\n` : ''}来源：[资料](../../../../${sourcePath})\n\n## 待确认\n本测试为模型协议回放，不是专业签署。\n`, source_refs: [{ path: sourcePath, location: 'L1-L4' }], idempotency_key: 'production-candidate' } }
      if (step === 2 && candidatePath) tool = { name: 'export_document', args: { path: candidatePath, formats: ['docx', 'pdf'], idempotency_key: 'production-export' } }
      if (tool) expect(body.tools?.some(item => item.function.name === tool!.name)).toBe(true)
      step += 1
      if (tool) called.push(tool.name)
      const delta = tool ? { tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
        : { content: `Markdown草稿已生成；导出桥未连接，DOCX/PDF待导出。\n[草稿](${candidatePath})` }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: `synthetic-${step}`, choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await writeFile(join(root, 'source.md'), templateId === 'tender-document' ? '# 合成招标要求\n1. 提供监测方案。\n2. 人员资质待提供。\n' : '# 合成研究资料\n观察事实A。\n未验证判断B。\n')
      await writeFile(join(root, 'data.csv'), 'point,time,value,unit\nP1,2026-11-01,1,mm\nP1,2026-11-02,3,mm\n')
      await writeFile(join(root, 'project.json'), JSON.stringify({ name: '合成监测', monitoringType: 'deformation', unit: 'mm', thresholds: { default: 10 } }))
      const address = server.address() as { port: number }
      runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-only', apiKey: '', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-protocol', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
      const graph = deliveryFlow(templateId, { workspaceRoot: root, goal: '根据固定合成资料交付可审阅草稿', sourcePaths: [sourcePath] }, `fixture:${templateId}`)
      runtime.flowService!.create(graph); expect(runtime.flowService!.publish(graph.id).published).toBe(true)
      const flow = await runtime.flowService!.run(graph.id, {})
      const executionThreadId = `thr_delivery_${createHash('sha256').update(`${flow.id}:delivery`).digest('hex').slice(0, 24)}`
      await expect.poll(() => called, { timeout: 10_000 }).toContain('export_document')
      const executing = runtime.taskRepository!.list({ threadId: executionThreadId, limit: 1 })[0]!
      expect(executing.goal).toBe('根据固定合成资料交付可审阅草稿')
      const execution = await runtime.threadService.get(executionThreadId)
      expect(execution?.turns.find(turn => turn.id === executing.activeTurnId)?.prompt).toContain('source_refs')
      expect(execution?.turns.find(turn => turn.id === executing.activeTurnId)?.prompt).toContain('propose_document')
      await runtime.runTurn(executionThreadId, executing.activeTurnId!)
      const task = runtime.taskRepository!.get(executing.id)!
      expect(task).toMatchObject({ templateId, flowRunId: flow.id, visibility: 'task', status: 'waiting_user' })
      expect(task.budget).toMatchObject({ version: 2, maxExecutionMs: 30 * 60 * 1000 })
      expect(called).toEqual([templateId === 'monitoring-report' ? 'analyze_delivery_monitoring' : 'read_delivery_sources', 'propose_document', 'export_document'])
      const candidate = await readFile(join(root, candidatePath), 'utf8')
      expect(candidate).toContain(templateId)
      expect(candidate).toContain('| 项目 | 状态 |')
      if (templateId === 'monitoring-report') {
        const image = candidate.match(/!\[[^\]]+\]\(([^)]+)\)/)![1]!
        expect(await readFile(resolve(root, dirname(candidatePath), decodeURIComponent(image)), 'utf8')).toContain('<svg')
      }
      const metadata = JSON.parse(await readFile(join(root, `${candidatePath}.sources.json`), 'utf8'))
      expect(metadata.sources[0].sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(runtime.taskContextRuntime!.repository.getContextBundle(metadata.contextBundleId)?.taskId).toBe(task.id)
      expect((await runtime.threadService.list()).some(thread => thread.id === executionThreadId)).toBe(false)
      expect(runtime.taskRepository!.operation(task.id, 'production-candidate')?.status).toBe('succeeded')
      // Pending export cannot invent a successful file or a successful export receipt.
      expect(runtime.taskRepository!.operation(task.id, 'production-export:docx')).toBeNull()
    } finally {
      await runtime?.shutdown?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
      if (oldUrl === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_URL; else process.env.RAILWISE_DOCUMENT_EXPORT_URL = oldUrl
      if (oldToken === undefined) delete process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN; else process.env.RAILWISE_DOCUMENT_EXPORT_TOKEN = oldToken
      await rm(root, { recursive: true, force: true })
    }
  }, 20_000)
})
