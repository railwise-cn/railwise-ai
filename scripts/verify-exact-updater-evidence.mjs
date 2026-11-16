// Verify the original native smoke reports retained by the same exact build run.
// This accepts the release workflow's branch identity without inventing a second
// freeze or rewriting its private-package receipt into historical provenance.
import { execFileSync } from 'node:child_process'
import { isDeepStrictEqual } from 'node:util'
import { githubApi, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256, verifyUpdaterEvidenceArchive } from './verify-frozen-updater-evidence.mjs'
import { validateUpdaterServiceEvidence } from './frozen-release-updater-service-contract.mjs'
import { resolveUpdaterBaseline } from './frozen-release-version.mjs'

export const EXACT_UPDATER_WORKFLOW = RELEASE_WORKFLOW
export const EXACT_UPDATER_JOB = 'Private exact-package updater smoke'
// Historical manifests omit the baseline. New evidence supplies its reviewed
// baseline explicitly without reinterpreting the original reports.
export const EXACT_UPDATER_BASE_VERSION = '0.5.4'
const RUN_STEP = 'Exercise official baseline to exact artifact once'
const RETAIN_STEP = 'Retain exact-package updater evidence'
const MAX_ARCHIVE = 20 * 1024 * 1024

function fail(message) { throw new Error(`[exact-updater-evidence] ${message}`) }
function equal(actual, expected, label) { if (actual !== expected) fail(`${label} mismatch`) }
function positive(value, label) { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`) }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is required`) }

function validateRunIdentity(run) {
  object(run, 'updaterRoundTrip.workflowRun')
  equal(run.repository, RELEASE_REPOSITORY, 'repository')
  equal(run.workflowPath, EXACT_UPDATER_WORKFLOW, 'workflow path')
  if (!/^[a-f0-9]{40}$/.test(run.sourceHead ?? '')) fail('exact build source HEAD is required')
  if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(run.headRef ?? '')
    || run.headRef.includes('..') || run.headRef.includes('//') || /[/.]$/.test(run.headRef)
    || run.headRef.split('/').some(part => part === '.' || part.endsWith('.lock'))) fail('exact build branch ref is required')
  equal(run.workflowRef, `${RELEASE_REPOSITORY}/${EXACT_UPDATER_WORKFLOW}@${run.headRef}`, 'workflow ref')
  equal(run.workflowSha, run.sourceHead, 'workflow source SHA')
  positive(run.runId, 'run ID'); positive(run.runAttempt, 'run attempt')
  object(run.artifact, 'immutable updater artifact')
  positive(run.artifact.id, 'artifact ID')
  equal(run.artifact.name, `exact-package-updater-${run.runId}`, 'artifact name')
  if (!/^sha256:[a-f0-9]{64}$/.test(run.artifact.digest ?? '')) fail('immutable artifact digest is required')
  return run
}

function validateRawReport(run, machine) {
  validateRunIdentity(run)
  object(machine, 'machine report')
  equal(machine.schemaVersion, 1, 'machine schema')
  equal(machine.status, 'passed', 'machine status')
  equal(machine.platform, 'darwin', 'machine platform')
  if (!['arm64', 'x64'].includes(machine.arch)) fail('machine report must identify a supported native macOS architecture')
  if (Object.hasOwn(machine, 'reviewedBuild')) fail('private exact-package report must retain its original privatePackage provenance')
  const provenance = {
    repository: run.repository, workflowPath: run.workflowPath,
    workflowRef: run.workflowRef, workflowSha: run.workflowSha, sourceHead: run.sourceHead,
    runId: run.runId, runAttempt: run.runAttempt, mode: 'private-exact-package-smoke'
  }
  if (!isDeepStrictEqual(machine.provenance, provenance)) fail('raw machine report workflow provenance mismatch')
  const pkg = machine.privatePackage
  object(pkg, 'private package provenance')
  equal(pkg.sourceHead, run.sourceHead, 'private package source')
  equal(pkg.artifactRunId, run.runId, 'private package artifact run')
  equal(pkg.artifactName, 'release-mac', 'private package artifact name')
  if (!Array.isArray(pkg.files) || pkg.files.length !== 5) fail('private package must retain all five exact macOS files')
  if (!/^[a-f0-9]{64}$/.test(machine.nativeReportSha256 ?? '')) fail('retained native report SHA256 is required')
}

export function validateExactUpdaterEvidenceRun(run, machine, reviewedBuild, version, baseVersion = EXACT_UPDATER_BASE_VERSION) {
  resolveUpdaterBaseline(baseVersion)
  validateRawReport(run, machine)
  object(reviewedBuild, 'exact reviewed build')
  equal(reviewedBuild.mode, 'exact-build', 'reviewed build mode')
  for (const key of ['repository', 'workflowPath', 'sourceHead', 'headRef', 'workflowRef', 'workflowSha', 'runId', 'runAttempt']) {
    equal(run[key], reviewedBuild[key], `same exact build ${key}`)
  }
  if (!Array.isArray(reviewedBuild.files)) fail('exact reviewed file manifest is required')
  const files = reviewedBuild.files.filter(file => file.artifact === 'release-mac')
  if (!isDeepStrictEqual(machine.privatePackage.files, files)) fail('raw private package files differ from the exact reviewed build')
  validateUpdaterServiceEvidence(machine, { sourceHead: run.sourceHead, version, baseVersion })
  return run
}

