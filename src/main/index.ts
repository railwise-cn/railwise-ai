import brand from '../shared/product-brand.json'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerSaveBlocker, shell, Tray, type MessageBoxOptions } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openAsBlob } from 'node:fs'
import { homedir, release as osRelease, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  JsonSettingsStore,
  devServerHintUrl
} from './settings-store'
import { applySettingsApplicationTransaction } from './settings-application-transaction'
import workwiseLogoPng from '../asset/img/workwise.png?url'
import workwiseDockPng from '../asset/img/workwise_dock.png?url'
import workwiseDockDarkPng from '../asset/img/workwise_dock_dark.png?url'
import workwiseLightPng from '../asset/img/workwise-light.png?url'
import workwiseTrayPng from '../asset/img/workwise_tray.png?url'
import workwiseSymbolPng from '../asset/img/workwise-symbol.png?url'
import { createAppIcon, pickTrayIcon } from './app-icon'
import { configureChromiumUserDataPath, configureLinuxWaylandImeSwitches } from './app-command-line'
import { configureAppIdentity } from './app-identity'
import { createNotificationClickHandler } from './notification-navigation'
import { isActiveThreadActuallyVisible } from './notification-visibility'
import {
  shouldCloseMainWindowToTray,
  shouldShowStartupErrorDialog,
  shouldStopServicesWhenAllWindowsClose
} from './app-lifecycle'
import { runLegacyDataImport } from './legacy-data-migration'
import {
  candidateServicePortPatch,
  configureCandidateApplicationPaths,
  candidateEnvironmentFromArgv,
  isCandidateHeadless,
  isCandidateRuntimeProbe,
  isUnconfiguredRecoveryCandidate,
  resolveCandidateRuntimePaths,
  reserveCandidateServicePorts,
  runCandidateRuntimeProbe,
  verifyCandidateServiceListeners,
  sanitizeCandidateProcessEnvironment,
  isCandidateImProviderConnectionAllowed,
  UNCONFIGURED_RECOVERY_CANDIDATE_EXIT_CODE
} from './candidate-runtime'
import {
  kunSettingsEnvelope,
  getActiveAgentApiKey,
  getManagedRuntimeSettings,
  mergeManagedRuntimeSettings,
  normalizeAppBehaviorSettings,
  shouldShowTerminalNotification,
  resolveManagedRuntimeSettings,
  type AppBehaviorConfigV1,
  type AppSettingsPatch,
  type AppSettingsV1
} from '../shared/app-settings'
import { parseRuntimeErrorBody, runtimeErrorToError, type RuntimeErrorCode } from '../shared/runtime-error'
import type { GuiUpdateState } from '../shared/gui-update'
import type { ApplicationMenuAction } from '../shared/workwise-api'
import { isAllowedDevPreviewUrl } from '../shared/dev-preview-url'
import { fetchUpstreamModelIds } from './upstream-models'
import {
  configureManagedRuntimeStartOptions,
  managedRuntimeAdapter,
  getRuntimeBaseUrlForSettings,
  runtimeAuthHeaders,
  runtimeRequestViaHost
} from './runtime/managed-runtime-adapter'
import { getManagedRuntimeActualPort } from './managed-runtime-process'
import { waitForRuntimeTurnsIdle } from './runtime/managed-runtime-idle'
import { configureLogger, logError, logWarn, pruneOnStartup } from './logger'
import { createClawRuntime, type ClawRuntime } from './claw-runtime'
import { shouldAutoRecoverFeishuHealth } from './im-health-recovery-policy'
import { createScheduleRuntime, type ScheduleRuntime } from './schedule-runtime'
import { migrateSchedulesToFlows } from './schedule-flow-migration'
import { runClawScheduleMcpServerFromArgv } from './claw-schedule-mcp-server'
import {
  clawScheduleMcpSettingsChanged,
  resolveRuntimeMcpJsonPath,
  syncClawScheduleMcpConfig,
  type ClawScheduleMcpLaunchConfig
} from './claw-schedule-mcp-config'
import { registerAppIpcHandlers } from './ipc/register-app-ipc-handlers'
import {
  configureManagedWeixinBridgeUrlResolver,
  pollFeishuInstall,
  pollWeixinInstall,
  startFeishuInstallQrcode,
  startWeixinInstallQrcode
} from './claw-platform-install'
import { registerRuntimeSseIpc, stopAllRuntimeSse } from './runtime-sse-ipc'
import { appCancellationRegistry } from './cancellation-registry'
import { drainSerializedWrites } from './services/durable-file'
import {
  ImCredentialService
} from './services/im-credential-service'
import {
  isImCredentialHelperProcess,
  runImCredentialHelperProcess,
  stopCredentialHelperProcesses
} from './services/im-credential-helper'
import { ImDeliveryLedger } from './services/im-delivery-ledger'
import { ImHealthService } from './services/im-health-service'
import {
  configureWeixinBridgeCredentialProvider,
  configureWeixinBridgeRuntimeContextProvider,
  disconnectWeixinBridgeAccount,
  ensureWeixinBridgeRpcUrl,
  getWeixinBridgeAccountStatuses,
  getWeixinBridgeAccountUserId,
  isWeixinBridgeAccountConfigured,
  reconnectWeixinBridgeAccount,
  sendWeixinBridgeMessage,
  startWeixinBridgeAccount,
  stopWeixinBridgeAccount,
  stopWeixinBridgeRuntime
} from './weixin-bridge-runtime'
import { webhookUrl } from './claw-runtime-helpers'
import { IM_HEALTH_SUPERVISOR_INTERVAL_MS } from '../shared/im-communication'
import { isRuntimeHealthResponseBody } from './runtime-health'
import { legacyStartupTraceEnabled } from './compat/legacy-environment'
import {
  applicationMenuLabels,
  buildApplicationMenuTemplate
} from './application-menu'
import {
  configureGuiUpdaterAcceptance,
  failGuiUpdaterAcceptance,
  isGuiUpdaterAcceptanceLaunch,
  prepareGuiUpdaterAcceptance,
  runGuiUpdaterAcceptance,
  type ActiveGuiUpdaterAcceptance
} from './gui-updater-acceptance'
import {
  applyWindowMaterial,
  isRemoteDesktopSession,
  parseWindowsBuild,
  resolveWindowAppearance,
  windowMaterialOptions
} from './window-appearance'
import {
  createSplashWindow,
  splashRemainingVisibleMs,
  splashProgressLabel,
  type SplashWindowController
} from './splash-window'
import {
  SOLID_WINDOW_APPEARANCE,
  windowAppearanceArguments,
  windowLocaleArgument,
  type WindowAppearanceV1
} from '../shared/window-appearance'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 品牌升级为 WorkWise Runtime 后仍保留旧 AppUserModelId:它必须和 electron-builder
// 的 appId 一致才能让 Windows 通知 / 任务栏分组在升级前后连续,而
// appId 因为 NSIS 升级 GUID 与 macOS 更新签名校验的原因永远不改。
const APP_USER_MODEL_ID = 'com.wangjiawei508.workgpt'
const HIDDEN_START_ARG = '--hidden'
const startupTraceEnabled =
  process.env.WORKWISE_STARTUP_TRACE === '1' || legacyStartupTraceEnabled()
const startupTraceStart = Date.now()

function traceStartup(label: string, detail?: unknown): void {
  if (!startupTraceEnabled) return
  const elapsed = String(Date.now() - startupTraceStart).padStart(6, ' ')
  if (detail === undefined) {
    console.info(`[startup +${elapsed}ms] ${label}`)
  } else {
    console.info(`[startup +${elapsed}ms] ${label}`, detail)
  }
}

