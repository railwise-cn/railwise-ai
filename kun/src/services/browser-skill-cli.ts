import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { BrowserInstance, type BrowserCapabilityConfig } from '../contracts/browser-skill.js'

const executeFile = promisify(execFile)
export type BrowserCommandResult = { ok: boolean; output: unknown; code?: string; outcomeUnknown?: boolean }
export type BrowserCommandRunner = (config: Pick<BrowserCapabilityConfig, 'executablePath' | 'executableHash' | 'homeDirectory'>, args: readonly string[], signal?: AbortSignal) => Promise<BrowserCommandResult>

export function browserEnvironment(homeDirectory?: string): NodeJS.ProcessEnv {
  return { ...process.env, ...(homeDirectory ? { BSK_HOME: homeDirectory } : {}), BSK_AUTO_START: '0', BSK_CANCEL_ON_STDIN_CLOSE: '1' }
}

export const runBrowserCommand: BrowserCommandRunner = async (config, args, signal) => {
  const path = config.executablePath
  if (!path || !isAbsolute(path) || !config.executableHash) throw new Error('browser_executable_unverified')
  const hash = createHash('sha256').update(await readFile(path)).digest('hex')
  if (hash !== config.executableHash) throw new Error('browser_executable_changed')
  try {
    const result = await executeFile(path, [...args, '--json'], {
      shell: false, windowsHide: true, env: browserEnvironment(config.homeDirectory), signal,
      timeout: 35_000, maxBuffer: 4 * 1024 * 1024
    })
    return { ok: true, output: JSON.parse(String(result.stdout)) }
  } catch (error) {
    const failure = error as { stdout?: string; code?: string | number; killed?: boolean; name?: string }
    let output: unknown
    try { output = JSON.parse(String(failure.stdout ?? '')) } catch { output = undefined }
    const code = object(output).code
    return { ok: false, output, code: typeof code === 'string' ? code : failure.killed || failure.name === 'AbortError' ? 'browser_request_timeout' : 'browser_command_failed',
      outcomeUnknown: Boolean(failure.killed || failure.name === 'AbortError' || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }
  }
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseBrowserStatus(value: unknown): { protocolVersion: string; browsers: BrowserInstance[]; pid: number } {
  const status = object(value)
  if (typeof status.protocol_version !== 'string' || !Array.isArray(status.browsers) || !Number.isSafeInteger(status.pid) || Number(status.pid) < 1) throw new Error('browser_invalid_status')
  return { protocolVersion: status.protocol_version, pid: Number(status.pid), browsers: status.browsers.map(value => {
    const browser = object(value)
    return BrowserInstance.parse({ id: browser.instance_id, name: browser.browser_name ?? '', label: browser.label ?? '',
      extensionVersion: browser.extension_version ?? '', protocolVersion: browser.extension_protocol_version ?? '',
      connected: browser.unresponsive !== true, versionSkew: browser.version_skew === true })
  }) }
}

export function compatibleBrowserProtocol(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version)
  return Boolean(match && Number(match[1]) === 1 && Number(match[2]) >= 6)
}
