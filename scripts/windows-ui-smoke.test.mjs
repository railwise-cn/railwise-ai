import * as permissionSmokeModule from './run-windows-ui-smoke.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { windowsUiClickExpression, windowsManualArtifactTargetExpression, clickWindowsManualTaskArtifact, readonlyConnectorSetupExpression, validateDefaultSkillSources, verifyInstalledAgentPackSkill, verifyInstalledBundledSkillCopy, validateWindowsUiReport, validateWindowsTaskEvidence, validateWindowsBrowserEvidence, validateWindowsPermissionRuntimeEvidence, runInstalledWindowsPermissionAcceptance, installedPermissionWorker, startWindowsTaskModelFixture, summarizeWindowsTaskFailure, collectWindowsTaskFailure, readWindowsTaskFailureStore, summarizeWindowsFailureLogs, inspectWindowsManualPreview, windowsUiEnvironment, validateWindowsFixtureQueryHtml, reviewWindowsFixtureApproval, windowsFixtureApprovalUiExpression, windowsFixturePendingApprovals, windowsFixtureApprovalResolution, windowsSmokeWorkspaceName, inspectWindowsBrowserRecoveryState, windowsBrowserBindingUiExpression, validateWindowsBrowserRecoveryEvidence, windowsTaskPreviewLayoutExpression, validateWindowsTaskPreviewLayout, validateWindowsScheduledQueryEvidence, inspectWindowsQueryThread } from './run-windows-ui-smoke.mjs'
import { browserSmokeDependency } from './prepare-browser-skill-smoke.mjs'
import { openWindowsTaskConversation, clickWindowsBrowserBinding, selectWindowsBrowserPolicy, selectWindowsPublicQueryAuthorization, windowsBindingPostAudit, inspectWindowsBrowserPolicy, inspectWindowsTaskScopeAction, windowsTaskPrompt, windowsFixtureNativeExpectations } from './run-windows-ui-smoke.mjs'
import { inspectWindowsDocumentNavigation, observeWindowsBrowserConnect, readWindowsBrowserFailureProcesses, sanitizeWindowsBrowserProcessQuery, readWindowsBrowserOwnedState, buildWindowsFixtureWebReport, validateWindowsFixtureReportHtml, windowsFixtureVerificationInputHash, inspectWindowsWebArtifactVerification, inspectWindowsPersistedWebArtifact, windowsTaskArtifactPreviewExpression } from './run-windows-ui-smoke.mjs'
import { validateWindowsComposerMenuGeometry, validateWindowsAdaptiveWorkbenchEvidence, windowsComposerMenuKeyboardExpression, validateWindowsComposerMenuKeyboardReceipt, windowsComposerMenuExpression, windowsOwnedWindowScript } from './run-windows-ui-smoke.mjs'
import { summarizeWindowsUpdateMetadata, checkWindowsUpdateMetadata } from './run-windows-ui-smoke.mjs'

test('updater metadata diagnostics retain only safe fields and known categories, leaving unexplained failures unclassified', () => {
  const secret = 'private-query-token-do-not-export'
  for (const [message, category] of [
    ['The stable update feed is rate limited right now. Please try again later.', 'http_429'],
    ['HttpError: 429 Too Many Requests', 'http_429'],
    ['The stable update feed is temporarily unavailable. Please try again later.', 'http_5xx'],
    ['HTTP 503 Service Unavailable', 'http_5xx'],
    ['Cannot parse update info from latest.yml', 'manifest'],
    ['connect ECONNRESET', 'network'],
    ['unexplained failure', 'unclassified'],
    ['unexplained 429', 'unclassified'],
    ['unexplained failure https://example.invalid/?token=network&status=HTTP503', 'unclassified'],
    ['unexplained failure\nnetwork error in response body', 'unclassified']
  ]) {
    const summary = summarizeWindowsUpdateMetadata({ ok: false, code: 'unknown', currentVersion: '0.5.7',
      latestVersion: secret, message: `${message}\nHeaders: ${secret}\nData: ${secret}`,
      releaseUrl: `https://example.invalid/?token=${secret}`, headers: { authorization: secret }, body: secret })
    assert.equal(summary.category, category)
    assert.equal(summary.phase, 'metadata-check')
    assert.equal(summary.code, 'unknown', 'A diagnostic hint must not replace the actual updater failure code')
    assert.equal(summary.currentVersion, '0.5.7')
    assert.equal(summary.latestVersion, undefined)
    assert.doesNotMatch(JSON.stringify(summary), new RegExp(`${secret}|message|releaseUrl|headers|body`))
  }
  assert.equal(summarizeWindowsUpdateMetadata({ ok: false, code: secret }).code, 'unknown')
})

test('successful first metadata response requires one real read and retains no raw updater payload', async () => {
  const attempts = []
  let calls = 0
  const result = await checkWindowsUpdateMetadata(async () => {
    calls++
    return { ok: true, hasUpdate: false, currentVersion: '0.5.7', latestVersion: '0.5.7', releaseUrl: 'private-url' }
  }, { attempts, wait: async () => assert.fail('A successful first check must not wait or reread') })
  assert.equal(calls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.hasUpdate, false)
  assert.equal(attempts.length, 1)
  assert.deepEqual(attempts[0], { attempt: 1, ...result })
  assert.doesNotMatch(JSON.stringify({ attempts, result }), /private-url|releaseUrl/)
})

test('one bounded metadata reread preserves the first unknown or network failure before a real second success', async () => {
  for (const code of ['unknown', 'network']) {
    const attempts = [], order = []
    let calls = 0
    const result = await checkWindowsUpdateMetadata(async () => {
      order.push('read')
      return ++calls === 1 ? { ok: false, code, currentVersion: '0.5.7', message: code === 'unknown' ? 'unexplained' : 'connect ECONNRESET' }
        : { ok: true, hasUpdate: false, currentVersion: '0.5.7', latestVersion: '0.5.7' }
    }, { attempts, wait: async milliseconds => { order.push(milliseconds) } })
    assert.deepEqual(order, ['read', 2_000, 'read'])
    assert.equal(calls, 2)
    assert.equal(result.ok, true)
    assert.deepEqual(attempts.map(item => item.ok), [false, true])
    assert.equal(attempts[0].code, code)
    assert.equal(attempts[0].category, code === 'unknown' ? 'unclassified' : 'network')
    assert.doesNotMatch(JSON.stringify(attempts), /transient|message|unexplained|ECONNRESET/)
  }
})

test('persistent metadata failures stop after two reads and retain a failed final result', async () => {
  const attempts = []
  let calls = 0, waits = 0
  const result = await checkWindowsUpdateMetadata(async () => {
    calls++
    return { ok: false, code: 'unknown', currentVersion: '0.5.7', message: 'still unexplained' }
  }, { attempts, wait: async milliseconds => { assert.equal(milliseconds, 2_000); waits++ } })
  assert.equal(calls, 2)
  assert.equal(waits, 1)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unknown')
  assert.equal(result.category, 'unclassified')
  assert.deepEqual(attempts.map(item => item.ok), [false, false])
  assert.throws(() => validateWindowsUiReport({ ...report(), update: result }, identity), 'Persistent failure must still fail acceptance')
})

test('integrity, configuration, available updates and malformed responses do not get an extra metadata read', async () => {
  for (const response of [
    { ok: false, code: 'signature_invalid' }, { ok: false, code: 'not_configured' },
    { ok: false, code: 'unsupported' }, { ok: false, code: 'unsigned_build' },
    { ok: false, code: 'github_forbidden' }, { ok: false, code: 'github_repo_not_found' },
    { ok: false, code: 'unknown', message: 'SHA512 checksum mismatch' },
    { ok: false, code: 'unknown', message: 'No online update source is configured.' },
    { ok: true, hasUpdate: true }, { ok: false, hasUpdate: true, code: 'network' },
    { ok: false, code: 'unexpected-private-code' }, undefined
  ]) {
    let calls = 0
    const attempts = []
    const result = await checkWindowsUpdateMetadata(async () => { calls++; return response },
      { attempts, wait: async () => assert.fail('This result must not be retried') })
    assert.equal(calls, 1)
    assert.equal(attempts.length, 1)
    assert.equal(result.ok, response?.ok)
    assert.equal(result.hasUpdate, response?.hasUpdate)
  }
})

test('thrown metadata IPC is terminal and its raw exception is never exported, including after the one reread', async () => {
  for (const failAt of [1, 2]) {
    let calls = 0, waits = 0
    const attempts = []
    await assert.rejects(checkWindowsUpdateMetadata(async () => {
      if (++calls === failAt) throw new Error('private-message https://example.invalid/?token=secret Headers: private-header Data: private-body')
      return { ok: false, code: 'unknown' }
    }, { attempts, wait: async () => { waits++ } }), { message: 'The real updater metadata IPC did not return a result' })
    assert.equal(calls, failAt)
    assert.equal(waits, failAt - 1)
    assert.equal(attempts.length, failAt)
    assert.deepEqual(attempts.at(-1), { attempt: failAt, ok: false, category: 'ipc_exception', phase: 'ipc' })
    assert.doesNotMatch(JSON.stringify(attempts), /private|secret|Headers|Data|message/)
  }
})

test('default metadata reread waits exactly two seconds and never schedules a third read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const result = checkWindowsUpdateMetadata(async () => { calls++; return { ok: false, code: 'network' } })
  await Promise.resolve()
  t.mock.timers.tick(1_999)
  await Promise.resolve()
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal((await result).ok, false)
  assert.equal(calls, 2)
  t.mock.timers.tick(60_000)
  assert.equal(calls, 2)
})

test('composer menu geometry uses actual viewport rectangles at both supported font scales', () => {
  const actual = { coordinateUnit: 'viewport-css-px', side: 'top', menuCount: 1, itemCount: 3, hitTest: true,
    viewport: { left: 0, top: 0, width: 960, height: 640 },
    anchor: { left: 450, top: 580, right: 650, bottom: 616, width: 200, height: 36 },
    menu: { left: 550, top: 272, right: 850, bottom: 572, width: 300, height: 300 },
    keyboard: { before: { focusReady: true, menuOpen: true, openMenuCount: 1, menuOwnsFocus: true, selectionFocused: true, triggerExpanded: true, focusRole: 'menuitemradio' }, after: { menuOpen: false, openMenuCount: 0, triggerExpanded: false, triggerFocused: true, focusTag: 'BUTTON' } } }
  for (const bodyZoom of [0.9, 1.1]) assert.equal(validateWindowsComposerMenuGeometry({ ...actual, bodyZoom }), true)
  const scenario = (font, bodyZoom) => ({ font, agent: { ...actual, bodyZoom, escapeFocusRestored: true }, model: { ...actual, bodyZoom, escapeFocusRestored: true } })
  const evidence = { status: 'passed', input: 'renderer-cdp-real-input', resizeMethod: 'verified-pid-native-window', scenarios: [scenario('small', 0.9), { ...scenario('large', 1.1), navigation: { modal: true, mainInert: true, width: 280, viewportWidth: 960 } }] }
  assert.equal(validateWindowsAdaptiveWorkbenchEvidence(evidence), true)
  assert.throws(() => validateWindowsAdaptiveWorkbenchEvidence(undefined))
  assert.throws(() => validateWindowsAdaptiveWorkbenchEvidence({ ...evidence, status: 'not_executed' }))
  assert.throws(() => validateWindowsAdaptiveWorkbenchEvidence({ ...evidence, scenarios: [evidence.scenarios[0]] }))
  assert.throws(() => validateWindowsAdaptiveWorkbenchEvidence({ ...evidence, scenarios: [evidence.scenarios[0], { ...evidence.scenarios[1], navigation: { modal: true, mainInert: false, width: 280, viewportWidth: 960 } }] }))
  assert.throws(() => validateWindowsComposerMenuGeometry({ ...actual, menu: { ...actual.menu, left: 5, right: 305 } }), /real composer trigger/)
  assert.throws(() => validateWindowsComposerMenuGeometry({ ...actual, menu: { ...actual.menu, top: -8 } }), /visual viewport/)
  assert.throws(() => validateWindowsComposerMenuGeometry({ ...actual, hitTest: false }), /pointer input/)
  assert.throws(() => validateWindowsComposerMenuGeometry({ ...actual, menuCount: 2 }), /One composer menu/)
})

test('composer keyboard receipts require actual selection focus before Escape and retain the original close/focus gate', () => {
  const before = { focusReady: true, menuOpen: true, openMenuCount: 1, menuOwnsFocus: true, selectionFocused: true, triggerExpanded: true, focusRole: 'menuitemradio' }
  const after = { menuOpen: false, openMenuCount: 0, triggerExpanded: false, triggerFocused: true, focusTag: 'BUTTON' }
  assert.equal(validateWindowsComposerMenuKeyboardReceipt(before, after), true)
  for (const change of [{ focusReady: false }, { menuOwnsFocus: false }, { selectionFocused: false }, { focusRole: null }]) assert.throws(() => validateWindowsComposerMenuKeyboardReceipt({ ...before, ...change }, after))
  for (const change of [{ menuOpen: true }, { openMenuCount: 1 }, { triggerFocused: false }, { triggerExpanded: true }]) assert.throws(() => validateWindowsComposerMenuKeyboardReceipt(before, { ...after, ...change }))
  const probe = windowsComposerMenuKeyboardExpression('切换智能体')
  assert.match(probe, /menu.contains\(active\)/)
  assert.match(probe, /active===selected/)
  assert.doesNotMatch(probe, /\.focus\(|dispatchEvent|scrollIntoView/)
})

test('installed UI probes select the actual controlled menu and constrain native resizing to an owned numeric PID', () => {
  assert.match(windowsComposerMenuExpression('模型与推理设置'), /getBoundingClientRect/)
  assert.match(windowsComposerMenuExpression('切换智能体'), /getElementById/)
  assert.throws(() => windowsOwnedWindowScript('7; other-command'), /assertion|expression|false/i)
  assert.throws(() => windowsOwnedWindowScript(7, { left: 0, top: 0, width: 1, height: 680 }))
  const script = windowsOwnedWindowScript(7, { left: 0, top: 0, width: 960, height: 680, windowState: 'normal' })
  assert.match(script, /GetWindowThreadProcessId/)
  assert.match(script, /windowOwnerId -ne 7/)
  assert.match(script, /SetWindowPos/)
  assert.doesNotMatch(script, /MainModule|runtimeRequest|Invoke-Expression|Start-Process/)
})

const identity = { version: '0.5.6', sourceHead: 'a'.repeat(40) }
// Validator input only; these synthetic projections are never acceptance receipts.
const syntheticWebArtifactVerification = (fixtureUrl = 'http://127.0.0.1:1234/fixture', artifactHash = 'a'.repeat(64)) => ({
  complete: true, reasons: [], artifactHash, evidenceReceiptId: 'synthetic-verification', persistedReceiptVerified: true,
  sourceReceipts: [fixtureUrl, new URL('/fixture/detail', fixtureUrl).href].map((url, index) => ({ receiptId: 'synthetic-read-' + index,
    turnId: 'synthetic-turn', url, resultHash: 'b'.repeat(64), full: true, readAt: '2026-11-15T00:00:00Z' }))
})

test('successful connect is single-shot and reads markers without warming PowerShell', async () => {
  const calls = []; let clock = 10
  const result = await observeWindowsBrowserConnect({ now: () => clock++,
    readState: async () => { calls.push('state'); return { owner: { exists: false } } },
    connect: async () => { calls.push('connect'); return { ok: true } },
    diagnose: async () => { throw new Error('Unexpected diagnosis') },
    readFailureProcesses: async () => { throw new Error('PowerShell must not run on success') } })
  assert.deepEqual(calls, ['state', 'connect', 'state'])
  assert.equal(result.result.ok, true)
  assert.equal(result.audit.durationMs, 1)
  assert.equal(result.audit.failureDiagnostics, undefined)
})

test('failed connect retains its original error and diagnoses once before bounded process reads', async () => {
  const calls = [], original = new Error('browser_daemon_identity_unverified'); let clock = 100
  await assert.rejects(observeWindowsBrowserConnect({ now: () => clock++,
    readState: async () => { calls.push('state'); return { owner: { exists: false } } },
    connect: async () => { calls.push('connect'); throw original },
    diagnose: async () => { calls.push('diagnose'); return { ok: true, status: { state: 'needs_extension', revision: 1, message: 'SECRET', browsers: [] } } },
    readFailureProcesses: async deadline => { calls.push('processes'); assert.equal(deadline, 20_102); throw Object.assign(new Error('SECRET'), { code: 'ETIMEDOUT' }) }
  }), error => error === original)
  assert.deepEqual(calls, ['state', 'connect', 'diagnose', 'processes', 'state'])
  const audit = original.browserConnectAudit
  assert.equal(audit.failureDiagnostics.budgetMs, 20_000)
  assert.equal(audit.failureDiagnostics.diagnosis.state, 'needs_extension')
  assert.equal(audit.failureDiagnostics.processes.errorCategory, 'ETIMEDOUT')
  assert.equal(JSON.stringify(audit).includes('SECRET'), false)
})

test('failure process diagnostics query only the exact binary and production ticks expression', async () => {
  const executablePath = "D:\\owned's tools\\browser-skill\\versions\\fixed\\bsk.exe", calls = []
  const raw = { exitCode: 0, signal: null, durationMs: 12, stdout: JSON.stringify([
    { pid: 3324, executablePath, creationDate: '2026-11-13T22:57:16.1234567Z', commandLine: 'SECRET', environment: 'SECRET' },
    { pid: 9999, executablePath: 'D:\\another\\bsk.exe', creationDate: '2026-11-13T22:57:16Z' }
  ]) }
  const result = await readWindowsBrowserFailureProcesses({ executablePath, deadline: 20_000, now: () => 0,
    query: async (command, timeout) => {
      calls.push({ command, timeout })
      return calls.length === 1 ? raw : calls.length === 2
        ? { exitCode: null, signal: 'SIGKILL', durationMs: 3000, timedOut: true, stdout: 'SECRET', stderr: 'SECRET' }
        : { exitCode: 0, signal: null, durationMs: 22, stdout: '638986138361234567\r\n', stderr: '' }
    } })
  assert.match(calls[0].command, /Get-CimInstance/)
  assert.ok(calls[0].command.includes("owned''s tools"))
  assert.doesNotMatch(calls[0].command, /CommandLine|Environment|Invoke|Start-Process/i)
  assert.deepEqual(calls.slice(1).map(call => call.command), Array(2).fill('(Get-Process -Id 3324 -ErrorAction Stop).StartTime.ToUniversalTime().Ticks'))
  assert.deepEqual(calls.map(call => call.timeout), [4000, 3000, 3000])
  assert.equal(result.processes.length, 1)
  assert.equal(result.processes[0].identityAttempts[0].errorCategory, 'timeout')
  assert.equal(result.processes[0].identityAttempts[0].signal, 'SIGKILL')
  assert.equal(result.processes[0].identityAttempts[1].ticks, '638986138361234567')
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})

test('process diagnostics stop at the read-only budget and redact non-tick output and errors', async () => {
  let calls = 0
  assert.deepEqual(await readWindowsBrowserFailureProcesses({ executablePath: 'D:\\owned\\bsk.exe', deadline: 2, now: () => 3,
    query: async () => { calls++; throw new Error('Must not run') } }), { budgetExhausted: true, processes: [] })
  assert.equal(calls, 0)
  const invalid = sanitizeWindowsBrowserProcessQuery({ stdout: 'ticks SECRET', stderr: '', exitCode: 0, durationMs: 3 }, { ticks: true })
  assert.equal(invalid.errorCategory, 'invalid_output')
  assert.equal(JSON.stringify(invalid).includes('SECRET'), false)
  const denied = sanitizeWindowsBrowserProcessQuery({ stdout: 'SECRET', stderr: 'AccessDenied SECRET', exitCode: 1, signal: null, durationMs: 3 }, { executablePath: 'D:\\owned\\bsk.exe' })
  assert.equal(denied.errorCategory, 'access_denied')
  assert.deepEqual(denied.processes, [])
})

test('owned daemon diagnostics hash the marker without retaining its contents or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'windows-owner-diagnostic-'))
  try {
    const directory = join(root, 'browser-skill'), executablePath = join(directory, 'versions', 'fixed', 'bsk.exe')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'owned-daemon.json'), JSON.stringify({ pid: 3324, fingerprint: 'win32:123', unexpected: 'SECRET' }))
    await writeFile(join(directory, 'connection.json'), JSON.stringify({ state: 'daemon_stopped', version: '0.4.0', revision: 1, executablePath, executableHash: 'a'.repeat(64), unexpected: 'SECRET' }))
    const state = await readWindowsBrowserOwnedState({ toolsRoot: root, executablePath })
    assert.equal(state.connection.configuration.matchesFixedExecutable, true)
    assert.match(state.owner.sha256, /^[a-f0-9]{64}$/)
    assert.equal(JSON.stringify(state).includes('SECRET'), false)
    await assert.rejects(readWindowsBrowserOwnedState({ toolsRoot: root, executablePath: join(root, 'external', 'bsk.exe') }))
  } finally { await rm(root, { recursive: true, force: true }) }
})

function permissionRuntimeEvidence() {
  // Validator input only; the real worker is never run by the ordinary Node suite.
  return { schemaVersion: 1, scope: 'compiled-runtime-owned-file-permission', status: 'passed', platform: 'win32',
    actualSystemClock: true, actualOsJunction: true, installedPackageRuntime: true, realModel: false, uiAuthorizationClaimed: false,
    productionTouched: false, externalModelCalls: 0, unexpectedApprovals: 0,
    checks: ['read-only-chinese-space-workspace-managed-artifact', 'explicit-task-grant-exports-to-chinese-space-directory',
      'changed-os-junction-cannot-reuse-original-task-path-grant', 'real-expiry-blocks-captured-old-execution-grant',
      'replacement-does-not-revive-the-old-immutable-grant', 'http-revocation-invalidates-captured-live-grant'],
    managedArtifact: { validated: true, workspaceFiles: 0, sha256: 'a'.repeat(64) },
    exportedArtifact: { matchedInputHtml: true, sha256: 'a'.repeat(64), file: '指定 中文导出/验收 报告.html', workspaceTrust: 'read-only',
      sandboxMode: 'workspace-write', workspaceWriteException: true, writeReceipts: 1 },
    junction: { initialTargetVerified: true, changedTargetVerified: true, forbiddenFiles: 0, code: 'workspace_path_blocked' },
    expiry: { elapsedThroughRealExpiry: true, code: 'task_permission_expired' }, replacedGrant: { oldPermissionRejected: 'task_permission_revoked' },
    revocation: { taskPaused: true, code: 'task_permission_revoked' } }
}
function report() {
  // Validator fixtures do not supply actual Windows UI acceptance evidence.
  return {
    schemaVersion: 1, scope: 'private-exact-package-chinese-ui', platform: 'win32', ...identity,
    locale: 'zh', theme: 'dark', workspaceRoot: `D:\\owned\\${windowsSmokeWorkspaceName}`, productionTouched: false, packageUnchanged: true, cleanExit: true,
    errors: [], tabs: ['技能', '插件', '连接器'], chapters: Array.from({ length: 13 }, (_, index) => index + 1),
    update: { ok: true, hasUpdate: false }, helpOffline: true,
    taskSmokeRequested: true,
    permissionRuntime: permissionRuntimeEvidence(),
    taskExecution: { model: 'local-protocol-fixture', status: 'completed', artifact: { format: 'html', validation: 'valid', sha256: 'a'.repeat(64), byteHashMatches: true },
      schedule: { times: ['08:30', '16:30'], timezone: 'Asia/Shanghai', enabled: true, nextRunAt: '2026-11-14T00:30:00Z', readBackFromTool: true },
      preview: { automatic: true, contentVerified: true, manualEntryVerified: true,
        layout: { coordinateUnit: 'viewport-css-px', scale: 1, workspace: { width: 560 }, workspaceInlineSize: 560, readableWidth: 400, availableWidth: 520, stackThresholdPx: 704, details: { width: 520, x: 20, y: 300, bottom: 800 }, list: { width: 520, x: 20, y: 20, bottom: 280 }, overflow: { workspace: 0, columns: 0, details: 0 } } },
      dueOccurrence: { clock: 'real', status: 'completed', independentTask: true, independentArtifact: true, byteHashMatches: true,
        dueAt: '2026-11-13T00:00:00Z', createdAt: '2026-11-13T00:00:10Z' } },
    resources: {
      defaultSkills: ['ppt-master', 'tender-master', 'di-bao-monitoring'].map(id => ({
        id, name: id,
        source: id === 'ppt-master'
          ? { type: 'github', owner: 'hugohe3', repo: 'ppt-master', path: 'skills/ppt-master', ref: 'v6.8.0', installedSha: '5e8856be0da8e6bc85c4aa28acc614478f7b7137', overlaySkillId: 'ppt-master', autoUpdate: false }
          : { type: 'bundled', id },
        entryRelativePath: `resources/app.asar.unpacked/src/asset/skills/${id}/SKILL.md`,
        entrySha256: 'd'.repeat(64), entryRegisteredInAsar: true
      })),
      engineeringSkills: ['资料盘点与来源索引', '监测质检与图表', '工程文档差异审阅', '会议纪要与待办'].map(name => ({ name, installEnabled: true })),
      connectors: ['amap-maps', 'zotero-mcp'].map(id => ({ id, detailsReady: true, catalogSourceType: 'built-in' })),
      connectionsUnchanged: true,
      cad: ['autocad-dwg-redraw', 'autocad-image-redraw'].map(id => ({
        id, catalogSourceType: 'built-in', commit: 'ed182ec5966caaaf1d82d6ad4015435a27a8a909',
        archiveSha256: '1981737a34085f1e9d1e9f9cb5a1d989b6bb75506f2d9b064bc20cda35239b0e',
        sourceUrl: `https://github.com/pengxiaoan/autocad-dwg-redraw-skill/tree/ed182ec5966caaaf1d82d6ad4015435a27a8a909/skills/${id}`,
        installEnabled: true, dependenciesVisible: true, licenseNoticeVisible: true
      }))
    },
    checks: ['installed-chinese-renderer', 'skills-default-and-tab-order', 'plugins-tab',
      'connectors-tab', 'github-actionable-setup', 'no-update-control-hidden', 'offline-help-thirteen-chapters',
      'offline-help-search-and-navigation', 'offline-help-images', 'personal-homepage-absent',
      'packaged-skills-and-engineering-entries', 'amap-zotero-actionable-setup', 'autocad-fixed-upstream-entries', 'runtime-task-html-and-daily-schedule', 'installed-runtime-file-permission']
  }
}

