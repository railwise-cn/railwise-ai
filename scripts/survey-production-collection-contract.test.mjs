import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync,
  truncateSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { COLLECTION_LIMITS, validateCollection } from './survey-production-collection-contract.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const moment = second => `2026-09-19T00:00:${String(second).padStart(2, '0')}Z`
function fixture() {
  const objects = new Map(), evidence = []
  const add = kind => {
    const bytes = Buffer.from(`SYNTHETIC-TEST-ONLY-${kind}`), sha256 = hash(bytes)
    objects.set(sha256, bytes); evidence.push({ sha256, sizeBytes: bytes.length, kind }); return sha256
  }
  const refs = Object.fromEntries(['protocol', 'scope', 'selection-policy', 'population-register', 'authorization',
    'shutdown-receipt', 'event-receipt', 'identity', 'signature-envelope', 'signature-verification', 'revocation'].map(kind => [kind, add(kind)]))
  const taskKey = hash('synthetic-task'), projectKey = hash('synthetic-project')
  const c = {
    schemaVersion: 1, contract: 'survey-production-collection-v1', cohort: 'candidate-fixture',
    period: { startInclusive: moment(0), endExclusive: '2026-09-20T00:00:00Z' },
    protocol: { frozenAt: '2026-09-18T00:00:00Z', historyFrom: '2026-09-18T00:00:00Z',
      evidenceSha256: refs.protocol, scopeSha256: refs.scope, selectionPolicySha256: refs['selection-policy'],
      sourceSystemKey: hash('synthetic-register'), taskUnit: 'predeclared-business-task',
      retryPolicy: 'same-task-new-attempt', unknownHistory: 'never-backfill' },
    authorization: { evidenceSha256: refs.authorization, grantorKey: hash('synthetic-grantor'), custodianKey: hash('synthetic-custodian'),
      scopeSha256: refs.scope, purpose: 'aggregate-survey-workflow-metrics', validFrom: '2026-09-18T00:00:00Z',
      validUntil: '2026-10-01T00:00:00Z', revokedAt: null, authenticity: 'not-authenticated' },
    population: { registerEvidenceSha256: refs['population-register'], asOf: '2026-09-20T00:00:00Z',
      declaredTaskCount: 1, unknownTaskCount: 0, coverageClaim: 'complete-declared',
      members: [{ taskKey, projectKey, origin: 'candidate-fixture', inclusion: 'included', exclusionReason: null }] },
    extraction: { capturedAt: '2026-09-20T01:00:00Z', runtimeCommit: '0'.repeat(40),
      shutdownEvidenceSha256: refs['shutdown-receipt'], snapshots: {
        engineering: { sha256: hash('dummy-engineering'), sizeBytes: 1 }, survey: { sha256: hash('dummy-survey'), sizeBytes: 1 } } },
    evidence, events: []
  }
  const event = (type, second, fields = {}) => ({ id: randomUUID(), taskKey,
    sequence: c.events.length + 1, occurredAt: moment(second), recordedAt: moment(second),
    evidenceSha256: refs['event-receipt'], type, ...fields })
  c.events.push(event('task-started', 0, { boundary: 'before-first-user-request', backfilled: false }))
  c.events.push(event('import-attempt-started', 1, { attemptKey: hash('attempt-1'), serviceTaskHash: null }))
  c.events.push(event('import-attempt-finished', 2, { attemptKey: hash('attempt-1'), outcome: 'rejected', sourceDisposition: null }))
  return { c, refs, objects, event }
}

