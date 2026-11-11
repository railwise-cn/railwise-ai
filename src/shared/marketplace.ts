export type CatalogSourceScopeV1 = 'user' | 'workspace' | 'team' | 'system'

export type CatalogSourceTrustV1 =
  | 'system'
  | 'official'
  | 'verified'
  | 'community'
  | 'external'
  | 'unverified'

export type CatalogSourceAuthV1 =
  | { type: 'none' }
  | { type: 'token'; secretKey: string }
  | { type: 'oauth'; provider: string; discovery: 'ready' | 'pending' }

export type CatalogCredentialStatusV1 = {
  sourceId: string
  configured: boolean
  storage?: 'keychain' | 'dpapi' | 'safe-storage' | 'session'
}

export type CatalogSourceSyncV1 = {
  mode: 'bundled' | 'watched' | 'search-on-demand' | 'manual'
  state: 'idle' | 'syncing' | 'synced' | 'error'
  mirroredByDefault: boolean
  installedByDefault: boolean
  lastSyncedAt?: string
  etag?: string
  lastModified?: string
  commit?: string
  error?: string
}

type CatalogSourceBaseV1 = {
  schemaVersion: 1
  id: string
  name: string
  scope: CatalogSourceScopeV1
  location: string
  trust: CatalogSourceTrustV1
  searchable: boolean
  auth: CatalogSourceAuthV1
  sync: CatalogSourceSyncV1
}

export type BuiltInCatalogSourceV1 = CatalogSourceBaseV1 & {
  type: 'built-in'
  scope: 'system'
  auth: { type: 'none' }
}

export type LocalCatalogSourceV1 = CatalogSourceBaseV1 & {
  type: 'local'
  auth: { type: 'none' }
}

export type ProjectCatalogSourceV1 = CatalogSourceBaseV1 & {
  type: 'project'
  scope: 'workspace'
  auth: { type: 'none' }
}

export type GitCatalogSourceV1 = CatalogSourceBaseV1 & {
  type: 'git'
  defaultBranch: string
}

export type GithubCatalogSourceV1 = CatalogSourceBaseV1 & {
  type: 'github'
  owner: string
  repository: string
  defaultBranch: string
}

export type HttpsCatalogSourceV1 = CatalogSourceBaseV1 & {
  type: 'https'
}

export type McpRegistryCatalogSourceV1 = CatalogSourceBaseV1 & {
  type: 'mcp-registry'
  registry: 'official' | string
}

export type CatalogSourceV1 =
  | BuiltInCatalogSourceV1
  | LocalCatalogSourceV1
  | ProjectCatalogSourceV1
  | GitCatalogSourceV1
  | GithubCatalogSourceV1
  | HttpsCatalogSourceV1
  | McpRegistryCatalogSourceV1

export type PackagePublisherV1 = {
  id: string
  name: string
  verified: boolean
  url?: string
}

export type MarketplaceIconToneV1 =
  | 'blue'
  | 'teal'
  | 'green'
  | 'orange'
  | 'red'
  | 'violet'
  | 'slate'

export type MarketplaceIconV1 = {
  kind: 'monogram' | 'asset'
  value: string
  tone?: MarketplaceIconToneV1
  alt?: string
}

export type MarketplaceProductTypeV1 = 'app' | 'connector' | 'workflow' | 'utility'

export type MarketplaceCollectionV1 =
  | 'development'
  | 'productivity'
  | 'documents'
  | 'writing'
  | 'data'
  | 'collaboration'
  | 'engineering'

export type PackageDigestV1 =
  | { algorithm: 'sha256'; value: string }
  | { algorithm: 'sha512-sri'; value: string }

type PackageSourceBaseV1 = {
  id: string
  catalogSourceId: string
  location: string
  resolvedRef?: string
  digest?: PackageDigestV1
}

export type NpmPackageSourceV1 = PackageSourceBaseV1 & {
  kind: 'npm'
  packageName: string
  version: string
  resolvedRef: string
  digest: Extract<PackageDigestV1, { algorithm: 'sha512-sri' }>
}

export type PypiPackageSourceV1 = PackageSourceBaseV1 & {
  kind: 'pypi'
  packageName: string
  version: string
  resolvedRef: string
  digest: Extract<PackageDigestV1, { algorithm: 'sha256' }>
}

export type GithubPackageSourceV1 = PackageSourceBaseV1 & {
  kind: 'github'
  owner: string
  repository: string
  defaultBranch: string
  requestedRef?: string
  resolvedRef: string
  subpath?: string
}

