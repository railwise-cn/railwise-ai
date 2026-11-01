import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalizeContainmentRoot, isCanonicalPathContained, resolveContainedPath } from './canonical-containment'

const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
}

/** Images are passive local resources. Embedded SVG must not include active or external content. */
function passiveSvg(source: string): boolean {
  return /<svg(?:\s|>)/i.test(source)
    && !/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed|image)\b|\son[a-z]+\s*=|@import/i.test(source)
    && !/(?:href|xlink:href)\s*=\s*(?:["']\s*(?!#)[^"']|[^"'\s#])/i.test(source)
    && !/url\(\s*["']?\s*(?!#)/i.test(source)
}

export async function readWriteImageResource(input: {
  src: string
  sourcePath: string
  workspaceRoot?: string
}): Promise<{ path: string; data: Buffer; mimeType: string; extension: string } | null> {
  try {
    const src = input.src.trim()
    if (!src || src.startsWith('#') || src.includes('\0') || src.startsWith('//') || src.includes('\\')) return null
    let candidate: string
    if (/^file:/i.test(src)) candidate = fileURLToPath(src)
    else {
      if (/^[a-z][a-z\d+.-]*:/i.test(src) || /[?#]/.test(src)) return null
      const decoded = decodeURIComponent(src)
      candidate = isAbsolute(decoded) ? decoded : resolve(dirname(input.sourcePath), decoded)
    }
    const rootInput = input.workspaceRoot || dirname(input.sourcePath)
    const root = await canonicalizeContainmentRoot(rootInput)
    const path = await resolveContainedPath({ root: rootInput, target: candidate, mustExist: true, expect: 'file', rejectFinalLink: true })
    const lexicalPath = isCanonicalPathContained(resolve(rootInput), candidate)
      ? resolve(root, relative(resolve(rootInput), candidate)) : candidate
    if (!isCanonicalPathContained(root, lexicalPath)) return null
    // Check the lexical path as well as its canonical target so internal links cannot hide assets.
    let current = root
    for (const segment of relative(root, lexicalPath).split(sep)) {
      current = resolve(current, segment)
      if ((await lstat(current)).isSymbolicLink()) return null
    }
    const extension = extname(path).toLowerCase()
    const mimeType = IMAGE_MIME[extension]
    if (!mimeType) return null
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null
      const data = await handle.readFile()
      if (data.length > MAX_IMAGE_BYTES || (extension === '.svg' && !passiveSvg(data.toString('utf8')))) return null
      return { path, data, mimeType, extension: extension.slice(1) }
    } finally { await handle.close() }
  } catch { return null }
}
