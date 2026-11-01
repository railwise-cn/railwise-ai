import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  InstalledPackagePermissionV1,
  InstalledPackageV1,
  MarketplacePackageV1,
  PreparedPluginImportV1,
  PluginUpdateDiagnosticV1
} from '../../shared/marketplace'
import { isCanonicalPathContained } from './canonical-containment'
import {
  PackageInstallationService,
  inspectPackageDirectory,
  marketplacePackagePermissionUpdateIdentity,
  marketplacePackageReviewSha256,
  classifyMarketplacePackageDrift,
  packageInstallLimitsFor,
  stagePackageDirectory,
  type UpdatePackagePermissionsRequestV1
} from './package-installation-service'
import { extractPluginArchive, PLUGIN_ARCHIVE_LIMITS } from './plugin-archive-security'
import {
  installPreparedPluginPackage,
  parsePreparedPluginDirectory,
  preparePluginArchive,
  type PluginPackageFormatV1,
  type PreparedPluginPackageV1,
  type TrustedPluginSigningKeyV1
} from './plugin-package-formats'
import { materializePypiPackage } from './pypi-package-materializer'
import { describeNetworkFailure, systemFetch } from './system-network'
import { parseCatalogPackageArtifact } from './marketplace-catalog-service'
import {
  marketplaceCommandEnvironment,
  resolveMarketplaceCommand
} from './marketplace-command'

const PREPARED_IMPORT_TTL_MS = 30 * 60_000
const MAX_CATALOG_ARTIFACT_BYTES = 10 * 1024 * 1024
const UUID_DIRECTORY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const execFileAsync = promisify(execFile)
const EXEC_MAX_BUFFER = 8 * 1024 * 1024
const MAX_GITHUB_ARCHIVE_BYTES = PLUGIN_ARCHIVE_LIMITS.maxArchiveBytes

export type PreparePluginImportRequestV1 = {
  sourcePath: string
  format?: PluginPackageFormatV1
  catalogSourceId?: string
}

export type InstallPluginImportRequestV1 = {
  preparedId: string
  reviewSha256: string
  expectedCurrentVersion: string | null
  scope: InstalledPackageV1['scope']
  workspaceRoot?: string
  permissions: InstalledPackagePermissionV1[]
  idempotencyKey: string
}

type PreparedRecord = {
  value: PreparedPluginPackageV1
  publicValue: PreparedPluginImportV1
  expiresAtMs: number
}

export type PluginManagementServiceOptions = {
  rootDirectory?: string
  installationService?: PackageInstallationService
  trustedSigningKeys?: TrustedPluginSigningKeyV1[]
  catalogMaterializer?: (item: MarketplacePackageV1, targetDirectory: string) => Promise<void>
  now?: () => Date
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(label + ' is required.')
  }
  return value.trim()
}

function rethrowAfterCompensation(
  error: unknown,
  compensationErrors: unknown[],
  message: string
): never {
  if (compensationErrors.length > 0) {
    throw new AggregateError([error, ...compensationErrors], message)
  }
  throw error
}

export class PluginManagementService {
  private readonly rootDirectory: string
  private readonly stagingDirectory: string
  private readonly installationService: PackageInstallationService
  private readonly trustedSigningKeys: TrustedPluginSigningKeyV1[]
  private readonly catalogMaterializer: (
    item: MarketplacePackageV1,
    targetDirectory: string
  ) => Promise<void>
  private readonly now: () => Date
  private readonly prepared = new Map<string, PreparedRecord>()
  private stagingInitialized = false

  constructor(options: PluginManagementServiceOptions = {}) {
    this.rootDirectory = resolve(options.rootDirectory ?? join(homedir(), '.workwise', 'marketplace', 'imports'))
    this.stagingDirectory = join(this.rootDirectory, 'staging')
    this.installationService = options.installationService ?? new PackageInstallationService()
    this.trustedSigningKeys = options.trustedSigningKeys ?? []
    this.catalogMaterializer = options.catalogMaterializer ?? materializeCatalogPackage
    this.now = options.now ?? (() => new Date())
  }

  listInstalled(): Promise<InstalledPackageV1[]> {
    return this.installationService.list()
  }