export type GitPackageSourceV1 = PackageSourceBaseV1 & {
  kind: 'git'
  defaultBranch: string
  requestedRef?: string
  resolvedRef: string
  subpath?: string
}

export type SimplePackageSourceKindV1 =
  | 'built-in'
  | 'local'
  | 'project'
  | 'https'
  | 'mcp-registry'
  | 'remote'
  | 'system'

export type SimplePackageSourceV1 = PackageSourceBaseV1 & {
  kind: SimplePackageSourceKindV1
}

export type PackageSourceV1 =
  | NpmPackageSourceV1
  | PypiPackageSourceV1
  | GithubPackageSourceV1
  | GitPackageSourceV1
  | SimplePackageSourceV1

export type PackageSourceKindV1 = PackageSourceV1['kind']

export type RemotePackageRuntimeV1 = {
  kind: 'remote'
  transport: 'streamable-http' | 'sse'
  endpoint: string
  oauthResource?: string
}

export type NpmPackageRuntimeV1 = {
  kind: 'npm'
  packageName: string
  version: string
  executable: string
  args: string[]
  install: {
    strategy: 'managed-download'
    verify: 'sri-before-activation'
    digestSource: 'component-source'
  }
}

export type GithubPackageRuntimeV1 = {
  kind: 'github'
  repository: string
  resolvedCommit: string
  subpath?: string
  install: {
    strategy: 'managed-git'
    verifyBeforeActivation: true
  }
}

export type UvPackageRuntimeV1 = {
  kind: 'uv'
  packageName: string
  version: string
  executable: string
  args: string[]
  install: {
    strategy: 'managed-wheel'
    verify: 'sha256-before-activation'
    digest: Extract<PackageDigestV1, { algorithm: 'sha256' }>
  }
}

export type SystemPackageRuntimeV1 = {
  kind: 'system'
  provider: string
  capability: string
}

export type BundledPackageRuntimeV1 = {
  kind: 'bundled'
  entrypoint: string
  executable?: string
  args?: string[]
  managedRuntime?: 'uv'
}

export type PackageRuntimeV1 =
  | RemotePackageRuntimeV1
  | NpmPackageRuntimeV1
  | GithubPackageRuntimeV1
  | UvPackageRuntimeV1
  | BundledPackageRuntimeV1
  | SystemPackageRuntimeV1

type MarketplaceComponentBaseV1 = {
  id: string
  name: string
  sourceId: string
}

export type McpComponentV1 = MarketplaceComponentBaseV1 & {
  type: 'mcp'
  runtime:
    | RemotePackageRuntimeV1
    | NpmPackageRuntimeV1
    | UvPackageRuntimeV1
    | BundledPackageRuntimeV1
    | SystemPackageRuntimeV1
}

export type CliComponentV1 = MarketplaceComponentBaseV1 & {
  type: 'cli'
  runtime:
    | NpmPackageRuntimeV1
    | GithubPackageRuntimeV1
    | UvPackageRuntimeV1
    | BundledPackageRuntimeV1
    | SystemPackageRuntimeV1
}

export type SkillComponentV1 = MarketplaceComponentBaseV1 & {
  type: 'skill'
  runtime:
    | NpmPackageRuntimeV1
    | GithubPackageRuntimeV1
    | BundledPackageRuntimeV1
    | SystemPackageRuntimeV1
  skillNames: string[]
}

export type MarketplaceComponentV1 = McpComponentV1 | CliComponentV1 | SkillComponentV1

export type PackagePermissionKindV1 =
  | 'filesystem'
  | 'network'
  | 'browser'
  | 'database'
  | 'process'
  | 'credentials'

export type PackagePermissionAccessV1 =
  | 'read'
  | 'write'
  | 'execute'
  | 'connect'
  | 'control'
  | 'authenticate'

export type PackagePermissionV1 = {
  id: string
  kind: PackagePermissionKindV1
  access: PackagePermissionAccessV1
  default: 'granted' | 'denied' | 'review'
  reviewRequired: boolean
  description: string
  resources?: string[]
}

export type PackageAuthV1 =
  | { type: 'none' }
  | { type: 'token'; provider: string; environmentVariables: string[] }
  | { type: 'tool-managed'; provider: string }
  | {
      type: 'oauth'
      provider: string
      discovery: 'ready' | 'pending'
      scopes?: string[]
    }

