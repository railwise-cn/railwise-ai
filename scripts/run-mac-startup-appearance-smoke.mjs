import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, lstat, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp } from './run-windows-ui-smoke.mjs'
import { observeInstalledStartup } from './verify-packaged-startup-appearance.mjs'
import { PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'
import { verifyMacWorkbook } from './verify-mac-workbook.mjs'

const require = createRequire(import.meta.url)
const acceptedDriverFiles = new Set([
  '.github/workflows/windows-install-smoke.yml',
  'scripts/prepare-windows-install-smoke.test.mjs',
  'scripts/run-mac-startup-appearance-smoke.mjs',
  'scripts/run-windows-ui-smoke.mjs',
  'scripts/verify-packaged-startup-appearance.mjs',
  'scripts/verify-mac-workbook.mjs',
  'scripts/verify-windows-startup-appearance.test.mjs'
])
const { publicInstallers } = require('./release-publication.cjs')
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
  if (source.mode === 'isolated-candidate') {
    assert.equal(source.event, 'workflow_dispatch')
    assert.equal(source.candidateConclusion, 'success')
    assert.equal(source.publicationConclusion, 'skipped')
    assert.match(source.version, /^\d+\.\d+\.\d+$/)
    assert.match(String(source.runNumber), /^[1-9]\d*$/)
    assert.equal(source.artifactName, `candidate-installers-${source.version}-${source.runNumber}`)
  } else {
    assert.ok(source.mode === undefined || source.mode === 'reviewed')
    assert.equal(source.artifactName, 'release-mac')
  }
  assert.match(source.artifactDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(source.artifactExpired, false)
  assert.ok(Array.isArray(source.changedFiles) && source.changedFiles.every(file => acceptedDriverFiles.has(file)), 'Application source differs from the reviewed build')
  return source
}

export function parseMacCandidateChecksums(content, version) {
  const expected = new Set(publicInstallers(version, 'RailWise-AI').map(item => item.name))
  const files = new Map()
  for (const line of content.trim().split(/\r?\n/)) {
    const record = /^([0-9a-f]{64}) [ *]([^/\\]+)$/.exec(line)
    assert.ok(record && expected.has(record[2]) && !files.has(record[2]), 'Unexpected or duplicate candidate checksum entry')
    files.set(record[2], record[1])
  }
  assert.equal(files.size, expected.size, 'Expected checksums for both macOS installers and the Windows installer')
  return files
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
  const isolated = process.env.EXACT_MAC_ISOLATED_CANDIDATE === 'true'
  const { version } = await json(new URL('../package.json', import.meta.url))
  const jobs = api(`actions/runs/${buildRunId}/attempts/${run.run_attempt}/jobs?per_page=100`)
  const build = jobs.jobs.find(job => job.name === 'Build macOS')
  const artifactName = isolated ? `candidate-installers-${version}-${run.run_number}` : 'release-mac'
  const artifacts = api(`actions/runs/${buildRunId}/artifacts?per_page=100`)
  const [artifact, duplicate] = artifacts.artifacts.filter(item => item.name === artifactName && !item.expired)
  assert.ok(artifact && !duplicate, 'Expected one immutable macOS release artifact')
  assert.equal(artifact.workflow_run.head_sha, run.head_sha)
  const source = validateMacStartupArtifact({ repository, workflow: run.path, runId: Number(buildRunId), runAttempt: run.run_attempt,
    sourceHead: run.head_sha, driverHead, buildConclusion: build?.conclusion, artifactName: artifact.name, artifactId: artifact.id,
    artifactDigest: artifact.digest, artifactExpired: artifact.expired,
    ...(isolated ? { mode: 'isolated-candidate', version, event: run.event, runNumber: run.run_number,
      candidateConclusion: jobs.jobs.find(job => job.name === 'Verify three-client candidate')?.conclusion,
      publicationConclusion: jobs.jobs.find(job => job.name === 'Publish GitHub Release')?.conclusion } : {}),
    changedFiles: git('diff', '--name-only', run.head_sha, driverHead).split('\n').filter(Boolean) })
  await writeFile(sourceFile, `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' })
  await appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${source.artifactId}\n`)
}

function isolatedMacEnvironment(environment, root, candidate) {
  const home = join(root, 'home')
  return { PATH: environment.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: root,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    ...(candidate ? { WORKWISE_CANDIDATE: '1', WORKWISE_CANDIDATE_ROOT: root,
      WORKWISE_CANDIDATE_USER_DATA: join(root, 'profile'), WORKWISE_CANDIDATE_HOME: home,
      WORKWISE_CANDIDATE_OUTBOUND_DISABLED: '1', WORKWISE_CANDIDATE_INBOUND_DISABLED: '1', WORKWISE_CANDIDATE_CREDENTIAL_ACCESS: '0' } : {}) }
}

export async function observeMacStartupCase(observe, expected) {
  try { return await observe(expected) } catch (error) {
    // Only a missing incidental English capture gets one fresh native launch.
    // Geometry, font, identity and workbook failures remain terminal.
    if (expected.locale !== 'en' || error.code !== 'STARTUP_CAPTURE_MISSED') throw error
    return observe({ ...expected, captureAttempt: 1, screenshotName: expected.screenshotName.replace(/\.png$/, '-retry.png') })
  }
}

async function verify(directory, sourceFile, evidenceDir, temporary) {
  const source = validateMacStartupArtifact(await json(sourceFile))
  assert.equal(source.driverHead, process.env.GITHUB_SHA)
  const isolated = source.mode === 'isolated-candidate'
  assert.equal(isolated, process.env.EXACT_MAC_ISOLATED_CANDIDATE === 'true')
  const { version } = await json(new URL('../package.json', import.meta.url))
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const publishedArch = process.arch === 'arm64' ? 'Apple-Silicon' : 'Intel'
  const name = `RailWise-AI-${version}-mac-${isolated ? publishedArch : process.arch}.dmg`
  const installer = join(directory, name)
  const digest = await sha256(installer)
  const size = (await stat(installer)).size
  if (isolated) {
    assert.equal(source.version, version)
    assert.ok((await lstat(installer)).isFile() && size > 0)
    const files = parseMacCandidateChecksums(await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8'), version)
    assert.equal(digest, files.get(name), 'Installer digest from the isolated Actions artifact must match')
  } else {
    const receipt = await json(join(directory, 'reviewed-build.json'))
    for (const name of ['runId', 'runAttempt', 'sourceHead']) assert.equal(receipt[name], source[name])
    assert.equal(receipt.version, version)
    const record = receipt.files.find(file => file.name === name)
    assert.equal(digest, record?.sha256)
    assert.equal(size, record.size)
  }
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
    artifactMode: isolated ? 'isolated-candidate' : 'reviewed',
    installer: { name, sha256: digest, size, ...(isolated ? { checksumsVerified: true, published: false } : {}) },
    installed: { bundleId: info.CFBundleIdentifier, installedArch,
      signature: 'verified', notarization: 'staple-verified', asarSha256: installedAsarSha256 }, observations: [] }
  try {
    if (isolated) {
      assert.match(await readFile(join(install, 'Contents', 'Resources', 'app-update.yml'), 'utf8'), /^\s*url:\s*https:\/\/127\.0\.0\.1\/\s*$/m)
      report.installed.updateFeed = 'loopback-only'
    }
    const failures = []
    report.scope = isolated && process.arch === 'arm64' ? 'primary-Chinese-dark-native-startup-and-workbook' : 'primary-Chinese-dark-native-startup'
    report.supplementalStartupCaptureGaps = []
    for (const expected of [{ locale: 'en', htmlLang: 'en', theme: 'light' }, { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark' }]) {
      try {
        report.observations.push(await observeMacStartupCase(attempt => observeInstalledStartup({ executable, version, evidenceDir, temporary }, attempt,
          { connectCdp, environmentForRoot: (env, root) => isolatedMacEnvironment(env, root, isolated),
            ...(isolated && process.arch === 'arm64' && expected.locale === 'zh'
              ? { onWorkbenchReady: (cdp, paths) => verifyMacWorkbook(cdp, paths, evidenceDir) } : {}) }),
        { ...expected, screenshotName: `mac-startup-${expected.locale}-${expected.theme}.png` }))
      } catch (error) {
        if (expected.locale === 'en' && error.code === 'STARTUP_CAPTURE_MISSED') {
          report.supplementalStartupCaptureGaps.push({ locale: expected.locale, theme: expected.theme, attempts: 2, status: 'not-captured', error: error.message })
        } else failures.push(`${expected.locale}/${expected.theme}: ${error.message}`)
      }
    }
    assert.equal(await sha256(path), installedAsarSha256)
    assert.equal(failures.length, 0, failures.join('; '))
    report.status = 'passed'
  } catch (error) {
    report.error = error.message
    throw error
  } finally {
    await writeFile(join(evidenceDir, 'mac-startup-appearance.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
}

async function main([mode, directory, source, evidenceDir, arch]) {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'macOS')
  const temporary = resolve(process.env.RUNNER_TEMP)
  const assertOwned = path => {
    const child = relative(temporary, resolve(path))
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'macOS acceptance paths must be owned by the runner')
  }
  if (mode === '--prepare') {
    assert.equal(process.arch, evidenceDir)
    assertOwned(source)
    return prepare(directory, source)
  }
  assert.equal(mode, '--run')
  assert.equal(process.arch, arch)
  for (const path of [directory, source, evidenceDir]) assertOwned(path)
  return verify(directory, source, evidenceDir, temporary)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
