import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { connectCdp, parseFixtureToolOutput, startWindowsTaskModelFixture } from './run-windows-ui-smoke.mjs'

const fixtureModel = 'windows-task-fixture'

async function shaFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function reserveLocalPort() {
  const socket = createServer()
  await new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', resolve)
  })
  const { port } = socket.address()
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  return port
}

export function macPptJourneyProvider(environment, mode, fixtureBaseUrl) {
  if (mode === 'controlled') {
    assert.equal(new URL(fixtureBaseUrl).hostname, '127.0.0.1')
    return { id: fixtureModel, model: fixtureModel, apiKey: 'synthetic-local-only', baseUrl: fixtureBaseUrl }
  }
  assert.equal(mode, 'live')
  const baseUrl = environment.RAILWISE_QA_MODEL_BASE_URL?.trim()
  const apiKey = environment.RAILWISE_QA_MODEL_API_KEY?.trim()
  const model = environment.RAILWISE_QA_MODEL?.trim()
  if (!baseUrl || !apiKey || !model) {
    throw Object.assign(new Error('Missing dedicated live QA model settings'), { code: 'live-model-unconfigured' })
  }
  const endpoint = URL.parse(baseUrl)
  assert.ok(endpoint?.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'The dedicated live QA model must use a plain HTTPS base URL')
  return { id: 'railwise-live-qa', model, apiKey, baseUrl }
}

