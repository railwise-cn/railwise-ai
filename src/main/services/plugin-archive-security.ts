import { constants } from 'node:fs'
import { mkdir, open, readdir } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import JSZip from 'jszip'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const MAX_EOCD_SEARCH = 65_557

export const PLUGIN_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 8_192,
  maxUncompressedBytes: 128 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 500,
  maxDepth: 24
})

export type PluginArchiveEntryV1 = {
  name: string
  path: string
  directory: boolean
  symbolicLink: boolean
  executable: boolean
  compressedBytes: number
  uncompressedBytes: number
}

export type PluginArchiveInspectionV1 = {
  entryCount: number
  compressedBytes: number
  uncompressedBytes: number
  entries: PluginArchiveEntryV1[]
}

function unsafe(message: string): never {
  throw Object.assign(new Error(`Unsafe plugin archive: ${message}`), { code: 'unsafe_file' })
}

function resourceLimit(message: string): never {
  throw Object.assign(new Error(message), { code: 'resource_limit' })
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - MAX_EOCD_SEARCH)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  unsafe('file is not a valid ZIP archive.')
}

function decodeEntryName(bytes: Buffer, utf8: boolean): string {
  if (!utf8 && bytes.some((value) => value >= 0x80)) {
    unsafe('non-UTF-8 non-ASCII entry names are not supported.')
  }
  const name = bytes.toString('utf8')
  if (name.includes('\uFFFD') || (utf8 && !Buffer.from(name, 'utf8').equals(bytes))) {
    unsafe('entry name is not valid UTF-8.')
  }
  return name
}

export function normalizePluginArchivePath(name: string): { path: string; directory: boolean } {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') ||
      /^[A-Za-z]:/.test(name)) {
    unsafe(`entry has an unsafe path: ${name}`)
  }
  const directory = name.endsWith('/')
  const body = directory ? name.slice(0, -1) : name
  const segments = body.split('/')
  if (!body || segments.length > PLUGIN_ARCHIVE_LIMITS.maxDepth ||
      segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    unsafe(`entry contains path traversal or excessive depth: ${name}`)
  }
  for (const segment of segments) {
    const base = segment.split('.')[0]?.toLowerCase() ?? ''
    const containsControl = [...segment].some((character) => {
      const code = character.charCodeAt(0)
      return code >= 1 && code <= 31
    })
    if (/[<>:"|?*]/.test(segment) || containsControl || /[. ]$/.test(segment) ||
        new Set(['con', 'prn', 'aux', 'nul']).has(base) || /^(?:com|lpt)[1-9]$/.test(base)) {
      unsafe(`entry path is not portable: ${name}`)
    }
  }
  return { path: segments.join('/'), directory }
}

export type ExtractPluginArchiveOptionsV1 = {
  /**
   * GitHub source archives can contain links committed by the repository.
   * When enabled, links are inspected and materialized as regular files or
   * directories. They are never created in the extraction directory.
   */
  allowInternalLinks?: boolean
}

