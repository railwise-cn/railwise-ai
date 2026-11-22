import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { githubApi, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256 } from './verify-frozen-updater-evidence.mjs'

const WINDOWS_INSTALL_WORKFLOW = '.github/workflows/windows-install-smoke.yml'
const MAX_ARCHIVE = 32 * 1024 * 1024
const MAX_REPORT = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const SHA1 = /^[a-f0-9]{40}$/
const PROOF_FILE = /^(?!core-journeys\.json$)[a-z0-9][a-z0-9-]{0,119}\.json$/
const WIN = 'win32-x64'
const MAC = 'darwin-arm64'
const INTEL = 'darwin-x64'

const desktopJourneys = [
  'conversation-task', 'approval-resume', 'kun-ag-ui-recovery', 'website-pptx', 'browserskill-fallback',
  'public-procurement-html', 'daily-schedule', 'composer-capabilities', 'pdf-attachments',
  'responsive-layout', 'startup-branding', 'offline-spreadsheet'
]
const specializedMethods = {
  'website-pptx': 'live-model-ui',
  'browserskill-fallback': 'real-browser-ui',
  'ego-dadan-report': 'authenticated-ego-ui',
  'mainland-windows-install': 'mainland-windows-ui'
}
const fieldJourneys = new Set(['ego-dadan-report', 'mainland-windows-install'])

