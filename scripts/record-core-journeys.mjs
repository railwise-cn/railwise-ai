import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256 } from './verify-frozen-updater-evidence.mjs'
import { validateWebPptFallbackProof, validateWebPptTurnIdentity } from './web-ppt-journey.mjs'

const windowsWorkflow = '.github/workflows/windows-install-smoke.yml'
const sha256 = /^[a-f0-9]{64}$/
const sha512Hex = /^[a-f0-9]{128}$/
const sha512Base64 = /^[A-Za-z0-9+/]{86}==$/

function isSha512Digest(value) {
  if (typeof value !== 'string') return false
  if (sha512Hex.test(value)) return true
  if (!sha512Base64.test(value)) return false
  const decoded = Buffer.from(value, 'base64')
  return decoded.length === 64 && decoded.toString('base64') === value
}

function hostedProvenance(environment) {
  assert.equal(environment.GITHUB_ACTIONS, 'true')
  assert.equal(environment.GITHUB_REPOSITORY, RELEASE_REPOSITORY)
  const workflowPath = environment.GITHUB_WORKFLOW_REF?.split('@')[0].slice(RELEASE_REPOSITORY.length + 1)
  assert.ok([RELEASE_WORKFLOW, windowsWorkflow].includes(workflowPath), 'Use a trusted release smoke workflow')
  const provenance = { repository: RELEASE_REPOSITORY, workflowPath, sourceHead: environment.GITHUB_SHA,
    runId: Number(environment.GITHUB_RUN_ID), runAttempt: Number(environment.GITHUB_RUN_ATTEMPT) }
  assert.match(provenance.sourceHead, /^[a-f0-9]{40}$/)
  for (const number of [provenance.runId, provenance.runAttempt]) assert.ok(Number.isSafeInteger(number) && number > 0)
  return provenance
}

export function livePptJourney(observation, reportFile, acceptedOpenStatus) {
  if (observation?.status !== 'passed' || observation?.model !== 'live-model') return undefined
  assert.equal(observation.input, 'installed-chat-ui')
  validateWebPptTurnIdentity(observation)
  assert.equal(observation.source?.url, 'https://www.railwise.cn/')
  assert.equal(observation.source?.tool, 'web_fetch')
  assert.match(observation.source?.sha256, sha256)
  assert.ok(Number.isSafeInteger(observation.source?.bytes) && observation.source.bytes > 0)
  assert.ok(observation.artifact?.id)
  assert.equal(observation.artifact.nativeEditableText, true)
  assert.equal(observation.artifact.originalChatButtonClicked, true)
  assert.match(observation.artifact.sha256, sha256)
  assert.ok(Number.isSafeInteger(observation.artifact.bytes) && observation.artifact.bytes > 0)
  if (observation.open?.status !== acceptedOpenStatus) return undefined
  return { id: 'website-pptx', method: 'live-model-ui', status: 'passed',
    evidence: `${reportFile} shows the real model completing the original installed GUI conversation from the public website and opening the editable PPTX.` }
}

function visitedWorkbench(observations, languages) {
  return Array.isArray(observations) && languages.every(locale => observations.some(item =>
    item?.locale === locale && item.workbenchOpened === true))
}

function startupJourney(reportFile) {
  return { id: 'startup-branding', method: 'installed-ui', status: 'passed',
    evidence: `${reportFile} records the actual cold startup appearance and transition to the installed workbench.` }
}

