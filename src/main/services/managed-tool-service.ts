import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import JSZip from 'jszip'
import type {
  ManagedLarkLoginResult,
  ManagedLarkAppSetupResult,
  ManagedToolId,
  ManagedToolListResult,
  ManagedToolResult,
  ManagedToolStatus
} from '../../shared/workwise-api'
import { describeNetworkFailure, systemFetch } from './system-network'
import { atomicWriteFile as durableWriteFile, recoverAtomicFile } from './durable-file'
import { ManagedLarkAppSetup, larkAppConfiguration, officialLarkURL } from './managed-lark-app-setup'
import { resolveLarkCliEnvironment } from '../../../kun/src/services/lark-cli-environment.js'
import { parseLarkIdentityBinding } from '../../../kun/src/services/lark-cli-identity.js'
import { LARK_RELEASE } from './managed-lark-release'
import { LARK_DELIVERY_SCOPES } from '../../../kun/src/adapters/tool/lark-delivery-tools.js'
import { downloadManagedDependency, findManagedDependency } from './managed-dependency-download'

const execFileAsync = promisify(execFile)
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_SKILL_BUNDLE_DOWNLOAD_BYTES = 96 * 1024 * 1024
const EGO_URL = 'https://lite.ego.app/'
const RELEASE_CACHE_TTL_MS = 30 * 60 * 1_000
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_TIMEOUT_MS = 60_000

type ToolManifest = Record<string, {
  version: string
  executablePath: string
  installedAt: string
  skillWarning?: string
}>

type ReleaseInfo = { version: string; tag: string; assets: Map<string, string> }
const releaseVersionCache = new Map<string, { release: ReleaseInfo; expiresAt: number }>()

const LARK_SKILLS = [
  'lark-approval', 'lark-apps', 'lark-attendance', 'lark-base', 'lark-calendar',
  'lark-contact', 'lark-doc', 'lark-drive', 'lark-event', 'lark-im', 'lark-mail',
  'lark-markdown', 'lark-meeting', 'lark-note', 'lark-okr', 'lark-openapi-explorer',
  'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-slides', 'lark-task',
  'lark-whiteboard', 'lark-wiki',
  'lark-workflow-meeting-summary', 'lark-workflow-standup-report'
]
const OFFICE_SKILLS = [
  'officecli', 'officecli-academic-paper', 'officecli-data-dashboard', 'officecli-docx',
  'officecli-financial-model', 'officecli-pitch-deck', 'officecli-pptx',
  'officecli-word-form', 'officecli-xlsx'
]

type ManagedToolTarget = {
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
}

let managedToolTargetOverride: ManagedToolTarget | undefined

function managedToolTarget(): ManagedToolTarget {
  return managedToolTargetOverride ?? { platform: process.platform, arch: process.arch }
}

export function managedToolsRoot(): string {
  return resolve(process.env.WORKWISE_TOOLS_ROOT?.trim() || join(homedir(), '.workwise', 'tools'))
}

export function managedToolsBinDir(): string {
  return join(managedToolsRoot(), 'bin')
}

export function managedToolsSkillRoot(): string {
  return join(managedToolsRoot(), 'skills')
}

function manifestPath(): string {
  return join(managedToolsRoot(), 'manifest.json')
}

function toolExecutableName(id: ManagedToolId): string {
  const base = id === 'officecli' ? 'officecli' : id === 'lark-cli' ? 'lark-cli' : 'ego-browser'
  return managedToolTarget().platform === 'win32' && id !== 'ego-browser' ? `${base}.exe` : base
}

function platformAsset(
  id: Exclude<ManagedToolId, 'ego-browser'>,
  version: string,
  targetPlatform: NodeJS.Platform = managedToolTarget().platform,
  targetArch: NodeJS.Architecture = managedToolTarget().arch
): string {
  const arch = targetArch === 'arm64' ? 'arm64' : 'x64'
  if (id === 'officecli') {
    if (targetPlatform === 'darwin') return `officecli-mac-${arch}`
    if (targetPlatform === 'win32') return `officecli-win-${arch}.exe`
  }
  if (id === 'lark-cli') {
    const larkArch = arch === 'x64' ? 'amd64' : arch
    if (targetPlatform === 'darwin') return `lark-cli-${version}-darwin-${larkArch}.tar.gz`
    if (targetPlatform === 'win32') return `lark-cli-${version}-windows-${larkArch}.zip`
  }
  throw new Error(`${id} is not supported on ${targetPlatform}/${targetArch}.`)
}

function repoFor(id: Exclude<ManagedToolId, 'ego-browser'>): string {
  return id === 'lark-cli' ? 'larksuite/cli' : 'iOfficeAI/OfficeCLI'
}

async function readManifest(): Promise<ToolManifest> {
  if (!existsSync(manifestPath())) return {}
  return JSON.parse(await readFile(manifestPath(), 'utf8')) as ToolManifest
}

