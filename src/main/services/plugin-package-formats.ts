import {
  createHash,
  createPublicKey,
  verify as verifySignature
} from 'node:crypto'
import { constants } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  InstalledPackagePermissionV1,
  InstalledPackageV1,
  MarketplaceComponentV1,
  MarketplacePackageV1,
  PackageAuthV1,
  PackageAvailabilityV1,
  PackageConfigurationFieldV1,
  PackageDependencyV1,
  PackageHookV1,
  PackageInstallationV1,
  PackagePermissionV1,
  PackageSignatureV1,
  PackageSourceV1
} from '../../shared/marketplace'
import { evaluateMarketplaceLicense } from '../../shared/marketplace'
import {
  inspectPackageDirectory,
  marketplacePackageReviewSha256,
  type PackageInstallationService
} from './package-installation-service'
import {
  extractPluginArchive,
  normalizePluginArchivePath,
  type PluginArchiveInspectionV1
} from './plugin-archive-security'

const MAX_MANIFEST_BYTES = 1024 * 1024
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PACKAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/
const CONFIGURATION_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export type PluginPackageFormatV1 = 'wwx' | 'codex' | 'mcpb'

export type TrustedPluginSigningKeyV1 = {
  keyId: string
  publicKey: string | Buffer
  signer?: string
}

export type ParsePluginPackageOptionsV1 = {
  directory: string
  format?: PluginPackageFormatV1
  catalogSourceId: string
  sourceLocation: string
  sourceKind?: 'local' | 'project' | 'https'
  archiveSha256?: string
  trustedSigningKeys?: TrustedPluginSigningKeyV1[]
}

export type PreparePluginArchiveOptionsV1 = Omit<ParsePluginPackageOptionsV1, 'directory'> & {
  archive: Buffer
  targetDirectory: string
}

export type PreparedPluginPackageV1 = {
  schemaVersion: 1
  format: PluginPackageFormatV1 | 'catalog'
  package: MarketplacePackageV1
  preparedDirectory: string
  archiveSha256?: string
  contentSha256: string
  reviewSha256: string
  warnings: string[]
  compatibility: {
    workwiseCompatible: boolean
    reasons: string[]
  }
  archiveInspection?: PluginArchiveInspectionV1
}

export type InstallPreparedPluginPackageOptionsV1 = {
  expectedCurrentVersion: string | null
  scope: InstalledPackageV1['scope']
  workspaceRoot?: string
  permissions: InstalledPackagePermissionV1[]
  idempotencyKey: string
}

type ParseContext = {
  directory: string
  paths: Set<string>
  directories: Set<string>
  source: PackageSourceV1
  catalogSourceId: string
}

type ParsedPackage = {
  package: MarketplacePackageV1
  warnings: string[]
  reasons: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(label + ' must be an object.')
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + ' must be an array.')
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required.')
  if (value.includes('\0')) throw new Error(label + ' contains a NUL byte.')
  return value.trim()
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label)
}

function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean.')
  return value
}

function exactVersion(value: unknown, label: string): string {
  const version = string(value, label)
  if (!EXACT_VERSION.test(version) || version.toLowerCase() === 'latest') {
    throw new Error(label + ' must be an exact semantic version.')
  }
  return version
}

function packageId(value: unknown, label: string): string {
  const id = string(value, label).toLowerCase()
  if (!PACKAGE_ID.test(id)) throw new Error(label + ' must be a portable lowercase identifier.')
  return id
}

function portablePath(value: unknown, label: string, directory = false): string {
  let path = string(value, label)
  while (path.startsWith('./')) path = path.slice(2)
  if (directory) path = path.replace(/\/+$/, '')
  const normalized = normalizePluginArchivePath(path)
  if (normalized.directory) throw new Error(label + ' must not end with a slash.')
  return normalized.path
}

function stringArray(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback
  const result = array(value, label).map((item, index) => string(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) throw new Error(label + ' contains duplicates.')
  return result
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (!isRecord(value)) return JSON.stringify(value)
  return '{' + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(value[key])
  ).join(',') + '}'
}

function safeUrl(value: unknown, label: string): string {
  const input = string(value, label)
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error(label + ' must be a valid URL.')
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(label + ' must be an HTTPS URL without embedded credentials.')
  }
  return url.toString()
}

async function readPackageFile(
  context: ParseContext,
  path: string,
  maxBytes = MAX_MANIFEST_BYTES
): Promise<Buffer> {
  if (!context.paths.has(path)) throw new Error(`Package file is missing: ${path}.`)
  const handle = await open(join(context.directory, ...path.split('/')), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > maxBytes) {
      throw new Error(`Package file is invalid or exceeds its read limit: ${path}.`)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Package metadata file changed while it was read: ${path}.`)
    }
    return bytes
  } finally {
    await handle.close()
  }
}

async function readPackageJson(context: ParseContext, path: string): Promise<Record<string, unknown>> {
  const bytes = await readPackageFile(context, path)
  try {
    return record(JSON.parse(bytes.toString('utf8')), path)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON.`)
    throw error
  }
}

function sourceFor(options: ParsePluginPackageOptionsV1, contentSha256: string): PackageSourceV1 {
  const sourceKind = options.sourceKind ?? 'local'
  return {
    id: 'package-archive',
    catalogSourceId: string(options.catalogSourceId, 'Catalog source ID'),
    kind: sourceKind,
    location: string(options.sourceLocation, 'Package source location'),
    digest: {
      algorithm: 'sha256',
      value: (options.archiveSha256 ?? contentSha256).toLowerCase()
    }
  }
}

