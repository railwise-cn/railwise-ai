import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { EgoBrowserCapabilityConfig } from '../../../kun/src/contracts/ego-browser'
const execute = promisify(execFile)
/** Discovery only: never installs, enumerates profiles, starts a browser or reads login data. */
export async function diagnoseEgoBrowser(deps: { candidates?: string[]; run?: (path: string) => Promise<string> } = {}): Promise<EgoBrowserCapabilityConfig> {
  for (const candidate of deps.candidates ?? [join(homedir(), '.local', 'bin', 'ego-browser')]) {
    try {
      const executablePath = await realpath(candidate), executableHash = createHash('sha256').update(await readFile(executablePath)).digest('hex')
      const output = await (deps.run ?? (async path => {
        const result = await execute(path, ['--version'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 8192 })
        // The fixed --version command may write its version banner to stderr.
        return [result.stdout, result.stderr].join('\n')
      }))(executablePath)
      const version = /\bego-browser\s*v?(\d+\.\d+\.\d+\.\d+)\b/.exec(output)?.[1]
      // This is the supported target CLI protocol, not the independently versioned guide.
      return EgoBrowserCapabilityConfig.parse({state: version === '0.6.3.14' ? 'installed' : 'unsupported',executablePath,executableHash,version,revision:0})
    } catch(error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return EgoBrowserCapabilityConfig.parse({state:'error',revision:0})
    }
  }
  return EgoBrowserCapabilityConfig.parse({state:'not_installed',revision:0})
}
