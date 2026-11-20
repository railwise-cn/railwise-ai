import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchWindowsSmokeEntry } from './run-windows-ui-smoke.mjs'
import { validateMacStartupArtifact } from './run-mac-startup-appearance-smoke.mjs'
import { observeWorkbenchTypography, validateNarrowWorkbenchComposer, validateStartupAppearance, windowsStartupCases } from './verify-packaged-startup-appearance.mjs'

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
      wait: async expression => assert.equal(window.eval(expression), true),
      evaluate: async expression => window.eval(expression),
      send: async (method, parameters) => {
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
})
