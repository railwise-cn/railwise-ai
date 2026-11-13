import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { readonlyConnectorSetupExpression, validateDefaultSkillSources, verifyInstalledAgentPackSkill, verifyInstalledBundledSkillCopy, validateWindowsUiReport, validateWindowsTaskEvidence, validateWindowsBrowserEvidence, validateWindowsPermissionRuntimeEvidence, runInstalledWindowsPermissionAcceptance, installedPermissionWorker, startWindowsTaskModelFixture, summarizeWindowsTaskFailure, inspectWindowsManualPreview, windowsUiEnvironment, validateWindowsFixtureQueryHtml, reviewWindowsFixtureApproval, windowsFixtureApprovalUiExpression, windowsFixturePendingApprovals, windowsFixtureApprovalResolution, windowsSmokeWorkspaceName, inspectWindowsBrowserRecoveryState, windowsBrowserBindingUiExpression, validateWindowsBrowserRecoveryEvidence, windowsTaskPreviewLayoutExpression, validateWindowsTaskPreviewLayout, validateWindowsScheduledQueryEvidence, inspectWindowsQueryThread } from './run-windows-ui-smoke.mjs'
import { browserSmokeDependency } from './prepare-browser-skill-smoke.mjs'

const identity = { version: '0.5.6', sourceHead: 'a'.repeat(40) }
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
        layout: { workspace: { width: 560 }, availableWidth: 520, stackThresholdPx: 704, details: { width: 520, x: 20, y: 300 }, list: { x: 20, y: 20, bottom: 280 }, overflow: { workspace: 0, columns: 0, details: 0 } } },
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
  const leaveHelp = ui.indexOf("cdp.click('.ds-settings-sidebar button', '返回')")
  assert.ok(leaveHelp > ui.indexOf("report.checks.push('offline-help-images')"))
  assert.ok(leaveHelp < ui.indexOf("'the main workspace after leaving help'"))
  assert.ok(ui.indexOf("'the main workspace after leaving help'") < ui.indexOf("cdp.click('.ds-sidebar-shell button.w-full', '新建会话')"))
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

// These protocol-component tests supply synthetic results only; they are not Windows business acceptance evidence.
const browserToolNames = ['browser_session_start', 'browser_navigate', 'browser_get_html', 'browser_authorize_action', 'browser_fill', 'browser_click', 'browser_session_stop', 'publish_artifact', 'schedule_task', 'list_schedules']
const fixtureMessages = (id, name, output) => [
  { role: 'assistant', tool_calls: [{ id: `smoke-${id}`, function: { name, arguments: '{}' } }] },
  ...(output === undefined ? [] : [{ role: 'tool', tool_call_id: `smoke-${id}`, content: JSON.stringify(output) }])
]
const fixtureResultHtml = (page, query) => page.replace('<output id="query-result" aria-live="polite"></output>', `<output id="query-result" aria-live="polite" data-query="${query}">本地查询结果：${query}；已完成合成公开检索</output>`)
const fixtureRequest = (fixture, names, messages) => fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ tools: names.map(name => ({ type: 'function', function: { name } })), messages }) })
const fixtureCall = async response => {
  assert.equal(response.status, 200)
  const data = (await response.text()).split('\n').find(line => line.startsWith('data: {'))
  return JSON.parse(data.slice(6)).choices[0].delta.tool_calls?.[0]
}

