// @vitest-environment happy-dom

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { CoreRuntimeCapabilityManifestJson, CoreRuntimeCapabilityStateJson } from '../agent/runtime-contract'
import i18n from '../i18n'
import { isWorkbenchCapabilityAvailable, WorkbenchCapabilityBoundary } from './WorkbenchCapabilityBoundary'

const available: CoreRuntimeCapabilityStateJson = { status: 'available', enabled: true, available: true }

function manifest(route: 'flow' | 'design' | 'schedule', state: CoreRuntimeCapabilityStateJson): CoreRuntimeCapabilityManifestJson {
  return { workspaces: { [route]: state } } as CoreRuntimeCapabilityManifestJson
}

let container: HTMLDivElement
let root: Root
let mounted: Mock<() => void>
let unmounted: Mock<() => void>
let onSettings: Mock<() => void>
let onPlugins: Mock<() => void>
let onRefresh: Mock<() => void>

function ExecutableWorkspace(): ReturnType<typeof createElement> {
  useEffect(() => {
    mounted()
    return () => { unmounted() }
  }, [])
  return createElement('div', { 'data-testid': 'executable-workspace' }, 'Executable workspace')
}

async function renderBoundary({
  route = 'design',
  capabilities,
  runtimeReady = true,
  refreshing = false
}: {
  route?: string
  capabilities?: CoreRuntimeCapabilityManifestJson | null
  runtimeReady?: boolean
  refreshing?: boolean
} = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkbenchCapabilityBoundary, {
      route, capabilities, runtimeReady, refreshing, onSettings, onPlugins, onRefresh,
      children: createElement(ExecutableWorkspace)
    }))
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mounted = vi.fn()
  unmounted = vi.fn()
  onSettings = vi.fn()
  onPlugins = vi.fn()
  onRefresh = vi.fn()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  await i18n.changeLanguage('en')
  vi.restoreAllMocks()
})

describe('Workbench capability deep links', () => {
  it.each(['flow', 'design', 'schedule'] as const)('does not mount %s until the runtime verifies availability', async (route) => {
    await renderBoundary({ route })
    expect(mounted).not.toHaveBeenCalled()
    expect(container.textContent).toContain('运行时尚未确认')

    await renderBoundary({ route, capabilities: manifest(route, available) })
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="executable-workspace"]')).not.toBeNull()

    await renderBoundary({ route, capabilities: manifest(route, available), runtimeReady: false })
    expect(unmounted).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="executable-workspace"]')).toBeNull()
    expect(container.textContent).toContain('请先连接运行时')
  })

  it.each([
    { status: 'disabled', enabled: false, available: true },
    { status: 'unavailable', enabled: true, available: false },
    { status: 'available', enabled: false, available: true },
    { status: 'available', enabled: true, available: false },
    { status: 'unavailable', enabled: true, available: true }
  ] as CoreRuntimeCapabilityStateJson[])('rejects inconsistent or blocked capability %j', async (state) => {
    await renderBoundary({ capabilities: manifest('design', state) })
    expect(mounted).not.toHaveBeenCalled()
    expect(container.textContent).toContain('设计当前不可用')
    expect(container.querySelector('[data-testid="executable-workspace"]')).toBeNull()
  })

  it('shows the blocking reason and working configuration and refresh actions', async () => {
    await renderBoundary({ capabilities: manifest('flow', {
      status: 'unavailable', enabled: true, available: false, reason: '尚未配置可用模型'
    }), route: 'flow' })
    expect(container.textContent).toContain('尚未配置可用模型')
    for (const label of ['打开设置', '打开插件', '刷新可用状态']) {
      const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label)
      expect(button).toBeDefined()
      await act(async () => { button!.click() })
    }
    expect(onSettings).toHaveBeenCalledTimes(1)
    expect(onPlugins).toHaveBeenCalledTimes(1)
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(mounted).not.toHaveBeenCalled()
  })

  it('disables repeated refresh while a runtime check is in progress', async () => {
    await renderBoundary({ runtimeReady: false, refreshing: true })
    const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === '正在核验…')
    expect(button?.disabled).toBe(true)
    button?.click()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('keeps ungated workspaces accessible without a capability manifest', async () => {
    await renderBoundary({ route: 'tasks', runtimeReady: false })
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="executable-workspace"]')).not.toBeNull()
  })

  it('uses the same fail-closed check for activation and mounting', () => {
    expect(isWorkbenchCapabilityAvailable({ route: 'flow', capabilities: null, runtimeReady: true })).toBe(false)
    expect(isWorkbenchCapabilityAvailable({ route: 'design', capabilities: manifest('design', available), runtimeReady: false })).toBe(false)
    expect(isWorkbenchCapabilityAvailable({ route: 'schedule', capabilities: manifest('schedule', available), runtimeReady: true })).toBe(true)
    expect(isWorkbenchCapabilityAvailable({ route: 'plugins', runtimeReady: false })).toBe(true)
  })
})
