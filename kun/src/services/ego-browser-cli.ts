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
    let stdout='', bytes=0, settled=false
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish(new Error('ego_browser_command_timeout'))},35000)
    const finish=(error?:Error,value?:Record<string,unknown>)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value!)}
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>4*1024*1024){child.kill('SIGTERM');finish(new Error('ego_browser_output_limit'));return}stdout+=chunk.toString('utf8')})
    child.stderr.resume() // Never persist CLI stderr, cookies, credentials or page console data.
    child.once('error',()=>finish(new Error(signal?.aborted?'ego_browser_aborted':'ego_browser_command_failed')))
    child.once('close',code=>{
      if(code!==0)return finish(new Error('ego_browser_command_failed'))
      try {
        const lines=stdout.split(/\r?\n/).filter(line=>line.startsWith(EGO_RESULT_MARKER))
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
