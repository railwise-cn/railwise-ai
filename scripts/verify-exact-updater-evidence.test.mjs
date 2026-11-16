import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW, expectedReleaseFiles } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256 } from './verify-frozen-updater-evidence.mjs'
import { EXACT_UPDATER_JOB, validateExactUpdaterEvidenceRun, verifyExactUpdaterEvidenceSource, verifyExactUpdaterEvidenceArchive, verifyRemoteExactUpdaterEvidence } from './verify-exact-updater-evidence.mjs'

// Synthetic fixtures exercise the evidence contract; they are not acceptance records.
function identity(sourceHead, version, { compatibility = false } = {}) {
  const root = compatibility ? 'node_modules' : 'app.asar.unpacked/kun/node_modules'
  return {
    schemaVersion: 1, packageVersion: version, packageSourceHead: sourceHead, serviceSourceHead: sourceHead,
    asarSha256: 'e'.repeat(64), serviceTreeSha256: 'a'.repeat(64), layout: compatibility ? 'source-compatibility' : 'asar-unpacked',
    modules: ['engineering-service', 'survey-service'].map(name => ({ path: `dist/engineering/${name}.js`, sha256: 'b'.repeat(64) })),
    dependencies: ['better-sqlite3', 'better-sqlite3-native', 'jszip', 'pdfkit', 'zod'].map(name => ({ name,
      path: `${root}/${name === 'better-sqlite3-native' ? 'better-sqlite3/build/Release/better_sqlite3.node' : `${name}/package.json`}`, sha256: 'c'.repeat(64),
      ...(name === 'better-sqlite3-native' ? {} : { treeSha256: 'd'.repeat(64) }) }))
  }
}

