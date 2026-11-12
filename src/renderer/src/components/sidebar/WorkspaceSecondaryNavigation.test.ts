// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WorkspaceSecondaryNavigation } from './WorkspaceSecondaryNavigation'

type ActiveRoute = ComponentProps<typeof WorkspaceSecondaryNavigation>['activeRoute']

const labelsByRoute: Partial<Record<ActiveRoute, string>> = {
  write: 'Write',
  tasks: 'Tasks',
  plugins: 'Skills &amp; connectors',
  schedule: 'Scheduled tasks',
  flow: 'Flow',
  design: 'Design'
}

function props(activeRoute: ActiveRoute): ComponentProps<typeof WorkspaceSecondaryNavigation> {
  return {
    activeRoute,
    onWriteOpen: vi.fn(),
    onTasksOpen: vi.fn(),
    toolCapabilities: {
      flow: { enabled: true, available: true, status: 'available' },
      schedule: { enabled: true, available: true, status: 'available' },
      design: { enabled: true, available: true, status: 'available' }
    },
    onOpenPlugins: vi.fn(),
    onScheduleOpen: vi.fn(),
    onFlowOpen: vi.fn(),
    onDesignOpen: vi.fn()
  }
}

describe('WorkspaceSecondaryNavigation', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  })

  it.each<ActiveRoute>(['chat', 'engineering', 'tasks', 'write', 'plugins', 'schedule', 'flow', 'design'])(
    'keeps all sidebar tools available on the %s route',
    (activeRoute) => {
      const html = renderToStaticMarkup(createElement(WorkspaceSecondaryNavigation, props(activeRoute)))

      for (const label of Object.values(labelsByRoute)) expect(html).toContain(label)
      const currentLabel = labelsByRoute[activeRoute]
      expect(html.match(/aria-current="page"/g)?.length ?? 0).toBe(currentLabel ? 1 : 0)
      if (currentLabel) expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>[\\s\\S]*?${currentLabel}`))
    }
  )

  it('routes every persistent sidebar tool through its callback', async () => {
    const callbacks = props('write')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(WorkspaceSecondaryNavigation, callbacks)))
    const buttons = container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Workspace tools"] button')
    expect(buttons).toHaveLength(6)
    for (const button of buttons) await act(async () => button.click())

    expect(callbacks.onWriteOpen).toHaveBeenCalledOnce()
    expect(callbacks.onTasksOpen).toHaveBeenCalledOnce()
    expect(callbacks.onOpenPlugins).toHaveBeenCalledOnce()
    expect(callbacks.onScheduleOpen).toHaveBeenCalledOnce()
    expect(callbacks.onFlowOpen).toHaveBeenCalledOnce()
    expect(callbacks.onDesignOpen).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
    container.remove()
  })

  it('keeps Plugins visible as a sibling of the collapsible Tools group', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSecondaryNavigation, props('plugins')))
    const toolsMenu = html.match(/<div id="workspace-tools-menu"[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(toolsMenu).not.toContain('Skills &amp; connectors')
    expect(html).toContain('aria-current="page"')
    expect(html.indexOf('id="workspace-tools-menu"')).toBeLessThan(html.indexOf('Skills &amp; connectors'))
  })

  it('hides unknown and unavailable execution entries while keeping configuration discoverable', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSecondaryNavigation, {
      ...props('chat'), toolCapabilities: { flow: { enabled: true, available: false, status: 'unavailable' } }
    }))
    expect(html).not.toContain('workspace-tools-menu')
    expect(html).toContain('Skills &amp; connectors')
    expect(html).toContain('Write')
  })

  it('preserves an unavailable deep-linked surface without advertising other tools', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSecondaryNavigation, { ...props('flow'), toolCapabilities: undefined }))
    expect(html).toContain('Flow')
    expect(html).not.toContain('Scheduled tasks')
    expect(html).not.toContain('>Design<')
  })
})
