import { createHash } from 'node:crypto'

/** Read an sfnt/TTF Unicode cmap; no dependency, font execution or repair. */
export function fontHasCodePoint(bytes, codePoint) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > 8 * 1024 * 1024) throw new Error('Invalid font size')
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) throw new Error('Invalid code point')
  const count = bytes.readUInt16BE(4)
  if (count > 256 || 12 + count * 16 > bytes.length) throw new Error('Invalid font directory')
  let cmap
  for (let i = 0; i < count; i++) {
    const entry = 12 + i * 16
    if (bytes.toString('ascii', entry, entry + 4) !== 'cmap') continue
    const start = bytes.readUInt32BE(entry + 8), size = bytes.readUInt32BE(entry + 12)
    if (size < 4 || start + size > bytes.length) throw new Error('Invalid cmap bounds')
    cmap = bytes.subarray(start, start + size)
  }
  if (!cmap) throw new Error('Unicode cmap missing')
  const maps = cmap.readUInt16BE(2)
  if (maps > 256 || 4 + maps * 8 > cmap.length) throw new Error('Invalid cmap records')
  let supported = false
  for (let i = 0; i < maps; i++) {
    const record = 4 + i * 8, platform = cmap.readUInt16BE(record), encoding = cmap.readUInt16BE(record + 2)
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue
    const offset = cmap.readUInt32BE(record + 4)
    if (offset + 4 > cmap.length) throw new Error('Invalid cmap offset')
    const format = cmap.readUInt16BE(offset)
    if (format !== 4 && format !== 12) continue
    const length = format === 4 ? cmap.readUInt16BE(offset + 2) : cmap.readUInt32BE(offset + 4)
    if (offset + length > cmap.length || length < 16) throw new Error('Invalid cmap table')
    const table = cmap.subarray(offset, offset + length)
    supported = true
    if (format === 12) {
      const groups = table.readUInt32BE(12)
      if (groups > 65536 || 16 + groups * 12 > table.length) throw new Error('Invalid cmap groups')
      for (let g = 0; g < groups; g++) {
        const at = 16 + g * 12, start = table.readUInt32BE(at), end = table.readUInt32BE(at + 4)
        if (start <= codePoint && codePoint <= end && table.readUInt32BE(at + 8) + codePoint - start !== 0) return true
      }
    } else if (codePoint <= 0xffff) {
      const segments = table.readUInt16BE(6) / 2
      if (!Number.isInteger(segments) || segments < 1 || 16 + segments * 8 > table.length) throw new Error('Invalid cmap segments')
      for (let s = 0; s < segments; s++) {
        const end = table.readUInt16BE(14 + 2 * s), start = table.readUInt16BE(16 + 2 * segments + 2 * s)
        if (codePoint < start || codePoint > end) continue
        const delta = table.readInt16BE(16 + 4 * segments + 2 * s)
        const rangeAt = 16 + 6 * segments + 2 * s, range = table.readUInt16BE(rangeAt)
        const address = rangeAt + range + 2 * (codePoint - start)
        if (range && address + 2 > table.length) throw new Error('Invalid glyph index')
        const glyph = range ? table.readUInt16BE(address) : codePoint
        if (glyph !== 0 && ((glyph + delta) & 0xffff) !== 0) return true
      }
    }
  }
  if (!supported) throw new Error('Supported Unicode cmap missing')
  return false
}