export function inspectPluginArchive(
  buffer: Buffer,
  options: ExtractPluginArchiveOptionsV1 = {}
): PluginArchiveInspectionV1 {
  if (buffer.byteLength > PLUGIN_ARCHIVE_LIMITS.maxArchiveBytes) {
    resourceLimit('Plugin archive exceeds the 64 MiB download limit.')
  }
  const eocd = findEndOfCentralDirectory(buffer)
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) {
    unsafe('multi-disk ZIP archives are not supported.')
  }
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    unsafe('ZIP64 plugin archives are not supported.')
  }
  if (entryCount < 1 || entryCount > PLUGIN_ARCHIVE_LIMITS.maxEntries) {
    resourceLimit(`Plugin archive entry count must be between 1 and ${PLUGIN_ARCHIVE_LIMITS.maxEntries}.`)
  }
  if (centralOffset + centralSize > eocd) unsafe('central directory is invalid.')

  const entries: PluginArchiveEntryV1[] = []
  const collisionKeys = new Map<string, boolean>()
  const filePaths = new Set<string>()
  let offset = centralOffset
  let compressedBytes = 0
  let uncompressedBytes = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      unsafe('central directory is truncated.')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const entryCompressed = buffer.readUInt32LE(offset + 20)
    const entryUncompressed = buffer.readUInt32LE(offset + 24)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const next = offset + 46 + fileNameLength + extraLength + commentLength
    if (fileNameLength < 1 || next > centralOffset + centralSize || next > buffer.length) {
      unsafe('entry name or central directory length is invalid.')
    }
    if ((flags & 0x1) !== 0) unsafe('encrypted entries are not allowed.')
    if (method !== 0 && method !== 8) unsafe('only stored and DEFLATE entries are supported.')
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + fileNameLength)
    const name = decodeEntryName(nameBytes, (flags & 0x800) !== 0)
    const normalized = normalizePluginArchivePath(name)
    const collisionKey = normalized.path.normalize('NFC').toLowerCase()
    const existingPathType = collisionKeys.get(collisionKey)
    if (existingPathType !== undefined) {
      if (existingPathType !== normalized.directory) {
        unsafe(`file and directory paths conflict: ${name}`)
      }
      unsafe(`archive contains a colliding path: ${name}`)
    }
    collisionKeys.set(collisionKey, normalized.directory)
    const unixMode = (externalAttributes >>> 16) & 0xffff
    const symbolicLink = (unixMode & 0o170000) === 0o120000
    if (symbolicLink && !options.allowInternalLinks) unsafe(`links are not allowed: ${name}`)
    if (entryUncompressed > PLUGIN_ARCHIVE_LIMITS.maxEntryBytes) {
      resourceLimit(`Plugin archive entry exceeds 32 MiB: ${name}`)
    }
    if (!normalized.directory && entryUncompressed > 0 && entryCompressed === 0) {
      resourceLimit(`Plugin archive entry has an unsafe compression ratio: ${name}`)
    }
    if (entryCompressed > 0 &&
        entryUncompressed / entryCompressed > PLUGIN_ARCHIVE_LIMITS.maxCompressionRatio) {
      resourceLimit(`Plugin archive entry has an unsafe compression ratio: ${name}`)
    }
    compressedBytes += entryCompressed
    uncompressedBytes += entryUncompressed
    if (uncompressedBytes > PLUGIN_ARCHIVE_LIMITS.maxUncompressedBytes) {
      resourceLimit('Plugin archive expands beyond the 128 MiB limit.')
    }
    if (!normalized.directory) filePaths.add(normalized.path)
    entries.push({
      name,
      path: normalized.path,
      directory: normalized.directory,
      symbolicLink,
      executable: (unixMode & 0o111) !== 0,
      compressedBytes: entryCompressed,
      uncompressedBytes: entryUncompressed
    })
    offset = next
  }
  if (offset !== centralOffset + centralSize) unsafe('central directory length does not match its entries.')
  for (const entry of entries) {
    const segments = entry.path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      if (filePaths.has(segments.slice(0, index).join('/'))) {
        unsafe(`file and directory paths conflict: ${entry.name}`)
      }
    }
  }
  return { entryCount, compressedBytes, uncompressedBytes, entries }
}

