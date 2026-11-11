import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedUvRuntimeService } from './managed-uv-runtime-service'
import { installManagedTool, managedToolsSkillRoot } from './managed-tool-service'

const enabled = process.env.RAILWISE_DEPENDENCY_MIRROR_ACCEPTANCE === '1'
const execFileAsync = promisify(execFile)
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe.runIf(enabled)('immutable managed dependency cold-cache acceptance', () => {
  it('installs uv, Python, Lark and companion Skills using only the company mirror', async () => {
    const parent = resolve(process.env.RAILWISE_DEPENDENCY_ACCEPTANCE_ROOT || tmpdir())
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'mirror-cold-cache-'))
    const realFetch = globalThis.fetch
    const downloads: string[] = []
    const companyOnlyFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.origin !== 'https://www.railwise.cn' || !url.pathname.startsWith('/downloads/railwise-ai/dependencies/')) {
        throw new Error('The cold-cache acceptance test forbids upstream fallback.')
      }
      downloads.push(url.href)
      return realFetch(input, init)
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(companyOnlyFetch)
    vi.stubEnv('WORKWISE_TOOLS_ROOT', join(directory, 'tools'))
    vi.stubEnv('WORKWISE_CANDIDATE', '1')
    vi.stubEnv('WORKWISE_CANDIDATE_ROOT', directory)
    vi.stubEnv('WORKWISE_CANDIDATE_HOME', join(directory, 'home'))
    vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS', '0')
    const runtime = await new ManagedUvRuntimeService({ rootDirectory: join(directory, 'uv'), fetch: companyOnlyFetch }).ensure()
    const python = await execFileAsync(runtime.pythonPath, ['--version'])
    const uv = await execFileAsync(runtime.uvPath, ['--version'])
    expect(python.stdout.trim()).toBe('Python 3.12.12')
    expect(uv.stdout.trim()).toMatch(/^uv 0\.12\.3\b/)
    const lark = await installManagedTool('lark-cli')
    if (!lark.ok) throw new Error(lark.message)
    expect(lark.status).toMatchObject({ state: 'needs_login', installedVersion: '1.0.100', scopes: [] })
    expect(existsSync(join(managedToolsSkillRoot(), 'lark-doc', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(managedToolsSkillRoot(), 'lark-mail', 'SKILL.md'))).toBe(true)
    const manifest = JSON.parse(await readFile(join(directory, 'tools', 'manifest.json'), 'utf8'))
    expect(manifest['lark-cli'].skillWarning).toBeUndefined()
    expect(downloads).toHaveLength(4)
    await writeFile(join(directory, 'evidence.json'), `${JSON.stringify({
      schema: 'railwise.dependency-cold-cache-evidence.v1', at: new Date().toISOString(),
      platform: process.platform, arch: process.arch, uvVersion: uv.stdout.trim(), pythonVersion: python.stdout.trim(),
      larkVersion: lark.status.installedVersion, companionSkillsInstalled: true,
      credentialAccess: false, upstreamFallbackAllowed: false, downloads
    }, null, 2)}\n`)
    console.log(`Cold-cache dependency evidence ${join(directory, 'evidence.json')}`)
  }, 480_000)
})
