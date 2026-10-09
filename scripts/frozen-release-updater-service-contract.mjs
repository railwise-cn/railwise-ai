import { isDeepStrictEqual } from 'node:util'

const MODULE_PATHS = ['dist/engineering/engineering-service.js', 'dist/engineering/survey-service.js']
const REQUIRED_DEPENDENCIES = ['better-sqlite3', 'better-sqlite3-native', 'jszip', 'pdfkit', 'zod']
const PACKAGED_LAYOUTS = ['asar-unpacked', 'asar']

function fail(message) { throw new Error(`[updater-service] ${message}`) }
function equal(actual, expected, label) { if (!isDeepStrictEqual(actual, expected)) fail(`${label} mismatch`) }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is required`) }
function sha(value, label, length = 64) {
  if (typeof value !== 'string' || !(length === 40 ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(value)) fail(`${label} must be a lowercase SHA${length === 40 ? '1' : '256'}`)
}
function nullableHead(value, label) { if (value !== null) sha(value, label, 40) }

function dependencyPath(path, name, layout, label) {
  if (typeof path !== 'string' || !path || /[\\:\s]/.test(path) || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`${label} must be a normalized relative dependency path`)
  const prefix = layout === 'source-compatibility' ? /^node_modules\// : /^app\.asar(?:\.unpacked)?\/(?:kun\/)?node_modules\//
  if (!prefix.test(path)) fail(`${label} must remain in the ${layout === 'source-compatibility' ? 'compatibility' : 'packaged'} dependency tree`)
  const packageName = name === 'better-sqlite3-native' ? 'better-sqlite3' : name
  if (!(`/${path}`).includes(`/node_modules/${packageName}/`)) fail(`${label} does not identify ${packageName}`)
  if (name === 'better-sqlite3-native' && !path.endsWith('.node')) fail(`${label} must identify the SQLite native module`)
}

function validateIdentity(identity, label) {
  object(identity, label)
  equal(identity.schemaVersion, 1, `${label} schema`)
  nullableHead(identity.packageSourceHead, `${label} package source`)
  nullableHead(identity.serviceSourceHead, `${label} service source`)
  sha(identity.asarSha256, `${label} ASAR`)
  sha(identity.serviceTreeSha256, `${label} complete service tree`)
  if (![...PACKAGED_LAYOUTS, 'source-compatibility'].includes(identity.layout)) fail(`${label} has an unsupported service layout`)
  if (!Array.isArray(identity.modules) || identity.modules.length !== MODULE_PATHS.length) fail(`${label} must identify both packaged services`)
  for (const [index, path] of MODULE_PATHS.entries()) {
    object(identity.modules[index], `${label} module`)
    equal(identity.modules[index].path, path, `${label} module path`)
    sha(identity.modules[index].sha256, `${label} ${path}`)
  }
  if (!Array.isArray(identity.dependencies) || identity.dependencies.length < REQUIRED_DEPENDENCIES.length || identity.dependencies.length > 64) fail(`${label} dependency identities are required`)
  const names = new Set(); const paths = new Set()
  for (const dependency of identity.dependencies) {
    object(dependency, `${label} dependency`)
    const name = dependency.name
    if (typeof name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || names.has(name)) fail(`${label} has an invalid or duplicate dependency name`)
    dependencyPath(dependency.path, name, identity.layout, `${label} ${name} path`)
    if (paths.has(dependency.path)) fail(`${label} has duplicate dependency paths`)
    names.add(name); paths.add(dependency.path)
    sha(dependency.sha256, `${label} ${name}`)
    if (name !== 'better-sqlite3-native') {
      if (!dependency.path.endsWith('/package.json')) fail(`${label} ${name} must identify its owning package manifest`)
      sha(dependency.treeSha256, `${label} ${name} complete package tree`)
    }
  }
  for (const name of REQUIRED_DEPENDENCIES) if (!names.has(name)) fail(`${label} must identify ${name}`)
}

// Pure evidence checks: neither a matching version string nor a source-tree
// readback can replace services and dependencies from the frozen target ZIP.
export function validateUpdaterServiceEvidence(machine, { sourceHead, version = '0.5.3' } = {}) {
  object(machine, 'machine report')
  sha(sourceHead, 'frozen source', 40)
  if (!['arm64', 'x64'].includes(machine.arch)) fail('machine report must identify a supported native macOS architecture')
  equal(machine.baseVersion, '0.5.2', 'official baseline version')
  equal(machine.targetVersion, version, 'frozen target version')
  sha(machine.targetAsarSha256, 'frozen target ASAR')
  equal(machine.installedAsarSha256, machine.targetAsarSha256, 'installed/frozen ASAR')

  const target = machine.targetServiceIdentity
  validateIdentity(target, 'frozen target service identity')
  if (!PACKAGED_LAYOUTS.includes(target.layout)) fail('frozen target services must be packaged')
  equal(target.packageVersion, version, 'frozen target package version')
  equal(target.packageSourceHead, sourceHead, 'frozen target package source')
  equal(target.serviceSourceHead, sourceHead, 'frozen target service source')
  equal(target.asarSha256, machine.targetAsarSha256, 'frozen target service ASAR')
  for (const key of ['dataReadback', 'dataRestartReadback']) {
    const data = machine[key]
    object(data, key)
    equal(data.serviceSource, 'target-package', `${key} service source`)
    validateIdentity(data.serviceIdentity, `${key} service identity`)
    equal(data.serviceIdentity, target, `${key} frozen service identity`)
  }

  const seed = machine.dataSeed
  object(seed, 'dataSeed')
  if (!['baseline-package', 'source-bound-compatibility-service'].includes(seed.serviceSource)) fail('dataSeed must identify baseline or explicitly source-bound compatibility services')
  validateIdentity(seed.serviceIdentity, 'dataSeed service identity')
  equal(seed.serviceIdentity.packageVersion, '0.5.2', 'dataSeed package version')
  if (seed.serviceSource === 'source-bound-compatibility-service') {
    equal(seed.serviceIdentity.layout, 'source-compatibility', 'dataSeed compatibility layout')
    equal(seed.serviceIdentity.serviceSourceHead, sourceHead, 'dataSeed compatibility source')
  } else {
    if (!PACKAGED_LAYOUTS.includes(seed.serviceIdentity.layout)) fail('dataSeed baseline services must be packaged')
    equal(seed.serviceIdentity.serviceSourceHead, seed.serviceIdentity.packageSourceHead, 'dataSeed baseline service source')
  }
  return machine
}
