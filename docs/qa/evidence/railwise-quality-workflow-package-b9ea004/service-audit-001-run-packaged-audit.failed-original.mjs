import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const AUDIT = process.env.WORKWISE_AUDIT_ROOT ?? '/private/tmp/workwise-audit'
const CANDIDATE = process.env.WORKWISE_CANDIDATE_ROOT ?? '/private/tmp/workwise-candidate'
const HEAD = 'b9ea004b668d68b34a7d82ece6674ef2273a9bc3'
const [appArg, expectedAsar, runName, ...flags] = process.argv.slice(2)
const guiSeed = flags.length === 1 && flags[0] === '--prepare-gui'
assert(appArg && /^[a-f0-9]{64}$/.test(expectedAsar ?? '') && /^[a-z0-9-]{1,64}$/.test(runName ?? '') && (!flags.length || guiSeed),
  'Usage: ELECTRON_RUN_AS_NODE=1 <packaged executable> run-packaged-audit.mjs <app> <expected ASAR sha256> <new-run-name> [--prepare-gui]')
assert(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1', 'Use the exact packaged Electron runtime')
const app = realpathSync(appArg)
assert(app.startsWith(`${CANDIDATE}/Applications/`) && app.endsWith('.app'), 'Only the new isolated b9ea004 candidate is allowed')
const plist = join(app, 'Contents', 'Info.plist')
const plistValue = key => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim()
const executable = join(app, 'Contents', 'MacOS', plistValue('CFBundleExecutable'))
assert.equal(realpathSync(process.execPath), realpathSync(executable), 'Executable must be from the reviewed app')
const version = plistValue('CFBundleShortVersionString'), bundleId = plistValue('CFBundleIdentifier')
assert.equal(version, '0.5.0')
assert(bundleId.includes('.candidate.'), 'Public installation is forbidden')
mkdirSync(AUDIT, { recursive: true, mode: 0o700 })
assert.equal(realpathSync(AUDIT), AUDIT)
const require = createRequire(import.meta.url), disk = require('original-fs')
const sha = value => createHash('sha256').update(value).digest('hex')
const asarPath = join(app, 'Contents', 'Resources', 'app.asar')
assert.equal(sha(disk.readFileSync(asarPath)), expectedAsar, 'ASAR does not match candidate acceptance evidence')
const packagedMetadata = JSON.parse(readFileSync(join(app, 'Contents', 'Resources', 'app.asar', 'package.json'), 'utf8'))
assert.equal(packagedMetadata.buildProvenance?.sourceHead, HEAD, 'Packaged source provenance must identify the new committed increment')
execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
const root = join(AUDIT, runName)
assert(!existsSync(root), 'A previous run may not be overwritten')
mkdirSync(root, { mode: 0o700 })
const put = (name, value) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const modules = {}, moduleRoot = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'kun')
async function load(name) {
  const path = join(moduleRoot, 'dist', `${name}.js`)
  modules[name] = { path, sha256: sha(readFileSync(path)) }
  return import(pathToFileURL(path).href)
}
const identity = { app, executable, packageVersion: version, bundleId, expectedSourceHead: HEAD, asarPath, asarSha256: expectedAsar,
  node: process.versions.node, electron: process.versions.electron, signatureVerification: 'codesign --verify --deep --strict passed',
  notarization: 'not-evaluated-by-this-script', scriptSha256: sha(readFileSync(new URL(import.meta.url))),
  mode: guiSeed ? 'prepare-gui-only' : 'packaged-service-audit', evidenceOrigin: 'synthetic-software-audit-not-GUI-not-professional-signoff' }
