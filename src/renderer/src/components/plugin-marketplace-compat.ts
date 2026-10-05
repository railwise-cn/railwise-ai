import type {
  CoreRuntimeToolDiagnosticsJson
} from '../agent/runtime-contract'
import type { ManagedToolStatus, SkillListItem } from '@shared/workwise-api'
import brand from '@shared/product-brand.json'

type JsonRecord = Record<string, unknown>

export type LegacyMarketplaceItem = {
  id: string
  kind: 'mcp' | 'skill' | 'cli'
  title?: string
  description?: string
  group: 'recommended' | 'personal'
  sourceLabel?: string
  sourceUrl?: string
  statusTone?: 'default' | 'success' | 'warning' | 'error'
}

const MARKETPLACE_TEXT_FALLBACKS: Record<string, string> = {
  pluginSkillAgentReachTitle: 'Agent Reach',
  pluginSkillDocumentIllustratorTitle: 'Document Illustrator',
  pluginCommercialLicenseRequired: 'Commercial license required',
  pluginNoRedistributionLicense: 'No redistribution license',
  pluginDetailExternalProject: `External project · not installed by ${brand.platform}`,
  pluginCliLarkTitle: 'Lark CLI',
  pluginSkillScanOversized: 'Skipped Skill “{{skill}}”: {{file}} exceeds the {{limit}} discovery limit. Other Skills are unaffected.'
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMcpJsonConfig(content: string): JsonRecord {
  const trimmed = content.trim()
  if (!trimmed) return {}
  const parsed = JSON.parse(trimmed) as unknown
  if (!isJsonRecord(parsed)) throw new Error('MCP config must be a JSON object.')
  return parsed
}

function mcpServersFromConfig(config: JsonRecord): JsonRecord {
  if (isJsonRecord(config.servers)) return config.servers
  const capabilities = isJsonRecord(config.capabilities) ? config.capabilities : undefined
  const mcp = isJsonRecord(capabilities?.mcp) ? capabilities.mcp : undefined
  return isJsonRecord(mcp?.servers) ? mcp.servers : {}
}

function buildStdioMcpServer(
  command: string,
  args: string[],
  options: {
    trustScope?: 'workspace' | 'user'
    trustedWorkspaceRoots?: string[]
    env?: JsonRecord
  } = {}
): JsonRecord {
  const trustScope = options.trustScope ?? 'user'
  return {
    enabled: true,
    transport: 'stdio',
    command,
    args,
    env: options.env ?? {},
    trustScope,
    ...(trustScope === 'workspace'
      ? {
          trustedWorkspaceRoots: options.trustedWorkspaceRoots?.length
            ? options.trustedWorkspaceRoots
            : ['/path/to/workspace']
        }
      : {}),
    timeoutMs: 30_000
  }
}

export function buildMcpConfig(
  id: string,
  command: string,
  args: string[],
  options?: Parameters<typeof buildStdioMcpServer>[2]
): JsonRecord {
  return { servers: { [id]: buildStdioMcpServer(command, args, options) } }
}

export function mcpConfigHasServer(content: string, id: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(mcpServersFromConfig(parseMcpJsonConfig(content)), id)
  } catch {
    return false
  }
}

export function customMcpConfigFragment(id: string, raw: string, fallback: JsonRecord): JsonRecord {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  const parsed = parseMcpJsonConfig(trimmed)
  if (isJsonRecord(parsed.servers)) return parsed
  if (isJsonRecord(parsed.capabilities)) {
    const mcp = isJsonRecord(parsed.capabilities.mcp) ? parsed.capabilities.mcp : undefined
    if (isJsonRecord(mcp?.servers)) return { servers: mcp.servers }
  }
  if (parsed.command !== undefined || parsed.url !== undefined || parsed.transport !== undefined) {
    return { servers: { [id]: parsed } }
  }
  throw new Error('MCP JSON config must include a servers object or a single server object.')
}

export function mergeMcpJsonConfig(
  content: string,
  fragment: JsonRecord
): { alreadyExists: boolean; text: string } {
  const current = parseMcpJsonConfig(content)
  const currentServers = mcpServersFromConfig(current)
  const fragmentServers = mcpServersFromConfig(fragment)
  const ids = Object.keys(fragmentServers)
  if (ids.length === 0) throw new Error('MCP JSON config must include at least one server.')
  const alreadyExists = ids.some((id) => Object.prototype.hasOwnProperty.call(currentServers, id))
  if (alreadyExists) return { alreadyExists: true, text: `${JSON.stringify(current, null, 2)}\n` }
  const rest = { ...fragment }
  delete rest.servers
  return {
    alreadyExists: false,
    text: `${JSON.stringify({
      ...current,
      ...rest,
      servers: { ...currentServers, ...fragmentServers }
    }, null, 2)}\n`
  }
}

function githubSkillUrl(skill: Extract<NonNullable<SkillListItem['source']>, { type: 'github' }>): string {
  const ref = skill.ref?.trim() || 'main'
  const path = skill.path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const encodedPath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const base = `https://github.com/${skill.owner.trim()}/${skill.repo.trim()}`
  return encodedPath ? `${base}/tree/${encodeURIComponent(ref)}/${encodedPath}` : base
}

export function skillMarketplaceItemsFromDiscoveredSkills(
  skills: SkillListItem[],
  labels: { project: string; global: string; github: string; bundled: string }
): LegacyMarketplaceItem[] {
  return skills.map((skill) => ({
    id: skill.id,
    kind: 'skill',
    title: skill.name,
    description: skill.description ?? skill.root,
    group: 'personal',
    sourceLabel:
      skill.source?.type === 'github' ? labels.github :
      skill.source?.type === 'bundled' ? labels.bundled :
      skill.scope === 'project' ? labels.project : labels.global,
    ...(skill.source?.type === 'github' ? { sourceUrl: githubSkillUrl(skill.source) } : {}),
    statusTone: skill.source ? 'success' : 'default'
  }))
}

