import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const systemFetchMock = vi.hoisted(() => vi.fn())

vi.mock('./system-network', () => ({
  systemFetch: systemFetchMock,
  describeNetworkFailure: (error: unknown, target: string) =>
    `${target} connection failed: ${error instanceof Error ? error.message : String(error)}`
}))

import {
  _internals,
  beginManagedLarkLogin,
  completeManagedLarkLogin,
  diagnoseManagedTool,
  installManagedTool,
  listManagedTools,
  managedToolsBinDir,
  managedToolsSkillRoot,
  removeManagedTool,
  updateManagedTool
} from './managed-tool-service'

type Fixture = {
  version: string
  assetName: string
  asset: Buffer
  checksumName: string
  checksum: string
  skills: Buffer
}

let toolsRoot = ''
let originalHome: string | undefined

function response(body: string | Buffer, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body as unknown as BodyInit, { status, headers })
}

async function skillBundle(root: string, names: string[], includeRootSkill = false): Promise<Buffer> {
  const zip = new JSZip()
  if (includeRootSkill) zip.file(`${root}/SKILL.md`, '# OfficeCLI\n')
  for (const name of names) zip.file(`${root}/skills/${name}/SKILL.md`, `# ${name}\n`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function larkArchive(root: string, version: string, assetName: string): Promise<Buffer> {
  if (assetName.endsWith('.zip')) {
    const zip = new JSZip()
    zip.file('lark-cli.exe', `lark ${version}\n`)
    return zip.generateAsync({ type: 'nodebuffer' })
  }
  const source = join(root, `lark-${version}`)
  const archive = join(root, `lark-${version}.tar.gz`)
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'lark-cli'), `#!/bin/sh\necho ${version}\n`)
  execFileSync('tar', ['-czf', archive, '-C', source, 'lark-cli'])
  return readFileSync(archive)
}

async function fixture(id: 'lark-cli' | 'officecli', version: string): Promise<Fixture> {
  const assetName = _internals.platformAsset(id, version)
  const asset = id === 'lark-cli'
    ? await larkArchive(toolsRoot, version, assetName)
    : Buffer.from(`officecli ${version}\n`)
  const checksumName = id === 'lark-cli' ? 'checksums.txt' : 'SHA256SUMS'
  const hash = createHash('sha256').update(asset).digest('hex')
  const skills = await skillBundle(
    `${id}-${version}`,
    id === 'lark-cli' ? _internals.larkSkills : _internals.officeSkills,
    id === 'officecli'
  )
  return { version, assetName, asset, checksumName, checksum: `${hash}  ${assetName}\n`, skills }
}

function mockOfficialDownloads(fixtures: Record<'lark-cli' | 'officecli', Fixture>, egoSkills?: Buffer): void {
  systemFetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    const id = url.includes('larksuite/cli') || url.includes('/lark-cli/') ? 'lark-cli' : 'officecli'
    const item = fixtures[id]

    if (url.includes('api.github.com/repos/')) {
      return response(JSON.stringify({
        tag_name: `v${item.version}`,
        assets: [
          { name: item.assetName, browser_download_url: `https://assets.test/${id}/${item.assetName}` },
          { name: item.checksumName, browser_download_url: `https://assets.test/${id}/${item.checksumName}` }
        ]
      }), 200, { 'content-type': 'application/json' })
    }
    if (url === `https://assets.test/${id}/${item.assetName}`) return response(item.asset)
    if (url === `https://assets.test/${id}/${item.checksumName}`) return response(item.checksum)
    if (url.includes('codeload.github.com/larksuite/cli/')) return response(fixtures['lark-cli'].skills)
    if (url.includes('codeload.github.com/iOfficeAI/OfficeCLI/')) return response(fixtures.officecli.skills)
    if (url.includes('codeload.github.com/citrolabs/ego-lite/')) {
      if (!egoSkills) throw new Error('Missing ego fixture.')
      return response(egoSkills)
    }
    throw new Error(`Unexpected managed tool request: ${url}`)
  })
}

beforeEach(() => {
  toolsRoot = mkdtempSync(join(tmpdir(), 'workwise-managed-tools-'))
  originalHome = process.env.HOME
  process.env.HOME = toolsRoot
  process.env.WORKWISE_TOOLS_ROOT = toolsRoot
  _internals.clearReleaseCache()
  _internals.setTargetPlatformForTests({ platform: 'darwin', arch: 'arm64' })
  _internals.setToolRunnerForTests(async (_path, args) => {
    if (args[0] === 'auth' && args[1] === 'status') return { ok: false, output: 'not logged in' }
    return { ok: true, output: '1.2.3' }
  })
  systemFetchMock.mockReset()
})

afterEach(() => {
  _internals.setToolRunnerForTests()
  _internals.setTargetPlatformForTests()
  _internals.clearReleaseCache()
  _internals.clearPendingLarkLogin()
  delete process.env.WORKWISE_TOOLS_ROOT
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(toolsRoot, { recursive: true, force: true })
})

