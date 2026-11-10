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
import { ManagedLarkAppSetup } from './managed-lark-app-setup'

const systemFetchMock = vi.hoisted(() => vi.fn())

vi.mock('./system-network', () => ({
  systemFetch: systemFetchMock,
  describeNetworkFailure: (error: unknown, target: string) =>
    `${target} connection failed: ${error instanceof Error ? error.message : String(error)}`
}))

import {
  _internals,
  beginManagedLarkLogin,
  beginManagedLarkAppSetup,
  cancelManagedLarkAppSetup,
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
const larkScopes = 'task:task:read task:task:write approval:task:read approval:instance:read approval:task:write'
const completedLarkLogin = (userOpenId: string) => JSON.stringify({ event: 'authorization_complete', user_open_id: userOpenId, scope: larkScopes, missing: [] })

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
  vi.restoreAllMocks()
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
  it('honors app-setup cancellation while the managed diagnosis is still pending', async () => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    let resolveVersion!: (value: { ok: boolean; output: string }) => void
    const runner = vi.fn(async (_path: string, args: string[]) => {
      if (args[0] === '--version') return new Promise<{ ok: boolean; output: string }>(resolve => { resolveVersion = resolve })
      if (args[0] === 'config') return { ok: true, output: JSON.stringify({ appId: 'cli-existing', brand: 'feishu' }) }
      return { ok: true, output: '{}' }
    })
    _internals.setToolRunnerForTests(runner)
    const result = beginManagedLarkAppSetup()
    await vi.waitFor(() => expect(resolveVersion).toBeTypeOf('function'))
    expect(await cancelManagedLarkAppSetup()).toEqual({ ok: true, state: 'cancelled' })
    resolveVersion({ ok: true, output: '1.2.3' })
    expect(await result).toEqual({ ok: true, state: 'cancelled' })
    expect(runner.mock.calls.some(([, args]) => args[0] === 'config')).toBe(false)
  })
  it('requires official app setup before user login and never substitutes auth for missing configuration', async () => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    const calls: string[][] = []
    _internals.setToolRunnerForTests(async (_path, args) => {
      calls.push(args)
      if (args[0] === '--version') return { ok: true, output: '1.2.3' }
      if (args[0] === 'config') return { ok: false, output: JSON.stringify({ error: { type: 'config', subtype: 'not_configured' } }) }
      return { ok: true, output: '{}' }
    })
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: false, reason: 'app_configuration_required' })
    expect(calls.some(args => args[1] === 'login')).toBe(false)
  })

  it('does not inspect real CLI credentials or start setup when candidate credential access is disabled', async () => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    const runner = vi.fn(async () => ({ ok: true, output: '1.2.3' }))
    _internals.setToolRunnerForTests(runner)
    vi.stubEnv('WORKWISE_CANDIDATE', '1'); vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS', '0')
    vi.stubEnv('WORKWISE_CANDIDATE_ROOT', toolsRoot); vi.stubEnv('WORKWISE_CANDIDATE_HOME', join(toolsRoot, 'candidate-home'))
    try {
      expect(await beginManagedLarkLogin()).toMatchObject({ ok: false, reason: 'candidate_credentials_disabled' })
      expect(await beginManagedLarkAppSetup()).toMatchObject({ ok: false })
      expect(runner).not.toHaveBeenCalled()
      expect(await diagnoseManagedTool('lark-cli')).toMatchObject({ ok: true, status: { state: 'needs_login' } })
      expect(runner.mock.calls).toEqual([[executablePath, ['--version']]])
      const environment = _internals.managedLarkEnvironment()
      expect(environment.LARKSUITE_CLI_CONFIG_DIR).toBe(join(toolsRoot, 'candidate-home', '.lark-cli'))
      expect(environment.HOME).toBe(process.env.HOME)
    } finally { vi.unstubAllEnvs() }
  })
  it('does not mistake an exit-zero bot-only auth status for user authorization', () => {
    expect(_internals.parseLarkIdentity(JSON.stringify({ identity: 'bot', brand: 'feishu', identities: { user: { available: false } } }))).toEqual({ available: false, scopes: [], brand: 'feishu' })
    expect(_internals.parseLarkIdentity(JSON.stringify({ identity: 'user', appId: 'cli-existing', brand: 'lark', identities: { user: { available: true, openId: 'ou-synthetic', scope: 'task:task:read approval:task:read' } } }))).toMatchObject({ available: true, scopes: ['task:task:read', 'approval:task:read'], brand: 'lark', identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(_internals.parseLarkIdentity('not json').available).toBe(false)
  })

  it('carries the verified app profile through login and persistent runtime diagnosis despite a different CLI default', async () => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    const binding = { executablePath, executableHash: createHash('sha256').update('fixture').digest('hex'), profile: 'railwise-this-attempt', appId: 'cli-this-attempt', brand: 'feishu' as const }
    const selected = vi.spyOn(ManagedLarkAppSetup.prototype, 'binding').mockReturnValue(binding)
    const calls: string[][] = []
    const runner = async (_path: string, args: string[]) => {
      calls.push(args)
      const exact = args.includes(binding.profile)
      if (args[0] === '--version') return { ok: true, output: '1.2.3' }
      if (args[0] === 'config') return { ok: true, output: JSON.stringify(exact ? binding : { appId: 'cli-unrelated-default', profile: 'unrelated-default', brand: 'lark' }) }
      if (args[1] === 'status') return { ok: true, output: JSON.stringify({ identity: 'user', appId: exact ? binding.appId : 'cli-unrelated-default', brand: exact ? 'feishu' : 'lark', identities: { user: { available: true, openId: exact ? 'ou-authorized' : 'ou-unrelated', scope: 'task:task:read task:task:write approval:task:read approval:instance:read approval:task:write' } } }) }
      if (args.includes('--no-wait')) return { ok: true, output: JSON.stringify({ device_code: 'private-code', verification_url: 'https://accounts.feishu.cn/device', expires_in: 600 }) }
      return { ok: true, output: completedLarkLogin('ou-authorized') }
    }
    _internals.setToolRunnerForTests(runner)
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: true })
    expect(await completeManagedLarkLogin()).toMatchObject({ ok: true, status: { profile: binding.profile, appId: binding.appId, userOpenId: 'ou-authorized' } })
    selected.mockRestore()
    _internals.clearPendingLarkLogin()
    calls.length = 0
    expect(await diagnoseManagedTool('lark-cli')).toMatchObject({ ok: true, status: { state: 'installed', profile: binding.profile, appId: binding.appId, userOpenId: 'ou-authorized' } })
    expect(calls).toContainEqual(['auth', 'status', '--profile', binding.profile, '--json'])
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: true })
    expect(calls.filter(args => args[0] === 'config')).toEqual([['config', 'show', '--profile', binding.profile, '--json']])
    expect(calls.filter(args => args[1] === 'login').every(args => args.includes(binding.profile))).toBe(true)
    expect(readFileSync(join(toolsRoot, 'lark-account-selection.json'), 'utf8')).not.toContain('private-code')
  })

  it.each(['changed_app', 'changed_binary'])('does not begin login when the verified setup binding has %s', async failure => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    vi.spyOn(ManagedLarkAppSetup.prototype, 'binding').mockReturnValue({ executablePath, executableHash: failure === 'changed_binary' ? 'a'.repeat(64) : createHash('sha256').update('fixture').digest('hex'), profile: 'railwise-this-attempt', appId: 'cli-this-attempt', brand: 'feishu' })
    const runner = vi.fn(async (_path: string, args: string[]) => args[0] === 'config' ? { ok: true, output: JSON.stringify({ appId: failure === 'changed_app' ? 'cli-other' : 'cli-this-attempt', profile: 'railwise-this-attempt', brand: 'feishu' }) } : { ok: true, output: '1.2.3' })
    _internals.setToolRunnerForTests(runner)
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: false })
    expect(runner.mock.calls.some(([, args]) => args[1] === 'login')).toBe(false)
  })

  it('does not resume a late login request after application setup was cancelled', async () => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    let resolveConfig!: (value: { ok: boolean; output: string }) => void
    const runner = vi.fn(async (_path: string, args: string[]) => args[0] === 'config' ? new Promise<{ ok: boolean; output: string }>(resolve => { resolveConfig = resolve }) : { ok: true, output: '1.2.3' })
    _internals.setToolRunnerForTests(runner)
    const result = beginManagedLarkLogin()
    await vi.waitFor(() => expect(resolveConfig).toBeTypeOf('function'))
    await cancelManagedLarkAppSetup()
    resolveConfig({ ok: true, output: JSON.stringify({ appId: 'cli-existing', profile: 'existing', brand: 'feishu' }) })
    expect(await result).toMatchObject({ ok: false })
    expect(runner.mock.calls.some(([, args]) => args[1] === 'login')).toBe(false)
  })

  it('blocks account login while the official application setup is still waiting', async () => {
    vi.spyOn(ManagedLarkAppSetup.prototype, 'isWaiting').mockReturnValue(true)
    const runner = vi.fn(async () => ({ ok: true, output: '{}' }))
    _internals.setToolRunnerForTests(runner)
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: false, reason: 'app_configuration_required' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not replace the selected account with another logged-in user during later diagnosis', async () => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    writeFileSync(join(toolsRoot, 'lark-account-selection.json'), JSON.stringify({ profile: 'railwise-selected', appId: 'cli-existing', brand: 'feishu', userOpenId: 'ou-authorized', identityFingerprint: createHash('sha256').update(JSON.stringify(['lark-user-v1', 'feishu', 'cli-existing', 'ou-authorized'])).digest('hex') }))
    const runner = vi.fn(async (_path: string, args: string[]) => args[1] === 'status' ? { ok: true, output: JSON.stringify({ appId: 'cli-existing', brand: 'feishu', identities: { user: { available: true, openId: 'ou-switched', scope: 'task:task:read task:task:write' } } }) } : { ok: true, output: '1.2.3' })
    _internals.setToolRunnerForTests(runner)
    expect(await diagnoseManagedTool('lark-cli')).toMatchObject({ ok: true, status: { state: 'needs_login', scopes: [] } })
    expect(await diagnoseManagedTool('lark-cli')).not.toHaveProperty('status.identityFingerprint')
    expect(runner.mock.calls).toContainEqual([executablePath, ['auth', 'status', '--profile', 'railwise-selected', '--json']])
    expect(JSON.parse(readFileSync(join(toolsRoot, 'lark-account-selection.json'), 'utf8')).userOpenId).toBe('ou-authorized')
  })

  it.each(['invalid_json', 'invalid_fingerprint'])('preserves an unverifiable stored selection and refuses default-account fallback for %s', async failure => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    const stored = failure === 'invalid_json' ? '{' : JSON.stringify({ profile: 'selected', appId: 'cli-existing', brand: 'feishu', userOpenId: 'ou-authorized', identityFingerprint: 'a'.repeat(64) })
    writeFileSync(join(toolsRoot, 'lark-account-selection.json'), stored)
    const runner = vi.fn(async () => ({ ok: true, output: '1.2.3' }))
    _internals.setToolRunnerForTests(runner)
    expect(await diagnoseManagedTool('lark-cli')).toMatchObject({ ok: false })
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: false })
    expect(runner.mock.calls).toEqual([[executablePath, ['--version']]])
    expect(readFileSync(join(toolsRoot, 'lark-account-selection.json'), 'utf8')).toBe(stored)
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
      if (args[0] === 'config') return { ok: true, output: JSON.stringify({ appId: 'cli-existing', brand: 'feishu' }) }
      if (args[1] === 'status') return { ok: true, output: JSON.stringify({ identity: connected ? 'user' : 'none', appId: 'cli-existing', brand: 'feishu', identities: { user: { available: connected, openId: 'ou-synthetic', scope: 'task:task:read task:task:write approval:task:read approval:instance:read approval:task:write' } } }) }
      if (args.includes('--no-wait')) return { ok: true, output: JSON.stringify({ device_code: 'private-code', verification_url: 'https://accounts.feishu.cn/oauth/device?user_code=test', expires_in: 600 }) }
      connected = true
      return { ok: true, output: completedLarkLogin('ou-synthetic') }
    })
    const [begin, simultaneous] = await Promise.all([beginManagedLarkLogin(), beginManagedLarkLogin()])
    expect(begin).toMatchObject({ ok: true, verificationUrl: 'https://accounts.feishu.cn/oauth/device?user_code=test' })
    expect(simultaneous).toEqual(begin)
    expect(await beginManagedLarkLogin()).toEqual(begin)
    expect(calls.filter(args => args.includes('--no-wait'))).toHaveLength(1)
    expect(JSON.stringify(begin)).not.toContain('private-code')
    expect(await completeManagedLarkLogin()).toMatchObject({ ok: true, status: { state: 'installed', profile: 'cli-existing', userOpenId: 'ou-synthetic', identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(calls.some(args => args.includes('--device-code') && args.includes('private-code'))).toBe(true)
    expect(await completeManagedLarkLogin()).toMatchObject({ ok: false })
  })

  it.each(['failed_device', 'missing_scope', 'different_app', 'changed_binary', 'malformed_poll', 'different_user', 'poll_missing_scope'])('does not let an old login hide %s in this authorization', async (failure) => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    const oldSelection = JSON.stringify({ profile: 'railwise-existing', appId: 'cli-existing', brand: 'feishu', userOpenId: 'ou-existing', identityFingerprint: createHash('sha256').update(JSON.stringify(['lark-user-v1', 'feishu', 'cli-existing', 'ou-existing'])).digest('hex') })
    writeFileSync(join(toolsRoot, 'lark-account-selection.json'), oldSelection)
    const calls: string[][] = []
    let completing = false
    _internals.setToolRunnerForTests(async (_path, args) => {
      calls.push(args)
      if (args[0] === '--version') return { ok: true, output: '1.2.3' }
      if (args[0] === 'config') return { ok: true, output: JSON.stringify({ appId: 'cli-existing', profile: 'railwise-existing', brand: 'feishu' }) }
      if (args[1] === 'status') return { ok: true, output: JSON.stringify({ identity: 'user', appId: completing && failure === 'different_app' ? 'cli-other' : 'cli-existing', brand: 'feishu', identities: { user: { available: true, openId: 'ou-existing', scope: failure === 'missing_scope' ? 'task:task:read' : 'task:task:read task:task:write approval:task:read approval:instance:read approval:task:write' } } }) }
      if (args.includes('--no-wait')) return { ok: true, output: JSON.stringify({ device_code: 'private-code', verification_url: 'https://accounts.feishu.cn/device', expires_in: 600 }) }
      completing = true
      return { ok: failure !== 'failed_device', output: failure === 'malformed_poll' ? '{}' : failure === 'poll_missing_scope' ? JSON.stringify({ event: 'authorization_complete', user_open_id: 'ou-existing', scope: 'task:task:read', missing: ['task:task:write'] }) : completedLarkLogin(failure === 'different_user' ? 'ou-other' : 'ou-existing') }
    })
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: true })
    if (failure === 'changed_binary') writeFileSync(executablePath, 'replacement')
    expect(await completeManagedLarkLogin()).toMatchObject({ ok: false })
    expect(await completeManagedLarkLogin()).toMatchObject({ ok: false })
    expect(calls.filter(args => args.includes('--device-code'))).toHaveLength(failure === 'changed_binary' ? 0 : 1)
    expect(calls.filter(args => args.includes('--device-code')).every(args => args.includes('railwise-existing'))).toBe(true)
    expect(readFileSync(join(toolsRoot, 'lark-account-selection.json'), 'utf8')).toBe(oldSelection)
  })

  it.each(['cancel', 'new_setup'])('keeps the previous account selection when %s invalidates an in-flight login completion', async invalidation => {
    const executablePath = join(toolsRoot, 'lark-cli')
    writeFileSync(executablePath, 'fixture')
    writeFileSync(join(toolsRoot, 'manifest.json'), JSON.stringify({ 'lark-cli': { version: '1.2.3', executablePath, installedAt: new Date().toISOString() } }))
    const oldSelection = JSON.stringify({ profile: 'railwise-existing', appId: 'cli-existing', brand: 'feishu', userOpenId: 'ou-existing', identityFingerprint: createHash('sha256').update(JSON.stringify(['lark-user-v1', 'feishu', 'cli-existing', 'ou-existing'])).digest('hex') })
    writeFileSync(join(toolsRoot, 'lark-account-selection.json'), oldSelection)
    let resolvePoll!: (value: { ok: boolean; output: string }) => void
    const runner = vi.fn(async (_path: string, args: string[]) => {
      if (args[0] === '--version') return { ok: true, output: '1.2.3' }
      if (args[0] === 'config') return { ok: true, output: JSON.stringify({ appId: 'cli-existing', profile: 'railwise-existing', brand: 'feishu' }) }
      if (args[1] === 'status') return { ok: true, output: JSON.stringify({ appId: 'cli-existing', brand: 'feishu', identities: { user: { available: true, openId: 'ou-existing', scope: larkScopes } } }) }
      if (args.includes('--no-wait')) return { ok: true, output: JSON.stringify({ device_code: 'private-code', verification_url: 'https://accounts.feishu.cn/device', expires_in: 600 }) }
      return new Promise<{ ok: boolean; output: string }>(resolve => { resolvePoll = resolve })
    })
    _internals.setToolRunnerForTests(runner)
    expect(await beginManagedLarkLogin()).toMatchObject({ ok: true })
    const result = completeManagedLarkLogin()
    await vi.waitFor(() => expect(resolvePoll).toBeTypeOf('function'))
    if (invalidation === 'cancel') await cancelManagedLarkAppSetup()
    else expect(await beginManagedLarkAppSetup()).toEqual({ ok: true, state: 'configured' })
    resolvePoll({ ok: true, output: completedLarkLogin('ou-new') })
    expect(await result).toMatchObject({ ok: false })
    expect(readFileSync(join(toolsRoot, 'lark-account-selection.json'), 'utf8')).toBe(oldSelection)
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
