import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InstalledPackageV1, MarketplacePackageV1 } from '../../shared/marketplace'
import { activatePluginPackage } from './plugin-activation-service'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ item: MarketplacePackageV1; installed: InstalledPackageV1 }> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-plugin-activation-'))
  roots.push(root)
  const packageRoot = join(root, 'node_modules', '@example', 'server')
  await mkdir(join(packageRoot, 'dist'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@example/server',
    version: '1.2.3',
    bin: { 'example-mcp': 'dist/server.js' }
  }))
  await writeFile(join(packageRoot, 'dist', 'server.js'), 'console.log("ready")\n')
  const source = {
    id: 'source-1',
    catalogSourceId: 'official',
    kind: 'npm' as const,
    location: 'https://www.npmjs.com/package/@example/server',
    packageName: '@example/server',
    version: '1.2.3',
    resolvedRef: '1.2.3',
    digest: { algorithm: 'sha512-sri' as const, value: 'sha512-dGVzdA==' }
  }
  const item: MarketplacePackageV1 = {
    schemaVersion: 1,
    id: 'example-server',
    name: 'Example Server',
    summary: 'Activation fixture.',
    tier: 'recommended',
    version: '1.2.3',
    publisher: { id: 'example', name: 'Example', verified: true },
    license: 'MIT',
    source,
    sources: [source],
    components: [{
      id: 'example-mcp',
      name: 'Example MCP',
      type: 'mcp',
      sourceId: source.id,
      runtime: {
        kind: 'npm',
        packageName: source.packageName,
        version: source.version,
        executable: 'example-mcp',
        args: ['--root', '${workspaceRoot}'],
        install: { strategy: 'managed-download', verify: 'sri-before-activation', digestSource: 'component-source' }
      }
    }],
    permissions: [{
      id: 'filesystem.read',
      kind: 'filesystem',
      access: 'read',
      default: 'review',
      reviewRequired: true,
      description: 'Read workspace files.'
    }],
    auth: { type: 'token', provider: 'example', environmentVariables: ['EXAMPLE_TOKEN'] },
    licenseEvidence: [],
    dependencies: [],
    updatePolicy: { strategy: 'pinned', channel: 'stable', allowMajor: false },
    compatibility: { workwise: '>=0.3.5', platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'] },
    availability: { status: 'available' },
    installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
  }
  const installed: InstalledPackageV1 = {
    schemaVersion: 1,
    packageId: item.id,
    version: item.version,
    license: item.license,
    reviewSha256: 'a'.repeat(64),
    source,
    sources: [source],
    components: [{ componentId: 'example-mcp', sourceId: source.id }],
    scope: 'workspace',
    workspaceRoot: '/tmp/workspace',
    artifact: { sha256: 'b'.repeat(64), location: root, fileCount: 2, totalBytes: 20 },
    permissions: [{ permissionId: 'filesystem.read', decision: 'granted' }],
    timestamps: { installedAt: '2026-08-08T00:00:00.000Z' },
    updatePolicy: item.updatePolicy,
    rollback: { available: false },
    health: { status: 'healthy' }
  }
  return { item, installed }
}

