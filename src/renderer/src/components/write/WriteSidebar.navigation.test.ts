// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { WriteSidebar } from './WriteSidebar'

let container: HTMLDivElement
let root: Root
const originalLoadWriteSettings = useWriteWorkspaceStore.getState().loadWriteSettings

function createProps(): ComponentProps<typeof WriteSidebar> {
  return {
    navigationRoute: 'write',
    connectPhoneSidebarOpen: false,
    focusModeEnabled: false,
    onCodeOpen: vi.fn(),
    onEngineeringOpen: vi.fn(),
    onWriteOpen: vi.fn(),
    onOpenPlugins: vi.fn(),
    onScheduleOpen: vi.fn(),
    onFlowOpen: vi.fn(),
    onDesignOpen: vi.fn(),
    onNewRequirement: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleFocusMode: vi.fn(),
    onToggleConnectPhone: vi.fn(),
    onToggleSidebar: vi.fn()
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  useWriteWorkspaceStore.getState().resetWorkspace()
  useWriteWorkspaceStore.setState({ loadWriteSettings: vi.fn(async () => undefined) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useWriteWorkspaceStore.getState().resetWorkspace()
  useWriteWorkspaceStore.setState({ loadWriteSettings: originalLoadWriteSettings })
})

describe('WriteSidebar navigation', () => {
  it('keeps the two primary entries and all five sidebar tools visible and clickable', async () => {
    const sidebarProps = createProps()
    await act(async () => root.render(createElement(WriteSidebar, sidebarProps)))

    const primaryButtons = container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Code / Survey"] button')
    const toolButtons = container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Workspace tools"] button')
    expect([...primaryButtons].map((button) => button.textContent)).toEqual(['Code', 'Survey'])
    expect([...toolButtons].map((button) => button.textContent)).toEqual([
      'Write',
      'Scheduled tasks',
      'Flow',
      'Design',
      'Plugins'
    ])
    expect(toolButtons[0]?.getAttribute('aria-current')).toBe('page')

    for (const button of primaryButtons) await act(async () => button.click())
    for (const button of toolButtons) await act(async () => button.click())

    expect(sidebarProps.onCodeOpen).toHaveBeenCalledOnce()
    expect(sidebarProps.onEngineeringOpen).toHaveBeenCalledOnce()
    expect(sidebarProps.onWriteOpen).toHaveBeenCalledOnce()
    expect(sidebarProps.onOpenPlugins).toHaveBeenCalledOnce()
    expect(sidebarProps.onScheduleOpen).toHaveBeenCalledOnce()
    expect(sidebarProps.onFlowOpen).toHaveBeenCalledOnce()
    expect(sidebarProps.onDesignOpen).toHaveBeenCalledOnce()
  })
})
