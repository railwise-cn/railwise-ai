import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { EngineeringService, verificationSnapshotHash } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { ModuleKind, transpileModule } from 'typescript'

const resources: Array<{ root: string; engineering: EngineeringService; survey: SurveyService }> = []
afterEach(async () => {
  for (const item of resources.splice(0)) {
    await item.engineering.flush(); await item.survey.flush()
    item.engineering.close(); item.survey.close()
    await rm(item.root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'verification-audit-'))
  const runtime = join(root, 'runtime')
  let engineering!: EngineeringService
  let snapshotAvailable = true
  let clock = () => '2026-09-20T01:00:00.000Z'
  const nowIso = () => clock()
  const survey = new SurveyService({ rootDir: runtime, nowIso, getProject: id => engineering.getProject(id) })
  engineering = new EngineeringService({ rootDir: runtime, nowIso, runtimeVersion: 'test-candidate',
    getAdjustments: (pid, ids) => ids.flatMap(id => {
      const item = survey.getAdjustmentForProjectNewUse(pid, id)
      return item?.result ? [item.result] : []
    }),
    getAdjustmentEvidence: (pid, ids) => ids.flatMap(id => {
      const item = survey.getAdjustmentForProjectNewUse(pid, id)
      return item?.result ? [{ run: item.run, result: item.result }] : []
    }),
    getDeformations: (pid, ids) => ids.flatMap(id => {
      const item = survey.getDeformationForProjectNewUse(pid, id); return item ? [item] : []
    }),
    getSurveyNetworkSnapshot: (pid, id) => {
      const network = survey.getNetwork(id)
      return snapshotAvailable && network?.projectId === pid ? network : null
    },
    getSurveySources: (pid, ids) => ids.flatMap(id => {
      const network = survey.getNetwork(id)
      return network?.projectId === pid ? [{ networkId: id, sourceFile: network.sourceFile,
        rawSourceIntegrity: survey.getRawSourceIntegrity(id), sourceEligibility: survey.getSourceEligibility(id),
        observations: network.observations, points: [...network.knownPoints, ...network.unknownPoints] }] : []
    })
  })
  resources.push({ root, engineering, survey })
  const project = engineering.createProject({ name: 'PRIVATE 审计', workspace: join(root, 'workspace'), expectedRevision: 0, idempotencyKey: 'audit-project' })
  const network = await importWorkwiseSurveyNetwork(survey, { projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'audit-import', networkType: 'leveling',
    network: { knownPoints: [{ id: 'A', known: true, height: 10 }], unknownPoints: [{ id: 'B', known: false, height: 10.1 }],
      observations: [0.1001, 0.1002, 0.1003].map((value, i) => ({ id: `dh-${i}`, type: 'height-difference', from: 'A', to: 'B', value, unit: 'm', sigma: 0.001, sigmaUnit: 'm' })) }
  })
  const adjustment = survey.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'audit-adjust' })
  const manifest = await engineering.finalize({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'audit-deliver', adjustmentIds: [adjustment.result.id], acknowledgeWarnings: true })
  const database = () => new Database(join(runtime, 'engineering.sqlite3'))
  const events = () => {
    const db = database()
    try { return (db.prepare('SELECT * FROM engineering_verification_attempts ORDER BY sequence').all() as Array<{ sequence: number; data_json: string; record_hash: string }>).map(row => ({ ...row, event: JSON.parse(row.data_json) })) }
    finally { db.close() }
  }
  const lifecycle = () => {
    const db = database()
    try { return (db.prepare('SELECT * FROM engineering_verification_events ORDER BY sequence').all() as Array<{ data_json: string; record_hash: string }>).map(row => ({ ...row, event: JSON.parse(row.data_json) })) }
    finally { db.close() }
  }
  const metrics = () => JSON.parse(execFileSync('python3', [resolve('../scripts/measure-survey-workflows.py'), '--engineering-db', join(runtime, 'engineering.sqlite3'), '--survey-db', join(runtime, 'survey.sqlite3'), '--cohort', 'candidate-fixture', '--start', '2026-09-20T00:00:00Z', '--end', '2026-09-21T00:00:00Z'], { encoding: 'utf8' }))
  return { root, runtime, engineering, survey, project, network, adjustment, manifest, database, events, lifecycle, metrics,
    setClock: (next: () => string) => { clock = next }, disableSnapshot: () => { snapshotAvailable = false } }
}

