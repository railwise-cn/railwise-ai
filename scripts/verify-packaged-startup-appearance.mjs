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

export async function observeWorkbenchTypography(cdp, selector = '.ds-sidebar-shell button.w-full') {
  await cdp.wait(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`, 'representative visible workbench text')
  const page = await cdp.evaluate(`document.fonts.ready.then(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const style = getComputedStyle(node);
    return {fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,devicePixelRatio,window:{width:innerWidth,height:innerHeight}};
  })`)
  assert.match(page.fontFamily, /RailWise UI/)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  await cdp.send('DOM.getDocument')
  const target = await cdp.send('Runtime.evaluate', { expression: `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    return [node, ...node.querySelectorAll('*')].find(element => element.getClientRects().length &&
      getComputedStyle(element).visibility === 'visible' && [...element.childNodes].some(child =>
        child.nodeType === Node.TEXT_NODE && child.textContent.trim()));
  })()` })
  assert.ok(target.result.objectId, 'Expected a visible workbench text element')
  const { nodeId } = await cdp.send('DOM.requestNode', { objectId: target.result.objectId })
  assert.ok(nodeId, 'Expected a rendered workbench text node')
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
  await cdp.send('Runtime.releaseObject', { objectId: target.result.objectId })
  assert.ok(fonts.some(font => font.isCustomFont && /Noto\s*Sans\s*SC/i.test(font.familyName) && font.glyphCount > 0),
    `The bundled Noto Sans SC font must draw actual workbench glyphs: ${JSON.stringify(fonts)}`)
  return { ...page, fonts }
}

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

// Attach before the data document has acquired its title and reuse that
// connection while the native window becomes visible. Reconnecting on every
// poll can consume the entire lifetime of this deliberately short-lived page.
export function createStartupTargetObserver(connectCdp, screenshotRequired = false) {
  const connections = new Map()
  const diagnostics = { targets: [], errors: [], polls: 0 }
  let observation, screenshot
  const recordError = error => {
    if (diagnostics.errors.length < 8) diagnostics.errors.push(String(error.message ?? error).slice(0, 240))
  }
  return {
    diagnostics,
    async observe(targets) {
      diagnostics.polls += 1
      for (const target of targets) {
        if (!/^data:text\/html(?:;[^,]*)?,/i.test(target.url) && target.url !== 'about:blank') continue
        const key = target.id ?? target.webSocketDebuggerUrl
        let record = diagnostics.targets.find(item => item.id === key)
        if (!record) {
          record = { id: key, kind: target.url === 'about:blank' ? 'blank' : 'data', titleMatched: target.title === brand.platform, samples: 0 }
          diagnostics.targets.push(record)
        }
        if (observation && (!screenshotRequired || screenshot)) continue
        let cdp = connections.get(key)
        try {
          if (!cdp) { cdp = await connectCdp(target.webSocketDebuggerUrl, 750); connections.set(key, cdp) }
          const sample = await cdp.evaluate(`({state:{readyState:document.readyState,visibility:document.visibilityState,
            splashPresent:Boolean(document.querySelector('.splash')),logoLoaded:Boolean(document.querySelector('.splash img.logo')?.naturalWidth)},
            snapshot:(${observeSplash.toString()})()})`, 750)
          record.lastState = sample.state
          record.samples += 1
          const snapshot = sample.snapshot
          if (snapshot) {
            observation = snapshot
            // This remains an actual screenshot from the same live page; never
            // reload, reconstruct or pause the application to manufacture it.
            if (screenshotRequired) {
              const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 1500)
              screenshot = Buffer.from(capture.data, 'base64')
            }
          }
        } catch (error) {
          recordError(error)
          cdp?.close()
          connections.delete(key)
        }
      }
      return { observation, screenshot }
    },
    close() { for (const cdp of connections.values()) cdp.close(); connections.clear() }
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
  const { connectCdp, environmentForRoot, onWorkbenchReady } = dependencies
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
  let observation, screenshot, main, port, workbenchTypography, workbook, failure
  const observer = createStartupTargetObserver(connectCdp, Boolean(expected.screenshotName))
  let requestedMacTermination = false
  try {
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline) {
      if (launch.error) throw launch.error
      assert.equal(child.exitCode, null, 'Installed application exited before startup observation')
      const observed = await collectTargets(launch, profile, port)
      port = observed.port
      const splash = observed.targets.find(target => /^data:text\/html(?:;[^,]*)?,/i.test(target.url))
      const captured = await observer.observe(observed.targets)
      observation = captured.observation
      screenshot = captured.screenshot
      const renderer = observed.targets.find(target => /^file:.*\/renderer\/index\.html(?:[?#]|$)/.test(target.url))
      if (renderer && !splash) {
        main = await connectCdp(renderer.webSocketDebuggerUrl)
        break
      }
      await wait(20)
    }
    assert.ok(main, 'The installed startup window must close and reveal the workbench')
    await main.wait(`Boolean(window.workwise?.getAppVersion && document.visibilityState === 'visible')`, 'the visible installed workbench', 12_000)
    assert.equal(await main.evaluate('window.workwise.getAppVersion()', 2000), version)
    workbenchTypography = await observeWorkbenchTypography(main)
    // A missed transient capture must still fail, but should not suppress the
    // independently useful real workbook acceptance evidence.
    if (onWorkbenchReady) workbook = await onWorkbenchReady(main, { root, workspace })
    if (!observation) {
      const error = new Error('The real transitional startup window was not captured')
      error.code = 'STARTUP_CAPTURE_MISSED'
      throw error
    }
    validateStartupAppearance(observation, expected)
    observation.workbenchTypography = workbenchTypography
    if (workbook) observation.workbook = workbook
    if (expected.screenshotName) {
      assert.ok(screenshot?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Actual startup screenshot is missing')
    }
  } catch (error) {
    failure = error.message
    throw error
  } finally {
    observer.close()
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
    if (expected.screenshotName && screenshot?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      await writeFile(join(evidenceDir, expected.screenshotName), screenshot)
    }
    await writeFile(join(evidenceDir, `startup-capture-${expected.locale}-${expected.theme}${expected.captureAttempt ? '-retry' : ''}.json`), `${JSON.stringify({
      status: failure ? 'failed' : 'observed', expected, observation, workbenchTypography, workbook,
      error: failure, capture: observer.diagnostics
    }, null, 2)}\n`)
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