test('isolated ordinary package environment keeps public identity and removes account and updater overrides', () => {
  assert.match(windowsSmokeWorkspaceName, /\p{Script=Han}/u)
  assert.ok(windowsSmokeWorkspaceName.includes(' '))
  const root = join('owned-runner-temp', 'ui')
  const result = windowsUiEnvironment({ PATH: 'system', SYSTEMROOT: 'windows', DEEPSEEK_API_KEY: 'secret', GH_TOKEN: 'secret',
    WORKWISE_CANDIDATE: '1', WORKWISE_UPDATE_PROVIDER: 'none', RELEASE_CHANNEL: 'frontier', NODE_OPTIONS: '--require arbitrary' }, root)
  assert.equal(result.PATH, 'system')
  assert.equal(result.SYSTEMROOT, 'windows')
  assert.equal(result.USERPROFILE, join(root, 'home'))
  assert.equal(result.APPDATA, join(root, 'home', 'AppData', 'Roaming'))
  assert.equal(result.WORKWISE_TOOLS_ROOT, join(root, 'home', '.workwise', 'tools'))
  assert.equal(result.BSK_HOME, join(root, 'home', '.bsk'))
  for (const key of ['DEEPSEEK_API_KEY', 'GH_TOKEN', 'WORKWISE_CANDIDATE', 'WORKWISE_UPDATE_PROVIDER', 'RELEASE_CHANNEL', 'NODE_OPTIONS']) assert.equal(result[key], undefined)
})

test('Windows Chinese UI evidence requires every actual production surface observation', () => {
  assert.equal(validateWindowsUiReport(report(), identity), true)
  for (const check of report().checks) {
    const missing = report()
    missing.checks = missing.checks.filter(value => value !== check)
    assert.throws(() => validateWindowsUiReport(missing, identity), check === 'installed-runtime-file-permission'
      ? /Missing actual installed Runtime permission evidence/ : /Missing actual UI observation/)
  }
})

test('installed Windows permission acceptance requires every actual OS and grant observation without substituting local or UI claims', () => {
  const valid = permissionRuntimeEvidence()
  assert.equal(validateWindowsPermissionRuntimeEvidence(valid), true)
  assert.throws(() => validateWindowsPermissionRuntimeEvidence(undefined))
  for (const check of valid.checks) {
    const missing = structuredClone(valid)
    missing.checks = missing.checks.filter(item => item !== check)
    assert.throws(() => validateWindowsPermissionRuntimeEvidence(missing))
  }
  for (const [field, value] of [['status', 'failed'], ['platform', 'darwin'], ['actualOsJunction', false], ['installedPackageRuntime', false],
    ['actualSystemClock', false], ['realModel', true], ['uiAuthorizationClaimed', true], ['productionTouched', true], ['externalModelCalls', 1], ['unexpectedApprovals', 1]]) {
    assert.throws(() => validateWindowsPermissionRuntimeEvidence({ ...valid, [field]: value }))
  }
  for (const [part, field, value] of [['managedArtifact', 'workspaceFiles', 1], ['exportedArtifact', 'sha256', 'b'.repeat(64)],
    ['exportedArtifact', 'writeReceipts', 0], ['exportedArtifact', 'workspaceWriteException', false], ['junction', 'forbiddenFiles', 1],
    ['junction', 'changedTargetVerified', false], ['expiry', 'elapsedThroughRealExpiry', false], ['expiry', 'code', 'succeeded'],
    ['replacedGrant', 'oldPermissionRejected', 'succeeded'], ['revocation', 'taskPaused', false], ['revocation', 'code', 'succeeded']]) {
    const missing = structuredClone(valid); missing[part][field] = value
    assert.throws(() => validateWindowsPermissionRuntimeEvidence(missing))
  }
  const omitted = report(); delete omitted.permissionRuntime
  assert.throws(() => validateWindowsUiReport(omitted, identity, { requireTaskExecution: true }))
})

