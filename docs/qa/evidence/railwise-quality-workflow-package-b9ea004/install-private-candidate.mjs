import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.WORKWISE_CANDIDATE_ROOT ?? '/private/tmp/workwise-candidate'
const head = 'b9ea004b668d68b34a7d82ece6674ef2273a9bc3'
const report = JSON.parse(readFileSync(join(root, 'updater-evidence', 'private-updater.json'), 'utf8'))
assert.equal(report.status, 'passed'); assert.equal(report.sourceHead, head); assert.equal(report.targetVersion, '0.5.0')
assert.equal(report.productionTouched, false); assert.equal(report.publicFeedUploaded, false)
const artifact = join(root, 'artifacts', `private-updater-target-arm64-${head}`)
const zips = readdirSync(artifact).filter(name => name.endsWith('.zip'))
assert.equal(zips.length, 1)
const zip = join(artifact, zips[0]), sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
assert.equal(sha(zip), report.targetZipSha256)
const applications = join(root, 'Applications')
assert(!existsSync(applications), 'Never overwrite an existing installed candidate')
mkdirSync(applications, { mode: 0o700 })
const checks = []
function run(command, args, required = true) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000 })
  checks.push({ command, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message })
  if (required) assert.equal(result.status, 0, `${command}: ${result.stderr}`)
  return result
}
let outcome = 'failed', app, failure
try {
  run('/usr/bin/ditto', ['-x', '-k', zip, applications])
  const apps = readdirSync(applications).filter(name => name.endsWith('.app')); assert.equal(apps.length, 1)
  app = join(applications, apps[0])
  assert.equal(sha(join(app, 'Contents/Resources/app.asar')), report.targetAsarSha256)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  run('/usr/bin/xcrun', ['stapler', 'validate', app])
  const gatekeeper = run('/usr/sbin/spctl', ['--status'], false)
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], /assessments enabled/.test(gatekeeper.stdout + gatekeeper.stderr))
  const version = run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]).stdout.trim()
  const bundleId = run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]).stdout.trim()
  assert.equal(version, '0.5.0'); assert.equal(bundleId, report.bundleId)
  outcome = 'passed'
} catch (error) { failure = error.message; process.exitCode = 1 }
finally {
  const value = { schemaVersion: 1, outcome, sourceHead: head, app, targetZipSha256: report.targetZipSha256, asarSha256: report.targetAsarSha256, checks, failure,
    newUserProvidedIconIncluded: false, guiStarted: false, scope: 'isolated private candidate installation, not release approval', checkedAt: new Date().toISOString() }
  writeFileSync(join(root, 'installation-report.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(value, null, 2))
}
