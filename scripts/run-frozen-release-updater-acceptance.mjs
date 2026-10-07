#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parse } from 'yaml'
import { PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW, validateReviewedBuild, verifyReviewedBuildSource, verifyDownloadedReleaseArtifacts } from './verify-reviewed-release-artifacts.mjs'
import { hashFile, startFrozenReleaseFeed } from './frozen-release-updater-feed.mjs'
import { assertRetainedFiles, snapshotFiles } from './frozen-release-updater-data.mjs'
import { boundedCommand } from './updater-acceptance-process.mjs'

const require = createRequire(import.meta.url)
const scriptRoot = dirname(fileURLToPath(import.meta.url))
const BASE_VERSION = '0.5.2'; const TARGET_VERSION = '0.5.3'
const FROZEN_UPDATER_WORKFLOW_REF = `${RELEASE_REPOSITORY}/.github/workflows/frozen-release-updater-acceptance.yml@refs/heads/main`
const UPDATE_URL = 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/'
export const BASELINE_PINS = Object.freeze({
  arm64: { name: 'WorkWise-0.5.2-mac-Apple-Silicon.dmg', size: 301766076, sha256: '09dae4a270bbf06fb3fc79771eef3faa2afaba43eea9e6696762fa7ba5cf99e0', assetId: 612608487 },
  x64: { name: 'WorkWise-0.5.2-mac-Intel.dmg', size: 306711696, sha256: '8368322a563871e00e6e9ac99b661bf0ee120a20d48f8ebd3e105209cdba20d4', assetId: 612608490 }
})
export const CLOUDFLARED_PINS = Object.freeze({
  version: '2026.10.0',
  arm64: { name: 'cloudflared-darwin-arm64.tgz', size: 19809074, sha256: 'a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70' },
  x64: { name: 'cloudflared-darwin-amd64.tgz', size: 21741581, sha256: '903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f' }
})

function equal(actual, expected, label) { if (actual !== expected) throw new Error(`${label} mismatch.`) }
function argument(name) { return process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) }
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