  async diagnoseUpdates(packages: MarketplacePackageV1[]): Promise<PluginUpdateDiagnosticV1[]> {
    const installed = await this.installationService.list()
    const byId = new Map(packages.map((item) => [item.id, item]))
    const diagnostics: PluginUpdateDiagnosticV1[] = []
    for (const record of installed) {
      const item = byId.get(record.packageId)
      if (!item || item.source.id !== record.source.id || item.availability.status !== 'available') {
        diagnostics.push({
          packageId: record.packageId,
          installedVersion: record.version,
          state: 'unavailable',
          message: 'The installed package is not available from its current catalog source.'
        })
        continue
      }
      if (item.version !== record.version) {
        diagnostics.push({
          packageId: record.packageId,
          installedVersion: record.version,
          catalogVersion: item.version,
          state: 'update-available',
          message: 'A newer package version is available.'
        })
        continue
      }
      if (marketplacePackageReviewSha256(item) === record.reviewSha256) {
        diagnostics.push({
          packageId: record.packageId,
          installedVersion: record.version,
          catalogVersion: item.version,
          state: 'current',
          message: 'The installed package matches the current catalog review.'
        })
        continue
      }
      let reviewed: MarketplacePackageV1
      try {
        reviewed = await this.reviewedPackageFor(record)
      } catch {
        diagnostics.push({ packageId: record.packageId, installedVersion: record.version,
          catalogVersion: item.version, state: 'runtime-drift',
          message: 'Installed review metadata cannot be verified. A complete update is required.' })
        continue
      }
      const drift = classifyMarketplacePackageDrift(reviewed, item)
      diagnostics.push({
        packageId: record.packageId,
        installedVersion: record.version,
        catalogVersion: item.version,
        state: drift === 'metadata-refresh' ? 'metadata-refresh' : 'runtime-drift',
        message: drift === 'metadata-refresh'
          ? 'Catalog metadata changed and can be refreshed after review.'
          : 'Runtime or provenance metadata changed without a package version update.'
      })
    }
    return diagnostics.sort((left, right) => left.packageId.localeCompare(right.packageId))
  }

