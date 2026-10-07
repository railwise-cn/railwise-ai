import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha = value => createHash('sha256').update(value).digest('hex')

export function snapshotRows(Database, directory) {
  const snapshot = {}
  for (const name of ['engineering.sqlite3', 'survey.sqlite3']) {
    const database = new Database(join(directory, name), { readonly: true, fileMustExist: true })
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      snapshot[name] = Object.fromEntries(tables.map(({ name: table }) => {
        if (!/^[a-z0-9_]+$/.test(table)) throw new Error('Unexpected historical database table.')
        const rows = database.prepare(`SELECT * FROM "${table}"`).all().map(row => JSON.stringify(row, (_key, value) => Buffer.isBuffer(value) ? { base64: value.toString('base64') } : value)).sort()
        return [table, { count: rows.length, sha256: sha(JSON.stringify(rows)) }]
      }))
    } finally { database.close() }
  }
  return snapshot
}

export function assertHistoricalRowsPreserved(before, after) {
  for (const [file, tables] of Object.entries(before)) {
    for (const [table, rows] of Object.entries(tables)) assert.deepEqual(after[file]?.[table], rows, `Historical rows changed: ${file}/${table}`)
  }
}

export function snapshotFiles(root, relative = '') {
  const output = {}
  if (!existsSync(join(root, relative))) return output
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = join(relative, name); const info = lstatSync(join(root, path))
    if (info.isSymbolicLink()) throw new Error('Synthetic fixture must not contain links.')
    if (info.isDirectory()) Object.assign(output, snapshotFiles(root, path))
    else if (info.isFile() && !/\.sqlite3(?:-wal|-shm)?$/.test(path)) output[path] = sha(readFileSync(join(root, path)))
    else if (!info.isFile()) throw new Error('Synthetic fixture contains a special entry.')
  }
  return output
}

export function assertRetainedFiles(before, after) {
  for (const [path, digest] of Object.entries(before)) assert.equal(after[path], digest, `Retained fixture changed: ${path}`)
}

function argument(name) { return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) }

async function main() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') throw new Error('Fixture must use the verified packaged Electron in Node mode.')
  const app = resolve(argument('app')); const directory = resolve(argument('data-dir')); const workspace = resolve(argument('workspace'))
  const snapshotPath = resolve(argument('snapshot')); const reportPath = resolve(argument('report'))
  const mode = argument('mode')
  if (!['seed', 'verify'].includes(mode)) throw new Error('Fixture mode must be seed or verify.')
  const packagedRoot = join(app, 'Contents/Resources/app.asar/kun')
  const require = createRequire(join(packagedRoot, 'package.json'))
  const Database = require('better-sqlite3')
  const { EngineeringService } = await import(pathToFileURL(join(packagedRoot, 'dist/engineering/engineering-service.js')).href)
  const { SurveyService } = await import(pathToFileURL(join(packagedRoot, 'dist/engineering/survey-service.js')).href)
  const engineering = new EngineeringService({ rootDir: directory })
  const survey = new SurveyService({ rootDir: directory, getProject: id => engineering.getProject(id) })
  let identity
  try {
    if (mode === 'seed') {
      if (engineering.listProjects().length || survey.listNetworks().length) throw new Error('Refusing to seed an existing professional data store.')
      const project = engineering.createProject({ name: 'Synthetic 0.5.2 update compatibility', workspace, taskType: 'control-network', unit: 'm', expectedRevision: 0, idempotencyKey: 'frozen-updater-project' })
      // Original file import, validation and adjustment are performed by 0.5.2 itself.
      const source = Buffer.from('1.000,1,1\nA,50.000000,150.000000\nB,150.000000,50.000000\nC,120.710678,120.710678\nS1\nA,L,0\nB,L,270.00000\nB,S,100.000\nC,L,315.00000\nC,S,100.000\n')
      const network = await survey.importNetwork({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'frozen-updater-import', networkType: 'plane-control', name: 'synthetic.in2', dataBase64: source.toString('base64'), referenceDeclaration: { coordinateSystem: 'SYNTHETIC-LOCAL-GRID', verticalDatum: 'SYNTHETIC-LOCAL-BENCHMARK' } })
      const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'frozen-updater-validation' })
      const adjustment = survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'frozen-updater-adjustment' })
      assert.equal(adjustment.result.validation, 'valid')
      const dataset = await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'frozen-updater-monitoring', name: 'synthetic-monitoring.csv', dataBase64: Buffer.from('point,time,value\nP1,2026-09-01,1\nP1,2026-09-02,2\n').toString('base64') })
      identity = { projectId: project.id, networkId: network.id, adjustmentId: adjustment.run.id, resultId: adjustment.result.id, project, network: checked, run: adjustment.run, result: adjustment.result, datasetId: dataset.id, sourceSha256: sha(source), rawLedger: survey.getRawSourceLedger(network.id) }
    } else {
      const baseline = JSON.parse(readFileSync(snapshotPath, 'utf8')); identity = baseline.identity
      assert.deepEqual(engineering.getProject(identity.projectId), identity.project)
      assert.deepEqual(survey.getNetwork(identity.networkId), identity.network)
      const adjustment = survey.getAdjustment(identity.adjustmentId)
      assert.deepEqual(adjustment?.run, identity.run)
      assert.deepEqual(adjustment?.result, identity.result)
      assert.deepEqual(survey.getRawSourceLedger(identity.networkId), identity.rawLedger)
      assert.equal(engineering.getProjectOverview(identity.projectId).datasets[0]?.id, identity.datasetId)
      assert.equal(survey.getRawSourceIntegrity(identity.networkId).status, 'verified')
    }
    await Promise.all([engineering.flush(), survey.flush()])
  } finally { survey.close(); engineering.close() }
  const rows = snapshotRows(Database, directory)
  const files = { data: snapshotFiles(directory), workspace: snapshotFiles(workspace) }
  if (mode === 'seed') {
    if (existsSync(snapshotPath)) throw new Error('Fixture snapshot must be a new file.')
    mkdirSync(dirname(snapshotPath), { recursive: true })
    writeFileSync(snapshotPath, JSON.stringify({ schemaVersion: 1, identity, rows, files }) + '\n', { mode: 0o600, flag: 'wx' })
  } else {
    const baseline = JSON.parse(readFileSync(snapshotPath, 'utf8'))
    assertHistoricalRowsPreserved(baseline.rows, rows)
    assertRetainedFiles(baseline.files.data, files.data); assertRetainedFiles(baseline.files.workspace, files.workspace)
  }
  writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, mode, status: 'passed', projects: 1, networks: 1, adjustments: 1, monitoringDatasets: 1, sourceSha256: identity.sourceSha256,
    scope: 'Real packaged services with synthetic IN2 and CSV; historical storage/readback only. No field data, vendor interoperability, report/signature migration or live credential/plugin execution is certified.' }) + '\n', { mode: 0o600 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`[updater-data] ${error.message}`); process.exitCode = 1 })