function fixture(t, { version = '0.5.5', baseVersion = '0.5.4' } = {}) {
  const sourceHead = 'a'.repeat(40)
  const headRef = 'refs/heads/codex/durable-task-document-workbench'
  const workflowRef = `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@${headRef}`
  const build = { mode: 'exact-build', repository: RELEASE_REPOSITORY, workflowPath: RELEASE_WORKFLOW, sourceHead, headRef, workflowRef, workflowSha: sourceHead,
    runId: 42573336374, runAttempt: 1, files: expectedReleaseFiles(version).map((file, i) => ({ ...file, size: i + 100, sha256: String(i + 1).repeat(64) })) }
  const run = { repository: build.repository, workflowPath: build.workflowPath, sourceHead, headRef, workflowRef, workflowSha: sourceHead, runId: build.runId, runAttempt: 1,
    artifact: { id: 8192, name: `exact-package-updater-${build.runId}`, digest: `sha256:${'b'.repeat(64)}` } }
  const nativeBytes = Buffer.from('{"schemaVersion":1,"status":"passed","synthetic":true}\n')
  const target = identity(sourceHead, version)
  const machine = { schemaVersion: 1, status: 'passed', platform: 'darwin', arch: 'arm64', baseVersion, targetVersion: version,
    targetAsarSha256: target.asarSha256, installedAsarSha256: target.asarSha256, targetServiceIdentity: target,
    dataSeed: { serviceSource: 'source-bound-compatibility-service', serviceIdentity: identity(sourceHead, baseVersion, { compatibility: true }) },
    dataReadback: { serviceSource: 'target-package', serviceIdentity: structuredClone(target) }, dataRestartReadback: { serviceSource: 'target-package', serviceIdentity: structuredClone(target) },
    nativeReportSha256: reportSha256(nativeBytes),
    provenance: { repository: run.repository, workflowPath: run.workflowPath, workflowRef, workflowSha: sourceHead, sourceHead, runId: run.runId, runAttempt: run.runAttempt, mode: 'private-exact-package-smoke' },
    privatePackage: { sourceHead, artifactRunId: run.runId, artifactName: 'release-mac', files: structuredClone(build.files.filter(file => file.artifact === 'release-mac')) } }
  let machineBytes = Buffer.from(JSON.stringify(machine) + '\n')
  const root = `repos/${RELEASE_REPOSITORY}`
  const job = { name: EXACT_UPDATER_JOB, conclusion: 'success', steps: [
    { name: 'Exercise official baseline to exact artifact once', conclusion: 'success' },
    { name: 'Retain exact-package updater evidence', conclusion: 'success' }
  ] }
  const actual = { id: run.runId, run_attempt: 1, workflow_id: 51, path: RELEASE_WORKFLOW,
    repository: { id: 98 }, head_repository: { id: 98 }, head_branch: headRef.slice(11), head_sha: sourceHead,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }
  const artifact = { ...run.artifact, expired: false, workflow_run: { id: run.runId, head_sha: sourceHead, repository_id: 98, head_repository_id: 98 } }
  const jobs = { total_count: 1, jobs: [job] }
  const responses = {
    [root]: { id: 98, full_name: RELEASE_REPOSITORY, default_branch: 'main' },
    [`${root}/actions/workflows/release.yml`]: { id: 51, path: RELEASE_WORKFLOW },
    [`${root}/actions/runs/${run.runId}`]: actual,
    [`${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}/jobs?per_page=100&page=1`]: jobs,
    [`${root}/actions/artifacts/${artifact.id}`]: artifact
  }
  const temporary = mkdtempSync(join(tmpdir(), 'railwise-exact-updater-proof-test-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const archive = (extra = []) => {
    machineBytes = Buffer.from(JSON.stringify(machine) + '\n')
    writeFileSync(join(temporary, 'frozen-updater.json'), machineBytes)
    writeFileSync(join(temporary, 'native-updater.json'), nativeBytes)
    const path = join(temporary, 'reports.zip')
    rmSync(path, { force: true })
    execFileSync('zip', ['-q', path, 'frozen-updater.json', 'native-updater.json', ...extra], { cwd: temporary })
    const bytes = readFileSync(path)
    run.artifact.digest = `sha256:${reportSha256(bytes)}`
    artifact.digest = run.artifact.digest
    responses[`${root}/actions/artifacts/${artifact.id}/zip`] = bytes
    return bytes
  }
  const api = path => { assert.ok(responses[path], `unexpected API path: ${path}`); return responses[path] }
  return { run, build, machine, get machineBytes() { return machineBytes }, nativeBytes, version, sourceHead, actual, artifact, job, jobs, root, responses, temporary, api, archive }
}

test('same exact-build branch run retains raw reports and needs no second main freeze', t => {
  const f = fixture(t)
  assert.equal(validateExactUpdaterEvidenceRun(f.run, f.machine, f.build, f.version), f.run)
  assert.equal(verifyExactUpdaterEvidenceSource(f.run, f.api), f.run)
  const archive = f.archive()
  verifyExactUpdaterEvidenceArchive({ ...f, archive })
  verifyRemoteExactUpdaterEvidence(f, f.api)
})

test('explicit pinned 0.5.6 baseline validates 0.5.7 without reinterpreting historical reports', t => {
  const f = fixture(t, { version: '0.5.7', baseVersion: '0.5.6' })
  assert.equal(validateExactUpdaterEvidenceRun(f.run, f.machine, f.build, f.version, '0.5.6'), f.run)
  assert.throws(() => validateExactUpdaterEvidenceRun(f.run, f.machine, f.build, f.version), /baseline version mismatch/)
  for (const expected of ['0.5.4', '0.5.9', 'https://example.invalid/baseline.dmg', 'v0.5.6']) {
    assert.throws(() => validateExactUpdaterEvidenceRun(f.run, f.machine, f.build, f.version, expected))
  }
  f.machine.dataSeed.serviceIdentity.packageVersion = '0.5.4'
  assert.throws(() => validateExactUpdaterEvidenceRun(f.run, f.machine, f.build, f.version, '0.5.6'), /dataSeed package version mismatch/)
})

test('raw same-run provenance, original privatePackage and exact manifest cannot be forged', async t => {
  const changes = {
    schema: f => { f.machine.schemaVersion = 2 }, status: f => { f.machine.status = 'failed' }, platform: f => { f.machine.platform = 'linux' }, arch: f => { f.machine.arch = 'universal' },
    workflow: f => { f.run.workflowPath = '.github/workflows/frozen-release-updater-acceptance.yml' },
    repository: f => { f.run.repository = 'fork/repo' },
    branch: f => { f.run.headRef = 'refs/tags/v0.5.5' },
    workflowRef: f => { f.run.workflowRef = f.run.workflowRef.replace('codex/', '') },
    workflowSha: f => { f.run.workflowSha = 'b'.repeat(40) },
    artifactName: f => { f.run.artifact.name = 'frozen-updater-arm64-42573336374' },
    missingDigest: f => { delete f.run.artifact.digest },
    rewrittenProvenance: f => { delete f.machine.provenance.mode },
    extraProvenance: f => { f.machine.provenance.reviewed = true },
    oldAttempt: f => { f.machine.provenance.runAttempt = 2 },
    oldRun: f => { f.machine.provenance.runId -= 1 },
    substitutedReviewedBuild: f => { f.machine.reviewedBuild = f.build },
    missingPrivatePackage: f => { delete f.machine.privatePackage },
    source: f => { f.machine.privatePackage.sourceHead = 'b'.repeat(40) },
    packageRun: f => { f.machine.privatePackage.artifactRunId -= 1 },
    packageArtifact: f => { f.machine.privatePackage.artifactName = 'release-win' },
    missingFile: f => { f.machine.privatePackage.files.pop() },
    changedFile: f => { f.machine.privatePackage.files[0].sha256 = 'b'.repeat(64) },
    changedSize: f => { f.machine.privatePackage.files[0].size += 1 },
    changedPlatform: f => { f.machine.privatePackage.files[0].platform = 'win32-x64' },
    changedBuild: f => { f.build.runId += 1 },
    legacyBuildMode: f => { delete f.build.mode },
    missingNativeDigest: f => { delete f.machine.nativeReportSha256 },
    baseline: f => { f.machine.baseVersion = '0.5.3' },
    sourceServices: f => { f.machine.dataReadback.serviceSource = 'source-bound-compatibility-service' },
    changedService: f => { f.machine.dataRestartReadback.serviceIdentity.modules[0].sha256 = 'f'.repeat(64) }
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, t => {
    const f = fixture(t); change(f)
    assert.throws(() => validateExactUpdaterEvidenceRun(f.run, f.machine, f.build, f.version))
  })
})

test('only the real same-run repository, successful job, steps and immutable artifact are accepted', async t => {
  const changes = {
    fork: f => { f.actual.head_repository.id += 1 },
    repository: f => { f.actual.repository.id += 1 },
    workflow: f => { f.actual.workflow_id += 1 },
    workflowPath: f => { f.actual.path = '.github/workflows/other.yml' },
    wrongBranch: f => { f.actual.head_branch = 'main' },
    wrongSource: f => { f.actual.head_sha = 'b'.repeat(40) },
    wrongRun: f => { f.actual.id += 1 },
    oldAttempt: f => { f.actual.run_attempt += 1 },
    failed: f => { f.actual.conclusion = 'failure' },
    unfinished: f => { f.actual.status = 'in_progress' },
    pullRequest: f => { f.actual.event = 'pull_request' },
    skippedJob: f => { f.job.conclusion = 'skipped' },
    duplicateJob: f => { f.jobs.jobs.push(f.job); f.jobs.total_count += 1 },
    skippedLaunch: f => { f.job.steps[0].conclusion = 'skipped' },
    failedRetain: f => { f.job.steps[1].conclusion = 'failure' },
    expired: f => { f.artifact.expired = true },
    artifactId: f => { f.artifact.id += 1 },
    artifactName: f => { f.artifact.name = 'old-updater' },
    artifactDigest: f => { f.artifact.digest = `sha256:${'c'.repeat(64)}` },
    artifactRun: f => { f.artifact.workflow_run.id += 1 },
    artifactAttempt: f => { f.artifact.workflow_run.run_attempt = 2 },
    artifactSource: f => { f.artifact.workflow_run.head_sha = 'b'.repeat(40) },
    artifactRepository: f => { f.artifact.workflow_run.repository_id += 1 },
    artifactHeadRepository: f => { f.artifact.workflow_run.head_repository_id += 1 }
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, t => {
    const f = fixture(t); change(f)
    assert.throws(() => verifyExactUpdaterEvidenceSource(f.run, f.api))
  })
})

test('archive SHA and original machine/native bytes are bound without normalizing reports', async t => {
  await t.test('modified archive', t => {
    const f = fixture(t); const archive = f.archive()
    assert.throws(() => verifyExactUpdaterEvidenceArchive({ ...f, archive: Buffer.concat([archive, Buffer.from('changed')]) }), /artifact digest/)
  })
  await t.test('rewritten machine bytes', t => {
    const f = fixture(t); const archive = f.archive()
    const machineBytes = Buffer.from(JSON.stringify(f.machine, null, 2) + '\n')
    assert.throws(() => verifyExactUpdaterEvidenceArchive({ ...f, archive, machineBytes }), /differs from the trusted immutable report/)
  })
  await t.test('rewritten native bytes', t => {
    const f = fixture(t); const archive = f.archive()
    assert.throws(() => verifyExactUpdaterEvidenceArchive({ ...f, archive, nativeBytes: Buffer.from('{}\n') }), /native report digest/)
  })
  await t.test('path traversal', t => {
    const f = fixture(t)
    writeFileSync(join(f.temporary, 'unexpected.txt'), 'not an updater report')
    const archive = f.archive(['unexpected.txt'])
    assert.throws(() => verifyExactUpdaterEvidenceArchive({ ...f, archive }), /unexpected updater artifact entries/)
  })
})
