import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { assertPublishedWindowsUpgrade, legacyUpdaterReason, repairedScheduleSeed, sidebarUpgradeControlSelector, sidebarUpgradeSelector, verifyPublishedWindowsManifest } from './run-windows-published-gui-update-smoke.mjs'
import { verifyFrozenWindowsReadback, verifyInstalledIsolatedWindowsFeed, verifyIsolatedWindowsTarget } from './run-windows-frozen-gui-upgrade.mjs'

const manifestDigest = 'uMwIBK7dFby0e3J6Ln6ZOA31iFMUjW1zy6kRtKx95+PxPO0Vr2wECHvSBuE5CUtMQtlH5mIf6oY+Ras2FBv0tA=='
const installer = { url: 'RailWise-AI-0.5.7-win-x64.exe', size: 317686658, sha512: manifestDigest }
const manifest = { version: '0.5.7', path: installer.url, sha512: manifestDigest, files: [installer] }

test('the sidebar locator matches the actual English and Chinese updater button titles', async () => {
  for (const locale of ['en', 'zh']) {
    const strings = JSON.parse(await readFile(new URL(`../src/renderer/src/locales/${locale}/settings.json`, import.meta.url), 'utf8'))
    const title = strings.guiUpdateUpgradeTitle.replace('{{version}}', '0.5.7')
    const prefixes = [...sidebarUpgradeControlSelector.matchAll(/\[title\^="([^"]+)"\]/g)].map(match => match[1])
    assert.ok(prefixes.some(prefix => title.startsWith(prefix)), `No selector matched the ${locale} title ${title}`)
    assert.ok(prefixes.every(prefix => !title.replace('0.5.7', '0.5.70').startsWith(prefix)))
  }
})

test('live feed preflight binds the complete reviewed Windows installer', () => {
  assert.equal(verifyPublishedWindowsManifest(manifest).reviewedSha256, '113a88a8601b04a49233267dc8321c17063a949fecce9fa5ad3e6ff37ed66dd7')
  assert.throws(() => verifyPublishedWindowsManifest({ ...manifest, version: '0.5.8' }))
  assert.throws(() => verifyPublishedWindowsManifest({ ...manifest, files: [{ ...installer, size: 1 }] }))
  assert.throws(() => verifyPublishedWindowsManifest({ ...manifest, files: [installer, installer] }))
})

test('the live 0.5.7 route is pinned to the exact reviewed 0.5.9 installer and rejects edge overrides', () => {
  const scenario = 'released-057-to-059'
  const sha512 = 'MuU84Ysjr5iFad2JGhtHWWxVYU095Fkioid7kpddVr5csS9Z9QklrY9P5/MSJgk1qLc9kgY+HQGdcBRP0ia1DQ=='
  const targetInstaller = { url: 'RailWise-AI-0.5.9-win-x64.exe', size: 320871735, sha512 }
  const targetManifest = { version: '0.5.9', path: targetInstaller.url, sha512, files: [targetInstaller] }
  assert.equal(verifyPublishedWindowsManifest(targetManifest, scenario).reviewedSha256,
    '7bc3fca6f7157e4f556a582e0133c69e2318390ced15ad2a1ce87160b153c55c')
  assert.throws(() => verifyPublishedWindowsManifest(manifest, scenario))
  assert.throws(() => verifyPublishedWindowsManifest(targetManifest, 'unreviewed'))
  assert.match(sidebarUpgradeSelector(scenario), /升级到 0\.5\.9，/)
  const installLocation = '/runner/live-upgrade'
  const executable = installLocation + '/RailWise AI.exe'
  const report = {
    scenario, scope: 'published-windows-gui-upgrade', directTargetInstallerLaunches: 0, applicationUpdaterOverrides: 0,
    officialFeed: 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/',
    baseline: {
      package: { version: '0.5.7', sourceHead: '52779c7b0cf46452a05ccf80a413f0b5d046a7b3' },
      installer: { sha256: '113a88a8601b04a49233267dc8321c17063a949fecce9fa5ad3e6ff37ed66dd7' },
      packagedFeed: 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/',
      runtime: { authenticatedRead: true, pid: 200 },
      executable, pid: 100, registry: { installLocation }
    },
    offer: { status: 'available', hasUpdate: true },
    action: { method: 'trusted-pointer-on-sidebar', manualOnly: false, latestVersion: '0.5.9' },
    target: {
      package: { version: '0.5.9', sourceHead: '389ee737a62cf4b889d5cb1958402e84911c5725',
        asarSha256: 'a90bca9b4fb10a43e1ae23b4a5a43d343656138e8ab9969256b9e2c08fca9d58' },
      registry: { installLocation, displayVersion: '0.5.9' },
      window: { pid: 101, handle: 42, title: 'RailWise AI', path: executable }
    },
    profile: { sentinelPreserved: true }
  }
  assert.doesNotThrow(() => assertPublishedWindowsUpgrade(report))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, directTargetInstallerLaunches: 1 }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, applicationUpdaterOverrides: 1 }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, baseline: { ...report.baseline, packagedFeed: 'https://127.0.0.1/' } }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, baseline: { ...report.baseline, runtime: undefined } }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, baseline: { ...report.baseline, package: { ...report.baseline.package, version: '0.5.8' } } }))
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
  const report = { scope: 'published-windows-gui-upgrade', baseline,
    offer: { status: 'available', hasUpdate: true }, action, target, profile: { sentinelPreserved: true } }
  assert.doesNotThrow(() => assertPublishedWindowsUpgrade(report))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, offer: undefined }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, target: undefined }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, action: { ...action, manualOnly: true } }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, target: { ...target, window: { ...window, pid: baseline.pid } } }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...report, target: { ...target, window: { ...window, path: '/other/RailWise AI.exe' } } }))

  const sourceHead = 'a'.repeat(40)
  const seededAt = '2026-11-18T02:00:00.000Z'
  const seededRecord = repairedScheduleSeed(Date.parse(seededAt))
  assert.deepEqual(seededRecord, { appVersion: '0.5.6', lastCheckedAt: '2026-11-18T01:00:00.000Z' })
  const repaired = { ...report, scope: 'private-repaired-windows-gui-upgrade',
    provenance: { driverSourceHead: sourceHead },
    baseline: { ...baseline, installer: { sha256: 'b'.repeat(64) }, package: { ...baseline.package, sourceHead } },
    schedule: { seededAt, seededRecord, automaticRecord: { appVersion: '0.5.6', lastCheckedAt: '2026-11-18T02:00:05.000Z' } } }
  assert.doesNotThrow(() => assertPublishedWindowsUpgrade(repaired))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...repaired, schedule: { ...repaired.schedule, automaticRecord: seededRecord } }))
  assert.throws(() => assertPublishedWindowsUpgrade({ ...repaired, baseline }))
})

