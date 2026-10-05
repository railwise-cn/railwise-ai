import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// src/ and dist/ are siblings of the bundled Runtime package.json. Reading
// that package keeps evidence provenance independent of the desktop version
// and avoids silently assigning a historical version to new records.
const runtimePackage: { version?: unknown } = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')
)
if (typeof runtimePackage.version !== 'string' || !runtimePackage.version.trim()) {
  throw new Error('Runtime package version is missing')
}
export const RUNTIME_VERSION = runtimePackage.version
