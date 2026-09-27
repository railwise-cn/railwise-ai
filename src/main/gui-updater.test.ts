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
}

let updater: MockUpdater
let nativeUpdater: EventEmitter

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
    quitAndInstall: vi.fn()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  updater = createUpdater()
  nativeUpdater = new EventEmitter()
  vi.doMock('electron', () => ({
    app: {
      isPackaged: true,
      getAppPath: () => '/tmp/workwise-updater-test-app',
      getPath: () => '/tmp/workwise-updater-test-user-data',
      getVersion: () => '0.1.0'
    },
    autoUpdater: nativeUpdater,
    BrowserWindow: class {}
  }))
  vi.doMock('electron-updater', () => ({
    default: { autoUpdater: updater },
    autoUpdater: updater
  }))
})

afterEach(() => {
  delete process.env.WORKWISE_WITHDRAWN_STABLE_VERSIONS
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('electron')
  vi.doUnmock('electron-updater')
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

    module.initializeGuiUpdater(() => null, () => 'stable', beforeInstall)
    updater.emit('update-downloaded', { version: '0.2.0', releaseDate: '2026-06-06T00:00:00.000Z' })

    nativeUpdater.emit('before-quit-for-update')
    const installing = module.installGuiUpdate()
    await Promise.resolve()

    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    finishCleanup()
    await expect(installing).resolves.toEqual({ ok: true })
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('uses silent replacement only for the assisted Windows installer', async () => {
    const module = await import('./gui-updater')
    expect(module._internals.shouldInstallSilently('win32')).toBe(true)
    expect(module._internals.shouldInstallSilently('darwin')).toBe(false)
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
      expect(module._internals.downloadPageUrl()).toBe('https://www.railwise.cn/products/workwise/')

      process.env.WORKWISE_UPDATE_PROVIDER = 'none'
      expect(module._internals.resolveUpdateFeedConfig('stable')).toEqual({ kind: 'none' })
      expect(module._internals.downloadPageUrl()).toBe('https://www.railwise.cn/products/workwise/')
      delete process.env.WORKWISE_UPDATE_PROVIDER

      process.env.WORKWISE_PUBLIC_BASE_URL = 'https://downloads.example.test/workwise'
      process.env.WORKWISE_RELEASE_PREFIX = 'desktop'
      expect(module._internals.resolveUpdateFeedConfig('stable')).toEqual({
        kind: 'generic',
        url: 'https://downloads.example.test/workwise/desktop/channels/stable/latest/'
      })
      expect(module._internals.downloadPageUrl()).toBe('https://www.railwise.cn/products/workwise/')

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
