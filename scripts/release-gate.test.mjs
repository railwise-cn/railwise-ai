import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { verifyReleaseApproval } from './verify-release-approval.mjs'
import { expectedReleaseFiles, PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256, UPDATER_WORKFLOW, UPDATER_WORKFLOW_REF } from './verify-frozen-updater-evidence.mjs'
// Keep the existing npm run test:release-gate entry point covering byte/provenance gates.
import './verify-reviewed-release-artifacts.test.mjs'
import './verify-frozen-updater-evidence.test.mjs'
import './release-promotion-recovery.test.mjs'

const workflowPath = new URL('../.github/workflows/release.yml', import.meta.url)
const workflowSource = readFileSync(workflowPath, 'utf8')
const workflow = parse(workflowSource)
const triggers = workflow.on ?? workflow['on']
const jobs = workflow.jobs ?? {}
const websiteWorkflowSource = readFileSync(new URL('../.github/workflows/deploy-workwise-product-page.yml', import.meta.url), 'utf8')
const websiteWorkflow = parse(websiteWorkflowSource)
const verifierPath = fileURLToPath(new URL('./verify-release-approval.mjs', import.meta.url))

function releaseFixture(t, packageVersion = '0.5.3') {
  const root = mkdtempSync(join(tmpdir(), 'railwise-release-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  const commit = message => {
    git('add', '-A')
    git('commit', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release gate test')
  git('config', 'user.email', 'release-test@example.invalid')
  put('package.json', JSON.stringify({ version: packageVersion }))
  put('src/runtime.js', 'export const value = 1\n')
  const reviewedSourceHead = commit('freeze reviewed source')
  const base = 'docs/qa/release-gates/v0.5.3'
  const manifestPath = `${base}.json`
  const manifest = {
    schemaVersion: 1,
    scope: 'public-release',
    status: 'passed',
    release: { tag: 'v0.5.3', version: '0.5.3', sourceHead: reviewedSourceHead },
    package: {
      version: '0.5.3',
      identity: { bundleId: PUBLIC_IDENTITY.bundleId, artifactSha256: 'a'.repeat(64), asarSha256: 'e'.repeat(64) },
      reviewedBuild: {
        repository: RELEASE_REPOSITORY, workflowPath: RELEASE_WORKFLOW, sourceHead: reviewedSourceHead,
        runId: 1234, runAttempt: 1, publicIdentity: { ...PUBLIC_IDENTITY },
        artifacts: [{ name: 'release-mac', id: 11, digest: `sha256:${'b'.repeat(64)}` }, { name: 'release-win', id: 12, digest: `sha256:${'c'.repeat(64)}` }],
        files: expectedReleaseFiles('0.5.3').map(file => ({ ...file, sha256: 'a'.repeat(64), size: 100 })),
      },
      signature: { status: 'passed' },
      notarization: { status: 'passed' },
      screenshots: [`${base}/overview.png`],
    },
    acceptance: {
      functionalChecklist: { status: 'passed', path: `${base}/functional-checklist.md` },
      uiComputerUse: { status: 'passed', path: `${base}/cua-review.md` },
      updaterRoundTrip: { status: 'passed', path: `${base}/updater-round-trip.md`, machineReportPath: `${base}/frozen-updater.json`, nativeReportPath: `${base}/native-updater.json`,
        workflowRun: { repository: RELEASE_REPOSITORY, workflowPath: UPDATER_WORKFLOW, sourceHead: reviewedSourceHead, runId: 4321, runAttempt: 1,
          artifact: { id: 21, name: 'frozen-updater-arm64-4321', digest: `sha256:${'d'.repeat(64)}` } } },
      independentSeniorEngineerReview: { status: 'passed', reviewerType: 'AI review', reviewRole: 'senior engineer', path: `${base}/independent-ai-review.md` },
    },
  }
  // These synthetic unit reports mirror the existing runner schema. They are
  // temporary fixtures only and must never be copied into release evidence.
  const identity = version => ({ version, bundleId: PUBLIC_IDENTITY.bundleId, signature: 'verified', stapledNotarization: 'verified', gatekeeper: 'accepted', designatedRequirement: 'designated => synthetic-unit-fixture' })
  const serviceIdentity = seed => ({ schemaVersion: 1, packageVersion: seed ? '0.5.2' : '0.5.3', packageSourceHead: seed ? null : reviewedSourceHead,
    serviceSourceHead: reviewedSourceHead, asarSha256: (seed ? 'f' : 'e').repeat(64), layout: seed ? 'source-compatibility' : 'asar-unpacked',
    serviceTreeSha256: 'a'.repeat(64),
    modules: ['engineering-service', 'survey-service'].map(name => ({ path: `dist/engineering/${name}.js`, sha256: 'b'.repeat(64) })),
    dependencies: ['better-sqlite3', 'better-sqlite3-native', 'jszip', 'pdfkit', 'zod'].map(name => ({ name,
      path: `${seed ? 'node_modules' : 'app.asar.unpacked/kun/node_modules'}/${name === 'better-sqlite3-native' ? 'better-sqlite3/build/Release/better_sqlite3.node' : `${name}/package.json`}`, sha256: 'c'.repeat(64),
      ...(name === 'better-sqlite3-native' ? {} : { treeSha256: 'd'.repeat(64) }) })),
  })
  const data = mode => ({ schemaVersion: 1, mode, status: 'passed', projects: 1, networks: 1, adjustments: 1, monitoringDatasets: 1, sourceSha256: 'd'.repeat(64),
    serviceSource: mode === 'seed' ? 'source-bound-compatibility-service' : 'target-package', serviceIdentity: serviceIdentity(mode === 'seed') })
  const machineReport = {
    schemaVersion: 1, status: 'passed', baseVersion: '0.5.2', targetVersion: '0.5.3', platform: 'darwin', arch: 'arm64',
    productionTouched: false, systemTrustModified: false, officialFeedsModified: false, publicReleasePerformed: false,
    reviewedBuild: structuredClone(manifest.package.reviewedBuild),
    provenance: { repository: RELEASE_REPOSITORY, workflowPath: UPDATER_WORKFLOW, workflowRef: UPDATER_WORKFLOW_REF, workflowSha: reviewedSourceHead,
      sourceHead: reviewedSourceHead, runId: 4321, runAttempt: 1 },
    baselineAsset: { tag: 'v0.5.2', name: 'WorkWise-0.5.2-mac-Apple-Silicon.dmg', size: 301766076, sha256: '09dae4a270bbf06fb3fc79771eef3faa2afaba43eea9e6696762fa7ba5cf99e0', assetId: 612608487 },
    baselineIdentity: identity('0.5.2'), targetIdentity: identity('0.5.3'), installedIdentity: identity('0.5.3'),
    targetZipSha256: 'a'.repeat(64), frozenManifestSha256: 'a'.repeat(64), targetAsarSha256: 'e'.repeat(64), installedAsarSha256: 'e'.repeat(64),
    targetServiceIdentity: serviceIdentity(false),
    strictNonceProbe: { strictProbeRequired: true, nonceSha256: 'f'.repeat(64) }, separateSentinelPreserved: true,
    dataSeed: data('seed'), dataReadback: data('verify'), dataRestartReadback: data('verify'), configReferences: { status: 'byte-preserved' },
    feedRequests: { manifest: 2, zip: 1, bytesServed: 100 },
    steps: [{ operation: 'real-native-update-and-historical-readback', status: 'completed' }, { operation: 'owned-resource-cleanup', status: 'completed' }],
  }
  const nativeReport = {
    schemaVersion: 1, status: 'passed', baseVersion: '0.5.2', targetVersion: '0.5.3', platform: 'darwin', arch: 'arm64', browserOpened: false, userDataPreserved: true,
    stages: ['base_started', 'update_available', 'download_completed', 'install_requested', 'target_relaunched', 'user_data_preserved'].map(name => ({ name, detail: name === 'user_data_preserved' ? '0.5.2' : 'synthetic unit fixture' })),
  }
  const recordEvidence = () => {
    machineReport.nativeReportSha256 = reportSha256(Buffer.from(JSON.stringify(nativeReport)))
    put(manifestPath, JSON.stringify(manifest))
    for (const path of [manifest.package.screenshots[0], ...Object.values(manifest.acceptance).map(item => item.path)]) put(path, 'test evidence\n')
    if (manifest.acceptance.updaterRoundTrip.machineReportPath) put(manifest.acceptance.updaterRoundTrip.machineReportPath, JSON.stringify(machineReport))
    if (manifest.acceptance.updaterRoundTrip.nativeReportPath) put(manifest.acceptance.updaterRoundTrip.nativeReportPath, JSON.stringify(nativeReport))
  }
  const tagRelease = () => {
    const releaseHead = commit('record acceptance evidence')
    git('tag', 'v0.5.3', releaseHead)
    return releaseHead
  }
  const verify = (releaseHead, expectError) => {
    const args = [verifierPath, '--tag=v0.5.3', '--ref-type=tag', `--source-head=${releaseHead}`, '--confirmation=PUBLISH-STABLE-v0.5.3']
    const env = { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', GITHUB_REF_NAME: '', GITHUB_REF_TYPE: '', GITHUB_SHA: '', RELEASE_CONFIRMATION: '', RELEASE_EVIDENCE: '' }
    if (!expectError) return execFileSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    let failure
    try {
      execFileSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      failure = error
    }
    assert.ok(failure, 'release verification must fail')
    assert.match(String(failure.stderr), expectError)
  }
  return { root, git, put, commit, reviewedSourceHead, base, manifestPath, manifest, machineReport, nativeReport, recordEvidence, tagRelease, verify }
}

function input(name) {
  const value = triggers?.workflow_dispatch?.inputs?.[name]
  assert.ok(value, `release.yml must declare workflow_dispatch input ${name}`)
  return value
}

test('stable release workflow cannot be triggered by pushing a version tag', () => {
  assert.ok(triggers?.workflow_dispatch, 'stable publication must be manually dispatched')
  assert.equal(triggers?.push, undefined, 'release.yml must not publish from push events')
  assert.doesNotMatch(workflowSource, /push:\s*[\s\S]{0,120}tags:\s*\n?\s*-\s*["']?v\\\*/)
})

test('stable publication requires an explicit opt-in and a review evidence path', () => {
  const publish = input('publish_release')
  assert.equal(publish.type, 'boolean')
  assert.equal(publish.default, false)

  const confirmation = input('release_confirmation')
  assert.equal(confirmation.type, 'string')
  assert.equal(confirmation.required, false, 'maintenance/candidate runs must not require a stable approval token')

  const evidence = input('release_evidence')
  assert.equal(evidence.type, 'string')
  assert.match(String(evidence.default ?? ''), /docs\/qa\/release-gates\//)

  const publishJob = jobs.publish
  assert.ok(publishJob, 'release.yml must retain an explicit publish job')
  assert.match(String(publishJob.if), /github\.event_name\s*==\s*['"]workflow_dispatch['"]/, 'publish must be dispatch-only')
  assert.match(String(publishJob.if), /github\.ref_type\s*==\s*['"]tag['"]/, 'publish must run only for a tag ref')
  assert.match(String(publishJob.if), /inputs\.publish_release\s*==\s*true/, 'publish must require publish_release=true')
  assert.match(String(publishJob.if), /release[-_]approval[-_]gate|verify[-_]release[-_]approval/, 'publish must depend on the approval/evidence gate')
  const environment = typeof publishJob.environment === 'string' ? publishJob.environment : publishJob.environment?.name
  assert.equal(environment, 'production-release', 'stable publication must use the protected production environment')
  assert.ok(Array.isArray(publishJob.needs), 'publish must declare its upstream jobs')
  assert.ok(publishJob.needs.some((name) => /release[-_]approval[-_]gate|verify[-_]release[-_]approval/.test(String(name))), 'approval gate must be an upstream publish dependency')
})

test('release workflow verifies the recorded approval evidence before side effects', () => {
  assert.ok(existsSync(new URL('./verify-release-approval.mjs', import.meta.url)), 'approval evidence verifier is required')
  assert.match(workflowSource, /scripts\/verify-release-approval\.mjs/, 'publish workflow must invoke the approval evidence verifier')

  const publish = jobs.publish
  const gateName = (publish.needs ?? []).find((name) => /release[-_]approval[-_]gate|verify[-_]release[-_]approval/.test(String(name)))
  assert.ok(gateName, 'publish must wait for a dedicated approval/evidence gate')
  const gate = jobs[gateName]
  assert.ok(gate, `approval gate job ${gateName} must exist`)
  const gateSteps = gate.steps ?? []
  const checkout = gateSteps.find(step => /actions\/checkout@/.test(String(step.uses ?? '')))
  assert.equal(checkout?.with?.['fetch-depth'], 0, 'the gate needs full history to verify the reviewed-source ancestor')
  const verifyIndex = gateSteps.findIndex((step) => /verify-release-approval\.mjs/.test(String(step.run ?? '')))
  assert.ok(verifyIndex >= 0, 'approval evidence must be checked in the dedicated gate job')
  assert.doesNotMatch(JSON.stringify(gate), /publish-r2|deploy-website-release|gh release/, 'approval gate must be read-only')

  const publishSteps = publish.steps ?? []
  const firstSideEffectIndex = publishSteps.findIndex((step) => /publish-r2\.mjs\s+(upload|promote)|deploy-website-release\.mjs\s+(stage|promote)|gh\s+release\s+(create|edit|upload)/.test(String(step.run ?? '')))
  assert.ok(firstSideEffectIndex >= 0, 'publish job must contain a detectable publication side effect')
  assert.ok(gateSteps.length > verifyIndex, 'approval evidence gate must complete before publish can run')
  const artifactCheck = publishSteps.findIndex(step => /verify-reviewed-release-artifacts\.mjs verify/.test(step.run ?? ''))
  assert.ok(artifactCheck >= 0 && artifactCheck < firstSideEffectIndex, 'downloaded artifact bytes must pass before any public write')
})

test('publication downloads exact reviewed IDs from the verified source run and never rebuilds', () => {
  const publish = jobs.publish
  assert.deepEqual(publish.needs, ['release-approval-gate', 'prepare'])
  const download = publish.steps.find(step => step.name === 'Download immutable reviewed release artifacts')
  assert.equal(download.with['merge-multiple'], false, 'separate directories prevent duplicate filenames being silently overwritten')
  assert.equal(download.with.pattern, undefined)
  for (const field of ['repository', 'run-id', 'artifact-ids']) assert.match(download.with[field], /needs\.release-approval-gate\.outputs\./)
  for (const job of ['stability', 'build-document-sidecars', 'build-macos', 'build-windows']) {
    assert.match(jobs[job].if, /inputs\.publish_release != true/, `${job} must not rebuild published bytes`)
  }
  assert.doesNotMatch(JSON.stringify(publish.steps), /npm run (?:build|dist)|electron-builder/)
  assert.equal(jobs['release-approval-gate'].permissions.actions, 'read')
  assert.equal(publish.permissions.actions, 'read')
})

test('only an explicit private final-package build records public-identity receipts', () => {
  assert.equal(input('prepare_public_artifacts').default, false)
  for (const job of ['build-macos', 'build-windows']) {
    const build = jobs[job]
    const record = build.steps.find(step => step.name === 'Record frozen public package identity')
    assert.match(record.if, /inputs\.candidate_only == true/)
    assert.match(record.if, /inputs\.prepare_public_artifacts == true/)
    assert.match(record.if, /inputs\.publish_release != true/)
    assert.match(build.env.WORKWISE_UPDATE_URL, /inputs\.prepare_public_artifacts != true/)
    assert.match(build.steps.find(step => /Upload .*installer/.test(step.name))?.with.path, /reviewed-build\.json/)
  }
})

test('release source checkout cannot move while stability or acceptance is running', () => {
  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (/actions\/checkout@/.test(step.uses ?? '')) assert.equal(step.with?.ref, '${{ github.sha }}', `${name} checkout must use the dispatch commit`)
    }
  }
})

test('stable publication does not inherit write permission globally', () => {
  assert.equal(workflow.permissions?.contents, 'read', 'workflow-wide token must be read-only')
  assert.equal(jobs.publish.permissions?.contents, 'write', 'only the publish job may receive contents: write')
})

test('every job that can mutate stable delivery is dispatch-gated', () => {
  const mutatingJobs = Object.entries(jobs).filter(([, job]) => {
    const source = JSON.stringify(job)
    return /publish-r2|deploy-website-release|gh release/.test(source)
  })
  assert.ok(mutatingJobs.length, 'expected at least one stable delivery job')
  for (const [name, job] of mutatingJobs) {
    assert.match(String(job.if), /github\.event_name\s*==\s*['"]workflow_dispatch['"]/, `${name} must be dispatch-only`)
    assert.match(String(job.if), /confirmation|publish_release|rollback_stable_confirmation|release_approval/, `${name} must require an explicit confirmation or release opt-in`)
  }
})

test('all production website and Stable pointer mutations use the protected environment', () => {
  const rollbackEnvironment = jobs['rollback-stable']?.environment
  assert.equal(rollbackEnvironment?.name ?? rollbackEnvironment, 'production-release')

  const repairEnvironment = jobs['repair-website-cache']?.environment
  assert.match(String(repairEnvironment?.name ?? repairEnvironment), /production-release/)
  assert.match(String(repairEnvironment?.name ?? repairEnvironment), /repair_website_cache_mode/)

  const websiteDeploy = websiteWorkflow.jobs?.deploy
  assert.ok(websiteDeploy, 'product page workflow must retain a deploy job')
  const websiteEnvironment = websiteDeploy.environment
  assert.match(String(websiteEnvironment?.name ?? websiteEnvironment), /production-release/)
  assert.match(String(websiteEnvironment?.name ?? websiteEnvironment), /inputs\.operation/)
})

test('independent release-control review covers frozen evidence and recovery dependencies', () => {
  const rules = readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8').split(/\r?\n/)
    .filter(line => line.trim() && !line.trim().startsWith('#')).map(line => line.trim().split(/\s+/))
  for (const path of [
    '.github/workflows/frozen-release-updater-acceptance.yml',
    'scripts/verify-reviewed-release-artifacts.mjs', 'scripts/verify-frozen-updater-evidence.mjs',
    'scripts/run-frozen-release-updater-acceptance.mjs', 'scripts/frozen-release-updater-data.mjs',
    'scripts/frozen-release-updater-feed.mjs', 'scripts/updater-acceptance-process.mjs',
    'scripts/release-promotion-recovery.mjs',
  ]) {
    const rule = rules.find(([pattern]) => pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern)
    assert.ok(rule && rule.slice(1).some(owner => /^@[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?$/.test(owner)), `${path} must declare a release CODEOWNER`)
  }
})

test('approval verifier rejects non-tag refs and missing exact confirmation before reading evidence', () => {
  const sourceHead = 'a'.repeat(40)
  assert.throws(
    () => verifyReleaseApproval({
      tag: 'v0.5.2',
      refType: 'branch',
      sourceHead,
      confirmation: 'PUBLISH-STABLE-v0.5.2',
    }),
    /exact tag/
  )
  assert.throws(
    () => verifyReleaseApproval({
      tag: 'v0.5.2',
      refType: 'tag',
      sourceHead,
      confirmation: '',
    }),
    /release confirmation must be PUBLISH-STABLE-v0.5.2/
  )
})

test('approval verifier requires a scoped, tracked evidence manifest', () => {
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /scope !== 'public-release'/)
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /packageIdentity\.artifactSha256/)
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /requireTrackedArtifact/)
  assert.match(readFileSync(new URL('./verify-release-approval.mjs', import.meta.url), 'utf8'), /rev-list[\s\S]*sourceHead/)
})

test('release evidence can follow a frozen reviewed commit without self-referencing its own hash', t => {
  const f = releaseFixture(t)
  f.put('docs/qa/evidence/first-pass.md', 'first pass\n')
  f.commit('record first evidence')
  f.recordEvidence()
  const releaseHead = f.tagRelease()
  assert.notEqual(releaseHead, f.reviewedSourceHead)
  assert.match(f.verify(releaseHead), new RegExp(`reviewed source ${f.reviewedSourceHead}`))
})

test('a passing prose updater report without both machine reports blocks release', t => {
  const f = releaseFixture(t)
  delete f.manifest.acceptance.updaterRoundTrip.machineReportPath
  delete f.manifest.acceptance.updaterRoundTrip.nativeReportPath
  f.recordEvidence()
  f.verify(f.tagRelease(), /updaterRoundTrip\.machineReportPath must provide/)
})

test('a same-version native report cannot be exchanged after the machine report was recorded', t => {
  const f = releaseFixture(t)
  f.recordEvidence()
  f.put(f.manifest.acceptance.updaterRoundTrip.nativeReportPath, JSON.stringify({ ...f.nativeReport, startedAt: 'old-run' }))
  f.verify(f.tagRelease(), /retained native report digest mismatch/)
})

test('the committed updater reports require a matching immutable trusted workflow run', async t => {
  const changes = {
    missingRun: f => { delete f.manifest.acceptance.updaterRoundTrip.workflowRun },
    changedRun: f => { f.manifest.acceptance.updaterRoundTrip.workflowRun.runId += 1 },
    changedAttempt: f => { f.machineReport.provenance.runAttempt += 1 },
    branchWorkflow: f => { f.machineReport.provenance.workflowRef = UPDATER_WORKFLOW_REF.replace('main', 'codex/feature') },
    wrongSource: f => { f.machineReport.provenance.sourceHead = 'a'.repeat(40) },
    unknownArtifact: f => { f.manifest.acceptance.updaterRoundTrip.workflowRun.artifact.name = 'old-updater-report' },
    noArtifactDigest: f => { delete f.manifest.acceptance.updaterRoundTrip.workflowRun.artifact.digest },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, st => {
    const f = releaseFixture(st)
    change(f); f.recordEvidence()
    f.verify(f.tagRelease(), /updater-evidence/)
  })
})

test('updater reports must bind the real official baseline, frozen bytes and completed native path', async t => {
  const changes = {
    oldSameSourceProbe: f => { f.machineReport.baseVersion = '0.0.0' },
    differentTarget: f => { f.machineReport.targetVersion = '0.5.4' },
    differentBuildRun: f => { f.machineReport.reviewedBuild.runId += 1 },
    differentBuildAttempt: f => { f.machineReport.reviewedBuild.runAttempt += 1 },
    differentSource: f => { f.machineReport.reviewedBuild.sourceHead = 'b'.repeat(40) },
    differentArtifactId: f => { f.machineReport.reviewedBuild.artifacts[0].id += 1 },
    differentFileHash: f => { f.machineReport.reviewedBuild.files[0].sha256 = 'b'.repeat(64) },
    differentFileSize: f => { f.machineReport.reviewedBuild.files[0].size += 1 },
    unpinnedBaseline: f => { f.machineReport.baselineAsset.sha256 = 'b'.repeat(64) },
    differentZip: f => { f.machineReport.targetZipSha256 = 'b'.repeat(64) },
    differentManifest: f => { f.machineReport.frozenManifestSha256 = 'b'.repeat(64) },
    differentInstalledAsar: f => { f.machineReport.installedAsarSha256 = 'b'.repeat(64) },
    differentUiReviewedAsar: f => { f.manifest.package.identity.asarSha256 = 'b'.repeat(64) },
    isolatedCandidateIdentity: f => { f.machineReport.installedIdentity.bundleId = 'com.example.candidate' },
    unsignedInstallation: f => { f.machineReport.installedIdentity.signature = 'unverified' },
    missingNotarization: f => { f.machineReport.targetIdentity.stapledNotarization = 'unverified' },
    rejectedGatekeeper: f => { f.machineReport.baselineIdentity.gatekeeper = 'rejected' },
    differentSigningIdentity: f => { f.machineReport.installedIdentity.designatedRequirement = 'designated => different' },
    noStrictProbe: f => { f.machineReport.strictNonceProbe.strictProbeRequired = false },
    noIndependentSentinel: f => { f.machineReport.separateSentinelPreserved = false },
    failedHistoricalReadback: f => { f.machineReport.dataReadback.status = 'failed' },
    failedRestartReadback: f => { f.machineReport.dataRestartReadback.status = 'failed' },
    changedHistoricalSource: f => { f.machineReport.dataReadback.sourceSha256 = 'b'.repeat(64) },
    noConfigPreservation: f => { f.machineReport.configReferences.status = 'failed' },
    incompleteDownload: f => { f.machineReport.feedRequests.bytesServed = 99 },
    absentNativeRequests: f => { f.machineReport.feedRequests.zip = 0 },
    incompleteCleanup: f => { f.machineReport.steps.pop() },
    retainedMachineFailure: f => { f.machineReport.failure = 'Cleanup failed' },
    nativeBaselineWrong: f => { f.nativeReport.baseVersion = '0.0.0' },
    nativeTargetWrong: f => { f.nativeReport.targetVersion = '0.5.4' },
    nativeArchWrong: f => { f.nativeReport.arch = 'x64' },
    browserFallback: f => { f.nativeReport.browserOpened = true },
    userDataLost: f => { f.nativeReport.userDataPreserved = false },
    incompleteNativeStages: f => { f.nativeReport.stages.splice(3, 1) },
    legacyStateFallback: f => { f.nativeReport.stages.at(-1).detail = 'legacy-state:0.5.2' },
    retainedNativeFailure: f => { f.nativeReport.failure = 'Install failed' },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, st => {
    const f = releaseFixture(st)
    change(f)
    f.recordEvidence()
    f.verify(f.tagRelease(), /updater evidence|native updater evidence/)
  })
})

test('the installed UI review must identify its application ASAR hash', t => {
  const f = releaseFixture(t)
  delete f.manifest.package.identity.asarSha256
  f.recordEvidence()
  f.verify(f.tagRelease(), /package\.identity must include.*asarSha256/)
})

test('prose or uncommitted substitutions cannot replace tagged native machine reports', async t => {
  await t.test('plain prose is not a machine report', st => {
    const f = releaseFixture(st)
    f.recordEvidence()
    f.put(f.manifest.acceptance.updaterRoundTrip.machineReportPath, 'Native updater passed\n')
    f.verify(f.tagRelease(), /frozen updater machine report is not valid committed JSON/)
  })
  await t.test('uncommitted passing JSON cannot replace a tagged failure', st => {
    const f = releaseFixture(st)
    f.machineReport.status = 'failed'
    f.recordEvidence()
    const head = f.tagRelease()
    f.machineReport.status = 'passed'
    f.put(f.manifest.acceptance.updaterRoundTrip.machineReportPath, JSON.stringify(f.machineReport))
    f.verify(head, /updater evidence machine status mismatch/)
  })
  await t.test('native machine report must also be a committed file', st => {
    const f = releaseFixture(st)
    f.recordEvidence()
    f.git('add', '-A')
    f.git('reset', '--', f.manifest.acceptance.updaterRoundTrip.nativeReportPath)
    f.git('commit', '-m', 'missing native machine evidence')
    const head = f.git('rev-parse', 'HEAD')
    f.git('tag', 'v0.5.3', head)
    f.verify(head, /regular file committed in the exact release tag/)
  })
})

test('unknown reviewed commits are rejected', t => {
  const f = releaseFixture(t)
  f.manifest.release.sourceHead = 'b'.repeat(40)
  f.recordEvidence()
  f.verify(f.tagRelease(), /reviewed source commit cannot be resolved/)
})

test('a reviewed commit from an unrelated branch is rejected', t => {
  const f = releaseFixture(t)
  f.git('checkout', '-b', 'other-review')
  f.put('docs/qa/evidence/unrelated.md', 'other branch\n')
  f.manifest.release.sourceHead = f.commit('unrelated review')
  f.git('checkout', 'main')
  f.recordEvidence()
  f.verify(f.tagRelease(), /must be an ancestor of the exact release tag/)
})

test('runtime, build, config and non-QA documentation changes require fresh package acceptance', async t => {
  for (const path of ['src/runtime.js', 'scripts/package.cjs', 'electron-builder.cjs', 'package.json', '.github/workflows/release.yml', 'docs/qa-lookalike.md', 'docs/reference.md']) {
    await t.test(path, st => {
      const f = releaseFixture(st)
      f.put(path, path === 'package.json' ? JSON.stringify({ version: '0.5.3', extra: true }) : 'unreviewed change\n')
      f.commit('change after acceptance')
      f.recordEvidence()
      f.verify(f.tagRelease(), /changes after the reviewed package must be limited to docs\/qa evidence/)
    })
  }
})

test('public release rejects source-tree target readback and incomplete packaged service identities', async t => {
  const changes = {
    targetSourceFallback: f => { f.machineReport.dataReadback.serviceSource = 'source-bound-compatibility-service' },
    targetMislabeledBaseline: f => { f.machineReport.dataRestartReadback.serviceSource = 'baseline-package' },
    missingFrozenServiceIdentity: f => { delete f.machineReport.targetServiceIdentity },
    missingReadbackServiceIdentity: f => { delete f.machineReport.dataReadback.serviceIdentity },
    missingRestartServiceIdentity: f => { delete f.machineReport.dataRestartReadback.serviceIdentity },
    differentFrozenServiceVersion: f => { f.machineReport.targetServiceIdentity.packageVersion = '0.5.2' },
    differentFrozenPackageSource: f => { f.machineReport.targetServiceIdentity.packageSourceHead = 'b'.repeat(40) },
    differentFrozenServiceSource: f => { f.machineReport.targetServiceIdentity.serviceSourceHead = 'b'.repeat(40) },
    differentFrozenServiceAsar: f => { f.machineReport.targetServiceIdentity.asarSha256 = 'b'.repeat(64) },
    missingFrozenServiceModule: f => { f.machineReport.targetServiceIdentity.modules.pop() },
    changedRestartServiceModule: f => { f.machineReport.dataRestartReadback.serviceIdentity.modules[0].sha256 = 'c'.repeat(64) },
    changedRestartDependency: f => { f.machineReport.dataRestartReadback.serviceIdentity.dependencies[0].sha256 = 'b'.repeat(64) },
    changedRestartServiceTree: f => { f.machineReport.dataRestartReadback.serviceIdentity.serviceTreeSha256 = 'b'.repeat(64) },
    changedRestartDependencyTree: f => { f.machineReport.dataRestartReadback.serviceIdentity.dependencies[0].treeSha256 = 'b'.repeat(64) },
    missingServiceTree: f => { delete f.machineReport.targetServiceIdentity.serviceTreeSha256 },
    missingDependencyTree: f => { delete f.machineReport.targetServiceIdentity.dependencies[0].treeSha256 },
    dependencyPathEscapesPackage: f => { f.machineReport.targetServiceIdentity.dependencies[0].path = 'app.asar.unpacked/../node_modules/better-sqlite3/index.js' },
    dependencyHashMissing: f => { delete f.machineReport.targetServiceIdentity.dependencies[0].sha256 },
    missingNativeDependency: f => { f.machineReport.targetServiceIdentity.dependencies = f.machineReport.targetServiceIdentity.dependencies.filter(item => item.name !== 'better-sqlite3-native') },
    changedSeedCompatibilitySource: f => { f.machineReport.dataSeed.serviceIdentity.serviceSourceHead = 'b'.repeat(40) },
    unknownSeedService: f => { f.machineReport.dataSeed.serviceSource = 'target-package' },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, st => {
    const f = releaseFixture(st)
    change(f); f.recordEvidence()
    f.verify(f.tagRelease(), /updater-service/)
  })
})

test('reverting an unreviewed runtime edit does not bypass the release gate', t => {
  const f = releaseFixture(t)
  f.put('src/runtime.js', 'export const value = 2\n')
  const change = f.commit('unreviewed runtime change')
  f.git('revert', '--no-edit', change)
  f.recordEvidence()
  f.verify(f.tagRelease(), /changes after the reviewed package must be limited to docs\/qa evidence/)
})

test('merge histories cannot hide unreviewed changes', t => {
  const f = releaseFixture(t)
  f.git('checkout', '-b', 'runtime-change')
  f.put('src/runtime.js', 'export const value = 2\n')
  f.commit('unreviewed branch runtime change')
  f.git('checkout', 'main')
  f.put('docs/qa/evidence/main.md', 'main evidence\n')
  f.commit('record main evidence')
  f.git('merge', '--no-ff', 'runtime-change', '-m', 'merge unreviewed branch')
  f.recordEvidence()
  f.verify(f.tagRelease(), /changes after the reviewed package must be limited to docs\/qa evidence/)
})

test('merging only acceptance evidence is allowed after the reviewed source', t => {
  const f = releaseFixture(t)
  f.git('checkout', '-b', 'extra-evidence')
  f.put('docs/qa/evidence/extra.md', 'extra evidence\n')
  f.commit('record extra evidence')
  f.git('checkout', 'main')
  f.put('docs/qa/evidence/main.md', 'main evidence\n')
  f.commit('record main evidence')
  f.git('merge', '--no-ff', 'extra-evidence', '-m', 'merge acceptance evidence')
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.3/)
})

test('staged evidence and reports absent from the exact tag are rejected', t => {
  const f = releaseFixture(t)
  f.recordEvidence()
  const report = f.manifest.acceptance.updaterRoundTrip.path
  f.git('add', '-A')
  f.git('reset', '--', report)
  f.git('commit', '-m', 'incomplete acceptance evidence')
  const releaseHead = f.git('rev-parse', 'HEAD')
  f.git('tag', 'v0.5.3', releaseHead)
  f.git('add', report)
  f.verify(releaseHead, /regular file committed in the exact release tag/)
})

test('symlink reports are rejected as acceptance evidence', t => {
  const f = releaseFixture(t)
  f.recordEvidence()
  const report = join(f.root, f.manifest.acceptance.updaterRoundTrip.path)
  rmSync(report)
  symlinkSync('cua-review.md', report)
  f.verify(f.tagRelease(), /regular file committed in the exact release tag/)
})

test('uncommitted edits cannot replace the tagged manifest', t => {
  const f = releaseFixture(t)
  f.manifest.status = 'failed'
  f.recordEvidence()
  const releaseHead = f.tagRelease()
  f.manifest.status = 'passed'
  f.put(f.manifestPath, JSON.stringify(f.manifest))
  f.verify(releaseHead, /release evidence must have status=passed/)
})

test('uncommitted edits cannot replace the tagged package version', t => {
  const f = releaseFixture(t, '0.5.2')
  f.recordEvidence()
  const releaseHead = f.tagRelease()
  f.put('package.json', JSON.stringify({ version: '0.5.3' }))
  f.verify(releaseHead, /package\.json version 0\.5\.2 does not match v0\.5\.3/)
})

test('evidence paths reject line breaks before writing workflow outputs', t => {
  const f = releaseFixture(t)
  f.manifest.package.screenshots[0] = `${f.base}/overview\nartifact_ids=999.png`
  f.recordEvidence()
  f.verify(f.tagRelease(), /must not contain line breaks/)
})
