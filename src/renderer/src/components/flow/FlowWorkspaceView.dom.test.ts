// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FlowWorkspaceView, createStarterFlowInput, ScheduleConfigFields } from './FlowWorkspaceView'

let container: HTMLDivElement
let root: Root

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function runtimeResponse(body: unknown): { ok: true; status: 200; body: string } {
  return { ok: true, status: 200, body: JSON.stringify(body) }
}

beforeEach(async () => {
  let savedFlow: ReturnType<typeof createStarterFlowInput> & {
    revision: number
    createdAt: string
    updatedAt: string
  } | null = null

  class TestResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 960,
    height: 640,
    top: 0,
    right: 960,
    bottom: 640,
    left: 0,
    toJSON: () => ({})
  })

  const registry = [
    {
      type: 'manual_trigger', category: 'trigger', label: '手动触发', available: true,
      inputs: [], outputs: [{ id: 'output', label: '输出', type: 'json', required: false, multiple: false }]
    },
    {
      type: 'agent', category: 'intelligence', label: 'Agent', available: true,
      inputs: [{ id: 'input', label: '输入', type: 'json', required: true, multiple: false }],
      outputs: [{ id: 'output', label: '输出', type: 'agent_message', required: false, multiple: false }]
    }
  ]

  Object.defineProperty(window, 'workwise', {
    configurable: true,
    value: {
      runtimeRequest: vi.fn(async (path: string, method: string, body?: string) => {
        if (path === '/v1/flows' && method === 'POST') {
          const definition = JSON.parse(body ?? '{}')
          const now = '2026-08-04T00:00:00.000Z'
          savedFlow = { ...definition, revision: 1, createdAt: now, updatedAt: now }
          return runtimeResponse({ flow: savedFlow })
        }
        if (path === '/v1/flows') return runtimeResponse({ flows: savedFlow ? [savedFlow] : [], registry })
        if (path.endsWith('/history')) return runtimeResponse({ runs: [] })
        throw new Error(`Unexpected Runtime request: ${method} ${path}`)
      })
    }
  })

  container = globalThis.document.createElement('div')
  container.style.width = '1200px'
  container.style.height = '800px'
  globalThis.document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(FlowWorkspaceView, {
      leftSidebarCollapsed: false,
      onToggleLeftSidebar: vi.fn(),
      filter: 'all'
    }))
  })
  await settle()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FlowWorkspaceView mounted canvas', () => {
  it('visibly mounts both starter nodes after creating the first Flow', async () => {
    const newFlowButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '新建 Flow')
    expect(newFlowButton).toBeInstanceOf(HTMLButtonElement)

    await act(async () => {
      ;(newFlowButton as HTMLButtonElement).click()
    })
    await settle()
    await settle()

    expect(container.querySelector('[aria-label="Flow 画布"]')).not.toBeNull()
    const nodes = container.querySelectorAll('.react-flow__node')
    expect(nodes).toHaveLength(2)
    for (const node of nodes) {
      expect(getComputedStyle(node).visibility).toBe('visible')
    }
    expect(container.textContent).toContain('手动触发')
    expect(container.textContent).toContain('Agent 处理')
  })

  it('keeps a newly created scheduled starter visible in the scheduled filter', async () => {
    await act(async () => {
      root.render(createElement(FlowWorkspaceView, {
        leftSidebarCollapsed: false,
        onToggleLeftSidebar: vi.fn(),
        filter: 'scheduled'
      }))
    })
    await settle()

    const newFlowButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '新建 Flow')
    expect(newFlowButton).toBeInstanceOf(HTMLButtonElement)

    await act(async () => {
      ;(newFlowButton as HTMLButtonElement).click()
    })
    await settle()
    await settle()

    expect(container.querySelector('[aria-label="Flow 画布"]')).not.toBeNull()
    expect(container.textContent).toContain('定时触发')
    expect(container.textContent).toContain('Agent 处理')
  })
})

it('edits daily times and timezone through the fields consumed by the scheduler', async () => {
  let config: Record<string, unknown> = { kind: 'interval', everyMinutes: 15, timezone: 'Asia/Shanghai' }
  const render = async () => {
    await act(async () => root.render(createElement(ScheduleConfigFields, { config, onChange: value => { config = value } })))
  }
  await render()
  const select = container.querySelector('[aria-label="计划类型"]') as HTMLSelectElement
  await act(async () => { select.value = 'daily'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await render()
  const input = container.querySelector('[aria-label="每日执行时刻"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '08:30, 16:30')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(config).toMatchObject({ kind: 'daily', times: ['08:30', '16:30'], timezone: 'Asia/Shanghai' })
  expect(config.schedule).toBeUndefined()
})