function permission(value: unknown, label: string): PackagePermissionV1 {
  const item = record(value, label)
  const kind = string(item.kind, label + ' kind')
  const access = string(item.access, label + ' access')
  const decision = item.default === undefined ? 'review' : string(item.default, label + ' default')
  if (!new Set(['filesystem', 'network', 'browser', 'database', 'process', 'credentials']).has(kind)) {
    throw new Error(label + ' kind is invalid.')
  }
  if (!new Set(['read', 'write', 'execute', 'connect', 'control', 'authenticate']).has(access)) {
    throw new Error(label + ' access is invalid.')
  }
  if (!new Set(['granted', 'denied', 'review']).has(decision)) {
    throw new Error(label + ' default is invalid.')
  }
  return {
    id: packageId(item.id, label + ' id'),
    kind: kind as PackagePermissionV1['kind'],
    access: access as PackagePermissionV1['access'],
    default: decision as PackagePermissionV1['default'],
    reviewRequired: boolean(item.reviewRequired, label + ' reviewRequired', true),
    description: string(item.description, label + ' description'),
    ...(item.resources === undefined ? {} : { resources: stringArray(item.resources, label + ' resources') })
  }
}

function dependency(value: unknown, label: string): PackageDependencyV1 {
  const item = record(value, label)
  const kind = string(item.kind, label + ' kind')
  const managedBy = optionalString(item.managedBy, label + ' managedBy')
  if (!new Set(['package', 'runtime', 'system']).has(kind)) throw new Error(label + ' kind is invalid.')
  if (managedBy && !new Set(['workwise', 'system', 'user']).has(managedBy)) {
    throw new Error(label + ' managedBy is invalid.')
  }
  return {
    id: packageId(item.id, label + ' id'),
    kind: kind as PackageDependencyV1['kind'],
    requirement: string(item.requirement, label + ' requirement'),
    optional: boolean(item.optional, label + ' optional'),
    ...(managedBy ? { managedBy: managedBy as NonNullable<PackageDependencyV1['managedBy']> } : {})
  }
}

function configurationField(
  key: string,
  value: unknown,
  label: string
): PackageConfigurationFieldV1 {
  if (!CONFIGURATION_KEY.test(key)) throw new Error(label + ' key is invalid.')
  const item = record(value, label)
  const type = string(item.type, label + ' type')
  if (!new Set(['string', 'number', 'boolean', 'directory', 'file']).has(type)) {
    throw new Error(label + ' type is invalid.')
  }
  const multiple = boolean(item.multiple, label + ' multiple')
  if (multiple && type !== 'string' && type !== 'directory' && type !== 'file') {
    throw new Error(label + ' only string and path values may be multiple.')
  }
  const defaultValue = item.defaultValue ?? item.default
  if (defaultValue !== undefined) {
    const valid = multiple
      ? Array.isArray(defaultValue) && defaultValue.every((entry) => typeof entry === 'string')
      : type === 'number'
        ? typeof defaultValue === 'number' && Number.isFinite(defaultValue)
        : type === 'boolean'
          ? typeof defaultValue === 'boolean'
          : typeof defaultValue === 'string'
    if (!valid) throw new Error(label + ' default does not match its type.')
  }
  return {
    key: string(key, label + ' key'),
    type: type as PackageConfigurationFieldV1['type'],
    title: string(item.title ?? key, label + ' title'),
    ...(item.description === undefined ? {} : { description: string(item.description, label + ' description') }),
    required: boolean(item.required, label + ' required'),
    sensitive: boolean(item.sensitive, label + ' sensitive'),
    multiple,
    ...(defaultValue === undefined ? {} : {
      defaultValue: defaultValue as PackageConfigurationFieldV1['defaultValue']
    })
  }
}

function licenseEvidence(paths: Set<string>, sourceId: string): MarketplacePackageV1['licenseEvidence'] {
  return [...paths]
    .filter((path) => /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(path.split('/').at(-1) ?? ''))
    .sort()
    .map((path) => ({
      license: 'package-declared',
      sourceId,
      path,
      includeInInstall: true as const,
      required: true as const
    }))
}

function installability(
  license: string | null,
  evidenceCount: number,
  reasons: string[]
): { availability: PackageAvailabilityV1; installation: PackageInstallationV1 } {
  const licenseResult = evaluateMarketplaceLicense(license)
  if (licenseResult.disposition !== 'direct-mirror') {
    reasons.push(`license:${licenseResult.reason}`)
  }
  if (evidenceCount === 0) reasons.push('license-evidence-missing')
  if (reasons.length > 0) {
    return {
      availability: {
        status: 'unavailable',
        reasonCode: reasons[0]!,
        message: 'This package requires compatibility, runtime, or license review before installation.'
      },
      installation: { mode: 'external', installedByDefault: false, reinstallable: false }
    }
  }
  return {
    availability: { status: 'available' },
    installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
  }
}

function publisher(value: unknown, fallbackName: string): MarketplacePackageV1['publisher'] {
  if (typeof value === 'string') {
    return { id: packageId(value.replace(/\s+/g, '-'), 'Publisher ID'), name: value, verified: false }
  }
  const item = record(value, 'Package publisher')
  const name = string(item.name ?? fallbackName, 'Publisher name')
  const rawId = typeof item.id === 'string' ? item.id : name.replace(/\s+/g, '-').toLowerCase()
  return {
    id: packageId(rawId, 'Publisher ID'),
    name,
    verified: false,
    ...(item.url === undefined ? {} : { url: safeUrl(item.url, 'Publisher URL') })
  }
}

