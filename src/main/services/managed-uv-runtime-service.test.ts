import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_PYTHON_VERSION,
  MANAGED_UV_VERSION,
  ManagedUvRuntimeService,
  managedUvAsset,
  type ManagedUvAssetV1
} from './managed-uv-runtime-service'
import { managedDependency } from './managed-dependency-download'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'workwise-managed-uv-'))
  roots.push(value)
  return value
}

async function fixture(): Promise<{ bytes: Buffer; asset: ManagedUvAssetV1 }> {
  const zip = new JSZip()
  zip.file('uv-test/uv.exe', 'trusted-uv-binary')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  return {
    bytes,
    asset: {
      name: 'uv-test.zip',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      executable: 'uv.exe',
      archive: 'zip',
      target: 'test-windows'
    }
  }
}

function responseBody(bytes: Buffer): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

describe('ManagedUvRuntimeService', () => {
  it('pins every supported platform asset to the audited uv release', () => {
    expect(managedUvAsset('darwin', 'arm64')).toMatchObject({
      name: 'uv-0.12.3-py3-none-macosx_11_0_arm64.whl',
      sha256: '7c99f2524fe4b11d74dec85cef9b4d8b725d142dec04cd237f1c06fbdae1ee54'
    })
    expect(managedUvAsset('darwin', 'x64').sha256).toHaveLength(64)
    expect(managedUvAsset('win32', 'arm64').sha256).toHaveLength(64)
    expect(managedUvAsset('win32', 'x64').sha256).toHaveLength(64)
    expect(managedUvAsset('linux', 'arm64').sha256).toHaveLength(64)
    expect(managedUvAsset('linux', 'x64').sha256).toHaveLength(64)
    expect(() => managedUvAsset('freebsd', 'x64')).toThrow(/not supported/i)
  })

  it('installs from a verified archive, pins Python, and repairs a modified binary', async () => {
    const runtimeRoot = await root()
    const { bytes, asset } = await fixture()
    const pythonAsset = { ...managedDependency('python-win32-x64'), size: bytes.length, sha256: asset.sha256 }
    const fetchMock = vi.fn(async () => new Response(responseBody(bytes), {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) }
    }))
    let pythonPath = ''
    vi.stubEnv('UV_PYTHON_INSTALL_MIRROR', 'https://untrusted.example.test/python')
    const run = vi.fn(async (executable: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (executable.endsWith('python.exe') && args[0] === '--version') {
        return { stdout: `Python ${MANAGED_PYTHON_VERSION}\n` }
      }
      if (args[0] === '--version') return { stdout: `uv ${MANAGED_UV_VERSION} fixture\n` }
      if (args[0] === 'python' && args[1] === 'install') {
        expect(options.env?.UV_PYTHON_INSTALL_MIRROR).toBeUndefined()
        const metadata = JSON.parse(await readFile(options.env?.UV_PYTHON_DOWNLOADS_JSON_URL ?? '', 'utf8'))
        expect(Object.values(metadata)).toEqual([expect.objectContaining({
          build: '20260211', sha256: asset.sha256, url: expect.stringMatching(/^file:\/\//)
        })])
        pythonPath = join(runtimeRoot, 'python', 'cpython-test', 'python.exe')
        await mkdir(join(runtimeRoot, 'python', 'cpython-test'), { recursive: true })
        await writeFile(pythonPath, 'managed-python')
        await chmod(pythonPath, 0o700)
        return { stdout: '' }
      }
      if (args[0] === 'python' && args[1] === 'find') return { stdout: `${pythonPath}\n` }
      throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`)
    })
    const service = new ManagedUvRuntimeService({
      rootDirectory: runtimeRoot,
      platform: 'win32',
      arch: 'x64',
      asset,
      pythonAsset,
      fetch: fetchMock as typeof fetch,
      run
    })

    const installed = await service.ensure()
    expect(installed).toMatchObject({
      uvVersion: MANAGED_UV_VERSION,
      pythonVersion: MANAGED_PYTHON_VERSION,
      pythonPath: await realpath(pythonPath)
    })
    expect(await readFile(installed.uvPath, 'utf8')).toBe('trusted-uv-binary')
    await writeFile(installed.uvPath, 'modified')
    const repaired = await service.ensure()
    expect(await readFile(repaired.uvPath, 'utf8')).toBe('trusted-uv-binary')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects an archive before extraction when its SHA-256 differs', async () => {
    const runtimeRoot = await root()
    const { bytes, asset } = await fixture()
    const service = new ManagedUvRuntimeService({
      rootDirectory: runtimeRoot,
      platform: 'win32',
      arch: 'x64',
      asset: { ...asset, sha256: '0'.repeat(64) },
      fetch: vi.fn(async () => new Response(responseBody(bytes), { status: 200 })) as typeof fetch,
      run: vi.fn()
    })

    await expect(service.ensure()).rejects.toThrow(/SHA-256 verification failed/i)
  })

  it('rejects a download redirected away from approved GitHub HTTPS hosts', async () => {
    const runtimeRoot = await root()
    const { bytes, asset } = await fixture()
    const response = new Response(responseBody(bytes), { status: 200 })
    Object.defineProperty(response, 'url', { value: 'https://downloads.example.test/uv-test.zip' })
    const service = new ManagedUvRuntimeService({
      rootDirectory: runtimeRoot,
      platform: 'win32',
      arch: 'x64',
      asset,
      fetch: vi.fn(async () => response) as typeof fetch,
      run: vi.fn()
    })

    await expect(service.ensure()).rejects.toThrow(/approved GitHub HTTPS host/i)
  })
})