export function verifyExactUpdaterEvidenceSource(run, api = githubApi) {
  validateRunIdentity(run)
  const root = `repos/${RELEASE_REPOSITORY}`
  const repository = api(root)
  const workflow = api(`${root}/actions/workflows/release.yml`)
  const actual = api(`${root}/actions/runs/${run.runId}`)
  equal(repository.full_name, RELEASE_REPOSITORY, 'API repository')
  positive(repository.id, 'API repository ID')
  equal(workflow.path, EXACT_UPDATER_WORKFLOW, 'trusted workflow path')
  equal(actual.workflow_id, workflow.id, 'trusted workflow ID')
  equal(actual.path, EXACT_UPDATER_WORKFLOW, 'run workflow path')
  equal(actual.repository?.id, repository.id, 'run repository')
  equal(actual.head_repository?.id, repository.id, 'run head repository')
  equal(actual.head_branch, run.headRef.slice('refs/heads/'.length), 'same exact build branch')
  equal(actual.head_sha, run.sourceHead, 'run source')
  equal(actual.id, run.runId, 'run ID')
  equal(actual.run_attempt, run.runAttempt, 'run attempt')
  equal(actual.event, 'workflow_dispatch', 'run event')
  equal(actual.status, 'completed', 'run status')
  equal(actual.conclusion, 'success', 'run conclusion')
  const jobs = []
  for (let page = 1; ; page += 1) {
    const result = api(`${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs?per_page=100&page=${page}`)
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count < 1 || result.total_count > 1000) fail('invalid updater jobs response')
    jobs.push(...result.jobs)
    if (jobs.length >= result.total_count) break
    if (result.jobs.length === 0) fail('incomplete updater jobs response')
  }
  const matches = jobs.filter(job => job.name === EXACT_UPDATER_JOB)
  if (matches.length !== 1 || matches[0].conclusion !== 'success') fail('same-run native updater job must succeed exactly once')
  for (const name of [RUN_STEP, RETAIN_STEP]) {
    const steps = matches[0].steps?.filter(step => step.name === name) ?? []
    if (steps.length !== 1 || steps[0].conclusion !== 'success') fail(`trusted updater step did not succeed: ${name}`)
  }
  const artifact = api(`${root}/actions/artifacts/${run.artifact.id}`)
  for (const key of ['id', 'name', 'digest']) equal(artifact[key], run.artifact[key], `immutable artifact ${key}`)
  equal(artifact.expired, false, 'artifact expiry')
  equal(artifact.workflow_run?.id, run.runId, 'artifact run')
  if (artifact.workflow_run?.run_attempt !== undefined) equal(artifact.workflow_run.run_attempt, run.runAttempt, 'artifact run attempt')
  equal(artifact.workflow_run?.head_sha, run.sourceHead, 'artifact source')
  equal(artifact.workflow_run?.repository_id, repository.id, 'artifact repository')
  equal(artifact.workflow_run?.head_repository_id, repository.id, 'artifact head repository')
  return run
}

export function verifyExactUpdaterEvidenceArchive(input) {
  validateRunIdentity(input.run)
  validateRetainedReports(input)
  return verifyUpdaterEvidenceArchive(input)
}

function validateRetainedReports({ run, machineBytes, nativeBytes }) {
  if (!Buffer.isBuffer(machineBytes) || !Buffer.isBuffer(nativeBytes)) fail('original retained machine/native bytes are required')
  const machine = JSON.parse(machineBytes.toString('utf8'))
  JSON.parse(nativeBytes.toString('utf8'))
  validateRawReport(run, machine)
  equal(reportSha256(nativeBytes), machine.nativeReportSha256, 'retained native report digest')
}

export function verifyRemoteExactUpdaterEvidence({ run, machineBytes, nativeBytes }, api = githubApi) {
  validateRetainedReports({ run, machineBytes, nativeBytes })
  verifyExactUpdaterEvidenceSource(run, api)
  const path = `repos/${RELEASE_REPOSITORY}/actions/artifacts/${run.artifact.id}/zip`
  const archive = api === githubApi
    ? execFileSync('gh', ['api', '--hostname', 'github.com', path], { maxBuffer: MAX_ARCHIVE, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    : api(path)
  if (!Buffer.isBuffer(archive)) fail('immutable updater artifact download must return original bytes')
  verifyExactUpdaterEvidenceArchive({ archive, run, machineBytes, nativeBytes })
}
