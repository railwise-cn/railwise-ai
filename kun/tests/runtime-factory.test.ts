import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../src/adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { UsageService } from '../src/services/usage-service.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { createKunServeRuntime, seedUsageCarryover } from '../src/server/runtime-factory.js'
import type { UsageSnapshot } from '../src/contracts/usage.js'
import type { SessionStore } from '../src/ports/session-store.js'

function usage(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  const promptTokens = overrides.promptTokens ?? 10
  const completionTokens = overrides.completionTokens ?? 5
  const cacheHitTokens = overrides.cacheHitTokens ?? 0
  const cacheMissTokens = overrides.cacheMissTokens ?? Math.max(promptTokens - cacheHitTokens, 0)
  const cacheTotal = cacheHitTokens + cacheMissTokens
  return {
    promptTokens,
    completionTokens,
    totalTokens: overrides.totalTokens ?? promptTokens + completionTokens,
    cachedTokens: overrides.cachedTokens ?? cacheHitTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRate: cacheTotal === 0 ? null : cacheHitTokens / cacheTotal,
    turns: overrides.turns ?? 1,
    ...(overrides.costUsd !== undefined ? { costUsd: overrides.costUsd } : {})
  }
}

describe('runtime factory usage carryover', () => {
  it('seeds runtime usage from the latest persisted cumulative usage event per thread', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const usageService = new UsageService()
    await threadStore.upsert(createThreadRecord({
      id: 'thr_seed',
      title: 'Seeded thread',
      workspace: '/tmp/project',
      model: 'deepseek-chat'
    }))
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 2,
      timestamp: '2026-06-02T09:00:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 20, completionTokens: 5, cacheHitTokens: 10, cacheMissTokens: 10, turns: 1 })
    })
    await sessionStore.appendEvent('thr_seed', {
      kind: 'usage',
      seq: 5,
      timestamp: '2026-06-02T09:05:00.000Z',
      threadId: 'thr_seed',
      usage: usage({ promptTokens: 80, completionTokens: 20, cacheHitTokens: 72, cacheMissTokens: 8, turns: 3 })
    })

    await seedUsageCarryover({ threadStore, sessionStore, usageService })

    expect(usageService.forThread('thr_seed')).toMatchObject({
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      cacheHitTokens: 72,
      cacheMissTokens: 8,
      turns: 3
    })
    expect(usageService.cacheSnapshot('thr_seed')).toMatchObject({
      hits: 72,
      misses: 8,
      hitRate: 0.9
    })
  })

  it('seeds runtime usage from indexed latest snapshots without replaying event logs', async () => {
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore() as InMemorySessionStore & {
      loadLatestUsageSnapshots: NonNullable<SessionStore['loadLatestUsageSnapshots']>
    }
    const usageService = new UsageService()
    sessionStore.loadLatestUsageSnapshots = vi.fn(async () => [
      {
        threadId: 'thr_indexed',
        seq: 9,
        usage: usage({ promptTokens: 120, completionTokens: 30, cacheHitTokens: 100, cacheMissTokens: 20, turns: 4 })
      }
    ])
    const loadEventsSince = vi.spyOn(sessionStore, 'loadEventsSince')

    await seedUsageCarryover({ threadStore, sessionStore, usageService })

    expect(loadEventsSince).not.toHaveBeenCalled()
    expect(usageService.forThread('thr_indexed')).toMatchObject({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cacheHitTokens: 100,
      cacheMissTokens: 20,
      turns: 4
    })
  })
})

