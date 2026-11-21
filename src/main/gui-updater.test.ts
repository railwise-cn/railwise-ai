import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockUpdater = EventEmitter & {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  forceDevUpdateConfig: boolean
  logger: unknown
  requestHeaders: Record<string, string> | null
  setFeedURL: ReturnType<typeof vi.fn>
  checkForUpdates: ReturnType<typeof vi.fn>
  downloadUpdate: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
  startVerifiedInstaller: ReturnType<typeof vi.fn>
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let updater: MockUpdater
let nativeUpdater: EventEmitter
const quitApp = vi.fn()
class WindowsUpdateCacheError extends Error {}

function createUpdater(): MockUpdater {
  return Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    forceDevUpdateConfig: false,
    logger: null,
    requestHeaders: null,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    startVerifiedInstaller: vi.fn()
  })
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  vi.useFakeTimers()
  vi.resetModules()
  updater = createUpdater()
  nativeUpdater = new EventEmitter()
  quitApp.mockReset()
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getAppPath: () => '/tmp/workwise-updater-test-app',
      getPath: () => '/tmp/workwise-updater-test-user-data',
      getVersion: () => '0.1.0',
      quit: quitApp
    },
    autoUpdater: nativeUpdater,
    BrowserWindow: class {}
  }))
  vi.doMock('electron-updater', () => ({
    default: { autoUpdater: updater },
    autoUpdater: updater
  }))
  vi.doMock('./windows-gui-update', () => ({
    WindowsUpdateCacheError,
    WindowsGuiUpdater: class { constructor() { return updater } }
  }))
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  delete process.env.WORKWISE_WITHDRAWN_STABLE_VERSIONS
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('electron')
  vi.doUnmock('electron-updater')
  vi.doUnmock('./windows-gui-update')
  vi.resetModules()
})

