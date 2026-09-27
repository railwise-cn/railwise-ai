import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join } from 'node:path'
import {
  SurveyConverterManifestV1,
  SurveyConverterProvenanceV1,
  type SurveyConverterManifestV1 as SurveyConverterManifest,
  type SurveyConverterProvenanceV1 as SurveyConverterProvenance,
  type SurveyFormatIdV1,
  type SurveyImportDiagnosticV1
} from '../contracts/survey.js'

const MAX_PROTOCOL_BYTES = 1024 * 1024

export type SandboxedSurveyConverterRequest = {
  executablePath: string
  arguments: string[]
  workingDirectory: string
  outputPath: string
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}

export type SandboxedSurveyConverterResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface SandboxedSurveyConverterExecutor {
  readonly networkIsolation: 'verified-none'
  execute(request: SandboxedSurveyConverterRequest): Promise<SandboxedSurveyConverterResult>
}

export type SurveyConversionResult = {
  ok: boolean
  outputName?: string
  outputBytes?: Buffer
  outputFormat?: SurveyFormatIdV1
  provenance: SurveyConverterProvenance
  diagnostic: SurveyImportDiagnosticV1
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function diagnostic(message: string, severity: 'info' | 'blocking'): SurveyImportDiagnosticV1 {
  return { code: severity === 'info' ? 'format_detected' : 'converter_required', severity, message }
}

async function readConverterOutput(outputPath: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const file = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error('survey converter output must be a regular file')
    if (info.size > limit) throw new Error(`survey converter output exceeds ${limit} bytes`)
    const chunks: Buffer[] = []
    let length = 0
    for (;;) {
      if (signal?.aborted) throw new Error('survey converter cancelled')
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - length + 1))
      const { bytesRead } = await file.read(chunk)
      if (!bytesRead) break
      length += bytesRead
      if (length > limit) throw new Error(`survey converter output exceeds ${limit} bytes`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, length)
  } finally {
    await file.close()
  }
}

/**
 * macOS converter execution uses the system sandbox to deny every network
 * operation. The converter is still locally supplied or distribution-audited
 * and hash-pinned before this executor is called. No shell is involved.
 */
export class MacOsSandboxedSurveyConverterExecutor implements SandboxedSurveyConverterExecutor {
  readonly networkIsolation = 'verified-none' as const

  async execute(request: SandboxedSurveyConverterRequest): Promise<SandboxedSurveyConverterResult> {
    if (request.signal?.aborted) throw new Error('survey converter cancelled')
    if (process.platform !== 'darwin') throw new Error('verified no-network survey converter execution is unavailable on this platform')
    await access('/usr/bin/sandbox-exec', constants.X_OK)
    if (request.signal?.aborted) throw new Error('survey converter cancelled')
    const profile = '(version 1) (allow default) (deny network*)'
    return await new Promise<SandboxedSurveyConverterResult>((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, request.executablePath, ...request.arguments], {
        cwd: request.workingDirectory,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let failure: Error | undefined
      let settled = false
      let timer: NodeJS.Timeout
      let outputMonitor: NodeJS.Timeout
      const killGroup = (): void => {
        if (!child.pid) return
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error
        }
      }
      const stop = (error: Error): void => {
        if (settled || failure) return
        failure = error
        killGroup()
      }
      const abort = (): void => stop(new Error('survey converter cancelled'))
      const finish = async (exitCode: number | null): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearInterval(outputMonitor)
        request.signal?.removeEventListener('abort', abort)
        if (!failure && exitCode === 0) {
          try {
            const info = await lstat(request.outputPath)
            if (!info.isFile()) throw new Error('survey converter output must be a regular file')
            if (info.size > request.maxOutputBytes) throw new Error(`survey converter output exceeds ${request.maxOutputBytes} bytes`)
          } catch (error) { failure = error as Error }
        }
        failure ? reject(failure) : resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      }
      child.stdout.on('data', (chunk: Buffer) => {
        if (failure) return
        stdoutBytes += chunk.length
        if (stdoutBytes > MAX_PROTOCOL_BYTES) stop(new Error(`survey converter stdout exceeds ${MAX_PROTOCOL_BYTES} bytes`))
        else stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (failure) return
        stderrBytes += chunk.length
        if (stderrBytes > MAX_PROTOCOL_BYTES) stop(new Error(`survey converter stderr exceeds ${MAX_PROTOCOL_BYTES} bytes`))
        else stderr.push(chunk)
      })
      child.once('error', stop)
      // Terminate background group members on parent exit and wait for inherited
      // pipes to close before registry cleanup.
      child.once('exit', killGroup)
      child.once('close', (exitCode) => { void finish(exitCode) })
      request.signal?.addEventListener('abort', abort, { once: true })
      if (request.signal?.aborted) abort()
      timer = setTimeout(() => stop(new Error(`survey converter timed out after ${request.timeoutMs}ms`)), request.timeoutMs)
      outputMonitor = setInterval(() => {
        void lstat(request.outputPath).then((info) => {
          if (!info.isFile()) stop(new Error('survey converter output must be a regular file'))
          else if (info.size > request.maxOutputBytes) stop(new Error(`survey converter output exceeds ${request.maxOutputBytes} bytes`))
        }).catch(() => undefined)
      }, 50)
    })
  }
}

