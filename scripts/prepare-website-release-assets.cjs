#!/usr/bin/env node

const { createHash } = require('node:crypto')
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { basename, join, resolve } = require('node:path')
const productBrand = require('../src/shared/product-brand.json')

function usage() {
  console.error('Usage: node scripts/prepare-website-release-assets.cjs <inputDir> <outputDir> <version> [--channel stable|frontier] [--release-prefix workwise[/acceptance/RUN_ID]] [--public-base-url HTTPS_URL]')
}

function readOptions(argv) {
  const options = {
    channel: 'stable',
    releasePrefix: 'workwise',
    publicBaseUrl: 'https://www.railwise.cn/downloads'
  }
  for (let index = 5; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) die(`Missing value for ${flag}`)
    if (flag === '--channel') options.channel = value
    else if (flag === '--release-prefix') options.releasePrefix = value.replace(/^\/+|\/+$/g, '')
    else if (flag === '--public-base-url') options.publicBaseUrl = value.replace(/\/+$/, '')
    else die(`Unknown flag: ${flag}`)
    index += 1
  }
  if (!['stable', 'frontier'].includes(options.channel)) die(`Invalid channel: ${options.channel}`)
  if (!/^workwise(?:\/acceptance\/[1-9]\d*)?$/.test(options.releasePrefix)) {
    die(`Invalid release prefix: ${options.releasePrefix}`)
  }
  if (!options.publicBaseUrl.startsWith('https://')) die('Public base URL must use HTTPS.')
  return options
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readReleaseDate(outputDir) {
  const releaseDates = ['latest-mac.yml', 'latest.yml']
    .map((name) => readFileSync(join(outputDir, name), 'utf8').match(/^releaseDate:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1] || '')
    .filter(Boolean)
    .sort()
  return releaseDates.at(-1) || '1970-01-01T00:00:00.000Z'
}

function writeLatestJson(outputDir, version, options) {
  const updateBaseUrl = `${options.publicBaseUrl}/${options.releasePrefix}/channels/${options.channel}/latest/`
  const files = readdirSync(outputDir)
    .filter((name) => name.startsWith(`WorkWise-${version}-`))
    .sort()
    .map((name) => ({
      name,
      url: `${updateBaseUrl}${encodeURIComponent(name)}`,
      size: statSync(join(outputDir, name)).size,
      sha256: sha256(join(outputDir, name))
    }))
  const manifest = {
    schemaVersion: 1,
    productName: productBrand.platform,
    channel: options.channel,
    version,
    tag: `v${version}`,
    generatedAt: readReleaseDate(outputDir),
    updateBaseUrl,
    updateMetadata: {
      mac: `${updateBaseUrl}latest-mac.yml`,
      win: `${updateBaseUrl}latest.yml`
    },
    files
  }
  writeFileSync(join(outputDir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function die(message) {
  console.error(`[prepare-website-release-assets] ${message}`)
  process.exit(1)
}

function findOne(entries, pattern, label) {
  const matches = entries.filter((name) => pattern.test(name))
  if (matches.length !== 1) {
    die(`Expected exactly one ${label}, found ${matches.length}: ${matches.join(', ') || '<none>'}`)
  }
  return matches[0]
}

function copyMapped(inputDir, outputDir, fromName, toName, fileMap) {
  const source = join(inputDir, fromName)
  if (!existsSync(source)) die(`Missing input file: ${fromName}`)
  copyFileSync(source, join(outputDir, toName))
  fileMap.set(fromName, toName)
}

function rewriteUpdateMetadata(inputDir, outputDir, fileName, fileMap) {
  const inputPath = join(inputDir, fileName)
  if (!existsSync(inputPath)) die(`Missing update metadata: ${fileName}`)
  let text = readFileSync(inputPath, 'utf8')
  for (const [fromName, toName] of fileMap.entries()) {
    text = text.split(fromName).join(toName)
  }
  writeFileSync(join(outputDir, fileName), text, 'utf8')
}

function main() {
  const inputDir = resolve(process.argv[2] || '')
  const outputDir = resolve(process.argv[3] || '')
  const version = String(process.argv[4] || '').trim()
  if (!inputDir || !outputDir || !/^\d+\.\d+\.\d+$/.test(version)) {
    usage()
    die(`Invalid arguments: input=${process.argv[2] || ''}, output=${process.argv[3] || ''}, version=${version}`)
  }
  const options = readOptions(process.argv)

  if (!existsSync(inputDir)) die(`Input directory does not exist: ${inputDir}`)
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  const entries = readdirSync(inputDir)
  const arm64Dmg = findOne(entries, /^WorkWise-.+-mac-arm64\.dmg$/, 'macOS arm64 dmg')
  const x64Dmg = findOne(entries, /^WorkWise-.+-mac-x64\.dmg$/, 'macOS x64 dmg')
  const arm64Zip = findOne(entries, /^WorkWise-.+-mac-arm64\.zip$/, 'macOS arm64 update zip')
  const x64Zip = findOne(entries, /^WorkWise-.+-mac-x64\.zip$/, 'macOS x64 update zip')
  const winExe = findOne(entries, /^WorkWise-.+-win-x64\.exe$/, 'Windows x64 exe')

  const fileMap = new Map()
  copyMapped(inputDir, outputDir, arm64Dmg, `WorkWise-${version}-mac-Apple-Silicon.dmg`, fileMap)
  copyMapped(inputDir, outputDir, x64Dmg, `WorkWise-${version}-mac-Intel.dmg`, fileMap)
  copyMapped(inputDir, outputDir, arm64Zip, `WorkWise-${version}-mac-arm64.zip`, fileMap)
  copyMapped(inputDir, outputDir, x64Zip, `WorkWise-${version}-mac-x64.zip`, fileMap)
  copyMapped(inputDir, outputDir, winExe, `WorkWise-${version}-win-x64.exe`, fileMap)

  const winBlockMap = `${winExe}.blockmap`
  if (existsSync(join(inputDir, winBlockMap))) {
    copyMapped(inputDir, outputDir, winBlockMap, `WorkWise-${version}-win-x64.exe.blockmap`, fileMap)
  }

  rewriteUpdateMetadata(inputDir, outputDir, 'latest-mac.yml', fileMap)
  rewriteUpdateMetadata(inputDir, outputDir, 'latest.yml', fileMap)
  writeLatestJson(outputDir, version, options)

  const output = readdirSync(outputDir).map((name) => basename(name)).sort()
  for (const name of output) console.log(name)
}

main()