async function waitForInstalledPage(port, child) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    assert.ok(child.exitCode === null && child.signalCode === null, 'The installed application exited before opening the workbench')
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })
      .then(response => response.json()).catch(() => [])
    const page = targets.find(item => item.type === 'page' && /^file:.*\/renderer\/index\.html(?:[?#]|$)/.test(item.url) &&
      item.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`))
    if (page) return connectCdp(page.webSocketDebuggerUrl)
    await wait(100)
  }
  throw new Error('The installed application did not expose its workbench')
}

export function installedChineseWorkbenchReadyExpression() {
  return `document.readyState !== 'loading' && Boolean(window.workwise?.getAppVersion &&
    document.visibilityState === 'visible' && document.body?.innerText.includes('技能与连接器'))`
}

// The shared driver enters text through Chromium input. macOS selects all with Command.
function macKeyboard(cdp) {
  return { ...cdp, fill: async (selector, text) => {
    await cdp.click(selector)
    assert.ok(await cdp.evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`), 'The installed input must receive focus')
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    }
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    }
    if (text) await cdp.send('Input.insertText', { text })
    await cdp.wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`, 'the typed input')
  } }
}

async function stopInstalledProcess(child, cdp) {
  if (cdp) {
    await cdp.send('Page.close', {}, 2000).catch(() => undefined)
    cdp.close()
  }
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const deadline = Date.now() + 8000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(100)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await wait(200)
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'The owned Mac acceptance process did not exit')
}

async function readNativeOpenResult(cdp, { task, artifact }) {
  const result = artifact.absolutePath || artifact.storage === 'task'
    ? await cdp.evaluate(`window.workwise.openTaskArtifact(${JSON.stringify({ taskId: task.id, artifactId: artifact.id })})`)
    : await cdp.evaluate(`window.workwise.openWorkspaceFile(${JSON.stringify({ workspaceRoot: task.workspaceRoot, path: artifact.relativePath })})`)
  if (result?.ok !== true) {
    throw new Error(`The operating system could not open the registered PPTX: ${result?.message ?? 'No error detail returned.'}`)
  }
  return { status: 'os-open-accepted' }
}

export async function runInstalledMacPptJourney({ executable, temporary, evidenceDir, version, installedAsarSha256,
  installer, source, mode, environmentForRoot, environment = process.env }) {
  assert.equal(process.platform, 'darwin')
  assert.ok(['controlled', 'live'].includes(mode))
  const receipt = { schemaVersion: 1, journey: 'url-pptx', status: 'failed', platform: 'darwin', arch: process.arch,
    version, source, installer, installedAsarSha256, modelMode: mode, productionTouched: false, startedAt: new Date().toISOString() }
  const root = await realpath(await mkdtemp(join(temporary, 'railwise-mac-ppt-')))
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const workwiseHome = join(root, 'home', '.workwise')
  let fixture, child, cdp, failure
  try {
    const driver = await import('./web-ppt-journey.mjs')
    const resources = join(dirname(executable), '..', 'Resources')
    const asar = join(resources, 'app.asar')
    assert.equal(await shaFile(asar), installedAsarSha256, 'The installed app must match the signature-verified package')
    const sidecar = join(resources, 'app.asar.unpacked', 'sidecars', 'markitdown', 'workwise-markitdown')
    assert.ok((await stat(sidecar)).isFile(), 'The installed native PPT sidecar is missing')
    const journey = driver.createWebPptJourney({ workspace, sidecar, parseToolOutput: parseFixtureToolOutput, live: mode === 'live' })
    if (mode === 'controlled') fixture = await startWindowsTaskModelFixture({ composerAcceptance: journey })
    const { id, model, apiKey, baseUrl } = macPptJourneyProvider(environment, mode, fixture?.baseUrl)
    const env = environmentForRoot(environment, root)
    assert.equal(env.HOME, join(root, 'home'))
    await Promise.all([profile, workspace, workwiseHome, evidenceDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    await writeFile(join(workwiseHome, 'workspace-trust.json'), JSON.stringify({ schema: 'workwise.workspace-trust', version: 1,
      workspaces: [{ level: 'workspace-write', canonicalRoot: workspace, revision: 1 }] }), { mode: 0o600 })
    await writeFile(join(profile, 'workwise-settings.json'), JSON.stringify({ schema: 'workwise.settings', version: 2, revision: 0,
      locale: 'zh', theme: 'dark', workspaceRoot: workspace,
      appBehavior: { closeToTray: false, startMinimized: false, openAtLogin: false },
      provider: { providers: [{ id, name: 'RailWise QA', apiKey, baseUrl, endpointFormat: 'chat_completions', models: [model] }] },
      agents: { kun: { autoStart: true, port: await reserveLocalPort(), dataDir: join(root, 'runtime'), providerId: id, model,
        approvalPolicy: mode === 'controlled' ? 'auto' : 'on-request', sandboxMode: 'workspace-write' } } }), { mode: 0o600 })
    const port = await reserveLocalPort()
    child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      '--lang=zh-CN', '--force-dark-mode'], { cwd: root, env, stdio: 'ignore' })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    cdp = macKeyboard(await waitForInstalledPage(port, child))
    await cdp.wait(installedChineseWorkbenchReadyExpression(), 'the visible installed Chinese workbench')
    assert.equal(await cdp.evaluate('window.workwise.getAppVersion()'), version)
    assert.equal(await cdp.evaluate('window.workwise.getSettings().then(settings => settings.workspaceRoot)'), workspace)
    receipt.observation = await journey.verify(cdp, { openArtifact: readNativeOpenResult })
    assert.equal(await shaFile(asar), installedAsarSha256)
    receipt.status = 'passed'
  } catch (error) {
    failure = error
    if (error.code === 'live-model-unconfigured') receipt.status = 'blocked'
    receipt.reason = mode === 'controlled' || error.code === 'live-model-unconfigured' ? error.message : 'Live journey failed. Inspect the restricted runner session.'
  } finally {
    try {
      await stopInstalledProcess(child, cdp)
      await fixture?.close()
    } catch (error) {
      receipt.status = 'failed'
      receipt.cleanupFailed = true
      failure ??= error
    }
    // The profile contains disposable QA model settings. Never publish it with the evidence.
    await rm(root, { recursive: true, force: true })
    receipt.finishedAt = new Date().toISOString()
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(join(evidenceDir, `mac-ppt-journey-${mode}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  }
  if (failure) throw new Error(receipt.reason ?? 'Mac PPT journey cleanup failed')
  return receipt
}
