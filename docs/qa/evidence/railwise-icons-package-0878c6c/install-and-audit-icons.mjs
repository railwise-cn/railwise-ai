import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = process.env.WORKWISE_CANDIDATE_ROOT ?? '/private/tmp/workwise-candidate'
const REPO = process.env.WORKWISE_REPOSITORY ?? process.cwd()
const HEAD = '0878c6cc932c6f7e85855b2ad5be199d7aee67d7'
const updater = JSON.parse(readFileSync(join(ROOT, 'updater-evidence/private-updater.json'), 'utf8'))
assert.equal(updater.status, 'passed'); assert.equal(updater.sourceHead, HEAD); assert.equal(updater.productionTouched, false); assert.equal(updater.publicFeedUploaded, false)
const artifacts = join(ROOT, 'artifacts', `private-updater-target-arm64-${HEAD}`)
const entries = readdirSync(artifacts).filter(name => name.endsWith('.zip')); assert.equal(entries.length, 1)
const sha = bytes => createHash('sha256').update(bytes).digest('hex'), zip = join(artifacts, entries[0])
assert.equal(sha(readFileSync(zip)), updater.targetZipSha256)
const applications = join(ROOT, 'Applications'); assert(!existsSync(applications), 'Never overwrite an installed candidate')
mkdirSync(applications, { mode: 0o700 })
const checks = [], resources = [], expected = [], omitted = []
function command(cmd, args, required = true) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000 })
  checks.push({ command: cmd, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message })
  if (required) assert.equal(result.status, 0, `${cmd}: ${result.stderr}`)
  return result
}
let outcome = 'failed', app, executable, failure, metadata
try {
  command('/usr/bin/ditto', ['-x', '-k', zip, applications])
  const apps = readdirSync(applications).filter(name => name.endsWith('.app')); assert.equal(apps.length, 1)
  app = join(applications, apps[0]); const resourceRoot = join(app, 'Contents/Resources'), asar = join(resourceRoot, 'app.asar')
  assert.equal(sha(readFileSync(asar)), updater.targetAsarSha256)
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  command('/usr/bin/xcrun', ['stapler', 'validate', app])
  const gatekeeper = command('/usr/sbin/spctl', ['--status'], false)
  command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], /assessments enabled/.test(gatekeeper.stdout + gatekeeper.stderr))
  const plist = key => command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')]).stdout.trim()
  assert.equal(plist('CFBundleShortVersionString'), '0.5.0'); assert.equal(plist('CFBundleIdentifier'), updater.bundleId)
  executable = join(app, 'Contents/MacOS', plist('CFBundleExecutable'))
  const { listPackage, extractFile } = await import(pathToFileURL(join(REPO, 'node_modules/@electron/asar/lib/asar.js')).href)
  metadata = JSON.parse(extractFile(asar, 'package.json').toString('utf8'))
  assert.equal(metadata.version, '0.5.0'); assert.equal(metadata.buildProvenance?.sourceHead, HEAD)
  for (const path of listPackage(asar).filter(path => /workwise[^/]*\.(png|svg|ico|icns)$/.test(path))) {
    const bytes = extractFile(asar, path.slice(1))
    resources.push({ path: `app.asar${path}`, sizeBytes: bytes.length, sha256: sha(bytes) })
  }
  const icns = readFileSync(join(resourceRoot, 'icon.icns')); resources.push({ path: 'Contents/Resources/icon.icns', sizeBytes: icns.length, sha256: sha(icns) })
  const required = ['workwise.png', 'workwise-light.png', 'workwise-dark.png', 'workwise_dock.png', 'workwise_dock_dark.png', 'workwise_tray.png', 'workwise.icns']
  for (const name of [...required, 'workwise.ico', 'workwise.svg', 'railwise-icon-source.png']) {
    const path = `src/asset/img/${name}`, bytes = execFileSync('git', ['show', `${HEAD}:${path}`], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 })
    const digest = sha(bytes), matches = resources.filter(r => r.sha256 === digest).map(r => r.path)
    const entry = { repositoryRevision: HEAD, repositoryPath: path, sha256: digest, sizeBytes: bytes.length, packageMatches: matches }
    expected.push(entry)
    if (required.includes(name)) assert(matches.length > 0, `Required final icon differs or missing: ${name}`)
    else if (!matches.length) omitted.push({ repositoryPath: path, reason: name.endsWith('.ico') ? 'Windows resource; not used by this macOS package' : 'Build source; no byte-identical runtime asset required' })
  }
  const mainText = listPackage(asar).filter(path => path.startsWith('/out/main/') && path.endsWith('.js')).map(path => extractFile(asar, path.slice(1)).toString('utf8')).join('\n')
  for (const name of ['workwise_dock-', 'workwise_dock_dark-', 'workwise-light-']) assert(mainText.includes(name), `Compiled main/splash icon reference missing: ${name}`)
  outcome = 'passed'
} catch (error) { failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  const report = { schemaVersion: 1, outcome, sourceHead: HEAD, app, executable, packageVersion: metadata?.version, packageSourceHead: metadata?.buildProvenance?.sourceHead,
    targetZipSha256: updater.targetZipSha256, asarSha256: updater.targetAsarSha256, checks, packagedResources: resources, expectedRepositoryAssets: expected, omittedAssets: omitted, failure,
    guiStarted: false, userInterfaceAcceptance: false, themeSwitchingAcceptance: false, iconArtworkSource: 'user-provided image, final crop-fix revision', olderCandidateTouched: false, publicReleaseApproval: false, checkedAt: new Date().toISOString() }
  writeFileSync(join(ROOT, 'installation-icon-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ outcome, app, executable, matchedExpectedAssets: expected.filter(e => e.packageMatches.length).length, failure: failure?.message }, null, 2))
}
