#!/usr/bin/env node

/**
 * Verify the non-build release gates before a Stable publication.
 *
 * This check deliberately lives in the repository so the workflow cannot
 * treat a successful build as release approval. It requires a committed,
 * version-bound evidence manifest and an explicit confirmation for the exact
 * tag. GitHub's protected `production-release` environment supplies the
 * independent human approval after this job passes.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { PUBLIC_IDENTITY, validateReviewedBuild, verifyReviewedBuildSource } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256, validateUpdaterEvidenceRun, verifyRemoteUpdaterEvidence } from './verify-frozen-updater-evidence.mjs'

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

function requireReviewedSource(reviewedSourceHead, releaseHead) {
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

  // Evidence is recorded after inspecting a frozen package. Only QA records
  // may follow that source commit; even a runtime edit later reverted requires
  // a fresh package review. Inspect every parent diff, including merge commits.
  const commits = git(['rev-list', `${reviewedSourceHead}..${releaseHead}`]).trim().split('\n').filter(Boolean)
  for (const commit of commits) {
    const changes = git(['diff-tree', '--root', '-r', '-m', '--no-commit-id', '--name-only', '-z', '--no-renames', commit])
      .split('\0').filter(Boolean)
    const unreviewed = changes.find(path => !path.startsWith('docs/qa/'))
    if (unreviewed) {
      fail(`changes after the reviewed package must be limited to docs/qa evidence: ${unreviewed} at ${commit}`)
    }
  }
  return reviewedSourceHead
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

function requireFrozenUpdaterEvidence(evidence, reviewedBuild, packageIdentity, version, releaseHead) {
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
  equal(machine.baseVersion, '0.5.2', 'official baseline version')
  equal(machine.targetVersion, version, 'frozen target version')
  for (const key of ['productionTouched', 'systemTrustModified', 'officialFeedsModified', 'publicReleasePerformed']) equal(machine[key], false, key)
  if (machine.failure) fail('updater evidence retains an acceptance or cleanup failure')
  equal(machine.reviewedBuild, reviewedBuild, 'reviewed build run, attempt, source and artifacts')

  const baselinePin = machine.arch === 'arm64'
    ? { name: 'WorkWise-0.5.2-mac-Apple-Silicon.dmg', size: 301766076, sha256: '09dae4a270bbf06fb3fc79771eef3faa2afaba43eea9e6696762fa7ba5cf99e0', assetId: 612608487 }
    : { name: 'WorkWise-0.5.2-mac-Intel.dmg', size: 306711696, sha256: '8368322a563871e00e6e9ac99b661bf0ee120a20d48f8ebd3e105209cdba20d4', assetId: 612608490 }
  equal(machine.baselineAsset, { tag: 'v0.5.2', ...baselinePin }, 'pinned official installer')
  const zip = reviewedBuild.files.find(file => file.name === `WorkWise-${version}-mac-${machine.arch}.zip`)
  const manifest = reviewedBuild.files.find(file => file.name === 'latest-mac.yml')
  equal(machine.targetZipSha256, zip?.sha256, 'exact frozen updater ZIP')
  equal(machine.frozenManifestSha256, manifest?.sha256, 'exact frozen update manifest')
  for (const [name, expectedVersion] of [['baselineIdentity', '0.5.2'], ['targetIdentity', version], ['installedIdentity', version]]) {
    const identity = machine[name]
    equal(identity?.version, expectedVersion, `${name} version`)
    equal(identity?.bundleId, PUBLIC_IDENTITY.bundleId, `${name} public identity`)
    equal(identity?.signature, 'verified', `${name} signature`)
    equal(identity?.stapledNotarization, 'verified', `${name} notarization`)
    equal(identity?.gatekeeper, 'accepted', `${name} Gatekeeper`)
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
  equal(native.baseVersion, '0.5.2', 'native official baseline')
  equal(native.targetVersion, version, 'native frozen target')
  equal(native.browserOpened, false, 'native path without browser fallback')
  equal(native.userDataPreserved, true, 'native user-data preservation')
  equal(native.stages?.map(stage => stage.name), ['base_started', 'update_available', 'download_completed', 'install_requested', 'target_relaunched', 'user_data_preserved'], 'complete native stages')
  equal(native.stages.at(-1).detail, '0.5.2', 'strict historical nonce proof')
  if (native.failure) fail('native updater evidence retains a failure')
  equal(reportSha256(nativeBytes), machine.nativeReportSha256, 'retained native report digest')
  const run = validateUpdaterEvidenceRun(evidence.workflowRun, machine, reviewedBuild.sourceHead)
  return { run, machineBytes, nativeBytes }
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
  const packageJson = readCommittedJson('package.json', sourceHead, 'package.json')
  if (packageJson.version !== version) {
    fail(`package.json version ${packageJson.version} does not match ${tag}`)
  }

  const { path: evidencePath, relativePath } = resolveEvidencePath(evidence, tag)
  if (!existsSync(evidencePath)) fail(`release evidence file does not exist: ${relativePath}`)
  ensureTracked(relativePath, sourceHead)
  const manifest = readCommittedJson(relativePath, sourceHead, 'release evidence')

  if (manifest.schemaVersion !== 1) fail('release evidence schemaVersion must be 1')
  if (manifest.scope !== 'public-release') fail('release evidence scope must be public-release')
  requireStatus(manifest.status, 'release evidence')

  const release = manifest.release
  if (!release || release.tag !== tag || release.version !== version) {
    fail('release evidence must bind release.tag and release.version to this run')
  }
  const reviewedSourceHead = requireReviewedSource(release.sourceHead, sourceHead)

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
  if (!reviewedBuild.files.some(file => file.sha256 === packageIdentity.artifactSha256 && /\.(dmg|zip|exe)$/.test(file.name))) {
    fail('installed package identity hash must identify a reviewed installer or updater artifact')
  }
  requireStatus(packageEvidence.signature, 'package.signature')
  requireStatus(packageEvidence.notarization, 'package.notarization')
  if (!Array.isArray(packageEvidence.screenshots) || packageEvidence.screenshots.length === 0) {
    fail('release evidence must list screenshots from the installed package review')
  }
  packageEvidence.screenshots.forEach((screenshot, index) => {
    requireTrackedArtifact(screenshot, `package.screenshots[${index}]`, sourceHead)
  })

  const acceptance = manifest.acceptance
  if (!acceptance || typeof acceptance !== 'object') fail('release evidence acceptance section is required')
  for (const key of ['functionalChecklist', 'uiComputerUse', 'updaterRoundTrip']) {
    requireStatus(acceptance[key], `acceptance.${key}`)
    requireTrackedArtifact(acceptance[key], `acceptance.${key}`, sourceHead)
  }
  const updaterEvidence = requireFrozenUpdaterEvidence(acceptance.updaterRoundTrip, reviewedBuild, packageIdentity, version, sourceHead)
  const independentReview = acceptance.independentSeniorEngineerReview
  requireStatus(independentReview, 'acceptance.independentSeniorEngineerReview')
  const reviewerLabel = typeof independentReview === 'object'
    ? `${independentReview.reviewerType || ''} ${independentReview.reviewRole || ''}`
    : ''
  if (!/ai|agent|simulat/i.test(reviewerLabel)) {
    fail('independentSeniorEngineerReview must identify the required AI/agent senior-engineer review')
  }
  requireTrackedArtifact(independentReview, 'acceptance.independentSeniorEngineerReview', sourceHead)

  return { tag, version, sourceHead, reviewedSourceHead, evidence: relativePath, reviewedBuild, updaterEvidence }
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
      verifyReviewedBuildSource(result.reviewedBuild, { version: result.version, sourceHead: result.reviewedSourceHead })
      verifyRemoteUpdaterEvidence(result.updaterEvidence)
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