function compatibility(value: unknown): MarketplacePackageV1['compatibility'] {
  const item = value === undefined ? {} : record(value, 'Package compatibility')
  const platforms = item.platforms === undefined
    ? ['darwin', 'win32', 'linux']
    : stringArray(item.platforms, 'Compatibility platforms')
  const architectures = item.architectures === undefined
    ? ['arm64', 'x64']
    : stringArray(item.architectures, 'Compatibility architectures')
  if (platforms.some((platform) => !new Set(['darwin', 'win32', 'linux']).has(platform)) ||
      architectures.some((architecture) => !new Set(['arm64', 'x64']).has(architecture))) {
    throw new Error('Package compatibility contains an unsupported platform or architecture.')
  }
  return {
    workwise: optionalString(item.workwise, 'RailWise AI compatibility') ?? '>=0.3.6',
    platforms: platforms as MarketplacePackageV1['compatibility']['platforms'],
    architectures: architectures as MarketplacePackageV1['compatibility']['architectures']
  }
}

function ensureUniqueIds(values: Array<{ id: string }>, label: string): void {
  if (new Set(values.map((item) => item.id)).size !== values.length) {
    throw new Error(label + ' contains duplicate IDs.')
  }
}

function remoteSource(
  packageSource: PackageSourceV1,
  id: string,
  endpoint: string
): PackageSourceV1 {
  return {
    id,
    catalogSourceId: packageSource.catalogSourceId,
    kind: 'remote',
    location: endpoint
  }
}

function parseWwxAuth(value: unknown): PackageAuthV1 {
  if (value === undefined) return { type: 'none' }
  const item = record(value, 'WWX auth')
  const type = string(item.type, 'WWX auth type')
  if (type === 'none') return { type: 'none' }
  if (type === 'token') {
    return {
      type,
      provider: string(item.provider, 'WWX auth provider'),
      environmentVariables: stringArray(item.environmentVariables, 'WWX auth environmentVariables')
    }
  }
  if (type === 'tool-managed') {
    return { type, provider: string(item.provider, 'WWX auth provider') }
  }
  if (type === 'oauth') {
    const discovery = item.discovery ?? 'pending'
    if (discovery !== 'ready' && discovery !== 'pending') throw new Error('WWX OAuth discovery is invalid.')
    return {
      type,
      provider: string(item.provider, 'WWX OAuth provider'),
      discovery,
      ...(item.scopes === undefined ? {} : { scopes: stringArray(item.scopes, 'WWX OAuth scopes') })
    }
  }
  throw new Error('WWX auth type is invalid.')
}

