import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { livePptJourney, macCoreJourneys, recordHostedCoreJourneys, windowsCoreJourneys, windowsUpdaterCoreJourney } from './record-core-journeys.mjs'
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'

const sourceHead = 'e'.repeat(40)
const installerSha256 = 'a'.repeat(64)
const installedAsarSha256 = 'b'.repeat(64)
const build = { runId: 123, runAttempt: 2 }
const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: RELEASE_REPOSITORY,
  GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/main`,
  GITHUB_SHA: sourceHead, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }

function ppt(open = 'os-open-accepted') {
  return { status: 'passed', model: 'live-model', input: 'installed-chat-ui', sameThread: true, sameTurn: true,
    source: { url: 'https://www.railwise.cn/', tool: 'web_fetch', bytes: 1024, sha256: 'c'.repeat(64) },
    artifact: { id: 'file-1', nativeEditableText: true, originalChatButtonClicked: true, bytes: 4096, sha256: 'd'.repeat(64) },
    open: { status: open } }
}

function offlineSpreadsheet(startup) {
  return { status: 'passed', platform: 'darwin', arch: startup.arch, version: startup.version,
    sourceHead: startup.source.sourceHead, installerSha256: startup.installer.sha256,
    installedAsarSha256: startup.installed.asarSha256, execution: 'installed-ui', packageUnchanged: true,
    checks: ['new-local-rwsheet', 'formula-calculation-saved', 'undo-restores-prior-cell-value',
      'external-save-conflict-preserves-original-and-saves-copy',
      'utf8-chinese-csv-import-export-preserves-leading-zero-and-decimal',
      'save-reopen-multiple-sheets-through-production-reader',
      'xlsx-read-only-preview-preserves-sheet-names-positions-and-source-bytes'] }
}

test('live PPT receipt requires the original installed GUI conversation and opened native document', () => {
  const file = 'mac-ppt-journey-live.json'
  assert.equal(livePptJourney(ppt(), file, 'os-open-accepted').id, 'website-pptx')
  assert.equal(livePptJourney(ppt('handler-unavailable'), file, 'os-open-accepted'), undefined)
  assert.equal(livePptJourney({ ...ppt(), model: 'controlled-protocol' }, file, 'os-open-accepted'), undefined)
  assert.throws(() => livePptJourney({ ...ppt(), sameTurn: false }, file, 'os-open-accepted'))
  assert.throws(() => {
    const result = ppt()
    result.artifact.nativeEditableText = false
    livePptJourney(result, file, 'os-open-accepted')
  })
})

test('macOS combines final installed startup and independently observed live PPT proof', () => {
  const observations = ['zh-CN', 'en'].map(locale => ({ locale, workbenchOpened: true }))
  const startup = { status: 'passed', version: '0.5.11', arch: 'arm64',
    source: { ...build, sourceHead }, installer: { sha256: installerSha256 },
    installed: { asarSha256: installedAsarSha256 }, observations }
  const live = { status: 'passed', modelMode: 'live', platform: 'darwin', arch: startup.arch, version: startup.version,
    source: startup.source, installer: startup.installer, installedAsarSha256, observation: ppt() }
  const spreadsheet = offlineSpreadsheet(startup)
  assert.deepEqual(macCoreJourneys(startup, live, spreadsheet).journeys.map(item => item.id), ['startup-branding', 'offline-spreadsheet', 'website-pptx'])
  assert.deepEqual(macCoreJourneys(startup, { ...live, status: 'blocked' }, spreadsheet).journeys.map(item => item.id), ['startup-branding', 'offline-spreadsheet'])
  assert.throws(() => macCoreJourneys(startup, { ...live, installedAsarSha256: 'f'.repeat(64) }, spreadsheet))
  assert.throws(() => macCoreJourneys(startup, undefined, { ...spreadsheet, installerSha256: 'f'.repeat(64) }))
  assert.throws(() => macCoreJourneys(startup, undefined, { ...spreadsheet, checks: [] }), /Missing installed spreadsheet check/)
})

test('Windows receipt derives only assertions made against the unchanged installed application', () => {
  const version = '0.5.11'
  const install = { status: 'passed', platform: 'win32', arch: 'x64', productionTouched: false, version, sourceHead,
    verification: { installerSha256, installedAsarSha256 }, installer: { sha256: installerSha256 },
    target: { package: { asarSha256: installedAsarSha256 } },
    provenance: { packageBuild: { ...build, packageSourceHead: sourceHead } },
    ui: { status: 'passed', sourceHead, version, installedAsarSha256, packageUnchanged: true,
      checks: ['installed-chat-web-ppt', 'real-browser-skill-html-and-schedule'], webPpt: ppt('desktop-open-request-accepted') } }
  assert.deepEqual(windowsCoreJourneys(install).journeys.map(item => item.id), ['website-pptx'])
  install.ui.webPpt.model = 'controlled-protocol'
  assert.deepEqual(windowsCoreJourneys(install).journeys, [])
})

test('Windows receipt derives task, schedule, composer, responsive, marketplace and video journeys from exact UI assertions', () => {
  const version = '0.5.11'
  const install = { status: 'passed', platform: 'win32', arch: 'x64', productionTouched: false, version, sourceHead,
    verification: { installerSha256, installedAsarSha256 }, installer: { sha256: installerSha256 },
    target: { package: { asarSha256: installedAsarSha256 } },
    provenance: { packageBuild: { ...build, packageSourceHead: sourceHead } },
    ui: { status: 'passed', sourceHead, version, installedAsarSha256, packageUnchanged: true,
      checks: ['runtime-task-html-and-daily-schedule', 'composer-files-skills-and-plugin',
        'native-window-composer-menus-and-narrow-navigation', 'cold-mirror-installs-playwright-docling-and-skill-selection'],
      taskExecution: { status: 'completed', taskId: 'task-1', artifact: { format: 'html', validation: 'valid', byteHashMatches: true },
        preview: { automatic: true, contentVerified: true, manualEntryVerified: true },
        dueOccurrence: { clock: 'real', status: 'completed', resultInOriginChat: true, durableOriginReceipt: true,
          noRepeatedUserRequest: true, byteHashMatches: true } },
      composerAcceptance: { status: 'passed', skillRead: true, pluginRead: true, scanSent: true, chineseTextSent: true,
        nativeClipboard: true, chooser: true, drop: true, scanBytes: 40 * 1024 * 1024,
        attachmentLayout: { preservedDraft: true } },
      adaptiveWorkbench: { status: 'passed' },
      marketplace: { status: 'passed', playwright: { navigated: true, observed: 1 }, docling: { toolsDiscovered: 1 },
        installed: [{ id: 'superpowers', installedViaUi: true }, { id: 'blender-skills', installedViaUi: true }] }
    } }
  assert.deepEqual(windowsCoreJourneys(install).journeys.map(item => item.id).sort(), [
    'composer-capabilities', 'conversation-task', 'daily-schedule', 'marketplace-mirror', 'pdf-attachments', 'responsive-layout'
  ])
  install.ui.composerAcceptance.scanBytes = 39 * 1024 * 1024
  assert.throws(() => windowsCoreJourneys(install), /scanBytes/)

  const videoInstall = { ...install, ui: { ...install.ui, checks: ['installed-video-skill-protocol-render-registered-and-decoded'],
    marketplace: { scope: 'video-shotcraft', videoShotcraft: { render: {
      runtimeApprovalId: 'approval-1', sameTaskResumedAfterInterruption: true, decoded: true, artifact: { id: 'file-1' }
    } } } } }
  assert.deepEqual(windowsCoreJourneys(videoInstall).journeys.map(item => item.id).sort(), ['approval-resume', 'video-shotcraft'])
})

test('Windows receipt includes startup branding only after exact installed bilingual startup readback', () => {
  const version = '0.5.11'
  const install = { status: 'passed', platform: 'win32', arch: 'x64', productionTouched: false, version, sourceHead,
    verification: { installerSha256, installedAsarSha256 }, installer: { sha256: installerSha256 },
    target: { package: { asarSha256: installedAsarSha256 } },
    provenance: { packageBuild: { ...build, packageSourceHead: sourceHead } },
    startupAppearance: { status: 'passed', version, sourceHead, installedAsarSha256, packageUnchanged: true,
      observations: ['zh', 'en'].map(locale => ({ locale, workbenchOpened: true })) },
    ui: { status: 'passed', sourceHead, version, installedAsarSha256, packageUnchanged: true,
      checks: ['cold-mirror-installs-playwright-docling-and-skill-selection'],
      marketplace: { status: 'passed', playwright: { navigated: true, observed: 1 }, docling: { toolsDiscovered: 1 },
        installed: [{ id: 'superpowers', installedViaUi: true }, { id: 'blender-skills', installedViaUi: true }] } } }

  assert.deepEqual(windowsCoreJourneys(install).journeys.map(item => item.id), ['startup-branding', 'marketplace-mirror'])
  install.startupAppearance.observations.pop()
  assert.throws(() => windowsCoreJourneys(install), /zh-CN.*en|zh.*en/)
})

test('Windows updater receipt requires exact handoff and recovers data for either entry or legacy overlay', () => {
  const version = '0.5.11'
  const after = { expectedVersion: version, expectedSource: sourceHead, installerSha256,
    packageMetadata: { version, sourceHead, asarSha256: installedAsarSha256 },
    profilePreserved: true, workspaceFilePreserved: true, preferencesPreserved: true, threadPreserved: true,
    releaseHighlightsVisible: true, action: { method: 'trusted-pointer-on-sidebar', window: { pid: 321 } } }
  const report = { status: 'passed', scope: 'private-frozen-windows-gui-upgrade', productionTouched: false,
    targetBuild: { ...build, packageSourceHead: sourceHead }, baseline: { package: { version: '0.5.10' } },
    privateTrust: { scope: 'ephemeral-github-hosted-windows-machine-root' }, steps: [after] }
  assert.equal(windowsUpdaterCoreJourney(report, 'sidebar').journeys[0].id, 'windows-updater-sidebar')
  assert.throws(() => windowsUpdaterCoreJourney(report, 'settings'))
  after.action.method = 'exact-installer-overlay'
  report.baseline.package.version = '0.5.7'
  assert.equal(windowsUpdaterCoreJourney(report, 'overlay').journeys[0].id, 'windows-legacy-overlay')
  after.threadPreserved = false
  assert.throws(() => windowsUpdaterCoreJourney(report, 'overlay'))
})

test('receipt writer only accepts hosted workflows and creates an immutable output path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-core-journeys-record-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = { buildRunId: build.runId, buildRunAttempt: build.runAttempt, installerSha256, installedAsarSha256,
    journeys: [{ id: 'startup-branding' }] }
  assert.equal(await recordHostedCoreJourneys(root, { ...result, journeys: [] }, environment), undefined)
  await assert.rejects(recordHostedCoreJourneys(root, result, { ...environment, GITHUB_ACTIONS: 'false' }))
  const report = await recordHostedCoreJourneys(root, result, environment)
  assert.deepEqual(JSON.parse(await readFile(join(root, 'core-journeys.json'), 'utf8')), report)
  assert.equal(report.provenance.runAttempt, 2)
  await assert.rejects(recordHostedCoreJourneys(root, result, environment), { code: 'EEXIST' })
})
