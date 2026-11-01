import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MarketplacePackageV1 } from '../../shared/marketplace'
import { evaluateMarketplaceLicense } from '../../shared/marketplace'
import {
  getMarketplaceCatalogSources,
  getOfficialMarketplaceCatalog
} from './official-marketplace-catalog'

const PINNED_NPM_COMPONENTS = {
  '@playwright/mcp': {
    version: '0.0.79',
    integrity: 'sha512-VpqD4a3vFyGQMY9sh3UJiO6wjcurggkljKfAyCHL0QWGY5m6Ehr3MNsAAHPDHO//n13g0PCjpHatAOiulrqdZQ=='
  },
  '@playwright/cli': {
    version: '0.1.18',
    integrity: 'sha512-ggNfYYH+GsZTGUiBEL8f6N5j0seYEUE52v+fIWqK/A36QG36cL0EJ79qWTXYO2uZMUU7vm+jk3x0fKCPL6UuIw=='
  },
  '@upstash/context7-mcp': {
    version: '4.0.0',
    integrity: 'sha512-7TlB85xbKbSHzI4G//3Qm+g8ryW11WZLd7PAOFdH5IxzAv1Yk+lcSBgDM4lDoYHXltzSwK7iUciiFNbFj7493Q=='
  },
  '@bytebase/dbhub': {
    version: '1.2.0',
    integrity: 'sha512-EaSkcaDpVTF8zOjOGEZlowSTt8jjvLG8pxJ06J1ib46mdl63ryxz4Ga+xhPR2Z6opMf7G5F2d9CWgwG53QlRSQ=='
  },
  '@antv/mcp-server-chart': {
    version: '0.9.10',
    integrity: 'sha512-km14tIp6xoTw2whXpFvmm9dVlC+8G+W+uORb0xcRan+0zos8GgQl7D2Vxn+D6OEQZmSHd/vNbRP9/4vaXiBfLQ=='
  },
  '@modelcontextprotocol/server-filesystem': {
    version: '2026.7.10',
    integrity: 'sha512-Mmjg4anFBD5OzbPnGJOA0jPPN8645ERhQk38HQLpSenx1ox9bfdPkmAzUnNjeQtqQGFLtKe13J20RtLBmUKMZA=='
  },
  '@modelcontextprotocol/server-memory': {
    version: '2026.7.4',
    integrity: 'sha512-D+NNzChsOHN72y58ngDmO+TzjJijGi/sSY/gBydhB3TJCcm1XQEozVWwEpruHeXt/HSkMV3Z/BpHDhdt1MLD5w=='
  },
  '@modelcontextprotocol/server-sequential-thinking': {
    version: '2026.7.4',
    integrity: 'sha512-tmR/ieGaeweffLNBrDp1H1w4sn4M6TN5yWSbMS+YMfS+0GDyPjnNKzqCl2uqfdRiX3D44PJUhwiDGqtJp6tFhw=='
  },
  'mongodb-mcp-server': {
    version: '2.0.0',
    integrity: 'sha512-5G1m202mFTfYRpIxYYkdRWzjerB48GEQIdgQOYUy9jeXUEwHakWN4vY+Aayyz/r7PChYf0fM3Ei02FcKIhEyIg=='
  }
} as const

const PINNED_WHEEL_COMPONENTS = {
  'docling-mcp': {
    version: '3.0.0',
    sha256: '595da70b9de2265f1f14e575fad65ff4213c5c7e2dbb255184d606505fa49f23',
    executable: 'docling-mcp-server'
  },
  'mcp-server-fetch': {
    version: '2026.7.10',
    sha256: '6991b9a8133726b9f0b76d8c5e9607c8207e19e7c3a47c9e174a8b2e0742fc70',
    executable: 'mcp-server-fetch'
  },
  'mcp-server-git': {
    version: '2026.7.10',
    sha256: '6eb8bb2cca00f39e7bf9752472268c2a037579d59d1373b2fb89cc606060fad5',
    executable: 'mcp-server-git'
  },
  'mcp-server-time': {
    version: '2026.7.10',
    sha256: 'b99cb0ecfe94ec8e05d4abb65c617b591a21e61a17a084ac782af0fa9e82c944',
    executable: 'mcp-server-time'
  },
  'redis-mcp-server': {
    version: '0.5.1',
    sha256: '335d9089d4c87a055b362effa7fd718334ccd88b2545d93c4ed9bc2b738b3ed8',
    executable: 'redis-mcp-server'
  }
} as const

