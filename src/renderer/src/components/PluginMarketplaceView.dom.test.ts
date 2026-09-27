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
import i18n from '../i18n'
import { useChatStore } from '../store/chat-store'
import { PluginMarketplaceView } from './PluginMarketplaceView'

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
  await i18n.changeLanguage('en')
  useChatStore.setState({ workspaceRoot: '/tmp/workwise-marketplace-qa' })
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
          { key: `${SOURCE.id}:${MANAGED_KB.id}`, sourceId: SOURCE.id, package: MANAGED_KB, conflicted: false }
        ],
        conflicts: []
      })),
      listInstalledPlugins: vi.fn(async () => [INSTALLED]),
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
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
  vi.restoreAllMocks()
})

describe('PluginMarketplaceView unified catalog', () => {
  it('keeps local Skill counts off the plugin surface and exposes installed product-level entries', () => {
    expect(container.textContent).not.toContain('local Skills indexed')
    expect(container.textContent).toContain('Installed')
    expect(container.textContent).toContain('Connector')
    expect(container.textContent).not.toContain('MCP')
    expect(container.querySelector('button[aria-label="Browser Tools"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Filters"]')).not.toBeNull()
    expect(container.textContent).toContain('All plugins')
    expect(container.textContent).toContain('Updates')
    expect(container.querySelector('.ds-opaque-work-surface')).not.toBeNull()
    expect(container.querySelector('.backdrop-blur-xl')).toBeNull()
  })

  it('shows managed connectors as installed and managed in details', async () => {
    const managed = container.querySelector('button[aria-label="RailWise Knowledge Base"]')
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
    expect(container.textContent).toContain('Permissions changed')
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

  it('labels the installed direct-mirror action as permission management', async () => {
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
