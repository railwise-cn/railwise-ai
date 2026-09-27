import { app, autoUpdater as nativeAutoUpdater, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import electronUpdater from 'electron-updater'
import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import type {
  GuiUpdateChannel,
  GuiUpdateDownloadResult,
  GuiUpdateFailureCode,
  GuiUpdateInfo,
  GuiUpdateInstallResult,
  GuiUpdateState
} from '../shared/gui-update'
import { nextGuiUpdateCheckDelay } from '../shared/gui-update-schedule'
import { DEFAULT_GUI_UPDATE_CHANNEL, normalizeGuiUpdateChannel } from '../shared/gui-update'
import { configurePrivateUpdaterTls } from './private-updater-tls'
import {
  legacyDownloadUrl,
  legacyGithubRepo,
  legacyGithubUpdateFallbackEnabled,
  legacyUnsignedUpdatesEnabled,
  legacyUpdateChannel,
  legacyUpdateProvider,
  legacyUpdateUrl
} from './compat/legacy-environment'

const DEFAULT_OFFICIAL_RELEASE_PREFIX = 'workwise'
const DEFAULT_OFFICIAL_UPDATE_BASE_URL = 'https://www.railwise.cn/downloads'
const DEFAULT_PRODUCT_PAGE_URL = 'https://www.railwise.cn/products/workwise/'
const DEFAULT_GITHUB_REPO = 'railwise-cn/railwise-ai'
const UPDATE_REQUEST_HEADERS = {
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache'
} as const
const WITHDRAWN_STABLE_VERSIONS = new Set(
  (process.env.WORKWISE_WITHDRAWN_STABLE_VERSIONS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)
const { autoUpdater } = electronUpdater

let initialized = false
let getMainWindow: (() => BrowserWindow | null) | null = null
let lastInfo: Extract<GuiUpdateInfo, { ok: true }> | null = null
let lastState: GuiUpdateState = { status: 'idle' }
let downloaded = false
let downloadPromise: Promise<string[]> | null = null
let configuredChannel: GuiUpdateChannel = normalizeGuiUpdateChannel(
  process.env.WORKWISE_UPDATE_CHANNEL?.trim() || legacyUpdateChannel() || undefined
)
let configuredFeedUrl = ''
let getSelectedChannel: (() => GuiUpdateChannel | Promise<GuiUpdateChannel>) | null = null
let beforeInstallUpdate: (() => void | Promise<void>) | null = null
let beforeInstallUpdatePromise: Promise<void> | null = null
let backgroundCheckTimer: NodeJS.Timeout | null = null
let backgroundCheckPromise: Promise<void> | null = null
let guiUpdateCheckPromise: Promise<GuiUpdateInfo> | null = null
let guiUpdateCheckChannel: GuiUpdateChannel | null = null
let onBackgroundUpdateAvailable: ((info: Extract<GuiUpdateInfo, { ok: true }>) => void) | null = null

const GUI_UPDATE_SCHEDULE_FILE = 'gui-update-schedule.json'

type UpdateFeedConfig =
  | { kind: 'generic'; url: string }
  | { kind: 'github'; owner: string; repo: string; fullName: string }
  | { kind: 'none' }

type GithubReleaseAsset = {
  name?: unknown
  browser_download_url?: unknown
}

type GithubRelease = {
  tag_name?: unknown
  name?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
  published_at?: unknown
  assets?: GithubReleaseAsset[]
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, '')
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

function joinUrl(base: string, ...parts: string[]): string {
  const cleanBase = normalizeBaseUrl(base)
  const cleanParts = parts.map((p) => trimSlashes(p)).filter(Boolean)
  return [cleanBase, ...cleanParts].join('/')
}

function envUpdateUrl(channel: GuiUpdateChannel): string {
  const upper = channel.toUpperCase()
  const channelSpecific =
    process.env[`WORKWISE_UPDATE_URL_${upper}`]?.trim() ||
    legacyUpdateUrl(channel)
  const direct =
    channelSpecific ||
    process.env.WORKWISE_UPDATE_URL?.trim() ||
    ''
  return direct ? direct.replace(/\{channel\}/g, channel).replace(/\/?$/, '/') : ''
}

function updateProviderSetting(): string {
  return (
    process.env.WORKWISE_UPDATE_PROVIDER ||
    legacyUpdateProvider() ||
    ''
  ).trim().toLowerCase()
}

function shouldUseGithubUpdateProvider(channel: GuiUpdateChannel = configuredChannel): boolean {
  const configured = updateProviderSetting()
  if (configured === 'github') return true
  if (configured === 'generic' || configured === 'none') return false
  return !genericUpdateFeedUrl(channel)
}

function shouldFallbackToGithubUpdateProvider(channel: GuiUpdateChannel): boolean {
  return (
    shouldUseGithubUpdateProvider(channel) ||
    process.env.WORKWISE_ENABLE_GITHUB_UPDATE_FALLBACK === '1' ||
    legacyGithubUpdateFallbackEnabled()
  )
}

function genericUpdateFeedUrl(channel: GuiUpdateChannel): string {
  const direct = envUpdateUrl(channel)
  if (direct) return direct

  const configuredBase =
    process.env.WORKWISE_UPDATE_BASE_URL?.trim() ||
    process.env.WORKWISE_PUBLIC_BASE_URL?.trim() ||
    process.env.R2_PUBLIC_BASE_URL?.trim() ||
    process.env.PUBLIC_DOWNLOAD_BASE_URL?.trim()
  const configuredPrefix =
    process.env.WORKWISE_RELEASE_PREFIX?.trim() ||
    process.env.R2_RELEASE_PREFIX?.trim()

  const base = configuredBase || DEFAULT_OFFICIAL_UPDATE_BASE_URL
  const prefix = configuredPrefix || DEFAULT_OFFICIAL_RELEASE_PREFIX
  return `${joinUrl(base, prefix, 'channels', channel, 'latest')}/`
}

function guiUpdateSchedulePath(): string {
  return join(app.getPath('userData'), GUI_UPDATE_SCHEDULE_FILE)
}

async function readLastScheduledCheckAt(): Promise<number | null> {
  try {
    const raw = await readFile(guiUpdateSchedulePath(), 'utf8')
    return parseScheduledCheckAt(raw, app.getVersion())
  } catch {
    return null
  }
}

function parseScheduledCheckAt(raw: string, currentVersion: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { lastCheckedAt?: unknown; appVersion?: unknown }
    if (parsed.appVersion !== currentVersion) return null
    const ms = typeof parsed.lastCheckedAt === 'string' ? Date.parse(parsed.lastCheckedAt) : Number.NaN
    return Number.isFinite(ms) ? ms : null
  } catch {
    return null
  }
}

async function writeLastScheduledCheckAt(nowMs: number): Promise<void> {
  const path = guiUpdateSchedulePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({
      lastCheckedAt: new Date(nowMs).toISOString(),
      appVersion: app.getVersion()
    }, null, 2),
    'utf8'
  )
}