test('the legacy diagnostic records the known shutdown fault without disclosing arbitrary internal messages', () => {
  assert.equal(legacyUpdaterReason('Runtime 未正常退出，更新已停止。请检查日志后重试。'), 'runtime-not-cleanly-exited')
  assert.equal(legacyUpdaterReason('The update has not finished downloading yet.'), undefined)
})

test('published Windows smoke is a separate opt-in job with read-only GitHub permissions', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/windows-install-smoke.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.run_published_gui_update.default, false)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.published_gui_upgrade_scenario.options,
    ['released-056-to-057', 'released-057-to-059'])
  assert.equal(workflow.on.workflow_dispatch.inputs.published_gui_upgrade_scenario.default, 'released-056-to-057')
  assert.equal(workflow.on.workflow_dispatch.inputs.published_gui_verify_overlay.default, false)
  assert.equal(workflow.on.workflow_call.inputs.package_run_id.required, true)
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
  assert.match(workflow.jobs['windows-install'].if, /run_published_gui_update != true/)
  const job = workflow.jobs['windows-published-gui-update']
  assert.match(job.if, /run_published_gui_update == true/)
  assert.equal(job['runs-on'], 'windows-2022')
  assert.ok(job.steps.some(step => step.if?.includes('package_run_id') && step.run.startsWith('throw ')))
  assert.match(job.steps.find(step => step.run === 'node scripts/run-windows-published-gui-update-smoke.mjs').env.PUBLISHED_GUI_UPGRADE_SCENARIO,
    /inputs\.published_gui_upgrade_scenario/)
  assert.match(job.steps.find(step => step.run === 'node scripts/run-windows-published-gui-update-smoke.mjs').env.PUBLISHED_GUI_VERIFY_OVERLAY,
    /inputs\.published_gui_verify_overlay/)
  assert.ok(job.steps.some(step => step.if === 'always()' && step.uses.startsWith('actions/upload-artifact@')))

  assert.equal(workflow.on.workflow_dispatch.inputs.run_repaired_gui_update.default, false)
  assert.match(job.steps.find(step => step.name === 'Reject mixed acceptance modes').if, /run_repaired_gui_update/)
  const repaired = workflow.jobs['windows-repaired-gui-update']
  assert.match(repaired.if, /run_repaired_gui_update == true \|\| inputs.run_repaired_marketplace_install == true/)
  assert.match(repaired.if, /inputs.run_published_gui_update != true/)
  assert.equal(workflow.on.workflow_dispatch.inputs.run_repaired_marketplace_install.default, false)
  assert.ok(repaired.steps.some(step => step.if === 'inputs.run_repaired_marketplace_install' &&
    step.run === 'node scripts/run-windows-published-gui-update-smoke.mjs --repaired-marketplace'))
  assert.equal(repaired.steps.find(step => step.uses === 'actions/checkout@v7').with['fetch-depth'], 0)
  const build = repaired.steps.find(step => step.run === 'npm run dist:win')
  assert.equal(build.env.WORKWISE_APP_VERSION, '0.5.6')
  assert.equal(build.env.WORKWISE_UPDATE_CHANNEL, 'stable')
  assert.equal(build.env.WORKWISE_CANDIDATE_SOURCE_HEAD, '${{ github.sha }}')
  assert.match(build.env.WORKWISE_DIST_DIR, /runner\.temp/)
  assert.ok(repaired.steps.some(step => step.run === 'node scripts/run-windows-published-gui-update-smoke.mjs --repaired-baseline'))
  assert.ok(repaired.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
    .every(step => step.with.path.includes('gui-upgrade-evidence') && !step.with.path.includes('repaired-updater-baseline')))
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(packageJson.scripts['dist:win'], /^npm run dist -- --win nsis --x64$/)
  assert.match(packageJson.scripts.dist, /--publish never/)
})

