import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedBrowserSkillService } from './managed-browser-skill-service'
import type { ManagedDependency } from './managed-dependency-download'
import type { BrowserCommandResult } from '../../../kun/src/services/browser-skill-cli.js'
import type { ProcessIdentity } from '../../../kun/src/contracts/execution.js'
import type { ProcessIdentityProbeOptions } from '../../../kun/src/services/process-identity.js'

const roots: string[] = []
const services: ManagedBrowserSkillService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-managed-'))
  roots.push(root)
  const zip = new JSZip()
  zip.file('bsk.exe', 'fixed-synthetic-binary')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const asset = { id: 'browser-synthetic', name: 'bsk.zip', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } as ManagedDependency
  const absent = { ok: false, output: { message: 'automatic daemon startup is disabled (BSK_AUTO_START=0); restore the daemon' } }
  let online = false
  const run = vi.fn(async (): Promise<BrowserCommandResult> => online ? { ok: true, output: { daemon_version: '0.5.0', protocol_version: '1.9', pid: 7,
    browsers: [{ instance_id: 'chrome-synthetic', browser_name: 'Chrome', label: 'Test profile', extension_version: '0.5.0', extension_protocol_version: '1.9' }] } } : absent)
  const child = Object.assign(new EventEmitter(), { pid: 7, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(), unref: vi.fn() })
  const start = vi.fn((_path: string, _args: string[], _env: NodeJS.ProcessEnv) => { online = true; return child as unknown as ChildProcess })
  const identity = vi.fn((pid: number, _options?: ProcessIdentityProbeOptions): ProcessIdentity | null | Promise<ProcessIdentity | null> => ({ pid, fingerprint: 'synthetic-owned-birth' }))
  const signal = vi.fn()
  const download = vi.fn(async (item: ManagedDependency) => item.id === asset.id ? bytes : Buffer.from('MIT synthetic'))
  const wait = vi.fn(async (): Promise<void> => undefined)
  const deps = { root, homeDirectory: join(root, 'browser-state'), target: { platform: 'win32', arch: 'x64' },
    asset, run, start, identity, signal, download, version: async () => 'bsk 0.5.0', wait }
  const service = new ManagedBrowserSkillService(deps)
  services.push(service)
  return { root, service, run, start, child, identity, signal, download, wait, deps, setOnline: () => { online = true } }
}

