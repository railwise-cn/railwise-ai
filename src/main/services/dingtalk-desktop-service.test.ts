import { describe, expect, it, vi } from 'vitest'
import { openDingTalkDesktop } from './dingtalk-desktop-service'

vi.mock('electron', () => ({ app: {}, shell: {} }))

function dependencies(platform = 'darwin') {
  return {
    platform,
    home: '/Users/test',
    exists: vi.fn((path: string) => path === '/Applications/DingTalk.app'),
    readBundleId: vi.fn(async () => '5ZSL2CJU2T.com.dingtalk.mac'),
    registeredApplication: vi.fn<() => Promise<{ path: string }>>(async () => { throw new Error('No registered application') }),
    openPath: vi.fn(async () => '')
  }
}

describe('open installed DingTalk desktop', () => {
  it('opens the verified installed macOS bundle without a URL or command from the renderer', async () => {
    const deps = dependencies()
    expect(await openDingTalkDesktop(deps)).toEqual({ ok: true })
    expect(deps.readBundleId).toHaveBeenCalledWith('/Applications/DingTalk.app')
    expect(deps.openPath).toHaveBeenCalledWith('/Applications/DingTalk.app')
    expect(deps.registeredApplication).not.toHaveBeenCalled()
  })

  it('finds a user-installed macOS client', async () => {
    const deps = dependencies()
    deps.exists.mockImplementation((path) => path === '/Users/test/Applications/DingTalk.app')
    expect(await openDingTalkDesktop(deps)).toEqual({ ok: true })
    expect(deps.openPath).toHaveBeenCalledWith('/Users/test/Applications/DingTalk.app')
  })

  it('uses the registered macOS location only after checking its bundle identity', async () => {
    const deps = dependencies()
    deps.exists.mockImplementation((path) => path === '/Volumes/Apps/DingTalk.app')
    deps.registeredApplication.mockResolvedValue({ path: '/Volumes/Apps/DingTalk.app' })
    expect(await openDingTalkDesktop(deps)).toEqual({ ok: true })
    expect(deps.readBundleId).toHaveBeenCalledWith('/Volumes/Apps/DingTalk.app')
    expect(deps.openPath).toHaveBeenCalledWith('/Volumes/Apps/DingTalk.app')
  })

  it('reports an absent app with a recoverable action', async () => {
    const deps = dependencies()
    deps.exists.mockReturnValue(false)
    expect(await openDingTalkDesktop(deps)).toMatchObject({ ok: false, code: 'not_installed' })
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('rejects a different macOS bundle in the expected location', async () => {
    const deps = dependencies()
    deps.readBundleId.mockResolvedValue('com.example.other')
    expect(await openDingTalkDesktop(deps)).toMatchObject({ ok: false, code: 'invalid_app' })
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('reports system open failures without returning system details', async () => {
    const deps = dependencies()
    deps.openPath.mockResolvedValue('/private/application/detail: failed')
    const result = await openDingTalkDesktop(deps)
    expect(result).toMatchObject({ ok: false, code: 'open_failed' })
    expect(JSON.stringify(result)).not.toContain('/private/application')
  })

  it('reports thrown platform failures', async () => {
    const deps = dependencies()
    deps.openPath.mockRejectedValue(new Error('native failure'))
    expect(await openDingTalkDesktop(deps)).toMatchObject({ ok: false, code: 'open_failed' })
  })

  it('opens a registered Windows executable directly without protocol command arguments', async () => {
    const deps = dependencies('win32')
    const path = 'C:\\Program Files\\DingTalk\\DingTalk.exe'
    deps.exists.mockImplementation((candidate) => candidate === path)
    deps.registeredApplication.mockResolvedValue({ path })
    expect(await openDingTalkDesktop(deps)).toEqual({ ok: true })
    expect(deps.openPath).toHaveBeenCalledWith(path)
    expect(deps.readBundleId).not.toHaveBeenCalled()
  })

  it('does not open a different registered Windows protocol handler', async () => {
    const deps = dependencies('win32')
    deps.exists.mockReturnValue(true)
    deps.registeredApplication.mockResolvedValue({ path: 'C:\\Windows\\System32\\cmd.exe' })
    expect(await openDingTalkDesktop(deps)).toMatchObject({ ok: false, code: 'invalid_app' })
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('gives a clear unsupported platform result', async () => {
    const deps = dependencies('linux')
    expect(await openDingTalkDesktop(deps)).toMatchObject({ ok: false, code: 'unsupported' })
    expect(deps.openPath).not.toHaveBeenCalled()
  })
})
