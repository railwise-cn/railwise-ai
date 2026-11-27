import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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

export function parseMacWindowObservation(output) {
  const windows = []
  let frontmostProcess = ''
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('FRONTMOST|')) frontmostProcess = line.slice('FRONTMOST|'.length)
    else if (line.startsWith('WINDOW|')) {
      const [, processName = '', ...titleParts] = line.split('|')
      const title = titleParts.join('|')
      if (processName && title) windows.push({ processName, title })
    }
  }
  return { frontmostProcess, windows }
}

function readMacWindowObservation() {
  const script = `set outputLines to {}
tell application "System Events"
  try
    set frontmostApp to name of first application process whose frontmost is true
  on error
    set frontmostApp to ""
  end try
  set end of outputLines to "FRONTMOST|" & frontmostApp
  repeat with appProcess in every application process
    try
      if background only of appProcess is false then
        set appName to name of appProcess
        repeat with appWindow in windows of appProcess
          try
            set end of outputLines to "WINDOW|" & appName & "|" & name of appWindow
          end try
        end repeat
      end if
    end try
  end repeat
end tell
set previousDelimiters to AppleScript's text item delimiters
set AppleScript's text item delimiters to linefeed
set outputText to outputLines as text
set AppleScript's text item delimiters to previousDelimiters
outputText`
  const result = spawnSync('/usr/bin/osascript', ['-e', script], {
    encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe']
  })
  return {
    ...(result.status === 0 ? parseMacWindowObservation(result.stdout) : { frontmostProcess: '', windows: [] }),
    error: result.status === 0 ? '' : result.stderr?.trim().slice(0, 300) || result.error?.message || `osascript exited ${result.status}`
  }
}

function readPptxDefaultHandler() {
  const result = spawnSync('duti', ['-x', 'pptx'], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) return { status: 'unavailable', error: result.stderr?.trim().slice(0, 300) || result.error?.message || `duti exited ${result.status}` }
  return { status: 'resolved', lines: result.stdout.trim().split(/\r?\n/).filter(Boolean).slice(0, 3) }
}

async function readArtifactOpenFailure(cdp) {
  return cdp.evaluate(`(() => {
    const text = document.querySelector('.ds-workbench-shell main')?.innerText ?? '';
    const message = text.includes('操作未完成，请重试。') ? 'localized-action-failure'
      : text.includes('The action did not complete. Try again.') ? 'localized-action-failure' : null;
    return {
      artifactVisible: text.includes('website.pptx'),
      visibleFailure: message,
      workbenchVisible: Boolean(document.querySelector('.ds-workbench-shell main')?.getClientRects().length)
    };
  })()`)
}

async function waitForNativeMacDocument(cdp, filename, artifactPath) {
  const deadline = Date.now() + 60_000
  const baseName = filename.replace(/\.pptx$/i, '')
  const lockPath = artifactPath ? join(dirname(artifactPath), `.~lock.${filename}#`) : ''
  const defaultHandler = readPptxDefaultHandler()
  let lastObservation = { defaultHandler, processes: [], windows: [], frontmostProcess: '', systemEventsError: '', renderer: null }
  while (Date.now() < deadline) {
    const system = readMacWindowObservation()
    const processResult = spawnSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'pipe'] })
    const processes = processResult.status === 0 ? processResult.stdout.split(/\r?\n/).map(name => name.trim()).filter(Boolean)
      .filter(name => /LibreOffice|soffice/i.test(name)) : []
    const lockOpened = lockPath ? await stat(lockPath).then(info => info.isFile(), () => false) : false
    const renderer = await readArtifactOpenFailure(cdp).catch(error => ({ statusReadError: error.message }))
    lastObservation = { defaultHandler, processes, windows: system.windows, frontmostProcess: system.frontmostProcess,
      lockOpened, systemEventsError: system.error, renderer }
    const documentWindow = system.windows.find(window => window.title.includes(filename) || window.title.includes(baseName))
    if (documentWindow) return { status: 'os-open-accepted', application: documentWindow.processName, windowTitle: documentWindow.title,
      defaultHandler, observation: lastObservation }
    if (processes.length > 0 && lockOpened && !renderer.visibleFailure) {
      return { status: 'os-open-accepted', application: 'LibreOffice', windowTitle: filename,
        defaultHandler, observation: lastObservation }
    }
    if (renderer.visibleFailure) {
      throw Object.assign(new Error(`The installed app showed an artifact-open failure for ${filename}`), { webPptDiagnostics: lastObservation })
    }
    await wait(500)
  }
  throw Object.assign(new Error(`The system did not show ${filename} in a document window. Observation: ${JSON.stringify(lastObservation)}`),
    { webPptDiagnostics: lastObservation })
}