describe('managed BrowserSkill lifecycle', () => {
  it('installs pinned bytes without starting a daemon or replacing user browser state', async () => {
    const f = await fixture()
    const result = await f.service.install()
    expect(result).toMatchObject({ ok: true, status: { state: 'daemon_stopped', enabled: false, version: '0.5.0' } })
    expect(await readFile(result.status.executablePath!, 'utf8')).toBe('fixed-synthetic-binary')
    expect(f.start).not.toHaveBeenCalled()
    expect(f.download).toHaveBeenCalledTimes(2)
    await f.service.install()
    expect(f.download).toHaveBeenCalledTimes(2)
  })
  it('updates only the explicitly installed CLI while preserving the legacy binary, browser scope and external daemon', async () => {
    const f = await fixture()
    const legacyPath = join(f.root, 'legacy-bsk.exe')
    const legacyBytes = Buffer.from('preserved-0.4.0-binary')
    await writeFile(legacyPath, legacyBytes)
    await writeFile(join(f.root, 'connection.json'), JSON.stringify({ enabled: true, revision: 9, state: 'ready', version: '0.4.0',
      executablePath: legacyPath, executableHash: createHash('sha256').update(legacyBytes).digest('hex'), homeDirectory: f.deps.homeDirectory,
      browserInstanceId: 'chrome-synthetic', origins: ['https://example.com'], interaction: 'observe' }))
    f.run.mockResolvedValue({ ok: true, output: { daemon_version: '0.4.0', protocol_version: '1.7', pid: 88,
      browsers: [{ instance_id: 'chrome-synthetic', browser_name: 'Chrome', extension_version: '0.4.0', extension_protocol_version: '1.7' }] } })
    const installed = await f.service.install()
    expect(installed).toMatchObject({ ok: true, status: { version: '0.5.0', revision: 10, enabled: true,
      homeDirectory: f.deps.homeDirectory, browserInstanceId: 'chrome-synthetic', origins: ['https://example.com'], interaction: 'observe', daemonProtocolVersion: '1.7' } })
    expect(installed.status.executablePath).not.toBe(legacyPath)
    expect(await readFile(legacyPath)).toEqual(legacyBytes)
    expect(f.start).not.toHaveBeenCalled()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('starts one owned foreground daemon with a thirty-minute session idle window and requires explicit browser selection', async () => {
    const f = await fixture()
    await f.service.install()
    const [first, second] = await Promise.all([f.service.connect(), f.service.connect()])
    expect(first.status.state).toBe('needs_browser_selection')
    expect(second.status.state).toBe(first.status.state)
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.start.mock.calls[0][1]).toEqual(['daemon', 'start', '--foreground', '--session-idle', '30m'])
    expect(f.start.mock.calls[0][2]).toMatchObject({ BSK_AUTO_START: '0', BSK_HOME: join(f.root, 'browser-state') })
    const configured = await f.service.configure({ enabled: true, browserInstanceId: 'chrome-synthetic', origins: ['https://example.com'], interaction: 'observe', expectedRevision: first.status.revision })
    expect(configured.status).toMatchObject({ state: 'ready', enabled: true, browserInstanceId: 'chrome-synthetic', origins: ['https://example.com'] })
    await f.service.dispose()
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  })
  it('reuses a reachable shared daemon without starting, changing idle settings or claiming its process', async () => {
    const f = await fixture()
    await f.service.install()
    f.setOnline()
    expect((await f.service.connect()).status.state).toBe('needs_browser_selection')
    expect(f.run).toHaveBeenCalledTimes(2)
    expect(f.run).toHaveBeenNthCalledWith(1, expect.anything(), ['status'])
    expect(f.run).toHaveBeenNthCalledWith(2, expect.anything(), ['status'])
    await f.service.dispose()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
    await expect(readFile(join(f.root, 'owned-daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves only the detached CLI process and records its exact ownership for the next launch', async () => {
    const f = await fixture()
    await f.service.install()
    await f.service.connect()
    const config = await f.service.configuration()
    const ownership = JSON.parse(await readFile(join(f.root, 'owned-daemon.json'), 'utf8'))
    expect(ownership).toEqual({ pid: 7, fingerprint: 'synthetic-owned-birth', executablePath: config.executablePath,
      executableHash: config.executableHash, homeDirectory: join(f.root, 'browser-state') })
    await f.service.dispose({ preserveDaemon: true })
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
    expect(f.child.unref).toHaveBeenCalledOnce()
    expect(f.child.stdout.destroyed).toBe(true)
    expect(f.child.stderr.destroyed).toBe(true)
    expect(JSON.parse(await readFile(join(f.root, 'owned-daemon.json'), 'utf8'))).toEqual(ownership)
    await expect(f.service.connect()).rejects.toThrow('browser_service_disposed')
    await f.service.dispose()
    expect(f.child.kill).not.toHaveBeenCalled()
  })
  it.each([false, true])('recovers exact ownership across service instances with preserveDaemon=%s', async preserveDaemon => {
    const f = await fixture()
    await f.service.install()
    await f.service.connect()
    await f.service.dispose({ preserveDaemon: true })
    const next = new ManagedBrowserSkillService(f.deps)
    services.push(next)
    expect(await next.connect()).toMatchObject({ status: { ownedDaemon: true } })
    expect(f.start).toHaveBeenCalledOnce()
    await next.dispose({ preserveDaemon })
    if (preserveDaemon) expect(f.signal).not.toHaveBeenCalled()
    else expect(f.signal).toHaveBeenCalledWith(7, 'SIGTERM')
    expect(f.child.kill).not.toHaveBeenCalled()
  })
  it.each(['fingerprint', 'homeDirectory', 'executablePath', 'executableHash', 'pid'])('does not adopt or signal a persisted daemon with mismatched %s', async field => {
    const f = await fixture()
    await f.service.install()
    await f.service.connect()
    await f.service.dispose({ preserveDaemon: true })
    const path = join(f.root, 'owned-daemon.json')
    const ownership = JSON.parse(await readFile(path, 'utf8'))
    ownership[field] = field === 'pid' ? 8 : 'mismatched'
    await writeFile(path, JSON.stringify(ownership))
    const next = new ManagedBrowserSkillService(f.deps)
    services.push(next)
    expect(await next.connect()).toMatchObject({ status: { ownedDaemon: false } })
    await next.dispose()
    expect(f.signal).not.toHaveBeenCalled()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.start).toHaveBeenCalledOnce()
  })
  it('does not signal a PID recycled after ownership was restored', async () => {
    const f = await fixture()
    await f.service.install()
    await f.service.connect()
    f.identity.mockImplementation(pid => ({ pid, fingerprint: 'another-process-birth' }))
    await f.service.dispose()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('does not claim or signal a daemon whose birth fingerprint could not be verified', async () => {
    const f = await fixture()
    await f.service.install()
    f.identity.mockReturnValue(null)
    await expect(f.service.connect()).rejects.toThrow('browser_daemon_identity_unverified')
    await f.service.dispose()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
    expect(f.child.unref).toHaveBeenCalled()
    await expect(readFile(join(f.root, 'owned-daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not signal an owned process when the executable bytes have changed', async () => {
    const f = await fixture()
    const installed = await f.service.install()
    await f.service.connect()
    await writeFile(installed.status.executablePath!, 'different executable')
    await f.service.dispose()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('does not start a daemon when disposal begins during initial diagnosis', async () => {
    const f = await fixture()
    await f.service.install()
    let finish!: (value: BrowserCommandResult) => void
    f.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const connection = f.service.connect()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const disposal = f.service.dispose({ preserveDaemon: true })
    finish({ ok: false, output: { message: 'automatic daemon startup is disabled (BSK_AUTO_START=0)' } })
    await Promise.all([connection, disposal])
    expect(f.start).not.toHaveBeenCalled()
  })
  it.each([false, true])('awaits an in-flight owned birth query before dispose preserveDaemon=%s', async preserveDaemon => {
    const f = await fixture()
    await f.service.install()
    let finish!: (identity: ProcessIdentity) => void
    f.identity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const connection = f.service.connect()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(f.start).toHaveBeenCalledOnce()
    // Main remains able to process another event while the cold query is pending.
    await new Promise(resolve => setImmediate(resolve))
    const disposal = f.service.dispose({ preserveDaemon })
    finish({ pid: 7, fingerprint: 'synthetic-owned-birth' })
    await Promise.all([connection, disposal])
    expect(JSON.parse(await readFile(join(f.root, 'owned-daemon.json'), 'utf8'))).toMatchObject({ pid: 7, fingerprint: 'synthetic-owned-birth' })
    if (preserveDaemon) expect(f.child.kill).not.toHaveBeenCalled()
    else expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.child.unref).toHaveBeenCalledOnce()
  })
  it('shares a ten-second startup budget rather than retrying a cold timeout for another ten seconds', async () => {
    const f = await fixture()
    await f.service.install()
    let clock = 100
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      f.identity.mockImplementationOnce(() => { clock += 10_000; return null })
      await expect(f.service.connect()).rejects.toThrow('browser_daemon_identity_unverified')
      expect(f.identity).toHaveBeenCalledOnce()
      expect(f.identity).toHaveBeenCalledWith(7, { timeoutMs: 10_000 })
      expect(f.wait).not.toHaveBeenCalled()
      await expect(readFile(join(f.root, 'owned-daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { date.mockRestore() }
  })
  it('passes only the remaining startup budget to a quick unavailable-probe retry', async () => {
    const f = await fixture()
    await f.service.install()
    let clock = 100
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      f.identity.mockImplementationOnce(() => { clock += 500; return null })
      f.wait.mockImplementation(async () => { clock += 500 })
      expect((await f.service.connect()).status.state).toBe('needs_browser_selection')
      expect(f.identity.mock.calls.slice(0, 2)).toEqual([[7, { timeoutMs: 10_000 }], [7, { timeoutMs: 9000 }]])
    } finally { date.mockRestore() }
  })
  it('rejects a birth result delivered after the startup deadline', async () => {
    const f = await fixture()
    await f.service.install()
    let clock = 100
    const date = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      f.identity.mockImplementationOnce(async pid => { clock += 10_001; return { pid, fingerprint: 'synthetic-owned-birth' } })
      await expect(f.service.connect()).rejects.toThrow('browser_daemon_identity_unverified')
      expect(f.identity).toHaveBeenCalledOnce()
      await expect(readFile(join(f.root, 'owned-daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.child.kill).not.toHaveBeenCalled()
    } finally { date.mockRestore() }
  })
  it('does not claim a late birth result after the exact child exits', async () => {
    const f = await fixture()
    await f.service.install()
    let finish!: (identity: ProcessIdentity) => void
    f.identity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const connection = f.service.connect()
    const rejection = expect(connection).rejects.toThrow('browser_daemon_identity_unverified')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    f.child.exitCode = 1
    f.child.emit('close', 1)
    finish({ pid: 7, fingerprint: 'synthetic-owned-birth' })
    await rejection
    await expect(readFile(join(f.root, 'owned-daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.child.kill).not.toHaveBeenCalled()
  })
  it('does not restore ownership from a diagnosis completing after disposal', async () => {
    const f = await fixture()
    await f.service.install()
    await f.service.connect()
    await f.service.dispose({ preserveDaemon: true })
    const next = new ManagedBrowserSkillService(f.deps)
    services.push(next)
    let finish!: (identity: ProcessIdentity) => void
    f.identity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const diagnosis = next.diagnose()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await next.dispose()
    finish({ pid: 7, fingerprint: 'synthetic-owned-birth' })
    expect((await diagnosis).status.ownedDaemon).toBe(false)
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('rechecks the birth after awaiting disposal ownership and rejects a recycled PID', async () => {
    const f = await fixture()
    await f.service.install()
    await f.service.connect()
    let finish!: (identity: ProcessIdentity) => void
    f.identity.mockImplementationOnce(pid => ({ pid, fingerprint: 'synthetic-owned-birth' }))
    f.identity.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const disposal = f.service.dispose()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish({ pid: 7, fingerprint: 'recycled-during-disposal' })
    await disposal
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('fails closed if an asynchronous identity provider rejects during disposal', async () => {
    const f = await fixture()
    await f.service.install()
    await f.service.connect()
    f.identity.mockRejectedValue(new Error('identity unavailable'))
    await f.service.dispose()
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.signal).not.toHaveBeenCalled()
  })
  it('rejects stale revisions and keeps the previous scope', async () => {
    const f = await fixture()
    const initial = await f.service.install()
    await expect(f.service.configure({ enabled: true, origins: [], interaction: 'observe', expectedRevision: initial.status.revision + 1 })).rejects.toThrow('browser_configuration_conflict')
    expect((await f.service.configuration()).enabled).toBe(false)
  })
  it('keeps protocol errors distinct from extension absence', async () => {
    const f = await fixture()
    await f.service.install()
    f.run.mockResolvedValue({ ok: true, output: { daemon_version: '0.3.3', protocol_version: '1.3', pid: 7, browsers: [] } })
    expect((await f.service.diagnose()).status.state).toBe('protocol_mismatch')
    f.run.mockResolvedValue({ ok: true, output: { daemon_version: '0.5.0', protocol_version: '1.9', pid: 7, browsers: [] } })
    expect((await f.service.diagnose()).status.state).toBe('needs_extension')
  })
  it('rejects a changed archive and never starts the downloaded content', async () => {
    const f = await fixture()
    f.download.mockResolvedValue(Buffer.from('different bytes'))
    expect(await f.service.install()).toMatchObject({ ok: false, status: { code: 'browser_install_failed' } })
    expect(f.run).not.toHaveBeenCalled()
    expect(f.start).not.toHaveBeenCalled()
  })
})
