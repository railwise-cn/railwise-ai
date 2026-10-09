import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha = value => createHash('sha256').update(value).digest('hex')
export const SERVICE_MODULES = ['dist/engineering/engineering-service.js', 'dist/engineering/survey-service.js']
// The baseline snapshot is JSON. Optional undefined properties added by a
// newer reader have no persisted JSON value; SQLite row hashes remain strict.
export function persistedJsonValue(value) { return JSON.parse(JSON.stringify(value)) }

function within(root, path) {
  const name = relative(root, path)
  return name !== '..' && !name.startsWith('../') && !isAbsolute(name)
}

// A partial or broken package is a failure, never permission to use the checkout.
export function resolveFixtureService({ app, mode, compatibilityRoot }) {
  if (!['seed', 'verify', 'inspect'].includes(mode)) throw new Error('Fixture mode must be seed, verify or inspect.')
  const resources = join(app, 'Contents/Resources')
  const layouts = ['asar-unpacked', 'asar'].map(layout => {
    const root = join(resources, layout === 'asar-unpacked' ? 'app.asar.unpacked/kun' : 'app.asar/kun')
    return { root, layout, present: SERVICE_MODULES.map(name => existsSync(join(root, name))) }
  })
  for (const candidate of layouts) {
    if (candidate.present.some(Boolean) && !candidate.present.every(Boolean)) throw new Error(`Incomplete packaged Survey services (${candidate.layout}).`)
  }
  const packaged = layouts.find(candidate => candidate.present.every(Boolean))
  if (packaged) return { ...packaged, serviceSource: mode === 'seed' ? 'baseline-package' : 'target-package' }
  if (mode !== 'seed') throw new Error('Target package does not contain both Survey services; source fallback is forbidden.')
  if (!compatibilityRoot || !SERVICE_MODULES.every(name => existsSync(join(compatibilityRoot, name)))) throw new Error('Baseline compatibility services must be built before acceptance.')
  return { root: compatibilityRoot, layout: 'source-compatibility', serviceSource: 'source-bound-compatibility-service' }
}

export function validateFixtureExecution(app, executable, metadata, mode, sourceHead) {
  assert.equal(realpathSync(executable), realpathSync(join(app, 'Contents/MacOS/RailWise AI')), 'Fixture must execute the selected packaged application.')
  assert.equal(metadata.version, mode === 'seed' ? '0.5.2' : '0.5.3', 'Fixture package version')
  if (!/^[a-f0-9]{40}$/.test(sourceHead ?? '')) throw new Error('Exact frozen source is required for fixture provenance.')
  if (mode !== 'seed') assert.equal(metadata.buildProvenance?.sourceHead, sourceHead, 'Fixture target source')
}

// Electron fs reads ASAR entries; copying explicitly also follows the unpacked
// native binary mapping without rebuilding a different ABI for the baseline.
function copyPackageTree(source, destination) {
  const stat = lstatSync(source)
  if (stat.isSymbolicLink()) throw new Error('Compatibility dependency must not contain links.')
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const name of readdirSync(source)) copyPackageTree(join(source, name), join(destination, name))
  } else if (stat.isFile()) writeFileSync(destination, readFileSync(source), { mode: stat.mode & 0o777 })
  else throw new Error('Compatibility dependency contains a special entry.')
}

export function prepareCompatibilityService(app, checkoutRoot, destination) {
  if (existsSync(destination)) throw new Error('Compatibility staging must be new.')
  if (!SERVICE_MODULES.every(name => existsSync(join(checkoutRoot, name)))) throw new Error('Baseline compatibility services must be built before acceptance.')
  const packageRequire = createRequire(join(app, 'Contents/Resources/app.asar/package.json'))
  const sqliteEntry = packageRequire.resolve('better-sqlite3')
  const sqliteRoot = dirname(dirname(sqliteEntry))
  if (!within(join(app, 'Contents/Resources'), realpathSync(sqliteRoot))) throw new Error('Baseline SQLite must come from the selected package.')
  mkdirSync(destination, { recursive: true, mode: 0o700 })
  cpSync(join(checkoutRoot, 'dist'), join(destination, 'dist'), { recursive: true })
  cpSync(join(checkoutRoot, 'package.json'), join(destination, 'package.json'))
  cpSync(join(checkoutRoot, 'node_modules'), join(destination, 'node_modules'), { recursive: true,
    filter: path => !['.bin', 'better-sqlite3'].includes(relative(join(checkoutRoot, 'node_modules'), path).split('/')[0]) })
  copyPackageTree(sqliteRoot, join(destination, 'node_modules/better-sqlite3'))
  return destination
}