test('structural success never authenticates production, authorization or a first-start', () => {
  const { c } = fixture(); c.cohort = 'production'; c.population.members[0].origin = 'production'
  const { report } = validateCollection(c)
  assert.equal(report.contractValidation, 'structurally-consistent')
  assert.equal(report.productionMetricPromotion, 'prohibited')
  for (const key of ['humanSignoff', 'sourceAuthorization', 'firstStartAuthenticity']) assert.equal(report[key], 'not-authenticated')
  assert.equal(report.populationCoverage, 'not-certified')
})
test('unknown authorization/history stays missing, empty data does not become perfect', () => {
  const { c } = fixture(); c.authorization = null; c.events = []; c.population.unknownTaskCount = null; c.population.coverageClaim = 'unknown'
  const { report } = validateCollection(c)
  assert.equal(report.counts.includedWithoutStart, 1)
  assert.equal(report.missingDeclarations.length, 3)
})
test('retries preserve the original failed attempt and incomplete starts', () => {
  const { c, event } = fixture()
  c.events.push(event('import-attempt-started', 3, { attemptKey: hash('retry'), serviceTaskHash: null }))
  const { report, contract } = validateCollection(c)
  assert.equal(contract.events[2].outcome, 'rejected')
  assert.equal(report.counts.incompleteAttemptsAtExtraction, 1)
})
for (const [name, mutate] of [
  ['duplicate task', c => c.population.members.push(c.population.members[0])],
  ['mixed cohort', c => { c.population.members[0].origin = 'production' }],
  ['unexplained exclusion', c => { c.population.members[0].inclusion = 'excluded' }],
  ['hidden unknown population', c => { c.population.unknownTaskCount = 1 }],
  ['population total mismatch', c => { c.population.declaredTaskCount = 2 }],
  ['late protocol', c => { c.protocol.frozenAt = moment(10) }],
  ['expired authorization', c => { c.authorization.validUntil = moment(10) }],
  ['scope mismatch', c => { c.authorization.scopeSha256 = hash('another') }],
  ['revoked authorization', c => { c.authorization.revokedAt = moment(10) }],
  ['invented authenticated status', c => { c.authorization.authenticity = 'verified' }],
  ['unknown top-level field', c => { c.approved = true }],
  ['backfilled first-start', c => { c.events[0].backfilled = true }],
  ['event before start', c => { c.events.shift() }],
  ['duplicate event identity', c => { c.events[2].id = c.events[1].id }],
  ['duplicate sequence', c => { c.events[2].sequence = c.events[1].sequence }],
  ['duplicate first-start', c => { c.events[1] = { ...c.events[0], id: randomUUID(), sequence: 2 } }],
  ['recorded order rollback', c => { c.events[2].recordedAt = moment(0) }],
  ['event after extraction', c => { c.events[2].recordedAt = '2027-01-01T00:00:00Z' }],
  ['unknown task', c => { c.events[1].taskKey = hash('unknown-task') }],
  ['outcome without matching start', c => { c.events[2].attemptKey = hash('unknown-attempt') }],
  ['success without source disposition', c => { c.events[2].outcome = 'returned' }],
  ['wrong evidence purpose', c => { c.evidence.find(e => e.kind === 'protocol').kind = 'identity' }],
  ['oversized database declaration', c => { c.extraction.snapshots.engineering.sizeBytes = COLLECTION_LIMITS.snapshotBytes + 1 }],
  ['empty database declaration', c => { c.extraction.snapshots.engineering.sizeBytes = 0 }],
  ['total evidence budget', c => { c.evidence.forEach(item => { item.sizeBytes = COLLECTION_LIMITS.evidenceFileBytes }) }]
]) test(`rejects ${name}`, () => { const { c } = fixture(); mutate(c); assert.throws(() => validateCollection(c)) })

test('signoff declaration and revocation require exact task/event/evidence bindings but grant no approval', () => {
  const { c, refs, event } = fixture()
  const signed = event('formal-signoff-declared', 4, { manifestSha256: hash('manifest'), bundleSha256: hash('bundle'),
    inputBindingSha256: hash('inputs'), actorKey: hash('human-declaration'), identityEvidenceSha256: refs.identity,
    authorizationEvidenceSha256: refs.authorization, signatureEnvelopeSha256: refs['signature-envelope'],
    verificationReceiptSha256: refs['signature-verification'], intent: 'approve-frozen-delivery',
    actorKind: 'human-declared', signatureValidation: 'external-receipt-not-authenticated' })
  c.events.push(signed)
  c.events.push(event('signoff-revoked', 5, { signoffEventId: signed.id, revocationEvidenceSha256: refs.revocation }))
  assert.equal(validateCollection(c).report.humanSignoff, 'not-authenticated')
  c.events.at(-1).signoffEventId = randomUUID()
  assert.throws(() => validateCollection(c), /revocation-binding-invalid/)
})