export async function extractPluginArchive(
  buffer: Buffer,
  targetDirectory: string,
  options: ExtractPluginArchiveOptionsV1 = {}
): Promise<PluginArchiveInspectionV1> {
  const inspection = inspectPluginArchive(buffer, options)
  await mkdir(targetDirectory, { recursive: true, mode: 0o700 })
  if ((await readdir(targetDirectory)).length > 0) unsafe('extraction target must be empty.')
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false })
  const entriesByPath = new Map(inspection.entries.map((item) => [item.path, item]))
  const written = new Set<string>()
  let materializedBytes = 0

  const entryBytes = async (item: PluginArchiveEntryV1): Promise<Buffer> => {
    const entry = archive.file(item.name)
    if (!entry || entry.dir) unsafe(`archive reader could not resolve entry: ${item.name}`)
    if (typeof entry.unixPermissions === 'number' &&
        (entry.unixPermissions & 0o170000) === 0o120000 && !item.symbolicLink) {
      unsafe(`archive reader exposed an unexpected symbolic link: ${item.name}`)
    }
    const bytes = await entry.async('nodebuffer')
    if (bytes.byteLength !== item.uncompressedBytes) unsafe(`entry size changed during extraction: ${item.name}`)
    return bytes
  }

  const writeFile = async (relativePath: string, item: PluginArchiveEntryV1, bytes: Buffer): Promise<void> => {
    materializedBytes += bytes.byteLength
    if (materializedBytes > PLUGIN_ARCHIVE_LIMITS.maxUncompressedBytes) {
      resourceLimit('Plugin archive materializes beyond the 128 MiB limit.')
    }
    const destination = join(targetDirectory, ...relativePath.split('/'))
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const handle = await open(destination, 'wx', item.executable ? 0o700 : 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    written.add(relativePath)
  }

  const linkTarget = (item: PluginArchiveEntryV1, target: string): string => {
    if (!target || target.includes('\0') || target.includes('\\') || target.startsWith('/') ||
        /^[A-Za-z]:/.test(target) || /[\r\n]/.test(target)) {
      unsafe(`symbolic link target is outside the archive: ${item.name}`)
    }
    const normalized = posix.normalize(posix.join(posix.dirname(item.path), target))
    if (!normalized || normalized === '..' || normalized.startsWith('../')) {
      unsafe(`symbolic link target escapes the archive: ${item.name}`)
    }
    return normalized
  }

  const hasArchivePath = (path: string): boolean =>
    entriesByPath.has(path) || inspection.entries.some((entry) => entry.path.startsWith(`${path}/`))

  const materialize = async (
    item: PluginArchiveEntryV1,
    relativePath: string,
    linkStack: Set<string>
  ): Promise<void> => {
    if (item.symbolicLink) {
      if (!options.allowInternalLinks) unsafe(`links are not allowed: ${item.name}`)
      if (linkStack.has(item.path)) unsafe(`symbolic link cycle detected: ${item.name}`)
      const target = linkTarget(item, (await entryBytes(item)).toString('utf8'))
      if (!hasArchivePath(target)) unsafe(`symbolic link target is missing: ${item.name}`)
      const targetItem = entriesByPath.get(target)
      const nextStack = new Set(linkStack)
      nextStack.add(item.path)
      if (targetItem && !targetItem.directory && !targetItem.symbolicLink) {
        await writeFile(relativePath, targetItem, await entryBytes(targetItem))
        return
      }
      if (targetItem?.symbolicLink) {
        await materialize(targetItem, relativePath, nextStack)
        return
      }
      await mkdir(join(targetDirectory, ...relativePath.split('/')), { recursive: true, mode: 0o700 })
      for (const child of inspection.entries) {
        if (!child.path.startsWith(`${target}/`)) continue
        const childRelative = `${relativePath}/${child.path.slice(target.length + 1)}`
        if (child.directory) {
          await mkdir(join(targetDirectory, ...childRelative.split('/')), { recursive: true, mode: 0o700 })
          continue
        }
        await materialize(child, childRelative, nextStack)
      }
      return
    }
    if (item.directory) {
      await mkdir(join(targetDirectory, ...relativePath.split('/')), { recursive: true, mode: 0o700 })
      return
    }
    if (!written.has(relativePath)) await writeFile(relativePath, item, await entryBytes(item))
  }

  // Create ordinary directories and files first. This keeps the output free of
  // links even when a link points at an entry that appears later in the ZIP.
  for (const item of inspection.entries) {
    if (item.symbolicLink) continue
    await materialize(item, item.path, new Set())
  }
  for (const item of inspection.entries) {
    if (!item.symbolicLink) continue
    await materialize(item, item.path, new Set())
  }
  const directory = await open(targetDirectory, constants.O_RDONLY)
  try {
    await directory.sync()
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    await directory.close()
  }
  return inspection
}
