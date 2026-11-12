import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { RELEASE_REPOSITORY } from './verify-reviewed-release-artifacts.mjs'
import { FROZEN_BASE_VERSION, FROZEN_BASELINE_PINS } from './frozen-release-version.mjs'
import { reportSha256, UPDATER_JOB, UPDATER_WORKFLOW, UPDATER_WORKFLOW_REF, validateUpdaterEvidenceRun, verifyUpdaterEvidenceArchive, verifyUpdaterEvidenceSource } from './verify-frozen-updater-evidence.mjs'
import { validateUpdaterServiceEvidence } from './frozen-release-updater-service-contract.mjs'

// Synthetic contract fixtures only; these are never package acceptance records.
function serviceIdentity(sourceHead, { version = '0.5.4', layout = 'asar-unpacked', asarSha256 = 'e'.repeat(64) } = {}) {
  const compatibility = layout === 'source-compatibility'
  const dependencyRoot = compatibility ? 'node_modules' : `app.${layout === 'asar' ? 'asar' : 'asar.unpacked'}/kun/node_modules`
  return {
    schemaVersion: 1, packageVersion: version, packageSourceHead: version === FROZEN_BASE_VERSION ? null : sourceHead, asarSha256, layout,
    serviceSourceHead: compatibility || version !== FROZEN_BASE_VERSION ? sourceHead : null,
    serviceTreeSha256: 'a'.repeat(64),
    modules: ['engineering-service', 'survey-service'].map(name => ({ path: `dist/engineering/${name}.js`, sha256: 'b'.repeat(64) })),
    dependencies: ['better-sqlite3', 'better-sqlite3-native', 'jszip', 'pdfkit', 'zod'].map(name => ({ name,
      path: `${dependencyRoot}/${name === 'better-sqlite3-native' ? 'better-sqlite3/build/Release/better_sqlite3.node' : `${name}/package.json`}`, sha256: 'c'.repeat(64),
      ...(name === 'better-sqlite3-native' ? {} : { treeSha256: 'd'.repeat(64) }) })),
  }
}

function serviceEvidence(sourceHead, version = '0.5.4') {
  const target = serviceIdentity(sourceHead, { version })
  return { baseVersion: FROZEN_BASE_VERSION, targetVersion: version, targetAsarSha256: target.asarSha256, installedAsarSha256: target.asarSha256,
    targetServiceIdentity: target,
    dataSeed: { serviceSource: 'source-bound-compatibility-service', serviceIdentity: serviceIdentity(sourceHead, { version: FROZEN_BASE_VERSION, layout: 'source-compatibility', asarSha256: 'f'.repeat(64) }) },
    dataReadback: { serviceSource: 'target-package', serviceIdentity: structuredClone(target) },
    dataRestartReadback: { serviceSource: 'target-package', serviceIdentity: structuredClone(target) } }
}

function fixture(t, version = '0.5.4') {
  const sourceHead = 'a'.repeat(40)
  const run = { repository: RELEASE_REPOSITORY, workflowPath: UPDATER_WORKFLOW, sourceHead, runId: 4321, runAttempt: 2,
    artifact: { id: 91, name: 'frozen-updater-arm64-4321', digest: `sha256:${'b'.repeat(64)}` } }
  const nativeBytes = Buffer.from('{"status":"passed","startedAt":"new-run"}\n')
  const machine = { ...serviceEvidence(sourceHead, version), arch: 'arm64', nativeReportSha256: reportSha256(nativeBytes), provenance: { repository: run.repository, workflowPath: run.workflowPath,
    workflowRef: UPDATER_WORKFLOW_REF, workflowSha: sourceHead, sourceHead, runId: run.runId, runAttempt: run.runAttempt } }
  const machineBytes = Buffer.from(JSON.stringify(machine) + '\n')
  const root = `repos/${RELEASE_REPOSITORY}`
  const job = { name: UPDATER_JOB, conclusion: 'success', steps: [
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
  assert.equal(validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead, '0.5.4'), f.run)
  assert.equal(verifyUpdaterEvidenceSource(f.run, f.api), f.run)
  assert.equal(Object.hasOwn(f.actual, 'workflow_ref'), false)
  assert.equal(Object.hasOwn(f.artifact.workflow_run, 'run_attempt'), false)
  verifyUpdaterEvidenceArchive({ ...f, archive: f.archive() })
})

