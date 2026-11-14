import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

export class SafeSpawnError extends Error {
  constructor(
    message: string,
    readonly code: 'executable_unavailable' | 'cwd_unavailable' | 'spawn_denied' | 'spawn_failed',
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'SafeSpawnError'
  }
}

export async function safeSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions & { workspaceRoot?: string; beforeSpawn?: () => void } = {}
): Promise<ChildProcess> {
  const executable = await resolveExecutable(command, options.env)
  const cwd = await resolveSpawnCwd(options.cwd, options.workspaceRoot)
  const { beforeSpawn, ...spawnOptions }: SpawnOptions & { workspaceRoot?: string; beforeSpawn?: () => void } = { ...options, cwd }
  delete (spawnOptions as SpawnOptions & { workspaceRoot?: string }).workspaceRoot
  try {
    return await spawnOnce(executable, args, spawnOptions, beforeSpawn)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 75))
      try {
        return await spawnOnce(executable, args, spawnOptions, beforeSpawn)
      } catch (retryError) {
        throw new SafeSpawnError(`Permission denied while starting ${command}.`, 'spawn_denied', retryError)
      }
    }
    const code = (error as NodeJS.ErrnoException).code
    throw new SafeSpawnError(
      code === 'ENOENT' ? `Executable was not found: ${command}` : `Failed to start ${command}.`,
      code === 'ENOENT' ? 'executable_unavailable' : 'spawn_failed',
      error
    )
  }
}

async function spawnOnce(command: string, args: readonly string[], options: SpawnOptions, beforeSpawn?: () => void): Promise<ChildProcess> {
  beforeSpawn?.()
  const child = spawn(command, [...args], options)
  return new Promise((resolveChild, reject) => {
    const onSpawn = (): void => {
      child.removeListener('error', onError)
      resolveChild(child)
    }
    const onError = (error: Error): void => {
      child.removeListener('spawn', onSpawn)
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  const candidate = command.trim()
  if (!candidate) throw new SafeSpawnError('Executable is required.', 'executable_unavailable')
  if (isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) {
    const absolute = resolve(candidate)
    await assertExecutable(absolute)
    return absolute
  }
  const pathValue = env?.PATH ?? env?.Path ?? process.env.PATH ?? ''
  const extensions = process.platform === 'win32'
    ? ['', ...(env?.PATHEXT ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
    : ['']
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(directory, process.platform === 'win32' ? `${candidate}${extension}` : candidate)
      try {
        await assertExecutable(path)
        return path
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new SafeSpawnError(`Executable was not found: ${command}`, 'executable_unavailable')
}

async function assertExecutable(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('not a regular file')
  await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
}

async function resolveSpawnCwd(requested: SpawnOptions['cwd'], workspaceRoot?: string): Promise<string> {
  const candidates = [requested, workspaceRoot, homedir()]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    try {
      const canonical = await realpath(candidate)
      if ((await stat(canonical)).isDirectory()) return canonical
    } catch {
      // Never create an unusable cwd; use the next existing fallback.
    }
  }
  throw new SafeSpawnError('No usable working directory is available.', 'cwd_unavailable')
}
