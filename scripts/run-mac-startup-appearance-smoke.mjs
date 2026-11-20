import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'
import { connectCdp } from './run-windows-ui-smoke.mjs'
import { observeInstalledStartup } from './verify-packaged-startup-appearance.mjs'
import { PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'

const require = createRequire(import.meta.url)
const acceptedDriverFiles = new Set([
  '.github/workflows/windows-install-smoke.yml',
  'scripts/run-mac-startup-appearance-smoke.mjs',
  'scripts/run-windows-ui-smoke.mjs',
  'scripts/verify-packaged-startup-appearance.mjs'
])
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args) => command('git', args)
const json = (path) => readFile(path, 'utf8').then(JSON.parse)

async function checksum(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest(encoding)
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
  if (source.scope === 'private-isolated-candidate') {
    assert.equal(source.event, 'workflow_dispatch')
    assert.equal(source.frozenReceiptStep, 'skipped')
    assert.equal(source.publishJob, 'skipped')
    assert.equal(source.signedBuildStep, 'success')
    assert.equal(source.updateMetadataStep, 'success')
  } else assert.ok(source.scope === undefined || source.scope === 'frozen-public-identity', 'Unknown macOS acceptance source scope')
  return source
}

async function prepare(buildRunId, sourceFile) {
  assert.match(buildRunId, /^[1-9]\d*$/)
  const repository = process.env.GITHUB_REPOSITORY
  assert.equal(repository, RELEASE_REPOSITORY)
  const api = async (suffix) => {
    for (let attempt = 1; ; attempt++) {
      try { return JSON.parse(command('gh', ['api', `repos/${repository}/${suffix}`])) }
      catch (error) {
        const transient = /HTTP (?:429|5\d\d)|timeout|ETIMEDOUT|connection reset|unexpected EOF|temporary failure/i.test(String(error.stderr ?? error.message))
        if (!transient || attempt === 4) throw error
        await wait(750 * attempt)
      }
    }
  }
  const run = await api(`actions/runs/${buildRunId}`)
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.path, RELEASE_WORKFLOW)
  const driverHead = git('rev-parse', 'HEAD')
  assert.equal(driverHead, process.env.GITHUB_SHA)
  git('merge-base', '--is-ancestor', run.head_sha, driverHead)
  const [jobs, artifacts] = await Promise.all([
    api(`actions/runs/${buildRunId}/attempts/${run.run_attempt}/jobs?per_page=100`),
    api(`actions/runs/${buildRunId}/artifacts?per_page=100`)
  ])
  const [build, duplicateBuild] = jobs.jobs.filter(job => job.name === 'Build macOS')
  assert.ok(build && !duplicateBuild && build.status === 'completed', 'Expected one completed macOS build in the trusted run attempt')
  const step = name => build.steps.find(item => item.name === name)?.conclusion
  const frozenReceiptStep = step('Record frozen public package identity')
  const [artifact, duplicate] = artifacts.artifacts.filter(item => item.name === 'release-mac' && !item.expired)
  assert.ok(artifact && !duplicate, 'Expected one immutable macOS release artifact')
  assert.equal(artifact.workflow_run.head_sha, run.head_sha)
  assert.equal(artifact.workflow_run.id, Number(buildRunId))
  const source = validateMacStartupArtifact({ repository, workflow: run.path, runId: Number(buildRunId), runAttempt: run.run_attempt,
    sourceHead: run.head_sha, driverHead, buildConclusion: build?.conclusion, artifactName: artifact.name, artifactId: artifact.id,
    artifactDigest: artifact.digest, artifactExpired: artifact.expired,
    ...(frozenReceiptStep === 'skipped' ? { scope: 'private-isolated-candidate', event: run.event, frozenReceiptStep,
      publishJob: jobs.jobs.find(job => job.name === 'Publish GitHub Release')?.conclusion,
      signedBuildStep: step('Build signed macOS packages'), updateMetadataStep: step('Generate macOS update metadata') }
      : { scope: 'frozen-public-identity' }),
    changedFiles: git('diff', '--name-only', run.head_sha, driverHead).split('\n').filter(Boolean) })
  await writeFile(sourceFile, `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' })
  await appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${source.artifactId}\n`)
}

function isolatedMacEnvironment(environment, root) {
  const home = join(root, 'home')
  return { PATH: environment.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: root,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
}

const taskSmokeModel = 'railwise-mac-task-layout-fixture'
const taskSmokeTitle = '合成资料布局核对'
const taskSection = '.ds-task-workspace[aria-label="任务"]'
const taskSidebar = '.ds-task-sidebar[aria-label="任务列表"]'

async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return server.address().port
}