function normalizeGithubOwnerRepo(raw: string): string | null {
  let s = raw.trim()
  if (!s) return null
  if (s.startsWith('github:')) s = s.slice('github:'.length).trim()
  const ssh = s.match(/^git@github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)
  if (ssh?.[1]) return ssh[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const https = s.match(/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:$|[#/])/i)
  if (https?.[1]) return https[1].replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s
  return null
}

function packageJsonPath(): string {
  return join(app.getAppPath(), 'package.json')
}

function readPackageJson(): Record<string, unknown> | null {
  try {
    const path = packageJsonPath()
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function resolveGithubRepo(): string | null {
  const envRepo = normalizeGithubOwnerRepo(
    (process.env.WORKWISE_GITHUB_REPO || legacyGithubRepo()).trim()
  )
  if (envRepo) return envRepo

  const pkg = readPackageJson()
  const repository = pkg?.repository
  const raw =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository === 'object' && 'url' in repository
        ? String((repository as { url?: unknown }).url ?? '')
        : ''
  const repo = normalizeGithubOwnerRepo(raw) || normalizeGithubOwnerRepo(
    typeof pkg?.homepage === 'string' ? pkg.homepage : ''
  )
  return repo || DEFAULT_GITHUB_REPO
}

function resolveGithubReleaseUrl(): string | null {
  const repo = resolveGithubRepo()
  return repo ? `https://github.com/${repo}/releases` : null
}

function resolveUpdateFeedConfig(channel: GuiUpdateChannel): UpdateFeedConfig {
  if (updateProviderSetting() === 'none') return { kind: 'none' }
  if (shouldUseGithubUpdateProvider(channel)) {
    const fullName = resolveGithubRepo()
    const [owner, repo] = fullName?.split('/') ?? []
    if (owner && repo) return { kind: 'github', owner, repo, fullName: `${owner}/${repo}` }
  }

  const genericUrl = genericUpdateFeedUrl(channel)
  if (genericUrl) return { kind: 'generic', url: genericUrl }

  return { kind: 'none' }
}

function downloadPageUrl(): string {
  const direct = (process.env.WORKWISE_DOWNLOAD_URL || legacyDownloadUrl()).trim()
  if (direct) return direct

  const configuredDownloadPage = (process.env.WORKWISE_DOWNLOAD_BASE_URL || process.env.PUBLIC_DOWNLOAD_PAGE_URL)?.trim()
  if (configuredDownloadPage) return configuredDownloadPage

  if (shouldUseGithubUpdateProvider(configuredChannel)) {
    const releaseUrl = resolveGithubReleaseUrl()
    if (releaseUrl) return releaseUrl
  }

  return DEFAULT_PRODUCT_PAGE_URL
}

function releaseUrlForVersion(version: string): string {
  const page = downloadPageUrl()
  if (/github\.com\/.+\/releases\/?$/i.test(page)) {
    return `${page.replace(/\/+$/, '')}/tag/v${version.replace(/^v/i, '')}`
  }
  return page
}

function parseVersionParts(v: string): number[] {
  const cleaned = v.trim().replace(/^v/i, '').replace(/-.*$/, '')
  return cleaned.split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function isVersionGreater(latest: string, current: string): boolean {
  const a = parseVersionParts(latest)
  const b = parseVersionParts(current)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av > bv) return true
    if (av < bv) return false
  }
  return false
}

function validateCandidateVersion(version: string, expectedVersion?: string): string | null {
  const normalized = version.trim().replace(/^v/i, '')
  if (!versionFromTag(normalized, configuredChannel)) return `Update metadata contains an invalid ${configuredChannel} version.`
  if (!isVersionGreater(normalized, app.getVersion())) return 'Update downgrade or same-version installation was rejected.'
  if (expectedVersion && normalized !== expectedVersion.trim().replace(/^v/i, '')) {
    return `Downloaded update version ${normalized} does not match checked manifest version ${expectedVersion}.`
  }
  return null
}

function versionFromTag(value: string, channel: GuiUpdateChannel): string | null {
  const trimmed = value.trim()
  const pattern =
    channel === 'stable'
      ? /^v?(\d+\.\d+\.\d+)$/i
      : /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/i
  const match = trimmed.match(pattern)
  return match?.[1] ?? null
}

function versionFromGithubRelease(release: GithubRelease, channel: GuiUpdateChannel): string | null {
  const tag = typeof release.tag_name === 'string' ? versionFromTag(release.tag_name, channel) : null
  if (tag) return tag
  const name = typeof release.name === 'string' ? versionFromTag(release.name, channel) : null
  return name
}

function selectGithubRelease(
  releases: GithubRelease[],
  channel: GuiUpdateChannel
): { release: GithubRelease; version: string } | null {
  for (const release of releases) {
    if (release.draft === true) continue
    if (channel === 'stable' && release.prerelease === true) continue
    const version = versionFromGithubRelease(release, channel)
    if (!version) continue
    if (channel === 'stable' && WITHDRAWN_STABLE_VERSIONS.has(version)) continue
    const htmlUrl = typeof release.html_url === 'string' ? release.html_url.trim() : ''
    if (!htmlUrl) continue
    return { release, version }
  }
  return null
}

function platformManifestName(): string {
  if (process.platform === 'darwin') return 'latest-mac.yml'
  if (process.platform === 'linux') return 'latest-linux.yml'
  return 'latest.yml'
}

function parseYamlScalar(source: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`^${escaped}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

function macAutoUpdateAllowed(): boolean {
  if (process.platform !== 'darwin') return true
  if (process.env.NODE_ENV === 'test' && process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES === '1') return true
  if (legacyUnsignedUpdatesEnabled()) return true

  const pkg = readPackageJson()
  const hints = pkg?.buildHints
  if (!hints || typeof hints !== 'object') return false
  const values = hints as { macSigningEnabled?: unknown; notarizationEnabled?: unknown }
  return values.macSigningEnabled === true && values.notarizationEnabled === true
}

function unsupportedMessage(): string {
  if (process.platform === 'darwin') {
    return 'This macOS build cannot update in the app because it is not signed and notarized.'
  }
  return 'This build cannot update in the app because its installer is not eligible for automatic updates.'
}

function extractHttpStatus(raw: string): number | null {
  const match = raw.match(/\b(\d{3})\b/)
  if (!match) return null
  const status = Number.parseInt(match[1], 10)
  return Number.isFinite(status) ? status : null
}

function sanitizeUpdaterError(raw: string, channel: GuiUpdateChannel): string {
  const message = raw.trim()
  if (!message) {
    return `Could not read GUI update metadata for the ${channel} channel.`
  }

  if (/Invalid release object path\./i.test(message)) {
    return `The ${channel} update feed is not published correctly yet.`
  }

  if (/Object not found\./i.test(message)) {
    return `The ${channel} update feed is missing release metadata right now.`
  }

  const status = extractHttpStatus(message)
  if (status === 400 || status === 404) {
    return `The ${channel} update feed is not available right now.`
  }
  if (status === 403) {
    return `The ${channel} update feed denied this request.`
  }
  if (status === 429) {
    return `The ${channel} update feed is rate limited right now. Please try again later.`
  }
  if (status && status >= 500) {
    return `The ${channel} update feed is temporarily unavailable. Please try again later.`
  }

  return message.split(/\n(?:Headers:|Data:)/, 1)[0].trim() || message
}

function classifyUpdaterFailureCode(raw: string): GuiUpdateFailureCode {
  if (/signature|code.?sign|not notarized|not signed|sha512|checksum/i.test(raw)) {
    return 'signature_invalid'
  }
  const status = extractHttpStatus(raw)
  if (status === 400 || status === 404 || /manifest|release metadata|object not found/i.test(raw)) {
    return 'manifest_unavailable'
  }
  if (/econn|enotfound|timeout|network|fetch failed|unable to connect|socket/i.test(raw)) {
    return 'network'
  }
  return 'unknown'
}

function isWithdrawnStableVersion(version: string, channel: GuiUpdateChannel): boolean {
  return channel === 'stable' && WITHDRAWN_STABLE_VERSIONS.has(version.trim().replace(/^v/i, ''))
}

function resolveWithdrawnVersion(
  currentVersion: string,
  latestVersion: string,
  channel: GuiUpdateChannel
): string | undefined {
  if (isWithdrawnStableVersion(currentVersion, channel)) return currentVersion
  if (isVersionGreater(latestVersion, currentVersion) && isWithdrawnStableVersion(latestVersion, channel)) {
    return latestVersion
  }
  return undefined
}

function toGuiInfo(updateInfo: UpdateInfo, hasUpdate: boolean, manualOnly = false): Extract<GuiUpdateInfo, { ok: true }> {
  const latestVersion = updateInfo.version.trim()
  const currentVersion = app.getVersion()
  const candidateWithdrawn = isWithdrawnStableVersion(latestVersion, configuredChannel)
  const withdrawnVersion = resolveWithdrawnVersion(currentVersion, latestVersion, configuredChannel)
  return {
    ok: true,
    currentVersion,
    latestVersion,
    hasUpdate: hasUpdate && !candidateWithdrawn,
    releaseUrl: releaseUrlForVersion(latestVersion),
    releaseDate: updateInfo.releaseDate,
    channel: configuredChannel,
    manualOnly,
    downloaded,
    withdrawn: Boolean(withdrawnVersion),
    ...(withdrawnVersion ? { withdrawnVersion } : {})
  }
}

function emitGuiUpdateState(state: GuiUpdateState): void {
  lastState = state
  const win = getMainWindow?.()
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send('gui:update-state', state)
}

function runBeforeInstallUpdate(): Promise<void> {
  if (!beforeInstallUpdate) return Promise.resolve()
  if (!beforeInstallUpdatePromise) {
    beforeInstallUpdatePromise = Promise.resolve()
      .then(() => beforeInstallUpdate?.())
      .then(() => undefined)
      .finally(() => {
        beforeInstallUpdatePromise = null
      })
  }
  return beforeInstallUpdatePromise
}

function clearBackgroundCheckTimer(): void {
  if (backgroundCheckTimer) {
    clearTimeout(backgroundCheckTimer)
    backgroundCheckTimer = null
  }
}

function shouldSkipScheduledCheck(): boolean {
  return (
    lastState.status === 'checking' ||
    lastState.status === 'downloading' ||
    lastState.status === 'downloaded' ||
    lastState.status === 'installing'
  )
}

async function scheduleNextBackgroundCheck(): Promise<void> {
  clearBackgroundCheckTimer()
  const lastCheckedAtMs = await readLastScheduledCheckAt()
  const delay = nextGuiUpdateCheckDelay(lastCheckedAtMs)
  backgroundCheckTimer = setTimeout(() => {
    void runScheduledGuiUpdateCheck()
  }, delay)
}

async function runScheduledGuiUpdateCheck(): Promise<void> {
  if (backgroundCheckPromise) return backgroundCheckPromise
  backgroundCheckPromise = (async () => {
    try {
      if (shouldSkipScheduledCheck()) return
      const nowMs = Date.now()
      await writeLastScheduledCheckAt(nowMs)
      const info = await checkGuiUpdate()
      if (info.ok && info.hasUpdate) onBackgroundUpdateAvailable?.(info)
    } catch (error) {
      console.warn('[workwise updater] scheduled GUI update check failed:', error)
    } finally {
      backgroundCheckPromise = null
      void scheduleNextBackgroundCheck()
    }
  })()
  return backgroundCheckPromise
}

async function resolveUpdateChannel(requested?: GuiUpdateChannel): Promise<GuiUpdateChannel> {
  if (requested) return normalizeGuiUpdateChannel(requested)
  if (getSelectedChannel) {
    return normalizeGuiUpdateChannel(await getSelectedChannel())
  }
  return DEFAULT_GUI_UPDATE_CHANNEL
}

function configureUpdaterChannel(channel: GuiUpdateChannel): void {
  const normalized = normalizeGuiUpdateChannel(channel)
  const feed = resolveUpdateFeedConfig(normalized)
  const feedUrl =
    feed.kind === 'generic'
      ? feed.url
      : feed.kind === 'github'
        ? `github:${feed.fullName}`
        : 'none'
  const changed = normalized !== configuredChannel || feedUrl !== configuredFeedUrl
  configuredChannel = normalized
  configuredFeedUrl = feedUrl
  autoUpdater.allowPrerelease = normalized === 'frontier'
  if (feed.kind === 'generic') {
    if (!/^https:\/\//i.test(feed.url) && app.isPackaged) {
      throw new Error('Production update feeds must use HTTPS.')
    }
    configurePrivateUpdaterTls(() => autoUpdater.netSession, feed.url)
    autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
  } else if (feed.kind === 'github') {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: feed.owner,
      repo: feed.repo
    })
  }
  if (!changed) return
  downloaded = false
  downloadPromise = null
  lastInfo = null
  emitGuiUpdateState({ status: 'idle' })
}

function configureUpdaterRequestHeaders(): void {
  autoUpdater.requestHeaders = {
    ...(autoUpdater.requestHeaders ?? {}),
    ...UPDATE_REQUEST_HEADERS
  }
}

export function setGuiUpdateChannel(channel: GuiUpdateChannel): void {
  configureUpdaterChannel(channel)
}

async function checkManualUpdate(
  channel: GuiUpdateChannel,
  code: GuiUpdateFailureCode = 'unsupported'
): Promise<GuiUpdateInfo> {
  const currentVersion = app.getVersion()
  const releaseUrl = downloadPageUrl()

  if (code === 'unsupported' || code === 'unsigned_build') {
    return {
      ok: false,
      currentVersion,
      code: 'unsigned_build',
      message: unsupportedMessage(),
      releaseUrl,
      channel
    }
  }

  const githubFallback = async (): Promise<GuiUpdateInfo | null> => {
    if (!shouldFallbackToGithubUpdateProvider(channel)) return null

    const repo = resolveGithubRepo()
    if (!repo) return null

    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `workwise/${currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      })

      if (res.status === 404) {
        return {
          ok: false,
          currentVersion,
          code: 'github_repo_not_found',
          message: `GitHub repository ${repo} was not found.`,
          releaseUrl,
          channel,
          repo
        }
      }
      if (res.status === 403) {
        const remaining = res.headers.get('x-ratelimit-remaining')
        return {
          ok: false,
          currentVersion,
          code: remaining === '0' ? 'github_rate_limited' : 'github_forbidden',
          message: 'GitHub denied the update metadata request.',
          releaseUrl,
          channel,
          repo
        }
      }
      if (!res.ok) return null

      const parsed = await res.json()
      const releases = Array.isArray(parsed) ? (parsed as GithubRelease[]) : []
      const selected = selectGithubRelease(releases, channel)
      if (!selected) {
        return {
          ok: false,
          currentVersion,
          code: 'no_stable_version',
          message: `No ${channel} release is available on GitHub yet.`,
          releaseUrl,
          channel,
          repo
        }
      }

      const withdrawnVersion = resolveWithdrawnVersion(currentVersion, selected.version, channel)
      const info: Extract<GuiUpdateInfo, { ok: true }> = {
        ok: true,
        currentVersion,
        latestVersion: selected.version,
        hasUpdate: isVersionGreater(selected.version, currentVersion),
        releaseUrl: String(selected.release.html_url),
        releaseDate:
          typeof selected.release.published_at === 'string' ? selected.release.published_at : undefined,
        channel,
        manualOnly: true,
        downloaded: false,
        withdrawn: Boolean(withdrawnVersion),
        ...(withdrawnVersion ? { withdrawnVersion } : {})
      }
      lastInfo = info
      emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
      return info
    } catch {
      return null
    }
  }

  if (shouldUseGithubUpdateProvider(channel)) {
    const github = await githubFallback()
    if (github) return github
    return {
      ok: false,
      currentVersion,
      code: 'not_configured',
      message: 'GitHub update provider is configured, but release metadata could not be read.',
      releaseUrl,
      channel
    }
  }

  const genericFeed = genericUpdateFeedUrl(channel)
  if (!genericFeed) {
    const github = await githubFallback()
    if (github) return github
    return {
      ok: false,
      currentVersion,
      code: 'not_configured',
      message: 'No online update source is configured.',
      releaseUrl,
      channel
    }
  }

  try {
    const url = `${genericFeed}${platformManifestName()}`
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        Accept: 'application/x-yaml,text/yaml,text/plain,*/*',
        'User-Agent': `workwise/${currentVersion}`,
        ...UPDATE_REQUEST_HEADERS
      }
    })
    if (!res.ok) {
      const github = await githubFallback()
      if (github) return github
      return {
        ok: false,
        currentVersion,
        code: 'manifest_unavailable',
        message: `The ${channel} update feed returned HTTP ${res.status}.`,
        releaseUrl,
        channel
      }
    }
    const text = await res.text()
    const latestVersion = parseYamlScalar(text, 'version')
    if (!latestVersion) {
      const github = await githubFallback()
      if (github) return github
      return {
        ok: false,
        currentVersion,
        code: 'manifest_unavailable',
        message: `The ${channel} update feed is missing a version.`,
        releaseUrl,
        channel
      }
    }
    const withdrawnVersion = resolveWithdrawnVersion(currentVersion, latestVersion, channel)
    const info: Extract<GuiUpdateInfo, { ok: true }> = {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate: isVersionGreater(latestVersion, currentVersion),
      releaseUrl: releaseUrlForVersion(latestVersion),
      releaseDate: parseYamlScalar(text, 'releaseDate'),
      channel,
      manualOnly: true,
      downloaded: false,
      withdrawn: Boolean(withdrawnVersion),
      ...(withdrawnVersion ? { withdrawnVersion } : {})
    }
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
    return info
  } catch (e) {
    const github = await githubFallback()
    if (github) return github
    return {
      ok: false,
      currentVersion,
      code: classifyUpdaterFailureCode(e instanceof Error ? e.message : String(e)),
      message: e instanceof Error ? e.message : String(e),
      releaseUrl,
      channel
    }
  }
}