async function parseWwx(context: ParseContext): Promise<ParsedPackage> {
  const manifest = await readPackageJson(context, 'workwise.plugin.json')
  if (manifest.schemaVersion !== 1) throw new Error('WWX schemaVersion must be 1.')
  const id = packageId(manifest.id, 'WWX package ID')
  const version = exactVersion(manifest.version, 'WWX package version')
  const sources: PackageSourceV1[] = [context.source]
  const components: MarketplaceComponentV1[] = []
  const rawComponents = array(manifest.components, 'WWX components')
  for (const [index, rawComponent] of rawComponents.entries()) {
    const item = record(rawComponent, `WWX component ${index}`)
    const componentId = packageId(item.id, `WWX component ${index} ID`)
    const type = string(item.type, `WWX component ${componentId} type`)
    if (type !== 'mcp' && type !== 'cli' && type !== 'skill') {
      throw new Error(`WWX component ${componentId} type is invalid.`)
    }
    const runtime = record(item.runtime, `WWX component ${componentId} runtime`)
    const runtimeKind = string(runtime.kind, `WWX component ${componentId} runtime kind`)
    if (runtimeKind === 'bundled') {
      const entrypoint = portablePath(runtime.entrypoint, `WWX component ${componentId} entrypoint`, type === 'skill')
      if (!context.paths.has(entrypoint) && !context.directories.has(entrypoint)) {
        throw new Error(`WWX component entrypoint is missing: ${entrypoint}.`)
      }
      const bundled = {
        kind: 'bundled' as const,
        entrypoint,
        ...(runtime.executable === undefined ? {} : {
          executable: string(runtime.executable, `WWX component ${componentId} executable`)
        }),
        ...(runtime.args === undefined ? {} : {
          args: stringArray(runtime.args, `WWX component ${componentId} args`)
        })
      }
      if (type === 'skill') {
        components.push({
          id: componentId,
          name: optionalString(item.name, `WWX component ${componentId} name`) ?? componentId,
          type,
          sourceId: context.source.id,
          runtime: bundled,
          skillNames: stringArray(item.skillNames, `WWX component ${componentId} skillNames`)
        })
      } else {
        components.push({
          id: componentId,
          name: optionalString(item.name, `WWX component ${componentId} name`) ?? componentId,
          type,
          sourceId: context.source.id,
          runtime: bundled
        })
      }
      continue
    }
    if (runtimeKind === 'remote' && type === 'mcp') {
      const endpoint = safeUrl(runtime.endpoint, `WWX component ${componentId} endpoint`)
      const sourceId = `${componentId}-remote`
      sources.push(remoteSource(context.source, sourceId, endpoint))
      const transport = runtime.transport ?? 'streamable-http'
      if (transport !== 'streamable-http' && transport !== 'sse') {
        throw new Error(`WWX component ${componentId} transport is invalid.`)
      }
      components.push({
        id: componentId,
        name: optionalString(item.name, `WWX component ${componentId} name`) ?? componentId,
        type,
        sourceId,
        runtime: {
          kind: 'remote',
          transport,
          endpoint,
          ...(runtime.oauthResource === undefined ? {} : {
            oauthResource: safeUrl(runtime.oauthResource, `WWX component ${componentId} OAuth resource`)
          })
        }
      })
      continue
    }
    throw new Error(`WWX component ${componentId} runtime is unsupported.`)
  }
  if (components.length === 0) throw new Error('WWX package must declare at least one component.')
  ensureUniqueIds(components, 'WWX components')

  for (const resource of stringArray(manifest.resources, 'WWX resources')) {
    const path = portablePath(resource, 'WWX resource path')
    if (!context.paths.has(path) && !context.directories.has(path)) {
      throw new Error(`WWX resource is missing: ${path}.`)
    }
  }
  const permissions = manifest.permissions === undefined
    ? []
    : array(manifest.permissions, 'WWX permissions').map((item, index) =>
      permission(item, `WWX permission ${index}`)
    )
  ensureUniqueIds(permissions, 'WWX permissions')
  const dependencies = manifest.dependencies === undefined
    ? []
    : array(manifest.dependencies, 'WWX dependencies').map((item, index) =>
      dependency(item, `WWX dependency ${index}`)
    )
  ensureUniqueIds(dependencies, 'WWX dependencies')
  const configuration = manifest.configuration === undefined
    ? []
    : Object.entries(record(manifest.configuration, 'WWX configuration')).map(([key, value]) =>
      configurationField(key, value, `WWX configuration ${key}`)
    )
  const hooks: PackageHookV1[] = manifest.hooks === undefined
    ? []
    : array(manifest.hooks, 'WWX hooks').map((rawHook, index) => {
      const item = record(rawHook, `WWX hook ${index}`)
      return {
        id: packageId(item.id, `WWX hook ${index} ID`),
        event: string(item.event, `WWX hook ${index} event`),
        ...(item.matcher === undefined ? {} : { matcher: string(item.matcher, `WWX hook ${index} matcher`) }),
        command: string(item.command, `WWX hook ${index} command`),
        enabledByDefault: false,
        execution: 'disabled-pending-review',
        permissionIds: stringArray(item.permissionIds, `WWX hook ${index} permissionIds`)
      }
    })
  ensureUniqueIds(hooks, 'WWX hooks')
  const update = manifest.update === undefined ? {} : record(manifest.update, 'WWX update')
  const strategy = update.strategy ?? 'manual'
  const channel = update.channel ?? 'stable'
  if (strategy !== 'manual' && strategy !== 'pinned') throw new Error('WWX update strategy is invalid.')
  if (channel !== 'stable' && channel !== 'preview') throw new Error('WWX update channel is invalid.')
  if (update.url !== undefined) {
    sources.push({
      id: 'package-update',
      catalogSourceId: context.catalogSourceId,
      kind: 'https',
      location: safeUrl(update.url, 'WWX update URL')
    })
  }
  const license = manifest.license === null ? null : string(manifest.license, 'WWX license')
  const evidence = licenseEvidence(context.paths, context.source.id)
  for (const item of evidence) item.license = license ?? 'unknown'
  const reasons: string[] = []
  const install = installability(license, evidence.length, reasons)
  const value: MarketplacePackageV1 = {
    schemaVersion: 1,
    id,
    name: string(manifest.name, 'WWX package name'),
    summary: string(manifest.description ?? manifest.summary, 'WWX package description'),
    tier: manifest.tier === 'recommended' ? 'recommended' : 'advanced',
    categories: stringArray(manifest.categories, 'WWX categories'),
    version,
    publisher: publisher(manifest.publisher, 'Unknown Publisher'),
    license,
    source: context.source,
    sources,
    components,
    permissions,
    auth: parseWwxAuth(manifest.auth),
    licenseEvidence: evidence,
    dependencies,
    hooks,
    configuration,
    updatePolicy: {
      strategy,
      channel,
      allowMajor: boolean(update.allowMajor, 'WWX update allowMajor')
    },
    compatibility: compatibility(manifest.compatibility),
    ...install
  }
  return { package: value, warnings: [], reasons }
}

function skillNames(context: ParseContext, directory: string): string[] {
  const prefix = directory + '/'
  return [...context.paths]
    .filter((path) => path.startsWith(prefix) && path.endsWith('/SKILL.md'))
    .map((path) => path.slice(prefix.length, -'/SKILL.md'.length))
    .filter((name) => name && !name.includes('/'))
    .sort()
}

function ensurePermission(
  permissions: PackagePermissionV1[],
  value: PackagePermissionV1
): string {
  if (!permissions.some((permission) => permission.id === value.id)) permissions.push(value)
  return value.id
}

function configurationFromEnvironment(
  environment: unknown,
  fields: PackageConfigurationFieldV1[],
  warnings: string[],
  reasons: string[],
  label: string
): string[] {
  if (environment === undefined) return []
  const variables: string[] = []
  for (const [key, rawValue] of Object.entries(record(environment, label))) {
    const value = string(rawValue, `${label} ${key}`)
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
    if (!match) {
      warnings.push(`${label} ${key} uses a fixed value that RailWise AI will not copy into runtime configuration.`)
      reasons.push(`fixed-environment-value-unsupported:${key}`)
      continue
    }
    const variable = match[1]!
    variables.push(variable)
    if (!fields.some((field) => field.key === variable)) {
      fields.push({
        key: variable,
        type: 'string',
        title: variable,
        required: true,
        sensitive: /(?:token|secret|password|api[_-]?key)/i.test(variable),
        multiple: false
      })
    }
  }
  return variables
}

function localMcpEntrypoint(
  context: ParseContext,
  command: string,
  args: string[]
): string | null {
  const candidates = [command, ...args]
  for (const candidate of candidates) {
    if (!candidate.startsWith('./')) continue
    const path = portablePath(candidate, 'Codex MCP entrypoint')
    if (context.paths.has(path)) return path
  }
  return null
}

