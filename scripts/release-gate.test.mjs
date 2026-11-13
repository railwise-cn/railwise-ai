import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse, stringify as stringifyYaml } from 'yaml'
import { classifyReleaseChanges, isProductPagePublicationOnlyChange, verifyReleaseApproval, verifyRequiredCI } from './verify-release-approval.mjs'
import { expectedReleaseFiles, PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256, UPDATER_WORKFLOW, UPDATER_WORKFLOW_REF } from './verify-frozen-updater-evidence.mjs'
import { FROZEN_BASE_VERSION, FROZEN_BASELINE_PINS, resolveUpdaterBaseline } from './frozen-release-version.mjs'
// Keep the existing npm run test:release-gate entry point covering byte/provenance gates.
import './verify-reviewed-release-artifacts.test.mjs'
import './verify-frozen-updater-evidence.test.mjs'
import './release-promotion-recovery.test.mjs'
import './release-build-memory.test.mjs'
import './macos-updater-trust.test.mjs'
import './build-markdown-rendering.test.cjs'
import './verify-packaged-markdown-rendering.test.cjs'
import './verify-markdown-packaging-filesets.test.cjs'
import './dependency-artifact-policy.test.cjs'
import './windows-install-smoke.test.mjs'
import './verify-exact-updater-evidence.test.mjs'

const workflowPath = new URL('../.github/workflows/release.yml', import.meta.url)
const workflowSource = readFileSync(workflowPath, 'utf8')
const workflow = parse(workflowSource)
const triggers = workflow.on ?? workflow['on']
const jobs = workflow.jobs ?? {}
const websiteWorkflowSource = readFileSync(new URL('../.github/workflows/deploy-workwise-product-page.yml', import.meta.url), 'utf8')
const websiteWorkflow = parse(websiteWorkflowSource)
const verifierPath = fileURLToPath(new URL('./verify-release-approval.mjs', import.meta.url))

