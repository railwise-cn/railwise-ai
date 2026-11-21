import test from 'node:test'
import assert from 'node:assert/strict'
import publication from './release-publication.cjs'
import { MAC_UPDATER_QA_REF, QA_MAC_BASELINES, readQaMacReuseInput, verifyQaMacArchiveEntries, verifyQaMacArtifact } from './qa-reused-mac-updater.mjs'
import { PUBLIC_IDENTITY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { resolveUpdaterBaseline } from './frozen-release-version.mjs'
import { requireFrozenRunner, validatePublicBundle } from './run-frozen-release-updater-acceptance.mjs'

const repo = 'railwise-cn/railwise-ai'
const driver = 'd'.repeat(40)
const target = 'a'.repeat(40)
const workflowRef = repo + '/.github/workflows/windows-install-smoke.yml@' + MAC_UPDATER_QA_REF
const context = { GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'exact-mac-native-updater',
  GITHUB_REF: MAC_UPDATER_QA_REF, GITHUB_WORKFLOW_REF: workflowRef, GITHUB_SHA: driver, GITHUB_WORKFLOW_SHA: driver }
const plan = '0.5.9:' + target
const runId = '21'
const input = readQaMacReuseInput({ plan, runId, env: context })

function fixture({ source = {}, artifact = {}, changed = 'scripts/qa-reused-mac-updater.mjs', publish = 'skipped',
  privateStable = false, macSmoke = 'failure', windowsSmoke = 'success', signed = true, extraJobs = [] } = {}) {
  const completed = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion })
  const macBuild = { ...completed('Build macOS'), steps: [
    completed('Build signed macOS packages', signed ? 'success' : 'skipped'), completed('Verify final signed macOS artifacts'), completed('Upload macOS installers')
  ] }
  const api = suffix => {
    const path = suffix.replace('repos/' + repo, '')
    if (path === '') return { id: 301, full_name: repo }
    if (path === '/actions/workflows/release.yml') return { id: 302, path: RELEASE_WORKFLOW }
    if (path === '/actions/runs/21') return { id: 21, workflow_id: 302, path: RELEASE_WORKFLOW,
      repository: { id: 301 }, head_repository: { id: 301 }, head_sha: target,
      event: 'workflow_dispatch', status: 'completed', run_attempt: 1, conclusion: privateStable ? macSmoke : 'success', ...source }
    if (path === '/actions/runs/21/attempts/1/jobs?per_page=100') return { jobs: [
      macBuild, completed('Verify three-client candidate', privateStable ? 'skipped' : 'success'), completed('Publish GitHub Release', publish),
      ...(privateStable ? [completed('Prepare release version'), completed('Build Windows'),
        completed('Private exact-package Windows install smoke', windowsSmoke), completed('Private exact-package updater smoke', macSmoke)] : []),
      ...extraJobs
    ] }
    if (path === '/actions/runs/21/artifacts?per_page=100') return { artifacts: [{
      name:'release-mac', id: 83, digest:'sha256:'+'a'.repeat(64), expired:false,
      workflow_run:{id:21,repository_id:301,head_repository_id:301,head_sha:target}, ...artifact
    }] }
    throw new Error('Unexpected API call.')
  }
  const run = (file,args) => {
    assert.equal(file,'git')
    if(args[0]==='rev-parse') return {stdout:driver+'\n'}
    if(args[0]==='merge-base') return {stdout:''}
    if(args[0]==='diff') return {stdout:changed+'\n'}
    throw new Error('Unexpected Git call.')
  }
  return [input,run,api]
}

test('reuses only an explicitly SHA-bound artifact from the authorized QA branch', () => {
  assert.deepEqual(input,{baseline:'0.5.9',targetHead:target,runId:21,driverHead:driver})
  assert.throws(() => readQaMacReuseInput({plan,runId,env:{...context,GITHUB_REF:'refs/heads/main'}}), /authorized Mac QA/)
  assert.throws(() => readQaMacReuseInput({plan:'0.5.8:'+target,runId,env:context}), /exact target SHA/)
  assert.throws(() => readQaMacReuseInput({plan,runId,env:{...context,GITHUB_REPOSITORY:'someone/fork'}}), /authorized Mac QA/)
  assert.throws(() => requireFrozenRunner(context,'darwin','/Users/runner'), /trusted fresh/)
  assert.equal(verifyQaMacArtifact(...fixture()).artifact.id,83)
})

