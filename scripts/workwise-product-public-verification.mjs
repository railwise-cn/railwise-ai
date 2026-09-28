import { basename } from 'node:path'
import { setTimeout } from 'node:timers/promises'

const PRODUCT_URL = 'https://www.railwise.cn/products/workwise/'

export async function verifyProductPublication(manifest, {
  fetcher = fetch,
  attempts = 10,
  delay = () => setTimeout(5_000),
  log = console.log
} = {}) {
  const version = manifest.version
  const required = [
    `softwareVersion":"v${version}`,
    `${manifest.name || 'WorkWise'} v${version} 已发布`,
    `releases/tag/v${version}`,
    ...manifest.platforms.map((item) => item.url)
  ]
  let verified = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Check the normal user URL as well as a cache-busting request. A fresh
      // query response alone must not mask an outdated default download page.
      for (const url of [PRODUCT_URL, `${PRODUCT_URL}?release=${encodeURIComponent(version)}&t=${Date.now()}`]) {
        const response = await fetcher(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
        if (!response.ok) throw new Error(`Product page returned HTTP ${response.status}.`)
        const html = await response.text()
        const observed = html.match(/"softwareVersion"\s*:\s*"([^"]+)"/)?.[1] || 'missing'
        for (const value of required) {
          if (!html.includes(value)) throw new Error(`Observed page version ${observed}; missing expected content: ${value}`)
        }
      }
      const response = await fetcher(new URL('/data/workwise-product.json', PRODUCT_URL), { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`Public manifest returned HTTP ${response.status}.`)
      const live = await response.json()
      if (live.version !== version || live.releaseCommit !== manifest.releaseCommit) {
        throw new Error(`Public manifest version ${live.version}; release commit matches: ${live.releaseCommit === manifest.releaseCommit}`)
      }
      for (const expected of manifest.platforms) {
        const actual = live.platforms?.find((item) => item.file === expected.file)
        if (actual?.url !== expected.url || actual?.sha256 !== expected.sha256) throw new Error(`Public installer metadata mismatch: ${expected.file}`)
      }
      verified = true
      break
    } catch (error) {
      log(`Public verification attempt ${attempt}/${attempts}: ${error.message}`)
      if (attempt === attempts) throw error
      await delay()
    }
  }
  if (!verified) throw new Error('No public verification attempt completed.')
  for (const item of manifest.platforms) {
    const url = new URL(item.url, PRODUCT_URL)
    const range = await fetcher(url, {
      headers: { Range: 'bytes=0-1023' }, redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(30_000)
    })
    if (range.status !== 206 || !/^bytes 0-\d+\/\d+$/i.test(range.headers.get('content-range') || '')) {
      throw new Error(`Installer Range verification failed for ${basename(url.pathname)}.`)
    }
    await range.arrayBuffer()
  }
  log(`Verified public WorkWise product page, manifest and three immutable ${version} installers.`)
}
