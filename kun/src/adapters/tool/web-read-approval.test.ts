import { describe, expect, it, vi } from 'vitest'
import type { WebCapabilityConfig } from '../../contracts/capabilities.js'
import { CapabilityRegistry } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { buildWebToolProviders } from './web-tool-provider.js'

describe('task-scoped web read approvals', () => {
  it('reuses one approval for later reads from the same origin in the same task', async () => {
    const approvedOrigins = new Set<string>()
    const approvalOrigins: string[] = []
    const approvalSummaries: string[] = []
    const fetchScopes: Array<{ origins?: string[]; urls?: string[] }> = []
    const fetch = vi.fn(async ({ url }: { url: string }) => ({
      sourceId: `source-${fetch.mock.calls.length}`,
      url,
      title: 'RailWise',
      finalUrl: url,
      retrievedAt: '2026-11-26T00:00:00.000Z',
      text: 'Public page content',
      byteCount: 20,
      truncated: false
    }))
    const scopedFetch = vi.fn(async (request: { url: string; allowedOrigins?: string[]; allowedUrls?: string[] }) => {
      fetchScopes.push({ origins: request.allowedOrigins, urls: request.allowedUrls })
      return fetch(request)
    })
    const provider = buildWebToolProviders({
      enabled: true, fetchEnabled: true, searchEnabled: false, allowDomains: [], denyDomains: [], maxFetchBytes: 1024
    } satisfies WebCapabilityConfig, { fetchProvider: { id: 'test-fetch', fetch: scopedFetch },
      searchResultUrls: () => ['https://search.example/result'] })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(provider.providers) })
    let approvalCount = 0
    const context = {
      threadId: 'task-thread', turnId: 'task-turn', workspace: '/tmp/workspace', approvalPolicy: 'on-request' as const,
      sandboxMode: 'read-only' as const, abortSignal: new AbortController().signal,
      executionGrant: { id: 'grant', taskId: 'task', threadId: 'task-thread', turnId: 'task-turn', workspaceRoot: '/tmp/workspace',
        workspaceTrust: 'read-only' as const, agentTrust: 'read-only' as const, approvalPolicy: 'on-request' as const,
        sandboxMode: 'read-only' as const, pathAllowlist: [], networkAllowlist: ['*'], connectorScopes: [], externalTargets: [],
        workspaceRevision: 1, agentRevision: 1, revision: 1, idempotencyKey: 'grant', issuedAt: '2026-11-26T00:00:00.000Z' },
      isTaskWebReadOriginApproved: (origin: string) => approvedOrigins.has(origin),
      awaitApproval: async (request: { toolName: string; summary: string; networkReadOrigin?: string }) => {
        approvalCount += 1
        expect(request.toolName).toBe('web_fetch')
        approvalSummaries.push(request.summary)
        if (request.networkReadOrigin) approvalOrigins.push(request.networkReadOrigin)
        if (request.networkReadOrigin) approvedOrigins.add(request.networkReadOrigin)
        return 'allow' as const
      }
    }

    const first = await host.execute({ callId: 'fetch-home', toolName: 'web_fetch', arguments: { url: 'https://www.railwise.cn/' } }, context)
    const second = await host.execute({ callId: 'fetch-about', toolName: 'web_fetch', arguments: { url: 'https://www.railwise.cn/about' } }, context)
    const otherOrigin = await host.execute({ callId: 'fetch-other-origin', toolName: 'web_fetch', arguments: { url: 'https://public.example/' } }, context)
    const searchResult = await host.execute({ callId: 'fetch-search-result', toolName: 'web_fetch', arguments: { url: 'https://search.example/result' } }, context)

    expect(first.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(second.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(otherOrigin.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(searchResult.item).toMatchObject({ kind: 'tool_result', isError: false })
    expect(approvalCount).toBe(2)
    expect(approvalOrigins).toEqual(['https://www.railwise.cn', 'https://public.example'])
    expect(approvalSummaries[0]).toContain('范围：仅当前任务')
    expect(scopedFetch).toHaveBeenCalledTimes(4)
    expect(fetchScopes).toEqual([
      { origins: ['https://www.railwise.cn'] }, { origins: ['https://www.railwise.cn'] },
      { origins: ['https://public.example'] },
      { origins: ['https://search.example'], urls: ['https://search.example/result'] }
    ])
  })
})