async function readNativeOpenResult(cdp, { artifact, path }) {
  const filename = artifact.relativePath.split(/[\\/]/).at(-1)
  assert.ok(filename)
  return waitForNativeMacDocument(cdp, filename, path)
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
  const receiptPath = join(evidenceDir, `mac-ppt-journey-${mode}.json`)
  const recordStage = async stage => {
    receipt.lastStage = stage
    receipt.stageHistory ??= []
    receipt.stageHistory.push({ stage, at: new Date().toISOString() })
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  }
  try {
    const driver = await import('./web-ppt-journey.mjs')
    const resources = join(dirname(executable), '..', 'Resources')
    const asar = join(resources, 'app.asar')
    assert.equal(await shaFile(asar), installedAsarSha256, 'The installed app must match the signature-verified package')
    const sidecar = join(resources, 'app.asar.unpacked', 'sidecars', 'markitdown', 'workwise-markitdown')
    assert.ok((await stat(sidecar)).isFile(), 'The installed native PPT sidecar is missing')
    const skillGuardPath = join(resources, 'app.asar.unpacked', 'src', 'asset', 'skills', 'ppt-master', 'scripts', 'attribution_guard.py')
    assert.ok((await stat(skillGuardPath)).isFile(), 'The installed PPT attribution guard is missing')
    const journey = driver.createWebPptJourney({ workspace, sidecar, skillGuardPath, parseToolOutput: parseFixtureToolOutput, live: mode === 'live' })
    if (mode === 'controlled') fixture = await startWindowsTaskModelFixture({ composerAcceptance: journey })
    const { id, model, apiKey, baseUrl } = macPptJourneyProvider(environment, mode, fixture?.baseUrl)
    const env = environmentForRoot(environment, root)
    assert.equal(env.HOME, join(root, 'home'))
    await Promise.all([profile, workspace, workwiseHome, evidenceDir].map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    await recordStage('prepare-isolated-profile')
    const verifyPptx = spawnSync('duti', ['-x', 'pptx'],
      { cwd: root, env: process.env, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] })
    assert.equal(verifyPptx.status, 0)
    assert.equal(verifyPptx.stdout.trim().split(/\r?\n/)[0], 'LibreOffice', 'The runner default must resolve PPTX files to LibreOffice')
    receipt.nativeOpener = { profile: 'ephemeral-runner-default', handler: verifyPptx.stdout.trim().split(/\r?\n/).slice(0, 3) }
    await recordStage('verify-native-document-handler-on-ephemeral-runner')
    await writeFile(join(workwiseHome, 'workspace-trust.json'), JSON.stringify({ schema: 'workwise.workspace-trust', version: 1,
      workspaces: [{ level: 'workspace-write', canonicalRoot: workspace, revision: 1 }] }), { mode: 0o600 })
    await writeFile(join(profile, 'workwise-settings.json'), JSON.stringify({ schema: 'workwise.settings', version: 2, revision: 0,
      locale: 'zh', theme: 'dark', workspaceRoot: workspace,
      appBehavior: { closeToTray: false, startMinimized: false, openAtLogin: false },
      provider: { providers: [{ id, name: 'RailWise QA', apiKey, baseUrl, endpointFormat: 'chat_completions', models: [model] }] },
      agents: { kun: { autoStart: true, port: await reserveLocalPort(), dataDir: join(root, 'runtime'), providerId: id, model,
        approvalPolicy: 'auto', sandboxMode: 'workspace-write' } } }), { mode: 0o600 })
    const port = await reserveLocalPort()
    child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      '--lang=zh-CN', '--force-dark-mode'], { cwd: root, env, stdio: 'ignore' })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    cdp = macKeyboard(await waitForInstalledPage(port, child))
    await cdp.wait(installedChineseWorkbenchReadyExpression(), 'the visible installed Chinese workbench')
    assert.equal(await cdp.evaluate('window.workwise.getAppVersion()'), version)
    assert.equal(await cdp.evaluate('window.workwise.getSettings().then(settings => settings.workspaceRoot)'), workspace)
    await recordStage('verify-original-chat-task-and-deliverable')
    receipt.observation = await journey.verify(cdp, { openArtifact: readNativeOpenResult, onStage: recordStage })
    assert.equal(await shaFile(asar), installedAsarSha256)
    receipt.status = 'passed'
  } catch (error) {
    failure = error
    if (error.code === 'live-model-unconfigured') receipt.status = 'blocked'
    receipt.reason = mode === 'controlled' || error.code === 'live-model-unconfigured' ? error.message : 'Live journey failed. Inspect the restricted runner session.'
    receipt.error = { name: error.name, message: receipt.reason, stage: receipt.lastStage,
      ...(error.webPptDiagnostics ? { webPptDiagnostics: error.webPptDiagnostics } : {}) }
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
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  }
  if (failure) throw new Error(receipt.reason ?? 'Mac PPT journey cleanup failed')
  return receipt
}
