#!/usr/bin/env node

// Freeze public-identity packages privately, then publish only the reviewed bytes.
// A successful build is provenance, not UI/updater acceptance or release approval.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASE_REPOSITORY = 'railwise-cn/railwise-ai'
export const RELEASE_WORKFLOW = '.github/workflows/release.yml'
export const RELEASE_WORKFLOW_REF = `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/main`
export const PUBLIC_IDENTITY = Object.freeze({ bundleId: 'com.wangjiawei508.workgpt', packageName: 'workwise', productName: 'RailWise AI' })
const RECEIPT = 'reviewed-build.json'
const RECORD_STEP = 'Record frozen public package identity'
const ARTIFACT_NAMES = ['release-mac', 'release-win']
const require = createRequire(import.meta.url)

function fail(message) { throw new Error(`[reviewed-artifacts] ${message}`) }
function equal(actual, expected, label) { if (actual !== expected) fail(`${label} mismatch: expected ${expected}, received ${actual}`) }
function positive(value, label) { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`) }
function exactSet(actual, expected, label) {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some(value => !actual.includes(value))) {
    fail(`${label} has missing, duplicate or extra entries`)
  }
}
export function validatePublicIdentity(identity) {
  for (const [key, value] of Object.entries(PUBLIC_IDENTITY)) equal(identity?.[key], value, `public package ${key}`)
}

export function expectedReleaseFiles(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('invalid public version')
  return [
    ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(extension => ({ name: `WorkWise-${version}-mac-${arch}.${extension}`, platform: `darwin-${arch}`, artifact: 'release-mac' }))),
    { name: 'latest-mac.yml', platform: 'darwin', artifact: 'release-mac' },
    { name: `WorkWise-${version}-win-x64.exe`, platform: 'win32-x64', artifact: 'release-win' },
    { name: `WorkWise-${version}-win-x64.exe.blockmap`, platform: 'win32-x64', artifact: 'release-win' },
    { name: 'latest.yml', platform: 'win32-x64', artifact: 'release-win' },
  ]
}

export function validateFileManifest(files, expected) {
  if (!Array.isArray(files)) fail('file manifest is required')
  exactSet(files.map(file => file?.name), expected.map(file => file.name), 'release file manifest')
  for (const file of files) {
    const target = expected.find(entry => entry.name === file.name)
    equal(file.platform, target.platform, `${file.name} platform`)
    equal(file.artifact, target.artifact, `${file.name} artifact`)
    positive(file.size, `${file.name} size`)
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) fail(`${file.name} requires a lowercase SHA256`)
  }
}

export function validateReviewedBuild(build, { version, sourceHead }) {
  if (!build || typeof build !== 'object') fail('package.reviewedBuild is required')
  equal(build.repository, RELEASE_REPOSITORY, 'source repository')
  equal(build.workflowPath, RELEASE_WORKFLOW, 'source workflow')
  equal(build.sourceHead, sourceHead, 'reviewed source HEAD')
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) fail('invalid source HEAD')
  positive(build.runId, 'source run ID')
  positive(build.runAttempt, 'source run attempt')
  validatePublicIdentity(build.publicIdentity)
  if (!Array.isArray(build.artifacts)) fail('immutable artifact IDs are required')
  exactSet(build.artifacts.map(artifact => artifact?.name), ARTIFACT_NAMES, 'source artifacts')
  exactSet(build.artifacts.map(artifact => artifact?.id), [...new Set(build.artifacts.map(artifact => artifact?.id))], 'artifact IDs')
  for (const artifact of build.artifacts) {
    positive(artifact.id, 'artifact ID')
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) fail('immutable artifact digest is required')
  }
  validateFileManifest(build.files, expectedReleaseFiles(version))
  return build
}

export function githubApi(path) {
  // Never infer the repository or host from local gh configuration/remotes.
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }))
}

export function verifyReviewedBuildSource(build, expected, api = githubApi) {
  validateReviewedBuild(build, expected)
  const root = `repos/${RELEASE_REPOSITORY}`
  const repository = api(root)
  const workflow = api(`${root}/actions/workflows/release.yml`)
  const run = api(`${root}/actions/runs/${build.runId}`)
  equal(repository.full_name, RELEASE_REPOSITORY, 'API repository')
  equal(workflow.path, RELEASE_WORKFLOW, 'trusted workflow path')
  equal(run.workflow_id, workflow.id, 'trusted workflow ID')
  equal(run.path, RELEASE_WORKFLOW, 'run workflow path')
  equal(run.repository?.id, repository.id, 'run repository ID')
  equal(run.head_repository?.id, repository.id, 'run head repository ID')
  equal(run.head_branch, 'main', 'run protected head branch')
  equal(run.workflow_ref, RELEASE_WORKFLOW_REF, 'run protected workflow ref')
  equal(run.head_sha, build.sourceHead, 'run source HEAD')
  equal(run.event, 'workflow_dispatch', 'run event')
  equal(run.status, 'completed', 'source run status')
  equal(run.conclusion, 'success', 'source run conclusion')
  equal(run.run_attempt, build.runAttempt, 'source run attempt')
  equal(run.id, build.runId, 'source run ID')
  const jobs = []
  for (let page = 1; ; page += 1) {
    const result = api(`${root}/actions/runs/${build.runId}/attempts/${build.runAttempt}/jobs?per_page=100&page=${page}`)
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count > 1000) fail('invalid source jobs response')
    jobs.push(...result.jobs)
    if (jobs.length >= result.total_count) break
    if (result.jobs.length === 0) fail('incomplete source jobs response')
  }
  for (const name of ['Build macOS', 'Build Windows', 'Two-hour pre-release stability', 'Verify three-client candidate', 'Verify final candidate on macOS']) {
    const matches = jobs.filter(job => job.name === name)
    if (matches.length !== 1 || matches[0].conclusion !== 'success') fail(`trusted source job must succeed exactly once: ${name}`)
    if (name.startsWith('Build ')) {
      const steps = matches[0].steps?.filter(step => step.name === RECORD_STEP) ?? []
      if (steps.length !== 1 || steps[0].conclusion !== 'success') fail(`${name} did not freeze candidate_only public-identity packages`)
    }
  }
  for (const artifact of build.artifacts) {
    const actual = api(`${root}/actions/artifacts/${artifact.id}`)
    equal(actual.id, artifact.id, 'immutable artifact ID')
    equal(actual.name, artifact.name, 'immutable artifact name')
    equal(actual.digest, artifact.digest, 'immutable artifact digest')
    equal(actual.expired, false, 'immutable artifact expiry')
    equal(actual.workflow_run?.id, build.runId, 'artifact run ID')
    if (actual.workflow_run?.run_attempt !== undefined) equal(actual.workflow_run.run_attempt, build.runAttempt, 'artifact run attempt')
    equal(actual.workflow_run?.head_sha, build.sourceHead, 'artifact source HEAD')
    equal(actual.workflow_run?.repository_id, repository.id, 'artifact repository ID')
    equal(actual.workflow_run?.head_repository_id, repository.id, 'artifact head repository ID')
  }
  return build
}

async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const data of createReadStream(path)) hash.update(data)
  return hash.digest('hex')
}

function plainFile(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`not a regular release file: ${path}`)
  return stat
}

function inspectPackagedIdentity(app, platform, version, sourceHead) {
  const resources = platform.startsWith('darwin') ? join(app, 'Contents', 'Resources') : join(app, 'resources')
  const metadata = JSON.parse(require('@electron/asar').extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8'))
  const updater = require('yaml').parse(readFileSync(join(resources, 'app-update.yml'), 'utf8'))
  const config = require(resolve('electron-builder.cjs'))
  const identity = { bundleId: config.appId, packageName: metadata.name, productName: metadata.productName }
  if (platform.startsWith('darwin')) {
    const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }))
    identity.bundleId = info.CFBundleIdentifier
    equal(info.CFBundleExecutable, PUBLIC_IDENTITY.productName, 'public executable')
    equal(info.CFBundleShortVersionString, version, 'public bundle version')
    equal(metadata.buildHints?.macSigningEnabled, true, 'macOS signing')
    equal(metadata.buildHints?.notarizationEnabled, true, 'macOS notarization')
  }
  validatePublicIdentity(identity)
  equal(metadata.version, version, 'packaged version')
  equal(metadata.buildProvenance?.sourceHead, sourceHead, 'packaged source HEAD')
  equal(metadata.updateChannel, 'stable', 'packaged update channel')
  equal(updater.provider, 'generic', 'public updater provider')
  equal(updater.url, 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/', 'public updater URL')
  equal(updater.updaterCacheDirName, 'workwise-updater', 'public updater cache')
  return { ...identity, version, sourceHead, updateUrl: updater.url }
}

function verifyBuildSource(sourceHead) {
  equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHead, 'checked-out source HEAD')
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { stdio: ['ignore', 'pipe', 'pipe'] })
}

export async function recordReviewedBuild({ dist, platform, version, env = process.env, inspect = inspectPackagedIdentity, verifySource = verifyBuildSource }) {
  equal(env.GITHUB_ACTIONS, 'true', 'hosted build')
  equal(env.GITHUB_REPOSITORY, RELEASE_REPOSITORY, 'build repository')
  equal(env.CANDIDATE_ONLY, 'true', 'private build dispatch')
  equal(env.PREPARE_PUBLIC_ARTIFACTS, 'true', 'final public identity mode')
  equal(env.PUBLISH_RELEASE, 'false', 'publication disabled during freezing')
  if (env.WORKWISE_CANDIDATE === '1') fail('isolated candidates cannot be frozen for publication')
  if (!String(env.GITHUB_WORKFLOW_REF).startsWith(`${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@`)) fail('untrusted build workflow')
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA)) fail('invalid build source HEAD')
  verifySource(env.GITHUB_SHA)
  const artifact = platform === 'mac' ? 'release-mac' : platform === 'win' ? 'release-win' : ''
  if (!artifact) fail('build platform must be mac or win')
  const expected = expectedReleaseFiles(version).filter(file => file.artifact === artifact)
  // electron-builder may leave blockmaps in dist even when the workflow does
  // not upload them. Freeze exactly the files declared in the upload step.
  const publicNames = new Set(expected.map(file => file.name))
  const publicFiles = readdirSync(dist).filter(name => publicNames.has(name))
  exactSet(publicFiles, expected.map(file => file.name), 'built release files')
  const files = []
  for (const file of expected) {
    const path = join(dist, file.name)
    files.push({ ...file, size: plainFile(path).size, sha256: await fileHash(path) })
  }
  const apps = platform === 'mac'
    ? { 'darwin-arm64': join(dist, 'mac-arm64', 'RailWise AI.app'), 'darwin-x64': join(dist, 'mac', 'RailWise AI.app') }
    : { 'win32-x64': join(dist, 'win-unpacked') }
  const identities = Object.fromEntries(Object.entries(apps).map(([key, path]) => [key, inspect(path, key, version, env.GITHUB_SHA)]))
  const receipt = { schemaVersion: 1, purpose: 'frozen-public-release', repository: RELEASE_REPOSITORY, workflowPath: RELEASE_WORKFLOW,
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT), sourceHead: env.GITHUB_SHA,
    candidateOnly: true, preparePublicArtifacts: true, publishRelease: false, artifact, version, identities, files }
  positive(receipt.runId, 'build run ID'); positive(receipt.runAttempt, 'build run attempt')
  writeFileSync(join(dist, RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

export async function verifyDownloadedReleaseArtifacts({ build, version, sourceHead, downloads, output }) {
  validateReviewedBuild(build, { version, sourceHead })
  exactSet(readdirSync(downloads), ARTIFACT_NAMES, 'downloaded artifact directories')
  const verified = []
  for (const artifact of ARTIFACT_NAMES) {
    const root = join(downloads, artifact)
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) fail('artifact directory must not be a symlink')
    const files = build.files.filter(file => file.artifact === artifact)
    exactSet(readdirSync(root), [...files.map(file => file.name), RECEIPT], `${artifact} files`)
    plainFile(join(root, RECEIPT))
    const receipt = JSON.parse(readFileSync(join(root, RECEIPT), 'utf8'))
    for (const key of ['repository', 'workflowPath', 'sourceHead', 'runId', 'runAttempt']) equal(receipt[key], build[key], `build receipt ${key}`)
    for (const [key, value] of Object.entries({ schemaVersion: 1, purpose: 'frozen-public-release', artifact, version, candidateOnly: true, preparePublicArtifacts: true, publishRelease: false })) equal(receipt[key], value, `build receipt ${key}`)
    const platforms = artifact === 'release-mac' ? ['darwin-arm64', 'darwin-x64'] : ['win32-x64']
    exactSet(Object.keys(receipt.identities ?? {}), platforms, 'packaged identities')
    for (const platform of platforms) {
      validatePublicIdentity(receipt.identities[platform])
      equal(receipt.identities[platform].version, version, 'identity version')
      equal(receipt.identities[platform].sourceHead, sourceHead, 'identity source HEAD')
      equal(receipt.identities[platform].updateUrl, 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/', 'identity update URL')
    }
    validateFileManifest(receipt.files, expectedReleaseFiles(version).filter(file => file.artifact === artifact))
    for (const file of files) {
      const recorded = receipt.files.find(entry => entry.name === file.name)
      equal(recorded.sha256, file.sha256, `${file.name} reviewed/build hash`)
      equal(recorded.size, file.size, `${file.name} reviewed/build size`)
      const path = join(root, file.name)
      equal(plainFile(path).size, file.size, `${file.name} downloaded size`)
      equal(await fileHash(path), file.sha256, `${file.name} downloaded hash`)
      verified.push({ path, name: file.name })
    }
  }
  if (existsSync(output)) fail('verified output directory must not already exist')
  // Copy only after every artifact, receipt and file passed. No merging/overwrites.
  mkdirSync(output, { recursive: true })
  for (const file of verified) copyFileSync(file.path, join(output, file.name))
  return { files: verified.length, sourceHead, runId: build.runId }
}

function argument(name) { return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || '' }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'record') {
      const receipt = await recordReviewedBuild({ dist: resolve(argument('dist') || 'dist'), platform: argument('platform'), version: argument('version') })
      console.log(`[reviewed-artifacts] froze ${receipt.artifact} at ${receipt.sourceHead}; no publication performed`)
    } else {
      const releaseHead = process.env.GITHUB_SHA
      const evidence = argument('evidence')
      if (!/^[a-f0-9]{40}$/.test(releaseHead || '') || !/^docs\/qa\/release-gates\/[a-zA-Z0-9_./-]+\.json$/.test(evidence) || evidence.split('/').includes('..')) fail('exact committed release evidence is required')
      const manifest = JSON.parse(execFileSync('git', ['show', `${releaseHead}:${evidence}`], { encoding: 'utf8' }))
      const build = manifest.package?.reviewedBuild
      // Recheck remote provenance immediately before consuming downloaded bytes.
      verifyReviewedBuildSource(build, { version: manifest.release?.version, sourceHead: manifest.release?.sourceHead })
      const result = await verifyDownloadedReleaseArtifacts({ build, version: manifest.release.version, sourceHead: manifest.release.sourceHead, downloads: resolve(argument('downloads')), output: resolve(argument('output')) })
      console.log(`[reviewed-artifacts] verified ${result.files} frozen files from run ${result.runId} at ${result.sourceHead}`)
    }
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