async function writeManifest(manifest: ToolManifest): Promise<void> {
  await mkdir(managedToolsRoot(), { recursive: true })
  await durableWriteFile(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`)
}

async function fetchLatestRelease(repo: string): Promise<ReleaseInfo> {
  try {
    const apiResponse = await systemFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'RailWise AI',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(30_000)
    })
    if (apiResponse.ok) {
      const payload = await apiResponse.json() as {
        tag_name?: unknown
        assets?: Array<{ name?: unknown; browser_download_url?: unknown }>
      }
      const tag = typeof payload.tag_name === 'string' ? payload.tag_name.trim() : ''
      const version = tag.replace(/^v/, '')
      if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Release version is invalid.')
      const assets = new Map<string, string>()
      for (const asset of payload.assets ?? []) {
        if (typeof asset.name === 'string' && typeof asset.browser_download_url === 'string') {
          assets.set(asset.name, asset.browser_download_url)
        }
      }
      return { version, tag, assets }
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Release version is invalid.') throw error
    // The public release redirect is a rate-limit-safe fallback.
  }
  let response: Response
  try {
    response = await systemFetch(`https://github.com/${repo}/releases/latest`, {
      headers: { Accept: 'text/html', 'User-Agent': 'RailWise AI' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000)
    })
  } catch (error) {
    throw new Error(describeNetworkFailure(error, `GitHub (${repo})`), { cause: error })
  }
  if (!response.ok) throw new Error(`Unable to read ${repo} release (${response.status}).`)
  const version = response.url
    ? releaseVersionFromUrl(response.url)
    : releaseVersionFromHtml(await response.text())
  return { version, tag: `v${version}`, assets: new Map() }
}

async function latestReleaseFor(id: Exclude<ManagedToolId, 'ego-browser'>): Promise<ReleaseInfo> {
  if (id === 'lark-cli') return { version: LARK_RELEASE.version, tag: `v${LARK_RELEASE.version}`, assets: new Map() }
  const cached = releaseVersionCache.get(id)
  if (cached && cached.expiresAt > Date.now()) return cached.release
  const release = await fetchLatestRelease(repoFor(id))
  releaseVersionCache.set(id, { release, expiresAt: Date.now() + RELEASE_CACHE_TTL_MS })
  return release
}

async function latestVersionFor(id: Exclude<ManagedToolId, 'ego-browser'>): Promise<string> {
  return (await latestReleaseFor(id)).version
}

function releaseVersionFromUrl(url: string): string {
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(url)?.[1] ?? ''
  const version = decodeURIComponent(tag).trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Release version is invalid.')
  return version
}

function releaseVersionFromHtml(html: string): string {
  const tag = /\/releases\/tag\/(v?\d+\.\d+\.\d+[^"'/?#\s<]*)/.exec(html)?.[1] ?? ''
  const version = decodeURIComponent(tag).trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('Release version is invalid.')
  return version
}

function releaseAssetUrl(repo: string, version: string, name: string): string {
  return `https://github.com/${repo}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`
}

function isTransientDownloadFailure(error: unknown): boolean {
  const value = error as { message?: unknown; cause?: { code?: unknown; message?: unknown } }
  const detail = [value?.message, value?.cause?.code, value?.cause?.message]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|network|socket|terminated|timeout/i.test(detail)
}

async function download(
  url: string,
  maxBytes = MAX_DOWNLOAD_BYTES,
  retryDelayMs = 750
): Promise<Buffer> {
  let lastError: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await systemFetch(url, {
        headers: { 'User-Agent': 'RailWise AI' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
      })
      if (!response.ok) {
        if ((response.status === 408 || response.status === 429 || response.status >= 500) && attempt < DOWNLOAD_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
          continue
        }
        throw new Error(`Download failed (${response.status}).`)
      }
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > maxBytes) throw new Error('Download exceeds the managed tool size limit.')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > maxBytes) throw new Error('Download exceeds the managed tool size limit.')
      return bytes
    } catch (error) {
      if (error instanceof Error && /^(Download failed|Download exceeds)/.test(error.message)) throw error
      lastError = error
      if (!isTransientDownloadFailure(error) || attempt >= DOWNLOAD_ATTEMPTS) break
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
    }
  }
  throw new Error(describeNetworkFailure(lastError, 'GitHub download'), { cause: lastError })
}

function checksumFor(text: string, assetName: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match && basename(match[2] ?? '') === assetName) return (match[1] ?? '').toLowerCase()
  }
  throw new Error(`Checksum is missing for ${assetName}.`)
}

function archiveEntryIsSafe(entry: string): boolean {
  const normalized = entry.trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)) return false
  return !normalized.split('/').some((segment) => segment === '..')
}

function assertSafeArchiveListing(listing: string): void {
  const entries = listing.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) throw new Error('Downloaded archive is empty.')
  const unsafe = entries.find((entry) => !archiveEntryIsSafe(entry))
  if (unsafe) throw new Error(`Downloaded archive contains an unsafe path: ${unsafe}`)
}

async function findFile(root: string, name: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const nested = await findFile(path, name)
      if (nested) return nested
    }
  }
  return null
}

async function extractZipAsset(bytes: Buffer, target: string): Promise<void> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > 512) {
    throw new Error('Downloaded archive has an invalid file count.')
  }

  const destinations = new Set<string>()
  let extractedBytes = 0
  for (const entry of entries) {
    const normalized = entry.name.trim().replaceAll('\\', '/').replace(/^\.\//, '')
    if (!archiveEntryIsSafe(normalized)) {
      throw new Error(`Downloaded archive contains an unsafe path: ${entry.name}`)
    }
    if (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000) {
      throw new Error(`Downloaded archive contains a symbolic link: ${entry.name}`)
    }
    if (entry.dir) continue

    const collisionKey = normalized.toLocaleLowerCase('en-US')
    if (destinations.has(collisionKey)) {
      throw new Error(`Downloaded archive contains a path collision: ${entry.name}`)
    }
    destinations.add(collisionKey)

    const fileBytes = await entry.async('nodebuffer')
    extractedBytes += fileBytes.length
    if (extractedBytes > MAX_DOWNLOAD_BYTES) {
      throw new Error('Downloaded archive exceeds the managed tool size limit.')
    }
    const destination = join(target, ...normalized.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, fileBytes)
  }
}

