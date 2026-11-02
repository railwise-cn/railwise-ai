// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesignDocument } from '@shared/design-document'
import type { DesignDocumentSaveResult } from '@shared/design-workspace'
import AppShell from './AppShell'
import { useChatStore } from './store/chat-store'
import { useDesignWorkspaceStore } from './design/design-workspace-store'
import { useWriteWorkspaceStore } from './write/write-workspace-store'
import { preflightAndInstallGuiUpdate } from './lib/gui-update-install-preflight'
import { DesignWorkspaceView } from './components/design/DesignWorkspaceView'

const native = vi.hoisted(() => ({ dirty: false, unmounts: 0, save: vi.fn(async () => true), dirtyChange: null as null | ((dirty: boolean) => void) }))
vi.mock('./components/design/PptxEditorAdapter', () => ({ PptxEditorAdapter: ({ onControllerReady, onDirtyChange }: {
  onControllerReady: (controller: unknown) => void; onDirtyChange: (dirty: boolean) => void
}) => {
  native.dirtyChange = onDirtyChange
  useEffect(() => {
    onControllerReady({ save: native.save, isDirty: () => native.dirty })
    return () => { native.unmounts += 1; onControllerReady(null) }
  }, [onControllerReady])
  return createElement('div', { 'data-testid': 'native-editor' }, 'Native editor')
} }))
vi.mock('./components/Workbench', () => ({ Workbench: () => {
  const route = useChatStore((s) => s.route)
  const workspaceRoot = useChatStore((s) => s.workspaceRoot)
  return route === 'design' ? createElement(DesignWorkspaceView, {
    leftSidebarCollapsed: false, onToggleLeftSidebar: () => undefined, onOpenWrite: () => undefined, workspaceRoot
  }) : createElement('div', null, 'Other workbench')
} }))
const update = vi.hoisted(() => ({ attempt: null as Promise<unknown> | null }))
vi.mock('./components/SettingsView', () => ({ SettingsView: () => createElement('button', {
  'data-testid': 'install', onClick: () => { update.attempt = preflightAndInstallGuiUpdate() }
}, 'Restart and update') }))
vi.mock('./components/InitialSetupDialog', () => ({ InitialSetupDialog: () => null }))

const workspaceRoot = '/tmp/app-shell-design-safety'
const originalBoot = useChatStore.getState().boot
let root: Root
let container: HTMLDivElement
function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value: T) => resolve(value) }
}
async function settle() { await act(async () => { await new Promise((done) => setTimeout(done, 0)) }) }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  useWriteWorkspaceStore.getState().resetWorkspace()
  useDesignWorkspaceStore.setState({ workspaceRoot: '', guiUpdateInstallPending: false })
  useDesignWorkspaceStore.getState().closeDocument()
  useChatStore.setState({ route: 'design', workspaceRoot, initialSetupOpen: false, boot: vi.fn(async () => undefined), error: null })
  native.dirty = false; native.unmounts = 0; native.dirtyChange = null; native.save.mockReset().mockResolvedValue(true)
  update.attempt = null
  const document = createDesignDocument({ name: 'Synthetic board' })
  Object.defineProperty(window, 'workwise', { configurable: true, value: {
    platform: 'darwin', getAppVersion: vi.fn(async () => '0.5.4'),
    preflightGuiUpdateInstall: vi.fn(async () => ({ ok: true, activeWork: [] })),
    installGuiUpdate: vi.fn(async () => ({ ok: false, currentVersion: '0.5.4' })),
    listDesignDocuments: vi.fn(async () => ({ ok: true, documents: [] })),
    loadDesignDocument: vi.fn(async () => ({ ok: true, document, activePageId: document.pages[0].id, revision: document.revision })),
    saveDesignDocument: vi.fn(async (request) => ({ ok: true, document: request.document, revision: request.document.revision }))
  } })
  container = globalThis.document.createElement('div'); globalThis.document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  useDesignWorkspaceStore.setState({ guiUpdateInstallPending: false })
  useDesignWorkspaceStore.getState().closeDocument()
  useChatStore.setState({ route: 'chat', workspaceRoot: '', boot: originalBoot })
  vi.restoreAllMocks()
})

