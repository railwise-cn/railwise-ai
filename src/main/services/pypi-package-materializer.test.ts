import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketplacePackageV1 } from '../../shared/marketplace'
import {
  materializePypiPackage,
  preservePypiLicense,
  validatePythonDependencyLock
} from './pypi-package-materializer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'workwise-pypi-materializer-'))
  roots.push(value)
  return value
}

function body(bytes: Buffer): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

async function wheel(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('fixture_package/__init__.py', '__version__ = "1.0.0"\n')
  zip.file('fixture_package-1.0.0.dist-info/licenses/LICENSE', 'MIT License\n')
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function wheelWithoutLicense(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('fixture_package/__init__.py', '__version__ = "1.0.0"\n')
  return zip.generateAsync({ type: 'nodebuffer' })
}

function item(digest: string): MarketplacePackageV1 {
  const source = {
    id: 'fixture-source',
    catalogSourceId: 'workwise-official',
    kind: 'pypi' as const,
    location: 'https://pypi.org/project/fixture-package/1.0.0/',
    packageName: 'fixture-package',
    version: '1.0.0',
    resolvedRef: '1.0.0',
    digest: { algorithm: 'sha256' as const, value: digest }
  }
  return {
    schemaVersion: 1,
    id: 'fixture-package',
    name: 'Fixture Package',
    summary: 'Python package fixture.',
    tier: 'advanced',
    version: '1.0.0',
    publisher: { id: 'fixture', name: 'Fixture', verified: true },
    license: 'MIT',
    source,
    sources: [source],
    components: [{
      id: 'fixture-mcp',
      name: 'Fixture MCP',
      type: 'mcp',
      sourceId: source.id,
      runtime: {
        kind: 'uv',
        packageName: source.packageName,
        version: source.version,
        executable: 'fixture-mcp',
        args: [],
        install: {
          strategy: 'managed-wheel',
          verify: 'sha256-before-activation',
          digest: source.digest
        }
      }
    }],
    permissions: [],
    auth: { type: 'none' },
    licenseEvidence: [],
    dependencies: [],
    updatePolicy: { strategy: 'pinned', channel: 'stable', allowMajor: false },
    compatibility: { workwise: '>=0.3.5', platforms: ['darwin'], architectures: ['arm64'] },
    availability: { status: 'available' },
    installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
  }
}

describe('materializePypiPackage', () => {
  it('fetches missing wheel license evidence from an immutable GitHub commit', async () => {
    const root = await tempRoot()
    const packageItem = item('a'.repeat(64))
    const source = {
      id: 'fixture-license-source',
      catalogSourceId: 'workwise-official',
      kind: 'github' as const,
      location: 'https://github.com/example/fixture',
      owner: 'example',
      repository: 'fixture',
      defaultBranch: 'main',
      requestedRef: 'b'.repeat(40),
      resolvedRef: 'b'.repeat(40)
    }
    packageItem.sources.push(source)
    packageItem.licenseEvidence = [{
      license: 'MIT',
      sourceId: source.id,
      path: 'LICENSE',
      includeInInstall: true,
      required: true
    }]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const license = Buffer.from('MIT License from immutable source\n')
      const response = new Response(JSON.stringify({
        type: 'file',
        path: 'LICENSE',
        size: license.byteLength,
        encoding: 'base64',
        content: license.toString('base64')
      }), { status: 200 })
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    })

    await preservePypiLicense(
      packageItem,
      root,
      await wheelWithoutLicense(),
      fetchMock as typeof fetch
    )

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.github.com/repos/example/fixture/contents/LICENSE?ref=${'b'.repeat(40)}`,
      expect.objectContaining({ redirect: 'error' })
    )
    expect(await readFile(join(root, 'LICENSE'), 'utf8')).toContain('immutable source')
  })

  it('verifies the primary wheel, locks every dependency hash, and creates an isolated runtime', async () => {
    const root = await tempRoot()
    const target = join(root, 'target')
    const uvPath = join(root, 'uv')
    const managedPython = join(root, 'managed-python')
    const virtualEnvPython = process.platform === 'win32'
      ? join(target, '.venv', 'Scripts', 'python.exe')
      : join(target, '.venv', 'bin', 'python')
    const virtualEnvSitePackages = process.platform === 'win32'
      ? join(target, '.venv', 'Lib', 'site-packages')
      : join(target, '.venv', 'lib', 'python3.12', 'site-packages')
    const portableSitePackages = process.platform === 'win32'
      ? '.venv/Lib/site-packages'
      : '.venv/lib/python3.12/site-packages'
    await writeFile(uvPath, 'uv')
    await writeFile(managedPython, 'python')
    const bytes = await wheel()
    const digest = createHash('sha256').update(bytes).digest('hex')
    const artifactUrl = 'https://files.pythonhosted.org/packages/fixture/fixture_package-1.0.0-py3-none-any.whl'
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://pypi.org/pypi/')) {
        return new Response(JSON.stringify({
          info: { name: 'fixture-package', version: '1.0.0' },
          urls: [{
            filename: 'fixture_package-1.0.0-py3-none-any.whl',
            url: artifactUrl,
            packagetype: 'bdist_wheel',
            yanked: false,
            size: bytes.byteLength,
            upload_time_iso_8601: '2026-08-01T12:00:00.000Z',
            digests: { sha256: digest }
          }]
        }), { status: 200 })
      }
      return new Response(body(bytes), {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) }
      })
    })
    const run = vi.fn(async (
      executable: string,
      args: string[],
      _options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
    ) => {
      if (executable === uvPath && args[0] === 'pip' && args[1] === 'compile') {
        const lockPath = args[args.indexOf('--output-file') + 1]!
        await writeFile(lockPath, [
          `fixture-package @ ${artifactUrl}#sha256=${digest} \\`,
          `    --hash=sha256:${digest}`,
          'fixture-dependency==2.0.0 \\',
          `    --hash=sha256:${'a'.repeat(64)}`,
          ''
        ].join('\n'))
        return { stdout: '' }
      }
      if (executable === uvPath && args[0] === 'venv') {
        await mkdir(join(virtualEnvPython, '..'), { recursive: true })
        await writeFile(virtualEnvPython, 'venv-python')
        return { stdout: '' }
      }
      if (executable === uvPath && args[0] === 'pip' && args[1] === 'sync') return { stdout: '' }
      if (executable === virtualEnvPython) {
        if (args.join(' ').includes('sysconfig')) {
          await mkdir(virtualEnvSitePackages, { recursive: true })
          return { stdout: `${virtualEnvSitePackages}\n` }
        }
        return { stdout: JSON.stringify({ name: 'fixture-package', version: '1.0.0', entrypoints: ['fixture-mcp'] }) }
      }
      throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`)
    })

    await materializePypiPackage(item(digest), target, {
      fetch: fetchMock as typeof fetch,
      run,
      runtime: { ensure: async () => ({
        uvPath,
        uvVersion: '0.12.3',
        pythonPath: managedPython,
        pythonVersion: '3.12.12',
        cacheDirectory: join(root, 'cache'),
        pythonInstallDirectory: join(root, 'python')
      }) }
    })

    expect(await readFile(join(target, 'LICENSE'), 'utf8')).toContain('MIT License')
    expect(await readFile(join(target, 'requirements.lock'), 'utf8')).toContain(`sha256:${digest}`)
    expect(JSON.parse(await readFile(join(target, 'workwise-python-runtime.json'), 'utf8'))).toMatchObject({
      packageName: 'fixture-package',
      packageVersion: '1.0.0',
      entrypoints: ['fixture-mcp'],
      uvVersion: '0.12.3',
      pythonVersion: '3.12.12',
      sitePackages: portableSitePackages
    })
    expect(run).toHaveBeenCalledWith(uvPath, expect.arrayContaining([
      'pip', 'compile', '--generate-hashes', '--exclude-newer', '2026-08-01T12:00:00.000Z'
    ]), expect.anything())
    expect(run).toHaveBeenCalledWith(uvPath, expect.arrayContaining([
      'pip', 'sync', '--require-hashes', '--strict', '--only-binary', ':all:'
    ]), expect.anything())
    const compileEnvironment = run.mock.calls.find(([, args]) =>
      args[0] === 'pip' && args[1] === 'compile'
    )?.[2].env
    expect(compileEnvironment).toMatchObject({
      UV_DEFAULT_INDEX: 'https://pypi.org/simple',
      UV_NO_CONFIG: '1',
      UV_PYTHON_DOWNLOADS: 'never'
    })
    expect(compileEnvironment).not.toHaveProperty('PIP_INDEX_URL')
    expect(compileEnvironment).not.toHaveProperty('UV_EXTRA_INDEX_URL')
  })

  it('rejects locks with any unhashed dependency', () => {
    expect(() => validatePythonDependencyLock([
      `fixture==1.0.0 --hash=sha256:${'a'.repeat(64)}`,
      'dependency==2.0.0'
    ].join('\n'), 'a'.repeat(64))).toThrow(/missing SHA-256 hashes/i)
  })

  it('rejects a wheel that no longer matches the catalog digest before running uv', async () => {
    const root = await tempRoot()
    const bytes = await wheel()
    const digest = createHash('sha256').update(bytes).digest('hex')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://pypi.org/pypi/')) {
        return new Response(JSON.stringify({
          info: { name: 'fixture-package', version: '1.0.0' },
          urls: [{
            filename: 'fixture_package-1.0.0-py3-none-any.whl',
            url: 'https://files.pythonhosted.org/packages/fixture/fixture.whl',
            packagetype: 'bdist_wheel',
            size: bytes.byteLength,
            upload_time_iso_8601: '2026-08-01T12:00:00.000Z',
            digests: { sha256: digest }
          }]
        }), { status: 200 })
      }
      return new Response(body(Buffer.from('modified-wheel')), { status: 200 })
    })
    const run = vi.fn()

    await expect(materializePypiPackage(item(digest), join(root, 'target'), {
      fetch: fetchMock as typeof fetch,
      run,
      runtime: { ensure: vi.fn() }
    })).rejects.toThrow(/SHA-256 or size verification failed/i)
    expect(run).not.toHaveBeenCalled()
  })
})


describe('mixed upstream license preservation', () => {
  it('keeps every license from the exact wheel alongside the compatibility LICENSE file', async () => {
    const root = await tempRoot()
    const zip = new JSZip()
    zip.file('fixture-1.0.0.dist-info/licenses/LICENSE', 'MIT License')
    zip.file('fixture-1.0.0.dist-info/licenses/plugin/LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENSE')
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    await preservePypiLicense({ ...item(createHash('sha256').update(bytes).digest('hex')), license: 'MIT AND AGPL-3.0-or-later' }, root, bytes, vi.fn() as never)
    expect(await readFile(join(root, 'LICENSE'), 'utf8')).toBe('MIT License')
    expect(await readFile(join(root, 'licenses/fixture-1.0.0.dist-info/licenses/plugin/LICENSE'), 'utf8')).toBe('GNU AFFERO GENERAL PUBLIC LICENSE')
  })
})
