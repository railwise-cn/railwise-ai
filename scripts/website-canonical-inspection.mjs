import { isAbsolute, normalize, relative, resolve } from 'node:path'

const SAFE_PATH = /^\/[A-Za-z0-9._/~+:-]+$/

export function safeAbsolutePath(value) {
  const path = String(value || '').trim()
  if (!SAFE_PATH.test(path) || path.includes('//')) return null
  const normalized = normalize(path)
  if (!isAbsolute(normalized) || normalized !== path || path.split('/').includes('..')) return null
  return normalized
}

export function isWithinRoot(root, candidate) {
  const safeRoot = safeAbsolutePath(root)
  const safeCandidate = safeAbsolutePath(candidate)
  if (!safeRoot || !safeCandidate) return false
  const rel = relative(safeRoot, safeCandidate)
  return rel === '' || (rel && !rel.startsWith('..') && !isAbsolute(rel))
}

export function classifyPathFacts({ path, realpath = null, fileType = null, sha256 = null, approvedRoot }) {
  const safePath = safeAbsolutePath(path)
  if (!safePath) return { resolution: 'blocked', reason: 'unsafe_path', path: null, realpath: null, fileType: null, sha256: null }
  if (!isWithinRoot(approvedRoot, safePath)) {
    return { resolution: 'blocked', reason: 'outside_approved_root', path: safePath, realpath: null, fileType: null, sha256: null }
  }
  if (!realpath) return { resolution: 'unknown', reason: 'path_not_found', path: safePath, realpath: null, fileType: null, sha256: null }
  const safeRealpath = safeAbsolutePath(realpath)
  if (!safeRealpath || !isWithinRoot(approvedRoot, safeRealpath)) {
    return { resolution: 'blocked', reason: 'symlink_outside_approved_root', path: safePath, realpath: safeRealpath, fileType: null, sha256: null }
  }
  return { resolution: 'resolved', path: safePath, realpath: safeRealpath, fileType: fileType || 'unknown', sha256: sha256 || null }
}

export function extractStaticPhpReferences(source, phpPath, approvedRoot) {
  const text = String(source || '').slice(0, 131072)
  const base = resolve(String(phpPath || '').replace(/\/[^/]*$/, '') || '/')
  const references = []
  const seen = new Set()
  const add = (expression, candidate, status = 'resolved') => {
    const key = `${expression}\u0000${candidate || ''}\u0000${status}`
    if (seen.has(key)) return
    seen.add(key)
    references.push({ expression: String(expression).slice(0, 256), path: candidate, status })
  }

  const requirePattern = /\b(?:require|require_once|include|include_once)\s*(?:\(\s*)?([^;\n]+?)(?:\s*\))?\s*;/g
  for (const match of text.matchAll(requirePattern)) {
    const expression = match[1].trim()
    const dirMatch = expression.match(/^__DIR__\s*\.\s*(['"])([^'"]+)\1$/)
    const literalMatch = expression.match(/^(['"])([^'"]+)\1$/)
    if (dirMatch) {
      const candidate = safeAbsolutePath(normalize(`${base}/${dirMatch[2]}`))
      add(expression, candidate, candidate && isWithinRoot(approvedRoot, candidate) ? 'resolved' : 'blocked')
    } else if (literalMatch && literalMatch[2].startsWith('/')) {
      const candidate = safeAbsolutePath(normalize(literalMatch[2]))
      add(expression, candidate, candidate && isWithinRoot(approvedRoot, candidate) ? 'resolved' : 'blocked')
    } else {
      add(expression, null, 'unknown')
    }
  }

  const dirLiteralPattern = /__DIR__\s*\.\s*(['"])([^'"]+\.(?:php|json))\1/g
  for (const match of text.matchAll(dirLiteralPattern)) {
    const candidate = safeAbsolutePath(normalize(`${base}/${match[2]}`))
    add(`__DIR__ . ${match[1]}${match[2]}${match[1]}`, candidate, candidate && isWithinRoot(approvedRoot, candidate) ? 'resolved' : 'blocked')
  }

  const versionMarkers = []
  const markerPattern = /(?:version|softwareVersion|releaseVersion|releaseCommit)\s*['"]?\s*(?:=>|:|=)\s*['"]([^'"]+)['"]/gi
  for (const match of text.matchAll(markerPattern)) versionMarkers.push(match[1].slice(0, 128))
  return { staticOnly: true, references, versionMarkers: [...new Set(versionMarkers)] }
}

export function routeResolution({ requestPath, location = null, modifier = '', directives = {}, effectiveRoot = null }) {
  const result = { requestPath, location, modifier, directives, resolution: 'unknown', reason: 'unresolved' }
  if (!location) {
    result.reason = 'no_matching_location'
    return result
  }
  if (directives.return) {
    result.resolution = 'redirect'
    result.redirect = directives.return.split('?')[0].slice(0, 256)
    delete result.reason
    return result
  }
  const configuredPath = directives.scriptFilename || directives.alias || directives.root || effectiveRoot
  if (!configuredPath || /\$[A-Za-z_][A-Za-z0-9_]*/.test(configuredPath)) {
    result.reason = 'dynamic_or_missing_script_path'
    return result
  }
  const path = safeAbsolutePath(configuredPath)
  if (!path) {
    result.resolution = 'blocked'
    result.reason = 'unsafe_script_path'
    return result
  }
  result.path = path
  result.resolution = 'candidate'
  delete result.reason
  return result
}