test('installed permission wrapper uses the exact EXE and packaged Runtime with bounded owned cleanup before business UI actions', () => {
  const ui = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  const wrapper = runInstalledWindowsPermissionAcceptance.toString()
  assert.match(wrapper, /spawn\(executable, \[workerFile\]/)
  assert.match(wrapper, /ELECTRON_RUN_AS_NODE: '1'/)
  assert.match(wrapper, /'app\.asar\.unpacked', 'kun', 'dist'/)
  assert.match(wrapper, /fs\.mkdtemp\(path\.join\(temporaryRoot,/)
  assert.match(wrapper, /installedPermissionWorker\.toString\(\)/)
  assert.match(wrapper, /readWindowsPermissionExecutionTurn\.toString\(\)/)
  assert.equal((installedPermissionWorker.toString().match(/await poll\(\(\) => readWindowsPermissionExecutionTurn/g) ?? []).length, 2)
  assert.match(wrapper, /150_000/)
  assert.match(wrapper, /if \(childExited\) await fs\.rm\(ownedRoot/)
  assert.doesNotMatch(wrapper, /Date\.now\s*=|setSystemTime|--ignore-certificate-errors/)
  assert.doesNotThrow(() => new Function(`return (${installedPermissionWorker.toString()})`))
  const call = ui.indexOf('report.permissionRuntime = await runInstalledWindowsPermissionAcceptance(')
  assert.ok(call > ui.indexOf('const before = inspectInstalledPackage('))
  assert.ok(call < ui.indexOf("report.checks.push('installed-chinese-renderer')"))
  assert.match(ui.slice(call, call + 250), /temporaryRoot: tmpdir\(\)/)
  assert.match(ui.slice(call, call + 400), /validateWindowsPermissionRuntimeEvidence\(report\.permissionRuntime\)/)
})

for (const [label, mutate] of [
  ['wrong package source', value => { value.sourceHead = 'b'.repeat(40) }],
  ['changed package', value => { value.packageUnchanged = false }],
  ['forced cleanup', value => { value.cleanExit = false }],
  ['wrong locale', value => { value.locale = 'en' }],
  ['workspace missing the required Chinese and space path', value => { value.workspaceRoot = 'D:\\owned\\workspace' }],
  ['old tab order', value => { value.tabs = ['连接器', '技能', '插件'] }],
  ['incomplete manual', value => { value.chapters.pop() }],
  ['network-only help', value => { value.helpOffline = false }],
  ['failed update metadata', value => { value.update.ok = false }],
  ['available update', value => { value.update.hasUpdate = true }],
  ['recorded error', value => { value.errors.push('renderer crashed') }]
]) {
  test(`Windows UI evidence rejects ${label}`, () => {
    const invalid = report()
    mutate(invalid)
    assert.throws(() => validateWindowsUiReport(invalid, identity))
  })
}

for (const [label, mutate] of [
  ['early empty catalog', value => { value.resources.connectors = [] }],
  ['missing default skill', value => { value.resources.defaultSkills.pop() }],
  ['unrelated local Skill directory', value => { value.resources.defaultSkills[0].entryRelativePath = 'personal/skills/ppt-master/SKILL.md' }],
  ['unregistered Skill entry', value => { value.resources.defaultSkills[0].entryRegisteredInAsar = false }],
  ['unavailable engineering skill entry', value => { value.resources.engineeringSkills[0].installEnabled = false }],
  ['missing connector details', value => { value.resources.connectors[1].detailsReady = false }],
  ['mutated connector config', value => { value.resources.connectionsUnchanged = false }],
  ['remote-only CAD catalog', value => { value.resources.cad[0].catalogSourceType = 'github' }],
  ['floating CAD source', value => { value.resources.cad[0].commit = 'main' }],
  ['different CAD archive', value => { value.resources.cad[0].archiveSha256 = '0'.repeat(64) }],
  ['disabled CAD installation entry', value => { value.resources.cad[1].installEnabled = false }],
  ['missing CAD dependency instructions', value => { value.resources.cad[1].dependenciesVisible = false }],
  ['missing CAD license notice', value => { value.resources.cad[0].licenseNoticeVisible = false }]
]) {
  test(`Windows resource evidence rejects ${label}`, () => {
    const invalid = report()
    mutate(invalid)
    assert.throws(() => validateWindowsUiReport(invalid, identity))
  })
}

test('readonly connector DOM observations compile with their exact Chinese dialog labels', () => {
  for (const connector of [{ id: 'amap-maps', name: '高德地图' }, { id: 'zotero-mcp', name: 'Zotero 本机文献' }]) {
    const expression = readonlyConnectorSetupExpression(connector)
    assert.doesNotThrow(() => new Function(`return ${expression}`))
    assert.ok(expression.includes(JSON.stringify(`[role="dialog"][aria-label="${connector.name}"]`)))
  }
})

test('default Skills retain the exact packaged PPT upstream overlay provenance', () => {
  const skills = report().resources.defaultSkills
  skills[0].source = { type: 'github', owner: 'hugohe3', repo: 'ppt-master', path: 'skills/ppt-master', ref: 'v6.8.0',
    installedSha: '5e8856be0da8e6bc85c4aa28acc614478f7b7137', overlaySkillId: 'ppt-master', autoUpdate: false }
  assert.deepEqual(validateDefaultSkillSources(skills), skills)
  for (const patch of [{ installedSha: '0'.repeat(40) }, { repo: 'other' }, { path: 'skills/other' }, { autoUpdate: true }, { overlaySkillId: 'other' }]) {
    const changed = structuredClone(skills)
    Object.assign(changed[0].source, patch)
    assert.throws(() => validateDefaultSkillSources(changed), /Unverified default Skill source/)
  }
  const changed = structuredClone(skills)
  changed[1].source.id = 'other'
  assert.throws(() => validateDefaultSkillSources(changed), /Unverified default Skill source/)
})

test('only the exact installed di-bao agent-pack component with matching packaged bytes is accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-agent-pack-proof-'))
  const applicationRoot = join(root, 'application')
  const isolatedRoot = join(root, 'profile')
  const id = 'metro-monitoring-agent-pack'
  const codexRoot = join(isolatedRoot, 'home', '.codex')
  const skillRoot = join(codexRoot, 'skills', 'di-bao-monitoring')
  const packRoot = join(applicationRoot, 'resources', 'src', 'asset', 'agent-packs', id)
  const sourceRoot = join(packRoot, 'assets', 'skill', 'di-bao-monitoring')
  const manifestRoot = join(codexRoot, '.workwise-agent-packs')
  const pack = { name: id, version: '1.2.34', agentAssets: [{ kind: 'skill', name: 'di-bao-monitoring', dir: 'assets/skill/di-bao-monitoring' }] }
  const metadata = { type: 'bundled-agent-pack', id, kind: 'skill', name: 'di-bao-monitoring', version: pack.version, installedAt: '2026-11-13T00:00:00Z' }
  const manifest = { type: metadata.type, id, version: pack.version, installedAt: metadata.installedAt, target: 'codex', rootPath: codexRoot,
    assets: [{ kind: 'skill', name: 'di-bao-monitoring', targetKind: 'directory', destination: skillRoot }] }
  const skill = () => ({ id: 'di-bao-monitoring', name: 'Di Bao Monitoring', root: skillRoot, entryPath: join(skillRoot, 'SKILL.md') })
  const reset = async () => {
    await Promise.all([skillRoot, sourceRoot, manifestRoot].map(path => mkdir(path, { recursive: true })))
    await Promise.all([
      writeFile(join(packRoot, 'package.json'), JSON.stringify(pack)),
      writeFile(join(skillRoot, '.workwise-agent-pack-source.json'), JSON.stringify(metadata)),
      writeFile(join(manifestRoot, `${id}.json`), JSON.stringify(manifest)),
      writeFile(join(sourceRoot, 'SKILL.md'), 'synthetic fixed packaged entry\n'),
      writeFile(join(skillRoot, 'SKILL.md'), 'synthetic fixed packaged entry\n')
    ])
  }
  try {
    await reset()
    const valid = skill()
    await verifyInstalledAgentPackSkill(valid, { applicationRoot, isolatedRoot })
    const evidence = report()
    evidence.resources.defaultSkills[2] = valid
    assert.equal(validateWindowsUiReport(evidence, identity), true)
    assert.equal(valid.agentPackSource.type, 'bundled-agent-pack')
    assert.equal(valid.entryRegisteredInAsar, false)
    for (const mutate of [
      async () => writeFile(join(skillRoot, 'SKILL.md'), 'same name, changed entry'),
      async () => writeFile(join(skillRoot, '.workwise-agent-pack-source.json'), JSON.stringify({ ...metadata, id: 'untrusted-pack' })),
      async () => writeFile(join(manifestRoot, `${id}.json`), JSON.stringify({ ...manifest, assets: [] })),
      async () => writeFile(join(packRoot, 'package.json'), JSON.stringify({ ...pack, agentAssets: [{ ...pack.agentAssets[0], dir: 'other/component' }] }))
    ]) {
      await reset()
      await mutate()
      await assert.rejects(verifyInstalledAgentPackSkill(skill(), { applicationRoot, isolatedRoot }))
    }
    await reset()
    await assert.rejects(verifyInstalledAgentPackSkill({ ...skill(), root: join(root, 'unrelated') }, { applicationRoot, isolatedRoot }))
    await assert.rejects(verifyInstalledAgentPackSkill({ ...skill(), id: 'tender-master' }, { applicationRoot, isolatedRoot }))
    const changedProof = structuredClone(valid)
    changedProof.agentPackSource.entrySha256 = '0'.repeat(64)
    assert.throws(() => validateDefaultSkillSources([report().resources.defaultSkills[0], report().resources.defaultSkills[1], changedProof]))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the normal Tender Master installed copy requires its owned path, bundled metadata and actual ASAR bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-bundled-copy-proof-'))
  const applicationRoot = join(root, 'application')
  const isolatedRoot = join(root, 'profile')
  const sourceRoot = join(root, 'archive-source', 'src', 'asset', 'skills', 'tender-master')
  const skillRoot = join(isolatedRoot, 'home', '.workwise', 'skills', 'tender-master')
  const metadata = { type: 'bundled', id: 'tender-master', autoUpdate: false }
  const skill = () => ({ id: 'tender-master', source: metadata, root: skillRoot, entryPath: join(skillRoot, 'SKILL.md') })
  try {
    await Promise.all([sourceRoot, skillRoot, join(applicationRoot, 'resources')].map(path => mkdir(path, { recursive: true })))
    await writeFile(join(sourceRoot, 'SKILL.md'), 'synthetic exact ASAR source\n')
    await createRequire(import.meta.url)('@electron/asar').createPackage(join(root, 'archive-source'), join(applicationRoot, 'resources', 'app.asar'))
    await writeFile(join(skillRoot, 'SKILL.md'), 'synthetic exact ASAR source\n')
    await writeFile(join(skillRoot, '.workwise-skill-source.json'), JSON.stringify(metadata))
    const valid = skill()
    await verifyInstalledBundledSkillCopy(valid, { applicationRoot, isolatedRoot })
    const evidence = report()
    evidence.resources.defaultSkills[1] = valid
    assert.equal(validateWindowsUiReport(evidence, identity), true)
    await writeFile(join(skillRoot, 'SKILL.md'), 'same name, changed bytes')
    await assert.rejects(verifyInstalledBundledSkillCopy(skill(), { applicationRoot, isolatedRoot }))
    await writeFile(join(skillRoot, 'SKILL.md'), 'synthetic exact ASAR source\n')
    await writeFile(join(skillRoot, '.workwise-skill-source.json'), JSON.stringify({ ...metadata, id: 'untrusted' }))
    await assert.rejects(verifyInstalledBundledSkillCopy(skill(), { applicationRoot, isolatedRoot }))
    await writeFile(join(skillRoot, '.workwise-skill-source.json'), JSON.stringify(metadata))
    await assert.rejects(verifyInstalledBundledSkillCopy({ ...skill(), root: join(root, 'unrelated') }, { applicationRoot, isolatedRoot }))
    await assert.rejects(verifyInstalledBundledSkillCopy({ ...skill(), id: 'ppt-master' }, { applicationRoot, isolatedRoot }))
    evidence.resources.defaultSkills[1].bundledCopySource.entrySha256 = '0'.repeat(64)
    assert.throws(() => validateWindowsUiReport(evidence, identity))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Chinese UI uses the same installed EXE before owned uninstall, with unchanged ordinary app configuration', () => {
  const installer = readFileSync(new URL('./run-windows-install-smoke.ps1', import.meta.url), 'utf8')
  const ui = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  assert.match(installer, /node \$uiScript \$executable \$Version \$SourceHead \$EvidenceDir/)
  assert.ok(installer.indexOf('node $uiScript') < installer.indexOf('Invoke-OwnedProcess $uninstaller'))
  assert.match(ui, /spawn\(executable, \[`--user-data-dir=/)
  assert.match(ui, /inspectInstalledPackage\(dirname\(executable\), identity\)/)
  assert.match(ui, /Network\.emulateNetworkConditions/)
  assert.match(ui, /Input\.dispatchMouseEvent/)
  assert.match(ui, /cdp\.click\('\.ds-settings-sidebar nav button', '帮助'\)/)
  assert.doesNotMatch(ui, /cdp\.click\('button', '帮助'\)/)
  assert.match(ui, /document\.activeElement\?\.matches\('input\[aria-label="搜索帮助"\]'\)/)
  assert.match(ui, /'the typed search query'/)
  assert.ok(ui.indexOf("text: '版本更新'") < ui.indexOf("'1.4 现有界面截图'"))
  const offlineHelp = ui.indexOf("report.checks.push('offline-help-images')")
  const taskRuntime = ui.indexOf("'the installed KUN runtime'", offlineHelp)
  assert.match(ui, /if \(!taskSmoke\) \{[\s\S]*?'offline-help-images'\)\r?\n    \} else \{/)
  assert.ok(taskRuntime > offlineHelp)
  assert.ok(taskRuntime < ui.indexOf("cdp.click('.ds-sidebar-shell button.w-full', '新建会话')", taskRuntime))
  assert.doesNotMatch(ui, /cdp\.hover\('button\[aria-label="新建会话"\]'/)
  const sidebar = readFileSync(new URL('../src/renderer/src/components/chat/Sidebar.tsx', import.meta.url), 'utf8')
  assert.match(sidebar, /label=\{activeView === 'engineering' \? t\('engineeringNewProject'\) : t\('newAgent'\)\}[\s\S]*?disabled=\{!runtimeReady\}/)
  assert.ok(ui.indexOf("'the loaded local Amap and Zotero catalog entries'") < ui.indexOf("const connectorsScreenshot"))
  assert.ok(ui.indexOf("'the loaded local Amap and Zotero catalog entries'") < ui.indexOf("查看 GitHub MCP 连接详情"))
  assert.match(ui, /window\.workwise\.listCatalogPackages\(\)/)
  assert.match(ui, /window\.workwise\.listSkills\(\)/)
  // @electron/asar splits archive lookups using the host path separator.
  assert.match(ui, /const entry = join\('src', 'asset', 'skills', skill.id, 'SKILL.md'\)/)
  assert.match(ui, /asar\.extractFile\(join\(dirname\(executable\), 'resources', 'app.asar'\), entry\)/)
  assert.match(ui, /both locally cataloged CAD skills/)
  assert.match(ui, /nav\[aria-label="工作区工具"\]/)
  assert.match(ui, /view\.executeJavaScript\('.*document\.body\.innerText/)
  assert.match(ui, /windows-task-html-preview-zh-dark\.png/)
  assert.match(ui, /report\.runtimeFailure = await cdp\.evaluate/)
  assert.match(ui, /mcpServers:tools\.body\.mcpServers/)
  assert.doesNotMatch(ui, /window\.workwise\s*=|innerHTML\s*=|mock\w*\(/)
})

for (const [name, change] of [
  ['prose-only completion', evidence => { evidence.artifact.byteHashMatches = false }],
  ['missing afternoon schedule', evidence => { evidence.schedule.times.pop() }],
  ['wrong timezone', evidence => { evidence.schedule.timezone = 'UTC' }],
  ['unverified schedule claim', evidence => { evidence.schedule.readBackFromTool = false }],
  ['manual preview presented as automatic', evidence => { evidence.preview.automatic = false }],
  ['mock clock presented as an actual due occurrence', evidence => { evidence.dueOccurrence.clock = 'mock' }],
  ['same task reused for a due occurrence', evidence => { evidence.dueOccurrence.independentTask = false }],
  ['same artifact reused for a due occurrence', evidence => { evidence.dueOccurrence.independentArtifact = false }],
  ['task created before the real due time', evidence => { evidence.dueOccurrence.createdAt = '2026-11-12T00:00:00Z' }]
]) test(`task acceptance rejects ${name}`, () => {
  const evidence = report().taskExecution
  change(evidence)
  assert.throws(() => validateWindowsTaskEvidence(evidence))
})

test('the local model protocol fixture requests real tools and never impersonates a browser result', async () => {
  const fixture = await startWindowsTaskModelFixture()
  try {
    const tools = ['publish_artifact', 'read_artifact', 'schedule_task', 'list_schedules'].map(name => ({ type: 'function', function: { name } }))
    const first = await fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ tools, messages: [] }) })
    const payload = await first.text()
    assert.ok(payload.includes('publish_artifact'))
    assert.ok(!payload.includes('browser_navigate'))
    assert.equal(fixture.observed.catalogs.length, 1)
  } finally { await fixture.close() }
})

test('task execution is opt-in and cannot be omitted when explicitly requested', () => {
  const evidence = report()
  delete evidence.taskExecution
  evidence.taskSmokeRequested = false
  evidence.checks = evidence.checks.filter(check => check !== 'runtime-task-html-and-daily-schedule')
  assert.equal(validateWindowsUiReport(evidence, identity), true)
  assert.throws(() => validateWindowsUiReport(evidence, identity, { requireTaskExecution: true }))
})

test('browser evidence requires the actual extension, HTML tool output and closed session', () => {
  // Only exercises the evidence validator, never substitutes for a real extension session.
  const evidence = { status: 'passed', fixturePageRead: true, htmlFromBrowserTool: true, sessionStopped: true, cliVersion: '0.5.0', protocolVersion: '1.9',
    skillInstallation: { packageId: 'browser-skill', sourceCommit: '361da1d75798b99b358dfb434b8ce1921fb90d9e',
      runtimeHotLoaded: true, runtimeUnchanged: true, sameConversation: true, activeInTask: true, entrySha256: 'b'.repeat(64),
      guiScheduleMcp: { id: 'gui_schedule', enabled: true, available: true, status: 'connected', toolCount: 8 } },
    extension: { version: '0.5.0', sha256: browserSmokeDependency.extensionSha256 }, browser: { version: browserSmokeDependency.chromeVersion },
    browserInstanceId: 'synthetic-validation-id', sessionId: 'synthetic-validation-session', htmlSha256: 'a'.repeat(64),
    sourceUrl: 'http://127.0.0.1:1234/fixture', artifactSha256: 'a'.repeat(64), webArtifactEvidence: syntheticWebArtifactVerification() }
  assert.doesNotThrow(() => validateWindowsBrowserEvidence(evidence))
  for (const field of ['fixturePageRead', 'htmlFromBrowserTool', 'sessionStopped']) assert.throws(() => validateWindowsBrowserEvidence({ ...evidence, [field]: false }))
  for (const field of ['runtimeHotLoaded', 'runtimeUnchanged', 'sameConversation', 'activeInTask']) {
    assert.throws(() => validateWindowsBrowserEvidence({ ...evidence, skillInstallation: { ...evidence.skillInstallation, [field]: false } }))
  }
  for (const change of [{ status: 'error' }, { toolCount: 7 }, { enabled: false }, { available: false }]) {
    assert.throws(() => validateWindowsBrowserEvidence({ ...evidence, skillInstallation: { ...evidence.skillInstallation,
      guiScheduleMcp: { ...evidence.skillInstallation.guiScheduleMcp, ...change } } }))
  }
  assert.throws(() => validateWindowsBrowserEvidence({ ...evidence, status: 'not_exercised' }))
  for (const change of [{ complete: false }, { reasons: ['missing source'] }, { artifactHash: '0'.repeat(64) },
    { evidenceReceiptId: undefined }, { sourceReceipts: [] }, { persistedReceiptVerified: false }]) {
    assert.throws(() => validateWindowsBrowserEvidence({ ...evidence, webArtifactEvidence: { ...evidence.webArtifactEvidence, ...change } }))
  }
  assert.throws(() => validateWindowsUiReport(report(), identity, { requireBrowserExecution: true }))
})

test('the installed schedule bridge evidence count matches the fixed node-entry tool contract', () => {
  const server = readFileSync(new URL('../src/main/claw-schedule-mcp-server.ts', import.meta.url), 'utf8')
  const names = [...server.matchAll(/register(?:List|Create|Update|Delete)Tool\('([^']+)'\)/g)].map(match => match[1]).sort()
  assert.deepEqual(names, ['claw_schedule_create', 'claw_schedule_delete', 'claw_schedule_list', 'claw_schedule_update',
    'gui_schedule_create', 'gui_schedule_delete', 'gui_schedule_list', 'gui_schedule_update'])
  const ui = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  assert.match(ui, /const guiScheduleMcp = loaded\.mcpServers\.find/)
  assert.match(ui, /validateGuiScheduleMcpEvidence\(guiScheduleMcp\)/)
})

test('installed acceptance uses the real marketplace and checks the existing Runtime without manually refreshing it', () => {
  const ui = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  assert.match(ui, /window\.workwise\.prepareCatalogPlugin/)
  assert.match(ui, /window\.workwise\.installPreparedPlugin/)
  assert.match(ui, /readFile\(skillEntry\)/)
  assert.match(ui, /runtimeRequest\('\/v1\/runtime\/tools'\)/)
  assert.doesNotMatch(ui, /runtime\/skills\/refresh|window\.workwise\.refreshSkills/)
  assert.ok(ui.indexOf('const originThreadId = newThreads[0].id') < ui.indexOf('skillInstallation = await installMarketplaceBrowserSkill'))
  assert.match(ui, /assert\.equal\(task\.originThreadId, originThreadId/)
  assert.doesNotMatch(ui, /(?:tasks|list)\.tasks\.(?:find|filter)/)
  const runtimeRoute = readFileSync(new URL('../kun/src/server/routes/tasks.ts', import.meta.url), 'utf8')
  assert.match(runtimeRoute, /return jsonResponse\(runtime\.taskRepository\.list\(/)
})

// These protocol-component tests supply synthetic results only; they are not Windows business acceptance evidence.
const browserToolNames = ['browser_session_start', 'browser_navigate', 'browser_get_html', 'browser_authorize_action', 'browser_fill', 'browser_click', 'browser_session_stop', 'publish_artifact', 'read_artifact', 'verify_web_artifact', 'schedule_task', 'list_schedules']
const fixtureMessages = (id, name, output) => [
  { role: 'assistant', tool_calls: [{ id: `smoke-${id}`, function: { name, arguments: '{}' } }] },
  ...(output === undefined ? [] : [{ role: 'tool', tool_call_id: `smoke-${id}`, content: JSON.stringify(output) }])
]
const fixtureResultHtml = (page, query) => page.replace('<output id="query-result" aria-live="polite"></output>', `<output id="query-result" aria-live="polite" data-query="${query}">本地查询结果：${query}；已完成合成公开检索</output>`)
const fixtureRead = (sourceUrl, html) => ({ sourceUrl, html, truncated: false, resultHash: createHash('sha256').update(html).digest('hex') })
const fixtureRequest = (fixture, names, messages) => fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ tools: names.map(name => ({ type: 'function', function: { name } })), messages }) })
const fixtureCall = async response => {
  assert.equal(response.status, 200)
  const data = (await response.text()).split('\n').find(line => line.startsWith('data: {'))
  return JSON.parse(data.slice(6)).choices[0].delta.tool_calls?.[0]
}

test('the controlled browser fixture discovers a distinct primary document with verifiable report fields', async () => {
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    const list = await (await fetch(fixture.fixtureUrl)).text()
    assert.ok(list.includes('href="/fixture/detail"'), 'The actual result page must discover a primary document link')
    const response = await fetch(new URL('/fixture/detail', fixture.fixtureUrl))
    assert.match(response.headers.get('content-type'), /text\/html/)
    const detail = await response.text()
    for (const field of ['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification']) {
      assert.ok(detail.includes(`data-field="${field}"`), `Missing actual primary document field ${field}`)
    }
    assert.ok(detail.includes(fixture.marker))
    const secondDetail = await (await fetch(new URL('/fixture/detail', fixture.fixtureUrl))).text()
    assert.notEqual(secondDetail, detail, 'The source itself must provide an independent document version for a due read')
  } finally { await fixture.close() }
})

test('report fixture extracts exact source quotes and never manufactures missing primary evidence', async () => {
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    const list = fixtureRead(fixture.fixtureUrl, fixtureResultHtml(await (await fetch(fixture.fixtureUrl)).text(), fixture.query))
    const detail = fixtureRead(fixture.detailUrl, await (await fetch(fixture.detailUrl)).text())
    const report = buildWindowsFixtureWebReport({ list, detail, ...fixture })
    assert.equal(report.verification.items.length, 1)
    const item = report.verification.items[0]
    assert.equal(item.source.url, fixture.detailUrl)
    assert.equal(item.discovery.url, fixture.fixtureUrl)
    assert.notEqual(item.source.url, item.discovery.url)
    assert.equal(item.fields.length, 6)
    for (const field of item.fields) {
      assert.ok(detail.html.includes(field.quote) && field.quote.includes(field.value))
      assert.ok(report.content.includes(`data-evidence-field="${field.field}"`))
    }
    assert.ok(report.content.includes('data-evidence-report') && report.content.includes('data-evidence-item="notice-1"'))
    assert.ok(report.content.includes(`data-evidence-source href="${fixture.detailUrl}"`))
    for (const change of [{ sourceUrl: fixture.fixtureUrl }, { truncated: true }, { resultHash: '0'.repeat(64) },
      fixtureRead(fixture.detailUrl, detail.html.replace(/<p data-field="budget">[^<]+<\/p>/, ''))]) {
      assert.throws(() => buildWindowsFixtureWebReport({ list, detail: { ...detail, ...change }, ...fixture }))
    }
  } finally { await fixture.close() }
})

test('automatic task preview reads the actual typed report DOM rather than legacy query narration', async t => {
  const { Window } = await import('happy-dom')
  const root = await mkdtemp(join(tmpdir(), 'railwise-typed-preview-'))
  let fixture
  try {
    const renderer = join(root, 'structured-report.mjs')
    await build({ entryPoints: [fileURLToPath(new URL('../kun/src/services/structured-web-report.ts', import.meta.url))], outfile: renderer, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { renderStructuredWebReport } = await import(pathToFileURL(renderer).href)
    fixture = await startWindowsTaskModelFixture({ browser: true })
    const list = fixtureRead(fixture.fixtureUrl, fixtureResultHtml(await (await fetch(fixture.fixtureUrl)).text(), fixture.query))
    const detail = fixtureRead(fixture.detailUrl, await (await fetch(fixture.detailUrl)).text())
    const report = buildWindowsFixtureWebReport({ list, detail, ...fixture })
    const rendered = renderStructuredWebReport(report.verification.path, report.report)
    const legacyQuery = `本地查询结果：${fixture.query}；已完成合成公开检索`
    assert.deepEqual(rendered.verificationInput, report.verification)
    assert.ok(rendered.content.includes(fixture.marker), 'The actual typed report retains its task marker in the title')
    assert.equal(rendered.content.includes(legacyQuery), false, 'Typed report bytes do not contain the old free-form query narration')
    const token = 'a'.repeat(48), partition = `railwise-artifact-${token}`
    const previewUrl = `http://127.0.0.1:1234/task-preview/${token}/${encodeURIComponent(report.verification.path)}`
    const probe = async (change = {}) => {
      const url = change.url ?? previewUrl
      const shell = new Window(), preview = new Window({ url })
      try {
        preview.document.write(change.html ?? rendered.content)
        preview.document.close()
        Object.defineProperty(preview.document, 'readyState', { configurable: true, value: change.state ?? 'complete' })
        change.mutate?.(preview.document)
        const view = shell.document.createElement('webview')
        view.setAttribute('src', url)
        view.setAttribute('partition', change.partition ?? partition)
        view.getClientRects = () => change.visible === false ? [] : [{ x: 0, y: 0, width: 960, height: 640 }]
        view.getURL = () => url
        view.isLoading = () => change.loading ?? false
        let executions = 0
        view.executeJavaScript = async expression => { executions++; return preview.eval(expression) }
        shell.document.body.append(view)
        const result = await shell.eval(windowsTaskArtifactPreviewExpression({ marker: change.marker ?? fixture.marker,
          query: change.local ? undefined : fixture.query, relativePath: report.verification.path,
          evidence: change.local ? undefined : report.verification }))
        return { result, executions }
      } finally { await Promise.all([shell.happyDOM.close(), preview.happyDOM.close()]) }
    }
    await t.test('accepts the visible complete typed report with exact fields and source links', async () => {
      const { result, executions } = await probe()
      assert.equal(result?.contentVerified, true)
      assert.equal(result.partition, partition)
      assert.ok(result.title.includes(fixture.marker))
      assert.ok(executions > 0, 'The webview must evaluate the probe against real rendered report DOM')
    })
    for (const [name, change] of [
      ['legacy marker and query text without formal report evidence', { html: `<html><head><title>${fixture.marker}</title></head><body>${fixture.marker}<p>${legacyQuery}</p></body></html>` }],
      ['document still loading', { state: 'loading' }],
      ['webview still loading', { loading: true }],
      ['hidden webview', { visible: false }],
      ['another task marker', { html: rendered.content.replaceAll(fixture.marker, 'RAILWISE_BROWSER_ANOTHER_TASK') }],
      ['another artifact path', { url: previewUrl.replace(encodeURIComponent(report.verification.path), 'other-report.html') }],
      ['another artifact partition', { partition: `railwise-artifact-${'b'.repeat(48)}` }],
      ['changed formal field value', { mutate: document => { document.querySelector('[data-evidence-field="budget"]').textContent = '999999.00 元' } }],
      ['changed formal source URL', { mutate: document => { document.querySelector('[data-evidence-source]').setAttribute('href', `${fixture.detailUrl}?articleId=unobserved`) } }],
      ['missing formal report region', { mutate: document => { document.querySelector('[data-evidence-report]').removeAttribute('data-evidence-report') } }]
    ]) await t.test(`rejects ${name}`, async () => {
      assert.notEqual((await probe(change)).result?.contentVerified, true)
    })
    await t.test('retains ordinary local HTML compatibility without web evidence', async () => {
      const { result } = await probe({ local: true, marker: '合成内容', html: '<html><head><title>本地报告</title></head><body><h1>合成内容</h1></body></html>' })
      assert.equal(result?.contentVerified, true)
    })
  } finally { await fixture?.close(); await rm(root, { recursive: true, force: true }) }
})

test('Windows web evidence inspection binds the actual file, task receipt and exact full source reads', async () => {
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    // Projection validator inputs only; real package acceptance must read its own SQLite and tool history.
    const list = fixtureRead(fixture.fixtureUrl, fixtureResultHtml(await (await fetch(fixture.fixtureUrl)).text(), fixture.query))
    const detail = fixtureRead(fixture.detailUrl, await (await fetch(fixture.detailUrl)).text())
    const report = buildWindowsFixtureWebReport({ list, detail, ...fixture })
    const artifact = { absolutePath: 'D:\\isolated\\每日网页报告.html', sha256: createHash('sha256').update(report.content).digest('hex') }
    const task = { id: 'synthetic-owned-task' }, proof = syntheticWebArtifactVerification(fixture.fixtureUrl, artifact.sha256)
    proof.sourceReceipts[0].resultHash = list.resultHash; proof.sourceReceipts[1].resultHash = detail.resultHash
    const thread = { turns: [{ id: 'synthetic-turn', items: [['read-results', list], ['read-detail', detail], ['verify-web-artifact', proof]].map(([id, output]) => ({
      kind: 'tool_result', turnId: 'synthetic-turn', callId: 'smoke-' + id, toolName: id === 'verify-web-artifact' ? 'verify_web_artifact' : 'browser_get_html', isError: false, output
    })) }] }
    const receipts = [{ id: proof.evidenceReceiptId, ownerId: task.id, kind: 'web_artifact_evidence', status: 'succeeded',
      request: { artifactPath: artifact.absolutePath, artifactHash: artifact.sha256, writerReceiptId: 'synthetic-writer' }, result: proof }]
    const saved = inspectWindowsPersistedWebArtifact(task, thread, receipts, artifact, fixture)
    assert.equal(saved.persistedReceiptVerified, true)
    assert.doesNotThrow(() => inspectWindowsWebArtifactVerification(saved, { sha256: artifact.sha256, fixtureUrl: fixture.fixtureUrl }))
    for (const mutate of [value => { value.receipts[0].ownerId = 'another-task' }, value => { value.receipts[0].status = 'failed' },
      value => { value.receipts[0].request.artifactHash = '0'.repeat(64) }, value => { value.receipts[0].request.artifactPath = 'D:\\other.html' },
      value => { delete value.receipts[0].request.writerReceiptId }, value => { value.receipts[0].result.sourceReceipts = [] },
      value => { value.thread.turns[0].items[1].output.truncated = true }, value => { value.thread.turns[0].items[1].output.sourceUrl = fixture.fixtureUrl },
      value => { value.thread.turns[0].items[1].output.html = '<html>Other source</html>' }, value => { value.thread.turns[0].items[1].turnId = 'other-turn' }]) {
      const changed = structuredClone({ thread, receipts }); mutate(changed)
      assert.throws(() => inspectWindowsPersistedWebArtifact(task, changed.thread, changed.receipts, artifact, fixture))
    }
  } finally { await fixture.close() }
})

test('the model fixture reads exact published artifact bytes before scheduling or final delivery', async () => {
  const fixture = await startWindowsTaskModelFixture()
  try {
    const names = ['publish_artifact', 'read_artifact', 'schedule_task', 'list_schedules']
    const content = '<h1>读取实际成果，不能只凭写入说明完成</h1>'
    const sha256 = createHash('sha256').update(content).digest('hex')
    const published = { name: '每日网页报告.html', read_artifact: { path: '每日网页报告.html' }, bytes_written: Buffer.byteLength(content), sha256 }
    const messages = fixtureMessages('artifact', 'publish_artifact', published)
    const read = await fixtureCall(await fixtureRequest(fixture, names, messages))
    assert.equal(read.function.name, 'read_artifact')
    assert.deepEqual(JSON.parse(read.function.arguments), published.read_artifact)
    const readback = { name: published.name, content, byte_size: published.bytes_written, sha256, truncated: false }
    const verified = [...messages, ...fixtureMessages('read-artifact', 'read_artifact', readback)]
    assert.equal((await fixtureCall(await fixtureRequest(fixture, names, verified))).function.name, 'schedule_task')
    assert.deepEqual(fixture.observed.requests.at(-1).artifactReadback, { name: published.name, bytes: published.bytes_written, sha256, toolName: 'read_artifact', complete: true })
    for (const changed of [{ content: 'different' }, { truncated: true }, { sha256: '0'.repeat(64) }, { byte_size: 0 }]) {
      assert.equal((await fixtureRequest(fixture, names, [...messages, ...fixtureMessages('read-artifact', 'read_artifact', { ...readback, ...changed })])).status, 400)
    }
  } finally { await fixture.close() }
})

test('the model fixture stops on the real failed prerequisite and records only its safe native diagnostics', async () => {
  const fixture = await startWindowsTaskModelFixture({ browser: true, documentLinkClick: true })
  try {
    const output = { provider: 'browser-skill', status: 'failed', code: 'browser_action_not_dispatched', vendorCode: 'precondition_failed',
      vendorReason: 'cooperation_sync_required', vendorPhase: 'precondition', effectState: 'none', vendorPressSent: false, vendorDispatched: false,
      notDispatched: true, actionDispatch: 'not_sent', stage: 'action', html: 'private page text', stderr: 'private command and credentials', token: 'private-key' }
    const response = await fixtureRequest(fixture, browserToolNames, fixtureMessages('click', 'browser_click', output))
    assert.equal(response.status, 200)
    const stream = await response.text()
    assert.doesNotMatch(stream, /tool_calls|private page|private command|private-key/)
    assert.match(stream, /browser_action_not_dispatched/)
    assert.equal(fixture.observed.failure.callId, 'smoke-click')
    assert.equal(fixture.observed.failure.toolName, 'browser_click')
    assert.equal(fixture.observed.failure.code, output.code)
    assert.deepEqual(fixture.observed.failure.nativeDiagnostics, { vendorCode: 'precondition_failed', vendorReason: 'cooperation_sync_required', vendorPhase: 'precondition',
      effectState: 'none', actionDispatch: 'not_sent', stage: 'action', vendorPressSent: false, vendorDispatched: false, notDispatched: true })
    assert.equal(fixture.observed.requests.at(-1).next, 'halt-on-tool-failure')
    assert.deepEqual(fixture.observed.requests.at(-1).prerequisiteFailure, fixture.observed.failure)
    assert.doesNotMatch(JSON.stringify(fixture.observed), /private page|private command|private-key/)
  } finally { await fixture.close() }
})

test('the Windows controlled page requires real shared-class candidate and nested generic-input proof', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window(), fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    const page = await (await fetch(fixture.fixtureUrl)).text()
    window.document.body.innerHTML = page
    const input = window.document.querySelector('.input-input > .po-input > input')
    const buttons = [...window.document.querySelectorAll('div.input-button')]
    assert.equal(input.getAttribute('type'), 'text')
    assert.equal(input.getAttribute('placeholder'), '请输入内容')
    assert.equal(input.hasAttribute('id') || input.hasAttribute('name') || input.hasAttribute('aria-label'), false)
    assert.deepEqual(buttons.map(node => node.textContent), ['搜标题', '搜全文'])
    assert.equal(buttons[0].parentElement, buttons[1].parentElement)
    assert.equal(buttons[0].parentElement.className, 'searchInput-content-input')
    assert.equal(window.document.querySelectorAll('div[class="input-button"]').length, 2, 'A production class locator must not become artificially unique')
    assert.equal(buttons[0].parentElement.querySelectorAll('div[class="input-button"]').length, 2, 'A scalar descendant target field would be ambiguous')
    assert.equal(buttons[0].parentElement.querySelectorAll('input[type="search"],input[name="q"],input[name="keyword"],input[id="title"]').length, 0, 'The fixture must not manufacture a searchInput=true field')
    assert.ok(buttons.every(node => !node.hasAttribute('id') && !node.hasAttribute('aria-label')))
    assert.ok(page.includes(fixture.inputHtml) && page.includes(fixture.buttonHtml) && page.includes(fixture.fullButtonHtml))
    const native = windowsFixtureNativeExpectations(fixture, { action: 'click', targetRef: '@e55', inputTargetRef: '@e54' })
    assert.deepEqual(native.slice(0, 2), [{ target: '@e55', field: 'exists', equals: true }, { target: '@e55', field: 'text', equals: '搜标题' }])
    assert.ok(native.some(value => value.target === '@e54' && value.field === 'value' && value.equals === fixture.query))
    assert.ok(!native.some(value => value.attribute === 'id' || value.attribute === 'data-testid'))
  } finally { await fixture.close(); await window.happyDOM.close() }
})

test('browser protocol obtains fresh real refs, asks exact persistent actions, and omits approvals for a new scheduled conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-fixture-report-'))
  const renderer = join(root, 'structured-report.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('../kun/src/services/structured-web-report.ts', import.meta.url))], outfile: renderer, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { renderStructuredWebReport } = await import(pathToFileURL(renderer).href)
  const fixture = await startWindowsTaskModelFixture({ browser: true, postPlanQuery: true, documentLinkClick: true })
  try {
    const page = await (await fetch(fixture.fixtureUrl)).text()
    const detail = await (await fetch(fixture.detailUrl)).text()
    const title = /<h1>([^<]+)<\/h1>/.exec(detail)[1]
    const linkHtml = /<a\b[^>]*id="detail-link"[^>]*>[\s\S]*?<\/a>/.exec(page)[0].replace(' hidden', '')
    assert.ok(page.includes(fixture.inputHtml) && page.includes(fixture.buttonHtml))
    assert.ok(!page.includes('fetch(') && !page.includes('<form'))
    assert.throws(() => validateWindowsFixtureQueryHtml(page, fixture), /actual DOM/)
    for (const initial of [true, false]) {
      const names = initial ? browserToolNames : browserToolNames.filter(name => !['schedule_task', 'list_schedules'].includes(name))
      const messages = []
      const authorizations = []
      const ids = []
      let published
      for (let count = 0; count < 40; count++) {
        const call = await fixtureCall(await fixtureRequest(fixture, names, messages))
        if (!call) break
        ids.push(call.id)
        const args = JSON.parse(call.function.arguments)
        const postPlan = call.id.startsWith('smoke-post-plan-')
        const currentId = postPlan ? call.id.replace('smoke-post-plan-', 'smoke-') : call.id
        const contextPrefix = postPlan ? 'post-plan-' : ''
        if (call.function.name === 'publish_artifact') {
          assert.equal(args.content, undefined)
          const rendered = renderStructuredWebReport(args.path, args.report)
          validateWindowsFixtureReportHtml(rendered.content, fixture)
          assert.equal(args.report.evidence.coverage[0].resultHash, fixtureRead(fixture.fixtureUrl, fixtureResultHtml(page, fixture.query)).resultHash)
          published = { name: args.path, read_artifact: { path: args.path }, bytes_written: Buffer.byteLength(rendered.content),
            sha256: createHash('sha256').update(rendered.content).digest('hex'), content: rendered.content,
            verificationInput: { path: args.path, manifestRef: 'web-manifest:' + 'a'.repeat(64) }, verificationInputHash: windowsFixtureVerificationInputHash(rendered.verificationInput) }
        }
        let output = { status: 'succeeded' }
        if (currentId === 'smoke-start') output.sessionId = postPlan ? 'synthetic-post-plan-session' : initial ? 'synthetic-source-session' : 'synthetic-due-session'
        if (currentId === 'smoke-navigate') output = { observation: { context_id: contextPrefix + 'synthetic-navigation-context', observation: { text: '@e1 input 请输入内容\n@e2 button 搜标题' } } }
        if (currentId === 'smoke-read-fill-target') assert.equal(args.target, '@e1')
        if (currentId === 'smoke-read-click-target') assert.equal(args.target, '@e12')
        if (call.function.name === 'browser_authorize_action') {
          authorizations.push(args)
          assert.equal(args.scope, 'schedule')
          assert.equal(args.scheduleAccess, 'public_query')
        }
        if (currentId === 'smoke-fill') {
          assert.equal(args.value, fixture.query)
          assert.equal(args.contextId, contextPrefix + 'synthetic-navigation-context')
          output = { observation: { context_id: contextPrefix + 'synthetic-post-fill-context', observation: { text: '@e11 input 请输入内容\n@e90 generic 搜标题 搜全文\n@e12 button 搜标题\n@e13 button 搜全文' } } }
        }
        if (currentId === 'smoke-click') {
          assert.equal(args.contextId, contextPrefix + 'synthetic-post-fill-context')
          assert.equal(args.target, '@e12')
          output = { status: 'succeeded', observation: { context_id: contextPrefix + 'synthetic-after-search-context',
            observation: { text: '@e14 link ' + title + '\n本地查询结果：' + fixture.query } } }
        }
        if (currentId === 'smoke-read-link-target') {
          assert.equal(args.target, '@e14'); output = fixtureRead(fixture.fixtureUrl, linkHtml)
        }
        if (currentId === 'smoke-open-detail') {
          assert.equal(call.function.name, 'browser_click'); assert.equal(args.target, '@e14')
          assert.equal(args.contextId, 'synthetic-after-search-context'); assert.equal(args.url, undefined)
        }
        if (currentId === 'smoke-read-results') output = fixtureRead(fixture.fixtureUrl, fixtureResultHtml(page, fixture.query))
        if (currentId === 'smoke-read-schedule') output = { schedules: [{ id: 'synthetic-owned-plan', enabled: true }] }
        if (currentId === 'smoke-stop') output.stopped = true
        if (currentId === 'smoke-navigate-detail') assert.equal(args.url, fixture.detailUrl)
        if (currentId === 'smoke-read-detail') { assert.equal(args.target, undefined); output = fixtureRead(fixture.detailUrl, detail) }
        if (currentId === 'smoke-artifact') output = published
        if (currentId === 'smoke-read-artifact') output = { name: published.name, content: published.content, sha256: published.sha256, byte_size: published.bytes_written, truncated: false }
        if (currentId === 'smoke-verify-web-artifact') {
          const expected = buildWindowsFixtureWebReport({ list: fixtureRead(fixture.fixtureUrl, fixtureResultHtml(page, fixture.query)),
            detail: fixtureRead(fixture.detailUrl, detail), ...fixture }).verification
          assert.deepEqual(args, published.verificationInput)
          assert.equal(published.verificationInputHash, windowsFixtureVerificationInputHash(expected))
          // Local protocol test input, never persisted or reported as Runtime acceptance.
          output = syntheticWebArtifactVerification(fixture.fixtureUrl, published.sha256)
          inspectWindowsWebArtifactVerification(output, { sha256: published.sha256, fixtureUrl: fixture.fixtureUrl })
        }
        messages.push(...fixtureMessages(call.id.slice(6), call.function.name, output))
      }
      assert.equal(authorizations.length, initial ? 2 : 0)
      assert.ok(ids.includes('smoke-artifact'))
      assert.ok(ids.includes('smoke-read-detail') && ids.includes('smoke-verify-web-artifact'))
      assert.ok(ids.includes('smoke-read-link-target') && ids.includes('smoke-open-detail'))
      assert.ok(!ids.includes('smoke-navigate-detail'), 'The installed fixture must exercise the click-intent/native-GET path')
      assert.ok(ids.indexOf('smoke-read-link-target') < ids.indexOf('smoke-open-detail'))
      assert.ok(ids.indexOf('smoke-read-detail') < ids.indexOf('smoke-artifact'))
      if (initial) {
        assert.ok(ids.indexOf('smoke-verify-web-artifact') < ids.indexOf('smoke-schedule'))
        assert.ok(ids.indexOf('smoke-post-plan-start') > ids.indexOf('smoke-read-schedule'))
        assert.ok(ids.indexOf('smoke-post-plan-fill') > ids.indexOf('smoke-post-plan-read-fill-target'))
        assert.ok(ids.indexOf('smoke-post-plan-click') > ids.indexOf('smoke-post-plan-read-click-target'))
        assert.ok(ids.includes('smoke-post-plan-read-results') && ids.includes('smoke-post-plan-stop'))
      } else assert.ok(ids.every(id => !id.startsWith('smoke-post-plan-')))
    }
    const missing = fixtureMessages('start', 'browser_session_start', { sessionId: 'synthetic' })
    missing.push(...fixtureMessages('navigate', 'browser_navigate', {}))
    assert.equal((await fixtureRequest(fixture, browserToolNames, missing)).status, 400)
    assert.match(fixture.observed.requests.at(-1).error, /fresh actual observed element/)
    const ambiguous = ['start', 'navigate', 'read-fill-target', 'authorize-fill'].flatMap(id => fixtureMessages(id, 'synthetic-component-call'))
    ambiguous.push(...fixtureMessages('fill', 'browser_fill', { observation: { context_id: 'ambiguous-click-context', observation: { text: '@e55 button 搜标题\n@e56 button 搜标题' } } }))
    assert.equal((await fixtureRequest(fixture, browserToolNames, ambiguous)).status, 400)
    assert.match(fixture.observed.requests.at(-1).error, /one fresh actual observed element/)
    const finished = ['start', 'navigate', 'read-fill-target', 'authorize-fill', 'fill', 'read-click-target', 'authorize-click', 'click', 'read-results', 'stop']
      .flatMap(id => fixtureMessages(id, 'synthetic-component-call'))
    assert.equal((await fixtureRequest(fixture, browserToolNames, finished)).status, 400)
    assert.match(fixture.observed.requests.at(-1).error, /requires actual browser HTML/)
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }) }
})

