import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  InstalledPackagePermissionV1,
  MarketplacePackageV1
} from '../../shared/marketplace'
import {
  PackageInstallationService,
  MANAGED_PYPI_INSTALL_LIMITS,
  PACKAGE_INSTALL_LIMITS,
  inspectPackageDirectory,
  marketplacePackageReviewSha256,
  packageInstallLimitsFor
} from './package-installation-service'

const roots: string[] = []
const NOW = '2026-08-08T08:00:00.000Z'
const NEXT = '2026-08-08T09:00:00.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `workwise-${label}-`))
  roots.push(root)
  return root
}

function marketplacePackage(version: string, options: {
  id?: string
  license?: string | null
  permission?: boolean
} = {}): MarketplacePackageV1 {
  const id = options.id ?? 'example-plugin'
  const source = {
    id: `${id}-source`,
    catalogSourceId: 'test-catalog',
    kind: 'local' as const,
    location: '/verified/package/source'
  }
  return {
    schemaVersion: 1,
    id,
    name: 'Example plugin',
    summary: 'A package installation fixture.',
    tier: 'recommended',
    version,
    publisher: { id: 'example', name: 'Example', verified: true },
    license: options.license === undefined ? 'MIT' : options.license,
    source,
    sources: [source],
    components: [],
    permissions: options.permission === false
      ? []
      : [{
          id: 'network.connect',
          kind: 'network',
          access: 'connect',
          default: 'review',
          reviewRequired: true,
          description: 'Connect to the package service.',
          resources: ['https://example.test']
        }],
    auth: { type: 'none' },
    licenseEvidence: [],
    dependencies: [],
    updatePolicy: { strategy: 'manual', channel: 'stable', allowMajor: false },
    compatibility: {
      workwise: '>=0.3.5',
      platforms: ['darwin', 'win32', 'linux'],
      architectures: ['arm64', 'x64']
    },
    availability: { status: 'available' },
    installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
  }
}

async function packageDirectory(version: string, options: {
  license?: boolean
  executable?: boolean
} = {}): Promise<string> {
  const root = await tempRoot('package-source')
  if (options.license !== false) await writeFile(join(root, 'LICENSE'), 'MIT License\n')
  const payload = join(root, 'plugin.txt')
  await writeFile(payload, `version=${version}\n`)
  if (options.executable) await chmod(payload, 0o755)
  return root
}

function permissionDecisions(item: MarketplacePackageV1): InstalledPackagePermissionV1[] {
  return item.permissions.map((permission) => ({
    permissionId: permission.id,
    decision: 'granted'
  }))
}

function pypiMarketplacePackage(version: string): MarketplacePackageV1 {
  const item = marketplacePackage(version, { id: 'managed-python-plugin' })
  const source = {
    id: 'managed-python-source',
    catalogSourceId: 'workwise-official',
    kind: 'pypi' as const,
    location: `https://pypi.org/project/managed-python-plugin/${version}/`,
    packageName: 'managed-python-plugin',
    version,
    resolvedRef: version,
    digest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) }
  }
  return { ...item, source, sources: [source] }
}

async function deepPackageDirectory(version: string): Promise<string> {
  const root = await tempRoot('deep-python-package')
  await writeFile(join(root, 'LICENSE'), 'MIT License\n')
  let current = root
  for (let index = 0; index < PACKAGE_INSTALL_LIMITS.maxDepth + 2; index += 1) {
    current = join(current, `level-${index}`)
    await mkdir(current)
  }
  await writeFile(join(current, 'plugin.txt'), `version=${version}\n`)
  return root
}

async function install(
  service: PackageInstallationService,
  item: MarketplacePackageV1,
  sourceDirectory: string,
  expectedCurrentVersion: string | null,
  idempotencyKey: string
) {
  const inspection = await inspectPackageDirectory(sourceDirectory, packageInstallLimitsFor(item))
  return service.install({
    package: item,
    sourceDirectory,
    expectedContentSha256: inspection.sha256,
    expectedCurrentVersion,
    reviewSha256: marketplacePackageReviewSha256(item),
    scope: 'user',
    permissions: permissionDecisions(item),
    idempotencyKey
  })
}

