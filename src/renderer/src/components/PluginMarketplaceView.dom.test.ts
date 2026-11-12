// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CatalogSourceV1,
  InstalledPackageV1,
  MarketplacePackageV1,
  PreparedPluginImportV1
} from '@shared/marketplace'
import type { SkillListItem } from '@shared/workwise-api'
import type { McpServerConfigV2 } from '@shared/agent-workbench'
import i18n from '../i18n'
import { useChatStore } from '../store/chat-store'
import { PluginMarketplaceView } from './PluginMarketplaceView'
import { getOfficialMarketplaceCatalog } from '../../../main/services/official-marketplace-catalog'

const SOURCE: CatalogSourceV1 = {
  schemaVersion: 1,
  id: 'workwise-official',
  name: 'WorkWise Official',
  type: 'built-in',
  scope: 'system',
  location: 'workwise://marketplace/test',
  trust: 'system',
  searchable: true,
  auth: { type: 'none' },
  sync: {
    mode: 'bundled',
    state: 'synced',
    mirroredByDefault: false,
    installedByDefault: false
  }
}

const PRIVATE_SOURCE: CatalogSourceV1 = {
  schemaVersion: 1,
  id: 'private-team',
  name: 'Private Team',
  type: 'https',
  scope: 'team',
  location: 'https://plugins.example.com/marketplace.json',
  trust: 'community',
  searchable: true,
  auth: { type: 'token', secretKey: 'catalog.private-team.token' },
  sync: {
    mode: 'manual',
    state: 'synced',
    mirroredByDefault: false,
    installedByDefault: false
  }
}

function catalogPackage(id: string, version: string): MarketplacePackageV1 {
  const source = {
    id: `${id}-source`,
    catalogSourceId: SOURCE.id,
    kind: 'npm' as const,
    location: `https://www.npmjs.com/package/${id}`,
    packageName: id,
    version,
    resolvedRef: version,
    digest: { algorithm: 'sha512-sri' as const, value: 'sha512-dGVzdA==' }
  }
  return {
    schemaVersion: 1,
    id,
    name: id === 'browser-tools'
      ? 'Browser Tools'
      : id === 'document-tools'
        ? 'Document Tools'
        : 'Advanced Reasoning',
    summary: `Summary for ${id}`,
    productType: 'utility',
    tier: 'recommended',
    categories: [id === 'browser-tools' ? 'browser' : 'documents'],
    version,
    publisher: { id: 'workwise', name: 'WorkWise', verified: true },
    license: 'MIT',
    source,
    sources: [source],
    components: [{
      id: `${id}-mcp`,
      name: id,
      type: 'mcp',
      sourceId: source.id,
      runtime: {
        kind: 'npm',
        packageName: id,
        version,
        executable: id,
        args: [],
        install: {
          strategy: 'managed-download',
          verify: 'sri-before-activation',
          digestSource: 'component-source'
        }
      }
    }],
    permissions: id === 'browser-tools' ? [{
      id: 'browser.control',
      kind: 'browser',
      access: 'control',
      default: 'review',
      reviewRequired: true,
      description: 'Control a browser selected by the user.'
    }] : [],
    auth: { type: 'none' },
    licenseEvidence: [],
    dependencies: [],
    updatePolicy: { strategy: 'pinned', channel: 'stable', allowMajor: false },
    compatibility: { workwise: '>=0.3.5', platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'] },
    availability: { status: 'available' },
    installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
  }
}

function pinnedSkillPackage(id: string): MarketplacePackageV1 {
  const base = catalogPackage(id, 'a'.repeat(40))
  const owner = id === 'browser-skill'
    ? 'Tencent'
    : id === 'blender-skills'
      ? 'arjun988'
      : id === 'video-shotcraft'
        ? 'Vincentwei1021'
      : id === 'diagram-design'
        ? 'cathrynlavery'
        : 'bassnova42'
  const source = {
    ...base.source,
    kind: 'github' as const,
    location: `https://github.com/${owner}/${id}`,
    owner,
    repository: id,
    defaultBranch: 'main',
    requestedRef: 'main',
    resolvedRef: 'a'.repeat(40)
  }
  return {
    ...base,
    name: id,
    tier: 'advanced',
    productType: 'workflow',
    publisher: { id: owner.toLowerCase(), name: owner, verified: false },
    source,
    sources: [source],
    components: [{
      ...base.components[0],
      type: 'skill' as const,
      skillNames: [id],
      runtime: {
        kind: 'github' as const,
        repository: source.location,
        resolvedCommit: source.resolvedRef,
        install: { strategy: 'managed-git' as const, verifyBeforeActivation: true }
      }
    }],
    usage: {
      howToUse: `Use ${id} by describing the task you want to perform.`,
      requirements: ['Node.js'],
      examples: [`Example request for ${id}`]
    }
  }
}

const BROWSER = catalogPackage('browser-tools', '2.0.0')
const DOCUMENTS = catalogPackage('document-tools', '1.0.0')
const ADVANCED = { ...catalogPackage('advanced-reasoning', '1.0.0'), tier: 'advanced' as const }
const MANAGED_KB: MarketplacePackageV1 = {
  ...catalogPackage('railwise-kb', 'managed'),
  name: 'RailWise Knowledge Base',
  productType: 'connector',
  tier: 'advanced',
  components: [{
    id: 'railwise-kb-managed-component',
    name: 'RailWise Knowledge Base',
    type: 'cli',
    sourceId: 'railwise-kb-source',
    runtime: { kind: 'system', provider: 'workwise', capability: 'railwise-kb' }
  }],
  auth: { type: 'tool-managed', provider: 'railwise-kb' },
  updatePolicy: { strategy: 'system-managed', channel: 'managed', allowMajor: false },
  availability: { status: 'managed', managedBy: 'WorkWise' },
  installation: { mode: 'system-managed', installedByDefault: true, reinstallable: false }
}

const INSTALLED: InstalledPackageV1 = {
  schemaVersion: 1,
  packageId: BROWSER.id,
  version: BROWSER.version,
  license: 'MIT',
  reviewSha256: 'a'.repeat(64),
  source: BROWSER.source,
  sources: BROWSER.sources,
  components: BROWSER.components.map((component) => ({ componentId: component.id, sourceId: component.sourceId })),
  scope: 'user',
  artifact: { sha256: 'b'.repeat(64), location: '/tmp/browser-tools', fileCount: 2, totalBytes: 20 },
  permissions: [],
  timestamps: { installedAt: '2026-08-01T00:00:00.000Z' },
  updatePolicy: BROWSER.updatePolicy,
  rollback: { available: false },
  health: { status: 'healthy' }
}

let container: HTMLDivElement
let root: Root
let installPrepared: ReturnType<typeof vi.fn>

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find((candidate) => {
    const content = candidate.textContent?.trim() ?? ''
    return content === text || content.startsWith(text)
  })
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`)
  return result
}

function exactButton(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`)
  return result
}