const closeServer = (server) => new Promise(done => { server.close(done); server.closeAllConnections() })

async function macTaskFixture() {
  const available = createServer()
  const runtimePort = await listen(available)
  await closeServer(available)
  let responses = 0
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: taskSmokeModel, object: 'model' }] }))
    } else if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      request.once('end', () => {
        responses++
        response.setHeader('Content-Type', 'text/event-stream')
        const choices = [{ index: 0, delta: { content: '已核对合成资料。' }, finish_reason: 'stop' }]
        response.end(`data: ${JSON.stringify({ id: taskSmokeModel, choices })}\n\ndata: [DONE]\n\n`)
      })
      request.resume()
    } else { response.writeHead(404); response.end() }
  })
  const port = await listen(server)
  return {
    provider: { id: taskSmokeModel, name: '本机合成验收', apiKey: 'synthetic-local-only',
      models: [taskSmokeModel], baseUrl: `http://127.0.0.1:${port}/v1`, endpointFormat: 'chat_completions' },
    runtimePort,
    observe: async (cdp, workspace) => observeMacTaskNavigation(cdp, workspace, () => responses),
    close: () => closeServer(server)
  }
}

async function observeMacTaskNavigation(cdp, workspace, responseCount) {
  let resizeMethod = 'native-window'
  const atMinimumWidth = 'Math.abs(innerWidth - 960) <= 2 && innerHeight >= 600'
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', {}, 2000)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 2000)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: 960, height: 680 } }, 2000)
    await cdp.wait(atMinimumWidth, 'the minimum-width macOS workbench', 3000)
  } catch {
    resizeMethod = 'renderer-viewport'
    const deviceScaleFactor = await cdp.evaluate('devicePixelRatio')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor, mobile: false }, 3000)
    await cdp.wait(atMinimumWidth, 'the minimum-width installed renderer')
  }
  await cdp.wait(`window.workwise.runtimeRequest('/v1/runtime/info','GET').then(result=>result.ok,()=>false)`, 'the owned KUN runtime', 45_000)
  const created = await cdp.evaluate(`(async () => {
    const response = await window.workwise.runtimeRequest('/v1/threads', 'POST', JSON.stringify({
      workspace: ${JSON.stringify(workspace)}, model: ${JSON.stringify(taskSmokeModel)}, mode: 'agent'
    }));
    if (!response.ok) throw new Error('Could not create the isolated test conversation');
    const thread = JSON.parse(response.body);
    return window.workwise.coordinateTaskCommand({ threadId: thread.id, intent: 'new', idempotencyKey: 'mac-task-navigation-fixture',
      request: { prompt: ${JSON.stringify(taskSmokeTitle)}, mode: 'agent' } });
  })()`)
  assert.equal(created.kind, 'task_started')
  assert.ok(created.task?.id)

  const showNavigation = async () => {
    if (!await cdp.evaluate(`Boolean(document.querySelector('#workbench-navigation')?.getClientRects().length)`)) {
      await cdp.click('button[aria-label="展开侧边栏"]')
    }
  }
  await showNavigation()
  await cdp.click('.ds-sidebar-shell button', '任务')
  await cdp.wait(`Boolean(document.querySelector(${JSON.stringify(taskSection)}))`, 'the installed task destination')
  await showNavigation()
  const sidebarObservation = await cdp.wait(`(() => {
    const element = document.querySelector(${JSON.stringify(taskSidebar)});
    const row = [...(element?.querySelectorAll('button') ?? [])].find(item => item.textContent.includes(${JSON.stringify(taskSmokeTitle)}));
    if (!row?.getClientRects().length) return null;
    const {left, right, width} = element.getBoundingClientRect();
    return { left, right, width, rowVisible: true };
  })()`, 'the original task in the left navigation')
  await cdp.click(`${taskSidebar} button`, taskSmokeTitle)
  const detailObservation = await cdp.wait(`(() => {
    const section = document.querySelector(${JSON.stringify(taskSection)});
    const article = section?.querySelector('article[aria-label="任务详情"]');
    if (!article?.innerText.includes('任务已完成') || !article.innerText.includes(${JSON.stringify(taskSmokeTitle)}) || article.closest('[inert]')) return null;
    const {left, right, width} = article.getBoundingClientRect();
    return { left, right, width, viewportWidth: innerWidth, viewportHeight: innerHeight,
      resultsVisible: [...article.querySelectorAll('h3')].some(item => item.textContent === '成果'),
      originalConversationAvailable: [...article.querySelectorAll('button')].some(item => item.textContent.trim() === '打开原会话') };
  })()`, 'the completed task overview at the minimum desktop width', 45_000)
  for (const geometry of [sidebarObservation, detailObservation]) {
    assert.ok(geometry.width > 0 && geometry.left >= -1 && geometry.right <= detailObservation.viewportWidth + 1)
  }
  assert.equal(detailObservation.resultsVisible, true)
  assert.equal(detailObservation.originalConversationAvailable, true)
  assert.ok(responseCount() > 0, 'The owned KUN runtime must have completed the synthetic task')
  return { source: 'real-installed-renderer-and-owned-runtime', resizeMethod, taskId: created.task.id,
    locale: 'zh-CN', sidebar: sidebarObservation, overview: detailObservation }
}