async function parseCodexHooks(
  context: ParseContext,
  permissions: PackagePermissionV1[]
): Promise<PackageHookV1[]> {
  if (!context.paths.has('hooks.json')) return []
  const manifest = await readPackageJson(context, 'hooks.json')
  const hooks = record(manifest.hooks, 'Codex hooks')
  const processPermission = ensurePermission(permissions, {
    id: 'hook-process',
    kind: 'process',
    access: 'execute',
    default: 'review',
    reviewRequired: true,
    description: 'Run plugin hook commands after explicit user review.'
  })
  const filesystemPermission = ensurePermission(permissions, {
    id: 'hook-filesystem',
    kind: 'filesystem',
    access: 'write',
    default: 'review',
    reviewRequired: true,
    description: 'Allow reviewed hooks to inspect or change files in the active workspace.',
    resources: ['workspace']
  })
  const result: PackageHookV1[] = []
  for (const [event, rawGroups] of Object.entries(hooks)) {
    for (const [groupIndex, rawGroup] of array(rawGroups, `Codex hook event ${event}`).entries()) {
      const group = record(rawGroup, `Codex hook ${event}[${groupIndex}]`)
      const matcher = optionalString(group.matcher, `Codex hook ${event}[${groupIndex}] matcher`)
      for (const [hookIndex, rawHook] of array(group.hooks, `Codex hook ${event}[${groupIndex}] commands`).entries()) {
        const hook = record(rawHook, `Codex hook ${event}[${groupIndex}][${hookIndex}]`)
        if (hook.type !== 'command') continue
        result.push({
          id: `${event}-${groupIndex}-${hookIndex}`.replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase(),
          event,
          ...(matcher ? { matcher } : {}),
          command: string(hook.command, `Codex hook ${event}[${groupIndex}][${hookIndex}] command`),
          enabledByDefault: false,
          execution: 'disabled-pending-review',
          permissionIds: [processPermission, filesystemPermission]
        })
      }
    }
  }
  return result
}

