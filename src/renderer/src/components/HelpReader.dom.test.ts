// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HelpReader } from './HelpReader'

vi.mock('../write/write-advanced-rendering', () => ({
  renderWriteAdvancedPreview: () => '<h2>控制网基准确认</h2><p>保留原始观测，再确认基准。</p><h3>成果复核</h3><p>检查计算记录。</p>',
  hydrateWriteAdvancedDiagrams: async () => undefined
}))
let root: Root
let container: HTMLDivElement
let width: number
const callbacks = new Set<ResizeObserverCallback>()
async function resize(next: number): Promise<void> {
  width = next
  await act(async () => { for (const callback of callbacks) callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver) })
}
async function settle(): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  width = 1000
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) { callbacks.add(callback) }
    observe(): void { this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect(): void { callbacks.delete(this.callback) }
  })
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(createElement(HelpReader)))
  await settle()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); callbacks.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('collapses the outline by available reader width while retaining the same article and search input', async () => {
  const article = container.querySelector('.ds-help-article'), search = container.querySelector('input')
  const outline = container.querySelector('details')!
  expect(outline.open).toBe(true)
  await resize(520)
  expect(outline.open).toBe(false)
  expect(container.querySelector('.ds-help-article')).toBe(article)
  expect(container.querySelector('input')).toBe(search)
  await act(async () => { outline.open = true; outline.dispatchEvent(new Event('toggle')) })
  expect(outline.open).toBe(true)
  const heading = [...container.querySelectorAll('nav button')].find(button => button.textContent === '成果复核')!
  await act(async () => (heading as HTMLButtonElement).click())
  await settle()
  expect(outline.open).toBe(false)
  expect(container.querySelector('.ds-help-article')).toBe(article)
  await resize(1000)
  expect(outline.open).toBe(true)
})

it('keeps Chinese full-text search intact while the available width changes', async () => {
  const search = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, '基准')
    search.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(container.querySelector('[aria-label="帮助搜索结果"]')).not.toBeNull()
  await resize(520)
  expect(search.value).toBe('基准')
  expect(container.querySelector('[aria-label="帮助搜索结果"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="帮助搜索结果"] button')).not.toBeNull()
  await resize(1000)
  expect(search.value).toBe('基准')
})