export type PackageLicenseEvidenceV1 = {
  license: string
  sourceId: string
  path: string
  includeInInstall: true
  required: true
}

export type PackageDependencyV1 = {
  id: string
  kind: 'package' | 'runtime' | 'system'
  requirement: string
  optional: boolean
  managedBy?: 'workwise' | 'system' | 'user'
}

export type PackageUpdatePolicyV1 = {
  strategy: 'pinned' | 'manual' | 'system-managed'
  channel: 'stable' | 'preview' | 'managed'
  allowMajor: boolean
}

export type PackageCompatibilityV1 = {
  workwise: string
  platforms: Array<'darwin' | 'win32' | 'linux'>
  architectures: Array<'arm64' | 'x64'>
}

export type PackageAvailabilityV1 =
  | { status: 'available' }
  | { status: 'managed'; managedBy: string }
  | { status: 'unavailable'; reasonCode: string; message: string }

export type PackageInstallationV1 =
  | {
      mode: 'direct-mirror' | 'upstream-only'
      installedByDefault: boolean
      reinstallable: true
    }
  | {
      mode: 'external'
      installedByDefault: false
      reinstallable: false
    }
  | {
      mode: 'system-managed'
      installedByDefault: boolean
      reinstallable: false
    }

export type PackageHookV1 = {
  id: string
  event: string
  matcher?: string
  command: string
  enabledByDefault: false
  execution: 'disabled-pending-review'
  permissionIds: string[]
}

export type PackageSignatureV1 =
  | { status: 'unsigned' }
  | {
      status: 'verified'
      algorithm: 'ed25519'
      keyId: string
      signer?: string
    }
  | {
      status: 'untrusted'
      algorithm: 'ed25519'
      keyId: string
      reason: string
    }

export type PackageConfigurationFieldV1 = {
  key: string
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description?: string
  required: boolean
  sensitive: boolean
  multiple: boolean
  defaultValue?: string | number | boolean | string[]
}

export type PackageUsageV1 = {
  howToUse: string
  examples?: string[]
  requirements?: string[]
}

export type MarketplacePackageV1 = {
  schemaVersion: 1
  id: string
  name: string
  summary: string
  tier: 'recommended' | 'advanced'
  categories?: string[]
  collections?: MarketplaceCollectionV1[]
  productType?: MarketplaceProductTypeV1
  icon?: MarketplaceIconV1
  version: string
  publisher: PackagePublisherV1
  license: string | null
  source: PackageSourceV1
  sources: PackageSourceV1[]
  components: MarketplaceComponentV1[]
  permissions: PackagePermissionV1[]
  auth: PackageAuthV1
  licenseEvidence: PackageLicenseEvidenceV1[]
  dependencies: PackageDependencyV1[]
  usage?: PackageUsageV1
  hooks?: PackageHookV1[]
  signature?: PackageSignatureV1
  configuration?: PackageConfigurationFieldV1[]
  updatePolicy: PackageUpdatePolicyV1
  compatibility: PackageCompatibilityV1
  availability: PackageAvailabilityV1
  installation: PackageInstallationV1
}

export type CatalogSnapshotV1 = {
  schemaVersion: 1
  sourceId: string
  revision: string
  generatedAt?: string
  commit?: string
  packages: MarketplacePackageV1[]
}

export type MarketplaceCatalogPackageEntryV1 = {
  key: string
  sourceId: string
  package: MarketplacePackageV1
  reviewSha256?: string
  conflicted: boolean
}

export type MarketplaceCatalogConflictV1 = {
  packageId: string
  sourceIds: string[]
  keys: string[]
}

export type MarketplaceCatalogPackagesResultV1 = {
  packages: MarketplaceCatalogPackageEntryV1[]
  conflicts: MarketplaceCatalogConflictV1[]
}

export type MarketplaceCatalogSyncResultV1 = {
  sourceId: string
  status: 'synced' | 'unchanged' | 'offline' | 'failed'
  stale: boolean
  snapshot: CatalogSnapshotV1 | null
  error?: string
}

export type PluginUpdateDiagnosticStateV1 =
  | 'current'
  | 'metadata-refresh'
  | 'update-available'
  | 'runtime-drift'
  | 'unavailable'

export type PluginUpdateDiagnosticV1 = {
  packageId: string
  installedVersion: string
  catalogVersion?: string
  state: PluginUpdateDiagnosticStateV1
  message: string
}

