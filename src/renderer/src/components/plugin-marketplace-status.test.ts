import { describe, expect, it } from 'vitest'
import type { McpServerConfigV2 } from '@shared/agent-workbench'
import type { InstalledPackageV1, MarketplacePackageV1, PluginUpdateDiagnosticV1 } from '@shared/marketplace'
import { marketplaceNeedsConfiguration, marketplacePackageStatus } from './plugin-marketplace-status'

const item = {
  availability: { status: 'available' },
  installation: { mode: 'direct-mirror', installedByDefault: false },
  auth: { type: 'none' }
} as MarketplacePackageV1
const installed = { health: { status: 'healthy' } } as InstalledPackageV1
const server = { enabled: true, credentialRef: { id: 'local-ref', storage: 'keychain' } } as McpServerConfigV2

describe('marketplace package readiness', () => {
  it('shows an actionable install state instead of a version for a package not yet installed', () => {
    expect(marketplacePackageStatus(item)).toEqual({ state: 'available', tone: 'neutral' })
    expect(marketplaceNeedsConfiguration(item)).toBe(false)
  })

  it('keeps installation distinct from the catalog availability', () => {
    const unavailable = { ...item, availability: { status: 'unavailable', reasonCode: 'offline', message: 'Not currently distributed' } } as MarketplacePackageV1
    expect(marketplacePackageStatus(unavailable)).toEqual({ state: 'unavailable', tone: 'neutral' })
    expect(marketplacePackageStatus(unavailable, installed)).toEqual({ state: 'installed_unavailable', tone: 'attention' })
    expect(installed.health.status).toBe('healthy')
    expect(server.enabled).toBe(true)
  })

  it('retains an installed record when only its update source is unavailable', () => {
    const diagnostic = { state: 'unavailable' } as PluginUpdateDiagnosticV1
    expect(marketplacePackageStatus(item, installed, server, diagnostic)).toEqual({ state: 'installed_source_unavailable', tone: 'attention' })
  })

  it('requires configuration for an unconfigured external service and includes it in the configuration filter', () => {
    const external = { ...item, installation: { mode: 'external', installedByDefault: false }, auth: { type: 'oauth', provider: 'service', discovery: 'ready' } } as MarketplacePackageV1
    expect(marketplacePackageStatus(external)).toEqual({ state: 'configuration', tone: 'attention' })
    expect(marketplaceNeedsConfiguration(external)).toBe(true)
  })

  it.each(['oauth', 'token'] as const)('never treats a %s credential reference or healthy package as verified authorization', (type) => {
    const authenticated = { ...item, auth: { type, provider: 'service' } } as MarketplacePackageV1
    expect(marketplacePackageStatus(authenticated, installed, server)).toEqual({ state: 'configured_unverified', tone: 'neutral' })
    expect(marketplacePackageStatus(authenticated, installed, { ...server, credentialRef: undefined })).toEqual({ state: 'configuration', tone: 'attention' })
  })

  it('requires attention for disabled or unhealthy configurations without removing installation facts', () => {
    expect(marketplacePackageStatus(item, installed, { ...server, enabled: false }).state).toBe('configuration')
    expect(marketplacePackageStatus(item, { ...installed, health: { status: 'unhealthy' } }, server).state).toBe('configuration')
    expect(marketplacePackageStatus(item, installed, server).state).toBe('installed')
  })

  it('reports managed installation without claiming remote authentication', () => {
    const managed = { ...item, installation: { mode: 'system-managed', installedByDefault: true }, auth: { type: 'tool-managed', provider: 'managed-service' } } as MarketplacePackageV1
    expect(marketplacePackageStatus(managed)).toEqual({ state: 'installed', tone: 'success' })
  })
})
