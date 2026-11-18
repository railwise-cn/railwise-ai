import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MARKETPLACE_MIRROR_BASE, marketplaceMirrorPath, materializeMarketplaceMirror, mirrorRecordFor } from './marketplace-mirror'
import { getOfficialMarketplaceCatalog } from './official-marketplace-catalog'
import { marketplacePackageReviewSha256 } from './package-installation-service'
import { materializeCatalogPackage } from './plugin-management-service'

const packageItem = getOfficialMarketplaceCatalog().find(item => item.id === 'video-shotcraft')!
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

  it('uses no upstream fallback when the shipped lock lacks the package', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected upstream') }))
    const unknownRevision = { ...packageItem, version: 'missing-from-lock' }
    await expect(materializeCatalogPackage(unknownRevision, await target())).rejects.toThrow('睿威官方镜像')
    expect(fetch).not.toHaveBeenCalled()
  })
})
