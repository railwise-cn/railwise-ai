import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { marketplaceHasBundledPayload, type MarketplacePackageV1 } from '../../shared/marketplace'
import { MarketplaceInstallError } from '../../shared/marketplace-install-errors'
import lock from '../../shared/marketplace-mirror-lock.json'
import { readBoundedResponseBuffer } from './bounded-response'
import { inspectPackageDirectory, marketplacePackageReviewSha256, packageInstallLimitsFor } from './package-installation-service'
import { extractPluginArchive, inspectPluginArchive, MARKETPLACE_MIRROR_PART_BYTES } from './plugin-archive-security'
import { systemFetch } from './system-network'

export const MARKETPLACE_MIRROR_BASE = 'https://www.railwise.cn/downloads/railwise-ai/dependencies'
const hexDigest = /^[0-9a-f]{64}$/
export const MARKETPLACE_MIRROR_RECEIPT = 'workwise.mirror.json'

export type MirrorPart = { sha256: string; size: number }
export type MirroredPackage = {
  packageId: string
  reviewSha256: string
  platform: string
  arch: string
  parts: MirrorPart[]
}

export function marketplaceMirrorPath(sha256: string): string {
  if (!hexDigest.test(sha256)) throw new Error('Invalid marketplace mirror digest.')
  return `marketplace/1/${sha256}/payload.zip`
}

export function assertMirroredPackage(record: MirroredPackage): void {
  if (!record || !hexDigest.test(record.reviewSha256) ||
      !/^[a-z0-9][-a-z0-9.]*$/.test(record.packageId) ||
      !['darwin', 'win32', 'linux'].includes(record.platform) || !['arm64', 'x64'].includes(record.arch) ||
      !Array.isArray(record.parts) || record.parts.length === 0 || record.parts.length > 128 ||
      new Set(record.parts.map(part => part.sha256)).size !== record.parts.length ||
      record.parts.some(part => !hexDigest.test(part.sha256) || !Number.isSafeInteger(part.size) || part.size < 1 || part.size > MARKETPLACE_MIRROR_PART_BYTES)) {
    throw new Error('Marketplace mirror record is invalid.')
  }
}

export function mirrorRecordFor(
  item: MarketplacePackageV1,
  records: readonly MirroredPackage[] = lock.packages,
  platform = process.platform,
  arch = process.arch
): MirroredPackage | undefined {
  const reviewSha256 = marketplacePackageReviewSha256(item)
  const candidates = records.filter(entry => entry.packageId === item.id && entry.platform === platform && entry.arch === arch)
  if (candidates.length > 1) throw new Error('Duplicate marketplace mirror records.')
  const record = candidates[0]
  if (!record || record.reviewSha256 !== reviewSha256) return undefined
  assertMirroredPackage(record)
  return record
}

function mirrorReceipt(record: MirroredPackage): string {
  return JSON.stringify({
    schemaVersion: 1,
    packageId: record.packageId,
    reviewSha256: record.reviewSha256,
    platform: record.platform,
    arch: record.arch,
    parts: record.parts.map(({ sha256, size }) => ({ sha256, size }))
  }) + '\n'
}

export async function hasMarketplaceMirrorReceipt(directory: string, record: MirroredPackage): Promise<boolean> {
  const expected = mirrorReceipt(record)
  const path = join(directory, MARKETPLACE_MIRROR_RECEIPT)
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink() && info.size === Buffer.byteLength(expected)
      && await readFile(path, 'utf8') === expected
  } catch {
    return false
  }
}

export function bundledMarketplaceArchivePath(sha256: string): string {
  if (!hexDigest.test(sha256)) throw new Error('Invalid marketplace mirror digest.')
  const resourceDirectory = process.resourcesPath && !process.defaultApp
    ? join(process.resourcesPath, 'marketplace-offline')
    : join(process.cwd(), 'src', 'asset', 'marketplace-offline')
  return join(resourceDirectory, `${sha256}.zip`)
}

async function readMarketplacePart(
  part: MirrorPart,
  bundled: boolean,
  fetcher: typeof fetch
): Promise<Buffer> {
  if (bundled) {
    const path = bundledMarketplaceArchivePath(part.sha256)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== part.size) {
        throw new Error('Invalid bundled archive size or path.')
      }
      return await readFile(path)
    } catch (error) {
      throw new MarketplaceInstallError('bundled-package-damaged', 'The bundled RailWise archive failed verification.', error)
    }
  }
  const url = `${MARKETPLACE_MIRROR_BASE}/${marketplaceMirrorPath(part.sha256)}`
  let response: Response
  try {
    response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) })
    if (!response.ok || (response.url !== '' && response.url !== url)) {
      throw new Error(`RailWise marketplace download failed (${response.status}).`)
    }
  } catch (error) {
    throw new MarketplaceInstallError('download-unavailable', 'RailWise marketplace download failed.', error)
  }
  try {
    return await readBoundedResponseBuffer(response, part.size, 'RailWise marketplace archive')
  } catch (error) {
    if (error instanceof Error && error.message === 'RailWise marketplace archive exceeds its size limit.') {
      throw new MarketplaceInstallError('verification-failed', error.message, error)
    }
    throw new MarketplaceInstallError('download-unavailable', 'The RailWise marketplace download did not complete.', error)
  }
}

export async function materializeMarketplaceMirror(
  item: MarketplacePackageV1,
  record: MirroredPackage,
  directory: string,
  fetcher: typeof fetch = systemFetch
): Promise<void> {
  assertMirroredPackage(record)
  if (record.packageId !== item.id || record.reviewSha256 !== marketplacePackageReviewSha256(item)) {
    throw new Error('Marketplace mirror does not match the package being reviewed.')
  }
  const limits = packageInstallLimitsFor(item)
  const paths = new Set<string>()
  let expandedBytes = 0
  const bundled = marketplaceHasBundledPayload(item)
  for (const part of record.parts) {
    const buffer = await readMarketplacePart(part, bundled, fetcher)
    if (buffer.byteLength !== part.size || createHash('sha256').update(buffer).digest('hex') !== part.sha256) {
      throw new MarketplaceInstallError(bundled ? 'bundled-package-damaged' : 'verification-failed',
        'RailWise marketplace archive failed size or SHA-256 verification.')
    }
    const options = { verifiedMirrorPart: true } as const
    const index = inspectPluginArchive(buffer, options)
    expandedBytes += index.uncompressedBytes
    if (expandedBytes > limits.maxTotalBytes) throw new Error('Marketplace mirror exceeds its expanded size limit.')
    for (const entry of index.entries) {
      if (entry.directory) continue
      const key = entry.path.normalize('NFC').toLowerCase()
      if (paths.has(key) || key === 'workwise.catalog.json' || key === MARKETPLACE_MIRROR_RECEIPT || entry.uncompressedBytes > limits.maxFileBytes) {
        throw new Error('Marketplace mirror contains an invalid or duplicate file.')
      }
      paths.add(key)
      if (paths.size > limits.maxFiles) throw new Error('Marketplace mirror exceeds its file count limit.')
    }
    await extractPluginArchive(buffer, directory, options)
  }
  await inspectPackageDirectory(directory, limits)
  await writeFile(join(directory, MARKETPLACE_MIRROR_RECEIPT), mirrorReceipt(record), { flag: 'wx', mode: 0o600 })
}
