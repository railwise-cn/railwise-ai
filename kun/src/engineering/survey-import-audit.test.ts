import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SurveyService } from './survey-service.js'
import { importSurveyNetwork } from '../server/routes/engineering.js'

const roots: string[] = []
const services: SurveyService[] = []
const databases: Database.Database[] = []
async function setup(options: { brokenWorkspace?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'survey-import-audit-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  if (options.brokenWorkspace) await writeFile(workspace, 'not a directory')
  const service = new SurveyService({ rootDir: root, getProject: () => ({ id: 'private-project', revision: 1, workspace }) })
  services.push(service)
  const db = new Database(join(root, 'survey.sqlite3'))
  databases.push(db)
  return { service, db, root }
}
const request = () => ({ projectId: 'private-project', expectedRevision: 0, idempotencyKey: 'private-idempotency-key',
  name: 'private-file.csv', dataBase64: Buffer.from('type,from,to,value,unit\nheight-difference,BM,P1,0.1,m').toString('base64') })
function events(db: Database.Database): Array<Record<string, any>> {
  const rows = db.prepare('SELECT * FROM survey_import_attempt_events ORDER BY sequence').all() as Array<Record<string, any>>
  const previous = new Map<string, string>()
  return rows.map(row => {
    const event = JSON.parse(row.data_json)
    expect(createHash('sha256').update(row.data_json).digest('hex')).toBe(row.record_hash)
    expect(event.previousHash).toBe(previous.get(row.attempt_id) ?? null)
    previous.set(row.attempt_id, row.record_hash)
    return event
  })
}
afterEach(async () => {
  databases.splice(0).forEach(db => db.close())
  services.splice(0).forEach(service => service.close())
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('durable import attempt evidence', () => {
  it('records schema and source preservation failures before any network exists without raw content', async () => {
    const { service, db, root } = await setup()
    await expect(service.importNetwork({ secret: 'DO-NOT-STORE' })).rejects.toThrow()
    await writeFile(join(root, 'sources'), 'DO-NOT-STORE')
    await expect(service.importNetwork(request())).rejects.toThrow()
    const recorded = events(db)
    expect(recorded.map(e => e.phase)).toEqual(['started', 'finished', 'started', 'finished'])
    expect(recorded[0]).toMatchObject({ taskHash: null, mode: 'unclassified' })
    expect(recorded[1]).toMatchObject({ outcome: 'rejected', rejection: 'validation' })
    expect(recorded[3]).toMatchObject({ outcome: 'rejected', rejection: 'parse' })
    expect(JSON.stringify(recorded)).not.toMatch(/DO-NOT-STORE|private-project|private-file|private-idempotency/)
    expect(service.listNetworks()).toHaveLength(0)
  })

  it('records archived unknown sources without presenting them as adjustment-ready', async () => {
    const { service, db } = await setup()
    const network = await service.importNetwork({ ...request(), dataBase64: Buffer.from('DO-NOT-STORE unknown source').toString('base64') })
    expect(network.sourceFile?.disposition).toBe('archive-only')
    expect(events(db)).toMatchObject([{ phase: 'started' }, { phase: 'committed', sourceDisposition: 'archive-only' }, { phase: 'finished', outcome: 'succeeded' }])
    expect(JSON.stringify(events(db))).not.toContain('DO-NOT-STORE')
  })

  it('preserves first failure when the same key succeeds later and scopes keys by project', async () => {
    const { service, db } = await setup()
    await expect(service.importNetwork({ ...request(), expectedRevision: 99 })).rejects.toThrow()
    await service.importNetwork(request())
    await expect(service.importNetwork({ ...request(), projectId: 'other-project' })).rejects.toThrow()
    const recorded = events(db)
    const starts = recorded.filter(e => e.phase === 'started')
    expect(starts[0]!.taskHash).toBe(starts[1]!.taskHash)
    expect(starts[2]!.taskHash).not.toBe(starts[0]!.taskHash)
    expect(recorded.filter(e => e.phase === 'finished').map(e => e.outcome)).toEqual(['rejected', 'succeeded', 'rejected'])
  })

  it('records concurrent invocations with one new commit and one replay', async () => {
    const { service, db, root } = await setup()
    const other = new SurveyService({ rootDir: root }); services.push(other)
    const [a, b] = await Promise.all([service.importNetwork(request()), other.importNetwork(request())])
    expect(a.id).toBe(b.id)
    const recorded = events(db)
    expect(recorded.filter(e => e.phase === 'started')).toHaveLength(2)
    expect(recorded.filter(e => e.phase === 'committed').map(e => e.replay).sort()).toEqual([false, true])
    expect(recorded.filter(e => e.phase === 'finished' && e.outcome === 'succeeded')).toHaveLength(2)
    expect(service.listNetworks()).toHaveLength(1)
  })

  it('keeps a committed projection failure distinct from successful replay', async () => {
    const { service, db } = await setup({ brokenWorkspace: true })
    await expect(service.importNetwork(request())).rejects.toThrow()
    await service.importNetwork(request())
    const recorded = events(db)
    expect(recorded.filter(e => e.phase === 'committed').map(e => e.replay)).toEqual([false, true])
    expect(recorded.filter(e => e.phase === 'finished')).toMatchObject([
      { outcome: 'rejected', rejection: 'projection' }, { outcome: 'succeeded', rejection: null }
    ])
    expect(service.listNetworks()).toHaveLength(1)
  })

  it.each(['started', 'committed', 'finished'])('fails closed on %s audit insertion failure', async phase => {
    const { service, db } = await setup()
    db.exec(`CREATE TRIGGER fail_import_audit BEFORE INSERT ON survey_import_attempt_events WHEN NEW.phase = '${phase}' BEGIN SELECT RAISE(ABORT, 'private injected failure'); END`)
    await expect(service.importNetwork(request())).rejects.toThrow('survey import audit could not be persisted')
    const recorded = events(db)
    expect(recorded.map(e => e.phase)).toEqual(phase === 'started' ? [] : phase === 'committed' ? ['started'] : ['started', 'committed'])
    expect(service.listNetworks()).toHaveLength(phase === 'finished' ? 1 : 0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM survey_idempotency').get()).toEqual({ n: phase === 'finished' ? 1 : 0 })
  })

  it('records ordinary transactional insertion failures as rejection and leaves no partial network', async () => {
    const { service, db } = await setup()
    db.exec("CREATE TRIGGER fail_import_key BEFORE INSERT ON survey_idempotency BEGIN SELECT RAISE(ABORT, 'private storage failure'); END")
    await expect(service.importNetwork(request())).rejects.toThrow()
    expect(events(db)).toMatchObject([{ phase: 'started' }, { phase: 'finished', outcome: 'rejected', rejection: 'commit' }])
    expect(service.listNetworks()).toHaveLength(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM survey_raw_source_ledger').get()).toEqual({ n: 0 })
  })

  it('protects audit rows from updates, deletes and replacement with recursive triggers disabled', async () => {
    const { service, db } = await setup()
    await service.importNetwork(request())
    db.pragma('recursive_triggers = OFF')
    expect(() => db.exec("UPDATE survey_import_attempt_events SET data_json = '{}' ")).toThrow(/append-only/)
    expect(() => db.exec('DELETE FROM survey_import_attempt_events')).toThrow(/append-only/)
    expect(() => db.exec('INSERT OR REPLACE INTO survey_import_attempt_events SELECT * FROM survey_import_attempt_events WHERE sequence = 1')).toThrow(/append-only/)
    expect(events(db)).toHaveLength(3)
  })

  it('records authenticated-handler transport and structured-payload rejections and surfaces audit outage as 503', async () => {
    const { service, db } = await setup()
    const send = (body: string, headers?: Record<string, string>) => importSurveyNetwork(service,
      new Request('http://runtime/v1/engineering/survey/networks/import', { method: 'POST', body, headers }))
    expect((await send('{private-invalid')).status).toBe(400)
    expect((await send('{}', { 'content-length': '999999999' })).status).toBe(413)
    expect((await send(JSON.stringify({ ...request(), network: {} }))).status).toBe(400)
    expect(events(db).filter(e => e.phase === 'finished').map(e => e.rejection)).toEqual(['invalid-json', 'body-too-large', 'structured-http'])
    db.exec("CREATE TRIGGER fail_import_audit BEFORE INSERT ON survey_import_attempt_events BEGIN SELECT RAISE(ABORT, 'private failure'); END")
    expect((await send('{invalid')).status).toBe(503)
  })

  it('measures actual service receipts with the read-only Python CLI without promoting production provenance', async () => {
    const { service, db, root } = await setup()
    await expect(service.importNetwork({ ...request(), expectedRevision: 99 })).rejects.toThrow()
    await service.importNetwork(request())
    await service.importNetwork(request())
    service.recordRejectedImport(undefined, 'invalid-json')
    const engineeringPath = join(root, 'engineering.sqlite3')
    const engineering = new Database(engineeringPath)
    engineering.exec('CREATE TABLE engineering_projects (data_json TEXT); CREATE TABLE engineering_manifests (data_json TEXT)')
    engineering.close()
    const before = events(db)
    const script = fileURLToPath(new URL('../../../scripts/measure-survey-workflows.py', import.meta.url))
    const output = execFileSync('python3', [script, '--engineering-db', engineeringPath, '--survey-db', join(root, 'survey.sqlite3'),
      '--cohort', 'production', '--start', '2000-01-01T00:00:00Z', '--end', '2100-01-01T00:00:00Z'], { encoding: 'utf8' })
    const result = JSON.parse(output)
    expect(result.recordedImportAttempts.counts).toMatchObject({ startedInPeriod: 4, succeededByPeriodEnd: 2,
      rejectedByPeriodEnd: 2, replayRequests: 1, unidentifiableRequestKeys: 1 })
    expect(result.recordedImportAttempts.firstObservedFileRequestCompletionRate).toMatchObject({ numerator: 0, denominator: 1, value: 0 })
    expect(result.productionRepresentativeness.status).toBe('not-measurable')
    expect(result.firstAttemptImportSuccessRate.status).toBe('not-measurable')
    expect(output).not.toMatch(/private-project|private-file|private-idempotency/)
    expect(events(db)).toEqual(before)
  })
})
