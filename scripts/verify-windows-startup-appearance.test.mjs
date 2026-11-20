import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchWindowsSmokeEntry } from './run-windows-ui-smoke.mjs'
import { parseMacCandidateChecksums, validateMacStartupArtifact } from './run-mac-startup-appearance-smoke.mjs'
import { validateStartupAppearance } from './verify-packaged-startup-appearance.mjs'

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

test('accepts only the correctly verified, unpublished three-client candidate', () => {
  const source = { repository: 'railwise-cn/railwise-ai', workflow: '.github/workflows/release.yml', sourceHead: 'a'.repeat(40),
    driverHead: 'b'.repeat(40), runId: 100, runAttempt: 1, buildConclusion: 'success', artifactName: 'candidate-installers-0.5.10-12',
    artifactId: 200, artifactDigest: `sha256:${'c'.repeat(64)}`, artifactExpired: false,
    changedFiles: ['scripts/verify-mac-workbook.mjs'], mode: 'isolated-candidate', version: '0.5.10', runNumber: 12,
    event: 'workflow_dispatch', candidateConclusion: 'success', publicationConclusion: 'skipped' }
  assert.equal(validateMacStartupArtifact(source), source)
  assert.throws(() => validateMacStartupArtifact({ ...source, publicationConclusion: 'success' }))
  assert.throws(() => validateMacStartupArtifact({ ...source, candidateConclusion: 'failure' }))
  assert.throws(() => validateMacStartupArtifact({ ...source, artifactName: 'release-mac' }))
  assert.throws(() => validateMacStartupArtifact({ ...source, changedFiles: ['src/renderer/src/components/WorkspaceSpreadsheet.tsx'] }))
})

test('requires one SHA-256 entry for each of the three exact candidate installers', () => {
  const windows = `${'a'.repeat(64)}  RailWise-AI-0.5.10-win-x64.exe`
  const apple = `${'b'.repeat(64)}  RailWise-AI-0.5.10-mac-Apple-Silicon.dmg`
  const intel = `${'c'.repeat(64)} *RailWise-AI-0.5.10-mac-Intel.dmg`
  const manifests = [windows, apple, intel].join('\n')
  assert.equal(parseMacCandidateChecksums(manifests, '0.5.10').get('RailWise-AI-0.5.10-mac-Apple-Silicon.dmg'), 'b'.repeat(64))
  assert.throws(() => parseMacCandidateChecksums([windows, apple].join('\n'), '0.5.10'), /both macOS/)
  assert.throws(() => parseMacCandidateChecksums(manifests + '\n' + intel, '0.5.10'), /duplicate/)
  assert.throws(() => parseMacCandidateChecksums(manifests.replace('RailWise-AI-', '../RailWise-AI-'), '0.5.10'))
  assert.throws(() => parseMacCandidateChecksums(manifests, '0.5.9'))
})