test('the query fixture reads session and DOM HTML using the production model client framing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-model-framing-'))
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    const output = join(root, 'model-client.mjs')
    await build({ entryPoints: [fileURLToPath(new URL('../kun/src/adapters/model/deepseek-compat-model-client.ts', import.meta.url))], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { DeepseekCompatModelClient } = await import(pathToFileURL(output).href)
    const client = new DeepseekCompatModelClient({ baseUrl: fixture.baseUrl, apiKey: 'synthetic', model: 'synthetic' })
    const framed = (id, name, value) => client.toolResultToMessage({ kind: 'tool_result', callId: `smoke-${id}`, output: value },
      { kind: 'tool_call', callId: `smoke-${id}`, toolName: name, arguments: {}, argumentSummary: 'Original arguments omitted' })
    const first = fixtureMessages('start', 'browser_session_start')
    const session = framed('start', 'browser_session_start', { sessionId: 'synthetic-framed-session' })
    assert.throws(() => JSON.parse(session.content))
    const navigation = await fixtureCall(await fixtureRequest(fixture, browserToolNames, [...first, session]))
    assert.equal(JSON.parse(navigation.function.arguments).sessionId, 'synthetic-framed-session')
    const html = fixtureResultHtml(await (await fetch(fixture.fixtureUrl)).text(), fixture.query)
    const detail = await (await fetch(fixture.detailUrl)).text()
    const calls = ['start', 'navigate', 'read-fill-target', 'authorize-fill', 'fill', 'read-click-target', 'authorize-click', 'click', 'read-results', 'navigate-detail', 'read-detail', 'stop']
      .flatMap(id => fixtureMessages(id, 'synthetic-component-call'))
    for (const untrusted of [false, true]) {
      const result = await fixtureCall(await fixtureRequest(fixture, browserToolNames, [...calls,
        framed('read-results', 'browser_get_html', { ...fixtureRead(fixture.fixtureUrl, html), untrusted }),
        framed('read-detail', 'browser_get_html', { ...fixtureRead(fixture.detailUrl, detail), untrusted })]))
      const args = JSON.parse(result.function.arguments)
      assert.equal(args.content, undefined)
      assert.deepEqual(args.report.evidence.coverage, [
        { url: fixture.fixtureUrl, resultHash: fixtureRead(fixture.fixtureUrl, html).resultHash },
        { url: fixture.detailUrl, resultHash: fixtureRead(fixture.detailUrl, detail).resultHash }
      ])
    }
    const invalid = await fixtureRequest(fixture, browserToolNames, [...calls, { role: 'tool', tool_call_id: 'smoke-read-results', content: `<html>Recorded result:\n${JSON.stringify({ html })}</html>` }])
    assert.equal(invalid.status, 400)
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }) }
})

test('fixture approval review rejects altered actual targets, inputs, origins, times, paths and extra approvals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-query-review-component-'))
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    const output = join(root, 'summaries.mjs')
    await build({ entryPoints: [fileURLToPath(new URL('../kun/src/security/browser-approval-summary.ts', import.meta.url))], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { browserApprovalSummary, browserScheduleApprovalSummary } = await import(pathToFileURL(output).href)
    const origin = new URL(fixture.fixtureUrl).origin
    const prompt = '合成组件测试：本地公开查询，每天09:00和17:00前提前30分钟执行。'
    const workspace = join(root, windowsSmokeWorkspaceName)
    const makeSummary = (action, change = {}) => browserApprovalSummary({ action, origin, pageUrl: fixture.fixtureUrl, verificationPolicy: 'public_query_target', targetHtml: action === 'fill' ? fixture.inputHtml : fixture.buttonHtml,
      value: action === 'fill' ? fixture.query : undefined, requestHash: 'a'.repeat(64), schedule: { purpose: prompt,
        requirement: { kind: 'daily', times: ['09:00', '17:00'], leadMinutes: 30, timezone: 'Asia/Shanghai' }, browserLabel: '合成组件浏览器', version: 'b'.repeat(64) }, ...change })
    const thread = { turns: [{ items: ['fill', 'click'].map(action => ({ kind: 'tool_result', callId: `smoke-read-${action}-target`, isError: false,
      output: { sourceUrl: fixture.fixtureUrl, html: action === 'fill' ? fixture.inputHtml : fixture.buttonHtml } })) }] }
    const options = { fixture, prompt, workspace, browserLabel: '合成组件浏览器', thread, index: 0 }
    const approval = { approvalId: 'synthetic-review', toolName: 'browser_authorize_action', requestHash: 'a'.repeat(64), status: 'pending', summary: makeSummary('fill') }
    assert.equal(reviewWindowsFixtureApproval(approval, options).scope, 'schedule')
    assert.throws(() => reviewWindowsFixtureApproval({ ...approval, requestHash: 'd'.repeat(64) }, options))
    for (const change of [{ origin: 'https://unreviewed.example.test' }, { value: fixture.query + '扩大' }, { targetHtml: '<input type="password" aria-label="合成公告关键词">' }, { schedule: undefined },
      { pageUrl: undefined }, { pageUrl: fixture.fixtureUrl + '/other' }, { pageUrl: fixture.fixtureUrl + '?different=1' }, { pageUrl: fixture.fixtureUrl + '#other' },
      { verificationPolicy: undefined }, { verificationPolicy: 'strict' }]) {
      assert.throws(() => reviewWindowsFixtureApproval({ ...approval, summary: makeSummary('fill', change) }, options))
    }
    for (const [field, value] of [['执行时刻', '01:20、08:30、16:30'], ['账号状态', '已登录'], ['计划目的', prompt + '扩大范围'], ['页面摘要', ''], ['页面摘要', 'malformed'], ['页面摘要', '0'.repeat(64)], ['校验范围', ''], ['校验范围', '未知策略']]) {
      const summary = approval.summary.replace(new RegExp(`^${field} .+$`, 'm'), `${field} ${JSON.stringify(value)}`)
      assert.throws(() => reviewWindowsFixtureApproval({ ...approval, summary }, options))
    }
    const changedThread = structuredClone(thread)
    changedThread.turns[0].items[0].output.html += '<!-- changed actual DOM -->'
    assert.throws(() => reviewWindowsFixtureApproval(approval, { ...options, thread: changedThread }))
    const click = { ...approval, summary: makeSummary('click') }
    assert.equal(reviewWindowsFixtureApproval(click, { ...options, index: 1 }).action, 'click')
    const planSummary = browserScheduleApprovalSummary({ purpose: prompt, times: ['08:30', '16:30'], timezone: 'Asia/Shanghai', readPaths: [workspace], writePaths: [],
      origins: [origin], browserLabel: options.browserLabel, actions: [{ summary: approval.summary, verificationPolicy: 'public_query_target' }, { summary: click.summary, verificationPolicy: 'public_query_target' }], scopeHash: 'c'.repeat(64) })
    const plan = { ...approval, toolName: 'schedule_task', requestHash: 'c'.repeat(64), summary: planSummary }
    assert.equal(reviewWindowsFixtureApproval(plan, { ...options, index: 2 }).toolName, 'schedule_task')
    assert.throws(() => reviewWindowsFixtureApproval(plan, { ...options, index: 3 }))
    assert.throws(() => reviewWindowsFixtureApproval(plan, { ...options, index: 2, workspace: join(root, 'other') }))
    const writes = planSummary.replace(/^写入路径 .+$/m, `写入路径 ${JSON.stringify(workspace)}`)
    assert.throws(() => reviewWindowsFixtureApproval({ ...plan, summary: writes }, { ...options, index: 2 }))
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }) }
})

test('the exact installed browser fixture request qualifies for explicit public-query review without permitting account or business writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-query-policy-contract-'))
  try {
    const output = join(root, 'browser-contract.mjs')
    await build({ entryPoints: [fileURLToPath(new URL('../kun/src/contracts/browser-skill.ts', import.meta.url))], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { isPublicBrowserQuery } = await import(pathToFileURL(output).href)
    const prompt = windowsTaskPrompt({ fixtureUrl: 'http://127.0.0.1:1234/fixture', query: '轨道交通监测合成验收' }, true)
    assert.equal(isPublicBrowserQuery(prompt), true)
    for (const unsafe of ['登录账号后查询并提交表单', '填写密码后查询', '审批公开采购付款', '查询后发送消息']) {
      assert.equal(isPublicBrowserQuery(`使用browser-skill ${unsafe}`), false)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('UI approval targeting requires the mounted task workspace, actual Chinese allow label and original technical summary', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    // DOM component contract only. Actual approvals must later be clicked in the exact packaged Windows application.
    const values = ['合成站点', '精确合成输入', '08:30、16:30']
    const originalSummary = '确认浏览器操作\n请求摘要 "original-request"'
    const zh = JSON.parse(readFileSync(new URL('../src/renderer/src/locales/zh/common.json', import.meta.url), 'utf8'))
    assert.equal(zh.taskWorkspaceAllow, '允许此操作')
    const card = (entries, text = zh.taskWorkspaceAllow) => `<div><section><dl>${entries.map(value => `<dd>${value}</dd>`).join('')}</dl><details><summary>原始技术详情</summary><pre>${originalSummary}</pre></details></section><div><button>${text}</button></div></div>`
    const cards = card(['其他站点', ...values.slice(1)]) + card(values)
    window.document.body.innerHTML = cards
    assert.equal(window.eval(windowsFixtureApprovalUiExpression(values, originalSummary)), null, 'A chat screen without the task card cannot satisfy this review')
    window.document.body.innerHTML = `<article aria-label="任务详情">${cards}</article>`
    for (const node of window.document.querySelectorAll('button, summary, article')) {
      node.getClientRects = () => [{}]
      node.scrollIntoView = () => undefined
      node.getBoundingClientRect = () => ({ x: 10, y: 20, width: 20, height: 10 })
    }
    const button = window.document.querySelectorAll('button')[1]
    const details = button.parentElement.parentElement.querySelector('details')
    const summary = details.querySelector('summary')
    window.document.elementFromPoint = () => summary
    assert.deepEqual(JSON.parse(JSON.stringify(window.eval(windowsFixtureApprovalUiExpression(values, originalSummary, { openDetails: true })))), { x: 20, y: 25 })
    assert.equal(window.eval(windowsFixtureApprovalUiExpression(values, originalSummary)), null, 'Collapsed technical evidence cannot verify the request')
    details.open = true
    window.document.elementFromPoint = () => button
    const expression = windowsFixtureApprovalUiExpression(values, originalSummary)
    assert.deepEqual(JSON.parse(JSON.stringify(window.eval(expression))), { x: 20, y: 25 })
    assert.equal(window.eval(windowsFixtureApprovalUiExpression(values, originalSummary + ' changed')), null)
    details.open = false
    assert.deepEqual(JSON.parse(JSON.stringify(window.eval(windowsFixtureApprovalUiExpression(values, originalSummary, { businessOnly: true })))), { x: 20, y: 25 })
    assert.equal(window.eval(expression), null, 'The business-only observation must never replace original-summary verification before clicking')
    details.open = true
    assert.equal(window.eval(windowsFixtureApprovalUiExpression(['无关扩大输入'], originalSummary)), null)
    button.textContent = '允许'
    assert.equal(window.eval(expression), null, 'The obsolete chat approval label must not match the task control')
    button.textContent = zh.taskWorkspaceAllow
    window.document.querySelector('article').insertAdjacentHTML('beforeend', card(values))
    window.document.querySelectorAll('button')[2].getClientRects = () => [{}]
    assert.equal(window.eval(expression), null)
  } finally { await window.happyDOM.close() }
})

test('browser recovery keeps the exact original task at zero Turns and model requests until a separate resume', () => {
  const task = { id: 'task-fixture', threadId: 'thread-worker', originThreadId: 'thread-origin', goal: '合成原请求', status: 'waiting_user' }
  const thread = { id: task.threadId, turns: [] }
  const options = { task, thread, originThreadId: task.originThreadId, taskId: task.id, prompt: task.goal, modelRequests: 0, status: 'waiting_user' }
  const initial = inspectWindowsBrowserRecoveryState(options)
  for (const change of [{ modelRequests: 1 }, { task: { ...task, activeTurnId: 'unexpected' } }, { thread: { ...thread, turns: [{ id: 'old-turn' }] } },
    { taskId: 'different' }, { originThreadId: 'different' }, { prompt: 'changed goal' }]) assert.throws(() => inspectWindowsBrowserRecoveryState({ ...options, ...change }))
  const paused = inspectWindowsBrowserRecoveryState({ ...options, task: { ...task, status: 'paused' }, status: 'paused' })
  const binding = { browserInstanceId: 'browser-fixed', revision: 2, origins: ['http://127.0.0.1:1234'], interaction: 'interact', verificationPolicy: 'public_query_target' }
  const confirmed = inspectWindowsBrowserRecoveryState({ ...options, task: { ...task, status: 'paused', authority: { browserScope: binding } }, status: 'paused', binding })
  const evidence = { taskId: task.id, threadId: task.threadId, originThreadId: task.originThreadId, fixtureOrigin: binding.origins[0],
    initial, pausedBeforeConfiguration: paused, blockedResume: paused, confirmed, initialCapability: 'browser_disabled', blockedCapability: 'browser_task_scope_required', blockedRoute: 'task/browser-binding',
    uiPreviewVerified: true, uiConfirmVerified: true, policyReview: { snapshotPolicy: 'strict', beforePublicSelection: paused,
      strictSelection: { input: 'real-cdp-mouse-and-keyboard', selected: { value: 'strict' } }, publicQuerySelection: { input: 'real-cdp-mouse-and-keyboard', selected: { value: 'public_query_target' } } },
    resumed: { taskId: task.id, threadId: task.threadId, turns: 1, firstTurnId: 'first-turn', executionGrant: { id: 'first-grant', verificationPolicy: 'public_query_target' } } }
  assert.equal(validateWindowsBrowserRecoveryEvidence(evidence, binding.browserInstanceId), true)
  for (const key of ['initial', 'pausedBeforeConfiguration', 'blockedResume', 'confirmed']) {
    const changed = structuredClone(evidence); changed[key].turns = 1
    assert.throws(() => validateWindowsBrowserRecoveryEvidence(changed, binding.browserInstanceId))
  }
  for (const change of [{ uiPreviewVerified: false }, { uiConfirmVerified: false }, { blockedRoute: 'marketplace' }, { resumed: { ...evidence.resumed, turns: 2 } }]) {
    assert.throws(() => validateWindowsBrowserRecoveryEvidence({ ...evidence, ...change }, binding.browserInstanceId))
  }
  const implicit = structuredClone(evidence); delete implicit.policyReview
  assert.throws(() => validateWindowsBrowserRecoveryEvidence(implicit, binding.browserInstanceId))
  const strictBinding = structuredClone(evidence); delete strictBinding.confirmed.binding.verificationPolicy
  assert.throws(() => validateWindowsBrowserRecoveryEvidence(strictBinding, binding.browserInstanceId))
  const script = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  const start = script.indexOf('const initial = await readRecovery(')
  const end = script.indexOf('const uiApprovals = []', start)
  const flow = script.slice(start, end)
  assert.ok(flow.indexOf("'暂停'") < flow.indexOf('await installMarketplaceBrowserSkill('))
  assert.ok(flow.indexOf('await startRealBrowserSmoke(') < flow.indexOf("'确认当前任务的浏览器范围'"))
  assert.ok(flow.indexOf('const confirmed = await readRecovery(') < flow.lastIndexOf("'继续任务'"))
  assert.doesNotMatch(flow, /confirmBrowserTaskBinding|runtimeRequest\([^\n]*browser-binding[^\n]*POST|authority\s*=/)
})

test('browser binding UI selection requires the actual task card, complete preview and enabled real confirmation control', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    const zh = JSON.parse(readFileSync(new URL('../src/renderer/src/locales/zh/common.json', import.meta.url), 'utf8'))
    const panel = `<section aria-label="${zh.capabilityRequiredTitle}"><div><p>${zh.browserTaskBindingReview}</p><dl><dt>${zh.browserSkillInstance}</dt><dd>browser-fixed</dd><dt>${zh.browserSkillOrigins}</dt><dd>http://127.0.0.1:1234</dd><dt>${zh.capabilityRequestedScope}</dt><dd>${zh.browserSkillAllowInteraction}</dd></dl><button>${zh.browserTaskBindingConfirm}</button></div></section>`
    window.requestAnimationFrame = callback => { queueMicrotask(() => callback(0)); return 1 }
    window.document.body.innerHTML = panel
    assert.equal(await window.eval(windowsBrowserBindingUiExpression()), null)
    window.document.body.innerHTML = `<article aria-label="任务详情">${panel}</article>`
    const detail = window.document.querySelector('article'), button = detail.querySelector('button')
    detail.getClientRects = button.getClientRects = () => [{}]
    button.scrollIntoView = () => undefined
    button.getBoundingClientRect = () => ({ x: 10, y: 20, width: 20, height: 10 })
    window.document.elementFromPoint = () => button
    const result = JSON.parse(JSON.stringify(await window.eval(windowsBrowserBindingUiExpression())))
    assert.deepEqual(result.point, { x: 20, y: 25 })
    assert.deepEqual(result.values, ['browser-fixed', 'http://127.0.0.1:1234', zh.browserSkillAllowInteraction])
    assert.deepEqual(result.hit, { tag: 'BUTTON', confirmationButton: true })
    assert.equal(result.viewport.width, window.innerWidth)
    assert.ok(Number.isFinite(result.sampledAt))
    assert.equal(result.stableFrames, 2)
    assert.equal(result.observedFrames, 3)
    await window.eval(windowsBrowserBindingUiExpression({ pointerAudit: true }))
    button.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 25, button: 0 }))
    assert.deepEqual(JSON.parse(JSON.stringify(window.__railwiseWindowsBindingPointerAudit.events)).map(({ type, trusted, x, y, target }) => ({ type, trusted, x, y, target })),
      [{ type: 'pointerdown', trusted: false, x: 20, y: 25, target: { tag: 'BUTTON', confirmationButton: true } }])
    const pointer = window.__railwiseWindowsBindingPointerAudit.events[0]
    assert.equal(pointer.buttonAtPointer.rect.y, 20)
    assert.equal(pointer.hitAtPointer.confirmationButton, true)
    window.__railwiseWindowsBindingPointerAudit.stop()
    window.document.elementFromPoint = () => window.document.body
    assert.equal(await window.eval(windowsBrowserBindingUiExpression()), null)
    window.document.elementFromPoint = () => button
    button.disabled = true
    assert.equal(await window.eval(windowsBrowserBindingUiExpression()), null)
    button.disabled = false
    detail.querySelector('dd').remove()
    assert.equal(await window.eval(windowsBrowserBindingUiExpression()), null)
  } finally { await window.happyDOM.close() }
})

