import { isApprovedUpstreamPackage } from '../../shared/engineering-marketplace'
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  CatalogSnapshotV1,
  CatalogSourceV1,
  MarketplaceCatalogPackagesResultV1,
  MarketplaceCatalogSyncResultV1,
  MarketplacePackageV1
} from '../../shared/marketplace'
import { atomicWriteFile, readRecoveredFile, runSerialized } from './durable-file'
import {
  adaptCodexMarketplace,
  mergeMcpRegistryDelta,
  parseMcpRegistryPage
} from './marketplace-catalog-adapters'
import {
  getMarketplaceCatalogSources,
  getOfficialMarketplaceCatalog
} from './official-marketplace-catalog'
import { marketplacePackageReviewSha256 } from './package-installation-service'
import {
  marketplaceCommandEnvironment,
  resolveMarketplaceCommand
} from './marketplace-command'

const SOURCE_MANIFEST_SCHEMA = 'workwise.marketplace-sources'
const SOURCE_MANIFEST_VERSION = 1
const MAX_CATALOG_JSON_BYTES = 10 * 1024 * 1024
const MAX_CATALOG_PACKAGES = 5_000
const MAX_REGISTRY_PAGES = 100
const IMMUTABLE_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const execFile = promisify(execFileCallback)

type SourceManifestV1 = {
  schema: typeof SOURCE_MANIFEST_SCHEMA
  version: typeof SOURCE_MANIFEST_VERSION
  sources: CatalogSourceV1[]
  snapshots?: Record<string, SnapshotPointerV1>
}

type SnapshotPointerV1 = {
  file: string
  revision: string
  sha256: string
}

type FileSourcePath = {
  lexicalPath: string
  realPath: string
  device: number
  inode: number
}

type CatalogSyncMetadata = {
  etag?: string
  lastModified?: string
  commit?: string
  syncedAt?: string
}

export type MarketplaceCatalogServiceOptions = {
  rootDirectory?: string
  workspaceRoot?: string
  resolveWorkspaceRoot?: () => Promise<string | undefined>
  fetch?: typeof fetch
  now?: () => Date
  allowLoopbackHttp?: boolean
  beforePersistSources?: (sources: readonly CatalogSourceV1[]) => Promise<void>
  fetchTimeoutMs?: number
  resolveSecret?: (secretKey: string) => Promise<string | null>
  fileSourceReadHook?: (phase: 'resolved' | 'opened', path: string) => Promise<void>
  runGit?: (args: string[]) => Promise<string>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sourceCacheName(sourceId: string, sha256: string): string {
  return createHash('sha256').update(sourceId).digest('hex') + '-' + sha256 + '.json'
}

function snapshotContent(snapshot: CatalogSnapshotV1): string {
  return JSON.stringify(snapshot, null, 2) + '\n'
}

function snapshotDigest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function sourceIdentity(source: CatalogSourceV1): string {
  const base = {
    type: source.type,
    scope: source.scope,
    location: source.location,
    trust: source.trust,
    auth: source.auth
  }
  if (source.type === 'git') return canonicalJson({ ...base, defaultBranch: source.defaultBranch })
  if (source.type === 'github') {
    return canonicalJson({
      ...base,
      owner: source.owner,
      repository: source.repository,
      defaultBranch: source.defaultBranch
    })
  }
  if (source.type === 'mcp-registry') {
    return canonicalJson({ ...base, registry: source.registry })
  }
  return canonicalJson(base)
}

function resetServiceOwnedSync(source: CatalogSourceV1): CatalogSourceV1 {
  return {
    ...source,
    sync: {
      mode: source.sync.mode,
      state: 'idle',
      mirroredByDefault: source.sync.mirroredByDefault,
      installedByDefault: source.sync.installedByDefault
    }
  }
}

function sanitizeAuth(source: CatalogSourceV1): CatalogSourceV1['auth'] {
  if (!isRecord(source) || !isRecord(source.auth)) {
    throw new Error('Catalog source authentication metadata is invalid.')
  }
  if (source.auth.type === 'token') {
    return { type: 'token', secretKey: source.auth.secretKey }
  }
  if (source.auth.type === 'oauth') {
    return {
      type: 'oauth',
      provider: source.auth.provider,
      discovery: source.auth.discovery
    }
  }
  if (source.auth.type === 'none') return { type: 'none' }
  throw new Error('Catalog source auth type is invalid.')
}

function sanitizeSource(source: CatalogSourceV1): CatalogSourceV1 {
  if (!isRecord(source) || !isRecord(source.sync)) {
    throw new Error('Catalog source metadata is invalid.')
  }
  const rawSync = source.sync
  const sync = {
    mode: rawSync.mode,
    state: rawSync.state,
    mirroredByDefault: rawSync.mirroredByDefault,
    installedByDefault: rawSync.installedByDefault,
    ...(typeof rawSync.lastSyncedAt === 'string' ? { lastSyncedAt: rawSync.lastSyncedAt } : {}),
    ...(typeof rawSync.etag === 'string' ? { etag: rawSync.etag } : {}),
    ...(typeof rawSync.lastModified === 'string' ? { lastModified: rawSync.lastModified } : {}),
    ...(typeof rawSync.commit === 'string' ? { commit: rawSync.commit } : {}),
    ...(typeof rawSync.error === 'string' ? { error: rawSync.error } : {})
  } as CatalogSourceV1['sync']
  const base = {
    schemaVersion: source.schemaVersion,
    id: source.id,
    name: source.name,
    scope: source.scope,
    location: source.location,
    trust: source.trust,
    searchable: source.searchable,
    auth: sanitizeAuth(source),
    sync
  }
  if (source.type === 'built-in') return clone({ ...base, type: 'built-in' }) as CatalogSourceV1
  if (source.type === 'local') return clone({ ...base, type: 'local' }) as CatalogSourceV1
  if (source.type === 'project') return clone({ ...base, type: 'project' }) as CatalogSourceV1
  if (source.type === 'git') {
    return clone({ ...base, type: 'git', defaultBranch: source.defaultBranch }) as CatalogSourceV1
  }
  if (source.type === 'github') {
    return clone({
      ...base,
      type: 'github',
      owner: source.owner,
      repository: source.repository,
      defaultBranch: source.defaultBranch
    }) as CatalogSourceV1
  }
  if (source.type === 'https') return clone({ ...base, type: 'https' }) as CatalogSourceV1
  if (source.type === 'mcp-registry') {
    return clone({ ...base, type: 'mcp-registry', registry: source.registry }) as CatalogSourceV1
  }
  throw new Error('Catalog source type is invalid.')
}

function assertSafeHttpsUrl(value: string, allowLoopbackHttp: boolean): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Catalog location must be a valid URL.')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Catalog URLs must not contain credentials.')
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (parsed.protocol !== 'https:' &&
      !(allowLoopbackHttp && parsed.protocol === 'http:' && loopback)) {
    throw new Error('Catalog URLs must use HTTPS.')
  }
}

function assertGithubRepositoryLocation(source: Extract<CatalogSourceV1, { type: 'github' }>): void {
  const parsed = new URL(source.location)
  const repositoryPath = parsed.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
  const expectedPath = `/${source.owner}/${source.repository}`
  if (parsed.hostname.toLowerCase() !== 'github.com' || repositoryPath !== expectedPath ||
      parsed.search || parsed.hash) {
    throw new Error('GitHub catalog location must match its owner and repository.')
  }
}

function assertNonEmptyStrings(value: unknown, label: string): string[] {
  const items = requiredArray(value, label)
  if (items.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(label + ' must contain non-empty strings.')
  }
  if (new Set(items).size !== items.length) throw new Error(label + ' must not contain duplicates.')
  return items as string[]
}

function assertPortablePackagePath(value: unknown, label: string): string {
  const path = requiredString(value, label)
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(label + ' must be a portable relative path.')
  }
  const segments = path.split('/')
  if (segments.length > 24 ||
      segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(label + ' contains path traversal or excessive depth.')
  }
  for (const segment of segments) {
    const base = segment.split('.')[0]?.toLowerCase() ?? ''
    const containsControl = [...segment].some((character) => character.charCodeAt(0) <= 31)
    if (/[<>:"|?*]/.test(segment) || containsControl || /[. ]$/.test(segment) ||
        new Set(['con', 'prn', 'aux', 'nul']).has(base) || /^(?:com|lpt)[1-9]$/.test(base)) {
      throw new Error(label + ' is not portable across supported platforms.')
    }
  }
  return path
}

