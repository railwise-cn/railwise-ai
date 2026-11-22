import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { expectedReleaseFiles, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256 } from './verify-frozen-updater-evidence.mjs'
import { requiredCoreJourneys, requiresCoreJourneys, validateCoreJourneyReceipts, verifyRemoteCoreJourneyReceipts } from './verify-core-journeys.mjs'

const version = '0.5.11'
const sourceHead = '1'.repeat(40)
const build = {
  mode: 'exact-build', sourceHead, runId: 1234, runAttempt: 1, artifacts: [{ id: 55 }, { id: 56 }],
  files: expectedReleaseFiles(version).map(file => ({ ...file, sha256: reportSha256(file.name) }))
}
const packageIdentity = {
  artifactSha256: build.files.find(file => file.platform === 'darwin-arm64').sha256,
  asarSha256: 'e'.repeat(64)
}
const options = { version, build, packageIdentity }
const methods = {
  'website-pptx': 'live-model-ui',
  'browserskill-fallback': 'real-browser-ui',
  'ego-dadan-report': 'authenticated-ego-ui',
  'mainland-windows-install': 'mainland-windows-ui'
}
function fixture() {
  return [...requiredCoreJourneys(version)].map(([target, ids]) => {
    const [platform, arch] = target.split('-')
    return { receipt: {
      schemaVersion: 1, status: 'passed', version, sourceHead, platform, arch, execution: 'field',
      buildRunId: build.runId, buildRunAttempt: build.runAttempt,
      installerSha256: build.files.find(file => file.platform === target && /\.(exe|dmg)$/.test(file.name)).sha256,
      installedAsarSha256: 'e'.repeat(64),
      journeys: ids.map(id => ({ id, status: 'passed', method: methods[id] ?? 'installed-ui', evidence: 'Synthetic installed application observation', proofSha256: 'a'.repeat(64) }))
    } }
  })
}

function futureFixture(changedPaths = []) {
  const futureVersion = '0.5.12'
  const futureBuild = {
    ...build,
    files: expectedReleaseFiles(futureVersion).map(file => ({ ...file, sha256: reportSha256(file.name) }))
  }
  const futureIdentity = {
    ...packageIdentity,
    artifactSha256: futureBuild.files.find(file => file.platform === 'darwin-arm64').sha256
  }
  const records = [...requiredCoreJourneys(futureVersion, { changedPaths })].map(([target, ids]) => {
    const [platform, arch] = target.split('-')
    return { receipt: {
      schemaVersion: 1, status: 'passed', version: futureVersion, sourceHead, platform, arch, execution: 'field',
      buildRunId: futureBuild.runId, buildRunAttempt: futureBuild.runAttempt,
      installerSha256: futureBuild.files.find(file => file.platform === target && /\.(exe|dmg)$/.test(file.name)).sha256,
      installedAsarSha256: 'e'.repeat(64),
      journeys: ids.map(id => ({ id, status: 'passed', method: methods[id] ?? 'installed-ui', evidence: 'Synthetic installed application observation', proofSha256: 'a'.repeat(64) }))
    } }
  })
  return { records, options: { version: futureVersion, build: futureBuild, packageIdentity: futureIdentity, changedPaths } }
}