const PINNED_EXECUTABLES = {
  '@antv/mcp-server-chart': 'mcp-server-chart',
  '@bytebase/dbhub': 'dbhub',
  '@modelcontextprotocol/server-filesystem': 'mcp-server-filesystem',
  '@modelcontextprotocol/server-memory': 'mcp-server-memory',
  '@modelcontextprotocol/server-sequential-thinking': 'mcp-server-sequential-thinking',
  '@playwright/cli': 'playwright-cli',
  '@playwright/mcp': 'playwright-mcp',
  '@upstash/context7-mcp': 'context7-mcp',
  'docling-mcp': 'docling-mcp-server',
  'mcp-server-fetch': 'mcp-server-fetch',
  'mcp-server-git': 'mcp-server-git',
  'mcp-server-time': 'mcp-server-time',
  'mongodb-mcp-server': 'mongodb-mcp-server',
  'redis-mcp-server': 'redis-mcp-server'
} as const

function packageById(id: string): MarketplacePackageV1 {
  const item = getOfficialMarketplaceCatalog().find((candidate) => candidate.id === id)
  if (!item) throw new Error(`Missing marketplace package: ${id}`)
  return item
}

function expectUnique(values: string[]): void {
  expect(new Set(values).size).toBe(values.length)
}

describe('official marketplace catalog', () => {
  it('contains the required recommended and managed package set', () => {
    const packages = getOfficialMarketplaceCatalog()
    const ids = new Set(packages.map((item) => item.id))

    const requiredIds = [
      'github-mcp',
      'playwright-mcp',
      'playwright-cli-skills',
      'context7-mcp',
      'dbhub',
      'antv-chart-mcp',
      'antv-chart-skill',
      'superpowers',
      'filesystem-mcp',
      'memory-mcp',
      'sequential-thinking-mcp',
      'di-bao-monitoring',
      'operational-monitoring',
      'rail-any-station-control-network',
      'tender-master',
      'document-illustrator',
      'ppt-master',
      'writing-agent',
      'humanizer-zh',
      'nuwa-skill',
      'lark-cli',
      'officecli',
      'ego-browser',
      'markitdown',
      'railwise-kb',
      'browser-skill',
      'blender-skills',
      'video-shotcraft',
      'diagram-design',
      'arch-diagram-skill'
    ]
    for (const id of requiredIds) expect(ids.has(id), `${id} is missing`).toBe(true)
  })

  it('documents how to use each pinned GitHub Skill', () => {
    for (const id of ['browser-skill', 'blender-skills', 'video-shotcraft', 'diagram-design', 'arch-diagram-skill']) {
      const item = packageById(id)
      expect(item.usage?.howToUse, `${id} must document usage`).toBeTruthy()
      expect(item.usage?.examples?.length, `${id} must include an example`).toBeGreaterThan(0)
    }
  })

  it('pins Arch Diagram to its latest inspected commit and preserves its runtime requirements', () => {
    const item = packageById('arch-diagram-skill')
    expect(item.version).toBe('879ca7fa503a64ab46b5bc77d2062ded32fadc84')
    expect(item.source.kind).toBe('github')
    if (item.source.kind !== 'github') throw new Error('Arch Diagram source must be GitHub.')
    expect(item.source.resolvedRef).toBe('879ca7fa503a64ab46b5bc77d2062ded32fadc84')
    expect(item.source.subpath).toBe('skills/arch-diagram')
    expect(item.license).toBe('MIT')
    expect(item.dependencies.map((dependency) => dependency.id)).toEqual(['node', 'browser', 'ffmpeg'])
  })

  it('contains exactly the official recommended package set and tiers', () => {
    const expectedRecommendedIds = [
      'antv-chart-mcp',
      'context7-mcp',
      'dbhub',
      'di-bao-monitoring',
      'document-illustrator',
      'filesystem-mcp',
      'github-mcp',
      'lark-cli',
      'markitdown',
      'officecli',
      'playwright-mcp',
      'ppt-master',
      'rail-any-station-control-network',
      'schedule',
      'superpowers',
      'tender-master',
      'writing-agent'
    ]
    const packages = getOfficialMarketplaceCatalog()
    const actualRecommendedIds = packages
      .filter((item) => item.tier === 'recommended')
      .map((item) => item.id)
      .sort()

    expect(actualRecommendedIds).toEqual([...expectedRecommendedIds].sort())
    for (const id of expectedRecommendedIds) {
      expect(packageById(id).tier, `${id} must be recommended`).toBe('recommended')
    }
  })

  it('contains exactly the official advanced package set and tiers', () => {
    const expectedAdvancedIds = [
      'antv-chart-skill',
      'docling-mcp',
      'ego-browser',
      'fetch-mcp',
      'git-mcp',
      'humanizer-zh',
      'lark-openapi-mcp',
      'linear-mcp',
      'memory-mcp',
      'mongodb-mcp',
      'notion-mcp',
      'nuwa-skill',
      'operational-monitoring',
      'playwright-cli-skills',
      'redis-mcp',
      'railwise-kb',
      'browser-skill',
      'blender-skills',
      'video-shotcraft',
      'diagram-design',
      'arch-diagram-skill',
      'sequential-thinking-mcp',
      'time-mcp'
    ]
    const packages = getOfficialMarketplaceCatalog()
    const actualAdvancedIds = packages
      .filter((item) => item.tier === 'advanced')
      .map((item) => item.id)
      .sort()

    expect(actualAdvancedIds).toEqual([...expectedAdvancedIds].sort())
    for (const id of expectedAdvancedIds) {
      expect(packageById(id).tier, `${id} must be advanced`).toBe('advanced')
    }
  })

  it('categorizes every package and only promotes distinct capabilities', () => {
    const packages = getOfficialMarketplaceCatalog()
    for (const item of packages) {
      expect(item.categories?.length, `${item.id} must have a product category`).toBeGreaterThan(0)
      expect(item.collections?.length, `${item.id} must have a user collection`).toBeGreaterThan(0)
      expect(item.productType, `${item.id} must have a product-level type`).toBeTruthy()
      expect(item.icon, `${item.id} must have a marketplace icon`).toBeDefined()
    }

    const recommended = new Set(
      packages.filter((item) => item.tier === 'recommended').map((item) => item.id)
    )
    for (const duplicate of [
      'playwright-cli-skills',
      'antv-chart-skill',
      'memory-mcp',
      'sequential-thinking-mcp',
      'ego-browser',
      'docling-mcp'
    ]) {
      expect(recommended.has(duplicate), `${duplicate} must not be promoted beside its primary capability`).toBe(false)
    }
  })

  it('restores the curated specialist Skills as managed product entries', () => {
    const restoredIds = [
      'di-bao-monitoring',
      'operational-monitoring',
      'rail-any-station-control-network',
      'tender-master',
      'document-illustrator',
      'ppt-master',
      'writing-agent',
      'humanizer-zh',
      'nuwa-skill'
    ]

    for (const id of restoredIds) {
      const item = packageById(id)
      expect(existsSync(resolve('src', 'asset', 'skills', id, 'SKILL.md')), `${id} bundled asset is missing`).toBe(true)
      expect(item.productType, id).toBe('workflow')
      expect(item.installation, id).toEqual({
        mode: 'system-managed',
        installedByDefault: true,
        reinstallable: false
      })
      expect(item.availability, id).toEqual({ status: 'managed', managedBy: 'RailWise AI' })
      expect(item.components, id).toEqual([
        expect.objectContaining({
          type: 'skill',
          skillNames: [id],
          runtime: { kind: 'system', provider: 'workwise', capability: `skill:${id}` }
        })
      ])
    }

    expect(packageById('writing-agent').collections).toContain('writing')
    expect(packageById('humanizer-zh').collections).toContain('writing')
    expect(packageById('di-bao-monitoring').collections).toContain('engineering')
    expect(packageById('operational-monitoring').collections).toContain('engineering')
  })

  it('uses the exact official GitHub remote MCP endpoint', () => {
    const github = getOfficialMarketplaceCatalog().find((item) => item.id === 'github-mcp')

    expect(github).toBeDefined()
    expect(github?.components).toContainEqual(expect.objectContaining({
      type: 'mcp',
      runtime: expect.objectContaining({
        kind: 'remote',
        endpoint: 'https://api.githubcopilot.com/mcp/'
      })
    }))
    expect(JSON.stringify(github)).not.toContain('@modelcontextprotocol/server-github')
  })

  it('pins every required npm component to the audited version and integrity', () => {
    const packages = getOfficialMarketplaceCatalog()
    const npmComponents = packages
      .flatMap((item) => item.components.map((component) => ({ item, component })))
      .filter(({ component }) => component.runtime.kind === 'npm')
    const actual = Object.fromEntries(npmComponents.map(({ item, component }) => {
      const source = item.sources.find((candidate) => candidate.id === component.sourceId)
      if (component.runtime.kind !== 'npm' || source?.kind !== 'npm') {
        throw new Error(`Invalid npm provenance for ${item.id}/${component.id}`)
      }
      return [
        component.runtime.packageName,
        { version: component.runtime.version, integrity: source.digest.value }
      ]
    }))

    expect(actual).toEqual(PINNED_NPM_COMPONENTS)
    expect(JSON.stringify(packages)).not.toContain('@latest')
  })

  it('pins Redis, MongoDB, and Docling to the verified artifacts and executables', () => {
    const redis = packageById('redis-mcp')
    const mongodb = packageById('mongodb-mcp')
    const docling = packageById('docling-mcp')

    expect(redis).toMatchObject({
      version: '0.5.1',
      license: 'MIT',
      publisher: { id: 'redis', verified: true },
      source: {
        kind: 'pypi',
        packageName: 'redis-mcp-server',
        version: '0.5.1',
        resolvedRef: '0.5.1',
        digest: {
          algorithm: 'sha256',
          value: '335d9089d4c87a055b362effa7fd718334ccd88b2545d93c4ed9bc2b738b3ed8'
        }
      },
      installation: { mode: 'direct-mirror' },
      availability: { status: 'available' }
    })
    expect(redis.components[0]?.runtime).toMatchObject({
      kind: 'uv',
      packageName: 'redis-mcp-server',
      version: '0.5.1',
      executable: 'redis-mcp-server'
    })

    expect(mongodb).toMatchObject({
      version: '2.0.0',
      license: 'Apache-2.0',
      publisher: { id: 'mongodb', verified: true },
      source: {
        kind: 'npm',
        packageName: 'mongodb-mcp-server',
        version: '2.0.0',
        resolvedRef: '2.0.0',
        digest: {
          algorithm: 'sha512-sri',
          value: 'sha512-5G1m202mFTfYRpIxYYkdRWzjerB48GEQIdgQOYUy9jeXUEwHakWN4vY+Aayyz/r7PChYf0fM3Ei02FcKIhEyIg=='
        }
      },
      installation: { mode: 'direct-mirror' },
      availability: { status: 'available' }
    })
    expect(mongodb.components[0]?.runtime).toMatchObject({
      kind: 'npm',
      packageName: 'mongodb-mcp-server',
      version: '2.0.0',
      executable: 'mongodb-mcp-server'
    })

    expect(docling).toMatchObject({
      version: '3.0.0',
      license: 'MIT',
      publisher: { id: 'docling-project', verified: true },
      source: {
        kind: 'pypi',
        location: 'https://pypi.org/project/docling-mcp/3.0.0/',
        packageName: 'docling-mcp',
        version: '3.0.0',
        resolvedRef: '3.0.0',
        digest: {
          algorithm: 'sha256',
          value: '595da70b9de2265f1f14e575fad65ff4213c5c7e2dbb255184d606505fa49f23'
        }
      },
      installation: { mode: 'direct-mirror' },
      availability: { status: 'available' }
    })
    expect(docling.dependencies).toContainEqual(expect.objectContaining({
      id: 'python',
      requirement: '>=3.10'
    }))
    expect(docling.components[0]?.runtime).toMatchObject({
      kind: 'uv',
      packageName: 'docling-mcp',
      version: '3.0.0',
      executable: 'docling-mcp-server'
    })
  })

  it('pins every Python artifact and every managed executable name exactly', () => {
    const packages = getOfficialMarketplaceCatalog()
    const python310Packages = new Set(['docling-mcp', 'fetch-mcp', 'git-mcp', 'time-mcp'])
    const wheelComponents = packages
      .flatMap((item) => item.components.map((component) => ({ item, component })))
      .filter(({ component }) => component.runtime.kind === 'uv')
    const actualWheels = Object.fromEntries(wheelComponents.map(({ item, component }) => {
      const source = item.sources.find((candidate) => candidate.id === component.sourceId)
      if (component.runtime.kind !== 'uv' || source?.kind !== 'pypi') {
        throw new Error(`Invalid wheel provenance for ${item.id}/${component.id}`)
      }
      if (python310Packages.has(item.id)) {
        expect(item.dependencies).toContainEqual(expect.objectContaining({
          id: 'python',
          requirement: '>=3.10'
        }))
      }
      expect(item.license).toBe('MIT')
      expect(item.installation.mode).toBe('direct-mirror')
      return [
        component.runtime.packageName,
        {
          version: component.runtime.version,
          sha256: source.digest.value,
          executable: component.runtime.executable
        }
      ]
    }))
    const managedArtifactComponents = packages
      .flatMap((item) => item.components)
      .flatMap((component) =>
        component.runtime.kind === 'npm' || component.runtime.kind === 'uv'
          ? [component.runtime]
          : []
      )
    const executableCounts = new Map<string, number>()

    expect(managedArtifactComponents).toHaveLength(15)
    for (const runtime of managedArtifactComponents) {
      const expectedExecutable = PINNED_EXECUTABLES[
        runtime.packageName as keyof typeof PINNED_EXECUTABLES
      ]
      expect(expectedExecutable, `Unexpected pinned package ${runtime.packageName}`).toBeDefined()
      expect(runtime.executable, `Wrong executable for ${runtime.packageName}`).toBe(
        expectedExecutable
      )
      executableCounts.set(runtime.packageName, (executableCounts.get(runtime.packageName) ?? 0) + 1)
    }

    expect(actualWheels).toEqual(PINNED_WHEEL_COMPONENTS)
    expect(executableCounts.size).toBe(Object.keys(PINNED_EXECUTABLES).length)
    for (const packageName of Object.keys(PINNED_EXECUTABLES)) {
      expect(executableCounts.get(packageName)).toBe(packageName === '@playwright/cli' ? 2 : 1)
    }
    expect(JSON.stringify(packages)).not.toContain('"kind":"uvx"')
  })

  it('uses the audited Playwright MCP executable name', () => {
    const component = packageById('playwright-mcp').components[0]

    expect(component?.runtime).toMatchObject({
      kind: 'npm',
      packageName: '@playwright/mcp',
      version: '0.0.79',
      executable: 'playwright-mcp'
    })
  })

  it('uses exact immutable GitHub sources for AntV and Superpowers', () => {
    const antv = packageById('antv-chart-skill')
    const superpowers = packageById('superpowers')

    expect(antv.source).toMatchObject({
      kind: 'github',
      location: 'https://github.com/antvis/chart-visualization-skills',
      owner: 'antvis',
      repository: 'chart-visualization-skills',
      defaultBranch: 'master',
      subpath: 'skills/chart-visualization',
      resolvedRef: 'b47f2feae59b1e792462d0edd8d1a7ea87c9bdfc'
    })
    expect(antv.components[0]).toMatchObject({
      sourceId: antv.source.id,
      runtime: {
        kind: 'github',
        repository: 'https://github.com/antvis/chart-visualization-skills',
        resolvedCommit: 'b47f2feae59b1e792462d0edd8d1a7ea87c9bdfc',
        subpath: 'skills/chart-visualization'
      }
    })
    expect(superpowers.source).toMatchObject({
      kind: 'github',
      resolvedRef: '44c9b2d6e889982ac18c27d05a19fefe335194e1'
    })
    expect(superpowers.components[0]?.runtime).toMatchObject({
      kind: 'github',
      resolvedCommit: '44c9b2d6e889982ac18c27d05a19fefe335194e1'
    })
  })

  it('ships the five GitHub skills as pinned, installable packages with license evidence', () => {
    const expected = new Map([
      ['browser-skill', ['9cfba53582cb04d48da36aabd0a5017987d4daea', 'MIT', 'crates/bsk-cli/skill']],
      ['blender-skills', ['8f778d2405a214b508d4c7d80742be8e43acdd52', 'MIT', '.claude/skills']],
      ['video-shotcraft', ['1266a3ec4831289c4d893d42dd5102723658039a', 'Apache-2.0', undefined]],
      ['diagram-design', ['0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1', 'MIT', undefined]],
      ['arch-diagram-skill', ['879ca7fa503a64ab46b5bc77d2062ded32fadc84', 'MIT', 'skills/arch-diagram']]
    ] as const)

    for (const [id, [commit, license, subpath]] of expected) {
      const item = packageById(id)
      expect(item.installation.mode).toBe('direct-mirror')
      expect(item.version).toBe(commit)
      expect(item.source).toMatchObject({
        kind: 'github', resolvedRef: commit,
        ...(subpath ? { subpath } : {})
      })
      expect(item.components).toHaveLength(1)
      expect(item.components[0]).toMatchObject({
        type: 'skill',
        runtime: { kind: 'github', resolvedCommit: commit, ...(subpath ? { subpath } : {}) }
      })
      expect(item.license).toBe(license)
      expect(item.licenseEvidence).toHaveLength(1)
      expect(item.licenseEvidence[0]).toMatchObject({
        license,
        path: 'LICENSE',
        includeInInstall: true,
        required: true
      })
      expect(item.sources.find((source) => source.id === item.licenseEvidence[0]?.sourceId))
        .toMatchObject({ kind: 'github', resolvedRef: commit })
    }

    expect(packageById('diagram-design').source.location)
      .toBe('https://github.com/cathrynlavery/diagram-design')
  })

  it('retains immutable root MIT license evidence for official MCP server artifacts', () => {
    const expectedCommits = new Map([
      ['filesystem-mcp', '9a96ea6e5913736f92b88345bf51caeaaa8e719f'],
      ['memory-mcp', '6dd0a683e198783e30feabf7abaf42f925bd18b1'],
      ['sequential-thinking-mcp', '6dd0a683e198783e30feabf7abaf42f925bd18b1'],
      ['git-mcp', '76d64c822f5125032f89eb71dbdb94e42b434821'],
      ['fetch-mcp', '76d64c822f5125032f89eb71dbdb94e42b434821'],
      ['time-mcp', '76d64c822f5125032f89eb71dbdb94e42b434821']
    ])

    for (const [id, commit] of expectedCommits) {
      const item = packageById(id)
      expect(item.license).toBe('MIT')
      expect(item.licenseEvidence).toHaveLength(1)
      expect(item.licenseEvidence[0]).toMatchObject({
        license: 'MIT',
        path: 'LICENSE',
        includeInInstall: true,
        required: true
      })
      const evidenceSource = item.sources.find(
        (source) => source.id === item.licenseEvidence[0]?.sourceId
      )
      expect(evidenceSource).toMatchObject({
        kind: 'github',
        location: 'https://github.com/modelcontextprotocol/servers',
        owner: 'modelcontextprotocol',
        repository: 'servers',
        resolvedRef: commit
      })
    }
  })

  it('declares required Git, Fetch, and Docling permissions', () => {
    const git = packageById('git-mcp')
    const fetch = packageById('fetch-mcp')
    const docling = packageById('docling-mcp')

    expect(git.permissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'filesystem', access: 'read' }),
      expect.objectContaining({
        kind: 'filesystem',
        access: 'write',
        default: 'denied',
        reviewRequired: true
      }),
      expect.objectContaining({ kind: 'process', access: 'execute' })
    ]))
    expect(fetch.permissions).toContainEqual(expect.objectContaining({
      kind: 'network',
      access: 'connect'
    }))
    expect(docling.permissions).toContainEqual(expect.objectContaining({
      kind: 'filesystem',
      access: 'read'
    }))
  })

  it('declares the exact Memory MCP filesystem permission defaults', () => {
    const permissions = packageById('memory-mcp').permissions
      .filter((permission) => permission.kind === 'filesystem')
      .map(({ access, default: defaultDecision, reviewRequired }) => ({
        access,
        default: defaultDecision,
        reviewRequired
      }))
      .sort((left, right) => left.access.localeCompare(right.access))

    expect(permissions).toEqual([
      { access: 'read', default: 'review', reviewRequired: true },
      { access: 'write', default: 'denied', reviewRequired: true }
    ])
  })

  it('uses conservative publisher verification and exact managed-tool licenses', () => {
    expect(packageById('redis-mcp').publisher.verified).toBe(true)
    expect(packageById('mongodb-mcp').publisher.verified).toBe(true)
    expect(packageById('docling-mcp').publisher.verified).toBe(true)
    expect(packageById('notion-mcp').publisher.verified).toBe(false)
    expect(packageById('linear-mcp').publisher.verified).toBe(false)
    expect(packageById('ego-browser').publisher.verified).toBe(false)
    expect(packageById('lark-cli').license).toBe('MIT')
    expect(packageById('officecli').license).toBe('Apache-2.0')
  })

  it('requires managed npm artifact installation and SRI verification before activation', () => {
    const npmComponents = getOfficialMarketplaceCatalog()
      .flatMap((item) => item.components.map((component) => ({ item, component })))
      .filter(({ component }) => component.runtime.kind === 'npm')

    expect(npmComponents.length).toBeGreaterThan(0)
    for (const { item, component } of npmComponents) {
      if (component.runtime.kind !== 'npm') continue
      const source = item.sources.find((candidate) => candidate.id === component.sourceId)
      expect(source).toMatchObject({
        kind: 'npm',
        packageName: component.runtime.packageName,
        version: component.runtime.version,
        digest: { algorithm: 'sha512-sri' }
      })
      expect(component.runtime).not.toHaveProperty('integrity')
      expect(component.runtime).not.toHaveProperty('command', 'npx')
      expect(component.runtime.install).toEqual({
        strategy: 'managed-download',
        verify: 'sri-before-activation',
        digestSource: 'component-source'
      })
    }
  })

  it('recommends DBHub instead of stale GitHub, Postgres, browser, chat, and search servers', () => {
    const packages = getOfficialMarketplaceCatalog()
    const ids = packages.map((item) => item.id)
    const serialized = JSON.stringify(packages)
    const dbhub = packages.find((item) => item.id === 'dbhub')

    expect(dbhub?.components).toContainEqual(expect.objectContaining({
      runtime: expect.objectContaining({
        kind: 'npm',
        packageName: '@bytebase/dbhub'
      })
    }))
    expect(ids).not.toEqual(expect.arrayContaining([
      'github',
      'postgres',
      'puppeteer',
      'slack',
      'brave-search'
    ]))
    for (const stalePackage of [
      '@modelcontextprotocol/server-github',
      '@modelcontextprotocol/server-postgres',
      '@modelcontextprotocol/server-puppeteer',
      '@modelcontextprotocol/server-slack',
      '@modelcontextprotocol/server-brave-search'
    ]) {
      expect(serialized).not.toContain(stalePackage)
    }
  })

  it('shows system-managed packages without offering marketplace reinstall', () => {
    const packages = getOfficialMarketplaceCatalog()

    for (const id of ['lark-cli', 'officecli', 'ego-browser', 'markitdown', 'railwise-kb']) {
      const item = packages.find((candidate) => candidate.id === id)
      expect(item?.availability).toMatchObject({ status: 'managed' })
      expect(item?.installation).toEqual(expect.objectContaining({
        mode: 'system-managed',
        reinstallable: false
      }))
    }
  })

  it('keeps external catalogs searchable without mirroring or installing them by default', () => {
    const sources = getMarketplaceCatalogSources()
    const expected = new Map([
      ['openai-plugins', 'https://github.com/openai/plugins'],
      ['github-awesome-copilot', 'https://github.com/github/awesome-copilot'],
      ['wshobson-agents', 'https://github.com/wshobson/agents'],
      ['terminalskills-skills', 'https://github.com/TerminalSkills/skills'],
      ['vercel-labs-skills', 'https://github.com/vercel-labs/skills']
    ])

    for (const [id, location] of expected) {
      expect(sources).toContainEqual(expect.objectContaining({
        id,
        type: 'github',
        location,
        trust: 'external',
        searchable: true,
        sync: expect.objectContaining({
          mode: 'search-on-demand',
          mirroredByDefault: false,
          installedByDefault: false
        })
      }))
    }
  })

  it('registers the official MCP Registry as a watched non-mirroring source', () => {
    expect(getMarketplaceCatalogSources()).toContainEqual(expect.objectContaining({
      id: 'mcp-official-registry',
      type: 'mcp-registry',
      scope: 'system',
      location: 'https://registry.modelcontextprotocol.io/v0.1/servers',
      registry: 'official',
      trust: 'official',
      searchable: true,
      sync: expect.objectContaining({
        mode: 'watched',
        mirroredByDefault: false,
        installedByDefault: false
      })
    }))
  })

  it('keeps pending OAuth remotes unavailable and database writes denied pending review', () => {
    const packages = getOfficialMarketplaceCatalog()

    for (const id of ['notion-mcp', 'linear-mcp']) {
      const item = packages.find((candidate) => candidate.id === id)
      expect(item?.availability).toMatchObject({
        status: 'unavailable',
        reasonCode: 'oauth-discovery-pending'
      })
      expect(item?.auth).toMatchObject({ type: 'oauth', discovery: 'pending' })
    }

    for (const id of ['redis-mcp', 'mongodb-mcp']) {
      const item = packages.find((candidate) => candidate.id === id)
      expect(item?.permissions).toContainEqual(expect.objectContaining({
        access: 'write',
        default: 'denied',
        reviewRequired: true
      }))
    }
  })

  it('only assigns direct-mirror installation to allowlisted licenses', () => {
    const directMirrorPackages = getOfficialMarketplaceCatalog()
      .filter((item) => item.installation.mode === 'direct-mirror')

    expect(directMirrorPackages.length).toBeGreaterThan(0)
    for (const item of directMirrorPackages) {
      expect(evaluateMarketplaceLicense(item.license).disposition).toBe('direct-mirror')
    }
  })

  it('maintains unique IDs, immutable Git refs, coherent sources, and install modes', () => {
    const packages = getOfficialMarketplaceCatalog()
    const sources = getMarketplaceCatalogSources()

    expectUnique(sources.map((source) => source.id))
    expectUnique(packages.map((item) => item.id))
    expectUnique(packages.flatMap((item) => item.components.map((component) => component.id)))

    for (const item of packages) {
      expectUnique(item.sources.map((source) => source.id))
      expect(item.sources).toContainEqual(item.source)

      for (const source of item.sources) {
        if (source.kind === 'github' || source.kind === 'git') {
          expect(source.resolvedRef).toMatch(/^[0-9a-f]{40}$/)
        }
      }

      for (const component of item.components) {
        const source = item.sources.find((candidate) => candidate.id === component.sourceId)
        expect(source, `${item.id}/${component.id} has no source`).toBeDefined()
        if (!source) continue

        if (component.runtime.kind === 'npm') {
          expect(source).toMatchObject({
            kind: 'npm',
            packageName: component.runtime.packageName,
            version: component.runtime.version,
            digest: { algorithm: 'sha512-sri' }
          })
          expect(component.runtime.install.digestSource).toBe('component-source')
        }
        if (component.runtime.kind === 'github') {
          expect(source).toMatchObject({
            kind: 'github',
            resolvedRef: component.runtime.resolvedCommit
          })
        }
        if (component.runtime.kind === 'uv' && source.kind === 'pypi') {
          expect(source).toMatchObject({
            packageName: component.runtime.packageName,
            version: component.runtime.version,
            digest: component.runtime.install.digest
          })
        }
      }

      if (item.installation.mode === 'direct-mirror') {
        expect(item.availability.status).toBe('available')
        expect(item.installation.reinstallable).toBe(true)
        expect(evaluateMarketplaceLicense(item.license).disposition).toBe('direct-mirror')
      } else {
        expect(item.installation.reinstallable).toBe(false)
      }

      if (item.installation.mode === 'system-managed') {
        expect(item.availability.status).toBe('managed')
        expect(item.components.every((component) => component.runtime.kind === 'system')).toBe(true)
      }
    }
  })

  it('does not offer Anthropic document Skills as catalog packages', () => {
    const packages = getOfficialMarketplaceCatalog()
    const forbidden = new Set(['docx', 'pdf', 'pptx', 'xlsx'])

    expect(packages.some((item) =>
      item.publisher.id === 'anthropic' || forbidden.has(item.id)
    )).toBe(false)
  })

  it('returns deep fresh catalog and source values that isolate nested mutations', () => {
    const firstPackages = getOfficialMarketplaceCatalog()
    const firstSources = getMarketplaceCatalogSources()
    const originalName = firstPackages[0]?.name
    const originalDigest = firstPackages
      .flatMap((item) => item.sources)
      .find((source) => source.digest)?.digest?.value
    const originalSourceName = firstSources[0]?.name

    if (firstPackages[0]) firstPackages[0].name = 'mutated by caller'
    const mutableDigest = firstPackages
      .flatMap((item) => item.sources)
      .find((source) => source.digest)?.digest
    if (mutableDigest) mutableDigest.value = 'mutated digest'
    if (firstSources[0]) firstSources[0].name = 'mutated source'

    const nextPackages = getOfficialMarketplaceCatalog()
    const nextDigest = nextPackages
      .flatMap((item) => item.sources)
      .find((source) => source.digest)?.digest?.value
    expect(nextPackages[0]?.name).toBe(originalName)
    expect(nextDigest).toBe(originalDigest)
    expect(getMarketplaceCatalogSources()[0]?.name).toBe(originalSourceName)
  })
})
