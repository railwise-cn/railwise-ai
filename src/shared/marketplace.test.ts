import { describe, expect, it } from 'vitest'
import type {
  CatalogSourceV1,
  InstalledPackageV1,
  MarketplacePackageV1,
  PackageSourceV1,
  PackagePermissionV1,
  PackageUpdateResultV1
} from './marketplace'
import {
  DIRECT_MIRROR_LICENSE_ALLOWLIST,
  evaluateMarketplaceLicense
} from './marketplace'

describe('marketplace V1 contracts', () => {
  it('represents every supported catalog source kind and scope', () => {
    const common = {
      schemaVersion: 1 as const,
      trust: 'community' as const,
      searchable: true,
      sync: {
        mode: 'search-on-demand' as const,
        state: 'synced' as const,
        mirroredByDefault: false,
        installedByDefault: false,
        lastSyncedAt: '2026-08-07T00:00:00.000Z',
        etag: '"catalog-v1"',
        commit: 'a'.repeat(40)
      }
    }
    const sources: CatalogSourceV1[] = [
      {
        ...common,
        id: 'builtin',
        name: 'Built-in',
        type: 'built-in',
        scope: 'system',
        location: 'workwise://marketplace/official-v1',
        trust: 'system',
        auth: { type: 'none' }
      },
      {
        ...common,
        id: 'local',
        name: 'Local',
        type: 'local',
        scope: 'user',
        location: '/Users/example/.workwise/catalog',
        auth: { type: 'none' }
      },
      {
        ...common,
        id: 'project',
        name: 'Project',
        type: 'project',
        scope: 'workspace',
        location: '.workwise/catalog.json',
        auth: { type: 'none' }
      },
      {
        ...common,
        id: 'git',
        name: 'Git',
        type: 'git',
        scope: 'team',
        location: 'ssh://git.example.test/team/catalog.git',
        defaultBranch: 'main',
        auth: { type: 'token', secretKey: 'catalog.git.token' }
      },
      {
        ...common,
        id: 'github',
        name: 'GitHub',
        type: 'github',
        scope: 'user',
        location: 'https://github.com/example/catalog',
        owner: 'example',
        repository: 'catalog',
        defaultBranch: 'main',
        auth: { type: 'oauth', provider: 'github', discovery: 'ready' }
      },
      {
        ...common,
        id: 'https',
        name: 'HTTPS',
        type: 'https',
        scope: 'team',
        location: 'https://catalog.example.test/v1.json',
        auth: { type: 'token', secretKey: 'catalog.https.token' }
      },
      {
        ...common,
        id: 'mcp-registry',
        name: 'MCP Registry',
        type: 'mcp-registry',
        scope: 'system',
        location: 'https://registry.modelcontextprotocol.io',
        registry: 'official',
        trust: 'official',
        auth: { type: 'none' }
      }
    ]

    expect(new Set(sources.map((source) => source.type))).toEqual(new Set([
      'built-in', 'local', 'project', 'git', 'github', 'https', 'mcp-registry'
    ]))
    expect(new Set(sources.map((source) => source.scope))).toEqual(new Set([
      'user', 'workspace', 'team', 'system'
    ]))
    expect(sources.every((source) => source.sync.etag && source.sync.commit)).toBe(true)
  })

  it('represents catalog, package, install, permission, and update provenance', () => {
    const npmSource: PackageSourceV1 = {
      id: 'example-npm',
      catalogSourceId: 'test-catalog',
      kind: 'npm',
      location: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz',
      packageName: 'example',
      version: '1.2.3',
      resolvedRef: '1.2.3',
      digest: { algorithm: 'sha512-sri', value: `sha512-${'a'.repeat(86)}==` }
    }
    const skillSource: PackageSourceV1 = {
      id: 'example-skills',
      catalogSourceId: 'test-catalog',
      kind: 'github',
      location: 'https://github.com/example/example',
      owner: 'example',
      repository: 'example',
      defaultBranch: 'main',
      requestedRef: 'v1.2.3',
      resolvedRef: 'b'.repeat(40),
      subpath: 'skills/example',
      digest: { algorithm: 'sha256', value: 'a'.repeat(64) }
    }
    const permission: PackagePermissionV1 = {
      id: 'workspace.read',
      kind: 'filesystem',
      access: 'read',
      default: 'granted',
      reviewRequired: false,
      description: 'Read files selected by the user.'
    }
    const marketplacePackage: MarketplacePackageV1 = {
      schemaVersion: 1,
      id: 'example-package',
      name: 'Example package',
      summary: 'A contract fixture.',
      tier: 'recommended',
      version: '1.2.3',
      publisher: { id: 'example', name: 'Example', verified: false },
      license: 'MIT',
      source: npmSource,
      sources: [npmSource, skillSource],
      components: [
        {
          id: 'example-cli',
          name: 'Example CLI',
          type: 'cli',
          sourceId: npmSource.id,
          runtime: {
            kind: 'npm',
            packageName: 'example',
            version: '1.2.3',
            executable: 'example',
            args: [],
            install: {
              strategy: 'managed-download',
              verify: 'sri-before-activation',
              digestSource: 'component-source'
            }
          }
        },
        {
          id: 'example-skill',
          name: 'Example Skill',
          type: 'skill',
          sourceId: skillSource.id,
          skillNames: ['example'],
          runtime: {
            kind: 'github',
            repository: skillSource.location,
            resolvedCommit: skillSource.resolvedRef,
            subpath: skillSource.subpath,
            install: { strategy: 'managed-git', verifyBeforeActivation: true }
          }
        }
      ],
      permissions: [permission],
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
      installation: {
        mode: 'direct-mirror',
        installedByDefault: false,
        reinstallable: true
      }
    }
    const installed: InstalledPackageV1 = {
      schemaVersion: 1,
      packageId: marketplacePackage.id,
      source: marketplacePackage.source,
      sources: marketplacePackage.sources,
      components: marketplacePackage.components.map((component) => ({
        componentId: component.id,
        sourceId: component.sourceId
      })),
      version: marketplacePackage.version,
      license: marketplacePackage.license,
      reviewSha256: 'c'.repeat(64),
      scope: 'workspace',
      artifact: {
        sha256: 'a'.repeat(64),
        location: '/plugins/example/versions/current',
        fileCount: 2,
        totalBytes: 1024
      },
      permissions: [{ permissionId: permission.id, decision: 'granted' }],
      timestamps: {
        installedAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T01:00:00.000Z',
        lastCheckedAt: '2026-08-07T02:00:00.000Z'
      },
      updatePolicy: marketplacePackage.updatePolicy,
      rollback: {
        available: true,
        version: '1.2.2',
        source: marketplacePackage.source,
        sources: marketplacePackage.sources,
        components: marketplacePackage.components.map((component) => ({
          componentId: component.id,
          sourceId: component.sourceId
        })),
        createdAt: '2026-08-07T01:00:00.000Z',
        license: marketplacePackage.license,
        reviewSha256: 'd'.repeat(64),
        artifact: {
          sha256: 'b'.repeat(64),
          location: '/plugins/example/versions/previous',
          fileCount: 2,
          totalBytes: 1000
        },
        permissions: [{ permissionId: permission.id, decision: 'granted' }],
        updatePolicy: marketplacePackage.updatePolicy,
        health: { status: 'healthy', checkedAt: '2026-08-07T01:00:00.000Z' }
      },
      health: {
        status: 'healthy',
        checkedAt: '2026-08-07T02:00:00.000Z'
      }
    }
    const update: PackageUpdateResultV1 = {
      status: 'updated',
      packageId: installed.packageId,
      fromVersion: '1.2.2',
      toVersion: installed.version,
      installed,
      rolledBack: false
    }

    expect(marketplacePackage.sources.map((source) => source.id)).toEqual([
      npmSource.id,
      skillSource.id
    ])
    expect(marketplacePackage.components.map((component) => component.sourceId)).toEqual([
      npmSource.id,
      skillSource.id
    ])
    expect(marketplacePackage.permissions).toEqual([permission])
    expect(installed.sources).toEqual(marketplacePackage.sources)
    expect(installed.components).toEqual([
      { componentId: 'example-cli', sourceId: npmSource.id },
      { componentId: 'example-skill', sourceId: skillSource.id }
    ])
    const installedDigests = installed.sources.flatMap((source) =>
      source.digest ? [source.digest] : []
    )
    expect(new Set(installedDigests.map((digest) => digest.algorithm))).toEqual(
      new Set(['sha256', 'sha512-sri'])
    )
    expect(installed.rollback.available).toBe(true)
    if (installed.rollback.available) {
      expect(installed.rollback.sources).toEqual(marketplacePackage.sources)
      expect(installed.rollback.sources.flatMap((source) =>
        source.digest ? [source.digest] : []
      )).toEqual(installedDigests)
    }
    expect(update.status).toBe('updated')
  })
})

