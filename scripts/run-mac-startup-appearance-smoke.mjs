import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp } from './run-windows-ui-smoke.mjs'
import { observeStartupWithCaptureRetry } from './verify-packaged-startup-appearance.mjs'
import { macCoreJourneys, recordHostedCoreJourneys } from './record-core-journeys.mjs'
import { PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { reportSha256 } from './verify-frozen-updater-evidence.mjs'

const require = createRequire(import.meta.url)
const acceptedDriverFiles = new Set([
  '.github/workflows/windows-install-smoke.yml',
  'scripts/run-mac-ppt-journey.mjs',
  'scripts/run-mac-offline-spreadsheet-journey.mjs',
  'scripts/record-core-journeys.mjs',
  'scripts/run-mac-startup-appearance-smoke.mjs',
  'scripts/run-windows-ui-smoke.mjs',
  'scripts/verify-packaged-startup-appearance.mjs',
  'scripts/web-ppt-journey.mjs'
])
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args) => command('git', args)
const json = (path) => readFile(path, 'utf8').then(JSON.parse)

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

export function validateMacStartupArtifact(source) {
  assert.equal(source.repository, RELEASE_REPOSITORY)
  assert.equal(source.workflow, RELEASE_WORKFLOW)
  for (const sha of [source.sourceHead, source.driverHead]) assert.match(sha, /^[a-f0-9]{40}$/)
  for (const number of [source.runId, source.runAttempt, source.artifactId]) assert.match(String(number), /^[1-9]\d*$/)
  assert.equal(source.buildConclusion, 'success')
  assert.equal(source.artifactName, 'release-mac')
  assert.match(source.artifactDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(source.artifactExpired, false)
  assert.ok(Array.isArray(source.changedFiles) && source.changedFiles.every(file => acceptedDriverFiles.has(file)), 'Application source differs from the reviewed build')
  return source
}

async function prepare(buildRunId, sourceFile) {
  assert.match(buildRunId, /^[1-9]\d*$/)
  const repository = process.env.GITHUB_REPOSITORY
  assert.equal(repository, RELEASE_REPOSITORY)
  const api = (suffix) => JSON.parse(command('gh', ['api', `repos/${repository}/${suffix}`]))
  const run = api(`actions/runs/${buildRunId}`)
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.path, RELEASE_WORKFLOW)
  const driverHead = git('rev-parse', 'HEAD')
  assert.equal(driverHead, process.env.GITHUB_SHA)
  git('merge-base', '--is-ancestor', run.head_sha, driverHead)
  const jobs = api(`actions/runs/${buildRunId}/attempts/${run.run_attempt}/jobs?per_page=100`)
  const build = jobs.jobs.find(job => job.name === 'Build macOS')
  const artifacts = api(`actions/runs/${buildRunId}/artifacts?per_page=100`)
  const [artifact, duplicate] = artifacts.artifacts.filter(item => item.name === 'release-mac' && !item.expired)
  assert.ok(artifact && !duplicate, 'Expected one immutable macOS release artifact')
  assert.equal(artifact.workflow_run.head_sha, run.head_sha)
  const source = validateMacStartupArtifact({ repository, workflow: run.path, runId: Number(buildRunId), runAttempt: run.run_attempt,
    sourceHead: run.head_sha, driverHead, buildConclusion: build?.conclusion, artifactName: artifact.name, artifactId: artifact.id,
    artifactDigest: artifact.digest, artifactExpired: artifact.expired,
    changedFiles: git('diff', '--name-only', run.head_sha, driverHead).split('\n').filter(Boolean) })
  await writeFile(sourceFile, `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' })
  await appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${source.artifactId}\n`)
}

