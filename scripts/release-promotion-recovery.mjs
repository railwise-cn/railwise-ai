#!/usr/bin/env node
// Preserve the currently selected public versions before this attempt changes them.
// Immutable uploads and draft preparation do not authorize a pointer rollback.
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import YAML from 'yaml'
import { buildLatestManifest } from './publish-r2.mjs'

const REPOSITORY = 'railwise-cn/railwise-ai'
const SURFACES = ['r2', 'website']
const FILES = ['latest.json', 'latest.yml', 'latest-mac.yml']
const BASES = ['workwise/channels/stable/latest', 'workwise/latest']
const KEYS = BASES.flatMap(base => FILES.map(name => `${base}/${name}`))
const MAX_BYTES = 4 * 1024 * 1024
function fail(message) { throw new Error(`[release-recovery] ${message}`) }
function tagVersion(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) fail('invalid exact release tag')
  return tag.slice(1)
}
function compareVersions(left, right) {
  const a = tagVersion(left).split('.').map(Number); const b = tagVersion(right).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  return 0
}
export function selectedTag(pointers) {
  const value = readManifest(KEYS[0], pointers[KEYS[0]])
  return `v${value.version}`
}
function equal(actual, expected, message) { if (!isDeepStrictEqual(actual, expected)) fail(message) }
function readManifest(key, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) fail('invalid pointer content')
  const value = key.endsWith('.json') ? JSON.parse(content) : YAML.parse(content)
  if (!/^\d+\.\d+\.\d+$/.test(value?.version ?? '')) fail(`invalid pointer version: ${key}`)
  if (key.endsWith('.json')) equal(value.tag, `v${value.version}`, `pointer tag/version mismatch: ${key}`)
  return value
}
function validatePointers(pointers, expectedTag) {
  equal(Object.keys(pointers).sort(), [...KEYS].sort(), 'missing, extra or duplicate public pointers')
  for (const key of KEYS) equal(readManifest(key, pointers[key]).version, tagVersion(expectedTag), `public pointers disagree: ${key}`)
}
export function capturePromotionState({ targetTag, attempt, pointers, targetPointers, generatedAt = new Date().toISOString() }) {
  tagVersion(targetTag)
  const previousTag = selectedTag(pointers.r2)
  if (compareVersions(targetTag, previousTag) <= 0) fail(`target ${targetTag} must be newer than current Stable ${previousTag}`)
  for (const surface of SURFACES) validatePointers(pointers[surface], previousTag)
  for (const surface of SURFACES) validatePointers(targetPointers?.[surface], targetTag)
  if (new Date(generatedAt).toISOString() !== generatedAt) fail('invalid promotion timestamp')
  return { schemaVersion: 1, targetTag, previousTag, attempt, generatedAt, status: 'prepared', pointers, targetPointers }
}
export function verifyDraftRelease(pages, targetTag) {
  tagVersion(targetTag)
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) fail('invalid GitHub release listing')
  const matches = pages.flat().filter(release => release?.tag_name === targetTag)
  if (matches.length > 1 || matches.some(release => release.draft !== true)) fail('an already-published GitHub Release must never be edited or have its assets replaced')
  return { exists: matches.length === 1 }
}
export function markPromotionStarted(state, current) {
  equal(state.status, 'prepared', 'only a prepared attempt can start promotion')
  for (const surface of SURFACES) equal(current[surface], state.pointers[surface], `public ${surface} changed after preparation; refusing promotion`)
  return { ...state, status: 'started' }
}
export async function preparePromotionStart(state, transport) {
  for (const surface of SURFACES) await transport.verifyArchive(state, surface)
  const current = {}
  for (const surface of SURFACES) current[surface] = await transport.readSurface(surface)
  return markPromotionStarted(state, current)
}
export function verifyArchivePointers(state, surface, archived) {
  validatePointers(archived, state.previousTag)
  equal(archived, state.pointers[surface], `${surface} previous archive metadata differs from the saved public pointers`)
}
export function mergeRecoveryFile(files, key, file) {
  const previous = files.get(key)
  if (previous) {
    equal(file.fileName, previous.fileName, `conflicting saved R2 package identity: ${key}`)
    equal(file.sha512, previous.sha512, `conflicting saved R2 package hashes: ${key}`)
    if (file.size !== undefined && previous.size !== undefined) equal(Number(file.size), Number(previous.size), `conflicting saved R2 package sizes: ${key}`)
  }
  files.set(key, { ...previous, ...file, size: file.size ?? previous?.size })
}
function recoveryNeeded(state, surface, current) {
  equal(Object.keys(current).sort(), [...KEYS].sort(), 'incomplete recovery pointer read')
  let changed = false
  for (const key of KEYS) {
    if (current[key] === state.pointers[surface][key]) continue
    changed = true
    readManifest(key, current[key])
    if (current[key] !== state.targetPointers[surface][key]) fail(`another release now owns ${surface}/${key}; refusing to overwrite changed metadata`)
  }
  return changed
}
function assertRestored(state, surface, current) {
  validatePointers(current, state.previousTag)
  equal(current, state.pointers[surface], `restored ${surface} differs from the exact saved public metadata`)
}
export function publicationState(pages, targetTag) {
  tagVersion(targetTag)
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) fail('invalid GitHub publication status response')
  const matches = pages.flat().filter(release => release?.tag_name === targetTag)
  if (matches.length > 1 || matches.some(release => typeof release.draft !== 'boolean')) fail('ambiguous GitHub publication status')
  return matches.length ? (matches[0].draft ? 'draft' : 'published') : 'absent'
}
export function verifyPublishedInstallers(release, state) {
  equal(release?.tag_name, state.targetTag, 'GitHub publication tag mismatch')
  equal(release?.draft, false, 'GitHub release is not published')
  equal(release?.prerelease, false, 'GitHub release is not a stable release')
  const expected = state.installers
  if (!expected || !Object.keys(expected).length || !Array.isArray(release.assets)) fail('missing reviewed GitHub installer identities')
  equal(release.assets.map(asset => asset.name).sort(), Object.keys(expected).sort(), 'published GitHub installers differ from the reviewed set')
  for (const asset of release.assets) {
    equal(asset.size, expected[asset.name].size, `published GitHub installer size differs: ${asset.name}`)
    if (asset.digest) equal(asset.digest, `sha256:${expected[asset.name].sha256}`, `published GitHub installer digest differs: ${asset.name}`)
  }
}
export async function recoverPromotion(state, { readSurface, restoreSurface, verifyArchive, getPublicationState, verifyPublishedRelease }) {
  if (state.status !== 'started') return { status: 'not-started', restored: [] }
  const publication = await getPublicationState()
  if (publication === 'published') {
    await verifyPublishedRelease(state)
    for (const surface of SURFACES) equal(await readSurface(surface), state.targetPointers[surface], `published GitHub release has inconsistent ${surface} pointers; refusing automatic rollback`)
    return { status: 'published-reconciled', restored: [] }
  }
  if (!['draft', 'absent'].includes(publication)) fail('GitHub publication status is unknown; refusing automatic rollback')
  const restored = []; const failures = []
  for (const surface of SURFACES) {
    try {
      const current = await readSurface(surface)
      if (recoveryNeeded(state, surface, current)) {
        await verifyArchive(state, surface)
        const beforeWrite = await readSurface(surface)
        equal(beforeWrite, current, `public ${surface} changed during recovery validation; refusing automatic rollback`)
        recoveryNeeded(state, surface, beforeWrite)
        await restoreSurface(surface, state)
        assertRestored(state, surface, await readSurface(surface))
        restored.push(surface)
      }
    } catch (error) { failures.push(`${surface}: ${error.message}`) }
  }
  if (failures.length) {
    const error = new Error(`[release-recovery] automatic recovery incomplete: ${failures.join('; ')}`)
    error.recoveryResult = { status: 'incomplete', restored, failures }
    throw error
  }
  return { status: 'restored', restored }
}
export async function commitPublication(state, { publishRelease, getPublicationState, verifyPublishedRelease, readSurface }) {
  equal(state.status, 'started', 'only a started promotion may publish GitHub')
  for (const surface of SURFACES) equal(await readSurface(surface), state.targetPointers[surface], `public ${surface} changed before GitHub publication; refusing final commit`)
  let requestFailed = false
  try { await publishRelease() } catch { requestFailed = true }
  const publication = await getPublicationState()
  if (publication !== 'published') fail(`GitHub publication status is ${publication}; final commit was not verified`)
  await verifyPublishedRelease(state)
  for (const surface of SURFACES) equal(await readSurface(surface), state.targetPointers[surface], `published GitHub release has inconsistent ${surface} pointers; refusing automatic rollback`)
  return { status: requestFailed ? 'published-reconciled' : 'published', restored: [] }
}
export function trustedAttempt(env = process.env, targetTag) {
  tagVersion(targetTag)
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_REF !== `refs/tags/${targetTag}` || env.GITHUB_REF_NAME !== targetTag
    || env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/release.yml@refs/tags/${targetTag}`
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA
    || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) fail('recovery requires this exact tagged public release workflow')
  return { repository: REPOSITORY, sourceHead: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }
}
function sshTransport(env) {
  const host = env.WORKWISE_WEBSITE_SSH_HOST; const user = env.WORKWISE_WEBSITE_SSH_USER
  const port = env.WORKWISE_WEBSITE_SSH_PORT; const root = env.WORKWISE_WEBSITE_RELEASE_ROOT
  if (!/^[A-Za-z0-9.-]+$/.test(host ?? '') || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user ?? '')
    || !/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535
    || !/^\/[A-Za-z0-9._/-]+$/.test(root ?? '') || root.split('/').includes('..')) fail('invalid pinned website transport')
  for (const key of ['WORKWISE_WEBSITE_SSH_KEY_PATH', 'WORKWISE_WEBSITE_SSH_KNOWN_HOSTS_PATH']) {
    if (!env[key]?.startsWith('/')) fail('pinned SSH key and known_hosts are required')
  }
  const args = ['-p', port, '-i', env.WORKWISE_WEBSITE_SSH_KEY_PATH, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${env.WORKWISE_WEBSITE_SSH_KNOWN_HOSTS_PATH}`, `${user}@${host}`]
  return { root, args }
}
function runNode(args) { execFileSync(process.execPath, args, { stdio: 'inherit', timeout: 30 * 60_000 }) }
function githubReleasePages() {
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/${REPOSITORY}/releases?per_page=100`], { encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 60_000 }))
}
async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function reviewedInstallers(targetTag) {
  const version = tagVersion(targetTag); const installers = {}
  for (const name of [`WorkWise-${version}-mac-Apple-Silicon.dmg`, `WorkWise-${version}-mac-Intel.dmg`, `WorkWise-${version}-win-x64.exe`]) {
    const path = resolve('public-release-assets', name)
    installers[name] = { sha256: await sha256File(path), size: statSync(path).size }
  }
  return installers
}
function liveTransport(env) {
  for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!env[key]) fail(`missing ${key}`)
  if (!/^[a-f0-9]{32}$/.test(env.R2_ACCOUNT_ID)) fail('invalid R2 account')
  const client = new S3Client({ region: 'auto', endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, forcePathStyle: true,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }, requestHandler: new NodeHttpHandler({ connectionTimeout: 15_000, requestTimeout: 30_000 }) })
  const ssh = sshTransport(env)
  const readR2Text = async key => {
    const response = await client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }))
    if (!response.Body || response.ContentLength > MAX_BYTES) fail('invalid R2 pointer response')
    const content = await response.Body.transformToString()
    if (Buffer.byteLength(content) > MAX_BYTES) fail('oversized R2 pointer response')
    return content
  }
  const readWebsiteArchive = tag => {
    tagVersion(tag)
    const script = `set -euo pipefail\nroot="$1"; release="$root/channels/stable/releases/$2"; test -d "$release"; test -f "$release/SHA256SUMS.txt"; (cd "$release" && sha256sum -c SHA256SUMS.txt >&2)\npython3 - "$release" <<'PY'\nimport json, pathlib, sys\nroot = pathlib.Path(sys.argv[1])\npointers = {}\nfor name in ['latest.json', 'latest.yml', 'latest-mac.yml']:\n p = root / name\n if not p.is_file() or p.stat().st_size > ${MAX_BYTES}: raise SystemExit('Invalid archived website pointer')\n for base in ['workwise/channels/stable/latest', 'workwise/latest']:\n  pointers[base + '/' + name] = p.read_bytes().decode('utf-8')\nprint(json.dumps(pointers))\nPY\n`
    return JSON.parse(execFileSync('ssh', [...ssh.args, 'bash', '-s', '--', ssh.root, tag], { input: script, encoding: 'utf8', maxBuffer: MAX_BYTES * 6, timeout: 5 * 60_000 }))
  }
  const readSurface = async surface => {
    if (surface === 'r2') {
      const pointers = {}
      for (const key of KEYS) pointers[key] = await readR2Text(key)
      return pointers
    }
    const script = `set -euo pipefail\npython3 - '${ssh.root}' <<'PY'\nimport json, pathlib, sys\nroot = pathlib.Path(sys.argv[1])\npointers = {}\nfor base in ['channels/stable/latest', 'latest']:\n for name in ['latest.json', 'latest.yml', 'latest-mac.yml']:\n  p = root / base / name\n  if not p.is_file() or p.stat().st_size > ${MAX_BYTES}: raise SystemExit('Invalid website pointer')\n  pointers['workwise/' + base + '/' + name] = p.read_bytes().decode('utf-8')\nprint(json.dumps(pointers))\nPY\n`
    return JSON.parse(execFileSync('ssh', [...ssh.args, 'bash -s'], { input: script, encoding: 'utf8', maxBuffer: MAX_BYTES * 6, timeout: 60_000 }))
  }
  const verifyArchive = async (state, surface) => {
    if (surface === 'website') return verifyArchivePointers(state, surface, readWebsiteArchive(state.previousTag))
    const tag = state.previousTag; const version = tagVersion(tag)
    const files = new Map()
    for (const base of BASES) {
      for (const name of ['latest.yml', 'latest-mac.yml']) {
        const key = `${base}/${name}`
        equal(await readR2Text(`workwise/channels/stable/releases/${tag}/${name}`), state.pointers.r2[key], `R2 archived ${name} differs from the saved public pointer`)
        const metadata = readManifest(key, state.pointers.r2[key])
        for (const file of metadata.files ?? []) mergeRecoveryFile(files, `${base}/${file.url}`, { fileName: file.url, sha512: file.sha512, size: file.size })
        if (metadata.path) mergeRecoveryFile(files, `${base}/${metadata.path}`, { fileName: metadata.path, sha512: metadata.sha512 })
      }
      const metadata = readManifest(`${base}/latest.json`, state.pointers.r2[`${base}/latest.json`])
      for (const file of metadata.downloads ?? []) mergeRecoveryFile(files, `${base}/${file.fileName}`, file)
    }
    if (!files.size) fail('saved R2 metadata does not identify any recoverable packages')
    for (const [key, file] of files) {
      if (typeof file.fileName !== 'string' || !file.fileName.startsWith(`WorkWise-${version}-`)
        || !/^[A-Za-z0-9._-]+$/.test(file.fileName) || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512 ?? '')) fail('saved R2 package identity or SHA-512 is invalid')
      const response = await client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }))
      if (!response.Body) fail(`saved R2 package is missing: ${key}`)
      const hash = createHash('sha512'); let size = 0
      for await (const chunk of response.Body) { hash.update(chunk); size += chunk.byteLength }
      equal(hash.digest('base64'), file.sha512, `saved R2 package hash mismatch: ${key}`)
      if (file.size !== undefined) equal(size, Number(file.size), `saved R2 package size mismatch: ${key}`)
      if (response.ContentLength !== undefined) equal(size, response.ContentLength, `saved R2 package response size mismatch: ${key}`)
    }
  }
  return { readSurface, verifyArchive,
    publishRelease: async () => execFileSync('gh', ['release', 'edit', env.GITHUB_REF_NAME, '--draft=false', '--prerelease=false', '--latest', '--repo', REPOSITORY], { stdio: 'inherit', timeout: 60_000 }),
    getPublicationState: async () => {
      try { return publicationState(githubReleasePages(), env.GITHUB_REF_NAME) } catch { return 'unknown' }
    },
    verifyPublishedRelease: async state => {
      const releases = githubReleasePages().flat().filter(release => release.tag_name === state.targetTag)
      if (releases.length !== 1) fail('published GitHub release cannot be uniquely verified')
      verifyPublishedInstallers(releases[0], state)
      const directory = mkdtempSync(join(tmpdir(), 'railwise-commit-installers-'))
      try {
        execFileSync('gh', ['release', 'download', state.targetTag, '--repo', REPOSITORY, '--dir', directory, '--pattern', 'WorkWise-*'], { stdio: 'inherit', timeout: 30 * 60_000 })
        equal(readdirSync(directory).sort(), Object.keys(state.installers).sort(), 'downloaded GitHub installers differ from the reviewed set')
        for (const [name, expected] of Object.entries(state.installers)) {
          equal(await sha256File(join(directory, name)), expected.sha256, `downloaded GitHub installer differs from accepted bytes: ${name}`)
          equal(statSync(join(directory, name)).size, expected.size, `downloaded GitHub installer size differs: ${name}`)
        }
      } finally { rmSync(directory, { force: true, recursive: true }) }
    },
    targetPointers: async (tag, generatedAt) => {
      const r2 = {}; const platformManifests = []
      for (const platform of ['mac', 'win']) {
        const manifest = JSON.parse(await readR2Text(`workwise/channels/stable/releases/${tag}/release-${platform}.json`))
        equal(manifest.tag, tag, 'target R2 manifest tag mismatch'); equal(manifest.version, tagVersion(tag), 'target R2 manifest version mismatch')
        equal(manifest.platform, platform, 'target R2 manifest platform mismatch')
        platformManifests.push(manifest)
      }
      const publicBaseUrl = (env.WORKWISE_PUBLIC_BASE_URL || 'https://www.railwise.cn/downloads').replace(/\/+$/, '')
      if (!publicBaseUrl.startsWith('https://')) fail('R2 public URL must use HTTPS')
      for (const base of BASES) {
        for (const name of ['latest.yml', 'latest-mac.yml']) r2[`${base}/${name}`] = await readR2Text(`workwise/channels/stable/releases/${tag}/${name}`)
        r2[`${base}/latest.json`] = JSON.stringify(buildLatestManifest({ platformManifests, channel: 'stable', tag,
          publicBaseUrl, basePath: base.replace(/\/latest$/, ''), generatedAt }), null, 2)
      }
      return { r2, website: readWebsiteArchive(tag) }
    },
    restoreSurface: async (surface, state) => {
    if (surface === 'r2') {
      for (const key of KEYS) await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key,
        Body: state.pointers.r2[key], ContentType: key.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/yaml; charset=utf-8',
        CacheControl: 'public, max-age=60, must-revalidate' }))
    } else runNode(['scripts/deploy-website-release.mjs', 'promote', '--tag', state.previousTag, '--channel', 'stable', '--release-prefix', 'workwise', '--deploy-id', `recovery-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`, '--skip-retention'])
  } }
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command] = argv
  const value = name => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const targetTag = value('tag'); const statePath = value('state')
  if (!['draft', 'capture', 'start', 'publish', 'restore'].includes(command) || (command !== 'draft' && !statePath)) fail('usage: draft|capture|start|publish|restore --tag=vX.Y.Z [--state=FILE] [--result=FILE]')
  const attempt = trustedAttempt(env, targetTag)
  if (command === 'draft') {
    const result = verifyDraftRelease(githubReleasePages(), targetTag)
    console.info(`[release-recovery] GitHub target is ${result.exists ? 'an existing draft' : 'not yet created'}`)
    return result
  }
  const transport = liveTransport(env)
  const readAll = async () => ({ r2: await transport.readSurface('r2'), website: await transport.readSurface('website') })
  if (command === 'capture') {
    const generatedAt = new Date().toISOString()
    const state = capturePromotionState({ targetTag, attempt, generatedAt, pointers: await readAll(), targetPointers: await transport.targetPointers(targetTag, generatedAt) })
    state.installers = await reviewedInstallers(targetTag)
    for (const surface of SURFACES) await transport.verifyArchive(state, surface)
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.info(`[release-recovery] Saved current official pointers: ${state.previousTag}`)
    return state
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  equal(state.schemaVersion, 1, 'invalid saved state schema'); equal(state.attempt, attempt, 'saved state belongs to another publication attempt'); equal(state.targetTag, targetTag, 'saved state target differs')
  for (const surface of SURFACES) validatePointers(state.pointers[surface], state.previousTag)
  for (const surface of SURFACES) validatePointers(state.targetPointers[surface], state.targetTag)
  if (command === 'start') {
    const started = await preparePromotionStart(state, transport)
    equal(await transport.targetPointers(targetTag, state.generatedAt), state.targetPointers, 'immutable target metadata changed after preparation; refusing promotion')
    for (const surface of SURFACES) equal(await transport.readSurface(surface), state.pointers[surface], `public ${surface} changed after archive validation; refusing promotion`)
    writeFileSync(statePath, JSON.stringify(started, null, 2) + '\n', { mode: 0o600 })
    return started
  }
  const resultPath = value('result')
  if (!resultPath) fail('publish and restore require a durable --result path')
  try {
    const result = command === 'publish' ? await commitPublication(state, transport) : await recoverPromotion(state, transport)
    writeFileSync(resultPath, JSON.stringify({ ...result, targetTag, attempt }, null, 2) + '\n', { mode: 0o600 })
    console.info(`[release-recovery] ${result.status}; recovered surfaces: ${result.restored.join(', ') || 'none'}`)
    return result
  } catch (error) {
    writeFileSync(resultPath, JSON.stringify({ ...(error.recoveryResult || { status: 'blocked', restored: [] }), targetTag, attempt, error: error.message }, null, 2) + '\n', { mode: 0o600 })
    throw error
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
