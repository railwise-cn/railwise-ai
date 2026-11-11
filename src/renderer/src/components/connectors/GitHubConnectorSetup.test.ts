// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfigV2 } from '@shared/agent-workbench'
import { GITHUB_MCP_READONLY_URL, GITHUB_MCP_URL, GITHUB_TOKEN_CREATE_URL } from '@shared/github-connector'
import { GitHubConnectorSetup } from './GitHubConnectorSetup'

const runtimeRequest = vi.hoisted(() => vi.fn())
vi.mock('../../agent/runtime-client', () => ({ rendererRuntimeClient: { runtimeRequest } }))
let container: HTMLDivElement
let root: Root
let saved: McpServerConfigV2 | undefined
let changed = vi.fn<() => void>()
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  saved = undefined; changed = vi.fn()
  runtimeRequest.mockImplementation(async () => ({ ok: true, body: JSON.stringify({ mcpServers: saved ? [{ id: saved.id, enabled: saved.enabled, status: saved.enabled ? 'connected' : 'disabled', available: saved.enabled, toolCount: saved.enabled ? 2 : 0 }] : [] }) }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: {
    listMcpServers: vi.fn(async () => saved ? [saved] : []),
    saveMcpServer: vi.fn(async (request: { config: McpServerConfigV2 }) => { saved = { ...request.config, revision: (saved?.revision ?? 0) + 1 }; return saved }),
    setMcpServerCredential: vi.fn(async () => { saved = { ...saved!, credentialRef: { id: 'synthetic', storage: 'dpapi' }, revision: saved!.revision + 1 }; return saved }),
    testMcpServer: vi.fn(async () => ({ id: 'github-mcp', state: 'connected', authorized: true, toolCount: 2, message: '检查通过' })),
    authorizeMcpServer: vi.fn(), openExternal: vi.fn(async () => undefined)
  } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, 'workwise') })
function button(text: string) { const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text); if (!found) throw new Error(`Missing ${text}`); return found }
async function render() { await act(async () => root.render(createElement(GitHubConnectorSetup, { onClose: vi.fn(), onChanged: changed, onAdvanced: vi.fn() }))) }
async function typeToken(value = 'synthetic-token') {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('GitHub connection setup', () => {
  it('opens actionable scope guidance without starting OAuth or changing configuration', async () => {
    await render()
    expect(container.textContent).toContain('具体仓库')
    expect(container.textContent).toContain('有效期')
    expect(button('检查连接').disabled).toBe(true)
    expect(window.workwise.saveMcpServer).not.toHaveBeenCalled()
    expect(window.workwise.authorizeMcpServer).not.toHaveBeenCalled()
    await act(async () => button('在 GitHub 创建令牌').click())
    expect(window.workwise.openExternal).toHaveBeenCalledWith(GITHUB_TOKEN_CREATE_URL)
  })

  it('securely saves a new read-only connection and separately enables its actual Runtime tools', async () => {
    await render(); await typeToken()
    await act(async () => button('保存并检查').click())
    expect(saved).toMatchObject({ url: GITHUB_MCP_READONLY_URL, enabled: false })
    expect(window.workwise.setMcpServerCredential).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'synthetic-token' }))
    expect(JSON.stringify(vi.mocked(window.workwise.saveMcpServer).mock.calls)).not.toContain('synthetic-token')
    expect(container.querySelector<HTMLInputElement>('input')!.value).toBe('')
    expect(container.textContent).toContain('认证检查通过，等待应用到任务')
    await act(async () => button('启用任务工具').click())
    expect(saved?.enabled).toBe(true)
    expect(container.textContent).toContain('任务工具已就绪 · 2 项')
    expect(window.workwise.authorizeMcpServer).not.toHaveBeenCalled()
  })

  it('retains existing OAuth, tool policy and credential references when checking and reapplying', async () => {
    saved = { id: 'github-imported', name: 'My GitHub', scope: 'global', transport: 'http', url: GITHUB_MCP_URL, timeoutMs: 1000,
      source: 'user', enabled: false, revision: 3, toolPolicy: { issue_write: 'ask' }, credentialRef: { id: 'existing-ref', storage: 'keychain' },
      oauth: { clientId: 'own-app', redirectUri: 'http://127.0.0.1:17864/oauth/callback', scopes: ['repo'] } }
    const previous = structuredClone(saved)
    await render()
    await act(async () => button('检查连接').click())
    expect(window.workwise.setMcpServerCredential).not.toHaveBeenCalled()
    await act(async () => button('启用任务工具').click())
    expect(saved).toMatchObject({ ...previous, revision: 4, enabled: true })
  })

  it('does not offer enable after a credential or network failure', async () => {
    vi.mocked(window.workwise.testMcpServer).mockResolvedValue({ id: 'github-mcp', state: 'needs_authorization', authorized: false, errorCode: 'insufficient_scope', message: '请核对仓库范围和组织批准' })
    await render(); await typeToken()
    await act(async () => button('保存并检查').click())
    expect(button('启用任务工具').disabled).toBe(true)
    expect(container.textContent).toContain('insufficient_scope')
    expect(saved?.enabled).toBe(false)
  })
})
