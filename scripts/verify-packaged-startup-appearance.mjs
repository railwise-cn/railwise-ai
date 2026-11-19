import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { inspectInstalledPackage, installIdentity, windowsSmokeProvenance } from './verify-windows-install-smoke.mjs'

const brand = JSON.parse(readFileSync(new URL('../src/shared/product-brand.json', import.meta.url), 'utf8'))
const windowsCases = [
  { locale: 'en', htmlLang: 'en', theme: 'light', scale: 1 },
  { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark', scale: 1.25, screenshotName: 'windows-startup-appearance-zh-dark.png' }
]

function observeSplash() {
  const logo = document.querySelector('.splash img.logo')
  const title = document.querySelector('.splash h1')
  const subtitle = document.querySelector('.splash .subtitle')
  const bar = document.querySelector('.splash [role="progressbar"]')
  const status = document.querySelector('.splash [role="status"]')
  if (!logo?.naturalWidth || !title || !subtitle || !bar || !status || document.visibilityState !== 'visible') return null
  const rect = (element) => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
    return { left, top, right, bottom, width, height }
  }
  const subtitleRange = document.createRange()
  subtitleRange.selectNodeContents(subtitle)
  const textLines = Array.from(subtitleRange.getClientRects(), ({ left, top, right, bottom, width, height }) => ({ left, top, right, bottom, width, height }))
  return {
    title: title.textContent.trim(), subtitle: subtitle.textContent.trim(), subtitleLang: subtitle.lang,
    theme: document.documentElement.dataset.theme, locale: document.documentElement.lang,
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
    versionVisible: Boolean(document.querySelector('.splash .version') || /\b\d+\.\d+\.\d+\b/.test(document.body.innerText)),
    progress: Number(bar.getAttribute('aria-valuenow') ?? NaN), status: status.textContent.trim(),
    geometry: { logo: rect(logo), title: rect(title), subtitle: rect(subtitle), bar: rect(bar), status: rect(status), textLines }
  }
}

export function validateStartupAppearance(actual, expected) {
  assert.equal(actual.title, brand.platform)
  assert.equal(actual.subtitle, brand.platformSubtitleZh)
  assert.equal(actual.subtitleLang, 'zh-CN')
  assert.equal(actual.locale, expected.htmlLang)
  assert.equal(actual.theme, expected.theme)
  assert.equal(actual.versionVisible, false)
  assert.ok(Number.isFinite(actual.viewport.scale) && actual.viewport.scale > 0, 'Expected native startup viewport scale')
  if (expected.scale !== undefined) assert.ok(Math.abs(actual.viewport.scale - expected.scale) < 0.01, 'Expected native startup viewport scale')
  assert.ok(actual.status && actual.progress >= 0 && actual.progress <= 100, 'The actual startup progress must be readable')
  const { logo, title, subtitle, bar, status, textLines } = actual.geometry
  const visuallyOrdered = [logo, title, subtitle, bar, status]
  assert.ok(textLines.length > 0)
  for (const [index, box] of visuallyOrdered.entries()) {
    assert.ok(!index || visuallyOrdered[index - 1].bottom <= box.top + 1, 'Startup content must remain in its intended order')
  }
  for (const box of [...visuallyOrdered, ...textLines]) {
    assert.ok(box.width > 0 && box.height > 0 && box.left >= -1 && box.top >= -1 &&
      box.right <= actual.viewport.width + 1 && box.bottom <= actual.viewport.height + 1, 'Startup content must fit inside the visible window')
  }
  assert.ok(bar.height <= 3, 'Startup progress track must remain thin')
  return actual
}

function assertInside(root, path) {
  const child = relative(root, resolve(path))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Startup evidence must stay in RUNNER_TEMP')
}