export function macCoreJourneys(startup, live, spreadsheet) {
  assert.equal(startup.status, 'passed')
  assert.ok(visitedWorkbench(startup.observations, ['zh-CN', 'en']) || visitedWorkbench(startup.observations, ['zh', 'en']))
  const journeys = [startupJourney('mac-startup-appearance.json')]
  assert.equal(spreadsheet?.status, 'passed')
  assert.equal(spreadsheet.platform, 'darwin')
  assert.equal(spreadsheet.arch, startup.arch)
  assert.equal(spreadsheet.version, startup.version)
  assert.equal(spreadsheet.sourceHead, startup.source.sourceHead)
  assert.equal(spreadsheet.installerSha256, startup.installer.sha256)
  assert.equal(spreadsheet.installedAsarSha256, startup.installed.asarSha256)
  assert.equal(spreadsheet.execution, 'installed-ui')
  assert.equal(spreadsheet.packageUnchanged, true)
  for (const check of ['new-local-rwsheet', 'formula-calculation-saved', 'undo-restores-prior-cell-value',
    'external-save-conflict-preserves-original-and-saves-copy', 'utf8-chinese-csv-import-export-preserves-leading-zero-and-decimal',
    'save-reopen-multiple-sheets-through-production-reader', 'xlsx-read-only-preview-preserves-sheet-names-positions-and-source-bytes']) {
    assert.ok(spreadsheet.checks.includes(check), `Missing installed spreadsheet check: ${check}`)
  }
  journeys.push({ id: 'offline-spreadsheet', method: 'installed-ui', status: 'passed',
    evidence: `${spreadsheet.platform}/${spreadsheet.arch} ran the offline workbook workflow in the exact installed package and recorded the workbook and read-only XLSX assertions.` })
  if (live?.status === 'passed' && live.modelMode === 'live') {
    assert.equal(live.platform, 'darwin')
    assert.equal(live.arch, startup.arch)
    assert.equal(live.version, startup.version)
    assert.deepEqual(live.source, startup.source)
    assert.equal(live.installer?.sha256, startup.installer.sha256)
    assert.equal(live.installedAsarSha256, startup.installed.asarSha256)
    const ppt = livePptJourney(live.observation, 'mac-ppt-journey-live.json', 'os-open-accepted')
    if (ppt) journeys.push(ppt)
  }
  return { version: startup.version, sourceHead: startup.source.sourceHead, platform: 'darwin', arch: startup.arch,
    installerSha256: startup.installer.sha256, installedAsarSha256: startup.installed.asarSha256,
    buildRunId: startup.source.runId, buildRunAttempt: startup.source.runAttempt, journeys }
}