function assertSourceShape(source: CatalogSourceV1, allowLoopbackHttp: boolean): void {
  requiredString(source.id, 'Catalog source id')
  requiredString(source.name, 'Catalog source name')
  if (source.schemaVersion !== 1) throw new Error('Catalog source schemaVersion must be 1.')
  const types = new Set(['built-in', 'local', 'project', 'git', 'github', 'https', 'mcp-registry'])
  if (!types.has(source.type)) throw new Error('Catalog source type is invalid.')
  const scopes = new Set(['user', 'workspace', 'team', 'system'])
  if (!scopes.has(source.scope)) throw new Error('Catalog source scope is invalid.')
  const trusts = new Set(['system', 'official', 'verified', 'community', 'external', 'unverified'])
  if (!trusts.has(source.trust)) throw new Error('Catalog source trust is invalid.')
  if (typeof source.searchable !== 'boolean') throw new Error('Catalog source searchable is required.')
  requiredString(source.location, 'Catalog source location')
  const sync = requiredRecord(source.sync, 'Catalog source sync')
  if (!new Set(['bundled', 'watched', 'search-on-demand', 'manual']).has(String(sync.mode)) ||
      !new Set(['idle', 'syncing', 'synced', 'error']).has(String(sync.state)) ||
      typeof sync.mirroredByDefault !== 'boolean' ||
      typeof sync.installedByDefault !== 'boolean') {
    throw new Error('Catalog source sync metadata is invalid.')
  }
  for (const field of ['lastSyncedAt', 'etag', 'lastModified', 'error']) {
    if (sync[field] !== undefined && typeof sync[field] !== 'string') {
      throw new Error('Catalog source sync metadata is invalid.')
    }
  }
  if (sync.commit !== undefined &&
      (typeof sync.commit !== 'string' || !IMMUTABLE_COMMIT.test(sync.commit))) {
    throw new Error('Catalog source sync commit must be immutable.')
  }
  const auth = requiredRecord(source.auth, 'Catalog source auth')
  if (auth.type === 'token') requiredString(auth.secretKey, 'Catalog token secretKey')
  else if (auth.type === 'oauth') {
    requiredString(auth.provider, 'Catalog OAuth provider')
    if (auth.discovery !== 'ready' && auth.discovery !== 'pending') {
      throw new Error('Catalog OAuth discovery state is invalid.')
    }
  } else if (auth.type !== 'none') {
    throw new Error('Catalog source auth type is invalid.')
  }
  if (source.type === 'https') assertSafeHttpsUrl(source.location, allowLoopbackHttp)
  if (source.type === 'git' || source.type === 'github' || source.type === 'mcp-registry') {
    assertSafeHttpsUrl(source.location, false)
  }
  if (source.type === 'github') {
    requiredString(source.owner, 'GitHub catalog owner')
    requiredString(source.repository, 'GitHub catalog repository')
    requiredString(source.defaultBranch, 'GitHub catalog default branch')
    assertGithubRepositoryLocation(source)
  }
  if (source.type === 'git') requiredString(source.defaultBranch, 'Git catalog default branch')
  if (source.type === 'mcp-registry') requiredString(source.registry, 'MCP Registry name')
  if ((source.type === 'built-in' || source.type === 'local' || source.type === 'project') &&
      source.auth.type !== 'none') {
    throw new Error('Built-in and file catalog sources cannot declare authentication.')
  }
  if (source.type === 'project' && source.scope !== 'workspace') {
    throw new Error('Project catalog sources require workspace scope.')
  }
  if (source.type === 'built-in' && source.scope !== 'system') {
    throw new Error('Built-in catalog sources require system scope.')
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required.')
  return value
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(label + ' must be an object.')
  return value
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array.')
  return value
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (!isRecord(value)) return JSON.stringify(value)
  return '{' + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(value[key])
  ).join(',') + '}'
}

function assertPackageSourceShape(value: unknown, packageId: string, expectedSourceId: string): string {
  const source = requiredRecord(value, packageId + ' source')
  const id = requiredString(source.id, packageId + ' source id')
  if (source.catalogSourceId !== expectedSourceId) {
    throw new Error(packageId + ' source catalogSourceId must match ' + expectedSourceId + '.')
  }
  requiredString(source.location, packageId + ' source location')
  const kind = requiredString(source.kind, packageId + ' source kind')
  const allowedKinds = new Set([
    'npm',
    'pypi',
    'github',
    'git',
    'built-in',
    'local',
    'project',
    'https',
    'mcp-registry',
    'remote',
    'system'
  ])
  if (!allowedKinds.has(kind)) throw new Error(packageId + ' source kind is unsupported.')
  if (kind === 'npm' || kind === 'pypi') {
    requiredString(source.packageName, packageId + ' source packageName')
    requiredString(source.version, packageId + ' source version')
    requiredString(source.resolvedRef, packageId + ' source resolvedRef')
    const digest = requiredRecord(source.digest, packageId + ' source digest')
    const expectedAlgorithm = kind === 'npm' ? 'sha512-sri' : 'sha256'
    if (digest.algorithm !== expectedAlgorithm) {
      throw new Error(packageId + ' source digest algorithm is invalid.')
    }
    requiredString(digest.value, packageId + ' source digest value')
  }
  if (kind === 'github' || kind === 'git') {
    const resolvedRef = requiredString(source.resolvedRef, packageId + ' source resolvedRef')
    if (!IMMUTABLE_COMMIT.test(resolvedRef)) {
      throw new Error(packageId + ' Git source must use an immutable commit.')
    }
  }
  if (kind === 'github') {
    requiredString(source.owner, packageId + ' GitHub source owner')
    requiredString(source.repository, packageId + ' GitHub source repository')
    requiredString(source.defaultBranch, packageId + ' GitHub source defaultBranch')
  }
  if (kind === 'git') requiredString(source.defaultBranch, packageId + ' Git source defaultBranch')
  return id
}

function assertRuntimeShape(
  value: unknown,
  packageId: string,
  componentType: string,
  componentSource: Record<string, unknown>
): void {
  const runtime = requiredRecord(value, packageId + ' component runtime')
  const kind = requiredString(runtime.kind, packageId + ' component runtime kind')
  const allowedByType: Record<string, Set<string>> = {
    mcp: new Set(['remote', 'npm', 'uv', 'bundled', 'system']),
    cli: new Set(['npm', 'github', 'uv', 'bundled', 'system']),
    skill: new Set(['npm', 'github', 'bundled', 'system'])
  }
  if (!allowedByType[componentType]?.has(kind)) {
    throw new Error(packageId + ' component runtime is incompatible with its type.')
  }
  if (kind === 'remote') {
    if (runtime.transport !== 'streamable-http' && runtime.transport !== 'sse') {
      throw new Error(packageId + ' remote transport is invalid.')
    }
    const endpoint = requiredString(runtime.endpoint, packageId + ' remote endpoint')
    if (runtime.oauthResource !== undefined) {
      const oauthResource = requiredString(runtime.oauthResource, packageId + ' OAuth resource')
      try {
        assertSafeHttpsUrl(oauthResource, false)
      } catch (error) {
        throw new Error(packageId + ' OAuth resource is invalid: ' + errorMessage(error))
      }
    }
    if (componentSource.kind !== 'remote' || componentSource.location !== endpoint) {
      throw new Error(packageId + ' remote runtime endpoint must match its component source.')
    }
  } else if (kind === 'bundled') {
    assertPortablePackagePath(runtime.entrypoint, packageId + ' bundled entrypoint')
    if (runtime.managedRuntime !== undefined && runtime.managedRuntime !== 'uv') {
      throw new Error(packageId + ' bundled managed runtime is invalid.')
    }
    if (runtime.executable !== undefined) {
      const executable = requiredString(runtime.executable, packageId + ' bundled executable')
      if (executable.includes('\0') || /[\r\n]/.test(executable) || executable.startsWith('-')) {
        throw new Error(packageId + ' bundled executable is invalid.')
      }
    }
    if (runtime.args !== undefined) {
      const args = requiredArray(runtime.args, packageId + ' bundled args')
      if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
        throw new Error(packageId + ' bundled args must be safe strings.')
      }
    }
  } else if (kind === 'system') {
    requiredString(runtime.provider, packageId + ' system provider')
    requiredString(runtime.capability, packageId + ' system capability')
    if (componentSource.kind !== 'system') {
      throw new Error(packageId + ' system runtime must use a system component source.')
    }
  } else if (kind === 'github') {
    const repository = requiredString(runtime.repository, packageId + ' GitHub repository')
    const commit = requiredString(runtime.resolvedCommit, packageId + ' GitHub resolvedCommit')
    if (!IMMUTABLE_COMMIT.test(commit)) throw new Error(packageId + ' GitHub commit is mutable.')
    const install = requiredRecord(runtime.install, packageId + ' GitHub install')
    if (install.strategy !== 'managed-git' || install.verifyBeforeActivation !== true) {
      throw new Error(packageId + ' GitHub install verification is invalid.')
    }
    if (componentSource.kind !== 'github' ||
        componentSource.location !== repository ||
        componentSource.resolvedRef !== commit ||
        componentSource.subpath !== runtime.subpath) {
      throw new Error(packageId + ' GitHub runtime must match its component source.')
    }
  } else {
    const packageName = requiredString(runtime.packageName, packageId + ' runtime packageName')
    const version = requiredString(runtime.version, packageId + ' runtime version')
    requiredString(runtime.executable, packageId + ' runtime executable')
    const args = requiredArray(runtime.args, packageId + ' runtime args')
    if (args.some((arg) => typeof arg !== 'string')) {
      throw new Error(packageId + ' runtime args must be strings.')
    }
    const install = requiredRecord(runtime.install, packageId + ' runtime install')
    if (kind === 'npm') {
      if (install.strategy !== 'managed-download' ||
          install.verify !== 'sri-before-activation' ||
          install.digestSource !== 'component-source') {
        throw new Error(packageId + ' npm install verification is invalid.')
      }
      if (componentSource.kind !== 'npm' ||
          componentSource.packageName !== packageName ||
          componentSource.version !== version) {
        throw new Error(packageId + ' npm runtime packageName and version must match its component source.')
      }
    } else {
      const digest = requiredRecord(install.digest, packageId + ' wheel install digest')
      if (install.strategy !== 'managed-wheel' ||
          install.verify !== 'sha256-before-activation' ||
          digest.algorithm !== 'sha256') {
        throw new Error(packageId + ' wheel install verification is invalid.')
      }
      requiredString(digest.value, packageId + ' wheel install digest value')
      if (componentSource.kind !== 'pypi' ||
          componentSource.packageName !== packageName ||
          componentSource.version !== version ||
          canonicalJson(componentSource.digest) !== canonicalJson(digest)) {
        throw new Error(packageId + ' uv runtime package, version, and digest must match its component source.')
      }
    }
  }
}