test('after an autonomous task leaves Needs you, navigation re-selects the same task through real UI controls', async () => {
  const { Window } = await import('happy-dom'), window = new Window()
  const task = { id: 'task-original', goal: '原任务公开查询与每日两次计划' }, clicks = []
  try {
    // DOM contract only: the actual package run must later exercise CDP mouse input.
    window.document.body.innerHTML = `<section class="ds-task-sidebar" aria-label="任务列表"><nav aria-label="任务筛选"><button>进行中 <span>0</span></button><button aria-pressed="true">需要你 <span>0</span></button><button>已完成 <span>1</span></button><button aria-pressed="false">全部任务 <span>1</span></button></nav><div id="task-buttons"></div></section><section aria-label="任务"><div id="details"></div></section>`
    const all = window.document.querySelector('nav button:last-child'), list = window.document.querySelector('#task-buttons')
    all.addEventListener('click', () => {
      all.setAttribute('aria-pressed', 'true')
      list.innerHTML = '<button aria-pressed="false"><span></span></button><button><span>其他任务</span></button>'
      const original = list.querySelector('button'); original.title = task.goal; original.querySelector('span').textContent = '精简任务标题'
      original.addEventListener('click', () => {
        original.setAttribute('aria-pressed', 'true')
        const detail = window.document.createElement('article'); detail.setAttribute('aria-label', '任务详情')
        const heading = window.document.createElement('h2'); heading.textContent = '精简任务标题'; detail.append(heading); const full=window.document.createElement('details'); const fullGoal=window.document.createElement('p'); fullGoal.textContent=task.goal; full.append(fullGoal); detail.append(full)
        const open = window.document.createElement('button'); open.textContent = '打开原会话'; detail.append(open)
        open.addEventListener('click', () => { window.document.body.dataset.openedTask = task.id })
        window.document.querySelector('#details').replaceChildren(detail)
      })
    })
    const cdp = {
      wait: async expression => { assert.ok(window.eval(expression), 'Only genuine mounted UI state may satisfy navigation') },
      click: async (selector, label) => {
        const node = Array.from(window.document.querySelectorAll(selector)).find(node => !label || node.textContent.trim() === label || node.querySelector('span')?.textContent.trim() === label)
        assert.ok(node); clicks.push(label ?? (node.title || node.firstChild.textContent.trim())); node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      }
    }
    assert.equal(window.document.querySelector('article'), null)
    const result = await openWindowsTaskConversation(cdp, task)
    assert.deepEqual(clicks, ['全部任务', task.goal, '打开原会话'])
    assert.equal(window.document.body.dataset.openedTask, task.id)
    assert.deepEqual(result, { taskId: task.id, goal: task.goal, filter: 'all', exactTaskSelected: true, input: 'real-cdp-mouse' })
    await assert.rejects(openWindowsTaskConversation(cdp, { ...task, goal: '不存在的任务' }), /mounted UI state/)
    all.addEventListener('click', () => list.append(list.firstElementChild.cloneNode(true)))
    await assert.rejects(openWindowsTaskConversation(cdp, task), /mounted UI state/, 'Ambiguous same-goal tasks must not open a different conversation')
    const source = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
    assert.match(source, /originalConversationNavigation = await openWindowsTaskConversation\(cdp, task\)/)
    assert.doesNotMatch(openWindowsTaskConversation.toString(), /runtimeRequest|dispatchEvent|setSelected|setFilter|\.click\(\)/)
  } finally { await window.happyDOM.close() }
})

test('browser binding samples the current hit point immediately before real mouse and retains pointer diagnostics', async () => {
  const calls = [], audit = {}
  const cdp = {
    wait: async expression => { calls.push('fresh-hit-test'); assert.match(expression, /elementFromPoint/); return { point: { x: 120, y: 220 } } },
    send: async (method, parameters) => { if (method === 'Page.bringToFront') { calls.push('bring-to-front'); return } calls.push(parameters.type); assert.equal(method, 'Input.dispatchMouseEvent'); assert.equal(parameters.x, 120); assert.equal(parameters.y, 220) },
    evaluate: async expression => { calls.push('read-and-stop-pointer-audit'); assert.match(expression, /audit\.stop\(\)/); return [{ type: 'pointerdown', trusted: true, target: { confirmationButton: true } }] }
  }
  await clickWindowsBrowserBinding(cdp, audit)
  assert.deepEqual(calls, ['bring-to-front', 'fresh-hit-test', 'mousePressed', 'mouseReleased', 'read-and-stop-pointer-audit'])
  assert.equal(audit.measurement.point.x, 120)
  assert.equal(audit.pointerEvents[0].target.confirmationButton, true)
  cdp.evaluate = async () => [{ type: 'pointerdown', trusted: true, target: { confirmationButton: false } }]
  await assert.rejects(() => clickWindowsBrowserBinding(cdp, {}), /pointerdown must reach/)
  cdp.evaluate = async () => [{ type: 'pointerdown', trusted: false, target: { confirmationButton: true } }]
  await assert.rejects(() => clickWindowsBrowserBinding(cdp, {}), /pointerdown must reach/)
  const source = readFileSync(new URL('./run-windows-ui-smoke.mjs', import.meta.url), 'utf8')
  const preview = source.indexOf('const previewSnapshot = await runtimeRequest(')
  const screenshot = source.indexOf("await writeFile(join(evidenceDir, 'windows-task-browser-binding-before-confirm-zh-dark.png')", preview)
  const click = source.indexOf('await clickWindowsBrowserBinding(cdp, confirmationAudit)', screenshot)
  assert.ok(preview > 0 && screenshot > preview && click > screenshot)
  assert.doesNotMatch(source.slice(screenshot, click), /runtimeRequest\(|cdp\.send\(/)
  assert.doesNotMatch(clickWindowsBrowserBinding.toString(), /\.click\(|runtimeRequest|captureScreenshot/)
})

test('browser policy is selected through a current real mouse target and native keyboard without a direct authority write', async () => {
  const calls = [], options = [{ value: 'strict', label: '严格网页操作', disabled: false }, { value: 'public_query_target', label: '公开资料查询', disabled: false }]
  let waits = 0
  const cdp = {
    send: async (method, parameters) => { calls.push([method, parameters?.type, parameters?.key]); if (method === 'Input.dispatchMouseEvent') assert.deepEqual([parameters.x, parameters.y], [40, 50]) },
    wait: async expression => {
      waits += 1
      if (waits === 1) return { point: { x: 40, y: 50 }, policy: { value: 'strict', disabled: false, options } }
      if (waits === 2) { assert.match(expression, /document\.activeElement/); return true }
      assert.match(expression, /select\.value==="public_query_target"/)
      return { value: 'public_query_target', label: '公开资料查询' }
    }
  }
  const audit = {}
  await selectWindowsBrowserPolicy(cdp, 'public_query_target', audit)
  assert.equal(audit.selected.value, 'public_query_target')
  assert.equal(audit.input, 'real-cdp-mouse-and-keyboard')
  assert.deepEqual(calls.map(([method, type, key]) => method === 'Input.dispatchKeyEvent' ? [type, key] : method === 'Input.dispatchMouseEvent' ? type : method),
    ['Page.bringToFront', 'mousePressed', 'mouseReleased', ['rawKeyDown', 'Home'], ['keyUp', 'Home'], ['rawKeyDown', 'ArrowDown'], ['keyUp', 'ArrowDown'], ['rawKeyDown', 'Enter'], ['keyUp', 'Enter']])
  const body = selectWindowsBrowserPolicy.toString()
  assert.doesNotMatch(body, /\.click\(|\.value\s*=(?!=)|confirmBrowserTaskBinding|runtimeRequest/)
  options[1].disabled = true
  waits = 0
  await assert.rejects(() => selectWindowsBrowserPolicy(cdp, 'public_query_target', {}))
})

test('autonomous query consent requires unchecked explicit scope, actual displayed times and real input without a direct authority write', async () => {
  const text = '08:30、16:30；09:00、17:00；Asia/Shanghai；持续至停用或撤销'
  const run = async (change = {}) => {
    let waits = 0
    const calls = [], audit = {}
    const cdp = {
      wait: async expression => {
        waits++
        if (waits === 1) return { duration: 'task', checked: false, options: ['task', 'schedule'], text, ...change }
        if (waits === 2 || waits === 4) { assert.match(expression, /elementFromPoint/); return { x: 40, y: 50 } }
        if (waits === 3) return { duration: 'schedule', checked: false, text: change.text ?? text }
        return { duration: 'schedule', checked: true, text }
      },
      send: async (method, parameters) => calls.push([method, parameters?.type, parameters?.key])
    }
    await selectWindowsPublicQueryAuthorization(cdp, 'schedule', audit)
    return { audit, calls }
  }
  const { audit, calls } = await run()
  assert.equal(audit.input, 'real-cdp-mouse-and-keyboard')
  assert.equal(audit.selected.checked, true)
  assert.equal(calls.filter(([method, type]) => method === 'Input.dispatchMouseEvent' && type === 'mousePressed').length, 2)
  assert.ok(calls.some(([method, type, key]) => method === 'Input.dispatchKeyEvent' && type === 'rawKeyDown' && key === 'ArrowDown'))
  assert.doesNotMatch(selectWindowsPublicQueryAuthorization.toString(), /\.click\(|\.checked\s*=|\.value\s*=(?!=)|runtimeRequest|confirmBrowserTaskBinding/)
  await assert.rejects(() => run({ checked: true }), /must never be prechecked/)
  await assert.rejects(() => run({ options: ['task'] }))
  await assert.rejects(() => run({ text: '08:30、16:30；09:00、17:00；停用' }), /display Asia\/Shanghai/)
})

test('browser binding preview reads its named browser fields beside purpose and the explicit verification selector', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    const zh = JSON.parse(readFileSync(new URL('../src/renderer/src/locales/zh/common.json', import.meta.url), 'utf8'))
    window.document.body.innerHTML = `<article aria-label="任务详情"><section aria-label="${zh.capabilityRequiredTitle}"><div><p>${zh.browserTaskBindingReview}</p><dl><dt>${zh.browserSkillInstance}</dt><dd>chrome</dd><dt>${zh.browserSkillOrigins}</dt><dd>http://127.0.0.1:1234</dd><dt>任务目的</dt><dd>合成原任务</dd><dt>${zh.capabilityRequestedScope}</dt><dd>${zh.browserSkillAllowInteraction}</dd><dt>网页操作方式</dt><dd><select aria-label="网页操作方式"><option value="strict">严格网页操作</option><option value="public_query_target">公开资料查询</option></select><p>核对完整页面与目标。</p></dd></dl><button>${zh.browserTaskBindingConfirm}</button></div></section></article>`
    const detail = window.document.querySelector('article'), button = detail.querySelector('button'), select = detail.querySelector('select')
    detail.getClientRects = button.getClientRects = select.getClientRects = () => [{}]
    button.getBoundingClientRect = select.getBoundingClientRect = () => ({ x: 10, y: 20, width: 20, height: 10 })
    button.scrollIntoView = select.scrollIntoView = () => undefined
    window.document.elementFromPoint = () => select
    window.requestAnimationFrame = callback => { queueMicrotask(() => callback(0)); return 1 }
    const sampled = await window.eval(windowsBrowserBindingUiExpression({ control: 'policy' }))
    assert.deepEqual(JSON.parse(JSON.stringify(sampled.values)), ['chrome', 'http://127.0.0.1:1234', zh.browserSkillAllowInteraction])
    assert.equal(sampled.purpose, '合成原任务')
    assert.equal(sampled.policy.value, 'strict')
    assert.deepEqual(Array.from(sampled.policy.options, option => option.value), ['strict', 'public_query_target'])
    assert.equal(sampled.hit.tag, 'SELECT')
    select.disabled = true
    assert.equal(await window.eval(windowsBrowserBindingUiExpression({ control: 'policy' })), null)
  } finally { await window.happyDOM.close() }
})

test('browser binding waits for stable painted frames after scroll, re-queries replacement targets and records pointer-time movement', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    const zh = JSON.parse(readFileSync(new URL('../src/renderer/src/locales/zh/common.json', import.meta.url), 'utf8'))
    window.document.body.innerHTML = `<article aria-label="任务详情"><section aria-label="${zh.capabilityRequiredTitle}"><div><p>${zh.browserTaskBindingReview}</p><dl><dt>${zh.browserSkillInstance}</dt><dd>chrome</dd><dt>${zh.browserSkillOrigins}</dt><dd>http://127.0.0.1:1234</dd><dt>${zh.capabilityRequestedScope}</dt><dd>${zh.browserSkillAllowInteraction}</dd></dl><button>${zh.browserTaskBindingConfirm}</button></div></section></article>`
    const detail = window.document.querySelector('article'), root = detail.querySelector('section > div')
    let button = detail.querySelector('button'), frame = 0, top = 0, pointerY, queries = 0
    const queryAll = detail.querySelectorAll.bind(detail)
    detail.querySelectorAll = (...args) => { queries += 1; return queryAll(...args) }
    detail.getClientRects = () => [{}]
    Object.defineProperties(root, { scrollHeight: { get: () => 1000 }, clientHeight: { get: () => 500 }, scrollTop: { get: () => top } })
    const prepare = target => {
      target.getClientRects = () => [{}]
      target.scrollIntoView = options => { assert.equal(options.behavior, 'instant') }
      target.getBoundingClientRect = () => ({ x: 10, y: pointerY ?? (frame >= 2 ? 40 : 20), width: 20, height: 10 })
    }
    prepare(button)
    window.document.elementFromPoint = () => frame === 4 ? window.document.body : button
    window.requestAnimationFrame = callback => {
      queueMicrotask(() => {
        frame += 1
        if (frame === 2) { const replacement = button.cloneNode(true); button.replaceWith(replacement); button = replacement; prepare(button) }
        if (frame === 3) top = 100
        callback(frame)
      })
      return frame + 1
    }
    const result = await window.eval(windowsBrowserBindingUiExpression({ pointerAudit: true }))
    assert.equal(result.observedFrames, 7, 'Changed geometry, scroll and a covered frame each prevent premature input')
    assert.equal(result.stableFrames, 2)
    assert.equal(result.rect.y, 40)
    assert.equal(result.scroll[0].top, 100)
    assert.ok(queries >= frame + 1, 'Every rendered frame re-queries the actual button')
    pointerY = 90
    top = 125
    window.document.elementFromPoint = () => window.document.body
    button.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 45, button: 0 }))
    const pointer = window.__railwiseWindowsBindingPointerAudit.events[0]
    assert.equal(pointer.buttonAtPointer.rect.y, 90)
    assert.equal(pointer.buttonAtPointer.scroll[0].top, 125)
    assert.equal(pointer.hitAtPointer.tag, 'BODY')
    assert.equal(pointer.hitAtPointer.confirmationButton, false)
    window.__railwiseWindowsBindingPointerAudit.stop()
    assert.doesNotMatch(windowsBrowserBindingUiExpression(), /setTimeout|sleep\(/)
  } finally { await window.happyDOM.close() }
})

test('binding POST audit observes actual Node fetch path/status, proves transport with a host read and excludes secrets and queries', async () => {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private-cookie' }); response.end('{"private":"private-response-body"}') })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`, path = '/v1/tasks/task_scope_audit/browser-binding'
  try {
    assert.equal(windowsBindingPostAudit('task_scope_audit').status, 'unavailable', 'No trace cannot be interpreted before verifying the actual transport')
    await (await fetch(`${base}/v1/runtime/info`)).text()
    await (await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer private-token' }, body: 'private-request-body' })).text()
    await (await fetch(base + path + '?private-query', { method: 'POST', body: 'private-other-body' })).text()
    const audit = windowsBindingPostAudit(null, true)
    assert.equal(audit.status, 'available')
    assert.equal(audit.stopped, true)
    assert.equal(audit.probe.responseStatus, 200)
    assert.equal(audit.posts.length, 1)
    assert.equal(audit.posts[0].method, 'POST')
    assert.equal(audit.posts[0].path, path)
    assert.equal(audit.posts[0].status, 200)
    assert.deepEqual(Object.keys(audit.posts[0]).sort(), ['method', 'path', 'requestedAt', 'respondedAt', 'status'])
    assert.doesNotMatch(JSON.stringify(audit), /private|Authorization|Bearer|cookie|body|headers|query/)
    await (await fetch(base + path, { method: 'POST' })).text()
    assert.equal(windowsBindingPostAudit().status, 'unavailable', 'Stopped subscriptions do not survive the owned audit')
  } finally {
    windowsBindingPostAudit(null, true)
    server.closeAllConnections()
    await new Promise(done => server.close(done))
  }
})

test('manual-preview layout keeps task details readable and stacks narrow containers using the actual rem threshold', () => {
  const valid = report().taskExecution.preview.layout
  assert.equal(validateWindowsTaskPreviewLayout(valid), true)
  const smallFont = { ...structuredClone(valid), workspace: { width: 630 }, workspaceInlineSize: 630, stackThresholdPx: 616,
    details: { width: 410, x: 220, y: 20, bottom: 600 }, list: { ...valid.list, width: 180 } }
  assert.equal(validateWindowsTaskPreviewLayout(smallFont), true, 'A 44rem threshold must follow actual root font size')
  for (const change of [{ details: { ...valid.details, width: 20 } }, { details: { ...valid.details, y: 20 } },
    { overflow: { workspace: 1, columns: 2, details: 0 } }, { stackThresholdPx: Number.NaN }, { availableWidth: 0 }, { scale: 0 }, { readableWidth: Number.NaN }]) {
    assert.throws(() => validateWindowsTaskPreviewLayout({ ...valid, ...change }))
  }
  assert.match(windowsTaskPreviewLayoutExpression(), /44\*parseFloat\(getComputedStyle\(document\.documentElement\)\.fontSize\)/)
  assert.doesNotMatch(windowsTaskPreviewLayoutExpression(), /704/)
  assert.throws(() => validateWindowsTaskPreviewLayout({ ...smallFont, list: { ...smallFont.list, width: 300 } }), /must not overlap/, 'Wide layouts must also reject actual overlapping paint')
})

test('manual-preview measurement uses one viewport coordinate unit at the actual small UI zoom and still rejects the observed overlap', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window()
  try {
    window.document.documentElement.style.fontSize = '16px'
    window.document.body.innerHTML = '<section aria-label="任务" style="padding:0px"><div class="ds-task-workspace-columns" style="padding:20px"><div aria-label="任务列表"></div><article aria-label="任务详情"></article></div></section>'
    const workspace = window.document.querySelector('section'), columns = workspace.querySelector('.ds-task-workspace-columns'), list = workspace.querySelector('[aria-label="任务列表"]'), details = workspace.querySelector('article')
    for (const [node, width, box] of [
      [workspace, 368, { x: 260, y: 36, width: 331.2, height: 692, bottom: 728 }],
      [columns, 358, { x: 269, y: 280, width: 322.2, height: 650, bottom: 930 }],
      [list, 318, { x: 278, y: 294, width: 286.2, height: 207, bottom: 501 }],
      [details, 318, { x: 278, y: 502, width: 286.2, height: 600, bottom: 1102 }]
    ]) {
      for (const field of ['offsetWidth', 'clientWidth', 'scrollWidth']) Object.defineProperty(node, field, { configurable: true, value: width })
      node.getBoundingClientRect = () => box
      node.getClientRects = () => [box]
    }
    const measure = () => JSON.parse(JSON.stringify(window.eval(windowsTaskPreviewLayoutExpression())))
    const layout = measure()
    assert.ok(Math.abs(layout.scale - 0.9) < 0.00001)
    assert.ok(Math.abs(layout.availableWidth - 286.2) < 0.00001)
    assert.ok(Math.abs(layout.stackThresholdPx - 633.6) < 0.00001)
    assert.equal(validateWindowsTaskPreviewLayout(layout), true, 'A visually full-width detail must pass at 90% UI zoom')
    details.getBoundingClientRect = () => ({ x: 278, y: 308.75, width: 286.2, height: 1208, bottom: 1517 })
    assert.throws(() => validateWindowsTaskPreviewLayout(measure()), /must not overlap/, 'The failed run painted details over the actual list')
    details.getBoundingClientRect = () => ({ x: 278, y: 502, width: 200, height: 600, bottom: 1102 })
    assert.throws(() => validateWindowsTaskPreviewLayout(measure()), /remain readable/)
  } finally { await window.happyDOM.close() }
})

test('manual-preview measurement finds the relocated left sidebar and rejects a duplicated center list', async () => {
  const { Window } = await import('happy-dom'), window = new Window()
  try {
    window.document.documentElement.style.fontSize = '16px'
    window.document.body.innerHTML = '<section class="ds-task-sidebar" aria-label="任务列表"></section><section aria-label="任务" style="padding:0px"><div class="ds-task-workspace-detail" style="padding:20px"><article aria-label="任务详情"></article></div></section>'
    const workspace=window.document.querySelector('section[aria-label="任务"]'), sidebar=window.document.querySelector('.ds-task-sidebar'), columns=workspace.querySelector('.ds-task-workspace-detail'), details=workspace.querySelector('article')
    for (const [node,width,box] of [[sidebar,240,{x:0,y:36,width:216,height:692,bottom:728}], [workspace,368,{x:216,y:36,width:331.2,height:692,bottom:728}], [columns,368,{x:216,y:190,width:331.2,height:538,bottom:728}], [details,328,{x:234,y:208,width:295.2,height:502,bottom:710}]]) {
      for (const field of ['offsetWidth','clientWidth','scrollWidth']) Object.defineProperty(node,field,{configurable:true,value:width})
      node.getBoundingClientRect=()=>box; node.getClientRects=()=>[box]
    }
    const measure=()=>JSON.parse(JSON.stringify(window.eval(windowsTaskPreviewLayoutExpression())))
    const layout=measure()
    assert.equal(layout.navigationPlacement,'sidebar'); assert.equal(layout.taskListCount,1)
    assert.equal(validateWindowsTaskPreviewLayout(layout),true)
    const duplicate=window.document.createElement('div'); duplicate.setAttribute('aria-label','任务列表'); workspace.append(duplicate)
    assert.throws(()=>validateWindowsTaskPreviewLayout(measure()),/appear once/)
    duplicate.remove()
    sidebar.getBoundingClientRect=()=>({x:230,y:36,width:216,height:692,bottom:728})
    assert.throws(()=>validateWindowsTaskPreviewLayout(measure()),/must not overlap/)
  } finally { await window.happyDOM.close() }
})

