// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WriteWorkspaceStart } from './WriteWorkspaceStart'

let container: HTMLDivElement
let root: Root

function props(overrides: Partial<ComponentProps<typeof WriteWorkspaceStart>> = {}): ComponentProps<typeof WriteWorkspaceStart> {
  return {
    onAskAssistant: vi.fn(),
    onCreateDraft: vi.fn(),
    onCreatePresentation: vi.fn(),
    onPickWorkspace: vi.fn(),
    onRefreshWorkspace: vi.fn(),
    workspaceName: 'write_workspace',
    workspacePathLabel: '/tmp/write_workspace',
    ...overrides
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('WriteWorkspaceStart', () => {
  it('collects a brief before starting an outline or draft', async () => {
    const next = props()
    await act(async () => root.render(createElement(WriteWorkspaceStart, next)))

    const inputs = container.querySelectorAll<HTMLInputElement>('input')
    const materials = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[0], 'Prepare a monitoring plan')
      inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(materials, 'Tender PDF and baseline report')
      materials.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    await act(async () => buttons.find((button) => button.textContent?.includes('Draft an outline'))?.click())
    const onAskAssistant = vi.mocked(next.onAskAssistant)
    expect(onAskAssistant).toHaveBeenCalledOnce()
    expect(onAskAssistant.mock.calls[0]?.[0]).toContain('Prepare a monitoring plan')
    expect(onAskAssistant.mock.calls[0]?.[0]).toContain('Tender PDF and baseline report')
    await act(async () => buttons.find((button) => button.textContent?.includes('Draft from materials'))?.click())
    expect(onAskAssistant.mock.calls[1]?.[0]).toContain('Read the referenced materials')
    expect(onAskAssistant.mock.calls[1]?.[0]).toContain('Tender PDF and baseline report')
    await act(async () => buttons.find((button) => button.textContent?.includes('Start the draft'))?.click())
    expect(next.onCreateDraft).toHaveBeenCalledWith(expect.stringContaining('Prepare a monitoring plan'))
  })

  it('lists supported workspace materials and inserts a selected file reference', async () => {
    const next = props()
    const directoryResults = [
      {
        ok: true,
        root: '/tmp/write_workspace',
        entries: [
          { name: 'report.md', path: 'report.md', type: 'file' },
          { name: 'notes.exe', path: 'notes.exe', type: 'file' },
          { name: 'reports', path: 'reports', type: 'directory' }
        ]
      },
      {
        ok: true,
        root: '/tmp/write_workspace/reports',
        entries: [{ name: 'baseline.pdf', path: 'reports/baseline.pdf', type: 'file' }]
      }
    ]
    const listWorkspaceDirectory = vi.fn(async () => directoryResults.shift()!)
    Object.defineProperty(window, 'workwise', {
      configurable: true,
      value: { listWorkspaceDirectory }
    })
    await act(async () => root.render(createElement(WriteWorkspaceStart, next)))

    const chooseButton = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Choose from workspace'))
    expect(chooseButton).toBeDefined()
    await act(async () => chooseButton!.click())

    expect(listWorkspaceDirectory).toHaveBeenCalledTimes(2)
    const select = container.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'report.md', 'reports/baseline.pdf'])
    expect([...select.options].some((option) => option.value.endsWith('.exe'))).toBe(false)

    await act(async () => {
      select.value = 'reports/baseline.pdf'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('@reports/baseline.pdf')
  })
})
