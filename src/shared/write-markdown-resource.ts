function normalizePath(value: string): string {
  return value.replaceAll('\\', '/')
}

function dirnamePortable(filePath: string): string {
  const normalized = normalizePath(filePath)
  const slash = normalized.lastIndexOf('/')
  if (slash < 0) return ''
  if (slash === 0) return '/'
  return normalized.slice(0, slash)
}

function normalizeJoinedPath(pathname: string): string {
  const normalized = normalizePath(pathname)
  const prefix = normalized.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of normalized.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(part)
  }
  return `${prefix}${parts.join('/')}`
}

export function writePathToFileUrl(pathname: string): string {
  const normalized = normalizeJoinedPath(pathname)
  const encoded = normalized
    .split('/')
    .map((part) => {
      if (/^[a-zA-Z]:$/.test(part)) return part
      return encodeURIComponent(part).replaceAll('~', '%7E')
    })
    .join('/')
  return `file://${encoded.startsWith('/') ? encoded : `/${encoded}`}`
}

export function isExplicitWriteResourceUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)
}

function explicitResourceProtocol(value: string): string | null {
  try {
    return new URL(value).protocol
  } catch {
    return null
  }
}

export function resolveWriteMarkdownResource(
  src: string | undefined,
  filePath?: string | null
): string | undefined {
  const resolvedPath = resolveWriteMarkdownResourcePath(src, filePath)
  if (resolvedPath) return writePathToFileUrl(resolvedPath)
  if (!src?.trim()) return src
  const value = src.trim()
  return explicitResourceProtocol(value) === 'file:' ? undefined : src
}

export function resolveWriteMarkdownResourcePath(
  src: string | undefined,
  filePath?: string | null
): string | undefined {
  if (!src?.trim() || !filePath) return undefined
  const value = src.trim()
  if (isExplicitWriteResourceUrl(value) || /[?#\\]|\p{Cc}/u.test(value) || value.startsWith('//')) return undefined
  // Markdown parsers URL-encode image destinations. Decode once before resolving
  // the filesystem path, then writePathToFileUrl will encode it for transport.
  // Encoded separators are ambiguous across URL/filesystem implementations.
  if (/%(?:2f|5c)/i.test(value)) return undefined
  let pathname: string
  try { pathname = decodeURIComponent(value) } catch { return undefined }
  if (!pathname || isExplicitWriteResourceUrl(pathname) || /\\|\p{Cc}/u.test(pathname) || pathname.startsWith('//')) return undefined
  const baseDir = dirnamePortable(filePath)
  if (!baseDir) return undefined
  const resolved = pathname.startsWith('/')
    ? normalizeJoinedPath(pathname)
    : normalizeJoinedPath(`${baseDir}/${pathname}`)
  return resolved
}
