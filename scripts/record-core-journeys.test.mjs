import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { livePptJourney, macCoreJourneys, recordHostedCoreJourneys, windowsCoreJourneys, windowsUpdaterCoreJourney } from './record-core-journeys.mjs'
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { browserSmokeDependency } from './prepare-browser-skill-smoke.mjs'

const sourceHead = 'e'.repeat(40)
const installerSha256 = 'a'.repeat(64)
const installedAsarSha256 = 'b'.repeat(64)
const build = { runId: 123, runAttempt: 2 }
const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: RELEASE_REPOSITORY,
  GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/main`,
  GITHUB_SHA: sourceHead, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }

function replyTrace(sameTurn = true) {
  const requestId = 'question-1'
  const firstTurn = 'turn-1'
  return {
    before: { ui: { taskQuestionRequestId: requestId }, task: { activeTurnId: firstTurn },
      attention: [{ requestId, kind: 'question', status: 'pending', questionCount: 1, textQuestion: true,
        questionId: 'website', questionLabel: '请提供官网网址。' }] },
    answerReceipt: { idempotencyKey: `user-input:${requestId}`, count: 1, questionId: 'website',
      answerLength: 15, answerMatchesExpected: true },
    after: { task: { id: 'task-1', originThreadId: 'conversation-1', activeTurnId: sameTurn ? firstTurn : 'turn-2' },
      inputs: [{ kind: 'supplement', idempotencyKey: `user-input:${requestId}` }], attention: [] }
  }
}

function ppt(open = 'os-open-accepted') {
  return { status: 'passed', model: 'live-model', input: 'installed-chat-ui', taskId: 'task-1',
    conversationThreadId: 'conversation-1', originThreadId: 'conversation-1', executionThreadId: 'execution-1', sameConversation: true,
    originalConversation: { questionVisible: true, artifactVisible: true }, sameTurn: true, replyTrace: replyTrace(),
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
  assert.throws(() => livePptJourney({ ...ppt(), sameTurn: false, replyTrace: replyTrace(false) }, file, 'os-open-accepted'))
  assert.equal(livePptJourney({ ...ppt(), sameTurn: false, replyTrace: replyTrace(false), initialTurnId: 'first', completedTurnId: 'resumed' }, file, 'os-open-accepted').id, 'website-pptx')
  assert.throws(() => livePptJourney({ ...ppt(), replyTrace: { ...replyTrace(), after: { ...replyTrace().after, inputs: [] } } }, file, 'os-open-accepted'))
  const wrongComposerRequest = structuredClone(ppt())
  wrongComposerRequest.replyTrace.before.ui.taskQuestionRequestId = 'different-question'
  assert.throws(() => livePptJourney(wrongComposerRequest, file, 'os-open-accepted'))
  const duplicateAnswer = structuredClone(ppt())
  duplicateAnswer.replyTrace.after.inputs.push({ kind: 'supplement', idempotencyKey: 'user-input:question-1' })
  assert.throws(() => livePptJourney(duplicateAnswer, file, 'os-open-accepted'))
  const wrongTask = structuredClone(ppt())
  wrongTask.replyTrace.after.task.id = 'different-task'
  assert.throws(() => livePptJourney(wrongTask, file, 'os-open-accepted'))
  const questionStillPending = structuredClone(ppt())
  questionStillPending.replyTrace.after.attention.push({ requestId: 'question-1', status: 'pending' })
  assert.throws(() => livePptJourney(questionStillPending, file, 'os-open-accepted'), /pending inbox/)
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

test('Windows records BrowserSkill fallback only with the real browser proof and a new Turn', () => {
  const version = '0.5.11'
  const url = 'http://127.0.0.1:32123/ppt-source'
  const browserInstanceId = 'isolated-browser'
  const install = { status: 'passed', platform: 'win32', arch: 'x64', productionTouched: false, version, sourceHead,
    verification: { installerSha256, installedAsarSha256 }, installer: { sha256: installerSha256 },
    target: { package: { asarSha256: installedAsarSha256 } },
    provenance: { packageBuild: { ...build, packageSourceHead: sourceHead } },
    ui: { status: 'passed', sourceHead, version, installedAsarSha256, packageUnchanged: true,
      checks: ['installed-chat-web-ppt-browser-fallback'],
      webPpt: { ...ppt('desktop-open-request-accepted'), model: 'controlled-protocol', sameTurn: false, replyTrace: replyTrace(false),
        initialTurnId: 'first', completedTurnId: 'resumed', source: { url, tool: 'browser_get_html', bytes: 512, sha256: 'c'.repeat(64) },
        browserRecovery: { taskId: 'task-1', originThreadId: 'conversation-1', executionThreadId: 'execution-1', initialTurnId: 'first', completedTurnId: 'resumed',
          originalQuestionCount: 1, supplements: 1, directFetchBlock: 'policy_blocked', directFetchUrl: url,
          browserInstanceId, sessionId: 'owned-session', sourceReadOnly: true, readOnlyOrigins: [new URL(url).origin],
          toolNames: ['web_fetch', 'browser_session_start', 'browser_navigate', 'browser_get_html', 'browser_session_stop'] } },
      webPptBrowser: { browserInstanceId, isolatedTestCredentialStore: true, cliVersion: '0.5.0', cliSha256: '1'.repeat(64),
        protocolVersion: '1.9', extensionId: 'a'.repeat(32),
        extension: { version: browserSmokeDependency.extensionVersion, sha256: browserSmokeDependency.extensionSha256 },
        browser: { version: browserSmokeDependency.chromeVersion, executableSha256: '2'.repeat(64) } } } }
  const journeys = windowsCoreJourneys(install).journeys
  assert.deepEqual(journeys.map(({ id, method }) => ({ id, method })), [{ id: 'browserskill-fallback', method: 'real-browser-ui' }])

  const wrongExtension = structuredClone(install)
  wrongExtension.ui.webPptBrowser.extension.sha256 = '3'.repeat(64)
  assert.throws(() => windowsCoreJourneys(wrongExtension))
  const sameTurn = structuredClone(install)
  sameTurn.ui.webPpt.completedTurnId = 'first'
  assert.throws(() => windowsCoreJourneys(sameTurn))
  const wrongDirectFailure = structuredClone(install)
  wrongDirectFailure.ui.webPpt.browserRecovery.directFetchBlock = 'fetch_failed'
  assert.throws(() => windowsCoreJourneys(wrongDirectFailure))
  const unopened = structuredClone(install)
  unopened.ui.webPpt.open.status = 'handler-unavailable'
  assert.throws(() => windowsCoreJourneys(unopened))
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

test('Windows receipt records offline spreadsheet only when exact workbook and XLSX checks pass', () => {
  const version = '0.5.11'
  const spreadsheet = {
    status: 'passed', platform: 'win32', arch: 'x64', version, sourceHead,
    buildRunId: build.runId, buildRunAttempt: build.runAttempt,
    installerSha256, installedAsarSha256, execution: 'installed-ui', packageUnchanged: true,
    networkIsolation: { rendererOffline: true },
    checks: ['new-local-rwsheet', 'formula-calculation-saved', 'undo-restores-prior-cell-value',
      'external-save-conflict-preserves-original-and-saves-copy',
      'utf8-chinese-csv-import-export-preserves-leading-zero-and-decimal',
      'save-reopen-multiple-sheets-through-production-reader',
      'xlsx-read-only-preview-preserves-sheet-names-positions-and-source-bytes'],
    formula: { expression: '=SUM(4,5)', value: 9 },
    undo: { shortcut: 'Ctrl+Z', restoredPreviousValue: true },
    conflict: { originalPreserved: true, copyPreservedUnsavedEdit: true },
    csv: { preservesLeadingZeroAndPrecision: true },
    savedWorkbook: { sheetCount: 2, reopenedThroughProductionReader: true,
      reopenedInVisibleGrid: true, formulaValueAfterReopen: 9 },
    xlsxPreview: { sheetNames: ['监测点', '记录'], renderedReadOnlyGrid: true,
      editingControlsHidden: true, systemOpenEntryVisible: true }
  }
  const install = { status: 'passed', platform: 'win32', arch: 'x64', productionTouched: false, version, sourceHead,
    verification: { installerSha256, installedAsarSha256 }, installer: { sha256: installerSha256 },
    target: { package: { asarSha256: installedAsarSha256 } },
    provenance: { packageBuild: { ...build, packageSourceHead: sourceHead } },
    ui: { status: 'passed', version, sourceHead, installedAsarSha256, installerSha256, packageUnchanged: true,
      checks: ['offline-spreadsheet-exact-package'], offlineSpreadsheet: spreadsheet } }

  assert.deepEqual(windowsCoreJourneys(install).journeys.map(item => item.id), ['offline-spreadsheet'])
  const wrongInstaller = structuredClone(install)
  wrongInstaller.ui.offlineSpreadsheet.installerSha256 = 'f'.repeat(64)
  assert.throws(() => windowsCoreJourneys(wrongInstaller))
  const missingCheck = structuredClone(install)
  missingCheck.ui.offlineSpreadsheet.checks.pop()
  assert.throws(() => windowsCoreJourneys(missingCheck), /Missing installed Windows spreadsheet check/)
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
    releaseHighlightsVisible: true, releaseHighlightsDismissalRecorded: false,
    action: { method: 'trusted-pointer-on-sidebar', window: { pid: 321 } } }
  const report = { status: 'passed', scope: 'private-frozen-windows-gui-upgrade', productionTouched: false,
    targetBuild: { ...build, packageSourceHead: sourceHead }, baseline: { package: { version: '0.5.10' } },
    privateTrust: { scope: 'ephemeral-github-hosted-windows-machine-root' }, steps: [after] }
  assert.equal(windowsUpdaterCoreJourney(report, 'sidebar').journeys[0].id, 'windows-updater-sidebar')
  assert.throws(() => windowsUpdaterCoreJourney(report, 'settings'))
  const hiddenAnnouncement = structuredClone(after)
  hiddenAnnouncement.releaseHighlightsVisible = false
  hiddenAnnouncement.releaseHighlightsDismissalRecorded = true
  report.steps = [hiddenAnnouncement]
  assert.throws(() => windowsUpdaterCoreJourney(report, 'sidebar'), /release highlights/)
  report.steps = [after]
  after.action.method = 'exact-installer-overlay'
  report.baseline.package.version = '0.5.7'
  assert.equal(windowsUpdaterCoreJourney(report, 'overlay').journeys[0].id, 'windows-legacy-overlay')
  after.threadPreserved = false
  assert.throws(() => windowsUpdaterCoreJourney(report, 'overlay'))
})

test('Windows updater receipt accepts an isolated candidate only with exact artifact and feed proof', () => {
  const version = '0.5.11'
  const after = { expectedVersion: version, expectedSource: sourceHead, installerSha256,
    packageMetadata: { version, sourceHead, asarSha256: installedAsarSha256 },
    profilePreserved: true, workspaceFilePreserved: true, preferencesPreserved: true, threadPreserved: true,
    releaseHighlightsVisible: true, releaseHighlightsDismissalRecorded: false,
    action: { method: 'trusted-pointer-on-sidebar', window: { pid: 321 } } }
  const targetVerification = { scope: 'isolated-candidate-acceptance', releaseApproval: false,
    manifestSha256: 'a'.repeat(64), installerSha512: Buffer.alloc(64, 0x5a).toString('base64'), blockmapSha256: 'c'.repeat(64),
    feedRequests: { manifest: 2, installerBytes: 100 } }
  const report = { status: 'passed', scope: 'private-isolated-windows-gui-upgrade', productionTouched: false,
    targetVerification, targetBuild: { ...build, packageSourceHead: sourceHead }, baseline: { package: { version: '0.5.10' } },
    privateTrust: { scope: 'ephemeral-github-hosted-windows-machine-root' }, steps: [after] }
  assert.equal(windowsUpdaterCoreJourney(report, 'sidebar').journeys[0].id, 'windows-updater-sidebar')
  targetVerification.installerSha512 = 'b'.repeat(128)
  assert.equal(windowsUpdaterCoreJourney(report, 'sidebar').journeys[0].id, 'windows-updater-sidebar')
  targetVerification.installerSha512 = `${Buffer.alloc(64).toString('base64').slice(0, -3)}B==`
  assert.throws(() => windowsUpdaterCoreJourney(report, 'sidebar'), /installer SHA-512/)
  targetVerification.installerSha512 = Buffer.alloc(64, 0x5a).toString('base64')
  report.targetVerification.feedRequests.installerBytes = 0
  assert.throws(() => windowsUpdaterCoreJourney(report, 'sidebar'))
  report.targetVerification.feedRequests = null
  after.action.method = 'exact-installer-overlay'
  report.baseline.package.version = '0.5.7'
  assert.equal(windowsUpdaterCoreJourney(report, 'overlay').journeys[0].id, 'windows-legacy-overlay')
  report.targetVerification.releaseApproval = true
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
