import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedBrowserSkillService } from './managed-browser-skill-service'
import type { ManagedDependency } from './managed-dependency-download'
import type { BrowserCommandResult } from '../../../kun/src/services/browser-skill-cli.js'

const roots: string[] = []
const services: ManagedBrowserSkillService[] = []
afterEach(async () => {
  services.splice(0).forEach(service => service.dispose())
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
  const run = vi.fn(async (): Promise<BrowserCommandResult> => online ? { ok: true, output: { daemon_version: '0.4.0', protocol_version: '1.7', pid: 7,
    browsers: [{ instance_id: 'chrome-synthetic', browser_name: 'Chrome', label: 'Test profile', extension_version: '0.4.0', extension_protocol_version: '1.7' }] } } : absent)
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: vi.fn() })
  const start = vi.fn((_path: string, _args: string[], _env: NodeJS.ProcessEnv) => { online = true; return child as unknown as ChildProcessWithoutNullStreams })
  const download = vi.fn(async (item: ManagedDependency) => item.id === asset.id ? bytes : Buffer.from('MIT synthetic'))
  const service = new ManagedBrowserSkillService({ root, homeDirectory: join(root, 'browser-state'), target: { platform: 'win32', arch: 'x64' },
    asset, run, start, download, version: async () => 'bsk 0.4.0', wait: async () => undefined })
  services.push(service)
  return { root, service, run, start, child, download, setOnline: () => { online = true } }
}

describe('managed BrowserSkill lifecycle', () => {
  it('installs pinned bytes without starting a daemon or replacing user browser state', async () => {
    const f = await fixture()
    const result = await f.service.install()
    expect(result).toMatchObject({ ok: true, status: { state: 'daemon_stopped', enabled: false, version: '0.4.0' } })
    expect(await readFile(result.status.executablePath!, 'utf8')).toBe('fixed-synthetic-binary')
    expect(f.start).not.toHaveBeenCalled()
    expect(f.download).toHaveBeenCalledTimes(2)
    await f.service.install()
    expect(f.download).toHaveBeenCalledTimes(2)
  })
  it('starts one owned foreground daemon then requires an explicit browser selection', async () => {
    const f = await fixture()
    await f.service.install()
    const [first, second] = await Promise.all([f.service.connect(), f.service.connect()])
    expect(first.status.state).toBe('needs_browser_selection')
    expect(second.status.state).toBe(first.status.state)
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.start.mock.calls[0][1]).toEqual(['daemon', 'start', '--foreground'])
    expect(f.start.mock.calls[0][2]).toMatchObject({ BSK_AUTO_START: '0', BSK_HOME: join(f.root, 'browser-state') })
    const configured = await f.service.configure({ enabled: true, browserInstanceId: 'chrome-synthetic', origins: ['https://example.com'], interaction: 'observe', expectedRevision: first.status.revision })
    expect(configured.status).toMatchObject({ state: 'ready', enabled: true, browserInstanceId: 'chrome-synthetic', origins: ['https://example.com'] })
    f.service.dispose()
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  })
  it('reuses a reachable shared daemon and never claims its process', async () => {
    const f = await fixture()
    await f.service.install()
    f.setOnline()
    expect((await f.service.connect()).status.state).toBe('needs_browser_selection')
    f.service.dispose()
    expect(f.start).not.toHaveBeenCalled()
    expect(f.child.kill).not.toHaveBeenCalled()
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
    f.run.mockResolvedValue({ ok: true, output: { daemon_version: '0.4.0', protocol_version: '1.7', pid: 7, browsers: [] } })
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