  async prepareCatalogPackage(item: MarketplacePackageV1): Promise<PreparedPluginImportV1> {
    await this.cleanupExpired()
    if (item.availability.status !== 'available' || item.installation.mode !== 'direct-mirror') {
      throw new Error('Catalog package is not eligible for direct installation.')
    }
    const targetDirectory = join(await this.ensureStagingRoot(), randomUUID())
    try {
      await this.catalogMaterializer(clone(item), targetDirectory)
      await writeFile(
        join(targetDirectory, 'workwise.catalog.json'),
        `${JSON.stringify(item, null, 2)}\n`,
        { mode: 0o600 }
      )
      const inspection = await inspectPackageDirectory(
        targetDirectory,
        packageInstallLimitsFor(item)
      )
      const value: PreparedPluginPackageV1 = {
        schemaVersion: 1,
        format: 'catalog',
        package: clone(item),
        preparedDirectory: targetDirectory,
        contentSha256: inspection.sha256,
        reviewSha256: marketplacePackageReviewSha256(item),
        warnings: [],
        compatibility: {
          workwiseCompatible:
            item.compatibility.platforms.includes(process.platform as 'darwin' | 'win32' | 'linux') &&
            item.compatibility.architectures.includes(process.arch as 'arm64' | 'x64'),
          reasons: []
        }
      }
      if (!value.compatibility.workwiseCompatible) {
        value.compatibility.reasons.push('This package does not support the current platform or architecture.')
      }
      return this.registerPrepared(value)
    } catch (error) {
      await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async prepareImport(request: PreparePluginImportRequestV1): Promise<PreparedPluginImportV1> {
    await this.cleanupExpired()
    const sourcePath = resolve(requiredString(request.sourcePath, 'Plugin import source path'))
    const stagingRoot = await this.ensureStagingRoot()
    const lexical = await lstat(sourcePath)
    if (lexical.isSymbolicLink() || (!lexical.isFile() && !lexical.isDirectory())) {
      throw new Error('Plugin import source must be a regular file or directory, not a link.')
    }
    const canonicalSource = await realpath(sourcePath)
    if (isCanonicalPathContained(stagingRoot, canonicalSource)) {
      throw new Error('Plugin import source cannot be inside the private staging directory.')
    }
    const targetDirectory = join(stagingRoot, randomUUID())
    const catalogSourceId = request.catalogSourceId?.trim() || 'workwise-imports'
    let value: PreparedPluginPackageV1
    if (lexical.isDirectory()) {
      await stagePackageDirectory(canonicalSource, targetDirectory)
      try {
        value = await parsePreparedPluginDirectory({
          directory: targetDirectory,
          format: request.format,
          catalogSourceId,
          sourceLocation: canonicalSource,
          sourceKind: 'local',
          trustedSigningKeys: this.trustedSigningKeys
        })
      } catch (error) {
        await rm(targetDirectory, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    } else {
      value = await preparePluginArchive({
        archive: await this.readArchive(canonicalSource, lexical),
        targetDirectory,
        format: request.format,
        catalogSourceId,
        sourceLocation: canonicalSource,
        sourceKind: 'local',
        trustedSigningKeys: this.trustedSigningKeys
      })
    }
    return this.registerPrepared(value)
  }

  async installPrepared(
    request: InstallPluginImportRequestV1,
    afterInstall?: (installed: InstalledPackageV1, item: MarketplacePackageV1) => Promise<void>
  ): Promise<InstalledPackageV1> {
    await this.cleanupExpired()
    const preparedId = requiredString(request.preparedId, 'Prepared plugin ID')
    const current = this.prepared.get(preparedId)
    if (!current) throw new Error('Prepared plugin import was not found or has expired.')
    if (request.reviewSha256.toLowerCase() !== current.value.reviewSha256) {
      throw new Error('Prepared plugin review changed; review the package again before installation.')
    }
    const installed = await installPreparedPluginPackage(
      this.installationService,
      current.value,
      {
        expectedCurrentVersion: request.expectedCurrentVersion,
        scope: request.scope,
        workspaceRoot: request.workspaceRoot,
        permissions: request.permissions,
        idempotencyKey: request.idempotencyKey
      }
    )
    try {
      await afterInstall?.(installed, clone(current.value.package))
    } catch (error) {
      const compensationErrors: unknown[] = []
      try {
        await this.installationService.compensateFailedInstall({
          packageId: installed.packageId,
          failedVersion: installed.version,
          failedReviewSha256: installed.reviewSha256,
          failedArtifactSha256: installed.artifact.sha256,
          installIdempotencyKey: request.idempotencyKey
        })
      } catch (failedCompensation) {
        compensationErrors.push(failedCompensation)
      }
      rethrowAfterCompensation(
        error,
        compensationErrors,
        'Plugin activation failed and its installation compensation was incomplete.'
      )
    }
    this.prepared.delete(preparedId)
    await rm(current.value.preparedDirectory, { recursive: true, force: true }).catch(() => undefined)
    return installed
  }

  async cancelPrepared(preparedId: string): Promise<boolean> {
    const id = requiredString(preparedId, 'Prepared plugin ID')
    const current = this.prepared.get(id)
    if (!current) return false
    this.prepared.delete(id)
    await rm(current.value.preparedDirectory, { recursive: true, force: true }).catch(() => undefined)
    return true
  }

  async rollback(request: {
    packageId: string
    expectedCurrentVersion: string
    idempotencyKey: string
  }, afterRollback?: (
    installed: InstalledPackageV1,
    item: MarketplacePackageV1
  ) => Promise<void>): Promise<InstalledPackageV1> {
    const installed = await this.installationService.rollback(request)
    try {
      const item = await this.reviewedPackageFor(installed)
      await afterRollback?.(installed, item)
    } catch (error) {
      const compensationErrors: unknown[] = []
      try {
        await this.installationService.rollback({
          packageId: installed.packageId,
          expectedCurrentVersion: installed.version,
          idempotencyKey: `rollback-compensation:${randomUUID()}`
        })
      } catch (failedCompensation) {
        compensationErrors.push(failedCompensation)
      }
      rethrowAfterCompensation(
        error,
        compensationErrors,
        'Plugin rollback activation failed and its manifest compensation was incomplete.'
      )
    }
    return installed
  }

  async updatePermissions(
    item: MarketplacePackageV1,
    request: Omit<UpdatePackagePermissionsRequestV1, 'declaredPermissionIds' | 'package'>,
    afterUpdate?: (installed: InstalledPackageV1, item: MarketplacePackageV1) => Promise<void>
  ): Promise<InstalledPackageV1> {
    const current = await this.installationService.get(request.packageId)
    if (!current) throw new Error('Package is not installed.')
    if (item.id !== current.packageId || item.version !== current.version ||
        item.source.id !== current.source.id) {
      throw new Error('Package metadata does not match the installed package.')
    }
    const reviewSha256 = marketplacePackageReviewSha256(item)
    if (request.reviewSha256.toLowerCase() !== reviewSha256) {
      throw new Error('Package review is stale; review the package again.')
    }
    const previous = await this.reviewedPackageFor(current)
    if (marketplacePackagePermissionUpdateIdentity(previous) !==
        marketplacePackagePermissionUpdateIdentity(item)) {
      throw new Error('Package runtime metadata changed without a version update.')
    }
    const installed = await this.installationService.updatePermissions({
      ...request,
      package: clone(item),
      reviewSha256,
      declaredPermissionIds: item.permissions.map((permission) => permission.id)
    })
    try {
      await afterUpdate?.(installed, clone(item))
    } catch (error) {
      const compensationErrors: unknown[] = []
      try {
        await this.installationService.updatePermissions({
          package: previous,
          packageId: current.packageId,
          expectedCurrentVersion: current.version,
          reviewSha256: current.reviewSha256,
          ...(current.workspaceRoot ? { workspaceRoot: current.workspaceRoot } : {}),
          declaredPermissionIds: previous.permissions.map((permission) => permission.id),
          permissions: current.permissions,
          idempotencyKey: `permission-compensation:${randomUUID()}`
        })
      } catch (failedCompensation) {
        compensationErrors.push(failedCompensation)
      }
      rethrowAfterCompensation(
        error,
        compensationErrors,
        'Plugin permission activation failed and its manifest compensation was incomplete.'
      )
    }
    return installed
  }

  private async readArchive(path: string, initial: Awaited<ReturnType<typeof lstat>>): Promise<Buffer> {
    if (initial.size > PLUGIN_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new Error('Plugin archive exceeds the 64 MiB download limit.')
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino ||
          before.size !== initial.size) {
        throw new Error('Plugin archive changed before it could be read.')
      }
      const bytes = await handle.readFile()
      const after = await handle.stat()
      const current = await lstat(path)
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
          after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
          current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) {
        throw new Error('Plugin archive changed while it was read.')
      }
      return bytes
    } finally {
      await handle.close()
    }
  }

  private async restoreReviewedPackage(installed: InstalledPackageV1): Promise<MarketplacePackageV1> {
    const catalogPath = join(installed.artifact.location, 'workwise.catalog.json')
    let item: MarketplacePackageV1
    try {
      const initial = await lstat(catalogPath)
      if (initial.isSymbolicLink() || !initial.isFile() || initial.size > MAX_CATALOG_ARTIFACT_BYTES) {
        throw new Error('Installed catalog metadata is invalid or exceeds 10 MiB.')
      }
      const handle = await open(catalogPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = await handle.stat()
        if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino ||
            before.size !== initial.size) {
          throw new Error('Installed catalog metadata changed before it could be read.')
        }
        const bytes = await handle.readFile()
        const after = await handle.stat()
        const current = await lstat(catalogPath)
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino ||
            after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
            current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) {
          throw new Error('Installed catalog metadata changed while it was read.')
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(bytes.toString('utf8'))
        } catch {
          throw new Error('Installed catalog metadata is malformed.')
        }
        item = parseCatalogPackageArtifact(parsed, installed.source.catalogSourceId)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const sourceKind = installed.source.kind
      if (sourceKind !== 'local' && sourceKind !== 'project' && sourceKind !== 'https') {
        throw new Error('Installed plugin does not contain recoverable reviewed metadata.')
      }
      const prepared = await parsePreparedPluginDirectory({
        directory: installed.artifact.location,
        catalogSourceId: installed.source.catalogSourceId,
        sourceLocation: installed.source.location,
        sourceKind,
        ...(installed.source.digest?.algorithm === 'sha256'
          ? { archiveSha256: installed.source.digest.value }
          : {}),
        trustedSigningKeys: this.trustedSigningKeys
      })
      item = prepared.package
    }

    if (item.id !== installed.packageId || item.version !== installed.version ||
        item.source.id !== installed.source.id || item.license !== installed.license ||
        marketplacePackageReviewSha256(item) !== installed.reviewSha256) {
      throw new Error('Rollback package metadata does not match its reviewed installation record.')
    }
    return item
  }

  private async reviewedPackageFor(installed: InstalledPackageV1): Promise<MarketplacePackageV1> {
    const persisted = await this.installationService.getReviewedPackage(installed.packageId)
    if (persisted) {
      if (persisted.id !== installed.packageId || persisted.version !== installed.version ||
          marketplacePackageReviewSha256(persisted) !== installed.reviewSha256) {
        throw new Error('Installed reviewed package metadata is inconsistent.')
      }
      return persisted
    }
    return this.restoreReviewedPackage(installed)
  }

  private async cleanupExpired(): Promise<void> {
    const now = this.now().getTime()
    const expired = [...this.prepared.entries()].filter(([, value]) => value.expiresAtMs <= now)
    for (const [id, value] of expired) {
      this.prepared.delete(id)
      await rm(value.value.preparedDirectory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private registerPrepared(value: PreparedPluginPackageV1): PreparedPluginImportV1 {
    const id = randomUUID()
    const createdAt = this.now()
    const expiresAtMs = createdAt.getTime() + PREPARED_IMPORT_TTL_MS
    const publicValue: PreparedPluginImportV1 = {
      schemaVersion: 1,
      id,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      format: value.format,
      package: clone(value.package),
      ...(value.archiveSha256 ? { archiveSha256: value.archiveSha256 } : {}),
      contentSha256: value.contentSha256,
      reviewSha256: value.reviewSha256,
      warnings: [...value.warnings],
      compatibility: clone(value.compatibility)
    }
    this.prepared.set(id, { value, publicValue, expiresAtMs })
    return clone(publicValue)
  }

  private async ensureStagingRoot(): Promise<string> {
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 })
    const lexical = await lstat(this.stagingDirectory)
    if (lexical.isSymbolicLink() || !lexical.isDirectory()) {
      throw new Error('Plugin staging root must be a real directory.')
    }
    const canonical = await realpath(this.stagingDirectory)
    if (!this.stagingInitialized) {
      const cutoff = this.now().getTime() - PREPARED_IMPORT_TTL_MS
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if (!UUID_DIRECTORY.test(entry.name)) continue
        const path = join(canonical, entry.name)
        const info = await lstat(path)
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || info.mtimeMs <= cutoff) {
          await rm(path, { recursive: info.isDirectory() && !info.isSymbolicLink(), force: true })
        }
      }
      this.stagingInitialized = true
    }
    return canonical
  }
}

