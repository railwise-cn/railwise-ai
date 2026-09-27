const { execFileSync } = require('node:child_process')
const {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync
} = require('node:fs')
const { join } = require('node:path')
const { verifyAsarArchive } = require('./verify-packaged-asar.cjs')
const {
  adHocSignMacSidecar,
  verifyMarkItDownSidecar
} = require('./verify-packaged-markitdown.cjs')
const { verifyCandidateSourceTree } = require('./candidate-source-provenance.cjs')
const { verifyMacRuntimeEntitlements } = require('./mac-notarize.cjs')._internals

const MAC_ENTITLEMENTS_PATH = join(__dirname, '..', 'build', 'entitlements.mac.plist')

const MANAGED_RUNTIME_REQUIRED_PATHS = [
  'kun/dist/cli/serve-entry.js',
  'kun/package.json',
  'kun/package-lock.json',
  'kun/node_modules/zod/package.json',
  'kun/node_modules/diff/package.json',
  'kun/node_modules/pptxgenjs/package.json',
  'kun/node_modules/@modelcontextprotocol/sdk/package.json',
  'src/asset/skills/ppt-master/scripts/svg_to_pptx.py'
]

function normalizePlatform(platform) {
  return platform === 'win' ? 'win32' : platform
}

function appBundlePath(context) {
  return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
}

function packedResourcesDir(context) {
  if (normalizePlatform(context.electronPlatformName) === 'darwin') {
    return join(appBundlePath(context), 'Contents', 'Resources')
  }
  return join(context.appOutDir, 'resources')
}

function normalizeArch(arch) {
  if (arch === 'x64' || arch === 'arm64') return arch
  if (arch === 0 || arch === 1) return 'x64'
  if (arch === 3) return 'arm64'
  return String(arch)
}