function hosted(record, t) {
  const { receipt } = record
  receipt.execution = 'hosted'
  receipt.journeys = receipt.journeys.filter(journey => journey.id === 'conversation-task')
  const raw = Buffer.from('{"status":"passed"}\n')
  Object.assign(receipt.journeys[0], { proofFile: 'windows-install-smoke.json', proofSha256: reportSha256(raw) })
  receipt.provenance = { repository: RELEASE_REPOSITORY, workflowPath: RELEASE_WORKFLOW, sourceHead, runId: 1234, runAttempt: 1 }
  record.bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  const directory = mkdtempSync(join(tmpdir(), 'railwise-core-journeys-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'core-journeys.json'), record.bytes)
  writeFileSync(join(directory, 'windows-install-smoke.json'), raw)
  const zipPath = join(directory, 'evidence.zip')
  execFileSync('zip', ['-q', zipPath, 'core-journeys.json', 'windows-install-smoke.json'], { cwd: directory })
  const archive = readFileSync(zipPath)
  record.workflowRun = {
    ...receipt.provenance, jobName: 'Private exact-package Windows install smoke',
    artifact: { id: 87, name: 'exact-package-windows-install-1234', digest: `sha256:${reportSha256(archive)}` }
  }
  const root = `repos/${RELEASE_REPOSITORY}`
  const run = { id: 1234, workflow_id: 40, path: RELEASE_WORKFLOW, run_attempt: 1, repository: { id: 32 }, head_repository: { id: 32 },
    head_sha: sourceHead, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }
  const artifact = { ...record.workflowRun.artifact, size_in_bytes: archive.length, expired: false,
    workflow_run: { id: 1234, run_attempt: 1, head_sha: sourceHead, repository_id: 32, head_repository_id: 32 } }
  const job = { name: record.workflowRun.jobName, status: 'completed', conclusion: 'success' }
  const responses = {
    [root]: { id: 32, full_name: RELEASE_REPOSITORY },
    [`${root}/actions/workflows/release.yml`]: { id: 40, path: RELEASE_WORKFLOW },
    [`${root}/actions/runs/1234`]: run,
    [`${root}/actions/runs/1234/attempts/1/jobs?per_page=100&page=1`]: { jobs: [job], total_count: 1 },
    [`${root}/actions/artifacts/87`]: artifact,
    [`${root}/actions/artifacts/87/zip`]: archive
  }
  const api = path => {
    assert.ok(Object.hasOwn(responses, path), `Unexpected API request ${path}`)
    return responses[path]
  }
  return { run, artifact, job, api, responses, root }
}

test('new stable release versions require the structured matrix and legacy versions do not', () => {
  assert.equal(requiresCoreJourneys('0.5.10'), false)
  for (const target of ['0.5.11', '0.5.20', '0.6.0', '1.0.0']) assert.equal(requiresCoreJourneys(target), true)
  assert.ok(requiredCoreJourneys(version).get('win32-x64').includes('windows-legacy-overlay'))
  assert.ok(requiredCoreJourneys(version).get('win32-x64').includes('browserskill-fallback'))
  assert.deepEqual(requiredCoreJourneys(version).get('darwin-arm64'), [
    'website-pptx', 'startup-branding', 'offline-spreadsheet', 'ego-dadan-report'
  ])
  assert.ok(!requiredCoreJourneys(version).get('darwin-arm64').includes('browserskill-fallback'))
  assert.ok(!requiredCoreJourneys(version).get('darwin-arm64').includes('kun-ag-ui-recovery'))
  assert.ok(!requiredCoreJourneys(version).get('darwin-arm64').includes('public-procurement-html'))
  assert.ok(!requiredCoreJourneys(version).get('win32-x64').includes('kun-ag-ui-recovery'))
  assert.ok(!requiredCoreJourneys(version).get('win32-x64').includes('public-procurement-html'))
  assert.ok(!requiredCoreJourneys('0.5.12').get('win32-x64').includes('windows-updater-sidebar'))
  assert.ok(requiredCoreJourneys('0.5.12', { updater: true }).get('win32-x64').includes('windows-updater-sidebar'))
  assert.deepEqual(validateCoreJourneyReceipts(fixture(), options), [])
})

test('later releases require field journeys only for related production changes', () => {
  const unrelatedChanges = [
    'README.md', 'kun/src/services/agent-loop.test.ts', 'scripts/verify-core-journeys.test.mjs',
    'src/shared/marketplace.test.ts',
    'docs/qa/release-gates/acceptance.md'
  ]
  const unrelated = futureFixture(unrelatedChanges)
  assert.ok(!requiredCoreJourneys('0.5.12', { changedPaths: unrelatedChanges }).get('darwin-arm64').includes('ego-dadan-report'))
  assert.ok(!requiredCoreJourneys('0.5.12', { changedPaths: unrelatedChanges }).get('win32-x64').includes('mainland-windows-install'))
  assert.deepEqual(validateCoreJourneyReceipts(unrelated.records, unrelated.options), [])

  const browserChanges = ['kun/src/services/ego-browser-runtime.ts']
  const browser = futureFixture()
  assert.ok(requiredCoreJourneys('0.5.12', { changedPaths: browserChanges }).get('darwin-arm64').includes('ego-dadan-report'))
  assert.throws(() => validateCoreJourneyReceipts(browser.records, { ...browser.options, changedPaths: browserChanges }), /missing required journeys.*ego-dadan-report/)

  const marketplaceChanges = ['src/main/services/marketplace-mirror.ts']
  const marketplace = futureFixture()
  assert.ok(requiredCoreJourneys('0.5.12', { changedPaths: marketplaceChanges }).get('win32-x64').includes('mainland-windows-install'))
  assert.throws(() => validateCoreJourneyReceipts(marketplace.records, { ...marketplace.options, changedPaths: marketplaceChanges }), /missing required journeys.*mainland-windows-install/)

  const lockChange = ['src/shared/marketplace-mirror-lock.json']
  assert.ok(requiredCoreJourneys('0.5.12', { changedPaths: lockChange }).get('win32-x64').includes('mainland-windows-install'))
})

test('core receipts reject stale, incomplete, failed and simulated results', async t => {
  const mutations = [
    ['omitted platform', reports => reports.pop(), /missing required journeys.*darwin-x64/],
    ['old build', ([record]) => { record.receipt.buildRunId-- }, /build run ID/],
    ['old attempt', ([record]) => { record.receipt.buildRunAttempt++ }, /build run attempt/],
    ['old source', ([record]) => { record.receipt.sourceHead = '0'.repeat(40) }, /packaged source HEAD/],
    ['old installer', ([record]) => { record.receipt.installerSha256 = '2'.repeat(64) }, /reviewed installer SHA-256/],
    ['wrong platform', ([record]) => { record.receipt.arch = 'arm64' }, /unsupported receipt platform/],
    ['duplicate journey', ([record]) => record.receipt.journeys.push(record.receipt.journeys[0]), /duplicate required journey/],
    ['skipped journey', ([record]) => { record.receipt.journeys[0].status = 'skipped' }, /status mismatch/],
    ['failed journey', ([record]) => { record.receipt.journeys[0].status = 'failed' }, /status mismatch/],
    ['simulated model', ([record]) => { record.receipt.journeys.find(journey => journey.id === 'website-pptx').method = 'installed-ui' }, /website-pptx test method/],
    ['simulated market', ([record]) => { record.receipt.journeys.find(journey => journey.id === 'mainland-windows-install').method = 'installed-ui' }, /mainland-windows-install test method/],
    ['missing raw proof', ([record]) => { delete record.receipt.journeys[0].proofSha256 }, /raw proof/],
    ['wrong installed ASAR', ([, record]) => { record.receipt.installedAsarSha256 = 'a'.repeat(64) }, /reviewed installed ASAR/],
  ]
  for (const [name, mutate, error] of mutations) await t.test(name, () => {
    const records = fixture()
    mutate(records)
    assert.throws(() => validateCoreJourneyReceipts(records, options), error)
  })
})

test('hosted receipts verify the original bytes and matching completed workflow attempt', t => {
  const records = fixture()
  const record = structuredClone(records[0])
  records[0].receipt.journeys.shift()
  const { run, artifact, job, api } = hosted(record, t)
  const verified = validateCoreJourneyReceipts([...records, record], options)
  assert.equal(verified.length, 1)
  verifyRemoteCoreJourneyReceipts(verified, api)
  assert.throws(() => verifyRemoteCoreJourneyReceipts([{ ...verified[0], bytes: Buffer.from('{}\n') }], api), /differs from the trusted immutable report/)
  run.run_attempt = 2
  assert.throws(() => verifyRemoteCoreJourneyReceipts(verified, api), /run attempt/)
  run.run_attempt = 1
  job.conclusion = 'skipped'
  assert.throws(() => verifyRemoteCoreJourneyReceipts(verified, api), /trusted receipt job/)
  job.conclusion = 'success'
  artifact.workflow_run.id++
  assert.throws(() => verifyRemoteCoreJourneyReceipts(verified, api), /artifact run/)
})
