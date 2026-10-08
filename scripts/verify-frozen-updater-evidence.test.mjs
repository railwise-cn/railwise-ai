import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RELEASE_REPOSITORY } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256, UPDATER_WORKFLOW, UPDATER_WORKFLOW_REF, validateUpdaterEvidenceRun, verifyUpdaterEvidenceArchive, verifyUpdaterEvidenceSource } from './verify-frozen-updater-evidence.mjs'

function fixture(t) {
  const sourceHead = 'a'.repeat(40)
  const run = { repository: RELEASE_REPOSITORY, workflowPath: UPDATER_WORKFLOW, sourceHead, runId: 4321, runAttempt: 2,
    artifact: { id: 91, name: 'frozen-updater-arm64-4321', digest: `sha256:${'b'.repeat(64)}` } }
  const nativeBytes = Buffer.from('{"status":"passed","startedAt":"new-run"}\n')
  const machine = { arch: 'arm64', nativeReportSha256: reportSha256(nativeBytes), provenance: { repository: run.repository, workflowPath: run.workflowPath,
    workflowRef: UPDATER_WORKFLOW_REF, workflowSha: sourceHead, sourceHead, runId: run.runId, runAttempt: run.runAttempt } }
  const machineBytes = Buffer.from(JSON.stringify(machine) + '\n')
  const root = `repos/${RELEASE_REPOSITORY}`
  const job = { name: 'Official 0.5.2 to exact frozen 0.5.3 native updater', conclusion: 'success', steps: [
    { name: 'Run default-trust HTTPS download, Squirrel install and historical data readback', conclusion: 'success' },
    { name: 'Retain durable updater evidence including failures', conclusion: 'success' },
  ] }
  const actual = { id: run.runId, run_attempt: run.runAttempt, workflow_id: 51, path: UPDATER_WORKFLOW,
    repository: { id: 98 }, head_repository: { id: 98 }, head_branch: 'main', head_sha: sourceHead,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }
  const artifact = { ...run.artifact, expired: false,
    workflow_run: { id: run.runId, head_sha: sourceHead, repository_id: 98, head_repository_id: 98 } }
  const branch = { name: 'main', protected: true, commit: { sha: sourceHead } }
  const ancestry = { status: 'identical', base_commit: { sha: sourceHead }, merge_base_commit: { sha: sourceHead } }
  const jobs = { total_count: 1, jobs: [job] }
  const responses = {
    [root]: { id: 98, full_name: RELEASE_REPOSITORY, default_branch: 'main' },
    [`${root}/actions/workflows/frozen-release-updater-acceptance.yml`]: { id: 51, path: UPDATER_WORKFLOW },
    [`${root}/actions/runs/${run.runId}`]: actual,
    [`${root}/branches/main`]: branch,
    [`${root}/compare/${sourceHead}...${sourceHead}`]: ancestry,
    [`${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs?per_page=100&page=1`]: jobs,
    [`${root}/actions/artifacts/${artifact.id}`]: artifact,
  }
  const api = path => { assert.ok(responses[path], `unexpected API path: ${path}`); return responses[path] }
  const temporary = mkdtempSync(join(tmpdir(), 'railwise-updater-proof-test-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const archive = (extra = []) => {
    writeFileSync(join(temporary, 'frozen-updater.json'), machineBytes)
    writeFileSync(join(temporary, 'native-updater.json'), nativeBytes)
    const target = join(temporary, 'reports.zip')
    rmSync(target, { force: true })
    execFileSync('zip', ['-q', target, 'frozen-updater.json', 'native-updater.json', ...extra], { cwd: temporary })
    const bytes = readFileSync(target)
    run.artifact.digest = `sha256:${reportSha256(bytes)}`
    return bytes
  }
  return { run, machine, sourceHead, machineBytes, nativeBytes, actual, artifact, job, jobs, branch, ancestry, responses, root, api, archive, temporary }
}

test('updater report provenance binds the exact freeze, run and retained native bytes', t => {
  const f = fixture(t)
  assert.equal(validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead), f.run)
  assert.equal(verifyUpdaterEvidenceSource(f.run, f.api), f.run)
  assert.equal(Object.hasOwn(f.actual, 'workflow_ref'), false)
  assert.equal(Object.hasOwn(f.artifact.workflow_run, 'run_attempt'), false)
  verifyUpdaterEvidenceArchive({ ...f, archive: f.archive() })
})