test('updater evidence pins the published 0.5.3 baseline assets for each native architecture', () => {
  assert.equal(FROZEN_BASE_VERSION, '0.5.3')
  assert.deepEqual(FROZEN_BASELINE_PINS.arm64, {
    name: 'WorkWise-0.5.3-mac-Apple-Silicon.dmg', size: 301352326,
    sha256: '6b12d991bee1853f93ab13e37aee8cf9759ea17642252bf7e11fa11ea0b37c6e', assetId: 630646810,
  })
  assert.deepEqual(FROZEN_BASELINE_PINS.x64, {
    name: 'WorkWise-0.5.3-mac-Intel.dmg', size: 306907651,
    sha256: '59613948518d9622d21063bff98aba2d78714d797f773b353bea313995975560', assetId: 630646813,
  })
})

test('0.5.4 native provenance requires the independently expected manifest target', t => {
  const f = fixture(t, '0.5.4')
  assert.equal(validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead, '0.5.4'), f.run)
  assert.equal(verifyUpdaterEvidenceSource(f.run, f.api), f.run)
  verifyUpdaterEvidenceArchive({ ...f, archive: f.archive() })
  assert.throws(() => validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead, '0.5.5'), /target version mismatch/)
  assert.throws(() => validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead), /explicit stable/)
  assert.throws(() => validateUpdaterServiceEvidence(f.machine, { sourceHead: f.sourceHead }), /explicit stable/)
  // Coherent older target identities and readbacks cannot choose the expected
  // release version by agreeing with one another.
  const older = fixture(t, '0.5.3')
  assert.throws(() => validateUpdaterEvidenceRun(older.run, older.machine, older.sourceHead, '0.5.4'), /target version mismatch/)
  const wrongPackage = structuredClone(f.machine)
  for (const identity of [wrongPackage.targetServiceIdentity, wrongPackage.dataReadback.serviceIdentity, wrongPackage.dataRestartReadback.serviceIdentity]) identity.packageVersion = '0.5.3'
  assert.throws(() => validateUpdaterServiceEvidence(wrongPackage, { sourceHead: f.sourceHead, version: '0.5.4' }), /target package version mismatch/)
})

test('retained archive accepts the runner service inspection and both historical readbacks', t => {
  const f = fixture(t)
  const reports = {
    'target-services.json': { mode: 'inspect', serviceSource: 'target-package', serviceIdentity: f.machine.targetServiceIdentity },
    'seed-data.json': f.machine.dataSeed,
    'verify-data.json': f.machine.dataReadback,
    'verify-restart-data.json': f.machine.dataRestartReadback,
  }
  for (const [name, report] of Object.entries(reports)) writeFileSync(join(f.temporary, name), JSON.stringify(report) + '\n')
  verifyUpdaterEvidenceArchive({ ...f, archive: f.archive(Object.keys(reports)) })
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

test('both real native architectures use their exact report architecture in the artifact name', t => {
  for (const arch of ['arm64', 'x64']) {
    const f = fixture(t); f.machine.arch = arch; f.run.artifact.name = `frozen-updater-${arch}-${f.run.runId}`
    assert.equal(validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead, '0.5.4'), f.run)
    f.run.artifact.name = `frozen-updater-${arch === 'arm64' ? 'x64' : 'arm64'}-${f.run.runId}`
    assert.throws(() => validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead, '0.5.4'), /artifact name mismatch/)
  }
  for (const arch of [undefined, 'ARM64', 'x86', 'unsupported']) {
    const f = fixture(t); f.machine.arch = arch; f.run.artifact.name = `frozen-updater-${arch}-${f.run.runId}`
    assert.throws(() => validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead, '0.5.4'), /supported native macOS architecture/)
  }
})