export type PreparedPluginImportV1 = {
  schemaVersion: 1
  id: string
  createdAt: string
  expiresAt: string
  format: 'wwx' | 'codex' | 'mcpb' | 'catalog'
  package: MarketplacePackageV1
  archiveSha256?: string
  contentSha256: string
  reviewSha256: string
  warnings: string[]
  compatibility: {
    workwiseCompatible: boolean
    reasons: string[]
  }
}

export type InstalledPackagePermissionV1 = {
  permissionId: string
  decision: 'granted' | 'denied'
  scope?: string
}

export type PackageInstallTimestampsV1 = {
  installedAt: string
  updatedAt?: string
  lastCheckedAt?: string
}

export type InstalledComponentSourceV1 = {
  componentId: string
  sourceId: string
}

export type PackageProvenanceSnapshotV1 = {
  source: PackageSourceV1
  sources: PackageSourceV1[]
  components: InstalledComponentSourceV1[]
}

export type InstalledPackageArtifactV1 = {
  sha256: string
  location: string
  fileCount: number
  totalBytes: number
}

export type PackageRollbackV1 =
  | { available: false }
  | ({
      available: true
      version: string
      createdAt?: string
      license: string | null
      reviewSha256: string
      artifact: InstalledPackageArtifactV1
      permissions: InstalledPackagePermissionV1[]
      updatePolicy: PackageUpdatePolicyV1
      health: PackageHealthV1
    } & PackageProvenanceSnapshotV1)

export type PackageHealthV1 = {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  checkedAt?: string
  message?: string
}

export type InstalledPackageV1 = PackageProvenanceSnapshotV1 & {
  schemaVersion: 1
  packageId: string
  version: string
  license: string | null
  reviewSha256: string
  scope: 'user' | 'workspace' | 'team' | 'system'
  workspaceRoot?: string
  artifact: InstalledPackageArtifactV1
  permissions: InstalledPackagePermissionV1[]
  timestamps: PackageInstallTimestampsV1
  updatePolicy: PackageUpdatePolicyV1
  rollback: PackageRollbackV1
  health: PackageHealthV1
}

export type PackageUpdateResultV1 =
  | {
      status: 'updated'
      packageId: string
      fromVersion: string
      toVersion: string
      installed: InstalledPackageV1
      rolledBack: false
    }
  | { status: 'unchanged'; packageId: string; version: string }
  | { status: 'blocked'; packageId: string; reason: string }
  | { status: 'failed'; packageId: string; error: string; rolledBack: boolean }

export const DIRECT_MIRROR_LICENSE_ALLOWLIST = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC'
] as const

export type DirectMirrorLicenseV1 = (typeof DIRECT_MIRROR_LICENSE_ALLOWLIST)[number]

export type MarketplaceLicensePolicyV1 = {
  disposition: 'direct-mirror' | 'external-only' | 'rejected'
  license: string | null
  reason: 'allowlisted' | 'missing' | 'not-allowlisted' | 'restricted'
}

const DIRECT_MIRROR_LICENSES = new Set<string>(DIRECT_MIRROR_LICENSE_ALLOWLIST)
const SPDX_IDENTIFIER = /[A-Za-z0-9][A-Za-z0-9.+-]*/g

function isRestrictedLicenseIdentifier(identifier: string): boolean {
  if (/^(?:AGPL|GPL|LGPL)-\d/i.test(identifier)) return true
  if (/^(?:SSPL|BUSL)-\d/i.test(identifier)) return true
  if (/^BSL-(?!1\.0$)\d/i.test(identifier)) return true
  return /(?:^|-)NC(?:-|$)/i.test(identifier)
}

export function evaluateMarketplaceLicense(
  license: string | null | undefined
): MarketplaceLicensePolicyV1 {
  const normalized = license?.trim() || null
  if (!normalized) {
    return { disposition: 'external-only', license: null, reason: 'missing' }
  }
  if (DIRECT_MIRROR_LICENSES.has(normalized)) {
    return { disposition: 'direct-mirror', license: normalized, reason: 'allowlisted' }
  }

  const identifiers = normalized.match(SPDX_IDENTIFIER) ?? []
  const businessSourceName = /\bbusiness\s+source(?:\s+license)?\b/i.test(normalized)
  if (businessSourceName || identifiers.some(isRestrictedLicenseIdentifier)) {
    return { disposition: 'rejected', license: normalized, reason: 'restricted' }
  }
  return { disposition: 'external-only', license: normalized, reason: 'not-allowlisted' }
}
