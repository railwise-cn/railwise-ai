#!/usr/bin/env node
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFileSync, existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Keep the published manifest identity in lockstep with the packaged app.
// Artifact filenames intentionally retain the WorkWise prefix for updater
// compatibility, but latest.json must expose the public RailWise AI name.
const require = createRequire(import.meta.url)
const PRODUCT_NAME = require('../src/shared/product-brand.json').platform
const R2_COPY_CONCURRENCY = 3

function createR2RequestHandler() {
  return new NodeHttpHandler({
    connectionTimeout: 15_000,
    requestTimeout: 5 * 60_000
  })
}
const DEFAULT_RELEASE_PREFIX = 'workwise'
const DEFAULT_RELEASE_CHANNEL = 'frontier'
const PLATFORMS = ['mac', 'win']
const RELEASE_CHANNELS = ['frontier', 'stable']
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')

const PLATFORM_SPECS = {
  mac: {
    updateFile: 'latest-mac.yml',
    assetPattern: /^WorkWise-.+-mac-(arm64|x64)\.(dmg|zip)(\.blockmap)?$/
  },
  win: {
    updateFile: 'latest.yml',
    assetPattern: /^WorkWise-.+-win-x64\.exe(\.blockmap)?$/
  },
  linux: {
    updateFile: 'latest-linux.yml',
    assetPattern: /^WorkWise-.+-linux-x86_64\.AppImage(\.blockmap)?$/
  }
}

function usage() {
  console.log(`Usage:
  node scripts/publish-r2.mjs upload --platform mac|win --tag vX.Y.Z [--channel frontier|stable] [--dry-run]
  node scripts/publish-r2.mjs verify --tag vX.Y.Z [--channel frontier|stable] [--platforms mac,win]
  node scripts/publish-r2.mjs promote --tag vX.Y.Z [--channel frontier|stable] [--platforms mac,win] [--dry-run]
  node scripts/publish-r2.mjs rollback --tag vX.Y.Z [--channel frontier|stable] [--platforms mac,win]
  node scripts/publish-r2.mjs cleanup-acceptance --run-id 123456

If --platforms is omitted, promote uses the platform manifests already uploaded for that tag.
If --channel is omitted, the default channel is frontier.

Environment:
  WORKWISE_RELEASE_ENV=scripts/release.local.env
  RELEASE_CHANNEL=frontier|stable
  R2_BUCKET or S3_BUCKET
  R2_ENDPOINT or S3_ENDPOINT
  R2_ACCESS_KEY_ID or S3_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY or S3_SECRET_ACCESS_KEY
  R2_PUBLIC_BASE_URL
  WORKWISE_RELEASE_PREFIX=workwise
`)
}

function parseEnvFile(content) {
  const values = new Map()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values.set(match[1], value)
  }
  return values
}

function loadLocalEnv() {
  const configured = process.env.WORKWISE_RELEASE_ENV?.trim()
  const candidates = [
    configured,
    join(ROOT, 'scripts', 'release.local.env'),
    join(ROOT, 'release.local.env')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const values = parseEnvFile(readFileSync(candidate, 'utf8'))
    for (const [key, value] of values) {
      if (!process.env[key]) process.env[key] = value
    }
    console.log(`Loaded local release config: ${candidate}`)
    return candidate
  }
  return null
}

function readArgs(argv) {
  const flags = new Map()
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const name = arg.slice(2)
    if (name === 'dry-run' || name === 'help' || name === 'h' || name === 'stable' || name === 'frontier' || name === 'skip-retention') {
      flags.set(name, true)
      continue
    }
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`)
    }
    flags.set(name, value)
    i += 1
  }
  return { command: positionals[0], flags }
}

function requireFlag(flags, name) {
  const value = flags.get(name)
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required flag --${name}`)
  }
  return value.trim()
}

