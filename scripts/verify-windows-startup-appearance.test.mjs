import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchWindowsSmokeEntry } from './run-windows-ui-smoke.mjs'
import { gatekeeperEnforcement, isolatedMacDmgMember, validateIsolatedMacStartupBundle, validateMacStartupArtifact } from './run-mac-startup-appearance-smoke.mjs'
import { observeStartupTargets, observeWorkbenchTypography, validateNarrowWorkbenchComposer, validateStartupAppearance, waitForStartupCondition, windowsStartupCases } from './verify-packaged-startup-appearance.mjs'

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height })
const dark = { htmlLang: 'zh-CN', theme: 'dark', scale: 1.25 }
const light = { htmlLang: 'en', theme: 'light', scale: 1 }
const observed = () => ({
  title: 'RailWise AI', subtitle: '基于本地优先架构的智能协同工作台', subtitleLang: 'zh-CN',
  locale: 'zh-CN', theme: 'dark', viewport: { width: 240, height: 184, scale: 1.25 },
  versionVisible: false, progress: 42, status: '正在载入扩展',
  geometry: { logo: box(80, 12, 80, 40), title: box(63, 59, 114, 23), subtitle: box(22, 87, 196, 38),
    bar: box(22, 142, 196, 2), status: box(70, 153, 100, 17), textLines: [box(25, 87, 190, 18), box(55, 105, 130, 18)] }
})

test('accepts the full Chinese branding and intact wrapping in both startup appearances', () => {
  const snapshot = observed()
  assert.equal(validateStartupAppearance(snapshot, dark), snapshot)
  const english = { ...snapshot, theme: 'light', locale: 'en', viewport: { ...snapshot.viewport, scale: 1 }, status: 'Preparing workspace' }
  assert.equal(validateStartupAppearance(english, light), english)
})

test('rejects a version label, wrong scale and clipped Chinese text', () => {
  assert.throws(() => validateStartupAppearance({ ...observed(), versionVisible: true }, dark))
  assert.throws(() => validateStartupAppearance(observed(), { ...dark, scale: 1 }), /viewport scale/)
  const snapshot = observed()
  snapshot.geometry.textLines[1] = box(90, 105, 160, 18)
  assert.throws(() => validateStartupAppearance(snapshot, dark), /fit inside/)
})

test('keeps 100%, 125%, and 150% startup cases with a real minimum workbench probe at 150%', () => {
  assert.deepEqual(windowsStartupCases.map(item => item.scale), [1, 1.25, 1.5])
  const highestScale = windowsStartupCases[2]
  assert.equal(highestScale.narrowWorkbench, true)
  const native = observed()
  native.viewport.scale = 1.5
  assert.equal(validateStartupAppearance(native, highestScale), native)
})

test('keeps an early splash connection open until the transitional window and logo are visible', async () => {
  const splash = { url: 'data:text/html;charset=UTF-8,splash', webSocketDebuggerUrl: 'splash' }
  const renderer = { url: 'file:///app.asar/out/renderer/index.html', webSocketDebuggerUrl: 'renderer' }
  const targets = [null, [renderer], [renderer, splash], [renderer, splash], [renderer, splash], [renderer]]
  const phases = [{ phase: 'logo-loading' }, { phase: 'window-hidden' }, { phase: 'visible', ...observed() }]
  const attachments = []
  let screenshotCaptured = false
  let splashDetached = false
  const main = { evaluate: async () => targets.length === 0 }
  const result = await observeStartupTargets({
    listTargets: async () => targets.shift(), needsScreenshot: true,
    connectCdp: async target => {
      attachments.push(target)
      if (target === 'renderer') return main
      return { evaluate: async () => phases.shift(), send: async method => {
        assert.equal(method, 'Page.captureScreenshot')
        screenshotCaptured = true
        return { data: 'aGVsbG8=' }
      }, close: () => { splashDetached = true } }
    }
  })
  assert.deepEqual(attachments, ['renderer', 'splash'])
  assert.equal(result.main, main)
  assert.deepEqual(result.observation, observed())
  assert.equal(screenshotCaptured, true)
  assert.equal(result.screenshot.toString(), 'hello')
  assert.equal(splashDetached, true)
})

