#!/usr/bin/env node

const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { basename, join, resolve } = require('node:path')
const productBrand = require('../src/shared/product-brand.json')
const publication = require('./release-publication.cjs')

function usage() {
  console.error('Usage: node scripts/prepare-website-release-assets.cjs <inputDir> <outputDir> <version> [--channel stable|frontier] [--release-prefix workwise[/acceptance/RUN_ID]] [--public-base-url HTTPS_URL]')
}

function readOptions(argv) {
  const options = {
    channel: 'stable',
    releasePrefix: publication.policy.downloadNamespace,
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
  publication.namespace(options.releasePrefix)
  if (!options.publicBaseUrl.startsWith('https://')) die('Public base URL must use HTTPS.')
  return options
}

function readReleaseDate(outputDir) {
  const releaseDates = ['latest-mac.yml', 'latest.yml']
    .map((name) => readFileSync(join(outputDir, name), 'utf8').match(/^releaseDate:\s*['"]?([^'"\s]+)['"]?\s*$/m)?.[1] || '')
    .filter(Boolean)
    .sort()
  return releaseDates.at(-1) || '1970-01-01T00:00:00.000Z'
}

function writeLatestJson(outputDir, sealed) {
  const updateBaseUrl = sealed.updateBaseUrl
  const files = sealed.files.map(file => ({ name: file.name, url: file.latestUrl, size: file.size, sha256: file.sha256 }))
  const manifest = {
    schemaVersion: 1,
    productName: productBrand.platform,
    channel: sealed.channel,
    version: sealed.version,
    tag: sealed.tag,
    generatedAt: sealed.publishedAt,
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
  // Public URLs are independent of the immutable legacy storage key.
  const publicOptions = { ...options, releasePrefix: options.releasePrefix.includes('/acceptance/') ? options.releasePrefix : publication.policy.downloadNamespace }

  if (!existsSync(inputDir)) die(`Input directory does not exist: ${inputDir}`)
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })

  const entries = readdirSync(inputDir)
  const fileMap = new Map()
  for (const spec of [
    ...['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(format => ({ platform: 'mac', arch, format }))),
    { platform: 'win', arch: 'x64', format: 'exe' }
  ]) {
    const matches = entries.filter(name => {
      const parsed = publication.parseArtifactName(name)
      return parsed && !parsed.blockmap && parsed.version === version && parsed.platform === spec.platform && parsed.arch === spec.arch && parsed.format === spec.format
    })
    if (matches.length !== 1) die(`Expected exactly one ${spec.platform}/${spec.arch}/${spec.format}, found ${matches.length}`)
    const sourceName = matches[0]
    const targetName = publication.artifactName({ version, ...spec, publicName: true })
    copyMapped(inputDir, outputDir, sourceName, targetName, fileMap)
    if (existsSync(join(inputDir, `${sourceName}.blockmap`))) copyMapped(inputDir, outputDir, `${sourceName}.blockmap`, `${targetName}.blockmap`, fileMap)
  }

  rewriteUpdateMetadata(inputDir, outputDir, 'latest-mac.yml', fileMap)
  rewriteUpdateMetadata(inputDir, outputDir, 'latest.yml', fileMap)
  const manifest = publication.createPublicationManifest({ directory: outputDir, version, sourceHead: process.env.GITHUB_SHA || '', publishedAt: readReleaseDate(outputDir), ...publicOptions })
  writeFileSync(join(outputDir, 'publication-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeLatestJson(outputDir, manifest)

  const output = readdirSync(outputDir).map((name) => basename(name)).sort()
  for (const name of output) console.log(name)
}

main()