async function command(
  executable: string,
  args: string[],
  options: { cwd?: string } = {}
): Promise<string> {
  const result = await execFileAsync(resolveMarketplaceCommand(executable), args, {
    ...options,
    env: marketplaceCommandEnvironment(),
    encoding: 'utf8',
    maxBuffer: EXEC_MAX_BUFFER,
    timeout: 10 * 60_000,
    windowsHide: true
  })
  return result.stdout
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code !== 'ENOENT')
  }
}

async function copyLicense(sourceDirectory: string, targetDirectory: string): Promise<void> {
  const names = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'NOTICE', 'NOTICE.md', 'COPYING']
  if (await Promise.all(names.map((name) => exists(join(targetDirectory, name)))).then((values) => values.some(Boolean))) {
    return
  }
  for (const name of names) {
    const source = join(sourceDirectory, name)
    if (!await exists(source)) continue
    await copyFile(source, join(targetDirectory, name))
    return
  }
  throw new Error('Catalog package does not preserve a LICENSE, NOTICE, or COPYING file.')
}

function packageDirectory(root: string, packageName: string): string {
  const segments = packageName.split('/').filter(Boolean)
  return join(root, 'node_modules', ...segments)
}

async function materializeNpmPackage(
  item: MarketplacePackageV1,
  targetDirectory: string
): Promise<void> {
  const source = item.source
  if (source.kind !== 'npm' || source.digest.algorithm !== 'sha512-sri') {
    throw new Error('Catalog npm package metadata is incomplete.')
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const spec = `${source.packageName}@${source.version}`
  const integrityOutput = await command(npm, ['view', spec, 'dist.integrity', '--json'])
  let integrity = integrityOutput.trim()
  try {
    const parsed = JSON.parse(integrity) as unknown
    if (typeof parsed === 'string') integrity = parsed
  } catch {
    // npm may return the bare integrity value depending on its version.
  }
  if (integrity !== source.digest.value) {
    throw new Error('npm registry integrity does not match the trusted catalog snapshot.')
  }

  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(targetDirectory, 'package.json'), `${JSON.stringify({
    name: `workwise-managed-${item.id}`,
    version: '1.0.0',
    private: true
  }, null, 2)}\n`, { mode: 0o600 })
  await command(npm, [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    '--package-lock=true',
    spec
  ], { cwd: targetDirectory })
  await rm(join(targetDirectory, 'node_modules', '.bin'), { recursive: true, force: true })
  const installedPackageRoot = packageDirectory(targetDirectory, source.packageName)
  if (item.components.some((component) => component.type === 'skill')) {
    const skillSource = join(installedPackageRoot, 'skills')
    if (!await exists(skillSource)) {
      throw new Error('Catalog npm package declares Skills but does not contain a skills directory.')
    }
    await stagePackageDirectory(skillSource, join(targetDirectory, 'skills'))
  }
  await copyLicense(installedPackageRoot, targetDirectory)
}

