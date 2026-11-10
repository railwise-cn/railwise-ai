// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import i18n from '../../i18n'
import { ConnectorCatalog } from './ConnectorCatalog'

const mocks = vi.hoisted(() => ({ runtimeRequest: vi.fn(), lark: vi.fn(), ding: vi.fn() }))
vi.mock('../../agent/runtime-client', () => ({ rendererRuntimeClient: { runtimeRequest: mocks.runtimeRequest } }))
vi.mock('./ManagedLarkConnection', () => ({ ManagedLarkConnection: (props: unknown) => { mocks.lark(props); return createElement('section', {}, 'Official Feishu connection flow') } }))
vi.mock('./ManagedDingTalkConnection', () => ({ ManagedDingTalkConnection: (props: unknown) => { mocks.ding(props); return createElement('section', {}, 'Official DingTalk connection flow') } }))
vi.mock('../dingtalk-connector-settings-card', () => ({ DingTalkConnectorSettingsCard: () => createElement('section', {}, 'Advanced DingTalk configuration') }))

let root: Root
let container: HTMLDivElement
let props: ComponentProps<typeof ConnectorCatalog>
const diagnose = vi.fn()

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function render(): Promise<void> { await act(async () => { root.render(createElement(ConnectorCatalog, props)); await Promise.resolve(); await Promise.resolve() }) }
async function click(label: string): Promise<void> { await act(async () => { button(label).click(); await Promise.resolve(); await Promise.resolve() }) }

beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  mocks.runtimeRequest.mockResolvedValue({ ok: false, status: 503, body: '{}' })
  diagnose.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'not_installed' } })
  Object.defineProperty(window, 'workwise', { configurable: true, value: { diagnoseManagedTool: diagnose } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  props = { entries: [], query: '', name: entry => entry.package.name, summary: entry => entry.package.summary, status: () => 'Configured · verification pending', onDetails: vi.fn(), onRefresh: vi.fn() }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, 'workwise') })

describe('ConnectorCatalog', () => {
  it('keeps independent native connectors reachable offline without claiming authorization or asking for accounts', async () => {
    await render()
    expect(container.textContent).toContain('Feishu / Lark')
    expect(container.textContent).toContain('DingTalk')
    expect(container.textContent).toContain('Dependency installation required')
    expect(container.textContent).toContain('Connection not verified')
    expect(container.textContent).not.toContain('Verified capabilities available')
    expect(container.querySelector('input')).toBeNull()
    expect(diagnose).toHaveBeenCalledWith('lark-cli')
    expect(mocks.runtimeRequest).toHaveBeenCalledWith('/v1/runtime/info')
  })

  it('shows a clear capability boundary and only starts connection from an explicit Connect click', async () => {
    await render()
    await click('View Feishu / Lark connection')
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(container.textContent).toContain('Connecting an account does not approve business actions')
    expect(mocks.lark.mock.lastCall?.[0]).toMatchObject({ autoConnect: false, initialState: 'not_installed' })
    await click('Close connector details')
    await click('Connect')
    expect(mocks.lark.mock.lastCall?.[0]).toMatchObject({ autoConnect: true })
    expect(container.textContent).toContain('Official Feishu connection flow')
  })

  it('requires Runtime capability and identity evidence instead of equating installation with authorization', async () => {
    diagnose.mockResolvedValue({ ok: true, status: { id: 'lark-cli', state: 'installed' } })
    mocks.runtimeRequest.mockResolvedValue({ ok: true, status: 200, body: JSON.stringify({ capabilities: { lark: { enabled: true, available: false, authState: 'installed' }, dingtalk: { enabled: true, available: true, credentialState: 'valid', identityVerified: false } } }) })
    await render()
    expect(container.textContent).not.toContain('Verified capabilities available')
    mocks.runtimeRequest.mockResolvedValue({ ok: true, status: 200, body: JSON.stringify({ capabilities: { lark: { enabled: true, available: true, authState: 'installed' }, dingtalk: { enabled: true, available: true, credentialState: 'valid', identityVerified: true } } }) })
    await click('Check connections')
    expect(container.textContent?.match(/Verified capabilities available/g)).toHaveLength(1)
    expect(container.textContent).toContain('Login saved · task access untested')
    mocks.runtimeRequest.mockResolvedValue({ ok: false, status: 503, body: '{}' })
    await click('Check connections')
    expect(container.textContent).not.toContain('Verified capabilities available')
    expect(container.textContent).not.toContain('Login saved · task access untested')
  })

  it('opens a one-shot provider deep link without starting authorization', async () => {
    props.target = 'dingtalk'
    props.onTargetOpened = vi.fn()
    await render()
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('DingTalk')
    expect(mocks.ding.mock.lastCall?.[0]).toMatchObject({ autoConnect: false })
    expect(mocks.lark).not.toHaveBeenCalled()
    expect(props.onTargetOpened).toHaveBeenCalledOnce()
    props.target = null
    await render()
    await click('Close connector details')
    await render()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(props.onTargetOpened).toHaveBeenCalledOnce()
    props.target = 'lark'
    await render()
    expect(container.querySelector('[role="dialog"] h2')?.textContent).toBe('Feishu / Lark')
    expect(mocks.lark.mock.lastCall?.[0]).toMatchObject({ autoConnect: false })
    expect(props.onTargetOpened).toHaveBeenCalledTimes(2)
  })

  it('keeps original Lark package management reachable from the native connection details', async () => {
    const entry = { key: 'official:lark-openapi-mcp', sourceId: 'official', conflicted: false, package: { id: 'lark-openapi-mcp', name: 'Lark OpenAPI MCP', summary: 'Original managed package.', publisher: { name: 'Lark' } } } as ComponentProps<typeof ConnectorCatalog>['entries'][number]
    props.entries = [entry]
    await render()
    expect(container.textContent).not.toContain('Lark OpenAPI MCP')
    await click('View Feishu / Lark connection')
    const advanced = container.querySelector('details')
    expect(advanced?.querySelector('summary')?.textContent).toBe('Advanced package management')
    await act(async () => advanced?.querySelector('summary')?.click())
    await click('Manage Lark OpenAPI MCP package')
    expect(props.onDetails).toHaveBeenCalledWith(entry)
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.lark.mock.calls.every(([value]) => !value.autoConnect)).toBe(true)
  })

  it('keeps generic catalog authorization unverified and delegates to existing package details', async () => {
    const entry = { key: 'test:service', sourceId: 'test', conflicted: false, package: { id: 'service', name: 'Research Service', summary: 'Read research resources.', publisher: { name: 'Example' } } } as ComponentProps<typeof ConnectorCatalog>['entries'][number]
    props.entries = [entry]
    await render()
    expect(container.textContent).toContain('Configured · verification pending')
    await click('View Research Service connection')
    expect(props.onDetails).toHaveBeenCalledWith(entry)
    props.query = '钉钉'
    await render()
    expect(container.textContent).toContain('DingTalk')
    expect(container.textContent).not.toContain('Research Service')
    expect(container.textContent).not.toContain('Feishu / Lark')
  })
})
