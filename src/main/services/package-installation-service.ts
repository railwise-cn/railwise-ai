import { isApprovedAutocadUpstreamSkill, isApprovedUpstreamPackage, isCatalogInstallable } from '../../shared/engineering-marketplace'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  InstalledPackageArtifactV1,
  InstalledPackagePermissionV1,
  InstalledPackageV1,
  MarketplacePackageV1,
  PackageSourceV1,
  PackageHealthV1
} from '../../shared/marketplace'
import { evaluateMarketplaceLicense } from '../../shared/marketplace'
import {
  canonicalizeContainmentRoot,
  isCanonicalPathContained,
  recheckContainedParent
} from './canonical-containment'
import { atomicWriteFile, readRecoveredFile, runSerialized } from './durable-file'

const INSTALL_MANIFEST_SCHEMA = 'workwise.installed-packages'
const INSTALL_MANIFEST_VERSION = 1
const CONTENT_SHA256 = /^[0-9a-f]{64}$/i
const IMMUTABLE_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024
const MAX_INSTALLED_PACKAGES = 1_000
const MAX_MUTATION_KEYS = 128
const MAX_IDENTIFIER_LENGTH = 256

export type PackageInstallLimitsV1 = Readonly<{
  maxFiles: number
  maxEntries: number
  maxTotalBytes: number
  maxFileBytes: number
  maxDepth: number
}>

export const PACKAGE_INSTALL_LIMITS: PackageInstallLimitsV1 = Object.freeze({
  maxFiles: 4_096,
  maxEntries: 8_192,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 32 * 1024 * 1024,
  maxDepth: 24
})

export const MANAGED_PYPI_INSTALL_LIMITS: PackageInstallLimitsV1 = Object.freeze({
  maxFiles: 50_000,
  maxEntries: 75_000,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxDepth: 64
})

export type PackageTreeInspectionV1 = {
  sha256: string
  fileCount: number
  totalBytes: number
  paths: string[]
  directories: string[]
}

type StoredInstalledPackageV1 = Omit<InstalledPackageV1, 'rollback'> & {
  reviewedPackage?: MarketplacePackageV1
}

type StoredPackageRecordV1 = {
  current: StoredInstalledPackageV1
  rollback?: StoredInstalledPackageV1
}

type InstallationMutationV1 = {
  packageId: string
  action: 'install' | 'rollback' | 'permissions'
  version: string
}

type InstallationManifestV1 = {
  schema: typeof INSTALL_MANIFEST_SCHEMA
  version: typeof INSTALL_MANIFEST_VERSION
  revision: number
  records: StoredPackageRecordV1[]
  mutationKeys: Record<string, InstallationMutationV1>
}

export type InstallPackageRequestV1 = {
  package: MarketplacePackageV1
  sourceDirectory: string
  expectedContentSha256: string
  expectedCurrentVersion: string | null
  reviewSha256: string
  scope: InstalledPackageV1['scope']
  workspaceRoot?: string
  permissions: InstalledPackagePermissionV1[]
  idempotencyKey: string
}

export type RollbackPackageRequestV1 = {
  packageId: string
  expectedCurrentVersion: string
  idempotencyKey: string
}

export type CompensateFailedInstallRequestV1 = {
  packageId: string
  failedVersion: string
  failedReviewSha256: string
  failedArtifactSha256: string
  installIdempotencyKey: string
}

export type UpdatePackagePermissionsRequestV1 = {
  package: MarketplacePackageV1
  packageId: string
  expectedCurrentVersion: string
  reviewSha256: string
  workspaceRoot?: string
  declaredPermissionIds: string[]
  permissions: InstalledPackagePermissionV1[]
  idempotencyKey: string
}

export type PackageInstallationServiceOptions = {
  rootDirectory?: string
  now?: () => Date
  healthCheck?: (input: {
    packageId: string
    version: string
    location: string
  }) => Promise<PackageHealthV1>
  fileCopyHook?: (phase: 'opened' | 'copied', sourcePath: string) => Promise<void>
  beforePersistManifest?: (manifest: Readonly<InstallationManifestV1>) => Promise<void>
}

type ScannedFile = {
  path: string
  size: number
  sha256: string
  executable: boolean
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const record = value as Record<string, unknown>
  return '{' + Object.keys(record).sort().map((key) =>
    JSON.stringify(key) + ':' + canonicalJson(record[key])
  ).join(',') + '}'
}

export function marketplacePackageRuntimeIdentity(item: MarketplacePackageV1): string {
  return canonicalJson({
    schemaVersion: item.schemaVersion,
    id: item.id,
    version: item.version,
    publisher: item.publisher,
    license: item.license,
    source: item.source,
    sources: item.sources,
    components: item.components,
    auth: item.auth,
    licenseEvidence: item.licenseEvidence,
    dependencies: item.dependencies,
    hooks: item.hooks,
    signature: item.signature,
    configuration: item.configuration,
    updatePolicy: item.updatePolicy,
    installation: item.installation
  })
}

/**
 * Compatibility and availability are catalog metadata. They may be refreshed
 * for an already installed artifact without replacing the artifact itself.
 * Runtime, provenance, authentication, and installation metadata remain
 * immutable until a real package version changes.
 */
export function marketplacePackagePermissionUpdateIdentity(item: MarketplacePackageV1): string {
  return marketplacePackageRuntimeIdentity(item)
}

export type MarketplacePackageDriftV1 =
  | 'unchanged'
  | 'metadata-refresh'
  | 'runtime-drift'

export function classifyMarketplacePackageDrift(
  previous: MarketplacePackageV1,
  next: MarketplacePackageV1
): MarketplacePackageDriftV1 {
  if (marketplacePackageReviewSha256(previous) === marketplacePackageReviewSha256(next)) {
    return 'unchanged'
  }
  return marketplacePackageRuntimeIdentity(previous) === marketplacePackageRuntimeIdentity(next)
    ? 'metadata-refresh'
    : 'runtime-drift'
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required.')
  return value
}

function boundedString(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (result.length > MAX_IDENTIFIER_LENGTH) throw new Error(label + ' is too long.')
  return result
}