async function materializeGithubPackage(
  item: MarketplacePackageV1,
  targetDirectory: string
): Promise<void> {
  const source = item.source
  if (source.kind !== 'github' || !/^[0-9a-f]{40}$/i.test(source.resolvedRef)) {
    throw new Error('Catalog GitHub package must use an immutable commit.')
  }
  const repository = `https://github.com/${source.owner}/${source.repository}.git`
  // GUI Electron processes do not inherit the interactive shell's proxy. Prefer
  // Chromium's network stack in the packaged app, while keeping the git path for
  // CLI/tests and as a fallback when codeload is unavailable.
  if (process.versions.electron) {
    try {
      await materializeGithubArchive(
        source.owner,
        source.repository,
        source.resolvedRef,
        targetDirectory,
        source.subpath
      )
      return
    } catch (error) {
      if (!isGithubNetworkFailure(error)) throw error
    }
  }
  try {
    await command('git', ['clone', '--filter=blob:none', '--no-checkout', repository, targetDirectory])
  } catch (error) {
    if (!isGithubNetworkFailure(error)) throw error
    await rm(targetDirectory, { recursive: true, force: true })
    await materializeGithubArchive(
      source.owner,
      source.repository,
      source.resolvedRef,
      targetDirectory,
      source.subpath
    )
    return
  }
  try {
    await command('git', ['fetch', '--depth=1', 'origin', source.resolvedRef], { cwd: targetDirectory })
    await command('git', ['checkout', '--detach', source.resolvedRef], { cwd: targetDirectory })
    const head = (await command('git', ['rev-parse', 'HEAD'], { cwd: targetDirectory })).trim()
    if (head.toLowerCase() !== source.resolvedRef.toLowerCase()) {
      throw new Error('GitHub checkout does not match the trusted catalog commit.')
    }
    await rm(join(targetDirectory, '.git'), { recursive: true, force: true })
    if (source.subpath) {
      const payload = `${targetDirectory}.payload`
      const selected = resolve(targetDirectory, source.subpath)
      if (!isCanonicalPathContained(targetDirectory, selected)) {
        throw new Error('Catalog package subpath escapes its repository.')
      }
      await stagePackageDirectory(selected, payload)
      await copyLicense(targetDirectory, payload)
      await rm(targetDirectory, { recursive: true, force: true })
      await rename(payload, targetDirectory)
    } else {
      await copyLicense(targetDirectory, targetDirectory)
    }
  } catch (error) {
    await rm(`${targetDirectory}.payload`, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function isGithubNetworkFailure(error: unknown): boolean {
  const value = error as { message?: unknown; stderr?: unknown; cause?: { message?: unknown } }
  const detail = [value?.message, value?.stderr, value?.cause?.message]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
  return /unable to access|could not resolve host|failed to connect|connection timed out|connection reset|network is unreachable|connection refused|operation timed out|fetch failed|archive download failed \((?:408|429|5\d\d)\)/i.test(detail)
}

async function downloadGithubArchive(owner: string, repository: string, commit: string): Promise<Buffer> {
  const url = `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/zip/${encodeURIComponent(commit)}`
  let response: Response
  try {
    response = await systemFetch(url, {
      headers: {
        Accept: 'application/zip',
        'User-Agent': 'RailWise AI'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    throw new Error(describeNetworkFailure(error, `GitHub (${owner}/${repository})`), { cause: error })
  }
  if (!response.ok) throw new Error(`GitHub archive download failed (${response.status}).`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_GITHUB_ARCHIVE_BYTES) {
    throw new Error(`GitHub archive exceeds the ${Math.floor(MAX_GITHUB_ARCHIVE_BYTES / (1024 * 1024))} MiB limit.`)
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_GITHUB_ARCHIVE_BYTES) {
      throw new Error(`GitHub archive exceeds the ${Math.floor(MAX_GITHUB_ARCHIVE_BYTES / (1024 * 1024))} MiB limit.`)
    }
    return bytes
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      const chunk = Buffer.from(next.value)
      total += chunk.byteLength
      if (total > MAX_GITHUB_ARCHIVE_BYTES) {
        throw new Error(`GitHub archive exceeds the ${Math.floor(MAX_GITHUB_ARCHIVE_BYTES / (1024 * 1024))} MiB limit.`)
      }
      chunks.push(chunk)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

export async function materializeGithubArchive(
  owner: string,
  repository: string,
  commit: string,
  targetDirectory: string,
  subpath?: string
): Promise<void> {
  const archiveDirectory = `${targetDirectory}.archive`
  try {
    const archive = await downloadGithubArchive(owner, repository, commit)
    // GitHub repositories may commit internal symlinks (for example a
    // workbench demo directory). The archive extractor resolves those links
    // into regular files/directories while continuing to reject links that
    // escape the repository or create cycles.
    await extractPluginArchive(archive, archiveDirectory, { allowInternalLinks: true })
    const roots = (await readdir(archiveDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    if (roots.length !== 1) {
      throw new Error('GitHub archive must contain exactly one repository root directory.')
    }
    const repositoryRoot = join(archiveDirectory, roots[0]!.name)
    if (subpath) {
      const selected = resolve(repositoryRoot, subpath)
      if (!isCanonicalPathContained(repositoryRoot, selected)) {
        throw new Error('Catalog package subpath escapes its repository.')
      }
      await stagePackageDirectory(selected, targetDirectory)
      await copyLicense(repositoryRoot, targetDirectory)
    } else {
      await rename(repositoryRoot, targetDirectory)
      await copyLicense(targetDirectory, targetDirectory)
    }
  } finally {
    await rm(archiveDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function materializeCatalogPackage(
  item: MarketplacePackageV1,
  targetDirectory: string
): Promise<void> {
  if (await exists(targetDirectory)) throw new Error('Catalog package staging directory already exists.')
  if (item.source.kind === 'npm') {
    await materializeNpmPackage(item, targetDirectory)
    return
  }
  if (item.source.kind === 'github') {
    await materializeGithubPackage(item, targetDirectory)
    return
  }
  if (item.source.kind === 'pypi') {
    await materializePypiPackage(item, targetDirectory)
    return
  }
  throw new Error(`Catalog source kind is not directly installable: ${item.source.kind}.`)
}
