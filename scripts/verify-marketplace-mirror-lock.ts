import lock from '../src/shared/marketplace-mirror-lock.json'
import { getOfficialMarketplaceCatalog } from '../src/main/services/official-marketplace-catalog'
import { assertMirroredPackage, type MirroredPackage } from '../src/main/services/marketplace-mirror'
import { marketplacePackageReviewSha256 } from '../src/main/services/package-installation-service'

const targets = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' }
] as const

const keyFor = ({ platform, arch, packageId }: Pick<MirroredPackage, 'platform' | 'arch' | 'packageId'>) => `${platform}-${arch}/${packageId}`

function verifyMarketplaceLock(): void {
  if (lock.version !== 1 || !Array.isArray(lock.packages)) throw new Error('Unsupported marketplace mirror lock.')
  const expected = new Map<string, string>()
  for (const item of getOfficialMarketplaceCatalog()) {
    if (item.installation?.mode !== 'direct-mirror') continue
    for (const target of targets) {
      if (!item.compatibility.platforms.includes(target.platform) || !item.compatibility.architectures.includes(target.arch)) continue
      expected.set(keyFor({ ...target, packageId: item.id }), marketplacePackageReviewSha256(item))
    }
  }
  if (expected.size === 0) throw new Error('Official marketplace mirror coverage could not be determined.')
  for (const record of lock.packages as MirroredPackage[]) {
    assertMirroredPackage(record)
    const key = keyFor(record)
    if (expected.get(key) !== record.reviewSha256) throw new Error(`Unexpected, duplicate or stale marketplace mirror record: ${key}`)
    expected.delete(key)
  }
  if (expected.size > 0) throw new Error(`Marketplace mirror coverage is incomplete: ${[...expected.keys()].join(', ')}`)
  console.log(`Verified ${lock.packages.length} locked platform/package pairs against the official catalog.`)
}

verifyMarketplaceLock()
