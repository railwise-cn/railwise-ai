import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonSettingsStore } from '../settings-store'
import { McpConfigService } from './mcp-config-service'
import { inspectPackageDirectory, PackageInstallationService } from './package-installation-service'
import { listGuiSkills } from './skill-service'

const isolated = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => isolated.home }))
vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => { throw new Error('Synthetic upgrade must not access OS credentials') }
} }))
vi.mock('./im-credential-helper', () => ({
  encryptStringWithCredentialHelper: () => { throw new Error('Synthetic upgrade must not access OS credentials') },
  decryptStringWithCredentialHelper: () => { throw new Error('Synthetic upgrade must not access OS credentials') }
}))

afterEach(async () => {
  vi.unstubAllEnvs()
  if (isolated.home) await rm(isolated.home, { recursive: true, force: true })
})

// These are the persisted settings-v2, MCP-v2 and installed-packages-v1 shapes
// from tag v0.5.6. Their production reader/writer files are unchanged in this
// upgrade. Only the platform keystore is replaced by a synthetic adapter.
it.each(['keychain', 'dpapi'] as const)('preserves 0.5.6 workspace, custom Skills, installed package and %s references across service restarts', async storage => {
  isolated.home = await realpath(await mkdtemp(join(tmpdir(), 'railwise-v056-desktop-')))
  const workwiseHome = join(isolated.home, '.workwise')
  const userData = join(isolated.home, 'RailWise AI')
  const workspace = join(isolated.home, '用户 项目')
  const writeRoot = join(isolated.home, '写作资料')
  vi.stubEnv('CODEX_HOME', join(isolated.home, '.codex'))
  vi.stubEnv('WORKWISE_TOOLS_ROOT', join(workwiseHome, 'tools'))
  await Promise.all([userData, workspace, writeRoot].map(path => mkdir(path, { recursive: true })))
  const activeWorkspace = storage === 'dpapi' ? '' : workspace
  await writeFile(join(userData, 'workwise-settings.json'), JSON.stringify({
    schema: 'workwise.settings', version: 2, revision: 7, locale: 'zh', workspaceRoot: activeWorkspace,
    write: { defaultWorkspaceRoot: writeRoot, activeWorkspaceRoot: writeRoot, workspaces: [writeRoot] }
  }))
  const userSkill = '---\nname: retained-v056\ndescription: 用户自定义的历史资料整理规则。\n---\n\n保留原有资料来源与正文。\n'
  const originalFiles: Record<string, string> = {
    [join(workspace, '.codex/skills/retained-v056/SKILL.md')]: userSkill,
    [join(workspace, 'draft.md')]: '# 用户草稿\n原内容继续保留。\n',
    [join(writeRoot, 'report.md')]: '# 历史报告\n旧版正文。\n'
  }
  for (const [path, contents] of Object.entries(originalFiles)) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  const pluginRoot = join(workwiseHome, 'plugins')
  const source = join(isolated.home, 'synthetic-package')
  await mkdir(join(source, 'skills/package-v056'), { recursive: true })
  await writeFile(join(source, 'workwise.catalog.json'), JSON.stringify({ components: [{ type: 'skill' }] }))
  await writeFile(join(source, 'skills/package-v056/SKILL.md'), '---\nname: package-v056\ndescription: 已安装的历史工程技能。\n---\n\n用户原始说明。\n')
  const inspection = await inspectPackageDirectory(source)
  const packageId = 'custom-v056-package'
  const packagePath = join(pluginRoot, 'packages', createHash('sha256').update(packageId).digest('hex'), 'versions', inspection.sha256)
  await mkdir(dirname(packagePath), { recursive: true })
  await cp(source, packagePath, { recursive: true })
  const packageSource = { id: 'v056-source', kind: 'local', location: source }
  const packageRecord = { schemaVersion: 1, packageId, version: '1.0.0', scope: 'user', source: packageSource, sources: [packageSource],
    components: [{ id: 'package-v056', type: 'skill', skillNames: ['package-v056'] }], permissions: [], license: 'MIT',
    reviewSha256: 'a'.repeat(64), timestamps: { installedAt: '2026-11-12T01:00:00.000Z' },
    updatePolicy: { strategy: 'manual', channel: 'stable', allowMajor: false }, health: { status: 'installed' },
    artifact: { sha256: inspection.sha256, location: packagePath, fileCount: inspection.fileCount, totalBytes: inspection.totalBytes } }
  const installedPath = join(pluginRoot, 'installed.json')
  const installedContents = JSON.stringify({ schema: 'workwise.installed-packages', version: 1, revision: 3,
    records: [{ current: packageRecord }], mutationKeys: {} })
  await writeFile(installedPath, installedContents)
  const credentialRoot = join(workwiseHome, 'credentials/mcp')
  await mkdir(credentialRoot, { recursive: true })
  const credentialRef = { id: 'mcp_v056_synthetic', storage }
  const credentialPath = join(credentialRoot, `${credentialRef.id}.json`)
  const credentialContents = JSON.stringify({ version: 1, encrypted: Buffer.from(JSON.stringify({ accessToken: 'synthetic-v056-only' })).toString('base64') })
  await writeFile(credentialPath, credentialContents)
  const mcpPath = join(workwiseHome, 'mcp-v2.json')
  const server = { id: 'v056-mcp', name: '历史自定义 MCP', scope: 'workspace', workspaceRoot: workspace, transport: 'stdio',
    command: 'synthetic-not-launched', args: [], cwd: workspace, timeoutMs: 5000, source: 'user', enabled: true, revision: 4,
    toolPolicy: { search: 'allow' }, credentialEnvironmentVariables: ['SYNTHETIC_API_TOKEN'], credentialRef }
  const mcpContents = JSON.stringify({ schema: 'workwise.mcp-servers', version: 2, revision: 4, servers: [server], mutationKeys: {} })
  await writeFile(mcpPath, mcpContents)
  const network = vi.fn(() => { throw new Error('Synthetic compatibility fixture cannot call a provider') })
  const encrypt = vi.fn(() => { throw new Error('Reading a legacy credential must not replace it') })
  const decrypt = vi.fn((value: Buffer) => value.toString())
  for (let restart = 0; restart < 2; restart++) {
    const settings = await new JsonSettingsStore(userData, { workwiseHome }).load()
    expect(settings.workspaceRoot).toBe(activeWorkspace)
    expect(settings.write).toMatchObject({ activeWorkspaceRoot: writeRoot, workspaces: [writeRoot] })
    const installed = await new PackageInstallationService({ rootDirectory: pluginRoot }).list()
    expect(installed).toMatchObject([packageRecord])
    const skills = await listGuiSkills(settings, workspace)
    expect(skills.ok).toBe(true)
    if (!skills.ok) throw new Error(skills.message)
    expect(skills.skills.map(skill => skill.id)).toEqual(expect.arrayContaining(['retained-v056', 'package-v056']))
    const mcp = new McpConfigService({ manifestPath: mcpPath, credentialRoot, fetch: network,
      encryption: { available: () => true, encrypt, decrypt, storage } })
    expect(await mcp.list(workspace)).toMatchObject([server])
    const snapshot = await mcp.runtimeSnapshot()
    expect(snapshot.servers['v056-mcp']).toMatchObject({ enabled: true, command: 'synthetic-not-launched', trustedWorkspaceRoots: [workspace] })
    expect(Object.values(snapshot.environment)).toEqual(['synthetic-v056-only'])
    expect(JSON.stringify(snapshot.servers)).not.toContain('synthetic-v056-only')
    for (const [path, contents] of Object.entries(originalFiles)) expect(await readFile(path, 'utf8')).toBe(contents)
    expect(await readFile(installedPath, 'utf8')).toBe(installedContents)
    expect(await readFile(mcpPath, 'utf8')).toBe(mcpContents)
    expect(await readFile(credentialPath, 'utf8')).toBe(credentialContents)
    expect(await inspectPackageDirectory(packagePath)).toEqual(inspection)
  }
  expect(decrypt).toHaveBeenCalledTimes(2)
  expect(encrypt).not.toHaveBeenCalled()
  expect(network).not.toHaveBeenCalled()
})