async function parseCodex(context: ParseContext): Promise<ParsedPackage> {
  const manifest = await readPackageJson(context, '.codex-plugin/plugin.json')
  const id = packageId(manifest.name, 'Codex plugin name')
  const version = exactVersion(manifest.version, 'Codex plugin version')
  const components: MarketplaceComponentV1[] = []
  const sources: PackageSourceV1[] = [context.source]
  const permissions: PackagePermissionV1[] = []
  const configuration: PackageConfigurationFieldV1[] = []
  const warnings: string[] = []
  const reasons: string[] = []
  const tokenVariables: string[] = []
  let oauthProvider: string | null = null

  if (manifest.skills !== undefined) {
    const directory = portablePath(manifest.skills, 'Codex skills directory', true)
    const names = skillNames(context, directory)
    if (names.length > 0) {
      components.push({
        id: `${id}-skills`,
        name: `${string(manifest.name, 'Codex plugin name')} Skills`,
        type: 'skill',
        sourceId: context.source.id,
        runtime: { kind: 'bundled', entrypoint: directory },
        skillNames: names
      })
    } else {
      warnings.push('The declared Codex skills directory contains no immediate SKILL.md packages.')
    }
  }

  const mcpPath = manifest.mcpServers === undefined
    ? (context.paths.has('.mcp.json') ? '.mcp.json' : null)
    : portablePath(manifest.mcpServers, 'Codex MCP manifest path')
  if (mcpPath) {
    const mcpManifest = await readPackageJson(context, mcpPath)
    const servers = record(mcpManifest.mcpServers, 'Codex MCP servers')
    for (const [serverName, rawServer] of Object.entries(servers)) {
      const server = record(rawServer, `Codex MCP server ${serverName}`)
      const componentId = packageId(`${id}-${serverName}`, `Codex MCP server ${serverName} ID`)
      if (server.type === 'http' || server.url !== undefined) {
        const endpoint = safeUrl(server.url, `Codex MCP server ${serverName} URL`)
        const sourceId = `${componentId}-remote`
        sources.push(remoteSource(context.source, sourceId, endpoint))
        const oauthResource = server.oauth_resource === undefined
          ? undefined
          : safeUrl(server.oauth_resource, `Codex MCP server ${serverName} OAuth resource`)
        if (oauthResource) oauthProvider = serverName
        if (server.bearer_token_env_var !== undefined) {
          const variable = string(server.bearer_token_env_var, `Codex MCP server ${serverName} token variable`)
          tokenVariables.push(variable)
          if (!configuration.some((field) => field.key === variable)) {
            configuration.push({
              key: variable,
              type: 'string',
              title: variable,
              required: true,
              sensitive: true,
              multiple: false
            })
          }
        }
        ensurePermission(permissions, {
          id: `network-${serverName}`.replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase(),
          kind: 'network',
          access: 'connect',
          default: 'review',
          reviewRequired: true,
          description: `Connect to the ${serverName} MCP endpoint.`,
          resources: [new URL(endpoint).origin]
        })
        components.push({
          id: componentId,
          name: serverName,
          type: 'mcp',
          sourceId,
          runtime: {
            kind: 'remote',
            transport: 'streamable-http',
            endpoint,
            ...(oauthResource ? { oauthResource } : {})
          }
        })
        continue
      }
      const command = string(server.command, `Codex MCP server ${serverName} command`)
      const args = stringArray(server.args, `Codex MCP server ${serverName} args`)
      if (server.cwd !== undefined && server.cwd !== '.') {
        reasons.push(`mcp-cwd-unsupported:${serverName}`)
      }
      const entrypoint = localMcpEntrypoint(context, command, args)
      if (!entrypoint) {
        reasons.push(`mcp-external-command-unsupported:${serverName}`)
        continue
      }
      tokenVariables.push(...configurationFromEnvironment(
        server.env,
        configuration,
        warnings,
        reasons,
        `Codex MCP server ${serverName} environment`
      ).filter((variable) => /(?:token|secret|password|api[_-]?key)/i.test(variable)))
      ensurePermission(permissions, {
        id: `process-${serverName}`.replace(/[^A-Za-z0-9._-]/g, '-').toLowerCase(),
        kind: 'process',
        access: 'execute',
        default: 'review',
        reviewRequired: true,
        description: `Run the bundled ${serverName} MCP server.`
      })
      components.push({
        id: componentId,
        name: serverName,
        type: 'mcp',
        sourceId: context.source.id,
        runtime: { kind: 'bundled', entrypoint, executable: command, args }
      })
    }
  }

  const appPath = manifest.apps === undefined
    ? (context.paths.has('.app.json') ? '.app.json' : null)
    : portablePath(manifest.apps, 'Codex App manifest path')
  if (appPath) {
    const appManifest = await readPackageJson(context, appPath)
    if (Object.keys(record(appManifest.apps, 'Codex apps')).length > 0) {
      warnings.push('Codex App Connector metadata is preserved but cannot run in RailWise AI.')
      if (components.length === 0) reasons.push('codex-app-connector-required')
    }
  }
  const hooks = await parseCodexHooks(context, permissions)
  if (hooks.length > 0) warnings.push('Codex hooks are imported disabled and require a separate permission review.')
  if (components.length === 0 && reasons.length === 0) reasons.push('no-compatible-components')
  ensureUniqueIds(components, 'Codex components')
  ensureUniqueIds(permissions, 'Codex permissions')
  const license = manifest.license === undefined ? null : string(manifest.license, 'Codex plugin license')
  const evidence = licenseEvidence(context.paths, context.source.id)
  for (const item of evidence) item.license = license ?? 'unknown'
  let auth: PackageAuthV1 = { type: 'none' }
  const uniqueTokens = [...new Set(tokenVariables)]
  if (oauthProvider && uniqueTokens.length > 0) reasons.push('mixed-auth-unsupported')
  if (oauthProvider) {
    auth = { type: 'oauth', provider: oauthProvider, discovery: 'ready' }
  } else if (uniqueTokens.length > 0) {
    auth = { type: 'token', provider: id, environmentVariables: uniqueTokens }
    ensurePermission(permissions, {
      id: 'credentials',
      kind: 'credentials',
      access: 'authenticate',
      default: 'review',
      reviewRequired: true,
      description: 'Use credentials stored in RailWise AI safe storage.'
    })
  }
  const install = installability(license, evidence.length, reasons)
  const interfaceMetadata = isRecord(manifest.interface) ? manifest.interface : {}
  return {
    package: {
      schemaVersion: 1,
      id,
      name: optionalString(interfaceMetadata.displayName, 'Codex display name') ?? id,
      summary: optionalString(interfaceMetadata.shortDescription, 'Codex short description') ??
        string(manifest.description, 'Codex plugin description'),
      tier: 'advanced',
      categories: [optionalString(interfaceMetadata.category, 'Codex category') ?? 'Codex'],
      version,
      publisher: publisher(manifest.author, optionalString(interfaceMetadata.developerName, 'Codex developer') ?? 'Unknown Publisher'),
      license,
      source: context.source,
      sources,
      components,
      permissions,
      auth,
      licenseEvidence: evidence,
      dependencies: [],
      hooks,
      configuration,
      updatePolicy: { strategy: 'manual', channel: 'stable', allowMajor: false },
      compatibility: compatibility(undefined),
      ...install
    },
    warnings,
    reasons
  }
}

function mcpbConfiguration(
  value: unknown,
  permissions: PackagePermissionV1[]
): PackageConfigurationFieldV1[] {
  if (value === undefined) return []
  const fields = Object.entries(record(value, 'MCPB user_config')).map(([key, field]) =>
    configurationField(key, field, `MCPB user_config ${key}`)
  )
  if (fields.some((field) => field.sensitive)) {
    ensurePermission(permissions, {
      id: 'credentials',
      kind: 'credentials',
      access: 'authenticate',
      default: 'review',
      reviewRequired: true,
      description: 'Use sensitive MCPB configuration stored in RailWise AI safe storage.'
    })
  }
  const pathKeys = fields.filter((field) => field.type === 'directory' || field.type === 'file').map((field) => field.key)
  if (pathKeys.length > 0) {
    ensurePermission(permissions, {
      id: 'configured-filesystem',
      kind: 'filesystem',
      access: 'read',
      default: 'review',
      reviewRequired: true,
      description: 'Read files or directories selected in MCPB configuration.',
      resources: pathKeys.map((key) => `\${user_config.${key}}`)
    })
  }
  return fields
}