async function extractAsset(id: Exclude<ManagedToolId, 'ego-browser'>, assetName: string, bytes: Buffer, target: string): Promise<string> {
  await mkdir(target, { recursive: true })
  const executableName = toolExecutableName(id)
  if (id === 'officecli') {
    const path = join(target, executableName)
    await writeFile(path, bytes)
    if (managedToolTarget().platform !== 'win32') await chmod(path, 0o755)
    return path
  }
  if (assetName.endsWith('.tar.gz')) {
    const archivePath = join(target, assetName)
    await writeFile(archivePath, bytes)
    const listing = await execFileAsync('tar', ['-tzf', archivePath], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
    assertSafeArchiveListing(listing.stdout)
    await execFileAsync('tar', ['-xzf', archivePath, '-C', target], { timeout: 30_000 })
    await rm(archivePath, { force: true })
  } else if (assetName.endsWith('.zip') && managedToolTarget().platform === 'win32') {
    await extractZipAsset(bytes, target)
  } else {
    throw new Error(`Unsupported archive: ${assetName}`)
  }
  const executable = await findFile(target, executableName)
  if (!executable) throw new Error(`Installed archive does not contain ${executableName}.`)
  if (managedToolTarget().platform !== 'win32') await chmod(executable, 0o755)
  return executable
}

async function activateExecutable(id: Exclude<ManagedToolId, 'ego-browser'>, executable: string): Promise<string> {
  await mkdir(managedToolsBinDir(), { recursive: true })
  const active = join(managedToolsBinDir(), toolExecutableName(id))
  const next = `${active}.next-${randomUUID()}`
  if (managedToolTarget().platform === 'win32') {
    await copyFile(executable, next)
    await rm(active, { force: true })
  } else {
    await symlink(executable, next)
  }
  await rename(next, active)
  return active
}

async function replaceSkillDirectory(name: string, staged: string): Promise<void> {
  const target = join(managedToolsSkillRoot(), name)
  const backup = join(managedToolsSkillRoot(), `.${name}.previous-${randomUUID()}`)
  const hadPrevious = existsSync(target)
  if (hadPrevious) await rename(target, backup)
  try {
    await rename(staged, target)
    await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    if (hadPrevious) await rename(backup, target).catch(() => undefined)
    throw error
  }
}

async function installGithubSkillBundle(
  owner: string,
  repo: string,
  ref: string,
  skillNames: string[],
  pinnedSource?: { url: string; sha256: string }
): Promise<void> {
  const archiveUrl = pinnedSource?.url ?? `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${encodeURIComponent(ref)}`
  const dependency = pinnedSource ? findManagedDependency(archiveUrl) : undefined
  const archive = dependency ? await downloadManagedDependency(dependency) : await download(archiveUrl, MAX_SKILL_BUNDLE_DOWNLOAD_BYTES)
  if (pinnedSource && createHash('sha256').update(archive).digest('hex') !== pinnedSource.sha256) {
    throw new Error('Official Skill source checksum verification failed. Existing Skills were preserved.')
  }
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true })
  const entries = Object.values(zip.files)
  if (entries.length === 0 || entries.length > 10_000) {
    throw new Error('GitHub Skill bundle has an invalid file count.')
  }
  for (const entry of entries) {
    if (!archiveEntryIsSafe(entry.name)) {
      throw new Error(`GitHub Skill bundle contains an unsafe path: ${entry.name}`)
    }
  }

  await mkdir(managedToolsSkillRoot(), { recursive: true })
  let extractedBytes = 0
  const staged: Array<{ name: string; path: string }> = []
  const preserved: string[] = []
  try {
    for (const name of skillNames) {
      const marker = `/skills/${name}/`
      const files = entries.filter((entry) => !entry.dir && entry.name.includes(marker))
      if (files.length === 0) throw new Error(`GitHub Skill bundle is missing skills/${name}.`)
      const archiveRoot = files[0].name.slice(0, files[0].name.indexOf(marker))
      const stage = join(managedToolsSkillRoot(), `.${name}.next-${randomUUID()}`)
      staged.push({ name, path: stage })
      await mkdir(stage, { recursive: true })
      for (const entry of files) {
        const relativePath = entry.name.slice(entry.name.indexOf(marker) + marker.length)
        if (repo === 'OfficeCLI' && name === 'officecli' && relativePath === 'SKILL.md') {
          // The repository exposes skills/officecli/SKILL.md as a symlink to
          // the root Skill. Install the target content explicitly below.
          continue
        }
        if (typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000) {
          throw new Error(`GitHub Skill contains a symbolic link: ${entry.name}`)
        }
        if (!archiveEntryIsSafe(relativePath)) {
          throw new Error(`GitHub Skill bundle contains an unsafe Skill path: ${relativePath}`)
        }
        const bytes = await entry.async('nodebuffer')
        extractedBytes += bytes.length
        if (extractedBytes > MAX_DOWNLOAD_BYTES) {
          throw new Error('GitHub Skill bundle exceeds the managed tool size limit.')
        }
        const destination = join(stage, ...relativePath.split('/'))
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, bytes)
      }
      if (repo === 'OfficeCLI' && name === 'officecli') {
        const rootSkill = zip.file(`${archiveRoot}/SKILL.md`)
        if (!rootSkill) throw new Error('OfficeCLI bundle is missing its root SKILL.md.')
        const bytes = await rootSkill.async('nodebuffer')
        extractedBytes += bytes.length
        await writeFile(join(stage, 'SKILL.md'), bytes)
      }
      if (!existsSync(join(stage, 'SKILL.md'))) {
        throw new Error(`GitHub Skill bundle is missing skills/${name}/SKILL.md.`)
      }
    }
    for (const item of staged) {
      // Older installations have no per-file baseline proving that a Skill was
      // left unmodified. Keep those directories until the user reviews an update.
      if (pinnedSource && existsSync(join(managedToolsSkillRoot(), item.name))) {
        preserved.push(item.name)
        continue
      }
      await replaceSkillDirectory(item.name, item.path)
    }
    if (preserved.length) throw new Error(`Existing companion Skills were preserved for review: ${preserved.join(', ')}.`)
  } finally {
    await Promise.all(staged.map((item) => rm(item.path, { recursive: true, force: true })))
  }
}

