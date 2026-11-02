import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepseekCompatModelClient } from '../src/adapters/model/deepseek-compat-model-client.js'
import { ProviderRoutingModelClient } from '../src/adapters/model/provider-routing-model-client.js'
import { estimateDeepseekCacheSavings, estimateDeepseekCost } from '../src/adapters/model/deepseek-pricing.js'
import { modelCapabilitiesForModel, resolveModelContextProfile } from '../src/loop/model-context-profile.js'
import type { ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'
import type { AttachmentStore } from '../src/attachments/attachment-store.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

afterEach(() => vi.restoreAllMocks())
const official = 'https://api.deepseek.com'
function request(model: string): ModelRequest {
  return { threadId: 'test', turnId: model, model, prefix: [], history: [], tools: [], stream: false, abortSignal: new AbortController().signal }
}
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 700, completion_tokens: 100 }
function response(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Completed synthetic check.' } }], usage }), { headers: { 'content-type': 'application/json' } })
}
const pricingInput = { providerHost: official, cacheHitTokens: 300, cacheMissTokens: 700, outputTokens: 100 }

describe('live DeepSeek model identity across request, capability and usage', () => {
  it('keeps concurrent request overrides and their cost/cache estimates isolated from the configured model', async () => {
    const seen: string[] = []
    const client = new DeepseekCompatModelClient({ baseUrl: official, apiKey: 'synthetic', model: 'deepseek-v4-pro', fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      seen.push(body.model)
      await Promise.resolve()
      return response(body)
    } })
    const run = async (selected: string): Promise<ModelStreamChunk[]> => {
      const chunks = []
      for await (const chunk of client.stream(request(selected))) chunks.push(chunk)
      return chunks
    }
    const [aliasChunks, explicitChunks] = await Promise.all([run('deepseek-reasoner'), run('deepseek-v4-flash')])
    expect(seen).toEqual(['deepseek-flash', 'deepseek-v4-flash'])
    for (const [chunks, model] of [[aliasChunks, 'deepseek-flash'], [explicitChunks, 'deepseek-v4-flash']] as const) {
      const costs = estimateDeepseekCost({ ...pricingInput, model })!
      const savings = estimateDeepseekCacheSavings({ ...pricingInput, model })!
      expect(chunks.find(chunk => chunk.kind === 'usage')).toMatchObject({ usage: { costUsd: costs.costUsd, costCny: costs.costCny, cacheSavingsUsd: savings.costUsd, cacheSavingsCny: savings.costCny } })
    }
    expect(client.model).toBe('deepseek-v4-pro')
    // The historical estimator remains a pure lookup for the saved old ID.
    expect(estimateDeepseekCost({ ...pricingInput, model: 'deepseek-reasoner' })).toEqual(estimateDeepseekCost({ ...pricingInput, model: 'deepseek-v4-flash' }))
    expect(estimateDeepseekCost({ ...pricingInput, model: 'deepseek-flash' })).not.toEqual(estimateDeepseekCost({ ...pricingInput, model: 'deepseek-reasoner' }))
  })

  it('uses the selected provider route default for both capabilities and wire model when request.model is empty', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return response(body)
    })
    const alias = 'deepseek-chat'
    const routes = [
      { id: 'official', baseUrl: official, apiKey: 'synthetic', model: alias, endpointFormat: 'chat_completions' as const },
      { id: 'third-party', baseUrl: 'https://example.com/v1', apiKey: 'synthetic', model: alias, endpointFormat: 'chat_completions' as const }
    ]
    const router = new ProviderRoutingModelClient(new DeepseekCompatModelClient({ ...routes[1], model: 'deepseek-v4-pro' }), routes)
    expect(router.resolveDefaultModelId('official')).toBe('deepseek-flash')
    expect(router.resolveDefaultModelId('third-party')).toBe('deepseek-chat')
    const capabilityIds: string[] = []
    const harness = makeHarness(router, { modelCapabilities: model => {
      capabilityIds.push(model)
      return modelCapabilitiesForModel(model)
    } })
    await bootstrapThread(harness, { request: { prompt: 'Use the selected provider default.', model: '', providerId: 'official', reasoningEffort: 'off' } })
    const thread = await harness.threadStore.get(harness.threadId)
    await harness.threadStore.upsert({ ...thread!, model: '' })

    expect(await harness.loop.runTurn(harness.threadId, harness.turnId)).toBe('completed')
    expect(capabilityIds).toEqual(['deepseek-flash'])
    expect(bodies).toHaveLength(1)
    expect(bodies[0].model).toBe('deepseek-flash')
    expect(await harness.turns.getTurn(harness.threadId, harness.turnId)).toMatchObject({ providerId: 'official' })
  })

  it.each(['deepseek-chat', 'deepseek-reasoner'])('resolves routed official %s before native image capability checks and preserves the saved turn ID', async (alias) => {
    const bodies: Record<string, unknown>[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      return response(body)
    })
    const routes = [
      { id: 'official', baseUrl: official, apiKey: 'synthetic', model: alias, endpointFormat: 'chat_completions' as const },
      { id: 'third-party', baseUrl: 'https://example.com/v1', apiKey: 'synthetic', model: alias, endpointFormat: 'chat_completions' as const }
    ]
    const router = new ProviderRoutingModelClient(new DeepseekCompatModelClient(routes[1]), routes)
    expect(router.resolveModelId(alias, 'third-party')).toBe(alias)
    expect(router.resolveModelId(alias, 'official')).toBe('deepseek-flash')
    expect(router.resolveModelId('deepseek-v4-pro', 'official')).toBe('deepseek-v4-pro')
    expect(() => router.resolveModelId(alias, 'missing')).toThrow('model_provider_unavailable')
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const metadata = { schemaVersion: 2, id: 'synthetic-image', name: 'synthetic.png', originalFileName: 'synthetic.png', mimeType: 'image/png', byteSize: data.length, hash: 'synthetic', kind: 'image', state: 'ready', degradationReasons: [], parserWarnings: [], indexState: 'not_applicable', threadIds: ['thr_1'], workspaces: ['/tmp'] }
    const attachmentStore = { resolveMetadataV2: async () => metadata, resolveContent: async () => ({ ...metadata, data }) } as unknown as AttachmentStore
    const capabilityIds: string[] = []
    const harness = makeHarness(router, { attachmentStore, modelCapabilities: model => {
      capabilityIds.push(model)
      return modelCapabilitiesForModel(model)
    } })
    await bootstrapThread(harness, { request: { prompt: 'Describe this synthetic image.', model: alias, providerId: 'official', attachmentIds: ['synthetic-image'], reasoningEffort: 'off' } })
    expect(await harness.loop.runTurn(harness.threadId, harness.turnId)).toBe('completed')
    expect(capabilityIds).toEqual(['deepseek-flash'])
    expect(resolveModelContextProfile(capabilityIds[0])?.canonicalModel).toBe('deepseek-flash')
    expect(bodies).toHaveLength(1)
    expect(bodies[0].model).toBe('deepseek-flash')
    expect(JSON.stringify(bodies[0].messages)).toContain('data:image/png;base64,')
    const turn = await harness.turns.getTurn(harness.threadId, harness.turnId)
    expect(turn).toMatchObject({ model: alias, providerId: 'official' })
    const costs = estimateDeepseekCost({ ...pricingInput, model: 'deepseek-flash' })!
    expect(harness.usage.forThread(harness.threadId)).toMatchObject({ costUsd: costs.costUsd, costCny: costs.costCny })
    // Pure legacy profiles are still available to historical and third-party callers.
    expect(resolveModelContextProfile(alias)?.canonicalModel).toBe('deepseek-v4-flash')
  })
})
