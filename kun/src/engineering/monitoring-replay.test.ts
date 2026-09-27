import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { ModuleKind, transpileModule } from 'typescript'
import { afterEach, expect, it } from 'vitest'
import { MonitoringReplayVerificationV1 } from '../contracts/engineering.js'
import { EngineeringService } from './engineering-service.js'
import { MonitoringReplayAudit } from './monitoring-replay-audit.js'

const resources: Array<{ root: string; service: EngineeringService }> = []
afterEach(async () => {
  for (const { root, service } of resources.splice(0)) {
    await service.flush(); service.close(); await rm(root, { recursive: true, force: true })
  }
})
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(options: { algorithm?: string; corruptResults?: boolean; rows?: string; source?: Buffer; name?: string; mutateDataset?: (dataset: ReturnType<EngineeringService['validateDataset']>) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'monitoring-replay-'))
  const service = new EngineeringService({ rootDir: join(root, 'runtime'), runtimeVersion: 'private-candidate' })
  resources.push({ root, service })
  const db = (service as unknown as { db: Database.Database }).db
  const project = service.createProject({ name: 'Synthetic replay', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'replay-project' })
  const source = options.source ?? Buffer.from(`monitoringItem,point,time,value,unit\n${options.rows ?? 'settlement,P1,2026-08-01T00:00:00Z,0,mm\nsettlement,P1,2026-08-02T00:00:00Z,10,mm'}`)
  const importRequest = { projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'replay-import', name: options.name ?? 'observations.csv', dataBase64: source.toString('base64') }
  const imported = await service.importDataset(importRequest)
  const dataset = service.validateDataset({ datasetId: imported.id, expectedRevision: imported.revision, idempotencyKey: 'replay-validate' })
  if (options.mutateDataset) {
    options.mutateDataset(dataset)
    db.prepare('UPDATE engineering_datasets SET data_json=? WHERE id=?').run(JSON.stringify(dataset), dataset.id)
  }
  const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'replay-analyze' })
  if (options.algorithm || options.corruptResults) {
    if (options.algorithm) analysis.algorithmVersion = options.algorithm
    if (options.corruptResults) analysis.results[0]!.currentValue = 99
    db.prepare('UPDATE engineering_analyses SET data_json=? WHERE id=?').run(JSON.stringify(analysis), analysis.id)
  }
  const manifest = await service.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: dataset.revision, idempotencyKey: 'replay-finalize', acknowledgeWarnings: true })
  const replay = () => service.replayMonitoringDeliverable(project.id, manifest.id)
  const events = () => db.prepare('SELECT * FROM engineering_monitoring_replay_events ORDER BY sequence').all() as Array<{ phase: string; data_json: string; record_hash: string }>
  return { root, service, db, project, dataset, analysis, manifest, replay, events, source, importRequest }
}

