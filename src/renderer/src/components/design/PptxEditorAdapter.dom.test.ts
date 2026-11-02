// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { PptxEditorAdapter, type NativePptxController } from './PptxEditorAdapter'
const { createPptxViewerMock, loadPresentationMock, revokeMock } = vi.hoisted(() => ({ createPptxViewerMock: vi.fn(), loadPresentationMock: vi.fn(), revokeMock: vi.fn() }))
vi.mock('pptx-vanilla-viewer', () => ({
  createPptxViewer: createPptxViewerMock,
  loadPresentation: loadPresentationMock,
  revokeBlobUrls: revokeMock,
  exportSlideToSvg: vi.fn(() => '<svg/>'),
  vermilionLightTheme: { colors: { background: '#fbfaf7' }, radius: '0.375rem' },
  vermilionDarkTheme: { colors: { background: '#0f1113' }, radius: '0.375rem' },
}))
vi.mock('./NativePptxAssistant', () => ({ NativePptxAssistant: () => null }))
let container: HTMLDivElement
let root: Root
const slide = { id: 'slide1', elements: [{ id: 'text1', type: 'text', text: 'Edited', x: 0, y: 0, width: 100, height: 50 }] }
function props(overrides: Partial<ComponentProps<typeof PptxEditorAdapter>> = {}) {
  return { documentName: 'Deck.pptx', documentId: 'doc_test', workspaceRoot: '/tmp/workspace', expectedSourceSha256: 'a'.repeat(64), slidesRailOpen: true, panelsOpen: false, onUseCanvas: vi.fn(), onToggleSlides: vi.fn(), onTogglePanels: vi.fn(), ...overrides }
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
function mockApi() {
  const api = { readDesignPptxRevision: vi.fn().mockResolvedValue({ ok: true, revision: { kind: 'source', sha256: 'a'.repeat(64), byteSize: 32 }, bytes: new Uint8Array([80, 75]) }), saveDesignPptxRevision: vi.fn().mockResolvedValue({ ok: true, revision: { kind: 'edited', sha256: 'b'.repeat(64), byteSize: 40 } }), exportDesignPptxBytes: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/Deck.pptx' }) }
  Object.defineProperty(window, 'workwise', { configurable: true, value: api })
  return api
}
function mockViewer() {
  const viewer = { save: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), getSlideCount: vi.fn(() => 1), getSlides: vi.fn(() => [slide]), getActiveSlide: vi.fn(() => slide), getCurrentSlide: vi.fn(() => 0), getSelectedElementIds: vi.fn(() => []), setPanelVisible: vi.fn(), setTheme: vi.fn(), goToSlide: vi.fn(), isDirty: vi.fn(() => false), destroy: vi.fn(), updateElements: vi.fn(), undo: vi.fn(), redo: vi.fn(), addSlide: vi.fn(), moveSlide: vi.fn(), deleteSlides: vi.fn() }
  createPptxViewerMock.mockImplementation((host, options) => {
    expect(host).toBeInstanceOf(HTMLDivElement)
    expect(host.isConnected).toBe(true)
    queueMicrotask(() => options.onLoad?.({ slideCount: 1, canvasSize: { width: 1280, height: 720 } }))
    return viewer
  })
  return viewer
}
beforeEach(async () => {
  await i18n.changeLanguage('en')
  document.documentElement.dataset.theme = 'light'
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  loadPresentationMock.mockResolvedValue({ slides: [slide], blobUrls: [], handler: { dispose: vi.fn() } })
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  delete document.documentElement.dataset.theme
  Object.defineProperty(window, 'workwise', { configurable: true, value: undefined })
  vi.clearAllMocks()
})
const settle = async () => { await act(async () => new Promise((resolve) => setTimeout(resolve, 0))) }

describe('PPTX native workspace', () => {
  it('follows the RailWise light/dark theme and updates the live viewer chrome', async () => {
    mockApi()
    const viewer = mockViewer()
    await act(async () => root.render(createElement(PptxEditorAdapter, props())))
    await settle()
    const options = createPptxViewerMock.mock.calls[0][1]
    expect(options.theme.colors.background).toBe('#fbfaf7')
    await act(async () => { document.documentElement.dataset.theme = 'dark'; await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(viewer.setTheme).toHaveBeenCalledWith(expect.objectContaining({ colors: expect.objectContaining({ background: '#0f1113' }) }))
    await act(async () => { document.documentElement.dataset.theme = 'light'; await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(viewer.setTheme).toHaveBeenLastCalledWith(expect.objectContaining({ colors: expect.objectContaining({ background: '#fbfaf7' }) }))
  })

  it('mounts a connected host and checks semantic readback before persisting edits', async () => {
    const api = mockApi(); const viewer = mockViewer()
    let controller: NativePptxController | null = null
    await act(async () => root.render(createElement(PptxEditorAdapter, props({ onControllerReady: (value) => { controller = value } }))))
    await settle()
    expect(createPptxViewerMock).toHaveBeenCalledOnce()
    const options = createPptxViewerMock.mock.calls[0][1]
    expect(options.allowExternalContent).toBe(false); expect(options.googleFonts).toBe(false)
    expect(options.messages['zh-CN']).toBeTruthy()
    await act(async () => { await controller!.save() })
    expect(viewer.save).toHaveBeenCalledOnce()
    expect(loadPresentationMock).toHaveBeenCalledBefore(api.saveDesignPptxRevision)
    expect(api.saveDesignPptxRevision).toHaveBeenCalledWith(expect.objectContaining({ expectedSha256: 'a'.repeat(64), documentId: 'doc_test' }))
    await act(async () => { await controller!.exportPptx() })
    expect(api.exportDesignPptxBytes).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: '/tmp/workspace', documentId: 'doc_test', expectedSlideCount: 1 }))
  })
  it('keeps the prior revision when rereading loses edited text', async () => {
    const api = mockApi(); mockViewer()
    loadPresentationMock.mockResolvedValue({ slides: [{ ...slide, elements: [{ ...slide.elements[0], text: 'lost' }] }], blobUrls: [], handler: { dispose: vi.fn() } })
    await act(async () => root.render(createElement(PptxEditorAdapter, props())))
    await settle()
    await act(async () => button('Save').click())
    expect(api.saveDesignPptxRevision).not.toHaveBeenCalled()
    expect(container.textContent).toContain('round-trip changed')
  })
  it('keeps native edits dirty when another edit arrives during a held persistence request', async () => {
    const api = mockApi(); mockViewer()
    let resolveSave!: (value: unknown) => void
    api.saveDesignPptxRevision.mockImplementation(() => new Promise((done) => { resolveSave = done }))
    let controller: NativePptxController | null = null
    await act(async () => root.render(createElement(PptxEditorAdapter, props({ onControllerReady: (value) => { controller = value } })))); await settle()
    let pending!: Promise<boolean>
    await act(async () => { pending = controller!.save(); await Promise.resolve() })
    await settle()
    const options = createPptxViewerMock.mock.calls[0][1]
    expect(controller!.isDirty()).toBe(true)
    // A viewer reset-to-clean callback during serialization is not persistence.
    await act(async () => options.onDirtyChange(false))
    expect(controller!.isDirty()).toBe(true)
    await act(async () => { options.onChange(); options.onDirtyChange(true) })
    await act(async () => resolveSave({ ok: true, revision: { kind: 'edited', sha256: 'b'.repeat(64), byteSize: 40 } }))
    await expect(pending).resolves.toBe(false)
    expect(controller!.isDirty()).toBe(true)
  })
  it('opens the immutable original in a separate readonly viewer and synchronizes by source identity', async () => {
    const api = mockApi(); const viewer = mockViewer()
    await act(async () => root.render(createElement(PptxEditorAdapter, props())))
    await settle()
    await act(async () => button('Reference').click()); await settle()
    expect(api.readDesignPptxRevision).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'source' }))
    expect(createPptxViewerMock.mock.calls[1][1]).toEqual(expect.objectContaining({ readOnly: true, editable: false, allowExternalContent: false }))
    expect(viewer.goToSlide).toHaveBeenCalledWith(0)
    expect(container.textContent).toContain('Original PPTX')
    expect(container.querySelector('[data-pptx-display-mode="reference"] img')).toBeNull()
  })
  it('delegates native rail and inspector visibility and shows all diagnostic reasons', async () => {
    mockApi(); const viewer = mockViewer()
    await act(async () => root.render(createElement(PptxEditorAdapter, props({ diagnostics: [{ code: 'font', severity: 'warning', message: 'Font missing', pageNumber: 38 }] }))))
    await settle()
    expect(viewer.setPanelVisible).toHaveBeenCalledWith('slidesPane', true)
    expect(viewer.setPanelVisible).toHaveBeenCalledWith('inspector', false)
    await act(async () => button('Diagnostics').click())
    expect(container.querySelector('[data-testid="pptx-adapter-diagnostics"]')?.textContent).toContain('Font missing')
  })
  it('refuses a source hash mismatch without creating an editor', async () => {
    mockApi(); mockViewer()
    await act(async () => root.render(createElement(PptxEditorAdapter, props({ expectedSourceSha256: 'c'.repeat(64) }))))
    await settle()
    expect(createPptxViewerMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="pptx-native-unavailable"]')).not.toBeNull()
  })
})