async function parseMcpb(context: ParseContext): Promise<ParsedPackage> {
  const manifest = await readPackageJson(context, 'manifest.json')
  const manifestVersion = manifest.manifest_version ?? manifest.dxt_version
  if (manifestVersion !== '0.3' && manifestVersion !== '0.4') {
    throw new Error('MCPB manifest_version must be 0.3 or 0.4.')
  }
  if (manifest.manifest_version !== undefined && manifest.dxt_version !== undefined &&
      manifest.manifest_version !== manifest.dxt_version) {
    throw new Error('MCPB manifest version fields conflict.')
  }
  const id = packageId(manifest.name, 'MCPB package name')
  const version = exactVersion(manifest.version, 'MCPB package version')
  const server = record(manifest.server, 'MCPB server')
  const serverType = string(server.type, 'MCPB server type')
  if (!new Set(manifestVersion === '0.4' ? ['node', 'python', 'binary', 'uv'] : ['node', 'python', 'binary'])
    .has(serverType)) {
    throw new Error('MCPB server type is invalid for its manifest version.')
  }
  const entrypoint = portablePath(server.entry_point, 'MCPB server entry_point')
  if (!context.paths.has(entrypoint)) throw new Error(`MCPB entry_point is missing: ${entrypoint}.`)
  const mcpConfig = record(server.mcp_config, 'MCPB server mcp_config')
  const command = string(mcpConfig.command, 'MCPB server command')
  const args = stringArray(mcpConfig.args, 'MCPB server args')
  const warnings: string[] = []
  const reasons: string[] = []
  if (serverType === 'uv') {
    const executable = command.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase()
    const expectedEntrypoint = `\${__dirname}/${entrypoint}`
    const configuredEntrypoint = args[1]?.replaceAll('\\', '/')
    if ((executable !== 'uv' && executable !== 'uv.exe') ||
        args[0] !== 'run' || configuredEntrypoint !== expectedEntrypoint) {
      reasons.push('mcpb-uv-command-unsupported')
    }
    if (!context.paths.has('pyproject.toml') || !context.paths.has('uv.lock')) {
      reasons.push('mcpb-uv-lock-required')
    }
  }
  if (mcpConfig.platform_overrides !== undefined &&
      Object.keys(record(mcpConfig.platform_overrides, 'MCPB platform_overrides')).length > 0) {
    warnings.push('MCPB platform overrides are preserved but require runtime selection during activation.')
  }
  const permissions: PackagePermissionV1[] = [{
    id: 'mcp-process',
    kind: 'process',
    access: 'execute',
    default: 'review',
    reviewRequired: true,
    description: 'Run the bundled MCP server process.'
  }]
  if (serverType === 'uv') permissions.push({
    id: 'python-package-index',
    kind: 'network',
    access: 'connect',
    default: 'review',
    reviewRequired: true,
    description: 'Resolve locked Python wheels from the package index.',
    resources: ['https://pypi.org', 'https://files.pythonhosted.org']
  })
  const configuration = mcpbConfiguration(manifest.user_config, permissions)
  const environmentVariables = configurationFromEnvironment(
    mcpConfig.env,
    configuration,
    warnings,
    reasons,
    'MCPB environment'
  ).filter((variable) => /(?:token|secret|password|api[_-]?key)/i.test(variable))
  const sensitiveKeys = configuration.filter((field) => field.sensitive).map((field) => field.key)
  const credentialKeys = [...new Set([...environmentVariables, ...sensitiveKeys])]
  const license = manifest.license === undefined ? null : string(manifest.license, 'MCPB license')
  const evidence = licenseEvidence(context.paths, context.source.id)
  for (const item of evidence) item.license = license ?? 'unknown'
  const install = installability(license, evidence.length, reasons)
  const author = record(manifest.author, 'MCPB author')
  const platforms = isRecord(manifest.compatibility) ? manifest.compatibility.platforms : undefined
  return {
    package: {
      schemaVersion: 1,
      id,
      name: optionalString(manifest.display_name, 'MCPB display_name') ?? id,
      summary: string(manifest.description, 'MCPB description'),
      tier: 'advanced',
      categories: stringArray(manifest.keywords, 'MCPB keywords', ['MCP']),
      version,
      publisher: publisher(author, 'Unknown Publisher'),
      license,
      source: context.source,
      sources: [context.source],
      components: [{
        id: `${id}-mcp`,
        name: optionalString(manifest.display_name, 'MCPB display_name') ?? id,
        type: 'mcp',
        sourceId: context.source.id,
        runtime: {
          kind: 'bundled',
          entrypoint,
          executable: command,
          args,
          ...(serverType === 'uv' ? { managedRuntime: 'uv' as const } : {})
        }
      }],
      permissions,
      auth: credentialKeys.length > 0
        ? { type: 'token', provider: id, environmentVariables: credentialKeys }
        : { type: 'none' },
      licenseEvidence: evidence,
      dependencies: serverType === 'uv'
        ? [{ id: 'uv-runtime', kind: 'runtime', requirement: 'managed uv', optional: false, managedBy: 'workwise' }]
        : [],
      configuration,
      updatePolicy: { strategy: 'manual', channel: 'stable', allowMajor: false },
      compatibility: compatibility(platforms === undefined ? undefined : { platforms }),
      ...install
    },
    warnings,
    reasons
  }
}