export function initializeGuiUpdater(
  windowGetter: () => BrowserWindow | null,
  channelGetter?: () => GuiUpdateChannel | Promise<GuiUpdateChannel>,
  beforeInstall?: () => void | Promise<void>,
  updateAvailable?: (info: Extract<GuiUpdateInfo, { ok: true }>) => void
): void {
  getMainWindow = windowGetter
  getSelectedChannel = channelGetter ?? null
  beforeInstallUpdate = beforeInstall ?? null
  onBackgroundUpdateAvailable = updateAvailable ?? null
  if (initialized) return
  initialized = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  configureUpdaterRequestHeaders()
  configureUpdaterChannel(configuredChannel)
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  autoUpdater.logger = {
    info: (message?: unknown) => console.info('[workwise updater]', message),
    warn: (message?: unknown) => console.warn('[workwise updater]', message),
    error: (message?: unknown) => console.error('[workwise updater]', message)
  }

  autoUpdater.on('checking-for-update', () => {
    emitGuiUpdateState({ status: 'checking', info: lastInfo ?? undefined })
  })

  autoUpdater.on('update-available', (updateInfo: UpdateInfo) => {
    downloaded = false
    const invalid = validateCandidateVersion(updateInfo.version)
    if (invalid) {
      emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message: invalid, code: 'download_failed' })
      return
    }
    const info = toGuiInfo(updateInfo, true)
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
  })

  autoUpdater.on('update-not-available', (updateInfo: UpdateInfo) => {
    downloaded = false
    const info = toGuiInfo(updateInfo, false)
    lastInfo = info
    emitGuiUpdateState({ status: 'not_available', info })
  })

  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    emitGuiUpdateState({ status: 'downloading', info: lastInfo ?? undefined, progress })
  })

  autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
    const invalid = validateCandidateVersion(event.version, lastInfo?.latestVersion)
    if (invalid) {
      downloaded = false
      emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message: invalid, code: 'download_failed' })
      return
    }
    downloaded = true
    const info = toGuiInfo(event, true)
    if (!info.hasUpdate) {
      downloaded = false
      lastInfo = info
      emitGuiUpdateState({ status: 'not_available', info })
      return
    }
    lastInfo = info
    emitGuiUpdateState({ status: 'downloaded', info })
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    emitGuiUpdateState({
      status: 'error',
      info: lastInfo ?? undefined,
      message,
      code: classifyUpdaterFailureCode(message)
    })
  })

  nativeAutoUpdater?.on?.('before-quit-for-update', () => {
    void runBeforeInstallUpdate().catch((error) => {
      console.warn('[workwise updater] failed to stop runtimes before update quit:', error)
    })
  })

  void scheduleNextBackgroundCheck()
}

