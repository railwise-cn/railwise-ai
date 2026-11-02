// @vitest-environment happy-dom

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesignDocument } from '@shared/design-document'
import type { DesignDocumentSaveResult } from '@shared/design-workspace'
import i18n from '../../i18n'
import { useDesignWorkspaceStore } from '../../design/design-workspace-store'
import { DesignWorkspaceView } from './DesignWorkspaceView'

const { nativeSave, nativeDirty } = vi.hoisted(() => ({ nativeSave: vi.fn(async () => true), nativeDirty: { value: false } }))
vi.mock('./PptxEditorAdapter', () => ({
  PptxEditorAdapter: ({ onControllerReady }: { onControllerReady?: (controller: unknown) => void }) => {
    useEffect(() => {
      onControllerReady?.({ save: nativeSave, isDirty: () => nativeDirty.value })
      return () => onControllerReady?.(null)
    }, [onControllerReady])
    return createElement('div', { 'data-testid': 'native-deck-editor' }, 'Native editor')
  }
}))

let container: HTMLDivElement
let root: Root

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button was not rendered: ${text}`)
  }
  return button
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  nativeSave.mockReset().mockImplementation(async () => { nativeDirty.value = false; return true })
  nativeDirty.value = false
  await i18n.changeLanguage('en')
  const document = createDesignDocument({ name: 'QA board' })
  const openWorkspaceFile = vi.fn(async () => ({ ok: true as const }))
  const revealWorkspaceFile = vi.fn(async () => ({ ok: true as const }))
  const saveWorkspaceFileAs = vi.fn(async () => ({
    ok: true as const,
    path: '/tmp/QA board copy.pptx'
  }))
  Object.defineProperty(window, 'workwise', {
    configurable: true,
    value: {
      listDesignDocuments: vi.fn(async () => ({
        ok: true as const,
        documents: [{
          id: document.id,
          name: document.name,
          revision: document.revision,
          pageCount: document.pages.length,
          updatedAt: document.updatedAt
        }],
        activeDocumentId: document.id,
        corruptDocumentIds: []
      })),
      loadDesignDocument: vi.fn(async () => ({
        ok: true as const,
        document,
        activePageId: document.pages[0].id,
        revision: document.revision
      })),
      saveDesignDocument: vi.fn(async () => ({
        ok: true as const,
        document,
        revision: document.revision
      })),
      exportDesignToPptx: vi.fn(async () => ({
        ok: true as const,
        path: '/tmp/QA board.pptx'
      })),
      openWorkspaceFile,
      revealWorkspaceFile,
      saveWorkspaceFileAs
    }
  })

  container = globalThis.document.createElement('div')
  globalThis.document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(DesignWorkspaceView, {
      leftSidebarCollapsed: false,
      onToggleLeftSidebar: vi.fn(),
      onOpenWrite: vi.fn(),
      workspaceRoot: '/tmp/workwise-design-qa'
    }))
  })
  await settle()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
  useDesignWorkspaceStore.getState().closeDocument()
  vi.restoreAllMocks()
})

describe('DesignWorkspaceView export delivery', () => {
  it.each(['new-document', 'saved-document'] as const)('does not replace a new draft after saving an older revision for %s', async (branch) => {
    let resolveSave!: (result: DesignDocumentSaveResult) => void
    vi.mocked(window.workwise.saveDesignDocument).mockImplementation(() => new Promise((done) => { resolveSave = done }))
    await act(async () => useDesignWorkspaceStore.getState().addDefaultElement('text'))
    const submitted = useDesignWorkspaceStore.getState().document!
    if (branch === 'new-document') {
      await act(async () => { window.dispatchEvent(new CustomEvent('workwise:design-new-document')) })
      await act(async () => buttonWithText(i18n.t('common:designCreate')).click())
    } else {
      await act(async () => { window.dispatchEvent(new CustomEvent('workwise:design-open-document', { detail: { documentId: 'other-synthetic-document' } })) })
    }
    expect(window.workwise.saveDesignDocument).toHaveBeenCalledOnce()
    await act(async () => useDesignWorkspaceStore.getState().addDefaultElement('rect'))
    await act(async () => resolveSave({ ok: true, document: submitted, revision: submitted.revision }))
    expect(useDesignWorkspaceStore.getState().document!.id).toBe(submitted.id)
    expect(useDesignWorkspaceStore.getState().document!.pages[0].elements).toHaveLength(2)
    expect(window.workwise.loadDesignDocument).toHaveBeenCalledOnce()
  })

  it('closes the current document after saving native PPTX changes', async () => {
    const deck = createDesignDocument({ name: 'Native deck' })
    deck.documentKind = 'pptx'
    deck.pptx = { editorBackend: 'pptx-vanilla-viewer', editorVersion: '3.61.0' }
    await act(async () => useDesignWorkspaceStore.getState().loadDocument(deck, {
      activePageId: deck.pages[0].id, persistedRevision: deck.revision
    }))
    await settle()
    nativeDirty.value = true
    await act(async () => {
      buttonWithText('Close document').click()
    })
    await settle()
    expect(nativeSave).toHaveBeenCalledOnce()
    expect(useDesignWorkspaceStore.getState().document).toBeNull()
    expect(container.textContent).toContain('New document')
  })

  it('uses only native PPTX controls and saves the native revision before importing another deck', async () => {
    const deck = createDesignDocument({ name: 'Native deck' })
    deck.documentKind = 'pptx'
    deck.pptx = { editorBackend: 'pptx-vanilla-viewer', editorVersion: '3.61.0' }
    Object.assign(window.workwise, { importPptxToDesign: vi.fn(async () => ({ ok: false, canceled: true })) })
    await act(async () => useDesignWorkspaceStore.getState().loadDocument(deck, {
      activePageId: deck.pages[0].id, persistedRevision: deck.revision
    }))
    await settle()
    expect(container.querySelector('[data-testid="native-deck-editor"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="free-canvas-toolbar"]')).toBeNull()
    expect(container.querySelector('[aria-label="Add page"]')).toBeNull()
    nativeDirty.value = true
    await act(async () => {
      const importButton = [...container.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === i18n.t('common:designImportPptx'))
      expect(importButton).toBeDefined()
      importButton!.click()
    })
    await settle()
    expect(nativeSave).toHaveBeenCalledOnce()
    expect(window.workwise.importPptxToDesign).toHaveBeenCalledOnce()
    expect(window.workwise.exportDesignToPptx).not.toHaveBeenCalled()
  })

  it('renders working open, save-as, and reveal actions after a PPTX export', async () => {
    await act(async () => {
      buttonWithText('Export PPTX').click()
    })
    await settle()

    expect(container.textContent).toContain('QA board.pptx')

    await act(async () => {
      buttonWithText('Open').click()
    })
    await settle()
    await act(async () => {
      buttonWithText('Save as').click()
    })
    await settle()
    await act(async () => {
      buttonWithText('Show in folder').click()
    })
    await settle()

    expect(window.workwise.openWorkspaceFile).toHaveBeenCalledWith({
      path: '/tmp/QA board.pptx'
    })
    expect(window.workwise.saveWorkspaceFileAs).toHaveBeenCalledWith({
      sourcePath: '/tmp/QA board.pptx',
      suggestedName: 'QA board.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    })
    expect(window.workwise.revealWorkspaceFile).toHaveBeenCalledWith({
      path: '/tmp/QA board.pptx'
    })
  })

  it('clears the previous document artifact when the active Design document changes', async () => {
    await act(async () => {
      buttonWithText('Export PPTX').click()
    })
    await settle()
    expect(container.textContent).toContain('QA board.pptx')

    await act(async () => {
      const otherDocument = createDesignDocument({ name: 'Other board' })
      useDesignWorkspaceStore.getState().loadDocument(otherDocument, {
        activePageId: otherDocument.pages[0].id,
        persistedRevision: otherDocument.revision
      })
    })
    await settle()

    expect(container.textContent).not.toContain('QA board.pptx')
  })
})
