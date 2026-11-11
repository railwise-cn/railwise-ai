import { createHash } from 'node:crypto'
import manifest from '../../shared/managed-dependencies.json'
import { readBoundedResponseBuffer } from './bounded-response'
import { systemFetch } from './system-network'

export type ManagedDependency = typeof manifest.files[number]
const sourceHosts = new Set(['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'files.pythonhosted.org', 'www.python.org', 'www.railwise.cn'])

export function managedDependency(id: string): ManagedDependency {
  const asset = manifest.files.find(item => item.id === id)
  if (!asset) throw new Error(`No verified managed dependency is registered for ${id}.`)
  return asset
}

export function findManagedDependency(sourceUrl: string): ManagedDependency | undefined {
  return manifest.files.find(item => item.sourceUrl === sourceUrl)
}

export function dependencyDownloadUrls(asset: ManagedDependency): string[] {
  return [`${manifest.publicBase}/${asset.mirrorPath.split('/').map(encodeURIComponent).join('/')}`, asset.sourceUrl]
}

function assertSource(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !sourceHosts.has(url.hostname) || url.username || url.password) {
    throw new Error('Managed dependency download must remain on an approved HTTPS source.')
  }
}

/** Both delivery paths must produce the exact upstream bytes recorded in the application. */
export async function downloadManagedDependency(asset: ManagedDependency, fetchImpl: typeof fetch = systemFetch): Promise<Buffer> {
  let lastError: unknown
  for (const [index, url] of dependencyDownloadUrls(asset).entries()) {
    try {
      assertSource(url)
      const response = await fetchImpl(url, { headers: { 'User-Agent': 'RailWise AI' }, redirect: 'follow',
        signal: AbortSignal.timeout(index === 0 ? 90_000 : 120_000) })
      if (!response.ok) throw new Error(`Managed dependency download failed (${response.status}).`)
      assertSource(response.url || url)
      const bytes = await readBoundedResponseBuffer(response, asset.size + 1, 'Managed dependency')
      if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
        throw new Error('Managed dependency size or SHA-256 verification failed.')
      }
      return bytes
    } catch (error) { lastError = error }
  }
  throw lastError instanceof Error ? lastError : new Error('Managed dependency download failed.')
}

export function managedPythonDownload(target: string) {
  const entry = manifest.pythonDownloads[target as keyof typeof manifest.pythonDownloads]
  if (!entry) throw new Error(`No verified managed Python build is registered for ${target}.`)
  return entry
}
