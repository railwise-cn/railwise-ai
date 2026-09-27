#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const { existsSync, readdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

const arch = process.argv[2]
if (arch !== 'arm64' && arch !== 'x64') {
  console.error('Usage: node scripts/zip-mac-app.cjs <arm64|x64>')
  process.exit(1)
}

const root = resolve(__dirname, '..')
const pkg = require(join(root, 'package.json'))
const productBrand = require(join(root, 'src', 'shared', 'product-brand.json'))
const version = (process.env.WORKWISE_APP_VERSION || pkg.version || '').trim()
if (!version) {
  console.error('[zip-mac-app] Could not resolve package version.')
  process.exit(1)
}

const distDir = resolve(process.env.WORKWISE_DIST_DIR || join(root, 'dist'))
const appOutDir = join(distDir, arch === 'arm64' ? 'mac-arm64' : 'mac')
const isCandidate = process.env.WORKWISE_CANDIDATE === '1'
const candidateHead = (process.env.WORKWISE_CANDIDATE_SOURCE_HEAD || '').trim()
const candidateApps = isCandidate
  ? readdirSync(appOutDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
      .map((entry) => entry.name)
  : []
if (isCandidate && candidateApps.length !== 1) {
  console.error(`[zip-mac-app] Expected exactly one candidate app bundle in ${appOutDir}, found ${candidateApps.length}.`)
  process.exit(1)
}
const appName = isCandidate ? candidateApps[0] : `${productBrand.platform}.app`
const appPath = join(appOutDir, appName)
const artifactPrefix = isCandidate && /^[0-9a-f]{12,40}$/.test(candidateHead)
  ? `WorkWise-Candidate-${candidateHead.slice(0, 12)}`
  : 'WorkWise'
const zipPath = join(distDir, `${artifactPrefix}-${version}-mac-${arch}.zip`)

if (!existsSync(appPath)) {
  console.error(`[zip-mac-app] App bundle not found: ${appPath}`)
  process.exit(1)
}

rmSync(zipPath, { force: true })
console.log(`[zip-mac-app] Creating ${zipPath}`)
execFileSync(
  'ditto',
  ['-c', '-k', '--sequesterRsrc', '--keepParent', appName, zipPath],
  {
    cwd: appOutDir,
    stdio: 'inherit'
  }
)
