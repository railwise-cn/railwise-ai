// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ManagedDingTalkConnection } from './ManagedDingTalkConnection'

const api = {
  diagnoseManagedDingTalk: vi.fn(), installManagedDingTalk: vi.fn(), beginManagedDingTalkLogin: vi.fn(),
  checkManagedDingTalkLogin: vi.fn(), cancelManagedDingTalkLogin: vi.fn(), setManagedDingTalkEnabled: vi.fn(), openExternal: vi.fn(async () => undefined)
}
let root: Root
let container: HTMLDivElement
const waiting = { ok: true, state: 'waiting', verificationUrl: 'https://login.dingtalk.com/oauth/device', userCode: 'SYNTHETIC', expiresAt: '2026-11-11T00:00:00Z' }
async function render(autoConnect = false, onChanged = vi.fn()): Promise<void> {
  await act(async () => { root.render(createElement(ManagedDingTalkConnection, { autoConnect, onChanged })) })
}
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => { button.click(); await Promise.resolve() })
}

describe('managed DingTalk connection', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { workwise: api })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    api.diagnoseManagedDingTalk.mockResolvedValue({ ok: true, status: { state: 'not_installed' } })
    api.installManagedDingTalk.mockResolvedValue({ ok: true, status: { state: 'needs_login' } })
    api.beginManagedDingTalkLogin.mockResolvedValue(waiting)
    api.checkManagedDingTalkLogin.mockResolvedValue(waiting)
    api.cancelManagedDingTalkLogin.mockResolvedValue({ ok: true, state: 'cancelled' })
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers() })

  it('does not install or begin login merely by opening details', async () => {
    await render()
    expect(api.diagnoseManagedDingTalk).not.toHaveBeenCalled()
    expect(api.installManagedDingTalk).not.toHaveBeenCalled()
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
    expect(container.textContent).toContain('无需在聊天中提供账号或密钥')
  })

  it('connects through managed installation and official device authorization without account fields', async () => {
    await render(true)
    expect(api.diagnoseManagedDingTalk).toHaveBeenCalledOnce()
    expect(api.installManagedDingTalk).toHaveBeenCalledOnce()
    expect(api.beginManagedDingTalkLogin).toHaveBeenCalledOnce()
    expect(api.openExternal).toHaveBeenCalledWith(waiting.verificationUrl)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(container.textContent).toContain('SYNTHETIC')
    expect(container.textContent).toContain('连接账号不会自动处理待办或审批')
  })

  it('checks the held login automatically and stops checking after verified success', async () => {
    vi.useFakeTimers()
    await render(true)
    api.checkManagedDingTalkLogin.mockResolvedValue({ ok: true, state: 'succeeded', status: { state: 'installed', identityFingerprint: 'synthetic-identity' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(api.checkManagedDingTalkLogin).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('钉钉登录已核验')
    expect(container.querySelector('svg')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.checkManagedDingTalkLogin).toHaveBeenCalledOnce()
  })

  it('cancels only the authorization flow and does not reopen it', async () => {
    await render(true)
    await click('取消本次登录')
    expect(api.cancelManagedDingTalkLogin).toHaveBeenCalledOnce()
    expect(api.beginManagedDingTalkLogin).toHaveBeenCalledOnce()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toContain('已取消本次登录')
  })

  it('stops checking an unverifiable identity without starting a fresh login', async () => {
    vi.useFakeTimers()
    await render(true)
    api.checkManagedDingTalkLogin.mockResolvedValue({ ok: false, message: '授权账号无法核验' })
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(container.textContent).toContain('授权账号无法核验')
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.checkManagedDingTalkLogin).toHaveBeenCalledOnce()
    expect(api.beginManagedDingTalkLogin).toHaveBeenCalledOnce()
  })

  it('does not start authorization when installation fails or diagnostics are unknown', async () => {
    api.installManagedDingTalk.mockResolvedValue({ ok: false, message: '下载摘要不匹配，未安装' })
    await render(true)
    expect(container.textContent).toContain('下载摘要不匹配')
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
    expect(api.openExternal).not.toHaveBeenCalled()
  })

  it('keeps an already verified account and leaves account changes to explicit management', async () => {
    api.diagnoseManagedDingTalk.mockResolvedValue({ ok: true, status: { state: 'installed', identityFingerprint: 'verified' } })
    await render(true)
    expect(api.installManagedDingTalk).not.toHaveBeenCalled()
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
    expect(container.textContent).toContain('登录身份已核验')
  })

  it('preserves a disabled connector and offers a separate explicit enable action', async () => {
    api.diagnoseManagedDingTalk.mockResolvedValue({ ok: true, status: { state: 'needs_login', enabled: false } })
    api.setManagedDingTalkEnabled.mockResolvedValue({ ok: true, status: { state: 'needs_login', enabled: true } })
    await render(true)
    expect(api.installManagedDingTalk).not.toHaveBeenCalled()
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
    await click('启用钉钉连接器')
    expect(api.setManagedDingTalkEnabled).toHaveBeenCalledWith(true)
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
    expect(container.textContent).toContain('停用钉钉连接器')
  })
})
