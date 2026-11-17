const { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { crc32 } = require('node:zlib')

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const MAX_PNG_BYTES = 16 * 1024 * 1024
const generatedRules = new WeakMap()

function isPng(bytes) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let offset = 8
  let colorType
  let bitDepth
  let palette = false
  let imageBytes = 0
  let imageStarted = false
  let imageEnded = false
  for (let chunks = 0; chunks < 4096 && offset + 12 <= bytes.length; chunks += 1) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) return false
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return false
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false
    if (chunks === 0) {
      if (type !== 'IHDR' || length !== 13) return false
      const width = bytes.readUInt32BE(offset + 8)
      const height = bytes.readUInt32BE(offset + 12)
      bitDepth = bytes[offset + 16]
      colorType = bytes[offset + 17]
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[colorType]?.includes(bitDepth)) return false
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false
    } else if (type === 'IHDR') {
      return false
    } else if (type === 'PLTE') {
      if (palette || imageStarted || colorType === 0 || colorType === 4 || !length || length % 3 || length > 768) return false
      if (colorType === 3 && length / 3 > 2 ** bitDepth) return false
      palette = true
    } else if (type === 'IDAT') {
      if (imageEnded || (colorType === 3 && !palette)) return false
      imageStarted = true
      imageBytes += length
    } else if (type === 'IEND') {
      return length === 0 && imageBytes > 0 && end === bytes.length
    } else {
      // Unknown critical chunks cannot establish a PNG; ancillary chunks may
      // contain metadata, but IDAT chunks must remain consecutive.
      if (type[0] === type[0].toUpperCase()) return false
      if (imageStarted) imageEnded = true
    }
    offset = end
  }
  return false
}

function isPngDataFile(path) {
  if (!path.toLowerCase().endsWith('.png')) return false
  let fd
  try {
    const entry = lstatSync(path)
    if (!entry.isFile() || (entry.mode & 0o111) !== 0 || (entry.mode & 0o444) === 0) return false
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = fstatSync(fd)
    if (info.ino !== entry.ino || info.dev !== entry.dev || !info.isFile() || (info.mode & 0o111) !== 0 || (info.mode & 0o444) === 0) return false
    if (info.size < 57 || info.size > MAX_PNG_BYTES) return false
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) return false
      offset += count
    }
    const after = fstatSync(fd)
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return false
    return isPng(bytes)
  } catch {
    // Unknown, unreadable and linked files retain the standard signing path.
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function collectPngDataFiles(resources) {
  const files = []
  if (!/\.app\/Contents\/Resources$/.test(resources)) return files
  try {
    for (const directory of [dirname(dirname(resources)), dirname(resources), resources]) {
      if (!lstatSync(directory).isDirectory()) return files
    }
  } catch { return files }
  const stack = [resources]
  while (stack.length) {
    const directory = stack.pop()
    let entries
    try {
      if (!lstatSync(directory).isDirectory()) continue
      entries = readdirSync(directory, { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      // Never follow directory or file symlinks into another signing scope.
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && isPngDataFile(path)) files.push(path)
    }
  }
  return files.sort()
}

function excludeMacPngResources(resourcesDir, options) {
  if (!options || options.identity === null) return 0
  const resources = resolve(resourcesDir)
  const files = collectPngDataFiles(resources)
  const byApp = generatedRules.get(options) || new Map()
  const previous = new Set(byApp.get(resources) || [])
  const existing = options.signIgnore == null ? [] : Array.isArray(options.signIgnore) ? options.signIgnore : [options.signIgnore]
  const rules = existing.filter((rule) => !previous.has(rule))
  const additions = []
  for (const path of files) {
    // Unlike $, this end assertion also rejects a trailing newline in a path.
    const rule = `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\s\\S])`
    if (!rules.includes(rule)) {
      rules.push(rule)
      additions.push(rule)
    }
  }
  if (files.length || previous.size) options.signIgnore = rules
  byApp.set(resources, additions)
  generatedRules.set(options, byApp)
  return files.length
}

module.exports = { excludeMacPngResources }