async function installCompanionSkills(id: ManagedToolId, version?: string): Promise<void> {
  await mkdir(managedToolsSkillRoot(), { recursive: true })
  if (id === 'lark-cli') {
    if (!version) throw new Error('Lark CLI release version is missing.')
    if (version !== LARK_RELEASE.version) throw new Error('This Lark CLI version has no verified companion Skill bundle. Existing Skills were preserved.')
    await installGithubSkillBundle('larksuite', 'cli', LARK_RELEASE.sourceCommit, LARK_SKILLS, {
      url: LARK_RELEASE.sourceUrl, sha256: LARK_RELEASE.sourceSha256
    })
  } else if (id === 'officecli') {
    if (!version) throw new Error('OfficeCLI release version is missing.')
    await installGithubSkillBundle('iOfficeAI', 'OfficeCLI', `v${version}`, OFFICE_SKILLS)
  } else {
    await installGithubSkillBundle('citrolabs', 'ego-lite', 'main', ['ego-browser'])
  }
}

function companionSkillWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `The tool was installed, but its companion Skills could not be updated: ${message}`
}

type ToolRunner = (path: string, args: string[]) => Promise<{ ok: boolean; output: string }>

const defaultToolRunner: ToolRunner = async (path, args) => {
  try {
    const result = await execFileAsync(path, args, { env: managedLarkEnvironment(), timeout: args.includes('--device-code') ? 120_000 : 15_000, maxBuffer: 512 * 1024 })
    return { ok: true, output: String(result.stdout || '').trim() }
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: `${value.stdout || ''}${value.stderr || value.message || ''}`.trim() }
  }
}

let toolRunner: ToolRunner = defaultToolRunner

async function runTool(path: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  if (basename(path).replace(/\.exe$/i, '') === 'lark-cli' && larkCandidateCredentialsDisabled() && args[0] !== '--version') {
    return { ok: false, output: 'Candidate credential access is disabled; no CLI account or Keychain was read.' }
  }
  return toolRunner(path, args)
}

function larkCandidateCredentialsDisabled(): boolean {
  return process.env.WORKWISE_CANDIDATE === '1' && process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS !== '1'
}
function managedLarkEnvironment(): NodeJS.ProcessEnv {
  return resolveLarkCliEnvironment(process.env)
}
const larkAppSetup = new ManagedLarkAppSetup(runTool, managedLarkEnvironment)
let larkAppSetupRequestGeneration = 0
process.once('exit', () => larkAppSetup.cancel())

export async function beginManagedLarkAppSetup(): Promise<ManagedLarkAppSetupResult> {
  const generation = ++larkAppSetupRequestGeneration
  larkAppSetup.clearBinding()
  pendingLarkLogin = undefined
  if (larkCandidateCredentialsDisabled()) return { ok: false, message: 'Candidate credential access is disabled. Application setup has not started.' }
  const diagnosis = await diagnoseManagedTool('lark-cli')
  if (generation !== larkAppSetupRequestGeneration) return { ok: true, state: 'cancelled' }
  if (!diagnosis.ok || !diagnosis.status.executablePath || diagnosis.status.state === 'not_installed' || diagnosis.status.state === 'error') return { ok: false, message: 'Install and diagnose Lark CLI before configuring an app.' }
  return larkAppSetup.begin(diagnosis.status.executablePath)
}
export async function checkManagedLarkAppSetup(): Promise<ManagedLarkAppSetupResult> {
  if (larkCandidateCredentialsDisabled()) return { ok: false, message: 'Candidate credential access is disabled. No account configuration was read.' }
  return larkAppSetup.check()
}
export async function cancelManagedLarkAppSetup(): Promise<ManagedLarkAppSetupResult> {
  larkAppSetupRequestGeneration++
  pendingLarkLogin = undefined
  return larkAppSetup.cancel()
}


// This fixed scope set is requested only after a user clicks Connect. No credentials or
// device code cross IPC; the renderer receives only the official verification URL.
const LARK_TASK_SCOPES = ['task:task:read', 'task:task:write', 'approval:task:read', 'approval:instance:read', 'approval:task:write']
let pendingLarkLogin: { generation: number; executablePath: string; executableHash: string; installedVersion?: string; requestedScopes: string[]; capability: string; deviceCode: string; expiresAt: number; appId: string; profile: string; brand: string; verificationUrl: string; userCode?: string } | undefined
let larkLoginCompleting = false
let larkLoginStarting: Promise<ManagedLarkLoginResult> | undefined
let larkLoginStartingCapability: string | undefined

