import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(process.argv[2] ?? '.')
const here = dirname(fileURLToPath(import.meta.url))
const files = ['kun/src/engineering/survey-standard-basis.ts','kun/src/contracts/survey-standard-basis.ts','kun/src/server/routes/survey-standard-basis.ts',
  'src/main/ipc/app-ipc-schemas.ts','src/renderer/src/agent/survey-standard-basis-client.ts','src/renderer/src/components/engineering/SurveyStandardBasis.tsx']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const record = {
  gitHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  productFileHashes:Object.fromEntries(files.map(path=>[path,digest(readFileSync(resolve(root,path)))])),
  contract:JSON.parse(execFileSync(process.execPath,[resolve(here,'probe.mjs'),root],{encoding:'utf8'})),
  dom:JSON.parse(execFileSync(process.execPath,[resolve(here,'dom-probe.mjs'),root],{encoding:'utf8'})),
  limitations:['An in-process real Router and schema replace network transport, not the production catalog/client/component.','No packaged Electron, browser PDF download, renderer pixel or real professional acceptance test.','Probe identities and samples are synthetic. No project database or user credentials were read.']
}
writeFileSync(resolve(here,'independent-result.json'),JSON.stringify(record,null,2)+'\n')
console.log(JSON.stringify(record,null,2))