function normalizeTag(raw) {
  const tag = raw.trim()
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Tag must look like vX.Y.Z. electron-updater cannot use four-part versions, got: ${raw}`)
  }
  return tag
}

function normalizeChannel(raw) {
  const channel = String(raw || '').trim() || DEFAULT_RELEASE_CHANNEL
  if (!RELEASE_CHANNELS.includes(channel)) {
    throw new Error(`Release channel must be one of: ${RELEASE_CHANNELS.join(', ')}`)
  }
  return channel
}

function readChannel(flags) {
  if (flags.has('stable') && flags.has('frontier')) {
    throw new Error('Use only one of --stable or --frontier.')
  }
  if (flags.has('stable')) return 'stable'
  if (flags.has('frontier')) return 'frontier'
  return normalizeChannel(
    flags.get('channel') ||
      process.env.RELEASE_CHANNEL ||
      process.env.WORKWISE_UPDATE_CHANNEL ||
      DEFAULT_RELEASE_CHANNEL
  )
}

function positiveInt(raw, fallback) {
  const value = Number.parseInt(String(raw || '').trim(), 10)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

async function runConcurrently(items, limit, worker) {
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex]
        nextIndex += 1
        await worker(item)
      }
    })
  )
}

function normalizeBaseUrl(raw) {
  return raw.trim().replace(/\/+$/, '')
}

function trimSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '')
}

function joinUrl(base, ...parts) {
  return [normalizeBaseUrl(base), ...parts.map((p) => trimSlashes(p)).filter(Boolean)].join('/')
}

function channelBasePath(prefix, channel) {
  return `${prefix}/channels/${channel}`
}

function acceptancePrefixForRunId(prefix, rawRunId) {
  const runId = String(rawRunId || '').trim()
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new Error('Acceptance cleanup run id must be a positive GitHub Actions run id.')
  }
  const normalized = trimSlashes(prefix)
  const expected = `workwise/acceptance/${runId}`
  if (normalized !== expected) {
    throw new Error(`Refusing acceptance cleanup outside ${expected}: ${normalized || '<empty>'}`)
  }
  return `${expected}/`
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return ''
}

function normalizeS3Endpoint(rawEndpoint, bucket) {
  const value = rawEndpoint.trim()
  if (!value) return ''
  const url = new URL(value)
  const normalizedBucket = bucket.trim()
  const path = url.pathname.replace(/\/+$/, '')
  if (normalizedBucket && path === `/${normalizedBucket}`) {
    url.pathname = ''
  }
  return url.toString().replace(/\/+$/, '')
}

function readConfig({ dryRun = false } = {}) {
  loadLocalEnv()
  const accountId = firstEnv('R2_ACCOUNT_ID')
  const bucket = firstEnv('R2_BUCKET', 'S3_BUCKET')
  const accessKeyId = firstEnv('R2_ACCESS_KEY_ID', 'S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID')
  const secretAccessKey = firstEnv(
    'R2_SECRET_ACCESS_KEY',
    'S3_SECRET_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY'
  )
  const endpoint = normalizeS3Endpoint(firstEnv('R2_ENDPOINT', 'S3_ENDPOINT'), bucket)
  const publicBaseUrl = firstEnv(
    'WORKWISE_PUBLIC_BASE_URL',
    'WORKWISE_UPDATE_BASE_URL',
    'R2_PUBLIC_BASE_URL',
    'PUBLIC_DOWNLOAD_BASE_URL'
  )
  const prefix = trimSlashes(firstEnv('WORKWISE_RELEASE_PREFIX', 'R2_RELEASE_PREFIX') || DEFAULT_RELEASE_PREFIX)

  if (!publicBaseUrl) {
    throw new Error('WORKWISE_PUBLIC_BASE_URL or R2_PUBLIC_BASE_URL is required so manifests can contain public download URLs.')
  }
  if (!dryRun && /(^|\.)downloads\.example\.com$/i.test(new URL(publicBaseUrl).hostname)) {
    throw new Error('Replace the placeholder public download URL with your real WorkWise download domain.')
  }

  if (!dryRun) {
    const missing = []
    if (!endpoint && !accountId) missing.push('R2_ENDPOINT or R2_ACCOUNT_ID')
    if (!accessKeyId) missing.push('R2_ACCESS_KEY_ID or S3_ACCESS_KEY_ID')
    if (!secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY or S3_SECRET_ACCESS_KEY')
    if (!bucket) missing.push('R2_BUCKET or S3_BUCKET')
    if (missing.length) throw new Error(`Missing environment variable(s): ${missing.join(', ')}`)
  }

  const resolvedEndpoint = endpoint || `https://${accountId}.r2.cloudflarestorage.com`
  const client = dryRun
    ? null
    : new S3Client({
        region: 'auto',
        endpoint: resolvedEndpoint,
        credentials: { accessKeyId, secretAccessKey },
        forcePathStyle: true,
        requestHandler: createR2RequestHandler()
      })

  return { bucket, publicBaseUrl: normalizeBaseUrl(publicBaseUrl), prefix, client }
}