async function packageSignature(
  context: ParseContext,
  trustedKeys: TrustedPluginSigningKeyV1[]
): Promise<PackageSignatureV1> {
  const path = 'workwise.signature.json'
  if (!context.paths.has(path)) return { status: 'unsigned' }
  const value = await readPackageJson(context, path)
  if (value.schemaVersion !== 1 || value.algorithm !== 'ed25519') {
    throw new Error('RailWise AI signature metadata is invalid.')
  }
  const keyId = string(value.keyId, 'RailWise AI signature keyId')
  const signer = optionalString(value.signer, 'RailWise AI signature signer')
  const declaredFiles = record(value.files, 'RailWise AI signature files')
  const actualPaths = [...context.paths].filter((entry) => entry !== path).sort()
  const declaredPaths = Object.keys(declaredFiles).sort()
  if (canonicalJson(actualPaths) !== canonicalJson(declaredPaths)) {
    throw new Error('RailWise AI signature file list does not match package contents.')
  }
  const files: Record<string, string> = {}
  for (const file of actualPaths) {
    const expected = string(declaredFiles[file], `RailWise AI signature digest for ${file}`).toLowerCase()
    if (!SHA256.test(expected)) throw new Error(`RailWise AI signature digest is invalid: ${file}.`)
    const actual = createHash('sha256').update(
      await readPackageFile(context, file, 32 * 1024 * 1024)
    ).digest('hex')
    if (actual !== expected) throw new Error(`RailWise AI signature digest does not match: ${file}.`)
    files[file] = expected
  }
  const encoded = string(value.signature, 'RailWise AI Ed25519 signature')
  if (!BASE64.test(encoded)) throw new Error('RailWise AI Ed25519 signature is not valid base64.')
  const signature = Buffer.from(encoded, 'base64')
  if (signature.byteLength !== 64) throw new Error('RailWise AI Ed25519 signature must be 64 bytes.')
  const payload = Buffer.from(canonicalJson({
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyId,
    ...(signer ? { signer } : {}),
    files
  }))
  const trusted = trustedKeys.find((key) => key.keyId === keyId)
  if (!trusted) {
    return { status: 'untrusted', algorithm: 'ed25519', keyId, reason: 'Signing key is not trusted.' }
  }
  let valid = false
  try {
    valid = verifySignature(null, payload, createPublicKey(trusted.publicKey), signature)
  } catch {
    throw new Error('Trusted RailWise AI signing key is invalid.')
  }
  if (!valid) throw new Error('RailWise AI package signature verification failed.')
  return {
    status: 'verified',
    algorithm: 'ed25519',
    keyId,
    ...(trusted.signer ?? signer ? { signer: trusted.signer ?? signer } : {})
  }
}

function detectFormat(paths: Set<string>, requested?: PluginPackageFormatV1): PluginPackageFormatV1 {
  const matches: PluginPackageFormatV1[] = []
  if (paths.has('workwise.plugin.json')) matches.push('wwx')
  if (paths.has('.codex-plugin/plugin.json')) matches.push('codex')
  if (paths.has('manifest.json')) matches.push('mcpb')
  if (requested) {
    if (!matches.includes(requested)) throw new Error(`Package does not contain the ${requested} root manifest.`)
    return requested
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'Package format could not be detected.'
      : 'Package contains conflicting root manifests; select a format explicitly.')
  }
  return matches[0]!
}

export async function parsePreparedPluginDirectory(
  options: ParsePluginPackageOptionsV1
): Promise<PreparedPluginPackageV1> {
  if (options.archiveSha256 !== undefined && !SHA256.test(options.archiveSha256)) {
    throw new Error('Plugin archive SHA-256 is invalid.')
  }
  const before = await inspectPackageDirectory(options.directory)
  const source = sourceFor(options, before.sha256)
  const context: ParseContext = {
    directory: options.directory,
    paths: new Set(before.paths),
    directories: new Set(before.directories),
    source,
    catalogSourceId: options.catalogSourceId
  }
  const format = detectFormat(context.paths, options.format)
  const parsed = format === 'wwx'
    ? await parseWwx(context)
    : format === 'codex'
      ? await parseCodex(context)
      : await parseMcpb(context)
  parsed.package.signature = await packageSignature(context, options.trustedSigningKeys ?? [])
  const after = await inspectPackageDirectory(options.directory)
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error('Plugin package changed while its metadata was parsed.')
  }
  return {
    schemaVersion: 1,
    format,
    package: parsed.package,
    preparedDirectory: options.directory,
    ...(options.archiveSha256 ? { archiveSha256: options.archiveSha256.toLowerCase() } : {}),
    contentSha256: before.sha256,
    reviewSha256: marketplacePackageReviewSha256(parsed.package),
    warnings: parsed.warnings,
    compatibility: {
      workwiseCompatible: parsed.reasons.length === 0,
      reasons: [...new Set(parsed.reasons)]
    }
  }
}

export async function preparePluginArchive(
  options: PreparePluginArchiveOptionsV1
): Promise<PreparedPluginPackageV1> {
  const archiveSha256 = createHash('sha256').update(options.archive).digest('hex')
  let inspection: PluginArchiveInspectionV1 | undefined
  try {
    inspection = await extractPluginArchive(options.archive, options.targetDirectory)
    const prepared = await parsePreparedPluginDirectory({
      directory: options.targetDirectory,
      format: options.format,
      catalogSourceId: options.catalogSourceId,
      sourceLocation: options.sourceLocation,
      sourceKind: options.sourceKind,
      archiveSha256,
      trustedSigningKeys: options.trustedSigningKeys
    })
    return { ...prepared, archiveInspection: inspection }
  } catch (error) {
    await rm(options.targetDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function installPreparedPluginPackage(
  service: PackageInstallationService,
  prepared: PreparedPluginPackageV1,
  options: InstallPreparedPluginPackageOptionsV1
): Promise<InstalledPackageV1> {
  if (!prepared.compatibility.workwiseCompatible ||
      prepared.package.availability.status !== 'available' ||
      prepared.package.installation.mode !== 'direct-mirror') {
    throw new Error('Prepared plugin package is not eligible for direct installation.')
  }
  return service.install({
    package: prepared.package,
    sourceDirectory: prepared.preparedDirectory,
    expectedContentSha256: prepared.contentSha256,
    expectedCurrentVersion: options.expectedCurrentVersion,
    reviewSha256: prepared.reviewSha256,
    scope: options.scope,
    ...(options.scope === 'workspace' ? { workspaceRoot: options.workspaceRoot } : {}),
    permissions: options.permissions,
    idempotencyKey: options.idempotencyKey
  })
}
