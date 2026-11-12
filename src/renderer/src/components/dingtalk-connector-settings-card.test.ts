// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { DingTalkConnectorSettingsCard } from './dingtalk-connector-settings-card'

const runtime = vi.hoisted(() => ({ runtimeRequest: vi.fn() }))
vi.mock('../agent/runtime-client', () => ({ rendererRuntimeClient: runtime }))

let root: Root
let container: HTMLDivElement
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
  if (!result) throw new Error(`Missing button: ${label}`)
  return result
}
function input(label: string): HTMLInputElement | HTMLTextAreaElement {
  const result = [...container.querySelectorAll('label')].find(item => item.textContent?.includes(label))?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  if (!result) throw new Error(`Missing field: ${label}`)
  return result
}
async function changeField(label: string, value: string): Promise<void> {
  await act(async () => {
    const field = input(label)
    const setter = Object.getOwnPropertyDescriptor(field.constructor.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function click(label: string): Promise<void> {
  await act(async () => { button(label).click(); await Promise.resolve(); await Promise.resolve() })
}

describe('DingTalk connector settings', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    Object.assign(window, { workwise: { openExternal: vi.fn(async () => undefined) } })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(DingTalkConnectorSettingsCard)))
  })
  afterEach(async () => { await act(async () => root.unmount()); container.remove() })

  it('saves only explicitly selected personal todo scopes and clears the app secret', async () => {
    runtime.runtimeRequest.mockResolvedValueOnce({ ok: true, status: 200, body: '{"configured":true}' })
    await changeField('应用 Client ID', 'ding-client')
    await changeField('应用 Client Secret', 'secret-value')
    await changeField('OAuth 回调地址', 'http://127.0.0.1:8899/oauth/callback')
    await click('保存应用配置')
    expect(runtime.runtimeRequest).toHaveBeenCalledWith('/v1/connectors/dingtalk/configure', 'POST', expect.any(String))
    const body = JSON.parse(runtime.runtimeRequest.mock.calls[0]?.[2] as string)
    expect(body).toMatchObject({ clientId: 'ding-client', clientSecret: 'secret-value', userScopes: ['Todo.Todo.Read'], allowedWriteUserIds: [] })
    expect(input('应用 Client Secret').value).toBe('')
    expect(container.textContent).toContain('应用配置已安全保存')
  })

  it('keeps workflow write scope unchecked until the user explicitly selects it', () => {
    const write = [...container.querySelectorAll('label')].find(label => label.textContent?.includes('Workflow.Instance.Write'))?.querySelector('input')
    expect(write?.checked).toBe(false)
    expect(button('授权企业审批应用').disabled).toBe(true)
  })

  it('opens the official authorization URL and sends the callback only to the completion endpoint', async () => {
    runtime.runtimeRequest.mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify({ authorizationUrl: 'https://login.dingtalk.com/oauth2/auth?state=test', expiresAt: '2026-12-01T00:00:00Z' }) })
    await click('打开钉钉授权')
    expect(window.workwise.openExternal).toHaveBeenCalledWith('https://login.dingtalk.com/oauth2/auth?state=test')
    const callback = 'http://127.0.0.1:8899/oauth/callback?code=synthetic&state=synthetic'
    runtime.runtimeRequest.mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify({ unionId: 'union-1', expiresAt: '2026-12-02T00:00:00Z', status: { enabled: true, available: true, credentialState: 'valid', identityVerified: true, scopes: ['Todo.Todo.Read'], checkedAt: '2026-12-01T00:00:00Z' } }) })
    await changeField('授权完成后粘贴完整回调地址', callback)
    await click('验证授权结果')
    expect(runtime.runtimeRequest.mock.calls[1]).toEqual(['/v1/connectors/dingtalk/oauth/complete', 'POST', JSON.stringify({ callbackUrl: callback })])
    expect(container.textContent).toContain('钉钉用户身份已验证')
  })
})