function quoteScalar(value) {
  const trimmed = value.trim()
  return trimmed.replace(/^['"]|['"]$/g, '')
}

function parseUpdateYml(source) {
  const version = quoteScalar(source.match(/^version:\s*(.+)$/m)?.[1] ?? '')
  const releaseDate = quoteScalar(source.match(/^releaseDate:\s*(.+)$/m)?.[1] ?? '')
  const files = []
  let current = null

  for (const line of source.split(/\r?\n/)) {
    const url = line.match(/^\s*-\s+url:\s*(.+)$/)
    if (url) {
      current = { url: quoteScalar(url[1]), sha512: '', size: 0 }
      files.push(current)
      continue
    }
    if (!current) continue
    const prop = line.match(/^\s+(sha512|size|blockMapSize):\s*(.+)$/)
    if (!prop) continue
    const [, key, value] = prop
    current[key] = key === 'sha512' ? quoteScalar(value) : Number.parseInt(value, 10) || 0
  }

  if (!version) throw new Error('Update metadata is missing version.')
  if (!files.length) throw new Error('Update metadata is missing files.')
  return { version, releaseDate, files }
}

async function hashFile(path, algorithm, encoding) {
  const hash = createHash(algorithm)
  await new Promise((resolvePromise, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolvePromise)
  })
  return hash.digest(encoding)
}

function contentType(fileName) {
  if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) return 'text/yaml; charset=utf-8'
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8'
  if (fileName.endsWith('.zip')) return 'application/zip'
  if (fileName.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (fileName.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  return 'application/octet-stream'
}

function cacheControlFor(key) {
  if (/\/latest\/latest(?:-[\w]+)?\.(?:json|yml)$/.test(key)) {
    return 'public, max-age=60, must-revalidate'
  }
  if (/\/latest\/.+\.(?:dmg|zip|exe|blockmap)$/.test(key)) {
    return 'public, max-age=31536000, immutable'
  }
  return 'public, max-age=31536000, immutable'
}

function classifyDownload(fileName, platform) {
  const extension = fileName.endsWith('.dmg')
      ? 'dmg'
      : fileName.endsWith('.zip')
        ? 'zip'
        : fileName.endsWith('.exe')
          ? 'exe'
          : 'bin'

  if (platform === 'mac') {
    const arch = fileName.includes('-arm64.') ? 'arm64' : 'x64'
    return {
      platform,
      arch,
      format: extension,
      label: arch === 'arm64' ? `macOS Apple Silicon ${extension.toUpperCase()}` : `macOS Intel ${extension.toUpperCase()}`
    }
  }
  if (platform === 'win') {
    return { platform, arch: 'x64', format: extension, label: 'Windows x64 installer' }
  }
  throw new Error(`Unsupported platform: ${platform}`)
}

async function collectPlatformRelease({ distDir, platform, tag, channel, config }) {
  const spec = PLATFORM_SPECS[platform]
  if (!spec) throw new Error(`Unsupported platform: ${platform}`)

  const entries = await readdir(distDir)
  const updatePath = join(distDir, spec.updateFile)
  const updateText = await readFile(updatePath, 'utf8')
  const updateMetadata = parseUpdateYml(updateText)
  const tagVersion = tag.slice(1)
  if (updateMetadata.version !== tagVersion) {
    throw new Error(
      `${spec.updateFile} version ${updateMetadata.version} does not match ${tag}. Rebuild with WORKWISE_APP_VERSION=${tagVersion}.`
    )
  }

  const referenced = new Set(updateMetadata.files.map((file) => basename(file.url)))
  const assets = entries.filter((name) => spec.assetPattern.test(name))
  for (const name of referenced) {
    if (!entries.includes(name)) {
      throw new Error(`${spec.updateFile} references ${name}, but it was not found in ${distDir}`)
    }
  }

  const fileNames = Array.from(new Set([spec.updateFile, ...assets, ...referenced])).sort()
  const files = []
  const downloadByName = new Map(updateMetadata.files.map((file) => [basename(file.url), file]))

  for (const fileName of fileNames) {
    const path = join(distDir, fileName)
    const info = await stat(path)
    if (!info.isFile()) continue
    const basePath = channelBasePath(config.prefix, channel)
    const archiveKey = `${basePath}/releases/${tag}/${fileName}`
    const sha256 = await hashFile(path, 'sha256', 'hex')
    const sha512 = await hashFile(path, 'sha512', 'base64')
    files.push({
      fileName,
      path,
      key: archiveKey,
      size: info.size,
      sha256,
      sha512,
      contentType: contentType(fileName),
      updateMetadata: fileName === spec.updateFile,
      downloadable: downloadByName.has(fileName)
    })
  }

  const filesByName = new Map(files.map((file) => [file.fileName, file]))
  const downloads = updateMetadata.files.map((file) => {
    const fileName = basename(file.url)
    const local = filesByName.get(fileName)
    if (!local) throw new Error(`Missing collected file: ${fileName}`)
    return {
      ...classifyDownload(fileName, platform),
      fileName,
      size: local.size,
      sha256: local.sha256,
      sha512: file.sha512 || local.sha512,
      blockMapSize: file.blockMapSize,
      archiveUrl: joinUrl(config.publicBaseUrl, config.prefix, 'channels', channel, 'releases', tag, fileName),
      latestUrl: joinUrl(config.publicBaseUrl, config.prefix, 'channels', channel, 'latest', fileName)
    }
  })

  return {
    schemaVersion: 1,
    productName: PRODUCT_NAME,
    tag,
    channel,
    platform,
    version: updateMetadata.version,
    releaseDate: updateMetadata.releaseDate,
    generatedAt: new Date().toISOString(),
    updateMetadata: {
      fileName: spec.updateFile,
      archiveUrl: joinUrl(config.publicBaseUrl, config.prefix, 'channels', channel, 'releases', tag, spec.updateFile),
      latestUrl: joinUrl(config.publicBaseUrl, config.prefix, 'channels', channel, 'latest', spec.updateFile)
    },
    files,
    downloads
  }
}

async function putObject({ config, key, body, contentType: type, cacheControl, contentLength, dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] put s3://${config.bucket || '<bucket>'}/${key}`)
    return
  }
  const input = {
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: type,
    CacheControl: cacheControl
  }
  if (typeof contentLength === 'number') input.ContentLength = contentLength
  await config.client.send(new PutObjectCommand(input))
}

async function copyObject({ config, fromKey, toKey, type, dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] copy s3://${config.bucket}/${fromKey} -> s3://${config.bucket}/${toKey}`)
    return
  }
  const copySource = `${config.bucket}/${fromKey}`
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  await config.client.send(
    new CopyObjectCommand({
      Bucket: config.bucket,
      Key: toKey,
      CopySource: copySource,
      ContentType: type,
      CacheControl: cacheControlFor(toKey),
      MetadataDirective: 'REPLACE'
    })
  )
}

