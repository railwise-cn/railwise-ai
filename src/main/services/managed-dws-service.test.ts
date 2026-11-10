import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedDwsService, officialDingTalkURL } from './managed-dws-service'

const asset = 'dws-windows-amd64.zip'
const loggedOut = JSON.stringify({ success: true, authenticated: false, message: '未登录' })
const loggedIn = JSON.stringify({ success: true, authenticated: true, token_valid: true, corp_id: 'corp-synthetic', user_id: 'user-synthetic' })
const finalLogin = JSON.stringify({ success: true, token_valid: true, corp_id: 'corp-synthetic', user_id: 'user-synthetic' })
const services: ManagedDwsService[] = []
let root = ''; let archive: Buffer
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'railwise-dws-test-'))
  const zip = new JSZip(); zip.file('dws.exe', 'official-synthetic-executable'); archive = await zip.generateAsync({ type: 'nodebuffer' })
  vi.stubEnv('WORKWISE_TOOLS_ROOT', join(root, 'tools'))
})
afterEach(async () => { services.forEach(service => service.cancel()); services.length = 0; vi.useRealTimers(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })
function fakeChild() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn(() => true) })
}
function fixture(mirror = true) {
  const child = fakeChild()
  const start = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  const run = vi.fn(async (_path: string, args: string[], _env: NodeJS.ProcessEnv) => ({ ok: true, output: args[0] === 'version' ? 'dws version 1.0.67' : loggedOut }))
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.startsWith('https://gitee.com/api/')) return new Response(JSON.stringify({ tag_name: 'v1.0.67', assets: { links: mirror ? [{ name: asset, browser_download_url: 'https://gitee.com/DingTalk-Real-AI/dingtalk-workspace-cli/attach_files/fixture' }] : [] } }))
    return new Response(new Uint8Array(archive))
  })
  const service = new ManagedDwsService({ root: () => join(root, 'managed-dws'), run, start, fetch, target: () => ({ platform: 'win32', arch: 'x64' }), hashes: { [asset]: createHash('sha256').update(archive).digest('hex') } })
  services.push(service)
  return { service, run, start, fetch, child }
}
async function login(f: ReturnType<typeof fixture>, url = 'https://login.dingtalk.com/oauth2/device?user_code=SYNTHETIC') {
  const pending = f.service.beginLogin()
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
  f.child.stderr.write(`  授权码: SYNTHETIC\n${url}\n`)
  return pending
}