describe('Design content safety across AppShell Settings lifecycle', () => {
  it.each(['save-fails', 'newer-draft'] as const)('keeps the actual Design view and draft when %s', async (branch) => {
    await act(async () => root.render(createElement(AppShell))); await settle()
    const save = deferred<DesignDocumentSaveResult>()
    vi.mocked(window.workwise.saveDesignDocument).mockImplementation(() => save.promise)
    await act(async () => useDesignWorkspaceStore.getState().addDefaultElement('text'))
    const submitted = useDesignWorkspaceStore.getState().document!
    await act(async () => useChatStore.getState().openSettings('general'))
    expect(useChatStore.getState().route).toBe('design')
    expect(container.querySelector('[data-testid="install"]')).toBeNull()
    expect(window.workwise.saveDesignDocument).toHaveBeenCalledOnce()
    if (branch === 'newer-draft') await act(async () => useDesignWorkspaceStore.getState().addDefaultElement('rect'))
    await act(async () => save.resolve(branch === 'save-fails'
      ? { ok: false, message: 'Synthetic Design save failure' }
      : { ok: true, document: submitted, revision: submitted.revision }))
    expect(useChatStore.getState().route).toBe('design')
    expect(useDesignWorkspaceStore.getState().document!.pages[0].elements).toHaveLength(branch === 'newer-draft' ? 2 : 1)
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    expect(window.workwise.loadDesignDocument).toHaveBeenCalledOnce()
  })

  it('retains the AppShell update guard in Settings and reuses a dirty same-workspace document on return', async () => {
    await act(async () => root.render(createElement(AppShell))); await settle()
    await act(async () => useChatStore.getState().openSettings('general')); await settle()
    expect(container.querySelector('[data-testid="install"]')).not.toBeNull()
    // A late async canvas command is still an unsaved edit, even off-route.
    useDesignWorkspaceStore.getState().addDefaultElement('text')
    const draft = useDesignWorkspaceStore.getState().document
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="install"]')!.click())
    await expect(update.attempt).resolves.toMatchObject({ ok: false })
    expect(window.workwise.preflightGuiUpdateInstall).not.toHaveBeenCalled()
    expect(window.workwise.installGuiUpdate).not.toHaveBeenCalled()
    await act(async () => useChatStore.getState().openDesign()); await settle()
    expect(useDesignWorkspaceStore.getState().document).toBe(draft)
    expect(window.workwise.loadDesignDocument).toHaveBeenCalledOnce()
  })

  it('keeps a dirty native viewer alive through a held or failed save before navigating', async () => {
    await act(async () => root.render(createElement(AppShell))); await settle()
    const deck = createDesignDocument({ name: 'Synthetic native deck' })
    deck.documentKind = 'pptx'; deck.pptx = { editorBackend: 'pptx-vanilla-viewer', editorVersion: '3.61.0' }
    await act(async () => useDesignWorkspaceStore.getState().loadDocument(deck, { persistedRevision: deck.revision })); await settle()
    const save = deferred<boolean>()
    native.save.mockImplementationOnce(() => save.promise)
    await act(async () => { native.dirty = true; native.dirtyChange!(true); useChatStore.getState().openSettings('general') })
    expect(useChatStore.getState().route).toBe('design')
    expect(container.querySelector('[data-testid="native-editor"]')).not.toBeNull()
    expect(native.unmounts).toBe(0)
    await act(async () => save.resolve(false))
    expect(useChatStore.getState().route).toBe('design')
    expect(native.unmounts).toBe(0)
    native.save.mockImplementationOnce(async () => { native.dirty = false; native.dirtyChange!(false); return true })
    await act(async () => useChatStore.getState().openSettings('general')); await settle()
    expect(useChatStore.getState().route).toBe('settings')
    expect(native.unmounts).toBe(1)
  })
})
