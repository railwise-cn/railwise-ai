import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import type { FlowDefinitionV1, FlowNodeV1, FlowRunV1 } from '../contracts/flow.js'
import type { ModelClient, ModelRequest } from '../ports/model-client.js'
import { buildRuntimeFlowAdapters } from './runtime-adapters.js'
import { FlowExecutor } from './executor.js'
import { FlowRepository } from './repository.js'

class FakeModel implements ModelClient {
  readonly provider = 'test'; readonly model = 'test-model'; constructor(private readonly outputs: string[]) {}
  async *stream(_request: ModelRequest) { yield { kind: 'assistant_text_delta' as const, text: this.outputs.shift() ?? '' }; yield { kind: 'completed' as const, stopReason: 'stop' as const } }
}
const policy = { timeoutMs: 2_000, retryAttempts: 0, retryBackoffMs: 0, errorBehavior: 'fail' as const, concurrencyLimit: 1, resumable: false, breakpoint: false }
const node = (type: string, config: Record<string, unknown> = {}): FlowNodeV1 => ({ id: type, type, label: type, position: { x: 0, y: 0 }, bindings: {}, config, policy, disabled: false })
const run = { id: 'run', flowId: 'flow', versionId: 'v1', status: 'running', input: {}, invocationStack: [], startedAt: '', updatedAt: '' } as FlowRunV1
const definition = (workspace?: string) => ({ id: 'flow', workspace } as FlowDefinitionV1)
const context = (type: string, input: unknown, workspace?: string, config?: Record<string, unknown>) => ({ run, definition: definition(workspace), node: node(type, config), input, signal: new AbortController().signal })

