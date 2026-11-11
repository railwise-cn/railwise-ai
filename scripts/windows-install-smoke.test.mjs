import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import test from 'node:test'
import { inspectInstalledPackage, inspectInstaller, installIdentity, nsisGuid, validateInstallReport } from './verify-windows-install-smoke.mjs'

const require = createRequire(import.meta.url)
const version = '0.5.5'
const sourceHead = 'a'.repeat(40)
const identity = installIdentity(version, sourceHead)

function evidence() {
  // Synthetic observations exercise the validator only. Real installer and
  // uninstall evidence is collected on the Windows runner, never from fixtures.
  const directory = 'D:\\a\\_temp\\railwise-install-synthetic\\RailWise AI'
  const executable = win32.join(directory, identity.executableName)
  const uninstaller = win32.join(directory, identity.uninstallerName)
  const versionInfo = { productName: identity.productName, productVersion: version, fileVersion: `${version}.0` }
  const authenticode = { status: 'NotSigned', signerThumbprint: null }
  return {
    schemaVersion: 1, status: 'failed', scope: 'private-exact-package-install', platform: 'win32', arch: 'x64', version, sourceHead,
    productionTouched: false, errors: [],
    runner: { environment: 'github-hosted', os: 'Windows', tempRoot: 'D:\\a\\_temp' },
    provenance: { sourceHead, runId: '12345', runAttempt: '1' },
    cleanScope: { registryAbsent: true, shortcutsAbsent: true, targetAbsent: true },
    install: { exitCode: 0 },
    installer: { name: identity.installerName, sha256: 'b'.repeat(64), size: 123, versionInfo: { ...versionInfo }, authenticode: { ...authenticode } },
    target: { directory, executable, uninstaller, versionInfo: { ...versionInfo }, authenticode: { ...authenticode },
      package: { name: identity.packageName, productName: identity.productName, version, sourceHead, asarSha256: 'c'.repeat(64), asarSize: 456 } },
    registry: {
      install: { hive: 'CurrentUser', view: 'Registry64', key: identity.installRegistryKey, values: { InstallLocation: directory, ShortcutName: identity.productName } },
      uninstall: { hive: 'CurrentUser', view: 'Registry64', key: identity.uninstallRegistryKey, values: { DisplayName: identity.productName, DisplayVersion: version, UninstallString: `"${uninstaller}" /currentuser` } },
    },
    shortcuts: ['desktop', 'start-menu'].map(kind => ({ kind, scope: 'current-user', path: `C:\\Users\\runner\\${kind}\\${identity.shortcutName}`, name: identity.shortcutName, target: executable })),
    cleanup: { attempted: true, ownedInstanceVerified: true, registryAbsent: true, shortcutsAbsent: true, appExecutableAbsent: true, exitCode: 0 },
    profileSentinels: [identity.productName, identity.packageName].map(name => ({ path: `C:\\Users\\runner\\AppData\\Roaming\\${name}\\synthetic.txt`, beforeSha256: 'd'.repeat(64), afterSha256: 'd'.repeat(64) })),
  }
}

test('Windows installation identity preserves the electron-builder NSIS GUID and new brand', () => {
  assert.equal(nsisGuid(), '0daef81e-c00a-5e19-aa76-e6b9a68e0938')
  assert.notEqual(nsisGuid('different.app.id'), identity.guid)
  assert.equal(identity.installerName, 'RailWise-AI-0.5.5-win-x64.exe')
  assert.equal(identity.uninstallerName, 'Uninstall RailWise AI.exe')
  assert.throws(() => installIdentity('0.5.5-Candidate', sourceHead), /stable package version/)
  assert.throws(() => installIdentity(version, 'main'), /exact source HEAD/)
})

test('Windows installer preflight binds actual bytes to the same-build update metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'railwise-win-smoke-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, identity.installerName)
  const bytes = Buffer.from('synthetic installer fixture; not an EXE')
  writeFileSync(path, bytes)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const metadata = `version: ${version}\nfiles:\n  - url: ${identity.installerName}\n    size: ${bytes.length}\n    sha512: ${sha512}\n`
  writeFileSync(join(root, 'latest.yml'), metadata)
  assert.equal(inspectInstaller(path, identity).sha256, createHash('sha256').update(bytes).digest('hex'))
  writeFileSync(path, 'changed after metadata generation')
  assert.throws(() => inspectInstaller(path, identity), /Windows update (size|SHA-512)/)
  writeFileSync(path, bytes)
  writeFileSync(join(root, 'latest.yml'), metadata.replace(version, '0.5.4'))
  assert.throws(() => inspectInstaller(path, identity), /Windows update version/)
})

test('installed ASAR inspection reads real archive metadata and rejects the wrong source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'railwise-win-asar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input = join(root, 'input')
  const directory = join(root, 'installed')
  mkdirSync(input)
  mkdirSync(join(directory, 'resources'), { recursive: true })
  writeFileSync(join(input, 'package.json'), JSON.stringify({ name: identity.packageName, productName: identity.productName, version, buildProvenance: { sourceHead } }))
  await require('@electron/asar').createPackage(input, join(directory, 'resources', 'app.asar'))
  const metadata = inspectInstalledPackage(directory, identity)
  assert.equal(metadata.sourceHead, sourceHead)
  assert.match(metadata.asarSha256, /^[a-f0-9]{64}$/)
  assert.throws(() => inspectInstalledPackage(directory, { ...identity, sourceHead: 'e'.repeat(40) }), /installed package sourceHead/)
  assert.throws(() => inspectInstalledPackage(directory, { ...identity, productName: 'WorkWise' }), /installed package productName/)
})

