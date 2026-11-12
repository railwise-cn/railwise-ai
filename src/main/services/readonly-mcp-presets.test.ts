import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpConfigService } from './mcp-config-service'
import { AMAP_READ_TOOLS, ZOTERO_READ_TOOLS } from '../../shared/engineering-marketplace'

vi.mock('./im-credential-helper', () => ({
  encryptStringWithCredentialHelper: vi.fn(async (value: string) => Buffer.from(value)),
  decryptStringWithCredentialHelper: vi.fn(async (value: Buffer) => value.toString()),
  requestInteractiveCredentialHelperAccess: vi.fn()
}))

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' } }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(persistent = false) {
  const root = await mkdtemp(join(tmpdir(), 'railwise-readonly-mcp-')); roots.push(root)
  const options = { manifestPath: join(root, 'mcp.json'), legacyPath: join(root, 'old.json'), credentialRoot: join(root, 'credentials'),
    encryption: { available: () => persistent, encrypt: (value:string) => Buffer.from(value), decrypt: (value:Buffer) => value.toString(), storage: 'safe-storage' as const } }
  return { root, options, service: new McpConfigService(options) }
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
    expect(snapshot.environment).toEqual({})
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

  it('persists real checks across reopening, preserves check-then-enable, and invalidates disable/configuration/credential changes', async () => {
    const { root, options, service } = await fixture(true)
    let server = await service.save({ config: amap(), expectedRevision: 0, idempotencyKey: 'create' })
    server = await service.setCredential({ serverId: server.id, accessToken: 'synthetic-key-one', expectedRevision: server.revision, idempotencyKey: 'key-one' })
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: AMAP_READ_TOOLS.map(name => ({ name, inputSchema: { type: 'object' } })) })
    const result = await service.test(server.id)
    expect(result).toMatchObject({ state: 'connected', authorized: true, verification: 'tool_discovery', toolCount: AMAP_READ_TOOLS.length, checkedAt: expect.any(String) })
    const reopened = new McpConfigService(options)
    server = (await reopened.list())[0]
    expect(server.connectionCheck).toMatchObject({ serverRevision: server.revision, credentialRefId: server.credentialRef!.id, checkedAt: result.checkedAt, verification: 'tool_discovery' })
    server = await reopened.save({ config: { ...server, enabled: true }, expectedRevision: server.revision, idempotencyKey: 'enable' })
    expect(server.connectionCheck).toMatchObject({ serverRevision: server.revision, checkedAt: result.checkedAt })
    server = await reopened.save({ config: { ...server, enabled: false }, expectedRevision: server.revision, idempotencyKey: 'disable' })
    expect(server.connectionCheck).toBeUndefined()
    await reopened.test(server.id)
    server = (await reopened.list())[0]
    server = await reopened.save({ config: { ...server, name: 'Renamed' }, expectedRevision: server.revision, idempotencyKey: 'rename' })
    expect(server.connectionCheck).toBeUndefined()
    await reopened.test(server.id)
    server = await reopened.setCredential({ serverId: server.id, accessToken: 'synthetic-key-two', expectedRevision: server.revision, idempotencyKey: 'key-two' })
    expect(server.connectionCheck).toBeUndefined()
    const manifest = await readFile(join(root, 'mcp.json'), 'utf8')
    expect(manifest).not.toContain('synthetic-key')
    expect(JSON.stringify((await reopened.runtimeSnapshot()).servers)).not.toContain('connectionCheck')
  })

  it('replaces success with failure and discards checks completed after a configuration change', async () => {
    const { service } = await fixture()
    let server = await service.save({ config: amap(), expectedRevision: 0, idempotencyKey: 'create' })
    server = await service.setCredential({ serverId: server.id, accessToken: 'synthetic-only', expectedRevision: server.revision, idempotencyKey: 'key' })
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    const tools = vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] })
    await service.test(server.id)
    tools.mockRejectedValueOnce(new Error('private URL and credential must not be stored'))
    expect(await service.test(server.id)).toMatchObject({ state: 'error', authorized: false })
    expect((await service.list())[0].connectionCheck).toMatchObject({ state: 'error', authorized: false })
    let finish!: () => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    tools.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { finish = resolve }); return { tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] } })
    const pending = service.test(server.id)
    await waiting
    server = await service.save({ config: { ...server, name: 'Changed while checking' }, expectedRevision: server.revision, idempotencyKey: 'change' })
    finish()
    expect(await pending).toMatchObject({ state: 'error', authorized: false, errorCode: 'configuration_changed' })
    expect((await service.list())[0].connectionCheck).toBeUndefined()
    expect(server.connectionCheck).toBeUndefined()
  })

  it('does not trust incoming evidence or retain a session-credential check after restart', async () => {
    const { service, options } = await fixture()
    let server = await service.save({ config: { ...amap(), connectionCheck: { serverRevision: 1, configurationHash: 'a'.repeat(64), checkedAt: new Date().toISOString(), state: 'connected', authorized: true, verification: 'tool_discovery', toolCount: 11 } }, expectedRevision: 0, idempotencyKey: 'spoof' })
    expect(server.connectionCheck).toBeUndefined()
    server = await service.setCredential({ serverId: server.id, accessToken: 'synthetic-only', expectedRevision: server.revision, idempotencyKey: 'key' })
    vi.spyOn(Client.prototype, 'connect').mockResolvedValue(undefined)
    vi.spyOn(Client.prototype, 'listTools').mockResolvedValue({ tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] })
    await service.test(server.id)
    expect((await service.list())[0].connectionCheck?.authorized).toBe(true)
    expect((await new McpConfigService(options).list())[0].connectionCheck).toBeUndefined()
    const edited = JSON.parse(await readFile(options.manifestPath, 'utf8'))
    edited.servers[0].name = 'Changed outside the configuration API'
    await writeFile(options.manifestPath, JSON.stringify(edited))
    expect((await service.list())[0].connectionCheck).toBeUndefined()
  })
})


it('distinguishes a saved Amap credential access denial from a missing key or network failure', async () => {
  const { options, service } = await fixture(true)
  const saved = await service.save({ config: amap(), expectedRevision: 0, idempotencyKey: 'create-denied-amap' })
  await service.setCredential({ serverId: saved.id, accessToken: 'synthetic-preserved-key', expectedRevision: saved.revision, idempotencyKey: 'denied-amap-key' })
  const denied = new McpConfigService({ ...options, encryption: { ...options.encryption,
    decrypt: async () => { throw Object.assign(new Error('synthetic denied'), { code: 'credential_helper_access_denied' }) }
  } })
  const connect = vi.spyOn(Client.prototype, 'connect')
  expect(await denied.test(saved.id)).toMatchObject({ state: 'needs_authorization', authorized: false, errorCode: 'credential_helper_access_denied', message: expect.stringContaining('重新检查连接') })
  expect(connect).not.toHaveBeenCalled()
  expect((await denied.list())[0].credentialRef).toEqual((await service.list())[0].credentialRef)
})