async function verify(directory, sourceFile, evidenceDir, temporary, taskOnly) {
  const source = validateMacStartupArtifact(await json(sourceFile))
  assert.equal(source.driverHead, process.env.GITHUB_SHA)
  const { version } = await json(new URL('../package.json', import.meta.url))
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const name = `RailWise-AI-${version}-mac-${process.arch}.dmg`
  const installer = join(directory, name)
  const stat = await lstat(installer)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'The exact installer must be a regular file')
  const size = stat.size
  const digest = await checksum(installer)
  const receipt = await json(join(directory, 'reviewed-build.json')).catch(error => {
    if (error.code !== 'ENOENT' || source.scope !== 'private-isolated-candidate') throw error
  })
  let digestSource = 'frozen-reviewed-build'
  if (receipt !== undefined) {
    for (const key of ['runId', 'runAttempt', 'sourceHead']) assert.equal(receipt[key], source[key])
    assert.equal(receipt.version, version)
    const record = receipt.files.find(file => file.name === name)
    assert.equal(digest, record?.sha256)
    assert.equal(size, record.size)
  } else {
    const metadata = require('yaml').parse(await readFile(join(directory, 'latest-mac.yml'), 'utf8'))
    assert.equal(metadata.version, version)
    const [record, duplicate] = metadata.files.filter(file => file.url === name)
    assert.ok(record && !duplicate, 'Expected one exact DMG record in the immutable build update manifest')
    assert.equal(record.size, size)
    assert.equal(record.sha512, await checksum(installer, 'sha512', 'base64'))
    digestSource = 'signed-build-update-manifest'
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
  const installedAsarSha256 = await checksum(path)
  if (source.scope === 'private-isolated-candidate') {
    const updater = require('yaml').parse(await readFile(join(install, 'Contents', 'Resources', 'app-update.yml'), 'utf8'))
    assert.equal(packaged.updateChannel, 'frontier')
    assert.equal(updater.provider, 'generic')
    assert.equal(updater.url, 'https://127.0.0.1/')
  }
  const report = { schemaVersion: 1, status: 'failed', source, arch: process.arch, version,
    mode: taskOnly ? 'task-navigation' : 'startup-appearance',
    installer: { name, sha256: digest, size, digestSource }, installed: { bundleId: info.CFBundleIdentifier, installedArch,
      signature: 'verified', notarization: 'staple-verified', asarSha256: installedAsarSha256,
      ...(source.scope === 'private-isolated-candidate' ? { privateLoopbackFeedVerified: true } : {}) }, observations: [] }
  try {
    const [major, minor, patch] = version.split('.').map(Number)
    const checkTaskNavigation = major > 0 || minor > 5 || minor === 5 && patch >= 10
    assert.ok(!taskOnly || checkTaskNavigation, 'Task navigation requires a 0.5.10 or newer package')
    const chinese = { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark' }
    const cases = taskOnly ? [chinese] : [{ locale: 'en', htmlLang: 'en', theme: 'light' }, chinese]
    for (const expected of cases) {
      const workbench = expected.locale === 'zh' && checkTaskNavigation ? await macTaskFixture() : undefined
      try {
        report.observations.push(await observeInstalledStartup({ executable, version, evidenceDir, temporary, workbench,
          workbenchOnly: taskOnly }, expected, { connectCdp, environmentForRoot: isolatedMacEnvironment }))
      } finally { await workbench?.close() }
    }
    assert.equal(await checksum(path), installedAsarSha256)
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
  return verify(directory, source, evidenceDir, temporary, process.env.EXACT_MAC_TASK_ONLY === 'true')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
