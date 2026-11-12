import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ManagedLarkAppSetupResult } from '../../shared/workwise-api'

type Run = (path: string, args: string[]) => Promise<{ ok: boolean; output: string }>
export type LarkAppSetupBinding = { executablePath: string; executableHash: string; profile: string; appId: string; brand: 'feishu' | 'lark' }
type Launch = (path: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams
const launch: Launch = (path, args, env) => spawn(path, args, { env, shell: false, windowsHide: true, stdio: 'pipe' })

export function officialLarkURL(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return
    if (!['feishu.cn', 'larksuite.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return
    return url.toString()
  } catch { return }
}

export function larkAppConfiguration(output: string, ok: boolean): 'configured' | 'missing' | 'error' {
  try {
    const value = JSON.parse(output) as Record<string, unknown>
    if (ok && typeof value.appId === 'string' && value.appId.trim() && ['feishu', 'lark'].includes(String(value.brand))) return 'configured'
    const error = (value.error ?? value) as Record<string, unknown>
    if (!ok && error.type === 'config' && error.subtype === 'not_configured') return 'missing'
  } catch { /* Never treat invalid config or network/storage failures as empty. */ }
  return 'error'
}

type Pending = {
  id: string; generation: number; profile: string; child: ChildProcessWithoutNullStreams; executablePath: string; fingerprint: string
  expiresAt: number; url?: string; closed?: boolean; state: 'waiting' | 'verifying' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  timer: ReturnType<typeof setTimeout>
}

/** config init has no no-wait API: hold the original official process while it polls. */
export class ManagedLarkAppSetup {
  private pending?: Pending
  private starting?: Promise<ManagedLarkAppSetupResult>
  private generation = 0
  private verifiedBinding?: LarkAppSetupBinding
  constructor(private readonly run: Run, private readonly env: () => NodeJS.ProcessEnv, private readonly start: Launch = launch) {}

  private stop(pending: Pending, state: 'cancelled' | 'expired' | 'failed'): void {
    pending.state = state
    if (this.verifiedBinding?.profile === pending.profile) this.clearBinding()
    clearTimeout(pending.timer)
    // Signal only the captured child, never a persisted/reused PID.
    if (!pending.closed && pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill('SIGTERM')
  }

  cancel(): ManagedLarkAppSetupResult {
    this.generation++
    this.clearBinding()
    if (this.pending && ['waiting', 'verifying', 'succeeded'].includes(this.pending.state)) this.stop(this.pending, 'cancelled')
    return { ok: true, state: 'cancelled' }
  }

  clearBinding(): void { this.verifiedBinding = undefined }
  binding(): LarkAppSetupBinding | undefined { return this.verifiedBinding ? { ...this.verifiedBinding } : undefined }
  isWaiting(): boolean {
    const pending = this.pending
    if (!pending || !this.isCurrent(pending)) return false
    this.snapshot(pending)
    return ['waiting', 'verifying'].includes(pending.state)
  }

  private snapshot(pending: Pending): ManagedLarkAppSetupResult {
    if (pending.expiresAt <= Date.now() && ['waiting', 'verifying'].includes(pending.state)) this.stop(pending, 'expired')
    return { ok: true, state: pending.state === 'verifying' ? 'waiting' : pending.state, expiresAt: new Date(pending.expiresAt).toISOString(), ...(pending.url && pending.state === 'waiting' ? { verificationUrl: pending.url } : {}) }
  }

  private isCurrent(pending: Pending): boolean {
    return this.pending === pending && pending.generation === this.generation
  }

  private invalidated(pending: Pending): ManagedLarkAppSetupResult | undefined {
    if (!this.isCurrent(pending)) return { ok: true, state: 'cancelled' }
    const snapshot = this.snapshot(pending)
    if (['cancelled', 'expired', 'failed'].includes(pending.state)) return snapshot
    return
  }

  async begin(executablePath: string): Promise<ManagedLarkAppSetupResult> {
    if (this.starting) return this.starting
    const operation = this.beginOnce(executablePath).catch((): ManagedLarkAppSetupResult => ({ ok: false, message: 'Application setup could not be verified or started. Existing configuration has not been replaced.' }))
    this.starting = operation
    try { return await operation } finally { if (this.starting === operation) this.starting = undefined }
  }

  private async beginOnce(executablePath: string): Promise<ManagedLarkAppSetupResult> {
    const generation = this.generation
    if (this.pending && ['waiting', 'verifying'].includes(this.pending.state)) return this.snapshot(this.pending)
    if (this.pending && !this.pending.closed) return { ok: false, message: 'The previous application setup process is still stopping. Check its state before retrying.' }
    this.pending = undefined
    this.clearBinding()
    const check = await this.run(executablePath, ['config', 'show'])
    if (generation !== this.generation) return { ok: true, state: 'cancelled' }
    const configuration = larkAppConfiguration(check.output, check.ok)
    if (configuration === 'configured') {
      const executableHash = createHash('sha256').update(await readFile(executablePath)).digest('hex')
      if (generation !== this.generation) return { ok: true, state: 'cancelled' }
      const value = JSON.parse(check.output) as { profile?: string; appId: string; brand: 'feishu' | 'lark' }
      this.verifiedBinding = { executablePath, executableHash, profile: value.profile?.trim() || value.appId, appId: value.appId, brand: value.brand }
      return { ok: true, state: 'configured' }
    }
    if (configuration !== 'missing') return { ok: false, message: 'Existing Lark configuration could not be verified. It has not been replaced.' }
    const fingerprint = createHash('sha256').update(await readFile(executablePath)).digest('hex')
    if (generation !== this.generation) return { ok: true, state: 'cancelled' }
    const id = randomUUID()
    const profile = `railwise-${id}`
    // --name appends a unique profile, even if another process configures an app
    // after our read. Bare --new would replace existing apps and their tokens.
    const child = this.start(executablePath, ['config', 'init', '--new', '--name', profile, '--brand', 'feishu', '--lang', 'zh_cn'], this.env())
    child.stdin.end()
    const pending: Pending = { id, generation, profile, child, executablePath, fingerprint, state: 'waiting', expiresAt: Date.now() + 15 * 60_000,
      timer: setTimeout(() => this.stop(pending, 'expired'), 15 * 60_000) }
    pending.timer.unref()
    this.pending = pending
    return new Promise(resolve => {
      let settled = false
      let output = ''
      const linkDeadline = setTimeout(() => { this.stop(pending, 'failed'); finish({ ok: false, message: 'The official application setup page was not received. Check connectivity and retry.' }) }, 35_000)
      linkDeadline.unref()
      const finish = (result: ManagedLarkAppSetupResult): void => { if (!settled) { settled = true; clearTimeout(linkDeadline); resolve(result) } }
      const consume = (bytes: Buffer): void => {
        if (pending.state !== 'waiting') return
        output = (output + bytes.toString('utf8')).slice(-64 * 1024)
        // Upstream prints the device verification link on its own indented
        // line. Wait for the line ending: pipes can split a URL at any byte.
        for (const raw of [...output.matchAll(/^ {2}(https:\/\/[^\s<>"']+)[\r\n]/gm)].map(match => match[1])) {
          const url = officialLarkURL(raw)
          if (!url) { this.stop(pending, 'failed'); finish({ ok: false, message: 'The official CLI returned an untrusted application setup URL.' }); return }
          pending.url = url
          finish(this.snapshot(pending))
          break
        }
      }
      child.stderr.on('data', consume)
      // stdout may contain app credentials in future CLI versions: discard it.
      child.stdout.resume()
      child.once('error', () => { this.stop(pending, 'failed'); finish({ ok: false, message: 'The official application setup process could not start.' }) })
      child.once('close', code => {
        pending.closed = true
        clearTimeout(linkDeadline)
        if (pending.state === 'waiting') pending.state = code === 0 ? 'verifying' : 'failed'
        if (pending.state !== 'verifying') { clearTimeout(pending.timer); finish(this.snapshot(pending)); return }
        // Exit zero is a process observation. Only the named profile created
        // by this attempt can establish that application setup completed.
        if (!settled) void this.check().then(finish, () => finish({ ok: false, message: 'Application setup ended without a verifiable app configuration.' }))
      })
    })
  }

  async check(): Promise<ManagedLarkAppSetupResult> {
    const pending = this.pending
    if (!pending) return { ok: false, message: 'Start application setup first.' }
    const initial = this.invalidated(pending)
    if (initial) return initial
    const fingerprint = createHash('sha256').update(await readFile(pending.executablePath)).digest('hex')
    const invalidated = this.invalidated(pending)
    if (invalidated) return invalidated
    if (fingerprint !== pending.fingerprint) {
      this.stop(pending, 'failed')
      return { ok: false, message: 'Lark CLI changed during setup. No login was started; check configuration again.' }
    }
    const status = this.snapshot(pending)
    if (pending.state !== 'verifying' && pending.state !== 'succeeded') return status
    const check = await this.run(pending.executablePath, ['config', 'show', '--profile', pending.profile])
    const stale = this.invalidated(pending)
    if (stale) return stale
    let profile: unknown
    try { profile = (JSON.parse(check.output) as { profile?: unknown }).profile } catch { /* Unknown output fails closed. */ }
    if (larkAppConfiguration(check.output, check.ok) !== 'configured' || profile !== pending.profile) {
      this.stop(pending, 'failed')
      return { ok: false, message: 'Application setup ended without a verifiable app configuration for this attempt. No account login was started.' }
    }
    pending.state = 'succeeded'
    const value = JSON.parse(check.output) as { appId: string; brand: 'feishu' | 'lark' }
    this.verifiedBinding = { executablePath: pending.executablePath, executableHash: fingerprint, profile: pending.profile, appId: value.appId, brand: value.brand }
    clearTimeout(pending.timer)
    return { ok: true, state: 'configured' }
  }
}
