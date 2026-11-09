import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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
    const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return value ? { pid, fingerprint: `${process.platform}:${value}` } : null
  } catch { return null }
}
export function inspectProcess(identity: ProcessIdentity): 'alive' | 'exited' | 'unknown' {
  if (identity.fingerprint.startsWith('unverified:')) return 'unknown'
  const current = processIdentity(identity.pid)
  if (current) return current.fingerprint === identity.fingerprint ? 'alive' : 'exited'
  try { process.kill(identity.pid, 0); return 'unknown' } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'exited' : 'unknown'
  }
}
