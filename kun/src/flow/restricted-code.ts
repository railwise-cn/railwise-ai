import { spawn } from 'node:child_process'
import type { FlowNodeAdapter } from './executor.js'

const SOURCE_BYTES = 64 * 1024
const PROTOCOL_BYTES = 1024 * 1024
const MAX_TIMEOUT_MS = 30_000
const MEMORY_MIB = 64

type RestrictedCodeRequest = { source: string; input: unknown }
type RestrictedCodeResponse = { ok: true; output: unknown } | { ok: false; error: string; code?: string }

const CHILD_PROGRAM = String.raw`
const vm = require('node:vm')
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  raw += chunk
  if (Buffer.byteLength(raw) > ${PROTOCOL_BYTES}) fail('protocol_limit', 'Restricted code input exceeds the protocol limit')
})
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(raw)
    if (!request || typeof request.source !== 'string') return fail('invalid_request', 'Invalid restricted code request')
    const sandbox = Object.create(null)
    sandbox.input = structuredClone(request.input)
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
    const script = new vm.Script('(async (input) => { "use strict"; ' + request.source + '\n})(input)', { filename: 'flow-restricted-code.js' })
    const output = await script.runInContext(context, { timeout: ${MAX_TIMEOUT_MS}, breakOnSigint: true })
    const encoded = JSON.stringify({ ok: true, output })
    if (encoded === undefined) return fail('non_json_output', 'Restricted code output must be JSON serializable')
    if (Buffer.byteLength(encoded) > ${PROTOCOL_BYTES}) return fail('protocol_limit', 'Restricted code output exceeds the protocol limit')
    process.stdout.write(encoded)
  } catch (error) {
    fail('execution_failed', error && error.message ? error.message : String(error))
  }
})
function fail(code, message) {
  const encoded = JSON.stringify({ ok: false, code, error: String(message).slice(0, 4096) })
  process.stdout.write(encoded)
  process.exitCode = 1
}
`

export const restrictedCodeAdapter: FlowNodeAdapter = async ({ run, node, input, signal }) => {
  const source = typeof node.config.source === 'string' ? node.config.source : ''
  if (!source.trim()) throw restrictedError('restricted_code_source_missing', 'Restricted code source is required')
  if (Buffer.byteLength(source, 'utf8') > SOURCE_BYTES) throw restrictedError('restricted_code_source_limit', `Restricted code source exceeds ${SOURCE_BYTES} bytes`)
  const requested = requestedPermissions(node.config)
  if (requested.length) {
    const grants = Array.isArray(run.checkpoint?.restrictedCodePermissionGrants) ? run.checkpoint.restrictedCodePermissionGrants : []
    if (!grants.includes(node.id)) return { kind: 'wait', reason: 'approval', checkpoint: { requestedPermissions: requested } }
    throw restrictedError('restricted_code_permission_denied', `Approved extra permissions are not enforceable by this runner and were denied: ${requested.join(', ')}`)
  }
  ensureJson(input, 'input')
  const timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, node.policy.timeoutMs))
  return { kind: 'output', output: await runRestrictedCode({ source, input }, timeoutMs, signal) }
}

export async function runRestrictedCode(request: RestrictedCodeRequest, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const payload = JSON.stringify(request)
  if (Buffer.byteLength(payload, 'utf8') > PROTOCOL_BYTES) throw restrictedError('restricted_code_protocol_limit', 'Restricted code input exceeds the protocol limit')
  return await new Promise<unknown>((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${MEMORY_MIB}`, '-e', CHILD_PROGRAM], {
      // Packaged Runtime uses Electron as process.execPath. Only this bootstrap
      // flag is needed; host credentials and NODE_OPTIONS remain isolated.
      stdio: ['pipe', 'pipe', 'pipe'], env: { ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true
    })
    let stdout = ''; let stderr = ''; let settled = false
    const finish = (error?: Error, output?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (!child.killed) child.kill('SIGKILL')
      error ? reject(error) : resolve(output)
    }
    const append = (current: string, chunk: Buffer) => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > PROTOCOL_BYTES) finish(restrictedError('restricted_code_protocol_limit', 'Restricted code process exceeded the protocol limit'))
      return next
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.on('error', (error) => finish(restrictedError('restricted_code_spawn_failed', error.message)))
    child.on('close', () => {
      if (settled) return
      try {
        const response = JSON.parse(stdout) as RestrictedCodeResponse
        if (!response.ok) return finish(restrictedError(response.code ?? 'restricted_code_execution_failed', response.error))
        ensureJson(response.output, 'output'); finish(undefined, response.output)
      } catch (error) {
        finish(restrictedError('restricted_code_protocol_error', stderr || (error instanceof Error ? error.message : String(error))))
      }
    })
    const abort = () => finish(restrictedError('restricted_code_cancelled', 'Restricted code execution was cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => finish(restrictedError('restricted_code_timeout', `Restricted code timed out after ${timeoutMs}ms`)), timeoutMs)
    child.stdin.end(payload)
  })
}

function requestedPermissions(config: Record<string, unknown>): string[] {
  const permissions = config.permissions
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return []
  return Object.entries(permissions as Record<string, unknown>).filter(([, enabled]) => enabled === true).map(([name]) => name)
}
function ensureJson(value: unknown, label: string): void { try { const encoded = JSON.stringify(value); if (encoded === undefined) throw new Error(); JSON.parse(encoded) } catch { throw restrictedError('restricted_code_non_json', `Restricted code ${label} must be JSON serializable`) } }
function restrictedError(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