export function getGuiUpdateState(): GuiUpdateState {
  return lastState
}

async function performGuiUpdateCheck(selectedChannel: GuiUpdateChannel): Promise<GuiUpdateInfo> {
  configureUpdaterChannel(selectedChannel)

  if (resolveUpdateFeedConfig(selectedChannel).kind === 'none') {
    return checkManualUpdate(selectedChannel, 'not_configured')
  }

  if (!macAutoUpdateAllowed()) {
    return checkManualUpdate(selectedChannel, 'unsigned_build')
  }

  emitGuiUpdateState({ status: 'checking', info: lastInfo ?? undefined })
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      const info: GuiUpdateInfo = {
        ok: false,
        currentVersion: app.getVersion(),
        code: 'manifest_unavailable',
        message: `The ${selectedChannel} update feed did not return update metadata.`,
        releaseUrl: downloadPageUrl(),
        channel: selectedChannel
      }
      emitGuiUpdateState({ status: 'error', info, message: info.message, code: info.code })
      return info
    }
    const info = toGuiInfo(result.updateInfo, result.isUpdateAvailable)
    lastInfo = info
    emitGuiUpdateState(info.hasUpdate ? { status: 'available', info } : { status: 'not_available', info })
    return info
  } catch (e) {
    const message = sanitizeUpdaterError(e instanceof Error ? e.message : String(e), selectedChannel)
    const code = classifyUpdaterFailureCode(e instanceof Error ? e.message : String(e))
    const info: GuiUpdateInfo = {
      ok: false,
      currentVersion: app.getVersion(),
      message,
      code,
      releaseUrl: downloadPageUrl(),
      channel: selectedChannel
    }
    emitGuiUpdateState({ status: 'error', info, message, code })
    return info
  }
}