function shouldStartWeixinBridgeRuntime(settings: AppSettingsV1): boolean {
  return isCandidateImProviderConnectionAllowed('weixin') &&
    settings.claw.enabled &&
    settings.claw.im.enabled &&
    settings.claw.channels.some((channel) => channel.enabled && channel.provider === 'weixin')
}

function syncWeixinBridgeRuntime(settings: AppSettingsV1): void {
  if (!shouldStartWeixinBridgeRuntime(settings)) return
  void ensureWeixinBridgeRpcUrl().catch((error) => {
    logWarn('weixin-bridge', 'Failed to start managed WeChat bridge.', {
      message: error instanceof Error ? error.message : String(error)
    })
  })
}

const runningClawScheduleMcpServer =
  process.argv.includes('--gui-schedule-mcp-server') || process.argv.includes('--claw-schedule-mcp-server')
const runningImCredentialHelper = isImCredentialHelperProcess()

function resolveLogDirectory(): string {
  return join(app.getPath('userData'), 'logs')
}

function resolvePreloadPath(): string {
  const cjsPath = join(__dirname, '../preload/index.cjs')
  if (existsSync(cjsPath)) return cjsPath
  return join(__dirname, '../preload/index.mjs')
}

function getClawScheduleMcpLaunchConfig(): ClawScheduleMcpLaunchConfig {
  return {
    appPath: app.getAppPath(),
    execPath: process.execPath,
    isPackaged: app.isPackaged
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runtimeFailure(code: string, message: string, status = 0, details?: unknown) {
  return {
    ok: false as const,
    status,
    body: JSON.stringify({ code, message, ...(details !== undefined ? { details } : {}) })
  }
}

function resolveConfiguredApiKey(settings: AppSettingsV1): string {
  const fromSettings = getActiveAgentApiKey(settings)
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim() ?? ''
  return fromSettings || fromEnv
}

function runtimeJsonError(code: string, message: string): Error {
  return runtimeErrorToError({ code: code as RuntimeErrorCode, message })
}

traceStartup('main module evaluated')

let candidateLaunchConfigurationError = ''
try {
  Object.assign(process.env, candidateEnvironmentFromArgv(process.execPath, process.argv, process.env, process.resourcesPath))
  sanitizeCandidateProcessEnvironment(process.env)
} catch (error) {
  candidateLaunchConfigurationError = error instanceof Error ? error.message : String(error)
}
const unconfiguredRecoveryCandidate = isUnconfiguredRecoveryCandidate(process.execPath, process.env, process.resourcesPath)
if (unconfiguredRecoveryCandidate) {
  const quarantineRoot = join(tmpdir(), `workwise-unconfigured-candidate-${process.pid}`)
  const quarantinePaths = {
    userData: join(quarantineRoot, 'user-data'),
    cache: join(quarantineRoot, 'cache'),
    sessionData: join(quarantineRoot, 'session-data'),
    crashDumps: join(quarantineRoot, 'crash-dumps'),
    logs: join(quarantineRoot, 'logs')
  }
  for (const path of Object.values(quarantinePaths)) mkdirSync(path, { recursive: true, mode: 0o700 })
  app.setPath('userData', quarantinePaths.userData)
  app.setPath('cache', quarantinePaths.cache)
  app.setPath('sessionData', quarantinePaths.sessionData)
  app.setPath('crashDumps', quarantinePaths.crashDumps)
  app.setPath('logs', quarantinePaths.logs)
  // Chromium helpers do not derive their profile directory from Electron's
  // app.setPath('userData'). Pass the quarantine path explicitly so an
  // unconfigured candidate cannot start GPU/network helpers against the
  // production profile.
  configureChromiumUserDataPath(quarantinePaths.userData)
}

const candidateRuntimePaths = resolveCandidateRuntimePaths()
const candidateHeadless = Boolean(candidateRuntimePaths && isCandidateHeadless())
const candidateRuntimeProbe = Boolean(candidateRuntimePaths && isCandidateRuntimeProbe())
if (candidateRuntimePaths) {
  const runtimeToken = randomBytes(32).toString('base64url')
  const flowSecretStoreKey = randomBytes(32).toString('base64url')
  // The credential helper receives its own --user-data-dir so it never
  // contends with the GUI's Chromium profile while initializing safeStorage.
  // Keep the candidate's normal paths for every other process.
  configureCandidateApplicationPaths(
    candidateRuntimePaths,
    process.argv,
    runningImCredentialHelper,
    (name, path) => app.setPath(name, path)
  )
  // Electron's child helpers inherit Chromium's command-line profile, not
  // the value changed through app.setPath(). Keep every candidate process in
  // the same isolated userData tree before any window or helper is created.
  configureChromiumUserDataPath(app.getPath('userData'))
  process.env.WORKWISE_TOOLS_ROOT = candidateRuntimePaths.toolsRoot
  process.env.WORKWISE_UPDATE_PROVIDER = 'none'
  configureManagedRuntimeStartOptions({
    candidateRoot: candidateRuntimePaths.root,
    homeDir: candidateRuntimePaths.home,
    workwiseHome: candidateRuntimePaths.workwiseHome,
    mcpConfigPath: join(candidateRuntimePaths.workwiseHome, 'mcp.json'),
    autoInstallBundledAgentPack: false,
    autoInstallBundledSpecialistSkills: false,
    skillRoots: [],
    runtimeToken,
    flowSecretStoreKey
  })
}

function clawScheduleMcpConfigPaths(): { mcpJsonPath?: string } {
  return candidateRuntimePaths
    ? { mcpJsonPath: join(candidateRuntimePaths.workwiseHome, 'mcp.json') }
    : {}
}

if (runningClawScheduleMcpServer && process.platform === 'darwin') {
  app.dock?.hide()
}

// 在最早的阶段把 app 名称、AppUserModelId 都设好。
// Windows 任务栏 / 系统托盘 / 通知中心看到的应用名都来自这里;
// 设得太晚的话 BrowserWindow title、托盘、IPC 启动时拿到的还是旧的。
// 抽到 app-identity.ts 是为了让测试可以直接 import,不被 main 的
// whenReady 副作用污染。
configureAppIdentity()

// 紧跟在身份设置之后、requestSingleInstanceLock() 之前做只读旧数据导入。
// 源目录永不重命名或删除；已存在的 WorkWise 目标始终优先。
const legacyMigration = runningImCredentialHelper || unconfiguredRecoveryCandidate
  ? {
      userData: { userDataPath: app.getPath('userData'), migrated: false },
      home: []
    }
  : runLegacyDataImport({
      userDataPath: app.getPath('userData'),
      homeDir: candidateRuntimePaths?.home ?? homedir(),
      log: (message, detail) => console.warn(`[workwise] ${message}`, detail ?? '')
    })
traceStartup('legacy data migration checked', {
  userDataPath: legacyMigration.userData.userDataPath,
  migratedUserData: legacyMigration.userData.migrated,
  importedHomeEntries: legacyMigration.home.filter((entry) => entry.outcome === 'imported').length
})

configureLinuxWaylandImeSwitches()

if (!runningClawScheduleMcpServer && process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

let mainWindow: BrowserWindow | null = null
let splashWindow: SplashWindowController | null = null
let splashOpenedAt = 0
let currentWindowAppearance: WindowAppearanceV1 = SOLID_WINDOW_APPEARANCE
let currentWindowDark = false
let store: JsonSettingsStore
let logDir = ''
let clawRuntime: ClawRuntime | null = null
let scheduleRuntime: ScheduleRuntime | null = null
let managedRuntimesStoppedForQuit = false
let appBehavior: AppBehaviorConfigV1 = normalizeAppBehaviorSettings()
let tray: Tray | null = null
let currentLocale: AppSettingsV1['locale'] = 'en'
let isQuitting = false
let candidateServiceReservations: Awaited<ReturnType<typeof reserveCandidateServicePorts>> | null = null
let gracefulShutdownPromise: Promise<void> | null = null
let imCredentialService: ImCredentialService | null = null
let imDeliveryLedger: ImDeliveryLedger | null = null
let imHealthService: ImHealthService | null = null
let imHealthTimer: ReturnType<typeof setInterval> | null = null

function gpuCompositingDisabled(): boolean {
  if (
    app.commandLine.hasSwitch('disable-gpu') ||
    app.commandLine.hasSwitch('disable-gpu-compositing') ||
    app.commandLine.hasSwitch('disable-software-rasterizer')
  ) {
    return true
  }
  try {
    return app.getGPUFeatureStatus().gpu_compositing !== 'enabled'
  } catch {
    return false
  }
}

function resolveCurrentWindowAppearance(): WindowAppearanceV1 {
  return resolveWindowAppearance({
    platform: process.platform,
    windowsBuild: process.platform === 'win32' ? parseWindowsBuild(osRelease()) : undefined,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    highContrast: nativeTheme.shouldUseHighContrastColors || nativeTheme.inForcedColorsMode,
    gpuDisabled: gpuCompositingDisabled(),
    remoteSession: isRemoteDesktopSession(process.env),
    forcedSolid: process.env.WORKWISE_DISABLE_TRANSPARENCY === '1'
  })
}

function refreshWindowAppearance(): void {
  const next = resolveCurrentWindowAppearance()
  const dark = nativeTheme.shouldUseDarkColors
  const appearanceChanged =
    next.material !== currentWindowAppearance.material ||
    next.transparencyEnabled !== currentWindowAppearance.transparencyEnabled ||
    next.reason !== currentWindowAppearance.reason
  if (!appearanceChanged && dark === currentWindowDark) return
  currentWindowAppearance = next
  currentWindowDark = dark
  refreshDockIcon()

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      applyWindowMaterial(mainWindow, process.platform, next, dark)
      if (appearanceChanged) mainWindow.webContents.send('window:appearance-changed', next)
    } catch (error) {
      logWarn('window-appearance', 'Failed to update the main window material.', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  try {
    splashWindow?.applyAppearance(next, dark)
  } catch (error) {
    logWarn('window-appearance', 'Failed to update the splash window material.', {
      message: error instanceof Error ? error.message : String(error)
    })
  }
}

type GuiUpdaterModule = typeof import('./gui-updater')

let guiUpdaterModulePromise: Promise<GuiUpdaterModule> | null = null
let guiUpdaterInitialized = false

function emitClawChannelActivity(payload: { channelId: string; threadId: string }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('claw:channel-activity', payload)
}

async function stopManagedRuntimesForQuit(): Promise<void> {
  if (managedRuntimesStoppedForQuit) return
  if (!gracefulShutdownPromise) {
    gracefulShutdownPromise = (async () => {
      await appCancellationRegistry.cancelAll('application_exit')
      if (imHealthTimer) {
        clearInterval(imHealthTimer)
        imHealthTimer = null
      }
      await stopAllRuntimeSse('application_exit')
      scheduleRuntime?.stop()
      await clawRuntime?.stop()
      await stopWeixinBridgeRuntime()
      stopCredentialHelperProcesses()
      await drainSerializedWrites()
      await imHealthService?.flush()
      imDeliveryLedger?.close()
      imDeliveryLedger = null
      await managedRuntimeAdapter.stopAndWait()
      await candidateServiceReservations?.close()
      candidateServiceReservations = null
    })()
  }
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  await Promise.race([gracefulShutdownPromise, timeout])
  managedRuntimesStoppedForQuit = true
}

async function loadGuiUpdaterModule(): Promise<GuiUpdaterModule> {
  if (!guiUpdaterModulePromise) {
    guiUpdaterModulePromise = import('./gui-updater')
      .then((module) => {
        if (!guiUpdaterInitialized) {
          module.initializeGuiUpdater(
            () => mainWindow,
            async () => (await store.load()).guiUpdate.channel,
            stopManagedRuntimesForQuit,
            showGuiUpdateAvailableNotification
          )
          guiUpdaterInitialized = true
        }
        return module
      })
      .catch((error) => {
        guiUpdaterModulePromise = null
        throw error
      })
  }
  return guiUpdaterModulePromise
}

async function readGuiUpdateState(): Promise<GuiUpdateState> {
  if (!guiUpdaterModulePromise) return { status: 'idle' }
  try {
    const module = await loadGuiUpdaterModule()
    return module.getGuiUpdateState()
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      code: 'unknown'
    }
  }
}


function installDevPreviewWebviewGuards(): void {
  app.on('web-contents-created', (_, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const src = typeof params.src === 'string' ? params.src : ''
      if (!isAllowedDevPreviewUrl(src)) {
        event.preventDefault()
        return
      }

      delete webPreferences.preload
      delete (webPreferences as { preloadURL?: string }).preloadURL
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      webPreferences.allowRunningInsecureContent = false
    })

    contents.on('will-navigate', (event, navigationUrl) => {
      if (contents.getType() !== 'webview') return
      if (!isAllowedDevPreviewUrl(navigationUrl)) event.preventDefault()
    })

    contents.setWindowOpenHandler(({ url }) => {
      if (contents.getType() !== 'webview') return { action: 'allow' }
      return isAllowedDevPreviewUrl(url) ? { action: 'allow' } : { action: 'deny' }
    })
  })
}


const appIcon = createAppIcon(workwiseLogoPng)
const dockIcon = createAppIcon(workwiseDockPng)
const dockDarkIcon = createAppIcon(workwiseDockDarkPng)
const lightIcon = createAppIcon(workwiseLightPng)
const trayIcon = createAppIcon(workwiseTrayPng)
const splashIcon = createAppIcon(workwiseSymbolPng)
function refreshDockIcon(): void {
  if (process.platform !== 'darwin') return
  const selected = nativeTheme.shouldUseDarkColors ? dockDarkIcon : dockIcon
  const fallback = nativeTheme.shouldUseDarkColors ? appIcon : lightIcon
  const icon = selected.isEmpty() ? fallback : selected
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}
traceStartup('app icon loaded', { source: workwiseLogoPng.startsWith('data:') ? 'data-url' : 'path' })
const guiUpdaterAcceptanceLaunch = isGuiUpdaterAcceptanceLaunch(process.argv, app.getPath('userData'))
const gotSingleInstanceLock = runningClawScheduleMcpServer ||
  runningImCredentialHelper ||
  guiUpdaterAcceptanceLaunch ||
  app.requestSingleInstanceLock()
traceStartup('single instance lock checked', {
  gotSingleInstanceLock,
  skippedForClawScheduleMcpServer: runningClawScheduleMcpServer,
  skippedForImCredentialHelper: runningImCredentialHelper,
  skippedForGuiUpdaterAcceptance: guiUpdaterAcceptanceLaunch
})

if (!gotSingleInstanceLock) app.quit()

function trayLabels(locale: AppSettingsV1['locale']): { show: string; quit: string; tooltip: string } {
  if (locale === 'zh') {
    return {
      show: `显示 ${brand.platform}`,
      quit: '退出',
      tooltip: brand.platform
    }
  }
  return {
    show: `Show ${brand.platform}`,
    quit: 'Quit',
    tooltip: brand.platform
  }
}

function shouldStartHidden(settings: AppSettingsV1): boolean {
  return (
    process.platform === 'win32' &&
    settings.appBehavior.openAtLogin &&
    settings.appBehavior.startMinimized &&
    process.argv.includes(HIDDEN_START_ARG)
  )
}

function syncLoginItemSettings(settings: AppSettingsV1): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  const behavior = settings.appBehavior
  try {
    app.setLoginItemSettings({
      openAtLogin: behavior.openAtLogin,
      args:
        process.platform === 'win32' && behavior.openAtLogin && behavior.startMinimized
          ? [HIDDEN_START_ARG]
          : []
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[workwise] failed to update login item settings:', error)
    logWarn('desktop-behavior', 'Failed to update login item settings.', { message })
  }
}

function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function sendApplicationMenuAction(action: ApplicationMenuAction): void {
  revealMainWindow()
  const contents = mainWindow?.webContents
  if (!contents || contents.isDestroyed()) return
  contents.send('app:menu-action', action)
}

function showAboutDialog(): void {
  const labels = applicationMenuLabels(currentLocale)
  const options: MessageBoxOptions = {
    type: 'info',
    title: labels.app.about,
    message: brand.platform,
    detail: currentLocale === 'zh'
      ? `智能工作台\n版本 ${app.getVersion()}`
      : `AI workbench\nVersion ${app.getVersion()}`,
    buttons: [currentLocale === 'zh' ? '好' : 'OK']
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    void dialog.showMessageBox(mainWindow, options)
  } else {
    void dialog.showMessageBox(options)
  }
}

function checkForUpdatesFromMenu(): void {
  sendApplicationMenuAction('check-updates')
  void loadGuiUpdaterModule()
    .then((module) => module.checkGuiUpdate())
    .catch((error) => {
      console.warn('[workwise updater] menu update check failed:', error)
    })
}

function showGuiUpdateAvailableNotification(info: Extract<GuiUpdateState, { status: 'available' }>['info']): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({
    title: currentLocale === 'zh' ? `${brand.platform} 有新版本` : `A ${brand.platform} update is available`,
    body: currentLocale === 'zh'
      ? `版本 ${info.latestVersion} 已发布，点击查看更新。`
      : `Version ${info.latestVersion} is available. Click to view the update.`,
    icon: appIcon.isEmpty() ? undefined : appIcon
  })
  notification.on('click', () => sendApplicationMenuAction('check-updates'))
  notification.show()
}

function syncApplicationMenu(settings: AppSettingsV1): void {
  currentLocale = settings.locale
  const template = buildApplicationMenuTemplate(settings.locale, process.platform, {
    send: sendApplicationMenuAction,
    openExternal: (url) => void shell.openExternal(url),
    checkForUpdates: checkForUpdatesFromMenu,
    showAbout: showAboutDialog,
    openLogs: () => void shell.openPath(resolveLogDirectory()),
    quit: () => {
      isQuitting = true
      app.quit()
    }
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function syncTray(settings: AppSettingsV1): void {
  appBehavior = settings.appBehavior
  if (!appBehavior.closeToTray) {
    if (tray) {
      tray.destroy()
      tray = null
    }
    return
  }

  if (!tray) {
    // Tray 优先用专门的托盘图(在 16x16/24x24 任务栏尺寸下更清晰的剪影);
    // 托盘图加载失败时回退到主应用图,这样不会看到 electron 默认占位。
    const traySource = pickTrayIcon(trayIcon, appIcon)
    tray = new Tray(traySource.isEmpty() ? nativeImage.createEmpty() : traySource)
    tray.on('click', revealMainWindow)
    tray.on('double-click', revealMainWindow)
  }

  const labels = trayLabels(settings.locale)
  tray.setToolTip(labels.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: revealMainWindow },
      { type: 'separator' },
      {
        label: labels.quit,
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

function normalizeNotificationText(raw: string | undefined, fallback: string, maxLength: number): string {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

type TurnCompleteNotificationPayload = {
  threadId?: string
  turnId?: string
  approvalId?: string
  reason?: 'completed' | 'error' | 'aborted' | 'blocked' | 'max_tokens' | 'waiting_approval'
  activeThread?: boolean
  title?: string
  body?: string
}

async function showTurnCompleteNotification(
  payload: TurnCompleteNotificationPayload
): Promise<{ ok: true; shown: boolean; reason?: string } | { ok: false; message: string }> {
  const settings = await store.load()
  const visibilityAwarePayload = {
    ...payload,
    activeThread: isActiveThreadActuallyVisible(mainWindow, payload.activeThread)
  }
  if (!shouldShowTerminalNotification(settings.notifications, visibilityAwarePayload)) {
    return { ok: true, shown: false, reason: 'filtered' }
  }
  if (!Notification.isSupported()) {
    return { ok: true, shown: false, reason: 'unsupported' }
  }

  const title = normalizeNotificationText(payload.title, `${brand.platform} Runtime`, 80)
  const body = normalizeNotificationText(payload.body, settings.locale === 'zh' ? '会话已完成。' : 'Conversation complete.', 180)

  try {
    const notification = new Notification({
      title,
      body,
      icon: appIcon.isEmpty() ? undefined : appIcon
    })
    notification.on('click', createNotificationClickHandler(() => mainWindow, revealMainWindow, payload.threadId))
    notification.show()
    return { ok: true, shown: true }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logError('notification', 'Failed to show turn completion notification', {
      message,
      threadId: payload.threadId
    })
    return { ok: false, message }
  }
}

async function probeThreadApi(settings: AppSettingsV1): Promise<
  | { ok: true }
  | { ok: false; error: string; message: string }
> {
  const base = getRuntimeBaseUrlForSettings(settings)
  const headers = runtimeAuthHeaders(settings)
  headers.set('Accept', 'application/json')

  try {
    const res = await fetch(`${base}/v1/threads?limit=1`, {
      headers,
      signal: AbortSignal.timeout(2_000)
    })
    if (res.ok) return { ok: true }
    const info = parseRuntimeErrorBody(
      await res.text(),
      'The local runtime returned an unexpected error.'
    )
    if (res.status === 401 && /bearer token required/i.test(info.message)) {
      return {
        ok: false,
        error: 'runtime_auth_required',
        message: 'The local runtime requires a bearer token for thread APIs.'
      }
    }
    return {
      ok: false,
      error: info.code === 'unknown' ? 'runtime_request_failed' : info.code,
      message: info.message
    }
  } catch (e) {
    return {
      ok: false,
      error: 'fetch_failed',
      message: e instanceof Error ? e.message : String(e)
    }
  }
}

async function waitForRuntimeHealth(settings: AppSettingsV1, timeoutMs: number): Promise<boolean> {
  const base = getRuntimeBaseUrlForSettings(settings)
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now())
      const res = await fetch(`${base}/health`, {
        headers: runtimeAuthHeaders(settings),
        signal: AbortSignal.timeout(Math.max(250, Math.min(1_000, remaining)))
      })
      if (res.ok && isRuntimeHealthResponseBody(await res.text())) return true
    } catch {
      /* retry until the deadline */
    }
    await sleep(150)
  }

  return false
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

let runtimeEnsurePromise: Promise<void> | null = null
let runtimeEnsureFingerprint: string | null = null
let runtimeSettingsApplyPromise: Promise<void> | null = null
let lastAppliedSettings: AppSettingsV1 | null = null

function queueRuntimeSettingsApply(prev: AppSettingsV1, next: AppSettingsV1): void {
  // Always update the prev/next anchor so a later task diffs against
  // the settings that were actually applied last, not against the
  // original `prev` captured when this call was queued.
  const anchor = lastAppliedSettings ?? prev
  lastAppliedSettings = next
  const startupConfigChanged = runtimeStartupConfigChanged(anchor, next)
  if (!startupConfigChanged) return

  const previousTask = runtimeSettingsApplyPromise ?? Promise.resolve()
  const task = previousTask
    .catch(() => undefined)
    .then(async () => {
      const current = lastAppliedSettings ?? next
      await restartManagedRuntimeForSettingsChange(anchor, current)
    })
    .catch((error: unknown) => {
      logWarn('settings-apply', 'Failed to apply WorkWise Runtime runtime settings in background', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    .finally(() => {
      if (runtimeSettingsApplyPromise === task) {
        runtimeSettingsApplyPromise = null
      }
    })

  runtimeSettingsApplyPromise = task
}

function queueRuntimeMcpConfigApply(settings: AppSettingsV1): void {
  lastAppliedSettings = settings

  const previousTask = runtimeSettingsApplyPromise ?? Promise.resolve()
  const task = previousTask
    .catch(() => undefined)
    .then(async () => {
      const current = lastAppliedSettings ?? settings
      await restartManagedRuntimeForMcpConfigChange(current)
    })
    .catch((error: unknown) => {
      logWarn('mcp-config', 'Failed to apply WorkWise Runtime MCP config change in background', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    .finally(() => {
      if (runtimeSettingsApplyPromise === task) {
        runtimeSettingsApplyPromise = null
      }
    })

  runtimeSettingsApplyPromise = task
}

async function waitForQueuedRuntimeSettingsApply(): Promise<void> {
  if (!runtimeSettingsApplyPromise) return
  await runtimeSettingsApplyPromise
}

/**
 * Build a stable fingerprint of the settings that affect the
 * WorkWise Runtime runtime so that `ensureRuntime` can debounce on real
 * state instead of on a single in-flight promise. Without this,
 * a fresh call that arrives while a failing ensure is still pending
 * would re-throw the old error.
 */
function runtimeFingerprint(settings: AppSettingsV1): string {
  return stableSettingsStringify(resolveManagedRuntimeSettings(settings))
}

async function ensureRuntime(settings: AppSettingsV1): Promise<void> {
  const fingerprint = runtimeFingerprint(settings)
  const pending = runtimeEnsurePromise
  if (pending) {
    // Wait for the in-flight ensure, then re-evaluate against the
    // fingerprint so callers don't inherit a stale result.
    try {
      await pending
    } catch {
      /* fall through to retry with the current settings */
    }
    if (runtimeEnsureFingerprint === fingerprint) return
  }
  const task = ensureRuntimeOnce(settings)
  const trackedTask = task.finally(() => {
    if (runtimeEnsurePromise === trackedTask) {
      runtimeEnsurePromise = null
      runtimeEnsureFingerprint = null
    }
  })
  runtimeEnsurePromise = trackedTask
  runtimeEnsureFingerprint = fingerprint
  return await trackedTask
}

async function ensureRuntimeOnce(settings: AppSettingsV1): Promise<void> {
  await waitForQueuedRuntimeSettingsApply()
  await ensureManagedRuntime(settings)
}

async function ensureManagedRuntime(settings: AppSettingsV1): Promise<void> {
  const runtime = getManagedRuntimeSettings(settings)

  const healthy = await waitForRuntimeHealth(settings, 2_000)
  if (healthy) {
    const threadApi = await probeThreadApi(settings)
    if (threadApi.ok) return
    throw runtimeJsonError(threadApi.error, threadApi.message)
  }

  // Local deterministic tools use Runtime authentication, not a model provider key.
  if (!runtime.autoStart) {
    throw runtimeJsonError(
      'runtime_offline',
      settings.locale === 'zh'
        ? `${brand.platform} Runtime 未连接。请在设置中启用自动启动，或手动启动内置 Runtime。`
        : `${brand.platform} Runtime is offline. Enable automatic startup in Settings, or start the bundled runtime manually.`
    )
  }

  const adapter = managedRuntimeAdapter
  const reclaim = await adapter.reclaimPort(runtime.port)
  if (!reclaim.ok) {
    throw runtimeJsonError('runtime_port_conflict', reclaim.message)
  }
  try {
    await adapter.ensureRunning(settings)
  } catch (e) {
    console.error('[workwise] failed to start runtime:', e)
    throw e
  }
  const started = await waitForRuntimeHealth(settings, 20_000)
  if (!started) {
    throw runtimeJsonError(
      'runtime_unhealthy',
      'WorkWise Runtime did not become healthy after launch.'
    )
  }

  const threadApi = await probeThreadApi(settings)
  if (!threadApi.ok) {
    throw runtimeJsonError(threadApi.error, threadApi.message)
  }
}

function createWindow(options: { suppressInitialShow?: boolean } = {}): void {
  traceStartup('createWindow:start')
  const preloadPath = resolvePreloadPath()
  const usesDesktopTitleBar = process.platform === 'win32' || process.platform === 'linux'
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    icon: appIcon.isEmpty() ? undefined : appIcon,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : usesDesktopTitleBar ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 31, y: 22 } : undefined,
    autoHideMenuBar: usesDesktopTitleBar,
    show: false,
    ...windowMaterialOptions(currentWindowAppearance, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
      additionalArguments: [
        ...windowAppearanceArguments(currentWindowAppearance),
        windowLocaleArgument(currentLocale)
      ]
    }
  })
  if (usesDesktopTitleBar) {
    mainWindow.setMenu(null)
    mainWindow.setMenuBarVisibility(false)
  }
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[workwise] failed to load preload ${preloadPath}:`, error)
    logError('preload', 'Failed to load preload script', { preloadPath, message })
  })
  const windowCancellation = appCancellationRegistry.register(
    { scope: 'window', id: String(mainWindow.webContents.id) },
    { parent: { scope: 'app', id: 'app' } }
  )
  const windowCancellationId = String(mainWindow.webContents.id)
  let deferredShowTimer: ReturnType<typeof setTimeout> | null = null
  const showWindow = (): void => {
    if (options.suppressInitialShow) {
      splashWindow?.close()
      splashWindow = null
      splashOpenedAt = 0
      return
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    const remainingSplashMs = splashWindow
      ? splashRemainingVisibleMs(splashOpenedAt, Date.now())
      : 0
    if (remainingSplashMs > 0) {
      if (!deferredShowTimer) {
        deferredShowTimer = setTimeout(() => {
          deferredShowTimer = null
          showWindow()
        }, remainingSplashMs)
      }
      return
    }
    splashWindow?.update({
      progress: 1,
      label: splashProgressLabel(currentLocale, 'ready')
    })
    mainWindow.show()
    splashWindow?.close()
    splashWindow = null
    splashOpenedAt = 0
  }
  mainWindow.on('close', (event) => {
    if (
      isQuitting ||
      !shouldCloseMainWindowToTray(appBehavior.closeToTray, Boolean(candidateRuntimePaths))
    ) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    if (deferredShowTimer) clearTimeout(deferredShowTimer)
    void appCancellationRegistry.cancel(
      { scope: 'window', id: windowCancellationId },
      'window_destroyed'
    )
    windowCancellation.release()
    mainWindow = null
  })
  const devUrl = devServerHintUrl()
  traceStartup('createWindow:load', { devUrl: devUrl ?? 'file' })
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  mainWindow.once('ready-to-show', () => {
    traceStartup('window:ready-to-show')
    showWindow()
  })
  mainWindow.webContents.once('did-finish-load', () => {
    traceStartup('window:did-finish-load')
    showWindow()
  })
  setTimeout(() => {
    traceStartup('window:fallback-show-timeout')
    showWindow()
  }, 1500)
}

/**
 * Stable equality for the WorkWise Runtime runtime settings. Most fields are flat,
 * but GUI-managed capability options can be nested, so compare values
 * structurally while still surviving future field additions.
 */
function managedRuntimeConfigChanged(prev: AppSettingsV1, next: AppSettingsV1): boolean {
  if (!stableSettingsValueEqual(prev.provider, next.provider)) return true
  const a = resolveManagedRuntimeSettings(prev)
  const b = resolveManagedRuntimeSettings(next)
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as Array<keyof typeof a>)
  for (const key of keys) {
    if (!stableSettingsValueEqual(a[key], b[key])) return true
  }
  return false
}

function stableSettingsValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return stableSettingsStringify(a) === stableSettingsStringify(b)
}

function stableSettingsStringify(value: unknown): string {
  return JSON.stringify(canonicalSettingsValue(value))
}

function canonicalSettingsValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSettingsValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonicalSettingsValue((value as Record<string, unknown>)[key])
  }
  return out
}

function runtimeStartupConfigChanged(prev: AppSettingsV1, next: AppSettingsV1): boolean {
  return managedRuntimeConfigChanged(prev, next) || clawScheduleMcpSettingsChanged(prev, next)
}

/**
 * Settings writes that do not touch IM configuration must not wake protected
 * credential storage. Reconnecting an IM channel remains the explicit path
 * that is allowed to authorize Keychain access.
 */
function imConnectionConfigChanged(prev: AppSettingsV1, next: AppSettingsV1): boolean {
  return !stableSettingsValueEqual(prev.claw, next.claw)
}

async function restartManagedRuntimeForSettingsChange(
  prev: AppSettingsV1,
  next: AppSettingsV1
): Promise<void> {
  if (!runtimeStartupConfigChanged(prev, next)) return

  const runtime = resolveManagedRuntimeSettings(next)
  const adapter = managedRuntimeAdapter
  const wasRunning = adapter.isChildRunning()

  if (!wasRunning) return
  if (wasRunning) {
    await waitForManagedRuntimeReadyBeforeStop(prev, 'settings-apply')
    await adapter.stopAndWait()
  }
  if (!runtime.autoStart) return

  try {
    await adapter.ensureRunning(next)
    const healthy = await waitForRuntimeHealth(next, 20_000)
    if (!healthy) {
      console.warn('[workwise] WorkWise Runtime restart did not become healthy after settings change')
    }
  } catch (e) {
    console.warn('[workwise] WorkWise Runtime restart failed after settings change:', e)
  }
}

async function restartManagedRuntimeForMcpConfigChange(settings: AppSettingsV1): Promise<void> {
  const runtime = resolveManagedRuntimeSettings(settings)
  const adapter = managedRuntimeAdapter
  const wasRunning = adapter.isChildRunning()

  if (!wasRunning) return
  await waitForManagedRuntimeReadyBeforeStop(settings, 'mcp-config')
  await adapter.stopAndWait()
  if (!runtime.autoStart) return

  try {
    await adapter.ensureRunning(settings)
    const healthy = await waitForRuntimeHealth(settings, 20_000)
    if (!healthy) {
      console.warn('[workwise] WorkWise Runtime restart did not become healthy after MCP config change')
    }
  } catch (e) {
    console.warn('[workwise] WorkWise Runtime restart failed after MCP config change:', e)
  }
}

async function waitForManagedRuntimeReadyBeforeStop(
  settings: AppSettingsV1,
  source: string
): Promise<void> {
  const healthy = await waitForRuntimeHealth(settings, 20_000)
  if (!healthy) {
    logWarn(source, 'WorkWise Runtime did not become healthy before a managed restart; stopping it anyway')
    return
  }
  const idle = await waitForRuntimeTurnsIdle({ settings })
  if (idle === 'timeout') {
    logWarn(source, 'WorkWise Runtime still has running turns after waiting; stopping it anyway')
  } else if (idle === 'unavailable') {
    logWarn(source, 'Could not verify WorkWise Runtime turn idleness before a managed restart; stopping it anyway')
  }
}

async function runtimeRequest(
  settings: AppSettingsV1,
  pathAndQuery: string,
  init: { method?: string; body?: BodyInit; headers?: Record<string, string> }
): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    return await runtimeRequestViaHost(settings, pathAndQuery, init, ensureRuntime)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logError('runtime-request', `HTTP request to ${pathAndQuery} failed`, { message })
    const parsed = parseRuntimeErrorBody(message, message)
    if (parsed.code !== 'unknown' || parsed.message !== message) {
      return runtimeFailure(parsed.code, parsed.message, 0, parsed.details)
    }
    return runtimeFailure('fetch_failed', message)
  }
}

if (unconfiguredRecoveryCandidate) {
  console.error(`[workwise candidate] ${candidateLaunchConfigurationError || 'Refusing to start without an isolated candidate environment.'}`)
  process.exit(UNCONFIGURED_RECOVERY_CANDIDATE_EXIT_CODE)
} else if (runningImCredentialHelper) {
  void runImCredentialHelperProcess()
} else if (runningClawScheduleMcpServer) {
  void runClawScheduleMcpServerFromArgv(process.argv).catch((error) => {
    console.error('[claw-schedule-mcp] server failed:', error)
    process.exit(1)
  })
} else {
app.whenReady().then(async () => {
  traceStartup('app.whenReady:start')
  if (!gotSingleInstanceLock) return

  const preparedUpdaterAcceptance = await prepareGuiUpdaterAcceptance({
    argv: process.argv,
    userDataPath: app.getPath('userData'),
    currentVersion: app.getVersion()
  })
  if (preparedUpdaterAcceptance?.kind === 'terminal') {
    console.info('[workwise updater acceptance] terminal report written:', preparedUpdaterAcceptance.reportPath)
    app.quit()
    return
  }
  const updaterAcceptance: ActiveGuiUpdaterAcceptance | null = preparedUpdaterAcceptance
  if (updaterAcceptance) configureGuiUpdaterAcceptance(updaterAcceptance)

  traceStartup('install webview guards:start')
  installDevPreviewWebviewGuards()
  traceStartup('install webview guards:done')

  refreshDockIcon()

  store = new JsonSettingsStore(app.getPath('userData'), {
    workwiseHome: candidateRuntimePaths?.workwiseHome
  })
  traceStartup('settings load:start')
  let initial = await store.load()
  if (candidateRuntimePaths) {
    candidateServiceReservations = await reserveCandidateServicePorts()
    initial = await store.patch(candidateServicePortPatch(candidateServiceReservations.ports))
    traceStartup('candidate service ports isolated', candidateServiceReservations.ports)
  }
  imCredentialService = new ImCredentialService({
    root: join(app.getPath('userData'), 'communication', 'credentials')
  })
  configureWeixinBridgeCredentialProvider(imCredentialService)
  imDeliveryLedger = new ImDeliveryLedger(join(app.getPath('userData'), 'communication', 'messages.sqlite3'))
  imHealthService = new ImHealthService()
  await imHealthService.load()
  // Do not migrate legacy IM secrets during startup. On macOS this would
  // access the user's Keychain before they explicitly asked to reconnect and
  // show a system permission dialog on every cold start. The main-process
  // settings object keeps the legacy value private, while the existing
  // start/reconnect IPC path performs the durable migration on demand.
  traceStartup('settings load:done')
  appBehavior = initial.appBehavior
  syncApplicationMenu(initial)
  syncLoginItemSettings(initial)
  syncTray(initial)
  currentWindowAppearance = resolveCurrentWindowAppearance()
  currentWindowDark = nativeTheme.shouldUseDarkColors
  const suppressInitialShow = shouldStartHidden(initial)
  if (!suppressInitialShow) {
    splashOpenedAt = Date.now()
    splashWindow = createSplashWindow({
      appearance: currentWindowAppearance,
      dark: currentWindowDark,
      version: app.getVersion(),
      locale: initial.locale,
      logoDataUrl: splashIcon.isEmpty() ? undefined : splashIcon.toDataURL()
    })
  }
  nativeTheme.on('updated', refreshWindowAppearance)
  await syncClawScheduleMcpConfig(
    initial,
    getClawScheduleMcpLaunchConfig(),
    clawScheduleMcpConfigPaths()
  ).catch((error) => {
    console.error('[claw-schedule-mcp] failed to sync config on startup:', error)
  })
  splashWindow?.update({
    progress: 0.34,
    label: splashProgressLabel(initial.locale, 'services')
  })

  logDir = resolveLogDirectory()
  configureLogger({
    dir: logDir,
    enabled: initial.log.enabled,
    retentionDays: initial.log.retentionDays
  })
  traceStartup('logger configured')
  initial = await migrateSchedulesToFlows({
    settings: initial,
    request: (settings, path, init) => runtimeRequest(settings, path, init),
    patchSettings: (patch) => store!.patch(patch),
    logError
  })
  scheduleRuntime = createScheduleRuntime({
    store,
    runtimeRequest,
    logError,
    powerSaveBlocker,
    internalServer: candidateServiceReservations?.scheduleServer
  })
  scheduleRuntime.sync(initial)
  clawRuntime = createClawRuntime({
    store,
    runtimeRequest,
    logError,
    notifyChannelActivity: emitClawChannelActivity,
    sendWeixinBridgeMessage,
    resolveWeixinAccountUserId: getWeixinBridgeAccountUserId,
    getWeixinBridgeAccountStatuses,
    startWeixinBridgeAccount,
    stopWeixinBridgeAccount,
    reconnectWeixinBridgeAccount,
    disconnectWeixinBridgeAccount,
    imLedger: imDeliveryLedger,
    imHealth: imHealthService,
    imMaxConcurrency: 4,
    resolveImCredential: async (channel) => {
      if (channel.credentialRef && imCredentialService) {
        const resolved = await imCredentialService.resolve(channel.credentialRef)
        if (resolved) return resolved
      }
      // Deprecated plaintext platform credentials are intentionally never a
      // runtime fallback. They remain in the main-process settings only so an
      // explicit reconnect can retry durable migration.
      return undefined
    },
    createScheduledTaskFromText: (text, options) =>
      scheduleRuntime?.createScheduledTaskFromText(text, options) ?? Promise.resolve({ kind: 'noop' }),
    webhookServer: candidateServiceReservations?.imServer
  })
  traceStartup('claw runtime sync:start', {
    clawEnabled: initial.claw.enabled,
    imEnabled: initial.claw.im.enabled,
    enabledChannels: initial.claw.channels.filter((channel) => channel.enabled).length
  })
  clawRuntime.sync(initial, { deferProtectedCredentialAccess: true })
  traceStartup('claw runtime sync:scheduled')
  imHealthService.onChange((health) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('claw:im:health-changed', health)
  })
  const refreshUnifiedImHealth = async (): Promise<void> => {
    if (!imHealthService) return
    await clawRuntime?.recoverPendingMessages()
    const settings = await store.load()
    clawRuntime?.refreshChannelHealth(settings)
    for (const channel of settings.claw.channels.filter((item) => item.enabled)) {
      const credential = channel.platformCredential
      const accountId = credential?.kind === 'weixin'
        ? credential.accountId
        : credential?.kind === 'feishu'
          ? credential.appId
          : channel.id
      if (!imHealthService.get(channel.id)) {
        imHealthService.start({ channelId: channel.id, provider: channel.provider, accountId, credentialStorage: channel.credentialRef?.storage })
      }
      if (channel.provider !== 'weixin') continue
      const status = (await getWeixinBridgeAccountStatuses(accountId))[0]
      if (!status) continue
      if (status.status === 'starting') {
        const current = imHealthService.get(channel.id)
        if (current?.status !== 'starting' || (status.runId && current.runId !== status.runId)) {
          imHealthService.start({
            channelId: channel.id,
            provider: channel.provider,
            accountId,
            credentialStorage: channel.credentialRef?.storage,
            runId: status.runId,
            startedAt: status.startedAt,
            message: status.message || '正在连接微信。'
          })
        }
      } else if (status.status === 'connected') imHealthService.heartbeat(channel.id, status.message || '微信连接正常。')
      else if (status.status === 'expired') imHealthService.fail(channel.id, { reasonCode: 'auth_expired', message: status.message || '微信连接已过期。', errorCode: status.errorCode, expired: true })
      else if (status.status === 'stale') imHealthService.markStale(channel.id, {
        reasonCode: status.reasonCode === 'first_poll_timeout' ? 'first_poll_timeout' : 'poll_stale',
        message: status.message || '微信连接心跳已超时。',
        errorCode: status.errorCode
      })
      else if (status.status === 'retrying' || status.status === 'error') imHealthService.fail(channel.id, {
        reasonCode: status.reasonCode === 'credential_missing'
          ? 'credential_missing'
          : status.reasonCode === 'credential_unavailable'
            ? 'credential_unavailable'
            : 'network',
        message: status.message || '微信连接异常。',
        errorCode: status.errorCode
      })
      else if (status.status === 'stopped') imHealthService.stop(channel.id, status.message || '微信连接已暂停。')
    }
    imHealthService.supervise((health) => {
      // A cold-start credential deferral is intentionally terminal until the
      // user asks to reconnect. Retrying it here would wake the Keychain
      // helper again and recreate the macOS authorization popup that startup
      // is specifically designed to avoid.
      if (shouldAutoRecoverFeishuHealth(health)) {
        if (!isCandidateImProviderConnectionAllowed('feishu')) return
        void (async () => {
          await clawRuntime?.reconnectChannel(health.channelId)
        })().catch((error) => logWarn('im-health', 'Failed to reconnect unhealthy Feishu channel.', { message: error instanceof Error ? error.message : String(error) }))
      }
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send('claw:im:health-changed', health)
    })
  }
  void refreshUnifiedImHealth()
  imHealthTimer = setInterval(() => void refreshUnifiedImHealth().catch((error) => logWarn('im-health', 'Failed to refresh IM health.', { message: error instanceof Error ? error.message : String(error) })), IM_HEALTH_SUPERVISOR_INTERVAL_MS)
  imHealthTimer.unref?.()
  configureWeixinBridgeRuntimeContextProvider(async () => {
    const settings = await store.load()
    const channel = settings.claw.channels.find((item) => item.enabled && item.provider === 'weixin')
    return {
      webhookUrl: webhookUrl(settings),
      webhookSecret: settings.claw.im.secret,
      channelId: channel?.id ?? ''
    }
  })
  configureManagedWeixinBridgeUrlResolver(ensureWeixinBridgeRpcUrl)
  syncWeixinBridgeRuntime(initial)
  splashWindow?.update({
    progress: 0.58,
    label: splashProgressLabel(initial.locale, 'extensions')
  })

  traceStartup('ipc registration:start')
  const applySettingsPatch = async (
    partial: AppSettingsPatch,
    expectedRevision?: number
  ): Promise<AppSettingsV1> => applySettingsApplicationTransaction({
    store,
    credentialService: imCredentialService ?? undefined,
    partial,
    expectedRevision,
    afterPersist: async (prev, saved) => {
      if (prev.log.enabled !== saved.log.enabled || prev.log.retentionDays !== saved.log.retentionDays) {
        configureLogger({ enabled: saved.log.enabled, retentionDays: saved.log.retentionDays })
      }
      await syncClawScheduleMcpConfig(
        saved,
        getClawScheduleMcpLaunchConfig(),
        clawScheduleMcpConfigPaths()
      ).catch((error) => {
        console.error('[claw-schedule-mcp] failed to sync config after settings change:', error)
      })
      if (prev.guiUpdate.channel !== saved.guiUpdate.channel && guiUpdaterModulePromise) {
        void guiUpdaterModulePromise.then((module) => module.setGuiUpdateChannel(saved.guiUpdate.channel))
      }
      queueRuntimeSettingsApply(prev, saved)
      scheduleRuntime?.sync(saved)
      clawRuntime?.sync(saved, {
        deferProtectedCredentialAccess: !imConnectionConfigChanged(prev, saved)
      })
      syncWeixinBridgeRuntime(saved)
      syncLoginItemSettings(saved)
      syncApplicationMenu(saved)
      syncTray(saved)
    }
  })

  const fetchModels = async () => {
    const settings = await store.load()
    const key = resolveConfiguredApiKey(settings)
    return fetchUpstreamModelIds(settings, key)
  }

  registerAppIpcHandlers({
    store,
    getMainWindow: () => mainWindow,
    applySettingsPatch,
    runtimeRequest: async (path, method, body) => {
      const settings = await store.load()
      return runtimeRequest(settings, path, { method, body })
    },
    runtimeFileRequest: async (path, filePath, headers) => {
      const settings = await store.load()
      const blob = await openAsBlob(filePath)
      return runtimeRequest(settings, path, { method: 'POST', body: blob, headers: { ...headers, 'Content-Length': String(blob.size) } })
    },
    fetchUpstreamModels: fetchModels,
    getClawRuntime: () => clawRuntime,
    getScheduleRuntime: () => scheduleRuntime,
    startFeishuInstallQrcode,
    pollFeishuInstall,
    startWeixinInstallQrcode,
    pollWeixinInstall,
    getWeixinBridgeAccountStatuses,
    isWeixinBridgeAccountConfigured,
    getImHealthService: () => imHealthService,
    getImCredentialService: () => imCredentialService,
    getImDeliveryLedger: () => imDeliveryLedger,
    getUserDataPath: () => app.getPath('userData'),
    resolveRuntimeConfigPath: () =>
      candidateRuntimePaths
        ? join(candidateRuntimePaths.workwiseHome, 'mcp.json')
        : resolveRuntimeMcpJsonPath(),
    onRuntimeMcpConfigWritten: async () => {
      const settings = await store.load()
      queueRuntimeMcpConfigApply(settings)
    },
    showTurnCompleteNotification,
    getAppVersion: () => app.getVersion(),
    readGuiUpdateState,
    loadGuiUpdaterModule,
    resolveLogDirectory,
    logError
  })

  void loadGuiUpdaterModule()
    .then(async (module) => {
      if (updaterAcceptance) await runGuiUpdaterAcceptance(updaterAcceptance, module)
    })
    .catch(async (error) => {
      console.warn('[workwise updater] failed to initialize on startup:', error)
      if (updaterAcceptance) await failGuiUpdaterAcceptance(updaterAcceptance, error)
    })

  registerRuntimeSseIpc({ ipcMain, store, ensureRuntime, logError })
  traceStartup('ipc registration:done')
  splashWindow?.update({
    progress: 0.82,
    label: splashProgressLabel(initial.locale, 'interface')
  })

  if (candidateHeadless) {
    traceStartup('candidate headless diagnostics enabled')
    if (candidateRuntimeProbe) {
      traceStartup('candidate Runtime probe:start')
      await runCandidateRuntimeProbe({
        ensureRuntime: () => ensureRuntime(initial),
        verifyServices: async () => {
          const runtimePort = getManagedRuntimeActualPort()
          if (!runtimePort) throw new Error('Candidate Runtime did not expose an actual listening port.')
          return verifyCandidateServiceListeners({
            runtime: runtimePort,
            schedule: initial.schedule.internal.port,
            im: initial.claw.im.port
          })
        },
        reportReady: (ports) => {
          console.info('[workwise candidate runtime probe]', JSON.stringify({
            ok: true,
            ports,
            authenticatedThreadApi: true
          }))
          traceStartup('candidate Runtime probe:ready')
        },
        stop: stopManagedRuntimesForQuit,
        exit: (code) => app.exit(code)
      })
      return
    }
  } else {
    createWindow({ suppressInitialShow })
    traceStartup('createWindow:returned')
  }

  void pruneOnStartup().catch((err) => {
    console.warn('[workwise] prune logs:', err)
  })

  if (resolveConfiguredApiKey(initial)) {
    setTimeout(() => {
      void managedRuntimeAdapter.resolveExecutable(initial).catch((err) => {
        console.warn('[workwise] prewarm WorkWise Runtime binary:', err)
      })
    }, 1500)
  }

  app.on('second-instance', () => {
    revealMainWindow()
  })

  app.on('activate', () => {
    if (candidateHeadless) return
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else revealMainWindow()
  })
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error('[workwise] startup failed:', error)
  splashWindow?.close()
  splashWindow = null
  if (!shouldShowStartupErrorDialog(candidateHeadless)) {
    isQuitting = true
    void stopManagedRuntimesForQuit()
      .catch((stopError) => {
        console.warn('[workwise] failed to clean up after headless startup failure:', stopError)
      })
      .finally(() => app.exit(1))
    return
  }
  dialog.showErrorBox('WorkWise Runtime failed to start', message)
  app.quit()
})
}

if (!runningImCredentialHelper) {
  app.on('window-all-closed', () => {
    if (!shouldStopServicesWhenAllWindowsClose(process.platform, Boolean(candidateRuntimePaths))) return
    isQuitting = true
    void stopManagedRuntimesForQuit()
      .catch((error) => {
        console.warn('[workwise] failed to stop WorkWise Runtime runtime:', error)
        managedRuntimesStoppedForQuit = true
      })
      .finally(() => app.quit())
  })

  app.on('before-quit', (event) => {
    isQuitting = true
    if (managedRuntimesStoppedForQuit) return
    event.preventDefault()
    void stopManagedRuntimesForQuit()
      .catch((error) => {
        console.warn('[workwise] failed to stop WorkWise Runtime runtime:', error)
        managedRuntimesStoppedForQuit = true
      })
      .finally(() => {
        app.quit()
      })
  })
}
