import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { MarketplacePackageV1 } from '../../shared/marketplace'
import { readBoundedResponseBuffer } from './bounded-response'
import { systemFetch } from './system-network'

export const MAX_PACKAGE_LICENSE_BYTES = 2 * 1024 * 1024
const MAX_LICENSE_METADATA_BYTES = 3 * 1024 * 1024

export function isPackageLicenseName(path: string): boolean {
  return /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(basename(path))
}

export async function readCatalogLicenseEvidence(
  item: MarketplacePackageV1,
  fetchImpl: typeof fetch = systemFetch,
  requireDigest = false
): Promise<Buffer | null> {
  const evidence = item.licenseEvidence.find(candidate => candidate.required && candidate.includeInInstall &&
    candidate.license === item.license && isPackageLicenseName(candidate.path))
  const source = item.sources.find(candidate => candidate.id === evidence?.sourceId)
  if (!evidence || source?.kind !== 'github' || !/^[0-9a-f]{40}$/i.test(source.resolvedRef)) return null
  if ((requireDigest || evidence.sha256 !== undefined) && !/^[0-9a-f]{64}$/.test(evidence.sha256 ?? '')) {
    throw new Error('Catalog license evidence must have a pinned SHA-256 digest.')
  }
  const segments = evidence.path.replaceAll('\\', '/').split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Catalog license evidence path is unsafe.')
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(source.owner) || !/^[A-Za-z0-9_.-]+$/.test(source.repository) ||
      source.owner === '.' || source.owner === '..' || source.repository === '.' || source.repository === '..') {
    throw new Error('Catalog license evidence source is invalid.')
  }
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/contents/${segments.map(encodeURIComponent).join('/')}`)
  url.searchParams.set('ref', source.resolvedRef)
  const requestInit: RequestInit = {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RailWise AI' },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000)
  }
  let response: Response | undefined
  try {
    response = await fetchImpl(url.href, requestInit)
  } catch {
    // The raw endpoint below is pinned to the same immutable commit and path.
  }
  if (response && response.url !== url.href) {
    throw new Error('Catalog license evidence URL does not match its pinned source.')
  }

  let bytes: Buffer
  if (response?.ok) {
    const metadata = JSON.parse((await readBoundedResponseBuffer(response, MAX_LICENSE_METADATA_BYTES, 'Catalog license evidence')).toString('utf8')) as {
      type?: unknown; path?: unknown; size?: unknown; encoding?: unknown; content?: unknown
    }
    const encoded = typeof metadata.content === 'string' ? metadata.content.replace(/\s/g, '') : ''
    if (metadata.type !== 'file' || metadata.path !== segments.join('/') || metadata.encoding !== 'base64' ||
        typeof metadata.size !== 'number' || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_PACKAGE_LICENSE_BYTES ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('Catalog license evidence metadata is invalid.')
    }
    bytes = Buffer.from(encoded, 'base64')
    if (bytes.byteLength !== metadata.size) {
      throw new Error('Catalog license evidence bytes do not match the reviewed size or SHA-256.')
    }
  } else {
    const rawUrl = new URL(`https://raw.githubusercontent.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/${source.resolvedRef}/${segments.map(encodeURIComponent).join('/')}`)
    const rawResponse = await fetchImpl(rawUrl.href, {
      headers: { 'User-Agent': 'RailWise AI' },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
    if (rawResponse.url !== rawUrl.href) {
      throw new Error('Catalog license evidence URL does not match its pinned source.')
    }
    if (!rawResponse.ok) throw new Error(`Catalog license evidence request failed (${response?.status ?? 'network error'}, raw ${rawResponse.status}).`)
    bytes = await readBoundedResponseBuffer(rawResponse, MAX_PACKAGE_LICENSE_BYTES, 'Catalog license evidence')
    if (bytes.byteLength < 1) throw new Error('Catalog license evidence bytes are empty.')
  }
  if (evidence.sha256 && createHash('sha256').update(bytes).digest('hex') !== evidence.sha256) {
    throw new Error('Catalog license evidence bytes do not match the reviewed size or SHA-256.')
  }
  return bytes
}