describe('PackageInstallationService', () => {
  it('uses bounded extended limits for official managed PyPI installs and rollback', async () => {
    const installRoot = await tempRoot('managed-python-install')
    const source1 = await deepPackageDirectory('1.0.0')
    const source2 = await deepPackageDirectory('2.0.0')
    const item1 = pypiMarketplacePackage('1.0.0')
    const item2 = pypiMarketplacePackage('2.0.0')
    const service = new PackageInstallationService({ rootDirectory: installRoot })

    expect(MANAGED_PYPI_INSTALL_LIMITS.maxTotalBytes).toBeGreaterThan(PACKAGE_INSTALL_LIMITS.maxTotalBytes)
    await expect(inspectPackageDirectory(source1)).rejects.toThrow(/depth/i)
    await install(service, item1, source1, null, 'install-python-v1')
    const second = await install(service, item2, source2, '1.0.0', 'install-python-v2')
    const rolledBack = await service.rollback({
      packageId: second.packageId,
      expectedCurrentVersion: second.version,
      idempotencyKey: 'rollback-python-v2'
    })

    expect(rolledBack.version).toBe('1.0.0')
  })

  it('stages, verifies, activates, persists, and reloads an installation', async () => {
    const installRoot = await tempRoot('package-install')
    const source = await packageDirectory('1.0.0')
    const item = marketplacePackage('1.0.0')
    const service = new PackageInstallationService({
      rootDirectory: installRoot,
      now: () => new Date(NOW),
      healthCheck: async () => ({ status: 'healthy', checkedAt: NOW })
    })

    const result = await install(service, item, source, null, 'install-v1')

    expect(result).toMatchObject({
      packageId: item.id,
      version: '1.0.0',
      license: 'MIT',
      reviewSha256: marketplacePackageReviewSha256(item),
      scope: 'user',
      health: { status: 'healthy' },
      rollback: { available: false },
      permissions: [{ permissionId: 'network.connect', decision: 'granted' }]
    })
    expect(result.artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
    await expect(readFile(join(result.artifact.location, 'plugin.txt'), 'utf8'))
      .resolves.toBe('version=1.0.0\n')
    expect(await new PackageInstallationService({ rootDirectory: installRoot }).list())
      .toEqual([result])
    const persisted = await readFile(join(installRoot, 'installed.json'), 'utf8')
    expect(persisted).toContain('test-catalog')
    expect(persisted).not.toContain('version=1.0.0')
  })

  it('updates reviewed permissions atomically and replays the idempotent result', async () => {
    const installRoot = await tempRoot('permission-update')
    const source = await packageDirectory('1.0.0')
    const item = marketplacePackage('1.0.0')
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    const installed = await install(service, item, source, null, 'install-permission-update')
    const request = {
      package: item,
      packageId: item.id,
      expectedCurrentVersion: installed.version,
      reviewSha256: marketplacePackageReviewSha256(item),
      declaredPermissionIds: item.permissions.map((permission) => permission.id),
      permissions: [{ permissionId: 'network.connect', decision: 'denied' as const }],
      idempotencyKey: 'update-permission'
    }

    const updated = await service.updatePermissions(request)
    expect(updated).toMatchObject({
      version: '1.0.0',
      reviewSha256: request.reviewSha256,
      permissions: [{ permissionId: 'network.connect', decision: 'denied' }]
    })
    await expect(service.updatePermissions(request)).resolves.toEqual(updated)
    await expect(service.updatePermissions({
      ...request,
      idempotencyKey: 'unknown-permission',
      permissions: [{ permissionId: 'filesystem.write', decision: 'granted' }]
    })).rejects.toThrow(/invalid|reviewed/i)

    const expandedPermissions = {
      ...item,
      permissions: item.permissions.map((permission) => ({
        ...permission,
        resources: ['https://example.test', 'https://api.example.test']
      }))
    }
    const expandedReview = marketplacePackageReviewSha256(expandedPermissions)
    await expect(service.updatePermissions({
      ...request,
      package: expandedPermissions,
      reviewSha256: expandedReview,
      idempotencyKey: 'expanded-permission-review'
    })).resolves.toMatchObject({ reviewSha256: expandedReview })
    await expect(service.getReviewedPackage(item.id)).resolves.toEqual(expandedPermissions)
    expect(await service.list()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewedPackage: expect.anything() })
    ]))

    const compatibilityRefresh = {
      ...expandedPermissions,
      compatibility: { ...expandedPermissions.compatibility, workwise: '>=0.3.6' }
    }
    const compatibilityReview = marketplacePackageReviewSha256(compatibilityRefresh)
    await expect(service.updatePermissions({
      ...request,
      package: compatibilityRefresh,
      reviewSha256: compatibilityReview,
      idempotencyKey: 'compatibility-metadata-refresh'
    })).resolves.toMatchObject({ reviewSha256: compatibilityReview })

    const changedRuntime = {
      ...expandedPermissions,
      auth: { type: 'token' as const, provider: 'example', environmentVariables: ['EXAMPLE_TOKEN'] }
    }
    await expect(service.updatePermissions({
      ...request,
      package: changedRuntime,
      reviewSha256: marketplacePackageReviewSha256(changedRuntime),
      idempotencyKey: 'same-version-runtime-change'
    })).rejects.toThrow(/runtime metadata changed.*version/i)
  })

  it('binds workspace-scoped permission changes to the installed workspace root', async () => {
    const installRoot = await tempRoot('workspace-permissions')
    const workspaceRoot = await tempRoot('workspace-root')
    const otherWorkspace = await tempRoot('other-workspace')
    const source = await packageDirectory('1.0.0')
    const item = marketplacePackage('1.0.0')
    const inspection = await inspectPackageDirectory(source)
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    const baseRequest = {
      package: item,
      sourceDirectory: source,
      expectedContentSha256: inspection.sha256,
      expectedCurrentVersion: null,
      reviewSha256: marketplacePackageReviewSha256(item),
      scope: 'workspace' as const,
      permissions: permissionDecisions(item)
    }

    await expect(service.install({
      ...baseRequest,
      idempotencyKey: 'missing-workspace-root'
    })).rejects.toThrow(/workspace root/i)
    const installed = await service.install({
      ...baseRequest,
      workspaceRoot,
      idempotencyKey: 'workspace-install'
    })
    expect(installed.workspaceRoot).toBe(await realpath(workspaceRoot))
    const permissionRequest = {
      package: item,
      packageId: item.id,
      expectedCurrentVersion: item.version,
      reviewSha256: marketplacePackageReviewSha256(item),
      declaredPermissionIds: item.permissions.map((permission) => permission.id),
      permissions: [{ permissionId: 'network.connect', decision: 'denied' as const }]
    }
    await expect(service.updatePermissions({
      ...permissionRequest,
      workspaceRoot: otherWorkspace,
      idempotencyKey: 'wrong-workspace'
    })).rejects.toThrow(/installed workspace/i)
    await expect(service.updatePermissions({
      ...permissionRequest,
      workspaceRoot,
      idempotencyKey: 'correct-workspace'
    })).resolves.toMatchObject({ workspaceRoot: await realpath(workspaceRoot) })
  })

  it('binds content hashes to file paths, executable bits, and empty directories', async () => {
    const source = await packageDirectory('1.0.0')
    const original = await inspectPackageDirectory(source)
    await chmod(join(source, 'plugin.txt'), 0o755)
    const executable = await inspectPackageDirectory(source)
    await mkdir(join(source, 'empty'))
    const withDirectory = await inspectPackageDirectory(source)

    if (process.platform === 'win32') {
      expect(executable.sha256).toBe(original.sha256)
    } else {
      expect(executable.sha256).not.toBe(original.sha256)
    }
    expect(withDirectory.sha256).not.toBe(executable.sha256)
    expect(withDirectory.directories).toContain('empty')
  })

  it('keeps one rollback version, removes older payloads, and swaps atomically on rollback', async () => {
    const installRoot = await tempRoot('package-install')
    let currentTime = NOW
    const service = new PackageInstallationService({
      rootDirectory: installRoot,
      now: () => new Date(currentTime)
    })
    const source1 = await packageDirectory('1.0.0')
    const source2 = await packageDirectory('2.0.0')
    const source3 = await packageDirectory('3.0.0')
    const first = await install(service, marketplacePackage('1.0.0'), source1, null, 'install-v1')
    currentTime = NEXT
    const second = await install(service, marketplacePackage('2.0.0'), source2, '1.0.0', 'install-v2')
    const third = await install(service, marketplacePackage('3.0.0'), source3, '2.0.0', 'install-v3')

    await expect(lstat(first.artifact.location)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(third.rollback).toMatchObject({
      available: true,
      version: '2.0.0',
      artifact: { location: second.artifact.location }
    })
    const rolledBack = await service.rollback({
      packageId: third.packageId,
      expectedCurrentVersion: '3.0.0',
      idempotencyKey: 'rollback-v3'
    })
    expect(rolledBack.version).toBe('2.0.0')
    expect(rolledBack.rollback).toMatchObject({ available: true, version: '3.0.0' })
    await expect(readFile(join(rolledBack.artifact.location, 'plugin.txt'), 'utf8'))
      .resolves.toBe('version=2.0.0\n')
  })

  it('restores the previous manifest when post-install activation fails', async () => {
    const installRoot = await tempRoot('activation-compensation')
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    const source1 = await packageDirectory('1.0.0')
    const source2 = await packageDirectory('2.0.0')
    const first = await install(service, marketplacePackage('1.0.0'), source1, null, 'install-v1')
    const second = await install(service, marketplacePackage('2.0.0'), source2, first.version, 'install-v2')

    const restored = await service.compensateFailedInstall({
      packageId: second.packageId,
      failedVersion: second.version,
      failedReviewSha256: second.reviewSha256,
      failedArtifactSha256: second.artifact.sha256,
      installIdempotencyKey: 'install-v2'
    })

    expect(restored).toMatchObject({ version: '1.0.0', rollback: { available: false } })
    await expect(lstat(second.artifact.location)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(install(
      service,
      marketplacePackage('2.0.0'),
      source2,
      first.version,
      'install-v2'
    )).resolves.toMatchObject({ version: '2.0.0' })
  })

  it('does not replace the current version when health or manifest persistence fails', async () => {
    const installRoot = await tempRoot('package-install')
    let failPersistence = false
    const service = new PackageInstallationService({
      rootDirectory: installRoot,
      now: () => new Date(NOW),
      healthCheck: async ({ version }) => version === '2.0.0'
        ? { status: 'unhealthy', message: 'health failed' }
        : { status: 'healthy' },
      beforePersistManifest: async () => {
        if (failPersistence) throw new Error('manifest persistence failed')
      }
    })
    const source1 = await packageDirectory('1.0.0')
    const source2 = await packageDirectory('2.0.0')
    const source3 = await packageDirectory('3.0.0')
    await install(service, marketplacePackage('1.0.0'), source1, null, 'install-v1')

    await expect(install(
      service,
      marketplacePackage('2.0.0'),
      source2,
      '1.0.0',
      'install-v2'
    )).rejects.toThrow(/health failed/)
    expect((await service.get('example-plugin'))?.version).toBe('1.0.0')

    failPersistence = true
    const inspection3 = await inspectPackageDirectory(source3)
    await expect(install(
      service,
      marketplacePackage('3.0.0'),
      source3,
      '1.0.0',
      'install-v3'
    )).rejects.toThrow(/manifest persistence failed/)
    expect((await service.get('example-plugin'))?.version).toBe('1.0.0')
    const orphan = join(
      installRoot,
      'packages',
      createHash('sha256').update('example-plugin').digest('hex'),
      'versions',
      inspection3.sha256
    )
    await expect(lstat(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses rollback when the health check mutates the immutable payload', async () => {
    const installRoot = await tempRoot('package-install')
    let mutateRollback = false
    const service = new PackageInstallationService({
      rootDirectory: installRoot,
      healthCheck: async ({ version, location }) => {
        if (mutateRollback && version === '1.0.0') {
          await writeFile(join(location, 'plugin.txt'), 'tampered')
        }
        return { status: 'healthy' }
      }
    })
    const source1 = await packageDirectory('1.0.0')
    const source2 = await packageDirectory('2.0.0')
    await install(service, marketplacePackage('1.0.0'), source1, null, 'install-v1')
    await install(service, marketplacePackage('2.0.0'), source2, '1.0.0', 'install-v2')
    mutateRollback = true

    await expect(service.rollback({
      packageId: 'example-plugin',
      expectedCurrentVersion: '2.0.0',
      idempotencyKey: 'tampered-rollback'
    })).rejects.toThrow(/changed during.*health/i)
    expect((await service.get('example-plugin'))?.version).toBe('2.0.0')
  })

  it('rejects stale review data, missing permission decisions, licenses, and mutable versions', async () => {
    const installRoot = await tempRoot('package-install')
    const source = await packageDirectory('1.0.0')
    const inspection = await inspectPackageDirectory(source)
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    const item = marketplacePackage('1.0.0')
    const base = {
      package: item,
      sourceDirectory: source,
      expectedContentSha256: inspection.sha256,
      expectedCurrentVersion: null,
      reviewSha256: marketplacePackageReviewSha256(item),
      scope: 'user' as const,
      permissions: permissionDecisions(item),
      idempotencyKey: 'review-check'
    }

    await expect(service.install({ ...base, reviewSha256: 'a'.repeat(64) }))
      .rejects.toThrow(/review is stale/i)
    await expect(service.install({ ...base, permissions: [] }))
      .rejects.toThrow(/every package permission/i)
    const restricted = marketplacePackage('1.0.0', { license: 'GPL-3.0' })
    await expect(service.install({
      ...base,
      package: restricted,
      reviewSha256: marketplacePackageReviewSha256(restricted),
      idempotencyKey: 'restricted-license'
    })).rejects.toThrow(/license/i)
    const mutable = marketplacePackage('latest')
    await expect(service.install({
      ...base,
      package: mutable,
      reviewSha256: marketplacePackageReviewSha256(mutable),
      idempotencyKey: 'mutable-version'
    })).rejects.toThrow(/latest|mutable/i)
  })

  it('requires license evidence and rejects links, Git metadata, and digest mismatches', async () => {
    const installRoot = await tempRoot('package-install')
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    const withoutLicense = await packageDirectory('1.0.0', { license: false })
    await expect(install(
      service,
      marketplacePackage('1.0.0'),
      withoutLicense,
      null,
      'missing-license'
    )).rejects.toThrow(/LICENSE|NOTICE|COPYING/i)

    const linked = await packageDirectory('1.0.0')
    const outside = await tempRoot('outside-package')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(join(outside, 'secret.txt'), join(linked, 'linked.txt'))
    await expect(inspectPackageDirectory(linked)).rejects.toThrow(/links/i)

    const repository = await packageDirectory('1.0.0')
    await mkdir(join(repository, '.git'))
    await expect(inspectPackageDirectory(repository)).rejects.toThrow(/Git metadata/i)

    if (process.platform !== 'win32') {
      const nonPortable = await packageDirectory('1.0.0')
      await writeFile(join(nonPortable, 'bad:name.txt'), 'bad')
      await expect(inspectPackageDirectory(nonPortable)).rejects.toThrow(/portable/i)
    }

    const valid = await packageDirectory('1.0.0')
    const item = marketplacePackage('1.0.0')
    await expect(service.install({
      package: item,
      sourceDirectory: valid,
      expectedContentSha256: 'b'.repeat(64),
      expectedCurrentVersion: null,
      reviewSha256: marketplacePackageReviewSha256(item),
      scope: 'user',
      permissions: permissionDecisions(item),
      idempotencyKey: 'digest-mismatch'
    })).rejects.toThrow(/SHA-256/i)
    expect(await service.list()).toEqual([])
  })

  it('detects a source file replacement while its open descriptor is being copied', async () => {
    const installRoot = await tempRoot('package-install')
    const source = await packageDirectory('1.0.0')
    const inspection = await inspectPackageDirectory(source)
    let replaced = false
    const service = new PackageInstallationService({
      rootDirectory: installRoot,
      fileCopyHook: async (phase, path) => {
        if (phase !== 'opened' || basename(path) !== 'plugin.txt' || replaced) return
        replaced = true
        await rename(path, `${path}.original`)
        await writeFile(path, 'swapped')
      }
    })
    const item = marketplacePackage('1.0.0')

    await expect(service.install({
      package: item,
      sourceDirectory: source,
      expectedContentSha256: inspection.sha256,
      expectedCurrentVersion: null,
      reviewSha256: marketplacePackageReviewSha256(item),
      scope: 'user',
      permissions: permissionDecisions(item),
      idempotencyKey: 'toctou'
    })).rejects.toThrow(/changed/i)
    expect(await service.list()).toEqual([])
  })

  it('rejects overlapping roots and linked private staging directories', async () => {
    const installRoot = await tempRoot('package-install')
    await writeFile(join(installRoot, 'LICENSE'), 'MIT License\n')
    await writeFile(join(installRoot, 'plugin.txt'), 'payload')
    const item = marketplacePackage('1.0.0')
    const inspection = await inspectPackageDirectory(installRoot)
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    await expect(service.install({
      package: item,
      sourceDirectory: installRoot,
      expectedContentSha256: inspection.sha256,
      expectedCurrentVersion: null,
      reviewSha256: marketplacePackageReviewSha256(item),
      scope: 'user',
      permissions: permissionDecisions(item),
      idempotencyKey: 'overlap'
    })).rejects.toThrow(/overlap/i)

    const linkedRoot = await tempRoot('linked-install')
    const outside = await tempRoot('outside-staging')
    await mkdir(join(linkedRoot, 'packages'))
    await symlink(outside, join(linkedRoot, 'staging'), 'dir')
    await expect(new PackageInstallationService({ rootDirectory: linkedRoot }).list())
      .rejects.toThrow(/staging.*unsafe/i)
  })

  it('serializes concurrent installs, rejects stale versions, and replays idempotent results', async () => {
    const installRoot = await tempRoot('package-install')
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    const source1 = await packageDirectory('1.0.0')
    const source2 = await packageDirectory('2.0.0')
    const requests = await Promise.allSettled([
      install(service, marketplacePackage('1.0.0'), source1, null, 'concurrent-v1'),
      install(service, marketplacePackage('2.0.0'), source2, null, 'concurrent-v2')
    ])

    expect(requests.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(requests.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const installed = await service.get('example-plugin')
    expect(installed).not.toBeNull()
    const source = installed?.version === '1.0.0' ? source1 : source2
    const item = marketplacePackage(installed!.version)
    const key = installed?.version === '1.0.0' ? 'concurrent-v1' : 'concurrent-v2'
    const inspection = await inspectPackageDirectory(source)
    const replayRequest = {
      package: item,
      sourceDirectory: source,
      expectedContentSha256: inspection.sha256,
      expectedCurrentVersion: null,
      reviewSha256: marketplacePackageReviewSha256(item),
      scope: 'user' as const,
      permissions: permissionDecisions(item),
      idempotencyKey: key
    }
    await rm(source, { recursive: true, force: true })
    await expect(service.install(replayRequest)).resolves.toEqual(installed)
  })

  it('does not allow an exact installed version to be replaced with new content', async () => {
    const installRoot = await tempRoot('package-install')
    const source1 = await packageDirectory('1.0.0')
    const source2 = await packageDirectory('changed-content')
    const item = marketplacePackage('1.0.0')
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    await install(service, item, source1, null, 'install-v1')

    await expect(install(service, item, source2, '1.0.0', 'replace-v1'))
      .rejects.toThrow(/immutable|replaced in place/i)
    await expect(readFile(join((await service.get(item.id))!.artifact.location, 'plugin.txt'), 'utf8'))
      .resolves.toBe('version=1.0.0\n')
  })

  it('rejects a manifest whose artifact pointer escapes the installation root', async () => {
    const installRoot = await tempRoot('package-install')
    const source = await packageDirectory('1.0.0')
    const service = new PackageInstallationService({ rootDirectory: installRoot })
    await install(service, marketplacePackage('1.0.0'), source, null, 'install-v1')
    const manifestPath = join(installRoot, 'installed.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      records: Array<{ current: { artifact: { location: string } } }>
    }
    manifest.records[0]!.current.artifact.location = '/tmp/outside-plugin'
    await writeFile(manifestPath, JSON.stringify(manifest))

    await expect(new PackageInstallationService({ rootDirectory: installRoot }).list())
      .rejects.toThrow(/artifact location/i)
  })
})
