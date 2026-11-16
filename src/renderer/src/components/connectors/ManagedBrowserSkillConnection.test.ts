// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { ManagedBrowserSkillConnection } from './ManagedBrowserSkillConnection'
import { BrowserCapabilityConfig } from '../../../../../kun/src/contracts/browser-skill'

const api = { diagnoseBrowserSkill: vi.fn(), installBrowserSkill: vi.fn(), connectBrowserSkill: vi.fn(), configureBrowserSkill: vi.fn(), openBrowserSkillExtension: vi.fn(async () => undefined) }
let root: Root
let container: HTMLDivElement
const status = (patch = {}) => ({ ok: true, status: BrowserCapabilityConfig.parse(patch) })
beforeEach(async () => {
  vi.resetAllMocks()
  await i18n.changeLanguage('zh')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { workwise: api })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  api.diagnoseBrowserSkill.mockResolvedValue(status())
  api.installBrowserSkill.mockResolvedValue(status({ state: 'daemon_stopped', executablePath: '/verified/bsk', revision: 1 }))
  api.connectBrowserSkill.mockResolvedValue(status({ state: 'needs_extension', executablePath: '/verified/bsk', revision: 1 }))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
async function render() { await act(async () => { root.render(createElement(ManagedBrowserSkillConnection)) }) }
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}

describe('BrowserSkill setup uses real capability stages', () => {
  it('opening details checks status while installation and service launch remain explicit', async () => {
    await render()
    expect(container.textContent).toContain('尚未安装 BrowserSkill CLI')
    expect(api.installBrowserSkill).not.toHaveBeenCalled()
    expect(api.connectBrowserSkill).not.toHaveBeenCalled()
    await click('安装 CLI 与配套技能')
    expect(container.textContent).toContain('浏览器服务尚未启动')
    await click('连接浏览器服务')
    expect(container.textContent).toContain('等待浏览器扩展连接')
  })
  it('opens only the supported official store entry through main', async () => {
    await render()
    await click('安装 Edge 扩展')
    expect(api.openBrowserSkillExtension).toHaveBeenCalledWith('edge')
    expect(api.configureBrowserSkill).not.toHaveBeenCalled()
  })
  it('shows a verified browser and preserves the saved narrow scope when submitting', async () => {
    const configured = status({ enabled: true, state: 'ready', browserInstanceId: 'test-browser', revision: 4, origins: ['https://example.com'], interaction: 'observe',
      browsers: [{ id: 'test-browser', name: 'Chrome', label: '测试', extensionVersion: '0.4.0', protocolVersion: '1.7', connected: true, versionSkew: false }] })
    api.diagnoseBrowserSkill.mockResolvedValue(configured)
    api.configureBrowserSkill.mockResolvedValue(status({ ...configured.status, revision: 5 }))
    await render()
    expect(container.textContent).toContain('浏览器连接检查通过')
    await click('保存连接与范围')
    expect(api.configureBrowserSkill).toHaveBeenCalledWith({ enabled: true, browserInstanceId: 'test-browser', origins: ['https://example.com'], interaction: 'observe', expectedRevision: 4 })
    expect(api.connectBrowserSkill).not.toHaveBeenCalled()
  })
})