describe('strict verification audit and read-only metrics', () => {
  it('records actual strict replay, feeds Python, and supersedes passing evidence after an output failure without modifying checked objects', async () => {
    const f = await fixture()
    const manifestBefore = JSON.stringify(f.manifest)
    const manifestPath = join(f.project.workspace, '.workwise', 'deliverables', f.project.id, f.manifest.runId, 'manifest.json')
    const manifestBytes = await readFile(manifestPath)
    expect(f.engineering.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(true)
    const [record] = f.events()
    expect(record.event).toMatchObject({ outcome: 'passed', bindingStable: true, bindings: { complete: true }, runtimeVersion: 'test-candidate' })
    expect(record.record_hash).toBe(createHash('sha256').update(record.data_json).digest('hex'))
    let result = f.metrics()
    expect(result.recordedStrictReverificationCoverage).toMatchObject({ value: 1, numerator: 1, denominator: 1 })
    expect(result.recordedVerificationAttemptSuccessRate).toMatchObject({ value: 1, numerator: 1, denominator: 1 })
    expect(result.recordedVerificationLifecycle).toMatchObject({ counts: { startedInPeriod: 1, finishedByPeriodEnd: 1, incompleteAtPeriodEnd: 0 }, recordedTerminalPassRate: { value: 1, numerator: 1, denominator: 1 } })
    const [start, finish] = f.lifecycle()
    expect(start!.event).toMatchObject({ attemptId: record.event.id, phase: 'started', previousHash: null })
    expect(finish!.event).toMatchObject({ attemptId: record.event.id, phase: 'finished', previousHash: start!.record_hash, terminalId: record.event.id, terminalRecordHash: record.record_hash, outcome: 'passed' })
    expect(result.strictReverificationCoverage.value).toBeNull()
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(JSON.stringify(result)).not.toContain(f.root)
    await writeFile(join(f.project.workspace, f.manifest.outputs[0]!.path), 'altered output')
    expect(f.engineering.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(false)
    result = f.metrics()
    expect(result.recordedStrictReverificationCoverage).toMatchObject({ value: 0, numerator: 0, denominator: 1 })
    expect(result.recordedVerificationAttemptSuccessRate).toMatchObject({ value: 0.5, numerator: 1, denominator: 2, outcomes: { passed: 1, failed: 1, error: 0 } })
    expect(JSON.stringify(f.manifest)).toBe(manifestBefore)
    expect(await readFile(manifestPath)).toEqual(manifestBytes)
    expect(f.events().map(row => row.event.verification.reviewStatus)).toEqual(['draft', 'draft'])
  })

  it('excludes stale numerical inputs even when old stored inputHash strings are left unchanged', async () => {
    const f = await fixture()
    f.engineering.verifyDeliverable(f.project.id, f.manifest.id)
    const db = new Database(join(f.runtime, 'survey.sqlite3'))
    try {
      db.prepare('UPDATE survey_networks SET project_id=? WHERE id=?').run('other-project', f.network.id)
      expect(f.metrics().recordedStrictReverificationCoverage.numerator).toBe(0)
      db.prepare('UPDATE survey_networks SET project_id=? WHERE id=?').run(f.project.id, f.network.id)
      const engineeringDb = f.database()
      try {
        engineeringDb.prepare('UPDATE engineering_manifests SET project_id=? WHERE id=?').run('other-project', f.manifest.id)
        expect(f.metrics().recordedStrictReverificationCoverage.numerator).toBe(0)
        engineeringDb.prepare('UPDATE engineering_manifests SET project_id=? WHERE id=?').run(f.project.id, f.manifest.id)
      } finally { engineeringDb.close() }
      expect(f.metrics().recordedStrictReverificationCoverage.numerator).toBe(1)
      const row = db.prepare('SELECT data_json FROM survey_networks WHERE id=?').get(f.network.id) as { data_json: string }
      const changed = JSON.parse(row.data_json); changed.observations[0].value += 0.001
      db.prepare('UPDATE survey_networks SET data_json=? WHERE id=?').run(JSON.stringify(changed), f.network.id)
    } finally { db.close() }
    const result = f.metrics()
    expect(result.recordedStrictReverificationCoverage.numerator).toBe(0)
    expect(result.recordedVerificationAttemptSuccessRate.numerator).toBe(0)
    expect(f.engineering.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(false)
    expect(f.events().at(-1)!.event.outcome).toBe('failed')
  })

  it('retains lookup errors, rejects update/delete/replace, and fails closed if the audit cannot be written', async () => {
    const f = await fixture()
    expect(() => f.engineering.verifyDeliverable('other-project', f.manifest.id)).toThrow('not found')
    expect(f.events()[0]!.event).toMatchObject({ outcome: 'error', bindingStable: false, verification: null })
    f.engineering.verifyDeliverable(f.project.id, f.manifest.id)
    const db = f.database()
    try {
      expect(() => db.exec('UPDATE engineering_verification_attempts SET outcome=\'passed\'')).toThrow('append-only')
      expect(() => db.exec('DELETE FROM engineering_verification_attempts')).toThrow('append-only')
      expect(() => db.exec('INSERT OR REPLACE INTO engineering_verification_attempts SELECT * FROM engineering_verification_attempts LIMIT 1')).toThrow('append-only')
      const existing = db.prepare('SELECT * FROM engineering_verification_attempts LIMIT 1').get() as Record<string, unknown>
      expect(() => db.prepare('INSERT OR REPLACE INTO engineering_verification_attempts(sequence,id,project_id,manifest_id,started_at,completed_at,outcome,record_hash,data_json) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(existing.sequence, 'different-id', existing.project_id, existing.manifest_id, existing.started_at, existing.completed_at, existing.outcome, existing.record_hash, existing.data_json)).toThrow('append-only')
      db.exec("CREATE TRIGGER test_no_audit BEFORE INSERT ON engineering_verification_attempts BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END")
      expect(() => f.engineering.verifyDeliverable(f.project.id, f.manifest.id)).toThrow('audit could not be saved')
      expect(f.events()).toHaveLength(2)
    } finally { db.close() }
  })

  it('keeps verification usable when the optional audit network provider is absent but refuses coverage credit', async () => {
    const f = await fixture(); f.disableSnapshot()
    expect(f.engineering.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(true)
    expect(f.events()[0]!.event).toMatchObject({ outcome: 'passed', bindingStable: false, bindings: { complete: false } })
    expect(f.metrics().recordedStrictReverificationCoverage.numerator).toBe(0)
  })

  it('fails the recorded metrics closed after audit corruption instead of substituting an earlier pass', async () => {
    const f = await fixture()
    f.engineering.verifyDeliverable(f.project.id, f.manifest.id)
    f.engineering.verifyDeliverable(f.project.id, f.manifest.id)
    const db = f.database()
    try {
      db.exec('DROP TRIGGER engineering_verification_no_update')
      db.prepare('UPDATE engineering_verification_attempts SET record_hash=? WHERE sequence=2').run('0'.repeat(64))
    } finally { db.close() }
    const result = f.metrics()
    expect(result.recordedStrictReverificationCoverage).toMatchObject({ value: null, status: 'not-measurable' })
    expect(result.recordedVerificationAttemptSuccessRate).toMatchObject({ value: null, status: 'not-measurable' })
  })

  it('uses identical JS and Python value digests at numeric and Unicode boundaries', () => {
    const values = [null, true, false, 0, -0, 1e-7, 1e20, 1e21, 1e23, Number.MIN_VALUE, Number.MAX_VALUE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.10000000000000002, '\u2028\n规范😀', { '𐀀': 1, '\ue000': 2, ascii: [1e-300, -1e200] }]
    const script = "import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps([m.snapshot_hash(v) for v in json.load(sys.stdin)]))"
    const hashes = JSON.parse(execFileSync('python3', ['-c', script, resolve('../scripts/measure-survey-workflows.py')], { input: JSON.stringify(values), encoding: 'utf8' }))
    expect(hashes).toEqual(values.map(verificationSnapshotHash))
    expect(() => verificationSnapshotHash('\ud800')).toThrow('Unicode')
    expect(() => verificationSnapshotHash(Infinity)).toThrow('non-finite')
  })

  it.each(['started', 'finished', 'terminal'])('keeps the correct durable denominator when %s persistence fails', async phase => {
    const f = await fixture()
    const before = JSON.stringify(f.manifest)
    const db = f.database()
    try {
      const target = phase === 'terminal' ? 'engineering_verification_attempts' : 'engineering_verification_events'
      const condition = phase === 'terminal' ? '' : `WHEN NEW.phase = '${phase}'`
      db.exec(`CREATE TRIGGER fail_verification BEFORE INSERT ON ${target} ${condition} BEGIN SELECT RAISE(ABORT, 'injected private failure'); END`)
      expect(() => f.engineering.verifyDeliverable(f.project.id, f.manifest.id)).toThrow('audit could not be saved')
      expect(f.events()).toHaveLength(0)
      expect(f.lifecycle().map(row => row.event.phase)).toEqual(phase === 'started' ? [] : ['started'])
      expect(f.metrics().recordedVerificationLifecycle).toMatchObject({ counts: { startedInPeriod: phase === 'started' ? 0 : 1, finishedByPeriodEnd: 0, incompleteAtPeriodEnd: phase === 'started' ? 0 : 1 } })
      db.exec('DROP TRIGGER fail_verification')
      expect(f.engineering.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(true)
      expect(f.events()).toHaveLength(1)
      expect(f.metrics().recordedVerificationLifecycle.recordedTerminalPassRate).toMatchObject({ numerator: 1, denominator: phase === 'started' ? 1 : 2 })
      expect(JSON.stringify(f.manifest)).toBe(before)
    } finally { db.close() }
  })

  it('does not count a finish at the exclusive cutoff for its started cohort', async () => {
    const f = await fixture()
    let calls = 0
    f.setClock(() => calls++ === 0 ? '2026-09-20T23:59:59.000Z' : '2026-09-21T00:00:00.000Z')
    expect(f.engineering.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(true)
    expect(f.metrics().recordedVerificationLifecycle).toMatchObject({ counts: { startedInPeriod: 1, finishedByPeriodEnd: 0, incompleteAtPeriodEnd: 1 }, recordedTerminalPassRate: { numerator: 0, denominator: 1 } })
    expect(f.metrics().recordedVerificationAttemptSuccessRate.denominator).toBe(0)
  })

  it('rolls back terminal evidence on a backwards clock and preserves the start', async () => {
    const f = await fixture()
    let calls = 0
    f.setClock(() => calls++ === 0 ? '2026-09-20T01:00:00.000Z' : '2026-09-20T00:59:59.000Z')
    expect(() => f.engineering.verifyDeliverable(f.project.id, f.manifest.id)).toThrow('audit could not be saved')
    expect(f.events()).toHaveLength(0)
    expect(f.lifecycle().map(row => row.event.phase)).toEqual(['started'])
  })

  it('preserves legacy terminal bytes and metrics when opening a database without lifecycle history', async () => {
    const f = await fixture()
    f.engineering.verifyDeliverable(f.project.id, f.manifest.id)
    const original = f.events()
    const before = f.metrics()
    const db = f.database()
    try { db.exec('DROP TABLE engineering_verification_events') } finally { db.close() }
    const upgraded = new EngineeringService({ rootDir: f.runtime })
    upgraded.close()
    expect(f.events()).toEqual(original)
    expect(f.lifecycle()).toEqual([])
    const after = f.metrics()
    expect(after.recordedVerificationAttemptSuccessRate).toEqual(before.recordedVerificationAttemptSuccessRate)
    expect(after.recordedStrictReverificationCoverage).toEqual(before.recordedStrictReverificationCoverage)
    expect(after.recordedVerificationLifecycle).toMatchObject({ status: 'no-samples', counts: { startedInPeriod: 0, legacyTerminalOnlyCompletedInPeriod: 1 } })
  })

  it('protects lifecycle rows from update, delete and both replace forms', async () => {
    const f = await fixture()
    f.engineering.verifyDeliverable(f.project.id, f.manifest.id)
    const db = f.database()
    try {
      expect(() => db.exec("UPDATE engineering_verification_events SET phase='finished'")).toThrow('append-only')
      expect(() => db.exec('DELETE FROM engineering_verification_events')).toThrow('append-only')
      expect(() => db.exec('INSERT OR REPLACE INTO engineering_verification_events SELECT * FROM engineering_verification_events LIMIT 1')).toThrow('append-only')
      const row = db.prepare('SELECT * FROM engineering_verification_events LIMIT 1').get() as Record<string, unknown>
      expect(() => db.prepare('INSERT OR REPLACE INTO engineering_verification_events(sequence,attempt_id,phase,occurred_at,record_hash,data_json) VALUES (?,?,?,?,?,?)')
        .run(row.sequence, 'different-attempt', row.phase, row.occurred_at, row.record_hash, row.data_json)).toThrow('append-only')
    } finally { db.close() }
  })

  it('retains a committed start after an actual process termination', async () => {
    const f = await fixture()
    const auditPath = join(f.root, 'compiled-audit.mjs')
    const source = await readFile(resolve('src/engineering/engineering-verification-audit.ts'), 'utf8')
    await writeFile(auditPath, transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
    const child = await writeFile(join(f.root, 'crash.mjs'), `
      import { createRequire } from 'node:module';
      import { EngineeringVerificationAudit } from './compiled-audit.mjs';
      const Database = createRequire(${JSON.stringify(resolve('package.json'))})('better-sqlite3');
      const db = new Database(${JSON.stringify(join(f.runtime, 'engineering.sqlite3'))});
      const audit = new EngineeringVerificationAudit(db, () => '2026-09-20T01:00:00.000Z');
      audit.begin('synthetic-project', 'synthetic-manifest');
      process.kill(process.pid, 'SIGKILL');
    `).then(() => spawnSync(process.execPath, [join(f.root, 'crash.mjs')], { encoding: 'utf8', timeout: 10000 }))
    expect(child.signal, child.stderr).toBe('SIGKILL')
    expect(f.events()).toHaveLength(0)
    expect(f.lifecycle().map(row => row.event.phase)).toEqual(['started'])
    expect(f.metrics().recordedVerificationLifecycle).toMatchObject({ counts: { startedInPeriod: 1, incompleteAtPeriodEnd: 1 }, recordedTerminalPassRate: { numerator: 0, denominator: 1 } })
  })
})