function mutationKey(value: unknown): string {
  const key = boundedString(value, 'Idempotency key')
  if (key.includes('\0') || new Set(['__proto__', 'prototype', 'constructor']).has(key)) {
    throw new Error('Idempotency key is unsafe.')
  }
  return key
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be an object.')
  }
  return value as Record<string, unknown>
}

function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

function packageDirectoryName(packageId: string): string {
  return createHash('sha256').update(packageId).digest('hex')
}

function normalizePackagePath(value: string, label: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') ||
      /^[A-Za-z]:/.test(value)) {
    throw new Error(label + ' must be a portable relative path.')
  }
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(label + ' contains path traversal.')
  }
  for (const segment of segments) {
    const base = segment.split('.')[0]?.toLowerCase() ?? ''
    const containsControl = [...segment].some((character) => {
      const code = character.charCodeAt(0)
      return code >= 1 && code <= 31
    })
    if (/[<>:"|?*]/.test(segment) || containsControl || /[. ]$/.test(segment) ||
        new Set(['con', 'prn', 'aux', 'nul']).has(base) || /^(?:com|lpt)[1-9]$/.test(base)) {
      throw new Error(label + ' is not portable across supported platforms.')
    }
  }
  return segments.join('/')
}

function isLicensePath(path: string): boolean {
  const name = path.split('/').at(-1)?.toLowerCase() ?? ''
  return /^(?:licen[cs]e|notice|copying)(?:\.|$)/.test(name)
}

function treeDigest(files: ScannedFile[], directories: string[]): string {
  const digest = createHash('sha256')
  for (const directory of directories) {
    digest.update('directory:')
    digest.update(String(Buffer.byteLength(directory)))
    digest.update(':')
    digest.update(directory)
    digest.update('\n')
  }
  for (const file of files) {
    digest.update(file.executable ? 'executable:' : 'file:')
    digest.update(String(Buffer.byteLength(file.path)))
    digest.update(':')
    digest.update(file.path)
    digest.update('\0')
    digest.update(String(file.size))
    digest.update(':')
    digest.update(file.sha256)
    digest.update('\n')
  }
  return digest.digest('hex')
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Directory fsync is unavailable on some Windows/filesystem combinations.
  }
}

async function syncPackageDirectories(
  root: string,
  directories: string[]
): Promise<void> {
  for (const path of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(join(root, ...path.split('/')))
  }
  await syncDirectory(root)
  await syncDirectory(dirname(root))
}

async function assertNoLinkedAncestors(root: string, target: string): Promise<void> {
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Package path escapes its root.')
  }
  let current = root
  const segments = rel.split(sep)
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Package paths must not cross links or non-directories.')
    }
  }
}

async function scanPackageTree(options: {
  sourceDirectory: string
  destinationDirectory?: string
  fileCopyHook?: PackageInstallationServiceOptions['fileCopyHook']
  limits?: PackageInstallLimitsV1
}): Promise<PackageTreeInspectionV1> {
  const limits = options.limits ?? PACKAGE_INSTALL_LIMITS
  const lexicalRoot = resolve(options.sourceDirectory)
  const lexicalInfo = await lstat(lexicalRoot)
  if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isDirectory()) {
    throw new Error('Package root must be a real directory.')
  }
  const root = await realpath(lexicalRoot)
  const rootInfo = await lstat(root)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('Package root must be a real directory.')
  }
  if (options.destinationDirectory) {
    await mkdir(options.destinationDirectory, { recursive: true, mode: 0o700 })
  }

  const files: ScannedFile[] = []
  const directories: string[] = []
  const collisions = new Set<string>()
  let totalBytes = 0

  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new Error(`Package directory depth exceeds ${limits.maxDepth}.`)
    }
    const beforeDirectory = await lstat(directory)
    if (beforeDirectory.isSymbolicLink() || !beforeDirectory.isDirectory()) {
      throw new Error('Package directories must not be links or special files.')
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.toLowerCase() === '.git') {
        throw new Error('Package Git metadata and submodules are not allowed.')
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      const portablePath = normalizePackagePath(relativePath, 'Package path')
      const collisionKey = portablePath.normalize('NFC').toLowerCase()
      if (collisions.has(collisionKey)) throw new Error(`Package path collision at ${portablePath}.`)
      collisions.add(collisionKey)
      if (collisions.size > limits.maxEntries) {
        throw new Error(`Package entry count exceeds ${limits.maxEntries}.`)
      }

      const sourcePath = join(directory, entry.name)
      const pathInfo = await lstat(sourcePath)
      if (pathInfo.isSymbolicLink()) throw new Error(`Package links are not allowed: ${portablePath}.`)
      if (pathInfo.isDirectory()) {
        directories.push(portablePath)
        if (options.destinationDirectory) {
          await mkdir(join(options.destinationDirectory, ...portablePath.split('/')), {
            recursive: true,
            mode: 0o700
          })
        }
        await visit(sourcePath, portablePath, depth + 1)
        continue
      }
      if (!pathInfo.isFile()) throw new Error(`Package special file is not allowed: ${portablePath}.`)
      if (files.length + 1 > limits.maxFiles) {
        throw new Error(`Package file count exceeds ${limits.maxFiles}.`)
      }
      if (pathInfo.size > limits.maxFileBytes) {
        throw new Error(`Package file exceeds ${limits.maxFileBytes} bytes: ${portablePath}.`)
      }
      totalBytes += pathInfo.size
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(`Package expands beyond ${limits.maxTotalBytes} bytes.`)
      }

      await assertNoLinkedAncestors(root, sourcePath)
      const canonicalFile = await realpath(sourcePath)
      if (!isCanonicalPathContained(root, canonicalFile)) throw new Error('Package path escapes its root.')
      const handle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      try {
        await options.fileCopyHook?.('opened', sourcePath)
        const before = await handle.stat()
        if (!before.isFile() || before.dev !== pathInfo.dev || before.ino !== pathInfo.ino ||
            before.size !== pathInfo.size) {
          throw new Error(`Package file changed before it could be copied: ${portablePath}.`)
        }
        bytes = await handle.readFile()
        const after = await handle.stat()
        const currentPath = await lstat(sourcePath)
        await assertNoLinkedAncestors(root, sourcePath)
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
            after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
            currentPath.isSymbolicLink() || currentPath.dev !== after.dev ||
            currentPath.ino !== after.ino || currentPath.size !== after.size) {
          throw new Error(`Package file changed while it was copied: ${portablePath}.`)
        }
      } finally {
        await handle.close()
      }
      if (options.destinationDirectory) {
        const destination = join(options.destinationDirectory, ...portablePath.split('/'))
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        const output = await open(destination, 'wx', (pathInfo.mode & 0o111) !== 0 ? 0o700 : 0o600)
        try {
          await output.writeFile(bytes)
          await output.sync()
        } finally {
          await output.close()
        }
      }
      await options.fileCopyHook?.('copied', sourcePath)
      files.push({
        path: portablePath,
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: (pathInfo.mode & 0o111) !== 0
      })
    }
    const afterDirectory = await lstat(directory)
    if (!afterDirectory.isDirectory() || afterDirectory.isSymbolicLink() ||
        afterDirectory.dev !== beforeDirectory.dev || afterDirectory.ino !== beforeDirectory.ino ||
        afterDirectory.mtimeMs !== beforeDirectory.mtimeMs) {
      throw new Error('Package directory changed while it was copied.')
    }
  }

  await visit(root, '', 0)
  if (files.length === 0) throw new Error('Package is empty.')
  const finalLexical = await lstat(lexicalRoot)
  if (finalLexical.isSymbolicLink() || finalLexical.dev !== lexicalInfo.dev ||
      finalLexical.ino !== lexicalInfo.ino || await realpath(lexicalRoot) !== root) {
    throw new Error('Package root changed while it was copied.')
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  directories.sort((left, right) => left.localeCompare(right))
  return {
    sha256: treeDigest(files, directories),
    fileCount: files.length,
    totalBytes,
    paths: files.map((file) => file.path),
    directories
  }
}

