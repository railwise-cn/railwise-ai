#!/usr/bin/env node
// Uses the real compiled scoring service and real SQLite. This does not launch GUI.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(process.argv[2] ?? join(here, '../../../..'))
const compiledPath = join(repository, 'kun/dist/engineering/survey-quality-scoring-workspace.js')
const { SurveyQualityScoringWorkspaceService } = await import(pathToFileURL(compiledPath).href)
const sha = value => createHash('sha256').update(value).digest('hex')
const root = mkdtempSync(join(tmpdir(), 'railwise-quality-development-'))
const workspace = join(root, 'workspace')
mkdirSync(workspace)
const project = { id: 'quality-development-smoke', revision: 1, workspace }
let clock = Date.now()
const options = { rootDir: root, getProject: id => id === project.id ? { ...project } : null,
  clockMs: () => clock, nowIso: () => new Date(clock).toISOString() }
let service = new SurveyQualityScoringWorkspaceService(options)
const records = [], checks = []
try {
  for (const name of ['full', 'child-veto', 'pending', 'multiple-sixty']) {
    // Advancing the injected clock isolates correctness from the admission rate gate.
    clock += 60_001
    const original = readFileSync(join(here, 'inputs', `quality-${name}.json`))
    const declarationJson = new TextDecoder('utf-8', { fatal: true }).decode(original)
    assert.deepEqual(Buffer.from(declarationJson), original)
    const model = JSON.parse(declarationJson)
    const request = { kind: model.operation, acknowledged: true, expectedProjectRevision: project.revision,
      idempotencyKey: `quality-development-${name}`, declarationJson,
      modelBasisStatement: '真实编译服务的开发链路验证。合成检查资料😀；非包内 GUI、非工程验收。\n' }
    const raw = Buffer.from(`\t${JSON.stringify(request)}\r\n`)
    const summary = service.createRecord(project.id, raw)
    const record = service.getRecord(project.id, summary.id)
    assert.equal(record.requestJson, raw.toString('utf8'))
    assert.equal(record.declarationJson, declarationJson)
    assert.equal(record.requestSha256, sha(raw))
    assert.equal(record.declarationSha256, sha(original))
    assert.deepEqual(service.createRecord(project.id, raw), summary)
    assert.equal(service.reverifyRecord(project.id, summary.id).recomputed, true)
    const expected = name === 'full' ? 'calculated' : name === 'child-veto' ? 'nonconforming' : 'unavailable'
    assert.equal(record.outcome, expected)
    if (name === 'full') assert.deepEqual(record.result.result.score, { numerator: '9141', denominator: '100' })
    else { assert.equal(record.result.result.score, null); assert.equal(record.result.result.grade, null) }
    if (name === 'child-veto') assert.deepEqual(record.result.trace.find(item => item.nodeId === 'observation-quality').result.rawScore, { numerator: '52', denominator: '1' })
    if (name === 'pending') assert.deepEqual(record.result.pendingSubelementIds, ['completeness'])
    if (name === 'multiple-sixty') assert.equal(record.result.result.reason, 'multiple_accuracy_equality_60')
    records.push(record)
    checks.push({ case: name, recordId: record.id, outcome: record.outcome, scope: record.scopeAssessment,
      exactScore: record.result.result.score, declarationSha256: record.declarationSha256,
      originalBytesPreserved: true, exactIdempotentRetry: true, runtimeReverified: true })
  }
  service.close()
  clock += 60_001
  service = new SurveyQualityScoringWorkspaceService(options)
  for (const record of records) {
    assert.deepEqual(service.getRecord(project.id, record.id), record)
    assert.equal(service.reverifyRecord(project.id, record.id).recordHash, record.recordHash)
  }
  assert.equal(service.listRecords(project.id).records.length, 4)
} finally { service.close() }

