import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { readonlyConnectorSetupExpression, validateDefaultSkillSources, verifyInstalledAgentPackSkill, validateWindowsUiReport, validateWindowsTaskEvidence, validateWindowsBrowserEvidence, startWindowsTaskModelFixture, summarizeWindowsTaskFailure, windowsUiEnvironment } from './run-windows-ui-smoke.mjs'
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
  const leaveHelp = ui.indexOf("cdp.click('.ds-settings-sidebar button', '返回')")
  assert.ok(leaveHelp > ui.indexOf("report.checks.push('offline-help-images')"))
  assert.ok(leaveHelp < ui.indexOf("'the main workspace after leaving help'"))
  assert.ok(ui.indexOf("'the main workspace after leaving help'") < ui.indexOf('cdp.hover(\'button[aria-label="新建会话"]\')'))
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
    skillInstallation: { packageId: 'browser-skill', sourceCommit: '9cfba53582cb04d48da36aabd0a5017987d4daea',
      runtimeHotLoaded: true, runtimeUnchanged: true, sameConversation: true, activeInTask: true, entrySha256: 'b'.repeat(64),
      guiScheduleMcp: { id: 'gui_schedule', enabled: true, available: true, status: 'connected', toolCount: 8 } },
    extension: { version: '0.4.0', sha256: browserSmokeDependency.extensionSha256 }, browser: { version: browserSmokeDependency.chromeVersion },
    browserInstanceId: 'synthetic-validation-id', sessionId: 'synthetic-validation-session', htmlSha256: 'a'.repeat(64) }
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
    // A later scheduled task uses a fresh conversation. Completed calls from
    // the previous request never become mutable state in this protocol model.
    const nextTask = await (await request([])).text()
    assert.ok(nextTask.includes('browser_session_start'))
    const freshHistory = [
      { role: 'assistant', tool_calls: [{ id: 'fresh-start', function: { name: 'browser_session_start', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'fresh-start', content: JSON.stringify({ sessionId: 'fresh-task-session' }) }
    ]
    const navigation = await (await request(freshHistory)).text()
    assert.ok(navigation.includes('browser_navigate') && navigation.includes('fresh-task-session'))
  } finally { await fixture.close() }
})

test('the fixture reads session and HTML results using the production model client framing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-model-framing-'))
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    const output = join(root, 'model-client.mjs')
    await build({ entryPoints: [fileURLToPath(new URL('../kun/src/adapters/model/deepseek-compat-model-client.ts', import.meta.url))],
      outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const { DeepseekCompatModelClient } = await import(pathToFileURL(output).href)
    const client = new DeepseekCompatModelClient({ baseUrl: fixture.baseUrl, apiKey: 'synthetic', model: 'synthetic' })
    const framed = (name, value) => client.toolResultToMessage({ kind: 'tool_result', callId: name, output: value },
      { kind: 'tool_call', callId: name, toolName: name, arguments: {}, argumentSummary: 'Original arguments omitted' })
    const names = ['browser_session_start', 'browser_navigate', 'browser_get_html', 'browser_session_stop', 'publish_artifact']
    const calls = names.slice(0, 4).map(name => ({ role: 'assistant', tool_calls: [{ id: name, function: { name, arguments: '{}' } }] }))
    const tools = names.map(name => ({ type: 'function', function: { name } }))
    const request = messages => fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ tools, messages }) })
    const session = framed('browser_session_start', { sessionId: 'actual-framed-session' })
    assert.throws(() => JSON.parse(session.content), 'The old plain-JSON fixture parser cannot read the production framing')
    const navigation = await request([calls[0], session])
    assert.equal(navigation.status, 200)
    assert.ok((await navigation.text()).includes('actual-framed-session'))
    const html = await (await fetch(fixture.fixtureUrl)).text()
    for (const untrusted of [false, true]) {
      const result = await request([...calls, framed('browser_get_html', { html, untrusted })])
      assert.equal(result.status, 200)
      assert.ok((await result.text()).includes(fixture.marker))
    }
    const invalid = await request([...calls, { role: 'tool', tool_call_id: 'browser_get_html',
      content: `<html>Recorded result:\n${JSON.stringify({ html })}</html>` }])
    assert.equal(invalid.status, 400)
    assert.match(fixture.observed.requests.at(-1).error, /requires actual browser HTML/)
  } finally {
    await fixture.close()
    await rm(root, { recursive: true, force: true })
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
})