test('Windows smoke reports unsigned status honestly and requires full observed installation and cleanup', () => {
  const report = evidence()
  assert.equal(validateInstallReport(report, identity).windowsSigning, 'not-configured')
  report.installer.authenticode = report.target.authenticode = { status: 'Valid', signerThumbprint: 'AABBCC' }
  assert.equal(validateInstallReport(report, identity).windowsSigning, 'verified')
})

test('Windows installation report distinguishes an existing package from its later verification driver', () => {
  const report = evidence()
  const driverSourceHead = 'e'.repeat(40)
  report.provenance = { sourceHead: driverSourceHead, packageSourceHead: sourceHead, driverSourceHead, runId: '7890', runAttempt: '1',
    packageBuild: { repository: 'railwise-cn/railwise-ai', runId: '1234', runAttempt: 1,
      workflow: '.github/workflows/release.yml', packageSourceHead: sourceHead, driverSourceHead,
      windowsBuildConclusion: 'success', artifactId: 4567, artifactName: 'release-win',
      artifactDigest: `sha256:${'c'.repeat(64)}`, artifactExpired: false,
      changedFiles: ['scripts/run-windows-ui-smoke.mjs'] } }
  assert.equal(validateInstallReport(report, identity).status, 'passed')
  report.provenance.packageBuild.packageSourceHead = driverSourceHead
  assert.throws(() => validateInstallReport(report, identity))
  report.provenance.packageBuild.packageSourceHead = sourceHead
  report.provenance.packageBuild.changedFiles = ['package-lock.json']
  assert.throws(() => validateInstallReport(report, identity))
})

const invalid = [
  ['wrong installer brand', report => { report.installer.name = 'WorkWise-0.5.5-win-x64.exe' }],
  ['wrong installed product', report => { report.target.versionInfo.productName = 'WorkWise' }],
  ['wrong source', report => { report.target.package.sourceHead = 'e'.repeat(40) }],
  ['wrong version', report => { report.target.versionInfo.productVersion = '0.5.4' }],
  ['signature hash mismatch', report => { report.installer.authenticode.status = 'HashMismatch' }],
  ['missing signed identity', report => { report.target.authenticode.status = 'Valid' }],
  ['existing registry identity', report => { report.cleanScope.registryAbsent = false }],
  ['install failure', report => { report.install.exitCode = 1 }],
  ['wrong NSIS identity', report => { report.registry.uninstall.key = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\new-id' }],
  ['old uninstall display', report => { report.registry.uninstall.values.DisplayName = 'WorkWise' }],
  ['uninstall redirects elsewhere', report => { report.registry.uninstall.values.UninstallString = 'C:\\other\\uninstall.exe /S' }],
  ['unexpected target scope', report => { report.target.directory = 'C:\\Program Files\\RailWise AI' }],
  ['shortcut points to old app', report => { report.shortcuts[0].target = 'C:\\old\\WorkWise.exe' }],
  ['missing Start Menu shortcut', report => { report.shortcuts.pop() }],
  ['wrong shortcut filename', report => { report.shortcuts[0].path = 'C:\\Users\\runner\\Desktop\\WorkWise.lnk' }],
  ['unverified cleanup ownership', report => { report.cleanup.ownedInstanceVerified = false }],
  ['cleanup failure', report => { report.cleanup.exitCode = 1 }],
  ['installer still present', report => { report.cleanup.appExecutableAbsent = false }],
  ['registry not removed', report => { report.cleanup.registryAbsent = false }],
  ['profile lost', report => { report.profileSentinels[0].afterSha256 = null }],
  ['wrong workflow commit', report => { report.provenance.sourceHead = 'e'.repeat(40) }],
  ['self-hosted runner', report => { report.runner.environment = 'self-hosted' }],
  ['recorded failure', report => { report.errors.push('inspection failed') }],
  ['public mutation', report => { report.productionTouched = true }],
]
for (const [label, mutate] of invalid) {
  test(`Windows installation evidence rejects ${label}`, () => {
    const report = evidence()
    mutate(report)
    assert.throws(() => validateInstallReport(report, identity))
  })
}

test('Windows smoke script parses with the actual PowerShell parser', { skip: process.platform !== 'win32' }, () => {
  const path = new URL('./run-windows-install-smoke.ps1', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
  const escaped = decodeURIComponent(path).replace(/'/g, "''")
  execFileSync('pwsh', ['-NoProfile', '-Command', `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Format-List; exit 1 }`])
})

test('Windows smoke preserves failure evidence and restricts uninstallation to its generated owned target', () => {
  const script = readFileSync(new URL('./run-windows-install-smoke.ps1', import.meta.url), 'utf8')
  assert.match(script, /installationStarted -and \$ownedInstallation/)
  assert.match(script, /Installation ownership changed before cleanup/)
  assert.match(script, /Invoke-OwnedProcess \$uninstaller '\/S \/currentuser'/)
  assert.doesNotMatch(script, /Invoke-Expression|Remove-Item|Stop-Process|UninstallString\s*\)/)
  assert.match(script, /windows-install-smoke\.json/)
  assert.match(script, /\$report\.status = 'failed'/)
})
