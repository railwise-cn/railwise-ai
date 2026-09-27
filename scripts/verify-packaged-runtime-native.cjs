const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')
const productBrand = require('../src/shared/product-brand.json')

const root = resolve(process.argv[2] || 'dist')
const target = process.argv[3]

if (target !== 'mac' && target !== 'win') {
  throw new Error('usage: verify-packaged-runtime-native.cjs DIST_DIR mac|win')
}

function sqliteSmokeScript(modulePath) {
  return [
    `const Database = require(${JSON.stringify(modulePath)})`,
    `const database = new Database(':memory:')`,
    `database.exec('CREATE TABLE qa (value INTEGER); INSERT INTO qa VALUES (1)')`,
    `if (database.prepare('SELECT value FROM qa').get().value !== 1) process.exit(71)`,
    `database.close()`,
    `console.log('WORKWISE_PACKAGED_SQLITE_OK ABI=' + process.versions.modules)`
  ].join(';')
}

function smoke(executable, modulePath) {
  if (!existsSync(executable)) throw new Error(`Packaged executable is missing: ${executable}`)
  if (!existsSync(modulePath)) throw new Error(`Packaged better-sqlite3 is missing: ${modulePath}`)
  return execFileSync(executable, ['-e', sqliteSmokeScript(modulePath)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
  }).trim()
}

if (target === 'win') {
  const appRoot = join(root, 'win-unpacked')
  const output = smoke(
    join(appRoot, 'WorkWise.exe'),
    join(appRoot, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3')
  )
  console.log(`Verified packaged WorkWise Runtime native dependency on Windows: ${output}`)
  process.exit(0)
}

function resolveMacAppName(directory) {
  const outputDirectory = join(root, directory)
  if (!existsSync(outputDirectory)) return null
  const productionName = join(outputDirectory, `${productBrand.platform}.app`)
  if (existsSync(productionName)) return `${productBrand.platform}.app`
  const candidates = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
    .map((entry) => entry.name)
  return candidates.length === 1 ? candidates[0] : null
}

const macTargets = [
  { arch: 'arm64', directory: 'mac-arm64' },
  { arch: 'x64', directory: 'mac' }
]
  .map((target) => ({ ...target, appName: resolveMacAppName(target.directory) }))
  .filter((target) => target.appName)

if (macTargets.length === 0) throw new Error(`No packaged macOS applications found under ${root}`)

let executed = 0
for (const candidate of macTargets) {
  const appRoot = join(root, candidate.directory, candidate.appName, 'Contents')
  const executable = join(appRoot, 'MacOS', candidate.appName.replace(/\.app$/, ''))
  const modulePath = join(
    appRoot,
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3'
  )

  if (candidate.arch !== process.arch && !(process.arch === 'arm64' && candidate.arch === 'x64')) {
    console.log(
      `Verified packaged better-sqlite3 presence for macOS ${candidate.arch}; execution is not supported on ${process.arch}.`
    )
    if (!existsSync(modulePath)) throw new Error(`Packaged better-sqlite3 is missing: ${modulePath}`)
    continue
  }

  const output = smoke(executable, modulePath)
  executed += 1
  console.log(`Verified packaged WorkWise Runtime native dependency on macOS ${candidate.arch}: ${output}`)
}

if (executed === 0) {
  throw new Error('No packaged macOS application could be executed for the native dependency smoke test.')
}