async function uploadPlatform({ flags, dryRun }) {
  const platform = requireFlag(flags, 'platform')
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`--platform must be one of: ${PLATFORMS.join(', ')}`)
  }
  const tag = normalizeTag(requireFlag(flags, 'tag'))
  const channel = readChannel(flags)
  const distDir = resolve(flags.get('dist') || 'dist')
  const config = readConfig({ dryRun })
  const release = await collectPlatformRelease({ distDir, platform, tag, channel, config })

  console.log(
    `Uploading ${PRODUCT_NAME} ${release.version} ${platform} assets to R2 ${channel} archive ${tag}`
  )
  const uploadConcurrency = positiveInt(
    process.env.R2_UPLOAD_CONCURRENCY || process.env.RELEASE_UPLOAD_CONCURRENCY,
    4
  )
  console.log(`Using R2 upload concurrency: ${uploadConcurrency}`)
  await runConcurrently(release.files, uploadConcurrency, async (file) => {
    await putObject({
      config,
      key: file.key,
      body: createReadStream(file.path),
      contentType: file.contentType,
      cacheControl: cacheControlFor(file.key),
      contentLength: file.size,
      dryRun
    })
    console.log(`  ${file.fileName}`)
  })

  const manifestKey = `${channelBasePath(config.prefix, channel)}/releases/${tag}/release-${platform}.json`
  const manifest = JSON.stringify(
    {
      ...release,
      files: release.files.map(({ path: _path, ...file }) => file)
    },
    null,
    2
  )
  await putObject({
    config,
    key: manifestKey,
    body: manifest,
    contentType: 'application/json; charset=utf-8',
    cacheControl: 'public, max-age=31536000, immutable',
    dryRun
  })
  console.log(`  release-${platform}.json`)
}

