import { ProductIcon } from './ProductIcon'
import type { ReactElement, ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Download,
  ExternalLink,
  FolderOpen,
  Import,
  KeyRound,
  Loader2,
  Package as PackageIcon,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Settings2,
  Sparkles,
  Terminal,
  Trash2,
  X
} from 'lucide-react'
import type {
  CatalogCredentialStatusV1,
  CatalogSourceV1,
  InstalledPackagePermissionV1,
  InstalledPackageV1,
  MarketplaceIconV1,
  MarketplaceCatalogPackageEntryV1,
  MarketplacePackageV1,
  MarketplaceProductTypeV1,
  PackagePermissionV1,
  PreparedPluginImportV1
} from '@shared/marketplace'
import type { SkillListItem } from '@shared/workwise-api'
import type { McpServerConfigV2 } from '@shared/agent-workbench'
import brand from '@shared/product-brand.json'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import { useChatStore } from '../store/chat-store'
import { friendlyMarketplaceError } from './plugin-marketplace-compat'

export * from './plugin-marketplace-compat'

type StatusFilter = 'recommended' | 'all' | 'installed' | 'updates' | 'configuration'
type MarketplaceView = 'plugins' | 'skills'
type AudienceFilter = 'official' | 'personal' | 'team'
type SkillBrowseFilter = 'overview' | 'workwise' | 'personal' | 'project' | 'integrations' | 'attention'
type SkillGroupCounts = Record<Exclude<SkillBrowseFilter, 'overview'>, number>
type Text = (key: string, fallback: string, values?: Record<string, unknown>) => string
type Notice = { tone: 'success' | 'error' | 'info'; message: string }
type PermissionSelections = Record<string, boolean>
type SourceDraft = {
  type: 'github' | 'git' | 'https' | 'local' | 'project'
  name: string
  location: string
  scope: 'user' | 'workspace' | 'team'
  defaultBranch: string
  requiresToken: boolean
  token: string
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function packageKey(entry: MarketplaceCatalogPackageEntryV1): string {
  return `${entry.sourceId}:${entry.package.id}`
}

function componentTypes(item: MarketplacePackageV1): string[] {
  return [...new Set(item.components.map((component) => component.type))]
}

function isManagedConnector(item: MarketplacePackageV1): boolean {
  return item.installation.mode === 'system-managed' && productType(item) === 'connector'
}

function packageDisplayName(item: MarketplacePackageV1, text: Text): string {
  return text(`pluginCatalogPackage_${item.id}_name`, item.name)
}

function packageDisplaySummary(item: MarketplacePackageV1, text: Text): string {
  return text(`pluginCatalogPackage_${item.id}_summary`, item.summary)
}

function sourceLabel(source: CatalogSourceV1 | undefined, fallback: string, text: Text): string {
  const id = source?.id || fallback
  return text(`pluginCatalogSource_${id}`, source?.name || fallback)
}

function permissionKindLabel(kind: PackagePermissionV1['kind'], text: Text): string {
  return text(`pluginPermissionKind_${kind}`, kind)
}

function permissionAccessLabel(access: PackagePermissionV1['access'], text: Text): string {
  return text(`pluginPermissionAccess_${access}`, access)
}

function permissionDescription(permission: PackagePermissionV1, text: Text): string {
  return text(`pluginPermission_${permission.id.replace(/[^a-z0-9]+/gi, '_')}_description`, permission.description)
}

function updatePolicyLabel(item: MarketplacePackageV1, text: Text): string {
  const strategy = text(`pluginUpdateStrategy_${item.updatePolicy.strategy}`, item.updatePolicy.strategy)
  const channel = text(`pluginUpdateChannel_${item.updatePolicy.channel}`, item.updatePolicy.channel)
  return `${strategy} · ${channel}`
}

function packageHealthLabel(status: string, text: Text): string {
  return text(`pluginHealth_${status.replace(/[^a-z0-9]+/gi, '_')}`, status)
}

function isHttpUrl(value: string): boolean {
  return /^https:\/\//i.test(value)
}

function installedServerForPackage(
  item: MarketplacePackageV1,
  servers: McpServerConfigV2[]
): McpServerConfigV2 | undefined {
  const mcpIds = new Set(item.components.filter((component) => component.type === 'mcp').map((component) => component.id))
  return servers.find((server) => server.id === item.id || mcpIds.has(server.id))
}

function isManagedInstalled(item: MarketplacePackageV1): boolean {
  return item.installation.mode === 'system-managed' && item.installation.installedByDefault
}

function isInstalled(
  item: MarketplacePackageV1,
  installed: Map<string, InstalledPackageV1>,
  servers: McpServerConfigV2[]
): boolean {
  return installed.has(item.id) || isManagedInstalled(item) || Boolean(installedServerForPackage(item, servers))
}

function hasUpdate(
  item: MarketplacePackageV1,
  record: InstalledPackageV1 | undefined,
  reviewSha256?: string
): boolean {
  return Boolean(record && item.availability.status === 'available' &&
    (record.version !== item.version || (reviewSha256 && record.reviewSha256 !== reviewSha256)))
}

function needsConfiguration(
  item: MarketplacePackageV1,
  record: InstalledPackageV1 | undefined,
  server: McpServerConfigV2 | undefined
): boolean {
  if (!record && !server && !isManagedInstalled(item)) return false
  if (server?.enabled === false) return true
  if (record?.health.status === 'degraded' || record?.health.status === 'unhealthy') return true
  if (item.auth.type === 'token') return !server?.credentialRef
  if (item.auth.type === 'oauth') return !server?.credentialRef
  return Boolean(item.configuration?.some((field) => field.required && field.defaultValue === undefined))
}

function permissionExpanded(
  item: MarketplacePackageV1,
  record: InstalledPackageV1 | undefined,
  reviewSha256?: string
): boolean {
  if (!record) return false
  const reviewed = new Set(record.permissions.map((permission) => permission.permissionId))
  return Boolean((reviewSha256 && record.reviewSha256 !== reviewSha256) ||
    item.permissions.some((permission) => !reviewed.has(permission.id)))
}

function defaultPermissions(item: MarketplacePackageV1): PermissionSelections {
  return Object.fromEntries(item.permissions.map((permission) => [
    permission.id,
    permission.default === 'granted'
  ]))
}

function reviewedPermissions(
  item: MarketplacePackageV1,
  record: InstalledPackageV1 | undefined
): PermissionSelections {
  const selections = defaultPermissions(item)
  for (const permission of record?.permissions ?? []) {
    if (permission.permissionId in selections) {
      selections[permission.permissionId] = permission.decision === 'granted'
    }
  }
  return selections
}

function catalogSourceFromDraft(draft: SourceDraft): CatalogSourceV1 {
  const idBase = draft.name.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'catalog'
  const id = `${idBase}-${uuid().slice(0, 8)}`
  const base = {
    schemaVersion: 1 as const,
    id,
    name: draft.name.trim(),
    scope: draft.type === 'project' ? 'workspace' as const : draft.scope,
    location: draft.location.trim(),
    trust: draft.scope === 'team' ? 'community' as const : 'unverified' as const,
    searchable: true,
    auth: draft.requiresToken
      ? { type: 'token' as const, secretKey: `catalog.${id}.token` }
      : { type: 'none' as const },
    sync: {
      mode: draft.type === 'local' || draft.type === 'project' ? 'watched' as const : 'manual' as const,
      state: 'idle' as const,
      mirroredByDefault: false,
      installedByDefault: false
    }
  }
  if (draft.type === 'github') {
    const parsed = new URL(draft.location)
    const [owner, repository] = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || !owner || !repository) {
      throw new Error('GitHub catalog URL must identify a repository on github.com.')
    }
    return {
      ...base,
      type: 'github',
      owner,
      repository: repository.replace(/\.git$/i, ''),
      defaultBranch: draft.defaultBranch.trim() || 'main'
    }
  }
  if (draft.type === 'git') return { ...base, type: 'git', defaultBranch: draft.defaultBranch.trim() || 'main' }
  if (draft.type === 'https') return { ...base, type: 'https' }
  if (draft.type === 'project') return { ...base, type: 'project', scope: 'workspace', auth: { type: 'none' } }
  return { ...base, type: 'local', auth: { type: 'none' } }
}

function statusTone(tone: Notice['tone']): string {
  if (tone === 'error') return 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200'
  if (tone === 'success') return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200'
  return 'border-ds-border bg-ds-subtle text-ds-muted'
}

function skillSourceUrl(skill: SkillListItem): string | null {
  if (skill.source?.type !== 'github') return null
  const path = skill.source.path ? `/${skill.source.path.replace(/^\/+/, '')}` : ''
  return `https://github.com/${skill.source.owner}/${skill.source.repo}/tree/${encodeURIComponent(skill.source.ref)}${path}`
}

const SKILL_RESULT_LIMIT = 50
const MARKETPLACE_CATEGORY_ORDER = [
  'development',
  'documents',
  'writing',
  'productivity',
  'data',
  'collaboration',
  'engineering'
] as const
const FEATURED_PACKAGE_IDS = ['github-mcp', 'playwright-mcp', 'context7-mcp', 'markitdown'] as const

function marketplaceCollection(item: MarketplacePackageV1): string {
  if (item.collections?.[0]) return item.collections[0]
  const legacy = item.categories?.[0]
  if (legacy === 'browser' || legacy === 'browser-automation' || legacy === 'system') return 'productivity'
  if (legacy === 'agent-workflows' || legacy === 'knowledge') return 'development'
  if (legacy === 'visualization') return 'data'
  return legacy ?? 'productivity'
}

function marketplaceCategoryLabel(category: string, text: Text): string {
  const labels: Record<string, string> = {
    featured: text('pluginCategoryFeatured', 'Featured'),
    development: text('pluginCategoryDevelopment', 'Development & debugging'),
    productivity: text('pluginCategoryProductivity', 'Productivity & automation'),
    data: text('pluginCategoryData', 'Data & visualization'),
    documents: text('pluginCategoryDocuments', 'Documents & reports'),
    writing: text('pluginCategoryWriting', 'Writing & editing'),
    collaboration: text('pluginCategoryCollaboration', 'Team collaboration'),
    engineering: text('pluginCategoryEngineering', 'Engineering & monitoring'),
    'browser-automation': text('pluginCategoryProductivity', 'Productivity & automation'),
    browser: text('pluginCategoryProductivity', 'Productivity & automation'),
    'agent-workflows': text('pluginCategoryDevelopment', 'Development & code'),
    knowledge: text('pluginCategoryDevelopment', 'Development & code'),
    visualization: text('pluginCategoryData', 'Data & databases'),
    system: text('pluginCategoryProductivity', 'Productivity & automation'),
    other: text('pluginCategoryOther', 'Other')
  }
  return labels[category] ?? category
}

