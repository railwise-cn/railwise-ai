import { readFileSync } from 'node:fs'

// The native updater gate starts from the latest published stable release.
export const FROZEN_BASE_VERSION = '0.5.3'
export const FROZEN_BASELINE_PINS = Object.freeze({
  arm64: { name: 'WorkWise-0.5.3-mac-Apple-Silicon.dmg', size: 301352326, sha256: '6b12d991bee1853f93ab13e37aee8cf9759ea17642252bf7e11fa11ea0b37c6e', assetId: 630646810 },
  x64: { name: 'WorkWise-0.5.3-mac-Intel.dmg', size: 306907651, sha256: '59613948518d9622d21063bff98aba2d78714d797f773b353bea313995975560', assetId: 630646813 },
})

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
