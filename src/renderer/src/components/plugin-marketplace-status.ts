import type { McpServerConfigV2 } from '@shared/agent-workbench'
import type { InstalledPackageV1, MarketplacePackageV1, PluginUpdateDiagnosticV1 } from '@shared/marketplace'
import { currentMcpConnectionCheck, mcpToolDiscoveryPassed } from '@shared/mcp-connection-check'

export type MarketplacePackageStatus = {
  state: 'available' | 'installed' | 'configuration' | 'configured_unverified' | 'connection_checked' | 'connection_failed' |
    'unavailable' | 'installed_unavailable' | 'source_unavailable' | 'installed_source_unavailable' |
    'runtime_drift' | 'metadata_refresh' | 'update_available'
  tone: 'success' | 'attention' | 'neutral'
}

export function marketplaceNeedsConfiguration(
  item: MarketplacePackageV1,
  record?: InstalledPackageV1,
  server?: McpServerConfigV2
): boolean {
  const added = Boolean(record || server || (item.installation.mode === 'system-managed' && item.installation.installedByDefault))
  if (!added) return item.installation.mode === 'external'
  if (server?.enabled === false || record?.health.status === 'degraded' || record?.health.status === 'unhealthy') return true
  if (item.auth.type === 'token' || item.auth.type === 'oauth') return !server?.credentialRef
  return Boolean(item.configuration?.some((field) => field.required && field.defaultValue === undefined))
}

/** Projects local catalog/configuration facts, never infers live authorization from a credential reference. */
export function marketplacePackageStatus(
  item: MarketplacePackageV1,
  record?: InstalledPackageV1,
  server?: McpServerConfigV2,
  diagnostic?: PluginUpdateDiagnosticV1
): MarketplacePackageStatus {
  const added = Boolean(record || server || (item.installation.mode === 'system-managed' && item.installation.installedByDefault))
  if (item.availability.status === 'unavailable') {
    return { state: added ? 'installed_unavailable' : 'unavailable', tone: added ? 'attention' : 'neutral' }
  }
  if (diagnostic?.state === 'unavailable') {
    return { state: added ? 'installed_source_unavailable' : 'source_unavailable', tone: 'attention' }
  }
  if (diagnostic?.state === 'runtime-drift') return { state: 'runtime_drift', tone: 'attention' }
  if (marketplaceNeedsConfiguration(item, record, server)) return { state: 'configuration', tone: 'attention' }
  const check = currentMcpConnectionCheck(server)
  if (mcpToolDiscoveryPassed(server)) return { state: 'connection_checked', tone: 'success' }
  if (check && (check.state !== 'connected' || !check.authorized)) return { state: 'connection_failed', tone: 'attention' }
  // Install health validates package files, not the remote account, token lifetime, or granted scopes.
  if (added && (item.auth.type === 'oauth' || item.auth.type === 'token')) {
    return { state: 'configured_unverified', tone: 'neutral' }
  }
  if (diagnostic?.state === 'metadata-refresh') return { state: 'metadata_refresh', tone: 'attention' }
  if (diagnostic?.state === 'update-available') return { state: 'update_available', tone: 'attention' }
  if (added) return { state: 'installed', tone: 'success' }
  return { state: 'available', tone: 'neutral' }
}
