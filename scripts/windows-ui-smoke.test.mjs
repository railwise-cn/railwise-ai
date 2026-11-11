import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { validateWindowsUiReport, windowsUiEnvironment } from './run-windows-ui-smoke.mjs'

const identity = { version: '0.5.6', sourceHead: 'a'.repeat(40) }
function report() {
  // Validator fixtures do not supply actual Windows UI acceptance evidence.
  return {
    schemaVersion: 1, scope: 'private-exact-package-chinese-ui', platform: 'win32', ...identity,
    locale: 'zh', theme: 'dark', productionTouched: false, packageUnchanged: true, cleanExit: true,
    errors: [], tabs: ['技能', '插件', '连接器'], chapters: Array.from({ length: 13 }, (_, index) => index + 1),
    update: { ok: true, hasUpdate: false }, helpOffline: true,
    checks: ['installed-chinese-renderer', 'skills-default-and-tab-order', 'plugins-tab',
      'connectors-tab', 'no-update-control-hidden', 'offline-help-thirteen-chapters',
      'offline-help-search-and-navigation', 'offline-help-images', 'personal-homepage-absent']
  }
}

test('isolated ordinary package environment keeps public identity and removes account and updater overrides', () => {
  const root = join('owned-runner-temp', 'ui')
  const result = windowsUiEnvironment({ PATH: 'system', SYSTEMROOT: 'windows', DEEPSEEK_API_KEY: 'secret', GH_TOKEN: 'secret',
    WORKWISE_CANDIDATE: '1', WORKWISE_UPDATE_PROVIDER: 'none', RELEASE_CHANNEL: 'frontier', NODE_OPTIONS: '--require arbitrary' }, root)
  assert.equal(result.PATH, 'system')
  assert.equal(result.SYSTEMROOT, 'windows')
  assert.equal(result.USERPROFILE, join(root, 'home'))
  assert.equal(result.APPDATA, join(root, 'home', 'AppData', 'Roaming'))
  assert.equal(result.WORKWISE_TOOLS_ROOT, join(root, 'home', '.workwise', 'tools'))
  for (const key of ['DEEPSEEK_API_KEY', 'GH_TOKEN', 'WORKWISE_CANDIDATE', 'WORKWISE_UPDATE_PROVIDER', 'RELEASE_CHANNEL', 'NODE_OPTIONS']) assert.equal(result[key], undefined)
})

test('Windows Chinese UI evidence requires every actual production surface observation', () => {
  assert.equal(validateWindowsUiReport(report(), identity), true)
  for (const check of report().checks) {
    const missing = report()
    missing.checks = missing.checks.filter(value => value !== check)
    assert.throws(() => validateWindowsUiReport(missing, identity), /Missing actual UI observation/)
  }
})

for (const [label, mutate] of [
  ['wrong package source', value => { value.sourceHead = 'b'.repeat(40) }],
  ['changed package', value => { value.packageUnchanged = false }],
  ['forced cleanup', value => { value.cleanExit = false }],
  ['wrong locale', value => { value.locale = 'en' }],
  ['old tab order', value => { value.tabs = ['连接器', '技能', '插件'] }],
  ['incomplete manual', value => { value.chapters.pop() }],
  ['network-only help', value => { value.helpOffline = false }],
  ['failed update metadata', value => { value.update.ok = false }],
  ['available update', value => { value.update.hasUpdate = true }],
  ['recorded error', value => { value.errors.push('renderer crashed') }]
]) {
  test(`Windows UI evidence rejects ${label}`, () => {
    const invalid = report()
    mutate(invalid)
    assert.throws(() => validateWindowsUiReport(invalid, identity))
  })
}

test('Chinese UI uses the same installed EXE before owned uninstall, with unchanged ordinary app configuration', () => {
  const installer = readFileSync(new URL('./run-windows-install-smoke.ps1', import.meta.url), 'utf8')
  const ui = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  assert.match(installer, /node \$uiScript \$executable \$Version \$SourceHead \$EvidenceDir/)
  assert.ok(installer.indexOf('node $uiScript') < installer.indexOf('Invoke-OwnedProcess $uninstaller'))
  assert.match(ui, /spawn\(executable, \[`--user-data-dir=/)
  assert.match(ui, /inspectInstalledPackage\(dirname\(executable\), identity\)/)
  assert.match(ui, /Network\.emulateNetworkConditions/)
  assert.match(ui, /Input\.dispatchMouseEvent/)
  assert.doesNotMatch(ui, /window\.workwise\s*=|innerHTML\s*=|mock\w*\(/)
})