/** Serializable browser probe. It does not navigate, write data or send forms. */
export function inspectWebsiteDocument() {
  const absolute = (value) => { try { return new URL(value, location.href).href } catch { return '' } }
  const cssFonts = []
  let unreadableStylesheets = 0
  const walk = (rules, base) => {
    for (const rule of rules) {
      if (rule.type === CSSRule.FONT_FACE_RULE) {
        const sources = [...rule.style.getPropertyValue('src').matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m => new URL(m[1], base).href)
        cssFonts.push({ family: rule.style.getPropertyValue('font-family').replace(/["']/g, ''), weight: rule.style.getPropertyValue('font-weight'), sources })
      } else if (rule.cssRules) walk(rule.cssRules, base)
    }
  }
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, sheet.href ?? location.href) } catch { unreadableStylesheets++ }
  }
  const icons = [...document.querySelectorAll('.fa, .fas, .far, .fab, .fa-solid, .fa-regular, .fa-brands')].map(node => {
    const style = getComputedStyle(node, '::before'), content = style.content
    const text = content.startsWith('"') || content.startsWith("'") ? content.slice(1, -1) : ''
    return { classes: node.className, content: text, codePoints: [...text].map(c => c.codePointAt(0)),
      family: style.fontFamily.split(',')[0].replace(/["']/g, '').trim(), weight: style.fontWeight,
      fontLoaded: document.fonts.check(`${style.fontWeight} 16px ${style.fontFamily}`, text) }
  })
  const nav = [...document.querySelectorAll('header a, nav a')].map(node => ({ text: node.textContent.trim().replace(/\s+/g, ' '), url: absolute(node.getAttribute('href')) }))
  const images = [...document.images].map(node => ({ url: node.currentSrc || absolute(node.getAttribute('src') || node.dataset.src || ''),
    declaredSource: Boolean(node.getAttribute('src') || node.dataset.src || node.getAttribute('srcset')),
    loaded: node.complete && node.naturalWidth > 0, deferred: node.loading === 'lazy' || Boolean(node.dataset.src) }))
  return { url: location.href, title: document.title, nav, images, icons, cssFonts, unreadableStylesheets, fontStatus: document.fonts.status,
    links: [...document.querySelectorAll('a[href]')].map(node => ({ text: node.textContent.trim(), url: absolute(node.getAttribute('href')) })) }
}

async function boundedGet(url, fetcher, maxBytes) {
  const allowedOrigin = new URL(url).origin
  let response, current = url
  for (let hop = 0; hop < 6; hop++) {
    response = await fetcher(current, { signal: AbortSignal.timeout(20_000), cache: 'no-store', redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    await response.body?.cancel()
    if (!response.headers.get('location') || hop === 5) throw new Error('Invalid redirect chain')
    current = new URL(response.headers.get('location'), current).href
    if (new URL(current).origin !== allowedOrigin) throw new Error('Redirect left allowed origin')
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Response exceeds bound') }
  const chunks = []; let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > maxBytes) throw new Error('Response exceeds bound')
    chunks.push(Buffer.from(chunk))
  }
  return { response, bytes: Buffer.concat(chunks) }
}

/** Audit an already navigated Ego page. Off-origin links are reported, never fetched. */
export async function auditWebsitePage(page, { origin = 'https://www.railwise.cn', fetcher = fetch, cache = new Map() } = {}) {
  const document = await page.evaluate(inspectWebsiteDocument)
  const failures = [], unknown = []
  const own = url => { try { return new URL(url).origin === origin } catch { return false } }
  if (!own(document.url)) throw new Error('Audit page left the allowed origin')
  if (document.unreadableStylesheets) unknown.push(`Unreadable stylesheets: ${document.unreadableStylesheets}`)
  if (document.fontStatus === 'loading') unknown.push('Fonts are still loading')
  if (!document.nav.some(link => /RailWise AI/.test(link.text))) failures.push('RailWise AI product menu absent')
  if (document.nav.some(link => /\bworkwise\b/i.test(link.text))) failures.push('Legacy product name in navigation')
  const request = (url, maxBytes) => {
    if (!own(url)) throw new Error('External resource requires separate review')
    const key = `${maxBytes}:${url}`
    if (!cache.has(key)) cache.set(key, boundedGet(url, fetcher, maxBytes))
    return cache.get(key)
  }
  const fonts = new Map()
  for (const icon of document.icons) {
    if (!icon.codePoints.length) { failures.push(`Icon has no glyph: ${icon.classes}`); continue }
    if (!icon.fontLoaded) failures.push(`Icon font not loaded: ${icon.classes}`)
    const face = document.cssFonts.find(font => font.family === icon.family && (font.weight === icon.weight || font.weight === 'normal' && icon.weight === '400'))
    const ttf = face?.sources.find(url => /\.ttf(?:[?#]|$)/i.test(url))
    if (!ttf) { unknown.push(`No inspectable TTF for ${icon.classes}`); continue }
    try {
      if (!fonts.has(ttf)) {
        const { bytes } = await request(ttf, 8 * 1024 * 1024)
        fonts.set(ttf, { bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
      for (const point of icon.codePoints) if (!fontHasCodePoint(fonts.get(ttf).bytes, point)) failures.push(`Missing glyph U+${point.toString(16)}: ${icon.classes}`)
    } catch (error) { failures.push(`Font inspection failed for ${icon.classes}: ${error.message}`) }
  }
  for (const img of document.images) {
    if (!img.declaredSource) { unknown.push('Image has no declared source'); continue }
    if (!img.loaded && img.deferred) unknown.push(`Deferred image not yet decoded: ${img.url}`)
    if (!img.loaded && !img.deferred) failures.push(`Image failed to decode: ${img.url}`)
    if (!own(img.url)) { unknown.push(`External image: ${img.url}`); continue }
    try {
      const { response, bytes } = await request(img.url, 12 * 1024 * 1024)
      if (!/^image\//.test(response.headers.get('content-type') ?? '') || !bytes.length) failures.push(`Image URL is not an image: ${img.url}`)
    } catch (error) { failures.push(`Image unavailable: ${img.url}: ${error.message}`) }
  }
  for (const url of new Set(document.nav.map(link => link.url).filter(own))) {
    try { await request(url, 2 * 1024 * 1024) } catch (error) { failures.push(`Navigation target unavailable: ${url}: ${error.message}`) }
  }
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), url: document.url, title: document.title,
    status: failures.length ? 'failed' : unknown.length ? 'incomplete' : 'passed',
    failures: [...new Set(failures)], unknown: [...new Set(unknown)], nav: document.nav,
    imageCount: document.images.length, iconCount: document.icons.length,
    fontDigests: [...fonts].map(([url, font]) => ({ url, sha256: font.sha256 })),
    scope: 'Observed DOM, same-origin resources and Unicode font cmap; screenshots and glyph outlines require visual review.' }
}

/** A missing/currently different deployment is drift, never an instruction to overwrite it. */
export function compareWebsiteSources(baseline, snapshot) {
  if (!Array.isArray(snapshot.activeRoots) || snapshot.activeRoots.length !== 1) throw new Error('A unique active document root is required')
  const differences = Object.entries(baseline.files).flatMap(([path, expected]) => snapshot.files[path] === expected ? []
    : [{ path, expected, actual: snapshot.files[path] ?? null }])
  return { status: differences.length ? 'drift' : 'matched', activeRoot: snapshot.activeRoots[0],
    sourceCommit: baseline.sourceCommit, differences, action: 'review-only' }
}
