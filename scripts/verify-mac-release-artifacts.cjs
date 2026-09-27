#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')
const productBrand = require('../src/shared/product-brand.json')

function usage() {
  console.error('Usage: node scripts/verify-mac-release-artifacts.cjs <distDir> [--dmg-only] <arm64|x64> [<arm64|x64> ...]')
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: 'inherit',
    ...options
  })
}

function versionFromArtifactName(name) {
  const match = name.match(/^WorkWise-(.+)-mac-(?:arm64|x64|Apple-Silicon|Intel)\.dmg$/)
  if (!match) throw new Error(`Could not resolve version from ${name}.`)
  return match[1]
}

function normalizeLipoArchitecture(architecture) {
  if (architecture === 'x86_64') return 'x64'
  return architecture
}

function assertAppArchitecture(appPath, expectedArch) {
  const architectures = run(
    'lipo',
    ['-archs', join(appPath, 'Contents', 'MacOS', basename(appPath, '.app'))],
    { stdio: 'pipe' }
  ).trim().split(/\s+/).filter(Boolean).map(normalizeLipoArchitecture)
  if (architectures.length !== 1 || architectures[0] !== expectedArch) {
    throw new Error(`${appPath} contains ${architectures.join(', ') || 'no'} architectures; expected only ${expectedArch}.`)
  }
}

function assertAppVersion(appPath, expectedVersion) {
  const output = run('defaults', ['read', join(appPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'], {
    stdio: 'pipe'
  }).trim()
  if (output !== expectedVersion) {
    throw new Error(`${appPath} reports version ${output}; expected ${expectedVersion}.`)
  }
}

function verifyApp(appPath, expectedArch, expectedVersion, label) {
  if (!existsSync(appPath)) throw new Error(`${label} app is missing: ${appPath}`)
  assertAppArchitecture(appPath, expectedArch)
  assertAppVersion(appPath, expectedVersion)
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
  run('xcrun', ['stapler', 'validate', appPath])
  console.log(`Verified signed and notarized macOS app: ${label}`)
}

function findSingleApp(root) {
  const appNames = readdirSync(root).filter((name) => name.endsWith('.app'))
  if (appNames.length !== 1) {
    throw new Error(`Expected one .app in ${root}, found ${appNames.join(', ') || 'none'}.`)
  }
  return join(root, appNames[0])
}

function verifyDmg(dmgPath, expectedArch, expectedVersion) {
  const mountPoint = mkdtempSync(join(tmpdir(), 'workwise-dmg-verify-'))
  let attached = false
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mountPoint, dmgPath])
    attached = true
    verifyApp(join(mountPoint, `${productBrand.platform}.app`), expectedArch, expectedVersion, basename(dmgPath))
  } finally {
    if (attached) {
      try {
        run('hdiutil', ['detach', mountPoint, '-force'], { stdio: 'ignore' })
      } catch (error) {
        console.error(`[verify-mac-release-artifacts] Failed to detach ${mountPoint}: ${error.message}`)
      }
    }
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

function verifyZip(zipPath, expectedArch, expectedVersion) {
  const extractRoot = mkdtempSync(join(tmpdir(), 'workwise-zip-verify-'))
  try {
    run('ditto', ['-x', '-k', zipPath, extractRoot])
    verifyApp(findSingleApp(extractRoot), expectedArch, expectedVersion, basename(zipPath))
  } finally {
    rmSync(extractRoot, { recursive: true, force: true })
  }
}

function main() {
  const [distArg, ...args] = process.argv.slice(2)
  const dmgOnly = args[0] === '--dmg-only'
  const architectures = dmgOnly ? args.slice(1) : args
  if (!distArg || !architectures.length || architectures.some((arch) => !['arm64', 'x64'].includes(arch))) {
    usage()
    process.exitCode = 2
    return
  }

  const distDir = resolve(distArg)
  const entries = readdirSync(distDir)
  for (const arch of architectures) {
    const publicArch = arch === 'arm64' ? 'Apple-Silicon' : 'Intel'
    const dmgCandidates = entries.filter((name) => name.endsWith(`-mac-${arch}.dmg`) ||
      (dmgOnly && name.endsWith(`-mac-${publicArch}.dmg`)))
    const zipCandidates = entries.filter((name) => name.endsWith(`-mac-${arch}.zip`))
    if (dmgCandidates.length !== 1 || (!dmgOnly && zipCandidates.length !== 1)) {
      throw new Error(`Expected one DMG${dmgOnly ? '' : ' and one ZIP'} for ${arch}; found ${dmgCandidates.length} DMG and ${zipCandidates.length} ZIP.`)
    }

    const version = versionFromArtifactName(dmgCandidates[0])
    verifyDmg(join(distDir, dmgCandidates[0]), arch, version)
    if (dmgOnly) continue
    const zipVersion = versionFromArtifactName(zipCandidates[0].replace(/\.zip$/, '.dmg'))
    if (zipVersion !== version) throw new Error(`DMG and ZIP versions do not match for ${arch}.`)

    verifyZip(join(distDir, zipCandidates[0]), arch, version)
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[verify-mac-release-artifacts] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports._internals = {
  normalizeLipoArchitecture,
  versionFromArtifactName
}