test('packaged service contracts support both layouts and explicitly labeled baseline compatibility', () => {
  const sourceHead = 'a'.repeat(40)
  for (const version of ['0.5.4']) for (const layout of ['asar-unpacked', 'asar']) {
    const machine = { ...serviceEvidence(sourceHead, version), arch: 'arm64' }
    machine.targetServiceIdentity = serviceIdentity(sourceHead, { layout, version })
    for (const key of ['dataReadback', 'dataRestartReadback']) machine[key].serviceIdentity = structuredClone(machine.targetServiceIdentity)
    assert.equal(validateUpdaterServiceEvidence(machine, { sourceHead, version }), machine)
    machine.dataSeed = { serviceSource: 'baseline-package', serviceIdentity: serviceIdentity(sourceHead, { version: FROZEN_BASE_VERSION, layout }) }
    assert.equal(validateUpdaterServiceEvidence(machine, { sourceHead, version }), machine)
    machine.dataSeed.serviceIdentity.packageSourceHead = 'd'.repeat(40)
    machine.dataSeed.serviceIdentity.serviceSourceHead = 'd'.repeat(40)
    assert.equal(validateUpdaterServiceEvidence(machine, { sourceHead, version }), machine)
  }
})

test('explicit baseline flows through service readback without changing historical defaults', () => {
  const sourceHead = 'a'.repeat(40); const version = '0.5.5'
  const machine = { ...serviceEvidence(sourceHead, version), arch: 'arm64', baseVersion: '0.5.4' }
  machine.dataSeed.serviceIdentity.packageVersion = '0.5.4'
  assert.equal(validateUpdaterServiceEvidence(machine, { sourceHead, version, baseVersion: '0.5.4' }), machine)
  assert.throws(() => validateUpdaterServiceEvidence(machine, { sourceHead, version }), /baseline version/)
  machine.dataSeed.serviceIdentity.packageVersion = '0.5.3'
  assert.throws(() => validateUpdaterServiceEvidence(machine, { sourceHead, version, baseVersion: '0.5.4' }), /dataSeed package version/)
})