export function sanitizeRetainedText(value, secrets = [], env = process.env) {
  let output = String(value).slice(-250_000)
  for (const secret of [...secrets, ...Object.entries(env).filter(([name]) => /SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY/i.test(name)).map(([, text]) => text)]) {
    if (secret?.length >= 4) output = output.replaceAll(secret, '[redacted]')
  }
  return output.replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?:\/[^\s"'<>]*)?/gi, '[temporary HTTPS feed redacted]')
    .replace(/\/private-[a-f0-9]{64}(?:\/)?/gi, '/private-[redacted]/')
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s,"'}]+/gi, '$1[redacted]')
}

export function requireFrozenRunner(env = process.env, platform = process.platform, home = homedir()) {
  if (platform !== 'darwin' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'macOS'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !isAbsolute(env.RUNNER_TEMP ?? '') || !isAbsolute(home)
    || env.GITHUB_REPOSITORY !== RELEASE_REPOSITORY
    || env.GITHUB_WORKFLOW_REF !== FROZEN_UPDATER_WORKFLOW_REF) {
    throw new Error('Historical public updater acceptance requires its trusted fresh GitHub-hosted macOS workflow.')
  }
  if (Object.keys(env).some(name => /^(?:WORKWISE_CANDIDATE|WORKWISE_UPDATE_|WORKWISE_PUBLIC_BASE_URL|RELEASE_CHANNEL)/.test(name) && env[name])) {
    throw new Error('Candidate or external updater overrides are forbidden for the public baseline.')
  }
}

export function productPaths(home) {
  return [...['RailWise AI', 'WorkWise', 'workwise', 'workgpt', 'WORKGPT', 'Kun', 'deepseek-gui', 'DeepSeek GUI'].map(name => join(home, 'Library/Application Support', name)),
    ...['.workwise', '.workgpt', '.kun'].map(name => join(home, name)),
    join(home, 'Library/Caches/workwise-updater'), join(home, 'Library/Caches/com.wangjiawei508.workgpt.ShipIt')]
}

export function assertFreshProfile(home, exists = existsSync) {
  if (productPaths(home).some(exists)) throw new Error('Existing product data or updater cache detected; refusing to reuse or delete it.')
}

export function validatePublicBundle(info, metadata, updater, version, head) {
  equal(info.CFBundleIdentifier, PUBLIC_IDENTITY.bundleId, 'Public bundle ID')
  equal(info.CFBundleExecutable, PUBLIC_IDENTITY.productName, 'Public executable')
  equal(info.CFBundleShortVersionString, version, 'Public bundle version')
  equal(metadata.name, PUBLIC_IDENTITY.packageName, 'Public package name')
  equal(metadata.productName, PUBLIC_IDENTITY.productName, 'Public product name')
  equal(metadata.version, version, 'Packaged version')
  equal(updater.provider, 'generic', 'Public updater provider')
  equal(updater.url, UPDATE_URL, 'Public updater URL')
  equal(updater.updaterCacheDirName, 'workwise-updater', 'Public updater cache')
  if (head) {
    equal(metadata.buildProvenance?.sourceHead, head, 'Frozen source HEAD')
    equal(metadata.buildHints?.macSigningEnabled, true, 'Packaged signing flag')
    equal(metadata.buildHints?.notarizationEnabled, true, 'Packaged notarization flag')
    equal(metadata.updateChannel, 'stable', 'Packaged update channel')
  }
}

function verifyBundle(app, version, head, run) {
  const resources = join(app, 'Contents/Resources')
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]).stdout)
  const metadata = JSON.parse(require('@electron/asar').extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8'))
  validatePublicBundle(info, metadata, parse(readFileSync(join(resources, 'app-update.yml'), 'utf8')), version, head)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  run('/usr/bin/xcrun', ['stapler', 'validate', app])
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app])
  const signed = run('/usr/bin/codesign', ['-d', '-r-', app])
  const requirements = [...new Set(`${signed.stdout}\n${signed.stderr}`.split(/\r?\n/).filter(line => line.startsWith('designated => ')))]
  if (requirements.length !== 1) throw new Error('Public designated requirement is unavailable or ambiguous.')
  return { version, bundleId: info.CFBundleIdentifier, signature: 'verified', stapledNotarization: 'verified', gatekeeper: 'accepted', designatedRequirement: requirements[0] }
}

export function validateNativeReport(report, arch) {
  equal(report.schemaVersion, 1, 'Native report schema')
  equal(report.status, 'passed', 'Native updater status'); equal(report.platform, 'darwin', 'Native platform'); equal(report.arch, arch, 'Native architecture')
  equal(report.baseVersion, BASE_VERSION, 'Native baseline'); equal(report.targetVersion, TARGET_VERSION, 'Native target')
  equal(report.browserOpened, false, 'No browser path'); equal(report.userDataPreserved, true, 'Native data probe')
  const names = ['base_started', 'update_available', 'download_completed', 'install_requested', 'target_relaunched', 'user_data_preserved']
  equal(JSON.stringify(report.stages?.map(stage => stage.name)), JSON.stringify(names), 'Native updater stages')
  equal(report.stages.at(-1).detail, BASE_VERSION, 'Strict nonce probe, excluding legacy-state acceptance')
}

export function validateTunnelUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error('Unexpected temporary tunnel URL.')
  return url.origin
}