function mcpServerDescription(server: JsonRecord | undefined, fallback: string): string {
  if (!server) return fallback
  const fields = [
    typeof server.status === 'string' ? `status: ${server.status}` : '',
    typeof server.transport === 'string' ? server.transport : '',
    typeof server.command === 'string' ? server.command : typeof server.url === 'string' ? server.url : '',
    typeof server.toolCount === 'number' ? `${server.toolCount} tools` : '',
    typeof server.lastError === 'string' ? `error: ${server.lastError}` : ''
  ].filter(Boolean)
  return fields.length ? fields.join(' · ') : fallback
}

export function mcpMarketplaceItemsFromConfigAndDiagnostics(
  configText: string,
  diagnostics: CoreRuntimeToolDiagnosticsJson | null,
  labels: {
    configured: string
    connected: string
    error: string
    disabled: string
    authRequired: string
  }
): LegacyMarketplaceItem[] {
  const records = new Map<string, { config?: JsonRecord; diagnostic?: JsonRecord }>()
  try {
    for (const [id, value] of Object.entries(mcpServersFromConfig(parseMcpJsonConfig(configText)))) {
      records.set(id, { config: isJsonRecord(value) ? value : {} })
    }
  } catch {
    // Preserve diagnostics even when the legacy JSON cannot be parsed.
  }
  for (const value of diagnostics?.mcpServers ?? []) {
    const diagnostic = value as JsonRecord
    const id = typeof diagnostic.id === 'string' ? diagnostic.id.trim() : ''
    if (!id) continue
    records.set(id, { ...records.get(id), diagnostic })
  }
  return [...records.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
    const status = typeof value.diagnostic?.status === 'string'
      ? value.diagnostic.status
      : value.config?.enabled === false ? 'disabled' : 'configured'
    const authRequired = value.diagnostic?.authRequired === true
    return {
      id,
      kind: 'mcp',
      title: id,
      description: mcpServerDescription({ ...value.config, ...value.diagnostic }, id),
      group: 'personal',
      sourceLabel: authRequired
        ? labels.authRequired
        : status === 'connected' ? labels.connected
        : status === 'error' ? labels.error
        : status === 'disabled' ? labels.disabled
        : labels.configured,
      statusTone: authRequired || status === 'disabled'
        ? 'warning'
        : status === 'connected' ? 'success'
        : status === 'error' ? 'error'
        : 'default'
    }
  })
}

export function managedToolStatusIsInstalled(status: ManagedToolStatus | undefined): boolean {
  if (!status) return false
  if (status.state === 'installed' || status.state === 'needs_login' || status.state === 'update_available') {
    return true
  }
  return status.state === 'error' && Boolean(status.executablePath)
}

export function marketplaceText(t: (key: string) => string, key: string, fallback = ''): string {
  const value = t(key)
  return value && value !== key ? value : MARKETPLACE_TEXT_FALLBACKS[key] ?? fallback
}

export function friendlyMarketplaceError(message: string, t: (key: string) => string): string {
  const normalized = message.trim()
  if (/Unsafe Skill package:.*file exceeds/i.test(normalized)) {
    return marketplaceText(t, 'pluginErrorUnsafeSkillTooLarge', 'Skill package contains an oversized file.')
  }
  if (/Unsafe Skill package/i.test(normalized)) {
    return marketplaceText(t, 'pluginErrorUnsafeSkill', 'Skill package did not pass the safety check.')
  }
  if (/\bfetch failed\b|network|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(normalized)) {
    return marketplaceText(t, 'pluginErrorNetwork', 'The download source could not be reached.')
  }
  return normalized
}

export function skillValidationWarning(root: string, message: string, t: (key: string) => string): string {
  const skill = root.replace(/\\/g, '/').replace(/\/+$/g, '').split('/').pop() || root
  const oversized = /file exceeds\s+([^:]+):\s*(.+?)\.?$/i.exec(message.trim())
  if (!oversized) return friendlyMarketplaceError(message, t)
  return marketplaceText(t, 'pluginSkillScanOversized', MARKETPLACE_TEXT_FALLBACKS.pluginSkillScanOversized)
    .replaceAll('{{skill}}', skill)
    .replaceAll('{{file}}', oversized[2] ?? '')
    .replaceAll('{{limit}}', oversized[1] ?? '')
}

export function mcpRuntimeErrorHint(
  message: string,
  serverId: string | undefined,
  t: (key: string) => string
): string {
  const normalized = `${serverId ?? ''} ${message}`.toLowerCase()
  if (/subscription_token_invalid|brave/.test(normalized)) return t('pluginMcpRuntimeHintBrave')
  if (/github/.test(normalized)) return t('pluginMcpRuntimeHintGithub')
  if (/spawn|\bnpx?\b.*enoent|enoent.*\bnpx?\b/.test(message.toLowerCase())) {
    return t('pluginMcpRuntimeHintNode')
  }
  if (/filesystem|path\/to|enoent.*(?:directory|folder)/.test(normalized)) {
    return t('pluginMcpRuntimeHintFilesystem')
  }
  if (/puppeteer|chromium/.test(normalized)) return t('pluginMcpRuntimeHintPuppeteer')
  return t('pluginMcpRuntimeHintNode')
}
