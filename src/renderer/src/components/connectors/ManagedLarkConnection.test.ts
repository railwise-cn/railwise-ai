// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ManagedLarkConnection } from './ManagedLarkConnection'

const api = {
  diagnoseManagedTool: vi.fn(), installManagedTool: vi.fn(), beginManagedLarkLogin: vi.fn(),
  completeManagedLarkLogin: vi.fn(), beginManagedLarkAppSetup: vi.fn(), checkManagedLarkAppSetup: vi.fn(),
  cancelManagedLarkAppSetup: vi.fn(), openExternal: vi.fn(async () => undefined)
}
let root: Root; let container: HTMLDivElement
async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!button) throw new Error(`Missing button: ${label}`)
  await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve() })
}
describe('shared official Lark connection panel', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    api.openExternal.mockResolvedValue(undefined)
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { workwise: api })
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })
  it('does not touch accounts when the connector catalog is only viewed', async () => {
    await act(async () => { root.render(createElement(ManagedLarkConnection)) })
    expect(api.diagnoseManagedTool).not.toHaveBeenCalled()
    expect(api.beginManagedLarkLogin).not.toHaveBeenCalled()
    expect(api.beginManagedLarkAppSetup).not.toHaveBeenCalled()
  })
  it('connects through official install and app scan after an explicit connect click', async () => {
    api.diagnoseManagedTool.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'not_installed' } })
    api.installManagedTool.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'needs_login' } })
    api.beginManagedLarkLogin.mockResolvedValue({ ok: false, reason: 'app_configuration_required', message: 'App required' })
    api.beginManagedLarkAppSetup.mockResolvedValue({ ok: true, state: 'waiting', verificationUrl: 'https://accounts.feishu.cn/device?synthetic', expiresAt: '2026-11-11T00:00:00Z' })
    await act(async () => { root.render(createElement(ManagedLarkConnection)) })
    await click('连接飞书')
    expect(api.installManagedTool).toHaveBeenCalledWith('lark-cli')
    expect(api.beginManagedLarkAppSetup).toHaveBeenCalledOnce()
    expect(api.openExternal).toHaveBeenCalledWith('https://accounts.feishu.cn/device?synthetic')
    expect(container.querySelector('svg')).not.toBeNull()
    expect(container.textContent).toContain('RailWise 不会替你确认平台权限')
    expect(container.querySelector('input')).toBeNull()
    await act(async () => { root.render(createElement(ManagedLarkConnection)) })
    expect(api.beginManagedLarkAppSetup).toHaveBeenCalledOnce()
  })
  it('starts autoConnect once only after the caller records an explicit connect action', async () => {
    api.diagnoseManagedTool.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'needs_login' } })
    api.beginManagedLarkLogin.mockResolvedValue({ ok: true, verificationUrl: 'https://accounts.feishu.cn/user-login', expiresAt: '2026-11-11T00:00:00Z' })
    api.completeManagedLarkLogin.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'installed' } })
    const onChanged = vi.fn(async () => undefined)
    await act(async () => { root.render(createElement(ManagedLarkConnection, { autoConnect: true, onChanged })); await Promise.resolve(); await Promise.resolve() })
    expect(api.beginManagedLarkLogin).toHaveBeenCalledOnce()
    expect(container.textContent).not.toContain('请输入')
    expect(container.textContent).not.toContain('undefined')
    await click('我已完成授权，检查登录')
    expect(api.completeManagedLarkLogin).toHaveBeenCalledOnce()
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('连接不会自动执行')
  })
  it('continues to user authorization after the official first-use configuration is verified', async () => {
    api.diagnoseManagedTool.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'needs_login' } })
    api.beginManagedLarkLogin.mockResolvedValueOnce({ ok: false, reason: 'app_configuration_required', message: 'App required' })
      .mockResolvedValueOnce({ ok: true, verificationUrl: 'https://accounts.feishu.cn/user-login', expiresAt: '2026-11-11T00:00:00Z' })
    api.beginManagedLarkAppSetup.mockResolvedValue({ ok: true, state: 'waiting', verificationUrl: 'https://open.feishu.cn/device', expiresAt: '2026-11-11T00:00:00Z' })
    api.checkManagedLarkAppSetup.mockResolvedValue({ ok: true, state: 'configured' })
    await act(async () => { root.render(createElement(ManagedLarkConnection)) })
    await click('连接飞书')
    expect(container.textContent).not.toContain('安装 Lark CLI')
    await click('我已完成应用配置，检查结果')
    expect(api.beginManagedLarkLogin).toHaveBeenCalledTimes(2)
    expect(api.openExternal).toHaveBeenLastCalledWith('https://accounts.feishu.cn/user-login')
    expect(api.completeManagedLarkLogin).not.toHaveBeenCalled()
  })
})
