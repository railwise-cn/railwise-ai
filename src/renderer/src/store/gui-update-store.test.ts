import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyGuiUpdate, useGuiUpdateStore } from './gui-update-store'
import type { GuiUpdateInfo } from '@shared/gui-update'

const info: Extract<GuiUpdateInfo, { ok: true }> = { ok: true, currentVersion: '0.5.4', latestVersion: '0.5.5', hasUpdate: true, releaseUrl: 'https://railwise.cn/download', channel: 'stable' }

beforeEach(() => {
  useGuiUpdateStore.setState({ state: { status: 'available', info }, pending: false, activity: null, error: null })
  vi.stubGlobal('window', {
    confirm: vi.fn(() => true),
    workwise: {
      downloadGuiUpdate: vi.fn(async () => ({ ok: true, paths: ['/update.zip'] })),
      getGuiUpdateState: vi.fn(async () => ({ status: 'downloaded', info: { ...info, downloaded: true } })),
      getAppVersion: vi.fn(async () => '0.5.4'),
      preflightGuiUpdateInstall: vi.fn(async () => ({ ok: true, activeWork: [], snapshotId: 'a'.repeat(64) })),
      installGuiUpdate: vi.fn(async () => ({ ok: true })),
      openExternal: vi.fn()
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('one-click update controller', () => {
  it('downloads, checks and installs from one action and coalesces duplicate clicks', async () => {
    await Promise.all([applyGuiUpdate(), applyGuiUpdate()])
    expect(window.workwise.downloadGuiUpdate).toHaveBeenCalledTimes(1)
    expect(window.workwise.preflightGuiUpdateInstall).toHaveBeenCalledTimes(1)
    expect(window.workwise.installGuiUpdate).toHaveBeenCalledTimes(1)
  })

  it('keeps the download when work cannot safely stop and retries installation directly', async () => {
    vi.mocked(window.workwise.preflightGuiUpdateInstall).mockResolvedValue({ ok: true, activeWork: [{ id: 'task', kind: 'agent', label: '报告', status: 'running', recoverable: false }], snapshotId: 'a'.repeat(64) })
    await applyGuiUpdate()
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    expect(useGuiUpdateStore.getState().state.status).toBe('downloaded')
    expect(useGuiUpdateStore.getState().error).toContain('无法安全暂停')
    vi.mocked(window.workwise.preflightGuiUpdateInstall).mockResolvedValue({ ok: true, activeWork: [{ id: 'task', kind: 'agent', label: '报告', status: 'running', recoverable: true }], snapshotId: 'a'.repeat(64) })
    await applyGuiUpdate()
    expect(window.workwise.downloadGuiUpdate).toHaveBeenCalledTimes(1)
    expect(window.workwise.installGuiUpdate).toHaveBeenCalledWith({ confirmActiveWork: true, confirmedSnapshotId: 'a'.repeat(64) })
  })

  it('stops before install on download or preflight failure', async () => {
    vi.mocked(window.workwise.downloadGuiUpdate).mockResolvedValueOnce({ ok: false, currentVersion: '0.5.4', message: 'offline' })
    await applyGuiUpdate()
    expect(window.workwise.preflightGuiUpdateInstall).not.toHaveBeenCalled()
    expect(useGuiUpdateStore.getState().error).toBe('offline')
    vi.mocked(window.workwise.preflightGuiUpdateInstall).mockResolvedValue({ ok: false, activeWork: [], message: 'Runtime unavailable' })
    await applyGuiUpdate()
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    expect(useGuiUpdateStore.getState().error).toBe('Runtime unavailable')
  })

  it('opens the official manual download without trying to install', async () => {
    useGuiUpdateStore.setState({ state: { status: 'available', info: { ...info, manualOnly: true } } })
    await applyGuiUpdate()
    expect(window.workwise.openExternal).toHaveBeenCalledWith(info.releaseUrl)
    expect(window.workwise.downloadGuiUpdate).not.toHaveBeenCalled()
  })
})
