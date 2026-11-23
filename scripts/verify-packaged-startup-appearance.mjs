import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { inspectInstalledPackage, installIdentity, windowsSmokeProvenance } from './verify-windows-install-smoke.mjs'

const brand = JSON.parse(readFileSync(new URL('../src/shared/product-brand.json', import.meta.url), 'utf8'))
export const windowsStartupCases = [
  { locale: 'en', htmlLang: 'en', theme: 'light', scale: 1 },
  { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark', scale: 1.25, screenshotName: 'windows-startup-appearance-zh-dark.png' },
  { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark', scale: 1.5, narrowWorkbench: true }
]

const narrowWindowBounds = { width: 960, height: 640 }
const cdpOperationMs = 5_000

export async function waitForStartupCondition(cdp, expression, label, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await cdp.evaluate(expression, Math.min(cdpOperationMs, Math.max(1, deadline - Date.now())))
    if (result) return result
    await wait(Math.min(75, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`Installed UI did not show ${label}`)
}

function visibleWorkbenchText(selector) {
  for (const control of document.querySelectorAll(selector)) {
    if (!control.getClientRects().length || control.closest('[inert]')) continue
    for (const element of [control, ...control.querySelectorAll('*')]) {
      if (![...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())) continue
      const bounds = element.getBoundingClientRect()
      if (bounds.width > 0 && bounds.height > 0 && bounds.right > 0 && bounds.bottom > 0 &&
          bounds.left < innerWidth && bounds.top < innerHeight && getComputedStyle(element).visibility === 'visible') return element
    }
  }
  return null
}

const workbenchTypographyTargets = '.ds-sidebar-shell button.w-full, .ds-floating-composer .ds-composer-model-picker button'

export async function observeWorkbenchTypography(cdp, selector = workbenchTypographyTargets) {
  const locate = `(${visibleWorkbenchText.toString()})(${JSON.stringify(selector)})`
  await waitForStartupCondition(cdp, `Boolean(${locate})`, 'representative visible workbench text', 12_000)
  const page = await cdp.evaluate(`document.fonts.ready.then(() => {
    const node = ${locate};
    const style = getComputedStyle(node);
    return {fontFamily:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,devicePixelRatio,window:{width:innerWidth,height:innerHeight}};
  })`, cdpOperationMs)
  assert.match(page.fontFamily, /RailWise UI/)
  await cdp.send('DOM.enable', {}, cdpOperationMs)
  await cdp.send('CSS.enable', {}, cdpOperationMs)
  await cdp.send('DOM.getDocument', {}, cdpOperationMs)
  const target = await cdp.send('Runtime.evaluate', { expression: locate }, cdpOperationMs)
  assert.ok(target.result.objectId, 'Expected a visible workbench text element')
  const { nodeId } = await cdp.send('DOM.requestNode', { objectId: target.result.objectId }, cdpOperationMs)
  assert.ok(nodeId, 'Expected a rendered workbench text node')
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }, cdpOperationMs)
  await cdp.send('Runtime.releaseObject', { objectId: target.result.objectId }, cdpOperationMs)
  assert.ok(fonts.some(font => font.isCustomFont && /Noto\s*Sans\s*SC/i.test(font.familyName) && font.glyphCount > 0),
    `The bundled Noto Sans SC font must draw actual workbench glyphs: ${JSON.stringify(fonts)}`)
  return { ...page, fonts }
}

function observeSplash() {
  const logo = [...document.querySelectorAll('.splash img.logo')].find(image => image.getClientRects().length)
  const title = document.querySelector('.splash h1')
  const subtitle = document.querySelector('.splash .subtitle')
  const bar = document.querySelector('.splash [role="progressbar"]')
  const status = document.querySelector('.splash [role="status"]')
  if (!title || !subtitle || !bar || !status) return { phase: 'document-loading' }
  if (!logo?.naturalWidth) return { phase: 'logo-loading' }
  if (document.visibilityState !== 'visible') return { phase: 'window-hidden' }
  const rect = (element) => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
    return { left, top, right, bottom, width, height }
  }
  const subtitleRange = document.createRange()
  subtitleRange.selectNodeContents(subtitle)
  const textLines = Array.from(subtitleRange.getClientRects(), ({ left, top, right, bottom, width, height }) => ({ left, top, right, bottom, width, height }))
  return {
    phase: 'visible', title: title.textContent.trim(), subtitle: subtitle.textContent.trim(), subtitleLang: subtitle.lang,
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

function observeComposerGeometry() {
  const composer = document.querySelector('.ds-floating-composer .ds-chat-composer')
  const textarea = composer?.querySelector('textarea')
  const toolbar = composer?.querySelector('.ds-composer-toolbar')
  const model = toolbar?.querySelector('.ds-composer-model-picker button')
  const send = toolbar?.querySelector('button[aria-label="发送"]')
  const general = toolbar?.querySelector('.ds-composer-agent-picker button')
  if (!composer || !textarea || !toolbar || !model || !send) return null
  const rect = node => {
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect()
    return { left, top, right, bottom, width, height }
  }
  const target = node => {
    const box = rect(node)
    return { ...box, hit: node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }
  }
  const label = general?.querySelector('span.truncate')
  return {
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
    composer: rect(composer), textarea: rect(textarea), toolbar: rect(toolbar), model: target(model), send: target(send),
    horizontalOverflow: [document.documentElement, composer, textarea, toolbar].some(node => node.scrollWidth > node.clientWidth + 2),
    general: general?.getClientRects().length && label
      ? { ...target(general), label: label.textContent, clipped: label.scrollWidth > label.clientWidth + 1 }
      : null
  }
}

export function validateNarrowWorkbenchComposer(observation, expectedScale) {
  const { viewport, composer, textarea, toolbar, model, send, general } = observation
  assert.ok(Math.abs(viewport.scale - expectedScale) < 0.01, 'Expected real workbench device scale')
  assert.ok(Math.abs(viewport.width - narrowWindowBounds.width) <= 24, 'Expected the real minimum-width workbench')
  assert.ok(Math.abs(viewport.height - narrowWindowBounds.height) <= 40, 'Expected the real minimum-height workbench')
  assert.equal(observation.horizontalOverflow, false, 'The actual workbench composer must fit without horizontal scrolling')
  for (const box of [composer, textarea, toolbar, model, send, ...(general ? [general] : [])]) {
    assert.ok(box.width > 0 && box.height > 0 && box.left >= -1 && box.top >= -1 &&
      box.right <= viewport.width + 1 && box.bottom <= viewport.height + 1, 'Composer controls must fit within the viewport')
  }
  for (const box of [textarea, toolbar]) {
    assert.ok(box.left >= composer.left - 1 && box.right <= composer.right + 1, 'Composer rows must fit the input shell')
  }
  assert.ok(textarea.bottom <= toolbar.top + 1, 'Composer controls must stay below the text input')
  for (const box of [model, send, ...(general ? [general] : [])]) {
    assert.ok(box.left >= toolbar.left - 1 && box.right <= toolbar.right + 1 && box.hit,
      'Composer selectors and send must remain visible and receive pointer hits')
  }
  if (general) assert.equal(general.clipped, false, 'The current agent label must remain readable')
  return observation
}

async function observeNarrowWorkbench(cdp, { pid, env, scale, windowsOwnedWindowScript }) {
  let resizeMethod = 'browser-cdp'
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', {}, 2000)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }, 2000)
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: narrowWindowBounds }, 2000)
  } catch {
    const nativeBounds = bounds => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      windowsOwnedWindowScript(pid, bounds)], { env, encoding: 'utf8', windowsHide: true, timeout: 15_000 }))
    const original = nativeBounds()
    assert.equal(original.ownerVerified, true)
    assert.equal(nativeBounds({ ...original, ...narrowWindowBounds, windowState: 'normal' }).ownerVerified, true)
    resizeMethod = 'verified-pid-native-window'
  }
  const geometry = await waitForStartupCondition(cdp, `(() => {
    const state = (${observeComposerGeometry.toString()})();
    return state && Math.abs(state.viewport.width - ${narrowWindowBounds.width}) <= 24 && state;
  })()`, 'real composer at the minimum Windows workbench width', 15_000)
  validateNarrowWorkbenchComposer(geometry, scale)
  return { resizeMethod, ...geometry }
}