describe('managed-tool-service', () => {
  it('does not mistake an exit-zero bot-only auth status for user authorization', () => {
    expect(_internals.parseLarkIdentity(JSON.stringify({ identity: 'bot', brand: 'feishu', identities: { user: { available: false } } }))).toEqual({ available: false, scopes: [], brand: 'feishu' })
    expect(_internals.parseLarkIdentity(JSON.stringify({ identity: 'user', brand: 'lark', identities: { user: { available: true, scope: 'task:task:read approval:task:read' } } }))).toEqual({ available: true, scopes: ['task:task:read', 'approval:task:read'], brand: 'lark' })
    expect(_internals.parseLarkIdentity('not json').available).toBe(false)
  })

  it('keeps device codes in main process and completes only the current official flow', async () => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    const calls: string[][] = []
    let connected = false
    _internals.setToolRunnerForTests(async (_path, args) => {
      calls.push(args)
      if (args[0] === '--version') return { ok: true, output: '1.2.3' }
      if (args[1] === 'status') return { ok: true, output: JSON.stringify({ identity: connected ? 'user' : 'none', brand: 'feishu', identities: { user: { available: connected, scope: 'task:task:read' } } }) }
      if (args.includes('--no-wait')) return { ok: true, output: JSON.stringify({ device_code: 'private-code', verification_url: 'https://accounts.feishu.cn/oauth/device?user_code=test', expires_in: 600 }) }
      connected = true
      return { ok: true, output: '{}' }
    })
    const begin = await beginManagedLarkLogin()
    expect(begin).toMatchObject({ ok: true, verificationUrl: 'https://accounts.feishu.cn/oauth/device?user_code=test' })
    expect(JSON.stringify(begin)).not.toContain('private-code')
    expect(await completeManagedLarkLogin()).toMatchObject({ ok: true, status: { state: 'installed', scopes: ['task:task:read'] } })
    expect(calls.some(args => args.includes('--device-code') && args.includes('private-code'))).toBe(true)
    expect(await completeManagedLarkLogin()).toMatchObject({ ok: false })
  })


  it('selects the current platform asset with an explicit architecture name', () => {
    expect(_internals.platformAsset('officecli', '1.2.3', 'darwin', 'arm64')).toBe('officecli-mac-arm64')
    expect(_internals.platformAsset('officecli', '1.2.3', 'win32', 'x64')).toBe('officecli-win-x64.exe')
    expect(_internals.platformAsset('lark-cli', '1.2.3', 'darwin', 'x64')).toBe(
      'lark-cli-1.2.3-darwin-amd64.tar.gz'
    )
    expect(_internals.platformAsset('lark-cli', '1.2.3', 'win32', 'arm64')).toBe(
      'lark-cli-1.2.3-windows-arm64.zip'
    )
    expect(() => _internals.platformAsset('officecli', '1.2.3', 'linux', 'x64')).toThrow(
      'officecli is not supported on linux/x64'
    )
  })

  it('reads only the checksum belonging to the selected asset', () => {
    const wanted = 'a'.repeat(64)
    const other = 'b'.repeat(64)
    expect(_internals.checksumFor(`${other}  other.zip\n${wanted} *wanted.zip`, 'wanted.zip')).toBe(wanted)
    expect(() => _internals.checksumFor(`${other}  other.zip`, 'wanted.zip')).toThrow('Checksum is missing')
  })

  it('retries transient GitHub download failures before succeeding', async () => {
    const timeoutError = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ETIMEDOUT', message: 'read ETIMEDOUT' }
    })
    systemFetchMock
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(response('downloaded'))

    await expect(_internals.download('https://github.com/example/tool', 1024, 0))
      .resolves.toEqual(Buffer.from('downloaded'))
    expect(systemFetchMock).toHaveBeenCalledTimes(3)
  })

  it('resolves official release versions and download URLs without the GitHub API', () => {
    expect(_internals.releaseVersionFromUrl('https://github.com/larksuite/cli/releases/tag/v1.0.68')).toBe('1.0.68')
    expect(_internals.releaseVersionFromHtml('<a href="/larksuite/cli/releases/tag/v1.0.68">latest</a>')).toBe('1.0.68')
    expect(_internals.releaseAssetUrl('larksuite/cli', '1.0.68', 'checksums.txt')).toBe(
      'https://github.com/larksuite/cli/releases/download/v1.0.68/checksums.txt'
    )
    expect(() => _internals.releaseVersionFromUrl('https://github.com/larksuite/cli/releases/latest')).toThrow('invalid')
  })

  it('rejects path traversal and absolute paths in release archives', () => {
    expect(_internals.archiveEntryIsSafe('lark-cli/bin/lark-cli')).toBe(true)
    expect(_internals.archiveEntryIsSafe('../outside')).toBe(false)
    expect(_internals.archiveEntryIsSafe('folder/../../outside')).toBe(false)
    expect(_internals.archiveEntryIsSafe('C:\\outside.exe')).toBe(false)
    expect(() => _internals.assertSafeArchiveListing('bin/lark-cli\n../outside')).toThrow('unsafe path')
  })

  it('installs, diagnoses, lists, and removes Lark and Office tools atomically', async () => {
    const lark = await fixture('lark-cli', '1.2.3')
    const office = await fixture('officecli', '1.2.3')
    mockOfficialDownloads({ 'lark-cli': lark, officecli: office })

    await expect(installManagedTool('lark-cli')).resolves.toMatchObject({
      ok: true,
      status: { id: 'lark-cli', state: 'needs_login', installedVersion: '1.2.3' }
    })
    await expect(installManagedTool('officecli')).resolves.toMatchObject({
      ok: true,
      status: { id: 'officecli', state: 'installed', installedVersion: '1.2.3' }
    })
    expect(existsSync(join(managedToolsBinDir(), process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'))).toBe(true)
    expect(existsSync(join(managedToolsBinDir(), process.platform === 'win32' ? 'officecli.exe' : 'officecli'))).toBe(true)
    expect(existsSync(join(managedToolsSkillRoot(), 'lark-doc', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(managedToolsSkillRoot(), 'officecli-pptx', 'SKILL.md'))).toBe(true)

    await expect(listManagedTools()).resolves.toMatchObject({
      ok: true,
      tools: [
        { id: 'lark-cli', state: 'needs_login', installedVersion: '1.2.3' },
        { id: 'officecli', state: 'installed', installedVersion: '1.2.3' },
        { id: 'ego-browser', state: 'needs_external_app' }
      ]
    })
    await expect(removeManagedTool('lark-cli')).resolves.toMatchObject({ status: { state: 'not_installed' } })
    await expect(removeManagedTool('officecli')).resolves.toMatchObject({ status: { state: 'not_installed' } })
    expect(existsSync(join(toolsRoot, 'manifest.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(toolsRoot, 'manifest.json'), 'utf8'))).toEqual({})
  })

  it('extracts the Windows Lark zip without depending on PowerShell argument forwarding', async () => {
    _internals.setTargetPlatformForTests({ platform: 'win32', arch: 'x64' })
    const lark = await fixture('lark-cli', '1.2.3')
    const office = await fixture('officecli', '1.2.3')
    mockOfficialDownloads({ 'lark-cli': lark, officecli: office })

    await expect(installManagedTool('lark-cli')).resolves.toMatchObject({
      ok: true,
      status: { id: 'lark-cli', state: 'needs_login', installedVersion: '1.2.3' }
    })
    expect(existsSync(join(managedToolsBinDir(), 'lark-cli.exe'))).toBe(true)
  })

  it('keeps the previous tool when an update checksum fails', async () => {
    const lark = await fixture('lark-cli', '1.2.3')
    const office = await fixture('officecli', '1.2.3')
    mockOfficialDownloads({ 'lark-cli': lark, officecli: office })
    await expect(installManagedTool('officecli')).resolves.toMatchObject({ ok: true })
    const active = join(managedToolsBinDir(), process.platform === 'win32' ? 'officecli.exe' : 'officecli')
    const original = readFileSync(active)

    const broken = await fixture('officecli', '1.2.4')
    broken.checksum = `${'0'.repeat(64)}  ${broken.assetName}\n`
    _internals.clearReleaseCache()
    mockOfficialDownloads({ 'lark-cli': lark, officecli: broken })

    await expect(updateManagedTool('officecli')).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Checksum verification failed')
    })
    expect(readFileSync(active)).toEqual(original)
    await expect(diagnoseManagedTool('officecli')).resolves.toMatchObject({
      ok: true,
      status: { installedVersion: '1.2.3', state: 'installed' }
    })
  })

  it('installs and removes the ego-browser companion Skill without requiring the external app', async () => {
    const lark = await fixture('lark-cli', '1.2.3')
    const office = await fixture('officecli', '1.2.3')
    const ego = await skillBundle('ego-lite-main', ['ego-browser'])
    mockOfficialDownloads({ 'lark-cli': lark, officecli: office }, ego)

    await expect(installManagedTool('ego-browser')).resolves.toMatchObject({
      ok: true,
      status: { id: 'ego-browser', state: 'needs_external_app' }
    })
    expect(existsSync(join(managedToolsSkillRoot(), 'ego-browser', 'SKILL.md'))).toBe(true)
    await expect(removeManagedTool('ego-browser')).resolves.toMatchObject({
      ok: true,
      status: { state: 'needs_external_app' }
    })
    expect(existsSync(join(managedToolsSkillRoot(), 'ego-browser'))).toBe(false)
  })
})
