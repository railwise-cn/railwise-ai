import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { readonlyConnectorSetupExpression, validateDefaultSkillSources, validateWindowsUiReport, validateWindowsTaskEvidence, validateWindowsBrowserEvidence, startWindowsTaskModelFixture, windowsUiEnvironment } from './run-windows-ui-smoke.mjs'
import { browserSmokeDependency } from './prepare-browser-skill-smoke.mjs'

const identity = { version: '0.5.6', sourceHead: 'a'.repeat(40) }
function report() {
  // Validator fixtures do not supply actual Windows UI acceptance evidence.
  return {
    schemaVersion: 1, scope: 'private-exact-package-chinese-ui', platform: 'win32', ...identity,
    locale: 'zh', theme: 'dark', productionTouched: false, packageUnchanged: true, cleanExit: true,
    errors: [], tabs: ['技能', '插件', '连接器'], chapters: Array.from({ length: 13 }, (_, index) => index + 1),
    update: { ok: true, hasUpdate: false }, helpOffline: true,
    taskSmokeRequested: true,
    taskExecution: { model: 'local-protocol-fixture', status: 'completed', artifact: { format: 'html', validation: 'valid', sha256: 'a'.repeat(64), byteHashMatches: true },
      schedule: { times: ['08:30', '16:30'], timezone: 'Asia/Shanghai', enabled: true, nextRunAt: '2026-11-14T00:30:00Z', readBackFromTool: true },
      preview: { automatic: true, contentVerified: true, manualEntryVerified: true },
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
      'packaged-skills-and-engineering-entries', 'amap-zotero-actionable-setup', 'autocad-fixed-upstream-entries', 'runtime-task-html-and-daily-schedule']
  }
}

test('isolated ordinary package environment keeps public identity and removes account and updater overrides', () => {
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
    assert.throws(() => validateWindowsUiReport(missing, identity), /Missing actual UI observation/)
  }
})

for (const [label, mutate] of [
  ['wrong package source', value => { value.sourceHead = 'b'.repeat(40) }],
  ['changed package', value => { value.packageUnchanged = false }],
  ['forced cleanup', value => { value.cleanExit = false }],
  ['wrong locale', value => { value.locale = 'en' }],
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
    const tools = ['publish_artifact', 'schedule_task', 'list_schedules'].map(name => ({ type: 'function', function: { name } }))
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
  const evidence = { status: 'passed', fixturePageRead: true, htmlFromBrowserTool: true, sessionStopped: true, cliVersion: '0.4.0',
    extension: { version: '0.4.0', sha256: browserSmokeDependency.extensionSha256 }, browser: { version: browserSmokeDependency.chromeVersion },
    browserInstanceId: 'synthetic-validation-id', sessionId: 'synthetic-validation-session', htmlSha256: 'a'.repeat(64) }
  assert.doesNotThrow(() => validateWindowsBrowserEvidence(evidence))
  for (const field of ['fixturePageRead', 'htmlFromBrowserTool', 'sessionStopped']) assert.throws(() => validateWindowsBrowserEvidence({ ...evidence, [field]: false }))
  assert.throws(() => validateWindowsBrowserEvidence({ ...evidence, status: 'not_exercised' }))
  assert.throws(() => validateWindowsUiReport(report(), identity, { requireBrowserExecution: true }))
})

test('browser protocol model asks for real navigation and refuses to invent missing page HTML', async () => {
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  const names = ['browser_session_start', 'browser_navigate', 'browser_get_html', 'browser_session_stop', 'publish_artifact', 'schedule_task', 'list_schedules']
  const tools = names.map(name => ({ type: 'function', function: { name } }))
  const request = messages => fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ tools, messages }) })
  try {
    assert.ok((await (await request([])).text()).includes('browser_session_start'))
    const messages = names.slice(0, 4).map(name => ({ role: 'assistant', tool_calls: [{ id: name, function: { name, arguments: '{}' } }] }))
    assert.equal((await request(messages)).status, 400)
    const page = await (await fetch(fixture.fixtureUrl)).text()
    assert.ok(page.includes(fixture.marker))
    const withHtml = [...messages, { role: 'tool', tool_call_id: 'browser_get_html', content: JSON.stringify({ html: page }) }]
    const response = await request(withHtml)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes('publish_artifact') && body.includes(fixture.marker))
  } finally { await fixture.close() }
})
