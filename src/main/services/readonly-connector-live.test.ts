import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { ManagedUvRuntimeService } from './managed-uv-runtime-service'
import { materializePypiPackage, ZOTERO_BIBTEX_BUILD } from './pypi-package-materializer'
import { McpConfigService } from './mcp-config-service'
import { ZOTERO_READ_TOOLS } from '../../shared/engineering-marketplace'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

// Explicit package-download acceptance. Uses an isolated root and no account.
describe('upstream Zotero installation acceptance', () => {
  it.runIf(process.env.RAILWISE_ZOTERO_INSTALL_ACCEPTANCE === '1')('materializes the exact upstream wheel and a hash-locked core dependency environment', async () => {
    const root = process.env.RAILWISE_CONNECTOR_ACCEPTANCE_ROOT
    if (!root) throw new Error('An isolated acceptance root is required.')
    await mkdir(root, { recursive: true })
    const item = getOfficialMarketplaceCatalog().find(item => item.id === 'zotero-mcp')!
    const target = join(root, 'zotero-0.17.0')
    await materializePypiPackage(item, target, { runtime: new ManagedUvRuntimeService({ rootDirectory: join(root, 'uv-runtime') }) })
    const manifest = JSON.parse(await readFile(join(target, 'workwise-python-runtime.json'), 'utf8'))
    const lock = await readFile(join(target, 'requirements.lock'), 'utf8')
    expect(manifest.packageVersion).toBe('0.17.0')
    expect(manifest.entrypoints).toContain('zotero-mcp')
    expect(manifest.sourceBuild).toEqual(ZOTERO_BIBTEX_BUILD)
    expect(lock).toContain(ZOTERO_BIBTEX_BUILD.sha256)
    expect(lock).not.toMatch(/^(?:chromadb|sentence-transformers|pymupdf|torch)==/m)
    await writeFile(join(root, 'zotero-install-evidence.json'), JSON.stringify({ package: manifest.packageName, version: manifest.packageVersion, wheel: manifest.wheel, sourceBuild: manifest.sourceBuild, lockSha256: manifest.lockSha256, coreOnly: true, accountAccess: false }, null, 2))
  }, 15 * 60_000)

  it.runIf(process.env.RAILWISE_ZOTERO_RUNTIME_ACCEPTANCE === '1')('starts the installed isolated Python entrypoint and discovers its readonly tools without library access', async () => {
    const root = process.env.RAILWISE_CONNECTOR_ACCEPTANCE_ROOT
    if (!root) throw new Error('An isolated acceptance root is required.')
    const target = join(root, 'zotero-0.17.0')
    const manifest = JSON.parse(await readFile(join(target, 'workwise-python-runtime.json'), 'utf8'))
    const runtime = await new ManagedUvRuntimeService({ rootDirectory: join(root, 'uv-runtime') }).ensure()
    const config = new McpConfigService({ manifestPath: join(root, 'runtime-check', 'mcp.json'), credentialRoot: join(root, 'runtime-check', 'credentials'), legacyPath: join(root, 'runtime-check', 'legacy.json') })
    const saved = await config.save({ config: { id: 'zotero-runtime-check', name: 'Zotero isolated runtime check', scope: 'global', transport: 'stdio',
      command: runtime.pythonPath, args: ['-I', join(target, 'workwise-python-launcher.py'), join(target, manifest.sitePackages), manifest.packageName, 'zotero-mcp', 'serve'],
      timeoutMs: 30_000, source: 'managed-tool', managedPreset: 'zotero-readonly', toolPolicy: {}, enabled: false }, expectedRevision: 0, idempotencyKey: 'readonly-runtime-check' })
    const snapshot = (await config.runtimeSnapshot()).servers[saved.id]
    const client = new Client({ name: 'railwise-zotero-readonly-acceptance', version: '1.0.0' })
    try {
      await client.connect(new StdioClientTransport({ command: snapshot.command as string, args: snapshot.args as string[], cwd: snapshot.cwd as string, env: snapshot.env as Record<string, string>, stderr: 'ignore' }), { timeout: 30_000 })
      const discovered = await client.listTools({}, { timeout: 30_000 })
      const approved = discovered.tools.filter(tool => ZOTERO_READ_TOOLS.some(name => name === tool.name)).map(tool => tool.name)
      expect(approved.sort()).toEqual([...ZOTERO_READ_TOOLS].sort())
      await writeFile(join(root, 'zotero-runtime-evidence.json'), JSON.stringify({ package: manifest.packageName, version: manifest.packageVersion,
        discoveredTools: discovered.tools.length, readonlyTools: approved, operations: ['initialize', 'tools/list'], businessToolCalls: 0,
        localLibraryAccess: false, isolatedConfiguration: true, enabledForTasks: false }, null, 2))
    } finally { await client.close() }
  }, 90_000)
})
