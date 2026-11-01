import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketplacePackageV1 } from '../../shared/marketplace'
import {
  PackageInstallationService,
  marketplacePackageReviewSha256
} from './package-installation-service'
import { materializeCatalogPackage, materializeGithubArchive, PluginManagementService } from './plugin-management-service'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `workwise-plugin-management-${label}-`))
  roots.push(root)
  return root
}

function manifest(version = '1.0.0'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'managed-import',
    name: 'Managed Import',
    description: 'Plugin management fixture.',
    version,
    publisher: { id: 'example', name: 'Example' },
    license: 'MIT',
    components: [{
      id: 'fixture-skill',
      name: 'Fixture Skill',
      type: 'skill',
      runtime: { kind: 'bundled', entrypoint: 'skills/fixture' },
      skillNames: ['fixture']
    }],
    permissions: [{
      id: 'workspace-read',
      kind: 'filesystem',
      access: 'read',
      default: 'review',
      reviewRequired: true,
      description: 'Read selected workspace files.',
      resources: ['workspace']
    }]
  }
}

async function writeArchive(path: string, skill = '# Original\n', version = '1.0.0'): Promise<void> {
  const zip = new JSZip()
  zip.file('workwise.plugin.json', JSON.stringify(manifest(version)))
  zip.file('skills/fixture/SKILL.md', skill)
  zip.file('LICENSE', 'MIT License\n')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

function createService(root: string, now?: () => Date): PluginManagementService {
  return new PluginManagementService({
    rootDirectory: join(root, 'imports'),
    installationService: new PackageInstallationService({ rootDirectory: join(root, 'installed') }),
    now
  })
}

describe('PluginManagementService', () => {
  it('materializes a pinned GitHub Skill from the system network archive when git is unavailable', async () => {
    const root = await tempRoot('github-archive')
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const archiveRoot = `BrowserSkill-${commit}`
    const zip = new JSZip()
    zip.file(`${archiveRoot}/skills/browser-skill/SKILL.md`, '# BrowserSkill\n')
    // GitHub repositories may contain an internal symlink. The GitHub
    // materializer must expand it into a regular directory before staging the
    // requested Skill subpath.
    zip.file(`${archiveRoot}/workbench/demos/demo.md`, 'demo\n')
    zip.file(`${archiveRoot}/workbench/demosrc`, 'demos', { unixPermissions: 0o120777 })
    zip.file(`${archiveRoot}/LICENSE`, 'MIT License\n')
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(archive as unknown as BodyInit, {
      status: 200,
      headers: { 'content-length': String(archive.byteLength) }
    })))
    const source = {
      id: 'browser-skill-source',
      catalogSourceId: 'workwise-official',
      kind: 'github' as const,
      location: 'https://github.com/Tencent/BrowserSkill',
      owner: 'Tencent',
      repository: 'BrowserSkill',
      defaultBranch: 'main',
      requestedRef: 'main',
      resolvedRef: commit,
      subpath: 'skills/browser-skill'
    }
    const item: MarketplacePackageV1 = {
      schemaVersion: 1,
      id: 'browser-skill',
      name: 'BrowserSkill',
      summary: 'Browser automation Skill.',
      tier: 'advanced',
      productType: 'workflow',
      categories: ['browser-automation'],
      version: commit,
      publisher: { id: 'tencent', name: 'Tencent', verified: false },
      license: 'MIT',
      source,
      sources: [source],
      components: [{
        id: 'browser-skill-skill',
        name: 'BrowserSkill',
        type: 'skill',
        sourceId: source.id,
        skillNames: ['browser-skill'],
        runtime: {
          kind: 'github',
          repository: source.location,
          resolvedCommit: commit,
          subpath: source.subpath,
          install: { strategy: 'managed-git', verifyBeforeActivation: true }
        }
      }],
      permissions: [],
      auth: { type: 'none' },
      licenseEvidence: [{ license: 'MIT', sourceId: source.id, path: 'LICENSE', includeInInstall: true, required: true }],
      dependencies: [],
      updatePolicy: { strategy: 'manual', channel: 'stable', allowMajor: false },
      compatibility: { workwise: '>=0.3.6', platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64'] },
      availability: { status: 'available' },
      installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
    }
    const target = join(root, 'prepared')
    await materializeGithubArchive('Tencent', 'BrowserSkill', commit, target, source.subpath)
    await expect(readFile(join(target, 'SKILL.md'), 'utf8')).resolves.toBe('# BrowserSkill\n')
    await expect(readFile(join(target, 'LICENSE'), 'utf8')).resolves.toBe('MIT License\n')
    await expect(access(join(target, '.git'))).rejects.toThrow()
  })

  it('prepares catalog packages through the same private review transaction', async () => {
    const root = await tempRoot('catalog')
    const source = {
      id: 'catalog-source',
      catalogSourceId: 'workwise-official',
      kind: 'built-in' as const,
      location: 'workwise://fixture'
    }
    const item: MarketplacePackageV1 = {
      schemaVersion: 1,
      id: 'catalog-fixture',
      name: 'Catalog Fixture',
      summary: 'Catalog preparation fixture.',
      tier: 'recommended',
      version: '1.0.0',
      publisher: { id: 'workwise', name: 'WorkWise', verified: true },
      license: 'MIT',
      source,
      sources: [source],
      components: [],
      permissions: [],
      auth: { type: 'none' },
      licenseEvidence: [],
      dependencies: [],
      updatePolicy: { strategy: 'pinned', channel: 'stable', allowMajor: false },
      compatibility: {
        workwise: '>=0.3.5',
        platforms: [process.platform as 'darwin' | 'win32' | 'linux'],
        architectures: [process.arch as 'arm64' | 'x64']
      },
      availability: { status: 'available' },
      installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
    }
    const service = new PluginManagementService({
      rootDirectory: join(root, 'imports'),
      installationService: new PackageInstallationService({ rootDirectory: join(root, 'installed') }),
      catalogMaterializer: async (_item, targetDirectory) => {
        await mkdir(targetDirectory, { recursive: true })
        await writeFile(join(targetDirectory, 'LICENSE'), 'MIT License\n')
        await writeFile(join(targetDirectory, 'payload.txt'), 'verified catalog payload\n')
      }
    })

    const prepared = await service.prepareCatalogPackage(item)
    expect(prepared).toMatchObject({
      format: 'catalog',
      package: { id: item.id, version: item.version },
      compatibility: { workwiseCompatible: true }
    })
    expect(prepared).not.toHaveProperty('preparedDirectory')

    const installed = await service.installPrepared({
      preparedId: prepared.id,
      reviewSha256: prepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [],
      idempotencyKey: 'install-catalog-fixture'
    })
    await expect(readFile(join(installed.artifact.location, 'payload.txt'), 'utf8'))
      .resolves.toBe('verified catalog payload\n')
    await expect(service.diagnoseUpdates([item])).resolves.toMatchObject([{
      packageId: item.id,
      state: 'current'
    }])
    await expect(service.diagnoseUpdates([{
      ...item,
      compatibility: { ...item.compatibility, workwise: '>=0.3.6' }
    }])).resolves.toMatchObject([{
      packageId: item.id,
      state: 'metadata-refresh'
    }])
    await expect(service.diagnoseUpdates([{
      ...item,
      auth: { type: 'token', provider: 'fixture', environmentVariables: ['FIXTURE_TOKEN'] }
    }])).resolves.toMatchObject([{
      packageId: item.id,
      state: 'runtime-drift'
    }])
  })

  it('keeps private staging paths out of the renderer contract and installs by prepared ID', async () => {
    const root = await tempRoot('install')
    const sourcePath = join(root, 'fixture.wwx')
    await writeArchive(sourcePath)
    const service = createService(root)

    const prepared = await service.prepareImport({ sourcePath })
    expect(prepared).toMatchObject({
      format: 'wwx',
      package: { id: 'managed-import', availability: { status: 'available' } }
    })
    expect(prepared).not.toHaveProperty('preparedDirectory')
    expect(JSON.stringify(prepared)).not.toContain(join(root, 'imports', 'staging'))

    const installed = await service.installPrepared({
      preparedId: prepared.id,
      reviewSha256: prepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' }],
      idempotencyKey: 'install-managed-import'
    })
    expect(installed).toMatchObject({ packageId: 'managed-import', version: '1.0.0' })
    await expect(readFile(join(installed.artifact.location, 'skills/fixture/SKILL.md'), 'utf8'))
      .resolves.toBe('# Original\n')
    await expect(service.cancelPrepared(prepared.id)).resolves.toBe(false)
  })

  it('removes a newly installed record when activation fails and allows a retry', async () => {
    const root = await tempRoot('activation-compensation')
    const sourcePath = join(root, 'fixture.wwx')
    await writeArchive(sourcePath)
    const service = createService(root)
    const prepared = await service.prepareImport({ sourcePath })
    const request = {
      preparedId: prepared.id,
      reviewSha256: prepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user' as const,
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' as const }],
      idempotencyKey: 'activation-failed-install'
    }

    await expect(service.installPrepared(request, async () => {
      throw new Error('MCP activation failed')
    })).rejects.toThrow(/MCP activation failed/i)
    await expect(service.listInstalled()).resolves.toEqual([])

    await expect(service.installPrepared(request)).resolves.toMatchObject({
      packageId: 'managed-import',
      version: '1.0.0'
    })
  })

  it('stages directory imports as immutable snapshots before review', async () => {
    const root = await tempRoot('directory')
    const source = join(root, 'codex-plugin')
    await mkdir(join(source, 'skills', 'fixture'), { recursive: true })
    await mkdir(join(source, '.codex-plugin'), { recursive: true })
    await writeFile(join(source, '.codex-plugin', 'plugin.json'), JSON.stringify({
      name: 'directory-plugin',
      version: '1.0.0',
      description: 'Directory fixture.',
      author: { name: 'Example' },
      license: 'MIT',
      skills: './skills/'
    }))
    await writeFile(join(source, 'skills', 'fixture', 'SKILL.md'), '# Before review\n')
    await writeFile(join(source, 'LICENSE'), 'MIT License\n')
    const service = createService(root)

    const prepared = await service.prepareImport({ sourcePath: source })
    await writeFile(join(source, 'skills', 'fixture', 'SKILL.md'), '# Changed after review\n')
    const installed = await service.installPrepared({
      preparedId: prepared.id,
      reviewSha256: prepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [],
      idempotencyKey: 'install-directory-plugin'
    })

    await expect(readFile(join(installed.artifact.location, 'skills/fixture/SKILL.md'), 'utf8'))
      .resolves.toBe('# Before review\n')
  })

  it('restores reviewed package metadata before reactivating a rolled-back artifact', async () => {
    const root = await tempRoot('rollback')
    const firstArchive = join(root, 'fixture-v1.wwx')
    const secondArchive = join(root, 'fixture-v2.wwx')
    await writeArchive(firstArchive, '# Version 1\n', '1.0.0')
    await writeArchive(secondArchive, '# Version 2\n', '2.0.0')
    const service = createService(root)

    const firstPrepared = await service.prepareImport({ sourcePath: firstArchive })
    const first = await service.installPrepared({
      preparedId: firstPrepared.id,
      reviewSha256: firstPrepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' }],
      idempotencyKey: 'install-rollback-v1'
    })
    const secondPrepared = await service.prepareImport({ sourcePath: secondArchive })
    const second = await service.installPrepared({
      preparedId: secondPrepared.id,
      reviewSha256: secondPrepared.reviewSha256,
      expectedCurrentVersion: first.version,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'denied' }],
      idempotencyKey: 'install-rollback-v2'
    })
    const reactivate = vi.fn(async () => undefined)

    const rolledBack = await service.rollback({
      packageId: second.packageId,
      expectedCurrentVersion: second.version,
      idempotencyKey: 'rollback-to-v1'
    }, reactivate)

    expect(rolledBack).toMatchObject({
      version: '1.0.0',
      reviewSha256: firstPrepared.reviewSha256,
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' }]
    })
    expect(reactivate).toHaveBeenCalledWith(
      rolledBack,
      expect.objectContaining({ id: 'managed-import', version: '1.0.0' })
    )
    await expect(readFile(join(rolledBack.artifact.location, 'skills/fixture/SKILL.md'), 'utf8'))
      .resolves.toBe('# Version 1\n')
  })

  it('restores the installed version when rollback activation fails', async () => {
    const root = await tempRoot('rollback-compensation')
    const firstArchive = join(root, 'fixture-v1.wwx')
    const secondArchive = join(root, 'fixture-v2.wwx')
    await writeArchive(firstArchive, '# Version 1\n', '1.0.0')
    await writeArchive(secondArchive, '# Version 2\n', '2.0.0')
    const service = createService(root)
    const firstPrepared = await service.prepareImport({ sourcePath: firstArchive })
    const first = await service.installPrepared({
      preparedId: firstPrepared.id,
      reviewSha256: firstPrepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' }],
      idempotencyKey: 'install-compensation-v1'
    })
    const secondPrepared = await service.prepareImport({ sourcePath: secondArchive })
    const second = await service.installPrepared({
      preparedId: secondPrepared.id,
      reviewSha256: secondPrepared.reviewSha256,
      expectedCurrentVersion: first.version,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'denied' }],
      idempotencyKey: 'install-compensation-v2'
    })

    await expect(service.rollback({
      packageId: second.packageId,
      expectedCurrentVersion: second.version,
      idempotencyKey: 'rollback-activation-failure'
    }, async () => {
      throw new Error('rollback activation failed')
    })).rejects.toThrow(/rollback activation failed/i)

    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({ version: '2.0.0' })
    ])
  })

  it('restores reviewed permissions when permission activation fails', async () => {
    const root = await tempRoot('permission-compensation')
    const sourcePath = join(root, 'fixture.wwx')
    await writeArchive(sourcePath)
    const service = createService(root)
    const prepared = await service.prepareImport({ sourcePath })
    const installed = await service.installPrepared({
      preparedId: prepared.id,
      reviewSha256: prepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' }],
      idempotencyKey: 'permission-compensation-install'
    })
    const changed = structuredClone(prepared.package)
    changed.permissions[0]!.resources = ['workspace', 'home']
    const changedReview = marketplacePackageReviewSha256(changed)

    await expect(service.updatePermissions(changed, {
      packageId: installed.packageId,
      expectedCurrentVersion: installed.version,
      reviewSha256: changedReview,
      permissions: [{ permissionId: 'workspace-read', decision: 'denied' }],
      idempotencyKey: 'permission-activation-failure'
    }, async () => {
      throw new Error('permission activation failed')
    })).rejects.toThrow(/permission activation failed/i)

    await expect(service.listInstalled()).resolves.toEqual([
      expect.objectContaining({
        reviewSha256: prepared.reviewSha256,
        permissions: [{ permissionId: 'workspace-read', decision: 'granted' }]
      })
    ])
  })

  it('rejects stale review hashes and expires abandoned private staging', async () => {
    const root = await tempRoot('expiry')
    const sourcePath = join(root, 'fixture.wwx')
    await writeArchive(sourcePath)
    let time = Date.parse('2026-08-08T00:00:00.000Z')
    const service = createService(root, () => new Date(time))
    const prepared = await service.prepareImport({ sourcePath })

    await expect(service.installPrepared({
      preparedId: prepared.id,
      reviewSha256: '0'.repeat(64),
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' }],
      idempotencyKey: 'stale-review'
    })).rejects.toThrow(/review changed/i)

    time += 31 * 60_000
    await expect(service.installPrepared({
      preparedId: prepared.id,
      reviewSha256: prepared.reviewSha256,
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [{ permissionId: 'workspace-read', decision: 'granted' }],
      idempotencyKey: 'expired-review'
    })).rejects.toThrow(/expired/i)
    await expect(service.cancelPrepared(prepared.id)).resolves.toBe(false)
  })

  it('removes expired UUID staging directories left by a previous process', async () => {
    const root = await tempRoot('orphan')
    const sourcePath = join(root, 'fixture.wwx')
    await writeArchive(sourcePath)
    const orphan = join(
      root,
      'imports',
      'staging',
      '123e4567-e89b-42d3-a456-426614174000'
    )
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'payload.txt'), 'stale')
    const old = new Date('2026-08-07T22:00:00.000Z')
    await utimes(orphan, old, old)
    const service = createService(root, () => new Date('2026-08-08T00:00:00.000Z'))

    await service.prepareImport({ sourcePath })

    await expect(access(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
