import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { EgoBrowserCapabilityConfig } from '../contracts/ego-browser.js'
export const EGO_RESULT_MARKER = 'RAILWISE_EGO_RESULT:'
export type EgoBrowserCommandRunner = (config: EgoBrowserCapabilityConfig, script: string, signal?: AbortSignal) => Promise<Record<string, unknown>>
export const runEgoBrowserScript: EgoBrowserCommandRunner = async (config, script, signal) => {
  if (!config.executablePath || !isAbsolute(config.executablePath) || !config.executableHash || config.state !== 'installed') throw new Error('ego_browser_unavailable')
  if (createHash('sha256').update(await readFile(config.executablePath)).digest('hex') !== config.executableHash) throw new Error('ego_browser_executable_changed')
  return new Promise((resolve, reject) => {
    // stdin keeps large read-only context proof out of OS argv limits and process listings.
    const child = spawn(config.executablePath!, ['nodejs'], { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'], signal })
    let stdout='', stderr='', bytes=0, settled=false
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('ego_browser_command_timeout'))},35000)
    const finish=(error?:Error,value?:Record<string,unknown>)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value!)}
    // Node's stream decoder retains partial UTF-8 characters between chunks.
    // Only the fixed marker is consumed; other diagnostics are never persisted.
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    const consume = (channel: 'stdout' | 'stderr') => (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > 4 * 1024 * 1024) { child.kill('SIGTERM'); finish(new Error('ego_browser_output_limit')); return }
      if (channel === 'stdout') stdout += chunk
      else stderr += chunk
    }
    child.stdout.on('data', consume('stdout'))
    child.stderr.on('data', consume('stderr'))
    child.once('error',()=>finish(new Error(signal?.aborted?'ego_browser_aborted':'ego_browser_command_failed')))
    child.once('close',code=>{
      if(code!==0)return finish(new Error('ego_browser_command_failed'))
      try {
        const lines=[stdout,stderr].flatMap(channel=>channel.split(/\r?\n/).filter(line=>line.startsWith(EGO_RESULT_MARKER)))
        if(lines.length!==1)throw new Error()
        const value:unknown=JSON.parse(lines[0]!.slice(EGO_RESULT_MARKER.length))
        if(!value||typeof value!=='object'||Array.isArray(value))throw new Error()
        finish(undefined,value as Record<string,unknown>)
      }catch{finish(new Error('ego_browser_protocol_invalid'))}
    })
    child.stdin.on('error',()=>finish(new Error('ego_browser_command_failed')))
    child.stdin.end(script)
  })
}
