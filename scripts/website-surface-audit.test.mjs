import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditWebsitePage, compareWebsiteSources, fontHasCodePoint } from './website-surface-audit.mjs'

function tinyFont() {
  // One sfnt table, one Unicode BMP cmap, glyph U+F044 -> 1 plus terminal segment.
  const font = Buffer.alloc(72)
  font.writeUInt32BE(0x10000, 0); font.writeUInt16BE(1, 4)
  font.write('cmap', 12); font.writeUInt32BE(28, 20); font.writeUInt32BE(44, 24)
  font.writeUInt16BE(1, 30); font.writeUInt16BE(3, 32); font.writeUInt16BE(1, 34); font.writeUInt32BE(12, 36)
  const start = 40
  font.writeUInt16BE(4, start); font.writeUInt16BE(32, start + 2); font.writeUInt16BE(4, start + 6)
  font.writeUInt16BE(0xf044, start + 14); font.writeUInt16BE(0xffff, start + 16)
  font.writeUInt16BE(0xf044, start + 20); font.writeUInt16BE(0xffff, start + 22)
  font.writeUInt16BE((1 - 0xf044) & 0xffff, start + 24); font.writeUInt16BE(1, start + 26)
  return font
}

test('detects an absent icon even when CSS resolves and the font is loaded', async () => {
  const doc = { url: 'https://www.railwise.cn/', title: 'test', unreadableStylesheets: 0,
    nav: [{ text: 'RailWise AI', url: 'https://www.railwise.cn/products/railwise-ai/' }], images: [],
    icons: [{ classes: 'fa-missing', codePoints: [0xe000], family: 'Test', weight: '900', fontLoaded: true }],
    cssFonts: [{ family: 'Test', weight: '900', sources: ['https://www.railwise.cn/font.ttf'] }] }
  const report = await auditWebsitePage({ evaluate: async () => doc }, { fetcher: async url => new Response(url.endsWith('ttf') ? tinyFont() : 'ok') })
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.failures, ['Missing glyph U+e000: fa-missing'])
})

test('checks real Unicode maps and rejects malformed table bounds', () => {
  assert.equal(fontHasCodePoint(tinyFont(), 0xf044), true)
  assert.equal(fontHasCodePoint(tinyFont(), 0xe000), false)
  assert.equal(fontHasCodePoint(tinyFont(), 0xffff), false)
  const damaged = tinyFont(); damaged.writeUInt32BE(0xffff, 20)
  assert.throws(() => fontHasCodePoint(damaged, 0xf044), /bounds/)
})

test('keeps missing images, external redirects and unknown font coverage explicit', async () => {
  const doc = { url: 'https://www.railwise.cn/', title: 'test', unreadableStylesheets: 1,
    nav: [{ text: 'WorkWise', url: 'https://www.railwise.cn/products/' }],
    images: [{ declaredSource: true, loaded: false, deferred: false, url: 'https://www.railwise.cn/missing.png' }],
    icons: [{ classes: 'fa-unknown', codePoints: [0xf044], family: 'Test', weight: '900', fontLoaded: true }], cssFonts: [] }
  let requests = 0
  const report = await auditWebsitePage({ evaluate: async () => doc }, { fetcher: async url => {
    requests++
    if (url.endsWith('.png')) return new Response('not found', { status: 404 })
    return new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } })
  } })
  assert.equal(report.status, 'failed')
  assert(report.failures.some(value => value.includes('Legacy product name')))
  assert(report.failures.some(value => value.includes('Image unavailable')))
  assert(report.failures.some(value => value.includes('Redirect left allowed origin')))
  assert.equal(requests, 2)
  assert.equal(report.unknown.length, 2)
})

test('reports deployment drift without accepting an old root or silently rebasing', () => {
  const baseline = { sourceCommit: 'approved-source', files: { 'config/site-navigation.json': 'old' } }
  assert.throws(() => compareWebsiteSources(baseline, { activeRoots: [], files: {} }), /unique active/)
  const report = compareWebsiteSources(baseline, { activeRoots: ['/active/site'], files: { 'config/site-navigation.json': 'new' } })
  assert.equal(report.status, 'drift'); assert.equal(report.action, 'review-only')
  assert.equal(report.differences[0].actual, 'new'); assert.equal(baseline.files['config/site-navigation.json'], 'old')
})
