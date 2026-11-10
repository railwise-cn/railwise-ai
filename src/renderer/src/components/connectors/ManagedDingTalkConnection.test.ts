// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ManagedDingTalkConnection } from './ManagedDingTalkConnection'

const api = {
  diagnoseManagedDingTalk: vi.fn(), installManagedDingTalk: vi.fn(), beginManagedDingTalkLogin: vi.fn(),
  checkManagedDingTalkLogin: vi.fn(), cancelManagedDingTalkLogin: vi.fn(), setManagedDingTalkEnabled: vi.fn(), openExternal: vi.fn(async () => undefined),
  openDingTalkDesktop: vi.fn(), checkManagedDingTalkTaskAccess: vi.fn()
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
    expect(container.querySelector('input')?.readOnly).toBe(true)
    expect(container.querySelector('input')?.value).toBe(waiting.verificationUrl)
    expect(container.textContent).toContain('SYNTHETIC')
    expect(container.textContent).toContain('连接账号不会自动处理待办或审批')
  })

  it('checks the held login automatically and stops checking after verified success', async () => {
    vi.useFakeTimers()
    await render(true)
    api.checkManagedDingTalkLogin.mockResolvedValue({ ok: true, state: 'succeeded', status: { state: 'installed', identityFingerprint: 'synthetic-identity' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(api.checkManagedDingTalkLogin).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('官方授权已返回')
    expect(container.querySelector('svg')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.checkManagedDingTalkLogin).toHaveBeenCalledOnce()
  })

  it('refreshes the connector after verified completion before an authorization page is needed', async () => {
    vi.useFakeTimers()
    const onChanged = vi.fn()
    api.diagnoseManagedDingTalk.mockResolvedValue({ ok: true, status: { state: 'needs_login' } })
    api.beginManagedDingTalkLogin.mockResolvedValue({ ok: true, state: 'succeeded', status: { state: 'installed', identityFingerprint: 'synthetic-identity' } })
    await render(true, onChanged)
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('官方授权已返回')
    expect(api.openExternal).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.checkManagedDingTalkLogin).not.toHaveBeenCalled()
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

  it('starts fresh authorization when the user connects with a saved login', async () => {
    api.diagnoseManagedDingTalk.mockResolvedValue({ ok: true, status: { state: 'installed', identityFingerprint: 'verified' } })
    await render(true)
    expect(api.installManagedDingTalk).not.toHaveBeenCalled()
    expect(api.beginManagedDingTalkLogin).toHaveBeenCalledOnce()
    expect(api.openExternal).toHaveBeenCalledWith(waiting.verificationUrl)
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toContain('重新授权 / 切换账号')
  })

  it('keeps the QR and copyable link visible when browser launch fails', async () => {
    vi.useFakeTimers()
    api.openExternal.mockRejectedValue(new Error('OS launch failed'))
    await render(true)
    expect(container.textContent).toContain('浏览器未能打开授权页面')
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('input')?.value).toBe(waiting.verificationUrl)
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(container.textContent).toContain('浏览器未能打开授权页面')
  })

  it('updates the displayed QR and link when the official device flow retries', async () => {
    vi.useFakeTimers()
    await render(true)
    api.checkManagedDingTalkLogin.mockResolvedValue({ ...waiting, verificationUrl: `${waiting.verificationUrl}?user_code=SECOND`, userCode: 'SECOND' })
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(container.querySelector('input')?.value).toContain('SECOND')
    expect(container.textContent).not.toContain('SYNTHETIC')
  })

  it('runs a fixed read check independently of login or model execution', async () => {
    api.checkManagedDingTalkTaskAccess.mockResolvedValue({ ok: true, itemCount: 1 })
    await render()
    await click('测试待办读取')
    expect(api.checkManagedDingTalkTaskAccess).toHaveBeenCalledWith()
    expect(container.textContent).toContain('已验证返回 1 条记录')
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
  })

  it('shows remote access failure without replacing it with local login success', async () => {
    api.checkManagedDingTalkTaskAccess.mockResolvedValue({ ok: false, code: 'access_denied', message: '组织暂未授权待办读取' })
    await render()
    await click('测试待办读取')
    expect(container.textContent).toContain('组织暂未授权待办读取')
    await click('检查登录信息')
    expect(container.textContent).toContain('组织暂未授权待办读取')
  })

  it('opens the installed desktop app through its fixed application action', async () => {
    api.openDingTalkDesktop.mockResolvedValue({ ok: true })
    await render()
    await click('打开本机钉钉')
    expect(api.openDingTalkDesktop).toHaveBeenCalledWith()
    expect(api.beginManagedDingTalkLogin).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已打开本机钉钉')
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