async function listReleaseKeys(config, tag, channel) {
  const prefix = `${channelBasePath(config.prefix, channel)}/releases/${tag}/`
  const keys = []
  let ContinuationToken
  do {
    const res = await config.client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        ContinuationToken
      })
    )
    for (const item of res.Contents ?? []) {
      if (item.Key) keys.push(item.Key)
    }
    ContinuationToken = res.NextContinuationToken
  } while (ContinuationToken)
  return keys
}

async function listPrefixKeys(config, prefix) {
  const keys = []
  let ContinuationToken
  do {
    const response = await config.client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: prefix,
      ContinuationToken
    }))
    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key)
    }
    ContinuationToken = response.NextContinuationToken
  } while (ContinuationToken)
  return keys
}

async function cleanupAcceptance({ flags, dryRun }) {
  if (dryRun) throw new Error('Acceptance cleanup does not support --dry-run; omit cleanup instead.')
  const runId = requireFlag(flags, 'run-id')
  const config = readConfig({ dryRun: false })
  const prefix = acceptancePrefixForRunId(config.prefix, runId)
  const keys = await listPrefixKeys(config, prefix)
  if (!keys.length) {
    console.log(`No isolated acceptance objects found under ${prefix}`)
    return
  }
  for (let index = 0; index < keys.length; index += 1000) {
    await config.client.send(new DeleteObjectsCommand({
      Bucket: config.bucket,
      Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true }
    }))
  }
  console.log(`Removed ${keys.length} isolated acceptance object(s) under ${prefix}`)
}

function compareReleaseTagsDescending(a, b) {
  const parts = (value) => value.slice(1).split('.').map(Number)
  const left = parts(a); const right = parts(b)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index]
  }
  return 0
}

async function enforceReleaseRetention(config, channel, keep = 3, dryRun = false) {
  const releaseRoot = `${channelBasePath(config.prefix, channel)}/releases/`
  const keys = []
  let ContinuationToken
  do {
    const response = await config.client.send(new ListObjectsV2Command({
      Bucket: config.bucket,
      Prefix: releaseRoot,
      Delimiter: '/',
      ContinuationToken
    }))
    for (const prefix of response.CommonPrefixes ?? []) {
      const tag = prefix.Prefix?.slice(releaseRoot.length).replace(/\/$/, '')
      if (tag && /^v\d+\.\d+\.\d+$/.test(tag)) keys.push(tag)
    }
    ContinuationToken = response.NextContinuationToken
  } while (ContinuationToken)
  const expired = [...new Set(keys)].sort(compareReleaseTagsDescending).slice(keep)
  for (const tag of expired) {
    const objects = await listReleaseKeys(config, tag, channel)
    if (!objects.length) continue
    if (dryRun) {
      console.log(`[dry-run] retain ${keep}: delete ${objects.length} objects for ${tag}`)
      continue
    }
    for (let index = 0; index < objects.length; index += 1000) {
      await config.client.send(new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: { Objects: objects.slice(index, index + 1000).map((Key) => ({ Key })), Quiet: true }
      }))
    }
    console.log(`Retention removed archived release ${tag}`)
  }
}

async function getJson(config, key) {
  const res = await config.client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  const text = await res.Body.transformToString()
  return JSON.parse(text)
}

