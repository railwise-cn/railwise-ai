import { readFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import type { ProcessIdentity } from '../contracts/execution.js'

/** A PID alone never proves identity; unavailable fingerprints fail closed. */
export function processIdentity(pid = process.pid): ProcessIdentity | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      return start ? { pid, fingerprint: `linux:${boot}:${start}` } : null
    }
    if (process.platform === 'win32') {
      const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim()
      return /^\d+$/.test(value) ? { pid, fingerprint: `win32:${value}` } : null
    }
    const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }).trim()
    return value ? { pid, fingerprint: `${process.platform === 'darwin' ? 'darwin-utc' : process.platform}:${value}` } : null
  } catch { return null }
}
export type ProcessIdentityProbeOptions = { timeoutMs?: number; signal?: AbortSignal }

/** An asynchronous birth probe for UI-owned processes; a timeout never proves identity. */
export async function processIdentityAsync(pid = process.pid, options: ProcessIdentityProbeOptions = {}): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid < 1 || options.signal?.aborted) return null
  if (process.platform !== 'win32') return processIdentity(pid)
  const timeout = options.timeoutMs ?? 10_000
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 10_000) return null
  return new Promise(resolve => {
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
        { encoding: 'utf8', timeout, windowsHide: true, signal: options.signal, maxBuffer: 64 * 1024 }, (error, stdout) => {
          if (error || options.signal?.aborted) { resolve(null); return }
          const value = stdout.trim()
          resolve(/^\d+$/.test(value) ? { pid, fingerprint: `win32:${value}` } : null)
        })
    } catch { resolve(null) }
  })
}
export function inspectProcess(identity: ProcessIdentity): 'alive' | 'exited' | 'unknown' {
  if (identity.fingerprint.startsWith('unverified:')) return 'unknown'
  const current = processIdentity(identity.pid)
  if (current) {
    if (current.fingerprint === identity.fingerprint) return 'alive'
    // Legacy macOS birth strings depended on the launching shell's locale and
    // timezone. A mismatch cannot establish that this PID's owner has exited.
    if (identity.fingerprint.startsWith('darwin:') && current.fingerprint.startsWith('darwin-utc:')) return 'unknown'
    return 'exited'
  }
  try { process.kill(identity.pid, 0); return 'unknown' } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'unknown'
  }
}