async function collectTargets(launch, profile, port) {
  if (!port) port = launch.output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
    ?? await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(value => value.split(/\r?\n/)[0]).catch(() => '')
  if (!/^\d+$/.test(port)) return { targets: [] }
  const endpoint = `http://127.0.0.1:${port}`
  const targets = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1000) })
    .then(response => response.json()).catch(() => [])
  return { port, targets: (Array.isArray(targets) ? targets : []).filter(target => target.type === 'page' && target.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`)) }
}

export async function observeInstalledStartup(options, expected, dependencies) {
  const { executable, version, evidenceDir, temporary } = options
  const { connectCdp, environmentForRoot } = dependencies
  const root = await mkdtemp(join(temporary, 'railwise-splash-'))
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const env = environmentForRoot(process.env, root)
  await Promise.all([profile, workspace, env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.HOME]
    .filter(Boolean).map(path => mkdir(path, { recursive: true })))
  await writeFile(join(profile, 'workwise-settings.json'), JSON.stringify({ schema: 'workwise.settings', version: 2, revision: 0,
    locale: expected.locale, theme: expected.theme, workspaceRoot: workspace,
    appBehavior: { closeToTray: false, startMinimized: false, openAtLogin: false },
    agents: { kun: { autoStart: false, dataDir: join(root, 'runtime') } } }))
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--lang=${expected.htmlLang}`, ...(expected.scale === undefined ? [] : [`--force-device-scale-factor=${expected.scale}`]),
    ...(expected.theme === 'dark' ? ['--force-dark-mode'] : [])],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const launch = { output: '', error: undefined }
  child.once('error', error => { launch.error = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { launch.output = (launch.output + bytes).slice(-8000) })
  let observation, screenshot, main, port
  let requestedMacTermination = false
  try {
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline) {
      if (launch.error) throw launch.error
      assert.equal(child.exitCode, null, 'Installed application exited before startup observation')
      const observed = await collectTargets(launch, profile, port)
      port = observed.port
      const splash = observed.targets.find(target => /^data:text\/html(?:;[^,]*)?,/i.test(target.url) && target.title === brand.platform)
      if (!observation && splash) {
        let splashCdp
        try {
          splashCdp = await connectCdp(splash.webSocketDebuggerUrl)
          const snapshot = await splashCdp.evaluate(`(${observeSplash.toString()})()`, 1000)
          if (snapshot) {
            if (expected.screenshotName) {
              const capture = await splashCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 2000)
              screenshot = Buffer.from(capture.data, 'base64')
            }
            observation = snapshot
          }
        } catch { /* The next poll can still capture the transient window. */ }
        finally { splashCdp?.close() }
      }
      const renderer = observed.targets.find(target => /^file:.*\/renderer\/index\.html(?:[?#]|$)/.test(target.url))
      if (renderer && !splash) {
        main = await connectCdp(renderer.webSocketDebuggerUrl)
        break
      }
      await wait(45)
    }
    assert.ok(main, 'The installed startup window must close and reveal the workbench')
    assert.ok(observation, 'The real transitional startup window was not captured')
    validateStartupAppearance(observation, expected)
    await main.wait(`Boolean(window.workwise?.getAppVersion && document.visibilityState === 'visible')`, 'the visible installed workbench', 12_000)
    assert.equal(await main.evaluate('window.workwise.getAppVersion()', 2000), version)
    if (expected.screenshotName) {
      assert.ok(screenshot?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Actual startup screenshot is missing')
      await writeFile(join(evidenceDir, expected.screenshotName), screenshot)
    }
  } finally {
    if (main) {
      await main.send('Page.close', {}, 2000).catch(() => undefined)
      main.close()
    }
    // Normal macOS window closure leaves the app running. The acceptance
    // runner owns this separate process and may terminate it after observing.
    if (process.platform === 'darwin' && child.pid && child.exitCode === null && child.signalCode === null) {
      requestedMacTermination = child.kill('SIGTERM')
    }
    const deadline = Date.now() + 8000
    while (child.pid && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(80)
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32') {
        const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        await new Promise(done => { cleanup.once('close', done); cleanup.once('error', done) })
      } else {
        child.kill('SIGTERM')
        await wait(800)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
  }
  assert.ok(child.exitCode === 0 || requestedMacTermination && child.signalCode === 'SIGTERM', 'The owned startup acceptance process did not stop as expected')
  return { ...observation, workbenchOpened: true, processExit: { code: child.exitCode, signal: child.signalCode } }
}

export async function runWindowsStartupAppearanceSmoke({ executable, version, sourceHead, evidenceDir }, dependencies) {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
    throw new Error('Exact startup appearance smoke requires the clean GitHub-hosted Windows installer runner')
  }
  const temporary = resolve(process.env.RUNNER_TEMP)
  for (const path of [executable, evidenceDir]) assertInside(temporary, path)
  assert.ok((await lstat(executable)).isFile())
  const provenance = windowsSmokeProvenance(sourceHead)
  const identity = installIdentity(version, sourceHead)
  const installed = inspectInstalledPackage(dirname(executable), identity)
  await mkdir(evidenceDir, { recursive: true })
  const report = { schemaVersion: 1, scope: 'private-exact-package-startup-appearance', status: 'failed',
    sourceHead, version, provenance, installedAsarSha256: installed.asarSha256, observations: [], productionTouched: false }
  try {
    for (const expected of windowsCases) {
      report.observations.push(await observeInstalledStartup({ executable, version, evidenceDir, temporary }, expected, {
        connectCdp: dependencies.connectCdp, environmentForRoot: dependencies.windowsUiEnvironment
      }))
    }
    report.packageUnchanged = inspectInstalledPackage(dirname(executable), identity).asarSha256 === installed.asarSha256
    assert.equal(report.packageUnchanged, true)
    report.status = 'passed'
  } catch (error) {
    report.error = error.message
    throw error
  } finally {
    await writeFile(join(evidenceDir, 'windows-startup-appearance.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  return report
}