export async function checkGuiUpdate(channel?: GuiUpdateChannel): Promise<GuiUpdateInfo> {
  const selectedChannel = await resolveUpdateChannel(channel)
  if (guiUpdateCheckPromise) {
    if (guiUpdateCheckChannel === selectedChannel) return guiUpdateCheckPromise
    await guiUpdateCheckPromise.catch(() => undefined)
    return checkGuiUpdate(selectedChannel)
  }
  guiUpdateCheckChannel = selectedChannel
  guiUpdateCheckPromise = performGuiUpdateCheck(selectedChannel).finally(() => {
    guiUpdateCheckPromise = null
    guiUpdateCheckChannel = null
  })
  return guiUpdateCheckPromise
}

export async function downloadGuiUpdate(channel?: GuiUpdateChannel): Promise<GuiUpdateDownloadResult> {
  const selectedChannel = await resolveUpdateChannel(channel)
  configureUpdaterChannel(selectedChannel)

  if (!macAutoUpdateAllowed()) {
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'unsupported',
      message: unsupportedMessage()
    }
  }

  try {
    if (!lastInfo?.hasUpdate || lastInfo.channel !== selectedChannel) {
      const checked = await checkGuiUpdate(selectedChannel)
      if (!checked.ok) return checked
      if (!checked.hasUpdate || checked.manualOnly) {
        return {
          ok: false,
          currentVersion: app.getVersion(),
          code: checked.manualOnly ? 'unsupported' : 'unknown',
          message: checked.manualOnly
            ? unsupportedMessage()
            : 'No downloadable GUI update is available.'
        }
      }
    }
    const downloadableInfo = lastInfo
    if (!downloadableInfo?.hasUpdate || downloadableInfo.channel !== selectedChannel) {
      return {
        ok: false,
        currentVersion: app.getVersion(),
        code: 'download_failed',
        message: 'Update state changed before the download could begin. Check for updates again.'
      }
    }
    const invalid = validateCandidateVersion(downloadableInfo.latestVersion)
    if (invalid) {
      return { ok: false, currentVersion: app.getVersion(), code: 'download_failed', message: invalid }
    }

    if (!downloadPromise) {
      downloadPromise = autoUpdater.downloadUpdate().finally(() => {
        downloadPromise = null
      })
    }
    const paths = await downloadPromise
    return { ok: true, paths }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'download_failed' })
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'download_failed',
      message
    }
  }
}

