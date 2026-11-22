import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256 } from './verify-frozen-updater-evidence.mjs'

const windowsWorkflow = '.github/workflows/windows-install-smoke.yml'
const sha256 = /^[a-f0-9]{64}$/

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
  assert.equal(observation.sameThread, true)
  assert.equal(observation.sameTurn, true)
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

export function macCoreJourneys(startup, live) {
  assert.equal(startup.status, 'passed')
  assert.ok(visitedWorkbench(startup.observations, ['zh-CN', 'en']) || visitedWorkbench(startup.observations, ['zh', 'en']))
  const journeys = [startupJourney('mac-startup-appearance.json')]
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
  if (ui?.status === 'passed' && ui.checks?.includes('installed-chat-web-ppt')) {
    assert.equal(ui.version, version)
    assert.equal(ui.sourceHead, sourceHead)
    assert.equal(ui.installedAsarSha256, installedAsarSha256)
    assert.equal(ui.packageUnchanged, true)
    const ppt = livePptJourney(ui.webPpt, 'windows-ui-smoke.json', 'desktop-open-request-accepted')
    if (ppt) journeys.push(ppt)
  }
  return { version, sourceHead, platform, arch, installerSha256, installedAsarSha256,
    buildRunId: Number(packageBuild.runId), buildRunAttempt: Number(packageBuild.runAttempt), journeys }
}

export function windowsUpdaterCoreJourney(report, entry) {
  assert.ok(['sidebar', 'settings', 'overlay'].includes(entry))
  assert.equal(report.status, 'passed')
  assert.equal(report.scope, 'private-frozen-windows-gui-upgrade')
  assert.equal(report.productionTouched, false)
  assert.equal(report.steps.length, 1)
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
    assert.equal(report.privateTrust?.scope, 'ephemeral-github-hosted-windows-machine-root')
    assert.ok(after.action.window)
  }
  return { version, sourceHead, platform: 'win32', arch: 'x64', installerSha256: after.installerSha256,
    installedAsarSha256: after.packageMetadata.asarSha256, buildRunId: Number(report.targetBuild.runId),
    buildRunAttempt: Number(report.targetBuild.runAttempt), journeys: [{ id, method: 'installed-ui', status: 'passed',
      evidence: 'frozen-windows-update.json records the exact install action and settings, workspace, conversation and release-highlight readback.' }] }
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
