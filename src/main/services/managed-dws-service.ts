import { createHash } from 'node:crypto'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import { gunzipSync } from 'node:zlib'
import JSZip from 'jszip'
import type { ManagedDwsResult, ManagedDwsStatus } from '../../shared/managed-dws'
import { assertDwsCredentialAccess, resolveDwsEnvironment } from '../../../kun/src/services/dws-cli-environment.js'
import { parseDwsIdentityBinding } from '../../../kun/src/services/dws-cli-identity.js'
import { systemFetch } from './system-network'
import { atomicWriteFile } from './durable-file'

export const MANAGED_DWS_VERSION = '1.0.67'
const REPO = 'DingTalk-Real-AI/dingtalk-workspace-cli'
const ASSETS: Record<string, string> = {
  'dws-darwin-arm64.tar.gz': 'ffbb8962de879a5693ea380654813f45f9252f39d5527a24e135567aa2c36dea',
  'dws-darwin-amd64.tar.gz': '1021d30296534c380bd27967b1641d5a5e42573e263c56d8a984dd13eb9991c2',
  'dws-windows-amd64.zip': '3cb839866497405581c8ba5ef069e635495e9ee8afa8ff736c11f66db726184e',
  'dws-windows-arm64.zip': '349cec555a59dff53ceb142ccf2f9e29727bf879ceb045fb9f51962226b5dcb2'
}
const LIMIT = 128 * 1024 * 1024
const execFileAsync = promisify(execFile)
type Run = (path: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ ok: boolean; output: string }>
type Launch = (path: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
type Dependencies = { root?: () => string; run?: Run; fetch?: typeof systemFetch; start?: Launch; target?: () => { platform: string; arch: string }; hashes?: Record<string, string> }
type InstallRecord = { version: string; executablePath: string; executableHash: string; assetName: string; archiveHash: string; installedAt: string }
type Pending = { child: ChildProcessWithoutNullStreams; closed?: boolean; executablePath: string; executableHash: string; state: 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'expired'; expiresAt: number; url?: string; userCode?: string; output: string; timer: ReturnType<typeof setTimeout> }
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export function officialDingTalkURL(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return
    if (!['dingtalk.com', 'dingtalk.io'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return
    return url.toString()
  } catch { return }
}
function assetName(platform: string, arch: string): string {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`Official DingTalk CLI is not supported on ${platform}/${arch}.`)
  return `dws-${platform === 'win32' ? 'windows' : platform}-${arch === 'x64' ? 'amd64' : arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`
}
function safePath(name: string): boolean {
  const value = name.replace(/\\/g, '/')
  return Boolean(value) && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.split('/').includes('..')
}
async function executableBytes(bytes: Buffer, asset: string, executable: string): Promise<Buffer> {
  if (asset.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
    const matches = Object.values(zip.files).filter(entry => {
      if (!safePath(entry.name) || (Number(entry.unixPermissions || 0) & 0o170000) === 0o120000) throw new Error('Official archive contains an unsafe entry.')
      return !entry.dir && entry.name.split('/').at(-1) === executable
    })
    if (matches.length !== 1) throw new Error('Official archive does not contain one DingTalk executable.')
    const result = await matches[0].async('nodebuffer')
    if (!result.length || result.length > LIMIT) throw new Error('DingTalk executable exceeds its size limit.')
    return result
  }
  const tar = gunzipSync(bytes, { maxOutputLength: LIMIT })
  const matches: Buffer[] = []
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '')
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/s, '')
    if (!safePath(prefix ? `${prefix}/${name}` : name)) throw new Error('Official archive contains an unsafe path.')
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Official archive contains an invalid size.')
    const size = parseInt(sizeText, 8)
    const kind = header[156]
    if (![0, 48, 53].includes(kind) || offset + 512 + size > tar.length) throw new Error('Official archive contains an unsupported entry.')
    if ((kind === 0 || kind === 48) && name.split('/').at(-1) === executable) matches.push(tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (matches.length !== 1 || !matches[0].length) throw new Error('Official archive does not contain one DingTalk executable.')
  return matches[0]
}