test('browser protocol obtains fresh real refs, asks exact persistent actions, and omits approvals for a new scheduled conversation', async () => {
  const fixture = await startWindowsTaskModelFixture({ browser: true })
  try {
    const page = await (await fetch(fixture.fixtureUrl)).text()
    assert.ok(page.includes(fixture.inputHtml) && page.includes(fixture.buttonHtml))
    assert.ok(!page.includes('fetch(') && !page.includes('<form'))
    assert.throws(() => validateWindowsFixtureQueryHtml(page, fixture), /actual DOM/)
    for (const initial of [true, false]) {
      const names = initial ? browserToolNames : browserToolNames.filter(name => !['schedule_task', 'list_schedules'].includes(name))
      const messages = []
      const authorizations = []
      const ids = []
      for (let count = 0; count < 15; count++) {
        const call = await fixtureCall(await fixtureRequest(fixture, names, messages))
        assert.ok(call)
        ids.push(call.id)
        const args = JSON.parse(call.function.arguments)
        if (call.function.name === 'publish_artifact') {
          assert.ok(args.content.includes(`data-query="${fixture.query}"`))
          break
        }
        let output = { status: 'succeeded' }
        if (call.id === 'smoke-start') output.sessionId = initial ? 'synthetic-source-session' : 'synthetic-due-session'
        if (call.id === 'smoke-navigate') output = { observation: { context_id: 'synthetic-navigation-context', observation: { text: '@e1 input 合成公告关键词\n@e2 button 查询合成公告' } } }
        if (call.id === 'smoke-read-fill-target') assert.equal(args.target, '@e1')
        if (call.id === 'smoke-read-click-target') assert.equal(args.target, '@e12')
        if (call.function.name === 'browser_authorize_action') {
          authorizations.push(args)
          assert.equal(args.scope, 'schedule')
          assert.equal(args.scheduleAccess, 'public_query')
        }
        if (call.id === 'smoke-fill') {
          assert.equal(args.value, fixture.query)
          assert.equal(args.contextId, 'synthetic-navigation-context')
          output = { observation: { context_id: 'synthetic-post-fill-context', observation: { text: '@e11 input 合成公告关键词\n@e12 button 查询合成公告' } } }
        }
        if (call.id === 'smoke-click') {
          assert.equal(args.contextId, 'synthetic-post-fill-context')
          assert.equal(args.target, '@e12')
        }
        if (call.id === 'smoke-read-results') output = { html: fixtureResultHtml(page, fixture.query) }
        messages.push(...fixtureMessages(call.id.slice(6), call.function.name, output))
      }
      assert.equal(authorizations.length, initial ? 2 : 0)
      assert.ok(ids.includes('smoke-artifact'))
    }
    const missing = fixtureMessages('start', 'browser_session_start', { sessionId: 'synthetic' })
    missing.push(...fixtureMessages('navigate', 'browser_navigate', {}))
    assert.equal((await fixtureRequest(fixture, browserToolNames, missing)).status, 400)
    assert.match(fixture.observed.requests.at(-1).error, /fresh actual observed element/)
    const finished = ['start', 'navigate', 'read-fill-target', 'authorize-fill', 'fill', 'read-click-target', 'authorize-click', 'click', 'read-results', 'stop']
      .flatMap(id => fixtureMessages(id, 'synthetic-component-call'))
    assert.equal((await fixtureRequest(fixture, browserToolNames, finished)).status, 400)
    assert.match(fixture.observed.requests.at(-1).error, /requires actual browser HTML/)
  } finally { await fixture.close() }
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
    const calls = ['start', 'navigate', 'read-fill-target', 'authorize-fill', 'fill', 'read-click-target', 'authorize-click', 'click', 'read-results', 'stop']
      .flatMap(id => fixtureMessages(id, 'synthetic-component-call'))
    for (const untrusted of [false, true]) {
      const result = await fixtureCall(await fixtureRequest(fixture, browserToolNames, [...calls, framed('read-results', 'browser_get_html', { html, untrusted })]))
      assert.ok(result.function.arguments.includes(fixture.query))
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
    const makeSummary = (action, change = {}) => browserApprovalSummary({ action, origin, targetHtml: action === 'fill' ? fixture.inputHtml : fixture.buttonHtml,
      value: action === 'fill' ? fixture.query : undefined, requestHash: 'a'.repeat(64), schedule: { purpose: prompt,
        requirement: { kind: 'daily', times: ['09:00', '17:00'], leadMinutes: 30, timezone: 'Asia/Shanghai' }, browserLabel: '合成组件浏览器', version: 'b'.repeat(64) }, ...change })
    const thread = { turns: [{ items: ['fill', 'click'].map(action => ({ kind: 'tool_result', callId: `smoke-read-${action}-target`, isError: false,
      output: { sourceUrl: fixture.fixtureUrl, html: action === 'fill' ? fixture.inputHtml : fixture.buttonHtml } })) }] }
    const options = { fixture, prompt, workspace, browserLabel: '合成组件浏览器', thread, index: 0 }
    const approval = { approvalId: 'synthetic-review', toolName: 'browser_authorize_action', requestHash: 'a'.repeat(64), status: 'pending', summary: makeSummary('fill') }
    assert.equal(reviewWindowsFixtureApproval(approval, options).scope, 'schedule')
    assert.throws(() => reviewWindowsFixtureApproval({ ...approval, requestHash: 'd'.repeat(64) }, options))
    for (const change of [{ origin: 'https://unreviewed.example.test' }, { value: fixture.query + '扩大' }, { targetHtml: '<input type="password" aria-label="合成公告关键词">' }, { schedule: undefined }]) {
      assert.throws(() => reviewWindowsFixtureApproval({ ...approval, summary: makeSummary('fill', change) }, options))
    }
    for (const [field, value] of [['执行时刻', '01:20、08:30、16:30'], ['账号状态', '已登录'], ['计划目的', prompt + '扩大范围']]) {
      const summary = approval.summary.replace(new RegExp(`^${field} .+$`, 'm'), `${field} ${JSON.stringify(value)}`)
      assert.throws(() => reviewWindowsFixtureApproval({ ...approval, summary }, options))
    }
    const changedThread = structuredClone(thread)
    changedThread.turns[0].items[0].output.html += '<!-- changed actual DOM -->'
    assert.throws(() => reviewWindowsFixtureApproval(approval, { ...options, thread: changedThread }))
    const click = { ...approval, summary: makeSummary('click') }
    assert.equal(reviewWindowsFixtureApproval(click, { ...options, index: 1 }).action, 'click')
    const planSummary = browserScheduleApprovalSummary({ purpose: prompt, times: ['08:30', '16:30'], timezone: 'Asia/Shanghai', readPaths: [workspace], writePaths: [],
      origins: [origin], browserLabel: options.browserLabel, actions: [{ summary: approval.summary }, { summary: click.summary }], scopeHash: 'c'.repeat(64) })
    const plan = { ...approval, toolName: 'schedule_task', requestHash: 'c'.repeat(64), summary: planSummary }
    assert.equal(reviewWindowsFixtureApproval(plan, { ...options, index: 2 }).toolName, 'schedule_task')
    assert.throws(() => reviewWindowsFixtureApproval(plan, { ...options, index: 3 }))
    assert.throws(() => reviewWindowsFixtureApproval(plan, { ...options, index: 2, workspace: join(root, 'other') }))
    const writes = planSummary.replace(/^写入路径 .+$/m, `写入路径 ${JSON.stringify(workspace)}`)
    assert.throws(() => reviewWindowsFixtureApproval({ ...plan, summary: writes }, { ...options, index: 2 }))
  } finally { await fixture.close(); await rm(root, { recursive: true, force: true }) }
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
  const binding = { browserInstanceId: 'browser-fixed', revision: 2, origins: ['http://127.0.0.1:1234'], interaction: 'interact' }
  const confirmed = inspectWindowsBrowserRecoveryState({ ...options, task: { ...task, status: 'paused', authority: { browserScope: binding } }, status: 'paused', binding })
  const evidence = { taskId: task.id, threadId: task.threadId, originThreadId: task.originThreadId, fixtureOrigin: binding.origins[0],
    initial, pausedBeforeConfiguration: paused, blockedResume: paused, confirmed, initialCapability: 'browser_disabled', blockedCapability: 'browser_task_scope_required', blockedRoute: 'task/browser-binding',
    uiPreviewVerified: true, uiConfirmVerified: true, resumed: { taskId: task.id, threadId: task.threadId, turns: 1, firstTurnId: 'first-turn' } }
  assert.equal(validateWindowsBrowserRecoveryEvidence(evidence, binding.browserInstanceId), true)
  for (const key of ['initial', 'pausedBeforeConfiguration', 'blockedResume', 'confirmed']) {
    const changed = structuredClone(evidence); changed[key].turns = 1
    assert.throws(() => validateWindowsBrowserRecoveryEvidence(changed, binding.browserInstanceId))
  }
  for (const change of [{ uiPreviewVerified: false }, { uiConfirmVerified: false }, { blockedRoute: 'marketplace' }, { resumed: { ...evidence.resumed, turns: 2 } }]) {
    assert.throws(() => validateWindowsBrowserRecoveryEvidence({ ...evidence, ...change }, binding.browserInstanceId))
  }
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
    const panel = `<section aria-label="${zh.capabilityRequiredTitle}"><div><p>${zh.browserTaskBindingReview}</p><dl><dd>browser-fixed</dd><dd>http://127.0.0.1:1234</dd><dd>${zh.browserSkillAllowInteraction}</dd></dl><button>${zh.browserTaskBindingConfirm}</button></div></section>`
    window.document.body.innerHTML = panel
    assert.equal(window.eval(windowsBrowserBindingUiExpression()), null)
    window.document.body.innerHTML = `<article aria-label="任务详情">${panel}</article>`
    const detail = window.document.querySelector('article'), button = detail.querySelector('button')
    detail.getClientRects = button.getClientRects = () => [{}]
    button.scrollIntoView = () => undefined
    button.getBoundingClientRect = () => ({ x: 10, y: 20, width: 20, height: 10 })
    window.document.elementFromPoint = () => button
    const result = JSON.parse(JSON.stringify(window.eval(windowsBrowserBindingUiExpression())))
    assert.deepEqual(result, { point: { x: 20, y: 25 }, values: ['browser-fixed', 'http://127.0.0.1:1234', zh.browserSkillAllowInteraction] })
    button.disabled = true
    assert.equal(window.eval(windowsBrowserBindingUiExpression()), null)
    button.disabled = false
    detail.querySelector('dd').remove()
    assert.equal(window.eval(windowsBrowserBindingUiExpression()), null)
  } finally { await window.happyDOM.close() }
})