export async function downloadPinned(url, destination, pin) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Pinned asset download failed (${response.status}).`)
  if (response.headers.has('content-length') && Number(response.headers.get('content-length')) !== pin.size) throw new Error('Pinned asset Content-Length mismatch.')
  let size = 0
  const hash = createHash('sha256')
  const stream = Readable.fromWeb(response.body)
  stream.on('data', chunk => { size += chunk.length; hash.update(chunk); if (size > pin.size) stream.destroy(new Error('Pinned asset exceeded expected size.')) })
  await pipeline(stream, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  if (size !== pin.size || hash.digest('hex') !== pin.sha256) throw new Error('Pinned asset size or SHA256 mismatch.')
}

function cleanChildEnvironment(root) {
  const env = { ...process.env, TMPDIR: join(root, 'native-temp') }
  for (const name of Object.keys(env)) if (/SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|P12_BASE64|^(?:CSC_|APPLE_|MAC_CODESIGN_|R2_|S3_|WORKWISE_WEBSITE_|WORKWISE_CANDIDATE|WORKWISE_UPDATE_)|^(?:RELEASE_CHANNEL|WORKWISE_PUBLIC_BASE_URL)$/i.test(name)) delete env[name]
  return env
}

function startCapturedProcess(command, args, { env, logPath, timeoutMs }) {
  const log = openSync(logPath, 'wx', 0o600)
  const child = spawn(command, args, { env, stdio: ['ignore', log, log], detached: true })
  closeSync(log)
  let expired = false
  const timer = setTimeout(() => { expired = true; try { process.kill(-child.pid, 'SIGKILL') } catch { /* The process already exited. */ } }, timeoutMs)
  const completed = new Promise((resolveProcess, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveProcess() : reject(new Error(expired ? 'Owned acceptance process timed out.' : `Owned acceptance process failed (${code}, ${signal}).`)))
  }).finally(() => clearTimeout(timer))
  // Attach a rejection handler while the caller inspects incremental files.
  completed.catch(() => {})
  return { child, completed, stop: () => { try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error } } }
}

async function startTunnel(executable, origin, root, env) {
  const logPath = join(root, 'cloudflared.log')
  const processRun = startCapturedProcess(executable, ['tunnel', '--url', origin, '--no-autoupdate', '--loglevel', 'info'], { env, logPath, timeoutMs: 30 * 60_000 })
  const deadline = Date.now() + 90_000
  try {
    while (Date.now() < deadline) {
      const log = readFileSync(logPath, 'utf8')
      const urls = [...new Set(log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g) ?? [])]
      if (urls.length === 1) return { ...processRun, url: validateTunnelUrl(urls[0]) }
      if (urls.length > 1) throw new Error('Tunnel yielded ambiguous endpoints.')
      if (processRun.child.exitCode !== null) throw new Error('Temporary tunnel stopped before readiness.')
      await delay(500)
    }
    throw new Error('Temporary tunnel readiness timed out.')
  } catch (error) { processRun.stop(); await processRun.completed.catch(() => {}); throw error }
}

async function downloadFrozenArtifacts(build, root, run) {
  const downloads = join(root, 'downloads'); mkdirSync(downloads)
  for (const artifact of build.artifacts) {
    const archive = join(root, `${artifact.name}.zip`)
    const fd = openSync(archive, 'wx', 0o600)
    try { run('gh', ['api', '--hostname', 'github.com', `repos/${RELEASE_REPOSITORY}/actions/artifacts/${artifact.id}/zip`], { stdio: ['ignore', fd, 'pipe'], timeoutMs: 15 * 60_000 }) }
    finally { closeSync(fd) }
    equal(`sha256:${await hashFile(archive)}`, artifact.digest, 'Immutable artifact archive digest')
    const names = run('/usr/bin/unzip', ['-Z1', archive]).stdout.trim().split(/\r?\n/)
    const expected = [...build.files.filter(file => file.artifact === artifact.name).map(file => file.name), 'reviewed-build.json'].sort()
    equal(JSON.stringify(names.sort()), JSON.stringify(expected), 'Artifact archive entry set')
    const directory = join(downloads, artifact.name); mkdirSync(directory)
    run('/usr/bin/ditto', ['-x', '-k', archive, directory])
  }
  const output = join(root, 'verified')
  await verifyDownloadedReleaseArtifacts({ build, version: TARGET_VERSION, sourceHead: build.sourceHead, downloads, output })
  return output
}

function installBaseline(dmg, root, run) {
  const mount = join(root, 'mount'); mkdirSync(mount)
  run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount])
  try {
    const apps = readdirSync(mount).filter(name => name.endsWith('.app'))
    equal(JSON.stringify(apps), JSON.stringify(['RailWise AI.app']), 'Official baseline DMG bundle')
    const app = join(root, 'baseline/RailWise AI.app'); mkdirSync(dirname(app))
    run('/usr/bin/ditto', [join(mount, apps[0]), app]); return app
  } finally { run('/usr/bin/hdiutil', ['detach', mount]) }
}

function fixture(app, mode, root, paths, env, run) {
  const report = join(root, `${mode}-data.json`)
  run(join(app, 'Contents/MacOS/RailWise AI'), [join(scriptRoot, 'frozen-release-updater-data.mjs'), `--mode=${mode}`, `--app=${app}`, `--data-dir=${paths.data}`, `--workspace=${paths.workspace}`, `--snapshot=${join(root, 'data-baseline.json')}`, `--report=${report}`], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 5 * 60_000 })
  return JSON.parse(readFileSync(report, 'utf8'))
}

function seedConfiguration(paths) {
  mkdirSync(paths.profile, { recursive: true, mode: 0o700 })
  const refs = {
    'mcp-v2.json': JSON.stringify({ schema: 'workwise.mcp-servers', version: 2, revision: 1, mutationKeys: {}, servers: [{ id: 'synthetic-disabled-mcp', name: 'Synthetic disabled reference', scope: 'global', transport: 'http', url: 'https://example.invalid/mcp', source: 'manual', enabled: false, timeoutMs: 30000, toolPolicy: {}, revision: 1, credentialRef: { id: 'synthetic-reference-only', storage: 'encrypted-file' } }] }),
    'marketplace/imports/synthetic-plugin/manifest.json': JSON.stringify({ name: 'synthetic-reference-only', enabled: false, mcp: { configPath: 'mcp-v2.json' }, skill: { path: 'synthetic-skill/SKILL.md' } }),
    'synthetic-skill/SKILL.md': '---\nname: synthetic-reference-only\ndescription: Inert update preservation fixture\n---\nSynthetic text; never activated.\n'
  }
  for (const [name, value] of Object.entries(refs)) { const path = join(paths.workwise, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value + '\n', { flag: 'wx', mode: 0o600 }) }
  const sentinel = randomBytes(32).toString('hex')
  writeFileSync(join(paths.profile, 'frozen-release-sentinel.json'), JSON.stringify({ purpose: 'separate native updater preservation probe', sentinel }) + '\n', { flag: 'wx', mode: 0o600 })
  return { refs, sentinel }
}

async function observeStrictProbe(profile, processRun) {
  let finished = false; processRun.completed.finally(() => { finished = true }).catch(() => {})
  const deadline = Date.now() + 25 * 60_000
  while (!finished && Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(join(profile, 'updater-acceptance-state.json'), 'utf8'))
      const probe = JSON.parse(readFileSync(join(profile, 'updater-acceptance-user-data-probe.json'), 'utf8'))
      if (state.probeRequired === true && /^[a-f0-9-]{36}$/i.test(probe.nonce) && probe.baseVersion === BASE_VERSION
        && JSON.stringify(state.probe) === JSON.stringify(probe)) return { nonceSha256: createHash('sha256').update(probe.nonce).digest('hex'), strictProbeRequired: true }
    } catch { /* The baseline writes these probe files asynchronously. */ }
    await delay(50)
  }
  throw new Error('Did not observe a matching strict nonce probe from the official baseline.')
}

export async function stopOwnedApplications(nativeRoot, run, {
  kill = process.kill,
  sleep = delay,
  now = Date.now,
  termTimeoutMs = 10_000,
  killTimeoutMs = 2_000,
  pollMs = 100
} = {}) {
  if (!existsSync(nativeRoot)) return
  const roots = readdirSync(nativeRoot)
    .filter(name => /^workwise-native-updater-/.test(name))
    .map(name => join(nativeRoot, name, 'Applications') + '/')
  if (roots.length === 0) return

  const ownedPids = () => run('/bin/ps', ['-axo', 'pid=,command=']).stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || Number(match[1]) === process.pid || !roots.some(prefix => match[2].includes(prefix))) return []
    return [Number(match[1])]
  })
  const signal = (pid, name) => {
    try { kill(pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const waitForExit = async (deadline) => {
    while (true) {
      const pids = ownedPids()
      if (pids.length === 0) return []
      if (now() >= deadline) return pids
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())))
    }
  }

  let pids = ownedPids()
  for (const pid of pids) signal(pid, 'SIGTERM')
  pids = await waitForExit(now() + termTimeoutMs)
  if (pids.length === 0) return

  for (const pid of pids) signal(pid, 'SIGKILL')
  pids = await waitForExit(now() + killTimeoutMs)
  if (pids.length > 0) throw new Error(`Owned native updater process cleanup failed; still running: ${pids.join(', ')}.`)
}

export async function main() {
  const evidence = resolve(argument('evidence-dir') ?? '')
  requireFrozenRunner()
  const runnerTemp = realpathSync(process.env.RUNNER_TEMP)
  if (!argument('evidence-dir') || !evidence.startsWith(runnerTemp + '/') || existsSync(evidence)) throw new Error('Evidence must be a new directory beneath RUNNER_TEMP.')
  mkdirSync(evidence, { mode: 0o700 })
  const root = mkdtempSync(join(runnerTemp, 'railwise-frozen-update-'))
  const report = { schemaVersion: 1, status: 'running', baseVersion: BASE_VERSION, targetVersion: TARGET_VERSION, platform: 'darwin', arch: process.arch,
    productionTouched: false, systemTrustModified: false, officialFeedsModified: false, publicReleasePerformed: false,
    transport: 'Temporary externally reachable Cloudflare Quick Tunnel with default CA TLS and a 256-bit bearer capability path; no persistent remote storage.', steps: [] }
  const secrets = []
  const persist = () => { const path = join(evidence, 'frozen-updater.json'); writeFileSync(path + '.tmp', sanitizeRetainedText(JSON.stringify(report, null, 2), secrets) + '\n', { mode: 0o600 }); renameSync(path + '.tmp', path) }
  const progress = event => { report.steps.push({ ...event, at: new Date().toISOString() }); persist(); console.info(`[frozen-native-updater] ${event.operation}: ${event.status}`) }
  const run = (command, args, options = {}) => boundedCommand(command, args, { progress, ...options })
  let feed; let tunnel; let harness; let ownsProfile = false
  const home = homedir(); const paths = { workwise: join(home, '.workwise'), profile: join(home, 'Library/Application Support/RailWise AI'), data: join(home, '.workwise/runtime/engineering'), workspace: join(home, '.workwise/default_workspace') }
  const env = cleanChildEnvironment(root)
  persist()
  try {
    if (!['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported runner architecture.')
    assertFreshProfile(home)
    const build = JSON.parse(readFileSync(resolve(argument('build-file')), 'utf8'))
    validateReviewedBuild(build, { version: TARGET_VERSION, sourceHead: build.sourceHead })
    verifyReviewedBuildSource(build, { version: TARGET_VERSION, sourceHead: build.sourceHead })
    report.reviewedBuild = build
    const verified = await downloadFrozenArtifacts(build, root, run)
    // Recheck immutable provenance after transport and before launching either package.
    verifyReviewedBuildSource(build, { version: TARGET_VERSION, sourceHead: build.sourceHead })
    const pin = BASELINE_PINS[process.arch]; const baselineDmg = join(root, pin.name)
    await downloadPinned(`https://github.com/${RELEASE_REPOSITORY}/releases/download/v${BASE_VERSION}/${pin.name}`, baselineDmg, pin)
    report.baselineAsset = { tag: 'v0.5.2', ...pin }
    const baseline = installBaseline(baselineDmg, root, run)
    report.baselineIdentity = verifyBundle(baseline, BASE_VERSION, undefined, run)
    const targetZip = join(verified, `WorkWise-${TARGET_VERSION}-mac-${process.arch}.zip`)
    const targetRoot = join(root, 'target'); mkdirSync(targetRoot)
    const zipEntries = run('/usr/bin/unzip', ['-Z1', targetZip], { maxBuffer: 20 * 1024 * 1024 }).stdout.trim().split(/\r?\n/)
    if (zipEntries.some(name => !/^(?:RailWise AI\.app|__MACOSX)(?:\/|$)/.test(name) || name.split('/').includes('..'))) throw new Error('Target ZIP has entries outside its public app bundle.')
    run('/usr/bin/ditto', ['-x', '-k', targetZip, targetRoot])
    const target = join(targetRoot, 'RailWise AI.app')
    report.targetIdentity = verifyBundle(target, TARGET_VERSION, build.sourceHead, run)
    equal(report.targetIdentity.designatedRequirement, report.baselineIdentity.designatedRequirement, 'Baseline/target signing requirement')
    report.targetZipSha256 = await hashFile(targetZip)
    report.targetAsarSha256 = await hashFile(join(target, 'Contents/Resources/app.asar'))
    const cloudPin = CLOUDFLARED_PINS[process.arch]; const cloudArchive = join(root, cloudPin.name)
    await downloadPinned(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_PINS.version}/${cloudPin.name}`, cloudArchive, cloudPin)
    const cloudEntries = run('/usr/bin/tar', ['-tzf', cloudArchive]).stdout.trim().split(/\r?\n/)
    if (cloudEntries.length !== 1 || !['cloudflared', './cloudflared'].includes(cloudEntries[0])) throw new Error('Pinned tunnel archive entry mismatch.')
    run('/usr/bin/tar', ['-xzf', cloudArchive, '-C', root]); chmodSync(join(root, 'cloudflared'), 0o700)
    report.cloudflared = { version: CLOUDFLARED_PINS.version, ...cloudPin }
    mkdirSync(join(root, 'native-temp'))
    assertFreshProfile(home); ownsProfile = true
    report.dataSeed = fixture(baseline, 'seed', root, paths, env, run)
    seedConfiguration(paths)
    const beforeRefs = snapshotFiles(paths.workwise)
    const beforeSentinel = readFileSync(join(paths.profile, 'frozen-release-sentinel.json'))
    feed = await startFrozenReleaseFeed({ zipPath: targetZip, manifestPath: join(verified, 'latest-mac.yml'), version: TARGET_VERSION, arch: process.arch })
    secrets.push(feed.prefix)
    tunnel = await startTunnel(join(root, 'cloudflared'), feed.origin, root, env)
    secrets.push(tunnel.url)
    const feedUrl = tunnel.url + feed.prefix
    const check = await fetch(feedUrl + 'latest-mac.yml', { signal: AbortSignal.timeout(30_000) })
    if (!check.ok || createHash('sha256').update(Buffer.from(await check.arrayBuffer())).digest('hex') !== feed.manifestSha256) throw new Error('Temporary default-CA HTTPS feed did not return the frozen manifest.')
    const beforeNativeRequests = { ...feed.requests }
    harness = startCapturedProcess(process.execPath, [join(scriptRoot, 'run-native-updater-acceptance.mjs'), `--installer=${baselineDmg}`, `--feed-url=${feedUrl}`, `--base-version=${BASE_VERSION}`, `--target-version=${TARGET_VERSION}`, '--channel=frontier', `--expected-arch=${process.arch}`, `--report=${join(root, 'native-updater.json')}`], { env, logPath: join(root, 'harness.log'), timeoutMs: 25 * 60_000 })
    report.strictNonceProbe = await observeStrictProbe(paths.profile, harness)
    await harness.completed
    const native = JSON.parse(readFileSync(join(root, 'native-updater.json'), 'utf8'))
    validateNativeReport(native, process.arch)
    if (feed.requests.manifest <= beforeNativeRequests.manifest || feed.requests.zip <= beforeNativeRequests.zip || feed.requests.bytesServed < lstatSync(targetZip).size) throw new Error('Native updater did not fetch the actual manifest and complete ZIP.')
    const nativeRoots = readdirSync(join(root, 'native-temp')).filter(name => /^workwise-native-updater-/.test(name))
    equal(nativeRoots.length, 1, 'Owned native installation count')
    const installed = join(root, 'native-temp', nativeRoots[0], 'Applications/RailWise AI.app')
    report.installedIdentity = verifyBundle(installed, TARGET_VERSION, build.sourceHead, run)
    report.installedAsarSha256 = await hashFile(join(installed, 'Contents/Resources/app.asar'))
    equal(report.installedAsarSha256, report.targetAsarSha256, 'Installed/exact frozen ZIP ASAR')
    equal(readFileSync(join(paths.profile, 'frozen-release-sentinel.json')).toString(), beforeSentinel.toString(), 'Independent user-data sentinel')
    report.dataReadback = fixture(installed, 'verify', root, paths, env, run)
    report.dataRestartReadback = fixture(installed, 'verify', root, paths, env, run)
    assertRetainedFiles(beforeRefs, snapshotFiles(paths.workwise))
    report.configReferences = { status: 'byte-preserved', kinds: ['disabled MCP', 'plugin manifest reference', 'Skill text', 'inert credential reference'], scope: 'Stored bytes only; updater acceptance exits before configuration activation. No real credential, plugin activation or complete catalog migration is certified.' }
    report.separateSentinelPreserved = true; report.feedRequests = feed.requests; report.frozenManifestSha256 = feed.manifestSha256
    report.status = 'passed'
    progress({ operation: 'real-native-update-and-historical-readback', status: 'completed' })
  } catch (error) {
    report.status = 'failed'; report.failure = sanitizeRetainedText(error.message, secrets)
    progress({ operation: 'acceptance', status: 'failed' })
  } finally {
    for (const name of ['native-updater.json', 'native-updater.log', 'harness.log', 'cloudflared.log', 'seed-data.json', 'verify-data.json']) {
      const path = join(root, name)
      if (existsSync(path)) writeFileSync(join(evidence, name.endsWith('.log') ? name.replace('.log', '.redacted.log') : name), sanitizeRetainedText(readFileSync(path, 'utf8'), secrets) + '\n', { mode: 0o600 })
    }
    let ownedApplicationsStopped = false
    const actions = [async () => { harness?.stop(); await harness?.completed.catch(() => {}) }, async () => { tunnel?.stop(); await tunnel?.completed.catch(() => {}) }, () => feed?.close(),
      async () => { await stopOwnedApplications(join(root, 'native-temp'), run); ownedApplicationsStopped = true },
      () => {
        if (!ownedApplicationsStopped) throw new Error('Owned application cleanup was not confirmed; retaining user data and native temp directories.')
        if (ownsProfile) for (const path of [paths.profile, paths.workwise, join(home, 'Library/Caches/workwise-updater'), join(home, 'Library/Caches/com.wangjiawei508.workgpt.ShipIt')]) rmSync(path, { recursive: true, force: true })
      },
      () => { if (!ownedApplicationsStopped) throw new Error('Owned application cleanup was not confirmed; retaining acceptance root.') ; rmSync(root, { recursive: true, force: true }) }]
    for (const action of actions) try { await action() } catch (error) { report.status = 'failed'; report.failure = `${report.failure ?? ''} Cleanup: ${sanitizeRetainedText(error.message, secrets)}`.trim() }
    progress({ operation: 'owned-resource-cleanup', status: report.status === 'passed' ? 'completed' : 'failed' })
  }
  if (report.status !== 'passed') throw new Error(report.failure)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`[frozen-native-updater] ${sanitizeRetainedText(error.message)}`); process.exitCode = 1 })