describe('runtime factory vision evidence configuration', () => {
  it.each(['', 'not a valid endpoint'])('starts without an analyzer for enabled invalid endpoint %j and fails only image turns', async (endpoint) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-vision-'))
    let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
    try {
      runtime = await createKunServeRuntime({
        host: '127.0.0.1',
        port: 0,
        dataDir,
        runtimeToken: 'test-token',
        apiKey: 'not-used',
        baseUrl: 'http://127.0.0.1:9',
        model: 'deepseek-v4-pro',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        tokenEconomyMode: false,
        insecure: false,
        storage: { backend: 'file' },
        capabilities: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }),
        visionEvidence: { enabled: true, endpoint }
      })
      const thread = await runtime.threadService.create({
        workspace: dataDir,
        model: 'deepseek-v4-pro',
        mode: 'agent'
      })
      const attachment = await runtime.attachmentStore?.create({
        name: 'evidence.png',
        data: png(1, 1),
        threadId: thread.id,
        workspace: dataDir
      })
      expect(attachment).toBeDefined()
      const turn = await runtime.turnService.startTurn({
        threadId: thread.id,
        request: { prompt: 'read this image', attachmentIds: [attachment!.id] }
      })

      await expect(runtime.runTurn(thread.id, turn.turnId)).resolves.toBe('failed')
      await expect(runtime.turnService.getTurn(thread.id, turn.turnId)).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining('attachment_analysis_unavailable')
      })
      const events = await runtime.sessionStore.loadEventsSince(thread.id, 0)
      expect(events.find((event) => event.kind === 'attachment_evidence_failed')).toMatchObject({
        attachmentId: attachment!.id,
        status: 'failed',
        message: 'vision evidence is not configured for this text-only model'
      })
    } finally {
      await runtime?.shutdown?.()
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('reports an enabled non-loopback analyzer as unavailable with its validation reason', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-vision-diagnostic-'))
    let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
    try {
      runtime = await createKunServeRuntime({
        host: '127.0.0.1',
        port: 0,
        dataDir,
        runtimeToken: 'test-token',
        apiKey: 'not-used',
        baseUrl: 'http://127.0.0.1:9',
        model: 'deepseek-v4-pro',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        tokenEconomyMode: false,
        insecure: false,
        storage: { backend: 'file' },
        capabilities: KunCapabilitiesConfig.parse({ attachments: { enabled: true } }),
        visionEvidence: { enabled: true, endpoint: 'https://vision.example.com/analyze' }
      })

      expect(runtime.info().capabilities.visionEvidence).toMatchObject({
        enabled: true,
        available: false,
        status: 'unavailable',
        reason: expect.stringContaining('loopback')
      })
      await expect(runtime.toolDiagnostics?.()).resolves.toMatchObject({
        visionEvidence: {
          enabled: true,
          available: false,
          reason: expect.stringContaining('loopback')
        }
      })
    } finally {
      await runtime?.shutdown?.()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

function png(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  buffer[0] = 0x89
  buffer[1] = 0x50
  buffer[2] = 0x4e
  buffer[3] = 0x47
  buffer[4] = 0x0d
  buffer[5] = 0x0a
  buffer[6] = 0x1a
  buffer[7] = 0x0a
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}


describe('runtime factory official Responses search wiring', () => {
  it.each(['deepseek-v4-flash', 'deepseek-v4-pro'])('registers and executes legacy official search for %s with the unchanged model ID', async model => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-search-'))
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ output: [{ type: 'message', status: 'completed', content: [{
      type: 'output_text', text: 'Synthetic cited search result', annotations: [{ type: 'url_citation', url: 'https://example.com/source', title: 'Source' }]
    }] }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchImpl)
    let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
    try {
      runtime = await createKunServeRuntime({
        host: '127.0.0.1', port: 0, dataDir, runtimeToken: 'test-token', apiKey: 'synthetic-search-key', baseUrl: 'https://api.deepseek.com/v1', model,
        approvalPolicy: 'on-request', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' },
        capabilities: KunCapabilitiesConfig.parse({ web: { enabled: true, searchEnabled: true, fetchEnabled: false } })
      })
      expect((await runtime.toolDiagnostics?.())?.webProviders).toEqual([expect.objectContaining({ searchAvailable: true, provider: 'deepseek-responses' })])
      expect((await runtime.toolHost!.listTools()).some(tool => tool.name === 'web_search')).toBe(true)
      const result = await runtime.toolHost!.execute({ callId: 'search-default-model', toolName: 'web_search', arguments: { query: '工程测量规范', limit: 1 } }, {
        threadId: 'search-thread', turnId: 'search-turn', workspace: dataDir, approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
        abortSignal: new AbortController().signal, awaitApproval: async () => 'allow'
      })
      expect(result.item).toMatchObject({ kind: 'tool_result', isError: false })
      expect(JSON.stringify(result.item)).toContain('https://example.com/source')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.deepseek.com/v1/responses')
      expect(JSON.parse(String(init.body))).toMatchObject({ model, input: '工程测量规范', tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } })
      expect(init.headers).toMatchObject({ authorization: 'Bearer synthetic-search-key' })
    } finally {
      await runtime?.shutdown?.(); vi.unstubAllGlobals(); await rm(dataDir, { recursive: true, force: true })
    }
  })
  it.each([
    { baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-key', model: 'deepseek-flash' },
    { baseUrl: 'https://third-party.example/v1', apiKey: 'synthetic-key', model: 'deepseek-flash' },
    { baseUrl: 'http://api.deepseek.com', apiKey: 'synthetic-key', model: 'deepseek-flash' },
    { baseUrl: 'https://api.deepseek.com', apiKey: ' ', model: 'deepseek-flash' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-key', model: 'deepseek-pro' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'synthetic-key', model: 'deepseek-chat' }
  ])('keeps official search unavailable for unsupported factory settings: $baseUrl / $model', async config => {
    const dataDir = await mkdtemp(join(tmpdir(), 'kun-runtime-search-rejected-'))
    const fetchImpl = vi.fn(); vi.stubGlobal('fetch', fetchImpl)
    let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
    try {
      runtime = await createKunServeRuntime({
        host: '127.0.0.1', port: 0, dataDir, runtimeToken: 'test-token', ...config,
        approvalPolicy: 'on-request', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' },
        capabilities: KunCapabilitiesConfig.parse({ web: { enabled: true, searchEnabled: true, fetchEnabled: false } })
      })
      expect((await runtime.toolDiagnostics?.())?.webProviders).toEqual([expect.objectContaining({ searchAvailable: false })])
      const result = await runtime.toolHost!.execute({ callId: 'unsupported-search', toolName: 'web_search', arguments: { query: 'synthetic query' } }, {
        threadId: 'search-thread', turnId: 'search-turn', workspace: dataDir, approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
        abortSignal: new AbortController().signal, awaitApproval: async () => 'allow'
      })
      expect(result.item).toMatchObject({ kind: 'tool_result', isError: true })
      expect(JSON.stringify(result.item)).toContain('provider_unavailable')
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      await runtime?.shutdown?.(); vi.unstubAllGlobals(); await rm(dataDir, { recursive: true, force: true })
    }
  })
})