put('package-identity.json', identity)
function isolated(path) {
  const target = resolve(path)
  assert(target.startsWith(`${CANDIDATE}/`))
  let current = CANDIDATE
  for (const part of target.slice(CANDIDATE.length + 1).split('/')) {
    current = join(current, part)
    if (existsSync(current)) assert(!lstatSync(current).isSymbolicLink(), `Candidate path contains symlink: ${current}`)
  }
  return target
}
const runtime = guiSeed ? isolated(join(CANDIDATE, 'home', '.workwise', 'runtime', 'engineering')) : join(root, 'runtime')
const workspace = guiSeed ? isolated(join(CANDIDATE, 'workspace', 'synthetic-quality-workflow')) : join(root, 'workspace')
let services = [], checks = [], outcome = 'failed', failure
const register = service => { services.push(service); return service }
const nowIso = () => '2026-09-24T09:00:00.000Z'
async function closeAll() {
  for (const service of services) if (service.flush) await service.flush()
  for (const service of services.reverse()) service.close()
  services = []
}
try {
  if (guiSeed) {
    const env = readFileSync(join(CANDIDATE, 'candidate.env'), 'utf8')
    assert(env.includes('export WORKWISE_CANDIDATE=1\n') && env.includes(`export WORKWISE_CANDIDATE_HOME=${CANDIDATE}/home\n`)
      && env.includes('export WORKWISE_CANDIDATE_CREDENTIAL_ACCESS=0\n') && env.includes(`export WORKWISE_CANDIDATE_SOURCE_HEAD=${HEAD}\n`), 'Candidate isolation declarations differ')
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/)
      return match && Number(match[1]) !== process.pid && (match[2].startsWith(executable) || match[2].includes(`${CANDIDATE}/home/.workwise/runtime`))
    })
    assert.equal(processes.length, 0, 'Close candidate GUI and Runtime before preparing its business store')
    assert(!existsSync(workspace), 'Existing GUI workspace is preserved')
    assert(!existsSync(runtime) || readdirSync(runtime).length === 0, 'GUI seeding requires an absent or empty engineering store; preserve any existing data')
  }
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const { EngineeringService } = await load('engineering/engineering-service')
  const { SurveyService } = await load('engineering/survey-service')
  const { importWorkwiseSurveyNetwork } = await load('engineering/survey-test-helpers')
  const { SurveyQualityWorkspaceService } = await load('engineering/survey-quality-workspace')
  const { SurveyQualityWorkflowService } = await load('engineering/survey-quality-workflow')
  const { SurveyQualityWorkflowReadV1 } = await load('contracts/survey-quality-workflow')
  const Database = createRequire(join(moduleRoot, 'package.json'))('better-sqlite3')
  const open = () => {
    let survey
    const engineering = register(new EngineeringService({ rootDir: runtime, nowIso, runtimeVersion: version,
      getAdjustments: (pid, ids) => ids.flatMap(id => { const value = survey.getAdjustmentForProjectNewUse(pid, id); return value?.result ? [value.result] : [] }),
      getAdjustmentEvidence: (pid, ids) => ids.flatMap(id => { const value = survey.getAdjustmentForProjectNewUse(pid, id); return value?.result ? [{ run: value.run, result: value.result }] : [] }),
      getSurveyNetworkSnapshot: (pid, id) => { const value = survey.getNetwork(id); return value?.projectId === pid ? value : null },
      getSurveySources: (pid, ids) => ids.flatMap(id => {
        const value = survey.getNetwork(id)
        return value?.projectId === pid ? [{ networkId: id, sourceFile: value.sourceFile, rawSourceIntegrity: survey.getRawSourceIntegrity(id), sourceEligibility: survey.getSourceEligibility(id),
          observations: value.observations.map(({ id, type, sourceRecordId }) => ({ id, type, sourceRecordId })), points: [...value.knownPoints, ...value.unknownPoints].map(({ id }) => ({ id })) }] : []
      })
    }))
    const getProject = id => engineering.getProject(id)
    survey = register(new SurveyService({ rootDir: runtime, nowIso, getProject }))
    const retention = register(new SurveyQualityWorkspaceService({ rootDir: runtime, nowIso, getProject, getManifest: (pid, mid) => engineering.getManifestForProject(pid, mid) }))
    const workflow = register(new SurveyQualityWorkflowService({ rootDir: runtime, nowIso, sources: {
      getProject, retentionSnapshot: (pid, plan, record) => retention.getAssessmentSnapshot(pid, plan, record)
    } }))
    return { engineering, survey, retention, workflow }
  }
  let live = open()
  const project = live.engineering.createProject({ name: '\u5408\u6210\u6574\u6539\u94fe\u9a8c\u6536', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'quality-audit-project' })
  async function makeDelivery(label, value) {
    const dh = value / 1000
    const network = await importWorkwiseSurveyNetwork(live.survey, { projectId: project.id, expectedRevision: 0, idempotencyKey: `network-${label}`, network: {
      networkType: 'leveling', unit: 'm', verticalDatum: 'synthetic-local-height',
      knownPoints: [{ id: 'A', known: true, pointClass: 'known', height: 100 }, { id: 'C', known: true, pointClass: 'known', height: 100.01 }],
      unknownPoints: [{ id: 'B', known: false, height: 100 }],
      observations: [{ id: `AB-${label}`, type: 'height-difference', from: 'A', to: 'B', value: dh, unit: 'm', sigma: 0.001, sigmaUnit: 'm' },
        { id: `BC-${label}`, type: 'height-difference', from: 'B', to: 'C', value: 0.01 - dh, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
    } })
    const adjustment = live.survey.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: `adjustment-${label}` })
    assert(adjustment.result, 'A complete deterministic adjustment result is required')
    const adjustedB = adjustment.result.points.find(point => point.id === 'B')
    assert(adjustedB && Math.abs(adjustedB.height - (100 + dh)) < 1e-9, 'Independent two-anchor leveling height')
    const source = `monitoringItem,point,time,value,unit\nsettlement,P1,2026-09-01T00:00:00Z,0,mm\nsettlement,P1,2026-09-02T00:00:00Z,${value},mm`
    const imported = await live.engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: `import-${label}`, name: `synthetic-${label}.csv`, dataBase64: Buffer.from(source).toString('base64') })
    const dataset = live.engineering.validateDataset({ datasetId: imported.id, expectedRevision: imported.revision, idempotencyKey: `validate-${label}` })
    const analysis = live.engineering.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: `analyse-${label}` })
    assert.equal(analysis.results[0].changeRate, value, 'Independent two-epoch/day arithmetic')
    const manifest = await live.engineering.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id], expectedRevision: dataset.revision, idempotencyKey: `finalize-${label}`, acknowledgeWarnings: true })
    assert.equal(manifest.reviewStatus, 'draft')
    assert.equal(manifest.outputs.length, 3, 'Full DOCX/PDF/XLSX outputs expected')
    const verification = live.engineering.verifyDeliverable(project.id, manifest.id)
    assert(verification.checks.every(check => check.status === 'passed'), 'Generated synthetic delivery must pass its own technical checks')
    const plan = live.retention.createPlan(project.id, { manifestId: manifest.id, expectedProjectRevision: project.revision, idempotencyKey: `plan-${label}`, requiredEvidence: [{ id: 'support', title: 'Synthetic retained report bytes', memberId: 'output-1' }] })
    let record = live.retention.createRecord(project.id, { planId: plan.plan.id, idempotencyKey: `record-${label}` })
    record = live.retention.appendCheck(project.id, record.record.id, { expectedHeadHash: record.verification.headHash, idempotencyKey: `check-${label}`, checkId: 'artifact-bytes' })
    const retained = live.retention.retainEvidence(project.id, { artifactId: plan.artifact.id, memberId: 'output-1', idempotencyKey: `evidence-${label}` })
    record = live.retention.appendCheck(project.id, record.record.id, { expectedHeadHash: record.verification.headHash, idempotencyKey: `support-check-${label}`, checkId: 'evidence:support', evidenceId: retained.id })
    const ref = { planId: plan.plan.id, recordId: record.record.id, expectedRetentionHeadHash: record.verification.headHash }
    return { label, source, network, adjustment, dataset, analysis, manifest, verification, plan, record, ref, evidence: { ...ref, memberId: 'output-1' } }
  }
  const original = await makeDelivery('original', 5), corrected = await makeDelivery('corrected', 4)
  assert.notEqual(original.plan.artifact.bundleHash, corrected.plan.artifact.bundleHash)
  for (const service of services) if (service.flush) await service.flush()
  put('saved-records.json', { fixtureOnly: true, professionalSignoff: false, productionKpi: false, project, runtime, workspace, original, corrected })
  function snapshot() {
    const databases = {}
    for (const name of readdirSync(runtime).filter(name => name.endsWith('.sqlite3') && name !== 'survey-quality-workflow.sqlite3').sort()) {
      const db = new Database(join(runtime, name), { readonly: true, fileMustExist: true })
      try {
        databases[name] = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({ name: table, sql }) => ({ name: table, sql, rows: db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all() }))
      } finally { db.close() }
    }
    const files = {}
    function walk(path) { for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name); assert(!entry.isSymbolicLink())
      if (entry.isDirectory()) walk(child)
      else if (!/\.sqlite3(?:-wal|-shm)?$/.test(entry.name)) files[child] = sha(readFileSync(child))
    } }
    walk(runtime); walk(workspace)
    return { databases, files }
  }
  const before = snapshot(); put('before-business-snapshot.json', before)
  const create = { ...original.ref, expectedProjectRevision: project.revision, idempotencyKey: 'audit-workflow-create' }
  put('gui-instructions.json', { fixtureOnly: true, workspace, projectId: project.id, originalManifestId: original.manifest.id, correctedManifestId: corrected.manifest.id,
    originalPlanId: original.plan.plan.id, originalRecordId: original.record.record.id, correctedPlanId: corrected.plan.plan.id, correctedRecordId: corrected.record.record.id,
    suggestedCheckId: 'synthetic-check-1', suggestedIssueId: 'synthetic-issue-1', suggestedCorrectionId: 'synthetic-correction-1', evidenceMember: 'output-1',
    workflowCreatedByScript: !guiSeed, stages: ['Open original manifest and its retained plan/record', 'Expand declared quality workflow', 'Create workflow explicitly', 'Record failed declaration', 'Open issue', 'Select corrected plan and record, record correction', 'Select same corrected plan and record, record resolved recheck', 'Restart and restore exact workflow'] })
  if (guiSeed) {
    assert.equal(live.workflow.listWorkflows(project.id).workflows.length, 0)
    checks.push({ check: 'two-full-draft-deliveries-and-retention-ready', passed: true, workflowCount: 0 })
  } else {
    const receipts = []
    let current = live.workflow.createWorkflow(project.id, create)
    assert.deepEqual(live.workflow.createWorkflow(project.id, create), current)
    const append = event => {
      const request = { expectedHeadHash: current.headHash, idempotencyKey: `audit-event-${receipts.length + 1}`, event }
      const next = SurveyQualityWorkflowReadV1.parse(live.workflow.appendEvent(project.id, current.workflow.id, request))
      assert.deepEqual(live.workflow.appendEvent(project.id, current.workflow.id, request), next, 'Exact idempotency retry must not append')
      receipts.push({ request, response: next }); current = next
    }
    append({ kind: 'check', checkId: 'synthetic-check-1', outcome: 'failed', evidence: original.evidence })
    append({ kind: 'issue-opened', issueId: 'synthetic-issue-1', checkId: 'synthetic-check-1', evidence: original.evidence })
    assert.equal(current.openIssueCount, 1)
    assert.throws(() => live.workflow.appendEvent(project.id, current.workflow.id, { expectedHeadHash: current.headHash, idempotencyKey: 'reject-unchanged-artifact', event: { kind: 'correction-recorded', issueId: 'synthetic-issue-1', correctionId: 'invalid', corrected: original.ref, evidence: original.evidence } }), /invalid-transition/)
    append({ kind: 'correction-recorded', issueId: 'synthetic-issue-1', correctionId: 'synthetic-correction-1', corrected: corrected.ref, evidence: corrected.evidence })
    append({ kind: 'issue-rechecked', issueId: 'synthetic-issue-1', correctionId: 'synthetic-correction-1', rechecked: corrected.ref, outcome: 'resolved', evidence: corrected.evidence })
    assert.equal(current.entries.length, 4); assert.equal(current.openIssueCount, 0)
    assert.equal(current.deliveryApproval, 'not-granted'); assert.equal(current.humanSignatureVerification, 'not-evaluated'); assert.equal(current.standardConformity, 'not-evaluated')
    checks.push({ check: 'four-declared-events-and-exact-retries', passed: true, workflowId: current.workflow.id, headHash: current.headHash })
    assert.throws(() => live.workflow.appendEvent(project.id, current.workflow.id, { ...receipts[0].request, idempotencyKey: 'reject-stale-head' }), /stale/)
    assert.throws(() => live.workflow.getWorkflow('other-project', current.workflow.id), /not-found/)
    const target = resolve(workspace, corrected.manifest.outputs[0].path)
    assert(target.startsWith(`${workspace}/`))
    const bytes = readFileSync(target), altered = Buffer.from(bytes)
    altered[0] ^= 1
    try { writeFileSync(target, altered); assert.throws(() => live.workflow.getWorkflow(project.id, current.workflow.id), /stale|integrity/); checks.push({ check: 'corrected-source-single-byte-tamper-rejected', passed: true, path: target }) }
    finally { writeFileSync(target, bytes) }
    assert.deepEqual(live.workflow.getWorkflow(project.id, current.workflow.id), current)
    put('workflow-receipts.json', receipts)
    await closeAll(); live = open()
    assert.deepEqual(live.workflow.getWorkflow(project.id, current.workflow.id), current)
    assert.deepEqual(live.retention.getRecord(project.id, original.record.record.id), original.record)
    assert.deepEqual(live.retention.getRecord(project.id, corrected.record.record.id), corrected.record)
    for (const delivery of [original, corrected]) assert.deepEqual(live.engineering.getManifestForProject(project.id, delivery.manifest.id), delivery.manifest)
    checks.push({ check: 'close-reopen-exact-chain-and-old-retention-unchanged', passed: true })
    put('reopened-workflow.json', current)
  }
  const after = snapshot(); put('after-business-snapshot.json', after)
  assert.deepEqual(after, before, 'Workflow audit changed original engineering/retention rows or source bytes')
  checks.push({ check: 'all-existing-business-rows-and-files-unchanged', passed: true, beforeSha256: sha(JSON.stringify(before)), afterSha256: sha(JSON.stringify(after)) })
  outcome = 'passed'
} catch (error) {
  failure = { name: error.name, message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  try { await closeAll() } catch (error) { outcome = 'failed'; process.exitCode = 1; failure ??= { message: `Closing packaged services failed: ${error.message}` } }
  put('audit-report.json', { schemaVersion: 1, outcome, identity, modules, runtime, workspace, checks, failure,
    boundaries: { syntheticOnly: true, guiAcceptance: false, userAcceptance: false, professionalSignoff: false, standardConformity: 'not-evaluated', publicReleaseApproval: false }, finishedAt: new Date().toISOString() })
  console.log(JSON.stringify({ outcome, root, checks: checks.length, guiSeed, failure: failure?.message }, null, 2))
}