function assertPermissionShape(value: unknown, packageId: string): void {
  const permission = requiredRecord(value, packageId + ' permission')
  requiredString(permission.id, packageId + ' permission id')
  if (!new Set(['filesystem', 'network', 'browser', 'database', 'process', 'credentials'])
    .has(String(permission.kind))) {
    throw new Error(packageId + ' permission kind is invalid.')
  }
  if (!new Set(['read', 'write', 'execute', 'connect', 'control', 'authenticate'])
    .has(String(permission.access))) {
    throw new Error(packageId + ' permission access is invalid.')
  }
  if (!new Set(['granted', 'denied', 'review']).has(String(permission.default)) ||
      typeof permission.reviewRequired !== 'boolean') {
    throw new Error(packageId + ' permission decision is invalid.')
  }
  requiredString(permission.description, packageId + ' permission description')
  if (permission.resources !== undefined) {
    assertNonEmptyStrings(permission.resources, packageId + ' permission resources')
  }
}

function assertAuthShape(value: unknown, packageId: string): void {
  const auth = requiredRecord(value, packageId + ' auth')
  if (auth.type === 'none') return
  if (auth.type === 'token') {
    requiredString(auth.provider, packageId + ' token provider')
    const variables = requiredArray(auth.environmentVariables, packageId + ' token environmentVariables')
    if (variables.some((item) => typeof item !== 'string')) {
      throw new Error(packageId + ' token environmentVariables must be strings.')
    }
    return
  }
  if (auth.type === 'tool-managed') {
    requiredString(auth.provider, packageId + ' managed auth provider')
    return
  }
  if (auth.type === 'oauth') {
    requiredString(auth.provider, packageId + ' OAuth provider')
    if (auth.discovery !== 'ready' && auth.discovery !== 'pending') {
      throw new Error(packageId + ' OAuth discovery state is invalid.')
    }
    if (auth.scopes !== undefined) assertNonEmptyStrings(auth.scopes, packageId + ' OAuth scopes')
    return
  }
  throw new Error(packageId + ' auth type is invalid.')
}

function assertPackageShape(
  rawPackage: unknown,
  expectedSourceId: string,
  packageIds: Set<string>,
  allowVerifiedPublisher: boolean
): MarketplacePackageV1 {
  const value = requiredRecord(rawPackage, 'Catalog package')
  if (value.schemaVersion !== 1) throw new Error('Catalog package schemaVersion must be 1.')
  const id = requiredString(value.id, 'Catalog package id')
  if (packageIds.has(id)) throw new Error('Catalog snapshot contains duplicate package ID: ' + id)
  packageIds.add(id)
  requiredString(value.name, id + ' name')
  requiredString(value.summary, id + ' summary')
  requiredString(value.version, id + ' version')
  if (value.tier !== 'recommended' && value.tier !== 'advanced') {
    throw new Error(id + ' tier is invalid.')
  }
  if (value.categories !== undefined) {
    assertNonEmptyStrings(value.categories, id + ' categories')
  }
  if (value.collections !== undefined) {
    const collections = assertNonEmptyStrings(value.collections, id + ' collections')
    const allowedCollections = new Set([
      'development',
      'productivity',
      'documents',
      'writing',
      'data',
      'collaboration',
      'engineering'
    ])
    if (collections.some((item) => !allowedCollections.has(item))) {
      throw new Error(id + ' collection is invalid.')
    }
  }
  if (value.productType !== undefined && !new Set(['app', 'connector', 'workflow', 'utility']).has(String(value.productType))) {
    throw new Error(id + ' productType is invalid.')
  }
  if (value.icon !== undefined) {
    const icon = requiredRecord(value.icon, id + ' icon')
    if (icon.kind !== 'monogram' && icon.kind !== 'asset') throw new Error(id + ' icon kind is invalid.')
    const iconValue = requiredString(icon.value, id + ' icon value')
    if (icon.kind === 'asset' && (/^https?:/i.test(iconValue) || iconValue.includes('..'))) {
      throw new Error(id + ' icon asset must be a local packaged path.')
    }
    if (icon.tone !== undefined && !new Set(['blue', 'teal', 'green', 'orange', 'red', 'violet', 'slate']).has(String(icon.tone))) {
      throw new Error(id + ' icon tone is invalid.')
    }
  }
  const publisher = requiredRecord(value.publisher, id + ' publisher')
  requiredString(publisher.id, id + ' publisher id')
  requiredString(publisher.name, id + ' publisher name')
  if (typeof publisher.verified !== 'boolean') throw new Error(id + ' publisher verified is required.')
  if (publisher.verified && !allowVerifiedPublisher) {
    throw new Error(id + ' publisher cannot claim verified status from this catalog source.')
  }
  if (publisher.url !== undefined) {
    const publisherUrl = requiredString(publisher.url, id + ' publisher URL')
    try {
      assertSafeHttpsUrl(publisherUrl, false)
    } catch (error) {
      throw new Error(id + ' publisher URL is invalid: ' + errorMessage(error))
    }
  }
  if (value.license !== null && typeof value.license !== 'string') {
    throw new Error(id + ' license must be a string or null.')
  }

  const rawSources = requiredArray(value.sources, id + ' sources')
  if (rawSources.length === 0) throw new Error(id + ' sources must not be empty.')
  const sourceIds = new Set<string>()
  for (const rawSource of rawSources) {
    const sourceId = assertPackageSourceShape(rawSource, id, expectedSourceId)
    if (sourceIds.has(sourceId)) throw new Error(id + ' contains duplicate package source IDs.')
    sourceIds.add(sourceId)
  }
  const primary = requiredRecord(value.source, id + ' primary source')
  const primaryId = assertPackageSourceShape(primary, id, expectedSourceId)
  const matchingSource = rawSources.find((source) =>
    isRecord(source) && source.id === primaryId
  )
  if (!matchingSource || canonicalJson(primary) !== canonicalJson(matchingSource)) {
    throw new Error(id + ' primary source provenance conflicts with sources.')
  }
  if (!sourceIds.has(String(primary.id))) throw new Error(id + ' primary source is missing from sources.')

  for (const rawComponent of requiredArray(value.components, id + ' components')) {
    const component = requiredRecord(rawComponent, id + ' component')
    requiredString(component.id, id + ' component id')
    requiredString(component.name, id + ' component name')
    const type = requiredString(component.type, id + ' component type')
    if (type !== 'mcp' && type !== 'cli' && type !== 'skill') {
      throw new Error(id + ' component type is invalid.')
    }
    const sourceId = requiredString(component.sourceId, id + ' component sourceId')
    if (!sourceIds.has(sourceId)) throw new Error(id + ' component references an unknown source.')
    const componentSource = rawSources.find((source) => isRecord(source) && source.id === sourceId)
    if (!componentSource || !isRecord(componentSource)) {
      throw new Error(id + ' component source is invalid.')
    }
    assertRuntimeShape(component.runtime, id, type, componentSource)
    if (type === 'skill') {
      const names = requiredArray(component.skillNames, id + ' skillNames')
      if (names.some((name) => typeof name !== 'string' || !name.trim())) {
        throw new Error(id + ' skillNames must be non-empty strings.')
      }
    }
  }

  const permissionIds = new Set<string>()
  for (const permission of requiredArray(value.permissions, id + ' permissions')) {
    assertPermissionShape(permission, id)
    const permissionId = String((permission as Record<string, unknown>).id)
    if (permissionIds.has(permissionId)) throw new Error(id + ' contains duplicate permission IDs.')
    permissionIds.add(permissionId)
  }
  assertAuthShape(value.auth, id)
  for (const rawEvidence of requiredArray(value.licenseEvidence, id + ' licenseEvidence')) {
    const evidence = requiredRecord(rawEvidence, id + ' license evidence')
    const sourceId = requiredString(evidence.sourceId, id + ' license evidence sourceId')
    if (!sourceIds.has(sourceId)) throw new Error(id + ' license evidence references an unknown source.')
    requiredString(evidence.license, id + ' license evidence license')
    requiredString(evidence.path, id + ' license evidence path')
    if (evidence.includeInInstall !== true || evidence.required !== true) {
      throw new Error(id + ' license evidence must be required for installation.')
    }
  }
  for (const rawDependency of requiredArray(value.dependencies, id + ' dependencies')) {
    const dependency = requiredRecord(rawDependency, id + ' dependency')
    requiredString(dependency.id, id + ' dependency id')
    if (!new Set(['package', 'runtime', 'system']).has(String(dependency.kind)) ||
        typeof dependency.optional !== 'boolean') {
      throw new Error(id + ' dependency metadata is invalid.')
    }
    requiredString(dependency.requirement, id + ' dependency requirement')
    if (dependency.managedBy !== undefined &&
        !new Set(['workwise', 'system', 'user']).has(String(dependency.managedBy))) {
      throw new Error(id + ' dependency manager is invalid.')
    }
  }
  if (value.hooks !== undefined) {
    const hookIds = new Set<string>()
    for (const rawHook of requiredArray(value.hooks, id + ' hooks')) {
      const hook = requiredRecord(rawHook, id + ' hook')
      const hookId = requiredString(hook.id, id + ' hook id')
      if (hookIds.has(hookId)) throw new Error(id + ' contains duplicate hook IDs.')
      hookIds.add(hookId)
      requiredString(hook.event, id + ' hook event')
      if (hook.matcher !== undefined) requiredString(hook.matcher, id + ' hook matcher')
      const command = requiredString(hook.command, id + ' hook command')
      if (command.includes('\0')) throw new Error(id + ' hook command is invalid.')
      if (hook.enabledByDefault !== false || hook.execution !== 'disabled-pending-review') {
        throw new Error(id + ' hooks must remain disabled pending review.')
      }
      const references = assertNonEmptyStrings(hook.permissionIds, id + ' hook permissionIds')
      if (references.some((permissionId) => !permissionIds.has(permissionId))) {
        throw new Error(id + ' hook references an unknown permission.')
      }
    }
  }
  if (value.signature !== undefined) {
    const signature = requiredRecord(value.signature, id + ' signature')
    if (signature.status === 'unsigned') {
      // Unsigned packages carry no signer-controlled trust metadata.
    } else if (signature.status === 'untrusted') {
      if (signature.algorithm !== 'ed25519') throw new Error(id + ' signature algorithm is invalid.')
      requiredString(signature.keyId, id + ' signature keyId')
      requiredString(signature.reason, id + ' signature reason')
    } else if (signature.status === 'verified') {
      throw new Error(id + ' artifact signature must be verified after download.')
    } else {
      throw new Error(id + ' signature status is invalid.')
    }
  }
  if (value.configuration !== undefined) {
    const configurationKeys = new Set<string>()
    for (const rawField of requiredArray(value.configuration, id + ' configuration')) {
      const field = requiredRecord(rawField, id + ' configuration field')
      const key = requiredString(field.key, id + ' configuration key')
      if (configurationKeys.has(key)) throw new Error(id + ' contains duplicate configuration keys.')
      configurationKeys.add(key)
      const type = requiredString(field.type, id + ' configuration type')
      if (!new Set(['string', 'number', 'boolean', 'directory', 'file']).has(type)) {
        throw new Error(id + ' configuration type is invalid.')
      }
      requiredString(field.title, id + ' configuration title')
      if (field.description !== undefined) {
        requiredString(field.description, id + ' configuration description')
      }
      if (typeof field.required !== 'boolean' || typeof field.sensitive !== 'boolean' ||
          typeof field.multiple !== 'boolean') {
        throw new Error(id + ' configuration flags are invalid.')
      }
      if (field.multiple && type !== 'string' && type !== 'directory' && type !== 'file') {
        throw new Error(id + ' multiple configuration is only supported for string and path values.')
      }
      if (field.defaultValue !== undefined) {
        const validDefault = field.multiple
          ? Array.isArray(field.defaultValue) && field.defaultValue.every((item) => typeof item === 'string')
          : type === 'number'
            ? typeof field.defaultValue === 'number' && Number.isFinite(field.defaultValue)
            : type === 'boolean'
              ? typeof field.defaultValue === 'boolean'
              : typeof field.defaultValue === 'string'
        if (!validDefault) throw new Error(id + ' configuration defaultValue does not match its type.')
      }
    }
  }
  const updatePolicy = requiredRecord(value.updatePolicy, id + ' updatePolicy')
  if (!new Set(['pinned', 'manual', 'system-managed']).has(String(updatePolicy.strategy)) ||
      !new Set(['stable', 'preview', 'managed']).has(String(updatePolicy.channel)) ||
      typeof updatePolicy.allowMajor !== 'boolean') {
    throw new Error(id + ' update policy is invalid.')
  }
  const compatibility = requiredRecord(value.compatibility, id + ' compatibility')
  requiredString(compatibility.workwise, id + ' compatibility workwise')
  const platforms = requiredArray(compatibility.platforms, id + ' compatibility platforms')
  const architectures = requiredArray(compatibility.architectures, id + ' compatibility architectures')
  if (platforms.some((item) => !new Set(['darwin', 'win32', 'linux']).has(String(item))) ||
      architectures.some((item) => !new Set(['arm64', 'x64']).has(String(item)))) {
    throw new Error(id + ' compatibility values are invalid.')
  }
  const availability = requiredRecord(value.availability, id + ' availability')
  if (availability.status === 'managed') requiredString(availability.managedBy, id + ' managedBy')
  else if (availability.status === 'unavailable') {
    requiredString(availability.reasonCode, id + ' availability reasonCode')
    requiredString(availability.message, id + ' availability message')
  } else if (availability.status !== 'available') {
    throw new Error(id + ' availability status is invalid.')
  }
  const installation = requiredRecord(value.installation, id + ' installation')
  if (!new Set(['direct-mirror', 'upstream-only', 'external', 'system-managed']).has(String(installation.mode)) ||
      typeof installation.installedByDefault !== 'boolean' ||
      typeof installation.reinstallable !== 'boolean') {
    throw new Error(id + ' installation metadata is invalid.')
  }
  if (installation.mode === 'direct-mirror' && installation.reinstallable !== true) {
    throw new Error(id + ' direct mirror packages must be reinstallable.')
  }
  if (installation.mode === 'external' && (installation.installedByDefault || installation.reinstallable)) {
    throw new Error(id + ' external packages cannot be installed by default.')
  }
  if (installation.mode === 'system-managed' && installation.reinstallable) {
    throw new Error(id + ' system-managed packages cannot be reinstallable.')
  }
  if (installation.mode === 'upstream-only' && !isApprovedUpstreamPackage(value as unknown as MarketplacePackageV1)) throw new Error(id + ' upstream installation is not approved.')
  return clone(value as unknown as MarketplacePackageV1)
}