function shouldInstallSilently(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

export async function installGuiUpdate(): Promise<GuiUpdateInstallResult> {
  try {
    if (!downloaded) {
      return {
        ok: false,
        currentVersion: app.getVersion(),
        code: 'install_failed',
        message: 'The update has not finished downloading yet.'
      }
    }
    emitGuiUpdateState({ status: 'installing', info: lastInfo ?? undefined })
    await runBeforeInstallUpdate()
    // Assisted NSIS installers are interactive unless isSilent is true. An
    // in-app update must finish after WorkWise exits without leaving a hidden
    // installer waiting for input. macOS ignores this parameter.
    autoUpdater.quitAndInstall(shouldInstallSilently(process.platform), true)
    return { ok: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    emitGuiUpdateState({ status: 'error', info: lastInfo ?? undefined, message, code: 'install_failed' })
    return {
      ok: false,
      currentVersion: app.getVersion(),
      code: 'install_failed',
      message
    }
  }
}

export const _internals = {
  normalizeGithubOwnerRepo,
  selectGithubRelease,
  genericUpdateFeedUrl,
  resolveUpdateFeedConfig,
  downloadPageUrl,
  parseScheduledCheckAt,
  resolveWithdrawnVersion,
  validateCandidateVersion,
  shouldInstallSilently,
  configureUpdaterRequestHeaders
}
