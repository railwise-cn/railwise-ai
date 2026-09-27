const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const EXPECTED = 'fbb88ea715571e9689cbc1c0802da08762e4318d'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const app = path.resolve(process.argv[2] || '')
const expectedAsarHash = process.argv[3]
const evidence = __dirname
let fixtureRoot

async function main() {
  assert(process.versions.electron && path.dirname(process.execPath) === path.join(app, 'Contents', 'MacOS'), 'Use selected packaged Electron with ELECTRON_RUN_AS_NODE=1')
  const resources = path.join(app, 'Contents', 'Resources')
  const asar = path.join(resources, 'app.asar')
  const metadata = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'))
  assert.equal(metadata.buildProvenance?.sourceHead, EXPECTED, 'Wrong candidate provenance')
  assert.equal(metadata.version, '0.5.0')
  assert.match(expectedAsarHash || '', /^[a-f0-9]{64}$/, 'Provide independently recorded cloud ASAR SHA-256 as third argument')
  const runtime = path.join(resources, 'app.asar.unpacked', 'kun')
  const packagedRequire = createRequire(path.join(runtime, 'package.json'))
  const Database = packagedRequire('better-sqlite3')
  const modulePath = name => path.join(runtime, 'dist', 'engineering', name + '.js')
  const { EngineeringService } = await import(pathToFileURL(modulePath('engineering-service')).href)
  const { SurveyService } = await import(pathToFileURL(modulePath('survey-service')).href)
  const disk = require('original-fs')
  const identity = {
    sourceHead: metadata.buildProvenance.sourceHead, packageVersion: metadata.version,
    asarSha256: hash(disk.readFileSync(asar)), electronVersion: process.versions.electron, nodeAbi: process.versions.modules,
    runtimeModuleHashes: Object.fromEntries(['engineering-service', 'engineering-verification-audit', 'survey-service'].map(name => [name, hash(fs.readFileSync(modulePath(name)))]))
  }
  assert.equal(identity.asarSha256, expectedAsarHash, 'Installed ASAR differs from independent cloud evidence')
  identity.cloudAsarSha256Matched = true
  const fixtureParent = path.join(path.dirname(evidence), 'audit-fixture')
  await fsp.mkdir(fixtureParent, { recursive: true })
  fixtureRoot = await fsp.mkdtemp(path.join(fixtureParent, 'lifecycle-'))
  const dataDir = path.join(fixtureRoot, 'runtime')
  const workspace = path.join(fixtureRoot, 'workspace')
  let engineering
  const survey = new SurveyService({ rootDir: dataDir, getProject: id => engineering.getProject(id) })
  const providers = {
    runtimeVersion: metadata.version,
    getAdjustments: (pid, ids) => ids.flatMap(id => { const item = survey.getAdjustmentForProjectNewUse(pid, id); return item?.result ? [item.result] : [] }),
    getAdjustmentEvidence: (pid, ids) => ids.flatMap(id => { const item = survey.getAdjustmentForProjectNewUse(pid, id); return item?.result ? [{ run: item.run, result: item.result }] : [] }),
    getDeformations: (pid, ids) => ids.flatMap(id => { const item = survey.getDeformationForProjectNewUse(pid, id); return item ? [item] : [] }),
    getSurveyNetworkSnapshot: (pid, id) => { const item = survey.getNetwork(id); return item?.projectId === pid ? item : null },
    getSurveySources: (pid, ids) => ids.flatMap(id => { const item = survey.getNetwork(id); return item?.projectId === pid ? [{ networkId: id, sourceFile: item.sourceFile,
      rawSourceIntegrity: survey.getRawSourceIntegrity(id), sourceEligibility: survey.getSourceEligibility(id), observations: item.observations, points: [...item.knownPoints, ...item.unknownPoints] }] : [] })
  }
  engineering = new EngineeringService({ rootDir: dataDir, ...providers })
  const opened = []
  let legacy
  try {
    const project = engineering.createProject({ name: 'Synthetic lifecycle probe', workspace, expectedRevision: 0, idempotencyKey: 'lifecycle-project' })
    const source = Buffer.from(JSON.stringify({ format: 'workwise-survey-network', formatVersion: 1, network: {
      networkType: 'leveling', unit: 'm', knownPoints: [{ id: 'A', known: true, height: 10 }], unknownPoints: [{ id: 'B', known: false, height: 10.1 }],
      observations: [0.1001, 0.1002, 0.1003].map((value, i) => ({ id: `dh-${i}`, type: 'height-difference', from: 'A', to: 'B', value, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }))
    } }))
    const network = await survey.importNetwork({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'lifecycle-import', name: 'synthetic.json', dataBase64: source.toString('base64'), networkType: 'leveling' })
    const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'lifecycle-validate' })
    const adjusted = survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'lifecycle-adjust' })
    assert.equal(adjusted.result.validation, 'valid')
    const manifest = await engineering.finalize({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'lifecycle-finalize', adjustmentIds: [adjusted.result.id], acknowledgeWarnings: true })
    assert.equal(manifest.reviewStatus, 'draft')
    await engineering.flush(); await survey.flush()
    const db = new Database(path.join(dataDir, 'engineering.sqlite3')); opened.push(db)
    const surveyDb = new Database(path.join(dataDir, 'survey.sqlite3')); opened.push(surveyDb)
    const snapshot = database => {
      const names = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)
        .filter(name => !['engineering_verification_attempts', 'engineering_verification_events'].includes(name))
      return Object.fromEntries(names.map(name => [name, hash(JSON.stringify(database.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()))]))
    }
    const files = directory => {
      const out = {}
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name)
        assert(!entry.isSymbolicLink(), 'Unexpected fixture symlink')
        if (entry.isDirectory()) Object.assign(out, files(target))
        else out[path.relative(workspace, target)] = hash(fs.readFileSync(target))
      }
      return out
    }
    const baseline = { engineering: snapshot(db), survey: snapshot(surveyDb), workspace: files(workspace) }
    const assertUnchanged = () => {
      assert.deepEqual(snapshot(db), baseline.engineering); assert.deepEqual(snapshot(surveyDb), baseline.survey); assert.deepEqual(files(workspace), baseline.workspace)
    }
    const verifyLedger = database => {
      const terminals = database.prepare('SELECT * FROM engineering_verification_attempts ORDER BY sequence').all()
      const events = database.prepare('SELECT * FROM engineering_verification_events ORDER BY sequence').all()
      for (const row of events) assert.equal(row.record_hash, hash(row.data_json))
      const outcomes = []
      for (const terminal of terminals) {
        assert.equal(terminal.record_hash, hash(terminal.data_json))
        const ends = events.filter(event => event.attempt_id === terminal.id)
        if (!ends.length) continue
        assert.equal(ends.length, 2)
        const [start, finish] = ends.map(row => JSON.parse(row.data_json))
        const body = JSON.parse(terminal.data_json)
        assert.equal(start.phase, 'started'); assert.equal(start.previousHash, null)
        assert.equal(finish.phase, 'finished'); assert.equal(finish.previousHash, ends[0].record_hash)
        assert.equal(finish.terminalId, terminal.id); assert.equal(finish.terminalRecordHash, terminal.record_hash)
        assert.equal(start.projectId, body.projectId); assert.equal(start.manifestId, body.manifestId)
        assert.equal(start.occurredAt, body.startedAt); assert.equal(finish.occurredAt, body.completedAt)
        assert.equal(finish.outcome, body.outcome); outcomes.push(body.outcome)
      }
      return { terminalCount: terminals.length, lifecycleCount: events.length, outcomes }
    }
    const success = engineering.verifyDeliverable(project.id, manifest.id)
    assert.equal(success.valid, true); assert.equal(success.reviewStatus, 'draft'); assert.equal(success.checks.length, 5)
    assert(success.checks.every(check => check.status === 'passed'))
    assertUnchanged()
    assert.throws(() => engineering.verifyDeliverable(project.id, 'synthetic-missing-manifest'), /not found/)
    assertUnchanged()
    assert.deepEqual(verifyLedger(db), { terminalCount: 2, lifecycleCount: 4, outcomes: ['passed', 'error'] })

    // Only the dedicated synthetic copy is made to resemble a pre-lifecycle database.
    const legacyDir = path.join(fixtureRoot, 'legacy-runtime'); fs.mkdirSync(legacyDir)
    await db.backup(path.join(legacyDir, 'engineering.sqlite3'))
    const legacyDb = new Database(path.join(legacyDir, 'engineering.sqlite3')); opened.push(legacyDb)
    legacyDb.exec('DROP TABLE engineering_verification_events')
    const oldRows = legacyDb.prepare('SELECT * FROM engineering_verification_attempts ORDER BY sequence').all()
    legacy = new EngineeringService({ rootDir: legacyDir, ...providers })
    assert.deepEqual(legacyDb.prepare('SELECT * FROM engineering_verification_attempts ORDER BY sequence').all(), oldRows)
    assert.equal(legacyDb.prepare('SELECT COUNT(*) AS count FROM engineering_verification_events').get().count, 0)
    assert.equal(legacy.verifyDeliverable(project.id, manifest.id).valid, true)
    assert.deepEqual(legacyDb.prepare('SELECT * FROM engineering_verification_attempts ORDER BY sequence LIMIT 2').all(), oldRows)
    assert.deepEqual(verifyLedger(legacyDb), { terminalCount: 3, lifecycleCount: 2, outcomes: ['passed'] })
    assert.deepEqual(snapshot(legacyDb), baseline.engineering)
    assertUnchanged()
    const result = {
      schemaVersion: 1, status: 'passed', checkedAt: new Date().toISOString(), package: identity,
      fixture: { kind: 'synthetic-workwise-json-leveling', isolated: true, sourceSha256: hash(source) },
      currentLedger: verifyLedger(db), legacyLedger: verifyLedger(legacyDb),
      checks: { realPackagedService: true, fiveStrictChecksPassed: true, successAndLookupErrorBound: true, originalRecordsUnchanged: true,
        originalWorkspaceFileBytesUnchanged: true, reviewStatusStayedDraft: true, legacyTerminalBytesPreserved: true, legacyStartsNotBackfilled: true },
      baselineHashes: baseline,
      limitations: ['Packaged Electron service integration, not GUI automation.', 'Synthetic isolated fixtures; no running GUI or user database read or changed.', 'No production KPI, professional signoff, new signature/notarization validation or release approval.']
    }
    await fsp.writeFile(path.join(evidence, 'packaged-verification-lifecycle.json'), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ status: result.status, package: identity, currentLedger: result.currentLedger, legacyLedger: result.legacyLedger, checks: result.checks }, null, 2))
  } finally {
    legacy?.close(); for (const database of opened) database.close()
    await engineering.flush(); await survey.flush(); engineering.close(); survey.close()
  }
}
main().catch(async error => {
  await fsp.writeFile(path.join(evidence, 'packaged-verification-lifecycle-failure.json'), JSON.stringify({ status: 'failed', checkedAt: new Date().toISOString(), errorType: error.name, message: String(error.message).split(app).join('<app>').split(evidence).join('<evidence>'), syntheticFixtureOnly: true }, null, 2) + '\n')
  console.error('Packaged lifecycle probe failed; inspect local failure evidence.')
  process.exitCode = 1
})
