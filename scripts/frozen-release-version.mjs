import { readFileSync } from 'node:fs'

// Historical acceptance always starts with these immutable official bytes.
export const FROZEN_BASE_VERSION = '0.5.2'

export function validateFrozenTargetVersion(version) {
  if (typeof version !== 'string' || version !== version.trim() || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(version)) {
    throw new Error('Frozen target version must be an explicit stable semantic version.')
  }
  const parts = version.split('.').map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error('Frozen target version components must be safe integers.')
  const baseline = FROZEN_BASE_VERSION.split('.').map(Number)
  const differing = parts.findIndex((part, index) => part !== baseline[index])
  if (differing < 0 || parts[differing] < baseline[differing]) throw new Error('Frozen target version must be newer than the official baseline.')
  return version
}

// Resolve against the checked-out verifier source, never an input report or
// installed package whose version is the claim being checked.
export function readFrozenSourceVersion() {
  return validateFrozenTargetVersion(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
}