it('reparses actual source bytes, recomputes exact results and preserves all old business/output/audit records', async () => {
  const f = await fixture()
  const tables = (f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'engineering_%' AND name != 'engineering_monitoring_replay_events' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
  const snapshot = () => tables.map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  const before = snapshot()
  const outputBytes = await Promise.all(f.manifest.outputs.map(file => readFile(join(f.root, file.path))))
  const result = await f.replay()
  expect(result).toMatchObject({ status: 'passed', reasonCode: 'matched', execution: { timeBasis: 'ISO-unzoned-UTC' } })
  expect(result.analyses[0]).toMatchObject({ sourceFileHash: sha(f.source.toString()), sourceContextHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(result.analyses[0]!.storedResultsHash).toBe(result.analyses[0]!.recomputedResultsHash)
  expect(snapshot()).toEqual(before)
  expect(await Promise.all(f.manifest.outputs.map(file => readFile(join(f.root, file.path))))).toEqual(outputBytes)
  const events = f.events()
  expect(events.map(row => row.phase)).toEqual(['started', 'finished'])
  expect(events.every(row => sha(row.data_json) === row.record_hash)).toBe(true)
  expect(JSON.parse(events[1]!.data_json)).toMatchObject({ previousHash: events[0]!.record_hash, resultHash: sha(JSON.stringify(result)), result })
})

it.each(['workwise-engineering-1', 'unknown-future-version'])('does not guess the environment for %s', async algorithm => {
  const f = await fixture({ algorithm })
  expect(await f.replay()).toMatchObject({ status: 'not-evaluated', reasonCode: 'unsupported-algorithm' })
})

it('detects a coherently bound but numerically incorrect stored analysis', async () => {
  const f = await fixture({ corruptResults: true })
  expect(f.service.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(true)
  const result = await f.replay()
  expect(result).toMatchObject({ status: 'failed', reasonCode: 'result-mismatch' })
  expect(result.analyses[0]!.recomputedResultsHash).not.toBe(result.analyses[0]!.storedResultsHash)
})

it('reports old unavailable originals without backfilling an idempotent import', async () => {
  const f = await fixture()
  f.db.exec('DROP TRIGGER monitoring_sources_no_delete; DELETE FROM engineering_monitoring_sources')
  await f.service.importDataset(f.importRequest)
  expect(f.db.prepare('SELECT count(*) AS n FROM engineering_monitoring_sources').get()).toEqual({ n: 0 })
  expect(await f.replay()).toMatchObject({ status: 'not-evaluated', reasonCode: 'source-unavailable' })
})

it.each(['bytes', 'context', 'mapping'])('rejects tampered original %s evidence', async target => {
  const f = await fixture()
  f.db.exec('DROP TRIGGER monitoring_sources_no_update')
  if (target === 'bytes') f.db.prepare('UPDATE engineering_monitoring_sources SET source_bytes=?').run(Buffer.from('wrong bytes'))
  if (target === 'context') f.db.prepare('UPDATE engineering_monitoring_sources SET context_json=?').run('{}')
  if (target === 'mapping') {
    const row = f.db.prepare('SELECT context_json FROM engineering_monitoring_sources').get() as { context_json: string }
    const context = JSON.parse(row.context_json)
    context.fieldMapping.value = 'other-column'
    const encoded = JSON.stringify(context)
    f.db.prepare('UPDATE engineering_monitoring_sources SET context_json=?,context_hash=?').run(encoded, sha(encoded))
  }
  expect(await f.replay()).toMatchObject({ status: 'failed', reasonCode: 'source-mismatch' })
})

it('does not read oversized original blobs', async () => {
  const f = await fixture()
  f.db.exec('DROP TRIGGER monitoring_sources_no_update; UPDATE engineering_monitoring_sources SET source_bytes=zeroblob(33554433)')
  expect(await f.replay()).toMatchObject({ status: 'not-evaluated', reasonCode: 'resource-limit' })
})

it('does not read oversized source context or persist a new oversized import', async () => {
  const f = await fixture()
  f.db.exec('DROP TRIGGER monitoring_sources_no_update; UPDATE engineering_monitoring_sources SET context_json=CAST(zeroblob(262145) AS TEXT)')
  expect(await f.replay()).toMatchObject({ status: 'not-evaluated', reasonCode: 'resource-limit' })
  await expect(f.service.importDataset({ ...f.importRequest, idempotencyKey: 'oversized-import', dataBase64: Buffer.alloc(33554433).toString('base64') })).rejects.toThrow(/32 MiB/)
  expect(f.db.prepare('SELECT count(*) AS n FROM engineering_datasets').get()).toEqual({ n: 1 })
})

it.each(['sourceRow', 'sourceFields', 'unit', 'cumulative', 'rate'] as const)('reparses all provenance/value fields, including %s', async field => {
  const f = await fixture({ mutateDataset: dataset => {
    const observation = dataset.observations[0]!
    if (field === 'sourceRow') observation.sourceRow = 99
    if (field === 'sourceFields') observation.sourceFields = { invented: 'value' }
    if (field === 'unit') observation.unit = 'm'
    if (field === 'cumulative') observation.cumulative = 55
    if (field === 'rate') observation.rate = 55
  } })
  expect(f.service.verifyDeliverable(f.project.id, f.manifest.id).valid).toBe(true)
  expect(await f.replay()).toMatchObject({ status: 'failed', reasonCode: 'source-mismatch' })
})

it('uses original requested mapping to select XLSX worksheets and preserves worksheet provenance', async () => {
  const zip = new JSZip()
  const sheet = (rows: string[][]) => `<worksheet><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${value}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`
  zip.file('xl/worksheets/sheet1.xml', sheet([['point', 'time', 'value'], ['P1', '2026-08-01', '1']]))
  zip.file('xl/worksheets/sheet2.xml', sheet([['point', 'time', 'value'], ['P2', '2026-08-02', '2']]))
  zip.file('xl/worksheets/sheet3.xml', sheet([['note'], ['synthetic metadata']]))
  const f = await fixture({ source: await zip.generateAsync({ type: 'nodebuffer' }), name: 'multisheet.xlsx' })
  expect(f.dataset.rowCount).toBe(2)
  expect(f.dataset.observations[0]!.sourceFields.__worksheet).toBe('xl/worksheets/sheet1.xml')
  expect(f.dataset.observations[1]!.sourceFields.__worksheet).toBe('xl/worksheets/sheet2.xml')
  const context = JSON.parse((f.db.prepare('SELECT context_json FROM engineering_monitoring_sources').get() as { context_json: string }).context_json)
  expect(context.requestedMapping).toBeNull()
  expect(context.fieldMapping).toMatchObject({ point: 'point', timestamp: 'time', value: 'value' })
  expect(await f.replay()).toMatchObject({ status: 'passed', reasonCode: 'matched' })
})

async function oversizedWorkbook(kind: 'ratio' | 'expanded' | 'entries' | 'columns'): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('xl/worksheets/sheet1.xml', kind === 'columns'
    ? '<worksheet><sheetData><row><c r="ZZZ1"><v>1</v></c></row></sheetData></worksheet>'
    : '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>point</t></is></c><c r="B1" t="inlineStr"><is><t>time</t></is></c><c r="C1" t="inlineStr"><is><t>value</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>P1</t></is></c><c r="B2" t="inlineStr"><is><t>2026-08-01</t></is></c><c r="C2"><v>1</v></c></row></sheetData></worksheet>')
  if (kind === 'ratio' || kind === 'expanded') {
    zip.file('xl/sharedStrings.xml', ' '.repeat(kind === 'ratio' ? 1024 * 1024 : 33 * 1024 * 1024))
    // Keep the whole archive below 200:1 to exercise the actual byte budget independently.
    if (kind === 'expanded') zip.file('padding.bin', randomBytes(256 * 1024))
  }
  if (kind === 'entries') for (let i = 0; i < 2049; i++) zip.file(`entry-${i}.txt`, '')
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

it.each(['ratio', 'expanded', 'entries', 'columns'] as const)('bounds actual XLSX %s before storing a new import', async kind => {
  const f = await fixture()
  const bytes = await oversizedWorkbook(kind)
  expect(bytes.length).toBeLessThan(32 * 1024 * 1024)
  if (kind === 'expanded') expect(33 * 1024 * 1024 / bytes.length).toBeLessThan(200)
  await expect(f.service.importDataset({ ...f.importRequest, idempotencyKey: `budget-${kind}`, name: 'budget.xlsx', dataBase64: bytes.toString('base64') })).rejects.toThrow(/XLSX exceeds the resource limit/)
  expect(f.db.prepare('SELECT count(*) AS n FROM engineering_datasets').get()).toEqual({ n: 1 })
})

it('reports a preserved pre-budget XLSX as not-evaluated when actual expansion exceeds the limit', async () => {
  const f = await fixture()
  const bytes = await oversizedWorkbook('ratio')
  const sourceHash = createHash('sha256').update(bytes).digest('hex')
  const dataset = { ...f.dataset, sourceFileName: 'legacy-budget.xlsx', sourceFileHash: sourceHash }
  const context = JSON.parse((f.db.prepare('SELECT context_json FROM engineering_monitoring_sources').get() as { context_json: string }).context_json)
  const contextJson = JSON.stringify({ ...context, sourceFileName: dataset.sourceFileName, sourceFileHash: sourceHash })
  // Seed the exact storage shape of a prior import accepted before parser budgets existed.
  f.db.exec('DROP TRIGGER monitoring_sources_no_update')
  f.db.prepare('UPDATE engineering_monitoring_sources SET source_bytes=?,source_hash=?,context_json=?,context_hash=?').run(bytes, sourceHash, contextJson, sha(contextJson))
  f.db.prepare('UPDATE engineering_datasets SET data_json=? WHERE id=?').run(JSON.stringify(dataset), dataset.id)
  const manifest = await f.service.finalize({ projectId: f.project.id, datasetId: dataset.id, analysisId: f.analysis.id, expectedRevision: dataset.revision, idempotencyKey: 'legacy-budget-finalize', acknowledgeWarnings: true })
  expect(f.service.verifyDeliverable(f.project.id, manifest.id).valid).toBe(true)
  expect(await f.service.replayMonitoringDeliverable(f.project.id, manifest.id)).toMatchObject({ status: 'not-evaluated', reasonCode: 'resource-limit' })
})

it('does not guess historical numeric collation for ASCII IDs at duplicate instants', async () => {
  const rows = Array.from({ length: 12 }, (_, i) => `settlement,P1,${i % 2 ? '2026-08-01T08:00:00+08:00' : '2026-08-01T00:00:00Z'},${i},mm`).join('\n')
  const f = await fixture({ rows })
  const id2 = f.dataset.observations.find(item => item.id.endsWith('_2'))!.id
  const id10 = f.dataset.observations.find(item => item.id.endsWith('_10'))!.id
  expect(new Intl.Collator('en-US', { numeric: false }).compare(id10, id2)).toBeLessThan(0)
  expect(new Intl.Collator('en-US', { numeric: true }).compare(id10, id2)).toBeGreaterThan(0)
  expect(await f.replay()).toMatchObject({ status: 'not-evaluated', reasonCode: 'ambiguous-tie-order' })
})

it('rejects wrong project scope without revealing the other project analysis', async () => {
  const f = await fixture()
  expect(await f.service.replayMonitoringDeliverable('other-project', f.manifest.id)).toMatchObject({ status: 'failed', reasonCode: 'prerequisite-failed', analyses: [] })
})

it('rechecks project bindings after asynchronous original parsing', async () => {
  const f = await fixture()
  const pending = f.replay()
  f.db.prepare('UPDATE engineering_projects SET revision=revision+1 WHERE id=?').run(f.project.id)
  const result = await pending
  expect(result).toMatchObject({ status: 'failed', reasonCode: 'prerequisite-failed' })
  expect(result.analyses[0]!.status).toBe('failed')
})

it('rejects output changes before and during replay', async () => {
  const f = await fixture()
  const pending = f.replay()
  await writeFile(join(f.root, f.manifest.outputs[0]!.path), 'altered output')
  expect(await pending).toMatchObject({ status: 'failed', reasonCode: 'prerequisite-failed' })
  expect(await f.replay()).toMatchObject({ status: 'failed', reasonCode: 'prerequisite-failed' })
})

it('keeps source and replay rows append-only, including INSERT OR REPLACE', async () => {
  const f = await fixture()
  await f.replay()
  for (const table of ['engineering_monitoring_sources', 'engineering_monitoring_replay_events']) {
    expect(() => f.db.exec(`DELETE FROM ${table}`)).toThrow(/append-only/)
    const column = table.endsWith('sources') ? 'project_id' : 'manifest_id'
    expect(() => f.db.exec(`UPDATE ${table} SET ${column}='changed'`)).toThrow(/append-only/)
    expect(() => f.db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(/append-only/)
  }
})

it.each(['started', 'finished'])('fails closed when %s audit persistence fails', async phase => {
  const f = await fixture()
  f.db.exec(`CREATE TRIGGER reject_replay BEFORE INSERT ON engineering_monitoring_replay_events WHEN NEW.phase='${phase}' BEGIN SELECT RAISE(ABORT,'test rejection'); END`)
  await expect(f.replay()).rejects.toThrow('monitoring replay audit could not be saved')
  expect(f.events().map(row => row.phase)).toEqual(phase === 'started' ? [] : ['started'])
})

it('rejects reversed clocks and cannot roll a start back in a caller transaction', async () => {
  const f = await fixture()
  const result = await f.replay()
  const audit = new MonitoringReplayAudit(f.db, () => '2099-01-01T00:00:00Z')
  const attempt = audit.begin(f.project.id, f.manifest.id)
  expect(() => audit.finish(attempt, { ...result, attemptId: attempt.id })).toThrow(/audit/)
  expect(f.events().at(-1)!.phase).toBe('started')
  expect(() => f.db.transaction(() => audit.begin(f.project.id, f.manifest.id))()).toThrow(/audit/)
})

it('rejects invalid scope or calendar timestamps before persisting a start', async () => {
  const f = await fixture()
  for (const at of ['2026-02-30T00:00:00Z', '2026-09-21T24:00:00Z', '2026-09-21 00:00:00Z', '2026-09-21T00:00:00', 'not-a-date']) {
    const audit = new MonitoringReplayAudit(f.db, () => at)
    expect(() => audit.begin(f.project.id, f.manifest.id)).toThrow(/audit/)
  }
  const audit = new MonitoringReplayAudit(f.db, () => '2026-09-21T00:00:00Z')
  for (const badId of ['', 'x'.repeat(241)]) {
    expect(() => audit.begin(badId, f.manifest.id)).toThrow(/audit/)
    expect(() => audit.begin(f.project.id, badId)).toThrow(/audit/)
  }
  expect(f.events()).toEqual([])
})

it('retains a real committed start after child-process SIGKILL', async () => {
  const f = await fixture()
  const source = await readFile(resolve('src/engineering/monitoring-replay-audit.ts'), 'utf8')
  await writeFile(join(f.root, 'audit.mjs'), transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
  await writeFile(join(f.root, 'crash.mjs'), `import {createRequire} from 'node:module'; import {MonitoringReplayAudit} from './audit.mjs'; const Database=createRequire(${JSON.stringify(resolve('package.json'))})('better-sqlite3'); const db=new Database(${JSON.stringify(join(f.root, 'runtime', 'engineering.sqlite3'))}); const audit=new MonitoringReplayAudit(db,()=> '2026-09-20T01:00:00Z'); audit.begin('synthetic-project','synthetic-manifest'); process.kill(process.pid,'SIGKILL');`)
  const child = spawnSync(process.execPath, [join(f.root, 'crash.mjs')], { encoding: 'utf8', timeout: 10000 })
  expect(child.signal, child.stderr).toBe('SIGKILL')
  expect(f.events().map(row => row.phase)).toEqual(['started'])
})

it('rejects contradictory, unbounded or incomplete replay contracts', async () => {
  const f = await fixture()
  const result = await f.replay()
  for (const invalid of [
    { ...result, status: 'failed' }, { ...result, analyses: [] }, { ...result, attemptId: 'x'.repeat(241) },
    { ...result, execution: { ...result.execution, locale: 'x'.repeat(161) } },
    { ...result, analyses: [{ ...result.analyses[0], sourceContextHash: undefined }] },
    { ...result, analyses: [{ ...result.analyses[0], recomputedResultsHash: '0'.repeat(64) }] }
  ]) expect(MonitoringReplayVerificationV1.safeParse(invalid).success).toBe(false)
})
