import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedLarkAppSetup, larkAppConfiguration, officialLarkURL } from './managed-lark-app-setup'

const missing = { ok: false, output: JSON.stringify({ error: { type: 'config', subtype: 'not_configured' } }) }
let root = ''; let executable = ''
const setups: ManagedLarkAppSetup[] = []
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'railwise-lark-setup-')); executable = join(root, 'lark-cli'); await writeFile(executable, 'official-fixture') })
afterEach(async () => { setups.forEach(setup => setup.cancel()); setups.length = 0; vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345, exitCode: null, signalCode: null, kill: vi.fn(() => true) })
  const run = vi.fn(async (_path: string, _args: string[]) => missing)
  const launch = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  const setup = new ManagedLarkAppSetup(run, () => ({ LARKSUITE_CLI_CONFIG_DIR: join(root, 'isolated-config') }), launch)
  setups.push(setup)
  return { setup, run, launch, child }
}
async function start(f: ReturnType<typeof fixture>, url = 'https://open.feishu.cn/device?ticket=synthetic') {
  const result = f.setup.begin(executable)
  await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
  f.child.stderr.write(`Scan this official page:\n  ${url}\n`)
  return result
}

describe('managed official Lark app initialization', () => {
  it('reuses existing application configuration and never creates or replaces profiles', async () => {
    const f = fixture(); f.run.mockResolvedValue({ ok: true, output: JSON.stringify({ appId: 'cli-existing', brand: 'feishu' }) })
    expect(await f.setup.begin(executable)).toEqual({ ok: true, state: 'configured' })
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('keeps unknown, malformed and invalid configuration intact', async () => {
    const f = fixture(); f.run.mockResolvedValue({ ok: false, output: JSON.stringify({ error: { type: 'config', subtype: 'invalid_config' } }) })
    expect(await f.setup.begin(executable)).toMatchObject({ ok: false })
    expect(f.launch).not.toHaveBeenCalled()
    expect(larkAppConfiguration('network failed', false)).toBe('error')
  })

  it('holds one official process, appends a unique profile and never returns credentials', async () => {
    const f = fixture()
    const result = await start(f)
    expect(result).toMatchObject({ ok: true, state: 'waiting', verificationUrl: 'https://open.feishu.cn/device?ticket=synthetic' })
    const [, args, env] = f.launch.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv]
    expect(args).toEqual(['config', 'init', '--new', '--name', expect.stringMatching(/^railwise-[a-f0-9-]+$/), '--brand', 'feishu', '--lang', 'zh_cn'])
    expect(args).not.toContain('--force-init')
    expect(env.LARKSUITE_CLI_CONFIG_DIR).toBe(join(root, 'isolated-config'))
    expect(await f.setup.begin(executable)).toMatchObject({ ok: true, state: 'waiting' })
    expect(f.launch).toHaveBeenCalledOnce()
    f.child.stdout.write(JSON.stringify({ appSecret: 'must-not-cross-ipc' }))
    f.child.emit('close', 0)
    f.run.mockResolvedValue({ ok: true, output: JSON.stringify({ appId: 'cli-new', brand: 'feishu', profile: args[4] }) })
    const completed = await f.setup.check()
    expect(completed).toEqual({ ok: true, state: 'configured' })
    expect(JSON.stringify([result, completed])).not.toContain('must-not-cross-ipc')
    expect(f.run).toHaveBeenLastCalledWith(executable, ['config', 'show', '--profile', args[4], '--json'])
  })

  it.each(['missing', 'wrong_profile'])('does not report success when the process exits zero before a link and configuration is %s', async outcome => {
    const f = fixture()
    const result = f.setup.begin(executable)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    if (outcome === 'wrong_profile') f.run.mockResolvedValue({ ok: true, output: JSON.stringify({ appId: 'cli-existing', brand: 'feishu', profile: 'unrelated-existing-profile' }) })
    f.child.emit('close', 0)
    expect(await result).toMatchObject({ ok: false })
    expect(await f.setup.check()).toMatchObject({ ok: true, state: 'failed' })
  })

  it('verifies this attempt’s exact named profile before accepting a zero exit without a link', async () => {
    const f = fixture()
    const result = f.setup.begin(executable)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    const [, args] = f.launch.mock.calls[0] as unknown as [string, string[]]
    f.run.mockResolvedValue({ ok: true, output: JSON.stringify({ appId: 'cli-created', brand: 'feishu', profile: args[4] }) })
    f.child.emit('close', 0)
    expect(await result).toEqual({ ok: true, state: 'configured' })
  })

  it('does not report an existing configuration after cancellation while the initial check is pending', async () => {
    const f = fixture()
    let resolveCheck!: (value: { ok: boolean; output: string }) => void
    f.run.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve }))
    const result = f.setup.begin(executable)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce())
    f.setup.cancel()
    resolveCheck({ ok: true, output: JSON.stringify({ appId: 'cli-existing', brand: 'feishu' }) })
    expect(await result).toEqual({ ok: true, state: 'cancelled' })
    expect(f.launch).not.toHaveBeenCalled()
  })

  it('suppresses a late named-profile verification after cancellation and a newer setup request', async () => {
    const f = fixture(); await start(f)
    const [, args] = f.launch.mock.calls[0] as unknown as [string, string[]]
    f.child.emit('close', 0)
    let resolveCheck!: (value: { ok: boolean; output: string }) => void
    f.run.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve }))
    const checked = f.setup.check()
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2))
    expect(f.setup.cancel()).toEqual({ ok: true, state: 'cancelled' })
    f.run.mockResolvedValue({ ok: true, output: JSON.stringify({ appId: 'cli-other-existing', brand: 'feishu' }) })
    expect(await f.setup.begin(executable)).toEqual({ ok: true, state: 'configured' })
    resolveCheck({ ok: true, output: JSON.stringify({ appId: 'cli-created', brand: 'feishu', profile: args[4] }) })
    expect(await checked).toEqual({ ok: true, state: 'cancelled' })
    expect(await f.setup.check()).toMatchObject({ ok: true, state: 'cancelled' })
    expect(f.launch).toHaveBeenCalledOnce()
  })

  it('does not turn a zero exit into configured when cancellation arrives during its automatic verification', async () => {
    const f = fixture()
    const result = f.setup.begin(executable)
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    const [, args] = f.launch.mock.calls[0] as unknown as [string, string[]]
    let resolveCheck!: (value: { ok: boolean; output: string }) => void
    f.run.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve }))
    f.child.emit('close', 0)
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2))
    f.setup.cancel()
    resolveCheck({ ok: true, output: JSON.stringify({ appId: 'cli-created', brand: 'feishu', profile: args[4] }) })
    expect(await result).toEqual({ ok: true, state: 'cancelled' })
    expect(f.child.kill).not.toHaveBeenCalled()
  })

  it('expires a verification that returns after this attempt’s deadline', async () => {
    const f = fixture(); await start(f)
    const [, args] = f.launch.mock.calls[0] as unknown as [string, string[]]
    f.child.emit('close', 0)
    let resolveCheck!: (value: { ok: boolean; output: string }) => void
    f.run.mockImplementationOnce(() => new Promise(resolve => { resolveCheck = resolve }))
    const checked = f.setup.check()
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(2))
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 16 * 60_000)
    resolveCheck({ ok: true, output: JSON.stringify({ appId: 'cli-created', brand: 'feishu', profile: args[4] }) })
    expect(await checked).toMatchObject({ ok: true, state: 'expired' })
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.launch).toHaveBeenCalledOnce()
  })

  it('rejects foreign URL and cancels only the captured child', async () => {
    const f = fixture()
    expect(await start(f, 'https://feishu.cn.attacker.example/device')).toMatchObject({ ok: false })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    const credentialUrl = new URL('https://open.feishu.cn/device')
    credentialUrl.username = 'synthetic-user'
    credentialUrl.password = 'synthetic-test-value'
    expect(officialLarkURL(credentialUrl.toString())).toBeUndefined()
    expect(officialLarkURL('http://open.feishu.cn/device')).toBeUndefined()
    expect(officialLarkURL('https://open.feishu.cn:8443/device')).toBeUndefined()
  })

  it('records cancellation and expiry without claiming remote rollback or restarting', async () => {
    const f = fixture(); await start(f)
    expect(f.setup.cancel()).toEqual({ ok: true, state: 'cancelled' })
    expect(await f.setup.check()).toMatchObject({ ok: true, state: 'cancelled' })
    const expired = fixture(); await start(expired)
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 16 * 60_000)
    expect(await expired.setup.check()).toMatchObject({ ok: true, state: 'expired' })
    expect(expired.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(expired.launch).toHaveBeenCalledOnce()
  })

  it('refuses completion after the executable changed', async () => {
    const f = fixture(); await start(f)
    await writeFile(executable, 'replacement')
    expect(await f.setup.check()).toMatchObject({ ok: false })
    expect(f.child.kill).toHaveBeenCalledOnce()
    expect(f.run).toHaveBeenCalledTimes(1)
  })

  it('waits for the full verification URL line when subprocess output is split', async () => {
    const f = fixture()
    let received = false
    const result = f.setup.begin(executable).then(value => { received = true; return value })
    await vi.waitFor(() => expect(f.launch).toHaveBeenCalledOnce())
    f.child.stderr.write('Documentation: https://open.feishu.cn/docs\n  https://accounts.fei')
    await new Promise(resolve => setImmediate(resolve))
    expect(received).toBe(false)
    f.child.stderr.write('shu.cn/device?code=synthetic\n')
    expect(await result).toMatchObject({ ok: true, verificationUrl: 'https://accounts.feishu.cn/device?code=synthetic' })
  })

  it('ends a real captured subprocess on cancellation without exposing its stdout', async () => {
    const run = vi.fn(async () => missing)
    let child: ChildProcessWithoutNullStreams | undefined
    const setup = new ManagedLarkAppSetup(run, () => ({ ...process.env }), (_path, _args, env) => {
      child = spawn(process.execPath, ['-e', 'process.stdout.write("synthetic-secret"); process.stderr.write("  https://accounts.feishu.cn/device?fixture\\n"); setInterval(()=>{},1000)'], { env, shell: false, stdio: 'pipe' })
      return child
    })
    setups.push(setup)
    const result = await setup.begin(executable)
    expect(result).toMatchObject({ ok: true, state: 'waiting' })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    const stopped = new Promise<void>(resolve => child!.once('close', () => resolve()))
    expect(setup.cancel()).toMatchObject({ state: 'cancelled' })
    await stopped
    expect(child!.signalCode !== null || child!.exitCode !== null).toBe(true)
  })
})