export function fixtureServiceIdentity({ app, selection, metadata, sourceHead, diskRead = readFileSync }) {
  const resources = join(app, 'Contents/Resources')
  const allowedRoot = selection.layout === 'source-compatibility' ? selection.root : resources
  const require = createRequire(join(selection.root, 'package.json'))
  const dependencies = []
  for (const name of ['better-sqlite3', 'jszip', 'pdfkit', 'zod']) {
    const entry = require.resolve(name)
    if (!within(allowedRoot, realpathSync(entry))) throw new Error(`Service dependency resolved outside its selected package: ${name}`)
    let packageRoot = dirname(entry)
    while (within(allowedRoot, packageRoot)) {
      const manifest = join(packageRoot, 'package.json')
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) break
      packageRoot = dirname(packageRoot)
    }
    if (!within(allowedRoot, packageRoot)) throw new Error(`Service dependency package root is missing: ${name}`)
    // The whole owning package covers both ESM and CJS export conditions.
    dependencies.push({ name, path: relative(allowedRoot, join(packageRoot, 'package.json')),
      sha256: sha(readFileSync(join(packageRoot, 'package.json'))), treeSha256: sha(JSON.stringify(snapshotFiles(packageRoot))) })
  }
  const sqliteRoot = dirname(dirname(require.resolve('better-sqlite3')))
  const virtualNative = join(sqliteRoot, 'build/Release/better_sqlite3.node')
  const physicalNative = virtualNative.replace('/app.asar/', '/app.asar.unpacked/')
  const native = existsSync(physicalNative) ? physicalNative : virtualNative
  if (!within(allowedRoot, realpathSync(native))) throw new Error('SQLite native dependency resolved outside its selected package.')
  dependencies.push({ name: 'better-sqlite3-native', path: relative(allowedRoot, native), sha256: sha(readFileSync(native)) })
  const modules = SERVICE_MODULES.map(path => {
    const file = join(selection.root, path)
    if (!within(allowedRoot, realpathSync(file))) throw new Error('Survey service resolved outside its selected package.')
    return { path, sha256: sha(readFileSync(file)) }
  })
  return { schemaVersion: 1, packageVersion: metadata.version, packageSourceHead: metadata.buildProvenance?.sourceHead ?? null,
    asarSha256: sha(diskRead(join(resources, 'app.asar'))), layout: selection.layout,
    serviceSourceHead: selection.layout === 'source-compatibility' ? sourceHead : metadata.buildProvenance?.sourceHead ?? null,
    serviceTreeSha256: sha(JSON.stringify(snapshotFiles(selection.root, 'dist'))), modules, dependencies }
}

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
  const app = realpathSync(resolve(argument('app'))); const directory = resolve(argument('data-dir')); const workspace = resolve(argument('workspace'))
  const snapshotPath = resolve(argument('snapshot')); const reportPath = resolve(argument('report'))
  const mode = argument('mode')
  if (!['seed', 'verify', 'inspect'].includes(mode)) throw new Error('Fixture mode must be seed, verify or inspect.')
  const sourceHead = argument('source-head')
  const metadata = JSON.parse(readFileSync(join(app, 'Contents/Resources/app.asar/package.json'), 'utf8'))
  validateFixtureExecution(app, process.execPath, metadata, mode, sourceHead)
  const checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../kun')
  let selection = resolveFixtureService({ app, mode, compatibilityRoot: mode === 'seed' ? checkoutRoot : undefined })
  if (selection.layout === 'source-compatibility') {
    selection = { ...selection, root: prepareCompatibilityService(app, checkoutRoot, join(dirname(snapshotPath), 'baseline-compatibility-service')) }
  }
  const require = createRequire(join(selection.root, 'package.json'))
  const diskRead = createRequire(import.meta.url)('original-fs').readFileSync
  const serviceIdentity = fixtureServiceIdentity({ app, selection, metadata, sourceHead, diskRead })
  const serviceSource = selection.serviceSource
  const Database = require('better-sqlite3')
  const { EngineeringService } = await import(pathToFileURL(join(selection.root, SERVICE_MODULES[0])).href)
  const { SurveyService } = await import(pathToFileURL(join(selection.root, SERVICE_MODULES[1])).href)
  // Loading both complete services and opening SQLite verifies transitive JS
  // dependencies and the native baseline/target Electron ABI, without fallback.
  const nativeProbe = new Database(':memory:')
  try { assert.equal(nativeProbe.prepare('SELECT 1 AS value').get().value, 1) } finally { nativeProbe.close() }
  if (mode === 'inspect') {
    writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, mode, status: 'passed', serviceSource, serviceIdentity }) + '\n', { mode: 0o600, flag: 'wx' })
    return
  }
  const engineering = new EngineeringService({ rootDir: directory })
  const survey = new SurveyService({ rootDir: directory, getProject: id => engineering.getProject(id) })
  let identity
  try {
    if (mode === 'seed') {
      if (engineering.listProjects().length || survey.listNetworks().length) throw new Error('Refusing to seed an existing professional data store.')
      const project = engineering.createProject({ name: 'Synthetic 0.5.2 update compatibility', workspace, taskType: 'control-network', unit: 'm', expectedRevision: 0, idempotencyKey: 'frozen-updater-project' })
      // Seed provenance records whether these synthetic records were produced
      // by baseline services or explicitly source-bound compatibility services.
      const source = Buffer.from('1.000,1,1\nA,50.000000,150.000000\nB,150.000000,50.000000\nC,120.710678,120.710678\nS1\nA,L,0\nB,L,270.00000\nB,S,100.000\nC,L,315.00000\nC,S,100.000\n')
      const network = await survey.importNetwork({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'frozen-updater-import', networkType: 'plane-control', name: 'synthetic.in2', dataBase64: source.toString('base64'), referenceDeclaration: { coordinateSystem: 'SYNTHETIC-LOCAL-GRID', verticalDatum: 'SYNTHETIC-LOCAL-BENCHMARK' } })
      const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'frozen-updater-validation' })
      const adjustment = survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'frozen-updater-adjustment' })
      assert.equal(adjustment.result.validation, 'valid')
      const dataset = await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'frozen-updater-monitoring', name: 'synthetic-monitoring.csv', dataBase64: Buffer.from('point,time,value\nP1,2026-09-01,1\nP1,2026-09-02,2\n').toString('base64') })
      identity = { projectId: project.id, networkId: network.id, adjustmentId: adjustment.run.id, resultId: adjustment.result.id, project, network: checked, run: adjustment.run, result: adjustment.result, datasetId: dataset.id, sourceSha256: sha(source), rawLedger: survey.getRawSourceLedger(network.id) }
    } else {
      const baseline = JSON.parse(readFileSync(snapshotPath, 'utf8')); identity = baseline.identity
      assert.deepEqual(persistedJsonValue(engineering.getProject(identity.projectId)), identity.project)
      assert.deepEqual(persistedJsonValue(survey.getNetwork(identity.networkId)), identity.network)
      const adjustment = survey.getAdjustment(identity.adjustmentId)
      assert.deepEqual(persistedJsonValue(adjustment?.run), identity.run)
      assert.deepEqual(persistedJsonValue(adjustment?.result), identity.result)
      assert.deepEqual(persistedJsonValue(survey.getRawSourceLedger(identity.networkId)), identity.rawLedger)
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
    serviceSource, serviceIdentity, scope: 'Synthetic IN2 and CSV storage continuity. Seed may use explicitly source-bound compatibility services with the baseline packaged SQLite ABI; both target readbacks require the target packaged services. No field data, vendor interoperability, report/signature migration or live credential/plugin execution is certified.' }) + '\n', { mode: 0o600 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`[updater-data] ${error.message}`); process.exitCode = 1 })