test('reports a seen but hidden splash as a missed real capture', async () => {
  const splash = { url: 'data:text/html,splash', webSocketDebuggerUrl: 'splash' }
  const renderer = { url: 'file:///app.asar/out/renderer/index.html', webSocketDebuggerUrl: 'renderer' }
  const targets = [[splash], [renderer]]
  const closed = []
  await assert.rejects(observeStartupTargets({ listTargets: async () => targets.shift(),
    connectCdp: async target => ({ evaluate: async () => target === 'splash' ? { phase: 'window-hidden' } : true,
      close: () => closed.push(target), send: async method => assert.equal(method, 'Page.close') }) }), error => {
    assert.match(error.message, /real transitional startup window was not captured/)
    assert.deepEqual(error.diagnostics, { endpointAvailable: true, splashTargetSeen: true, rendererTargetSeen: true,
      splashReadiness: 'window-hidden', splashReadErrors: 0 })
    return true
  })
  assert.deepEqual(closed, ['renderer', 'splash'])
})

test('startup readiness limits each renderer evaluation to the remaining stage time', async () => {
  const budgets = []
  const cdp = { evaluate: async (expression, budget) => {
    assert.equal(expression, 'ready')
    budgets.push(budget)
    return false
  } }
  await assert.rejects(waitForStartupCondition(cdp, 'ready', 'the actual ready window', 30), /actual ready window/)
  assert.ok(budgets.length > 0)
  assert.ok(budgets.every(budget => budget > 0 && budget <= 30))
})

test('startup typography inspects a real composer label when the compact sidebar is hidden', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    window.document.body.innerHTML = '<aside class="ds-sidebar-shell" inert><button class="w-full">新建会话</button></aside><main class="ds-floating-composer"><div class="ds-composer-model-picker"><button><span style="visibility: visible; font-family: RailWise UI; font-size: 14px; line-height: 20px">自动选择模型</span></button></div></main>'
    const sidebar = window.document.querySelector('aside button')
    const composer = window.document.querySelector('main button')
    const label = composer.querySelector('span')
    for (const element of [sidebar, composer, label]) {
      element.getClientRects = () => [box(20, 40, 120, 25)]
      element.getBoundingClientRect = () => box(20, 40, 120, 25)
    }
    Object.defineProperty(window.document, 'fonts', { value: { ready: Promise.resolve() } })
    const cdp = {
      evaluate: async (expression, budget) => {
        assert.ok(budget > 0 && budget <= 5000)
        return window.eval(expression)
      },
      send: async (method, parameters, budget) => {
        assert.ok(budget > 0 && budget <= 5000)
        if (method === 'Runtime.evaluate') {
          assert.equal(window.eval(parameters.expression), label)
          return { result: { objectId: 'composed-label' } }
        }
        if (method === 'DOM.requestNode') return { nodeId: 11 }
        if (method === 'CSS.getPlatformFontsForNode') {
          assert.equal(parameters.nodeId, 11)
          return { fonts: [{ familyName: 'Noto Sans SC', isCustomFont: true, glyphCount: 6 }] }
        }
      }
    }
    const observed = await observeWorkbenchTypography(cdp)
    assert.equal(observed.fontSize, '14px')
    assert.equal(observed.lineHeight, '20px')
  } finally { await window.happyDOM.close() }
})

test('accepts bounded composer controls and rejects horizontal overflow, hit obstruction, and an oversized viewport', () => {
  const geometry = {
    viewport: { width: 960, height: 640, scale: 1.5 }, horizontalOverflow: false,
    composer: box(130, 480, 700, 140), textarea: box(142, 496, 675, 48), toolbar: box(142, 550, 675, 52),
    general: { ...box(483, 559, 113, 36), hit: true, label: 'General', clipped: false },
    model: { ...box(600, 559, 158, 36), hit: true }, send: { ...box(768, 557, 40, 40), hit: true }
  }
  assert.equal(validateNarrowWorkbenchComposer(geometry, 1.5), geometry)
  assert.doesNotThrow(() => validateNarrowWorkbenchComposer({ ...geometry, general: null }, 1.5))
  assert.throws(() => validateNarrowWorkbenchComposer({ ...geometry, horizontalOverflow: true }, 1.5), /horizontal/)
  assert.throws(() => validateNarrowWorkbenchComposer({ ...geometry, model: { ...geometry.model, hit: false } }, 1.5), /pointer/)
  assert.throws(() => validateNarrowWorkbenchComposer({ ...geometry, general: { ...geometry.general, clipped: true } }, 1.5), /readable/)
  assert.throws(() => validateNarrowWorkbenchComposer({ ...geometry, viewport: { ...geometry.viewport, width: 1280 } }, 1.5), /minimum-width/)
})

