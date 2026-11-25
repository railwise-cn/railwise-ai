import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { diagnoseEgoBrowser, egoBrowserCandidatePaths } from './managed-ego-browser-service'
const clean:string[]=[]
afterEach(async()=>{while(clean.length)await rm(clean.pop()!,{recursive:true,force:true})})
it('discovers only the external CLI with exact executable hash/version, without a browser handshake',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-discovery-'));clean.push(root);const path=join(root,'ego-browser');await writeFile(path,'controlled fixture, never executable')
 expect(await diagnoseEgoBrowser({candidates:[path],run:async actual=>{expect(actual).toBe(await realpath(path));return 'ego-browser 0.6.3.14\nChromium 156.0.8078.96'}})).toMatchObject({state:'installed',version:'0.6.3.14',executablePath:await realpath(path),executableHash:expect.stringMatching(/^[a-f0-9]{64}$/)})
})
it('accepts newer builds in the audited Ego CLI protocol series',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-newer-build-'));clean.push(root);const path=join(root,'ego-browser');await writeFile(path,'controlled fixture')
 expect(await diagnoseEgoBrowser({candidates:[path],run:async()=> 'ego-browser 0.6.3.17\nChromium 156.0.8078.96'})).toMatchObject({state:'installed',version:'0.6.3.17'})
})
it('does not mistake the Skill guide version for the CLI protocol',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-version-'));clean.push(root);const path=join(root,'ego-browser');await writeFile(path,'fixture')
 expect(await diagnoseEgoBrowser({candidates:[path],run:async()=> 'ego-browser usage guide v2.2.1'})).toMatchObject({state:'unsupported'})
})
it('reports unavailable CLI honestly and never installs or accesses profiles',async()=>{expect(await diagnoseEgoBrowser({candidates:[]})).toEqual({state:'not_installed',revision:0})})

it('discovers the Windows onboarding installation and executable on absolute local PATH entries', () => {
  const home = 'C:\\Users\\验收 User'
  const active = home + '\\.local\\share\\ego\\active_version_dir'
  expect(egoBrowserCandidatePaths('win32', home,
    `${active};"C:\\Program Files\\Citro Labs\\ego lite";.;..\\workspace;D:relative;\\\\network\\share`)).toEqual([
    active + '\\ego-browser.exe',
    'C:\\Program Files\\Citro Labs\\ego lite\\ego-browser.exe'
  ])
})

it('continues to the working executable when an earlier Windows install path is stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ego-windows-path-')); clean.push(root)
  const stale = join(root, 'old-ego-browser.exe')
  const active = join(root, 'ego-browser.exe')
  await writeFile(stale, 'old version')
  await writeFile(active, 'active version')
  const actualActive = await realpath(active)
  expect(await diagnoseEgoBrowser({
    candidates: [join(root, 'missing.exe'), stale, active],
    run: async path => 'ego-browser ' + (path === actualActive ? '0.6.3.14' : '0.6.2.10')
  })).toEqual({
    state: 'installed', version: '0.6.3.14', executablePath: actualActive,
    executableHash: createHash('sha256').update('active version').digest('hex'), revision: 0
  })
})

// Real subprocess regression for the macOS/POSIX CLI channel contract. No Ego
// executable, browser, website, profile or injected runner is used here.
it.skipIf(process.platform === 'win32')('recognizes the pinned CLI version emitted only on stderr by a real executable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-real-version-stderr-'));clean.push(root)
 const path=join(root,'ego-browser'),script=`#!${process.execPath}\nif(process.argv.length!==3||process.argv[2]!=="--version")process.exit(64);process.stderr.write("ego-browser 0.6.3.14\\nchromium156.0.8078.96\\nnodev24.22.1\\n");\n`
 await writeFile(path,script,{mode:0o700})
 expect(await diagnoseEgoBrowser({candidates:[path]})).toMatchObject({state:'installed',version:'0.6.3.14',executablePath:await realpath(path),executableHash:createHash('sha256').update(script).digest('hex')})
})
it.skipIf(process.platform === 'win32')('does not treat unknown real version output from either channel as installed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-real-version-unknown-'));clean.push(root);const path=join(root,'ego-browser')
 await writeFile(path,`#!${process.execPath}\nif(process.argv[2]!=="--version")process.exit(64);process.stdout.write("ego-browser usage guide v2.2.1\\n");process.stderr.write("unknown build\\n");\n`,{mode:0o700})
 expect(await diagnoseEgoBrowser({candidates:[path]})).toMatchObject({state:'unsupported'})
})
it.skipIf(process.platform === 'win32')('requires a successful real version process even if stderr contains the pinned version',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ego-real-version-failure-'));clean.push(root);const path=join(root,'ego-browser')
 await writeFile(path,`#!${process.execPath}\nif(process.argv[2]!=="--version")process.exit(64);process.stderr.write("ego-browser 0.6.3.14\\n");process.exit(7);\n`,{mode:0o700})
 expect(await diagnoseEgoBrowser({candidates:[path]})).toEqual({state:'error',revision:0})
})
