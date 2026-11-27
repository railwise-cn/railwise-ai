import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024

export type RuntimePptMasterSidecarRequest = {
  operation:
    | 'ppt-master-list-presets'
    | 'ppt-master-render-preset'
    | 'ppt-master-export-pptx'
    | 'ppt-master-quality-check'
  workspaceRoot: string
  projectPath?: string
  outputPath?: string
  source?: 'output' | 'final'
  format?: 'ppt169' | 'ppt43'
  stage?: 'first-page' | 'final'
  presetName?: string
  frame?: [number, number, number, number]
  fill?: string
}

type RuntimePptMasterSidecarResponse = {
  ok: boolean
  exitCode?: number
  reportPath?: string
  report?: unknown
  stdout?: string
  message?: string
}

export function runtimePptMasterSidecarAvailable(): boolean {
  const executable = process.env.WORKWISE_PPT_MASTER_SIDECAR?.trim()
  if (!executable || !existsSync(executable)) return false
  try {
    return statSync(executable).isFile()
  } catch {
    return false
  }
}

export async function runRuntimePptMasterSidecar(
  request: RuntimePptMasterSidecarRequest,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<RuntimePptMasterSidecarResponse> {
  const executable = process.env.WORKWISE_PPT_MASTER_SIDECAR?.trim()
  if (!executable || !runtimePptMasterSidecarAvailable()) {
    throw new Error('The bundled PPT Master runtime is unavailable.')
  }
  let child: ChildProcess | undefined
  let timeout: NodeJS.Timeout | undefined
  let bytes = 0
  let errorBytes = 0
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const abort = (): void => {
    if (!child?.pid) return
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.once('error', () => child?.kill())
      return
    }
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    child = spawn(executable, [], {
      cwd: request.workspaceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TMPDIR: process.env.TMPDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME
      }
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes <= MAX_PROTOCOL_BYTES) stdout.push(chunk)
      else abort()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      errorBytes += chunk.byteLength
      if (errorBytes <= MAX_ERROR_BYTES) stderr.push(chunk)
    })
    child.stdin?.end(JSON.stringify(request))
    timeout = setTimeout(abort, options.timeoutMs ?? 5 * 60 * 1000)
    if (options.signal?.aborted) abort()
    const code = await new Promise<number | null>((resolve, reject) => {
      child?.once('error', reject)
      child?.once('exit', resolve)
    })
    if (options.signal?.aborted) throw new Error('operation_cancelled: PPT Master operation was cancelled')
    if (bytes > MAX_PROTOCOL_BYTES) throw new Error('resource_limit: PPT Master response exceeded 2 MiB')
    const text = Buffer.concat(stdout).toString('utf8').trim()
    let response: RuntimePptMasterSidecarResponse
    try {
      response = JSON.parse(text) as RuntimePptMasterSidecarResponse
    } catch {
      const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 500)
      throw new Error(`PPT Master runtime exited with ${code ?? 'unknown'}${detail ? `: ${detail}` : ''}`)
    }
    if (code !== 0 || !response.ok) {
      throw new Error(response.message || 'PPT Master operation failed.')
    }
    return response
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