test('CLI binds real SQLite snapshots, reuses existing collector, rejects changed bytes and suppresses private error details', () => {
  const directory = mkdtempSync(join(tmpdir(), 'survey-contract-test-'))
  try {
    const { c, objects } = fixture()
    for (const [sha, bytes] of objects) writeFileSync(join(directory, sha), bytes)
    const eng = join(directory, 'engineering.sqlite3'), survey = join(directory, 'survey.sqlite3')
    const setup = spawnSync('python3', ['-c', 'import sqlite3,sys\nfor path,names in [(sys.argv[1],["engineering_projects","engineering_manifests"]),(sys.argv[2],["survey_networks","survey_adjustments"])]:\n c=sqlite3.connect(path)\n c.execute("PRAGMA journal_mode=WAL")\n for name in names:c.execute("CREATE TABLE "+name+" (data_json TEXT)")\n c.commit();c.close()', eng, survey])
    assert.equal(setup.status, 0)
    for (const [kind, path] of [['engineering', eng], ['survey', survey]]) {
      const bytes = readFileSync(path); c.extraction.snapshots[kind] = { sha256: hash(bytes), sizeBytes: bytes.length }
    }
    const contract = join(directory, 'PRIVATE-CONTRACT.json')
    const save = () => writeFileSync(contract, `${JSON.stringify(c, null, 2)}\n`)
    const run = (contractFile = contract, evidenceDir = directory, engineeringDb = eng) => spawnSync(process.execPath, ['scripts/validate-survey-production-collection.mjs', '--contract', contractFile,
      '--evidence-dir', evidenceDir, '--engineering-db', engineeringDb, '--survey-db', survey], { encoding: 'utf8', timeout: 5000 })
    save()
    const before = hash(readFileSync(eng)), successful = run()
    assert.equal(successful.status, 0, successful.stderr)
    const report = JSON.parse(successful.stdout)
    assert.equal(report.evidenceByteIntegrity, 'matched-declared-digests')
    assert.equal(report.existingMetrics.productionRepresentativeness.status, 'not-measurable')
    assert.equal(report.existingMetrics.approvedTraceableProductionProjects.status, 'not-measurable')
    assert.equal(hash(readFileSync(eng)), before)
    assert.equal(report.taskToSnapshotIdentity, 'not-verified')
    assert.equal(report.databaseReadIsolation, 'byte-verified-private-copies; originals-not-opened-by-sqlite')
    for (const path of [eng, survey]) for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(path + suffix), false)
    const alias = join(directory, 'alias')
    symlinkSync(contract, alias); assert.equal(run(alias).status, 1); unlinkSync(alias)
    symlinkSync(directory, alias); assert.equal(run(contract, alias).status, 1); unlinkSync(alias)
    symlinkSync(eng, alias); assert.equal(run(contract, directory, alias).status, 1); unlinkSync(alias)
    const firstEvidence = join(directory, c.evidence[0].sha256), evidenceCopy = join(directory, 'original-evidence')
    writeFileSync(evidenceCopy, objects.get(c.evidence[0].sha256)); unlinkSync(firstEvidence)
    symlinkSync(evidenceCopy, firstEvidence); assert.equal(run().status, 1); unlinkSync(firstEvidence)
    writeFileSync(firstEvidence, objects.get(c.evidence[0].sha256))
    if (process.platform !== 'win32') {
      const fifo = join(directory, 'contract-fifo')
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0)
      const rejected = run(fifo); assert.equal(rejected.status, 1); assert.equal(rejected.error, undefined)
    }
    const large = join(directory, 'large-contract')
    writeFileSync(large, ''); truncateSync(large, COLLECTION_LIMITS.contractBytes + 1)
    assert.equal(run(large).status, 1)
    const largeDb = join(directory, 'large-db')
    writeFileSync(largeDb, ''); truncateSync(largeDb, COLLECTION_LIMITS.snapshotBytes + 1)
    assert.equal(run(contract, directory, largeDb).status, 1)
    for (const suffix of ['-wal', '-shm', '-journal']) {
      writeFileSync(eng + suffix, '')
      assert.equal(run().status, 1)
      unlinkSync(eng + suffix)
    }
    const originalDirectoryEntries = readdirSync(directory).sort()
    assert.equal(run().status, 0)
    assert.deepEqual(readdirSync(directory).sort(), originalDirectoryEntries)
    c.extraction.snapshots.engineering.sha256 = hash('wrong snapshot')
    save(); assert.equal(run().status, 1)
    c.extraction.snapshots.engineering.sha256 = before
    save()
    writeFileSync(contract, readFileSync(contract, 'utf8').replace('"schemaVersion": 1,', '"schemaVersion": 2, "schemaVersion": 1,'))
    assert.equal(run().status, 1)
    save()
    writeFileSync(join(directory, c.evidence[0].sha256), 'PRIVATE-CHANGED-BYTES')
    const failed = run()
    assert.equal(failed.status, 1); assert.equal(failed.stdout, '')
    assert.equal(failed.stderr.includes('PRIVATE'), false)
    writeFileSync(join(directory, c.evidence[0].sha256), objects.get(c.evidence[0].sha256))
    writeFileSync(eng + '-wal', 'uncheckpointed')
    assert.equal(run().status, 1)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('JSON Schema export retains strict event variants and no authenticated status', () => {
  const result = spawnSync(process.execPath, ['scripts/validate-survey-production-collection.mjs', '--schema'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  const schema = JSON.parse(result.stdout)
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.events.items.oneOf.length, 5)
})