function converterDirNameForContext(context) {
  const platform = normalizePlatform(context.electronPlatformName)
  const arch = normalizeArch(context.arch)
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`
  if (platform === 'win32' && arch === 'x64') return 'win32-x64'
  return null
}

function unpackedAppRoot(context) {
  return join(packedResourcesDir(context), 'app.asar.unpacked')
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`[after-pack] Missing ${label}: ${path}`)
  }
}

function validateBundledKunRuntime(context) {
  const root = unpackedAppRoot(context)
  for (const relativePath of MANAGED_RUNTIME_REQUIRED_PATHS) {
    assertExists(join(root, relativePath), relativePath)
  }
  assertExists(
    join(root, 'node_modules', 'better-sqlite3', 'package.json'),
    'root better-sqlite3 dependency'
  )
}

function ensureBundledMarkItDownExecutable(context) {
  const platform = normalizePlatform(context.electronPlatformName)
  const executableName = platform === 'win32'
    ? 'workwise-markitdown.exe'
    : 'workwise-markitdown'
  const executablePath = join(
    unpackedAppRoot(context),
    'sidecars',
    'markitdown',
    executableName
  )
  assertExists(executablePath, 'MarkItDown sidecar executable')

  const before = statSync(executablePath)
  if (!before.isFile() || before.size === 0) {
    throw new Error(`[after-pack] MarkItDown sidecar is empty or not a file: ${executablePath}`)
  }

  if (platform !== 'win32') {
    chmodSync(executablePath, 0o755)
    if ((statSync(executablePath).mode & 0o111) === 0) {
      throw new Error(`[after-pack] MarkItDown sidecar is not executable: ${executablePath}`)
    }
  }
}

function validateBundledMarkItDownSidecar(context) {
  const platform = normalizePlatform(context.electronPlatformName)
  const sidecarRoot = join(unpackedAppRoot(context), 'sidecars', 'markitdown')
  if (platform === 'darwin' && !hasDeveloperIdSigning()) {
    adHocSignMacSidecar(sidecarRoot)
  }
  return verifyMarkItDownSidecar(sidecarRoot, platform)
}

function hasDeveloperIdSigning() {
  return Boolean(
    process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_KEY_PASSWORD ||
    process.env.MAC_SIGN === '1'
  )
}

function activateBundledRuntimeDependencies(context) {
  const runtimeRoot = join(unpackedAppRoot(context), 'kun')
  const staged = join(runtimeRoot, 'runtime-deps')
  const target = join(runtimeRoot, 'node_modules')
  assertExists(staged, 'staged managed runtime dependencies')
  rmSync(target, { recursive: true, force: true })
  renameSync(staged, target)
}

function copyBundledMarkdownConverters(context) {
  const converterDirName = converterDirNameForContext(context)
  if (!converterDirName) return

  const sourceRoot = join(__dirname, '..', 'converters')
  const sourceDir = join(sourceRoot, converterDirName)
  if (!existsSync(sourceDir)) {
    console.log(`[after-pack] No Markdown converters for ${converterDirName}.`)
    return
  }

  const targetRoot = join(packedResourcesDir(context), 'converters')
  const targetDir = join(targetRoot, converterDirName)
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetRoot, { recursive: true })
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => !source.endsWith('.gitkeep') && !source.endsWith('.DS_Store')
  })

  const readmePath = join(sourceRoot, 'README.md')
  if (existsSync(readmePath)) cpSync(readmePath, join(targetRoot, 'README.md'))
  console.log(`[after-pack] Bundled Markdown converters: ${converterDirName}`)
}

function maybeAdhocSignMacApp(context) {
  if (normalizePlatform(context.electronPlatformName) !== 'darwin') {
    return
  }

  if (
    process.env.CSC_LINK ||
    process.env.CSC_NAME ||
    process.env.CSC_KEY_PASSWORD ||
    process.env.MAC_SIGN === '1'
  ) {
    console.log('[after-pack] Developer ID signing is enabled, skipping ad-hoc signing.')
    return
  }

  const appBundle = appBundlePath(context)
  if (!existsSync(appBundle)) {
    throw new Error(`[after-pack] App bundle not found for ad-hoc signing: ${appBundle}`)
  }

  execFileSync(
    'codesign',
    [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--timestamp=none',
      '--entitlements',
      MAC_ENTITLEMENTS_PATH,
      appBundle
    ],
    { stdio: 'inherit' }
  )
  verifyMacRuntimeEntitlements(appBundle)
}

async function afterPack(context) {
  const candidateSourceHead = process.env.WORKWISE_CANDIDATE_SOURCE_HEAD?.trim() || undefined
  if (process.env.WORKWISE_CANDIDATE === '1') {
    verifyCandidateSourceTree(join(__dirname, '..'), candidateSourceHead, { label: 'after-pack' })
  }
  activateBundledRuntimeDependencies(context)
  validateBundledKunRuntime(context)
  ensureBundledMarkItDownExecutable(context)
  validateBundledMarkItDownSidecar(context)
  copyBundledMarkdownConverters(context)
  const integrity = verifyAsarArchive(
    join(packedResourcesDir(context), 'app.asar'),
    join(__dirname, '..', 'out'),
    candidateSourceHead
  )
  console.log(
    `[after-pack] ASAR integrity passed: ${integrity.files} files, ${integrity.compiledFiles} compiled files.`
  )
  maybeAdhocSignMacApp(context)
}

module.exports = afterPack
module.exports.MANAGED_RUNTIME_REQUIRED_PATHS = MANAGED_RUNTIME_REQUIRED_PATHS
module.exports._internals = {
  appBundlePath,
  packedResourcesDir,
  unpackedAppRoot,
  activateBundledRuntimeDependencies,
  validateBundledKunRuntime,
  ensureBundledMarkItDownExecutable,
  validateBundledMarkItDownSidecar,
  copyBundledMarkdownConverters,
  verifyCandidateSourceTree,
  converterDirNameForContext,
  normalizeArch
}
module.exports.MAC_ENTITLEMENTS_PATH = MAC_ENTITLEMENTS_PATH
