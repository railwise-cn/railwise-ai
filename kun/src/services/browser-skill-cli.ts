import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { BrowserInstance, type BrowserCapabilityConfig } from '../contracts/browser-skill.js'

const executeFile = promisify(execFile)
export type BrowserNavigationResult = { tab_id: number; url: string; reached: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | 'timeout'; final_url?: string; error_text?: string }
export type BrowserCommandResult = { ok: boolean; output: unknown; code?: string; outcomeUnknown?: boolean;
  exitCode?: number; navigation?: BrowserNavigationResult;
  vendorReason?: string; effectState?: 'none' | 'unknown' | 'committed';
  vendorCode?: string; vendorPhase?: string; vendorPressSent?: boolean; vendorDispatched?: boolean; vendorOperationId?: string;
  vendorFailureKind?: 'observed_content_changed' | 'context_superseded' | 'context_stale' | 'operation_settling' }
const vendorFailureMessages: Readonly<Record<string, NonNullable<BrowserCommandResult['vendorFailureKind']>>> = {
  "The action's observed content changed; synchronize and replan": 'observed_content_changed',
  'Page changed; synchronize before choosing an action': 'observed_content_changed',
  'This context belongs to a different or superseded observation': 'context_superseded',
  'This action requires the context returned by the latest cooperate sync': 'context_stale',
  'Another operation is settling on this tab': 'operation_settling'
}
/** Fixed vendor diagnostic scalars only; messages/recovery text can contain page data. */
export function browserCommandDiagnostics(result: BrowserCommandResult): Pick<BrowserCommandResult, 'vendorReason' | 'effectState' | 'vendorFailureKind' | 'vendorCode' | 'vendorPhase' | 'vendorPressSent' | 'vendorDispatched' | 'vendorOperationId'> {
  const data = object(object(result.output).data)
  const reason = result.vendorReason ?? data.reason
  const effect = result.effectState ?? data.effect_state
  const envelope = object(result.output)
  const message = envelope.message
  const code = result.vendorCode ?? envelope.code
  const phase = result.vendorPhase ?? data.phase
  const pressSent = result.vendorPressSent ?? data.press_sent
  const dispatched = result.vendorDispatched ?? data.dispatched
  const operationId = result.vendorOperationId ?? data.operation_id
  const kind = result.vendorFailureKind ?? (typeof message === 'string' && Object.hasOwn(vendorFailureMessages, message) ? vendorFailureMessages[message] : undefined)
  return { ...(typeof reason === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(reason) ? { vendorReason: reason } : {}),
    ...(['none', 'unknown', 'committed'].includes(String(effect)) ? { effectState: effect as 'none' | 'unknown' | 'committed' } : {}),
    ...(kind && Object.values(vendorFailureMessages).includes(kind) ? { vendorFailureKind: kind } : {}),
    ...(typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code) ? { vendorCode: code } : {}),
    ...(typeof phase === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(phase) ? { vendorPhase: phase } : {}),
    ...(typeof pressSent === 'boolean' ? { vendorPressSent: pressSent } : {}),
    ...(typeof dispatched === 'boolean' ? { vendorDispatched: dispatched } : {}),
    ...(typeof operationId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(operationId) ? { vendorOperationId: operationId } : {}) }
}
export type BrowserCommandRunner = (config: Pick<BrowserCapabilityConfig, 'executablePath' | 'executableHash' | 'homeDirectory'>, args: readonly string[], signal?: AbortSignal) => Promise<BrowserCommandResult>

/** A navigation lifecycle result is printed before exit 4; it is not an RPC error envelope. */
function navigationResult(args: readonly string[], output: unknown): BrowserNavigationResult | undefined {
  const value = object(output)
  if (args[0] !== 'navigate' || value.url !== args[1] || !Number.isSafeInteger(value.tab_id) || Number(value.tab_id) < 1 ||
    !['load', 'domcontentloaded', 'networkidle', 'commit', 'timeout'].includes(String(value.reached))) return undefined
  const boundedText = (item: unknown) => typeof item === 'string' && item.length <= 4096 && ![...item].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  if (!boundedText(value.url) || value.final_url != null && !boundedText(value.final_url) || value.error_text != null && !boundedText(value.error_text)) return undefined
  return { tab_id: Number(value.tab_id), url: String(value.url), reached: value.reached as BrowserNavigationResult['reached'],
    ...(typeof value.final_url === 'string' ? { final_url: value.final_url } : {}),
    ...(typeof value.error_text === 'string' ? { error_text: value.error_text } : {}) }
}

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
    const output: unknown = JSON.parse(String(result.stdout))
    const navigation = navigationResult(args, output)
    return { ok: true, output, exitCode: 0, ...(navigation ? { navigation } : {}) }
  } catch (error) {
    const failure = error as { stdout?: string; code?: string | number; killed?: boolean; name?: string }
    let output: unknown
    try { output = JSON.parse(String(failure.stdout ?? '')) } catch { output = undefined }
    const code = object(output).code
    const exitCode = typeof failure.code === 'number' && Number.isSafeInteger(failure.code) && failure.code >= 0 && failure.code <= 255 ? failure.code : undefined
    const navigation = navigationResult(args, output)
    const lifecycleTimeout = exitCode === 4 && navigation?.reached === 'timeout' && !failure.killed && failure.name !== 'AbortError'
    const result = { ok: false, output, ...(exitCode !== undefined ? { exitCode } : {}), ...(navigation ? { navigation } : {}),
      code: typeof code === 'string' ? code : failure.killed || failure.name === 'AbortError' ? 'browser_request_timeout' : lifecycleTimeout ? 'browser_navigation_timeout' : 'browser_command_failed',
      outcomeUnknown: Boolean(failure.killed || failure.name === 'AbortError' || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') }
    return { ...result, ...browserCommandDiagnostics(result) }
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

/** Target facts/read/explicit policy are an official 0.5 / protocol 1.8 contract. */
export function supportsBrowserTargetPolicy(version?: string, daemonProtocol?: string, extensionProtocol?: string): boolean {
  const protocol = (value?: string) => {
    const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value ?? '')
    return Boolean(match && Number(match[1]) === 1 && Number(match[2]) >= 8)
  }
  return supportsBrowserPolicyCLI(version) && protocol(daemonProtocol) && protocol(extensionProtocol)
}

/** Declarative native DOM read is the official 0.5 / protocol 1.9 contract. */
export function supportsBrowserNativeRead(version?: string, daemonProtocol?: string, extensionProtocol?: string): boolean {
  return supportsBrowserTargetPolicy(version, daemonProtocol, extensionProtocol) &&
    [daemonProtocol, extensionProtocol].every(value => Number(value!.split('.')[1]) >= 9)
}

export function supportsBrowserPolicyCLI(version?: string): boolean {
  const cli = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '')
  return Boolean(cli && (Number(cli[1]) > 0 || Number(cli[2]) >= 5))
}