test('the production gate, repository projection and inbox route expose pending task approval payloads without transcript approval items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-inbox-contract-'))
  try {
    const output = join(root, 'production-inbox.cjs')
    await build({ stdin: { contents: `export { TaskRunRepository } from './kun/src/services/task-run-repository.ts'; export { PersistentApprovalGate } from './kun/src/adapters/persistent-human-gates.ts'; export { getTaskInbox } from './kun/src/server/routes/tasks.ts';`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const { TaskRunRepository, PersistentApprovalGate, getTaskInbox } = createRequire(import.meta.url)(output)
    // Persistence is an in-memory SQL facade; production saveHumanRequest,
    // putAttention, inbox serialization and HTTP response code run unchanged.
    const human = new Map(), attention = new Map()
    const task = { id: 'synthetic-task', threadId: 'synthetic-worker', activeTurnId: 'synthetic-turn', status: 'running', revision: 1 }
    const repository = Object.create(TaskRunRepository.prototype)
    repository.changeListeners = new Set()
    repository.db = { prepare(sql) { return {
      get(id) { const value = human.get(id); return value ? { data_json: value } : undefined },
      run(id, ...args) { if (sql.startsWith('INSERT INTO human_requests')) human.set(id, args[0]); else if (sql.startsWith('INSERT INTO inbox_items')) attention.set(id, args.at(-1)); else throw new Error(`Unexpected synthetic SQL: ${sql}`) },
      all() { return [...(sql.includes('FROM inbox_items') ? attention : human).values()].map(data_json => ({ data_json })) }
    } } }
    repository.transaction = operation => operation()
    repository.findActiveByThread = id => id === task.threadId ? task : null
    repository.update = (_id, _revision, update) => Object.assign(task, update(task))
    const gate = new PersistentApprovalGate(repository, () => '2026-11-13T00:00:00Z')
    const approval = { id: 'synthetic-request', threadId: task.threadId, turnId: task.activeTurnId, toolName: 'browser_authorize_action',
      summary: '原始合成审批摘要', requestHash: 'a'.repeat(64), status: 'pending', createdAt: '2026-11-13T00:00:00Z' }
    void gate.request(approval)
    const thread = { turns: [{ id: task.activeTurnId, items: [] }] }
    assert.equal(thread.turns.flatMap(turn => turn.items).filter(item => item.kind === 'approval').length, 0)
    const response = getTaskInbox({ taskRepository: repository }, new Request('http://synthetic/v1/inbox'))
    const inbox = JSON.parse(response.body)
    const [pending] = windowsFixturePendingApprovals(inbox, task)
    assert.equal(pending.approvalId, approval.id)
    assert.equal(pending.summary, approval.summary)
    assert.equal(pending.requestHash, approval.requestHash)
    for (const change of [{ taskId: 'other' }, { ownerId: 'other' }, { threadId: 'other' }, { requestId: 'other' }, { message: 'changed' },
      { payload: { approval: { ...approval, turnId: 'other' } } }]) assert.throws(() => windowsFixturePendingApprovals([{ ...inbox[0], ...change }], task))
    assert.throws(() => windowsFixturePendingApprovals([inbox[0], inbox[0]], task))
    assert.equal(windowsFixtureApprovalResolution([], pending, task.id), undefined)
    const resolution = { taskId: task.id, kind: 'approval_resolution', sourceId: approval.id, text: JSON.stringify({ request: approval.summary, resolution: { decision: 'allow' } }) }
    assert.equal(windowsFixtureApprovalResolution([resolution], pending, task.id).status, 'allowed')
    assert.throws(() => windowsFixtureApprovalResolution([{ ...resolution, text: JSON.stringify({ request: 'changed', resolution: { decision: 'allow' } }) }], pending, task.id))
    assert.throws(() => windowsFixtureApprovalResolution([{ ...resolution, text: JSON.stringify({ request: approval.summary, resolution: { decision: 'deny' } }) }], pending, task.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('policy evidence binds actual task, Turn Grant, fresh target, derived authorization and native expectations', () => {
  const fixture = { fixtureUrl: 'http://127.0.0.1:1234/fixture', inputHtml: '<input aria-label="合成查询">', buttonHtml: '<button>查询</button>', query: '合成查询',
    observed: { requests: [{ browserAction: { action: 'fill', sessionId: 'actual-session', targetRef: '@e1' } }, { browserAction: { action: 'click', sessionId: 'actual-session', targetRef: 'e2' } }] } }
  const digest = value => createHash('sha256').update(value).digest('hex')
  const input = verificationPolicy => {
    const optional = verificationPolicy === undefined ? {} : { verificationPolicy }
    const scope = { browserInstanceId: 'test-browser', revision: 2, origins: ['http://127.0.0.1:1234'], interaction: 'interact', ...optional }
    const task = { id: 'task-fixture', authority: { browserScope: scope } }
    const turn = { id: 'turn-fixture', executionGrant: { id: 'grant-fixture', taskId: task.id, browserScope: structuredClone(scope) },
      items: ['fill', 'click'].map(action => ({ kind: 'tool_call', callId: `smoke-${action}`, toolName: `browser_${action}`, arguments: {} })) }
    const receipts = turn.items.flatMap((call, i) => {
      const action = i ? 'click' : 'fill', binding = { action, turnId: turn.id, sessionId: 'actual-session', elementHash: digest(i ? fixture.buttonHtml : fixture.inputHtml), ...(i ? {} : { valueHash: digest(fixture.query) }), ...optional }
      const expectation = verificationPolicy === 'public_query_target' ? { expectationVersion: 'native-dom-v1',
        expectationHash: digest(JSON.stringify(windowsFixtureNativeExpectations(fixture, { action, targetRef: i ? 'e2' : '@e1', inputTargetRef: '@e1' }))) } : {}
      return [{ id: `dispatch-${action}`, ownerId: task.id, kind: 'browser_action_dispatch', status: 'succeeded',
        request: { ...binding, ...expectation, toolName: `browser_${action}`, targetRef: i ? 'e2' : '@e1', pageUrl: fixture.fixtureUrl, dependsOn: [] },
        result: { actionAcknowledged: true, readbackPending: false, ...(!i && verificationPolicy === 'public_query_target' ? {
          publicQueryInput: { target: '@e1', value: fixture.query, elementHash: binding.elementHash, frameUrl: fixture.fixtureUrl } } : {}) } },
      { id: `derived-${action}`, ownerId: task.id, kind: 'browser_derived_action_authorization', status: 'succeeded', request: { ...binding, grantId: turn.executionGrant.id }, result: { ...optional } }]
    })
    return { task, thread: { turns: [turn] }, receipts }
  }
  const check = value => inspectWindowsBrowserPolicy(value.task, value.thread, value.receipts, fixture)
  const valid = input('public_query_target')
  const result = check(valid)
  assert.deepEqual(result.dispatches.map(item => item.dependsOn), [[], []])
  assert.ok(result.dispatches.every(item => item.nativeExpectationVerified && item.inputBindingVerified && item.expectationVersion === 'native-dom-v1'))
  assert.equal(result.grants[0].id, 'grant-fixture')
  for (const mutate of [value => { delete value.task.authority.browserScope.verificationPolicy },
    value => { value.thread.turns[0].executionGrant.browserScope.verificationPolicy = 'strict' },
    value => { value.receipts[0].request.dependsOn = ['e1'] }, value => { value.receipts[0].request.dependsOn.push('other') },
    value => { delete value.receipts[0].request.expectationHash }, value => { value.receipts[0].request.expectationHash = '0'.repeat(64) },
    value => { value.receipts[0].request.expectationVersion = 'other' }, value => { value.receipts[0].result.publicQueryInput.value = 'changed' },
    value => { value.receipts[0].result.publicQueryInput.target = '@e999' }, value => { value.receipts[0].result.publicQueryInput.frameUrl += '?changed' },
    value => { delete value.receipts[0].request.verificationPolicy },
    value => { value.receipts[0].request.targetRef = 'e99' }, value => { value.receipts[0].request.pageUrl += '?other=1' },
    value => { value.receipts[1].request.grantId = 'old-grant' }, value => { value.receipts[1].result.verificationPolicy = 'strict' },
    value => { value.receipts[0].result.readbackPending = true }, value => { value.receipts[0].status = 'outcome_unknown' }]) {
    const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => check(invalid))
  }
  const legacy = input(undefined), before = structuredClone(legacy)
  assert.equal(inspectWindowsBrowserPolicy(legacy.task, legacy.thread, legacy.receipts, fixture, 'strict').verificationPolicy, 'strict')
  assert.deepEqual(legacy, before, 'Missing legacy policy is interpreted as strict without changing persisted hashes')
  legacy.receipts[0].request.dependsOn = ['@e1']
  assert.throws(() => inspectWindowsBrowserPolicy(legacy.task, legacy.thread, legacy.receipts, fixture, 'strict'), 'An old strict Grant never gains target dependencies implicitly')
  const strict = input(undefined)
  strict.receipts[0].request.expectationVersion = 'native-dom-v1'
  assert.throws(() => inspectWindowsBrowserPolicy(strict.task, strict.thread, strict.receipts, fixture, 'strict'), 'An old strict Grant never gains target expectations implicitly')
})

test('controlled native expectations include the precise DOM attributes and the previously filled input value for a click', () => {
  const fixture = { inputHtml: '<input type="search" id="query" aria-label="合成公告关键词">',
    buttonHtml: '<button type="button" id="search">查询合成公告</button>', query: '轨道监测' }
  assert.deepEqual(windowsFixtureNativeExpectations(fixture, { action: 'fill', targetRef: '@e1' }), [
    { target: '@e1', field: 'exists', equals: true }, { target: '@e1', field: 'value', equals: '' },
    { target: '@e1', field: 'attribute', attribute: 'id', equals: 'query' }, { target: '@e1', field: 'attribute', attribute: 'aria-label', equals: '合成公告关键词' },
    { target: '@e1', field: 'attribute', attribute: 'type', equals: 'search' } ])
  const click = windowsFixtureNativeExpectations(fixture, { action: 'click', targetRef: '@e2', inputTargetRef: '@e1' })
  assert.deepEqual(click.slice(0, 4), [{ target: '@e2', field: 'exists', equals: true }, { target: '@e2', field: 'text', equals: '查询合成公告' },
    { target: '@e2', field: 'attribute', attribute: 'id', equals: 'search' }, { target: '@e2', field: 'attribute', attribute: 'type', equals: 'button' }])
  assert.deepEqual(click[5], { target: '@e1', field: 'value', equals: '轨道监测' })
})

test('task-query evidence requires a real scope receipt and exact current action without invented human approvals', () => {
  const fingerprint = value => {
    const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : item
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
  }
  const task = { id: 'task_source', goal: '公开检索', acceptance: { schedule: { kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 } } }
  const authorization = { receiptId: 'binding-row', duration: 'schedule', purposeHash: fingerprint({ purpose: task.goal }), requirementHash: fingerprint({ requirement: task.acceptance.schedule }) }
  const scope = { browserInstanceId: 'actual-browser', origins: ['https://example.test'], interaction: 'interact', verificationPolicy: 'public_query_target', revision: 2, publicQueryAuthorization: authorization }
  const grant = { id: 'current-grant', browserScope: scope }
  const binding = { id: 'binding-row', ownerId: task.id, kind: 'browser_binding', status: 'succeeded',
    request: { confirmed: true, publicQueryAuthorization: 'schedule' },
    result: { purpose: task.goal, browserRevision: 2, ...scope } }
  const target = { action: 'fill', pageUrl: 'https://example.test/search', elementHash: 'a'.repeat(64), valueHash: 'b'.repeat(64),
    browserInstanceId: scope.browserInstanceId, browserRevision: 2, verificationPolicy: 'public_query_target', sessionId: 'fresh-session', turnId: 'current-turn' }
  const scoped = { id: 'scope-action-row', ownerId: task.id, kind: 'browser_scope_action_authorization', status: 'succeeded', createdAt: '2026-11-14T09:00:00.000Z',
    request: { ...target, taskId: task.id, sourceTaskId: task.id, grantId: grant.id, purposeHash: authorization.purposeHash, requirementHash: authorization.requirementHash,
      scopeAuthorizationReceiptId: binding.id, contextHash: 'c'.repeat(64), rule: 'search_input', origin: 'https://example.test' },
    result: { id: 'action-hash', authorizationSource: 'task_scope', scopeAuthorizationReceiptId: binding.id, sourceTaskId: task.id,
      accountState: 'unknown', access: 'public_query', verificationPolicy: 'public_query_target', expiresAt: '2026-11-14T09:15:00.000Z' } }
  const derived = { id: 'derived-row', ownerId: task.id, status: 'succeeded', kind: 'browser_derived_action_authorization', createdAt: scoped.createdAt,
    request: { ...scoped.request, actionId: scoped.result.id, scopeActionReceiptId: scoped.id },
    result: { ...scoped.result, scopeActionReceiptId: scoped.id } }
  const dispatch = { request: { ...target, authorizationSource: 'task_scope', scopeAuthorizationReceiptId: binding.id, scopeActionReceiptId: scoped.id } }
  const base = { task, grant, dispatch, derived, receipts: [binding, scoped], actualRequest: { contextHash: 'c'.repeat(64) } }
  const finalize = value => { for (const receipt of [...value.receipts, value.derived]) receipt.fingerprint = fingerprint(receipt.request); return value }
  const valid = finalize(structuredClone(base))
  assert.equal(inspectWindowsTaskScopeAction(valid).taskConsentVerified, true)
  const due = structuredClone(valid)
  due.task.id = 'task_due'; due.task.scheduledBy = { scheduleId: 'schedule_task_source', dueAt: '2026-11-14T09:00:00.000Z' }
  due.grant.id = 'fresh-due-grant'
  due.grant.browserScheduleBinding = { sourceTaskId: 'task_source', scheduleId: 'schedule_task_source', versionId: 'real-published-version', scopeHash: 'd'.repeat(64) }
  due.derived.ownerId = due.receipts[1].ownerId = due.task.id
  for (const item of [due.receipts[1], due.derived]) Object.assign(item.request, { taskId: due.task.id, grantId: due.grant.id, binding: due.grant.browserScheduleBinding })
  finalize(due)
  assert.equal(inspectWindowsTaskScopeAction(due).scopeActionVerified, true)
  due.derived.request.binding = { ...due.derived.request.binding, versionId: 'superseded-version' }
  finalize(due)
  assert.throws(() => inspectWindowsTaskScopeAction(due))
  for (const mutate of [value => { value.receipts.splice(0, 1) }, value => { value.receipts[0].request.confirmed = false },
    value => { value.receipts[0].request.publicQueryAuthorization = 'task' }, value => { value.receipts[0].result.purpose = 'another task' },
    value => { value.receipts[1].request.grantId = 'old-grant' }, value => { value.receipts[1].request.elementHash = 'd'.repeat(64) },
    value => { value.receipts[1].request.contextHash = 'd'.repeat(64) }, value => { value.receipts[1].request.rule = 'model-says-safe' },
    value => { value.derived.result.sourceApprovalId = 'fake-human-approval' }, value => { value.derived.result.expiresAt = '2026-11-14T09:15:01.000Z' },
    value => { value.dispatch.request.scopeAuthorizationReceiptId = 'another-binding' }]) {
    const invalid = structuredClone(base); mutate(invalid); finalize(invalid)
    assert.throws(() => inspectWindowsTaskScopeAction(invalid))
  }
})

test('scheduled query validation requires source UI reviews and independent derived authority without extra due approvals', () => {
  // Synthetic validator input; never emitted as actual business evidence.
  const documentNavigation = { verified: true, intent: 'click', nativeAction: 'navigate', clickDispatched: false, actionAcknowledged: false,
    navigationAcknowledged: true, readbackPending: false, freshContextVerified: true, primaryDocumentReadbackVerified: true,
    taskConsentVerified: true, scopeActionVerified: true, receiptId: 'synthetic-navigation', hostReceiptId: 'synthetic-host' }
  const query = { documentNavigation, domReadbackVerified: true, htmlReadbackVerified: true, primaryDocumentReadbackVerified: true,
    verifiedFields: ['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification'],
    actions: 2, unknownOutcomes: 0, accountState: 'unknown', access: 'public_query' }
  const policyProjection = (id, count = 2) => ({ verificationPolicy: 'public_query_target', grants: [{ id, verificationPolicy: 'public_query_target' }],
    dispatches: ['@e1', 'e2', 'e3', 'e4'].slice(0, count).map((targetRef, index) => ({ phase: index >= 2 ? 'post_plan' : 'initial', verificationPolicy: 'public_query_target', derivedVerificationPolicy: 'public_query_target', grantId: id, targetRef,
      dependsOn: [], expectationVersion: 'native-dom-v1', expectationHash: 'a'.repeat(64), nativeExpectationVerified: true, inputBindingVerified: true })) })
  const evidence = { browserSkill: { sourceUrl: 'http://127.0.0.1:1234/fixture', publicQuery: { ...query, actions: 4, postPlanQuery: { verified: true, actions: 2, planId: 'synthetic-owned-plan', startedAfterScheduleReadback: true, freshSession: true, acknowledgementAndReadbackVerified: true }, policyExecution: policyProjection('source-grant', 4), uiApprovals: ['browser_authorize_action', 'browser_authorize_action', 'schedule_task'].map(toolName => ({ toolName, status: 'allowed', verificationPolicy: 'public_query_target', uiFieldsVerified: true, businessCardDisplayedVerified: true, originalSummaryVerified: true, cardDisplayedVerified: true, buttonOperableVerified: true })), persistentActionAuthorizations: 2 } },
    dueOccurrence: { artifactSha256: 'a'.repeat(64), webArtifactEvidence: syntheticWebArtifactVerification(),
      publicQuery: { ...query, policyExecution: policyProjection('due-grant'), addedApprovals: 0, derivedActionAuthorizations: 3, publishedPlanVersionVerified: true, enabledPlanVerified: true, shortAuthorizationVerified: true } } }
  assert.doesNotThrow(() => validateWindowsScheduledQueryEvidence(evidence))
  const modern = structuredClone(evidence)
  const consent = { receiptId: 'real-binding-row', duration: 'schedule', purposeHash: 'b'.repeat(64), requirementHash: 'c'.repeat(64) }
  Object.assign(modern.browserSkill.publicQuery, { uiApprovals: [], persistentActionAuthorizations: 0, scopeActionAuthorizations: 5,
    taskScopeAuthorization: { ...consent, authorizationSource: 'task_scope', uiConsentVerified: true } })
  modern.dueOccurrence.publicQuery.scopeActionAuthorizations = 3
  for (const item of [modern.browserSkill.publicQuery, modern.dueOccurrence.publicQuery]) {
    for (const grant of item.policyExecution.grants) grant.publicQueryAuthorization = consent
    for (const dispatch of item.policyExecution.dispatches) Object.assign(dispatch, { authorizationSource: 'task_scope', scopeAuthorizationReceiptId: consent.receiptId,
      scopeActionReceiptId: `actual-scoped-${dispatch.targetRef}`, taskConsentVerified: true, scopeActionVerified: true })
  }
  assert.doesNotThrow(() => validateWindowsScheduledQueryEvidence(modern))
  for (const mutate of [value => { value.browserSkill.publicQuery.documentNavigation.actionAcknowledged = true },
    value => { value.dueOccurrence.publicQuery.documentNavigation.clickDispatched = true },
    value => { value.dueOccurrence.publicQuery.documentNavigation.freshContextVerified = false },
    value => { delete value.dueOccurrence.publicQuery.documentNavigation },
    value => { delete value.browserSkill.publicQuery.postPlanQuery },
    value => { value.browserSkill.publicQuery.postPlanQuery.startedAfterScheduleReadback = false },
    value => { value.browserSkill.publicQuery.postPlanQuery.freshSession = false },
    value => { value.browserSkill.publicQuery.postPlanQuery.acknowledgementAndReadbackVerified = false },
    value => { value.browserSkill.publicQuery.policyExecution.dispatches[2].phase = 'initial' },
    value => { value.browserSkill.publicQuery.actions = 2 },
    value => { value.browserSkill.publicQuery.uiApprovals.push({ toolName: 'browser_authorize_action' }) },
    value => { value.browserSkill.publicQuery.taskScopeAuthorization.uiConsentVerified = false },
    value => { value.dueOccurrence.publicQuery.scopeActionAuthorizations = 1 },
    value => { value.dueOccurrence.publicQuery.policyExecution.dispatches[0].scopeAuthorizationReceiptId = 'another-task' },
    value => { delete value.dueOccurrence.publicQuery.policyExecution.grants[0].publicQueryAuthorization },
    value => { value.dueOccurrence.publicQuery.policyExecution.dispatches[0].scopeActionVerified = false }]) {
    const invalid = structuredClone(modern); mutate(invalid); assert.throws(() => validateWindowsScheduledQueryEvidence(invalid))
  }
  for (const [field, value] of [['addedApprovals', 1], ['derivedActionAuthorizations', 0], ['publishedPlanVersionVerified', false], ['enabledPlanVerified', false], ['shortAuthorizationVerified', false], ['unknownOutcomes', 1], ['domReadbackVerified', false], ['htmlReadbackVerified', false], ['primaryDocumentReadbackVerified', false], ['verifiedFields', ['title']]]) {
    const changed = structuredClone(evidence)
    changed.dueOccurrence.publicQuery[field] = value
    assert.throws(() => validateWindowsScheduledQueryEvidence(changed))
  }
  const noReview = structuredClone(evidence)
  noReview.browserSkill.publicQuery.uiApprovals.pop()
  assert.throws(() => validateWindowsScheduledQueryEvidence(noReview))
  for (const mutate of [value => { value.dueOccurrence.publicQuery.policyExecution.dispatches[0].dependsOn = ['@e1'] },
    value => { delete value.dueOccurrence.publicQuery.policyExecution.dispatches[0].expectationHash },
    value => { value.dueOccurrence.publicQuery.policyExecution.dispatches[0].nativeExpectationVerified = false },
    value => { value.dueOccurrence.publicQuery.policyExecution.dispatches[0].inputBindingVerified = false },
    value => { value.dueOccurrence.publicQuery.policyExecution.grants[0].verificationPolicy = 'strict' },
    value => { value.dueOccurrence.publicQuery.policyExecution = policyProjection('source-grant') },
    value => { delete value.browserSkill.publicQuery.uiApprovals[0].verificationPolicy }]) {
    const invalid = structuredClone(evidence); mutate(invalid); assert.throws(() => validateWindowsScheduledQueryEvidence(invalid))
  }
  for (const field of ['businessCardDisplayedVerified', 'originalSummaryVerified', 'cardDisplayedVerified', 'buttonOperableVerified']) {
    const missing = structuredClone(evidence)
    missing.browserSkill.publicQuery.uiApprovals[0][field] = false
    assert.throws(() => validateWindowsScheduledQueryEvidence(missing))
  }
})

test('failed task evidence retains status and codes without exporting prompts, arguments or tool content', () => {
  const summary = summarizeWindowsTaskFailure({ id: 'task', threadId: 'thread', status: 'stalled', goal: 'private prompt', artifacts: [] },
    { turns: [{ id: 'turn', status: 'failed', error: 'HTTP 400 Authorization=private-key', items: [
      { kind: 'user_message', text: 'private prompt' },
      { kind: 'tool_result', toolName: 'browser_navigate', callId: 'call', isError: true,
        arguments: { secret: 'private-key' }, output: { status: 'failed', code: 'browser_scope_required', html: 'private page' } }
    ] }] }, [{ id: 'receipt', toolName: 'browser_navigate', status: 'failed', request: { secret: 'private-key' } }])
  assert.equal(summary.turns[0].toolResults[0].code, 'browser_scope_required')
  assert.equal(summary.receipts[0].status, 'failed')
  assert.doesNotMatch(JSON.stringify(summary), /private prompt|private-key|private page/)
  const output = { code: 'TypeError: CLI connection closed unexpectedly', error: { message: 'TypeError: Cannot read properties of undefined', request: { body: 'private page' } },
    message: 'CLI exited with code 1', detail: 'Authorization: private-key' }
  const providerFailure = summarizeWindowsTaskFailure({}, { turns: [{ items: [{ kind: 'tool_result', output }] }] }, [],
    [{ result: { item: { output } } }], [], [{ attributes: { 'error.message': 'TypeError: CLI child closed', body: 'private page' } }, { attributes: { errorMessage: 'headers: private-key' } }])
  assert.equal(providerFailure.turns[0].toolResults[0].outputErrorDetail, output.code, 'The real Browser provider uses error.message as output.code when no typed code exists')
  assert.equal(providerFailure.turns[0].toolResults[0].error, output.error.message)
  assert.equal(providerFailure.turns[0].toolResults[0].message, output.message)
  assert.equal(providerFailure.operations[0].result.outputErrorDetail, output.code)
  assert.equal(providerFailure.operations[0].result.outputError, output.error.message)
  assert.equal(providerFailure.operations[0].result.outputMessage, output.message)
  assert.equal(providerFailure.spans[0].errorMessage, 'TypeError: CLI child closed')
  assert.doesNotMatch(JSON.stringify(providerFailure), /private|Authorization|headers|body/)
  assert.deepEqual(providerFailure.operations[0].request, {})
})

test('failure diagnostics retain exact native scalar proof from both Host output and dispatch result without exporting other fields', () => {
  const diagnostics = { vendorCode: 'precondition_failed', vendorReason: 'context_stale', vendorPhase: 'preparation', vendorFailureKind: 'context_stale',
    effectState: 'none', vendorPressSent: false, vendorDispatched: false, notDispatched: true, actionDispatch: 'not_sent', stage: 'action',
    actionAcknowledged: false, readbackPending: false, outcomeUnknown: false, refreshAttempted: true, refreshExhausted: true }
  const output = { ...diagnostics, provider: 'browser-skill', status: 'failed', code: 'browser_action_not_dispatched', html: 'private html', arguments: 'private arguments', stderr: 'private stderr', token: 'private-key', surprise: true }
  const report = summarizeWindowsTaskFailure({}, { turns: [{ items: [{ kind: 'tool_result', toolName: 'browser_click', callId: 'call', isError: true, output }] }] }, [],
    [{ id: 'dispatch', kind: 'browser_action_dispatch', result: { ...output, item: { output } } }])
  assert.deepEqual(report.turns[0].toolResults[0].nativeDiagnostics, diagnostics)
  assert.deepEqual(report.operations[0].result.nativeDiagnostics, diagnostics)
  assert.deepEqual(report.operations[0].result.outputNativeDiagnostics, diagnostics)
  const separate = summarizeWindowsTaskFailure({}, {}, [], [{ result: { vendorPhase: 'preparation', item: { output: { vendorPhase: 'precondition' } } } }])
  assert.equal(separate.operations[0].result.nativeDiagnostics.vendorPhase, 'preparation')
  assert.equal(separate.operations[0].result.outputNativeDiagnostics.vendorPhase, 'precondition')
  assert.doesNotMatch(JSON.stringify(report), /private|html|arguments|stderr|token|surprise/)
  const malicious = summarizeWindowsTaskFailure({}, { turns: [{ items: [{ kind: 'tool_result', output: { vendorReason: 'https://private.test/path', stage: 'curl command', vendorDispatched: 'false', notDispatched: { secret: 'private-key' }, effectState: 'unverified_page_text' } }] }] })
  assert.deepEqual(malicious.turns[0].toolResults[0].nativeDiagnostics, {})
})

test('failure collection reads each due task and its own thread even when external receipt projection is empty or unavailable', async () => {
  const reads = []
  const read = async path => {
    reads.push(path)
    if (path === '/v1/tasks/source') return { id: 'source', threadId: 'source-thread', status: 'completed' }
    if (path === '/v1/tasks/due') return { id: 'due', threadId: 'due-thread', activeTurnId: 'due-turn', status: 'stalled' }
    if (path === '/v1/threads/source-thread') return { id: 'source-thread', turns: [] }
    if (path === '/v1/threads/due-thread') return { id: 'due-thread', turns: [{ id: 'due-turn', status: 'failed', error: 'browser_context_stale',
      items: [{ kind: 'tool_call', toolName: 'browser_fill', callId: 'due-fill', arguments: { value: 'private page' } }] }] }
    if (path === '/v1/tasks/source/receipts') return []
    throw new Error('Authorization: private-key')
  }
  const source = await collectWindowsTaskFailure('source', read), due = await collectWindowsTaskFailure('due', read)
  assert.equal(source.task.status, 'completed')
  assert.equal(due.task.status, 'stalled')
  assert.equal(due.turns[0].id, 'due-turn')
  assert.equal(due.turns[0].toolCalls[0].callId, 'due-fill')
  assert.deepEqual(due.readFailures, ['receipts'])
  assert.deepEqual(reads, ['/v1/tasks/source', '/v1/threads/source-thread', '/v1/tasks/source/receipts', '/v1/tasks/due', '/v1/threads/due-thread', '/v1/tasks/due/receipts'])
  assert.doesNotMatch(JSON.stringify(due), /private-key|private page|Authorization/)
})

test('owned SQLite diagnostics preserve browser dispatch, derived authorization, unknown outcome, events and spans without exporting authority or payloads', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const root = await mkdtemp(join(tmpdir(), 'railwise-due-diagnostic-'))
  const stamp = '2026-11-13T06:00:00.000Z'
  try {
    await mkdir(join(root, 'runtime'))
    const database = new DatabaseSync(join(root, 'runtime', 'tasks.sqlite3'))
    try {
      database.exec('CREATE TABLE task_runs(id TEXT PRIMARY KEY,data_json TEXT); CREATE TABLE operation_receipts(owner_id TEXT,data_json TEXT); CREATE TABLE task_events(task_id TEXT,sequence INTEGER,kind TEXT,payload_json TEXT,created_at TEXT); CREATE TABLE runtime_spans(task_id TEXT,started_at TEXT,data_json TEXT)')
      database.prepare('INSERT INTO task_runs VALUES(?,?)').run('due', JSON.stringify({ id: 'due', status: 'stalled', goal: 'private prompt', threadId: 'due-thread', activeTurnId: 'due-turn', scheduledBy: { scheduleId: 'schedule_source', dueAt: stamp } }))
      for (const [index, kind, status] of [[1, 'tool', 'running'], [2, 'browser_action_dispatch', 'prepared'], [3, 'browser_derived_action_authorization', 'succeeded'], [4, 'browser_schedule_action_outcome', 'outcome_unknown']]) {
        database.prepare('INSERT INTO operation_receipts VALUES(?,?)').run('due', JSON.stringify({ id: `operation_${index}`, ownerId: 'due', kind, status, createdAt: stamp, updatedAt: stamp,
          request: { toolName: 'browser_fill', callId: 'smoke-fill', turnId: 'due-turn', dispatchTracking: 'host-v1', arguments: { value: 'private page' }, executionGrant: { token: 'private-token' }, headers: { Authorization: 'private-key' } },
          result: { approved: true, item: { isError: true, output: { code: 'operation_not_dispatched', status: 'failed', html: 'private page' } }, token: 'private-token' }, error: 'Authorization: private-key with spaces' }))
      }
      database.prepare('INSERT INTO operation_receipts VALUES(?,?)').run('unrelated', JSON.stringify({ id: 'unrelated-operation', kind: 'tool' }))
      database.prepare('INSERT INTO task_events VALUES(?,?,?,?,?)').run('due', 1, 'task_stalled', JSON.stringify({ operationIds: ['operation_2'], message: 'private prompt', headers: { cookie: 'private-cookie' } }), stamp)
      database.prepare('INSERT INTO runtime_spans VALUES(?,?,?)').run('due', stamp, JSON.stringify({ id: 'span_due', turnId: 'due-turn', kind: 'tool', status: 'error', errorCode: 'browser_context_stale', startedAt: stamp, attributes: { toolName: 'browser_fill', body: 'private page', token: 'private-token' } }))
      const summary = await readWindowsTaskFailureStore(root, 'due')
      assert.equal(summary.readOnly, true)
      assert.deepEqual(summary.counts, { operations: 4, events: 1, spans: 1 })
      assert.deepEqual(summary.operations.map(item => item.kind), ['tool', 'browser_action_dispatch', 'browser_derived_action_authorization', 'browser_schedule_action_outcome'])
      assert.equal(summary.operations[0].request.dispatchTracking, 'host-v1')
      assert.equal(summary.operations[0].result.outputCode, 'operation_not_dispatched')
      assert.deepEqual(summary.events[0].payload.operationIds, ['operation_2'])
      assert.equal(summary.spans[0].errorCode, 'browser_context_stale')
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM operation_receipts').get().count, 5, 'Failure diagnostics must not finish, recover or redispatch operations')
      assert.doesNotMatch(JSON.stringify(summary), /private|Authorization|headers|executionGrant|unrelated-operation/)
    } finally { database.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('failure logs export only timestamps, stream, exception names and codes, never raw messages, headers, tokens or body', () => {
  const logs = summarizeWindowsFailureLogs('[2026-11-13T06:00:00.000Z] [STDERR] TypeError: browser_context_stale at https://private.example/body\nAuthorization: Bearer browser_private_token\nheaders={"cookie":"private-cookie"}; browser_cookie_secret\nrequest body=private page browser_private_body\nprivate prompt with no code')
  assert.equal(logs.lineCount, 5)
  assert.equal(logs.entries.length, 1)
  assert.equal(logs.entries[0].exception, 'TypeError')
  assert.deepEqual(logs.entries[0].codes, ['browser_context_stale'])
  assert.doesNotMatch(JSON.stringify(logs), /private|Authorization|Bearer|headers|cookie|https|body/)
})

test('manual preview failure permits later diagnostics while keeping the complete acceptance failed', async () => {
  const evidence = report()
  const observations = []
  const passed = await inspectWindowsManualPreview(evidence, async () => {
    observations.push('manual preview')
    throw new Error('The actual task route has no preview body')
  }).then(value => { observations.push('later due diagnostic'); return value })
  assert.equal(passed, false)
  assert.deepEqual(observations, ['manual preview', 'later due diagnostic'])
  assert.equal(evidence.taskExecution.preview.manualEntryVerified, false)
  assert.match(evidence.errors[0], /actual task route has no preview body/)
  assert.throws(() => validateWindowsTaskEvidence(evidence.taskExecution))
  assert.throws(() => validateWindowsUiReport(evidence, identity))
  const successful = report()
  delete successful.taskExecution.preview.manualEntryVerified
  assert.equal(await inspectWindowsManualPreview(successful, async () => undefined), true)
  assert.equal(successful.taskExecution.preview.manualEntryVerified, true)
})


test('document-navigation acceptance joins real-shaped immutable Host, native GET, scope and fresh page proof without claiming a click ACK', () => {
  // Synthetic validator input only. Runtime and exact installed acceptance must
  // obtain these records from the actual Provider; this never injects receipts.
  const hash = text => createHash('sha256').update(text).digest('hex')
  const stamp = '2026-11-15T00:00:00.000Z', finished = '2026-11-15T00:00:01.000Z'
  const fixtureUrl = 'http://127.0.0.1:1234/fixture', detailUrl = new URL('/fixture/detail', fixtureUrl).href
  const task = { id: 'source-task', goal: '查询工程监测公开公告', acceptance: { schedule: { kind: 'daily', times: ['09:00', '17:00'], timezone: 'Asia/Shanghai', leadMinutes: 30 } } }
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
  const fingerprint = value => hash(JSON.stringify(canonical(value)))
  const authorization = { receiptId: 'binding', duration: 'schedule', purposeHash: fingerprint({ purpose: task.goal }), requirementHash: fingerprint({ requirement: task.acceptance.schedule }) }
  const scope = { browserInstanceId: 'browser', revision: 2, origins: [new URL(fixtureUrl).origin], interaction: 'interact', verificationPolicy: 'public_query_target', publicQueryAuthorization: authorization }
  const grant = { id: 'grant', taskId: task.id, threadId: 'execution', turnId: 'turn', issuedAt: stamp, browserScope: scope }
  const args = { sessionId: 'session', target: '@e14', contextId: 'search-context' }, linkHtml = '<a href="/fixture/detail">合成公告正文</a>'
  const docProof = { hrefHash: hash('/fixture/detail'), destinationHash: hash(detailUrl), frameHash: hash('real-native-frame'), canonicalTarget: '@e999' }
  const target = { action: 'click', pageUrl: fixtureUrl, elementHash: hash(linkHtml), browserInstanceId: 'browser', browserRevision: 2,
    verificationPolicy: 'public_query_target', sessionId: 'session', turnId: 'turn' }
  const binding = { id: 'binding', ownerId: task.id, kind: 'browser_binding', status: 'succeeded', request: { confirmed: true, publicQueryAuthorization: 'schedule' },
    result: { purpose: task.goal, browserRevision: 2, ...scope } }
  const scoped = { id: 'scope-action', ownerId: task.id, kind: 'browser_scope_action_authorization', status: 'succeeded', createdAt: stamp,
    request: { ...target, taskId: task.id, sourceTaskId: task.id, grantId: grant.id, purposeHash: authorization.purposeHash,
      requirementHash: authorization.requirementHash, scopeAuthorizationReceiptId: binding.id, contextHash: hash(args.contextId),
      rule: 'result_link', origin: new URL(fixtureUrl).origin, documentLinkProof: docProof },
    result: { id: 'scoped-action-id', authorizationSource: 'task_scope', scopeAuthorizationReceiptId: binding.id, sourceTaskId: task.id,
      accountState: 'unknown', access: 'public_query', verificationPolicy: 'public_query_target', expiresAt: '2026-11-15T00:15:00.000Z' } }
  const derived = { id: 'derived', ownerId: task.id, kind: 'browser_derived_action_authorization', status: 'succeeded', createdAt: stamp,
    request: { ...scoped.request, actionId: scoped.result.id, scopeActionReceiptId: scoped.id }, result: { ...scoped.result, scopeActionReceiptId: scoped.id } }
  const dispatch = { id: 'navigation', ownerId: task.id, kind: 'browser_action_dispatch', status: 'succeeded', createdAt: stamp, updatedAt: finished,
    request: { ...target, toolName: 'browser_click', argumentsHash: fingerprint(args), targetRef: args.target, contextHash: hash(args.contextId),
      scopeActionReceiptId: scoped.id, scopeAuthorizationReceiptId: binding.id, authorizationSource: 'task_scope', nativeAction: 'navigate', navigationDestinationHash: docProof.destinationHash, documentLinkProof: docProof },
    result: { nativeAction: 'navigate', requestedAction: 'click', actionAcknowledged: false, clickDispatched: false, navigationAcknowledged: true,
      readbackPending: false, sourceUrl: detailUrl, resultHash: hash('actual new page readback'), navigationContextHash: hash('new-document-context'), navigationDestinationHash: docProof.destinationHash } }
  const output = { status: 'succeeded', action: 'navigate', nativeAction: 'navigate', requestedAction: 'click', clickDispatched: false,
    sourceUrl: detailUrl, resultHash: dispatch.result.resultHash, observation: { context_id: 'new-document-context' }, dispatchReceiptId: dispatch.id, documentLinkProof: docProof }
  const result = { kind: 'tool_result', toolName: 'browser_click', callId: 'smoke-open-detail', threadId: 'execution', turnId: 'turn', isError: false, output }
  const host = { id: 'host', ownerId: task.id, kind: 'tool', status: 'succeeded',
    request: { callId: result.callId, toolName: 'browser_click', providerId: 'browser-skill', turnId: 'turn', argumentsHash: fingerprint(args), executionGrant: grant },
    result: { approved: true, item: result } }
  const thread = { id: 'execution', turns: [{ id: 'turn', executionGrant: grant, items: [
    { kind: 'tool_call', toolName: 'browser_click', callId: result.callId, arguments: args },
    { kind: 'tool_result', toolName: 'browser_get_html', callId: 'smoke-read-link-target', isError: false, output: fixtureRead(fixtureUrl, linkHtml) }, result
  ] }] }
  const fixture = { fixtureUrl, detailUrl, observed: { requests: [{ documentNavigation: { sessionId: 'session', targetRef: args.target, contextHash: hash(args.contextId) } }] } }
  const input = { task, thread, receipts: [binding, scoped, derived, dispatch, host], fixture }
  const finalize = value => { for (const receipt of value.receipts) receipt.fingerprint = fingerprint(receipt.request); return value }
  const inspect = value => inspectWindowsDocumentNavigation(value.task, value.thread, value.receipts, value.fixture)
  const valid = finalize(structuredClone(input))
  assert.deepEqual({ ...inspect(valid), receiptId: undefined, hostReceiptId: undefined, grantId: undefined,
    scopeActionReceiptId: undefined, scopeAuthorizationReceiptId: undefined, positiveRule: undefined }, {
    verified: true, intent: 'click', nativeAction: 'navigate', clickDispatched: false, actionAcknowledged: false, navigationAcknowledged: true,
    readbackPending: false, freshContextVerified: true, primaryDocumentReadbackVerified: true, receiptId: undefined, hostReceiptId: undefined, grantId: undefined,
    authorizationSource: 'task_scope', scopeActionReceiptId: undefined, scopeAuthorizationReceiptId: undefined, taskConsentVerified: true, scopeActionVerified: true, positiveRule: undefined })
  for (const mutate of [value => { value.receipts[3].result.actionAcknowledged = true },
    value => { value.receipts[3].result.clickDispatched = true }, value => { value.receipts[3].result.navigationAcknowledged = false },
    value => { value.receipts[3].request.documentLinkProof.frameHash = 'not-a-native-hash' },
    value => { value.receipts[3].request.documentLinkProof.canonicalTarget = 'not-a-native-ref' },
    value => { value.receipts[3].result.navigationContextHash = value.receipts[3].request.contextHash },
    value => { value.receipts[4].request.executionGrant.id = 'old-grant' }, value => { value.receipts[4].request.argumentsHash = '0'.repeat(64) },
    value => { value.receipts[1].request.rule = 'model-says-safe' }, value => { value.thread.turns[0].items[1].output.html = '<a href="/elsewhere">Other</a>' },
    value => { value.receipts.splice(4, 1) }]) {
    const invalid = structuredClone(input); mutate(invalid); finalize(invalid); assert.throws(() => inspect(invalid))
  }
})

test('startup diagnostic dispatch never enters the application/model/task smoke path', async () => {
  const { dispatchWindowsSmokeEntry } = await import('./run-windows-ui-smoke.mjs')
  const calls = []
  await dispatchWindowsSmokeEntry(['installed.exe', '0.5.7', 'a'.repeat(40), 'evidence', '--browser-startup-diagnostic'], {}, {
    runUi: () => { throw new Error('The application/model/task path must not run') },
    runDiagnostic: async value => { calls.push(value); return { scope: 'startup-diagnostic' } }
  })
  assert.equal(calls.length, 1)
  await assert.rejects(dispatchWindowsSmokeEntry(['installed.exe', '0.5.7', 'a'.repeat(40), 'evidence', '--browser-smoke'], { RAILWISE_WINDOWS_BROWSER_STARTUP_DIAGNOSTIC: 'true' }, { runUi: () => assert.fail(), runDiagnostic: () => assert.fail() }), /exclusive/)
  for (const environment of [{ RAILWISE_WINDOWS_TASK_SMOKE: 'true' }, { RAILWISE_WINDOWS_BROWSER_SMOKE: 'true' }]) {
    await assert.rejects(dispatchWindowsSmokeEntry(['installed.exe', '0.5.7', 'a'.repeat(40), 'evidence', '--browser-startup-diagnostic'], environment, {
      runUi: () => assert.fail('UI must not start'), runDiagnostic: () => assert.fail('mixed-mode diagnostic must not start')
    }), /exclusive/)
  }
})

test('startup A/B preserve ignored stdio and conditional C never follows a live unknown child', async () => {
  const { runWindowsDaemonDiagnosticCases } = await import('./run-windows-ui-smoke.mjs')
  const calls = [], consoles = []
  const runCase = async plan => { calls.push(plan); return { label: plan.label, pid: 77, naturalExit: true, endpointReleased: true, vendor: { informative: plan.label !== 'A' } } }
  const result = await runWindowsDaemonDiagnosticCases({ runCase, readConsole: async plan => { consoles.push(plan.label); return { collected: true } } })
  assert.deepEqual(calls.map(x => x.label), ['A', 'B', 'C'])
  assert.deepEqual(calls[0].options, { detached: true, windowsHide: true, shell: false, stdio: 'ignore' })
  assert.deepEqual(calls[1].options, { detached: false, windowsHide: false, shell: false, stdio: 'ignore' })
  assert.deepEqual(calls[2].options, { detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.deepEqual(consoles, ['A', 'B'])
  assert.equal(result.status, 'completed')
  const onlyAB = await runWindowsDaemonDiagnosticCases({ runCase: async plan => ({ label: plan.label, pid: 7, naturalExit: true, endpointReleased: true, vendor: { informative: true } }), readConsole: async () => ({ collected: true }) })
  assert.deepEqual(onlyAB.cases.map(value => value.label), ['A', 'B'])
  calls.length = 0; consoles.length = 0
  const stopped = await runWindowsDaemonDiagnosticCases({ runCase: async plan => { calls.push(plan); return { label: plan.label, endpointReleased: false, naturalExit: false, vendor: { informative: false } } },
    readConsole: async plan => { consoles.push(plan.label) } })
  assert.deepEqual(calls.map(x => x.label), ['A'])
  assert.deepEqual(consoles, [])
  assert.equal(stopped.status, 'incomplete')
})

test('startup diagnostic distinguishes vendor signal exit, startup errors and a still-live unverified identity', async () => {
  const { classifyWindowsDaemonStartup } = await import('./run-windows-ui-smoke.mjs')
  assert.equal(classifyWindowsDaemonStartup({ naturalExit: true, vendor: { signal: true } }), 'vendor_signal_exit')
  assert.equal(classifyWindowsDaemonStartup({ naturalExit: true, vendor: { error: true } }), 'vendor_startup_error')
  assert.equal(classifyWindowsDaemonStartup({ naturalExit: false, identity: { verified: false } }), 'identity_probe_unverified')
  assert.equal(classifyWindowsDaemonStartup({ naturalExit: true, identity: { verified: false }, vendor: {} }), 'early_exit_identity_unavailable')
})

async function startupExtraResourceFixture(t) {
  const { windowsStartupDiagnosticPackage } = await import('./run-windows-ui-smoke.mjs')
  const { readFile } = await import('node:fs/promises')
  const asar = createRequire(import.meta.url)('@electron/asar')
  const root = await mkdtemp(join(tmpdir(), 'startup-extra-resource-')); t.after(() => rm(root, { recursive: true, force: true }))
  const input = join(root, 'input'), resources = join(root, 'resources'); await mkdir(input); await mkdir(resources)
  const metadata = { name: 'workwise', productName: 'RailWise AI', version: windowsStartupDiagnosticPackage.version, buildProvenance: { sourceHead: windowsStartupDiagnosticPackage.sourceHead } }
  await writeFile(join(input, 'package.json'), JSON.stringify(metadata))
  const archive = join(resources, 'app.asar'); await asar.createPackage(input, archive)
  // electron-builder copies kun/dist as an extraResource; this file is absent
  // from the ASAR header even though its installed directory says .unpacked.
  const modulePath = join(resources, 'app.asar.unpacked', 'kun', 'dist', 'services', 'process-identity.js')
  await mkdir(join(modulePath, '..'), { recursive: true })
  const bytes = 'export async function processIdentityAsync(pid) { return {pid, fingerprint:"installed-compiled-module"} }\n'
  await writeFile(modulePath, bytes)
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
  const modulePin = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes), source: 'controlled-compiled-fixture' }
  return { root, input, archive, modulePath, metadata, bytes, digest, modulePin, asar }
}

test('diagnostic imports the real installed extraResource without an ASAR module entry', async t => {
  const { loadWindowsStartupIdentity, windowsStartupIdentityModule } = await import('./run-windows-ui-smoke.mjs')
  const fixture = await startupExtraResourceFixture(t)
  assert.throws(() => fixture.asar.statFile(fixture.archive, join('kun', 'dist', 'services', 'process-identity.js')), /not found/)
  const loaded = await loadWindowsStartupIdentity({ asarPath: fixture.archive, expectedAsarSha256: fixture.digest, directory: join(fixture.root, 'imported'), modulePin: fixture.modulePin })
  assert.deepEqual(await loaded.identity(7), { pid: 7, fingerprint: 'installed-compiled-module' })
  assert.equal(loaded.proof.source, 'exact-installed-extra-resource')
  assert.equal(loaded.proof.entry, 'app.asar.unpacked/kun/dist/services/process-identity.js')
  assert.equal(loaded.proof.sha256, fixture.modulePin.sha256)
  assert.equal(loaded.proof.importedSha256, fixture.modulePin.sha256)
  assert.equal(loaded.proof.pinSource, fixture.modulePin.source)
  assert.equal(loaded.proof.entryIntegritySha256, undefined, 'An extraResource must not claim ASAR header integrity')
  assert.equal(loaded.proof.packageSourceHead, fixture.metadata.buildProvenance.sourceHead)
  assert.deepEqual(windowsStartupIdentityModule, { sha256: '112ccee06a9e75ef68a3912a4b316606364dd36dd77404d3958a6d092be8f3ad', bytes: 3430, source: 'same-source-signed-Mac245' })
  await loaded.verifyUnchanged()
  await writeFile(fixture.modulePath, fixture.bytes.replace('installed-compiled-module', 'tampered-compiled-module!'))
  await assert.rejects(loaded.verifyUnchanged(), /module pin/)
})

test('diagnostic refuses wrong ASAR, source, extraResource pin and path escape before import', async t => {
  const { loadWindowsStartupIdentity } = await import('./run-windows-ui-smoke.mjs')
  const { readFile, symlink } = await import('node:fs/promises')
  const fixture = await startupExtraResourceFixture(t)
  const options = { asarPath: fixture.archive, expectedAsarSha256: fixture.digest, directory: join(fixture.root, 'rejected-import'), modulePin: fixture.modulePin }
  await assert.rejects(loadWindowsStartupIdentity({ ...options, expectedAsarSha256: '0'.repeat(64) }))
  await assert.rejects(loadWindowsStartupIdentity({ ...options, modulePin: undefined }), /module pin/, 'The diagnostic defaults to the immutable signed-package pin')
  await assert.rejects(loadWindowsStartupIdentity({ ...options, modulePin: { ...fixture.modulePin, sha256: '0'.repeat(64) } }), /module pin/)
  const wrongSource = join(fixture.root, 'resources', 'wrong-source.asar')
  await writeFile(join(fixture.input, 'package.json'), JSON.stringify({ ...fixture.metadata, buildProvenance: { sourceHead: 'b'.repeat(40) } }))
  await fixture.asar.createPackage(fixture.input, wrongSource)
  await assert.rejects(loadWindowsStartupIdentity({ ...options, asarPath: wrongSource, expectedAsarSha256: createHash('sha256').update(await readFile(wrongSource)).digest('hex') }))
  const services = join(fixture.modulePath, '..'), outside = join(fixture.root, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'process-identity.js'), fixture.bytes)
  await rm(services, { recursive: true }); await symlink(outside, services, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(loadWindowsStartupIdentity(options), /symbolic link|contained/)
})

async function startupCaseFixture({ identityResult, closeDuringIdentity = false, changedExecutable = false, exhausted = false, quickUnavailable = false } = {}) {
  const { EventEmitter } = await import('node:events')
  const { collectWindowsDaemonStartupCase } = await import('./run-windows-ui-smoke.mjs')
  const { browserStartupDependency } = await import('./prepare-browser-skill-smoke.mjs')
  const child = new EventEmitter(); child.pid = 77; child.exitCode = null; child.signalCode = null; child.stdout = child.stderr = null
  const calls = []; let clock = 0, probes = 0, restored = false
  child.unref = () => calls.push('unref')
  child.kill = signal => { calls.push(['kill', signal]); child.exitCode = 0; child.signalCode = signal; child.emit('close', 0, signal) }
  const identity = async (pid, options) => {
    calls.push(['identity', pid, options.timeoutMs]); probes++
    if (exhausted) { clock += 10000; return null }
    if (quickUnavailable && probes === 1) { clock += 500; return null }
    if (closeDuringIdentity) { child.exitCode = 0; child.emit('close', 0, null) }
    return identityResult === undefined ? { pid, fingerprint: 'win32:123456' } : identityResult
  }
  const result = await collectWindowsDaemonStartupCase({ plan: { label: 'A', options: { detached: true, windowsHide: true, shell: false, stdio: 'ignore' } },
    executable: 'fixed-bsk.exe', home: 'fresh-home', environment: {}, identity, start: (...args) => { calls.push(['spawn', ...args]); return child },
    now: () => clock, wait: async ms => { clock += ms }, observeMs: 1000,
    vendor: async () => ({ informative: false, signal: child.signalCode === 'SIGTERM', logs: [] }),
    fileHash: async () => changedExecutable ? '0'.repeat(64) : browserStartupDependency.executableSha256,
    endpointReleased: async () => true, observeProbe: () => () => { restored = true } })
  return { result, calls, probes, restored }
}

test('diagnostic retains the ten-second budget and never kills a live unverified or changed child', async () => {
  const exhausted = await startupCaseFixture({ exhausted: true })
  assert.equal(exhausted.probes, 1)
  assert.equal(exhausted.result.endpointReleased, false)
  assert.equal(exhausted.calls.some(call => Array.isArray(call) && call[0] === 'kill'), false)
  const changed = await startupCaseFixture({ changedExecutable: true })
  assert.equal(changed.result.cleanup.verifiedBirth, false)
  assert.equal(changed.result.endpointReleased, false)
  assert.equal(changed.calls.some(call => Array.isArray(call) && call[0] === 'kill'), false)
  assert.equal(changed.restored, true)
})

test('diagnostic records child close before the identity callback and separates cleanup signals from natural exit', async () => {
  const exited = await startupCaseFixture({ closeDuringIdentity: true })
  assert.equal(exited.result.identity.verified, false)
  assert.equal(exited.result.identity.attempts[0].childStillLive, false)
  assert.equal(exited.result.naturalExit, true)
  assert.equal(exited.result.classification, 'child_exited_before_identity_acceptance')
  assert.equal(exited.result.events[0].event, 'close')
  assert.equal(exited.calls.some(call => Array.isArray(call) && call[0] === 'kill'), false)
  const owned = await startupCaseFixture()
  assert.equal(owned.result.identity.verified, true)
  assert.equal(owned.result.naturalExit, false)
  assert.equal(owned.result.vendor.signal, false)
  assert.equal(owned.result.vendorAfterCleanup.signal, true)
  assert.equal(owned.result.cleanup.verifiedBirth, true)
  assert.equal(owned.result.endpointReleased, true)
})

test('diagnostic logs redact credentials, URLs and opaque values before persistence', async () => {
  const { sanitizeWindowsStartupText } = await import('./run-windows-ui-smoke.mjs')
  const text = sanitizeWindowsStartupText('daemon ready\nsecret=synthetic-test-secret\nfailed https://example.invalid/?signature=synthetic\nopaque ' + 'z'.repeat(64))
  assert.match(text, /daemon ready/)
  assert.doesNotMatch(text, /synthetic-test-secret|signature=synthetic|https:|zzzzzzzz/)
})

test('diagnostic quick identity retry receives only the remaining startup budget', async () => {
  const value = await startupCaseFixture({ quickUnavailable: true })
  const attempts = value.calls.filter(call => Array.isArray(call) && call[0] === 'identity')
  assert.deepEqual(attempts.slice(0, 2), [['identity', 77, 10000], ['identity', 77, 9000]])
  assert.equal(value.result.identity.verified, true)
  assert.equal(value.result.cleanup.verifiedBirth, true)
})

// Offline renderer protocol fixture: the production layout hook, not a mocked
// activeOverlay response, reacts to a deferred preview after the real route click.
async function manualPreviewRouteFixture(run, { latePreviewOnRoute = false, selectedTaskKeyUnchanged = false } = {}) {
  const { Window } = await import('happy-dom')
  const window = new Window({ url: 'http://localhost/' }), temporary = await mkdtemp(join(tmpdir(), 'railwise-manual-route-'))
  const prior = new Map()
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT', 'MessageChannel']) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'MessageChannel' ? class { constructor() { this.port1 = {}; this.port2 = { postMessage: () => setImmediate(() => this.port1.onmessage?.()) } } } : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'getComputedStyle' ? window.getComputedStyle.bind(window) : key === 'window' ? window : window[key] })
  }
  let root, fixture
  try {
    Object.defineProperty(window, 'innerWidth', { value: 1024 }); Object.defineProperty(window, 'innerHeight', { value: 728 })
    const output = join(temporary, 'layout.cjs')
    await build({ stdin: { contents: `
      import {act,createElement as h,useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {useWorkbenchLayout} from './src/renderer/src/components/workbench-layout.ts';
      export {act,createRoot,h};
      export const events=[];
      export function Harness(){
        const [route,setRoute]=useState('chat'),[ready,setReady]=useState(0);
        const layout=useWorkbenchLayout({route,workspaceRoot:'/synthetic-ui-only',activeThreadId:route==='tasks'?'task-workspace-preview:synthetic':'chat',latestAutoOpenDevPreviewKey:ready?'synthetic-current-hash-'+ready:null,latestAutoOpenDevPreviewUrl:ready?'http://localhost/report':null,latestDevPreviewUrl:ready?'http://localhost/report':null,writeAssistantOpen:false});
        const artifact=()=>{events.push('artifact-click');layout.openDevPreview()};
        const select=()=>{events.push('select-task');if(${JSON.stringify(selectedTaskKeyUnchanged)})return;Promise.resolve().then(()=>{events.push('late-preview-projection');setReady(value=>value+1)})};
        return h('div',{className:'ds-workbench-shell',ref:layout.shellRef,'data-active-overlay':layout.activeOverlay??''},
          h('nav',{'aria-label':'工作区工具'},h('button',{id:'task-route',onClick:()=>{events.push('route-tasks');setRoute('tasks');if(${JSON.stringify(latePreviewOnRoute)})Promise.resolve().then(()=>{events.push('route-preview-projection');setReady(value=>value+1)})}},'任务')),
          layout.activeOverlay?h('button',{'aria-label':'返回当前任务',id:'backdrop',onClick:layout.closeDevPreview}):null,
          h('main',{inert:layout.activeOverlay?true:undefined},route==='tasks'?h('section',{className:'ds-task-sidebar','aria-label':'任务列表'},h('div',{'aria-label':'任务筛选'},h('button',{id:'completed'},'已完成 1')),h('button',{id:'task-row',title:'合成 UI 任务',onClick:select},'合成 UI 任务')):null,
            route==='tasks'?h('article',{'aria-label':'任务详情'},h('button',{id:'artifact',onClick:artifact},'每日网页报告.html')):null),
          layout.rightPanelVisible?h('aside',{id:'workbench-inspector'},h('button',{'aria-label':'收起右侧栏',id:'collapse',onClick:()=>{events.push('collapse-panel');layout.closeDevPreview()}}),h('webview'),ready?h('div',{id:'workspace-preview-ready'}):null):null);
      }`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx' }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' } })
    fixture = createRequire(import.meta.url)(output)
    const box = node => {
      const x = node.id === 'artifact' ? 297 : node.id === 'collapse' ? 940 : node.id === 'backdrop' ? 0 : node.id === 'task-route' ? 20 : node.id === 'completed' ? 20 : 20
      const y = node.id === 'artifact' ? 500 : node.id === 'collapse' ? 20 : node.id === 'backdrop' ? 0 : node.id === 'task-route' ? 20 : node.id === 'completed' ? 100 : 160
      const width = node.id === 'artifact' ? 674 : node.id === 'backdrop' ? 1024 : 60, height = node.id === 'backdrop' ? 728 : 36
      return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height }
    }
    window.HTMLElement.prototype.getBoundingClientRect = function () { return box(this) }
    window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [box(this)] : [] }
    window.HTMLElement.prototype.scrollIntoView = function () {}
    window.requestAnimationFrame = callback => { queueMicrotask(() => callback(Date.now())); return 1 }
    window.document.elementFromPoint = (x, y) => {
      const candidates = Array.from(window.document.querySelectorAll('button')).filter(node => { const b = box(node); return x >= b.x && x < b.right && y >= b.y && y < b.bottom })
      if (window.document.querySelector('.ds-workbench-shell')?.dataset.activeOverlay === 'inspector') return candidates.find(node => node.id === 'collapse') ?? window.document.querySelector('webview')
      return candidates.find(node => node.id !== 'backdrop') ?? window.document.body
    }
    root = fixture.createRoot(window.document.body.appendChild(window.document.createElement('div')))
    await fixture.act(async () => root.render(fixture.h(fixture.Harness)))
    const input = []
    const cdp = {
      async evaluate(expression) { let value; await fixture.act(async () => { value = await window.eval(expression) }); return value },
      async wait(expression, label) { for (let attempt = 0; attempt < 10; attempt++) { const value = await this.evaluate(expression); if (value) return value } throw new Error('Fixture UI did not show ' + label) },
      async send(method, params) {
        assert.equal(method, 'Input.dispatchMouseEvent'); input.push(params)
        if (params.type === 'mouseReleased') await fixture.act(async () => { const hit = window.document.elementFromPoint(params.x, params.y); assert.equal(Boolean(hit.closest('main[inert]')), false, 'Real input cannot bypass the modal main surface'); hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: params.x, clientY: params.y })) })
      },
      async click(selector, label) { const point = await this.wait(windowsUiClickExpression(selector, label), label ?? selector); for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point }) }
    }
    await run({ window, cdp, events: fixture.events, input })
  } finally {
    if (root) await fixture.act(async () => root.unmount())
    for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
    await window.happyDOM.close(); await rm(temporary, { recursive: true, force: true })
  }
}