function sourceAudience(source: CatalogSourceV1 | undefined): AudienceFilter {
  if (source?.trust === 'system' || source?.trust === 'official') return 'official'
  if (source?.scope === 'user') return 'personal'
  return 'team'
}

function normalizedSkillRoot(skill: SkillListItem): string {
  return skill.root.replace(/\\/g, '/').toLowerCase()
}

function skillMatchesGroup(
  skill: SkillListItem,
  filter: Exclude<SkillBrowseFilter, 'overview'>,
  invalidRoots: Set<string>,
  duplicateNames: Set<string>
): boolean {
  const root = normalizedSkillRoot(skill)
  const name = (skill.name || skill.id).trim().toLowerCase()
  const integration = root.includes('/.codex/plugins/cache/')
  const workwise = skill.source?.type === 'bundled' ||
    root.includes('/.workwise/') ||
    root.includes('/contents/resources/app.asar')

  if (filter === 'workwise') return workwise
  if (filter === 'project') return skill.scope === 'project'
  if (filter === 'integrations') return integration
  if (filter === 'attention') return invalidRoots.has(skill.root) || duplicateNames.has(name)
  return skill.scope === 'global' && !workwise && !integration
}

export function PluginMarketplaceView(): ReactElement {
  const { t } = useTranslation('common')
  const text = useCallback<Text>((key, fallback, values) => {
    const translated = t(key, { defaultValue: fallback, ...values })
    return typeof translated === 'string' ? translated : fallback
  }, [t])
  const workspaceRoot = normalizeWorkspaceRoot(useChatStore((state) => state.workspaceRoot))
  const [sources, setSources] = useState<CatalogSourceV1[]>([])
  const [catalogCredentials, setCatalogCredentials] = useState<CatalogCredentialStatusV1[]>([])
  const [entries, setEntries] = useState<MarketplaceCatalogPackageEntryV1[]>([])
  const [installedPackages, setInstalledPackages] = useState<InstalledPackageV1[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerConfigV2[]>([])
  const [skills, setSkills] = useState<SkillListItem[]>([])
  const [skillValidationErrors, setSkillValidationErrors] = useState<Array<{ root: string; message: string }>>([])
  const [skillCount, setSkillCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('recommended')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [audienceFilter, setAudienceFilter] = useState<AudienceFilter>('official')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [prepared, setPrepared] = useState<PreparedPluginImportV1 | null>(null)
  const [permissions, setPermissions] = useState<PermissionSelections>({})
  const [scope, setScope] = useState<'user' | 'workspace' | 'team'>('user')
  const [oauth, setOauth] = useState<{
    serverId: string
    state: string
    url: string
    code: string
    callback: 'loopback' | 'manual'
  } | null>(null)
  const [viewMode, setViewMode] = useState<MarketplaceView>('plugins')
  const [skillFilter, setSkillFilter] = useState<SkillBrowseFilter>('overview')

  const installed = useMemo(
    () => new Map(installedPackages.map((item) => [item.packageId, item])),
    [installedPackages]
  )
  const sourceMap = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources])

  const refresh = useCallback(async (showSpinner = false): Promise<void> => {
    if (showSpinner) setLoading(true)
    try {
      const [catalogSources, catalog, packageRecords, servers, skills, credentialStatuses] = await Promise.all([
        window.workwise.listCatalogSources(),
        window.workwise.listCatalogPackages(),
        window.workwise.listInstalledPlugins(),
        window.workwise.listMcpServers(workspaceRoot || undefined),
        window.workwise.listSkills(workspaceRoot || undefined).catch(() => null),
        window.workwise.listCatalogCredentialStatuses()
      ])
      setSources(catalogSources)
      setEntries(catalog.packages)
      setInstalledPackages(packageRecords)
      setMcpServers(servers)
      setCatalogCredentials(credentialStatuses)
      if (skills?.ok) {
        setSkills(skills.skills)
        setSkillCount(skills.skills.length)
        setSkillValidationErrors(skills.validationErrors)
      }
      if (catalog.conflicts.length > 0) {
        setNotice({
          tone: 'info',
          message: text(
            'pluginUnifiedCatalogConflicts',
            '{{count}} package name conflicts are isolated by source.',
            { count: catalog.conflicts.length }
          )
        })
      }
    } catch (error) {
      setNotice({
        tone: 'error',
        message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t)
      })
    } finally {
      setLoading(false)
    }
  }, [t, text, workspaceRoot])

  useEffect(() => {
    void refresh(true)
  }, [refresh])

  useEffect(() => window.workwise.onSkillsChanged(() => {
    void window.workwise.listSkills(workspaceRoot || undefined)
      .then((result) => {
        if (result.ok) {
          setSkills(result.skills)
          setSkillCount(result.skills.length)
          setSkillValidationErrors(result.validationErrors)
        }
      })
      .catch(() => undefined)
  }), [workspaceRoot])

  const categories = useMemo(() => {
    const available = new Set(
      entries
        .flatMap((entry) => [marketplaceCollection(entry.package)])
    )
    return [
      ...MARKETPLACE_CATEGORY_ORDER.filter((category) => available.delete(category)),
      ...[...available].sort()
    ]
  }, [entries])
  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      const item = entry.package
      const record = installed.get(item.id)
      const server = installedServerForPackage(item, mcpServers)
      const added = isInstalled(item, installed, mcpServers)
      if (sourceAudience(sourceMap.get(entry.sourceId)) !== audienceFilter) return false
      if (sourceFilter !== 'all' && entry.sourceId !== sourceFilter) return false
      if (categoryFilter !== 'all' && marketplaceCollection(item) !== categoryFilter) return false
      if (statusFilter === 'recommended' && item.tier !== 'recommended') return false
      if (statusFilter === 'installed' && !added) return false
      if (statusFilter === 'updates' && !hasUpdate(item, record, entry.reviewSha256)) return false
      if (statusFilter === 'configuration' && !needsConfiguration(item, record, server)) return false
      if (!needle) return true
      return [
        packageDisplayName(item, text),
        packageDisplaySummary(item, text),
        item.publisher.name,
        item.id,
        sourceLabel(sourceMap.get(entry.sourceId), entry.sourceId, text),
        ...componentTypes(item),
        ...(item.categories ?? []),
        ...(item.collections ?? []),
        item.productType ?? ''
      ].some((value) => value.toLowerCase().includes(needle))
    }).sort((left, right) => {
      const leftInstalled = isInstalled(left.package, installed, mcpServers) ? 0 : 1
      const rightInstalled = isInstalled(right.package, installed, mcpServers) ? 0 : 1
      if (leftInstalled !== rightInstalled) return leftInstalled - rightInstalled
      if (left.package.tier !== right.package.tier) return left.package.tier === 'recommended' ? -1 : 1
      return left.package.name.localeCompare(right.package.name)
    })
  }, [audienceFilter, categoryFilter, entries, installed, mcpServers, query, sourceFilter, sourceMap, statusFilter, text])

  const installedEntries = useMemo(
    () => entries.filter((entry) => isInstalled(entry.package, installed, mcpServers)),
    [entries, installed, mcpServers]
  )

  const statusCounts = useMemo<Record<StatusFilter, number>>(() => {
    const scoped = entries.filter((entry) => {
      if (sourceAudience(sourceMap.get(entry.sourceId)) !== audienceFilter) return false
      return sourceFilter === 'all' || entry.sourceId === sourceFilter
    })
    return {
      recommended: scoped.filter((entry) => entry.package.tier === 'recommended').length,
      all: scoped.length,
      installed: scoped.filter((entry) => isInstalled(entry.package, installed, mcpServers)).length,
      updates: scoped.filter((entry) => hasUpdate(
        entry.package,
        installed.get(entry.package.id),
        entry.reviewSha256
      )).length,
      configuration: scoped.filter((entry) => needsConfiguration(
        entry.package,
        installed.get(entry.package.id),
        installedServerForPackage(entry.package, mcpServers)
      )).length
    }
  }, [audienceFilter, entries, installed, mcpServers, sourceFilter, sourceMap])

  const visibleEntryGroups = useMemo(() => {
    const showFeatured = categoryFilter === 'all' && statusFilter === 'recommended' && !query.trim()
    const preferred = showFeatured
      ? visibleEntries.filter((entry) => FEATURED_PACKAGE_IDS.includes(entry.package.id as typeof FEATURED_PACKAGE_IDS[number])).slice(0, 4)
      : []
    const featured = preferred.length ? preferred : showFeatured ? visibleEntries.slice(0, 2) : []
    const featuredKeys = new Set(featured.map(packageKey))
    const grouped = new Map<string, MarketplaceCatalogPackageEntryV1[]>()
    for (const entry of visibleEntries.filter((entry) => !featuredKeys.has(packageKey(entry)))) {
      const category = marketplaceCollection(entry.package)
      const group = grouped.get(category) ?? []
      group.push(entry)
      grouped.set(category, group)
    }
    const order = [
      ...MARKETPLACE_CATEGORY_ORDER,
      ...[...grouped.keys()].filter((category) => !MARKETPLACE_CATEGORY_ORDER.includes(
        category as typeof MARKETPLACE_CATEGORY_ORDER[number]
      )).sort()
    ]
    const categoryGroups = order.flatMap((category) => {
      const packages = grouped.get(category)
      return packages?.length ? [{ category, packages }] : []
    })
    return featured.length ? [{ category: 'featured', packages: featured }, ...categoryGroups] : categoryGroups
  }, [categoryFilter, query, statusFilter, visibleEntries])

  const duplicateSkillNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const skill of skills) {
      const name = (skill.name || skill.id).trim().toLowerCase()
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name))
  }, [skills])

  const invalidSkillRoots = useMemo(
    () => new Set(skillValidationErrors.map((item) => item.root)),
    [skillValidationErrors]
  )

  const skillGroupCounts = useMemo<SkillGroupCounts>(() => ({
    workwise: skills.filter((skill) => skillMatchesGroup(skill, 'workwise', invalidSkillRoots, duplicateSkillNames)).length,
    personal: skills.filter((skill) => skillMatchesGroup(skill, 'personal', invalidSkillRoots, duplicateSkillNames)).length,
    project: skills.filter((skill) => skillMatchesGroup(skill, 'project', invalidSkillRoots, duplicateSkillNames)).length,
    integrations: skills.filter((skill) => skillMatchesGroup(skill, 'integrations', invalidSkillRoots, duplicateSkillNames)).length,
    attention: skills.filter((skill) => skillMatchesGroup(skill, 'attention', invalidSkillRoots, duplicateSkillNames)).length
  }), [duplicateSkillNames, invalidSkillRoots, skills])

  const matchingSkills = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle && skillFilter === 'overview') return []
    return skills.filter((skill) => {
      if (skillFilter !== 'overview' && !skillMatchesGroup(
        skill,
        skillFilter,
        invalidSkillRoots,
        duplicateSkillNames
      )) return false
      if (!needle) return true
      return [skill.name, skill.id, skill.description ?? '', skill.root, skill.scope, skill.source?.type ?? '']
        .some((value) => value.toLowerCase().includes(needle))
    }).sort((left, right) => {
      const leftInvalid = invalidSkillRoots.has(left.root) ? 1 : 0
      const rightInvalid = invalidSkillRoots.has(right.root) ? 1 : 0
      if (leftInvalid !== rightInvalid) return leftInvalid - rightInvalid
      return (left.name || left.id).localeCompare(right.name || right.id)
    })
  }, [duplicateSkillNames, invalidSkillRoots, query, skillFilter, skills])

  const visibleSkills = useMemo(
    () => matchingSkills.slice(0, SKILL_RESULT_LIMIT),
    [matchingSkills]
  )

  const selected = entries.find((entry) => packageKey(entry) === selectedKey) ?? visibleEntries[0]

  useEffect(() => {
    if (!selectedKey && visibleEntries[0]) setSelectedKey(packageKey(visibleEntries[0]))
  }, [selectedKey, visibleEntries])

  const openPrepared = useCallback((value: PreparedPluginImportV1): void => {
    const current = installed.get(value.package.id)
    setPrepared(value)
    setPermissions(reviewedPermissions(value.package, current))
    setScope(current?.scope === 'workspace' || current?.scope === 'team' || current?.scope === 'user'
      ? current.scope
      : workspaceRoot ? 'workspace' : 'user')
    setImportOpen(false)
    setDetailsOpen(false)
  }, [installed, workspaceRoot])

  const prepareCatalog = async (entry: MarketplaceCatalogPackageEntryV1): Promise<void> => {
    const key = packageKey(entry)
    setBusy(key)
    setNotice(null)
    try {
      openPrepared(await window.workwise.prepareCatalogPlugin({
        sourceId: entry.sourceId,
        packageId: entry.package.id
      }))
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t) })
    } finally {
      setBusy('')
    }
  }

  const importPackage = async (mode: 'file' | 'directory'): Promise<void> => {
    setBusy(`import:${mode}`)
    setNotice(null)
    try {
      const picked = await window.workwise.pickPluginPackage(mode)
      if (picked.canceled || !picked.path) return
      const lower = picked.path.toLowerCase()
      const format = mode === 'directory' ? 'codex' : lower.endsWith('.mcpb') ? 'mcpb' : 'wwx'
      openPrepared(await window.workwise.preparePluginImport({ sourcePath: picked.path, format }))
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t) })
    } finally {
      setBusy('')
    }
  }

  const closePrepared = async (): Promise<void> => {
    const current = prepared
    setPrepared(null)
    if (current) await window.workwise.cancelPluginImport(current.id).catch(() => undefined)
  }

  const installPrepared = async (): Promise<void> => {
    if (!prepared) return
    setBusy(`prepared:${prepared.id}`)
    try {
      const current = installed.get(prepared.package.id)
      if (current?.version === prepared.package.version && prepared.format === 'catalog') {
        await window.workwise.updatePluginPermissions({
          packageId: prepared.package.id,
          expectedCurrentVersion: current.version,
          reviewSha256: prepared.reviewSha256,
          ...(current.workspaceRoot ? { workspaceRoot: current.workspaceRoot } : {}),
          permissions: prepared.package.permissions.map((permission): InstalledPackagePermissionV1 => ({
            permissionId: permission.id,
            decision: permissions[permission.id] ? 'granted' : 'denied'
          })),
          idempotencyKey: uuid()
        })
      } else {
        await window.workwise.installPreparedPlugin({
          preparedId: prepared.id,
          reviewSha256: prepared.reviewSha256,
          expectedCurrentVersion: current?.version ?? null,
          scope,
          ...(scope === 'workspace' && workspaceRoot ? { workspaceRoot } : {}),
          permissions: prepared.package.permissions.map((permission): InstalledPackagePermissionV1 => ({
            permissionId: permission.id,
            decision: permissions[permission.id] ? 'granted' : 'denied'
          })),
          idempotencyKey: uuid()
        })
      }
      await window.workwise.cancelPluginImport(prepared.id).catch(() => false)
      setPrepared(null)
      setNotice({
        tone: 'success',
        message: text(
          current?.version === prepared.package.version ? 'pluginUnifiedPermissionsUpdated' : 'pluginUnifiedInstalled',
          current?.version === prepared.package.version ? '{{name}} permissions updated.' : '{{name}} installed.',
          { name: prepared.package.name }
        )
      })
      await refresh()
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t) })
    } finally {
      setBusy('')
    }
  }

  const rollback = async (record: InstalledPackageV1): Promise<void> => {
    setBusy(`rollback:${record.packageId}`)
    try {
      await window.workwise.rollbackPlugin({
        packageId: record.packageId,
        expectedCurrentVersion: record.version,
        idempotencyKey: uuid()
      })
      setNotice({ tone: 'success', message: text('pluginUnifiedRolledBack', '{{name}} rolled back.', { name: record.packageId }) })
      await refresh()
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t) })
    } finally {
      setBusy('')
    }
  }

  const connectRemote = async (item: MarketplacePackageV1): Promise<void> => {
    const component = item.components.find((candidate) =>
      candidate.type === 'mcp' && candidate.runtime.kind === 'remote'
    )
    if (!component || component.type !== 'mcp' || component.runtime.kind !== 'remote') return
    setBusy(`connect:${item.id}`)
    try {
      const existing = installedServerForPackage(item, mcpServers)
      const saved = await window.workwise.saveMcpServer({
        config: {
          id: item.id,
          name: item.name,
          scope: 'global',
          transport: 'http',
          url: component.runtime.endpoint,
          timeoutMs: 30_000,
          source: 'managed-tool',
          ...(item.auth.type === 'oauth'
            ? {
                oauth: {
                  resource: component.runtime.oauthResource ?? component.runtime.endpoint,
                  redirectUri: 'http://127.0.0.1:17864/oauth/callback',
                  scopes: item.auth.scopes ?? []
                }
              }
            : {}),
          toolPolicy: {},
          enabled: true,
          revision: existing?.revision
        },
        expectedRevision: existing?.revision ?? 0,
        idempotencyKey: uuid()
      })
      if (item.auth.type === 'oauth') {
        const authorization = await window.workwise.authorizeMcpServer({
          serverId: saved.id,
          useLocalCallback: true
        })
        if (authorization.authorizationUrl && authorization.authorizationState) {
          setOauth({
            serverId: saved.id,
            state: authorization.authorizationState,
            url: authorization.authorizationUrl,
            code: '',
            callback: authorization.authorizationCallback ?? 'manual'
          })
          await window.workwise.openExternal(authorization.authorizationUrl)
          if (authorization.authorizationCallback === 'loopback') {
            const result = await window.workwise.waitForMcpAuthorization(
              saved.id,
              authorization.authorizationState
            )
            if (result.state !== 'connected') {
              throw new Error(result.message || 'OAuth authorization failed.')
            }
            setOauth(null)
          } else {
            setNotice({ tone: 'info', message: authorization.message || text('pluginUnifiedOauthTitle', 'Complete authorization') })
            await refresh()
            return
          }
        }
      }
      setNotice({ tone: 'success', message: text('pluginUnifiedConnected', '{{name}} connected to MCP V2.', { name: item.name }) })
      await refresh()
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t) })
    } finally {
      setBusy('')
    }
  }

  const finishOauth = async (): Promise<void> => {
    if (!oauth?.code.trim()) return
    setBusy(`oauth:${oauth.serverId}`)
    try {
      const result = await window.workwise.authorizeMcpServer({
        serverId: oauth.serverId,
        state: oauth.state,
        authorizationCode: oauth.code.trim()
      })
      if (result.state !== 'connected') throw new Error(result.message || 'OAuth authorization failed.')
      setOauth(null)
      setNotice({ tone: 'success', message: text('pluginUnifiedAuthorized', 'Authorization completed.') })
      await refresh()
    } catch (error) {
      setNotice({ tone: 'error', message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t) })
    } finally {
      setBusy('')
    }
  }

  const invokePrimaryAction = async (entry: MarketplaceCatalogPackageEntryV1): Promise<void> => {
    const item = entry.package
    if (item.installation.mode === 'direct-mirror') {
      await prepareCatalog(entry)
      return
    }
    if (item.components.some((component) => component.type === 'mcp' && component.runtime.kind === 'remote') &&
        item.availability.status === 'available') {
      await connectRemote(item)
      return
    }
    if (isHttpUrl(item.source.location)) await window.workwise.openExternal(item.source.location)
  }

  return (
    <div className="ds-no-drag ds-opaque-work-surface flex h-full min-h-0 flex-col bg-ds-page text-ds-ink">
      <header className="shrink-0 border-b border-ds-border bg-ds-page px-5 py-4 md:px-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold">{text('pluginUnifiedTitle', 'Plugins')}</h1>
            <p className="mt-0.5 text-[12px] text-ds-muted">
              {text('pluginUnifiedSummary', `Connect ${brand.platform} to the tools you use every day`, { productName: brand.platform })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <IconButton
              label={text('pluginUnifiedFilters', 'Filters')}
              onClick={() => setFiltersOpen((value) => !value)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </IconButton>
            <IconButton
              label={text('pluginUnifiedSources', 'Catalog sources')}
              onClick={() => setSourcesOpen(true)}
            >
              <Settings2 className="h-4 w-4" />
            </IconButton>
            <IconButton label={text('pluginUnifiedRefresh', 'Refresh')} onClick={() => void refresh(true)} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </IconButton>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-ds-userbubble px-3 text-[13px] font-semibold text-ds-userbubbleFg hover:opacity-90"
            >
              <Import className="h-4 w-4" />
              {text('pluginUnifiedAddPlugin', 'Add plugin')}
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-3 flex w-fit items-center gap-1 rounded-md border border-ds-border bg-ds-subtle p-1">
          {([
            ['plugins', text('pluginUnifiedPluginsTab', 'Plugins')],
            ['skills', text('pluginUnifiedSkillsTab', 'Skills')]
          ] as Array<[MarketplaceView, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={viewMode === value}
              onClick={() => {
                setViewMode(value)
                setQuery('')
                if (value === 'skills') setSkillFilter('overview')
              }}
              className={`h-7 rounded px-2.5 text-[12px] font-medium transition ${viewMode === value ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted hover:text-ds-ink'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={`mt-3 grid gap-2 ${viewMode === 'plugins' ? 'lg:grid-cols-1' : 'lg:grid-cols-[minmax(260px,1fr)_auto]'}`}>
          <label className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-faint" />
            <input
              value={query}
              onChange={(event) => {
                const value = event.target.value
                setQuery(value)
                if (viewMode === 'plugins' && value.trim() && statusFilter === 'recommended') {
                  setStatusFilter('all')
                }
              }}
              placeholder={viewMode === 'skills'
                ? text('pluginUnifiedSearchSkills', 'Search indexed Skills by name or capability')
                : text('pluginUnifiedSearch', 'Search plugins, publishers, and capabilities')}
              className="h-10 w-full rounded-md border border-ds-border bg-ds-card pl-10 pr-3 text-[13px] outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30"
            />
          </label>
          {viewMode === 'plugins' ? null : (
            <div className="flex h-10 items-center gap-2 rounded-md border border-ds-border bg-ds-card px-3 text-[12px] text-ds-muted">
              <Sparkles className="h-4 w-4 text-accent" />
              {text('pluginUnifiedSkillsRootCount', '{{count}} Skills indexed', { count: skills.length })}
            </div>
          )}
        </div>

        {viewMode === 'plugins' ? <>
          <InstalledPluginStrip entries={installedEntries} text={text} onSelect={(entry) => {
            setSelectedKey(packageKey(entry))
            setDetailsOpen(true)
          }} />
          <div className="mt-3 flex items-center justify-between gap-3 border-b border-ds-border">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto" role="tablist" aria-label={text('pluginUnifiedStatus', 'Plugin status')}>
              {([
                ['recommended', text('pluginUnifiedFeatured', 'Featured')],
                ['all', text('pluginUnifiedAllPlugins', 'All plugins')],
                ['installed', text('pluginFilterInstalled', 'Installed')],
                ['updates', text('pluginUnifiedUpdates', 'Updates')],
                ['configuration', text('pluginUnifiedNeedsConfig', 'Needs configuration')]
              ] as Array<[StatusFilter, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                  className={`h-9 shrink-0 border-b-2 px-2.5 text-[12px] font-medium transition ${statusFilter === value ? 'border-accent text-ds-ink' : 'border-transparent text-ds-muted hover:text-ds-ink'}`}
                >
                  {label} <span className="text-[10px] text-ds-faint">{statusCounts[value]}</span>
                </button>
              ))}
            </div>
            <span className="hidden shrink-0 pb-2 text-[11px] text-ds-faint sm:block">
              {text('pluginUnifiedCatalogCount', '{{featured}} featured · {{total}} total', {
                featured: statusCounts.recommended,
                total: statusCounts.all
              })}
            </span>
          </div>
          {filtersOpen ? <div className="mt-2 grid gap-2 rounded-md border border-ds-border bg-ds-subtle/40 p-2 md:grid-cols-3">
            <Select value={categoryFilter} onChange={setCategoryFilter} ariaLabel={text('pluginUnifiedCategory', 'Category')}>
              <option value="all">{text('pluginUnifiedAllCategories', 'All categories')}</option>
              {categories.map((category) => <option key={category} value={category}>{marketplaceCategoryLabel(category, text)}</option>)}
            </Select>
            <Select value={sourceFilter} onChange={setSourceFilter} ariaLabel={text('pluginUnifiedSource', 'Source')}>
              <option value="all">{text('pluginUnifiedAllSources', 'All sources')}</option>
              {sources.filter((source) => source.searchable).map((source) => <option key={source.id} value={source.id}>{sourceLabel(source, source.id, text)}</option>)}
            </Select>
            <div className="flex h-10 items-center gap-1 overflow-x-auto" role="tablist" aria-label={text('pluginUnifiedAudience', 'Catalog audience')}>
              {([
                ['official', text('pluginAudienceOfficial', 'Official')],
                ['personal', text('pluginAudiencePersonal', 'Personal')],
                ['team', text('pluginAudienceTeam', 'Team')]
              ] as Array<[AudienceFilter, string]>).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={audienceFilter === value} onClick={() => setAudienceFilter(value)} className={`h-8 shrink-0 rounded-md px-2.5 text-[11px] font-medium transition ${audienceFilter === value ? 'bg-ds-card text-ds-ink shadow-sm' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'}`}>{label}</button>)}
            </div>
          </div> : null}
        </> : null}
      </header>

      {notice ? (
        <div className={`mx-5 mt-3 flex shrink-0 items-start justify-between gap-3 rounded-md border px-3 py-2 text-[12px] ${statusTone(notice.tone)}`}>
          <span>{notice.message}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={text('pluginCloseDetails', 'Close')}>
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-y-auto">
        {viewMode === 'skills' ? (
          <LocalSkillsList
            skills={visibleSkills}
            totalIndexed={skillCount}
            totalMatches={matchingSkills.length}
            filter={skillFilter}
            groupCounts={skillGroupCounts}
            query={query}
            validationErrors={skillValidationErrors}
            duplicateNames={duplicateSkillNames}
            text={text}
            onFilter={setSkillFilter}
            onRefresh={() => void refresh(true)}
            onOpenSource={(skill) => {
              const url = skillSourceUrl(skill)
              if (url) void window.workwise.openExternal(url)
            }}
          />
        ) : loading && entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-ds-muted">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <Search className="h-7 w-7 text-ds-faint" />
            <p className="mt-3 text-[14px] font-medium">{text('pluginNoResults', 'No matching plugins.')}</p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[1040px] px-5 pb-8 md:px-7">
            {visibleEntryGroups.map((group) => (
              <section key={group.category} className="pt-5">
                <div className="flex h-8 items-center justify-between border-b border-ds-border">
                  <h2 className="text-[13px] font-semibold text-ds-ink">
                    {marketplaceCategoryLabel(group.category, text)}
                  </h2>
                  <span className="text-[10px] text-ds-faint">{group.packages.length}</span>
                </div>
                <div className="grid gap-x-9 md:grid-cols-2">
                  {group.packages.map((entry) => (
                    <PluginRow
                      key={packageKey(entry)}
                      entry={entry}
                      installed={installed.get(entry.package.id)}
                      reviewSha256={entry.reviewSha256}
                      server={installedServerForPackage(entry.package, mcpServers)}
                      busy={busy === packageKey(entry) || busy === `connect:${entry.package.id}`}
                      text={text}
                      onSelect={() => {
                        setSelectedKey(packageKey(entry))
                        setDetailsOpen(true)
                      }}
                      onAction={() => void invokePrimaryAction(entry)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          )}
      </main>

      {detailsOpen && selected ? (
        <DetailsDrawer
          entry={selected}
          source={sourceMap.get(selected.sourceId)}
          installed={installed.get(selected.package.id)}
          server={installedServerForPackage(selected.package, mcpServers)}
          busy={busy}
          text={text}
          onClose={() => setDetailsOpen(false)}
          onAction={() => void invokePrimaryAction(selected)}
          onRollback={(record) => void rollback(record)}
          onOpenSource={() => {
            if (isHttpUrl(selected.package.source.location)) void window.workwise.openExternal(selected.package.source.location)
          }}
        />
      ) : null}

      {sourcesOpen ? (
        <SourceDrawer
          sources={sources}
          credentialStatuses={catalogCredentials}
          busy={busy}
          text={text}
          onClose={() => setSourcesOpen(false)}
          workspaceAvailable={Boolean(workspaceRoot)}
          onAdd={async (draft) => {
            setBusy('source:add')
            try {
              const source = await window.workwise.upsertCatalogSource(catalogSourceFromDraft(draft))
              if (source.auth.type === 'token') {
                try {
                  await window.workwise.setCatalogSourceCredential(source.id, draft.token)
                } catch (error) {
                  await window.workwise.removeCatalogSource(source.id).catch(() => undefined)
                  throw error
                }
              }
              const result = await window.workwise.syncCatalogSource(source.id)
              setNotice({
                tone: result.status === 'failed' ? 'error' : 'success',
                message: result.error || text('pluginUnifiedSourceAdded', '{{name}} catalog added.', { name: source.name })
              })
              await refresh()
              return true
            } catch (error) {
              setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
              return false
            } finally {
              setBusy('')
            }
          }}
          onRemove={async (source) => {
            const confirmed = await window.workwise.confirmDialog({
              message: text('pluginUnifiedRemoveSourceConfirm', 'Remove {{name}} and its cached snapshot?', { name: source.name }),
              confirmLabel: text('pluginUnifiedRemove', 'Remove'),
              cancelLabel: text('pluginUnifiedCancel', 'Cancel')
            })
            if (!confirmed) return
            setBusy(`source:${source.id}`)
            try {
              await window.workwise.removeCatalogSource(source.id)
              await refresh()
            } catch (error) {
              setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
            } finally {
              setBusy('')
            }
          }}
          onCredential={async (source, token) => {
            setBusy(`credential:${source.id}`)
            try {
              if (token.trim()) await window.workwise.setCatalogSourceCredential(source.id, token)
              else await window.workwise.clearCatalogSourceCredential(source.id)
              setNotice({
                tone: 'success',
                message: token.trim()
                  ? text('pluginUnifiedCredentialSaved', '{{name}} credential saved securely.', { name: source.name })
                  : text('pluginUnifiedCredentialCleared', '{{name}} credential cleared.', { name: source.name })
              })
              await refresh()
              return true
            } catch (error) {
              setNotice({ tone: 'error', message: friendlyMarketplaceError(error instanceof Error ? error.message : String(error), t) })
              return false
            } finally {
              setBusy('')
            }
          }}
          onSync={async (source) => {
            setBusy(`source:${source.id}`)
            try {
              const result = await window.workwise.syncCatalogSource(source.id)
              setNotice({
                tone: result.status === 'failed' ? 'error' : 'success',
                message: result.error || text('pluginUnifiedSourceSynced', '{{name}} catalog synchronized.', { name: source.name })
              })
              await refresh()
            } catch (error) {
              setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) })
            } finally {
              setBusy('')
            }
          }}
        />
      ) : null}

      {importOpen ? (
        <Modal title={text('pluginUnifiedImportTitle', 'Import plugin')} onClose={() => setImportOpen(false)}>
          <div className="grid gap-2 sm:grid-cols-2">
            <ImportChoice
              icon={<PackageIcon className="h-5 w-5" />}
              title={text('pluginUnifiedImportArchive', 'WWX or MCPB package')}
              description={text('pluginUnifiedImportArchiveDesc', 'Choose a signed or locally reviewed package archive.')}
              busy={busy === 'import:file'}
              onClick={() => void importPackage('file')}
            />
            <ImportChoice
              icon={<FolderOpen className="h-5 w-5" />}
              title={text('pluginUnifiedImportCodex', 'Codex plugin directory')}
              description={text('pluginUnifiedImportCodexDesc', 'Review a local .codex-plugin directory before installation.')}
              busy={busy === 'import:directory'}
              onClick={() => void importPackage('directory')}
            />
          </div>
        </Modal>
      ) : null}

      {prepared ? (
        <ReviewModal
          prepared={prepared}
          selections={permissions}
          scope={scope}
          permissionUpdate={installed.get(prepared.package.id)?.version === prepared.package.version}
          workspaceAvailable={Boolean(workspaceRoot)}
          busy={busy === `prepared:${prepared.id}`}
          text={text}
          onSelection={(permissionId, value) => setPermissions((current) => ({ ...current, [permissionId]: value }))}
          onScope={setScope}
          onClose={() => void closePrepared()}
          onInstall={() => void installPrepared()}
        />
      ) : null}

      {oauth ? (
        <Modal title={text('pluginUnifiedOauthTitle', 'Complete authorization')} onClose={() => {
          const current = oauth
          setOauth(null)
          if (current.callback === 'loopback') {
            void window.workwise.cancelMcpAuthorization(current.serverId, current.state)
          }
        }}>
          {oauth.callback === 'loopback' ? (
            <div className="flex items-center gap-3 text-[12px] text-ds-muted">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              <span>{text('pluginUnifiedOauthWaiting', 'Waiting for authorization in your browser...')}</span>
            </div>
          ) : (
            <label className="block text-[12px] font-medium text-ds-muted">
              {text('pluginUnifiedOauthCode', 'Authorization code')}
              <input
                autoFocus
                value={oauth.code}
                onChange={(event) => setOauth({ ...oauth, code: event.target.value })}
                className="mt-2 h-10 w-full rounded-md border border-ds-border bg-ds-card px-3 text-[13px] text-ds-ink outline-none focus:border-accent/50"
              />
            </label>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => void window.workwise.openExternal(oauth.url)} className="h-9 rounded-md border border-ds-border px-3 text-[12px] font-medium hover:bg-ds-hover">
              {text('pluginUnifiedOpenAuthorization', 'Open authorization page')}
            </button>
            {oauth.callback === 'manual' ? <button type="button" disabled={!oauth.code.trim() || busy === `oauth:${oauth.serverId}`} onClick={() => void finishOauth()} className="h-9 rounded-md bg-ds-userbubble px-3 text-[12px] font-semibold text-ds-userbubbleFg disabled:opacity-50">
              {busy === `oauth:${oauth.serverId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : text('pluginUnifiedAuthorize', 'Authorize')}
            </button> : null}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

function LocalSkillsList({
  skills,
  totalIndexed,
  totalMatches,
  filter,
  groupCounts,
  query,
  validationErrors,
  duplicateNames,
  text,
  onFilter,
  onRefresh,
  onOpenSource
}: {
  skills: SkillListItem[]
  totalIndexed: number
  totalMatches: number
  filter: SkillBrowseFilter
  groupCounts: SkillGroupCounts
  query: string
  validationErrors: Array<{ root: string; message: string }>
  duplicateNames: Set<string>
  text: Text
  onFilter: (filter: SkillBrowseFilter) => void
  onRefresh: () => void
  onOpenSource: (skill: SkillListItem) => void
}): ReactElement {
  const invalidRoots = new Set(validationErrors.map((item) => item.root))
  const browsing = filter !== 'overview' || Boolean(query.trim())
  const filters: Array<[SkillBrowseFilter, string, number | null]> = [
    ['overview', text('pluginUnifiedSkillOverview', 'Overview'), null],
    ['workwise', text('pluginUnifiedSkillWorkWise', brand.platform, { productName: brand.platform }), groupCounts.workwise],
    ['personal', text('pluginUnifiedSkillPersonal', 'Personal'), groupCounts.personal],
    ['project', text('pluginUnifiedSkillProject', 'Project'), groupCounts.project],
    ['integrations', text('pluginUnifiedSkillIntegrations', 'Codex plugins'), groupCounts.integrations],
    ['attention', text('pluginUnifiedSkillAttention', 'Needs attention'), groupCounts.attention]
  ]
  return (
    <div className="min-h-full">
      <div className="flex items-center justify-between border-b border-ds-border px-5 py-3 md:px-7">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ds-ink">{text('pluginUnifiedLocalSkillsTitle', 'Local Skills')}</h2>
          <p className="mt-0.5 text-[12px] text-ds-muted">
            {text('pluginUnifiedLocalSkillsDesc', 'Indexed by source and health. Skill files remain in their original folders.')}
          </p>
        </div>
        <IconButton label={text('pluginUnifiedRefreshSkills', 'Refresh Skills')} onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-ds-border px-5 py-2.5 md:px-7" role="tablist">
        {filters.map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={filter === value}
            onClick={() => onFilter(value)}
            className={`h-8 shrink-0 rounded-md px-3 text-[12px] font-medium transition ${
              filter === value ? 'bg-ds-subtle text-ds-ink' : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
            }`}
          >
            {label}{count === null ? '' : ` (${count})`}
          </button>
        ))}
      </div>

      {validationErrors.length > 0 ? (
        <div className="mx-5 mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/25 dark:text-amber-100 md:mx-7">
          <div className="flex items-center gap-2 font-semibold">
            <CircleAlert className="h-4 w-4 shrink-0" />
            {text('pluginUnifiedSkillScanIssues', '{{count}} Skill roots need attention.', { count: validationErrors.length })}
          </div>
          <div className="mt-1 space-y-1 opacity-80">
            {validationErrors.slice(0, 3).map((error) => <div key={`${error.root}:${error.message}`} className="break-words">{error.root}: {error.message}</div>)}
          </div>
        </div>
      ) : null}

      {!browsing ? (
        <div className="flex min-h-[260px] flex-col items-center justify-center px-6 text-center text-ds-muted">
          <Sparkles className="h-7 w-7 text-accent" />
          <p className="mt-3 text-[15px] font-semibold text-ds-ink">
            {text('pluginUnifiedSkillOverviewTitle', '{{count}} Skills indexed', { count: totalIndexed })}
          </p>
          <p className="mt-1 max-w-[520px] text-[12px] leading-5">
            {text('pluginUnifiedSkillOverviewDesc', 'These Skills remain in their source folders and are not added to the curated plugin catalog.')}
          </p>
        </div>
      ) : skills.length === 0 ? (
        <div className="flex min-h-[240px] flex-col items-center justify-center px-6 text-center text-ds-muted">
          <Sparkles className="h-7 w-7 text-ds-faint" />
          <p className="mt-3 text-[14px] font-medium">{text('pluginUnifiedNoLocalSkills', 'No matching local Skills.')}</p>
        </div>
      ) : (
        <div>
          <div className="border-b border-ds-border px-5 py-2 text-[11px] text-ds-faint md:px-7">
            {totalMatches > skills.length
              ? text('pluginUnifiedSkillResultsLimited', 'Showing {{shown}} of {{total}} matches. Narrow the search to see a specific Skill.', { shown: skills.length, total: totalMatches })
              : text('pluginUnifiedSkillResults', '{{count}} matching Skills', { count: totalMatches })}
          </div>
          <div className="divide-y divide-ds-border">
          {skills.map((skill) => {
            const name = skill.name || skill.id
            const duplicate = duplicateNames.has(name.trim().toLowerCase())
            const invalid = invalidRoots.has(skill.root)
            const source = skill.source?.type === 'github'
              ? `${skill.source.owner}/${skill.source.repo}`
              : skill.source?.type === 'bundled'
                ? text('pluginUnifiedSkillBundled', `${brand.platform} bundled`, { productName: brand.platform })
                : text('pluginUnifiedSkillLocal', 'Local folder')
            return (
              <div key={`${skill.root}:${skill.id}`} className="flex min-w-0 items-start gap-3 px-5 py-3.5 md:px-7">
                <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-ds-subtle text-accent">
                  <Sparkles className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="truncate text-[13px] font-semibold text-ds-ink">{name}</div>
                    <span className="rounded bg-ds-subtle px-1.5 py-0.5 text-[10px] font-medium text-ds-muted">
                      {skill.scope === 'project' ? text('pluginUnifiedScopeWorkspace', 'Workspace') : text('pluginUnifiedScopeUser', 'User')}
                    </span>
                    {duplicate ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{text('pluginUnifiedSkillDuplicate', 'Duplicate')}</span> : null}
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold ${invalid ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'}`}>
                      {invalid ? <CircleAlert className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
                      {invalid ? text('pluginUnifiedSkillNeedsAttention', 'Needs attention') : text('pluginUnifiedSkillHealthy', 'Healthy')}
                    </span>
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-ds-muted">{skill.description || skill.id}</div>
                  <div className="mt-1.5 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[10px] text-ds-faint">
                    <span className="max-w-full break-all">{skill.root}</span>
                    <span>{source}</span>
                    {skill.source?.type === 'github' ? <span>{skill.source.autoUpdate ? text('pluginUnifiedSkillAutoUpdate', 'Auto update on') : text('pluginUnifiedSkillManualUpdate', 'Manual update')}</span> : null}
                  </div>
                </div>
                {skillSourceUrl(skill) ? (
                  <IconButton label={text('pluginUnifiedSkillOpenSource', 'Open Skill source')} onClick={() => onOpenSource(skill)}>
                    <ExternalLink className="h-4 w-4" />
                  </IconButton>
                ) : null}
              </div>
            )
          })}
          </div>
        </div>
      )}
    </div>
  )
}

function IconButton({ label, onClick, disabled, children }: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}): ReactElement {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled} className="grid h-9 w-9 place-items-center rounded-md border border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50">
      {children}
    </button>
  )
}

function Select({ value, onChange, ariaLabel, children }: {
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  children: ReactNode
}): ReactElement {
  return (
    <label className="relative">
      <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full appearance-none rounded-md border border-ds-border bg-ds-card px-3 pr-9 text-[12px] text-ds-ink outline-none focus:border-accent/50">
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ds-faint" />
    </label>
  )
}

function ComponentBadge({ type }: { type: string }): ReactElement {
  const icon = type === 'mcp' ? <Server className="h-3 w-3" /> : type === 'cli' ? <Terminal className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />
  return <span className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-semibold uppercase text-ds-muted ring-1 ring-inset ring-ds-border">{icon}{type}</span>
}

function productType(item: MarketplacePackageV1): MarketplaceProductTypeV1 {
  if (item.productType) return item.productType
  if (item.components.some((component) => component.type === 'skill')) return 'workflow'
  if (item.components.some((component) => component.type === 'cli')) return 'utility'
  return 'connector'
}

function productTypeLabel(type: MarketplaceProductTypeV1, text: Text): string {
  return text(`pluginProductType_${type}`, type)
}

function ProductTypeBadge({ item, text }: { item: MarketplacePackageV1; text: Text }): ReactElement {
  const type = productType(item)
  return <span className="inline-flex h-5 items-center rounded px-1.5 text-[10px] font-medium text-ds-muted ring-1 ring-inset ring-ds-border">{productTypeLabel(type, text)}</span>
}

const iconToneClasses: Record<NonNullable<MarketplaceIconV1['tone']>, string> = {
  blue: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  teal: 'bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300',
  green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
}

export function fallbackPluginMonogram(item: MarketplacePackageV1): string {
  const source = item.name.trim() || item.id.trim()
  const latin = source.replace(/[^A-Za-z0-9]+/g, '').slice(0, 2).toUpperCase()
  if (latin) return latin
  const unicode = Array.from(source).filter((character) => /[\p{L}\p{N}]/u.test(character)).slice(0, 2).join('')
  return unicode || 'RW'
}

function PluginIcon({ item, text, compact = false }: { item: MarketplacePackageV1; text: Text; compact?: boolean }): ReactElement {
  const [assetFailed, setAssetFailed] = useState(false)
  const configuredIcon = item.icon
  const icon = configuredIcon && configuredIcon.value.trim()
    ? configuredIcon
    : {
        kind: 'monogram' as const,
        value: fallbackPluginMonogram(item),
        tone: 'slate' as const,
        alt: item.name
      }
  const size = compact ? 'h-9 w-9 text-[10px]' : 'h-10 w-10 text-[12px]'
  const alt = icon.alt?.trim() || packageDisplayName(item, text)
  if (icon.kind === 'asset' && /^(?:\/|\.\/)/i.test(icon.value) && !assetFailed) {
    return <img src={icon.value} alt={alt} onError={() => setAssetFailed(true)} className={`${size} shrink-0 rounded-lg object-cover ring-1 ring-inset ring-black/10 dark:ring-white/10`} />
  }
  // Catalog payloads can come from older or third-party sources. Keep a
  // deterministic visible fallback when an unknown tone or broken asset is
  // returned instead of leaving an empty icon slot.
  const tone = icon.tone && iconToneClasses[icon.tone] ? icon.tone : 'slate'
  const value = icon.kind === 'monogram' && icon.value.trim() ? icon.value.trim().slice(0, 3) : fallbackPluginMonogram(item)
  return <span role="img" aria-label={alt} className={`inline-flex ${size} shrink-0 items-center justify-center rounded-lg font-bold ring-1 ring-inset ring-black/10 dark:ring-white/10 ${iconToneClasses[tone]}`}>{!configuredIcon?.value.trim() || assetFailed || icon.kind !== 'monogram' || !/[\p{L}\p{N}]/u.test(value) ? <ProductIcon name="plugins" className="h-5 w-5" aria-hidden="true" /> : value}</span>
}

function InstalledPluginStrip({ entries, text, onSelect }: {
  entries: MarketplaceCatalogPackageEntryV1[]
  text: Text
  onSelect: (entry: MarketplaceCatalogPackageEntryV1) => void
}): ReactElement | null {
  if (!entries.length) return null
  return (
    <section className="mt-3 border-b border-ds-border pb-3" aria-label={text('pluginUnifiedInstalledSection', 'Installed')}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[12px] font-semibold text-ds-ink">{text('pluginFilterInstalled', 'Installed')}</h2>
        <span className="text-[11px] text-ds-faint">{text('pluginUnifiedManageInstalled', 'Manage from plugin details')}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 overflow-x-auto">
        {entries.slice(0, 12).map((entry) => (
          <button
            key={packageKey(entry)}
            type="button"
            title={packageDisplayName(entry.package, text)}
            aria-label={packageDisplayName(entry.package, text)}
            onClick={() => onSelect(entry)}
            className="shrink-0 rounded-lg p-0.5 transition hover:bg-ds-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <PluginIcon item={entry.package} text={text} compact />
          </button>
        ))}
      </div>
    </section>
  )
}

function PackageStatus({ item, installed, server, reviewSha256, text }: {
  item: MarketplacePackageV1
  installed?: InstalledPackageV1
  server?: McpServerConfigV2
  reviewSha256?: string
  text: Text
}): ReactElement {
  if (hasUpdate(item, installed, reviewSha256)) return <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">{permissionExpanded(item, installed, reviewSha256) ? text('pluginUnifiedPermissionsChanged', 'Permissions changed') : text('pluginUnifiedUpdateAvailable', 'Update available')}</span>
  if (needsConfiguration(item, installed, server)) return <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300">{text('pluginUnifiedNeedsConfig', 'Needs configuration')}</span>
  if (installed || server || isManagedInstalled(item)) return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />{text('pluginFilterInstalled', 'Installed')}</span>
  if (item.availability.status === 'unavailable') return <span className="text-[11px] font-medium text-ds-faint">{text('pluginUnifiedUnavailable', 'Unavailable')}</span>
  if (item.installation.mode === 'external') return <span className="text-[11px] font-medium text-ds-muted">{text('pluginUnifiedExternal', 'External service')}</span>
  return <span className="text-[11px] font-medium text-ds-faint">{item.version}</span>
}

function PrimaryAction({ item, installed, server, reviewSha256, busy, text, onClick }: {
  item: MarketplacePackageV1
  installed?: InstalledPackageV1
  server?: McpServerConfigV2
  reviewSha256?: string
  busy: boolean
  text: Text
  onClick: () => void
}): ReactElement | null {
  if (item.installation.mode === 'system-managed') return null
  const added = Boolean(installed || server || isManagedInstalled(item))
  const update = hasUpdate(item, installed, reviewSha256)
  const managesPermissions = item.installation.mode === 'direct-mirror' && added && !update
  const remote = item.components.some((component) => component.type === 'mcp' && component.runtime.kind === 'remote')
  const canAct = item.installation.mode === 'direct-mirror' || remote || isHttpUrl(item.source.location)
  if (!canAct) return null
  const label = update
    ? permissionExpanded(item, installed, reviewSha256) ? text('pluginUnifiedReviewUpdate', 'Review update') : text('pluginUnifiedUpdate', 'Update')
    : item.installation.mode === 'direct-mirror' && !added ? text('pluginUnifiedInstall', 'Install')
    : remote && !added ? text('pluginUnifiedConnect', 'Connect')
    : managesPermissions ? text('pluginUnifiedPermissions', 'Permissions')
    : text('pluginOpenSource', 'Open source')
  return (
    <button type="button" disabled={busy || (item.availability.status === 'unavailable' && !isHttpUrl(item.source.location))} onClick={(event) => { event.stopPropagation(); onClick() }} className="inline-flex h-8 min-w-[92px] items-center justify-center gap-1.5 rounded-md border border-ds-border bg-ds-card px-3 text-[11px] font-semibold hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-50">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : item.installation.mode === 'external' ? <ExternalLink className="h-3.5 w-3.5" /> : update ? <RefreshCw className="h-3.5 w-3.5" /> : managesPermissions ? <SlidersHorizontal className="h-3.5 w-3.5" /> : <Download className="h-3.5 w-3.5" />}
      {label}
    </button>
  )
}

function PluginRow({ entry, installed, server, reviewSha256, busy, text, onSelect, onAction }: {
  entry: MarketplaceCatalogPackageEntryV1
  installed?: InstalledPackageV1
  server?: McpServerConfigV2
  reviewSha256?: string
  busy: boolean
  text: Text
  onSelect: () => void
  onAction: () => void
}): ReactElement {
  const item = entry.package
  return (
    <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter') onSelect() }} className="grid min-h-[96px] cursor-pointer grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 border-b border-ds-border px-1 py-3 hover:bg-ds-hover/60">
      <PluginIcon item={item} text={text} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-semibold">{packageDisplayName(item, text)}</span>
          <ProductTypeBadge item={item} text={text} />
          {item.publisher.verified ? <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" aria-label={text('pluginUnifiedVerified', 'Verified publisher')} /> : null}
        </div>
        <p className="mt-1 line-clamp-1 text-[12px] text-ds-muted">{packageDisplaySummary(item, text)}</p>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ds-faint">
          <span>{item.publisher.name}</span>
          <PackageStatus item={item} installed={installed} server={server} reviewSha256={reviewSha256} text={text} />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <PrimaryAction item={item} installed={installed} server={server} reviewSha256={reviewSha256} busy={busy} text={text} onClick={onAction} />
        <ChevronRight className="h-4 w-4 text-ds-faint" />
      </div>
    </div>
  )
}

function Drawer({ title, closeLabel, onClose, children }: { title: string; closeLabel: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="fixed inset-0 z-40 bg-black/20" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[480px] flex-col border-l border-ds-border bg-ds-card shadow-2xl">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-ds-border px-5">
          <h2 className="truncate text-[15px] font-semibold">{title}</h2>
          <IconButton label={closeLabel} onClick={onClose}><X className="h-4 w-4" /></IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return <section className="border-b border-ds-border px-5 py-4"><h3 className="mb-2 text-[11px] font-semibold uppercase text-ds-faint">{title}</h3>{children}</section>
}

function DetailsDrawer({ entry, source, installed, server, busy, text, onClose, onAction, onRollback, onOpenSource }: {
  entry: MarketplaceCatalogPackageEntryV1
  source?: CatalogSourceV1
  installed?: InstalledPackageV1
  server?: McpServerConfigV2
  busy: string
  text: Text
  onClose: () => void
  onAction: () => void
  onRollback: (record: InstalledPackageV1) => void
  onOpenSource: () => void
}): ReactElement {
  const item = entry.package
  return (
    <Drawer title={packageDisplayName(item, text)} closeLabel={text('pluginUnifiedClose', 'Close')} onClose={onClose}>
      <div className="px-5 py-5">
        <div className="flex items-start gap-3">
          <PluginIcon item={item} text={text} />
          <div className="min-w-0">
            <ProductTypeBadge item={item} text={text} />
            <p className="mt-2 text-[13px] leading-5 text-ds-muted">{packageDisplaySummary(item, text)}</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PrimaryAction item={item} installed={installed} server={server} reviewSha256={entry.reviewSha256} busy={busy === packageKey(entry) || busy === `connect:${item.id}`} text={text} onClick={onAction} />
          {installed?.rollback.available ? (
            <button type="button" disabled={busy === `rollback:${item.id}`} onClick={() => onRollback(installed)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ds-border px-3 text-[11px] font-semibold hover:bg-ds-hover disabled:opacity-50">
              <RotateCcw className="h-3.5 w-3.5" />{text('pluginUnifiedRollback', 'Rollback')}
            </button>
          ) : null}
        </div>
      </div>
      <DetailSection title={text('pluginUnifiedPackageInfo', 'Package')}>
        <DefinitionList values={[
          [text('pluginUnifiedVersion', 'Version'), installed ? `${installed.version} / ${item.version}` : item.version],
          [text('pluginUnifiedProductType', 'Product type'), productTypeLabel(productType(item), text)],
          [text('pluginUnifiedPublisher', 'Publisher'), `${item.publisher.name}${item.publisher.verified ? ` · ${text('pluginUnifiedVerified', 'Verified')}` : ''}`],
          [text('pluginUnifiedLicense', 'License'), item.license ?? text('pluginUnifiedUnknownLicense', 'Unknown')],
          [text('pluginUnifiedSource', 'Source'), sourceLabel(source, entry.sourceId, text)],
          [text('pluginUnifiedUpdatePolicy', 'Update policy'), updatePolicyLabel(item, text)]
        ]} />
        {isHttpUrl(item.source.location) ? <button type="button" onClick={onOpenSource} className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"><ExternalLink className="h-3.5 w-3.5" />{text('pluginOpenSource', 'Open source')}</button> : null}
      </DetailSection>
      <DetailSection title={text('pluginUnifiedImplementation', 'Implementation')}>
        {isManagedConnector(item)
          ? <p className="text-[12px] text-ds-muted">{text('pluginUnifiedManagedConnector', `${brand.platform} managed connector`, { productName: brand.platform })}</p>
          : <div className="flex flex-wrap gap-1.5">{componentTypes(item).map((type) => <ComponentBadge key={type} type={type} />)}</div>}
      </DetailSection>
      <DetailSection title={text('pluginUnifiedPermissions', 'Permissions')}>
        {item.permissions.length ? <div className="space-y-2">{item.permissions.map((permission) => <PermissionLine key={permission.id} permission={permission} text={text} />)}</div> : <p className="text-[12px] text-ds-faint">{text('pluginUnifiedNoPermissions', 'No additional permissions declared.')}</p>}
      </DetailSection>
      <DetailSection title={text('pluginUnifiedAuthDependencies', 'Authentication and dependencies')}>
        <DefinitionList values={[
          [text('pluginUnifiedAuthentication', 'Authentication'), item.auth.type === 'none' ? text('pluginUnifiedNone', 'None') : `${item.auth.type} · ${item.auth.provider}`],
          [text('pluginUnifiedDependencies', 'Dependencies'), item.dependencies.length ? item.dependencies.map((dependency) => dependency.requirement).join(', ') : text('pluginUnifiedNone', 'None')]
        ]} />
      </DetailSection>
      <DetailSection title={text('pluginUnifiedHealth', 'Health')}>
        <DefinitionList values={[
          [text('pluginUnifiedStatus', 'Status'), packageHealthLabel(installed?.health.status ?? (server ? (server.enabled ? 'configured' : 'disabled') : isManagedInstalled(item) ? 'managed' : 'not installed'), text)],
          [text('pluginUnifiedLastCheck', 'Last check'), installed?.health.checkedAt ?? installed?.timestamps.lastCheckedAt ?? (isManagedInstalled(item) ? text('pluginUnifiedManagedCheck', `Managed with ${brand.platform} releases`, { productName: brand.platform }) : text('pluginUnifiedNever', 'Never'))]
        ]} />
      </DetailSection>
    </Drawer>
  )
}

function DefinitionList({ values }: { values: Array<[string, string]> }): ReactElement {
  return <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">{values.map(([label, value]) => <div key={label} className="contents"><dt className="text-ds-faint">{label}</dt><dd className="break-words text-ds-ink">{value}</dd></div>)}</dl>
}

function PermissionLine({ permission, text }: { permission: PackagePermissionV1; text: Text }): ReactElement {
  return <div className="flex items-start gap-2 text-[12px]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ds-faint" /><div><div className="font-medium">{permissionKindLabel(permission.kind, text)} · {permissionAccessLabel(permission.access, text)}</div><p className="mt-0.5 leading-5 text-ds-muted">{permissionDescription(permission, text)}</p>{permission.resources?.length ? <p className="mt-0.5 break-all text-[10px] text-ds-faint">{permission.resources.join(', ')}</p> : null}</div></div>
}

function emptySourceDraft(): SourceDraft {
  return {
    type: 'github',
    name: '',
    location: '',
    scope: 'user',
    defaultBranch: 'main',
    requiresToken: false,
    token: ''
  }
}

function SourceDrawer({ sources, credentialStatuses, busy, text, workspaceAvailable, onClose, onSync, onAdd, onRemove, onCredential }: {
  sources: CatalogSourceV1[]
  credentialStatuses: CatalogCredentialStatusV1[]
  busy: string
  text: Text
  workspaceAvailable: boolean
  onClose: () => void
  onSync: (source: CatalogSourceV1) => void
  onAdd: (draft: SourceDraft) => Promise<boolean>
  onRemove: (source: CatalogSourceV1) => void
  onCredential: (source: CatalogSourceV1, token: string) => Promise<boolean>
}): ReactElement {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<SourceDraft>(emptySourceDraft)
  const [credentialSourceId, setCredentialSourceId] = useState('')
  const [credentialToken, setCredentialToken] = useState('')
  const credentialMap = new Map(credentialStatuses.map((status) => [status.sourceId, status]))
  return (
    <Drawer title={text('pluginUnifiedSources', 'Catalog sources')} closeLabel={text('pluginUnifiedClose', 'Close')} onClose={onClose}>
      <div className="border-b border-ds-border px-5 py-4">
        <button type="button" onClick={() => setAdding((value) => !value)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-ds-border px-3 text-[11px] font-semibold hover:bg-ds-hover">
          <Plus className="h-3.5 w-3.5" />{text('pluginUnifiedAddSource', 'Add source')}
        </button>
        {adding ? (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Select value={draft.type} onChange={(value) => setDraft({ ...draft, type: value as SourceDraft['type'], scope: value === 'project' ? 'workspace' : draft.scope, requiresToken: value === 'github' || value === 'https' ? draft.requiresToken : false, token: value === 'github' || value === 'https' ? draft.token : '' })} ariaLabel={text('pluginUnifiedSourceType', 'Source type')}>
                <option value="github">GitHub</option><option value="git">Git</option><option value="https">HTTPS</option><option value="local">{text('pluginUnifiedLocalFile', 'Local file')}</option><option value="project" disabled={!workspaceAvailable}>{text('pluginUnifiedProjectFile', 'Project file')}</option>
              </Select>
              <Select value={draft.scope} onChange={(value) => setDraft({ ...draft, scope: value as SourceDraft['scope'] })} ariaLabel={text('pluginUnifiedScope', 'Scope')}>
                <option value="user">{text('pluginUnifiedScopeUser', 'User')}</option><option value="workspace" disabled={!workspaceAvailable}>{text('pluginUnifiedScopeWorkspace', 'Workspace')}</option><option value="team">{text('pluginUnifiedScopeTeam', 'Team')}</option>
              </Select>
            </div>
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={text('pluginUnifiedSourceName', 'Catalog name')} className="h-9 w-full rounded-md border border-ds-border bg-ds-card px-3 text-[12px] outline-none focus:border-accent/50" />
            <input value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} placeholder={draft.type === 'project' ? '.agents/plugins/marketplace.json' : draft.type === 'local' ? '/path/to/marketplace.json' : 'https://...'} className="h-9 w-full rounded-md border border-ds-border bg-ds-card px-3 text-[12px] outline-none focus:border-accent/50" />
            {draft.type === 'github' || draft.type === 'git' ? <input value={draft.defaultBranch} onChange={(event) => setDraft({ ...draft, defaultBranch: event.target.value })} placeholder={text('pluginUnifiedDefaultBranch', 'Default branch')} className="h-9 w-full rounded-md border border-ds-border bg-ds-card px-3 text-[12px] outline-none focus:border-accent/50" /> : null}
            {draft.type === 'github' || draft.type === 'https' ? (
              <label className="flex items-center gap-2 text-[11px] text-ds-muted">
                <input type="checkbox" checked={draft.requiresToken} onChange={(event) => setDraft({ ...draft, requiresToken: event.target.checked, token: event.target.checked ? draft.token : '' })} />
                {text('pluginUnifiedPrivateSource', 'Private catalog')}
              </label>
            ) : null}
            {draft.requiresToken ? <input type="password" autoComplete="off" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} placeholder={text('pluginUnifiedCatalogToken', 'Access token')} className="h-9 w-full rounded-md border border-ds-border bg-ds-card px-3 text-[12px] outline-none focus:border-accent/50" /> : null}
            <div className="flex justify-end gap-2"><button type="button" onClick={() => { setAdding(false); setDraft(emptySourceDraft()) }} className="h-8 rounded-md px-3 text-[11px] font-medium text-ds-muted hover:bg-ds-hover">{text('pluginUnifiedCancel', 'Cancel')}</button><button type="button" disabled={!draft.name.trim() || !draft.location.trim() || (draft.requiresToken && !draft.token.trim()) || busy === 'source:add'} onClick={() => void onAdd(draft).then((added) => { if (added) { setAdding(false); setDraft(emptySourceDraft()) } })} className="inline-flex h-8 min-w-[72px] items-center justify-center rounded-md bg-ds-userbubble px-3 text-[11px] font-semibold text-ds-userbubbleFg disabled:opacity-50">{busy === 'source:add' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : text('pluginUnifiedAdd', 'Add')}</button></div>
          </div>
        ) : null}
      </div>
      <div className="divide-y divide-ds-border">
        {sources.map((source) => (
          <div key={source.id} className="px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="truncate text-[13px] font-semibold">{sourceLabel(source, source.id, text)}</div><div className="mt-1 flex flex-wrap gap-1.5 text-[10px] text-ds-faint"><span>{source.type}</span><span>·</span><span>{source.trust}</span><span>·</span><span>{source.sync.state}</span></div></div>
              <div className="flex gap-1">{source.auth.type === 'token' ? <IconButton label={text('pluginUnifiedConfigureCredential', 'Configure credential')} disabled={busy === `credential:${source.id}`} onClick={() => { setCredentialSourceId(source.id); setCredentialToken('') }}>{busy === `credential:${source.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}</IconButton> : null}{source.sync.mode !== 'bundled' ? <IconButton label={text('pluginUnifiedSyncSource', 'Sync source')} disabled={busy === `source:${source.id}`} onClick={() => onSync(source)}>{busy === `source:${source.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</IconButton> : null}{source.scope !== 'system' ? <IconButton label={text('pluginUnifiedRemoveSource', 'Remove source')} disabled={busy === `source:${source.id}`} onClick={() => onRemove(source)}><Trash2 className="h-4 w-4" /></IconButton> : null}</div>
            </div>
            <p className="mt-2 break-all text-[11px] leading-4 text-ds-muted">{source.location}</p>
            {source.auth.type === 'token' ? <p className="mt-1 text-[10px] text-ds-faint">{credentialMap.get(source.id)?.configured ? text('pluginUnifiedCredentialConfigured', 'Credential configured') : text('pluginUnifiedCredentialMissing', 'Credential required')}</p> : null}
            {credentialSourceId === source.id ? <div className="mt-3 flex gap-2"><input type="password" autoFocus autoComplete="off" value={credentialToken} onChange={(event) => setCredentialToken(event.target.value)} placeholder={text('pluginUnifiedCatalogToken', 'Access token')} className="h-8 min-w-0 flex-1 rounded-md border border-ds-border bg-ds-card px-3 text-[11px] outline-none focus:border-accent/50" /><button type="button" disabled={!credentialToken.trim() || busy === `credential:${source.id}`} onClick={() => void onCredential(source, credentialToken).then((saved) => { if (saved) { setCredentialSourceId(''); setCredentialToken('') } })} className="h-8 rounded-md bg-ds-userbubble px-3 text-[11px] font-semibold text-ds-userbubbleFg disabled:opacity-50">{text('pluginUnifiedSave', 'Save')}</button>{credentialMap.get(source.id)?.configured ? <button type="button" disabled={busy === `credential:${source.id}`} onClick={() => void onCredential(source, '').then((saved) => { if (saved) { setCredentialSourceId(''); setCredentialToken('') } })} className="h-8 rounded-md border border-ds-border px-3 text-[11px] font-medium hover:bg-ds-hover">{text('pluginUnifiedClear', 'Clear')}</button> : null}</div> : null}
            {source.sync.error ? <p className="mt-2 text-[11px] text-red-700 dark:text-red-300">{source.sync.error}</p> : null}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="w-full max-w-[620px] rounded-lg border border-ds-border bg-ds-card shadow-2xl">
        <header className="flex h-14 items-center justify-between border-b border-ds-border px-5"><h2 className="text-[15px] font-semibold">{title}</h2><IconButton label="Close" onClick={onClose}><X className="h-4 w-4" /></IconButton></header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

function ImportChoice({ icon, title, description, busy, onClick }: { icon: ReactNode; title: string; description: string; busy: boolean; onClick: () => void }): ReactElement {
  return <button type="button" disabled={busy} onClick={onClick} className="min-h-[120px] rounded-md border border-ds-border p-4 text-left hover:bg-ds-hover disabled:opacity-50"><div className="text-ds-muted">{busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}</div><div className="mt-3 text-[13px] font-semibold">{title}</div><p className="mt-1 text-[11px] leading-4 text-ds-muted">{description}</p></button>
}

function ReviewModal({ prepared, selections, scope, permissionUpdate, workspaceAvailable, busy, text, onSelection, onScope, onClose, onInstall }: {
  prepared: PreparedPluginImportV1
  selections: PermissionSelections
  scope: 'user' | 'workspace' | 'team'
  permissionUpdate: boolean
  workspaceAvailable: boolean
  busy: boolean
  text: Text
  onSelection: (permissionId: string, value: boolean) => void
  onScope: (scope: 'user' | 'workspace' | 'team') => void
  onClose: () => void
  onInstall: () => void
}): ReactElement {
  const item = prepared.package
  return (
    <Modal title={text('pluginUnifiedReviewTitle', 'Review {{name}}', { name: item.name })} onClose={onClose}>
      <div className="flex items-start gap-3 rounded-md border border-ds-border bg-ds-subtle p-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" /><div><div className="text-[12px] font-semibold">{text('pluginUnifiedVerifiedReview', 'Content and metadata review')}</div><p className="mt-1 break-all text-[10px] leading-4 text-ds-muted">SHA-256 {prepared.contentSha256}</p></div></div>
      {!prepared.compatibility.workwiseCompatible ? <div className="mt-3 flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-[12px] text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"><CircleAlert className="h-4 w-4 shrink-0" /><span>{prepared.compatibility.reasons.join(' ')}</span></div> : null}
      <div className="mt-4"><h3 className="text-[11px] font-semibold uppercase text-ds-faint">{text('pluginUnifiedPermissions', 'Permissions')}</h3><div className="mt-2 max-h-[230px] space-y-2 overflow-y-auto">{item.permissions.length ? item.permissions.map((permission) => <label key={permission.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-ds-border p-3"><input type="checkbox" checked={Boolean(selections[permission.id])} onChange={(event) => onSelection(permission.id, event.target.checked)} className="mt-0.5 h-4 w-4" /><div><div className="text-[12px] font-medium">{permissionKindLabel(permission.kind, text)} · {permissionAccessLabel(permission.access, text)}</div><p className="mt-0.5 text-[11px] leading-4 text-ds-muted">{permissionDescription(permission, text)}</p></div></label>) : <p className="text-[12px] text-ds-faint">{text('pluginUnifiedNoPermissions', 'No additional permissions declared.')}</p>}</div></div>
      <div className="mt-4"><h3 className="text-[11px] font-semibold uppercase text-ds-faint">{text('pluginUnifiedScope', 'Install scope')}</h3><div className="mt-2 inline-flex rounded-md bg-ds-subtle p-1">{(['user', 'workspace', 'team'] as const).map((value) => <button key={value} type="button" disabled={permissionUpdate || (value === 'workspace' && !workspaceAvailable)} onClick={() => onScope(value)} className={`h-8 rounded px-3 text-[11px] font-medium ${scope === value ? 'bg-ds-card shadow-sm' : 'text-ds-muted'} disabled:opacity-40`}>{text(`pluginUnifiedScope${value[0]!.toUpperCase()}${value.slice(1)}`, value)}</button>)}</div></div>
      {prepared.warnings.length ? <div className="mt-4 text-[11px] leading-4 text-amber-700 dark:text-amber-300">{prepared.warnings.join(' ')}</div> : null}
      <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onClose} className="h-9 rounded-md border border-ds-border px-3 text-[12px] font-medium hover:bg-ds-hover">{text('pluginUnifiedCancel', 'Cancel')}</button><button type="button" disabled={busy || !prepared.compatibility.workwiseCompatible} onClick={onInstall} className="inline-flex h-9 min-w-[96px] items-center justify-center gap-2 rounded-md bg-ds-userbubble px-3 text-[12px] font-semibold text-ds-userbubbleFg disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="h-4 w-4" />{permissionUpdate ? text('pluginUnifiedApplyPermissions', 'Apply') : text('pluginUnifiedInstall', 'Install')}</>}</button></div>
    </Modal>
  )
}
