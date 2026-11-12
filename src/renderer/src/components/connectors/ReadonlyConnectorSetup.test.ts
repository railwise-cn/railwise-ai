// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfigV2 } from '@shared/agent-workbench'
import type { MarketplaceCatalogPackageEntryV1 } from '@shared/marketplace'
import { ReadonlyConnectorSetup } from './ReadonlyConnectorSetup'

let container: HTMLDivElement
let root: Root
let saved: McpServerConfigV2 | undefined
const entry = { key: 'amap', package: { id: 'amap-maps', name: '高德地图', summary: '只读地图查询' } } as unknown as MarketplaceCatalogPackageEntryV1
function checkedServer(enabled = false): McpServerConfigV2 {
  return { id: 'amap-maps-server', name: '高德', scope: 'global', transport: 'http', url: 'https://mcp.amap.com/mcp', timeoutMs: 1000, source: 'managed-tool', managedPreset: 'amap-readonly', toolPolicy: {}, enabled, revision: 2, credentialRef: { id: 'synthetic', storage: 'keychain' }, connectionCheck: {
    serverRevision: 2, credentialRefId: 'synthetic', configurationHash: 'a'.repeat(64), checkedAt: '2026-11-12T01:02:03.000Z', state: 'connected', authorized: true, verification: 'tool_discovery', toolCount: 11
  } }
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  saved = undefined
  Object.defineProperty(window, 'workwise', { configurable: true, value: {
    listMcpServers: vi.fn(async () => saved ? [saved] : []),
    saveMcpServer: vi.fn(async (request: { config: McpServerConfigV2 }) => {
      const previous = saved
      saved = { ...request.config, revision: (saved?.revision ?? 0) + 1 }
      delete saved.connectionCheck
      if (previous?.connectionCheck && !previous.enabled && saved.enabled) saved.connectionCheck = { ...previous.connectionCheck, serverRevision: saved.revision }
      return saved
    }),
    setMcpServerCredential: vi.fn(async () => { saved = { ...saved!, credentialRef: { id: 'synthetic', storage: 'session' }, revision: saved!.revision + 1 }; return saved }),
    testMcpServer: vi.fn(async () => {
      saved = { ...saved!, connectionCheck: { ...checkedServer().connectionCheck!, serverRevision: saved!.revision } }
      return { id: 'amap-maps-server', state: 'connected', authorized: true, verification: 'tool_discovery', toolCount: 11, message: '已发现 11 项只读工具。' }
    }),
    openExternal: vi.fn()
  } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, 'workwise') })
function button(text: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); if (!result) throw new Error(`Missing ${text}`); return result }

describe('read-only connection setup', () => {
  it('saves a key through protected storage, checks tools, and enables only on a separate user action', async () => {
    const changed = vi.fn()
    await act(async () => root.render(createElement(ReadonlyConnectorSetup, { entry, onClose: vi.fn(), onInstall: vi.fn(), onChanged: changed })))
    expect(window.workwise.saveMcpServer).not.toHaveBeenCalled()
    const input = container.querySelector<HTMLInputElement>('input')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'synthetic-key'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('保存并检查').click())
    expect(saved?.enabled).toBe(false)
    expect(window.workwise.setMcpServerCredential).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'synthetic-key' }))
    expect(JSON.stringify(vi.mocked(window.workwise.saveMcpServer).mock.calls)).not.toContain('synthetic-key')
    expect(input.value).toBe('')
    expect(changed).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('连接检查通过（11 项工具）')
    expect(container.querySelector('time')?.dateTime).toBe('2026-11-12T01:02:03.000Z')
    await act(async () => button('启用只读工具').click())
    expect(saved?.enabled).toBe(true)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(window.workwise.openExternal).not.toHaveBeenCalled()
  })

  it('preserves a same-name user configuration', async () => {
    saved = { id: 'amap-maps-server', name: 'User config', scope: 'global', transport: 'http', url: 'https://custom.example', timeoutMs: 5000, source: 'user', toolPolicy: {}, enabled: true, revision: 1 }
    await act(async () => root.render(createElement(ReadonlyConnectorSetup, { entry, onClose: vi.fn(), onInstall: vi.fn(), onChanged: vi.fn() })))
    await act(async () => button('检查连接').click())
    expect(container.textContent).toContain('已有配置已保留')
    expect(window.workwise.saveMcpServer).not.toHaveBeenCalled()
    expect(window.workwise.testMcpServer).not.toHaveBeenCalled()
  })

  it('restores persisted discovery after reopening and invalidates it when disabled', async () => {
    saved = checkedServer(true)
    await act(async () => root.render(createElement(ReadonlyConnectorSetup, { entry, onClose: vi.fn(), onInstall: vi.fn(), onChanged: vi.fn() })))
    expect(container.textContent).toContain('连接检查通过（11 项工具）')
    expect(container.textContent).toContain('业务调用结果见任务详情中的操作回执')
    expect(window.workwise.testMcpServer).not.toHaveBeenCalled()
    await act(async () => button('停用').click())
    expect(saved?.connectionCheck).toBeUndefined()
    expect(container.textContent).not.toContain('连接检查通过')
    expect(button('启用只读工具').disabled).toBe(true)
  })

  it('updates the parent after a failed recheck and does not retain the successful badge', async () => {
    saved = checkedServer(true)
    const changed = vi.fn()
    vi.mocked(window.workwise.testMcpServer).mockImplementation(async () => {
      saved = { ...saved!, connectionCheck: { ...saved!.connectionCheck!, state: 'error', authorized: false, errorCode: 'connection_failed' } }
      return { id: saved.id, state: 'error', authorized: false, errorCode: 'connection_failed', message: '高德连接检查失败。' }
    })
    await act(async () => root.render(createElement(ReadonlyConnectorSetup, { entry, onClose: vi.fn(), onInstall: vi.fn(), onChanged: changed })))
    await act(async () => button('检查连接').click())
    expect(container.textContent).toContain('连接检查未通过')
    expect(container.textContent).not.toContain('连接检查通过（')
    expect(changed).toHaveBeenCalledOnce()
  })
})
