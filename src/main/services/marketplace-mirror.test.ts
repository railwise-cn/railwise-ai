import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MARKETPLACE_MIRROR_BASE, marketplaceMirrorPath, materializeMarketplaceMirror, mirrorRecordFor } from './marketplace-mirror'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { marketplacePackageReviewSha256, PackageInstallationService } from './package-installation-service'
import { materializeCatalogPackage, PluginManagementService } from './plugin-management-service'
import type { MarketplacePackageV1 } from '../../shared/marketplace'
import { SkillRuntime } from '../../../kun/src/skills/skill-runtime'
import { declaredMarketplaceSkills, marketplaceSkillReadiness } from '../../shared/marketplace-skill-readiness'
import { marketplacePackageSkillRoots } from './skill-service'

const packageItem = getOfficialMarketplaceCatalog().find(item => item.id === 'video-shotcraft')!
const SUPERPOWERS_PREVIOUS_COMMIT = '44c9b2d6e889982ac18c27d05a19fefe335194e1'
const temporary: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function target() {
  const root = await mkdtemp(join(tmpdir(), 'marketplace-mirror-test-'))
  temporary.push(root)
  return join(root, 'package')
}

async function archive(path: string, content: string) {
  const bytes = await new JSZip().file(path, content).generateAsync({ type: 'nodebuffer' })
  return { bytes, part: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } }
}

function previousSuperpowersItem(item: MarketplacePackageV1): MarketplacePackageV1 {
  return {
    ...item,
    version: `${SUPERPOWERS_PREVIOUS_COMMIT}-railwise.1`,
    source: { ...item.source, resolvedRef: SUPERPOWERS_PREVIOUS_COMMIT },
    sources: item.sources.map(source => ({ ...source, resolvedRef: SUPERPOWERS_PREVIOUS_COMMIT })),
    components: item.components.map(component => {
      if (component.id !== 'superpowers-skills' || component.type !== 'skill' || component.runtime.kind !== 'github') return component
      return {
        ...component,
        skillNames: ['using-superpowers'],
        runtime: { ...component.runtime, resolvedCommit: SUPERPOWERS_PREVIOUS_COMMIT }
      }
    })
  }
}