describe('managed official DingTalk CLI', () => {
  it('installs the pinned asset through the official domestic mirror, verifies it and preserves other tools', async () => {
    const f = fixture()
    expect(await f.service.install()).toMatchObject({ ok: true, status: { state: 'needs_login', version: '1.0.67' } })
    expect(f.fetch.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('gitee.com/api/v5/repos/'), 'https://gitee.com/DingTalk-Real-AI/dingtalk-workspace-cli/attach_files/fixture'])
    expect(await readFile(join(root, 'managed-dws', 'dws.exe'), 'utf8')).toBe('official-synthetic-executable')
    expect(await f.service.diagnose()).toMatchObject({ ok: true, status: { state: 'needs_login', scopes: [] } })
    const env = f.run.mock.calls.at(-1)?.[2] as unknown as NodeJS.ProcessEnv
    expect(env.DWS_DISABLE_KEYCHAIN).toBe('1')
    expect(env.DWS_CONFIG_DIR).toBe(join(root, 'tools', 'dws-state', 'config'))
    expect(env.DWS_KEYCHAIN_DIR).toBe(join(root, 'tools', 'dws-state', 'keychain'))
    expect(f.start).not.toHaveBeenCalled()
  })
  it('falls back to the same official GitHub version without accepting a different hash', async () => {
    const f = fixture(false)
    expect(await f.service.install()).toMatchObject({ ok: true })
    expect(f.fetch.mock.calls.at(-1)?.[0]).toBe(`https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.67/${asset}`)
    const bad = fixture()
    bad.fetch.mockImplementation(async url => String(url).includes('/api/') ? new Response('{}') : new Response('wrong archive'))
    expect(await bad.service.install()).toMatchObject({ ok: true }) // Existing verified installation is reused.
    await rm(join(root, 'managed-dws'), { recursive: true })
    expect(await bad.service.install()).toMatchObject({ ok: false })
    expect(bad.run).not.toHaveBeenCalledWith(expect.anything(), ['version'], expect.anything())
  })
  it('distinguishes unreadable credentials from logout and never replaces them', async () => {
    const f = fixture(); await f.service.install()
    f.run.mockImplementation(async () => ({ ok: true, output: JSON.stringify({ success: true, authenticated: false, reason: 'dek_missing' }) }))
    expect(await f.service.diagnose()).toMatchObject({ ok: true, status: { state: 'error' } })
    expect(await f.service.beginLogin()).toMatchObject({ ok: false })
    expect(f.start).not.toHaveBeenCalled()
  })
  it('keeps one device process and verifies that process result against the exact fresh identity', async () => {
    const f = fixture(); await f.service.install()
    const begin = await login(f)
    expect(begin).toMatchObject({ ok: true, state: 'waiting', userCode: 'SYNTHETIC' })
    expect(await f.service.beginLogin()).toEqual(begin)
    f.run.mockImplementation(async () => ({ ok: true, output: loggedIn }))
    expect(await f.service.checkLogin()).toMatchObject({ state: 'waiting' })
    f.child.stdout.write(finalLogin); f.child.emit('close', 0)
    expect(await f.service.checkLogin()).toMatchObject({ ok: true, state: 'succeeded', status: { state: 'installed', profile: 'corp-synthetic:user-synthetic', identityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), scopes: [] } })
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.run.mock.calls.at(-1)?.[1]).toEqual(['auth', 'status', '--readonly', '--profile', 'corp-synthetic:user-synthetic', '--format', 'json'])
  })
  it.each(['missing', 'invalid', 'valid'] as const)('verifies an immediate zero exit before any authorization URL (%s result)', async resultKind => {
    const f = fixture(); await f.service.install()
    const begin = f.service.beginLogin()
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    f.run.mockImplementation(async () => ({ ok: true, output: loggedIn }))
    if (resultKind !== 'missing') f.child.stdout.write(resultKind === 'valid' ? finalLogin : '{}')
    f.child.emit('close', 0)
    const result = await begin
    if (resultKind === 'valid') {
      expect(result).toMatchObject({ ok: true, state: 'succeeded', status: { state: 'installed', profile: 'corp-synthetic:user-synthetic' } })
      expect(f.run.mock.calls.at(-1)?.[1]).toContain('corp-synthetic:user-synthetic')
    } else {
      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty('state', 'succeeded')
      expect(result).not.toHaveProperty('status')
    }
    expect(f.start).toHaveBeenCalledOnce()
  })
  it.each(['cancel', 'replace'] as const)('does not return or refresh an old success after %s during exact-profile verification', async action => {
    const f = fixture(); await f.service.install(); await login(f)
    f.child.stdout.write(finalLogin); f.child.emit('close', 0)
    let resolveDiagnosis!: (result: { ok: boolean; output: string }) => void
    const diagnosis = new Promise<{ ok: boolean; output: string }>(resolve => { resolveDiagnosis = resolve })
    f.run.mockImplementation(async (_path, args) => args.includes('--profile') ? diagnosis : { ok: true, output: loggedOut })
    const check = f.service.checkLogin()
    await vi.waitFor(() => expect(f.run.mock.calls.some(call => call[1].includes('corp-synthetic:user-synthetic'))).toBe(true))
    if (action === 'cancel') {
      expect(f.service.cancel()).toMatchObject({ state: 'cancelled' })
    } else {
      const replacement = fakeChild()
      f.start.mockImplementationOnce(() => replacement as unknown as ChildProcessWithoutNullStreams)
      const next = f.service.beginLogin()
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2))
      replacement.stderr.write('https://login.dingtalk.com/device?flow=second-synthetic\n')
      expect(await next).toMatchObject({ state: 'waiting' })
    }
    resolveDiagnosis({ ok: true, output: loggedIn })
    const result = await check
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('status')
    expect(result).not.toHaveProperty('state', 'succeeded')
    expect(await f.service.checkLogin()).toMatchObject({ state: action === 'cancel' ? 'cancelled' : 'waiting' })
  })
  it.each(['lost_result', 'wrong_identity', 'failed_process'])('does not use an existing logged-in account to hide %s', async failure => {
    const f = fixture(); await f.service.install(); await login(f)
    f.run.mockImplementation(async () => ({ ok: true, output: failure === 'wrong_identity' ? loggedIn.replace('user-synthetic', 'user-other') : loggedIn }))
    f.child.stdout.write(failure === 'lost_result' ? '{}' : finalLogin)
    f.child.emit('close', failure === 'failed_process' ? 1 : 0)
    const result = await f.service.checkLogin()
    expect(result.ok && result.status?.state === 'installed').toBe(false)
    expect(f.start).toHaveBeenCalledOnce()
  })
  it('rejects untrusted links and never restarts a cancelling process', async () => {
    const f = fixture(); await f.service.install()
    expect(await login(f, 'https://dingtalk.com.attacker.example/scan')).toMatchObject({ ok: false })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(await f.service.beginLogin()).toMatchObject({ ok: false })
    expect(f.start).toHaveBeenCalledOnce()
    const credentialUrl = new URL('https://login.dingtalk.com/device')
    credentialUrl.username = 'synthetic-user'
    credentialUrl.password = 'synthetic-test-value'
    expect(officialDingTalkURL(credentialUrl.toString())).toBeUndefined()
    expect(officialDingTalkURL('http://login.dingtalk.com/device')).toBeUndefined()
  })
  it('bounds expiry and refuses changed binaries without arbitrary PID operations', async () => {
    const f = fixture(); await f.service.install(); await login(f)
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 11 * 60_000)
    expect(await f.service.checkLogin()).toMatchObject({ state: 'expired' })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    await writeFile(join(root, 'managed-dws', 'dws.exe'), 'replacement')
    expect(await f.service.diagnose()).toMatchObject({ ok: false, status: { state: 'error' } })
  })
  it('blocks candidate account access before diagnosis or login can read credentials', async () => {
    const f = fixture(); await f.service.install(); f.run.mockClear()
    vi.stubEnv('WORKWISE_CANDIDATE', '1'); vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS', '0')
    vi.stubEnv('WORKWISE_CANDIDATE_ROOT', root); vi.stubEnv('WORKWISE_CANDIDATE_HOME', join(root, 'home'))
    expect(await f.service.diagnose()).toMatchObject({ ok: false })
    expect(await f.service.beginLogin()).toMatchObject({ ok: false })
    expect(await f.service.checkLogin()).toMatchObject({ ok: false })
    expect(f.run).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  })
  it('cancels the same real subprocess and never exposes stdout contents', async () => {
    const f = fixture(); await f.service.install()
    let child: ChildProcessWithoutNullStreams | undefined
    const service = new ManagedDwsService({ root: () => join(root, 'managed-dws'), hashes: { [asset]: createHash('sha256').update(archive).digest('hex') }, run: f.run, start: (_path, _args, env) => {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("private-synthetic");process.stderr.write("https://login.dingtalk.com/device?fixture\\n");setInterval(()=>{},1000)'], { env, shell: false, stdio: 'pipe' }); return child
    } }); services.push(service)
    const result = await service.beginLogin()
    expect(JSON.stringify(result)).not.toContain('private-synthetic')
    const stopped = new Promise<void>(resolve => child!.once('close', () => resolve()))
    service.cancel(); await stopped
    expect(await service.checkLogin()).toMatchObject({ state: 'cancelled' })
  })
})
