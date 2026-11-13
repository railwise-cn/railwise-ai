import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { readonlyConnectorSetupExpression, validateDefaultSkillSources, verifyInstalledAgentPackSkill, verifyInstalledBundledSkillCopy, validateWindowsUiReport, validateWindowsTaskEvidence, validateWindowsBrowserEvidence, validateWindowsPermissionRuntimeEvidence, runInstalledWindowsPermissionAcceptance, installedPermissionWorker, startWindowsTaskModelFixture, summarizeWindowsTaskFailure, collectWindowsTaskFailure, readWindowsTaskFailureStore, summarizeWindowsFailureLogs, inspectWindowsManualPreview, windowsUiEnvironment, validateWindowsFixtureQueryHtml, reviewWindowsFixtureApproval, windowsFixtureApprovalUiExpression, windowsFixturePendingApprovals, windowsFixtureApprovalResolution, windowsSmokeWorkspaceName, inspectWindowsBrowserRecoveryState, windowsBrowserBindingUiExpression, validateWindowsBrowserRecoveryEvidence, windowsTaskPreviewLayoutExpression, validateWindowsTaskPreviewLayout, validateWindowsScheduledQueryEvidence, inspectWindowsQueryThread } from './run-windows-ui-smoke.mjs'
import { browserSmokeDependency } from './prepare-browser-skill-smoke.mjs'
import { clickWindowsBrowserBinding, selectWindowsBrowserPolicy, windowsBindingPostAudit, inspectWindowsBrowserPolicy, windowsTaskPrompt } from './run-windows-ui-smoke.mjs'

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

test('policy evidence binds actual task, Turn Grant, fresh target, derived authorization and exact dispatch dependencies', () => {
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
      return [{ id: `dispatch-${action}`, ownerId: task.id, kind: 'browser_action_dispatch', status: 'succeeded',
        request: { ...binding, toolName: `browser_${action}`, targetRef: i ? 'e2' : '@e1', pageUrl: fixture.fixtureUrl, dependsOn: verificationPolicy === 'public_query_target' ? [i ? 'e2' : '@e1'] : [] },
        result: { actionAcknowledged: true, readbackPending: false } },
      { id: `derived-${action}`, ownerId: task.id, kind: 'browser_derived_action_authorization', status: 'succeeded', request: { ...binding, grantId: turn.executionGrant.id }, result: { ...optional } }]
    })
    return { task, thread: { turns: [turn] }, receipts }
  }
  const check = value => inspectWindowsBrowserPolicy(value.task, value.thread, value.receipts, fixture)
  const valid = input('public_query_target')
  const result = check(valid)
  assert.deepEqual(result.dispatches.map(item => item.dependsOn), [['@e1'], ['e2']])
  assert.equal(result.grants[0].id, 'grant-fixture')
  for (const mutate of [value => { delete value.task.authority.browserScope.verificationPolicy },
    value => { value.thread.turns[0].executionGrant.browserScope.verificationPolicy = 'strict' },
    value => { value.receipts[0].request.dependsOn = [] }, value => { value.receipts[0].request.dependsOn = ['e1'] },
    value => { value.receipts[0].request.dependsOn.push('other') }, value => { delete value.receipts[0].request.verificationPolicy },
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
})

test('scheduled query validation requires source UI reviews and independent derived authority without extra due approvals', () => {
  // Synthetic validator input; never emitted as actual business evidence.
  const query = { domReadbackVerified: true, htmlReadbackVerified: true, actions: 2, unknownOutcomes: 0, accountState: 'unknown', access: 'public_query' }
  const policyProjection = id => ({ verificationPolicy: 'public_query_target', grants: [{ id, verificationPolicy: 'public_query_target' }],
    dispatches: ['@e1', 'e2'].map(targetRef => ({ verificationPolicy: 'public_query_target', derivedVerificationPolicy: 'public_query_target', grantId: id, targetRef, dependsOn: [targetRef] })) })
  const evidence = { browserSkill: { publicQuery: { ...query, policyExecution: policyProjection('source-grant'), uiApprovals: ['browser_authorize_action', 'browser_authorize_action', 'schedule_task'].map(toolName => ({ toolName, status: 'allowed', verificationPolicy: 'public_query_target', uiFieldsVerified: true, businessCardDisplayedVerified: true, originalSummaryVerified: true, cardDisplayedVerified: true, buttonOperableVerified: true })), persistentActionAuthorizations: 2 } },
    dueOccurrence: { publicQuery: { ...query, policyExecution: policyProjection('due-grant'), addedApprovals: 0, derivedActionAuthorizations: 2, publishedPlanVersionVerified: true, enabledPlanVerified: true, shortAuthorizationVerified: true } } }
  assert.doesNotThrow(() => validateWindowsScheduledQueryEvidence(evidence))
  for (const [field, value] of [['addedApprovals', 1], ['derivedActionAuthorizations', 0], ['publishedPlanVersionVerified', false], ['enabledPlanVerified', false], ['shortAuthorizationVerified', false], ['unknownOutcomes', 1], ['domReadbackVerified', false], ['htmlReadbackVerified', false]]) {
    const changed = structuredClone(evidence)
    changed.dueOccurrence.publicQuery[field] = value
    assert.throws(() => validateWindowsScheduledQueryEvidence(changed))
  }
  const noReview = structuredClone(evidence)
  noReview.browserSkill.publicQuery.uiApprovals.pop()
  assert.throws(() => validateWindowsScheduledQueryEvidence(noReview))
  for (const mutate of [value => { value.dueOccurrence.publicQuery.policyExecution.dispatches[0].dependsOn = [] },
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
