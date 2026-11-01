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
  plugins: 'Plugins',
  schedule: 'Scheduled tasks',
  flow: 'Flow',
  design: 'Design'
}

function props(activeRoute: ActiveRoute): ComponentProps<typeof WorkspaceSecondaryNavigation> {
  return {
    activeRoute,
    onWriteOpen: vi.fn(),
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

  it.each<ActiveRoute>(['chat', 'engineering', 'write', 'plugins', 'schedule', 'flow', 'design'])(
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
    expect(buttons).toHaveLength(5)
    for (const button of buttons) await act(async () => button.click())

    expect(callbacks.onWriteOpen).toHaveBeenCalledOnce()
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
    expect(toolsMenu).not.toContain('Plugins')
    expect(html).toContain('aria-current="page"')
    expect(html.indexOf('id="workspace-tools-menu"')).toBeLessThan(html.indexOf('Plugins'))
  })
})