async function hashR2Object(config, key, expectedSize) {
  const response = await config.client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
  if (!response.Body) throw new Error(`R2 object has no body: ${key}`)
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of response.Body) {
    hash.update(chunk)
    size += chunk.byteLength
  }
  if (Number.isFinite(expectedSize) && size !== expectedSize) {
    throw new Error(`R2 object size mismatch for ${key}: ${size} != ${expectedSize}`)
  }
  if (Number.isFinite(response.ContentLength) && response.ContentLength !== size) {
    throw new Error(`R2 Content-Length mismatch for ${key}: ${response.ContentLength} != ${size}`)
  }

  const range = await config.client.send(new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Range: 'bytes=0-1023'
  }))
  if (!range.Body || !/^bytes 0-\d+\/\d+$/i.test(range.ContentRange ?? '')) {
    throw new Error(`R2 Range download verification failed for ${key}`)
  }
  await range.Body.transformToByteArray()
  return hash.digest('base64')
}

async function verifyRemoteRelease({ flags }) {
  const tag = normalizeTag(requireFlag(flags, 'tag')); const channel = readChannel(flags)
  const platforms = String(flags.get('platforms') || 'mac,win').split(',').map((value) => value.trim()).filter(Boolean)
  const config = readConfig({ dryRun: false })
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`)
    const key = `${channelBasePath(config.prefix, channel)}/releases/${tag}/release-${platform}.json`
    const manifest = await getJson(config, key)
    if (manifest.tag !== tag || manifest.version !== tag.slice(1)) throw new Error(`Remote ${platform} manifest identity mismatch`)
    for (const file of manifest.files ?? []) {
      if (file.key !== `${channelBasePath(config.prefix, channel)}/releases/${tag}/${file.fileName}`) {
        throw new Error(`Remote object key mismatch for ${file.fileName}`)
      }
      const sha512 = await hashR2Object(config, file.key, Number(file.size))
      if (sha512 !== file.sha512) throw new Error(`Remote SHA-512 mismatch for ${file.fileName}`)
      console.log(`Verified R2 object, Range and SHA-512: ${file.fileName}`)
    }
  }
}

export function buildLatestManifest({ platformManifests, channel, tag, publicBaseUrl, basePath, generatedAt }) {
  const releaseDates = platformManifests.map(manifest => manifest.releaseDate).filter(Boolean).sort()
  return {
    schemaVersion: 1,
    productName: PRODUCT_NAME,
    channel,
    version: tag.slice(1),
    tag,
    releaseDate: releaseDates.at(-1) ?? generatedAt,
    generatedAt,
    githubReleaseUrl: `https://github.com/railwise-cn/railwise-ai/releases/tag/${tag}`,
    updateBaseUrl: joinUrl(publicBaseUrl, basePath, 'latest') + '/',
    updateMetadata: Object.fromEntries(platformManifests.map(manifest => [manifest.platform, {
      fileName: manifest.updateMetadata.fileName,
      url: joinUrl(publicBaseUrl, basePath, 'latest', manifest.updateMetadata.fileName)
    }])),
    downloads: platformManifests.flatMap(manifest => manifest.downloads.map(download => ({
      ...download, url: joinUrl(publicBaseUrl, basePath, 'latest', download.fileName)
    })))
  }
}

