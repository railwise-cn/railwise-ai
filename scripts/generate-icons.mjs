import { Resvg } from '@resvg/resvg-js'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Use the user-selected clean SVG artwork. Remove canvas whitespace without
// changing the ribbon pixels, then place it consistently across app surfaces.
// Keep historical resource paths for installer and runtime compatibility.
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const iconDir = resolve(projectRoot, 'src/asset/img')
const sourceDir = resolve(iconDir, 'railwise-logo-pack-v2')
const macIconScale = 0.84

function renderPng(svg, size, scale = 1) {
  const inset = 1024 * (1 - scale) / 2
  const source = scale === 1 ? svg : `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(${inset} ${inset}) scale(${scale})">${svg.replace(/<\?xml[^>]*\?>/g, '')}</g></svg>`
  const rendered = new Resvg(source, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false } }).render()
  for (const fraction of [0.25, 0.5, 0.75]) {
    const alpha = rendered.pixels[(Math.floor(size / 2) * size + Math.floor(size * fraction)) * 4 + 3]
    if (alpha !== 255) throw new Error(`Unexpected clipping in ${size}px icon at ${fraction}`)
  }
  const png = Buffer.from(rendered.asPng())
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size || png[25] !== 6) {
    throw new Error(`Invalid ${size}px RGBA icon`)
  }
  return png
}

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(entries.length * 16)
  let position = header.length + directory.length
  entries.forEach((png, index) => {
    const size = png.readUInt32BE(16)
    const offset = index * 16
    directory.writeUInt8(size === 256 ? 0 : size, offset)
    directory.writeUInt8(size === 256 ? 0 : size, offset + 1)
    directory.writeUInt16LE(1, offset + 4)
    directory.writeUInt16LE(32, offset + 6)
    directory.writeUInt32LE(png.length, offset + 8)
    directory.writeUInt32LE(position, offset + 12)
    position += png.length
  })
  return Buffer.concat([header, directory, ...entries])
}

function buildIcns(svg) {
  // PNG-compatible ICNS element types, including Retina variants.
  const sizes = { icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024, ic11: 32, ic12: 64, ic13: 256, ic14: 512 }
  const body = Buffer.concat(Object.entries(sizes).map(([type, size]) => {
    const png = renderPng(svg, size, macIconScale)
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  }))
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

const symbolSvgSource = await readFile(resolve(sourceDir, 'RAILWISE_AI_symbol_color.svg'), 'utf8')
const master = new Resvg(symbolSvgSource, { font: { loadSystemFonts: false } }).render()
let left = master.width, top = master.height, right = -1, bottom = -1
const pixels = master.pixels
for (let y = 0; y < master.height; y++) {
  for (let x = 0; x < master.width; x++) {
    if (pixels[(y * master.width + x) * 4 + 3] === 0) continue
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
}
if (right < left || bottom < top) throw new Error('Selected symbol is empty')
// Two source pixels protect the antialiased edge. The original source stays intact.
left = Math.max(0, left - 2); top = Math.max(0, top - 2)
right = Math.min(master.width - 1, right + 2); bottom = Math.min(master.height - 1, bottom + 2)
const markWidth = right - left + 1, markHeight = bottom - top + 1
const symbolSvg = symbolSvgSource.replace(/<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${markWidth}" height="${markHeight}" viewBox="${left} ${top} ${markWidth} ${markHeight}"><title>RailWise AI</title>`)
const symbolPng = Buffer.from(new Resvg(symbolSvg, { fitTo: { mode: 'width', value: 1024 }, font: { loadSystemFonts: false } }).render().asPng())
const symbolData = symbolPng.toString('base64')

function appTile(theme) {
  const background = theme === 'light' ? '#F7FAFC' : '#06152D'
  const width = 832, height = width * markHeight / markWidth
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024"><title>RailWise AI</title><desc>User-selected clean v2 ribbon; canvas whitespace removed.</desc><rect width="1024" height="1024" rx="230" fill="${background}"/><image x="${(1024-width)/2}" y="${(1024-height)/2}" width="${width}" height="${height}" xlink:href="data:image/png;base64,${symbolData}"/></svg>`
}

const light = appTile('light')
const dark = appTile('dark')
const lightPng = renderPng(light, 1024)
const darkPng = renderPng(dark, 1024)
const outputs = {
  'workwise.svg': dark,
  'workwise-symbol.svg': symbolSvg,
  'workwise-symbol.png': symbolPng,
  'workwise.png': darkPng,
  'workwise-light.png': lightPng,
  'workwise-dark.png': darkPng,
  'workwise_tray.png': renderPng(dark, 512),
  'workwise_dock.png': renderPng(light, 1024, macIconScale),
  'workwise_dock_dark.png': renderPng(dark, 1024, macIconScale),
  'workwise.ico': buildIco([16, 24, 32, 48, 64, 128, 256].map((size) => renderPng(dark, size))),
  'workwise.icns': buildIcns(light)
}
for (const [name, content] of Object.entries(outputs)) {
  await writeFile(resolve(iconDir, name), content)
  console.log(`Generated ${name}`)
}
