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
  assert.deepEqual(workflow.on.workflow_call.inputs.run_browser_execution, workflow.on.workflow_dispatch.inputs.run_browser_execution)
  assert.equal(workflow.jobs['windows-install'].steps.find(step => step.env?.RAILWISE_WINDOWS_BROWSER_SMOKE).env.RAILWISE_WINDOWS_BROWSER_SMOKE, '${{ inputs.run_browser_execution }}')
  const source = { repository: 'railwise-cn/railwise-ai', packageSourceHead: 'a'.repeat(40), driverSourceHead: 'b'.repeat(40), workflow: '.github/workflows/release.yml',
    windowsBuildConclusion: 'success', runId: '123', runAttempt: '1', artifactId: '234', artifactName: 'release-win', artifactDigest: 'sha256:' + 'c'.repeat(64), artifactExpired: false,
    changedFiles: ['scripts/prepare-browser-skill-smoke.mjs'] }
  assert.equal(validateWindowsSmokeSource(source), source)
  assert.throws(() => validateWindowsSmokeSource({ ...source, changedFiles: ['src/main/services/managed-browser-skill-service.ts'] }), /build source changed/)
})

test('startup diagnostic is opt-in and exclusive before package/dependency work', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/windows-install-smoke.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.run_browser_startup_diagnostic.default, false)
  assert.deepEqual(workflow.on.workflow_call.inputs.run_browser_startup_diagnostic, workflow.on.workflow_dispatch.inputs.run_browser_startup_diagnostic)
  const steps = workflow.jobs['windows-install'].steps
  const gate = steps.findIndex(step => step.name === 'Reject mixed diagnostic and business acceptance modes')
  assert.ok(gate >= 0 && gate < steps.findIndex(step => step.uses === 'actions/setup-node@v7'))
  assert.match(steps[gate].if, /run_browser_startup_diagnostic.*run_task_execution.*run_browser_execution/)
  assert.equal(steps.find(step => step.env?.RAILWISE_WINDOWS_BROWSER_STARTUP_DIAGNOSTIC).env.RAILWISE_WINDOWS_BROWSER_STARTUP_DIAGNOSTIC, '${{ inputs.run_browser_startup_diagnostic }}')
})

test('pinned diagnostic CLI extraction rejects tampering and traversal without executing the binary', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const { default: JSZip } = await import('jszip')
  const { extractPinnedBrowserStartupCli, browserStartupDependency } = await import('./prepare-browser-skill-smoke.mjs')
  const root = await mkdtemp(join(tmpdir(), 'startup-cli-extract-')); t.after(() => rm(root, { recursive: true, force: true }))
  const executable = Buffer.from('controlled non-executable fixture'), zip = new JSZip(); zip.file('vendor/bsk.exe', executable)
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const dependency = { version: '0.5.0', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), executableSha256: createHash('sha256').update(executable).digest('hex') }
  const result = await extractPinnedBrowserStartupCli(bytes, join(root, 'valid'), dependency)
  assert.deepEqual(await readFile(result.path), executable)
  await assert.rejects(extractPinnedBrowserStartupCli(bytes, join(root, 'tampered'), { ...dependency, executableSha256: '0'.repeat(64) }))
  const traversal = new JSZip(); traversal.file('../bsk.exe', executable)
  const badBytes = await traversal.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(extractPinnedBrowserStartupCli(badBytes, join(root, 'traversal'), { ...dependency, size: badBytes.length, sha256: createHash('sha256').update(badBytes).digest('hex') }))
  assert.equal(browserStartupDependency.executableSha256, 'd6e2875707ca89cb506fa0bebc881a638d721178974c4b26d8b4bf9070bc03f2')
  assert.match(browserStartupDependency.url, /^https:\/\/github\.com\/Tencent\/BrowserSkill\/releases\/download\/cli-v0\.5\.0\//)
})