async function promoteRelease({ flags, dryRun }) {
  const tag = normalizeTag(requireFlag(flags, 'tag'))
  const channel = readChannel(flags)
  const generatedAt = flags.get('generated-at') || new Date().toISOString()
  if (new Date(generatedAt).toISOString() !== generatedAt) throw new Error('Invalid --generated-at timestamp')
  const requestedPlatforms = flags.has('platforms')
  const platforms = String(flags.get('platforms') || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  for (const platform of platforms) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform in --platforms: ${platform}`)
  }

  const config = readConfig({ dryRun: false })
  const releaseKeys = await listReleaseKeys(config, tag, channel)
  if (!releaseKeys.length) throw new Error(`No archived R2 objects found for ${tag}`)

  if (!requestedPlatforms) {
    for (const platform of PLATFORMS) {
      const key = `${channelBasePath(config.prefix, channel)}/releases/${tag}/release-${platform}.json`
      if (releaseKeys.includes(key)) platforms.push(platform)
    }
  }
  if (!platforms.length) {
    throw new Error(
      `No platform manifests found for ${tag}. Run upload for at least one platform before promoting.`
    )
  }

  const platformManifests = []
  for (const platform of platforms) {
    const key = `${channelBasePath(config.prefix, channel)}/releases/${tag}/release-${platform}.json`
    if (!releaseKeys.includes(key)) {
      throw new Error(`Missing ${key}. Run upload for ${platform} before promoting.`)
    }
    platformManifests.push(await getJson(config, key))
  }

  for (const manifest of platformManifests) {
    if (manifest.tag !== tag || manifest.version !== tag.slice(1)) {
      throw new Error(`Archived manifest identity mismatch for ${manifest.platform}: ${manifest.tag}/${manifest.version}`)
    }
    for (const download of manifest.downloads ?? []) {
      if (!download.sha512 || !download.archiveUrl?.startsWith('https://')) {
        throw new Error(`Archived manifest has an untrusted download entry: ${download.fileName ?? 'unknown'}`)
      }
    }
  }

  const allFiles = new Map()
  for (const manifest of platformManifests) {
    for (const file of manifest.files) {
      allFiles.set(file.fileName, file)
    }
  }

  const latestTargets = [{ basePath: channelBasePath(config.prefix, channel), label: `${channel} latest` }]
  if (channel === 'stable') {
    latestTargets.push({ basePath: config.prefix, label: 'legacy stable latest' })
  }

  console.log(`Promoting ${PRODUCT_NAME} ${tag} to R2 ${channel} latest (${platforms.join(', ')})`)
  for (const target of latestTargets) {
    console.log(`Target: ${target.label}`)
    await runConcurrently([...allFiles.values()], R2_COPY_CONCURRENCY, async (file) => {
      const toKey = `${target.basePath}/latest/${file.fileName}`
      await copyObject({
        config,
        fromKey: file.key,
        toKey,
        type: file.contentType,
        dryRun
      })
      console.log(`  ${file.fileName}`)
    })
  }

  const versions = new Set(platformManifests.map((manifest) => manifest.version))
  if (versions.size > 1) {
    throw new Error(`Cannot promote mixed versions: ${Array.from(versions).join(', ')}`)
  }
  for (const target of latestTargets) {
    const latestManifest = buildLatestManifest({ platformManifests, channel, tag,
      publicBaseUrl: config.publicBaseUrl, basePath: target.basePath, generatedAt })

    const latestKey = `${target.basePath}/latest/latest.json`
    await putObject({
      config,
      key: latestKey,
      body: JSON.stringify(latestManifest, null, 2),
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'public, max-age=60, must-revalidate',
      dryRun
    })
    console.log(`  ${target.label}/latest.json`)
    console.log(`Latest manifest: ${joinUrl(config.publicBaseUrl, target.basePath, 'latest', 'latest.json')}`)
  }
  if (!flags.has('skip-retention')) await enforceReleaseRetention(config, channel, 3, dryRun)
}

async function main() {
  const { command, flags } = readArgs(process.argv.slice(2))
  if (flags.has('help') || flags.has('h') || !command) {
    usage()
    return
  }
  const dryRun = flags.has('dry-run')

  if (command === 'upload') {
    await uploadPlatform({ flags, dryRun })
    return
  }
  if (command === 'verify') {
    await verifyRemoteRelease({ flags })
    return
  }
  if (command === 'promote' || command === 'rollback') {
    await promoteRelease({ flags, dryRun })
    return
  }
  if (command === 'cleanup-acceptance') {
    await cleanupAcceptance({ flags, dryRun })
    return
  }
  throw new Error(`Unknown command: ${command}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[publish-r2] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

export const _internals = {
  productName: PRODUCT_NAME,
  normalizeTag,
  normalizeChannel,
  compareReleaseTagsDescending,
  acceptancePrefixForRunId,
  parseUpdateYml,
  classifyDownload,
  createR2RequestHandler,
  R2_COPY_CONCURRENCY
}