const database = join(root, 'survey-quality-scoring.sqlite3')
const probe = spawnSync(process.env.REVIEW_PYTHON ?? 'python3', [join(here, 'inspect-packaged-records.py'), database, '--project', project.id], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
if (probe.error || probe.status !== 0) throw new Error(`Independent Python verification failed: ${probe.error?.message ?? probe.stderr}`)
const independent = JSON.parse(probe.stdout)
assert.equal(independent.recordsChecked, 4)
assert.equal(independent.allFourCasesPresent, true)
const negativeCode = `
import importlib.util,json,sqlite3,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
script,original,project,inputs=sys.argv[1:]
spec=importlib.util.spec_from_file_location('quality_record_inspector',script)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
results=[]
for mode in ('changed-request-bytes','coherent-wrong-score','missing-required-case'):
    with tempfile.TemporaryDirectory(prefix='quality-inspector-negative-') as directory:
        target=Path(directory)/'copy.sqlite3'
        source=sqlite3.connect(Path(original).resolve().as_uri()+'?mode=ro',uri=True)
        db=sqlite3.connect(target);source.backup(db);source.close();db.row_factory=sqlite3.Row
        row=dict(db.execute('SELECT * FROM quality_scoring_records WHERE idempotency_key=?',('quality-development-full',)).fetchone())
        if mode=='missing-required-case':
            db.execute('DROP TRIGGER quality_scoring_records_no_delete')
            db.execute('DELETE FROM quality_scoring_records WHERE id=?',(row['id'],))
        else:
            db.execute('DROP TRIGGER quality_scoring_records_no_update')
            if mode=='changed-request-bytes':
                db.execute('UPDATE quality_scoring_records SET request_bytes=? WHERE id=?',(b' '+row['request_bytes'],row['id']))
            else:
                record=m.load_json(row['data_json'])
                record['result']['result']['score']={'numerator':'4571','denominator':'50'}
                record['resultHash']=m.digest(record['result'])
                record['recordHash']=m.digest({k:v for k,v in record.items() if k!='recordHash'})
                row['record_hash']=record['recordHash'];row['data_json']=m.json_text(record)
                meta={k:v for k,v in row.items() if k not in ('request_bytes','declaration_bytes','storage_hash')}
                row['storage_hash']=m.digest({**meta,'request_bytes_sha256':m.sha(row['request_bytes']),'declaration_bytes_sha256':m.sha(row['declaration_bytes'])})
                db.execute('UPDATE quality_scoring_records SET record_hash=?,data_json=?,storage_hash=? WHERE id=?',(row['record_hash'],row['data_json'],row['storage_hash'],row['id']))
        db.commit();db.close()
        try: m.inspect(target,project,Path(inputs))
        except ValueError as error: results.append({'case':mode,'rejected':True,'reason':str(error)})
        else: raise RuntimeError('Inspector incorrectly accepted '+mode)
print(json.dumps(results,ensure_ascii=False))
`
const negativeProbe = spawnSync(process.env.REVIEW_PYTHON ?? 'python3', ['-c', negativeCode, join(here, 'inspect-packaged-records.py'), database, project.id, join(here, 'inputs')], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
if (negativeProbe.error || negativeProbe.status !== 0) throw new Error(`Independent inspector negative probes failed: ${negativeProbe.error?.message ?? negativeProbe.stderr}`)
const negativeChecks = JSON.parse(negativeProbe.stdout)
assert.equal(negativeChecks.length, 3)
const modules = ['kun/dist/engineering/survey-quality-scoring-workspace.js', 'kun/dist/contracts/survey-quality-scoring-workspace.js',
  'kun/dist/engineering/survey-quality-scoring.js', 'kun/dist/engineering/survey-quality-scoring-exact.js', 'kun/dist/engineering/survey-quality-scoring-rules.js', 'kun/dist/contracts/survey-quality-scoring.js']
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), scope: 'development-compiled-service-real-sqlite-only',
  guiExecuted: false, packagedApplicationExecuted: false, releaseAuthorizedByThisCheck: false, professionalApproval: false,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  repository, database, temporaryDatabaseRetained: true, injectedClockUsedForRateIsolation: true,
  compiledSha256: Object.fromEntries(modules.map(path => [path, sha(readFileSync(join(repository, path)))])),
  cases: checks, fullServiceRestartSameRecords: true, independentPythonInspection: independent, independentInspectorNegativeChecks: negativeChecks }
writeFileSync(join(here, 'development-smoke.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ passed: checks.length, independentCases: independent.recordsChecked, database, report: join(here, 'development-smoke.json'), guiExecuted: false }, null, 2))