describe('activatePluginPackage', () => {
  it('reports removed MCP components when an update now contains only Skills', async () => {
    const { item, installed } = await fixture()
    installed.rollback = { ...installed, available: true }
    const priorComponent = item.components[0]!
    item.components = [{ ...priorComponent, type: 'skill', runtime: { kind: 'system', provider: 'fixture', capability: 'skill' }, skillNames: ['replacement-skill'] }]
    const previous = { id: 'example-mcp', source: 'managed-tool', enabled: true, revision: 3 }
    const untouched = { id: 'user-server', source: 'user', enabled: true, revision: 2 }
    const save = vi.fn(async ({ config }) => ({ ...config, revision: 4 }))
    const result = await activatePluginPackage({ item, installed, workspaceRoot: '/tmp/workspace',
      mcpConfigService: { list: async () => [previous, untouched], save } as never, idempotencyKey: 'replace-with-skill' })
    expect(result).toEqual({ mcpChanged: true })
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      config: { ...previous, enabled: false }, expectedRevision: 3
    }))
    expect(previous.enabled).toBe(true)
    expect(untouched.enabled).toBe(true)
  })

  it('activates verified npm entrypoints in MCP V2 without shell command strings', async () => {
    const { item, installed } = await fixture()
    const save = vi.fn(async ({ config }) => ({ ...config, revision: 1 }))
    const mcpConfigService = { list: vi.fn(async () => []), save }

    await activatePluginPackage({
      item,
      installed,
      workspaceRoot: '/tmp/workspace',
      mcpConfigService: mcpConfigService as never,
      idempotencyKey: 'activate-example'
    })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        id: 'example-mcp',
        transport: 'stdio',
        command: process.platform === 'win32' ? 'node.exe' : 'node',
        args: [expect.stringMatching(/dist[/\\]server\.js$/), '--root', '/tmp/workspace'],
        credentialEnvironmentVariables: ['EXAMPLE_TOKEN'],
        enabled: true
      })
    }))
  })

  it('keeps the MCP server disabled when a declared permission is denied', async () => {
    const { item, installed } = await fixture()
    installed.permissions = [{ permissionId: 'filesystem.read', decision: 'denied' }]
    const save = vi.fn(async ({ config }) => ({ ...config, revision: 1 }))

    await activatePluginPackage({
      item,
      installed,
      workspaceRoot: '/tmp/workspace',
      mcpConfigService: { list: vi.fn(async () => []), save } as never,
      idempotencyKey: 'activate-denied'
    })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ enabled: false })
    }))
  })

  it('does not overwrite a user-owned MCP server with the same component ID', async () => {
    const { item, installed } = await fixture()
    const existing = {
      id: 'example-mcp',
      name: 'User server',
      scope: 'workspace',
      workspaceRoot: '/tmp/workspace',
      transport: 'stdio',
      command: 'user-command',
      args: [],
      timeoutMs: 30_000,
      source: 'user',
      toolPolicy: {},
      enabled: true,
      revision: 2
    }
    const save = vi.fn()

    await expect(activatePluginPackage({
      item,
      installed,
      workspaceRoot: '/tmp/workspace',
      mcpConfigService: { list: vi.fn(async () => [existing]), save } as never,
      idempotencyKey: 'activate-collision'
    })).rejects.toThrow(/existing user server/i)
    expect(save).not.toHaveBeenCalled()
  })

  it('disables newly written MCP configs when a later activation write fails', async () => {
    const { item, installed } = await fixture()
    item.components.push({
      ...item.components[0]!,
      id: 'second-mcp',
      name: 'Second MCP'
    })
    installed.components.push({ componentId: 'second-mcp', sourceId: item.source.id })
    const save = vi.fn(async (request: {
      config: { id: string; enabled: boolean }
      expectedRevision: number
    }) => {
      if (request.config.id === 'second-mcp') throw new Error('manifest write failed')
      return { ...request.config, revision: request.expectedRevision + 1 }
    })

    await expect(activatePluginPackage({
      item,
      installed,
      workspaceRoot: '/tmp/workspace',
      mcpConfigService: { list: vi.fn(async () => []), save } as never,
      idempotencyKey: 'activate-transaction'
    })).rejects.toThrow(/manifest write failed/i)

    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({ id: 'example-mcp', enabled: false }),
      expectedRevision: 1,
      idempotencyKey: 'activate-transaction:compensate:0:example-mcp'
    }))
  })

  it('disables managed MCP components removed by an update or rollback', async () => {
    const { item, installed } = await fixture()
    installed.rollback = {
      available: true,
      version: '1.1.0',
      license: 'MIT',
      reviewSha256: 'c'.repeat(64),
      source: installed.source,
      sources: installed.sources,
      components: [{ componentId: 'removed-mcp', sourceId: installed.source.id }],
      artifact: installed.artifact,
      permissions: installed.permissions,
      updatePolicy: installed.updatePolicy,
      health: { status: 'healthy' }
    }
    const removedServer = {
      id: 'removed-mcp',
      name: 'Removed MCP',
      scope: 'workspace',
      workspaceRoot: '/tmp/workspace',
      transport: 'stdio',
      command: 'node',
      args: ['/tmp/removed.js'],
      timeoutMs: 30_000,
      source: 'managed-tool',
      toolPolicy: {},
      enabled: true,
      revision: 3
    }
    const save = vi.fn(async ({ config }) => ({ ...config, revision: 4 }))

    await activatePluginPackage({
      item,
      installed,
      workspaceRoot: '/tmp/workspace',
      mcpConfigService: { list: vi.fn(async () => [removedServer]), save } as never,
      idempotencyKey: 'activate-with-removed-component'
    })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ id: 'removed-mcp', enabled: false }),
      expectedRevision: 3,
      idempotencyKey: 'activate-with-removed-component:disable:removed-mcp'
    }))
  })

  it('activates a verified PyPI entry point through its isolated Python environment', async () => {
    const { item, installed } = await fixture()
    const source = {
      id: 'python-source',
      catalogSourceId: 'official',
      kind: 'pypi' as const,
      location: 'https://pypi.org/project/example-python/1.2.3/',
      packageName: 'example-python',
      version: '1.2.3',
      resolvedRef: '1.2.3',
      digest: { algorithm: 'sha256' as const, value: 'c'.repeat(64) }
    }
    item.source = source
    item.sources = [source]
    item.components = [{
      id: 'example-python-mcp',
      name: 'Example Python MCP',
      type: 'mcp',
      sourceId: source.id,
      runtime: {
        kind: 'uv',
        packageName: source.packageName,
        version: source.version,
        executable: 'example-python-mcp',
        args: ['--root', '${workspaceRoot}'],
        install: {
          strategy: 'managed-wheel',
          verify: 'sha256-before-activation',
          digest: source.digest
        }
      }
    }]
    installed.source = source
    installed.sources = [source]
    installed.components = [{ componentId: 'example-python-mcp', sourceId: source.id }]
    const python = join(installed.artifact.location, 'managed-python')
    const sitePackages = process.platform === 'win32'
      ? join(installed.artifact.location, '.venv', 'Lib', 'site-packages')
      : join(installed.artifact.location, '.venv', 'lib', 'python3.12', 'site-packages')
    await mkdir(sitePackages, { recursive: true })
    await writeFile(python, 'python')
    await writeFile(join(installed.artifact.location, 'workwise-python-launcher.py'), 'print("launcher")\n')
    const lock = `example-python==1.2.3 --hash=sha256:${source.digest.value}\n`
    await writeFile(join(installed.artifact.location, 'requirements.lock'), lock)
    await writeFile(join(installed.artifact.location, 'workwise-python-runtime.json'), JSON.stringify({
      schema: 'workwise.python-runtime',
      version: 1,
      packageName: source.packageName,
      packageVersion: source.version,
      entrypoints: ['example-python-mcp'],
      uvVersion: '0.12.3',
      pythonVersion: '3.12.12',
      wheel: { sha256: source.digest.value },
      sitePackages: process.platform === 'win32'
        ? '.venv/Lib/site-packages'
        : '.venv/lib/python3.12/site-packages',
      lockSha256: createHash('sha256').update(lock).digest('hex')
    }))
    const save = vi.fn(async ({ config }) => ({ ...config, revision: 1 }))

    await activatePluginPackage({
      item,
      installed,
      workspaceRoot: '/tmp/workspace',
      mcpConfigService: { list: vi.fn(async () => []), save } as never,
      managedUvRuntime: { ensure: async () => ({
        uvPath: python,
        uvVersion: '0.12.3',
        pythonPath: python,
        pythonVersion: '3.12.12',
        cacheDirectory: join(installed.artifact.location, 'cache'),
        pythonInstallDirectory: join(installed.artifact.location, 'python')
      }) },
      idempotencyKey: 'activate-python'
    })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        id: 'example-python-mcp',
        command: await realpath(python),
        args: [
          '-I',
          expect.stringMatching(/workwise-python-launcher\.py$/),
          await realpath(sitePackages),
          'example-python',
          'example-python-mcp',
          '--root',
          '/tmp/workspace'
        ]
      })
    }))
  })

  it('activates MCPB uv packages only through the pinned managed runtime', async () => {
    const { item, installed } = await fixture()
    const entrypoint = join(installed.artifact.location, 'server', 'main.py')
    const uvPath = join(installed.artifact.location, 'managed-runtime', process.platform === 'win32' ? 'uv.exe' : 'uv')
    const pythonPath = join(installed.artifact.location, 'managed-runtime', process.platform === 'win32' ? 'python.exe' : 'python')
    const cacheDirectory = join(installed.artifact.location, 'managed-cache')
    await mkdir(join(entrypoint, '..'), { recursive: true })
    await mkdir(join(uvPath, '..'), { recursive: true })
    await mkdir(cacheDirectory, { recursive: true })
    await writeFile(entrypoint, 'print("ready")\n')
    await writeFile(join(installed.artifact.location, 'pyproject.toml'), '[project]\nname = "example"\nversion = "1.0.0"\n')
    await writeFile(join(installed.artifact.location, 'uv.lock'), 'version = 1\nrevision = 1\nrequires-python = ">=3.12"\n')
    await writeFile(uvPath, 'managed uv')
    await writeFile(pythonPath, 'managed python')
    item.components = [{
      id: 'example-uv-mcp',
      name: 'Example uv MCP',
      type: 'mcp',
      sourceId: item.source.id,
      runtime: {
        kind: 'bundled',
        entrypoint: 'server/main.py',
        executable: 'uv',
        args: ['run', '${__dirname}/server/main.py', '--workspace', '${workspaceRoot}'],
        managedRuntime: 'uv'
      }
    }]
    installed.components = [{ componentId: 'example-uv-mcp', sourceId: item.source.id }]
    const ensure = vi.fn(async () => ({
      uvPath,
      uvVersion: '0.12.3',
      pythonPath,
      pythonVersion: '3.12.12',
      cacheDirectory,
      pythonInstallDirectory: join(installed.artifact.location, 'managed-python')
    }))
    const save = vi.fn(async ({ config }) => ({ ...config, revision: 1 }))

    await activatePluginPackage({
      item,
      installed,
      workspaceRoot: '/tmp/workspace',
      mcpConfigService: { list: vi.fn(async () => []), save } as never,
      managedUvRuntime: { ensure },
      idempotencyKey: 'activate-mcpb-uv'
    })

    expect(ensure).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        command: await realpath(uvPath),
        args: [
          '--cache-dir', cacheDirectory,
          '--managed-python',
          '--no-python-downloads',
          '--no-progress',
          '--directory', await realpath(installed.artifact.location),
          '--no-config',
          'run',
          '--locked',
          '--isolated',
          '--no-env-file',
          '--no-editable',
          '--python', pythonPath,
          await realpath(entrypoint),
          '--workspace',
          '/tmp/workspace'
        ]
      })
    }))
    expect(save.mock.calls[0]?.[0].config.command).not.toBe('uv')
  })
})