test('manual artifact entry waits for the actual route late-preview overlay and dismisses its panel control before pointer input', async () => {
  await manualPreviewRouteFixture(async ({ cdp, events, input }) => {
    const audit = {}
    await clickWindowsManualTaskArtifact(cdp, { taskGoal: '合成 UI 任务', previewExpression: `document.querySelector('#workspace-preview-ready') && {partition:'railwise-artifact-synthetic'}`, audit })
    assert.ok(events.indexOf('route-tasks') < events.indexOf('late-preview-projection'))
    assert.ok(events.indexOf('late-preview-projection') < events.indexOf('collapse-panel'))
    assert.equal(events.filter(event => event === 'artifact-click').length, 1)
    assert.equal(events.filter(event => event === 'collapse-panel').length, 1)
    assert.equal(audit.afterProjection.activeOverlay, 'inspector')
    assert.equal(audit.afterProjection.mainInert, true)
    assert.equal(audit.afterProjection.hit.target, false)
    assert.ok(audit.target.stableFrames >= 2)
    assert.equal(audit.target.mainInert, false)
    assert.equal(input.at(-1).type, 'mouseReleased')
  })
})

test('manual artifact permanent coverage stays failed with first geometry and no input behind the blocker', async () => {
  await manualPreviewRouteFixture(async ({ window, cdp, events }) => {
    const originalHit = window.document.elementFromPoint.bind(window.document)
    window.document.elementFromPoint = (x, y) => { const hit = originalHit(x, y); return hit?.id === 'artifact' ? window.document.body : hit }
    const audit = {}, evidence = report()
    assert.equal(await inspectWindowsManualPreview(evidence, () => clickWindowsManualTaskArtifact(cdp, { taskGoal: '合成 UI 任务', previewExpression: `Boolean(document.querySelector('#workspace-preview-ready'))`, audit })), false)
    assert.equal(audit.target.ready, false)
    assert.equal(audit.target.observedFrames, 60)
    assert.equal(audit.target.initial.hit.tag, 'BODY')
    assert.equal(audit.target.initial.hit.target, false)
    assert.equal(audit.target.initial.mainInert, false)
    assert.ok(audit.target.initial.rect.width > 0)
    assert.equal(events.includes('artifact-click'), false)
    assert.match(evidence.errors[0], /UI target is covered or unstable/)
    assert.throws(() => validateWindowsTaskEvidence(evidence.taskExecution))
    assert.throws(() => validateWindowsUiReport(evidence, identity))
  })
})