function fail(message) { throw new Error(`[core-journeys] ${message}`) }
function equal(actual, expected, label) { if (actual !== expected) fail(`${label} mismatch`) }
function hash(value, label) { if (!SHA256.test(value ?? '')) fail(`${label} must be a lowercase SHA-256`) }
function positive(value, label) { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`) }
function description(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) fail(`${label} is required`)
}

export function requiresCoreJourneys(version) {
  const [major, minor, patch] = version.split('.').map(Number)
  return major > 0 || minor > 5 || minor === 5 && patch >= 11
}

export function requiredCoreJourneys(version, { updater = false } = {}) {
  const firstRelease = version === '0.5.11'
  const windows = [
    ...desktopJourneys, 'marketplace-mirror', 'video-shotcraft', 'mainland-windows-install',
    ...(updater || firstRelease ? ['windows-updater-sidebar', 'windows-updater-settings'] : []),
    ...(firstRelease ? ['windows-legacy-overlay'] : [])
  ]
  return new Map([
    [WIN, windows],
    [MAC, [...desktopJourneys, 'ego-dadan-report']],
    [INTEL, ['startup-branding', 'offline-spreadsheet']]
  ])
}

function workflowArtifactName(workflowPath, platform, jobName, runId) {
  if (workflowPath === RELEASE_WORKFLOW) {
    if (platform === WIN && jobName === 'Private exact-package Windows install smoke') return `exact-package-windows-install-${runId}`
    if (platform === MAC && jobName === 'Private exact-package updater smoke') return `exact-package-updater-${runId}`
    return undefined
  }
  if (platform === WIN) {
    if (jobName === 'Install and inspect the existing Windows package') return `exact-package-windows-install-${runId}`
    if (jobName === 'Official 0.5.7 to exact candidate (overlay)') return `frozen-windows-gui-upgrade-${runId}-overlay`
    const entry = /^Official (?:0\.5\.10|current Stable) to exact candidate \((sidebar|settings)\)$/.exec(jobName)?.[1]
    return entry && `frozen-windows-gui-upgrade-${runId}-${entry}`
  }
  const arch = platform.slice('darwin-'.length)
  if (jobName === `Exact startup appearance on macOS ${arch}`) return `exact-mac-startup-appearance-${arch}`
}

function validateWorkflowRun(workflowRun, receipt, build, platform) {
  if (!workflowRun || typeof workflowRun !== 'object') fail('hosted receipt requires workflow provenance')
  const { jobName, artifact, ...provenance } = workflowRun
  if (!isDeepStrictEqual(receipt.provenance, provenance)) fail('receipt workflow provenance mismatch')
  equal(provenance.repository, RELEASE_REPOSITORY, 'receipt repository')
  if (![RELEASE_WORKFLOW, WINDOWS_INSTALL_WORKFLOW].includes(provenance.workflowPath)) fail('untrusted receipt workflow')
  if (!SHA1.test(provenance.sourceHead ?? '')) fail('receipt workflow source HEAD is required')
  positive(provenance.runId, 'receipt run ID')
  positive(provenance.runAttempt, 'receipt run attempt')
  if (provenance.workflowPath === RELEASE_WORKFLOW) {
    equal(provenance.runId, build.runId, 'same build receipt run ID')
    equal(provenance.runAttempt, build.runAttempt, 'same build receipt run attempt')
  }
  const expectedArtifact = workflowArtifactName(provenance.workflowPath, platform, jobName, provenance.runId)
  if (!expectedArtifact) fail('untrusted receipt job for the reported platform')
  positive(artifact?.id, 'receipt artifact ID')
  equal(artifact.name, expectedArtifact, 'receipt job artifact name')
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact?.digest ?? '')) fail('immutable receipt artifact digest is required')
  if (artifact.reportPath !== undefined && !/^(?:[a-zA-Z0-9_-]+\/)*core-journeys\.json$/.test(artifact.reportPath)) fail('invalid receipt artifact report path')
  return workflowRun
}

export function validateCoreJourneyReceipts(records, { version, build, packageIdentity, updater = false, requireSource = () => {} }) {
  if (build.mode !== 'exact-build') fail('core journeys require exact-build package provenance')
  if (!Array.isArray(records) || !records.length || records.length > 64) fail('core journey receipts are required')
  const required = requiredCoreJourneys(version, { updater })
  const seen = new Set()
  const installations = new Map()
  const installers = new Map([...required.keys()].map(platform => [
    platform, build.files.find(file => file.platform === platform && /\.(?:dmg|exe)$/.test(file.name))
  ]))
  const identityArtifact = build.files.find(file => file.sha256 === packageIdentity.artifactSha256 && /\.(?:dmg|zip|exe)$/.test(file.name))
  const artifactIds = new Set()
  const hosted = []

  for (const { receipt, bytes, workflowRun } of records) {
    equal(receipt?.schemaVersion, 1, 'receipt schema')
    equal(receipt.status, 'passed', 'receipt status')
    equal(receipt.version, version, 'receipt version')
    equal(receipt.sourceHead, build.sourceHead, 'receipt packaged source HEAD')
    equal(receipt.buildRunId, build.runId, 'installer build run ID')
    equal(receipt.buildRunAttempt, build.runAttempt, 'installer build run attempt')
    const platform = `${receipt.platform}-${receipt.arch}`
    const expected = required.get(platform)
    if (!expected) fail(`unsupported receipt platform: ${platform}`)
    const installer = installers.get(platform)
    if (!installer) fail(`missing reviewed installer for ${platform}`)
    equal(receipt.installerSha256, installer.sha256, `${platform} reviewed installer SHA-256`)
    hash(receipt.installedAsarSha256, 'installed ASAR')
    if (identityArtifact?.platform === platform) equal(receipt.installedAsarSha256, packageIdentity.asarSha256, `${platform} reviewed installed ASAR`)
    if (installations.has(platform)) equal(receipt.installedAsarSha256, installations.get(platform), `${platform} ASAR across receipts`)
    installations.set(platform, receipt.installedAsarSha256)

    if (receipt.execution === 'hosted') {
      validateWorkflowRun(workflowRun, receipt, build, platform)
      requireSource(workflowRun.sourceHead)
      if (artifactIds.has(workflowRun.artifact.id) || build.artifacts.some(artifact => artifact.id === workflowRun.artifact.id)) fail('duplicate or reused receipt artifact ID')
      artifactIds.add(workflowRun.artifact.id)
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_REPORT) fail('original bounded receipt bytes are required')
      hosted.push({ run: workflowRun, bytes })
    } else if (receipt.execution !== 'field' || workflowRun !== undefined || receipt.provenance !== undefined) {
      fail('receipt execution must be hosted or field with valid provenance')
    }

    if (!Array.isArray(receipt.journeys) || !receipt.journeys.length) fail('receipt journeys are required')
    for (const journey of receipt.journeys) {
      const id = journey?.id
      if (!expected.includes(id)) fail(`unexpected journey on ${platform}: ${id}`)
      const key = `${platform}/${id}`
      if (seen.has(key)) fail(`duplicate required journey: ${key}`)
      equal(journey.status, 'passed', `${key} status`)
      equal(journey.method, specializedMethods[id] ?? 'installed-ui', `${key} test method`)
      description(journey.evidence, `${key} evidence`)
      if (fieldJourneys.has(id)) equal(receipt.execution, 'field', `${key} field execution`)
      hash(journey.proofSha256, `${key} raw proof`)
      if (receipt.execution === 'hosted' && !PROOF_FILE.test(journey.proofFile ?? '')) fail(`${key} raw report filename is required`)
      seen.add(key)
    }
  }

  const missing = [...required].flatMap(([platform, ids]) => ids.map(id => `${platform}/${id}`)).filter(key => !seen.has(key))
  if (missing.length) fail(`missing required journeys: ${missing.join(', ')}`)
  return hosted
}

function verifyCoreJourneyWorkflowRun(run, api) {
  const root = `repos/${RELEASE_REPOSITORY}`
  const repository = api(root)
  const workflow = api(`${root}/actions/workflows/${run.workflowPath.split('/').at(-1)}`)
  const actual = api(`${root}/actions/runs/${run.runId}`)
  equal(repository.full_name, RELEASE_REPOSITORY, 'API repository')
  positive(repository.id, 'API repository ID')
  positive(workflow.id, 'trusted workflow ID')
  equal(workflow.path, run.workflowPath, 'trusted workflow path')
  equal(actual.workflow_id, workflow.id, 'run workflow ID')
  equal(actual.path, run.workflowPath, 'run workflow path')
  for (const [received, expected, name] of [
    [actual.id, run.runId, 'ID'], [actual.run_attempt, run.runAttempt, 'attempt'],
    [actual.repository?.id, repository.id, 'repository'], [actual.head_repository?.id, repository.id, 'head repository'],
    [actual.head_sha, run.sourceHead, 'source'], [actual.event, 'workflow_dispatch', 'event'],
    [actual.status, 'completed', 'status'], [actual.conclusion, 'success', 'conclusion']
  ]) equal(received, expected, `receipt run ${name}`)

  const jobs = []
  for (let page = 1; ; page += 1) {
    const result = api(`${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs?per_page=100&page=${page}`)
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count < 1 || result.total_count > 1000) fail('invalid receipt workflow jobs')
    jobs.push(...result.jobs)
    if (jobs.length >= result.total_count) break
    if (!result.jobs.length) fail('incomplete receipt workflow jobs')
  }
  const matches = jobs.filter(job => job.name === run.jobName)
  if (matches.length !== 1 || matches[0].status !== 'completed' || matches[0].conclusion !== 'success') fail('trusted receipt job must succeed exactly once')
  const artifact = api(`${root}/actions/artifacts/${run.artifact.id}`)
  for (const key of ['id', 'name', 'digest']) equal(artifact[key], run.artifact[key], `immutable receipt artifact ${key}`)
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_ARCHIVE) fail('receipt artifact archive size is invalid')
  equal(artifact.expired, false, 'receipt artifact expiry')
  equal(artifact.workflow_run?.id, run.runId, 'receipt artifact run')
  if (artifact.workflow_run?.run_attempt !== undefined) equal(artifact.workflow_run.run_attempt, run.runAttempt, 'receipt artifact run attempt')
  equal(artifact.workflow_run?.head_sha, run.sourceHead, 'receipt artifact source')
  equal(artifact.workflow_run?.repository_id, repository.id, 'receipt artifact repository')
  equal(artifact.workflow_run?.head_repository_id, repository.id, 'receipt artifact head repository')
}

export function verifyCoreJourneyArchive(archive, run, bytes) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE) fail('immutable receipt archive must contain original bounded bytes')
  equal(`sha256:${reportSha256(archive)}`, run.artifact.digest, 'downloaded receipt archive digest')
  const directory = mkdtempSync(join(tmpdir(), 'railwise-core-journey-'))
  try {
    const path = join(directory, 'evidence.zip')
    writeFileSync(path, archive, { mode: 0o600, flag: 'wx' })
    const reportPath = run.artifact.reportPath ?? 'core-journeys.json'
    if (!/^(?:[a-zA-Z0-9_-]+\/)*core-journeys\.json$/.test(reportPath)) fail('invalid receipt artifact report path')
    const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: MAX_REPORT, timeout: 30_000 }).trim().split(/\r?\n/)
    if (entries.filter(entry => entry === reportPath).length !== 1) fail('receipt archive must contain the reported file exactly once')
    const downloaded = execFileSync('unzip', ['-p', path, reportPath], { maxBuffer: MAX_REPORT, timeout: 30_000 })
    if (!downloaded.equals(bytes)) fail('committed receipt differs from the trusted immutable report')
    const directory = reportPath.slice(0, -'core-journeys.json'.length)
    const rawDigests = new Map()
    const receipt = JSON.parse(downloaded.toString('utf8'))
    for (const journey of receipt.journeys) {
      if (!PROOF_FILE.test(journey.proofFile ?? '')) fail('invalid receipt raw report filename')
      const file = `${directory}${journey.proofFile}`
      if (!rawDigests.has(file)) {
        if (entries.filter(entry => entry === file).length !== 1) fail('receipt archive must contain the raw report exactly once')
        const original = execFileSync('unzip', ['-p', path, file], { maxBuffer: MAX_ARCHIVE, timeout: 30_000 })
        rawDigests.set(file, reportSha256(original))
      }
      equal(rawDigests.get(file), journey.proofSha256, 'archived raw report SHA-256')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export function verifyRemoteCoreJourneyReceipts(receipts, api = githubApi) {
  for (const { run, bytes } of receipts) {
    verifyCoreJourneyWorkflowRun(run, api)
    const path = `repos/${RELEASE_REPOSITORY}/actions/artifacts/${run.artifact.id}/zip`
    const archive = api === githubApi
      ? execFileSync('gh', ['api', '--hostname', 'github.com', path], { maxBuffer: MAX_ARCHIVE, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
      : api(path)
    verifyCoreJourneyArchive(archive, run, bytes)
  }
}
