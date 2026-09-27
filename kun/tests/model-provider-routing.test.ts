import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepseekCompatModelClient } from '../src/adapters/model/deepseek-compat-model-client.js'
import { ProviderRoutingModelClient, type ModelProviderRoutes } from '../src/adapters/model/provider-routing-model-client.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { resolveAutoModelRoute } from '../src/loop/auto-model-router.js'
import { createChildAgentExecutor } from '../src/delegation/child-agent-executor.js'
import { createImmutablePrefix } from '../src/cache/immutable-prefix.js'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { buildRuntimeFlowAdapters } from '../src/flow/runtime-adapters.js'
import type { FlowNodeAdapter } from '../src/flow/executor.js'
import type { ModelRequest } from '../src/ports/model-client.js'
import { estimateDeepseekCost } from '../src/adapters/model/deepseek-pricing.js'
import { resumeTask, retryTask } from '../src/server/routes/tasks.js'
import { parseServeOptions } from '../src/cli/serve.js'
import { StartTurnRequest } from '../src/contracts/turns.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!(); vi.unstubAllEnvs() })

async function endpoint(id: string) {
  const requests: Array<{ body: Record<string, unknown>; authorization?: string }> = []
  const server: Server = createServer(async (request, response) => {
    let raw = ''
    for await (const part of request) raw += part.toString()
    const body = JSON.parse(raw) as Record<string, unknown>
    requests.push({ body, authorization: request.headers.authorization })
    const text = JSON.stringify(body.messages).includes('auto-routing classifier')
      ? '{"model":"deepseek-v4-pro","thinking":"max"}'
      : body.response_format ? '{"category":"survey","amount":5}' : '5'
    const payload = { id: `${id}-reply`, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ ...payload, choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } else {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener unavailable')
  return { requests, route: { id, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: '', endpointFormat: 'chat_completions' as const, model: 'shared-model' } }
}

async function runtimeFor(routes: ModelProviderRoutes, defaultModelProviderId = 'a', dataDir?: string) {
  const root = dataDir ?? await mkdtemp(join(tmpdir(), 'kun-provider-routing-'))
  if (!dataDir) cleanup.push(() => rm(root, { recursive: true, force: true }))
  const route = routes.find(item => item.id === defaultModelProviderId)!
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: root,
    runtimeToken: 'test-token', ...route, modelProviders: routes, defaultModelProviderId,
    approvalPolicy: 'on-request', sandboxMode: 'workspace-write', tokenEconomyMode: false,
    insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
  cleanup.push(async () => { await runtime.shutdown?.() })
  return { runtime, root }
}

function request(providerId?: string, model = 'shared-model'): ModelRequest {
  return { threadId: 'internal', turnId: 'internal-turn', providerId, model, prefix: [], history: [], tools: [], stream: false, abortSignal: new AbortController().signal }
}

describe('configured provider identity over real HTTP', () => {
  it('rejects invalid private startup configuration without echoing credentials and strips request endpoints', () => {
    for (const secret of ['{"apiKey":"synthetic-private-key"', JSON.stringify([{ id: 'bad', apiKey: 'synthetic-private-key', baseUrl: 'invalid', model: 'shared-model', endpointFormat: 'chat_completions' }])]) {
      let caught: unknown
      try { parseServeOptions(['--data-dir', '/nonexistent-provider-routing-test'], { WORKWISE_MODEL_PROVIDERS_SECRET: secret }) } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(Error)
      expect(String(caught)).not.toContain('synthetic-private-key')
    }
    expect(StartTurnRequest.parse({ prompt: '2+3', providerId: 'a', baseUrl: 'https://untrusted.example', apiKey: 'untrusted', continuationTaskId: 'another-task', engineeringExecution: true, engineeringPlanId: 'another-plan' })).toEqual({ prompt: '2+3', providerId: 'a', attachmentIds: [], workspaceReferences: [] })
  })
  it('prices the selected model rather than the first model of its provider', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '5' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } }), { headers: { 'content-type': 'application/json' } }))
    const route = { id: 'deepseek', apiKey: '', baseUrl: 'https://api.deepseek.com', endpointFormat: 'chat_completions' as const, model: 'deepseek-flash' }
    const router = new ProviderRoutingModelClient(new DeepseekCompatModelClient(route), [route])
    const chunks = []
    for await (const chunk of router.stream(request('deepseek', 'deepseek-v4-pro'))) chunks.push(chunk)
    const expected = estimateDeepseekCost({ model: 'deepseek-v4-pro', providerHost: route.baseUrl, cacheHitTokens: 0, cacheMissTokens: 1000, outputTokens: 100 })
    expect(chunks.find(chunk => chunk.kind === 'usage')).toMatchObject({ usage: { costUsd: expected!.costUsd } })
    expect(expected!.costUsd).not.toBe(estimateDeepseekCost({ model: 'deepseek-flash', providerHost: route.baseUrl, cacheHitTokens: 0, cacheMissTokens: 1000, outputTokens: 100 })!.costUsd)
  })
  it('routes duplicate model IDs to the selected endpoint, pins defaults and rejects removed providers', async () => {
    const a = await endpoint('a'); const b = await endpoint('b')
    vi.stubEnv('WORKWISE_MODEL_PROVIDERS_SECRET', 'synthetic-private-key')
    const { runtime, root } = await runtimeFor([a.route, b.route])
    expect(process.env.WORKWISE_MODEL_PROVIDERS_SECRET).toBeUndefined()
    const thread = await runtime.threadService.create({ workspace: root, model: 'thread-specific-model', mode: 'agent' })
    for (const providerId of ['b', 'a']) {
      const started = await runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'What is 2+3?', model: 'shared-model', providerId, reasoningEffort: 'off' } })
      expect(await runtime.runTurn(thread.id, started.turnId)).toBe('completed')
      expect(await runtime.turnService.getTurn(thread.id, started.turnId)).toMatchObject({ providerId, model: 'shared-model', reasoningEffort: 'off' })
    }
    expect(a.requests).toHaveLength(1); expect(b.requests).toHaveLength(1)
    for (const seen of [...a.requests, ...b.requests]) {
      expect(seen.authorization).toBeUndefined()
      expect(seen.body).toMatchObject({ model: 'shared-model' })
    }
    await expect(runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: '2+3', providerId: 'removed' } })).rejects.toMatchObject({ code: 'model_provider_unavailable' })
    const started = await runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'What is 2+3?' } })
    expect(await runtime.turnService.getTurn(thread.id, started.turnId)).toMatchObject({ providerId: 'a', model: 'thread-specific-model' })
    await runtime.turnService.finishTurn({ threadId: thread.id, turnId: started.turnId, status: 'completed' })
    const pinned = await runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'What is 2+3?', providerId: 'a' } })
    expect(await runtime.turnService.getTurn(thread.id, pinned.turnId)).toMatchObject({ providerId: 'a', model: 'thread-specific-model' })
    expect(a.requests).toHaveLength(1); expect(b.requests).toHaveLength(1)
  })

  it('keeps the saved default after restart and replays omitted model continuation idempotently', async () => {
    const a = await endpoint('a'); const b = await endpoint('b')
    const first = await runtimeFor([a.route, b.route])
    const thread = await first.runtime.threadService.create({ workspace: first.root, model: 'shared-model', mode: 'agent' })
    const start = await first.runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'What is 2+3?', reasoningEffort: 'high' } })
    await first.runtime.turnService.finishTurn({ threadId: thread.id, turnId: start.turnId, status: 'completed' })
    const continued = await first.runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'continue', idempotencyKey: 'continue-key' } })
    expect(await first.runtime.turnService.getTurn(thread.id, continued.turnId)).toMatchObject({ model: 'shared-model', providerId: 'a', reasoningEffort: 'high' })
    expect(await first.runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'continue', idempotencyKey: 'continue-key' } })).toEqual(continued)
    await first.runtime.shutdown?.(); cleanup.pop()
    const second = await runtimeFor([a.route, b.route], 'b', first.root)
    const saved = await second.runtime.turnService.getTurn(thread.id, continued.turnId)
    expect(saved).toMatchObject({ providerId: 'a', model: 'shared-model', reasoningEffort: 'high' })
    const router = new ProviderRoutingModelClient(new DeepseekCompatModelClient(b.route), [a.route, b.route])
    for await (const _ of router.stream({ ...request(saved?.providerId, saved?.model), reasoningEffort: saved?.reasoningEffort })) { /* Drain the real response. */ }
    expect(a.requests).toHaveLength(1); expect(b.requests).toHaveLength(0)
  })

  it('carries identity through Auto and child requests while Flow internal requests retain the default', async () => {
    const a = await endpoint('a'); const b = await endpoint('b')
    const router = new ProviderRoutingModelClient(new DeepseekCompatModelClient(a.route), [a.route, b.route])
    const auto = await resolveAutoModelRoute({ modelClient: router, threadId: 'parent', turnId: 'turn', providerId: 'b', latestRequest: '2+3', recentContext: '', selectedModelMode: 'auto', abortSignal: new AbortController().signal })
    expect(auto).toMatchObject({ model: 'deepseek-v4-pro', source: 'flash-router' })
    expect(b.requests[0]?.body.model).toBe('deepseek-flash')
    const executor = createChildAgentExecutor({ model: router, defaultModel: 'wrong-default',
      parentSelection: async () => ({ model: 'child-model', providerId: 'b', reasoningEffort: 'off' }),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }), prefix: createImmutablePrefix({ systemPrompt: 'Answer arithmetic.' }) })
    expect((await executor({ childId: 'child', parentThreadId: 'parent', parentTurnId: 'turn', prompt: 'What is 2+3?', signal: new AbortController().signal })).summary).toBe('5')
    expect(b.requests[1]?.body.model).toBe('child-model')
    const adapters = buildRuntimeFlowAdapters({ model: router, defaultModel: 'flow-model' })
    for (const type of ['agent', 'classification', 'parameter_extraction']) {
      const context = { run: { id: 'flow-run' }, node: { id: type, config: {} }, input: '2+3', signal: new AbortController().signal } as Parameters<FlowNodeAdapter>[0]
      expect(await adapters.get(type)!(context)).toMatchObject({ kind: 'output' })
    }
    expect(a.requests).toHaveLength(3); expect(b.requests).toHaveLength(2)
    expect(a.requests.every(seen => seen.body.model === 'flow-model')).toBe(true)
    await expect(async () => { for await (const _ of router.stream(request('removed'))) { /* Drain. */ } }).rejects.toMatchObject({ code: 'model_provider_unavailable' })
  })

  it('preserves saved provider and effort in generic resume and retry routes', async () => {
    const a = await endpoint('a'); const b = await endpoint('b')
    const { runtime, root } = await runtimeFor([a.route, b.route])
    const thread = await runtime.threadService.create({ workspace: root, model: 'shared-model', mode: 'agent' })
    const start = await runtime.turnService.startTurn({ threadId: thread.id, request: { prompt: 'What is 2+3?', model: 'shared-model', providerId: 'b', reasoningEffort: 'off' } })
    await runtime.turnService.finishTurn({ threadId: thread.id, turnId: start.turnId, status: 'completed' })
    const repository = runtime.taskRepository!
    const active = repository.findActiveByThread(thread.id)!
    const waiting = repository.update(active.id, active.revision, current => ({ ...current, status: 'waiting_user' }))
    vi.spyOn(runtime, 'runTurn').mockResolvedValue('completed')
    const mutation = (revision: number) => new Request('http://localhost/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: revision, idempotencyKey: `resume-${revision}` }) })
    const resumed = await resumeTask(runtime, active.id, mutation(waiting.revision))
    expect(resumed.status).toBe(202)
    const resumedTurn = repository.get(active.id)!.activeTurnId!
    expect(await runtime.turnService.getTurn(thread.id, resumedTurn)).toMatchObject({ providerId: 'b', model: 'shared-model', reasoningEffort: 'off' })
    await runtime.turnService.finishTurn({ threadId: thread.id, turnId: resumedTurn, status: 'completed' })
    const current = repository.get(active.id)!
    const failed = repository.update(current.id, current.revision, value => ({ ...value, status: 'failed' }))
    const retried = await retryTask(runtime, active.id, mutation(failed.revision))
    expect(retried.status).toBe(202)
    const retriedTask = repository.findActiveByThread(thread.id)!
    expect(retriedTask).toMatchObject({ providerId: 'b', model: 'shared-model', reasoningEffort: 'off' })
    expect(await runtime.turnService.getTurn(thread.id, retriedTask.activeTurnId!)).toMatchObject({ providerId: 'b', model: 'shared-model', reasoningEffort: 'off' })
  })
})
