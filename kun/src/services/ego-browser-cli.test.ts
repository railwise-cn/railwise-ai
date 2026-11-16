import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EGO_RESULT_MARKER, runEgoBrowserScript } from './ego-browser-cli.js'
import type { EgoBrowserCapabilityConfig } from '../contracts/ego-browser.js'
const roots:string[]=[]
afterEach(async()=>{while(roots.length)await rm(roots.pop()!,{recursive:true,force:true})})
// Real POSIX executable, using this test's pinned Node runtime. The fixture
// consumes a constant input without evaluating it and never starts Ego/browser.
async function fixture(program:string):Promise<EgoBrowserCapabilityConfig>{
 const root=await mkdtemp(join(tmpdir(),'ego-runner-stdio-'));roots.push(root);const path=join(root,'ego-browser')
 const script=`#!${process.execPath}\nif(process.argv.length!==3||process.argv[2]!=="nodejs")process.exit(64);let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",s=>input+=s);process.stdin.on("end",()=>{if(input!=="CONTROLLED_READONLY_INPUT")process.exit(65);${program}});\n`
 await writeFile(path,script,{mode:0o700})
 return {state:'installed',version:'0.6.3.14',executablePath:await realpath(path),executableHash:createHash('sha256').update(script).digest('hex'),revision:0}
}
describe.skipIf(process.platform==='win32')('real Node executable SDK output-channel regression; no Ego/TaskSpace/website',()=>{
 it('accepts one fixed marker on stderr and does not return unrelated diagnostics',async()=>{
  const expected={ok:true,title:'受控测绘项目'},line=EGO_RESULT_MARKER+JSON.stringify(expected)+'\n'
  const config=await fixture(`process.stderr.write("unrelated diagnostic must not escape\\n");process.stderr.write(${JSON.stringify(line)});`)
  expect(await runEgoBrowserScript(config,'CONTROLLED_READONLY_INPUT')).toEqual(expected)
 })
 it('rejects duplicate markers across stdout and stderr',async()=>{
  const line=EGO_RESULT_MARKER+JSON.stringify({ok:true})+'\n',config=await fixture(`process.stdout.write(${JSON.stringify(line)});process.stderr.write(${JSON.stringify(line)});`)
  await expect(runEgoBrowserScript(config,'CONTROLLED_READONLY_INPUT')).rejects.toThrow('ego_browser_protocol_invalid')
 })
 it('preserves Chinese UTF-8 when the real subprocess splits a multibyte character across writes',async()=>{
  const expected={ok:true,title:'中文测绘与监测'},line=EGO_RESULT_MARKER+JSON.stringify(expected)+'\n'
  const config=await fixture(`const bytes=Buffer.from(${JSON.stringify(line)},"utf8"),split=bytes.indexOf(Buffer.from("中","utf8"))+1;process.stdout.write(bytes.subarray(0,split),()=>setTimeout(()=>process.stdout.write(bytes.subarray(split)),50));`)
  expect(await runEgoBrowserScript(config,'CONTROLLED_READONLY_INPUT')).toEqual(expected)
 })
 it('bounds the combined bytes of both subprocess channels',async()=>{
  const config=await fixture('process.stdout.write("x".repeat(2*1024*1024+32));process.stderr.write("y".repeat(2*1024*1024+32));')
  await expect(runEgoBrowserScript(config,'CONTROLLED_READONLY_INPUT')).rejects.toThrow('ego_browser_output_limit')
 })
})