test('manual-preview layout keeps task details readable and stacks narrow containers using the actual rem threshold', () => {
  const valid = report().taskExecution.preview.layout
  assert.equal(validateWindowsTaskPreviewLayout(valid), true)
  const smallFont = { ...structuredClone(valid), workspace: { width: 630 }, stackThresholdPx: 616, details: { width: 410, x: 220, y: 20 } }
  assert.equal(validateWindowsTaskPreviewLayout(smallFont), true, 'A 44rem threshold must follow actual root font size')
  for (const change of [{ details: { ...valid.details, width: 20 } }, { details: { ...valid.details, y: 20 } },
    { overflow: { workspace: 1, columns: 2, details: 0 } }, { stackThresholdPx: Number.NaN }, { availableWidth: 0 }]) {
    assert.throws(() => validateWindowsTaskPreviewLayout({ ...valid, ...change }))
  }
  assert.match(windowsTaskPreviewLayoutExpression(), /44\*parseFloat\(getComputedStyle\(document\.documentElement\)\.fontSize\)/)
  assert.doesNotMatch(windowsTaskPreviewLayoutExpression(), /704/)
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

test('scheduled query validation requires source UI reviews and independent derived authority without extra due approvals', () => {
  // Synthetic validator input; never emitted as actual business evidence.
  const query = { domReadbackVerified: true, htmlReadbackVerified: true, actions: 2, unknownOutcomes: 0, accountState: 'unknown', access: 'public_query' }
  const evidence = { browserSkill: { publicQuery: { ...query, uiApprovals: ['browser_authorize_action', 'browser_authorize_action', 'schedule_task'].map(toolName => ({ toolName, status: 'allowed', uiFieldsVerified: true, businessCardDisplayedVerified: true, originalSummaryVerified: true, cardDisplayedVerified: true, buttonOperableVerified: true })), persistentActionAuthorizations: 2 } },
    dueOccurrence: { publicQuery: { ...query, addedApprovals: 0, derivedActionAuthorizations: 2, publishedPlanVersionVerified: true, enabledPlanVerified: true, shortAuthorizationVerified: true } } }
  assert.doesNotThrow(() => validateWindowsScheduledQueryEvidence(evidence))
  for (const [field, value] of [['addedApprovals', 1], ['derivedActionAuthorizations', 0], ['publishedPlanVersionVerified', false], ['enabledPlanVerified', false], ['shortAuthorizationVerified', false], ['unknownOutcomes', 1], ['domReadbackVerified', false], ['htmlReadbackVerified', false]]) {
    const changed = structuredClone(evidence)
    changed.dueOccurrence.publicQuery[field] = value
    assert.throws(() => validateWindowsScheduledQueryEvidence(changed))
  }
  const noReview = structuredClone(evidence)
  noReview.browserSkill.publicQuery.uiApprovals.pop()
  assert.throws(() => validateWindowsScheduledQueryEvidence(noReview))
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