export function parseCatalogPackageArtifact(
  value: unknown,
  expectedSourceId: string
): MarketplacePackageV1 {
  return assertPackageShape(value, expectedSourceId, new Set(), true)
}

function assertSnapshot(
  value: unknown,
  expectedSourceId: string,
  allowVerifiedPublisher = false
): CatalogSnapshotV1 {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.sourceId !== expectedSourceId) {
    throw new Error('Catalog snapshot sourceId must match ' + expectedSourceId + '.')
  }
  if (typeof value.revision !== 'string' || !value.revision.trim()) {
    throw new Error('Catalog snapshot revision is required.')
  }
  if (value.generatedAt !== undefined &&
      (typeof value.generatedAt !== 'string' ||
       Number.isNaN(Date.parse(value.generatedAt)) ||
       new Date(value.generatedAt).toISOString() !== value.generatedAt)) {
    throw new Error('Catalog snapshot generatedAt must be an ISO timestamp.')
  }
  if (value.commit !== undefined &&
      (typeof value.commit !== 'string' || !IMMUTABLE_COMMIT.test(value.commit))) {
    throw new Error('Catalog snapshot commit must be an immutable SHA.')
  }
  if (!Array.isArray(value.packages)) throw new Error('Catalog snapshot packages must be an array.')
  if (value.packages.length > MAX_CATALOG_PACKAGES) {
    throw new Error('Catalog snapshot exceeds the 5,000 packages limit.')
  }

  const packageIds = new Set<string>()
  const packages = value.packages.map((item) =>
    assertPackageShape(item, expectedSourceId, packageIds, allowVerifiedPublisher)
  )
  return clone({ ...value, packages } as unknown as CatalogSnapshotV1)
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error('Catalog JSON is malformed: ' + errorMessage(error))
  }
}

function adaptCatalogValue(
  value: unknown,
  source: CatalogSourceV1,
  context: { revision: string; generatedAt?: string; commit?: string }
): CatalogSnapshotV1 {
  const allowVerifiedPublisher = source.trust === 'system' ||
    source.trust === 'official' || source.trust === 'verified'
  if (isRecord(value) && value.schemaVersion !== undefined) {
    return assertSnapshot(value, source.id, allowVerifiedPublisher)
  }
  return assertSnapshot(adaptCodexMarketplace(value, {
    source,
    revision: context.revision,
    ...(context.generatedAt ? { generatedAt: context.generatedAt } : {}),
    ...(context.commit ? { commit: context.commit } : {})
  }), source.id, allowVerifiedPublisher)
}

function parseCatalogText(
  text: string,
  source: CatalogSourceV1,
  context: { revision?: string; generatedAt?: string; commit?: string } = {}
): CatalogSnapshotV1 {
  return adaptCatalogValue(parseJsonText(text), source, {
    revision: context.revision ?? snapshotDigest(text),
    ...(context.generatedAt ? { generatedAt: context.generatedAt } : {}),
    ...(context.commit ? { commit: context.commit } : {})
  })
}

function decodeGithubContents(value: unknown): unknown {
  const response = requiredRecord(value, 'GitHub contents response')
  if (response.type !== 'file' || response.encoding !== 'base64') {
    throw new Error('GitHub marketplace content must be a base64-encoded file.')
  }
  const encoded = requiredString(response.content, 'GitHub marketplace content').replace(/\s/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('GitHub marketplace content is not valid base64.')
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength > MAX_CATALOG_JSON_BYTES) {
    throw new Error('Catalog JSON exceeds the 10 MiB limit.')
  }
  return parseJsonText(decoded.toString('utf8'))
}

