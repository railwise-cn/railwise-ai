// Bind native updater acceptance to the trusted run and its immutable reports.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { githubApi, RELEASE_REPOSITORY } from './verify-reviewed-release-artifacts.mjs'

export const UPDATER_WORKFLOW = '.github/workflows/frozen-release-updater-acceptance.yml'
export const UPDATER_WORKFLOW_REF = `${RELEASE_REPOSITORY}/${UPDATER_WORKFLOW}@refs/heads/main`
const JOB = 'Official 0.5.2 to exact frozen 0.5.3 native updater'
const RUN_STEP = 'Run default-trust HTTPS download, Squirrel install and historical data readback'
const RETAIN_STEP = 'Retain durable updater evidence including failures'
const MAX_ARCHIVE = 20 * 1024 * 1024

function fail(message) { throw new Error(`[updater-evidence] ${message}`) }
function equal(actual, expected, label) { if (actual !== expected) fail(`${label} mismatch`) }
function positive(value, label) { if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`) }
export function reportSha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

export function validateUpdaterEvidenceRun(run, machine, sourceHead) {
  if (!run || typeof run !== 'object') fail('updaterRoundTrip.workflowRun is required')
  equal(run.repository, RELEASE_REPOSITORY, 'repository')
  equal(run.workflowPath, UPDATER_WORKFLOW, 'workflow path')
  equal(run.sourceHead, sourceHead, 'exact frozen workflow source')
  positive(run.runId, 'run ID'); positive(run.runAttempt, 'run attempt')
  positive(run.artifact?.id, 'artifact ID')
  equal(run.artifact.name, `frozen-updater-${machine.arch}-${run.runId}`, 'artifact name')
  if (!/^sha256:[a-f0-9]{64}$/.test(run.artifact.digest)) fail('immutable artifact digest is required')
  const provenance = { repository: run.repository, workflowPath: run.workflowPath,
    workflowRef: UPDATER_WORKFLOW_REF, workflowSha: sourceHead, sourceHead,
    runId: run.runId, runAttempt: run.runAttempt }
  if (!isDeepStrictEqual(machine.provenance, provenance)) fail('machine report workflow provenance mismatch')
  if (!/^[a-f0-9]{64}$/.test(machine.nativeReportSha256 ?? '')) fail('native report SHA256 is required')
  return run
}

export function verifyUpdaterEvidenceSource(run, api = githubApi) {
  const root = `repos/${RELEASE_REPOSITORY}`
  const repository = api(root)
  const workflow = api(`${root}/actions/workflows/frozen-release-updater-acceptance.yml`)
  const actual = api(`${root}/actions/runs/${run.runId}`)
  equal(repository.full_name, RELEASE_REPOSITORY, 'API repository')
  equal(repository.default_branch, 'main', 'default branch')
  equal(workflow.path, UPDATER_WORKFLOW, 'trusted workflow path')
  equal(actual.workflow_id, workflow.id, 'trusted workflow ID')
  equal(actual.path, UPDATER_WORKFLOW, 'run workflow path')
  equal(actual.repository?.id, repository.id, 'run repository')
  equal(actual.head_repository?.id, repository.id, 'run head repository')
  equal(actual.head_branch, 'main', 'protected head branch')
  equal(actual.head_sha, run.sourceHead, 'run source')
  equal(actual.id, run.runId, 'run ID')
  equal(actual.run_attempt, run.runAttempt, 'run attempt')
  equal(actual.event, 'workflow_dispatch', 'run event')
  equal(actual.status, 'completed', 'run status')
  equal(actual.conclusion, 'success', 'run conclusion')
  const branch = api(`${root}/branches/main`)
  equal(branch.name, 'main', 'protected branch name')
  equal(branch.protected, true, 'main protection')
  if (!/^[a-f0-9]{40}$/.test(branch.commit?.sha ?? '')) fail('invalid protected main commit')
  const ancestry = api(`${root}/compare/${run.sourceHead}...${branch.commit.sha}`)
  if (!['ahead', 'identical'].includes(ancestry.status)) fail('updater source is not an ancestor of protected main')
  equal(ancestry.base_commit?.sha, run.sourceHead, 'comparison source')
  equal(ancestry.merge_base_commit?.sha, run.sourceHead, 'source ancestry')
  if (ancestry.status === 'identical') equal(branch.commit.sha, run.sourceHead, 'identical source')
  const jobs = []
  for (let page = 1; ; page += 1) {
    const result = api(`${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs?per_page=100&page=${page}`)
    if (!Array.isArray(result.jobs) || !Number.isSafeInteger(result.total_count) || result.total_count < 1 || result.total_count > 1000) fail('invalid updater jobs response')
    jobs.push(...result.jobs)
    if (jobs.length >= result.total_count) break
    if (result.jobs.length === 0) fail('incomplete updater jobs response')
  }
  const matches = jobs.filter(job => job.name === JOB)
  if (matches.length !== 1 || matches[0].conclusion !== 'success') fail('trusted native updater job must succeed exactly once')
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

export function verifyUpdaterEvidenceArchive({ archive, run, machineBytes, nativeBytes }) {
  equal(`sha256:${reportSha256(archive)}`, run.artifact.digest, 'downloaded artifact digest')
  const root = mkdtempSync(join(tmpdir(), 'railwise-updater-evidence-'))
  try {
    const path = join(root, 'evidence.zip')
    writeFileSync(path, archive, { mode: 0o600, flag: 'wx' })
    const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', maxBuffer: MAX_ARCHIVE, timeout: 30_000 }).trim().split(/\r?\n/)
    if (new Set(entries).size !== entries.length || entries.some(name => !/^(?:frozen-updater\.json|native-updater\.json|seed-data\.json|verify-data\.json|[a-z-]+\.redacted\.log)$/.test(name))
      || !entries.includes('frozen-updater.json') || !entries.includes('native-updater.json')) fail('unexpected updater artifact entries')
    for (const [name, committed] of [['frozen-updater.json', machineBytes], ['native-updater.json', nativeBytes]]) {
      const downloaded = execFileSync('unzip', ['-p', path, name], { maxBuffer: MAX_ARCHIVE, timeout: 30_000 })
      if (!downloaded.equals(committed)) fail(`committed ${name} differs from the trusted immutable report`)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

export function verifyRemoteUpdaterEvidence({ run, machineBytes, nativeBytes }, api = githubApi) {
  verifyUpdaterEvidenceSource(run, api)
  const archive = execFileSync('gh', ['api', '--hostname', 'github.com', `repos/${RELEASE_REPOSITORY}/actions/artifacts/${run.artifact.id}/zip`],
    { maxBuffer: MAX_ARCHIVE, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  verifyUpdaterEvidenceArchive({ archive, run, machineBytes, nativeBytes })
}