test('rejects mismatched source, artifact digest, release or driver provenance', () => {
  assert.throws(() => verifyQaMacArtifact(...fixture({source:{head_sha:driver}})), /exact target source/)
  assert.throws(() => verifyQaMacArtifact(...fixture({source:{head_repository:{id:44}}})), /trusted repository/)
  assert.throws(() => verifyQaMacArtifact(...fixture({artifact:{digest:'unknown'}})), /immutable/)
  assert.throws(() => verifyQaMacArtifact(...fixture({artifact:{workflow_run:{id:99,head_sha:target}}})), /immutable/)
  assert.throws(() => verifyQaMacArtifact(...fixture({publish:'success'})), /skipped publication/)
  assert.throws(() => verifyQaMacArtifact(...fixture({signed:false})), /verified signed macOS build/)
  assert.throws(() => verifyQaMacArtifact(...fixture({changed:'src/main/index.ts'})), /limited to the QA/)
})

test('reuses a verified private Stable build when only the Mac updater smoke failed', () => {
  assert.equal(verifyQaMacArtifact(...fixture({privateStable:true})).packageMode,'private-stable')
  assert.equal(verifyQaMacArtifact(...fixture({privateStable:true,macSmoke:'success'})).packageMode,'private-stable')
  assert.throws(() => verifyQaMacArtifact(...fixture({privateStable:true,windowsSmoke:'failure'})), /Windows install smoke/)
  assert.throws(() => verifyQaMacArtifact(...fixture({privateStable:true,macSmoke:'skipped'})), /Windows install smoke/)
  assert.throws(() => verifyQaMacArtifact(...fixture({privateStable:true,extraJobs:[{name:'Unexpected failure',conclusion:'failure'}]})), /Windows install smoke/)
  assert.throws(() => verifyQaMacArtifact(...fixture({privateStable:true,extraJobs:[{name:'Unexpected cancellation',conclusion:'cancelled'}]})), /Windows install smoke/)
})

test('accepts only the 0.5.7 and 0.5.9 historical Apple installer pins for this QA suite', () => {
  for (const version of ['0.5.7','0.5.9']) {
    const { pins } = resolveUpdaterBaseline(version,QA_MAC_BASELINES)
    assert.ok(pins.arm64.assetId > 0 && pins.x64.assetId > 0)
  }
  assert.throws(() => resolveUpdaterBaseline('0.5.9'), /no valid .* installer pin/)
})

test('archives select an explicit QA frontier or stable package mode; mixed metadata fails', () => {
  const version = '0.5.10'
  const names = publication.expectedReleaseFiles(version).filter(file => file.artifact === 'release-mac').map(file => file.name)
  assert.equal(verifyQaMacArchiveEntries(names,version,'candidate'),'qa-frontier')
  assert.equal(verifyQaMacArchiveEntries([...names,'reviewed-build.json'],version,'candidate'),'stable')
  assert.equal(verifyQaMacArchiveEntries(names,version,'private-stable'),'stable')
  assert.throws(() => verifyQaMacArchiveEntries(names,version), /admitted Mac package mode/)
  assert.throws(() => verifyQaMacArchiveEntries([...names,'reviewed-build.json'],version,'private-stable'), /candidate build receipt/)
  assert.throws(() => verifyQaMacArchiveEntries([...names,'../extra.zip'],version,'candidate'), /unexpected package entry set/)
  assert.throws(() => verifyQaMacArchiveEntries([...names.slice(1),names[1]],version,'private-stable'), /unexpected package entry set/)

  const info = { CFBundleIdentifier:PUBLIC_IDENTITY.bundleId, CFBundleExecutable:PUBLIC_IDENTITY.productName, CFBundleShortVersionString:version }
  const metadata = { name:PUBLIC_IDENTITY.packageName, productName:PUBLIC_IDENTITY.productName, version,
    buildProvenance:{sourceHead:target}, buildHints:{macSigningEnabled:true,notarizationEnabled:true}, updateChannel:'frontier' }
  const updater = { provider:'generic', url:'https://127.0.0.1/', updaterCacheDirName:'workwise-updater' }
  assert.throws(() => validatePublicBundle(info,metadata,updater,version,target), /Public updater URL/)
  assert.doesNotThrow(() => validatePublicBundle(info,metadata,updater,version,target,'qa-frontier'))
  assert.throws(() => validatePublicBundle(info,metadata,updater,version,undefined,'qa-frontier'), /exact source HEAD/)
  assert.throws(() => validatePublicBundle(info,{...metadata,updateChannel:'stable'},updater,version,target,'qa-frontier'), /Packaged update channel/)
  const stableUpdater = {...updater,url:publication.updateUrl({releasePrefix:'workwise'})}
  assert.throws(() => validatePublicBundle(info,metadata,stableUpdater,version,target,'stable'), /Packaged update channel/)
  assert.doesNotThrow(() => validatePublicBundle(info,{...metadata,updateChannel:'stable'},stableUpdater,version,target,'stable'))
})