function assertInside(root, path) {
  const child = relative(root, resolve(path))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'Startup evidence must stay in RUNNER_TEMP')
}

async function startupDebugPort() {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const { port } = server.address()
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
  return port
}

async function collectTargets(port) {
  const endpoint = `http://127.0.0.1:${port}`
  const targets = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1000) })
    .then(response => response.json()).catch(() => null)
  if (!Array.isArray(targets)) return null
  return targets.filter(target => target.type === 'page' && target.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`))
}

const missedStartupCapture = 'The real transitional startup window was not captured'

export async function observeStartupTargets({ listTargets, connectCdp, needsScreenshot, timeout = 35_000 }) {
  const diagnostics = { endpointAvailable: false, splashTargetSeen: false, rendererTargetSeen: false, splashReadiness: 'not-observed', splashReadErrors: 0 }
  let main, splashCdp, splashUrl, observation, screenshot, workbenchVisible = false
  try {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const targets = await listTargets()
      diagnostics.endpointAvailable ||= targets !== null
      const splash = targets?.find(target => /^data:text\/html(?:;[^,]*)?,/i.test(target.url))
      const renderer = targets?.find(target => /^file:.*\/renderer\/index\.html(?:[?#]|$)/.test(target.url))
      diagnostics.splashTargetSeen ||= Boolean(splash)
      diagnostics.rendererTargetSeen ||= Boolean(renderer)
      if (splash && !observation) {
        try {
          if (splashUrl !== splash.webSocketDebuggerUrl) {
            splashCdp?.close()
            splashCdp = await connectCdp(splash.webSocketDebuggerUrl)
            splashUrl = splash.webSocketDebuggerUrl
          }
          const { phase, ...snapshot } = await splashCdp.evaluate(`(${observeSplash.toString()})()`, 2_000)
          diagnostics.splashReadiness = phase
          if (phase === 'visible') {
            if (needsScreenshot) {
              const capture = await splashCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 5_000)
              screenshot = Buffer.from(capture.data, 'base64')
            }
            observation = snapshot
          }
        } catch {
          diagnostics.splashReadErrors++
          splashCdp?.close()
          splashCdp = undefined
          splashUrl = undefined
        }
      }
      if (renderer && !splash) {
        main ??= await connectCdp(renderer.webSocketDebuggerUrl)
        workbenchVisible = await main.evaluate('document.visibilityState === "visible"', 1000)
        if (workbenchVisible) break
      }
      await wait(25)
    }
    assert.ok(workbenchVisible, 'The installed startup window must close and reveal the workbench')
    assert.ok(observation, missedStartupCapture)
    return { main, observation, screenshot }
  } catch (error) {
    if (main) {
      await main.send('Page.close', {}, 2000).catch(() => undefined)
      main.close()
    }
    throw Object.assign(error, { diagnostics })
  } finally {
    splashCdp?.close()
  }
}

export async function observeInstalledStartup(options, expected, dependencies) {
  const { executable, version, evidenceDir, temporary } = options
  const { connectCdp, environmentForRoot, windowsOwnedWindowScript, checkpoint = async () => {} } = dependencies
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
  const port = await startupDebugPort()
  await checkpoint('launching')
  const child = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    `--lang=${expected.htmlLang}`, ...(expected.scale === undefined ? [] : [`--force-device-scale-factor=${expected.scale}`]),
    ...(expected.theme === 'dark' ? ['--force-dark-mode'] : [])],
  { cwd: root, env, stdio: 'ignore' })
  let launchError, observation, main, cleanupError
  child.once('error', error => { launchError = error })
  let requestedMacTermination = false
  try {
    const startup = await observeStartupTargets({ connectCdp,
      needsScreenshot: Boolean(expected.screenshotName), listTargets: () => {
        if (launchError) throw launchError
        assert.equal(child.exitCode, null, 'Installed application exited before startup observation')
        return collectTargets(port)
      } })
    main = startup.main
    observation = startup.observation
    const { screenshot } = startup
    validateStartupAppearance(observation, expected)
    if (expected.screenshotName) {
      assert.ok(screenshot?.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'Actual startup screenshot is missing')
      await writeFile(join(evidenceDir, expected.screenshotName), screenshot)
    }
    await checkpoint('visible-splash-verified', { viewport: observation.viewport, screenshot: expected.screenshotName })
    await waitForStartupCondition(main, `Boolean(window.workwise?.getAppVersion && document.visibilityState === 'visible')`, 'the visible installed workbench', 12_000)
    assert.equal(await main.evaluate('window.workwise.getAppVersion()', 2000), version)
    await checkpoint('visible-workbench-verified', { version })
    if (process.platform === 'win32' && ['0.5.10', '0.5.11'].includes(version) && expected.screenshotName) {
      observation.releaseHighlights = await waitForStartupCondition(main, `(() => {
        const section = document.querySelector('main section[aria-label="本版更新"]');
        const bounds = section?.getBoundingClientRect();
        return bounds?.width > 0 && bounds.height > 0 && bounds.top >= 0 && bounds.bottom <= innerHeight &&
          getComputedStyle(section).visibility === 'visible' && section.innerText.includes(${JSON.stringify(version)}) &&
          { title: section.getAttribute('aria-label'), version: ${JSON.stringify(version)}, visibleOnFirstOpen: true };
      })()`, `the visible ${version} release highlights on first open`, 12_000)
      await checkpoint('release-highlights-verified', observation.releaseHighlights)
    }
    observation.workbenchTypography = await observeWorkbenchTypography(main)
    await checkpoint('bundled-font-verified', observation.workbenchTypography)
    if (expected.narrowWorkbench) {
      observation.narrowWorkbench = await observeNarrowWorkbench(main, { pid: child.pid, env, scale: expected.scale, windowsOwnedWindowScript })
      await checkpoint('minimum-width-layout-verified', { viewport: observation.narrowWorkbench.viewport })
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
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: cdpOperationMs })
        } catch (error) {
          await wait(100)
          if (child.exitCode === null && child.signalCode === null) {
            cleanupError = new Error('The owned startup process did not exit during bounded cleanup', { cause: error })
          }
        }
        await wait(100)
      } else {
        child.kill('SIGTERM')
        await wait(800)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
  }
  if (cleanupError) throw cleanupError
  assert.ok(child.exitCode === 0 || requestedMacTermination && child.signalCode === 'SIGTERM', 'The owned startup acceptance process did not stop as expected')
  return { ...observation, workbenchOpened: true, processExit: { code: child.exitCode, signal: child.signalCode } }
}

export async function observeStartupWithCaptureRetry(options, expected, dependencies) {
  const missedCaptures = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return { ...await observeInstalledStartup(options, expected, { ...dependencies,
        checkpoint: (stage, details) => dependencies.checkpoint?.(attempt, stage, details) }), captureAttempts: attempt }
    } catch (error) {
      // A DevTools target can disappear while the real 1.2-second splash is
      // being attached. Retry only that missed capture in a fresh profile.
      if (error?.message !== missedStartupCapture) throw error
      missedCaptures.push(error.diagnostics)
      await dependencies.checkpoint?.(attempt, 'splash-capture-missed', error.diagnostics)
      if (attempt === 3) throw Object.assign(error, { diagnostics: missedCaptures })
    }
  }
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
  const report = { schemaVersion: 1, scope: 'private-exact-package-startup-appearance', status: 'running',
    sourceHead, version, provenance, installedAsarSha256: installed.asarSha256, observations: [], cases: [], productionTouched: false }
  const reportPath = join(evidenceDir, 'windows-startup-appearance.json')
  const writeReport = async () => {
    await writeFile(`${reportPath}.tmp`, `${JSON.stringify(report, null, 2)}\n`)
    await rename(`${reportPath}.tmp`, reportPath)
  }
  try {
    const errors = []
    for (const expected of windowsStartupCases) {
      const result = { locale: expected.locale, theme: expected.theme, scale: expected.scale, status: 'running', checkpoints: [] }
      report.cases.push(result)
      try {
        report.observations.push(await observeStartupWithCaptureRetry({ executable, version, evidenceDir, temporary }, expected, {
          connectCdp: dependencies.connectCdp, environmentForRoot: dependencies.windowsUiEnvironment,
          windowsOwnedWindowScript: dependencies.windowsOwnedWindowScript,
          checkpoint: async (attempt, stage, details) => {
            result.checkpoints.push({ attempt, stage, time: new Date().toISOString(), details })
            await writeReport()
          }
        }))
        result.status = 'passed'
      } catch (error) {
        result.status = 'failed'
        result.error = error.message
        result.diagnostics = error.diagnostics
        errors.push(`${expected.locale} ${expected.theme} ${expected.scale}: ${result.error}`)
      }
      await writeReport()
    }
    report.packageUnchanged = inspectInstalledPackage(dirname(executable), identity).asarSha256 === installed.asarSha256
    assert.equal(report.packageUnchanged, true)
    assert.deepEqual(errors, [], 'Each startup and workbench case must pass')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    throw error
  } finally {
    await writeReport()
  }
  return report
}