export function windowsCoreJourneys(install, environment = process.env) {
  assert.equal(install.status, 'passed')
  assert.equal(install.platform, 'win32')
  assert.equal(install.arch, 'x64')
  assert.equal(install.productionTouched, false)
  const { version, sourceHead, platform, arch } = install
  const { installerSha256, installedAsarSha256 } = install.verification
  assert.equal(installerSha256, install.installer.sha256)
  assert.equal(installedAsarSha256, install.target.package.asarSha256)
  const packageBuild = install.provenance.packageBuild ?? {
    packageSourceHead: sourceHead, runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT
  }
  assert.equal(packageBuild.packageSourceHead, sourceHead)
  const journeys = []
  const startup = install.startupAppearance
  if (startup?.status === 'passed') {
    assert.equal(startup.version, version)
    assert.equal(startup.sourceHead, sourceHead)
    assert.equal(startup.installedAsarSha256, installedAsarSha256)
    assert.equal(startup.packageUnchanged, true)
    assert.ok(visitedWorkbench(startup.observations, ['zh-CN', 'en']) || visitedWorkbench(startup.observations, ['zh', 'en']))
    journeys.push(startupJourney('windows-startup-appearance.json'))
  }
  const ui = install.ui
  const webPptChecks = ui?.checks ?? []
  if (ui?.status === 'passed' && webPptChecks.some(check =>
    ['installed-chat-web-ppt', 'installed-chat-web-ppt-browser-fallback'].includes(check))) {
    assert.equal(ui.version, version)
    assert.equal(ui.sourceHead, sourceHead)
    assert.equal(ui.installedAsarSha256, installedAsarSha256)
    assert.equal(ui.packageUnchanged, true)
    if (webPptChecks.includes('installed-chat-web-ppt-browser-fallback')) {
      validateWebPptFallbackProof(ui.webPpt, ui.webPptBrowser)
      journeys.push({ id: 'browserskill-fallback', method: 'real-browser-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records the task origin bound to the original chat, a separate execution thread, a denied direct fetch, a verified DOM read through the pinned Chrome extension, and an editable PPTX opened from the original chat.' })
    } else {
      const ppt = livePptJourney(ui.webPpt, 'windows-ui-smoke.json', 'desktop-open-request-accepted')
      if (ppt) journeys.push(ppt)
    }
  }
  if (ui?.status === 'passed') {
    const checks = new Set(ui.checks ?? [])
    const task = ui.taskExecution
    if (checks.has('runtime-task-html-and-daily-schedule')) {
      assert.equal(task?.status, 'completed')
      assert.ok(task.taskId)
      assert.equal(task.artifact?.format, 'html')
      assert.equal(task.artifact?.validation, 'valid')
      assert.equal(task.artifact?.byteHashMatches, true)
      assert.equal(task.preview?.automatic, true)
      assert.equal(task.preview?.contentVerified, true)
      assert.equal(task.preview?.manualEntryVerified, true)
      journeys.push({ id: 'conversation-task', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records a completed task, valid HTML and automatic and manual previews from the installed conversation.' })
      const occurrence = task.dueOccurrence
      assert.equal(occurrence?.clock, 'real')
      assert.equal(occurrence?.status, 'completed')
      assert.equal(occurrence?.resultInOriginChat, true)
      assert.equal(occurrence?.durableOriginReceipt, true)
      assert.equal(occurrence?.noRepeatedUserRequest, true)
      assert.equal(occurrence?.byteHashMatches, true)
      journeys.push({ id: 'daily-schedule', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records a real-clock due run, one verified artifact and its durable result in the original conversation.' })
    }
    if (checks.has('composer-files-skills-and-plugin')) {
      const composer = ui.composerAcceptance
      assert.equal(composer?.status, 'passed')
      for (const flag of ['skillRead', 'pluginRead', 'scanSent', 'chineseTextSent', 'nativeClipboard', 'chooser', 'drop']) {
        assert.equal(composer[flag], true, `Missing installed composer assertion: ${flag}`)
      }
      assert.ok(Number.isSafeInteger(composer.scanBytes) && composer.scanBytes >= 40 * 1024 * 1024)
      assert.equal(composer.attachmentLayout?.preservedDraft, true)
      journeys.push({ id: 'composer-capabilities', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records Skill and plugin calls from the installed composer with the draft preserved.' })
      journeys.push({ id: 'pdf-attachments', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records a 40 MiB scan PDF, Chinese text PDF and chooser, clipboard and drop intake.' })
    }
    if (checks.has('native-window-composer-menus-and-narrow-navigation')) {
      assert.equal(ui.adaptiveWorkbench?.status, 'passed')
      journeys.push({ id: 'responsive-layout', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records actual native window resizing, composer menu keyboard behavior and narrow navigation.' })
    }
    if (checks.has('cold-mirror-installs-playwright-docling-and-skill-selection')) {
      assert.equal(ui.marketplace?.status, 'passed')
      assert.equal(ui.marketplace?.playwright?.navigated, true)
      assert.ok(ui.marketplace?.playwright?.observed > 0)
      assert.ok(ui.marketplace?.docling?.toolsDiscovered > 0)
      assert.ok(ui.marketplace?.installed?.some(item => item.id === 'superpowers' && item.installedViaUi))
      assert.ok(ui.marketplace?.installed?.some(item => item.id === 'blender-skills' && item.installedViaUi))
      journeys.push({ id: 'marketplace-mirror', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records cold mirrored market installs, installed Skill entries, Docling startup and Playwright navigation.' })
    }
    if (checks.has('installed-video-skill-protocol-render-registered-and-decoded')) {
      const render = ui.marketplace?.videoShotcraft?.render
      assert.equal(ui.marketplace?.scope, 'video-shotcraft')
      assert.ok(render?.runtimeApprovalId)
      assert.equal(render.sameTaskResumedAfterInterruption, true)
      assert.equal(render.decoded, true)
      assert.ok(render.artifact?.id)
      journeys.push({ id: 'approval-resume', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records one approved Video Shotcraft render, same-task recovery and verified playable output.' })
      journeys.push({ id: 'video-shotcraft', method: 'installed-ui', status: 'passed',
        evidence: 'windows-install-smoke.json records the installed Video Shotcraft skill, PDF read, registered MP4 and full decode.' })
    }
  }
  return { version, sourceHead, platform, arch, installerSha256, installedAsarSha256,
    buildRunId: Number(packageBuild.runId), buildRunAttempt: Number(packageBuild.runAttempt), journeys }
}

export function windowsUpdaterCoreJourney(report, entry) {
  assert.ok(['sidebar', 'settings', 'overlay'].includes(entry))
  assert.equal(report.status, 'passed')
  assert.ok(['private-frozen-windows-gui-upgrade', 'private-isolated-windows-gui-upgrade'].includes(report.scope))
  assert.equal(report.productionTouched, false)
  assert.equal(report.steps.length, 1)
  if (report.scope === 'private-isolated-windows-gui-upgrade') {
    const verification = report.targetVerification
    assert.equal(verification?.scope, 'isolated-candidate-acceptance')
    assert.equal(verification?.releaseApproval, false)
    assert.match(verification?.manifestSha256 ?? '', sha256)
    assert.ok(isSha512Digest(verification?.installerSha512), 'installer SHA-512 must be 64-byte hex or canonical Base64')
    assert.match(verification?.blockmapSha256 ?? '', sha256)
    if (entry === 'overlay') assert.equal(verification.feedRequests, null)
    else {
      assert.ok(verification.feedRequests?.manifest >= 1)
      assert.ok(verification.feedRequests?.zip >= 1)
      assert.ok(verification.feedRequests?.bytesServed > 0)
    }
  }
  const [after] = report.steps
  const version = after.packageMetadata.version
  const sourceHead = report.targetBuild.packageSourceHead
  assert.equal(after.expectedVersion, version)
  assert.equal(after.packageMetadata.sourceHead, sourceHead)
  assert.equal(after.expectedSource, sourceHead)
  for (const key of ['profilePreserved', 'workspaceFilePreserved', 'preferencesPreserved', 'threadPreserved']) assert.equal(after[key], true)
  assert.ok(after.releaseHighlightsVisible === true || after.releaseHighlightsFirstLaunchRecorded === true)
  const id = entry === 'overlay' ? 'windows-legacy-overlay' : `windows-updater-${entry}`
  const method = { sidebar: 'trusted-pointer-on-sidebar', settings: 'trusted-pointer-in-settings', overlay: 'exact-installer-overlay' }[entry]
  assert.equal(after.action.method, method)
  if (entry === 'overlay') {
    assert.equal(report.baseline.package.version, '0.5.7')
  } else {
    assert.equal(report.baseline.package.version, '0.5.10')
    if (entry !== 'overlay') assert.equal(report.privateTrust?.scope, 'ephemeral-github-hosted-windows-machine-root')
    assert.ok(after.action.window)
  }
  return { version, sourceHead, platform: 'win32', arch: 'x64', installerSha256: after.installerSha256,
    installedAsarSha256: after.packageMetadata.asarSha256, buildRunId: Number(report.targetBuild.runId),
    buildRunAttempt: Number(report.targetBuild.runAttempt), journeys: [{ id, method: 'installed-ui', status: 'passed',
      evidence: 'frozen-windows-update.json records the exact install action and settings, workspace, conversation and release-highlight readback for the verified package.' }] }
}

export async function recordHostedCoreJourneys(directory, result, environment = process.env) {
  if (result.journeys.length === 0) return
  for (const number of [result.buildRunId, result.buildRunAttempt]) assert.ok(Number.isSafeInteger(number) && number > 0)
  assert.match(result.installerSha256, sha256)
  assert.match(result.installedAsarSha256, sha256)
  const report = { schemaVersion: 1, status: 'passed', ...result, execution: 'hosted', provenance: hostedProvenance(environment) }
  await writeFile(join(directory, 'core-journeys.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return report
}

async function main([mode, directory, entry]) {
  assert.ok(['windows', 'windows-upgrade'].includes(mode), 'Expected windows or windows-upgrade receipt mode')
  const bytes = await readFile(join(directory, mode === 'windows' ? 'windows-install-smoke.json' : 'frozen-windows-update.json'))
  const report = JSON.parse(bytes)
  const result = mode === 'windows' ? windowsCoreJourneys(report) : windowsUpdaterCoreJourney(report, entry)
  // Hash the original rich report so a receipt can be traced to its assertions.
  for (const journey of result.journeys) {
    journey.proofFile = mode === 'windows' ? 'windows-install-smoke.json' : 'frozen-windows-update.json'
    journey.proofSha256 = reportSha256(bytes)
  }
  await recordHostedCoreJourneys(directory, result)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