describe('installGuiUpdate', () => {
  it('waits for managed runtime cleanup before asking the updater to quit and install', async () => {
    const module = await import('./gui-updater')
    let finishCleanup = (): void => {
      throw new Error('cleanup resolver was not set')
    }
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => {
      finishCleanup = resolve
    }))

    module.initializeGuiUpdater(() => null, () => 'stable', beforeInstall)
    updater.emit('update-downloaded', { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' })

    const installing = module.installGuiUpdate()
    await Promise.resolve()
    await Promise.resolve()

    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    finishCleanup()
    await expect(installing).resolves.toEqual({ ok: true })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('reuses the same cleanup when the native updater emits before-quit-for-update', async () => {
    const module = await import('./gui-updater')
    let finishCleanup = (): void => {
      throw new Error('cleanup resolver was not set')
    }
    const beforeInstall = vi.fn(() => new Promise<void>((resolve) => {
      finishCleanup = resolve
    }))

    const willQuit = vi.fn()
    module.initializeGuiUpdater(() => null, () => 'stable', beforeInstall, undefined, undefined, willQuit)
    updater.emit('update-downloaded', { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' })

    nativeUpdater.emit('before-quit-for-update')
    expect(willQuit).toHaveBeenCalledOnce()
    const installing = module.installGuiUpdate()
    await Promise.resolve()

    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    finishCleanup()
    await expect(installing).resolves.toEqual({ ok: true })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('retains the verified download after shutdown failure and coalesces install retries', async () => {
    const module = await import('./gui-updater')
    const cleanup = vi.fn().mockRejectedValueOnce(new Error('shutdown timed out')).mockResolvedValue(undefined)
    module.initializeGuiUpdater(() => null, () => 'stable', cleanup)
    updater.emit('update-downloaded', { version: '0.2.0' })
    await expect(module.installGuiUpdate()).resolves.toMatchObject({ ok: false, message: 'shutdown timed out' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await Promise.all([module.installGuiUpdate(), module.installGuiUpdate()])
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('unfences after a delayed Squirrel install error, removes only failed-attempt listeners, and retries with a new cleanup', async () => {
    const module = await import('./gui-updater')
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const resume = vi.fn().mockResolvedValue(undefined)
    const persistentListener = vi.fn()
    const installerListener = vi.fn()
    nativeUpdater.on('update-downloaded', persistentListener)
    updater.quitAndInstall.mockImplementationOnce(() => nativeUpdater.on('update-downloaded', installerListener))
    module.initializeGuiUpdater(() => null, () => 'stable', cleanup, undefined, resume)
    updater.emit('update-downloaded', { version: '0.2.0' })
    await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
    expect(resume).not.toHaveBeenCalled()
    updater.emit('error', new Error('Squirrel refused to install'))
    updater.emit('error', new Error('Repeated native error'))
    await expect(module.installGuiUpdate()).resolves.toMatchObject({ ok: false, code: 'install_failed', message: 'Squirrel refused to install' })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(nativeUpdater.listeners('update-downloaded')).toEqual([persistentListener])
    expect(module.getGuiUpdateState()).toMatchObject({ status: 'error', code: 'install_failed' })
    await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(2)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('restores the Runtime when handing off to the installer throws synchronously', async () => {
    const module = await import('./gui-updater')
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const resume = vi.fn().mockResolvedValue(undefined)
    updater.quitAndInstall.mockImplementationOnce(() => { throw new Error('Could not start installer') })
    module.initializeGuiUpdater(() => null, () => 'stable', cleanup, undefined, resume)
    updater.emit('update-downloaded', { version: '0.2.0' })
    await expect(module.installGuiUpdate()).resolves.toMatchObject({ ok: false, message: 'Could not start installer' })
    expect(resume).toHaveBeenCalledTimes(1)
    await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
    expect(cleanup).toHaveBeenCalledTimes(2)
  })

  it('releases a dispatched update when Electron is prevented from quitting', async () => {
    const module = await import('./gui-updater')
    const resume = vi.fn().mockResolvedValue(undefined)
    module.initializeGuiUpdater(() => null, () => 'stable', async () => undefined, undefined, resume)
    updater.emit('update-downloaded', { version: '0.2.0' })
    await module.reportGuiUpdateQuitFailure(new Error('Unrelated quit failed'))
    expect(resume).not.toHaveBeenCalled()

    await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
    await module.reportGuiUpdateQuitFailure(new Error('Unable to finish saving'))
    expect(resume).toHaveBeenCalledOnce()
    expect(module.getGuiUpdateState()).toMatchObject({ status: 'error', message: 'Unable to finish saving' })
    await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
  })

  it('keeps a verified downloaded package actionable when a later feed check is offline', async () => {
    const previous = process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES
    process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES = '1'
    try {
      const module = await import('./gui-updater')
      module.initializeGuiUpdater(() => null, () => 'stable', async () => undefined)
      updater.emit('update-downloaded', { version: '0.2.0' })
      updater.checkForUpdates.mockRejectedValue(new Error('network offline'))
      await expect(module.checkGuiUpdate('stable')).resolves.toMatchObject({ ok: false })
      expect(module.getGuiUpdateState()).toMatchObject({ status: 'error', info: { ok: true, downloaded: true, latestVersion: '0.2.0' } })
      await expect(module.installGuiUpdate()).resolves.toEqual({ ok: true })
    } finally { if (previous === undefined) delete process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES; else process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES = previous }
  })

  it('keeps a failed Windows handoff visible and quits only after an acknowledged retry', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const module = await import('./gui-updater')
    let acceptHandoff: () => void = () => { throw new Error('installer not prepared') }
    updater.startVerifiedInstaller
      .mockRejectedValueOnce(new Error('installer could not start'))
      .mockImplementationOnce(() => new Promise<void>(resolve => { acceptHandoff = resolve }))
    module.initializeGuiUpdater(() => null, () => 'stable', async () => undefined)
    updater.emit('update-downloaded', { version: '0.2.0' })

    await expect(module.installGuiUpdate()).resolves.toMatchObject({ ok: false, message: 'installer could not start' })
    expect(module.getGuiUpdateState()).toMatchObject({ status: 'error', info: { downloaded: true } })
    expect(quitApp).not.toHaveBeenCalled()

    const installation = module.installGuiUpdate()
    expect(module.installGuiUpdate()).toBe(installation)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(updater.startVerifiedInstaller).toHaveBeenCalledTimes(2)
    expect(quitApp).not.toHaveBeenCalled()
    acceptHandoff()
    await expect(installation).resolves.toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(quitApp).toHaveBeenCalledOnce()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('offers a download again if Windows removes the checked installer from its cache', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const module = await import('./gui-updater')
    updater.startVerifiedInstaller.mockRejectedValueOnce(new WindowsUpdateCacheError('Installer cache lost'))
    module.initializeGuiUpdater(() => null, () => 'stable')
    updater.emit('update-downloaded', { version: '0.2.0' })

    await expect(module.installGuiUpdate()).resolves.toMatchObject({ ok: false, code: 'install_failed' })
    expect(module.getGuiUpdateState()).toMatchObject({
      status: 'error', info: { hasUpdate: true, downloaded: false, latestVersion: '0.2.0' }
    })
    expect(quitApp).not.toHaveBeenCalled()
  })
})

describe('gui updater source helpers', () => {
  it('forces update metadata revalidation without discarding existing request headers', async () => {
    updater.requestHeaders = { Authorization: 'Bearer test-token' }
    const module = await import('./gui-updater')

    module.initializeGuiUpdater(() => null, () => 'stable')

    expect(updater.requestHeaders).toEqual({
      Authorization: 'Bearer test-token',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    })
  })

  it('normalizes common GitHub repository URL forms', async () => {
    const module = await import('./gui-updater')

    expect(module._internals.normalizeGithubOwnerRepo('railwise-cn/railwise-ai')).toBe(
      'railwise-cn/railwise-ai'
    )
    expect(module._internals.normalizeGithubOwnerRepo('https://github.com/railwise-cn/railwise-ai.git')).toBe(
      'railwise-cn/railwise-ai'
    )
    expect(module._internals.normalizeGithubOwnerRepo('git@github.com:railwise-cn/railwise-ai.git')).toBe(
      'railwise-cn/railwise-ai'
    )
  })

  it('selects the newest usable release for stable and frontier channels', async () => {
    const module = await import('./gui-updater')
    const releases = [
      {
        tag_name: 'v0.3.0-beta.1',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.3.0-beta.1',
        prerelease: true
      },
      {
        tag_name: 'v0.2.0',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.2.0'
      },
      {
        tag_name: 'draft',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/draft',
        draft: true
      }
    ]

    expect(module._internals.selectGithubRelease(releases, 'stable')?.version).toBe('0.2.0')
    expect(module._internals.selectGithubRelease(releases, 'frontier')?.version).toBe('0.3.0-beta.1')
  })

  it('selects 0.4.0 by default now that the replacement release is active', async () => {
    const module = await import('./gui-updater')
    const releases = [
      {
        tag_name: 'v0.4.0',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.4.0'
      },
      {
        tag_name: 'v0.3.5',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.3.5'
      }
    ]

    expect(module._internals.selectGithubRelease(releases, 'stable')?.version).toBe('0.4.0')
  })

  it('skips only stable versions explicitly configured as withdrawn', async () => {
    process.env.WORKWISE_WITHDRAWN_STABLE_VERSIONS = '0.4.0'
    const module = await import('./gui-updater')
    const releases = [
      {
        tag_name: 'v0.3.6',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.3.6'
      },
      {
        tag_name: 'v0.4.0',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.4.0'
      },
      {
        tag_name: 'v0.3.5',
        html_url: 'https://github.com/railwise-cn/railwise-ai/releases/tag/v0.3.5'
      }
    ]

    expect(module._internals.selectGithubRelease(releases, 'stable')?.version).toBe('0.3.6')
  })

  it('does not describe an older withdrawn feed version as the current version', async () => {
    process.env.WORKWISE_WITHDRAWN_STABLE_VERSIONS = '0.4.0'
    const module = await import('./gui-updater')

    expect(module._internals.resolveWithdrawnVersion('0.5.0', '0.4.0', 'stable')).toBeUndefined()
    expect(module._internals.resolveWithdrawnVersion('0.4.0', '0.3.5', 'stable')).toBe('0.4.0')
    expect(module._internals.resolveWithdrawnVersion('0.3.5', '0.4.0', 'stable')).toBe('0.4.0')
    expect(module._internals.resolveWithdrawnVersion('0.4.0', '0.3.5', 'frontier')).toBeUndefined()
  })

  it('defaults to the official railwise.cn feed and keeps explicit enterprise overrides', async () => {
    const previous = {
      WORKWISE_UPDATE_PROVIDER: process.env.WORKWISE_UPDATE_PROVIDER,
      WORKWISE_ENABLE_GITHUB_UPDATE_FALLBACK: process.env.WORKWISE_ENABLE_GITHUB_UPDATE_FALLBACK,
      WORKWISE_UPDATE_URL: process.env.WORKWISE_UPDATE_URL,
      WORKWISE_UPDATE_URL_STABLE: process.env.WORKWISE_UPDATE_URL_STABLE,
      WORKWISE_UPDATE_BASE_URL: process.env.WORKWISE_UPDATE_BASE_URL,
      WORKWISE_PUBLIC_BASE_URL: process.env.WORKWISE_PUBLIC_BASE_URL,
      WORKWISE_RELEASE_PREFIX: process.env.WORKWISE_RELEASE_PREFIX,
      WORKWISE_DOWNLOAD_URL: process.env.WORKWISE_DOWNLOAD_URL,
      WORKWISE_DOWNLOAD_BASE_URL: process.env.WORKWISE_DOWNLOAD_BASE_URL,
      R2_PUBLIC_BASE_URL: process.env.R2_PUBLIC_BASE_URL,
      R2_RELEASE_PREFIX: process.env.R2_RELEASE_PREFIX,
      PUBLIC_DOWNLOAD_BASE_URL: process.env.PUBLIC_DOWNLOAD_BASE_URL,
      PUBLIC_DOWNLOAD_PAGE_URL: process.env.PUBLIC_DOWNLOAD_PAGE_URL
    }
    delete process.env.WORKWISE_UPDATE_PROVIDER
    delete process.env.WORKWISE_ENABLE_GITHUB_UPDATE_FALLBACK
    delete process.env.WORKWISE_UPDATE_URL
    delete process.env.WORKWISE_UPDATE_URL_STABLE
    delete process.env.WORKWISE_UPDATE_BASE_URL
    delete process.env.WORKWISE_PUBLIC_BASE_URL
    delete process.env.WORKWISE_RELEASE_PREFIX
    delete process.env.WORKWISE_DOWNLOAD_URL
    delete process.env.WORKWISE_DOWNLOAD_BASE_URL
    delete process.env.R2_PUBLIC_BASE_URL
    delete process.env.R2_RELEASE_PREFIX
    delete process.env.PUBLIC_DOWNLOAD_BASE_URL
    delete process.env.PUBLIC_DOWNLOAD_PAGE_URL

    try {
      const module = await import('./gui-updater')
      expect(module._internals.resolveUpdateFeedConfig('stable')).toEqual({
        kind: 'generic',
        url: 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/'
      })
      expect(module._internals.downloadPageUrl()).toBe('https://www.railwise.cn/products/railwise-ai/')

      process.env.WORKWISE_UPDATE_PROVIDER = 'none'
      expect(module._internals.resolveUpdateFeedConfig('stable')).toEqual({ kind: 'none' })
      expect(module._internals.downloadPageUrl()).toBe('https://www.railwise.cn/products/railwise-ai/')
      delete process.env.WORKWISE_UPDATE_PROVIDER

      process.env.WORKWISE_PUBLIC_BASE_URL = 'https://downloads.example.test/workwise'
      process.env.WORKWISE_RELEASE_PREFIX = 'desktop'
      expect(module._internals.resolveUpdateFeedConfig('stable')).toEqual({
        kind: 'generic',
        url: 'https://downloads.example.test/workwise/desktop/channels/stable/latest/'
      })
      expect(module._internals.downloadPageUrl()).toBe('https://www.railwise.cn/products/railwise-ai/')

      process.env.WORKWISE_UPDATE_URL_STABLE = 'https://mirror.example.test/{channel}/latest'
      expect(module._internals.resolveUpdateFeedConfig('stable')).toEqual({
        kind: 'generic',
        url: 'https://mirror.example.test/stable/latest/'
      })
      process.env.WORKWISE_DOWNLOAD_URL = 'https://www.example.test/products/workwise/'
      expect(module._internals.downloadPageUrl()).toBe('https://www.example.test/products/workwise/')
      delete process.env.WORKWISE_DOWNLOAD_URL

      delete process.env.WORKWISE_UPDATE_URL_STABLE
      process.env.WORKWISE_UPDATE_PROVIDER = 'github'
      expect(module._internals.resolveUpdateFeedConfig('stable')).toMatchObject({
        kind: 'github',
        owner: 'railwise-cn',
        repo: 'railwise-ai'
      })
      expect(module._internals.downloadPageUrl()).toBe('https://github.com/railwise-cn/railwise-ai/releases')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('ignores a scheduled-check timestamp written by another app version', async () => {
    const module = await import('./gui-updater')
    const checkedAt = '2026-07-14T00:00:00.000Z'

    expect(module._internals.parseScheduledCheckAt(JSON.stringify({
      lastCheckedAt: checkedAt,
      appVersion: '0.1.0'
    }), '0.1.0')).toBe(Date.parse(checkedAt))
    expect(module._internals.parseScheduledCheckAt(JSON.stringify({
      lastCheckedAt: checkedAt,
      appVersion: '0.1.0'
    }), '0.2.0')).toBeNull()
  })

  it('automatically checks on startup even after a recent check in the same installed version', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const now = new Date()
    vi.setSystemTime(now)
    const readFile = vi.fn(async () => JSON.stringify({ lastCheckedAt: now.toISOString(), appVersion: '0.1.0' }))
    vi.doMock('node:fs/promises', async importOriginal => ({
      ...await importOriginal<typeof import('node:fs/promises')>(),
      readFile,
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined)
    }))
    try {
      updater.checkForUpdates.mockResolvedValue({
        isUpdateAvailable: true, updateInfo: { version: '0.2.0' }
      })
      const module = await import('./gui-updater')
      module.initializeGuiUpdater(() => null, () => 'stable')
      await vi.advanceTimersByTimeAsync(0)
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(module.getGuiUpdateState()).toMatchObject({ status: 'available', info: { latestVersion: '0.2.0' } })
    } finally {
      vi.doUnmock('node:fs/promises')
    }
  })

  it('keeps a downloaded installer actionable through a feed check only for matching bytes', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const module = await import('./gui-updater')
    module.initializeGuiUpdater(() => null, () => 'stable')
    const update = { version: '0.2.0', files: [{ url: 'update.exe', sha512: 'checked-hash' }] }
    updater.emit('update-downloaded', update)
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', update)
      return { isUpdateAvailable: true, updateInfo: update }
    })
    await expect(module.checkGuiUpdate('stable')).resolves.toMatchObject({ downloaded: true })
    expect(module.getGuiUpdateState().status).toBe('downloaded')

    update.files = [{ url: 'update.exe', sha512: 'different-hash' }]
    await expect(module.checkGuiUpdate('stable')).resolves.toMatchObject({ downloaded: false })
    expect(module.getGuiUpdateState().status).toBe('available')
  })

  it('rejects downgrades and manifest/download version mismatches', async () => {
    const module = await import('./gui-updater')
    expect(module._internals.validateCandidateVersion('0.0.9')).toMatch(/downgrade/i)
    expect(module._internals.validateCandidateVersion('0.2.0', '0.3.0')).toMatch(/does not match/i)
    expect(module._internals.validateCandidateVersion('not-a-version')).toMatch(/invalid/i)
  })

  it('does not mark a mismatched downloaded package ready to install', async () => {
    const module = await import('./gui-updater')
    module.initializeGuiUpdater(() => null, () => 'stable')
    updater.emit('update-available', { version: '0.3.0', releaseDate: '2026-08-01T00:00:00.000Z' })
    updater.emit('update-downloaded', { version: '0.4.0', releaseDate: '2026-08-01T00:00:00.000Z' })
    expect(module.getGuiUpdateState()).toMatchObject({ status: 'error', code: 'download_failed' })
    await expect(module.installGuiUpdate()).resolves.toMatchObject({ ok: false })
  })

  it('coalesces concurrent checks for the same update channel', async () => {
    process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES = '1'
    updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '0.2.0', releaseDate: '2026-07-14T00:00:00.000Z' } })
    const module = await import('./gui-updater')

    const [first, second] = await Promise.all([
      module.checkGuiUpdate('stable'),
      module.checkGuiUpdate('stable')
    ])

    expect(first).toEqual(second)
    expect(first).toMatchObject({ ok: true, latestVersion: '0.2.0', hasUpdate: true })
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    delete process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES
  })

  it('keeps the classified failure code in the emitted update state', async () => {
    process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES = '1'
    updater.checkForUpdates.mockRejectedValue(new Error('ETIMEDOUT: update feed network timeout'))
    const module = await import('./gui-updater')

    const result = await module.checkGuiUpdate('stable')

    expect(result).toMatchObject({ ok: false, code: 'network' })
    expect(module.getGuiUpdateState()).toMatchObject({ status: 'error', code: 'network' })
    delete process.env.WORKWISE_ALLOW_UNSIGNED_UPDATES
  })
})
