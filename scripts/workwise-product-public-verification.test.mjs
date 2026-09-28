import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { verifyProductPublication } from './workwise-product-public-verification.mjs'

const manifest = JSON.parse(readFileSync(new URL('../website/data/workwise-product.json', import.meta.url)))
const html = `"softwareVersion":"v${manifest.version}" ${manifest.name} v${manifest.version} 已发布 releases/tag/v${manifest.version} ${manifest.platforms.map((item) => item.url).join(' ')}`
const options = { attempts: 2, delay: async () => {}, log: () => {} }
const goodResponse = (url) => {
  if (String(url).includes('/data/')) return Response.json(manifest)
  if (String(url).includes('/releases/')) return new Response('data', { status: 206, headers: { 'content-range': 'bytes 0-3/100' } })
  return new Response(html)
}

test('retries a stale normal page and verifies both URLs, manifest and all installers', async () => {
  const calls = []
  await verifyProductPublication(manifest, { ...options, fetcher: async (url) => {
    calls.push(String(url))
    return calls.length === 1 ? new Response('"softwareVersion":"v0.5.0"') : goodResponse(url)
  } })
  assert.equal(calls.filter((url) => url.endsWith('/products/workwise/')).length, 2)
  assert.equal(calls.filter((url) => url.includes('?release=')).length, 1)
  assert.equal(calls.filter((url) => url.includes('/releases/')).length, 3)
})

test('persistent stale default URL fails even when cache-busting URL would be fresh', async () => {
  let attempts = 0
  await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) => {
    attempts++
    return String(url).endsWith('/products/workwise/') ? new Response('"softwareVersion":"v0.5.0"') : goodResponse(url)
  } }), /Observed page version v0.5.0/)
  assert.equal(attempts, 2)
})

test('correct page cannot mask an old public manifest or wrong installer hash', async () => {
  for (const bad of [
    { ...manifest, version: '0.5.0' },
    { ...manifest, platforms: manifest.platforms.map((p, i) => i ? p : { ...p, sha256: '0'.repeat(64) }) }
  ]) {
    await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) =>
      String(url).includes('/data/') ? Response.json(bad) : goodResponse(url)
    }), /Public manifest version|Public installer metadata mismatch/)
  }
})

test('missing download content and unsupported Range responses remain failures', async () => {
  await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) =>
    String(url).includes('/products/') ? new Response(html.replace(manifest.platforms[0].url, '')) : goodResponse(url)
  }), /missing expected content/)
  await assert.rejects(verifyProductPublication(manifest, { ...options, fetcher: async (url) =>
    String(url).includes('/releases/') ? new Response('full file', { status: 200 }) : goodResponse(url)
  }), /Installer Range verification failed/)
})