describe('Runtime-backed Flow adapters', () => {
  it('runs Agent, classifier and extraction while refusing Flow delegation without parent authority', async () => {
    const runSubagent = vi.fn(async () => ({ status: 'completed', summary: 'child done' })); const adapters = buildRuntimeFlowAdapters({ model: new FakeModel(['answer', '{"category":"bid"}', '```json\n{"amount":2}\n```']), defaultModel: 'default', runSubagent })
    await expect(adapters.get('agent')!(context('agent', { prompt: 'hello' }))).resolves.toMatchObject({ kind: 'output', output: { text: 'answer' } })
    await expect(adapters.get('classification')!(context('classification', 'classify'))).resolves.toEqual({ kind: 'output', output: { category: 'bid' } })
    await expect(adapters.get('parameter_extraction')!(context('parameter_extraction', 'extract'))).resolves.toEqual({ kind: 'output', output: { amount: 2 } })
    await expect(adapters.get('subagent')!(context('subagent', 'delegate', '/workspace'))).rejects.toMatchObject({code:'flow_node_unavailable'}); expect(runSubagent).not.toHaveBeenCalled()
  })
  it.each([
    { input:'处理钉钉里的待办事项', config:{} },
    { input:{prompt:'帮我处理飞书审批'}, config:{} },
    { input:{request:{text:'连接钉钉和飞书'}}, config:{} },
    { input:{provider:'dingtalk',operation:'complete',target:'todo-1'}, config:{} },
    { input:{context:'saved'}, config:{prompt:'同意钉钉审批'} }
  ])('blocks external work in a generic Agent before model allocation: $input', async ({input,config}) => {
    const model = new FakeModel(['已完成'])
    const stream = vi.spyOn(model,'stream')
    const adapter = buildRuntimeFlowAdapters({model,defaultModel:'default'}).get('agent')!
    await expect(adapter(context('agent',input,undefined,config))).rejects.toMatchObject({code:'external_effect_requires_typed_provider',resolution:expect.stringContaining('typed Provider task')})
    expect(stream).not.toHaveBeenCalled()
  })
  it('preserves how-to questions, comparisons, and extraction as text-only model work', async () => {
    const model = new FakeModel(['教程','对比','{"provider":"dingtalk"}'])
    const stream = vi.spyOn(model,'stream')
    const adapters = buildRuntimeFlowAdapters({model,defaultModel:'default'})
    await expect(adapters.get('agent')!(context('agent',{prompt:'如何使用钉钉审批'},undefined,{prompt:'回答用户的知识问题'}))).resolves.toMatchObject({output:{text:'教程'}})
    await expect(adapters.get('agent')!(context('agent',{request:{text:'比较飞书和钉钉审批功能'}}))).resolves.toMatchObject({output:{text:'对比'}})
    await expect(adapters.get('parameter_extraction')!(context('parameter_extraction',{prompt:'处理钉钉待办'}))).resolves.toMatchObject({output:{provider:'dingtalk'}})
    expect(stream).toHaveBeenCalledTimes(3)
  })
  it.each(['fail','continue','error_edge'] as const)('never marks an external Agent instruction complete under %s policy', async errorBehavior => {
    const root = await mkdtemp(join(tmpdir(),'railwise-flow-agent-policy-'))
    const repository = new FlowRepository(join(root,'flow.sqlite'))
    const model = new FakeModel(['已完成全部钉钉待办'])
    const stream = vi.spyOn(model,'stream')
    const adapters = buildRuntimeFlowAdapters({model,defaultModel:'default'})
    const agent = vi.fn(adapters.get('agent')!); adapters.set('agent',agent)
    const graph = {schemaVersion:1 as const,id:'external-agent-flow',name:'Saved Agent Flow',description:'',variables:{},nodes:[{
      ...node('agent',{prompt:'请执行输入中的平台任务'}),policy:{...policy,retryAttempts:4,errorBehavior}
    }],edges:[]}
    try {
      repository.create(graph); repository.publish(graph.id)
      const started = await new FlowExecutor(repository,adapters).start(graph.id,{prompt:'帮我处理钉钉和飞书待办'})
      await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('failed'))
      expect(repository.getRun(started.id)?.output).toMatchObject({code:'external_effect_requires_typed_provider'})
      expect(repository.listNodeRuns(started.id)).toMatchObject([{status:'failed',attempt:1,output:{code:'external_effect_requires_typed_provider'}}])
      expect(agent).toHaveBeenCalledOnce(); expect(stream).not.toHaveBeenCalled()
      expect(repository.get(graph.id)?.nodes).toEqual(graph.nodes)
    } finally {repository.close();await rm(root,{recursive:true,force:true})}
  })
  it('retrieves scoped document sections and bounds HTTP behavior', async () => {
    const searchSections = vi.fn(async () => [{ id: 's1', text: 'clause', provenance: { page: 9 } }]); const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })); const adapters = buildRuntimeFlowAdapters({ model: new FakeModel([]), defaultModel: 'default', attachments: { searchSections } as never, fetch })
    await expect(adapters.get('knowledge_retrieval')!(context('knowledge_retrieval', { attachmentId: 'att_1', query: 'clause' }, '/workspace'))).resolves.toMatchObject({ output: { untrusted: true, results: [{ provenance: { page: 9 } }] } }); expect(searchSections).toHaveBeenCalledWith('att_1', 'clause', { workspace: '/workspace' }, 8)
    await expect(adapters.get('http')!(context('http', {}, undefined, { url: 'https://example.com/api' }))).resolves.toMatchObject({ output: { status: 200, body: { ok: true } } })
    await expect(adapters.get('http')!(context('http', {}, undefined, { url: 'http://example.com' }))).rejects.toThrow('requires HTTPS')
    expect(fetch).toHaveBeenCalledWith(new URL('https://example.com/api'), expect.objectContaining({ method: 'GET', redirect: 'error' }))
  })
  it('allows HEAD reads without forwarding a configured body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
    const adapter = buildRuntimeFlowAdapters({ model: new FakeModel([]), defaultModel: 'default', fetch }).get('http')!
    await expect(adapter(context('http', { body: { ignored: true } }, undefined, { url: 'https://example.com/api', method: 'head', body: 'ignored' }))).resolves.toMatchObject({ output: { status: 200 } })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'HEAD', redirect: 'error' })
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty('body')
  })
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'OPTIONS'])('blocks generic %s before making a request', async method => {
    const fetch = vi.fn()
    const adapter = buildRuntimeFlowAdapters({ model: new FakeModel([]), defaultModel: 'default', fetch }).get('http')!
    await expect(adapter(context('http', {}, undefined, { url: 'https://example.com/api', method }))).rejects.toMatchObject({ code: 'external_effect_requires_typed_provider', resolution: expect.stringContaining('typed Provider') })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['https://api.dingtalk.com/v1.0/todo/users/me/tasks', 'https://oapi.dingtalk.com/robot/send', 'https://DINGTALK.CN./api', 'https://open.feishu.cn/open-apis/task/v2/tasks', 'https://open.larksuite.com/open-apis/approval/v4/tasks', 'https://a.b.larkoffice.com/api'])('blocks typed platform URL %s even for reads', async url => {
    const fetch = vi.fn()
    const adapter = buildRuntimeFlowAdapters({ model: new FakeModel([]), defaultModel: 'default', fetch }).get('http')!
    await expect(adapter(context('http', {}, undefined, { url }))).rejects.toMatchObject({ code: 'external_effect_requires_typed_provider' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not accept method override headers or follow a redirect into another authority', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('redirect mode is set to error') })
    const adapter = buildRuntimeFlowAdapters({ model: new FakeModel([]), defaultModel: 'default', fetch }).get('http')!
    await expect(adapter(context('http', {}, undefined, { url: 'https://example.com', headers: { 'X-HTTP-Method-Override': 'DELETE' } }))).rejects.toMatchObject({ code: 'external_effect_requires_typed_provider' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(adapter(context('http', {}, undefined, { url: 'https://example.com/redirect' }))).rejects.toThrow('redirect mode')
    expect(fetch).toHaveBeenCalledWith(new URL('https://example.com/redirect'), expect.objectContaining({ redirect: 'error' }))
  })
  it.each(['fail', 'continue', 'error_edge'] as const)('fails blocked legacy HTTP once under %s policy and preserves its published data', async errorBehavior => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-flow-http-policy-'))
    const repository = new FlowRepository(join(root, 'flow.sqlite'))
    const fetch = vi.fn()
    const adapters = buildRuntimeFlowAdapters({ model: new FakeModel([]), defaultModel: 'default', fetch })
    const original = { ...node('http', { url: 'https://example.com/write', method: 'POST', body: { original: true } }), policy: { ...policy, retryAttempts: 4, errorBehavior } }
    const graph = { schemaVersion: 1 as const, id: 'legacy-http-flow', name: 'Existing Flow', description: '', variables: {}, nodes: [original], edges: [] }
    try {
      repository.create(graph); const version = repository.publish(graph.id)
      const schedule = { flowId: graph.id, nodeId: 'saved-schedule', enabled: true, nextRunAt: '2026-11-12T09:00:00.000Z', state: { userConfigured: true } }
      repository.saveTriggerState(schedule)
      const adapter = vi.fn(adapters.get('http')!); adapters.set('http', adapter)
      const executor = new FlowExecutor(repository, adapters)
      const started = await executor.start(graph.id, { saved: 'input' })
      await vi.waitFor(() => expect(repository.getRun(started.id)?.status).toBe('failed'))
      expect(adapter).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled()
      expect(repository.listNodeRuns(started.id)).toMatchObject([{ nodeId: 'http', attempt: 1, status: 'failed', output: { code: 'external_effect_requires_typed_provider' } }])
      expect(repository.getRun(started.id)?.output).toMatchObject({ code: 'external_effect_requires_typed_provider', resolution: expect.stringContaining('typed Provider') })
      expect(repository.get(graph.id)?.nodes).toEqual([original])
      expect(repository.getVersion(version.id)?.definition.nodes).toEqual([original])
      expect(repository.getRun(started.id)?.input).toEqual({ saved: 'input' })
      expect(repository.getTriggerState(graph.id, schedule.nodeId)).toEqual(schedule)
    } finally { repository.close(); await rm(root, { recursive: true, force: true }) }
  })
  it('creates contained real DOCX, XLSX, PDF, and PPTX artifacts', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'workwise-flow-output-')); const adapters = buildRuntimeFlowAdapters({ model: new FakeModel([]), defaultModel: 'default' })
    for (const format of ['docx', 'xlsx', 'pdf', 'pptx'] as const) {
      const result = await adapters.get(`${format}_output`)!(context(`${format}_output`, format === 'xlsx' ? [{ a: 1, b: 2 }] : 'Tender output', workspace)) as { kind: 'output'; output: { path: string } }
      const bytes = await readFile(result.output.path); expect(bytes.length).toBeGreaterThan(100)
      if (format === 'pdf') expect(bytes.subarray(0, 8).toString()).toBe('%PDF-1.4')
      else { const zip = await JSZip.loadAsync(bytes); expect(Object.keys(zip.files).length).toBeGreaterThan(2) }
    }
    await expect(adapters.get('docx_output')!(context('docx_output', 'bad', workspace, { outputPath: '../escape.docx' }))).rejects.toThrow('escapes')
  })
})