export function marketplacePackageReviewSha256(item: MarketplacePackageV1): string {
  return createHash('sha256').update(canonicalJson(item)).digest('hex')
}

export function inspectPackageDirectory(
  sourceDirectory: string,
  limits: PackageInstallLimitsV1 = PACKAGE_INSTALL_LIMITS
): Promise<PackageTreeInspectionV1> {
  return scanPackageTree({ sourceDirectory, limits })
}

export function packageInstallLimitsForSource(source: PackageSourceV1): PackageInstallLimitsV1 {
  return source.kind === 'pypi' && source.catalogSourceId === 'workwise-official'
    ? MANAGED_PYPI_INSTALL_LIMITS
    : PACKAGE_INSTALL_LIMITS
}

export function packageInstallLimitsFor(item: MarketplacePackageV1): PackageInstallLimitsV1 {
  return packageInstallLimitsForSource(item.source)
}

export async function stagePackageDirectory(
  sourceDirectory: string,
  destinationDirectory: string,
  limits: PackageInstallLimitsV1 = PACKAGE_INSTALL_LIMITS
): Promise<PackageTreeInspectionV1> {
  if (await pathExists(destinationDirectory)) {
    throw new Error('Package staging destination must not already exist.')
  }
  try {
    const copied = await scanPackageTree({ sourceDirectory, destinationDirectory, limits })
    const sourceAfterCopy = await scanPackageTree({ sourceDirectory, limits })
    if (canonicalJson(sourceAfterCopy) !== canonicalJson(copied)) {
      throw new Error('Package source changed after it was staged.')
    }
    const staged = await scanPackageTree({ sourceDirectory: destinationDirectory, limits })
    if (canonicalJson(staged) !== canonicalJson(copied)) {
      throw new Error('Staged package content does not match its verified source.')
    }
    return staged
  } catch (error) {
    await rm(destinationDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function emptyManifest(): InstallationManifestV1 {
  return {
    schema: INSTALL_MANIFEST_SCHEMA,
    version: INSTALL_MANIFEST_VERSION,
    revision: 0,
    records: [],
    mutationKeys: {}
  }
}

function installedPackage(record: StoredPackageRecordV1): InstalledPackageV1 {
  const { reviewedPackage: _reviewedPackage, ...current } = record.current
  return clone({
    ...current,
    rollback: record.rollback
      ? {
          available: true,
          version: record.rollback.version,
          source: record.rollback.source,
          sources: record.rollback.sources,
          components: record.rollback.components,
          createdAt: record.rollback.timestamps.updatedAt ?? record.rollback.timestamps.installedAt,
          license: record.rollback.license,
          reviewSha256: record.rollback.reviewSha256,
          artifact: record.rollback.artifact,
          permissions: record.rollback.permissions,
          updatePolicy: record.rollback.updatePolicy,
          health: record.rollback.health
        }
      : { available: false }
  })
}

export class PackageInstallationService {
  private readonly rootDirectory: string
  private readonly manifestPath: string
  private readonly now: () => Date
  private readonly healthCheck?: PackageInstallationServiceOptions['healthCheck']
  private readonly fileCopyHook?: PackageInstallationServiceOptions['fileCopyHook']
  private readonly beforePersistManifest?: PackageInstallationServiceOptions['beforePersistManifest']

  constructor(options: PackageInstallationServiceOptions = {}) {
    this.rootDirectory = resolve(options.rootDirectory ?? join(homedir(), '.workwise', 'plugins'))
    this.manifestPath = join(this.rootDirectory, 'installed.json')
    this.now = options.now ?? (() => new Date())
    this.healthCheck = options.healthCheck
    this.fileCopyHook = options.fileCopyHook
    this.beforePersistManifest = options.beforePersistManifest
  }

  async list(): Promise<InstalledPackageV1[]> {
    return runSerialized(this.manifestQueue(), async () => {
      await this.ensureRoot()
      return (await this.readManifest()).records.map(installedPackage)
    })
  }

  async get(packageId: string): Promise<InstalledPackageV1 | null> {
    return runSerialized(this.manifestQueue(), async () => {
      await this.ensureRoot()
      const record = (await this.readManifest()).records.find((item) =>
        item.current.packageId === packageId
      )
      return record ? installedPackage(record) : null
    })
  }

  async getReviewedPackage(packageId: string): Promise<MarketplacePackageV1 | null> {
    return runSerialized(this.manifestQueue(), async () => {
      await this.ensureRoot()
      const record = (await this.readManifest()).records.find((item) =>
        item.current.packageId === packageId
      )
      return record?.current.reviewedPackage ? clone(record.current.reviewedPackage) : null
    })
  }

  async install(request: InstallPackageRequestV1): Promise<InstalledPackageV1> {
    this.assertInstallRequest(request)
    const workspaceRoot = request.scope === 'workspace'
      ? await canonicalizeContainmentRoot(request.workspaceRoot!)
      : undefined
    return runSerialized(this.packageQueue(request.package.id), async () => {
      await this.ensureRoot()
      const replay = await this.findMutation(request.idempotencyKey)
      if (replay) return this.replayInstall(replay, request.package.id, request.package.version)
      await this.assertSourceDoesNotOverlapInstallRoot(request.sourceDirectory)
      await this.assertExpectedVersion(
        request.package.id,
        request.expectedCurrentVersion,
        request.package.version
      )

      const staging = join(this.rootDirectory, 'staging', randomUUID())
      const limits = packageInstallLimitsFor(request.package)
      let activatedNew = false
      let versionLocation = ''
      try {
        const copied = await scanPackageTree({
          sourceDirectory: request.sourceDirectory,
          destinationDirectory: staging,
          fileCopyHook: this.fileCopyHook,
          limits
        })
        if (copied.sha256 !== request.expectedContentSha256.toLowerCase()) {
          throw new Error('Package content SHA-256 verification failed.')
        }
        const sourceAfterCopy = await scanPackageTree({ sourceDirectory: request.sourceDirectory, limits })
        if (canonicalJson(sourceAfterCopy) !== canonicalJson(copied)) {
          throw new Error('Package source changed after it was staged.')
        }
        this.assertLicenseFiles(request.package, copied.paths)

        const staged = await scanPackageTree({ sourceDirectory: staging, limits })
        if (canonicalJson(staged) !== canonicalJson(copied)) {
          throw new Error('Staged package content does not match its verified source.')
        }
        versionLocation = this.versionPath(request.package.id, copied.sha256)
        await mkdir(dirname(versionLocation), { recursive: true, mode: 0o700 })
        await recheckContainedParent(this.rootDirectory, versionLocation)
        if (await pathExists(versionLocation)) {
          const existing = await scanPackageTree({ sourceDirectory: versionLocation, limits })
          if (existing.sha256 !== copied.sha256) {
            throw new Error('Existing package version directory failed integrity verification.')
          }
          await this.removeContainedDirectory(staging)
        } else {
          await rename(staging, versionLocation)
          activatedNew = true
          await syncPackageDirectories(versionLocation, copied.directories)
        }

        const beforeHealth = await scanPackageTree({ sourceDirectory: versionLocation, limits })
        if (beforeHealth.sha256 !== copied.sha256) {
          throw new Error('Activated package failed integrity verification.')
        }
        const health = await this.checkHealth(
          request.package.id,
          request.package.version,
          versionLocation
        )
        if (health.status === 'unhealthy') {
          throw new Error(health.message ?? 'Package health check failed.')
        }
        const afterHealth = await scanPackageTree({ sourceDirectory: versionLocation, limits })
        if (canonicalJson(afterHealth) !== canonicalJson(beforeHealth)) {
          throw new Error('Package content changed during its health check.')
        }

        const artifact: InstalledPackageArtifactV1 = {
          sha256: copied.sha256,
          location: versionLocation,
          fileCount: copied.fileCount,
          totalBytes: copied.totalBytes
        }
        const result = await this.commitInstall({
          ...request,
          ...(workspaceRoot ? { workspaceRoot } : {})
        }, artifact, health)
        activatedNew = false
        return result
      } catch (error) {
        if (activatedNew && versionLocation) {
          await this.removeContainedDirectory(versionLocation).catch(() => undefined)
        }
        throw error
      } finally {
        await this.removeContainedDirectory(staging).catch(() => undefined)
      }
    })
  }

  async compensateFailedInstall(
    request: CompensateFailedInstallRequestV1
  ): Promise<InstalledPackageV1 | null> {
    requiredString(request.packageId, 'Package ID')
    requiredString(request.failedVersion, 'Failed package version')
    mutationKey(request.installIdempotencyKey)
    if (!CONTENT_SHA256.test(request.failedReviewSha256) ||
        !CONTENT_SHA256.test(request.failedArtifactSha256)) {
      throw new Error('Failed package compensation metadata is invalid.')
    }
    let failedLocation: string | undefined
    const restored = await runSerialized(this.packageQueue(request.packageId), async () =>
      runSerialized(this.manifestQueue(), async () => {
        await this.ensureRoot()
        const manifest = await this.readManifest()
        const index = manifest.records.findIndex((item) => item.current.packageId === request.packageId)
        if (index < 0) return null
        const record = manifest.records[index]!
        if (record.current.version !== request.failedVersion ||
            record.current.reviewSha256 !== request.failedReviewSha256.toLowerCase() ||
            record.current.artifact.sha256 !== request.failedArtifactSha256.toLowerCase()) {
          throw new Error('Installed package changed before failed activation could be compensated.')
        }
        failedLocation = record.current.artifact.location
        if (record.rollback) manifest.records[index] = { current: record.rollback }
        else manifest.records.splice(index, 1)
        const mutation = manifest.mutationKeys[request.installIdempotencyKey]
        if (mutation?.packageId === request.packageId && mutation.action === 'install' &&
            mutation.version === request.failedVersion) {
          delete manifest.mutationKeys[request.installIdempotencyKey]
        }
        manifest.revision += 1
        await this.persistManifest(manifest)
        return record.rollback ? installedPackage({ current: record.rollback }) : null
      })
    )
    if (failedLocation && restored?.artifact.location !== failedLocation) {
      await this.removeContainedDirectory(failedLocation).catch(() => undefined)
    }
    return restored
  }

  async rollback(request: RollbackPackageRequestV1): Promise<InstalledPackageV1> {
    requiredString(request.packageId, 'Package ID')
    requiredString(request.expectedCurrentVersion, 'Expected package version')
    mutationKey(request.idempotencyKey)
    return runSerialized(this.packageQueue(request.packageId), async () =>
      runSerialized(this.manifestQueue(), async () => {
        await this.ensureRoot()
        const manifest = await this.readManifest()
        const replay = manifest.mutationKeys[request.idempotencyKey]
        if (replay) {
          if (replay.packageId !== request.packageId || replay.action !== 'rollback') {
            throw new Error('Idempotency key was already used for another package mutation.')
          }
          const replayed = manifest.records.find((item) => item.current.packageId === request.packageId)
          if (!replayed || replayed.current.version !== replay.version) {
            throw new Error('Idempotent rollback result is no longer available.')
          }
          return installedPackage(replayed)
        }
        const index = manifest.records.findIndex((item) => item.current.packageId === request.packageId)
        if (index < 0) throw new Error('Package is not installed.')
        const record = manifest.records[index]!
        if (record.current.version !== request.expectedCurrentVersion) {
          throw new Error('Installed package version changed before rollback.')
        }
        if (!record.rollback) throw new Error('No package rollback is available.')
        const limits = packageInstallLimitsForSource(record.rollback.source)
        const inspected = await scanPackageTree({
          sourceDirectory: record.rollback.artifact.location,
          limits
        })
        if (inspected.sha256 !== record.rollback.artifact.sha256 ||
            inspected.fileCount !== record.rollback.artifact.fileCount ||
            inspected.totalBytes !== record.rollback.artifact.totalBytes) {
          throw new Error('Rollback package failed integrity verification.')
        }
        const now = this.now().toISOString()
        const health = await this.checkHealth(
          request.packageId,
          record.rollback.version,
          record.rollback.artifact.location
        )
        if (health.status === 'unhealthy') throw new Error(health.message ?? 'Rollback health check failed.')
        const afterHealth = await scanPackageTree({
          sourceDirectory: record.rollback.artifact.location,
          limits
        })
        if (canonicalJson(afterHealth) !== canonicalJson(inspected)) {
          throw new Error('Rollback package content changed during its health check.')
        }
        const previousCurrent = record.current
        const nextCurrent: StoredInstalledPackageV1 = {
          ...record.rollback,
          timestamps: {
            ...record.rollback.timestamps,
            updatedAt: now,
            ...(this.healthCheck ? { lastCheckedAt: now } : {})
          },
          health
        }
        manifest.records[index] = { current: nextCurrent, rollback: previousCurrent }
        manifest.revision += 1
        this.recordMutation(manifest, request.idempotencyKey, {
          packageId: request.packageId,
          action: 'rollback',
          version: nextCurrent.version
        })
        await this.persistManifest(manifest)
        return installedPackage(manifest.records[index]!)
      })
    )
  }

  async updatePermissions(request: UpdatePackagePermissionsRequestV1): Promise<InstalledPackageV1> {
    requiredString(request.packageId, 'Package ID')
    requiredString(request.expectedCurrentVersion, 'Expected package version')
    if (!CONTENT_SHA256.test(request.reviewSha256)) throw new Error('Package review SHA-256 is invalid.')
    if (marketplacePackageReviewSha256(request.package) !== request.reviewSha256.toLowerCase()) {
      throw new Error('Package review is stale; review the package again.')
    }
    mutationKey(request.idempotencyKey)
    if (!Array.isArray(request.declaredPermissionIds) || request.declaredPermissionIds.length > 128) {
      throw new Error('Package permission declarations exceed the safety limit.')
    }
    const declared = new Set(request.declaredPermissionIds)
    if (declared.size !== request.declaredPermissionIds.length ||
        [...declared].some((permissionId) => !permissionId || permissionId.length > 128)) {
      throw new Error('Package permission declarations are invalid.')
    }
    const packageDeclared = new Set(request.package.permissions.map((permission) => permission.id))
    if (packageDeclared.size !== request.package.permissions.length ||
        packageDeclared.size !== declared.size ||
        [...packageDeclared].some((permissionId) => !declared.has(permissionId))) {
      throw new Error('Package permission declarations do not match the reviewed package.')
    }
    if (!Array.isArray(request.permissions) || request.permissions.length !== declared.size) {
      throw new Error('Every package permission must be reviewed.')
    }
    const decisions = new Map<string, InstalledPackagePermissionV1>()
    for (const permission of request.permissions) {
      if (!declared.has(permission.permissionId) || decisions.has(permission.permissionId) ||
          (permission.decision !== 'granted' && permission.decision !== 'denied')) {
        throw new Error('Package permission decisions are invalid.')
      }
      decisions.set(permission.permissionId, clone(permission))
    }
    if (decisions.size !== declared.size) throw new Error('Every package permission must be reviewed.')
    return runSerialized(this.packageQueue(request.packageId), async () =>
      runSerialized(this.manifestQueue(), async () => {
        await this.ensureRoot()
        const manifest = await this.readManifest()
        const replay = manifest.mutationKeys[request.idempotencyKey]
        if (replay) {
          if (replay.packageId !== request.packageId || replay.action !== 'permissions') {
            throw new Error('Idempotency key was already used for another package mutation.')
          }
          const replayed = manifest.records.find((item) => item.current.packageId === request.packageId)
          if (!replayed || replayed.current.version !== replay.version) {
            throw new Error('Idempotent permission update result is no longer available.')
          }
          return installedPackage(replayed)
        }
        const index = manifest.records.findIndex((item) => item.current.packageId === request.packageId)
        if (index < 0) throw new Error('Package is not installed.')
        const record = manifest.records[index]!
        if (record.current.version !== request.expectedCurrentVersion) {
          throw new Error('Installed package version changed before permissions could be updated.')
        }
        if (request.package.id !== record.current.packageId ||
            request.package.version !== record.current.version ||
            request.package.source.id !== record.current.source.id) {
          throw new Error('Package metadata does not match the installed package.')
        }
        if (record.current.reviewedPackage &&
            marketplacePackagePermissionUpdateIdentity(record.current.reviewedPackage) !==
              marketplacePackagePermissionUpdateIdentity(request.package)) {
          throw new Error('Package runtime metadata changed without a version update.')
        }
        if (record.current.scope === 'workspace') {
          const workspaceRoot = request.workspaceRoot
            ? await canonicalizeContainmentRoot(request.workspaceRoot)
            : undefined
          if (!record.current.workspaceRoot || workspaceRoot !== record.current.workspaceRoot) {
            throw new Error('Workspace package permissions must be updated from their installed workspace.')
          }
        } else if (request.workspaceRoot !== undefined) {
          throw new Error('Only workspace-scoped packages may use a workspace root.')
        }
        const now = this.now().toISOString()
        const current: StoredInstalledPackageV1 = {
          ...record.current,
          reviewSha256: request.reviewSha256.toLowerCase(),
          reviewedPackage: clone(request.package),
          permissions: [...decisions.values()],
          timestamps: {
            ...record.current.timestamps,
            updatedAt: now,
            ...(this.healthCheck ? { lastCheckedAt: now } : {})
          }
        }
        manifest.records[index] = { ...record, current }
        manifest.revision += 1
        this.recordMutation(manifest, request.idempotencyKey, {
          packageId: request.packageId,
          action: 'permissions',
          version: current.version
        })
        await this.persistManifest(manifest)
        return installedPackage(manifest.records[index]!)
      })
    )
  }

  private async commitInstall(
    request: InstallPackageRequestV1,
    artifact: InstalledPackageArtifactV1,
    health: PackageHealthV1
  ): Promise<InstalledPackageV1> {
    let staleRollbackLocation: string | undefined
    const installed = await runSerialized(this.manifestQueue(), async () => {
      const manifest = await this.readManifest()
      const replay = manifest.mutationKeys[request.idempotencyKey]
      if (replay) return this.replayInstallFromManifest(manifest, replay, request.package.id, request.package.version)
      const index = manifest.records.findIndex((item) => item.current.packageId === request.package.id)
      const currentRecord = index >= 0 ? manifest.records[index]! : undefined
      this.assertCurrentVersion(currentRecord?.current.version ?? null, request.expectedCurrentVersion)
      if (currentRecord?.current.version === request.package.version) {
        throw new Error('An installed package version is immutable and cannot be replaced in place.')
      }
      const now = this.now().toISOString()
      const current: StoredInstalledPackageV1 = {
        schemaVersion: 1,
        packageId: request.package.id,
        version: request.package.version,
        license: request.package.license,
        reviewSha256: request.reviewSha256.toLowerCase(),
        source: clone(request.package.source),
        sources: clone(request.package.sources),
        components: request.package.components.map((component) => ({
          componentId: component.id,
          sourceId: component.sourceId
        })),
        scope: request.scope,
        ...(request.scope === 'workspace' ? { workspaceRoot: resolve(request.workspaceRoot!) } : {}),
        artifact: clone(artifact),
        permissions: clone(request.permissions),
        timestamps: {
          installedAt: currentRecord?.current.timestamps.installedAt ?? now,
          ...(currentRecord ? { updatedAt: now } : {}),
          ...(this.healthCheck ? { lastCheckedAt: now } : {})
        },
        updatePolicy: clone(request.package.updatePolicy),
        reviewedPackage: clone(request.package),
        health: clone(health)
      }
      if (currentRecord?.rollback &&
          currentRecord.rollback.artifact.location !== current.artifact.location &&
          currentRecord.rollback.artifact.location !== currentRecord.current.artifact.location) {
        staleRollbackLocation = currentRecord.rollback.artifact.location
      }
      const nextRecord: StoredPackageRecordV1 = {
        current,
        ...(currentRecord ? { rollback: currentRecord.current } : {})
      }
      if (index >= 0) manifest.records[index] = nextRecord
      else manifest.records.push(nextRecord)
      manifest.revision += 1
      this.recordMutation(manifest, request.idempotencyKey, {
        packageId: request.package.id,
        action: 'install',
        version: request.package.version
      })
      await this.persistManifest(manifest)
      return installedPackage(nextRecord)
    })
    if (staleRollbackLocation) {
      await this.removeContainedDirectory(staleRollbackLocation).catch(() => undefined)
    }
    return installed
  }

  private assertInstallRequest(request: InstallPackageRequestV1): void {
    const item = request.package
    boundedString(item.id, 'Package ID')
    boundedString(item.version, 'Package version')
    requiredString(request.sourceDirectory, 'Package source directory')
    mutationKey(request.idempotencyKey)
    if (request.expectedCurrentVersion !== null) {
      boundedString(request.expectedCurrentVersion, 'Expected package version')
    }
    if (!new Set(['user', 'workspace', 'team', 'system']).has(request.scope)) {
      throw new Error('Package installation scope is invalid.')
    }
    if (request.scope === 'workspace') {
      if (!request.workspaceRoot?.trim() || request.workspaceRoot.includes('\0')) {
        throw new Error('Workspace-scoped package installation requires a workspace root.')
      }
    } else if (request.workspaceRoot !== undefined) {
      throw new Error('Only workspace-scoped packages may use a workspace root.')
    }
    if (!Array.isArray(item.sources) || item.sources.length === 0 || item.sources.length > 64 ||
        !Array.isArray(item.components) || item.components.length > 128 ||
        !Array.isArray(item.permissions) || item.permissions.length > 128 ||
        !Array.isArray(item.licenseEvidence) || item.licenseEvidence.length > 64) {
      throw new Error('Package installation metadata exceeds its safety limits.')
    }
    if (!CONTENT_SHA256.test(request.expectedContentSha256)) {
      throw new Error('Expected package content SHA-256 is invalid.')
    }
    if (!CONTENT_SHA256.test(request.reviewSha256) ||
        marketplacePackageReviewSha256(item) !== request.reviewSha256.toLowerCase()) {
      throw new Error('Package review is stale; permissions and provenance must be reviewed again.')
    }
    if (item.availability.status !== 'available' || !isCatalogInstallable(item)) {
      throw new Error('Package is not available for a direct RailWise AI installation.')
    }
    if (evaluateMarketplaceLicense(item.license).disposition !== 'direct-mirror' && !isApprovedUpstreamPackage(item)) {
      throw new Error('Package license is not approved for direct installation.')
    }
    if (item.version.trim().toLowerCase() === 'latest') {
      throw new Error('Mutable latest package versions are not allowed.')
    }
    for (const source of item.sources) {
      if ((source.kind === 'npm' || source.kind === 'pypi') &&
          (source.version.toLowerCase() === 'latest' || source.resolvedRef.toLowerCase() === 'latest')) {
        throw new Error('Mutable latest artifact versions are not allowed.')
      }
      if ((source.kind === 'github' || source.kind === 'git') &&
          !IMMUTABLE_COMMIT.test(source.resolvedRef)) {
        throw new Error('Git package sources must use immutable commits.')
      }
    }
    const declared = new Set(item.permissions.map((permission) => permission.id))
    if (declared.size !== item.permissions.length) throw new Error('Package permissions contain duplicates.')
    const decisions = new Map<string, InstalledPackagePermissionV1>()
    for (const permission of request.permissions) {
      if (!declared.has(permission.permissionId)) throw new Error('Permission decision is not declared by the package.')
      if (decisions.has(permission.permissionId)) throw new Error('Permission decisions contain duplicates.')
      if (permission.decision !== 'granted' && permission.decision !== 'denied') {
        throw new Error('Permission decision is invalid.')
      }
      decisions.set(permission.permissionId, permission)
    }
    if (decisions.size !== declared.size) throw new Error('Every package permission must be reviewed.')
  }

  private assertLicenseFiles(item: MarketplacePackageV1, paths: string[]): void {
    const installedPaths = new Set(paths)
    const requiredEvidence = item.licenseEvidence.filter((evidence) => evidence.required)
    if (requiredEvidence.length > 0) {
      for (const evidence of requiredEvidence) {
        const path = normalizePackagePath(evidence.path, 'License evidence path')
        if (!installedPaths.has(path)) throw new Error(`Required license evidence is missing: ${path}.`)
      }
      return
    }
    if (!paths.some(isLicensePath) && !isApprovedAutocadUpstreamSkill(item)) {
      throw new Error('Direct installations must preserve a LICENSE, NOTICE, or COPYING file.')
    }
  }

  private async checkHealth(
    packageId: string,
    version: string,
    location: string
  ): Promise<PackageHealthV1> {
    if (!this.healthCheck) return { status: 'unknown' }
    const health = await this.healthCheck({ packageId, version, location })
    if (!new Set(['healthy', 'degraded', 'unhealthy', 'unknown']).has(health.status)) {
      throw new Error('Package health check returned an invalid status.')
    }
    return clone(health)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.rootDirectory)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Package installation root must be a real directory.')
    }
    for (const child of ['packages', 'staging']) {
      const path = join(this.rootDirectory, child)
      await mkdir(path, { recursive: true, mode: 0o700 })
      const childInfo = await lstat(path)
      const childReal = await realpath(path)
      const rootReal = await realpath(this.rootDirectory)
      if (childInfo.isSymbolicLink() || !childInfo.isDirectory() ||
          !isCanonicalPathContained(rootReal, childReal)) {
        throw new Error(`Package installation ${child} directory is unsafe.`)
      }
    }
  }

  private async assertSourceDoesNotOverlapInstallRoot(sourceDirectory: string): Promise<void> {
    const source = await realpath(resolve(sourceDirectory))
    const installRoot = await realpath(this.rootDirectory)
    if (isCanonicalPathContained(source, installRoot) ||
        isCanonicalPathContained(installRoot, source)) {
      throw new Error('Package source must not overlap the installation root.')
    }
  }

  private async removeContainedDirectory(path: string): Promise<void> {
    if (!isCanonicalPathContained(this.rootDirectory, path) ||
        resolve(path) === resolve(this.rootDirectory)) {
      throw new Error('Package cleanup path escapes the installation root.')
    }
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Package cleanup target must be a real directory.')
    }
    const rootReal = await realpath(this.rootDirectory)
    const targetReal = await realpath(path)
    if (!isCanonicalPathContained(rootReal, targetReal)) {
      throw new Error('Package cleanup target escapes the installation root.')
    }
    await recheckContainedParent(this.rootDirectory, path)
    await rm(path, { recursive: true, force: true })
  }

  private versionPath(packageId: string, sha256: string): string {
    return join(this.rootDirectory, 'packages', packageDirectoryName(packageId), 'versions', sha256)
  }

  private parseArtifact(value: unknown, packageId: string): InstalledPackageArtifactV1 {
    const artifact = requiredRecord(value, 'Installed package artifact')
    const sha256 = requiredString(artifact.sha256, 'Installed package artifact SHA-256').toLowerCase()
    const location = requiredString(artifact.location, 'Installed package artifact location')
    if (!CONTENT_SHA256.test(sha256) || location !== this.versionPath(packageId, sha256) ||
        !isCanonicalPathContained(this.rootDirectory, location)) {
      throw new Error('Installed package artifact location or SHA-256 is invalid.')
    }
    if (!Number.isInteger(artifact.fileCount) || Number(artifact.fileCount) < 1 ||
        !Number.isInteger(artifact.totalBytes) || Number(artifact.totalBytes) < 0) {
      throw new Error('Installed package artifact size metadata is invalid.')
    }
    return {
      sha256,
      location,
      fileCount: Number(artifact.fileCount),
      totalBytes: Number(artifact.totalBytes)
    }
  }

  private parseStoredPackage(value: unknown): StoredInstalledPackageV1 {
    const item = requiredRecord(value, 'Installed package record')
    const packageId = boundedString(item.packageId, 'Installed package ID')
    if (item.schemaVersion !== 1 || !Array.isArray(item.sources) || !Array.isArray(item.components) ||
        !Array.isArray(item.permissions)) {
      throw new Error('Installed package record is invalid.')
    }
    boundedString(item.version, 'Installed package version')
    if (item.license !== null && typeof item.license !== 'string') {
      throw new Error('Installed package license is invalid.')
    }
    const reviewSha256 = requiredString(item.reviewSha256, 'Installed package review SHA-256')
    if (!CONTENT_SHA256.test(reviewSha256)) throw new Error('Installed package review SHA-256 is invalid.')
    requiredRecord(item.source, 'Installed package source')
    requiredRecord(item.timestamps, 'Installed package timestamps')
    requiredRecord(item.updatePolicy, 'Installed package update policy')
    requiredRecord(item.health, 'Installed package health')
    if (!new Set(['user', 'workspace', 'team', 'system']).has(String(item.scope))) {
      throw new Error('Installed package scope is invalid.')
    }
    if ((item.scope === 'workspace' &&
        (typeof item.workspaceRoot !== 'string' || resolve(item.workspaceRoot) !== item.workspaceRoot)) ||
        (item.scope !== 'workspace' && item.workspaceRoot !== undefined)) {
      throw new Error('Installed package workspace root is invalid.')
    }
    let reviewedPackage: MarketplacePackageV1 | undefined
    if (item.reviewedPackage !== undefined) {
      const value = requiredRecord(item.reviewedPackage, 'Installed reviewed package metadata')
      reviewedPackage = clone(value as unknown as MarketplacePackageV1)
      if (marketplacePackageReviewSha256(reviewedPackage) !== reviewSha256.toLowerCase() ||
          reviewedPackage.id !== packageId || reviewedPackage.version !== item.version ||
          reviewedPackage.source?.id !== (item.source as { id?: unknown }).id) {
        throw new Error('Installed reviewed package metadata is invalid.')
      }
    }
    return clone({
      ...item,
      ...(reviewedPackage ? { reviewedPackage } : {}),
      artifact: this.parseArtifact(item.artifact, packageId)
    } as unknown as StoredInstalledPackageV1)
  }

  private async readManifest(): Promise<InstallationManifestV1> {
    let text: string
    try {
      text = await readRecoveredFile(this.manifestPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest()
      throw error
    }
    if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) {
      throw new Error('Installed package manifest exceeds the 8 MiB limit.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('Installed package manifest is malformed.')
    }
    const manifest = requiredRecord(parsed, 'Installed package manifest')
    if (manifest.schema !== INSTALL_MANIFEST_SCHEMA || manifest.version !== INSTALL_MANIFEST_VERSION ||
        !Number.isInteger(manifest.revision) || !Array.isArray(manifest.records)) {
      throw new Error('Installed package manifest is invalid.')
    }
    if (manifest.records.length > MAX_INSTALLED_PACKAGES) {
      throw new Error('Installed package manifest exceeds the package limit.')
    }
    const packageIds = new Set<string>()
    const records = manifest.records.map((value) => {
      const record = requiredRecord(value, 'Installed package history')
      const current = this.parseStoredPackage(record.current)
      if (packageIds.has(current.packageId)) throw new Error('Installed package manifest contains duplicates.')
      packageIds.add(current.packageId)
      const rollback = record.rollback === undefined
        ? undefined
        : this.parseStoredPackage(record.rollback)
      if (rollback && rollback.packageId !== current.packageId) {
        throw new Error('Installed package rollback belongs to another package.')
      }
      return { current, ...(rollback ? { rollback } : {}) }
    })
    const rawMutations = requiredRecord(manifest.mutationKeys ?? {}, 'Installed package mutations')
    if (Object.keys(rawMutations).length > MAX_MUTATION_KEYS) {
      throw new Error('Installed package manifest exceeds the mutation limit.')
    }
    const mutationKeys: Record<string, InstallationMutationV1> = {}
    for (const [key, value] of Object.entries(rawMutations)) {
      mutationKey(key)
      const mutation = requiredRecord(value, 'Installed package mutation')
      const action = mutation.action
      if (action !== 'install' && action !== 'rollback' && action !== 'permissions') {
        throw new Error('Package mutation action is invalid.')
      }
      mutationKeys[key] = {
        packageId: boundedString(mutation.packageId, 'Package mutation ID'),
        action,
        version: boundedString(mutation.version, 'Package mutation version')
      }
    }
    return {
      schema: INSTALL_MANIFEST_SCHEMA,
      version: INSTALL_MANIFEST_VERSION,
      revision: Number(manifest.revision),
      records,
      mutationKeys
    }
  }

  private async persistManifest(manifest: InstallationManifestV1): Promise<void> {
    await this.beforePersistManifest?.(clone(manifest))
    await atomicWriteFile(this.manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }

  private recordMutation(
    manifest: InstallationManifestV1,
    key: string,
    mutation: InstallationMutationV1
  ): void {
    const entries = [...Object.entries(manifest.mutationKeys), [key, mutation] as const]
      .slice(-MAX_MUTATION_KEYS)
    manifest.mutationKeys = Object.fromEntries(entries)
  }

  private async findMutation(key: string): Promise<InstallationMutationV1 | undefined> {
    return runSerialized(this.manifestQueue(), async () => {
      const manifest = await this.readManifest()
      return clone(manifest.mutationKeys[key])
    })
  }

  private replayInstall(
    mutation: InstallationMutationV1,
    packageId: string,
    version: string
  ): Promise<InstalledPackageV1> {
    return runSerialized(this.manifestQueue(), async () => {
      const manifest = await this.readManifest()
      return this.replayInstallFromManifest(manifest, mutation, packageId, version)
    })
  }

  private replayInstallFromManifest(
    manifest: InstallationManifestV1,
    mutation: InstallationMutationV1,
    packageId: string,
    version: string
  ): InstalledPackageV1 {
    if (mutation.packageId !== packageId || mutation.action !== 'install' || mutation.version !== version) {
      throw new Error('Idempotency key was already used for another package mutation.')
    }
    const record = manifest.records.find((item) => item.current.packageId === packageId)
    if (!record || record.current.version !== version) {
      throw new Error('Idempotent installation result is no longer available.')
    }
    return installedPackage(record)
  }

  private async assertExpectedVersion(
    packageId: string,
    expected: string | null,
    nextVersion: string
  ): Promise<void> {
    await runSerialized(this.manifestQueue(), async () => {
      const current = (await this.readManifest()).records.find((item) =>
        item.current.packageId === packageId
      )?.current.version ?? null
      this.assertCurrentVersion(current, expected)
      if (current === nextVersion) {
        throw new Error('An installed package version is immutable and cannot be replaced in place.')
      }
    })
  }

  private assertCurrentVersion(current: string | null, expected: string | null): void {
    if (current !== expected) throw new Error('Installed package version changed before activation.')
  }

  private packageQueue(packageId: string): string {
    return `package-install:${this.rootDirectory}:${packageId}`
  }

  private manifestQueue(): string {
    return `package-install-manifest:${this.rootDirectory}`
  }
}
