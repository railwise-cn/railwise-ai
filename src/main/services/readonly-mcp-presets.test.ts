import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpConfigService } from './mcp-config-service'
import { AMAP_READ_TOOLS, ZOTERO_READ_TOOLS } from '../../shared/engineering-marketplace'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' } }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'railwise-readonly-mcp-')); roots.push(root)
  return { root, service: new McpConfigService({ manifestPath: join(root, 'mcp.json'), legacyPath: join(root, 'old.json'), credentialRoot: join(root, 'credentials') }) }
}
function amap() {
  return { id: 'amap-maps-server', name: '高德', scope: 'global' as const, transport: 'http' as const, url: 'https://mcp.amap.com/mcp', timeoutMs: 1000, source: 'managed-tool' as const, managedPreset: 'amap-readonly' as const, toolPolicy: {}, enabled: false }
}

describe('readonly connector configuration', () => {
  it('keeps the Amap key out of manifests and Runtime JSON while forwarding a bounded tool policy', async () => {
    const { root, service } = await fixture()
    const saved = await service.save({ config: amap(), expectedRevision: 0, idempotencyKey: 'create' })
    await service.setCredential({ serverId: saved.id, accessToken: 'synthetic-amap-secret', expectedRevision: saved.revision, idempotencyKey: 'credential' })
    const snapshot = await service.runtimeSnapshot()
    expect(JSON.stringify(snapshot.servers)).not.toContain('synthetic-amap-secret')
    expect(await readFile(join(root, 'mcp.json'), 'utf8')).not.toContain('synthetic-amap-secret')
    expect(snapshot.servers[saved.id].url).toMatch(/^https:\/\/mcp\.amap\.com\/mcp\?key=\$\{WORKWISE_MCP_SECRET_[A-F0-9]+\}$/)
    expect(Object.values(snapshot.environment)).toContain('synthetic-amap-secret')
    expect(snapshot.servers[saved.id].toolPolicy).toEqual({ allowedTools: [...AMAP_READ_TOOLS], readOnlyTools: [...AMAP_READ_TOOLS] })
    await expect(service.save({ config: { ...amap(), id: 'bad', url: 'https://other.example/mcp' }, expectedRevision: 0, idempotencyKey: 'bad' })).rejects.toThrow('官方固定')
  })

  it('isolates Zotero configuration, removes write credentials and omits optional semantic toolsets', async () => {
    const { root, service } = await fixture()
    await service.save({ config: { id: 'zotero-mcp-server', name: 'Zotero', scope: 'global', transport: 'stdio', command: 'python', args: ['launcher.py'], timeoutMs: 1000, source: 'managed-tool', managedPreset: 'zotero-readonly', toolPolicy: {}, enabled: false }, expectedRevision: 0, idempotencyKey: 'zotero' })
    const snapshot = await service.runtimeSnapshot()
    const server = snapshot.servers['zotero-mcp-server']
    expect(server.cwd).toBe(join(root, 'connector-profiles', 'zotero-readonly'))
    expect(server.env).toMatchObject({ HOME: server.cwd, ZOTERO_LOCAL: 'true', ZOTERO_LOCAL_WRITE: 'false', ZOTERO_API_KEY: '', ZOTERO_LOCAL_API_KEY: '', ZOTERO_NO_CLAUDE: 'true', ZOTERO_MCP_TOOLSETS: 'none', PYTHON_DOTENV_DISABLED: '1' })
    expect(server.toolPolicy).toEqual({ allowedTools: [...ZOTERO_READ_TOOLS], readOnlyTools: [...ZOTERO_READ_TOOLS] })
  })

  it('requires credentials and discovered allowed tools before reporting a usable connection', async () => {
    const { service } = await fixture()
    const saved = await service.save({ config: amap(), expectedRevision: 0, idempotencyKey: 'create' })
    expect(await service.test(saved.id)).toMatchObject({ state: 'needs_authorization', authorized: false })
    await service.setCredential({ serverId: saved.id, accessToken: 'synthetic-only', expectedRevision: saved.revision, idempotencyKey: 'credential' })
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const list = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'unexpected_write', inputSchema: { type: 'object' } }] })
    expect(await service.test(saved.id)).toMatchObject({ state: 'error', authorized: false })
    list.mockResolvedValue({ tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] })
    expect(await service.test(saved.id)).toMatchObject({ state: 'connected', authorized: true, message: '已发现 1 项只读工具。' })
  })
})
