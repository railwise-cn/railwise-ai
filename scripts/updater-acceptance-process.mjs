import { spawn, spawnSync } from 'node:child_process'
import { basename } from 'node:path'

export function boundedCommand(command, args, options = {}) {
  const { timeoutMs = basename(command) === 'security' ? 20_000 : 120_000, progress = () => {}, allowedExitCodes = [0], ...spawnOptions } = options
  const label = `${basename(command)}${basename(command) === 'security' ? ` ${args[0]}` : ''}`
  progress({ operation: label, status: 'started', timeoutMs })
  const result = spawnSync(command, args, { encoding: 'utf8', ...spawnOptions, timeout: timeoutMs, killSignal: 'SIGKILL' })
  const timedOut = result.error?.code === 'ETIMEDOUT'
  progress({ operation: label, status: timedOut ? 'timed-out' : result.error || !allowedExitCodes.includes(result.status) ? 'failed' : 'completed', exitCode: result.status, signal: result.signal })
  if (result.error || !allowedExitCodes.includes(result.status)) {
    // Keychain arguments and diagnostics can contain credentials.
    const detail = basename(command) === 'security' ? '' : `: ${result.stderr || result.error?.message || ''}`
    throw new Error(`${label} ${timedOut ? `timed out after ${timeoutMs} ms` : `failed (exit ${result.status ?? 'unknown'})`}${detail}`)
  }
  return result
}

export function boundedProcess(command, args, { timeoutMs, env, progress = () => {}, operation = 'native-updater-harness' }) {
  return new Promise((resolveRun, reject) => {
    const grouped = process.platform !== 'win32'
    let settled = false
    const child = spawn(command, args, { env, stdio: 'inherit', detached: grouped })
    progress({ operation, status: 'started', timeoutMs })
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      progress({ operation, status: error ? 'failed' : 'completed' })
      if (error) reject(error)
      else resolveRun()
    }
    const timer = setTimeout(() => {
      progress({ operation, status: 'timed-out' })
      try {
        if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch (error) { if (error.code !== 'ESRCH') return finish(error) }
      finish(new Error(`${operation} timed out after ${timeoutMs} ms.`))
    }, timeoutMs)
    child.once('error', finish)
    child.once('exit', (code, signal) => finish(code === 0 ? null : new Error(`${operation} failed (exit ${code}, signal ${signal}).`)))
  })
}