function builtInSnapshot(): CatalogSnapshotV1 {
  return {
    schemaVersion: 1,
    sourceId: 'workwise-official',
    revision: 'official-v1',
    packages: getOfficialMarketplaceCatalog()
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Catalog request was aborted.')
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw abortError(signal)
  return new Promise((resolveRead, rejectRead) => {
    const onAbort = (): void => rejectRead(abortError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(resolveRead, rejectRead).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}

async function resolveWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal)
  return new Promise((resolveOperation, rejectOperation) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      rejectOperation(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => {
        cleanup()
        resolveOperation(value)
      },
      (error) => {
        cleanup()
        rejectOperation(error)
      }
    )
  })
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const declaredBytes = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CATALOG_JSON_BYTES) {
    await response.body?.cancel('Catalog JSON exceeds the 10 MiB limit.')
    throw new Error('Catalog JSON exceeds the 10 MiB limit.')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await readWithAbort(reader, signal)
      if (result.done) break
      const chunk = Buffer.from(result.value)
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_CATALOG_JSON_BYTES) {
        await reader.cancel('Catalog JSON exceeds the 10 MiB limit.')
        throw new Error('Catalog JSON exceeds the 10 MiB limit.')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8')
}

async function cancelResponse(response: Response, reason: string): Promise<void> {
  await response.body?.cancel(reason).catch(() => undefined)
}

function retryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

class CatalogRequestError extends Error {
  readonly offlineCandidate: boolean

  constructor(message: string, offlineCandidate: boolean) {
    super(message)
    this.name = 'CatalogRequestError'
    this.offlineCandidate = offlineCandidate
  }
}

async function runGitCommand(args: string[]): Promise<string> {
  const result = await execFile(resolveMarketplaceCommand('git'), args, {
    env: marketplaceCommandEnvironment(),
    encoding: 'utf8',
    maxBuffer: MAX_CATALOG_JSON_BYTES,
    timeout: 120_000,
    windowsHide: true
  })
  return String(result.stdout)
}

export class MarketplaceCatalogService {
  private readonly rootDirectory: string
  private readonly sourcesPath: string
  private readonly snapshotDirectory: string
  private readonly workspaceRoot?: string
  private readonly resolveWorkspaceRoot?: () => Promise<string | undefined>
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly allowLoopbackHttp: boolean
  private readonly beforePersistSources?: (sources: readonly CatalogSourceV1[]) => Promise<void>
  private readonly fetchTimeoutMs: number
  private readonly resolveSecret?: (secretKey: string) => Promise<string | null>
  private readonly fileSourceReadHook?: (
    phase: 'resolved' | 'opened',
    path: string
  ) => Promise<void>
  private readonly runGit: (args: string[]) => Promise<string>
  private readonly sources: CatalogSourceV1[] = []
  private readonly snapshots = new Map<string, CatalogSnapshotV1>()
  private readonly snapshotPointers = new Map<string, SnapshotPointerV1>()
  private initializePromise: Promise<void> | null = null

  constructor(options: MarketplaceCatalogServiceOptions = {}) {
    this.rootDirectory = resolve(options.rootDirectory ?? join(homedir(), '.workwise', 'marketplace'))
    this.sourcesPath = join(this.rootDirectory, 'sources.json')
    this.snapshotDirectory = join(this.rootDirectory, 'snapshots')
    this.workspaceRoot = options.workspaceRoot ? resolve(options.workspaceRoot) : undefined
    this.resolveWorkspaceRoot = options.resolveWorkspaceRoot
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
    this.allowLoopbackHttp = options.allowLoopbackHttp ?? false
    this.beforePersistSources = options.beforePersistSources
    this.fetchTimeoutMs = Math.min(Math.max(options.fetchTimeoutMs ?? 30_000, 1_000), 120_000)
    this.resolveSecret = options.resolveSecret
    this.fileSourceReadHook = options.fileSourceReadHook
    this.runGit = options.runGit ?? runGitCommand
  }

  async listSources(): Promise<CatalogSourceV1[]> {
    await this.ensureInitialized()
    await this.refreshStateFromDisk()
    return clone(this.sources)
  }

  async getSnapshot(sourceId: string): Promise<CatalogSnapshotV1 | null> {
    await this.ensureInitialized()
    await this.refreshStateFromDisk()
    return clone(this.snapshots.get(sourceId) ?? null)
  }

  async listPackages(): Promise<MarketplaceCatalogPackagesResultV1> {
    await this.ensureInitialized()
    await this.refreshStateFromDisk()
    const ordered = this.sources.flatMap((source) =>
      (this.snapshots.get(source.id)?.packages ?? []).map((item) => ({
        key: source.id + ':' + item.id,
        sourceId: source.id,
        package: clone(item),
        reviewSha256: marketplacePackageReviewSha256(item),
        conflicted: false
      }))
    )
    const byPackageId = new Map<string, typeof ordered>()
    for (const entry of ordered) {
      const matches = byPackageId.get(entry.package.id) ?? []
      matches.push(entry)
      byPackageId.set(entry.package.id, matches)
    }
    const conflicts: MarketplaceCatalogPackagesResultV1['conflicts'] = []
    for (const [packageId, matches] of byPackageId) {
      if (matches.length < 2) continue
      for (const match of matches) match.conflicted = true
      conflicts.push({
        packageId,
        sourceIds: matches.map((entry) => entry.sourceId),
        keys: matches.map((entry) => entry.key)
      })
    }
    return clone({ packages: ordered, conflicts })
  }

  async upsertSource(input: CatalogSourceV1): Promise<CatalogSourceV1> {
    await this.ensureInitialized()
    const requested = sanitizeSource(input)
    assertSourceShape(requested, this.allowLoopbackHttp)
    if (requested.type === 'built-in' || requested.scope === 'system' ||
        requested.trust === 'system' || requested.trust === 'official' ||
        requested.trust === 'verified') {
      throw new Error('Privileged and reserved catalog sources cannot be created by users.')
    }
    return runSerialized('catalog-sync:' + this.rootDirectory + ':' + requested.id, () =>
      runSerialized('catalog-manifest:' + this.rootDirectory, async () => {
        await this.reloadStateFromDisk()
        const index = this.sources.findIndex((entry) => entry.id === requested.id)
        const current = index >= 0 ? this.sources[index]! : null
        if (current && (current.type === 'built-in' || current.scope === 'system')) {
          throw new Error('System and built-in catalog sources cannot be modified.')
        }
        const identityChanged = Boolean(current && sourceIdentity(current) !== sourceIdentity(requested))
        const source = current && !identityChanged
          ? this.preserveServiceSync(requested, current)
          : resetServiceOwnedSync(requested)
        const previousPointer = this.snapshotPointers.get(source.id)
        if (index >= 0) this.sources[index] = source
        else this.sources.push(source)
        if (identityChanged) {
          this.snapshots.delete(source.id)
          this.snapshotPointers.delete(source.id)
        }
        try {
          await this.persistSources()
        } catch (error) {
          await this.reloadStateFromDisk()
          throw error
        }
        if (identityChanged && previousPointer) {
          await rm(this.snapshotPath(source.id, previousPointer), { force: true }).catch(() => undefined)
        }
        return clone(source)
      })
    )
  }

  async removeSource(sourceId: string): Promise<void> {
    await this.ensureInitialized()
    await runSerialized('catalog-sync:' + this.rootDirectory + ':' + sourceId, () =>
      runSerialized('catalog-manifest:' + this.rootDirectory, async () => {
        await this.reloadStateFromDisk()
        const index = this.sources.findIndex((entry) => entry.id === sourceId)
        if (index < 0) return
        const source = this.sources[index]!
        if (source.type === 'built-in' || source.scope === 'system') {
          throw new Error('System and built-in catalog sources cannot be removed.')
        }
        const pointer = this.snapshotPointers.get(sourceId)
        this.sources.splice(index, 1)
        this.snapshots.delete(sourceId)
        this.snapshotPointers.delete(sourceId)
        try {
          await this.persistSources()
        } catch (error) {
          await this.reloadStateFromDisk()
          throw error
        }
        if (pointer) {
          await rm(this.snapshotPath(sourceId, pointer), { force: true }).catch(() => undefined)
        }
      })
    )
  }

  async syncSource(sourceId: string): Promise<MarketplaceCatalogSyncResultV1> {
    await this.ensureInitialized()
    return runSerialized('catalog-sync:' + this.rootDirectory + ':' + sourceId, async () => {
      await this.refreshStateFromDisk()
      if (!this.sources.some((entry) => entry.id === sourceId)) {
        throw new Error('Catalog source was not found: ' + sourceId)
      }
      await this.recordSyncing(sourceId)
      const currentSource = this.sources.find((entry) => entry.id === sourceId)
      if (!currentSource) throw new Error('Catalog source was removed during synchronization.')
      if (currentSource.type === 'built-in') return this.syncBuiltIn(currentSource)
      if (currentSource.type === 'local' || currentSource.type === 'project') return this.syncFile(currentSource)
      if (currentSource.type === 'https') return this.syncHttps(currentSource)
      if (currentSource.type === 'github') return this.syncGithub(currentSource)
      if (currentSource.type === 'git') return this.syncGit(currentSource)
      if (currentSource.type === 'mcp-registry') return this.syncMcpRegistry(currentSource)
      throw new Error('Catalog source type is not supported: ' + sourceId)
    })
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = runSerialized('catalog-manifest:' + this.rootDirectory, async () => {
        await mkdir(this.snapshotDirectory, { recursive: true })
        await this.reloadStateFromDisk()
        const official = builtInSnapshot()
        const pointer = await this.persistSnapshot(official)
        this.snapshots.set(official.sourceId, official)
        this.snapshotPointers.set(official.sourceId, pointer)
        await this.persistSources()
      })
    }
    await this.initializePromise
  }

  private snapshotPath(sourceId: string, pointer: SnapshotPointerV1): string {
    const expected = sourceCacheName(sourceId, pointer.sha256)
    if (pointer.file !== expected || basename(pointer.file) !== pointer.file) {
      throw new Error('Marketplace snapshot pointer is invalid.')
    }
    return join(this.snapshotDirectory, pointer.file)
  }

  private async readPersistedManifest(): Promise<SourceManifestV1 | null> {
    try {
      const text = await readRecoveredFile(this.sourcesPath)
      const parsed = JSON.parse(text) as Partial<SourceManifestV1>
      if (parsed.schema !== SOURCE_MANIFEST_SCHEMA ||
          parsed.version !== SOURCE_MANIFEST_VERSION ||
          !Array.isArray(parsed.sources)) {
        throw new Error('Marketplace source manifest is invalid.')
      }
      if (parsed.snapshots !== undefined && !isRecord(parsed.snapshots)) {
        throw new Error('Marketplace snapshot manifest is invalid.')
      }
      return parsed as SourceManifestV1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private parseSnapshotPointer(sourceId: string, value: unknown): SnapshotPointerV1 {
    const pointer = requiredRecord(value, 'Marketplace snapshot pointer')
    const file = requiredString(pointer.file, 'Marketplace snapshot file')
    const revision = requiredString(pointer.revision, 'Marketplace snapshot revision')
    const sha256 = requiredString(pointer.sha256, 'Marketplace snapshot SHA-256')
    if (!/^[0-9a-f]{64}$/i.test(sha256) ||
        file !== sourceCacheName(sourceId, sha256) ||
        basename(file) !== file) {
      throw new Error('Marketplace snapshot pointer is invalid.')
    }
    return { file, revision, sha256: sha256.toLowerCase() }
  }

  private mergeSources(persisted: CatalogSourceV1[] | null): CatalogSourceV1[] {
    const defaults = getMarketplaceCatalogSources().map(sanitizeSource)
    if (!persisted) return defaults
    const seen = new Set<string>()
    const systemMetadata = new Map<string, CatalogSourceV1>()
    const userSources: CatalogSourceV1[] = []
    const defaultsById = new Map(defaults.map((source) => [source.id, source]))
    for (const input of persisted) {
      const source = sanitizeSource(input)
      assertSourceShape(source, this.allowLoopbackHttp)
      if (seen.has(source.id)) throw new Error('Marketplace source manifest has duplicate source IDs.')
      seen.add(source.id)
      const defaultSource = defaultsById.get(source.id)
      if (defaultSource) {
        if (source.type === defaultSource.type &&
            source.scope === defaultSource.scope &&
            source.location === defaultSource.location) {
          systemMetadata.set(source.id, source)
        }
        continue
      }
      if (source.type === 'built-in' || source.scope === 'system' ||
          source.trust === 'system' || source.trust === 'official' ||
          source.trust === 'verified') {
        throw new Error('Persisted manifest contains a privileged or reserved user source.')
      }
      userSources.push(source)
    }
    return [
      ...defaults.map((source) => {
        const persistedDefault = systemMetadata.get(source.id)
        return persistedDefault ? { ...source, sync: persistedDefault.sync } : source
      }),
      ...userSources
    ]
  }

  private async refreshStateFromDisk(): Promise<void> {
    await runSerialized('catalog-manifest:' + this.rootDirectory, () => this.reloadStateFromDisk())
  }

  private async reloadStateFromDisk(): Promise<void> {
    const manifest = await this.readPersistedManifest()
    const sources = this.mergeSources(manifest?.sources ?? null)
    const snapshots = new Map<string, CatalogSnapshotV1>()
    const pointers = new Map<string, SnapshotPointerV1>()
    const official = builtInSnapshot()
    snapshots.set(official.sourceId, official)
    const sourceIds = new Set(sources.map((source) => source.id))
    for (const [sourceId, rawPointer] of Object.entries(manifest?.snapshots ?? {})) {
      if (!sourceIds.has(sourceId)) continue
      try {
        const pointer = this.parseSnapshotPointer(sourceId, rawPointer)
        const text = await readRecoveredFile(this.snapshotPath(sourceId, pointer))
        if (snapshotDigest(text) !== pointer.sha256) {
          throw new Error('Marketplace snapshot digest does not match its manifest pointer.')
        }
        const source = sources.find((entry) => entry.id === sourceId)
        const snapshot = assertSnapshot(
          parseJsonText(text),
          sourceId,
          source?.trust === 'system' || source?.trust === 'official' || source?.trust === 'verified'
        )
        if (snapshot.revision !== pointer.revision) {
          throw new Error('Marketplace snapshot revision does not match its manifest pointer.')
        }
        if (sourceId === official.sourceId &&
            pointer.sha256 !== snapshotDigest(snapshotContent(official))) {
          continue
        }
        snapshots.set(sourceId, sourceId === official.sourceId ? official : snapshot)
        pointers.set(sourceId, pointer)
      } catch {
        // An invalid cache is ignored. Only the manifest-addressed, verified snapshot is trusted.
      }
    }
    this.sources.splice(0, this.sources.length, ...sources)
    this.snapshots.clear()
    this.snapshotPointers.clear()
    for (const [sourceId, snapshot] of snapshots) this.snapshots.set(sourceId, snapshot)
    for (const [sourceId, pointer] of pointers) this.snapshotPointers.set(sourceId, pointer)
  }

  private async persistSources(): Promise<void> {
    const manifest: SourceManifestV1 = {
      schema: SOURCE_MANIFEST_SCHEMA,
      version: SOURCE_MANIFEST_VERSION,
      sources: this.sources.map(sanitizeSource),
      snapshots: Object.fromEntries(
        [...this.snapshotPointers].filter(([sourceId]) =>
          this.sources.some((source) => source.id === sourceId)
        )
      )
    }
    await this.beforePersistSources?.(clone(this.sources))
    await atomicWriteFile(this.sourcesPath, JSON.stringify(manifest, null, 2) + '\n')
  }

  private async recordSyncing(sourceId: string): Promise<void> {
    await runSerialized('catalog-manifest:' + this.rootDirectory, async () => {
      await this.reloadStateFromDisk()
      const source = this.sources.find((entry) => entry.id === sourceId)
      if (!source) throw new Error('Catalog source was removed during synchronization.')
      source.sync = { ...source.sync, state: 'syncing' }
      delete source.sync.error
      try {
        await this.persistSources()
      } catch (error) {
        await this.reloadStateFromDisk()
        throw error
      }
    })
  }

  private async persistSnapshot(snapshot: CatalogSnapshotV1): Promise<SnapshotPointerV1> {
    const content = snapshotContent(snapshot)
    const sha256 = snapshotDigest(content)
    const pointer = {
      file: sourceCacheName(snapshot.sourceId, sha256),
      revision: snapshot.revision,
      sha256
    }
    await atomicWriteFile(this.snapshotPath(snapshot.sourceId, pointer), content)
    return pointer
  }

  private async syncBuiltIn(source: CatalogSourceV1): Promise<MarketplaceCatalogSyncResultV1> {
    const snapshot = builtInSnapshot()
    await this.acceptSnapshot(source, snapshot, {}, false)
    return clone({ sourceId: source.id, status: 'synced', stale: false, snapshot })
  }

  private async resolveFileSource(source: CatalogSourceV1): Promise<FileSourcePath> {
    const workspaceRoot = this.workspaceRoot ??
      (this.resolveWorkspaceRoot ? await this.resolveWorkspaceRoot().then((value) => value ? resolve(value) : undefined) : undefined)
    const target = source.type === 'project'
      ? resolve(workspaceRoot ?? '', source.location)
      : resolve(source.location)
    if (source.type === 'project' && !workspaceRoot) {
      throw new Error('Project catalogs require a configured workspace root.')
    }
    const separator = process.platform === 'win32' ? '\\' : '/'
    if (source.type === 'project') {
      const rel = relative(workspaceRoot!, target)
      if (rel === '..' || rel.startsWith('..' + separator) || isAbsolute(rel)) {
        throw new Error('Project catalog path escapes the workspace root.')
      }
    }
    const lexicalInfo = await lstat(target)
    if (lexicalInfo.isSymbolicLink()) {
      throw new Error('Catalog files must not be symbolic links.')
    }
    const realTarget = await realpath(target)
    if (source.type === 'project') {
      const realWorkspace = await realpath(workspaceRoot!)
      const realRelative = relative(realWorkspace, realTarget)
      if (realRelative === '..' ||
          realRelative.startsWith('..' + separator) ||
          isAbsolute(realRelative)) {
        throw new Error('Project catalog path escapes the workspace through a symbolic link.')
      }
    }
    await this.fileSourceReadHook?.('resolved', realTarget)
    const resolvedInfo = await lstat(realTarget)
    if (!resolvedInfo.isFile()) throw new Error('Catalog location must be a regular file.')
    return {
      lexicalPath: target,
      realPath: realTarget,
      device: lexicalInfo.dev,
      inode: lexicalInfo.ino
    }
  }

  private async syncFile(source: CatalogSourceV1): Promise<MarketplaceCatalogSyncResultV1> {
    try {
      const sourcePath = await this.resolveFileSource(source)
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      const handle = await open(sourcePath.realPath, flags)
      let text: string
      try {
        await this.fileSourceReadHook?.('opened', sourcePath.realPath)
        const before = await handle.stat()
        if (!before.isFile() || before.dev !== sourcePath.device || before.ino !== sourcePath.inode) {
          throw new Error('Catalog path changed before it could be read safely.')
        }
        if (before.size > MAX_CATALOG_JSON_BYTES) {
          throw new Error('Catalog JSON exceeds the 10 MiB limit.')
        }
        text = await handle.readFile('utf8')
        const after = await handle.stat()
        const lexicalInfo = await lstat(sourcePath.lexicalPath)
        const currentRealPath = await realpath(sourcePath.lexicalPath)
        if (lexicalInfo.isSymbolicLink() || currentRealPath !== sourcePath.realPath ||
            lexicalInfo.dev !== after.dev || lexicalInfo.ino !== after.ino ||
            after.dev !== before.dev || after.ino !== before.ino ||
            after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw new Error('Catalog path changed while it was being read.')
        }
      } finally {
        await handle.close()
      }
      if (Buffer.byteLength(text) > MAX_CATALOG_JSON_BYTES) {
        throw new Error('Catalog JSON exceeds the 10 MiB limit.')
      }
      const snapshot = parseCatalogText(text, source, { generatedAt: this.now().toISOString() })
      await this.acceptSnapshot(source, snapshot, { commit: snapshot.commit })
      return clone({ sourceId: source.id, status: 'synced', stale: false, snapshot })
    } catch (error) {
      return this.recordFailure(source.id, errorMessage(error), false)
    }
  }

  private async requestJson(
    source: CatalogSourceV1,
    url: string,
    initialHeaders: HeadersInit = {}
  ): Promise<{ value: unknown; headers: Headers }> {
    const headers = new Headers(initialHeaders)
    headers.set('accept', 'application/json')
    const controller = new AbortController()
    const timeoutError = new Error('Catalog request timed out.')
    const timeout = setTimeout(() => controller.abort(timeoutError), this.fetchTimeoutMs)
    let networkStarted = false
    try {
      if (source.auth.type === 'token') {
        if (!this.resolveSecret) {
          throw new CatalogRequestError('Catalog token resolver is unavailable.', false)
        }
        const token = await resolveWithAbort(
          this.resolveSecret(source.auth.secretKey),
          controller.signal
        )
        if (!token) throw new CatalogRequestError('Catalog token is unavailable.', false)
        headers.set('authorization', 'Bearer ' + token)
      }
      networkStarted = true
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          headers,
          redirect: 'error',
          signal: controller.signal
        })
      } catch (error) {
        throw new CatalogRequestError(
          controller.signal.aborted ? timeoutError.message : errorMessage(error),
          true
        )
      }
      if (!response.ok) {
        await cancelResponse(response, 'Catalog request failed.')
        throw new CatalogRequestError(
          'Catalog request failed (' + response.status + ').',
          retryableHttpStatus(response.status)
        )
      }
      let text: string
      try {
        text = await readBoundedResponse(response, controller.signal)
      } catch (error) {
        const message = controller.signal.aborted ? timeoutError.message : errorMessage(error)
        throw new CatalogRequestError(message, !/10 MiB/i.test(message))
      }
      try {
        return { value: JSON.parse(text), headers: response.headers }
      } catch (error) {
        throw new CatalogRequestError('Catalog JSON is malformed: ' + errorMessage(error), false)
      }
    } catch (error) {
      if (error instanceof CatalogRequestError) throw error
      throw new CatalogRequestError(
        controller.signal.aborted ? timeoutError.message : errorMessage(error),
        controller.signal.aborted || networkStarted
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private async syncGithub(source: CatalogSourceV1): Promise<MarketplaceCatalogSyncResultV1> {
    if (source.type !== 'github') throw new Error('GitHub source type is required.')
    try {
      const commitApi = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/` +
        `${encodeURIComponent(source.repository)}/commits/${encodeURIComponent(source.defaultBranch)}`
      const commitResponse = await this.requestJson(source, commitApi, {
        accept: 'application/vnd.github+json'
      })
      const commitRecord = requiredRecord(commitResponse.value, 'GitHub commit response')
      const commit = requiredString(commitRecord.sha, 'GitHub commit SHA')
      if (!IMMUTABLE_COMMIT.test(commit)) throw new Error('GitHub returned a mutable commit reference.')
      const cached = this.snapshots.get(source.id)
      if (source.sync.commit === commit && cached) {
        await this.recordSuccess(source.id, { commit })
        return clone({ sourceId: source.id, status: 'unchanged', stale: false, snapshot: cached })
      }
      const marketplaceUrl = source.auth.type === 'token'
        ? `https://api.github.com/repos/${encodeURIComponent(source.owner)}/` +
          `${encodeURIComponent(source.repository)}/contents/.agents/plugins/marketplace.json?` +
          `ref=${encodeURIComponent(commit)}`
        : `https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/` +
          `${encodeURIComponent(source.repository)}/${commit}/.agents/plugins/marketplace.json`
      const marketplace = await this.requestJson(source, marketplaceUrl, source.auth.type === 'token'
        ? { accept: 'application/vnd.github+json' }
        : {})
      const marketplaceValue = source.auth.type === 'token'
        ? decodeGithubContents(marketplace.value)
        : marketplace.value
      const snapshot = adaptCatalogValue(marketplaceValue, source, {
        revision: commit,
        commit,
        generatedAt: this.now().toISOString()
      })
      await this.acceptSnapshot(source, snapshot, { commit })
      return clone({ sourceId: source.id, status: 'synced', stale: false, snapshot })
    } catch (error) {
      return this.recordFailure(
        source.id,
        errorMessage(error),
        error instanceof CatalogRequestError && error.offlineCandidate
      )
    }
  }

  private async syncGit(source: CatalogSourceV1): Promise<MarketplaceCatalogSyncResultV1> {
    if (source.type !== 'git') throw new Error('Git source type is required.')
    if (source.auth.type !== 'none') {
      return this.recordFailure(
        source.id,
        'Authenticated generic Git catalogs are not supported without a credential helper.',
        false
      )
    }
    const repositoryDirectory = join(
      this.rootDirectory,
      'git',
      createHash('sha256').update(source.id).digest('hex')
    )
    try {
      await mkdir(repositoryDirectory, { recursive: true })
      await this.runGit(['init', '--bare', repositoryDirectory])
      await this.runGit(['--git-dir', repositoryDirectory, 'remote', 'remove', 'origin'])
        .catch(() => undefined)
      await this.runGit([
        '--git-dir', repositoryDirectory,
        'remote', 'add', 'origin', source.location
      ])
    } catch (error) {
      return this.recordFailure(source.id, errorMessage(error), false)
    }
    try {
      await this.runGit([
        '--git-dir', repositoryDirectory,
        'fetch', '--depth=1', 'origin', `refs/heads/${source.defaultBranch}`
      ])
    } catch (error) {
      return this.recordFailure(source.id, errorMessage(error), true)
    }
    let commit: string
    try {
      commit = (await this.runGit([
        '--git-dir', repositoryDirectory,
        'rev-parse', 'FETCH_HEAD'
      ])).trim()
    } catch (error) {
      return this.recordFailure(source.id, errorMessage(error), false)
    }
    if (!IMMUTABLE_COMMIT.test(commit)) {
      return this.recordFailure(source.id, 'Git returned a mutable commit reference.', false)
    }
    const cached = this.snapshots.get(source.id)
    if (source.sync.commit === commit && cached) {
      await this.recordSuccess(source.id, { commit })
      return clone({ sourceId: source.id, status: 'unchanged', stale: false, snapshot: cached })
    }
    let text: string
    try {
      text = await this.runGit([
        '--git-dir', repositoryDirectory,
        'show', `${commit}:.agents/plugins/marketplace.json`
      ])
    } catch (error) {
      return this.recordFailure(source.id, errorMessage(error), false)
    }
    try {
      if (Buffer.byteLength(text) > MAX_CATALOG_JSON_BYTES) {
        throw new Error('Catalog JSON exceeds the 10 MiB limit.')
      }
      const snapshot = parseCatalogText(text, source, {
        revision: commit,
        commit,
        generatedAt: this.now().toISOString()
      })
      await this.acceptSnapshot(source, snapshot, { commit })
      return clone({ sourceId: source.id, status: 'synced', stale: false, snapshot })
    } catch (error) {
      return this.recordFailure(source.id, errorMessage(error), false)
    }
  }

  private async syncMcpRegistry(source: CatalogSourceV1): Promise<MarketplaceCatalogSyncResultV1> {
    if (source.type !== 'mcp-registry') throw new Error('MCP Registry source type is required.')
    const syncWatermark = this.now().toISOString()
    try {
      const cachedSnapshot = this.snapshots.get(source.id)
      const incrementalSince = cachedSnapshot ? source.sync.lastSyncedAt : undefined
      const deltas = []
      const seenCursors = new Set<string>()
      let cursor: string | undefined
      let updateCount = 0
      for (let pageNumber = 0; pageNumber < MAX_REGISTRY_PAGES; pageNumber += 1) {
        if (cursor) {
          if (seenCursors.has(cursor)) throw new Error('MCP Registry cursor loop detected.')
          seenCursors.add(cursor)
        }
        const url = new URL(source.location)
        url.searchParams.set('limit', '100')
        if (incrementalSince) {
          url.searchParams.set('updated_since', incrementalSince)
          url.searchParams.set('include_deleted', 'true')
        } else {
          url.searchParams.set('version', 'latest')
        }
        if (cursor) url.searchParams.set('cursor', cursor)
        const response = await this.requestJson(source, url.toString())
        const delta = parseMcpRegistryPage(response.value, {
          sourceId: source.id,
          registryUrl: source.location
        })
        updateCount += delta.upserts.length + delta.removals.length
        if (updateCount > MAX_CATALOG_PACKAGES) {
          throw new Error('MCP Registry update exceeds the 5,000 packages limit.')
        }
        deltas.push(delta)
        cursor = delta.nextCursor
        if (!cursor) break
        if (pageNumber === MAX_REGISTRY_PAGES - 1) {
          throw new Error('MCP Registry pagination exceeds the 100 page limit.')
        }
      }
      const generatedAt = this.now().toISOString()
      const existing = incrementalSince ? cachedSnapshot?.packages ?? [] : []
      const snapshot = mergeMcpRegistryDelta(existing, deltas, {
        sourceId: source.id,
        revision: 'pending',
        generatedAt
      })
      snapshot.revision = 'registry-' + createHash('sha256')
        .update(canonicalJson(snapshot.packages))
        .digest('hex')
      const validatedSnapshot = assertSnapshot(snapshot, source.id)
      if (cachedSnapshot &&
          canonicalJson(cachedSnapshot.packages) === canonicalJson(validatedSnapshot.packages)) {
        await this.recordSuccess(source.id, { syncedAt: syncWatermark })
        return clone({
          sourceId: source.id,
          status: 'unchanged',
          stale: false,
          snapshot: cachedSnapshot
        })
      }
      await this.acceptSnapshot(source, validatedSnapshot, { syncedAt: syncWatermark }, false)
      return clone({ sourceId: source.id, status: 'synced', stale: false, snapshot: validatedSnapshot })
    } catch (error) {
      return this.recordFailure(
        source.id,
        errorMessage(error),
        error instanceof CatalogRequestError && error.offlineCandidate
      )
    }
  }

  private async syncHttps(source: CatalogSourceV1): Promise<MarketplaceCatalogSyncResultV1> {
    const headers = new Headers({ accept: 'application/json' })
    if (source.sync.etag) headers.set('if-none-match', source.sync.etag)
    if (source.sync.lastModified) headers.set('if-modified-since', source.sync.lastModified)
    const controller = new AbortController()
    const timeoutError = new Error('Catalog request timed out.')
    const timeout = setTimeout(() => controller.abort(timeoutError), this.fetchTimeoutMs)
    try {
      let response: Response
      let networkStarted = false
      try {
        if (source.auth.type === 'token') {
          if (!this.resolveSecret) {
            return this.recordFailure(source.id, 'Catalog token resolver is unavailable.', false)
          }
          const token = await resolveWithAbort(
            this.resolveSecret(source.auth.secretKey),
            controller.signal
          )
          if (!token) return this.recordFailure(source.id, 'Catalog token is unavailable.', false)
          headers.set('authorization', 'Bearer ' + token)
        }
        networkStarted = true
        response = await this.fetchImpl(source.location, {
          headers,
          redirect: 'error',
          signal: controller.signal
        })
      } catch (error) {
        return this.recordFailure(
          source.id,
          controller.signal.aborted ? timeoutError.message : errorMessage(error),
          controller.signal.aborted || networkStarted
        )
      }
      if (response.status === 304) {
        await cancelResponse(response, 'Catalog response was not modified.')
        const snapshot = this.snapshots.get(source.id)
        if (!snapshot) {
          return this.recordFailure(source.id, 'Catalog returned 304 without a trusted cache.', false)
        }
        await this.recordSuccess(source.id, {
          etag: response.headers.get('etag') ?? undefined,
          lastModified: response.headers.get('last-modified') ?? undefined
        })
        return clone({ sourceId: source.id, status: 'unchanged', stale: false, snapshot })
      }
      if (!response.ok) {
        await cancelResponse(response, 'Catalog request failed.')
        return this.recordFailure(
          source.id,
          'Catalog request failed (' + response.status + ').',
          retryableHttpStatus(response.status)
        )
      }
      let text: string
      try {
        text = await readBoundedResponse(response, controller.signal)
      } catch (error) {
        const message = controller.signal.aborted ? timeoutError.message : errorMessage(error)
        return this.recordFailure(source.id, message, !/10 MiB/i.test(message))
      }
      const headerCommit = response.headers.get('x-workwise-catalog-commit') ?? undefined
      if (headerCommit && !IMMUTABLE_COMMIT.test(headerCommit)) {
        throw new Error('Catalog response commit must be an immutable SHA.')
      }
      let snapshot: CatalogSnapshotV1
      try {
        snapshot = parseCatalogText(text, source, {
          revision: headerCommit ?? snapshotDigest(text),
          generatedAt: this.now().toISOString(),
          ...(headerCommit ? { commit: headerCommit } : {})
        })
      } catch (error) {
        return this.recordFailure(source.id, errorMessage(error), false)
      }
      if (headerCommit && snapshot.commit && headerCommit !== snapshot.commit) {
        throw new Error('Catalog response commit conflicts with the snapshot commit.')
      }
      await this.acceptSnapshot(source, snapshot, {
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
        commit: headerCommit ?? snapshot.commit
      })
      return clone({ sourceId: source.id, status: 'synced', stale: false, snapshot })
    } catch (error) {
      return this.recordFailure(source.id, errorMessage(error), false)
    } finally {
      clearTimeout(timeout)
    }
  }

  private async acceptSnapshot(
    source: CatalogSourceV1,
    snapshot: CatalogSnapshotV1,
    metadata: CatalogSyncMetadata,
    replaceValidators = true
  ): Promise<void> {
    const pointer = await this.persistSnapshot(snapshot)
    let previousPointer: SnapshotPointerV1 | undefined
    await runSerialized('catalog-manifest:' + this.rootDirectory, async () => {
      await this.reloadStateFromDisk()
      const current = this.sources.find((entry) => entry.id === source.id)
      if (!current) throw new Error('Catalog source was removed during synchronization.')
      previousPointer = this.snapshotPointers.get(source.id)
      this.applySuccessMetadata(current, metadata, replaceValidators)
      this.snapshots.set(source.id, snapshot)
      this.snapshotPointers.set(source.id, pointer)
      try {
        await this.persistSources()
      } catch (error) {
        await this.reloadStateFromDisk()
        throw error
      }
    })
    if (previousPointer && previousPointer.file !== pointer.file) {
      await rm(this.snapshotPath(source.id, previousPointer), { force: true }).catch(() => undefined)
    }
  }

  private async recordSuccess(
    sourceId: string,
    metadata: CatalogSyncMetadata = {},
    replaceValidators = false
  ): Promise<void> {
    await runSerialized('catalog-manifest:' + this.rootDirectory, async () => {
      await this.reloadStateFromDisk()
      const source = this.sources.find((entry) => entry.id === sourceId)
      if (!source) throw new Error('Catalog source was removed during synchronization.')
      this.applySuccessMetadata(source, metadata, replaceValidators)
      try {
        await this.persistSources()
      } catch (error) {
        await this.reloadStateFromDisk()
        throw error
      }
    })
  }

  private applySuccessMetadata(
    source: CatalogSourceV1,
    metadata: CatalogSyncMetadata,
    replaceValidators: boolean
  ): void {
    const nextSync = {
      ...source.sync,
      state: 'synced' as const,
      lastSyncedAt: metadata.syncedAt ?? this.now().toISOString()
    }
    delete nextSync.error
    if (replaceValidators) {
      delete nextSync.etag
      delete nextSync.lastModified
      delete nextSync.commit
    }
    if (metadata.etag !== undefined) nextSync.etag = metadata.etag
    if (metadata.lastModified !== undefined) nextSync.lastModified = metadata.lastModified
    if (metadata.commit !== undefined) nextSync.commit = metadata.commit
    source.sync = nextSync
  }

  private preserveServiceSync(requested: CatalogSourceV1, current: CatalogSourceV1): CatalogSourceV1 {
    return {
      ...requested,
      sync: {
        mode: requested.sync.mode,
        state: current.sync.state,
        mirroredByDefault: requested.sync.mirroredByDefault,
        installedByDefault: requested.sync.installedByDefault,
        ...(current.sync.lastSyncedAt ? { lastSyncedAt: current.sync.lastSyncedAt } : {}),
        ...(current.sync.etag ? { etag: current.sync.etag } : {}),
        ...(current.sync.lastModified ? { lastModified: current.sync.lastModified } : {}),
        ...(current.sync.commit ? { commit: current.sync.commit } : {}),
        ...(current.sync.error ? { error: current.sync.error } : {})
      }
    }
  }

  private async recordFailure(
    sourceId: string,
    message: string,
    offlineCandidate: boolean
  ): Promise<MarketplaceCatalogSyncResultV1> {
    let snapshot: CatalogSnapshotV1 | null = null
    await runSerialized('catalog-manifest:' + this.rootDirectory, async () => {
      await this.reloadStateFromDisk()
      snapshot = this.snapshots.get(sourceId) ?? null
      const source = this.sources.find((entry) => entry.id === sourceId)
      if (!source) return
      source.sync = { ...source.sync, state: 'error', error: message }
      try {
        await this.persistSources()
      } catch (error) {
        await this.reloadStateFromDisk()
        throw error
      }
    })
    const offline = offlineCandidate && Boolean(snapshot)
    return clone({
      sourceId,
      status: offline ? 'offline' : 'failed',
      stale: Boolean(snapshot),
      snapshot,
      error: message
    })
  }
}
