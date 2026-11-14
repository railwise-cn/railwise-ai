import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { parse } from 'yaml'
import { browserSmokeArguments, browserSmokeDependency, chromeSmokeAsset } from './prepare-browser-skill-smoke.mjs'
import { validateWindowsSmokeSource } from './prepare-windows-install-smoke.mjs'

test('browser acceptance pins the official extension bytes and Chrome for Testing distribution', () => {
  assert.equal(browserSmokeDependency.extensionUrl, 'https://github.com/Tencent/BrowserSkill/releases/download/ext-v0.5.0/browser-skill-extension-v0.5.0-chrome.zip')
  assert.equal(browserSmokeDependency.extensionSha256, '4de785b340e401de855448410be3b7bad5e685a9e5128c0bd4ec4edeba5c9fc9')
  assert.equal(chromeSmokeAsset('win32', 'x64').url, 'https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/win64/chrome-win64.zip')
  assert.equal(chromeSmokeAsset('darwin', 'arm64').executable, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
  assert.throws(() => chromeSmokeAsset('linux', 'x64'))
})

test('test browser uses an isolated profile and explicit test extension-loading API', () => {
  const profile = join(tmpdir(), 'owned-browser-smoke-profile')
  const args = browserSmokeArguments(profile)
  assert.ok(args.includes(`--user-data-dir=${profile}`))
  assert.ok(args.includes('--enable-unsafe-extension-debugging'))
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'))
  assert.ok(!args.some(value => value.includes('disable-web-security')))
  assert.throws(() => browserSmokeArguments('relative-profile'))
  const source = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  assert.match(source, /Extensions\.loadUnpacked/)
  assert.match(source, /window\.workwise\.installBrowserSkill\(\)/)
  assert.match(source, /window\.workwise\.configureBrowserSkill/)
  assert.match(source, /fixturePageRead: true, htmlFromBrowserTool: true/)
})

test('connected-browser acceptance remains opt-in and only its exact helper is source-equivalent', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/windows-install-smoke.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.run_browser_execution.default, false)
  assert.deepEqual(workflow.on.workflow_call.inputs, workflow.on.workflow_dispatch.inputs)
  assert.equal(workflow.jobs['windows-install'].steps.find(step => step.env?.RAILWISE_WINDOWS_BROWSER_SMOKE).env.RAILWISE_WINDOWS_BROWSER_SMOKE, '${{ inputs.run_browser_execution }}')
  const source = { repository: 'railwise-cn/railwise-ai', packageSourceHead: 'a'.repeat(40), driverSourceHead: 'b'.repeat(40), workflow: '.github/workflows/release.yml',
    windowsBuildConclusion: 'success', runId: '123', runAttempt: '1', artifactId: '234', artifactName: 'release-win', artifactDigest: 'sha256:' + 'c'.repeat(64), artifactExpired: false,
    changedFiles: ['scripts/prepare-browser-skill-smoke.mjs'] }
  assert.equal(validateWindowsSmokeSource(source), source)
  assert.throws(() => validateWindowsSmokeSource({ ...source, changedFiles: ['src/main/services/managed-browser-skill-service.ts'] }), /build source changed/)
})