function iconButton(label: string): HTMLButtonElement {
  const result = container.querySelector(`button[aria-label="${label}"]`)
  if (!(result instanceof HTMLButtonElement)) throw new Error(`Icon button not found: ${label}`)
  return result
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTML input value setter is unavailable.')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  useChatStore.setState({ workspaceRoot: '/tmp/workwise-marketplace-qa', pluginConnectorTarget: null })
  installPrepared = vi.fn(async () => INSTALLED)
  Object.defineProperty(window, 'workwise', {
    configurable: true,
    value: {
      listCatalogSources: vi.fn(async () => [SOURCE]),
      listCatalogCredentialStatuses: vi.fn(async () => []),
      listCatalogPackages: vi.fn(async () => ({
        packages: [
          {
            key: `${SOURCE.id}:${BROWSER.id}`,
            sourceId: SOURCE.id,
            package: BROWSER,
            reviewSha256: 'd'.repeat(64),
            conflicted: false
          },
          { key: `${SOURCE.id}:${DOCUMENTS.id}`, sourceId: SOURCE.id, package: DOCUMENTS, conflicted: false },
          { key: `${SOURCE.id}:${ADVANCED.id}`, sourceId: SOURCE.id, package: ADVANCED, conflicted: false },
          { key: `${SOURCE.id}:${MANAGED_KB.id}`, sourceId: SOURCE.id, package: MANAGED_KB, conflicted: false },
          ...['browser-skill', 'blender-skills', 'video-shotcraft', 'diagram-design', 'arch-diagram-skill'].map((id) => ({
            key: `${SOURCE.id}:${id}`,
            sourceId: SOURCE.id,
            package: pinnedSkillPackage(id),
            conflicted: false
          }))
        ],
        conflicts: []
      })),
      listInstalledPlugins: vi.fn(async () => [INSTALLED]),
      listPluginUpdateDiagnostics: vi.fn(async () => [{
        packageId: BROWSER.id,
        installedVersion: BROWSER.version,
        catalogVersion: BROWSER.version,
        state: 'metadata-refresh' as const,
        message: 'Catalog metadata changed and can be refreshed after review.'
      }]),
      listMcpServers: vi.fn(async () => []),
      listSkills: vi.fn(async () => ({ ok: true as const, generation: 1, skills: [], validationErrors: [] })),
      onSkillsChanged: vi.fn(() => () => undefined),
      pickPluginPackage: vi.fn(async () => ({ canceled: false, path: '/tmp/example.wwx' })),
      preparePluginImport: vi.fn(async (): Promise<PreparedPluginImportV1> => ({
        schemaVersion: 1,
        id: 'prepared-1',
        createdAt: '2026-08-08T00:00:00.000Z',
        expiresAt: '2026-08-08T00:30:00.000Z',
        format: 'wwx',
        package: DOCUMENTS,
        contentSha256: 'c'.repeat(64),
        reviewSha256: 'd'.repeat(64),
        warnings: [],
        compatibility: { workwiseCompatible: true, reasons: [] }
      })),
      prepareCatalogPlugin: vi.fn(async (): Promise<PreparedPluginImportV1> => ({
        schemaVersion: 1,
        id: 'prepared-browser-review',
        createdAt: '2026-08-08T00:00:00.000Z',
        expiresAt: '2026-08-08T00:30:00.000Z',
        format: 'catalog',
        package: BROWSER,
        contentSha256: 'c'.repeat(64),
        reviewSha256: 'd'.repeat(64),
        warnings: [],
        compatibility: { workwiseCompatible: true, reasons: [] }
      })),
      installPreparedPlugin: installPrepared,
      updatePluginPermissions: vi.fn(async () => INSTALLED),
      cancelPluginImport: vi.fn(async () => true),
      upsertCatalogSource: vi.fn(async (source: CatalogSourceV1) => source),
      setCatalogSourceCredential: vi.fn(async (sourceId: string) => ({ sourceId, configured: true, storage: 'keychain' as const })),
      clearCatalogSourceCredential: vi.fn(async (sourceId: string) => ({ sourceId, configured: false })),
      removeCatalogSource: vi.fn(async () => undefined),
      syncCatalogSource: vi.fn(async (sourceId: string) => ({ sourceId, status: 'synced' as const, stale: false })),
      openExternal: vi.fn(async () => undefined)
    } as unknown as typeof window.workwise
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(PluginMarketplaceView)))
  await settle()
  // Existing package-management coverage remains on its explicit Plugins tab.
  await act(async () => exactButton('Plugins').click())
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
  vi.restoreAllMocks()
})

