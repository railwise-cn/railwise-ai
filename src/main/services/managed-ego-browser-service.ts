import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { EgoBrowserCapabilityConfig } from '../../../kun/src/contracts/ego-browser'
const execute = promisify(execFile)

export function egoBrowserCandidatePaths(platform = process.platform, home = homedir(), path = process.env.PATH ?? process.env.Path ?? ''): string[] {
  if (platform !== 'win32') return [join(home, '.local', 'bin', 'ego-browser')]
  const installedCli = win32.join(home, '.local', 'share', 'ego', 'active_version_dir', 'ego-browser.exe')
  const paths = path.split(';').map(entry => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter(entry => /^[a-z]:[\\/]/i.test(entry))
    .map(entry => win32.join(entry, 'ego-browser.exe'))
  return [...new Map([installedCli, ...paths].map(entry => [entry.toLowerCase(), entry])).values()]
}

/** Discovery only: never installs, enumerates profiles, starts a browser or reads login data. */
export async function diagnoseEgoBrowser(deps: { candidates?: string[]; run?: (path: string) => Promise<string> } = {}): Promise<EgoBrowserCapabilityConfig> {
  let unsupported: EgoBrowserCapabilityConfig | undefined
  let probeFailed = false
  const checked = new Set<string>()
  for (const candidate of deps.candidates ?? egoBrowserCandidatePaths()) {
    try {
      const executablePath = await realpath(candidate)
      const identity = process.platform === 'win32' ? executablePath.toLowerCase() : executablePath
      if (checked.has(identity)) continue
      checked.add(identity)
      const executableHash = createHash('sha256').update(await readFile(executablePath)).digest('hex')
      const output = await (deps.run ?? (async path => {
        const result = await execute(path, ['--version'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 8192 })
        // The fixed --version command may write its version banner to stderr.
        return [result.stdout, result.stderr].join('\n')
      }))(executablePath)
      const version = /\bego-browser\s*v?(\d+\.\d+\.\d+\.\d+)\b/.exec(output)?.[1]
      // This is the supported target CLI protocol, not the independently versioned guide.
      if (version === '0.6.3.14') return { state: 'installed', executablePath, executableHash, version, revision: 0 }
      unsupported ??= { state: 'unsupported', executablePath, executableHash, version, revision: 0 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') probeFailed = true
    }
  }
  return unsupported ?? { state: probeFailed ? 'error' : 'not_installed', revision: 0 }
}
