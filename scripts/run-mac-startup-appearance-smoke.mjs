import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { connectCdp } from './run-windows-ui-smoke.mjs'
import { observeInstalledStartup } from './verify-packaged-startup-appearance.mjs'
import { PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'

const require = createRequire(import.meta.url)
const acceptedDriverFiles = new Set([
  '.github/workflows/windows-install-smoke.yml',
  'scripts/prepare-windows-install-smoke.test.mjs',
  'scripts/run-mac-startup-appearance-smoke.mjs',
  'scripts/run-windows-ui-smoke.mjs',
  'scripts/verify-packaged-startup-appearance.mjs',
  'scripts/verify-windows-startup-appearance.test.mjs'
])
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args) => command('git', args)
const json = (path) => readFile(path, 'utf8').then(JSON.parse)
export const macDeveloperIdRequirement = '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

export function validateMacStartupArtifact(source, { isolated = false } = {}) {
  assert.equal(source.repository, RELEASE_REPOSITORY)
  assert.equal(source.workflow, RELEASE_WORKFLOW)
  for (const sha of [source.sourceHead, source.driverHead]) assert.match(sha, /^[a-f0-9]{40}$/)
  for (const number of [source.runId, source.runAttempt, source.artifactId]) assert.match(String(number), /^[1-9]\d*$/)
  assert.equal(source.buildConclusion, 'success')
  assert.equal(source.artifactName, 'release-mac')
  assert.match(source.artifactDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(source.artifactExpired, false)
  assert.ok(Array.isArray(source.changedFiles) && source.changedFiles.every(file => acceptedDriverFiles.has(file)), 'Application source differs from the reviewed build')
  if (isolated) {
    assert.equal(source.classification, 'isolated-unreviewed')
    assert.equal(source.publicReleaseApproved, false)
    assert.equal(source.buildHead, source.sourceHead)
    assert.equal(source.buildJob, 'Build macOS')
    assert.match(String(source.buildJobId), /^[1-9]\d*$/)
  } else assert.equal(source.classification, undefined, 'An isolated source requires explicit opt-in')
  return source
}

async function prepare(buildRunId, sourceFile, isolated) {
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
  if (isolated) {
    assert.equal(run.event, 'workflow_dispatch')
    assert.equal(run.id, Number(buildRunId))
    assert.equal(build.run_id, run.id)
    assert.equal(build.run_attempt, run.run_attempt)
    assert.equal(artifact.workflow_run.id, run.id)
  }
  const source = validateMacStartupArtifact({ repository, workflow: run.path, runId: Number(buildRunId), runAttempt: run.run_attempt,
    sourceHead: run.head_sha, driverHead, buildConclusion: build?.conclusion, artifactName: artifact.name, artifactId: artifact.id,
    artifactDigest: artifact.digest, artifactExpired: artifact.expired,
    changedFiles: git('diff', '--name-only', run.head_sha, driverHead).split('\n').filter(Boolean),
    ...(isolated ? { classification: 'isolated-unreviewed', publicReleaseApproved: false,
      buildHead: build.head_sha, buildJob: build.name, buildJobId: build.id } : {}) }, { isolated })
  await writeFile(sourceFile, `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' })
  await appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${source.artifactId}\n`)
}

export function isolatedMacDmgMember(names, version, arch) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.ok(['arm64', 'x64'].includes(arch))
  const expected = ['latest-mac.yml', ...['arm64', 'x64'].flatMap(item =>
    ['dmg', 'zip'].map(extension => `RailWise-AI-${version}-mac-${item}.${extension}`))]
  assert.deepEqual([...names].sort(), expected.sort(), 'Unexpected isolated artifact entries')
  return `RailWise-AI-${version}-mac-${arch}.dmg`
}

async function isolatedMacInstaller(source, directory, version, arch, report) {
  await mkdir(directory, { recursive: true })
  const archive = join(directory, 'release-mac-archive.zip')
  const archiveFile = await open(archive, 'wx', 0o600)
  try {
    execFileSync('gh', ['api', '--hostname', 'github.com', `repos/${source.repository}/actions/artifacts/${source.artifactId}/zip`],
      { stdio: ['ignore', archiveFile.fd, 'pipe'], timeout: 10 * 60_000 })
  } finally { await archiveFile.close() }
  const archiveDigest = `sha256:${await sha256(archive)}`
  assert.equal(archiveDigest, source.artifactDigest, 'Immutable artifact archive digest')
  report.transport = { artifactId: source.artifactId, archiveDigest }
  const member = isolatedMacDmgMember(command('/usr/bin/unzip', ['-Z1', archive]).split(/\r?\n/), version, arch)
  const installer = join(directory, member)
  const output = await open(installer, 'wx', 0o600)
  try {
    execFileSync('/usr/bin/unzip', ['-p', archive, member], { stdio: ['ignore', output.fd, 'pipe'], timeout: 3 * 60_000 })
  } finally { await output.close() }
  report.transport.member = member
  return installer
}