export class SurveyConverterRegistry {
  private readonly adapters = new Map<SurveyFormatIdV1, SurveyConverterManifest>()

  constructor(
    manifests: readonly SurveyConverterManifest[] = [],
    private readonly executor?: SandboxedSurveyConverterExecutor
  ) {
    for (const value of manifests) {
      const manifest = SurveyConverterManifestV1.parse(value)
      for (const format of manifest.inputFormats) {
        if (this.adapters.has(format)) throw new Error(`duplicate survey converter for ${format}`)
        this.adapters.set(format, manifest)
      }
    }
  }

  has(format: SurveyFormatIdV1): boolean {
    return this.adapters.has(format)
  }

  async convert(format: SurveyFormatIdV1, sourceName: string, bytes: Buffer, signal?: AbortSignal): Promise<SurveyConversionResult | null> {
    const manifest = this.adapters.get(format)
    if (!manifest) return null
    const inputHash = sha256(bytes)
    let actualExecutableHash = manifest.executableHash
    let outputHash: string | undefined
    const provenance = (status: SurveyConverterProvenance['status'], outputHashValue?: string): SurveyConverterProvenance => SurveyConverterProvenanceV1.parse({
      id: manifest.id,
      version: manifest.version,
      origin: manifest.origin,
      ...(manifest.origin === 'workwise-bundled' ? { license: manifest.license } : {}),
      executableHash: actualExecutableHash,
      inputHash,
      ...(outputHashValue ? { outputHash: outputHashValue } : {}),
      networkAccess: 'none',
      arguments: manifest.arguments,
      status
    })
    const blocked = (message: string): SurveyConversionResult => ({
      ok: false,
      provenance: provenance('blocked', outputHash),
      diagnostic: diagnostic(message, 'blocking')
    })
    if (!this.executor || this.executor.networkIsolation !== 'verified-none') return blocked(`转换器 ${manifest.id} 未连接可验证的无网络执行器`)
    if (signal?.aborted) return blocked(`转换器 ${manifest.id} 已取消`)
    if (!isAbsolute(manifest.executablePath)) return blocked(`转换器 ${manifest.id} 的可执行文件路径不是绝对路径`)
    try {
      await access(manifest.executablePath, constants.X_OK)
      const executableBytes = await readFile(manifest.executablePath)
      actualExecutableHash = sha256(executableBytes)
      if (actualExecutableHash !== manifest.executableHash) return blocked(`转换器 ${manifest.id} 可执行文件哈希不匹配`)
    } catch (error) {
      return blocked(`转换器 ${manifest.id} 不可执行：${error instanceof Error ? error.message : String(error)}`)
    }
    const directory = await mkdtemp(join(tmpdir(), 'workwise-survey-converter-'))
    try {
      const sourceExtension = extname(sourceName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 13)
      const inputPath = join(directory, `source${sourceExtension || '.bin'}`)
      const outputPath = join(directory, `converted${manifest.outputExtension}`)
      await writeFile(inputPath, bytes, { flag: 'wx', mode: 0o600 })
      const args = manifest.arguments.map((value) => value.replaceAll('{input}', inputPath).replaceAll('{output}', outputPath))
      const result = await this.executor.execute({ executablePath: manifest.executablePath, arguments: args, workingDirectory: directory, outputPath, timeoutMs: manifest.timeoutMs, maxOutputBytes: manifest.maxOutputBytes, ...(signal ? { signal } : {}) })
      if (signal?.aborted) return blocked(`转换器 ${manifest.id} 已取消`)
      if (result.exitCode !== 0) return blocked(`转换器 ${manifest.id} 退出码 ${String(result.exitCode)}：${result.stderr.trim().slice(0, 500) || '无诊断输出'}`)
      const outputBytes = await readConverterOutput(outputPath, manifest.maxOutputBytes, signal)
      if (signal?.aborted) return blocked(`转换器 ${manifest.id} 已取消`)
      if (!outputBytes.length) return blocked(`转换器 ${manifest.id} 未生成输出`)
      if (outputBytes.length > manifest.maxOutputBytes) return blocked(`转换器 ${manifest.id} 输出超过 ${manifest.maxOutputBytes} 字节`)
      outputHash = sha256(outputBytes)
      return {
        ok: true,
        outputName: `${basename(sourceName, extname(sourceName))}${manifest.outputExtension}`,
        outputBytes,
        outputFormat: manifest.outputFormat,
        provenance: provenance('passed', outputHash),
        diagnostic: diagnostic(`转换器 ${manifest.id}/${manifest.version} 已在无网络沙箱中完成，输出 SHA-256 ${outputHash}`, 'info')
      }
    } catch (error) {
      return blocked(`转换器 ${manifest.id} 执行失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

/** No converter is bundled until its license and binary hash pass review. */
export const BUNDLED_SURVEY_CONVERTERS: readonly SurveyConverterManifest[] = []