describe('official marketplace mirror', () => {
  it('assembles verified parts using only the first-party download host', async () => {
    const main = await archive('SKILL.md', '# Main Skill')
    const reference = await archive('references/guide.md', '# Reference')
    const record = { packageId: packageItem.id, reviewSha256: marketplacePackageReviewSha256(packageItem),
      platform: process.platform, arch: process.arch, parts: [main.part, reference.part] }
    const download = vi.fn(async (url: string | URL | Request) => {
      const part = [main, reference].find(file => url === `${MARKETPLACE_MIRROR_BASE}/${marketplaceMirrorPath(file.part.sha256)}`)
      if (!part) throw new Error('unexpected network request')
      return new Response(new Uint8Array(part.bytes))
    })
    const directory = await target()
    expect(mirrorRecordFor(packageItem, [record])).toBe(record)
    expect(mirrorRecordFor({ ...packageItem, version: 'other' }, [record])).toBeUndefined()
    await materializeMarketplaceMirror(packageItem, record, directory, download)
    expect(await readFile(join(directory, 'references', 'guide.md'), 'utf8')).toBe('# Reference')
    expect(download).toHaveBeenCalledTimes(2)
    expect(download.mock.calls[0]?.[0]).toContain('www.railwise.cn')
  })

  it('rejects modified bytes and duplicate paths across otherwise locked parts', async () => {
    const main = await archive('SKILL.md', '# Main')
    const duplicate = await archive('skill.md', '# Duplicate')
    const record = { packageId: packageItem.id, reviewSha256: marketplacePackageReviewSha256(packageItem),
      platform: process.platform, arch: process.arch, parts: [main.part, duplicate.part] }
    await expect(materializeMarketplaceMirror(packageItem, record, await target(), async () => new Response('modified')))
      .rejects.toThrow('SHA-256')
    let index = 0
    await expect(materializeMarketplaceMirror(packageItem, record, await target(), async () => new Response(new Uint8Array([main, duplicate][index++]!.bytes))))
      .rejects.toThrow('duplicate file')
  })

  it.each([['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']] as const)(
    'uses the exact bundled Superpowers archive without network on %s %s',
    async (platform, arch) => {
      const item = getOfficialMarketplaceCatalog().find(entry => entry.id === 'superpowers')!
      const record = mirrorRecordFor(item, undefined, platform, arch)!
      const download = vi.fn<typeof fetch>(async () => { throw new Error('offline') })
      const directory = await target()
      await materializeMarketplaceMirror(item, record, directory, download)
      expect(download).not.toHaveBeenCalled()
      expect(await readFile(join(directory, 'LICENSE'), 'utf8')).toContain('MIT License')
      const roots = await marketplacePackageSkillRoots(directory)
      const skills = (await SkillRuntime.create({ enabled: true, roots, legacySkillMd: true })).diagnostics()
      expect(skills.skills).toHaveLength(15)
      expect(marketplaceSkillReadiness(skills, directory, declaredMarketplaceSkills(item.components, item)!)).toBe('loaded')
      const oldItem = previousSuperpowersItem(item)
      expect(marketplaceSkillReadiness(skills, directory, declaredMarketplaceSkills(oldItem.components, oldItem)!)).toBe('loaded')
    }
  )

  it('keeps the previous reviewed Superpowers installation and workspace when applying the declaration upgrade', async () => {
    const item = getOfficialMarketplaceCatalog().find(entry => entry.id === 'superpowers')!
    const oldItem = previousSuperpowersItem(item)
    const oldReview = marketplacePackageReviewSha256(oldItem)
    expect(oldReview).toBe('f65a56ea8d796994dcb02a9b0ca3955938f816e52410124167eb8b4d2b084e2c')
    const record = mirrorRecordFor(item, undefined, 'win32', 'x64')!
    const root = await target()
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'existing.md'), 'Existing user file')
    const installations = new PackageInstallationService({ rootDirectory: join(root, 'plugin-data') })
    const service = new PluginManagementService({
      rootDirectory: join(root, 'imports'),
      installationService: installations,
      catalogMaterializer: (candidate, directory) => materializeMarketplaceMirror(candidate, {
        ...record, reviewSha256: marketplacePackageReviewSha256(candidate)
      }, directory, async () => { throw new Error('unexpected network') })
    })
    const before = await service.prepareCatalogPackage(oldItem)
    const initial = await service.installPrepared({
      preparedId: before.id, reviewSha256: before.reviewSha256, expectedCurrentVersion: null,
      scope: 'workspace', workspaceRoot: workspace, permissions: [], idempotencyKey: 'before-declaration-upgrade'
    })
    const after = await service.prepareCatalogPackage(item)
    const upgraded = await service.installPrepared({
      preparedId: after.id, reviewSha256: after.reviewSha256, expectedCurrentVersion: initial.version,
      scope: 'workspace', workspaceRoot: workspace, permissions: [], idempotencyKey: 'after-declaration-upgrade'
    })
    expect(upgraded).toMatchObject({
      scope: 'workspace', workspaceRoot: await realpath(workspace),
      rollback: { available: true, reviewSha256: before.reviewSha256, artifact: initial.artifact }
    })
    const reverted = await service.rollback({ packageId: item.id, expectedCurrentVersion: item.version, idempotencyKey: 'revert-declaration-upgrade' })
    expect(reverted).toMatchObject({ version: oldItem.version, artifact: initial.artifact,
      workspaceRoot: await realpath(workspace), reviewSha256: oldReview })
    expect(await readFile(join(workspace, 'existing.md'), 'utf8')).toBe('Existing user file')
  }, 30_000)

  it('uses no upstream fallback when the shipped lock lacks the package', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected upstream') }))
    const unknownRevision = { ...packageItem, version: 'missing-from-lock' }
    await expect(materializeCatalogPackage(unknownRevision, await target())).rejects.toThrow('睿威官方镜像')
    expect(fetch).not.toHaveBeenCalled()
  })
})
