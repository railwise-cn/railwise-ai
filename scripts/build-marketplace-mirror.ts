import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import type { MarketplacePackageV1 } from '../src/shared/marketplace'
import { declaredMarketplaceSkills, marketplaceSkillReadiness } from '../src/shared/marketplace-skill-readiness'
import { SkillRuntime } from '../kun/src/skills/skill-runtime'
import { marketplacePackageSkillRoots } from '../src/main/services/skill-service'
import { getOfficialMarketplaceCatalog } from '../src/main/services/official-marketplace-catalog'
import { assertMirroredPackage, type MirroredPackage, type MirrorPart } from '../src/main/services/marketplace-mirror'
import { inspectPackageDirectory, marketplacePackageReviewSha256, packageInstallLimitsFor } from '../src/main/services/package-installation-service'
import { inspectPluginArchive, MARKETPLACE_MIRROR_PART_BYTES } from '../src/main/services/plugin-archive-security'
import { materializeCatalogUpstreamForMirror } from '../src/main/services/plugin-management-service'

const fixedDate = new Date('2000-01-01T00:00:00.000Z')
const partTarget = 48 * 1024 * 1024
const partEntryTarget = 2_048

async function preparePackage(item: MarketplacePackageV1, output: string, scratch: string): Promise<MirroredPackage> {
  const directory = join(scratch, item.id)
  await materializeCatalogUpstreamForMirror(item, directory)
  try {
    const tree = await inspectPackageDirectory(directory, packageInstallLimitsFor(item))
    const names = declaredMarketplaceSkills(item.components, item)
    if (names !== undefined) {
      const roots = await marketplacePackageSkillRoots(directory)
      const runtime = await SkillRuntime.create({ enabled: true, roots, legacySkillMd: true }, { discoveryWaitMs: 15_000 })
      if (marketplaceSkillReadiness(runtime.diagnostics(), directory, names) !== 'loaded') {
        throw new Error(`Package ${item.id} does not provide its declared callable skills: ${names.join(', ')}`)
      }
    }
    const parts: MirrorPart[] = []
    let zip = new JSZip()
    let size = 0
    let entries = 0
    async function flush() {
      if (!entries) return
      const bytes = await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', streamFiles: false })
      if (bytes.byteLength > MARKETPLACE_MIRROR_PART_BYTES) throw new Error(`Archive part is too large: ${item.id}`)
      inspectPluginArchive(bytes, { verifiedMirrorPart: true })
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await writeFile(join(output, `${sha256}.zip`), bytes)
      parts.push({ sha256, size: bytes.byteLength })
      zip = new JSZip()
      size = 0
      entries = 0
    }
    for (const path of tree.paths.sort()) {
      const absolute = join(directory, ...path.split('/'))
      const info = await lstat(absolute)
      if (size + info.size > partTarget || entries === partEntryTarget) await flush()
      const bytes = await readFile(absolute)
      const deflated = deflateRawSync(bytes)
      const compression = deflated.length < bytes.length && bytes.length <= deflated.length * 400 ? 'DEFLATE' : 'STORE'
      zip.file(path, bytes, { compression, date: fixedDate, unixPermissions: info.mode, createFolders: false })
      size += bytes.length
      entries += 1
    }
    await flush()
    const record = { packageId: item.id, reviewSha256: marketplacePackageReviewSha256(item),
      platform: process.platform, arch: process.arch, parts }
    assertMirroredPackage(record)
    return record
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function build() {
  if (!process.argv[2]) throw new Error('An output directory is required.')
  const output = resolve(process.argv[2])
  const ids = new Set(process.argv.slice(3))
  const targets = getOfficialMarketplaceCatalog().filter(item => item.installation?.mode === 'direct-mirror' &&
    item.compatibility.platforms.includes(process.platform as 'darwin' | 'win32' | 'linux') &&
    item.compatibility.architectures.includes(process.arch as 'arm64' | 'x64') && (!ids.size || ids.has(item.id)))
  if (!targets.length || (ids.size > 0 && ids.size !== targets.length)) throw new Error('Invalid marketplace build target.')
  await mkdir(output, { recursive: true })
  const scratch = await mkdtemp(join(tmpdir(), 'railwise-mirror-'))
  const records: MirroredPackage[] = []
  const errors: Array<{ packageId: string; message: string }> = []
  try {
    for (const target of targets) {
      console.log(`Preparing ${target.id} ${target.version} on ${process.platform}-${process.arch}`)
      try {
        records.push(await preparePackage(target, output, scratch))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`Marketplace preparation failed for ${target.id}: ${message}`)
        errors.push({ packageId: target.id, message })
      }
    }
    await writeFile(join(output, 'marketplace-lock.json'), `${JSON.stringify({ version: 1, packages: records }, null, 2)}\n`)
    if (errors.length) {
      await writeFile(join(output, 'build-errors.json'), `${JSON.stringify(errors, null, 2)}\n`)
      throw new Error(`${errors.length} of ${targets.length} marketplace packages failed on ${process.platform}-${process.arch}.`)
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

void build().catch(error => { console.error(error); process.exitCode = 1 })