function releaseFixture(t, packageVersion = '0.5.4', version = '0.5.4', options = {}) {
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
  for (const [path, contents] of Object.entries(options.sourceFiles ?? {})) put(path, contents)
  if (options.previousTag) {
    const previousSourceHead = commit('previous formal source fixture')
    const previousVersion = options.previousTag.slice(1)
    put(`docs/qa/release-gates/${options.previousTag}.json`, JSON.stringify({
      schemaVersion: 1, scope: 'public-release', status: 'passed',
      release: { tag: options.previousTag, version: previousVersion, sourceHead: previousSourceHead }
    }))
    commit('previous formal release evidence fixture')
    git('tag', options.previousTag)
    put('src/runtime.js', 'export const value = 2\n')
    for (const [path, contents] of Object.entries(options.changedFiles ?? {})) put(path, contents)
  }
  const reviewedSourceHead = commit('freeze reviewed source')
  const base = `docs/qa/release-gates/v${version}`
  const manifestPath = `${base}.json`
  const manifest = {
    schemaVersion: 1,
    scope: 'public-release',
    status: 'passed',
    release: { tag: `v${version}`, version, sourceHead: reviewedSourceHead },
    package: {
      version,
      identity: { bundleId: PUBLIC_IDENTITY.bundleId, artifactSha256: 'a'.repeat(64), asarSha256: 'e'.repeat(64) },
      reviewedBuild: {
        repository: RELEASE_REPOSITORY, workflowPath: RELEASE_WORKFLOW, sourceHead: reviewedSourceHead,
        runId: 1234, runAttempt: 1, publicIdentity: { ...PUBLIC_IDENTITY },
        artifacts: [{ name: 'release-mac', id: 11, digest: `sha256:${'b'.repeat(64)}` }, { name: 'release-win', id: 12, digest: `sha256:${'c'.repeat(64)}` }],
        files: expectedReleaseFiles(version).map(file => ({ ...file, sha256: 'a'.repeat(64), size: 100 })),
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
  const identity = version => ({ version, bundleId: PUBLIC_IDENTITY.bundleId, signature: 'verified', stapledNotarization: 'verified', gatekeeper: 'accepted', gatekeeperAssessments: 'enabled', gatekeeperSource: 'Notarized Developer ID', designatedRequirement: 'designated => synthetic-unit-fixture' })
  const serviceIdentity = seed => ({ schemaVersion: 1, packageVersion: seed ? FROZEN_BASE_VERSION : version, packageSourceHead: seed ? null : reviewedSourceHead,
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
    schemaVersion: 1, status: 'passed', baseVersion: FROZEN_BASE_VERSION, targetVersion: version, platform: 'darwin', arch: 'arm64',
    productionTouched: false, systemTrustModified: false, officialFeedsModified: false, publicReleasePerformed: false,
    reviewedBuild: structuredClone(manifest.package.reviewedBuild),
    provenance: { repository: RELEASE_REPOSITORY, workflowPath: UPDATER_WORKFLOW, workflowRef: UPDATER_WORKFLOW_REF, workflowSha: reviewedSourceHead,
      sourceHead: reviewedSourceHead, runId: 4321, runAttempt: 1 },
    baselineAsset: { tag: `v${FROZEN_BASE_VERSION}`, ...FROZEN_BASELINE_PINS.arm64 },
    baselineIdentity: identity(FROZEN_BASE_VERSION), targetIdentity: identity(version), installedIdentity: identity(version),
    targetZipSha256: 'a'.repeat(64), frozenManifestSha256: 'a'.repeat(64), targetAsarSha256: 'e'.repeat(64), installedAsarSha256: 'e'.repeat(64),
    targetServiceIdentity: serviceIdentity(false),
    strictNonceProbe: { strictProbeRequired: true, nonceSha256: 'f'.repeat(64) }, separateSentinelPreserved: true,
    dataSeed: data('seed'), dataReadback: data('verify'), dataRestartReadback: data('verify'), configReferences: { status: 'byte-preserved' },
    feedRequests: { manifest: 2, zip: 1, bytesServed: 100 },
    steps: [{ operation: 'real-native-update-and-historical-readback', status: 'completed' }, { operation: 'owned-resource-cleanup', status: 'completed' }],
  }
  const nativeReport = {
    schemaVersion: 1, status: 'passed', baseVersion: FROZEN_BASE_VERSION, targetVersion: version, platform: 'darwin', arch: 'arm64', browserOpened: false, userDataPreserved: true,
    stages: ['base_started', 'update_available', 'download_completed', 'install_requested', 'target_relaunched', 'user_data_preserved'].map(name => ({ name, detail: name === 'user_data_preserved' ? FROZEN_BASE_VERSION : 'synthetic unit fixture' })),
  }
  const recordEvidence = () => {
    machineReport.nativeReportSha256 = reportSha256(Buffer.from(JSON.stringify(nativeReport)))
    put(manifestPath, JSON.stringify(manifest))
    for (const path of [...(manifest.package.screenshots ?? []), ...Object.values(manifest.acceptance).map(item => item.path), ...Object.values(manifest.checks ?? {}).map(item => item.path)].filter(Boolean)) put(path, 'test evidence\n')
    if (manifest.acceptance.updaterRoundTrip?.machineReportPath) put(manifest.acceptance.updaterRoundTrip.machineReportPath, JSON.stringify(machineReport))
    if (manifest.acceptance.updaterRoundTrip?.nativeReportPath) put(manifest.acceptance.updaterRoundTrip.nativeReportPath, JSON.stringify(nativeReport))
  }
  const tagRelease = () => {
    const releaseHead = commit('record acceptance evidence')
    git('tag', `v${version}`, releaseHead)
    return releaseHead
  }
  const verify = (releaseHead, expectError) => {
    const args = [verifierPath, `--tag=v${version}`, '--ref-type=tag', `--source-head=${releaseHead}`, `--confirmation=PUBLISH-STABLE-v${version}`]
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

test('previous formal tag may point to evidence after its packaged source', t => {
  const f = currentPolicyFixture(t)
  f.recordEvidence()
  const releaseHead = f.tagRelease()
  assert.match(f.verify(releaseHead), /verified v0\.5\.5/)
})

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

const productPageSteps = [
  'Generate product download data from the publication manifest',
  'Deploy the generated product download page',
  'Verify the generated public product download page',
  'Restore only the previous product page if its public verification fails'
]
const originalProductRollback = "${{ always() && steps.product_page_deploy.outcome == 'success' && steps.product_page_verify.outcome != 'success' }}"

function legacyPublicationWorkflow() {
  const previous = structuredClone(workflow)
  delete previous.on.workflow_dispatch.inputs.publish_product_page
  for (const name of productPageSteps.slice(0, 3)) delete previous.jobs.publish.steps.find(step => step.name === name).if
  previous.jobs.publish.steps.find(step => step.name === productPageSteps[3]).if = originalProductRollback
  return previous
}

test('product page opt-out gates every page operation and retains the existing rollback conditions', () => {
  assert.deepEqual(input('publish_product_page'), {
    description: 'Publish the product page and its download data after release promotion.',
    required: false, type: 'boolean', default: true
  })
  const pageSteps = jobs.publish.steps.filter(step => productPageSteps.includes(step.name))
  assert.equal(pageSteps.length, 4)
  for (const step of pageSteps.slice(0, 3)) assert.equal(step.if, '${{ inputs.publish_product_page == true }}')
  assert.equal(pageSteps[3].if, "${{ always() && inputs.publish_product_page == true && steps.product_page_deploy.outcome == 'success' && steps.product_page_verify.outcome != 'success' }}")
  for (const step of jobs.publish.steps.filter(step => !productPageSteps.includes(step.name))) {
    assert.doesNotMatch(String(step.if ?? ''), /publish_product_page/)
  }
  assert.equal(isProductPagePublicationOnlyChange(stringifyYaml(legacyPublicationWorkflow()), workflowSource), true)
  assert.equal(isProductPagePublicationOnlyChange(workflowSource, '# Formatting-only comment\n' + workflowSource), true)
})

test('publication-only workflow equivalence rejects all unrelated execution changes', async t => {
  const before = stringifyYaml(legacyPublicationWorkflow())
  const mutations = {
    'default-disabled': value => { value.on.workflow_dispatch.inputs.publish_product_page.default = false },
    'missing-page-generation-gate': value => { delete value.jobs.publish.steps.find(step => step.name === productPageSteps[0]).if },
    'broad-page-gate': value => { value.jobs.publish.steps.find(step => step.name === productPageSteps[1]).if = '${{ always() }}' },
    'removed-rollback-failure-condition': value => { value.jobs.publish.steps.find(step => step.name === productPageSteps[3]).if = '${{ inputs.publish_product_page == true }}' },
    'changed-product-page-command': value => { value.jobs.publish.steps.find(step => step.name === productPageSteps[1]).run += '\necho changed deployment' },
    'changed-build-command': value => { value.jobs['build-macos'].steps.push({ name: 'Change package', run: 'echo changed package bytes' }) },
    'changed-signing-environment': value => { value.jobs['build-macos'].env.CSC_IDENTITY_AUTO_DISCOVERY = 'false' },
    'changed-artifact-source': value => { value.jobs.publish.steps.find(step => step.name === 'Download immutable reviewed release artifacts').with['run-id'] = '1' },
    'removed-byte-verification': value => { value.jobs.publish.steps.find(step => step.name === 'Verify every reviewed installer and updater byte before publication').run = 'true' },
    'changed-r2-upload': value => { value.jobs.publish.steps.find(step => String(step.run).includes('publish-r2.mjs upload')).run += '\necho changed upload' },
    'changed-feed-promotion': value => { value.jobs.publish.steps.find(step => step.id === 'stable_promotion').run += '\necho changed feed' },
    'disabled-recovery': value => { value.jobs.publish.steps.find(step => String(step.run).includes('release-promotion-recovery.mjs restore')).if = '${{ false }}' },
    'additional-unreviewed-download': value => { value.jobs.publish.steps.push({ name: 'Replace installer', run: 'curl -fsS https://example.invalid/unreviewed -o public-release-assets/installer.exe' }) },
    'broader-token-permissions': value => { value.permissions.contents = 'write' },
    'unrelated-workflow-input': value => { value.on.workflow_dispatch.inputs.skip_verification = { type: 'boolean', default: true } }
  }
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const changed = structuredClone(workflow)
    mutate(changed)
    assert.equal(isProductPagePublicationOnlyChange(before, stringifyYaml(changed)), false)
  })
  assert.equal(isProductPagePublicationOnlyChange(before, workflowSource + '\njobs: {}\n'), false)
  assert.equal(isProductPagePublicationOnlyChange(before, 'invalid: [yaml'), false)
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

test('public-identity builds allow optional stability to be skipped', () => {
  const prepare = jobs.prepare.steps.find(step => step.id === 'version')
  assert.doesNotMatch(prepare.run, /SKIP_STABILITY|require the complete stability gate/)
  for (const name of ['build-document-sidecars', 'build-macos', 'build-windows', 'verify-candidate']) {
    assert.match(jobs[name].if, /inputs\.skip_stability == true/)
  }
})

test('release Electron mirror is scoped to the checksummed runtime preparation step', () => {
  assert.equal(workflow.env?.ELECTRON_MIRROR, undefined)
  for (const name of ['build-macos', 'build-windows']) {
    const preparation = jobs[name].steps.find(step => step.name === 'Prepare checksummed Electron runtime')
    assert.equal(preparation.env.ELECTRON_MIRROR, 'https://npmmirror.com/mirrors/electron/')
  }
})

test('private exact updater smoke consumes this run’s package once without a rebuild or publication', () => {
  assert.equal(input('exact_package_updater_smoke').default, false)
  const smoke = jobs['exact-package-updater-smoke']
  assert.deepEqual(smoke.needs, ['prepare', 'build-macos'])
  assert.match(smoke.if, /inputs\.exact_package_updater_smoke == true/)
  assert.match(smoke.if, /inputs\.publish_release != true/)
  assert.match(smoke.if, /inputs\.candidate_only != true/)
  const download = smoke.steps.find(step => /actions\/download-artifact@/.test(step.uses ?? ''))
  assert.equal(download.with.name, 'release-mac')
  assert.equal(download.with['run-id'], undefined, 'artifact must belong to this run')
  const launch = smoke.steps.find(step => /--target-dist=/.test(step.run ?? ''))
  assert.match(launch.run, /--base-version=0\.5\.4/)
  assert.match(launch.run, /--target-version="\$\{TARGET_VERSION\}"/)
  assert.doesNotMatch(JSON.stringify(smoke), /npm run dist|electron-builder|publish-r2|gh release|deploy-website-release|REVIEWED_BUILD_JSON/)
  const signing = jobs['build-macos'].steps.find(step => step.name === 'Resolve signing mode')
  assert.equal(signing.env.EXACT_PACKAGE_UPDATER_SMOKE, '${{ inputs.exact_package_updater_smoke }}')
  assert.match(signing.run, /EXACT_PACKAGE_UPDATER_SMOKE.*true/)
})

test('private Windows installation smoke inspects this run’s exact EXE without rebuilding or publication', () => {
  const smoke = jobs['exact-package-windows-install-smoke']
  assert.deepEqual(smoke.needs, ['prepare', 'build-windows'])
  assert.equal(smoke['runs-on'], 'windows-2022')
  assert.match(smoke.if, /inputs\.exact_package_updater_smoke == true/)
  assert.match(smoke.if, /inputs\.publish_release != true/)
  assert.match(smoke.if, /inputs\.candidate_only != true/)
  const download = smoke.steps.find(step => /actions\/download-artifact@/.test(step.uses ?? ''))
  assert.equal(download.with.name, 'release-win')
  assert.equal(download.with['run-id'], undefined)
  const inspect = smoke.steps.find(step => /run-windows-install-smoke\.ps1/.test(step.run ?? ''))
  assert.equal(inspect.shell, 'pwsh')
  assert.match(inspect.run, /-SourceHead \$env:GITHUB_SHA/)
  assert.match(inspect.run, /-Version \$env:TARGET_VERSION/)
  const evidence = smoke.steps.find(step => /actions\/upload-artifact@/.test(step.uses ?? ''))
  assert.equal(evidence.if, 'always()')
  assert.doesNotMatch(JSON.stringify(smoke), /npm run dist|electron-builder|publish-r2|gh release|deploy-website-release/)
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
    'scripts/frozen-release-updater-feed.mjs', 'scripts/updater-acceptance-process.mjs', 'scripts/macos-updater-trust.mjs',
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

test('0.5.4 release evidence preserves the complete exact-version release gate', t => {
  const f = releaseFixture(t, '0.5.4', '0.5.4')
  f.recordEvidence()
  const output = f.verify(f.tagRelease())
  assert.match(output, /verified v0\.5\.4/)
  assert.match(output, new RegExp(`reviewed source ${f.reviewedSourceHead}`))
})

test('0.5.4 release rejects otherwise coherent 0.5.3 updater machine and native reports', t => {
  const f = releaseFixture(t, '0.5.4', '0.5.4')
  f.machineReport.targetVersion = '0.5.3'
  f.nativeReport.targetVersion = '0.5.3'
  for (const key of ['targetIdentity', 'installedIdentity']) f.machineReport[key].version = '0.5.3'
  for (const identity of [f.machineReport.targetServiceIdentity, f.machineReport.dataReadback.serviceIdentity, f.machineReport.dataRestartReadback.serviceIdentity]) identity.packageVersion = '0.5.3'
  f.recordEvidence()
  f.verify(f.tagRelease(), /frozen target version mismatch/)
})

test('0.5.4 release rejects coherent older target services even when native version matches', t => {
  const f = releaseFixture(t, '0.5.4', '0.5.4')
  for (const identity of [f.machineReport.targetServiceIdentity, f.machineReport.dataReadback.serviceIdentity, f.machineReport.dataRestartReadback.serviceIdentity]) identity.packageVersion = '0.5.3'
  f.recordEvidence()
  f.verify(f.tagRelease(), /frozen target package version mismatch/)
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
    differentTarget: f => { f.machineReport.targetVersion = '0.5.3' },
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
    nativeTargetWrong: f => { f.nativeReport.targetVersion = '0.5.3' },
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

test('updater evidence requires enabled Gatekeeper and notarized Developer ID at every boundary', t => {
  const f = releaseFixture(t)
  f.recordEvidence()
  assert.doesNotThrow(() => f.verify(f.tagRelease()))

  const disabled = releaseFixture(t)
  disabled.machineReport.targetIdentity.gatekeeperAssessments = 'disabled'
  disabled.recordEvidence()
  assert.throws(() => disabled.verify(disabled.tagRelease()), /targetIdentity Gatekeeper status mismatch/)

  const nonNotarized = releaseFixture(t)
  nonNotarized.machineReport.installedIdentity.gatekeeperSource = 'Developer ID'
  nonNotarized.recordEvidence()
  assert.throws(() => nonNotarized.verify(nonNotarized.tagRelease()), /installedIdentity Gatekeeper source mismatch/)
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
    f.git('tag', 'v0.5.4', head)
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
      f.put(path, path === 'package.json' ? JSON.stringify({ version: '0.5.4', extra: true }) : 'unreviewed change\n')
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
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.4/)
})

test('staged evidence and reports absent from the exact tag are rejected', t => {
  const f = releaseFixture(t)
  f.recordEvidence()
  const report = f.manifest.acceptance.updaterRoundTrip.path
  f.git('add', '-A')
  f.git('reset', '--', report)
  f.git('commit', '-m', 'incomplete acceptance evidence')
  const releaseHead = f.git('rev-parse', 'HEAD')
  f.git('tag', 'v0.5.4', releaseHead)
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
  const f = releaseFixture(t, '0.5.3')
  f.recordEvidence()
  const releaseHead = f.tagRelease()
  f.put('package.json', JSON.stringify({ version: '0.5.4' }))
  f.verify(releaseHead, /package\.json version 0\.5\.3 does not match v0\.5\.4/)
})

test('evidence paths reject line breaks before writing workflow outputs', t => {
  const f = releaseFixture(t)
  f.manifest.package.screenshots[0] = `${f.base}/overview\nartifact_ids=999.png`
  f.recordEvidence()
  f.verify(f.tagRelease(), /must not contain line breaks/)
})

function currentPolicyFixture(t, { changedFiles = {}, sourceVersion = '0.5.5', exact = false } = {}) {
  const version = '0.5.5'
  const f = releaseFixture(t, sourceVersion, version, { previousTag: 'v0.5.4', changedFiles,
    sourceFiles: {
      '.github/workflows/release.yml': 'jobs:\n  build:\n    env:\n      WORKWISE_APP_VERSION: ${{ needs.prepare.outputs.version }}\n',
      'electron-builder.cjs': 'const releaseAppVersion = process.env.WORKWISE_APP_VERSION; module.exports = { extraMetadata: { version: releaseAppVersion } }\n',
    } })
  f.manifest.schemaVersion = 2
  f.manifest.release.previousTag = 'v0.5.4'
  delete f.manifest.package.screenshots
  f.manifest.acceptance = { installedPackage: { status: 'passed', path: `${f.base}/installed-package.md`, sourceHead: f.reviewedSourceHead } }
  f.manifest.checks = {
    focusedTests: { status: 'passed', path: `${f.base}/focused-tests.md`, sourceHead: f.reviewedSourceHead },
    productionBuild: { status: 'passed', path: `${f.base}/production-build.md`, sourceHead: f.reviewedSourceHead },
    requiredCI: { status: 'passed', workflowRun: { repository: RELEASE_REPOSITORY, workflowPath: '.github/workflows/quality.yml', sourceHead: f.reviewedSourceHead, runId: 777, runAttempt: 1 } },
  }
  if (exact) {
    const headRef = 'refs/heads/codex/package-source'
    Object.assign(f.manifest.package.reviewedBuild, { mode: 'exact-build', headRef, workflowRef: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@${headRef}`, workflowSha: f.reviewedSourceHead })
    Object.assign(f.manifest.package, { sourceVersion, buildVersion: version,
      installedMetadata: { version, sourceHead: f.reviewedSourceHead, packageName: PUBLIC_IDENTITY.packageName, productName: PUBLIC_IDENTITY.productName, asarSha256: f.manifest.package.identity.asarSha256 },
      versionOverride: { environmentVariable: 'WORKWISE_APP_VERSION', value: version, sourceHead: f.reviewedSourceHead } })
  }
  return f
}

test('current policy accepts focused checks and exact package inspection without screenshots, AI review or default updater', t => {
  const f = currentPolicyFixture(t)
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.5/)
})

test('legacy evidence remains readable without elective screenshot archives or AI review', t => {
  const f = releaseFixture(t)
  delete f.manifest.package.screenshots
  delete f.manifest.acceptance.independentSeniorEngineerReview
  delete f.manifest.acceptance.functionalChecklist
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.4/)
})

test('current policy still requires relevant source checks, exact install, identity, signature and notarization', async t => {
  const mutations = {
    missingFocused: f => { delete f.manifest.checks.focusedTests },
    failedBuild: f => { f.manifest.checks.productionBuild.status = 'failed' },
    wrongCheckSource: f => { f.manifest.checks.focusedTests.sourceHead = 'f'.repeat(40) },
    missingCI: f => { delete f.manifest.checks.requiredCI },
    foreignCI: f => { f.manifest.checks.requiredCI.workflowRun.repository = 'fork/repo' },
    oldCI: f => { f.manifest.checks.requiredCI.workflowRun.sourceHead = 'f'.repeat(40) },
    noInstall: f => { delete f.manifest.acceptance.installedPackage },
    wrongInstallSource: f => { f.manifest.acceptance.installedPackage.sourceHead = 'f'.repeat(40) },
    wrongBundle: f => { f.manifest.package.identity.bundleId = 'new.incompatible.identity' },
    unsigned: f => { f.manifest.package.signature.status = 'failed' },
    noNotary: f => { f.manifest.package.notarization.status = 'failed' },
    missingBaseline: f => { delete f.manifest.release.previousTag },
  }
  for (const [name, mutation] of Object.entries(mutations)) await t.test(name, t => {
    const f = currentPolicyFixture(t); mutation(f); f.recordEvidence()
    assert.throws(() => f.verify(f.tagRelease()))
  })
})

test('updater/download boundary changes require one exact smoke and cannot be waived by false declarations', async t => {
  for (const path of ['src/main/gui-updater.ts', 'scripts/release-publication.cjs', 'scripts/publish-r2.mjs', 'src/shared/product-brand.json', 'electron-builder.cjs']) await t.test(path, t => {
    const f = currentPolicyFixture(t, { changedFiles: { [path]: 'changed production updater/download boundary\n' } })
    f.manifest.release.updaterPathChanged = false
    f.manifest.acceptance.packagedUI = { status: 'passed', sourceHead: f.reviewedSourceHead, path: `${f.base}/packaged-ui.md` }
    f.recordEvidence()
    f.verify(f.tagRelease(), /requires one exact-package updater smoke/)
  })
  assert.deepEqual(classifyReleaseChanges(['scripts/verify-release-approval.mjs', 'src/main/gui-updater.test.ts', 'docs/update-notes.md']).updater, [])
})

test('visual changes require only affected packaged UI inspection, with no screenshot matrix', t => {
  const f = currentPolicyFixture(t, { changedFiles: { 'src/renderer/src/components/Task.tsx': 'export const Task = () => null\n' } })
  f.recordEvidence()
  f.verify(f.tagRelease(), /acceptance\.packagedUI must have status=passed/)
  f.git('tag', '-d', 'v0.5.5')
  f.manifest.acceptance.packagedUI = { status: 'passed', sourceHead: f.reviewedSourceHead, path: `${f.base}/packaged-ui.md` }
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.5/)
})

test('exact build effective version is bound to unchanged source and the existing version override', t => {
  const f = currentPolicyFixture(t, { sourceVersion: '0.5.4', exact: true })
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.5/)
})

test('effective version evidence cannot disguise a source-version or installed package mismatch', async t => {
  const mutations = {
    sourceVersion: f => { f.manifest.package.sourceVersion = '0.5.3' },
    effectiveVersion: f => { f.manifest.package.buildVersion = '0.5.6' },
    installedVersion: f => { f.manifest.package.installedMetadata.version = '0.5.4' },
    installedSource: f => { f.manifest.package.installedMetadata.sourceHead = 'f'.repeat(40) },
    installedAsar: f => { f.manifest.package.installedMetadata.asarSha256 = 'f'.repeat(64) },
    missingOverride: f => { delete f.manifest.package.versionOverride },
    wrongVariable: f => { f.manifest.package.versionOverride.environmentVariable = 'ARBITRARY_VERSION' },
  }
  for (const [name, mutation] of Object.entries(mutations)) await t.test(name, t => {
    const f = currentPolicyFixture(t, { sourceVersion: '0.5.4', exact: true }); mutation(f); f.recordEvidence()
    assert.throws(() => f.verify(f.tagRelease()))
  })
})

test('package-external policy, test harness and evidence edits can follow the exact package without a second build', t => {
  const f = currentPolicyFixture(t, { exact: true })
  for (const path of ['scripts/verify-release-approval.mjs', 'scripts/verify-exact-updater-evidence.mjs', 'scripts/run-task-delivery-live.mjs', 'scripts/run-windows-ui-smoke.mjs', 'scripts/windows-ui-smoke.test.mjs', 'scripts/macos-updater-trust.test.mjs', 'kun/src/services/task-controller.test.ts', 'docs/runtime-architecture.md', 'website/products/workwise/index.php', 'scripts/workwise-product-public-verification.test.mjs', 'openspec/changes/durable-task-document-workbench/tasks.md']) f.put(path, 'package-external correction\n')
  const policyHead = f.commit('record nonshipped policy and evidence harness changes')
  f.manifest.checks.requiredCI.workflowRun.sourceHead = policyHead
  f.manifest.checks.focusedTests.sourceHead = policyHead
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.5/)
})

test('exact build still rejects every later application or packaging edit', async t => {
  for (const path of ['src/runtime.js', 'kun/src/services/task-controller.ts', 'kun/src/other.test.ts', 'package.json', 'electron-builder.cjs', 'scripts/before-pack.cjs', 'scripts/prepare-windows-install-smoke.mjs', '.github/workflows/release.yml']) await t.test(path, t => {
    const f = currentPolicyFixture(t, { exact: true })
    f.put(path, path === 'package.json' ? JSON.stringify({ version: '0.5.5', changed: true }) : 'changed application/build inputs\n')
    f.commit('change package inputs after build'); f.recordEvidence()
    f.verify(f.tagRelease(), /changes after the reviewed package/)
  })
})

test('exact package evidence accepts the product-page switch and the two Windows QA scripts', t => {
  const f = currentPolicyFixture(t, { exact: true, changedFiles: { [RELEASE_WORKFLOW]: stringifyYaml(legacyPublicationWorkflow()) } })
  f.put(RELEASE_WORKFLOW, workflowSource)
  f.put('scripts/run-windows-ui-smoke.mjs', 'exact-package QA driver\n')
  f.put('scripts/windows-ui-smoke.test.mjs', 'QA driver regression\n')
  f.commit('add scoped product publication opt-out and QA driver evidence')
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.5/)
})

test('reverting a post-build workflow packaging change still requires a newly accepted package', t => {
  const f = currentPolicyFixture(t, { exact: true, changedFiles: { [RELEASE_WORKFLOW]: stringifyYaml(legacyPublicationWorkflow()) } })
  const changed = legacyPublicationWorkflow()
  changed.jobs['build-macos'].steps.push({ name: 'Change package', run: 'echo changed package bytes' })
  f.put(RELEASE_WORKFLOW, stringifyYaml(changed))
  f.commit('change packaging after the accepted build')
  f.put(RELEASE_WORKFLOW, workflowSource)
  f.commit('restore packaging while adding publication opt-out')
  f.recordEvidence()
  f.verify(f.tagRelease(), /changes after the reviewed package/)
})

test('curated 0.5.6 publication notes can follow an accepted package', t => {
  const f = currentPolicyFixture(t, { exact: true })
  f.put('release/release-v0.5.6.md', '# RailWise AI 0.5.6\n\nVerified release capabilities.\n')
  f.commit('add publication notes outside the application file sets')
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.5/)
})

test('current rename release accepts original same-run native smoke without inventing a frozen receipt', t => {
  const f = currentPolicyFixture(t, { exact: true })
  f.manifest.release.updaterPathChanged = true
  const build = f.manifest.package.reviewedBuild
  f.machineReport.baseVersion = '0.5.4'
  f.machineReport.baselineIdentity.version = '0.5.4'
  f.machineReport.baselineAsset = { tag: 'v0.5.4', ...resolveUpdaterBaseline('0.5.4').pins.arm64 }
  f.machineReport.dataSeed.serviceIdentity.packageVersion = '0.5.4'
  f.nativeReport.baseVersion = '0.5.4'
  f.nativeReport.stages.at(-1).detail = '0.5.4'
  delete f.machineReport.reviewedBuild
  f.machineReport.privatePackage = { sourceHead: build.sourceHead, artifactRunId: build.runId, artifactName: 'release-mac', files: structuredClone(build.files.filter(file => file.artifact === 'release-mac')) }
  f.machineReport.provenance = { repository: build.repository, workflowPath: build.workflowPath, workflowRef: build.workflowRef,
    workflowSha: build.workflowSha, sourceHead: build.sourceHead, runId: build.runId, runAttempt: build.runAttempt, mode: 'private-exact-package-smoke' }
  f.manifest.acceptance.updaterRoundTrip = { status: 'passed', mode: 'exact-build', path: `${f.base}/native-smoke.md`, machineReportPath: `${f.base}/frozen-updater.json`, nativeReportPath: `${f.base}/native-updater.json`,
    workflowRun: { repository: build.repository, workflowPath: build.workflowPath, headRef: build.headRef, workflowRef: build.workflowRef,
      workflowSha: build.workflowSha, sourceHead: build.sourceHead, runId: build.runId, runAttempt: build.runAttempt,
      artifact: { id: 88, name: `exact-package-updater-${build.runId}`, digest: `sha256:${'d'.repeat(64)}` } } }
  f.recordEvidence()
  assert.match(f.verify(f.tagRelease()), /verified v0\.5\.5/)
})

test('required CI verifies actual API source, repository, run attempt and successful quality job', async t => {
  const root = `repos/${RELEASE_REPOSITORY}`
  const sourceHead = 'a'.repeat(40)
  const run = { repository: RELEASE_REPOSITORY, workflowPath: '.github/workflows/quality.yml', sourceHead, runId: 99, runAttempt: 1 }
  const fixture = () => {
    const job = { name: 'OpenSpec, brand, lint, type, test, build', conclusion: 'success' }
    const actual = { id: 99, run_attempt: 1, path: run.workflowPath, workflow_id: 11, head_sha: sourceHead, repository: { id: 22 }, head_repository: { id: 22 }, status: 'completed', conclusion: 'success' }
    const jobs = { total_count: 1, jobs: [job] }
    const responses = { [root]: { id: 22, full_name: RELEASE_REPOSITORY }, [`${root}/actions/workflows/quality.yml`]: { id: 11, path: run.workflowPath }, [`${root}/actions/runs/99`]: actual,
      [`${root}/actions/runs/99/attempts/1/jobs?per_page=100&page=1`]: jobs }
    return { actual, job, jobs, api: path => { assert.ok(responses[path], path); return responses[path] } }
  }
  const good = fixture()
  assert.equal(verifyRequiredCI(run, sourceHead, good.api), run)
  for (const [name, mutate] of Object.entries({ oldSource: f => { f.actual.head_sha = 'b'.repeat(40) }, fork: f => { f.actual.head_repository.id = 23 }, oldAttempt: f => { f.actual.run_attempt = 2 }, failed: f => { f.actual.conclusion = 'failure' }, skippedQuality: f => { f.job.conclusion = 'skipped' }, duplicate: f => { f.jobs.jobs.push(f.job); f.jobs.total_count += 1 } })) await t.test(name, () => {
    const f = fixture(); mutate(f); assert.throws(() => verifyRequiredCI(run, sourceHead, f.api))
  })
})