/** Official CLI installation and one captured device authorization process. */
export class ManagedDwsService {
  private readonly root: () => string
  private readonly run: Run
  private readonly fetch: typeof systemFetch
  private readonly start: Launch
  private readonly target: () => { platform: string; arch: string }
  private readonly hashes: Record<string, string>
  private installing?: Promise<ManagedDwsResult>
  private starting?: Promise<ManagedDwsResult>
  private pending?: Pending
  private generation = 0
  constructor(deps: Dependencies = {}) {
    this.root = deps.root ?? (() => join(resolve(process.env.WORKWISE_TOOLS_ROOT || join(homedir(), '.workwise', 'tools')), 'dws'))
    this.run = deps.run ?? (async (path, args, env) => {
      try { const result = await execFileAsync(path, args, { env, shell: false, windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024 }); return { ok: true, output: String(result.stdout).trim() } }
      catch { return { ok: false, output: '' } }
    })
    this.fetch = deps.fetch ?? systemFetch
    this.start = deps.start ?? ((path, args, env) => spawn(path, args, { env, shell: false, windowsHide: true, stdio: 'pipe' }))
    this.target = deps.target ?? (() => ({ platform: process.platform, arch: process.arch }))
    this.hashes = deps.hashes ?? ASSETS
  }
  private async record(): Promise<InstallRecord | undefined> {
    const path = join(this.root(), 'manifest.json')
    if (!existsSync(path)) return
    const record = JSON.parse(await readFile(path, 'utf8')) as InstallRecord
    const expected = join(this.root(), record.executablePath.endsWith('.exe') ? 'dws.exe' : 'dws')
    if (record.version !== MANAGED_DWS_VERSION || record.executablePath !== expected || record.archiveHash !== this.hashes[record.assetName] || !/^[a-f0-9]{64}$/.test(record.executableHash)) throw new Error('Managed DingTalk installation metadata could not be verified. Existing files were preserved.')
    return record
  }
  async diagnose(profile?: string): Promise<ManagedDwsResult> {
    try {
      const record = await this.record()
      if (!record || !existsSync(record.executablePath)) return { ok: true, status: { state: 'not_installed' } }
      if (sha256(await readFile(record.executablePath)) !== record.executableHash) return { ok: false, message: 'Managed DingTalk executable changed. Existing files were preserved.', status: { state: 'error' } }
      assertDwsCredentialAccess()
      const env = resolveDwsEnvironment()
      const result = await this.run(record.executablePath, ['auth', 'status', '--readonly', ...(profile ? ['--profile', profile] : []), '--format', 'json'], env)
      const identity = parseDwsIdentityBinding(result.ok ? result.output : '')
      return { ok: true, status: { ...identity, version: record.version, executablePath: record.executablePath, executableHash: record.executableHash, ...(identity.state === 'error' ? { message: 'DingTalk login state could not be verified. Existing credentials were preserved; check connection diagnostics.' } : {}) } }
    } catch (error) { return { ok: false, status: { state: 'error' }, message: error instanceof Error ? error.message : 'DingTalk diagnosis failed.' } }
  }
  private async boundedDownload(url: string, max = LIMIT): Promise<Buffer> {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(45_000), headers: { 'User-Agent': 'RailWise AI' } })
    if (!response.ok) throw new Error('Official DingTalk download is unavailable.')
    if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Official download redirected to an insecure URL.')
    if (Number(response.headers.get('content-length')) > max) throw new Error('Official download exceeds its size limit.')
    const chunks: Buffer[] = []; let size = 0
    if (!response.body) throw new Error('Official download is empty.')
    const reader = response.body.getReader()
    try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) throw new Error('Official download exceeds its size limit.'); chunks.push(Buffer.from(value)) } }
    finally { await reader.cancel().catch(() => undefined) }
    return Buffer.concat(chunks)
  }
  private async mirrorAsset(asset: string): Promise<string | undefined> {
    try {
      const body = JSON.parse((await this.boundedDownload(`https://gitee.com/api/v5/repos/${REPO}/releases/tags/v${MANAGED_DWS_VERSION}`, 1024 * 1024)).toString()) as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> | { links?: Array<{ name?: string; browser_download_url?: string }> } }
      if (body.tag_name !== `v${MANAGED_DWS_VERSION}`) return
      const assets = Array.isArray(body.assets) ? body.assets : body.assets?.links ?? []
      const url = assets.find(item => item.name === asset)?.browser_download_url
      if (!url) return
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && (parsed.hostname === 'gitee.com' || parsed.hostname.endsWith('.gitee.com'))) return parsed.toString()
    } catch { /* The same fixed GitHub asset remains the fallback. */ }
    return
  }
  async install(): Promise<ManagedDwsResult> {
    if (this.installing) return this.installing
    const operation = this.installOnce()
    this.installing = operation
    try { return await operation } finally { if (this.installing === operation) this.installing = undefined }
  }
  private async installOnce(): Promise<ManagedDwsResult> {
    let stage: string | undefined
    try {
      const existing = await this.record()
      if (existing) return this.diagnose()
      const target = this.target(); const asset = assetName(target.platform, target.arch)
      const digest = this.hashes[asset]
      if (!digest) throw new Error('No verified official DingTalk asset is available for this platform.')
      const mirror = await this.mirrorAsset(asset)
      const sources = [...(mirror ? [mirror] : []), `https://github.com/${REPO}/releases/download/v${MANAGED_DWS_VERSION}/${asset}`]
      let bytes: Buffer | undefined
      for (const url of sources) {
        try { const downloaded = await this.boundedDownload(url); if (sha256(downloaded) !== digest) throw new Error('Official DingTalk archive checksum does not match the pinned release.'); bytes = downloaded; break }
        catch { /* A failed mirror cannot change the pinned asset or hash. */ }
      }
      if (!bytes) throw new Error('Verified DingTalk CLI download failed from the official mirror and GitHub. Check the system network and retry.')
      const executable = target.platform === 'win32' ? 'dws.exe' : 'dws'
      const binary = await executableBytes(bytes, asset, executable)
      await mkdir(this.root(), { recursive: true, mode: 0o700 })
      stage = await mkdtemp(join(this.root(), '.install-'))
      const staged = join(stage, executable); await writeFile(staged, binary, { mode: 0o700 }); await chmod(staged, 0o700)
      const version = await this.run(staged, ['version'], resolveDwsEnvironment())
      if (!version.ok || !new RegExp(`(?:^|[^0-9])${MANAGED_DWS_VERSION.replace(/\./g, '\\.')}([^0-9]|$)`).test(version.output)) throw new Error('The installed DingTalk executable did not report the pinned version.')
      const destination = join(this.root(), executable)
      if (existsSync(destination)) throw new Error('An unregistered DingTalk executable already exists. It was preserved; inspect the managed tools directory before installing.')
      await rename(staged, destination)
      const record: InstallRecord = { version: MANAGED_DWS_VERSION, executablePath: destination, executableHash: sha256(binary), assetName: asset, archiveHash: digest, installedAt: new Date().toISOString() }
      await atomicWriteFile(join(this.root(), 'manifest.json'), `${JSON.stringify(record, null, 2)}\n`)
      return { ok: true, status: { state: 'needs_login', version: record.version, executablePath: destination, executableHash: record.executableHash, scopes: [], message: 'Official DingTalk CLI is installed. Connect on the official scan page to authorize an account.' } }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'DingTalk installation failed.' } }
    finally { if (stage) await rm(stage, { recursive: true, force: true }) }
  }
  private stop(pending: Pending, state: 'cancelled' | 'expired' | 'failed'): void {
    pending.state = state; clearTimeout(pending.timer)
    if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill('SIGTERM')
  }
  cancel(): ManagedDwsResult {
    this.generation++
    if (this.pending && ['waiting', 'succeeded'].includes(this.pending.state)) this.stop(this.pending, 'cancelled')
    return { ok: true, state: 'cancelled' }
  }
  private snapshot(pending: Pending): ManagedDwsResult {
    if (pending.state === 'waiting' && pending.expiresAt <= Date.now()) this.stop(pending, 'expired')
    return { ok: true, state: pending.state, expiresAt: new Date(pending.expiresAt).toISOString(), ...(pending.url ? { verificationUrl: pending.url } : {}), ...(pending.userCode ? { userCode: pending.userCode } : {}) }
  }
  async beginLogin(): Promise<ManagedDwsResult> {
    if (this.starting) return this.starting
    const operation = this.beginLoginOnce().catch((): ManagedDwsResult => ({ ok: false, message: 'Official DingTalk authorization could not start. Existing credentials were preserved.' }))
    this.starting = operation
    try { return await operation } finally { if (this.starting === operation) this.starting = undefined }
  }
  private async beginLoginOnce(): Promise<ManagedDwsResult> {
    assertDwsCredentialAccess()
    if (this.pending?.state === 'waiting') return this.snapshot(this.pending)
    if (this.pending && !this.pending.closed) return { ok: false, message: 'The previous DingTalk authorization process is still stopping. Check its result before reconnecting.' }
    const generation = ++this.generation
    const diagnosis = await this.diagnose()
    if (!diagnosis.ok || !diagnosis.status?.executablePath || diagnosis.status.state === 'error') return { ok: false, message: 'Install and diagnose the official DingTalk CLI before connecting. Unknown login state is preserved.' }
    if (generation !== this.generation) return { ok: true, state: 'cancelled' }
    const child = this.start(diagnosis.status.executablePath, ['auth', 'login', '--device', '--no-browser', '--format', 'json'], resolveDwsEnvironment())
    child.stdin.end()
    const pending: Pending = { child, executablePath: diagnosis.status.executablePath, executableHash: diagnosis.status.executableHash!, state: 'waiting', expiresAt: Date.now() + 10 * 60_000, output: '', timer: setTimeout(() => this.stop(pending, 'expired'), 10 * 60_000) }
    pending.timer.unref(); this.pending = pending
    return new Promise(resolveResult => {
      let settled = false; let stderr = ''
      const finish = (value: ManagedDwsResult): void => { if (!settled) { settled = true; clearTimeout(deadline); resolveResult(value) } }
      const deadline = setTimeout(() => { this.stop(pending, 'failed'); finish({ ok: false, message: 'The official DingTalk authorization page was not received. Check connectivity and retry.' }) }, 45_000)
      deadline.unref()
      child.stderr.on('data', (bytes: Buffer) => {
        if (pending.state !== 'waiting') return
        stderr = stripVTControlCharacters((stderr + bytes.toString('utf8')).slice(-64 * 1024))
        const code = /(?:授权码|[Uu]ser[_ ]?[Cc]ode)\s*[:：]\s*([A-Z0-9-]{4,32})/.exec(stderr)?.[1]
        if (code) pending.userCode = code
        for (const match of stderr.matchAll(/^(https:\/\/[^\s<>"']+)[\r\n]/gm)) {
          const url = officialDingTalkURL(match[1])
          if (!url) { this.stop(pending, 'failed'); finish({ ok: false, message: 'The official CLI returned an untrusted DingTalk authorization URL.' }); return }
          pending.url = url; finish(this.snapshot(pending)); break
        }
      })
      child.stdout.on('data', (bytes: Buffer) => { pending.output = (pending.output + bytes.toString('utf8')).slice(-64 * 1024) })
      child.once('error', () => { this.stop(pending, 'failed'); finish({ ok: false, message: 'The official DingTalk login process could not start.' }) })
      child.once('close', code => {
        pending.closed = true
        clearTimeout(pending.timer)
        if (pending.state === 'waiting') pending.state = code === 0 ? 'succeeded' : 'failed'
        if (pending.state === 'succeeded') {
          // Even an immediate zero exit must prove this process's result and
          // exact profile. Exit status alone is never an authorization receipt.
          if (!settled) void this.verifyPendingLogin(pending, generation).then(finish)
        } else finish(this.snapshot(pending))
      })
    })
  }
  async checkLogin(): Promise<ManagedDwsResult> {
    const pending = this.pending
    if (!pending) return { ok: false, message: 'Start official DingTalk authorization first.' }
    return this.verifyPendingLogin(pending, this.generation)
  }
  private async verifyPendingLogin(pending: Pending, generation: number): Promise<ManagedDwsResult> {
    const isCurrent = (): boolean => this.pending === pending && this.generation === generation
    const superseded = (): ManagedDwsResult => ({ ok: false, message: 'This DingTalk authorization check was cancelled or replaced. Check the current connection; no queued task was run.' })
    try {
      assertDwsCredentialAccess()
      if (!isCurrent()) return superseded()
      const binaryHash = sha256(await readFile(pending.executablePath))
      if (!isCurrent()) return superseded()
      if (binaryHash !== pending.executableHash) { if (pending.state === 'waiting') this.stop(pending, 'failed'); return { ok: false, message: 'DingTalk CLI changed during authorization. Check official account state before reconnecting.' } }
      const snapshot = this.snapshot(pending)
      if (pending.state !== 'succeeded') return snapshot
      let result: { success?: boolean; token_valid?: boolean; corp_id?: string; user_id?: string }
      try { result = JSON.parse(pending.output) as typeof result } catch { return { ok: false, message: 'The official login result could not be verified. No queued task was run.' } }
      if (result.success !== true || result.token_valid !== true || !result.corp_id || !result.user_id) return { ok: false, message: 'The official login process did not return a verified user identity.' }
      const diagnosis = await this.diagnose(`${result.corp_id}:${result.user_id}`)
      // Cancellation and a subsequent login invalidate every in-flight read.
      // Do not return status: IPC would otherwise refresh the old account into
      // Runtime capabilities even after the user cancelled or changed flows.
      if (!isCurrent() || pending.state !== 'succeeded') return superseded()
      if (!diagnosis.ok || diagnosis.status?.state !== 'installed' || diagnosis.status.corpId !== result.corp_id || diagnosis.status.userId !== result.user_id) return { ok: false, message: 'The authorized DingTalk identity could not be verified. No queued task was run.' }
      return { ...diagnosis, state: 'succeeded' }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'DingTalk authorization could not be verified.' } }
  }
}

const service = new ManagedDwsService()
process.once('exit', () => service.cancel())
export const diagnoseManagedDingTalk = (): Promise<ManagedDwsResult> => service.diagnose()
export const installManagedDingTalk = (): Promise<ManagedDwsResult> => service.install()
export const beginManagedDingTalkLogin = (): Promise<ManagedDwsResult> => service.beginLogin()
export const checkManagedDingTalkLogin = (): Promise<ManagedDwsResult> => service.checkLogin()
export const cancelManagedDingTalkLogin = async (): Promise<ManagedDwsResult> => service.cancel()