describe('PluginMarketplaceView unified catalog', () => {
  it('routes the GitHub connector to actionable token setup without attempting unregistered OAuth', async () => {
    const github: MarketplacePackageV1 = { ...DOCUMENTS, id: 'github-mcp', name: 'GitHub MCP', productType: 'connector',
      auth: { type: 'oauth', provider: 'github', discovery: 'ready' },
      installation: { mode: 'external', installedByDefault: false, reinstallable: false },
      components: [{ id: 'github-mcp-server', name: 'GitHub', sourceId: DOCUMENTS.source.id, type: 'mcp', runtime: { kind: 'remote', transport: 'streamable-http', endpoint: 'https://api.githubcopilot.com/mcp/' } }] }
    vi.mocked(window.workwise.listCatalogPackages).mockResolvedValue({ packages: [{ key: `${SOURCE.id}:${github.id}`, sourceId: SOURCE.id, package: github, conflicted: false }], conflicts: [] })
    const authorize = vi.fn(), save = vi.fn()
    Object.assign(window.workwise, { authorizeMcpServer: authorize, saveMcpServer: save })
    await act(async () => iconButton('Refresh').click())
    await settle()
    expect(container.querySelector('button[aria-label="GitHub MCP"]')).toBeNull()
    await act(async () => exactButton('Connectors').click())
    await act(async () => iconButton('View GitHub MCP connection').click())
    expect(container.querySelector('[role="dialog"][aria-label="GitHub 连接"]')).not.toBeNull()
    expect(container.textContent).toContain('在 GitHub 创建令牌')
    expect(container.querySelector('input[type="password"]')).not.toBeNull()
    expect(authorize).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('opens Skills by default and orders connectors last while keeping connector deep links', async () => {
    await act(async () => root.render(createElement(PluginMarketplaceView, { key: 'default-tabs' })))
    await settle()
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Skills and connector sections"] > [role="tab"]')]
    expect(tabs.map(tab => tab.textContent)).toEqual(['Skills', 'Plugins', 'Connectors'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(container.textContent).toContain('资料盘点与来源索引')
    expect(window.workwise.installPreparedPlugin).not.toHaveBeenCalled()
  })

  it('preserves installed Lark OpenAPI package source, permissions, and update details behind native setup', async () => {
    const larkPackage: MarketplacePackageV1 = {
      ...MANAGED_KB,
      id: 'lark-openapi-mcp',
      name: 'Lark OpenAPI MCP',
      permissions: [{ id: 'network.connect', kind: 'network', access: 'connect', default: 'review', reviewRequired: true, description: 'Connect only to the selected Lark service.', resources: ['https://open.feishu.cn'] }],
      auth: { type: 'tool-managed', provider: 'lark-cli' },
      installation: { mode: 'system-managed', installedByDefault: false, reinstallable: false }
    }
    const installed = { ...INSTALLED, packageId: larkPackage.id, version: 'legacy-0.5.4', source: larkPackage.source, sources: larkPackage.sources }
    vi.mocked(window.workwise.listCatalogPackages).mockResolvedValue({ packages: [{ key: `${SOURCE.id}:${larkPackage.id}`, sourceId: SOURCE.id, package: larkPackage, conflicted: false }], conflicts: [] })
    vi.mocked(window.workwise.listInstalledPlugins).mockResolvedValue([installed])
    vi.mocked(window.workwise.listPluginUpdateDiagnostics).mockResolvedValue([{ packageId: larkPackage.id, installedVersion: installed.version, catalogVersion: larkPackage.version, state: 'metadata-refresh', message: 'Original metadata review remains visible.' }])
    await act(async () => iconButton('Refresh').click())
    await settle()
    await act(async () => exactButton('Connectors').click())
    await act(async () => iconButton('View Feishu / Lark connection').click())
    const advanced = [...container.querySelectorAll('summary')].find(item => item.textContent === 'Advanced package management')
    expect(advanced).toBeDefined()
    await act(async () => advanced?.click())
    await act(async () => exactButton('Manage Lark OpenAPI MCP package').click())
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect([...container.querySelectorAll('h2')].some(item => item.textContent === 'Lark OpenAPI MCP')).toBe(true)
    expect(container.textContent).toContain('legacy-0.5.4 / managed')
    expect(container.textContent).toContain('Update diagnosis')
    expect(container.textContent).toContain('Review metadata changes')
    expect(container.textContent).toContain('Source')
    expect(container.textContent).toContain('RailWise AI')
    expect(container.textContent).toContain('Permissions')
    expect(container.textContent).toContain('https://open.feishu.cn')
    expect(container.textContent).toContain('Update policy')
    expect(window.workwise.updatePluginPermissions).not.toHaveBeenCalled()
    expect(window.workwise.saveMcpServer).toBeUndefined()
    expect(window.workwise.openExternal).not.toHaveBeenCalled()
  })

  it('opens task capability deep links on the matching connector and consumes the navigation target', async () => {
    await act(async () => {
      useChatStore.getState().openPlugins(undefined, 'dingtalk')
      await Promise.resolve()
    })
    await settle()
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('DingTalk')
    expect(useChatStore.getState().pluginConnectorTarget).toBeNull()
    expect(window.workwise.openExternal).not.toHaveBeenCalled()
    await act(async () => iconButton('Close connector details').click())
    await act(async () => {
      useChatStore.getState().openPlugins()
      await Promise.resolve()
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps connectors, skills, and package management on separate surfaces in one hub', async () => {
    await act(async () => exactButton('Connectors').click())
    expect(container.textContent).toContain('Connect your services')
    expect(container.textContent).toContain('Feishu / Lark')
    expect(container.textContent).toContain('DingTalk')
    expect(container.textContent).toContain('RailWise Knowledge Base')
    expect(container.textContent).not.toContain('Browser Tools')
    expect(container.textContent).not.toContain('arch-diagram-skill')
    expect(container.querySelector('input[placeholder="Search connectors"]')).not.toBeNull()
    await act(async () => exactButton('Custom connector').click())
    expect(useChatStore.getState()).toMatchObject({ route: 'settings', settingsSection: 'mcp' })
    await act(async () => exactButton('Skills').click())
    expect(container.textContent).toContain('Discover skills')
    expect(container.textContent).toContain('arch-diagram-skill')
    expect(container.textContent).not.toContain('Connect your services')
    await act(async () => exactButton('Plugins').click())
    expect(container.textContent).toContain('Browser Tools')
    expect(container.textContent).not.toContain('RailWise Knowledge Base')
    expect(window.workwise.listInstalledPlugins).toHaveBeenCalled()
    expect(window.workwise.listMcpServers).toHaveBeenCalledWith('/tmp/workwise-marketplace-qa')
    expect(window.workwise.updatePluginPermissions).not.toHaveBeenCalled()
  })

  it('shows available-to-install readiness on a new package instead of its version number', () => {
    const row = [...container.querySelectorAll('[role="button"]')].find((candidate) => candidate.textContent?.includes('Document Tools'))
    expect(row?.textContent).toContain('Available to install')
    expect(row?.textContent).not.toContain(DOCUMENTS.version)
  })

  it('keeps unavailable installed packages in Installed and reports availability consistently in details', async () => {
    const unavailable: MarketplacePackageV1 = {
      ...BROWSER,
      availability: { status: 'unavailable', reasonCode: 'catalog_retired', message: 'The catalog no longer distributes this version.' }
    }
    vi.mocked(window.workwise.listCatalogPackages).mockResolvedValue({
      packages: [{ key: `${SOURCE.id}:${BROWSER.id}`, sourceId: SOURCE.id, package: unavailable, conflicted: false }],
      conflicts: []
    })
    vi.mocked(window.workwise.listPluginUpdateDiagnostics).mockResolvedValue([])
    const saveServer = vi.fn()
    Object.assign(window.workwise, { saveMcpServer: saveServer })
    await act(async () => iconButton('Refresh').click())
    await settle()

    const row = [...container.querySelectorAll('[role="button"]')].find((candidate) => candidate.textContent?.includes('Browser Tools'))
    expect(row?.textContent).toContain('Installed · currently unavailable')
    expect(row?.querySelector('.text-emerald-700')).toBeNull()
    await act(async () => exactButton('Open source').click())
    expect(window.workwise.openExternal).toHaveBeenCalledWith(BROWSER.source.location)
    expect(window.workwise.prepareCatalogPlugin).not.toHaveBeenCalled()
    await act(async () => button('Installed').click())
    expect(container.textContent).toContain('Browser Tools')
    const installedRow = [...container.querySelectorAll('[role="button"]')].find((candidate) => candidate.textContent?.includes('Browser Tools'))
    await act(async () => (installedRow as HTMLElement).click())
    expect(container.textContent?.match(/Installed · currently unavailable/g)).toHaveLength(2)
    expect(container.textContent).toContain('Installation health')
    expect(container.textContent).toContain('healthy')
    expect(window.workwise.listInstalledPlugins).toHaveBeenLastCalledWith()
    expect(saveServer).not.toHaveBeenCalled()
    expect(window.workwise.updatePluginPermissions).not.toHaveBeenCalled()
    expect(installPrepared).not.toHaveBeenCalled()
  })

  it('includes unconfigured external services in configuration counts and never treats an OAuth reference as authorization', async () => {
    const connector: MarketplacePackageV1 = {
      ...DOCUMENTS,
      id: 'service-connector',
      name: 'Service Connector',
      auth: { type: 'oauth', provider: 'service', discovery: 'ready' },
      installation: { mode: 'external', installedByDefault: false, reinstallable: false },
      components: [{ id: 'service-mcp', name: 'Service', sourceId: DOCUMENTS.source.id, type: 'mcp', runtime: { kind: 'remote', transport: 'streamable-http', endpoint: 'https://service.example/mcp' } }]
    }
    vi.mocked(window.workwise.listCatalogPackages).mockResolvedValue({
      packages: [{ key: `${SOURCE.id}:${connector.id}`, sourceId: SOURCE.id, package: connector, conflicted: false }],
      conflicts: []
    })
    vi.mocked(window.workwise.listInstalledPlugins).mockResolvedValue([])
    vi.mocked(window.workwise.listPluginUpdateDiagnostics).mockResolvedValue([])
    const testServer = vi.fn()
    Object.assign(window.workwise, { testMcpServer: testServer })
    await act(async () => iconButton('Refresh').click())
    await settle()
    expect(container.textContent).toContain('Needs configuration')
    await act(async () => iconButton('Filters').click())
    await act(async () => button('Needs configuration').click())
    expect(container.textContent).toContain('Service Connector')

    const server: McpServerConfigV2 = { id: connector.id, name: connector.name, scope: 'global', transport: 'http', url: 'https://service.example/mcp', timeoutMs: 30_000, source: 'managed-tool', enabled: true, toolPolicy: {}, revision: 1, credentialRef: { id: 'credential-reference', storage: 'keychain' } }
    vi.mocked(window.workwise.listMcpServers).mockResolvedValue([server])
    vi.mocked(window.workwise.listInstalledPlugins).mockResolvedValue([{ ...INSTALLED, packageId: connector.id }])
    await act(async () => iconButton('Refresh').click())
    await settle()
    await act(async () => button('Installed').click())
    const row = [...container.querySelectorAll('[role="button"]')].find((candidate) => candidate.textContent?.includes('Service Connector'))
    expect(row?.textContent).toContain('Configured · verification pending')
    expect(row?.textContent).not.toContain('Authorized')
    expect(row?.querySelector('.text-emerald-700')).toBeNull()
    expect(server.enabled).toBe(true)
    expect(testServer).not.toHaveBeenCalled()

    await act(async () => i18n.changeLanguage('zh'))
    await settle()
    expect(container.textContent).toContain('已配置 · 待验证授权')
    server.connectionCheck = { serverRevision: server.revision, credentialRefId: server.credentialRef!.id,
      configurationHash: 'a'.repeat(64), checkedAt: '2026-11-12T01:02:03.000Z', state: 'connected', authorized: true, verification: 'tool_discovery', toolCount: 11 }
    await act(async () => iconButton(i18n.t('common:pluginUnifiedRefresh')).click())
    await settle()
    expect(container.textContent).toContain('连接检查通过（11 项工具）')
    expect(container.textContent).toContain(new Date(server.connectionCheck.checkedAt).toLocaleString())
    expect(container.textContent).not.toContain('已配置 · 待验证授权')
    server.connectionCheck = { ...server.connectionCheck, state: 'error', authorized: false, errorCode: 'connection_failed' }
    await act(async () => iconButton(i18n.t('common:pluginUnifiedRefresh')).click())
    await settle()
    expect(container.textContent).toContain('连接检查未通过')
    expect(container.textContent).not.toContain('连接检查通过（')
    expect(testServer).not.toHaveBeenCalled()
  })

  it('keeps local Skill counts off the plugin surface and exposes installed product-level entries', () => {
    expect(container.textContent).not.toContain('local Skills indexed')
    expect(container.textContent).toContain('Installed')
    expect(container.textContent).not.toContain('RailWise Knowledge Base')
    expect(container.textContent).not.toContain('MCP')
    expect(container.querySelector('button[aria-label="Browser Tools"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Filters"]')).not.toBeNull()
    expect(container.textContent).toContain('All plugins')
    expect(container.textContent).toContain('Updates')
    expect(container.querySelector('.ds-opaque-work-surface')).not.toBeNull()
    expect(container.querySelector('.backdrop-blur-xl')).toBeNull()
  })

  it('keeps the built-in catalog visible when an auxiliary marketplace read fails', async () => {
    vi.mocked(window.workwise.listCatalogSources).mockRejectedValueOnce(new Error('fetch failed'))
    vi.mocked(window.workwise.listMcpServers).mockRejectedValueOnce(new Error('fetch failed'))

    await act(async () => iconButton('Refresh').click())
    await settle()

    expect(container.textContent).toContain('Browser Tools')
    expect(container.textContent).toContain('Featured catalog remains available offline')
    expect(container.textContent).not.toContain('The download source could not be reached')
  })

  it('shows managed connectors as installed and managed in details', async () => {
    await act(async () => exactButton('Connectors').click())
    const managed = container.querySelector('button[aria-label="View RailWise Knowledge Base connection"]')
    if (!(managed instanceof HTMLButtonElement)) throw new Error('Managed connector was not rendered.')
    await act(async () => managed.click())

    expect(container.textContent).toContain('RailWise AI managed connector')
    expect(container.textContent).toContain('installed · RailWise AI managed')
    expect(container.textContent).toContain('Managed with RailWise AI releases')
    expect(container.textContent).not.toContain('not installed')
  })

  it('exposes the complete catalog and searches advanced packages from the featured view', async () => {
    expect(container.textContent).not.toContain('Advanced Reasoning')
    await act(async () => button('All plugins').click())
    expect(container.textContent).toContain('Advanced Reasoning')

    await act(async () => button('Featured').click())
    const search = container.querySelector(
      'input[placeholder="Search plugins, publishers, and capabilities"]'
    )
    if (!(search instanceof HTMLInputElement)) throw new Error('Plugin search input was not rendered.')
    await act(async () => setInput(search, 'Advanced Reasoning'))
    expect(container.textContent).toContain('Advanced Reasoning')
    expect(button('All plugins').getAttribute('aria-selected')).toBe('true')
  })

  it('shows the five pinned GitHub Skills on the default plugin surface', () => {
    for (const name of ['browser-skill', 'blender-skills', 'video-shotcraft', 'diagram-design', 'arch-diagram-skill']) {
      expect(container.textContent).toContain(name)
    }
  })

  it('shows featured recommendations on the default Skills overview', async () => {
    vi.mocked(window.workwise.listSkills).mockResolvedValue({
      ok: true,
      generation: 3,
      skills: [
        {
          id: 'ppt-master',
          name: 'PPT Master',
          description: 'Create and refine editable presentations.',
          root: '/Users/test/.workwise/tools/skills/ppt-master',
          entryPath: '/Users/test/.workwise/tools/skills/ppt-master/SKILL.md',
          scope: 'global',
          legacy: false,
          source: { type: 'bundled', id: 'ppt-master', autoUpdate: false }
        },
        {
          id: 'report-writing',
          name: 'Report Writing',
          description: 'Draft clear technical reports.',
          root: '/Users/test/.codex/skills/report-writing',
          entryPath: '/Users/test/.codex/skills/report-writing/SKILL.md',
          scope: 'global',
          legacy: false,
          source: { type: 'bundled', id: 'report-writing', autoUpdate: false }
        }
      ],
      validationErrors: []
    })
    await act(async () => iconButton('Refresh').click())
    await settle()
    await act(async () => button('Skills').click())
    expect(container.textContent).toContain('Featured recommendations')
    expect(container.textContent).toContain('PPT Master')
    expect(container.textContent).toContain('Report Writing')
  })

  it('shows installable AutoCAD skills with offline metadata and a fixed upstream source link', async () => {
    const items = getOfficialMarketplaceCatalog().filter(item => item.id.startsWith('autocad-'))
    vi.mocked(window.workwise.listCatalogPackages).mockResolvedValue({ packages: items.map(item => ({
      key: `${SOURCE.id}:${item.id}`, sourceId: SOURCE.id, package: item, conflicted: false
    })), conflicts: [] })
    vi.mocked(window.workwise.listCatalogSources).mockRejectedValueOnce(new Error('fetch failed'))
    await act(async () => iconButton('Refresh').click())
    await settle()
    await act(async () => exactButton('Skills').click())
    expect(container.textContent).toContain('AutoCAD DWG 重绘')
    expect(container.textContent).toContain('图片转 CAD 重绘')
    expect(container.textContent).toContain('Available to install')
    expect([...container.querySelectorAll('button')].filter(item => item.textContent === 'Install from upstream')).toHaveLength(2)
    const row = [...container.querySelectorAll('[role="button"]')].find(item => item.textContent?.includes('AutoCAD DWG 重绘'))
    if (!(row instanceof HTMLElement)) throw new Error('AutoCAD skill catalog row missing')
    await act(async () => row.click())
    const drawer = container.querySelector('aside')
    expect(drawer?.parentElement?.classList.contains('ds-connector-overlay')).toBe(true)
    expect(drawer?.querySelector('header h2')?.textContent).toBe('AutoCAD DWG 重绘')
    expect(container.textContent).toContain('上游未声明分发许可证')
    expect(container.textContent).toContain('未保存文档')
    expect(container.textContent).toContain('pywin32')
    expect(container.textContent).toContain('The upstream repository has no declared license.')
    await act(async () => exactButton('Open source').click())
    expect(window.workwise.openExternal).toHaveBeenCalledWith(items[0]!.source.location)
    expect(window.workwise.prepareCatalogPlugin).not.toHaveBeenCalled()
    expect(installPrepared).not.toHaveBeenCalled()
    expect(window.workwise.updatePluginPermissions).not.toHaveBeenCalled()
    await act(async () => iconButton('Close').click())
    expect(container.querySelector('aside')).toBeNull()
  })

  it.each(['autocad-dwg-redraw', 'autocad-image-redraw'])('installs %s through the existing upstream preview and permission lifecycle', async id => {
    const item = getOfficialMarketplaceCatalog().find(candidate => candidate.id === id)!
    const installed: InstalledPackageV1 = { ...INSTALLED, packageId: item.id, version: item.version,
      license: item.license, source: item.source, sources: item.sources, updatePolicy: item.updatePolicy,
      components: item.components.map(component => ({ componentId: component.id, sourceId: component.sourceId })) }
    vi.mocked(window.workwise.listCatalogPackages).mockResolvedValue({ packages: [{ key: `${SOURCE.id}:${id}`, sourceId: SOURCE.id,
      package: item, reviewSha256: 'd'.repeat(64), conflicted: false }], conflicts: [] })
    vi.mocked(window.workwise.prepareCatalogPlugin).mockResolvedValue({ schemaVersion: 1, id: `prepared-${id}`,
      createdAt: '2026-11-11T00:00:00.000Z', expiresAt: '2026-11-11T00:30:00.000Z', format: 'catalog', package: item,
      contentSha256: item.source.digest!.value, reviewSha256: 'd'.repeat(64), warnings: [],
      compatibility: { workwiseCompatible: true, reasons: [] } })
    installPrepared.mockImplementation(async () => {
      vi.mocked(window.workwise.listInstalledPlugins).mockResolvedValue([INSTALLED, installed])
      return installed
    })
    await act(async () => iconButton('Refresh').click())
    await settle()
    await act(async () => exactButton('Skills').click())
    await act(async () => { await i18n.changeLanguage('zh') })
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(candidate => candidate.textContent?.includes(item.name))!
    expect(row.textContent).toContain('可安装')
    await act(async () => row.click())
    expect(container.textContent).toContain('上游未声明许可证')
    for (const dependency of item.dependencies) expect(container.textContent).toContain(dependency.requirement)
    expect(container.textContent).toContain(item.usage!.examples![0])
    const action = [...container.querySelectorAll('button')].filter(candidate => candidate.textContent === '从上游安装').at(-1)!
    await act(async () => action.click())
    await settle()
    expect(window.workwise.prepareCatalogPlugin).toHaveBeenCalledExactlyOnceWith({ sourceId: SOURCE.id, packageId: id })
    expect(container.textContent).toContain(item.source.digest!.value)
    expect(container.textContent).toContain('上游未声明许可证')
    expect(installPrepared).not.toHaveBeenCalled()
    const permissions = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(permissions).toHaveLength(item.permissions.length)
    expect(permissions.every(permission => !permission.checked)).toBe(true)
    const readIndex = item.permissions.findIndex(permission => permission.id === 'filesystem.read')
    await act(async () => permissions[readIndex]!.click())
    const install = [...container.querySelectorAll('button')].filter(candidate => candidate.textContent === '从上游安装').at(-1)!
    expect(install.disabled).toBe(false)
    await act(async () => install.click())
    await settle()
    expect(installPrepared).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ preparedId: `prepared-${id}`,
      reviewSha256: 'd'.repeat(64), expectedCurrentVersion: null, scope: 'workspace', workspaceRoot: '/tmp/workwise-marketplace-qa',
      permissions: item.permissions.map(permission => ({ permissionId: permission.id, decision: permission.id === 'filesystem.read' ? 'granted' : 'denied' })) }))
    expect(window.workwise.cancelPluginImport).toHaveBeenCalledWith(`prepared-${id}`)
    expect(container.textContent).toContain(`已安装 ${item.name}`)
    const installedRow = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(candidate => candidate.textContent?.includes(item.name))!
    expect(installedRow.textContent).toContain('已安装')
    expect(installedRow.textContent).toContain('权限')
    expect(window.workwise.openExternal).not.toHaveBeenCalled()
    expect(window.workwise.updatePluginPermissions).not.toHaveBeenCalled()
    expect((await window.workwise.listInstalledPlugins()).find(record => record.packageId === INSTALLED.packageId)).toBe(INSTALLED)
  })

  it('shows a clear usage guide, requirements, and example in Skill details', async () => {
    const row = [...container.querySelectorAll('[role="button"]')].find((item) => item.textContent?.includes('arch-diagram-skill'))
    if (!(row instanceof HTMLElement)) throw new Error('Arch Diagram catalog row was not rendered.')
    await act(async () => row.click())
    expect(container.textContent).toContain('How to use')
    expect(container.textContent).toContain('Use arch-diagram-skill by describing the task you want to perform.')
    expect(container.textContent).toContain('Node.js')
    expect(container.textContent).toContain('Example request for arch-diagram-skill')
  })

  it('indexes large local Skill sets without flattening them into the default marketplace view', async () => {
    const indexedSkills = Array.from({ length: 200 }, (_, index): SkillListItem => ({
      id: `skill-${index}`,
      name: `Indexed Skill ${index}`,
      description: `Capability ${index}`,
      root: index < 180
        ? `/Users/test/.codex/plugins/cache/example/skills/skill-${index}`
        : `/Users/test/.codex/skills/skill-${index}`,
      entryPath: index < 180
        ? `/Users/test/.codex/plugins/cache/example/skills/skill-${index}/SKILL.md`
        : `/Users/test/.codex/skills/skill-${index}/SKILL.md`,
      scope: 'global',
      legacy: false
    }))
    vi.mocked(window.workwise.listSkills).mockResolvedValue({
      ok: true,
      generation: 2,
      skills: indexedSkills,
      validationErrors: []
    })

    await act(async () => iconButton('Refresh').click())
    await settle()
    await act(async () => button('Skills').click())

    expect(container.textContent).toContain('200 Skills indexed')
    expect(container.textContent).not.toContain('Indexed Skill 199')
    const search = container.querySelector(
      'input[placeholder="Search indexed Skills by name or capability"]'
    )
    if (!(search instanceof HTMLInputElement)) throw new Error('Skill search input was not rendered.')
    await act(async () => setInput(search, 'Indexed Skill 199'))
    expect(container.textContent).toContain('Indexed Skill 199')
    expect(container.textContent).toContain('1 matching Skills')
  })

  it('uses main-process install state and isolates update results', async () => {
    expect(container.textContent).toContain('Browser Tools')
    expect(container.textContent).toContain('Document Tools')
    expect(container.textContent).toContain('Review metadata changes')
    expect(container.textContent).toContain('Review update')

    await act(async () => iconButton('Filters').click())
    await act(async () => button('Updates').click())
    expect(container.textContent).toContain('Browser Tools')
    expect(container.textContent).not.toContain('Document Tools')
  })

  it('reviews same-version catalog changes through the permission transaction', async () => {
    await act(async () => button('Review update').click())
    await settle()
    expect(container.textContent).toContain('Review Browser Tools')
    await act(async () => button('Apply').click())
    await settle()

    expect(window.workwise.updatePluginPermissions).toHaveBeenCalledWith({
      packageId: BROWSER.id,
      expectedCurrentVersion: BROWSER.version,
      reviewSha256: 'd'.repeat(64),
      permissions: [{ permissionId: 'browser.control', decision: 'denied' }],
      idempotencyKey: expect.any(String)
    })
    expect(installPrepared).not.toHaveBeenCalled()
  })

  it('does not include runtime drift in Updates or expose an update action', async () => {
    vi.mocked(window.workwise.listPluginUpdateDiagnostics).mockResolvedValue([{
      packageId: BROWSER.id,
      installedVersion: BROWSER.version,
      catalogVersion: BROWSER.version,
      state: 'runtime-drift',
      message: 'Runtime or provenance metadata changed without a package version update.'
    }])
    await act(async () => iconButton('Refresh').click())
    await settle()

    expect(container.textContent).toContain('Complete update required')
    await act(async () => iconButton('Filters').click())
    await act(async () => button('Updates').click())
    expect(container.textContent).not.toContain('Browser Tools')
    expect(installPrepared).not.toHaveBeenCalled()
  })

  it('labels the installed direct-mirror action as permission management', async () => {
    vi.mocked(window.workwise.listPluginUpdateDiagnostics).mockResolvedValue([{
      packageId: BROWSER.id,
      installedVersion: BROWSER.version,
      catalogVersion: BROWSER.version,
      state: 'current',
      message: 'The installed package matches the current catalog review.'
    }])
    vi.mocked(window.workwise.listCatalogPackages).mockResolvedValue({
      packages: [
        {
          key: `${SOURCE.id}:${BROWSER.id}`,
          sourceId: SOURCE.id,
          package: BROWSER,
          reviewSha256: INSTALLED.reviewSha256,
          conflicted: false
        },
        { key: `${SOURCE.id}:${DOCUMENTS.id}`, sourceId: SOURCE.id, package: DOCUMENTS, conflicted: false }
      ],
      conflicts: []
    })

    await act(async () => iconButton('Refresh').click())
    await settle()

    const permissions = exactButton('Permissions')
    expect(permissions.querySelector('.lucide-sliders-horizontal')).not.toBeNull()
    await act(async () => permissions.click())
    await settle()
    expect(container.textContent).toContain('Review Browser Tools')
  })

  it('imports a package through review and installs with explicit permission decisions', async () => {
    await act(async () => button('Add plugin').click())
    await act(async () => button('WWX or MCPB package').click())
    await settle()
    expect(container.textContent).toContain('Review Document Tools')
    const installButtons = [...container.querySelectorAll('button')]
      .filter((candidate) => candidate.textContent?.trim() === 'Install')
    const reviewInstall = installButtons.at(-1)
    if (!(reviewInstall instanceof HTMLButtonElement)) throw new Error('Review install button was not rendered.')
    await act(async () => reviewInstall.click())
    await settle()
    expect(installPrepared).toHaveBeenCalledWith(expect.objectContaining({
      preparedId: 'prepared-1',
      expectedCurrentVersion: null,
      scope: 'workspace',
      permissions: []
    }))
  })

  it('adds a private catalog without putting its token in catalog metadata', async () => {
    await act(async () => iconButton('Catalog sources').click())
    await act(async () => exactButton('Add source').click())
    const name = container.querySelector('input[placeholder="Catalog name"]')
    const location = container.querySelector('input[placeholder="https://..."]')
    const privateToggle = [...container.querySelectorAll('label')]
      .find((label) => label.textContent?.includes('Private catalog'))
      ?.querySelector('input[type="checkbox"]')
    if (!(name instanceof HTMLInputElement) || !(location instanceof HTMLInputElement) ||
        !(privateToggle instanceof HTMLInputElement)) throw new Error('Private source inputs were not rendered.')
    await act(async () => setInput(name, 'Internal Catalog'))
    await act(async () => setInput(location, 'https://github.com/acme/internal-plugins'))
    await act(async () => privateToggle.click())
    const token = container.querySelector('input[placeholder="Access token"]')
    if (!(token instanceof HTMLInputElement)) throw new Error('Private source token input was not rendered.')
    await act(async () => setInput(token, 'private-renderer-token'))
    await act(async () => exactButton('Add').click())
    await settle()

    const upsert = vi.mocked(window.workwise.upsertCatalogSource)
    const savedSource = upsert.mock.calls[0]?.[0]
    expect(savedSource?.auth).toMatchObject({ type: 'token' })
    expect(JSON.stringify(savedSource)).not.toContain('private-renderer-token')
    expect(window.workwise.setCatalogSourceCredential).toHaveBeenCalledWith(
      savedSource?.id,
      'private-renderer-token'
    )
    expect(window.workwise.syncCatalogSource).toHaveBeenCalledWith(savedSource?.id)
  })

  it('updates and clears an existing private catalog credential', async () => {
    vi.mocked(window.workwise.listCatalogSources).mockResolvedValue([SOURCE, PRIVATE_SOURCE])
    vi.mocked(window.workwise.listCatalogCredentialStatuses).mockResolvedValue([{
      sourceId: PRIVATE_SOURCE.id,
      configured: true,
      storage: 'keychain'
    }])
    await act(async () => iconButton('Refresh').click())
    await settle()
    await act(async () => iconButton('Catalog sources').click())
    expect(container.textContent).toContain('Credential configured')

    await act(async () => iconButton('Configure credential').click())
    const token = container.querySelector('input[placeholder="Access token"]')
    if (!(token instanceof HTMLInputElement)) throw new Error('Credential editor was not rendered.')
    await act(async () => setInput(token, 'rotated-token'))
    await act(async () => exactButton('Save').click())
    await settle()
    expect(window.workwise.setCatalogSourceCredential).toHaveBeenCalledWith(PRIVATE_SOURCE.id, 'rotated-token')

    await act(async () => iconButton('Configure credential').click())
    await act(async () => exactButton('Clear').click())
    await settle()
    expect(window.workwise.clearCatalogSourceCredential).toHaveBeenCalledWith(PRIVATE_SOURCE.id)
  })
})