test('source fallback, unbound or changed services and unsafe dependency identities are rejected', async t => {
  const changes = {
    targetFallback: f => { f.machine.dataReadback.serviceSource = 'source-bound-compatibility-service' },
    mislabeledTarget: f => { f.machine.dataRestartReadback.serviceSource = 'baseline-package' },
    missingFrozenIdentity: f => { delete f.machine.targetServiceIdentity },
    missingReadbackIdentity: f => { delete f.machine.dataReadback.serviceIdentity },
    missingRestartIdentity: f => { delete f.machine.dataRestartReadback.serviceIdentity },
    wrongFrozenVersion: f => { f.machine.targetServiceIdentity.packageVersion = '0.5.2' },
    wrongFrozenSource: f => { f.machine.targetServiceIdentity.packageSourceHead = 'd'.repeat(40) },
    wrongServiceSource: f => { f.machine.targetServiceIdentity.serviceSourceHead = 'd'.repeat(40) },
    wrongFrozenAsar: f => { f.machine.targetServiceIdentity.asarSha256 = 'd'.repeat(64) },
    wrongInstalledAsar: f => { f.machine.installedAsarSha256 = 'd'.repeat(64) },
    sourceLayout: f => { f.machine.targetServiceIdentity.layout = 'source-compatibility' },
    changedRestartModule: f => { f.machine.dataRestartReadback.serviceIdentity.modules[0].sha256 = 'd'.repeat(64) },
    changedRestartDependency: f => { f.machine.dataRestartReadback.serviceIdentity.dependencies[0].sha256 = 'd'.repeat(64) },
    changedRestartServiceTree: f => { f.machine.dataRestartReadback.serviceIdentity.serviceTreeSha256 = 'b'.repeat(64) },
    changedRestartDependencyTree: f => { f.machine.dataRestartReadback.serviceIdentity.dependencies[0].treeSha256 = 'b'.repeat(64) },
    missingServiceTree: f => { delete f.machine.targetServiceIdentity.serviceTreeSha256 },
    missingDependencyTree: f => { delete f.machine.targetServiceIdentity.dependencies[0].treeSha256 },
    missingModule: f => { f.machine.targetServiceIdentity.modules.pop() },
    wrongModulePath: f => { f.machine.targetServiceIdentity.modules[0].path = 'src/engineering/engineering-service.ts' },
    wrongModuleHash: f => { f.machine.targetServiceIdentity.modules[0].sha256 = 'invalid' },
    missingNativeDependency: f => { f.machine.targetServiceIdentity.dependencies = f.machine.targetServiceIdentity.dependencies.filter(item => item.name !== 'better-sqlite3-native') },
    duplicateDependency: f => { f.machine.targetServiceIdentity.dependencies.push(f.machine.targetServiceIdentity.dependencies[0]) },
    wrongDependencyHash: f => { f.machine.targetServiceIdentity.dependencies[0].sha256 = 'D'.repeat(64) },
    dependencyOutsidePackage: f => { f.machine.targetServiceIdentity.dependencies[0].path = 'node_modules/better-sqlite3/lib/index.js' },
    dependencyWrongPackage: f => { f.machine.targetServiceIdentity.dependencies[0].path = 'app.asar/kun/node_modules/another-package/index.js' },
    dependencyNotNative: f => { f.machine.targetServiceIdentity.dependencies[1].path = 'app.asar.unpacked/node_modules/better-sqlite3/index.js' },
    wrongSeedVersion: f => { f.machine.dataSeed.serviceIdentity.packageVersion = '0.5.2' },
    wrongSeedSource: f => { f.machine.dataSeed.serviceIdentity.serviceSourceHead = 'd'.repeat(40) },
    unboundSeedSource: f => { f.machine.dataSeed.serviceIdentity.serviceSourceHead = null },
    mislabeledSeed: f => { f.machine.dataSeed.serviceSource = 'baseline-package' },
    seedMissingAsar: f => { delete f.machine.dataSeed.serviceIdentity.asarSha256 },
    unboundSeedPackageSource: f => { delete f.machine.dataSeed.serviceIdentity.packageSourceHead },
  }
  for (const path of ['/host/node_modules/better-sqlite3/index.js', 'app.asar/../node_modules/better-sqlite3/index.js',
    'app.asar//node_modules/better-sqlite3/index.js', 'app.asar/./node_modules/better-sqlite3/index.js',
    'app.asar\\node_modules\\better-sqlite3\\index.js', 'https://host/node_modules/better-sqlite3/index.js',
    'app.asar/node_modules/better-sqlite3/index.js\n']) {
    changes[`unsafePath:${JSON.stringify(path)}`] = f => { f.machine.targetServiceIdentity.dependencies[0].path = path }
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, st => {
    const f = fixture(st); change(f)
    assert.throws(() => validateUpdaterEvidenceRun(f.run, f.machine, f.sourceHead, '0.5.4'), /updater-service/)
  })
})


test('current native smoke requires paused/waiting tasks, pending inputs, file history and draft readback twice', () => {
  const head = 'a'.repeat(40)
  const machine = { ...serviceEvidence(head, '0.5.6'), arch: 'arm64', baseVersion: '0.5.4' }
  machine.dataSeed.serviceIdentity.packageVersion = '0.5.4'
  const taskContinuity = { status: 'passed', taskStates: ['paused', 'waiting_user'], pendingInputs: 2, pendingQuestions: 1,
    drafts: 1, readableThreads: 2, preservedMessages: 2, candidateReceiptStatus: 'succeeded', draftSha256: 'd'.repeat(64), baselineSha256: 'b'.repeat(64) }
  for (const key of ['dataSeed', 'dataReadback', 'dataRestartReadback']) machine[key].taskContinuity = structuredClone(taskContinuity)
  const expected = { sourceHead: head, version: '0.5.6', baseVersion: '0.5.4', requireTaskContinuity: true }
  assert.equal(validateUpdaterServiceEvidence(machine, expected), machine)
  for (const change of [value => { delete value.dataReadback.taskContinuity },
    value => { value.dataRestartReadback.taskContinuity.taskStates = ['completed', 'waiting_user'] },
    value => { value.dataRestartReadback.taskContinuity.draftSha256 = 'f'.repeat(64) },
    value => { value.dataSeed.taskContinuity.pendingInputs = 0 }]) {
    const changed = structuredClone(machine); change(changed)
    assert.throws(() => validateUpdaterServiceEvidence(changed, expected), /Task|task|continuity/)
  }
})
