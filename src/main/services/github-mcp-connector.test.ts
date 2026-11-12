import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpConfigService } from './mcp-config-service'
import { GITHUB_MCP_READONLY_URL, GITHUB_MCP_URL, isGitHubMcpServer } from '../../shared/github-connector'
import type { McpServerConfigV2 } from '../../shared/agent-workbench'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
let root: string
let service: McpConfigService
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'railwise-github-mcp-'))
  service = new McpConfigService({ manifestPath: join(root, 'mcp.json'), credentialRoot: join(root, 'credentials'), legacyPath: join(root, 'legacy.json'),
    encryption: { available: () => true, storage: 'dpapi', encrypt: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 42)), decrypt: value => Buffer.from(value.map(byte => byte ^ 42)).toString() } })
})
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }) })
async function configured() {
  const saved = await service.save({ config: { id: 'github-mcp', name: 'GitHub', transport: 'http', url: GITHUB_MCP_READONLY_URL,
    timeoutMs: 1000, scope: 'global', source: 'managed-tool', toolPolicy: {}, enabled: false }, expectedRevision: 0, idempotencyKey: 'create' })
  return service.setCredential({ serverId: saved.id, accessToken: 'synthetic-github-token', expectedRevision: saved.revision, idempotencyKey: 'token' })
}
function protocol(tools = ['get_me', 'get_file_contents']) {
  const methods: string[] = []
  const requests = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(GITHUB_MCP_READONLY_URL)
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-github-token')
    expect(init?.redirect).toBe('error')
    if (init?.method === 'GET') return new Response(null, { status: 405 })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { protocolVersion?: string } }
    methods.push(request.method)
    if (request.id === undefined) return new Response(null, { status: 202 })
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-protocol-fixture', version: '1.0.0' } }
      : { tools: tools.map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }
    return Response.json({ jsonrpc: '2.0', id: request.id, result })
  })
  vi.stubGlobal('fetch', requests)
  return { methods, requests }
}

describe('official GitHub connection checks', () => {
  it('performs real MCP initialize/listTools with an isolated synthetic transport and no business tool invocation', async () => {
    const saved = await configured()
    const observed = protocol()
    expect(await service.test(saved.id)).toMatchObject({ state: 'connected', authorized: true, toolCount: 2 })
    expect(observed.methods).toContain('initialize')
    expect(observed.methods).toContain('tools/list')
    expect(observed.methods).not.toContain('tools/call')
    expect(observed.requests.mock.calls.some(([, init]) => init?.method === 'HEAD')).toBe(false)
    expect(await readFile(join(root, 'mcp.json'), 'utf8')).not.toContain('synthetic-github-token')
    const snapshot = await service.runtimeSnapshot()
    expect(JSON.stringify(snapshot.servers)).not.toContain('synthetic-github-token')
    expect(snapshot.environment).toEqual({})
    expect(snapshot.servers[saved.id].enabled).toBe(false)
  })

  it('requires an actual credential before any HTTP request and preserves existing incomplete OAuth metadata', async () => {
    const old: McpServerConfigV2 = { id: 'github-mcp', name: 'Original GitHub', transport: 'http', url: GITHUB_MCP_URL,
      timeoutMs: 1000, scope: 'global', source: 'user', toolPolicy: { issue_write: 'ask' }, enabled: false, revision: 7,
      oauth: { resource: GITHUB_MCP_URL, redirectUri: 'http://127.0.0.1:17864/oauth/callback', scopes: ['repo'] } }
    await writeFile(join(root, 'mcp.json'), JSON.stringify({ schema: 'workwise.mcp-servers', version: 2, revision: 1, servers: [old], mutationKeys: {} }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await service.test(old.id)).toMatchObject({ state: 'needs_authorization', errorCode: 'missing_credentials' })
    const saved = await service.setCredential({ serverId: old.id, accessToken: 'synthetic-pat', expectedRevision: 7, idempotencyKey: 'explicit-token' })
    expect(saved).toMatchObject({ oauth: old.oauth, toolPolicy: old.toolPolicy, name: old.name, enabled: false })
    expect(saved.credentialRef).toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([[401, 'invalid_credentials'], [403, 'insufficient_scope'], [429, 'service_unavailable'], [503, 'service_unavailable']])('reports HTTP %i without leaking response bodies or tokens', async (status, errorCode) => {
    const saved = await configured()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('synthetic-sensitive-response', { status: status as number })))
    const result = await service.test(saved.id)
    expect(result).toMatchObject({ authorized: false, errorCode })
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-response')
    expect(JSON.stringify(result)).not.toContain('synthetic-github-token')
  })

  it('keeps network failures and empty tool permissions unavailable', async () => {
    const saved = await configured()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed with synthetic-secret') }))
    expect(await service.test(saved.id)).toMatchObject({ state: 'error', authorized: false, errorCode: 'network_blocked' })
    protocol([])
    expect(await service.test(saved.id)).toMatchObject({ state: 'error', authorized: false, errorCode: 'tool_manifest_mismatch', toolCount: 0 })
    const blocked = await service.save({ config: { ...saved, toolPolicy: { '*': 'deny' } }, expectedRevision: saved.revision, idempotencyKey: 'deny-tools' })
    protocol()
    expect(await service.test(blocked.id)).toMatchObject({ authorized: false, errorCode: 'tool_manifest_mismatch' })
  })

  it('binds native token entry to the exact GitHub HTTPS origin', () => {
    for (const url of [GITHUB_MCP_URL, GITHUB_MCP_READONLY_URL, 'https://api.githubcopilot.com/mcp/x/issues/readonly']) expect(isGitHubMcpServer({ transport: 'http', url })).toBe(true)
    for (const url of ['http://api.githubcopilot.com/mcp/', 'https://api.githubcopilot.com.evil.test/mcp/', 'https://someone@api.githubcopilot.com/mcp/', `${GITHUB_MCP_URL}?token=secret`]) expect(isGitHubMcpServer({ transport: 'http', url })).toBe(false)
  })
})