test('selects the scoped startup runner without starting regular UI or task fixtures', async () => {
  const unexpected = () => assert.fail('Only the real startup-specific driver is allowed')
  const runStartupAppearance = (options, helpers) => {
    assert.equal(typeof helpers.connectCdp, 'function')
    assert.equal(typeof helpers.windowsUiEnvironment, 'function')
    return options
  }
  const driver = { runUi: unexpected, runDiagnostic: unexpected, runStartupAppearance }
  const args = ['RailWise AI.exe', '0.5.9', 'a'.repeat(40), '/evidence']
  const expected = { executable: args[0], version: args[1], sourceHead: args[2], evidenceDir: args[3] }
  assert.deepEqual(await dispatchWindowsSmokeEntry([...args, '--startup-appearance'], {}, driver), expected)
  assert.deepEqual(await dispatchWindowsSmokeEntry(args, { RAILWISE_WINDOWS_STARTUP_APPEARANCE_SMOKE: 'true' }, driver), expected)
  await assert.rejects(dispatchWindowsSmokeEntry([...args, '--startup-appearance', '--task-smoke'], {}, driver), /exclusive/)
})

test('binds native Mac startup acceptance to a successful immutable release build', () => {
  const source = { repository: 'railwise-cn/railwise-ai', workflow: '.github/workflows/release.yml', sourceHead: 'a'.repeat(40),
    driverHead: 'b'.repeat(40), runId: 100, runAttempt: 1, buildConclusion: 'success', artifactName: 'release-mac',
    artifactId: 200, artifactDigest: `sha256:${'c'.repeat(64)}`, artifactExpired: false,
    changedFiles: ['scripts/run-mac-startup-appearance-smoke.mjs'] }
  assert.equal(validateMacStartupArtifact(source), source)
  assert.throws(() => validateMacStartupArtifact({ ...source, changedFiles: ['src/main/splash-window.ts'] }), /Application source differs/)
  assert.throws(() => validateMacStartupArtifact({ ...source, artifactExpired: true }))
  assert.throws(() => validateMacStartupArtifact({ ...source, artifactName: 'release-win' }))
  const isolated = { ...source, classification: 'isolated-unreviewed', publicReleaseApproved: false,
    buildHead: source.sourceHead, buildJob: 'Build macOS', buildJobId: 300 }
  assert.equal(validateMacStartupArtifact(isolated, { isolated: true }), isolated)
  assert.throws(() => validateMacStartupArtifact(isolated), /explicit opt-in/)
  for (const patch of [{ publicReleaseApproved: true }, { buildHead: source.driverHead }, { buildJobId: 0 }, { classification: undefined }]) {
    assert.throws(() => validateMacStartupArtifact({ ...isolated, ...patch }, { isolated: true }))
  }
})

test('isolated Mac startup accepts only the exact installer entries and loopback feed', () => {
  const installers = ['latest-mac.yml', 'RailWise-AI-0.5.10-mac-arm64.dmg', 'RailWise-AI-0.5.10-mac-arm64.zip',
    'RailWise-AI-0.5.10-mac-x64.dmg', 'RailWise-AI-0.5.10-mac-x64.zip']
  assert.equal(isolatedMacDmgMember(installers, '0.5.10', 'arm64'), installers[1])
  assert.equal(isolatedMacDmgMember(installers, '0.5.10', 'x64'), installers[3])
  for (const entry of ['reviewed-build.json', installers[1], '../' + installers[3]]) {
    assert.throws(() => isolatedMacDmgMember([...installers, entry], '0.5.10', 'arm64'), /artifact entries/)
  }
  const packaged = { updateChannel: 'frontier', buildHints: { macSigningEnabled: true, notarizationEnabled: true } }
  const updater = { provider: 'generic', url: 'https://127.0.0.1/' }
  assert.doesNotThrow(() => validateIsolatedMacStartupBundle(packaged, updater))
  assert.throws(() => validateIsolatedMacStartupBundle({ ...packaged, updateChannel: 'stable' }, updater))
  assert.throws(() => validateIsolatedMacStartupBundle(packaged, { ...updater, url: 'https://www.railwise.cn/' }))
})

test('records Gatekeeper enforcement separately from a successful bundle assessment', () => {
  assert.equal(gatekeeperEnforcement('assessments enabled\n'), 'enabled')
  assert.equal(gatekeeperEnforcement('assessments disabled\n'), 'disabled')
  assert.equal(gatekeeperEnforcement('status unavailable'), 'unknown')
  assert.equal(gatekeeperEnforcement(null), 'unknown')
})