test('manual artifact pointer probe waits through a covered frame, moving geometry and DOM replacement', async () => {
  const { Window } = await import('happy-dom'), window = new Window()
  try {
    window.document.body.innerHTML = '<div class="ds-workbench-shell"><main><article aria-label="任务详情"><button>每日网页报告.html</button></article></main></div>'
    let frame = 0, scrollOptions
    const configure = node => {
      node.scrollIntoView = options => { scrollOptions = options }
      node.getClientRects = () => [node.getBoundingClientRect()]
      node.getBoundingClientRect = () => ({ x: 10, y: frame < 3 ? frame * 10 : 40, width: 100, height: 30 })
    }
    configure(window.document.querySelector('button'))
    window.requestAnimationFrame = callback => { frame++; if (frame === 3) { const node = window.document.createElement('button'); node.textContent = '每日网页报告.html'; configure(node); window.document.querySelector('button').replaceWith(node) } queueMicrotask(() => callback(frame)); return frame }
    window.document.elementFromPoint = () => frame === 2 ? window.document.body : window.document.querySelector('button')
    const result = JSON.parse(JSON.stringify(await window.eval(windowsManualArtifactTargetExpression({ stable: true }))))
    assert.equal(result.ready, true)
    assert.equal(result.observedFrames, 5)
    assert.equal(result.stableFrames, 2)
    assert.equal(result.rect.y, 40)
    assert.equal(scrollOptions.behavior, 'instant')
    assert.doesNotMatch(windowsManualArtifactTargetExpression({ stable: true }), /\.click\(|dispatchEvent|\.remove\(|removeAttribute|setAttribute/)
  } finally { await window.happyDOM.close() }
})

test('manual task navigation dismisses a late route overlay as well as the selected-task preview without bypassing either', async () => {
  await manualPreviewRouteFixture(async ({ cdp, events }) => {
    const audit = {}
    await clickWindowsManualTaskArtifact(cdp, { taskGoal: '合成 UI 任务', previewExpression: `Boolean(document.querySelector('#workspace-preview-ready'))`, audit })
    assert.ok(events.indexOf('route-tasks') < events.indexOf('route-preview-projection'))
    assert.ok(events.indexOf('route-preview-projection') < events.indexOf('select-task'))
    assert.equal(events.filter(event => event === 'collapse-panel').length, 2)
    assert.equal(events.filter(event => event === 'artifact-click').length, 1)
    assert.equal(audit.navigation[0].initial.activeOverlay, 'inspector')
    assert.equal(audit.navigation[0].initial.mainInert, true)
    assert.equal(audit.navigation[0].afterDismiss.ready, true)
    assert.equal(audit.target.ready, true)
  }, { latePreviewOnRoute: true })
})


test('manual artifact entry respects an already dismissed workspace preview when selecting the same task and hash again', async () => {
  await manualPreviewRouteFixture(async ({ cdp, events }) => {
    const audit = {}
    await clickWindowsManualTaskArtifact(cdp, { taskGoal: '合成 UI 任务', previewExpression: `Boolean(document.querySelector('#workspace-preview-ready'))`, audit })
    assert.equal(events.filter(event => event === 'route-preview-projection').length, 1)
    assert.equal(events.filter(event => event === 'late-preview-projection').length, 0, 'Selecting the current task must not invent a new IPC projection or artifact hash')
    assert.equal(events.filter(event => event === 'collapse-panel').length, 1)
    assert.equal(events.filter(event => event === 'artifact-click').length, 1)
    assert.ok(events.indexOf('collapse-panel') < events.indexOf('select-task'))
    assert.ok(events.indexOf('select-task') < events.indexOf('artifact-click'))
    assert.equal(audit.beforeManual.activeOverlay, null)
    assert.equal(audit.beforeManual.mainInert, false)
    assert.equal(audit.targetBeforeDismiss, undefined)
    assert.equal(audit.target.ready, true)
    assert.equal(audit.target.mainInert, false)
    assert.equal(audit.target.stableFrames, 2)
  }, { latePreviewOnRoute: true, selectedTaskKeyUnchanged: true })
})


// Execute the worker's real capture statement and existing bounded poll, rather
// than a duplicate mock of its readiness algorithm. The file-store is real.
function permissionCaptureFromWorker(runtime, taskId, turnId, timeout = 1000) {
  const code = installedPermissionWorker.toString()
  const start = code.indexOf('    const turn =', code.indexOf("'actual exported file'"))
  const end = code.indexOf('\n    const grant =', start)
  assert.ok(start > 0 && end > start)
  const pollStart = code.indexOf('  const poll = async')
  const pollEnd = code.indexOf('  const exists =', pollStart)
  const originalPoll = new Function(code.slice(pollStart, pollEnd) + '; return poll')()
  const capture = new Function('runtime', 'taskId', 'getTask', 'resume', 'poll', 'readWindowsPermissionExecutionTurn',
    `return (async () => { ${code.slice(start, end)}; return turn })()`)
  return capture(runtime, taskId, () => runtime.taskRepository.get(taskId), { turn: { turnId } },
    (read, label) => originalPoll(read, label, timeout), permissionSmokeModule.readWindowsPermissionExecutionTurn)
}

let permissionFileStoreModule
async function permissionFileStore(root) {
  permissionFileStoreModule ??= build({ entryPoints: [fileURLToPath(new URL('../kun/src/adapters/file/file-thread-store.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false }).then(result => import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')))
  const { FileThreadStore } = await permissionFileStoreModule
  return new FileThreadStore({ dataDir: root })
}

test('permission execution capture waits through the real file-store publication gap for the exact Turn and Grant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-permission-thread-publication-'))
  try {
    const store = await permissionFileStore(root), taskId = 'permission-task', threadId = 'permission-thread', turnId = 'permission-turn'
    const grant = { id: 'owned-grant', taskId, threadId, turnId }
    const thread = { id: threadId, updatedAt: new Date().toISOString(), turns: [{ id: turnId, status: 'running', executionGrant: grant }] }
    await store.upsert(thread)
    const file = join(root, 'threads', threadId, 'thread.json'), backup = file + '.workwise-backup'
    // This is the Windows replace() target->backup->temp publication boundary.
    // A barrier restores it only after the actual FileThreadStore.get saw null.
    await rename(file, backup)
    let observedMissing
    const missing = new Promise(resolve => { observedMissing = resolve })
    const runtime = { taskRepository: { get: () => ({ id: taskId, threadId, activeTurnId: turnId }) },
      threadService: { get: async id => { const value = await store.get(id); if (value === null) observedMissing(); return value } } }
    const captured = permissionCaptureFromWorker(runtime, taskId, turnId).then(value => ({ value }), error => ({ error }))
    await missing
    await rename(backup, file)
    const result = await captured
    assert.equal(result.error, undefined, result.error?.stack)
    assert.equal(result.value.id, turnId)
    assert.equal(result.value.status, 'running', 'The fixture deliberately holds the current Turn for expiry/revocation checks')
    assert.deepEqual(result.value.executionGrant, grant)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('permission execution capture permanently missing Thread remains a bounded failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-permission-thread-missing-'))
  try {
    const store = await permissionFileStore(root), taskId = 'permission-task', threadId = 'permission-thread', turnId = 'permission-turn'
    const runtime = { taskRepository: { get: () => ({ id: taskId, threadId, activeTurnId: turnId }) }, threadService: { get: id => store.get(id) } }
    await assert.rejects(permissionCaptureFromWorker(runtime, taskId, turnId, 30), /Permission acceptance timed out: .*execution Grant/)
  } finally { await rm(root, { recursive: true, force: true }) }
})


test('permission execution readiness rejects foreign and stale Task Turn or Grant snapshots', async () => {
  const taskId = 'current-task', threadId = 'current-thread', turnId = 'current-turn'
  const task = { id: taskId, threadId, activeTurnId: turnId }
  const turn = { id: turnId, executionGrant: { id: 'current-grant', taskId, threadId, turnId } }
  const read = async (taskSnapshot, threadSnapshot) => permissionSmokeModule.readWindowsPermissionExecutionTurn({ taskRepository: { get: () => taskSnapshot }, threadService: { get: async () => threadSnapshot } }, taskId, turnId)
  assert.equal(await read(task, { id: threadId, turns: [turn] }), turn)
  for (const [badTask, badThread] of [
    [{ ...task, activeTurnId: 'old-turn' }, { id: threadId, turns: [turn] }],
    [task, { id: 'foreign-thread', turns: [turn] }],
    [task, { id: threadId, turns: [{ ...turn, executionGrant: { ...turn.executionGrant, taskId: 'foreign-task' } }] }],
    [task, { id: threadId, turns: [{ ...turn, executionGrant: { ...turn.executionGrant, turnId: 'old-turn' } }] }],
    [task, { id: threadId, turns: [{ id: turnId }] }]
  ]) assert.equal(await read(badTask, badThread), null)
})