function isolatedMacEnvironment(environment, root) {
  const home = join(root, 'home')
  return { PATH: environment.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: root,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
}

async function verify(directory, sourceFile, evidenceDir, temporary) {
  const source = validateMacStartupArtifact(await json(sourceFile))
  assert.equal(source.driverHead, process.env.GITHUB_SHA)
  const receipt = await json(join(directory, 'reviewed-build.json'))
  for (const name of ['runId', 'runAttempt', 'sourceHead']) assert.equal(receipt[name], source[name])
  const { version } = await json(new URL('../package.json', import.meta.url))
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(receipt.version, version)
  const name = `RailWise-AI-${version}-mac-${process.arch}.dmg`
  const installer = join(directory, name)
  const digest = await sha256(installer)
  const size = (await stat(installer)).size
  const record = receipt.files.find(file => file.name === name)
  assert.equal(digest, record?.sha256)
  assert.equal(size, record.size)
  const root = await mkdtemp(join(temporary, 'railwise-mac-startup-'))
  const mountPoint = join(root, 'mounted')
  const install = join(root, 'RailWise AI.app')
  await Promise.all([mountPoint, evidenceDir].map(path => mkdir(path, { recursive: true })))
  command('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, installer])
  try { command('/usr/bin/ditto', [join(mountPoint, 'RailWise AI.app'), install]) }
  finally { command('/usr/bin/hdiutil', ['detach', mountPoint]) }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', install])
  command('/usr/bin/xcrun', ['stapler', 'validate', install])
  const info = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(install, 'Contents', 'Info.plist')]))
  assert.equal(info.CFBundleIdentifier, PUBLIC_IDENTITY.bundleId)
  assert.equal(info.CFBundleExecutable, PUBLIC_IDENTITY.productName)
  assert.equal(info.CFBundleShortVersionString, version)
  const executable = join(install, 'Contents', 'MacOS', info.CFBundleExecutable)
  const installedArch = command('/usr/bin/lipo', ['-archs', executable])
  assert.equal(installedArch, process.arch === 'x64' ? 'x86_64' : 'arm64')
  const path = join(install, 'Contents', 'Resources', 'app.asar')
  const packaged = JSON.parse(require('@electron/asar').extractFile(path, 'package.json').toString('utf8'))
  assert.equal(packaged.name, PUBLIC_IDENTITY.packageName)
  assert.equal(packaged.productName, PUBLIC_IDENTITY.productName)
  assert.equal(packaged.version, version)
  assert.equal(packaged.buildProvenance?.sourceHead, source.sourceHead)
  const installedAsarSha256 = await sha256(path)
  const report = { schemaVersion: 1, status: 'failed', source, arch: process.arch, version,
    installer: { name, sha256: digest, size }, installed: { bundleId: info.CFBundleIdentifier, installedArch,
      signature: 'verified', notarization: 'staple-verified', asarSha256: installedAsarSha256 }, observations: [] }
  let live
  try {
    for (const expected of [
      { locale: 'en', htmlLang: 'en', theme: 'light' },
      { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark', screenshotName: 'mac-startup-zh-dark.png' }
    ]) {
      const observation = await observeStartupWithCaptureRetry({ executable, version, evidenceDir, temporary }, expected,
        { connectCdp, environmentForRoot: isolatedMacEnvironment })
      if (expected.screenshotName) {
        const screenshotPath = join(evidenceDir, expected.screenshotName)
        observation.screenshot = { name: expected.screenshotName, sha256: await sha256(screenshotPath), size: (await stat(screenshotPath)).size }
      }
      report.observations.push(observation)
    }
    const journey = process.env.RAILWISE_MAC_PPT_JOURNEY || 'off'
    assert.ok(['off', 'controlled', 'live', 'both'].includes(journey), 'Invalid Mac PPT journey mode')
    if (journey !== 'off') {
      const { runInstalledMacPptJourney } = await import('./run-mac-ppt-journey.mjs')
      for (const mode of journey === 'both' ? ['controlled', 'live'] : [journey]) {
        const result = await runInstalledMacPptJourney({ executable, temporary, evidenceDir, version, installedAsarSha256,
          installer: report.installer, source, mode, environmentForRoot: isolatedMacEnvironment })
        if (mode === 'live') live = result
      }
    }
    const { runInstalledMacOfflineSpreadsheetJourney } = await import('./run-mac-offline-spreadsheet-journey.mjs')
    const spreadsheet = await runInstalledMacOfflineSpreadsheetJourney({ executable, temporary, evidenceDir, version,
      installedAsarSha256, installer: report.installer, source })
    assert.equal(await sha256(path), installedAsarSha256)
    report.status = 'passed'
    report.offlineSpreadsheet = { status: spreadsheet.status, file: 'mac-offline-spreadsheet.json' }
  } catch (error) {
    report.error = error.message
    throw error
  } finally {
    await writeFile(join(evidenceDir, 'mac-startup-appearance.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  const spreadsheet = await json(join(evidenceDir, 'mac-offline-spreadsheet.json'))
  const result = macCoreJourneys(report, live, spreadsheet)
  for (const item of result.journeys) {
    const file = item.id === 'startup-branding' ? 'mac-startup-appearance.json'
      : item.id === 'offline-spreadsheet' ? 'mac-offline-spreadsheet.json' : 'mac-ppt-journey-live.json'
    item.proofFile = file
    item.proofSha256 = reportSha256(await readFile(join(evidenceDir, file)))
  }
  await recordHostedCoreJourneys(evidenceDir, result)
}

async function main([mode, directory, source, evidenceDir, arch]) {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'macOS')
  if (mode === '--prepare') {
    assert.equal(process.arch, evidenceDir)
    return prepare(directory, source)
  }
  assert.equal(mode, '--run')
  assert.equal(process.arch, arch)
  const temporary = resolve(process.env.RUNNER_TEMP)
  for (const path of [directory, source, evidenceDir]) {
    const child = relative(temporary, resolve(path))
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'macOS acceptance paths must be owned by the runner')
  }
  return verify(directory, source, evidenceDir, temporary)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
