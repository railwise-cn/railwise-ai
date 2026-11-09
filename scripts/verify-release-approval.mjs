#!/usr/bin/env node

/**
 * Verify the non-build release gates before a Stable publication.
 *
 * This check deliberately lives in the repository so the workflow cannot
 * treat a successful build as release approval. It requires a committed,
 * version-bound evidence manifest and an explicit confirmation for the exact
 * tag. The production environment's reviewer policy follows the repository's
 * authorized governance mode; this check never represents a human review.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { PUBLIC_IDENTITY, RELEASE_REPOSITORY, githubApi, validateReviewedBuild, verifyReviewedBuildSource } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256, validateUpdaterEvidenceRun, verifyRemoteUpdaterEvidence } from './verify-frozen-updater-evidence.mjs'
import { validateUpdaterServiceEvidence } from './frozen-release-updater-service-contract.mjs'
import { FROZEN_BASE_VERSION, resolveUpdaterBaseline } from './frozen-release-version.mjs'
import { validateExactUpdaterEvidenceRun, verifyRemoteExactUpdaterEvidence } from './verify-exact-updater-evidence.mjs'

const ROOT = process.cwd()

function fail(message) {
  throw new Error(`[release-gate] ${message}`)
}

function arg(name) {
  const prefix = `--${name}=`
  const value = process.argv.find(entry => entry.startsWith(prefix))
  return value ? value.slice(prefix.length) : ''
}

function statusOf(value) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.status === 'string') return value.status
  return ''
}

function requireStatus(value, label) {
  if (statusOf(value) !== 'passed') fail(`${label} must have status=passed`)
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// These files are not packaged, imported by the application or used to produce
// application bytes. A policy-only correction must not force another freeze.
// This is deliberately an exact allowlist, not a blanket scripts/ exception.
const PACKAGE_EXTERNAL_EVIDENCE_FILES = new Set([
  'scripts/verify-release-approval.mjs',
  'scripts/release-gate.test.mjs',
  'scripts/verify-reviewed-release-artifacts.mjs',
  'scripts/verify-reviewed-release-artifacts.test.mjs',
  'scripts/verify-exact-updater-evidence.mjs',
  'scripts/verify-exact-updater-evidence.test.mjs',
  'scripts/run-task-delivery-live.mjs',
  'scripts/macos-updater-trust.test.mjs',
  'docs/MIGRATION_RELEASE_IDENTITY.zh-CN.md',
  'openspec/changes/durable-task-document-workbench/tasks.md',
])

function requireReviewedSource(reviewedSourceHead, releaseHead, schemaVersion) {
  if (typeof reviewedSourceHead !== 'string' || !/^[0-9a-f]{40}$/.test(reviewedSourceHead)) {
    fail('release.sourceHead must be the 40-character lowercase commit of the reviewed package')
  }
  try {
    if (git(['rev-parse', '--verify', `${reviewedSourceHead}^{commit}`]).trim() !== reviewedSourceHead) throw new Error('not a commit')
  } catch {
    fail(`reviewed source commit cannot be resolved locally: ${reviewedSourceHead}`)
  }
  try {
    git(['merge-base', '--is-ancestor', reviewedSourceHead, releaseHead])
  } catch {
    fail('reviewed source commit must be an ancestor of the exact release tag')
  }

  // Evidence and the schema2 explicitly nonshipped policy/harness allowlist
  // may follow the package source. A runtime/build edit later reverted still
  // requires a new package. Inspect every parent diff, including merges.
  const commits = git(['rev-list', `${reviewedSourceHead}..${releaseHead}`]).trim().split('\n').filter(Boolean)
  for (const commit of commits) {
    const changes = git(['diff-tree', '--root', '-r', '-m', '--no-commit-id', '--name-only', '-z', '--no-renames', commit])
      .split('\0').filter(Boolean)
    const unreviewed = changes.find(path => !path.startsWith('docs/qa/') && !(schemaVersion === 2 && PACKAGE_EXTERNAL_EVIDENCE_FILES.has(path)))
    if (unreviewed) {
      fail(`changes after the reviewed package must be limited to docs/qa evidence: ${unreviewed} at ${commit}`)
    }
  }
  return reviewedSourceHead
}

export function classifyReleaseChanges(paths) {
  // Inspect production updater/download boundaries, not tests, acceptance
  // helpers or all release documentation. Explicit declarations may add a
  // reason, but cannot suppress a change detected here.
  const updater = paths.filter(path => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && (
    /^src\/main\/(?:gui-updater|release-assets|private-updater-tls)(?:[./-]|$)/.test(path)
    || /^(?:electron-builder\.cjs|src\/shared\/product-brand\.json)$/.test(path)
    || /^scripts\/(?:release-publication|publish-r2|generate-mac-latest|zip-mac-app|prepare-website-release-assets|deploy-website-release|verify-stable-feed-version)\.[cm]?[jt]s$/.test(path)
  ))
  const visual = paths.filter(path => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && (
    /^src\/renderer\//.test(path) || /^src\/asset\/(?:img|icons|styles)\//.test(path) || path === 'src/shared/product-brand.json'
  ))
  return { updater, visual }
}

function releaseChangeRequirements(manifest, reviewedSourceHead) {
  if (manifest.schemaVersion !== 2 && !manifest.release.previousTag) {
    if (!manifest.acceptance?.updaterRoundTrip) fail('legacy evidence omitting updater acceptance must identify release.previousTag for change detection')
    return { updater: true, visual: Boolean(manifest.acceptance?.uiComputerUse), changedPaths: [] }
  }
  const previousTag = manifest.release.previousTag
  if (!/^v\d+\.\d+\.\d+$/.test(previousTag ?? '') || previousTag === manifest.release.tag) fail('release.previousTag must identify the previous formal version')
  const previousParts = previousTag.slice(1).split('.').map(Number)
  const currentParts = manifest.release.version.split('.').map(Number)
  const different = currentParts.findIndex((value, index) => value !== previousParts[index])
  if (different < 0 || currentParts[different] < previousParts[different]) fail('release.previousTag must precede the target version')
  try { git(['merge-base', '--is-ancestor', `${previousTag}^{commit}`, reviewedSourceHead]) } catch { fail('previous formal version must resolve to an ancestor of the packaged source') }
  const changedPaths = git(['diff', '--name-only', '-z', '--no-renames', `${previousTag}^{commit}`, reviewedSourceHead]).split('\0').filter(Boolean)
  const detected = classifyReleaseChanges(changedPaths)
  return { updater: detected.updater.length > 0 || manifest.release.updaterPathChanged === true,
    visual: detected.visual.length > 0 || manifest.release.visualChange === true,
    changedPaths, detected, previousTag }
}

function verifyPreviousFormalRelease(previousTag, api = githubApi) {
  if (!previousTag) return
  const release = api(`repos/${RELEASE_REPOSITORY}/releases/tags/${previousTag}`)
  if (release.tag_name !== previousTag || release.draft !== false || release.prerelease !== false || !release.published_at) fail('release.previousTag must identify a published formal GitHub Release')
}

function resolveEvidencePath(input, tag) {
  const requested = input || `docs/qa/release-gates/${tag}.json`
  const expanded = requested.replaceAll('${tag}', tag).replaceAll('<tag>', tag)
  if (/[\r\n]/.test(expanded)) fail('release evidence path must not contain line breaks')
  if (isAbsolute(expanded)) fail('release evidence path must be repository-relative')
  const path = resolve(ROOT, expanded)
  const rel = relative(ROOT, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('release evidence path must stay inside the repository')
  if (!rel.startsWith('docs/qa/release-gates/')) {
    fail('release evidence path must be under docs/qa/release-gates/')
  }
  return { path, relativePath: rel }
}

function requireTrackedArtifact(value, label, releaseHead) {
  const candidate = typeof value === 'string' ? value : value?.path
  if (!candidate || typeof candidate !== 'string') fail(`${label} must provide a repository-relative path`)
  const { path, relativePath } = resolveEvidencePath(candidate, '')
  if (!existsSync(path)) fail(`${label} file does not exist: ${relativePath}`)
  ensureTracked(relativePath, releaseHead)
  return relativePath
}

function ensureTracked(relativePath, releaseHead) {
  try {
    const entry = git(['ls-tree', releaseHead, '--', relativePath]).trim()
    // A staged addition or a symlink to an unrelated file is not committed
    // acceptance evidence from the selected release tag.
    if (!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(entry)) throw new Error('not a committed regular file')
  } catch {
    fail(`release evidence must be a regular file committed in the exact release tag: ${relativePath}`)
  }
}

function readCommittedJson(relativePath, releaseHead, label) {
  try {
    return JSON.parse(git(['show', `${releaseHead}:${relativePath}`]))
  } catch (error) {
    fail(`${label} is not valid committed JSON: ${error.message}`)
  }
}

function requireUpdaterEvidence(evidence, reviewedBuild, packageIdentity, version, releaseHead) {
  const exactBuild = evidence.mode === 'exact-build'
  const baseVersion = exactBuild ? '0.5.4' : FROZEN_BASE_VERSION
  const baseline = resolveUpdaterBaseline(baseVersion)
  // A prose summary or a green declaration cannot substitute for the native
  // runner's two reports, bound to the exact frozen public package bytes.
  const machinePath = requireTrackedArtifact(evidence?.machineReportPath, 'acceptance.updaterRoundTrip.machineReportPath', releaseHead)
  const nativePath = requireTrackedArtifact(evidence?.nativeReportPath, 'acceptance.updaterRoundTrip.nativeReportPath', releaseHead)
  const machine = readCommittedJson(machinePath, releaseHead, 'frozen updater machine report')
  const native = readCommittedJson(nativePath, releaseHead, 'native updater report')
  const machineBytes = execFileSync('git', ['show', `${releaseHead}:${machinePath}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const nativeBytes = execFileSync('git', ['show', `${releaseHead}:${nativePath}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  const equal = (actual, expected, label) => { if (!isDeepStrictEqual(actual, expected)) fail(`updater evidence ${label} mismatch`) }
  const sha256 = (value, label) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`updater evidence ${label} must be a lowercase SHA256`) }
  equal(machine.schemaVersion, 1, 'machine schema')
  equal(machine.status, 'passed', 'machine status')
  equal(machine.platform, 'darwin', 'machine platform')
  if (!['arm64', 'x64'].includes(machine.arch)) fail('updater evidence must identify a supported native macOS architecture')
  equal(machine.baseVersion, baseVersion, 'official baseline version')
  equal(machine.targetVersion, version, 'frozen target version')
  for (const key of ['productionTouched', 'systemTrustModified', 'officialFeedsModified', 'publicReleasePerformed']) equal(machine[key], false, key)
  if (machine.failure) fail('updater evidence retains an acceptance or cleanup failure')
  if (exactBuild) {
    if (reviewedBuild.mode !== 'exact-build') fail('raw exact updater evidence requires exact-build package provenance')
    equal(machine.privatePackage, { sourceHead: reviewedBuild.sourceHead, artifactRunId: reviewedBuild.runId,
      artifactName: 'release-mac', files: reviewedBuild.files.filter(file => file.artifact === 'release-mac') }, 'same-run package files, hashes and sizes')
  } else equal(machine.reviewedBuild, reviewedBuild, 'reviewed build run, attempt, source and artifacts')

  const baselinePin = baseline.pins[machine.arch]
  equal(machine.baselineAsset, { tag: `v${baseVersion}`, ...baselinePin }, 'pinned official installer')
  const zip = reviewedBuild.files.find(file => file.name.endsWith(`-${version}-mac-${machine.arch}.zip`))
  const manifest = reviewedBuild.files.find(file => file.name === 'latest-mac.yml')
  equal(machine.targetZipSha256, zip?.sha256, 'exact frozen updater ZIP')
  equal(machine.frozenManifestSha256, manifest?.sha256, 'exact frozen update manifest')
  for (const [name, expectedVersion] of [['baselineIdentity', baseVersion], ['targetIdentity', version], ['installedIdentity', version]]) {
    const identity = machine[name]
    equal(identity?.version, expectedVersion, `${name} version`)
    equal(identity?.bundleId, PUBLIC_IDENTITY.bundleId, `${name} public identity`)
    equal(identity?.signature, 'verified', `${name} signature`)
    equal(identity?.stapledNotarization, 'verified', `${name} notarization`)
    equal(identity?.gatekeeper, 'accepted', `${name} Gatekeeper`)
    equal(identity?.gatekeeperAssessments, 'enabled', `${name} Gatekeeper status`)
    equal(identity?.gatekeeperSource, 'Notarized Developer ID', `${name} Gatekeeper source`)
    if (typeof identity?.designatedRequirement !== 'string' || !identity.designatedRequirement.startsWith('designated => ')) fail(`updater evidence ${name} signing requirement is missing`)
    equal(identity.designatedRequirement, machine.baselineIdentity.designatedRequirement, `${name} signing requirement`)
  }
  sha256(machine.targetAsarSha256, 'target ASAR')
  equal(machine.targetAsarSha256, packageIdentity.asarSha256, 'UI-reviewed/frozen ASAR')
  equal(machine.installedAsarSha256, machine.targetAsarSha256, 'installed/frozen ASAR')
  equal(machine.strictNonceProbe?.strictProbeRequired, true, 'strict nonce probe')
  sha256(machine.strictNonceProbe?.nonceSha256, 'strict nonce digest')
  equal(machine.separateSentinelPreserved, true, 'independent user-data sentinel')
  for (const [key, mode] of [['dataSeed', 'seed'], ['dataReadback', 'verify'], ['dataRestartReadback', 'verify']]) {
    const data = machine[key]
    equal(data?.schemaVersion, 1, `${key} schema`)
    equal(data?.status, 'passed', `${key} status`)
    equal(data?.mode, mode, `${key} mode`)
    for (const count of ['projects', 'networks', 'adjustments', 'monitoringDatasets']) equal(data?.[count], 1, `${key} ${count}`)
    sha256(data?.sourceSha256, `${key} original source`)
    equal(data.sourceSha256, machine.dataSeed.sourceSha256, `${key} original source continuity`)
  }
  validateUpdaterServiceEvidence(machine, { sourceHead: reviewedBuild.sourceHead, version, baseVersion })
  equal(machine.configReferences?.status, 'byte-preserved', 'configuration reference preservation')
  if (!Number.isSafeInteger(machine.feedRequests?.manifest) || machine.feedRequests.manifest < 1
    || !Number.isSafeInteger(machine.feedRequests?.zip) || machine.feedRequests.zip < 1
    || !Number.isSafeInteger(machine.feedRequests?.bytesServed) || machine.feedRequests.bytesServed < zip.size) fail('updater evidence does not prove the actual manifest and complete ZIP were served')
  const completed = machine.steps?.filter(step => step.operation === 'real-native-update-and-historical-readback' && step.status === 'completed')
  if (completed?.length !== 1 || machine.steps?.at(-1)?.operation !== 'owned-resource-cleanup' || machine.steps.at(-1).status !== 'completed') fail('updater evidence must complete historical readback and owned-resource cleanup')

  equal(native.schemaVersion, 1, 'native schema')
  equal(native.status, 'passed', 'native status')
  equal(native.platform, machine.platform, 'native platform')
  equal(native.arch, machine.arch, 'native architecture')
  equal(native.baseVersion, baseVersion, 'native official baseline')
  equal(native.targetVersion, version, 'native frozen target')
  equal(native.browserOpened, false, 'native path without browser fallback')
  equal(native.userDataPreserved, true, 'native user-data preservation')
  equal(native.stages?.map(stage => stage.name), ['base_started', 'update_available', 'download_completed', 'install_requested', 'target_relaunched', 'user_data_preserved'], 'complete native stages')
  equal(native.stages.at(-1).detail, baseVersion, 'strict historical nonce proof')
  if (native.failure) fail('native updater evidence retains a failure')
  equal(reportSha256(nativeBytes), machine.nativeReportSha256, 'retained native report digest')
  const run = exactBuild
    ? validateExactUpdaterEvidenceRun(evidence.workflowRun, machine, reviewedBuild, version)
    : validateUpdaterEvidenceRun(evidence.workflowRun, machine, reviewedBuild.sourceHead, version)
  return { run, machineBytes, nativeBytes, mode: exactBuild ? 'exact-build' : 'frozen-public-release' }
}

const QUALITY_WORKFLOW = '.github/workflows/quality.yml'
const QUALITY_JOB = 'OpenSpec, brand, lint, type, test, build'

function requireVersionedCheck(value, label, sourceHead, releaseHead) {
  requireStatus(value, label)
  requireTrackedArtifact(value, label, releaseHead)
  if (value.sourceHead !== sourceHead) fail(`${label}.sourceHead must identify the exact packaged source`)
}

function requireCompatibleCheckSource(value, label, packagedSourceHead, releaseHead) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) fail(`${label} must identify a real source commit`)
  // CI may cover a later correction to this verifier or a nonshipped harness.
  // Both halves of the ancestry must still contain no application/build edit.
  requireReviewedSource(packagedSourceHead, value, 2)
  requireReviewedSource(value, releaseHead, 2)
}

export function verifyRequiredCI(run, sourceHead, api = githubApi) {
  if (!run || typeof run !== 'object') fail('checks.requiredCI.workflowRun is required')
  if (!/^[a-f0-9]{40}$/.test(sourceHead ?? '') || run.repository !== RELEASE_REPOSITORY || run.workflowPath !== QUALITY_WORKFLOW || run.sourceHead !== sourceHead
    || !Number.isSafeInteger(run.runId) || run.runId < 1 || !Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1) fail('required CI provenance does not identify the packaged source')
  const root = `repos/${RELEASE_REPOSITORY}`
  const repository = api(root)
  const workflow = api(`${root}/actions/workflows/quality.yml`)
  const actual = api(`${root}/actions/runs/${run.runId}`)
  if (!Number.isSafeInteger(repository.id) || repository.id < 1 || !Number.isSafeInteger(workflow.id) || workflow.id < 1
    || repository.full_name !== RELEASE_REPOSITORY || workflow.path !== QUALITY_WORKFLOW || actual.workflow_id !== workflow.id || actual.path !== QUALITY_WORKFLOW
    || actual.repository?.id !== repository.id || actual.head_repository?.id !== repository.id || actual.head_sha !== sourceHead
    || actual.id !== run.runId || actual.run_attempt !== run.runAttempt || actual.status !== 'completed' || actual.conclusion !== 'success') fail('required CI run did not pass for the exact packaged source and repository')
  const jobs = []
  for (let page = 1; ; page += 1) {
    const result = api(`${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs?per_page=100&page=${page}`)
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count < 1 || result.total_count > 1000) fail('invalid required CI jobs response')
    jobs.push(...result.jobs)
    if (jobs.length >= result.total_count) break
    if (!result.jobs.length) fail('incomplete required CI jobs response')
  }
  const quality = jobs.filter(job => job.name === QUALITY_JOB)
  if (quality.length !== 1 || quality[0].conclusion !== 'success') fail('required CI quality/type/test/production-build job must succeed exactly once')
  // The source-bound workflow owns its relevant test matrix. Requiring its
  // actual successful result avoids introducing another hand-maintained matrix.
  return run
}

export function verifyReleaseApproval({
  tag = process.env.GITHUB_REF_NAME || '',
  refType = process.env.GITHUB_REF_TYPE || '',
  sourceHead = process.env.GITHUB_SHA || '',
  confirmation = process.env.RELEASE_CONFIRMATION || '',
  evidence = process.env.RELEASE_EVIDENCE || '',
} = {}) {
  if (refType !== 'tag') fail(`Stable publication must run from an exact tag; ref_type=${refType || '(missing)'}`)
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`tag must match vX.Y.Z exactly: ${tag || '(missing)'}`)
  if (confirmation !== `PUBLISH-STABLE-${tag}`) {
    fail(`release confirmation must be PUBLISH-STABLE-${tag}`)
  }
  if (!/^[0-9a-f]{40}$/i.test(sourceHead)) fail('GITHUB_SHA must be the 40-character commit targeted by the tag')
  let resolvedTagCommit
  try {
    resolvedTagCommit = git(['rev-list', '-n', '1', tag]).trim()
  } catch {
    fail(`release tag cannot be resolved locally: ${tag}`)
  }
  if (resolvedTagCommit !== sourceHead) {
    fail(`GITHUB_SHA ${sourceHead} does not match commit ${resolvedTagCommit} resolved from ${tag}`)
  }

  const version = tag.slice(1)
  const { path: evidencePath, relativePath } = resolveEvidencePath(evidence, tag)
  if (!existsSync(evidencePath)) fail(`release evidence file does not exist: ${relativePath}`)
  ensureTracked(relativePath, sourceHead)
  const manifest = readCommittedJson(relativePath, sourceHead, 'release evidence')

  if (![1, 2].includes(manifest.schemaVersion)) fail('release evidence schemaVersion must be 1 or 2')
  if (manifest.scope !== 'public-release') fail('release evidence scope must be public-release')
  requireStatus(manifest.status, 'release evidence')

  const release = manifest.release
  if (!release || release.tag !== tag || release.version !== version) {
    fail('release evidence must bind release.tag and release.version to this run')
  }
  const reviewedSourceHead = requireReviewedSource(release.sourceHead, sourceHead, manifest.schemaVersion)

  const packageEvidence = manifest.package
  if (!packageEvidence || packageEvidence.version !== version) {
    fail('release evidence package.version must match the tagged package')
  }
  const packageIdentity = packageEvidence.identity
  if (!packageIdentity || typeof packageIdentity !== 'object' ||
      packageIdentity.bundleId !== PUBLIC_IDENTITY.bundleId ||
      typeof packageIdentity.artifactSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(packageIdentity.artifactSha256) ||
      typeof packageIdentity.asarSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(packageIdentity.asarSha256)) {
    fail('release evidence package.identity must include the public bundleId, a 64-character artifactSha256 and lowercase asarSha256 from the installed UI-reviewed application')
  }
  const reviewedBuild = validateReviewedBuild(packageEvidence.reviewedBuild, { version, sourceHead: reviewedSourceHead })
  const packageJson = readCommittedJson('package.json', sourceHead, 'package.json')
  if (manifest.schemaVersion === 1 || reviewedBuild.mode !== 'exact-build') {
    if (packageJson.version !== version) fail(`package.json version ${packageJson.version} does not match ${tag}`)
  } else {
    const sourcePackage = readCommittedJson('package.json', reviewedSourceHead, 'packaged source package.json')
    if (packageEvidence.sourceVersion !== sourcePackage.version || packageJson.version !== sourcePackage.version
      || packageEvidence.buildVersion !== version) fail('exact-build sourceVersion/buildVersion must match the unchanged source package and effective release version')
    const metadata = packageEvidence.installedMetadata
    if (metadata?.version !== version || metadata.sourceHead !== reviewedSourceHead || metadata.packageName !== PUBLIC_IDENTITY.packageName
      || metadata.productName !== PUBLIC_IDENTITY.productName || metadata.asarSha256 !== packageIdentity.asarSha256) fail('exact-build installedMetadata must identify the actual effective version, source, public identity and ASAR')
    if (sourcePackage.version !== version) {
      const override = packageEvidence.versionOverride
      if (override?.environmentVariable !== 'WORKWISE_APP_VERSION' || override.value !== version || override.sourceHead !== reviewedSourceHead) fail('exact-build effective version requires the existing WORKWISE_APP_VERSION override provenance')
      const sourceWorkflow = git(['show', `${reviewedSourceHead}:.github/workflows/release.yml`])
      const sourceBuilder = git(['show', `${reviewedSourceHead}:electron-builder.cjs`])
      if (!/WORKWISE_APP_VERSION:\s*\$\{\{\s*needs\.prepare\.outputs\.version\s*\}\}/.test(sourceWorkflow)
        || !/process\.env\.WORKWISE_APP_VERSION/.test(sourceBuilder) || !/version:\s*releaseAppVersion/.test(sourceBuilder)) fail('packaged source does not contain the recorded release version override')
    }
  }
  if (!reviewedBuild.files.some(file => file.sha256 === packageIdentity.artifactSha256 && /\.(dmg|zip|exe)$/.test(file.name))) {
    fail('installed package identity hash must identify a reviewed installer or updater artifact')
  }
  requireStatus(packageEvidence.signature, 'package.signature')
  requireStatus(packageEvidence.notarization, 'package.notarization')
  if (packageEvidence.screenshots !== undefined && !Array.isArray(packageEvidence.screenshots)) fail('package.screenshots must be an array when supplied')
  ;(packageEvidence.screenshots ?? []).forEach((screenshot, index) => {
    requireTrackedArtifact(screenshot, `package.screenshots[${index}]`, sourceHead)
  })

  const acceptance = manifest.acceptance
  if (!acceptance || typeof acceptance !== 'object') fail('release evidence acceptance section is required')
  const requirements = releaseChangeRequirements(manifest, reviewedSourceHead)
  if (manifest.schemaVersion === 2) {
    const checks = manifest.checks
    if (!checks || typeof checks !== 'object') fail('schema2 checks are required')
    requireVersionedCheck(checks.productionBuild, 'checks.productionBuild', reviewedSourceHead, sourceHead)
    requireStatus(checks.focusedTests, 'checks.focusedTests')
    requireTrackedArtifact(checks.focusedTests, 'checks.focusedTests', sourceHead)
    requireCompatibleCheckSource(checks.focusedTests.sourceHead, 'checks.focusedTests.sourceHead', reviewedSourceHead, sourceHead)
    requireStatus(checks.requiredCI, 'checks.requiredCI')
    const ci = checks.requiredCI.workflowRun
    if (!ci || ci.repository !== RELEASE_REPOSITORY || ci.workflowPath !== QUALITY_WORKFLOW
      || !Number.isSafeInteger(ci.runId) || ci.runId < 1 || !Number.isSafeInteger(ci.runAttempt) || ci.runAttempt < 1) fail('checks.requiredCI.workflowRun must bind the packaged source to its Quality run')
    requireCompatibleCheckSource(ci.sourceHead, 'checks.requiredCI.workflowRun.sourceHead', reviewedSourceHead, sourceHead)
    requireVersionedCheck(acceptance.installedPackage, 'acceptance.installedPackage', reviewedSourceHead, sourceHead)
    if (requirements.visual) {
      const ui = acceptance.packagedUI ?? acceptance.uiComputerUse
      requireVersionedCheck(ui, 'acceptance.packagedUI', reviewedSourceHead, sourceHead)
    }
  }
  for (const key of ['functionalChecklist', 'uiComputerUse', 'packagedUI', 'updaterRoundTrip']) {
    if (acceptance[key] !== undefined) {
      requireStatus(acceptance[key], `acceptance.${key}`)
      requireTrackedArtifact(acceptance[key], `acceptance.${key}`, sourceHead)
    }
  }
  if (requirements.updater && !acceptance.updaterRoundTrip) fail('this release changes updater/download paths and requires one exact-package updater smoke')
  const updaterEvidence = acceptance.updaterRoundTrip
    ? requireUpdaterEvidence(acceptance.updaterRoundTrip, reviewedBuild, packageIdentity, version, sourceHead)
    : null
  const independentReview = acceptance.independentSeniorEngineerReview
  if (independentReview !== undefined) {
    requireStatus(independentReview, 'acceptance.independentSeniorEngineerReview')
    const reviewerLabel = typeof independentReview === 'object'
      ? `${independentReview.reviewerType || ''} ${independentReview.reviewRole || ''}` : ''
    if (!/ai|agent|simulat/i.test(reviewerLabel)) fail('independentSeniorEngineerReview must identify itself as AI/agent review when supplied')
    requireTrackedArtifact(independentReview, 'acceptance.independentSeniorEngineerReview', sourceHead)
  }
  return { tag, version, sourceHead, reviewedSourceHead, evidence: relativePath, reviewedBuild, updaterEvidence,
    requiredCI: manifest.schemaVersion === 2 ? manifest.checks.requiredCI.workflowRun : null, requirements }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyReleaseApproval({
      tag: process.env.GITHUB_REF_NAME || arg('tag'),
      refType: process.env.GITHUB_REF_TYPE || arg('ref-type'),
      sourceHead: process.env.GITHUB_SHA || arg('source-head'),
      confirmation: process.env.RELEASE_CONFIRMATION || arg('confirmation'),
      evidence: process.env.RELEASE_EVIDENCE || arg('evidence'),
    })
    // This cannot be disabled in Actions. Unit fixtures can exercise the pure
    // local evidence checks without network access; production always checks GitHub.
    if (process.env.GITHUB_ACTIONS === 'true' || process.argv.includes('--verify-source')) {
      verifyReviewedBuildSource(result.reviewedBuild, { version: result.version, sourceHead: result.reviewedSourceHead,
        requiredSourceJobs: result.reviewedBuild.mode === 'exact-build'
          ? ['Private exact-package Windows install smoke', ...(result.requirements.updater ? ['Private exact-package updater smoke'] : [])] : [] })
      if (result.requiredCI) verifyRequiredCI(result.requiredCI, result.requiredCI.sourceHead)
      verifyPreviousFormalRelease(result.requirements.previousTag)
      if (result.updaterEvidence?.mode === 'exact-build') verifyRemoteExactUpdaterEvidence(result.updaterEvidence)
      else if (result.updaterEvidence) verifyRemoteUpdaterEvidence(result.updaterEvidence)
    } else if (process.env.GITHUB_OUTPUT) {
      fail('workflow outputs require authenticated GitHub provenance verification')
    }
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, [
        `artifact_run_id=${result.reviewedBuild.runId}`,
        `artifact_ids=${result.reviewedBuild.artifacts.map(artifact => artifact.id).join(',')}`,
        `artifact_repository=${result.reviewedBuild.repository}`,
        `evidence_path=${result.evidence}`,
      ].join('\n') + '\n')
    }
    console.log(`[release-gate] verified ${result.tag} at ${result.sourceHead}; reviewed source ${result.reviewedSourceHead}; evidence ${result.evidence}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
