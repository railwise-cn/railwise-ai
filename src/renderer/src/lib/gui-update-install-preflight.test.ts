import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  flushGuiUpdateEditors,
  preflightAndInstallGuiUpdate,
  registerGuiUpdateSaveHandler
} from './gui-update-install-preflight'

describe('GUI update install preflight', () => {
  beforeEach(() => {
    const testWindow = {
      confirm: vi.fn(() => true),
      workwise: {
        getAppVersion: vi.fn(async () => '0.3.3'),
        preflightGuiUpdateInstall: vi.fn(async () => ({ ok: true, activeWork: [] })),
        installGuiUpdate: vi.fn(async () => ({ ok: true }))
      }
    }
    vi.stubGlobal('window', testWindow)
  })

  it('flushes every registered editor and reports failed saves', async () => {
    const releaseWrite = registerGuiUpdateSaveHandler('Write-test', vi.fn(async () => true))
    const releaseDesign = registerGuiUpdateSaveHandler('Design-test', vi.fn(async () => false))
    await expect(flushGuiUpdateEditors()).resolves.toEqual({ ok: false, failed: ['Design-test'] })
    releaseWrite()
    releaseDesign()
  })

  it('keeps the app open when saving fails', async () => {
    const release = registerGuiUpdateSaveHandler('dirty-test', vi.fn(async () => false))
    const result = await preflightAndInstallGuiUpdate()
    expect(result).toMatchObject({ ok: false, code: 'install_failed' })
    expect(window.workwise.preflightGuiUpdateInstall).not.toHaveBeenCalled()
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    release()
  })

  it('hands safe active work to main without a second confirmation', async () => {
    vi.mocked(window.workwise.preflightGuiUpdateInstall).mockResolvedValue({
      ok: true,
      activeWork: [{ kind: 'flow', id: 'run-1', label: 'Tender Flow', status: 'running', recoverable: true }]
    })
    await expect(preflightAndInstallGuiUpdate()).resolves.toEqual({ ok: true })
    expect(window.confirm).not.toHaveBeenCalled()
    expect(window.workwise.installGuiUpdate).toHaveBeenCalledWith({ confirmActiveWork: true })
  })

  it('validates synchronously again after freezing editors and releases them when installation fails', async () => {
    const calls: string[] = []
    const unlock = vi.fn(() => calls.push('unlock'))
    const release = registerGuiUpdateSaveHandler('guarded-test', async () => true, {
      isReady: () => { calls.push('ready'); return true },
      beginHandoff: () => { calls.push('freeze'); return unlock }
    })
    vi.mocked(window.workwise.installGuiUpdate).mockImplementation(async () => {
      calls.push('install')
      return { ok: false, currentVersion: '0.5.4', message: 'Synthetic failure' }
    })
    await expect(preflightAndInstallGuiUpdate()).resolves.toMatchObject({ ok: false })
    expect(calls).toEqual(['ready', 'freeze', 'ready', 'install', 'unlock'])
    release()
  })
})