test('frozen Windows acceptance preserves native package identity and the local KUN conversation', () => {
  const sourceHead = '1'.repeat(40)
  const sha256 = 'a'.repeat(64)
  const target = { identity: { version: '0.5.8', sourceHead }, installer: { sha256 } }
  const result = { expectedVersion: '0.5.8', expectedSource: sourceHead, installerSha256: sha256,
    registry: { displayVersion: '0.5.8' }, packageMetadata: { version: '0.5.8', sourceHead, asarSha256: 'b'.repeat(64) },
    profilePreserved: true, threadPreserved: true }
  assert.doesNotThrow(() => verifyFrozenWindowsReadback(result, target))
  assert.throws(() => verifyFrozenWindowsReadback({ ...result, threadPreserved: false }, target))
  assert.throws(() => verifyFrozenWindowsReadback({ ...result, registry: { displayVersion: '0.5.7' } }, target))
  assert.throws(() => verifyFrozenWindowsReadback({ ...result, installerSha256: '0'.repeat(64) }, target))
})

test('official 0.5.9 can test a checksummed isolated 0.5.10 without a public build receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-isolated-upgrade-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'download')
  await mkdir(directory)
  const version = '0.5.10'
  const name = `RailWise-AI-${version}-win-x64.exe`
  const payload = Buffer.from('a synthetic fixture for installer hash validation')
  const sha512 = createHash('sha512').update(payload).digest('base64')
  const metadata = { version, path: name, sha512, files: [{ url: name, size: payload.length, sha512 }] }
  const file = join(directory, name)
  const metadataFile = join(directory, 'latest.yml')
  const writeManifest = data => writeFile(metadataFile, JSON.stringify(data))
  await writeFile(file, payload)
  await writeFile(`${file}.blockmap`, 'owned blockmap')
  await writeManifest(metadata)
  const source = { repository: 'railwise-cn/railwise-ai', packageSourceHead: 'a'.repeat(40), driverSourceHead: 'b'.repeat(40),
    workflow: '.github/workflows/release.yml', windowsBuildConclusion: 'success', runId: 8123, runAttempt: 1,
    artifactId: 927, artifactName: 'release-win', artifactDigest: `sha256:${'c'.repeat(64)}`, artifactExpired: false,
    changedFiles: ['scripts/run-windows-frozen-gui-upgrade.mjs'] }
  const opts = { baselineVersion: '0.5.9', environment: { GITHUB_REPOSITORY: source.repository, GITHUB_SHA: source.driverSourceHead, RUNNER_TEMP: root } }

  const target = await verifyIsolatedWindowsTarget(directory, source, version, opts)
  assert.deepEqual(target.manifest, Buffer.from(JSON.stringify(metadata)))
  assert.equal(target.identity.sourceHead, source.packageSourceHead)
  assert.equal(target.isolated.scope, 'isolated-candidate-acceptance')
  assert.equal(target.isolated.releaseApproval, false)
  assert.equal(target.isolated.installerSha512, sha512)
  await assert.rejects(verifyIsolatedWindowsTarget(directory, source, version, { ...opts, baselineVersion: '0.5.8' }), /only accepted after official 0.5.9/)
  await assert.rejects(verifyIsolatedWindowsTarget(directory, source, '0.5.11', opts), /exact 0.5.10/)
  await assert.rejects(verifyIsolatedWindowsTarget(directory, { ...source, repository: 'other-orig/railwise-ai' }, version, opts))
  await assert.rejects(verifyIsolatedWindowsTarget(directory, { ...source, artifactDigest: 'unverified' }, version, opts))
  await assert.rejects(verifyIsolatedWindowsTarget(directory, { ...source, changedFiles: ['electron-builder.cjs'] }, version, opts), /build source changed/)
  await assert.rejects(verifyIsolatedWindowsTarget(directory, { ...source, driverSourceHead: 'd'.repeat(40) }, version, opts))
  await writeManifest({ ...metadata, sha512: 'b'.repeat(86) + '==' })
  await assert.rejects(verifyIsolatedWindowsTarget(directory, source, version, opts), /manifest header/)
  await writeManifest(metadata)
  await writeFile(file, Buffer.alloc(payload.length, 97))
  await assert.rejects(verifyIsolatedWindowsTarget(directory, source, version, opts), /Windows update SHA-512/)
})

test('only the exact isolated feed can pass installed target readback', () => {
  assert.deepEqual(verifyInstalledIsolatedWindowsFeed('provider: generic\nurl: https://127.0.0.1/\n'),
    { provider: 'generic', url: 'https://127.0.0.1/' })
  assert.throws(() => verifyInstalledIsolatedWindowsFeed('provider: generic\nurl: https://www.railwise.cn/\n'))
  assert.throws(() => verifyInstalledIsolatedWindowsFeed('provider: github\nurl: https://127.0.0.1/\n'))
})

test('frozen Windows acceptance pins the original artifact and builds the next installer inside its runner', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/windows-install-smoke.yml', import.meta.url), 'utf8'))
  const job = workflow.jobs['windows-frozen-gui-update']
  assert.match(job.if, /inputs.run_frozen_gui_update == true/)
  assert.ok(job.steps.some(step => step.with?.['artifact-ids'] === '${{ steps.frozen.outputs.artifact_id }}'))
  assert.ok(job.steps.some(step => step.run === 'npm run dist:win' && step.env?.WORKWISE_APP_VERSION === '0.5.9'))
  assert.ok(job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@')).every(step => step.with.path.includes('frozen-windows-evidence/')))
})
