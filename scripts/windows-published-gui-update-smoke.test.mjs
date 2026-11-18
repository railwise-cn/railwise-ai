import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parse } from 'yaml'
import { assertPublishedWindowsUpgrade, verifyPublishedWindowsManifest } from './run-windows-published-gui-update-smoke.mjs'

const manifestDigest = 'uMwIBK7dFby0e3J6Ln6ZOA31iFMUjW1zy6kRtKx95+PxPO0Vr2wECHvSBuE5CUtMQtlH5mIf6oY+Ras2FBv0tA=='
const installer = { url: 'RailWise-AI-0.5.7-win-x64.exe', size: 317686658, sha512: manifestDigest }
const manifest = { version: '0.5.7', path: installer.url, sha512: manifestDigest, files: [installer] }

test('live feed preflight binds the complete reviewed Windows installer', () => {
  assert.equal(verifyPublishedWindowsManifest(manifest).reviewedSha256, '113a88a8601b04a49233267dc8321c17063a949fecce9fa5ad3e6ff37ed66dd7')
  assert.throws(() => verifyPublishedWindowsManifest({ ...manifest, version: '0.5.8' }))
  assert.throws(() => verifyPublishedWindowsManifest({ ...manifest, files: [{ ...installer, size: 1 }] }))
  assert.throws(() => verifyPublishedWindowsManifest({ ...manifest, files: [installer, installer] }))
})

test('a visible offer alone or an unexpected relaunch cannot pass the real updater smoke', () => {
  const installLocation = '/runner/owned-install'
  const executable = installLocation + '/RailWise AI.exe'
  const baseline = {
    package: { version: '0.5.6' },
    installer: { sha256: '978aba9f85290d78fd5f5495f48c630965ba3aedefdddcc495deda9f3948a62f' },
    pid: 100, executable, registry: { installLocation }
  }
  const action = { method: 'trusted-pointer-on-sidebar', manualOnly: false, latestVersion: '0.5.7' }
  const window = { handle: 42, pid: 101, title: 'RailWise AI', path: executable }
  const target = {
    registry: { installLocation, displayVersion: '0.5.7' }, window,
    package: { version: '0.5.7', asarSha256: 'd0b02f0cf4ff19c7891a1722706932d10c33ee77f3b03c53f3fdd3ab3998ce3a' }
  }
  const report = { baseline, offer: { status: 'available', hasUpdate: true }, action, target, profile: { sentinelPreserved: true } }
  assert.doesNotThrow(() => assertPublishedWindowsUpgrade(report))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, offer: undefined }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, target: undefined }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, action: { ...action, manualOnly: true } }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, target: { ...target, window: { ...window, pid: baseline.pid } } }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, target: { ...target, window: { ...window, path: '/other/RailWise AI.exe' } } }))
})

test('published Windows smoke is a separate opt-in job with read-only GitHub permissions', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/windows-install-smoke.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.run_published_gui_update.default, false)
  assert.equal(workflow.on.workflow_call.inputs.package_run_id.required, true)
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
  assert.match(workflow.jobs['windows-install'].if, /run_published_gui_update != true/)
  const job = workflow.jobs['windows-published-gui-update']
  assert.match(job.if, /run_published_gui_update == true/)
  assert.equal(job['runs-on'], 'windows-2022')
  assert.ok(job.steps.some(step => step.if?.includes('package_run_id') && step.run.startsWith('throw ')))
  assert.ok(job.steps.some(step => step.run === 'node scripts/run-windows-published-gui-update-smoke.mjs'))
  assert.ok(job.steps.some(step => step.if === 'always()' && step.uses.startsWith('actions/upload-artifact@')))
})