describe('marketplace license policy', () => {
  it('uses the exact direct-mirror license allowlist', () => {
    expect(DIRECT_MIRROR_LICENSE_ALLOWLIST).toEqual([
      'MIT',
      'Apache-2.0',
      'BSD-2-Clause',
      'BSD-3-Clause',
      'ISC',
      'MIT AND Apache-2.0 AND CC-BY-4.0'
    ])

    for (const license of DIRECT_MIRROR_LICENSE_ALLOWLIST) {
      expect(evaluateMarketplaceLicense(license)).toMatchObject({
        disposition: 'direct-mirror',
        license
      })
    }
  })

  it('keeps unknown and missing licenses external-only', () => {
    for (const license of [undefined, null, '', 'UNKNOWN', 'MPL-2.0', 'MIT OR Apache-2.0']) {
      expect(evaluateMarketplaceLicense(license).disposition).toBe('external-only')
    }
  })

  it('rejects copyleft, source-available, and non-commercial licenses', () => {
    for (const license of [
      'GPL-3.0-only',
      'LGPL-3.0-only',
      'AGPL-3.0-only',
      'SSPL-1.0',
      'BSL-1.1',
      'BUSL-1.1',
      'Business Source License 1.1',
      'MIT OR GPL-3.0-only',
      'CC-BY-NC-4.0'
    ]) {
      expect(evaluateMarketplaceLicense(license)).toMatchObject({
        disposition: 'rejected',
        license
      })
    }
  })
  it('does not confuse the SPDX Boost Software License with Business Source', () => {
    expect(evaluateMarketplaceLicense('BSL-1.0')).toMatchObject({
      disposition: 'external-only',
      license: 'BSL-1.0'
    })
  })

  it('classifies restricted SPDX identifiers exactly instead of matching substrings', () => {
    for (const license of ['MIT-Modern-Variant', 'BlueOak-1.0.0', 'bsl-helper']) {
      expect(evaluateMarketplaceLicense(license).disposition).toBe('external-only')
    }

    for (const license of ['GPL-2.0-or-later', 'LGPL-2.1-only', 'AGPL-3.0-or-later']) {
      expect(evaluateMarketplaceLicense(license).disposition).toBe('rejected')
    }
  })
})
