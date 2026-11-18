import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path'

/**
 * GUI-launched Electron processes do not inherit the user's interactive shell
 * profile. Keep marketplace downloads usable when npm/git live in Homebrew,
 * Volta, NVM, or another common user-managed tool directory.
 */
export function resolveMarketplaceCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const trimmed = command.trim()
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\')) return trimmed

  const pathEntries = marketplacePathEntries(env, home, platform)
  const suffixes = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')]
    : ['']
  const candidates = [...new Set(pathEntries)].flatMap((directory) =>
    suffixes.map((suffix) => join(directory, `${trimmed}${suffix}`))
  )
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK)
      return true
    } catch {
      return false
    }
  }) ?? trimmed
}

function isRegularFile(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

export function resolveMarketplaceNpmCommand(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform
): { executable: string; args: string[] } {
  const npm = resolveMarketplaceCommand('npm', env, home, platform)
  if (platform !== 'win32' || (extname(npm).toLowerCase() === '.exe' && isRegularFile(npm))) {
    return { executable: npm, args: [] }
  }

  // Node cannot execFile a Windows batch wrapper. Use the real npm entry
  // point and keep the registry arguments out of any command interpreter.
  const detectedNode = resolveMarketplaceCommand('node.exe', env, home, platform)
  const directories = [npm, detectedNode].filter(isAbsolute).map(dirname)
  for (const directory of new Set(directories)) {
    const cli = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    const executable = [join(directory, 'node.exe'), detectedNode]
      .find((candidate) => extname(candidate).toLowerCase() === '.exe' && isRegularFile(candidate))
    if (executable && isRegularFile(cli)) return { executable, args: [cli] }
  }
  throw new Error('Windows Node.js with npm was not found.')
}

export function marketplaceCommandEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  const path = marketplacePathEntries(env, home, platform).join(pathDelimiter)
  return {
    ...env,
    PATH: path,
    ...(platform === 'win32' && env.Path !== undefined ? { Path: path } : {})
  }
}

function marketplacePathEntries(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform
): string[] {
  const pathDelimiter = platform === 'win32' ? ';' : delimiter
  return [
    env.PATH ?? env.Path ?? '',
    ...(platform === 'win32' ? [
      env.NVM_SYMLINK ?? '',
      env.FNM_MULTISHELL_PATH ?? '',
      env.ProgramFiles ? join(env.ProgramFiles, 'nodejs') : '',
      env.APPDATA ? join(env.APPDATA, 'npm') : '',
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Volta', 'bin') : ''
    ] : []),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    join(home, '.local', 'bin'),
    join(home, '.local', 'node', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.bun', 'bin'),
    join(home, '.nvm', 'current', 'bin')
  ]
    .flatMap((value) => value.split(pathDelimiter))
    .map((value) => value.trim())
    .filter(Boolean)
}