test('wrong or incomplete native updater workflow and artifacts cannot authorize release', async t => {
  const changes = {
    fork: f => { f.actual.head_repository.id += 1 },
    wrongWorkflow: f => { f.actual.workflow_id += 1 },
    wrongPath: f => { f.actual.path = '.github/workflows/other.yml' },
    featureBranch: f => { f.actual.head_branch = 'codex/feature' },
    wrongSource: f => { f.actual.head_sha = 'd'.repeat(40) },
    oldAttempt: f => { f.actual.run_attempt -= 1 },
    failedRun: f => { f.actual.conclusion = 'failure' },
    pullRequest: f => { f.actual.event = 'pull_request' },
    unprotected: f => { f.branch.protected = false },
    diverged: f => { f.ancestry.status = 'diverged' },
    falseIdentical: f => { f.branch.commit.sha = 'b'.repeat(40); f.responses[`${f.root}/compare/${f.sourceHead}...${f.branch.commit.sha}`] = f.ancestry },
    skippedJob: f => { f.job.conclusion = 'skipped' },
    duplicateJob: f => { f.jobs.jobs.push(f.job); f.jobs.total_count += 1 },
    skippedNativeStep: f => { f.job.steps[0].conclusion = 'skipped' },
    failedRetention: f => { f.job.steps[1].conclusion = 'failure' },
    expiredArtifact: f => { f.artifact.expired = true },
    wrongArtifactId: f => { f.artifact.id += 1 },
    wrongArtifactName: f => { f.artifact.name = 'old-updater-artifact' },
    wrongDigest: f => { f.artifact.digest = `sha256:${'d'.repeat(64)}` },
    oldArtifactRun: f => { f.artifact.workflow_run.id += 1 },
    oldArtifactAttempt: f => { f.artifact.workflow_run.run_attempt = 1 },
    oldArtifactSource: f => { f.artifact.workflow_run.head_sha = 'b'.repeat(40) },
    incompleteJobs: f => { f.jobs.total_count = 2; f.responses[`${f.root}/actions/runs/${f.run.runId}/attempts/${f.run.runAttempt}/jobs?per_page=100&page=2`] = { total_count: 2, jobs: [] } },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, st => {
    const f = fixture(st); change(f)
    assert.throws(() => verifyUpdaterEvidenceSource(f.run, f.api), /updater-evidence/)
  })
})

test('same-version substituted reports and modified archive bytes are rejected', async t => {
  await t.test('old native report', st => {
    const f = fixture(st)
    assert.throws(() => verifyUpdaterEvidenceArchive({ ...f, archive: f.archive(), nativeBytes: Buffer.from('{"status":"passed","startedAt":"old-run"}\n') }), /native-updater.json differs/)
  })
  await t.test('rewritten machine declaration', st => {
    const f = fixture(st)
    assert.throws(() => verifyUpdaterEvidenceArchive({ ...f, archive: f.archive(), machineBytes: Buffer.from(JSON.stringify({ ...f.machine, changed: true })) }), /frozen-updater.json differs/)
  })
  await t.test('changed ZIP', st => {
    const f = fixture(st); const archive = f.archive(); archive[10] ^= 1
    assert.throws(() => verifyUpdaterEvidenceArchive({ ...f, archive }), /downloaded artifact digest/)
  })
  await t.test('unsafe nested entry', st => {
    const f = fixture(st); mkdirSync(join(f.temporary, 'nested')); writeFileSync(join(f.temporary, 'nested', 'native-updater.json'), 'old')
    assert.throws(() => verifyUpdaterEvidenceArchive({ ...f, archive: f.archive(['nested/native-updater.json']) }), /unexpected updater artifact entries/)
  })
})

test('successful workflow jobs can span multiple API pages', t => {
  const f = fixture(t)
  f.jobs.total_count = 2
  f.responses[`${f.root}/actions/runs/${f.run.runId}/attempts/${f.run.runAttempt}/jobs?per_page=100&page=2`] = {
    total_count: 2, jobs: [{ name: 'unrelated', conclusion: 'success' }],
  }
  verifyUpdaterEvidenceSource(f.run, f.api)
})