function jsonRecord(output: string): Record<string, unknown> {
  try { const value = JSON.parse(output); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}
const parseLarkIdentity = parseLarkIdentityBinding
// RailWise's explicit account selection is metadata only. Keep all CLI apps,
// tokens and the CLI's own default untouched; restart diagnosis uses this selector.
type SelectedLarkAccount = { profile: string; appId: string; brand: 'feishu' | 'lark'; userOpenId: string; identityFingerprint: string }
const selectedLarkAccountPath = (): string => join(managedToolsRoot(), 'lark-account-selection.json')
async function readSelectedLarkAccount(): Promise<SelectedLarkAccount | undefined> {
  let value: Record<string, unknown>
  try { await recoverAtomicFile(selectedLarkAccountPath()); value = jsonRecord(await readFile(selectedLarkAccountPath(), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!['profile', 'appId', 'userOpenId'].every(key => typeof value[key] === 'string' && String(value[key]).trim()) || !['feishu', 'lark'].includes(String(value.brand)) || value.identityFingerprint !== createHash('sha256').update(JSON.stringify(['lark-user-v1', value.brand, value.appId, value.userOpenId])).digest('hex')) throw new Error('The selected Lark account record could not be verified. Existing CLI accounts are preserved.')
  return value as SelectedLarkAccount
}
function assertLarkConnectionCurrent(generation: number): void {
  if (generation !== larkAppSetupRequestGeneration) throw new Error('The connection request was cancelled or replaced. Check the official account state before reconnecting.')
}
export async function beginManagedLarkLogin(input?: { capability?: 'tasks' | 'mail' | 'im' | 'drive' }): Promise<ManagedLarkLoginResult> {
  const capability = input?.capability ?? 'tasks'
  if (!['tasks', 'mail', 'im', 'drive'].includes(capability)) return { ok: false, message: 'Unknown connector capability.' }
  if (larkLoginStarting) return larkLoginStartingCapability === capability ? larkLoginStarting : { ok: false, message: 'Another authorization capability is already starting.' }
  const operation = beginManagedLarkLoginOnce(capability).catch((): ManagedLarkLoginResult => ({ ok: false, message: 'The official authorization flow could not be verified or started. Existing configuration was not replaced.' }))
  larkLoginStarting = operation
  larkLoginStartingCapability = capability
  try { return await operation } finally {
    if (larkLoginStarting === operation) { larkLoginStarting = undefined; larkLoginStartingCapability = undefined }
  }
}
async function beginManagedLarkLoginOnce(capability: 'tasks' | 'mail' | 'im' | 'drive'): Promise<ManagedLarkLoginResult> {
  const generation = larkAppSetupRequestGeneration
  if (larkCandidateCredentialsDisabled()) return { ok: false, reason: 'candidate_credentials_disabled', message: 'Candidate credential access is disabled. No account configuration or Keychain was read.' }
  if (larkLoginCompleting) return { ok: false, message: 'Authorization is already being completed.' }
  if (larkAppSetup.isWaiting()) return { ok: false, reason: 'app_configuration_required', message: 'Complete or cancel the current application setup before starting account login.' }
  if (pendingLarkLogin && pendingLarkLogin.expiresAt > Date.now()) {
    if (pendingLarkLogin.capability !== capability) return { ok: false, message: 'Complete or cancel the current authorization before selecting another capability.' }
    return { ok: true, verificationUrl: pendingLarkLogin.verificationUrl, expiresAt: new Date(pendingLarkLogin.expiresAt).toISOString(), ...(pendingLarkLogin.userCode ? { userCode: pendingLarkLogin.userCode } : {}) }
  }
  pendingLarkLogin = undefined
  const selection = larkAppSetup.binding() ?? await readSelectedLarkAccount()
  assertLarkConnectionCurrent(generation)
  const diagnosis = await diagnoseManagedTool('lark-cli')
  assertLarkConnectionCurrent(generation)
  if (!diagnosis.ok || !diagnosis.status.executablePath || diagnosis.status.state === 'error') return { ok: false, message: 'Install and diagnose Lark CLI before connecting an account.' }
  const app = await runTool(diagnosis.status.executablePath, ['config', 'show', ...(selection ? ['--profile', selection.profile] : []), '--json'])
  assertLarkConnectionCurrent(generation)
  const configuration = larkAppConfiguration(app.output, app.ok)
  if (configuration === 'missing') return { ok: false, reason: 'app_configuration_required', message: 'Configure a Feishu application on the official scan page first, then log in. Existing apps and accounts are preserved.' }
  if (configuration !== 'configured') return { ok: false, message: 'Lark application configuration could not be verified. Existing configuration was not replaced.' }
  const appConfig = jsonRecord(app.output)
  const appId = String(appConfig.appId)
  const profile = typeof appConfig.profile === 'string' && appConfig.profile.trim() ? appConfig.profile : appId
  const executableHash = createHash('sha256').update(await readFile(diagnosis.status.executablePath)).digest('hex')
  assertLarkConnectionCurrent(generation)
  if (selection && (profile !== selection.profile || appId !== selection.appId || appConfig.brand !== selection.brand || ('executableHash' in selection && (selection.executablePath !== diagnosis.status.executablePath || selection.executableHash !== executableHash)))) return { ok: false, message: 'The verified Lark application changed before login. Check its configuration before reconnecting.' }
  const required = capability === 'tasks' ? LARK_TASK_SCOPES : LARK_DELIVERY_SCOPES[capability]
  const existingScopes = diagnosis.status.profile === profile && diagnosis.status.appId === appId ? diagnosis.status.scopes ?? [] : []
  const requestedScopes = [...new Set([...existingScopes, ...required])]
  const result = await runTool(diagnosis.status.executablePath, ['auth', 'login', '--profile', profile, '--scope', requestedScopes.join(' '), '--no-wait', '--json'])
  assertLarkConnectionCurrent(generation)
  const value = jsonRecord(result.output)
  if (!result.ok || typeof value.device_code !== 'string' || typeof value.verification_url !== 'string' || typeof value.expires_in !== 'number' || value.expires_in <= 0) return { ok: false, message: 'The official Lark authorization flow could not be started. Check application configuration and network connectivity.' }
  const url = officialLarkURL(value.verification_url)
  if (!url) return { ok: false, message: 'Untrusted Lark authorization URL.' }
  const expiresAt = Date.now() + Math.min(value.expires_in, 1800) * 1000
  pendingLarkLogin = { generation, executablePath: diagnosis.status.executablePath, executableHash, installedVersion: diagnosis.status.installedVersion, requestedScopes, capability, deviceCode: value.device_code, expiresAt, appId, profile, brand: String(appConfig.brand), verificationUrl: url, ...(typeof value.user_code === 'string' ? { userCode: value.user_code } : {}) }
  return { ok: true, verificationUrl: url, expiresAt: new Date(expiresAt).toISOString(), ...(typeof value.user_code === 'string' ? { userCode: value.user_code } : {}) }
}
export async function completeManagedLarkLogin(): Promise<ManagedToolResult> {
  if (larkCandidateCredentialsDisabled()) return { ok: false, message: 'Candidate credential access is disabled. No account configuration or Keychain was read.' }
  const pending = pendingLarkLogin
  if (!pending || pending.expiresAt <= Date.now()) { pendingLarkLogin = undefined; return { ok: false, message: 'Authorization expired. Connect again.' } }
  if (larkLoginCompleting) return { ok: false, message: 'Authorization is already being completed.' }
  larkLoginCompleting = true
  try {
    assertLarkConnectionCurrent(pending.generation)
    if (createHash('sha256').update(await readFile(pending.executablePath)).digest('hex') !== pending.executableHash) {
      pendingLarkLogin = undefined
      return { ok: false, message: 'Lark CLI changed during authorization. Check the official account state before reconnecting.' }
    }
    const app = await runTool(pending.executablePath, ['config', 'show', '--profile', pending.profile, '--json'])
    assertLarkConnectionCurrent(pending.generation)
    const appConfig = jsonRecord(app.output)
    if (larkAppConfiguration(app.output, app.ok) !== 'configured' || appConfig.appId !== pending.appId || appConfig.brand !== pending.brand || (typeof appConfig.profile === 'string' && appConfig.profile !== pending.profile)) {
      pendingLarkLogin = undefined
      return { ok: false, message: 'The app changed during authorization. This authorization was not resumed.' }
    }
    const result = await runTool(pending.executablePath, ['auth', 'login', '--profile', pending.profile, '--device-code', pending.deviceCode, '--json'])
    // The device code may have been consumed even if the result was lost.
    // Never retry it automatically, or claim an old login is this flow's success.
    pendingLarkLogin = undefined
    assertLarkConnectionCurrent(pending.generation)
    if (!result.ok) return { ok: false, message: 'Authorization did not complete. Check the official account state before reconnecting; an existing login is not proof this authorization succeeded.' }
    const completed = jsonRecord(result.output)
    const completedScopes = typeof completed.scope === 'string' ? completed.scope.split(/\s+/).filter(Boolean) : []
    if (completed.event !== 'authorization_complete' || typeof completed.user_open_id !== 'string' || !completed.user_open_id.trim() || !Array.isArray(completed.missing) || completed.missing.length || completed.warning || pending.requestedScopes.some(scope => !completedScopes.includes(scope))) return { ok: false, message: 'The current authorization result did not verify an authorized user and all requested permissions. Existing account selection was preserved.' }
    const auth = await runTool(pending.executablePath, ['auth', 'status', '--profile', pending.profile, '--json'])
    assertLarkConnectionCurrent(pending.generation)
    const identity = parseLarkIdentity(auth.ok ? auth.output : '')
    if (!identity.available || identity.appId !== pending.appId || identity.brand !== pending.brand || identity.userOpenId !== completed.user_open_id) return { ok: false, message: 'The authorized user identity could not be verified for this application and this login result.' }
    const missingScopes = pending.requestedScopes.filter(scope => !identity.scopes.includes(scope))
    if (missingScopes.length) return { ok: false, message: `Authorization is missing required permissions: ${missingScopes.join(', ')}. Check permissions on the official page.` }
    await durableWriteFile(selectedLarkAccountPath(), `${JSON.stringify({ profile: pending.profile, appId: identity.appId, brand: identity.brand, userOpenId: identity.userOpenId, identityFingerprint: identity.identityFingerprint }, null, 2)}\n`, { beforeReplace: async () => assertLarkConnectionCurrent(pending.generation) })
    assertLarkConnectionCurrent(pending.generation)
    return { ok: true, status: { id: 'lark-cli', state: 'installed', installedVersion: pending.installedVersion, executablePath: pending.executablePath, executableHash: pending.executableHash, scopes: identity.scopes, brand: identity.brand, appId: identity.appId, profile: pending.profile, userOpenId: identity.userOpenId, identityFingerprint: identity.identityFingerprint, message: 'Lark user identity and requested permissions are verified.' } }
  } catch {
    pendingLarkLogin = undefined
    return { ok: false, message: 'Authorization could not be verified. Check the official account state before reconnecting.' }
  } finally { larkLoginCompleting = false }
}

export async function diagnoseManagedTool(id: ManagedToolId): Promise<ManagedToolResult> {
  try {
    if (id === 'ego-browser') {
      const candidates = [join(managedToolsBinDir(), 'ego-browser'), join(homedir(), '.local', 'bin', 'ego-browser')]
      const executablePath = candidates.find(existsSync)
      if (!executablePath) {
        return { ok: true, status: { id, state: 'needs_external_app', externalUrl: EGO_URL, message: 'Install ego lite and finish onboarding.' } }
      }
      const check = await runTool(executablePath, ['--help'])
      return { ok: true, status: { id, state: check.ok ? 'installed' : 'error', executablePath, message: check.ok ? 'ego-browser is ready.' : check.output } }
    }
    const manifest = await readManifest()
    const record = manifest[id]
    if (!record || !existsSync(record.executablePath)) return { ok: true, status: { id, state: 'not_installed' } }
    const missingSkills = id === 'lark-cli' ? LARK_SKILLS.filter(name => !existsSync(join(managedToolsSkillRoot(), name, 'SKILL.md'))) : []
    const skillWarning = record.skillWarning ?? (missingSkills.length ? `配套技能缺少 ${missingSkills.length} 项，请使用“修复配套工具”补齐。` : undefined)
    const versionCheck = await runTool(record.executablePath, ['--version'])
    if (!versionCheck.ok) return { ok: true, status: { id, state: 'error', installedVersion: record.version, executablePath: record.executablePath, message: versionCheck.output } }
    if (id === 'lark-cli') {
      const actualVersion = /\bv?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/.exec(versionCheck.output)?.[1]
      if (actualVersion !== record.version) return { ok: true, status: { id, state: 'error', installedVersion: record.version, executablePath: record.executablePath, skillWarning,
        message: 'The Lark CLI version no longer matches its verified installation record. Reinstall the managed connector before continuing.' } }
      if (larkCandidateCredentialsDisabled()) return { ok: true, status: { id, state: 'needs_login', installedVersion: record.version, executablePath: record.executablePath, scopes: [], skillWarning, message: 'Candidate credential access is disabled. No account configuration or Keychain was read.' } }
      const selection = await readSelectedLarkAccount()
      const auth = await runTool(record.executablePath, ['auth', 'status', ...(selection ? ['--profile', selection.profile] : []), '--json'])
      const diagnosis = parseLarkIdentity(auth.ok ? auth.output : '')
      const executableHash = createHash('sha256').update(await readFile(record.executablePath)).digest('hex')
      const matchesSelection = !selection || diagnosis.identityFingerprint === selection.identityFingerprint
      const ready = diagnosis.available && matchesSelection
      return { ok: true, status: { id, state: ready ? 'installed' : 'needs_login', installedVersion: record.version, executablePath: record.executablePath, executableHash, skillWarning, scopes: ready ? diagnosis.scopes : [], ...(diagnosis.brand ? { brand: diagnosis.brand } : {}), ...(ready && diagnosis.appId ? { appId: diagnosis.appId, profile: selection?.profile ?? diagnosis.appId } : {}), ...(ready && diagnosis.userOpenId ? { userOpenId: diagnosis.userOpenId } : {}), ...(ready && diagnosis.identityFingerprint ? { identityFingerprint: diagnosis.identityFingerprint } : {}), message: ready ? 'Lark user identity is ready.' : 'Connect the selected Lark user account before using task or approval data.' } }
    }
    return { ok: true, status: { id, state: 'installed', installedVersion: record.version, executablePath: record.executablePath, message: versionCheck.output } }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function installManagedTool(id: ManagedToolId): Promise<ManagedToolResult> {
  try {
    if (id === 'ego-browser') {
      let warning = ''
      await installCompanionSkills(id).catch((error) => {
        warning = companionSkillWarning(error)
      })
      const result = await diagnoseManagedTool(id)
      if (result.ok && warning) {
        result.status.message = [result.status.message, warning].filter(Boolean).join(' ')
      }
      return result
    }
    const repo = repoFor(id)
    const release = await latestReleaseFor(id)
    const version = release.version
    const assetName = platformAsset(id, version)
    const checksumName = id === 'lark-cli' ? 'checksums.txt' : 'SHA256SUMS'
    const assetUrl = release.assets.get(assetName) ?? releaseAssetUrl(repo, version, assetName)
    const checksumUrl = release.assets.get(checksumName) ?? releaseAssetUrl(repo, version, checksumName)
    const dependency = id === 'lark-cli' ? findManagedDependency(assetUrl) : undefined
    const [assetBytes, checksumBytes] = await Promise.all([
      dependency ? downloadManagedDependency(dependency) : download(assetUrl),
      id === 'lark-cli' ? Promise.resolve(undefined) : download(checksumUrl)
    ])
    const expected = id === 'lark-cli' ? LARK_RELEASE.assets[assetName] : checksumFor(checksumBytes!.toString('utf8'), assetName)
    if (!expected) throw new Error(`No verified checksum is registered for ${assetName}.`)
    const actual = createHash('sha256').update(assetBytes).digest('hex')
    if (actual !== expected) throw new Error(`Checksum verification failed for ${assetName}.`)

    const toolRoot = join(managedToolsRoot(), id)
    await mkdir(toolRoot, { recursive: true })
    const temp = await mkdtemp(join(toolRoot, '.install-'))
    const transactionId = randomUUID()
    const finalDir = join(toolRoot, version)
    const previousDir = join(toolRoot, `.previous-${transactionId}`)
    const activePath = join(managedToolsBinDir(), toolExecutableName(id))
    const activeBackup = join(toolRoot, `.active-${transactionId}`)
    let movedPrevious = false
    let movedNew = false
    try {
      const executable = await extractAsset(id, assetName, assetBytes, temp)
      let skillWarning = ''
      await installCompanionSkills(id, version).catch((error) => {
        skillWarning = companionSkillWarning(error)
      })
      if (existsSync(activePath)) await copyFile(activePath, activeBackup)
      if (existsSync(finalDir)) {
        await rename(finalDir, previousDir)
        movedPrevious = true
      }
      await rename(temp, finalDir)
      movedNew = true
      const finalExecutable = join(finalDir, executable.slice(temp.length + 1))
      const active = await activateExecutable(id, finalExecutable)
      const manifest = await readManifest()
      manifest[id] = {
        version,
        executablePath: active,
        installedAt: new Date().toISOString(),
        ...(skillWarning ? { skillWarning } : {})
      }
      await writeManifest(manifest)
      await rm(previousDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(activeBackup, { force: true }).catch(() => undefined)
    } catch (error) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      if (movedNew) await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
      if (movedPrevious) await rename(previousDir, finalDir).catch(() => undefined)
      if (existsSync(activeBackup)) {
        await rm(activePath, { force: true }).catch(() => undefined)
        await mkdir(managedToolsBinDir(), { recursive: true }).catch(() => undefined)
        await copyFile(activeBackup, activePath).catch(() => undefined)
        if (managedToolTarget().platform !== 'win32') await chmod(activePath, 0o755).catch(() => undefined)
        await rm(activeBackup, { force: true }).catch(() => undefined)
      }
      throw error
    }
    const diagnosed = await diagnoseManagedTool(id)
    if (diagnosed.ok) {
      const skillWarning = (await readManifest())[id]?.skillWarning
      if (skillWarning) {
        diagnosed.status.message = [diagnosed.status.message, skillWarning].filter(Boolean).join(' ')
      }
    }
    return diagnosed
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function updateManagedTool(id: ManagedToolId): Promise<ManagedToolResult> {
  return installManagedTool(id)
}

export async function removeManagedTool(id: ManagedToolId): Promise<ManagedToolResult> {
  try {
    if (id === 'ego-browser') {
      await rm(join(managedToolsSkillRoot(), 'ego-browser'), { recursive: true, force: true })
      return { ok: true, status: { id, state: 'needs_external_app', externalUrl: EGO_URL } }
    }
    const manifest = await readManifest()
    await rm(join(managedToolsRoot(), id), { recursive: true, force: true })
    await rm(join(managedToolsBinDir(), toolExecutableName(id)), { force: true })
    delete manifest[id]
    await writeManifest(manifest)
    const skills = id === 'lark-cli' ? LARK_SKILLS : OFFICE_SKILLS
    await Promise.all(skills.map((name) => rm(join(managedToolsSkillRoot(), name), { recursive: true, force: true })))
    return { ok: true, status: { id, state: 'not_installed' } }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function listManagedTools(): Promise<ManagedToolListResult> {
  try {
    const ids = ['lark-cli', 'officecli', 'ego-browser'] as ManagedToolId[]
    const results = await Promise.all(ids.map(diagnoseManagedTool))
    const tools = results.map((result, index) => result.ok
      ? result.status
      : ({ id: ids[index], state: 'error', message: result.message } as ManagedToolStatus))
    await Promise.all(tools.map(async (status) => {
      if (status.id === 'ego-browser' || !status.installedVersion) return
      try {
        const latestVersion = await latestVersionFor(status.id)
        status.latestVersion = latestVersion
        if (latestVersion !== status.installedVersion && status.state === 'installed') {
          status.state = 'update_available'
        }
      } catch {
        // Diagnostics remain useful offline; update checks must not hide installed tools.
      }
    }))
    return {
      ok: true,
      tools
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export const _internals = {
  platformAsset,
  checksumFor,
  archiveEntryIsSafe,
  assertSafeArchiveListing,
  releaseVersionFromUrl,
  releaseVersionFromHtml,
  releaseAssetUrl,
  download,
  larkSkills: LARK_SKILLS,
  parseLarkIdentity,
  managedLarkEnvironment,
  clearPendingLarkLogin: () => { pendingLarkLogin = undefined; larkLoginCompleting = false; larkAppSetupRequestGeneration++; larkAppSetup.cancel() },
  officeSkills: OFFICE_SKILLS,
  clearReleaseCache: () => releaseVersionCache.clear(),
  setToolRunnerForTests: (runner?: ToolRunner) => {
    if (process.env.NODE_ENV !== 'test') throw new Error('Managed tool test runner is only available in tests.')
    toolRunner = runner ?? defaultToolRunner
  },
  setTargetPlatformForTests: (target?: ManagedToolTarget) => {
    if (process.env.NODE_ENV !== 'test') throw new Error('Managed tool target override is only available in tests.')
    managedToolTargetOverride = target
  }
}
