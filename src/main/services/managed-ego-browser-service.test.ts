import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { diagnoseEgoBrowser } from './managed-ego-browser-service'
const clean:string[]=[]
afterEach(async()=>{while(clean.length)await rm(clean.pop()!,{recursive:true,force:true})})
it('discovers only the external CLI with exact executable hash/version, without a browser handshake',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-discovery-'));clean.push(root);const path=join(root,'ego-browser');await writeFile(path,'controlled fixture, never executable')
 expect(await diagnoseEgoBrowser({candidates:[path],run:async actual=>{expect(actual).toBe(await realpath(path));return 'ego-browser 0.6.3.14\nChromium 156.0.8078.96'}})).toMatchObject({state:'installed',version:'0.6.3.14',executablePath:await realpath(path),executableHash:expect.stringMatching(/^[a-f0-9]{64}$/)})
})
it('does not mistake the Skill guide version for the CLI protocol',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-version-'));clean.push(root);const path=join(root,'ego-browser');await writeFile(path,'fixture')
 expect(await diagnoseEgoBrowser({candidates:[path],run:async()=> 'ego-browser usage guide v2.2.1'})).toMatchObject({state:'unsupported'})
})
it('reports unavailable CLI honestly and never installs or accesses profiles',async()=>{expect(await diagnoseEgoBrowser({candidates:[]})).toEqual({state:'not_installed',revision:0})})
