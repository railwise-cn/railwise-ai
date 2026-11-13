import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import { BrowserCapabilityConfig, BrowserExecutionScope } from '../../../kun/src/contracts/browser-skill.js'
import { browserEnvironment, compatibleBrowserProtocol, object, parseBrowserStatus, runBrowserCommand, type BrowserCommandRunner } from '../../../kun/src/services/browser-skill-cli.js'
import type { BrowserSkillConfigureRequest, ManagedBrowserSkillResult, ManagedBrowserSkillStatus } from '../../shared/managed-browser-skill'
import { atomicWriteFile, runSerialized } from './durable-file'
import { downloadManagedDependency, managedDependency, type ManagedDependency } from './managed-dependency-download'

const executeFile = promisify(execFile)
export const BROWSER_SKILL_VERSION = '0.4.0'
export const BROWSER_EXTENSION_URLS = {
  chrome: 'https://chromewebstore.google.com/detail/hhcmgoofomhgciiibhipgmgkgnoenaoi',
  edge: 'https://microsoftedge.microsoft.com/addons/detail/browserskill/emacgiaaaiojkkpkddmmdfhmokgmnikg'
} as const
type Dependencies = {
  root?: string
  homeDirectory?: string
  target?: { platform: string; arch: string }
  run?: BrowserCommandRunner
  download?: (asset: ManagedDependency) => Promise<Buffer>
  start?: (path: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
  version?: (path: string) => Promise<string>
  wait?: () => Promise<void>
  asset?: ManagedDependency
}
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Main owns installation and the daemon it starts. Existing shared daemons remain externally owned. */
export class ManagedBrowserSkillService {
  private readonly root: string
  private readonly homeDirectory: string
  private readonly target: { platform: string; arch: string }
  private readonly run: BrowserCommandRunner
  private readonly download: (asset: ManagedDependency) => Promise<Buffer>
  private readonly start: NonNullable<Dependencies['start']>
  private readonly version: NonNullable<Dependencies['version']>
  private readonly wait: () => Promise<void>
  private readonly asset?: ManagedDependency
  private ownedDaemon?: ChildProcessWithoutNullStreams
  private connection?: Promise<ManagedBrowserSkillResult>

  constructor(deps: Dependencies = {}) {
    this.root = resolve(deps.root ?? join(process.env.WORKWISE_TOOLS_ROOT || join(homedir(), '.workwise', 'tools'), 'browser-skill'))
    this.homeDirectory = resolve(deps.homeDirectory ?? process.env.BSK_HOME ?? join(homedir(), '.bsk'))
    this.target = deps.target ?? { platform: process.platform, arch: process.arch }
    this.run = deps.run ?? runBrowserCommand
    this.download = deps.download ?? downloadManagedDependency
    this.start = deps.start ?? ((path, args, env) => spawn(path, args, { env, shell: false, windowsHide: true, stdio: 'pipe' }))
    this.version = deps.version ?? (async path => String((await executeFile(path, ['--version'], { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 })).stdout).trim())
    this.wait = deps.wait ?? (() => new Promise(resolveWait => setTimeout(resolveWait, 500)))
    this.asset = deps.asset
  }

  private path(): string { return join(this.root, 'connection.json') }

  async configuration(): Promise<BrowserCapabilityConfig> {
    try { return BrowserCapabilityConfig.parse(JSON.parse(await readFile(this.path(), 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return BrowserCapabilityConfig.parse({ homeDirectory: this.homeDirectory })
    }
  }

  private async save(config: BrowserCapabilityConfig): Promise<void> {
    await mkdir(this.root, { recursive: true })
    await atomicWriteFile(this.path(), JSON.stringify(config, null, 2) + '\n')
  }

  async install(): Promise<ManagedBrowserSkillResult> {
    return runSerialized(`browser-install:${this.root}`, async () => {
      const config = await this.configuration()
      if (config.version === BROWSER_SKILL_VERSION && config.executablePath && config.executableHash) {
        try {
          if (digest(await readFile(config.executablePath)) === config.executableHash) return this.diagnose()
        } catch { /* A missing managed binary can be restored from the fixed archive. */ }
      }
      const target = `${this.target.platform}-${this.target.arch}`
      if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) {
        return { ok: false, status: { ...config, state: 'unsupported', code: 'browser_platform_unsupported', message: '当前固定版本支持 Windows x64 与 macOS Apple Silicon/Intel。' } }
      }
      const asset = this.asset ?? managedDependency(`browser-skill-${target}`)
      await mkdir(this.root, { recursive: true })
      const staged = await mkdtemp(join(this.root, '.install-'))
      try {
        const [archive, license] = await Promise.all([this.download(asset), this.download(managedDependency('browser-skill-license'))])
        if (digest(archive) !== asset.sha256 || archive.length !== asset.size) throw new Error('browser_archive_mismatch')
        const executable = this.target.platform === 'win32' ? 'bsk.exe' : 'bsk'
        await extractBrowserExecutable(archive, asset.name, staged, executable)
        const path = join(staged, executable)
        if (this.target.platform !== 'win32') await chmod(path, 0o755)
        if (!new RegExp(`\\b${BROWSER_SKILL_VERSION.replaceAll('.', '\\.')}\\b`).test(await this.version(path))) throw new Error('browser_version_mismatch')
        await writeFile(join(staged, 'LICENSE'), license, { mode: 0o600 })
        const destination = join(this.root, 'versions', asset.sha256)
        await mkdir(join(this.root, 'versions'), { recursive: true })
        try { await rename(staged, destination) }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
          if (digest(await readFile(join(destination, executable))) !== digest(await readFile(path))) throw new Error('browser_existing_installation_changed')
        }
        await runSerialized(`browser-config:${this.root}`, async () => {
          const current = await this.configuration()
          await this.save({ ...current, executablePath: join(destination, executable), executableHash: digest(await readFile(join(destination, executable))),
            homeDirectory: this.homeDirectory, version: BROWSER_SKILL_VERSION, state: 'daemon_stopped', revision: current.revision + 1 })
        })
        return this.diagnose()
      } catch (error) {
        return { ok: false, status: { ...config, state: 'error', code: 'browser_install_failed', message: error instanceof Error ? error.message : 'BrowserSkill 安装失败。' } }
      } finally { await rm(staged, { recursive: true, force: true }) }
    })
  }

  async diagnose(): Promise<ManagedBrowserSkillResult> {
    return runSerialized(`browser-config:${this.root}`, async () => {
      const config = await this.configuration()
      let next: ManagedBrowserSkillStatus = { ...config, checkedAt: new Date().toISOString(), ownedDaemon: Boolean(this.ownedDaemon), code: undefined, message: undefined }
      if (!config.executablePath || !config.executableHash) return { ok: true, status: { ...next, state: 'not_installed' } }
      try {
        const response = await this.run(config, ['status'])
        if (!response.ok) {
          const body = object(response.output)
          const absent = typeof body.message === 'string' && body.message.includes('automatic daemon startup is disabled (BSK_AUTO_START=0)')
          next = { ...next, state: absent ? 'daemon_stopped' : 'error', code: absent ? 'browser_daemon_stopped' : response.code ?? 'browser_diagnosis_failed',
            message: absent ? '浏览器服务尚未启动，请点击连接浏览器。' : '无法核验浏览器连接，请检查诊断后重试。' }
        } else {
          const status = parseBrowserStatus(response.output)
          const selected = status.browsers.find(browser => browser.id === config.browserInstanceId)
          next = { ...next, daemonProtocolVersion: status.protocolVersion, browsers: status.browsers,
            state: !compatibleBrowserProtocol(status.protocolVersion) ? 'protocol_mismatch'
              : !status.browsers.some(browser => browser.connected) ? 'needs_extension'
                : !selected?.connected ? 'needs_browser_selection'
                  : !compatibleBrowserProtocol(selected.protocolVersion) ? 'protocol_mismatch' : 'ready' }
        }
      } catch (error) { next = { ...next, state: 'error', code: 'browser_diagnosis_failed', message: error instanceof Error ? error.message : '浏览器诊断失败。' } }
      const { ownedDaemon: _owned, ...persisted } = next
      await this.save(BrowserCapabilityConfig.parse(persisted))
      return { ok: next.state !== 'error' && next.state !== 'protocol_mismatch', status: next }
    })
  }

  async configure(request: BrowserSkillConfigureRequest): Promise<ManagedBrowserSkillResult> {
    await runSerialized(`browser-config:${this.root}`, async () => {
      const current = await this.configuration()
      if (request.expectedRevision !== current.revision) throw new Error('browser_configuration_conflict')
      if (request.browserInstanceId) BrowserExecutionScope.parse({ browserInstanceId: request.browserInstanceId, origins: request.origins, interaction: request.interaction, revision: current.revision })
      const next = BrowserCapabilityConfig.parse({ ...current, enabled: request.enabled, browserInstanceId: request.browserInstanceId,
        origins: request.origins, interaction: request.interaction, revision: current.revision + 1 })
      await this.save(next)
    })
    return this.diagnose()
  }

  connect(): Promise<ManagedBrowserSkillResult> {
    if (this.connection) return this.connection
    const connection = this.connectOnce().finally(() => { if (this.connection === connection) this.connection = undefined })
    this.connection = connection
    return connection
  }

  private async connectOnce(): Promise<ManagedBrowserSkillResult> {
    let result = await this.diagnose()
    if (result.status.state !== 'daemon_stopped') return result
    if (!this.ownedDaemon) {
      const config = result.status
      // Diagnose verified the fixed executable before this explicit launch.
      if (!config.executablePath || digest(await readFile(config.executablePath)) !== config.executableHash) throw new Error('browser_executable_changed')
      const child = this.start(config.executablePath, ['daemon', 'start', '--foreground'], browserEnvironment(config.homeDirectory))
      this.ownedDaemon = child
      child.stdout.resume()
      child.stderr.resume()
      const clear = (): void => { if (this.ownedDaemon === child) this.ownedDaemon = undefined }
      child.once('close', clear)
      child.once('error', clear)
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await this.wait()
      result = await this.diagnose()
      if (result.status.state !== 'daemon_stopped') return result
      if (!this.ownedDaemon) break
    }
    return result
  }

  dispose(): void {
    const child = this.ownedDaemon
    this.ownedDaemon = undefined
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

async function extractBrowserExecutable(bytes: Buffer, archiveName: string, target: string, executable: string): Promise<void> {
  if (archiveName.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
    const matches = Object.values(zip.files).filter(entry => !entry.dir && basename(entry.name) === executable)
    if (matches.length !== 1 || (Number(matches[0].unixPermissions ?? 0) & 0o170000) === 0o120000) throw new Error('browser_archive_invalid')
    const content = await matches[0].async('nodebuffer')
    if (!content.length || content.length > 128 * 1024 * 1024) throw new Error('browser_executable_size_invalid')
    await writeFile(join(target, executable), content, { mode: 0o600 })
    return
  }
  const archive = join(target, archiveName)
  await writeFile(archive, bytes, { mode: 0o600 })
  const listing = await executeFile('tar', ['-tzf', archive], { timeout: 10_000, maxBuffer: 1024 * 1024 })
  const members = String(listing.stdout).trim().split('\n')
  const names = members.filter(name => basename(name) === executable)
  if (names.length !== 1 || members.some(name => name.startsWith('/') || name.split('/').includes('..'))) throw new Error('browser_archive_invalid')
  const result = await executeFile('tar', ['-xOzf', archive, names[0]], { encoding: 'buffer', timeout: 10_000, maxBuffer: 128 * 1024 * 1024 })
  await writeFile(join(target, executable), result.stdout, { mode: 0o700 })
  await rm(archive)
}

let service: ManagedBrowserSkillService | undefined
export function getManagedBrowserSkillService(): ManagedBrowserSkillService {
  service ??= new ManagedBrowserSkillService()
  return service
}