export function validateIsolatedMacStartupBundle(packaged, updater) {
  assert.equal(packaged.updateChannel, 'frontier')
  assert.equal(packaged.buildHints?.macSigningEnabled, true)
  assert.equal(packaged.buildHints?.notarizationEnabled, true)
  assert.equal(updater.provider, 'generic')
  assert.equal(updater.url, 'https://127.0.0.1/')
}

export function gatekeeperEnforcement(statusOutput) {
  const match = /^\s*assessments (enabled|disabled)\s*$/i.exec(statusOutput ?? '')
  return match?.[1].toLowerCase() ?? 'unknown'
}

function isolatedMacEnvironment(environment, root) {
  const home = join(root, 'home')
  return { PATH: environment.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: root,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
}

async function reviewedMacInstaller(source, directory, version) {
  const receipt = await json(join(directory, 'reviewed-build.json'))
  for (const name of ['runId', 'runAttempt', 'sourceHead']) assert.equal(receipt[name], source[name])
  assert.equal(receipt.version, version)
  const name = `RailWise-AI-${version}-mac-${process.arch}.dmg`
  const installer = join(directory, name)
  const digest = await sha256(installer)
  const size = (await stat(installer)).size
  const record = receipt.files.find(file => file.name === name)
  assert.equal(digest, record?.sha256)
  assert.equal(size, record.size)
  return { installer, name, sha256: digest, size }
}

async function readInstalledStartupBundle(installer, temporary, source, version, isolated) {
  const root = await mkdtemp(join(temporary, 'railwise-mac-startup-'))
  const mountPoint = join(root, 'mounted')
  const install = join(root, 'RailWise AI.app')
  await mkdir(mountPoint)
  command('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, installer])
  try { command('/usr/bin/ditto', [join(mountPoint, 'RailWise AI.app'), install]) }
  finally { command('/usr/bin/hdiutil', ['detach', mountPoint]) }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', install])
  command('/usr/bin/xcrun', ['stapler', 'validate', install])
  let gatekeeper
  if (isolated) {
    command('/usr/bin/codesign', ['--verify', '-R', macDeveloperIdRequirement, install])
    const status = spawnSync('/usr/sbin/spctl', ['--status'], { encoding: 'utf8', timeout: 10_000 })
    command('/usr/sbin/spctl', ['--assess', '--type', 'execute', install])
    gatekeeper = { assessment: 'succeeded', enforcement: gatekeeperEnforcement(status.stdout), statusCommandExitCode: status.status }
  }
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
  if (isolated) {
    const updater = parse(await readFile(join(install, 'Contents', 'Resources', 'app-update.yml'), 'utf8'))
    validateIsolatedMacStartupBundle(packaged, updater)
  }
  return { executable, asarPath: path, installed: { bundleId: info.CFBundleIdentifier, installedArch,
    signature: 'verified', notarization: 'staple-verified', asarSha256: await sha256(path),
    ...(isolated ? { developerId: 'verified', gatekeeper, updateChannel: packaged.updateChannel } : {}) } }
}

async function verify(directory, sourceFile, evidenceDir, temporary, isolated) {
  const source = validateMacStartupArtifact(await json(sourceFile), { isolated })
  assert.equal(source.driverHead, process.env.GITHUB_SHA)
  const { version } = await json(new URL('../package.json', import.meta.url))
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const report = { schemaVersion: 1, status: 'failed', source, arch: process.arch, version,
    ...(isolated ? { classification: 'isolated-unreviewed', publicReleaseApproved: false, productionTouched: false } : {}), observations: [] }
  await mkdir(evidenceDir, { recursive: true })
  try {
    let installer
    if (isolated) {
      installer = await isolatedMacInstaller(source, directory, version, process.arch, report)
      report.installer = { name: report.transport.member, sha256: await sha256(installer), size: (await stat(installer)).size }
      assert.ok(report.installer.size > 0, 'Empty macOS installer archive member')
    } else {
      const { installer: installerPath, ...identity } = await reviewedMacInstaller(source, directory, version)
      installer = installerPath
      report.installer = identity
    }
    const bundle = await readInstalledStartupBundle(installer, temporary, source, version, isolated)
    report.installed = bundle.installed
    for (const expected of [{ locale: 'en', htmlLang: 'en', theme: 'light' }, { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark' }]) {
      report.observations.push(await observeInstalledStartup({ executable: bundle.executable, version, evidenceDir, temporary }, expected,
        { connectCdp, environmentForRoot: isolatedMacEnvironment }))
    }
    assert.equal(await sha256(bundle.asarPath), bundle.installed.asarSha256)
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
  const isolated = process.env.MAC_STARTUP_ISOLATED_ARTIFACT === 'true'
  if (mode === '--prepare') {
    assert.equal(process.arch, evidenceDir)
    return prepare(directory, source, isolated)
  }
  assert.equal(mode, '--run')
  assert.equal(process.arch, arch)
  const temporary = resolve(process.env.RUNNER_TEMP)
  for (const path of [directory, source, evidenceDir]) {
    const child = relative(temporary, resolve(path))
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'macOS acceptance paths must be owned by the runner')
  }
  return verify(directory, source, evidenceDir, temporary, isolated)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
