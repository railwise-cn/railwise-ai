// @vitest-environment happy-dom

import type { WorkspacePreviewResultV1 } from '@shared/agent-workbench'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFilePreviewPanel } from './WorkspaceFilePreviewPanel'
import i18n from '../i18n'

let container: HTMLDivElement
let root: Root

function pdf(
  relativePath: string,
  pageCount: number
): Extract<WorkspacePreviewResultV1, { kind: 'pdf' }> {
  return {
    kind: 'pdf',
    relativePath,
    pageCount,
    searchable: true,
    pageTexts: [{ page: 1, text: relativePath }],
    truncated: false,
    warnings: [],
    sizeBytes: 128
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await i18n.changeLanguage('zh')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WorkspaceFilePreviewPanel PDF retries', () => {
  it('keeps the retry reason visible when accurate parsing fails', async () => {
    const automatic: WorkspacePreviewResultV1 = {
      ...pdf('scan.pdf', 1),
      document: {
        engine: 'markitdown',
        engineVersion: 'fixture-fast',
        quality: { status: 'degraded', reasons: ['scanned_document'] },
        route: {
          requestedMode: 'auto',
          selectedEngine: 'markitdown',
          switchReason: ['scanned_document']
        },
        headings: [],
        references: []
      }
    }
    const failed: WorkspacePreviewResultV1 = {
      ...pdf('scan.pdf', 1),
      documentError: {
        code: 'document_engine_unavailable',
        message: 'No high-accuracy document engine is configured.'
      },
      warnings: ['High-accuracy parsing failed.']
    }
    const previewWorkspaceFile = vi.fn((request: { parsingMode?: string }) =>
      Promise.resolve(request.parsingMode === 'accurate' ? failed : automatic)
    )
    vi.stubGlobal('window', Object.assign(window, {
      workwise: {
        previewWorkspaceFile,
        cancelDocumentParse: vi.fn(async () => true),
        readWorkspaceFile: vi.fn(),
        openWorkspacePathInEditor: vi.fn(),
        logError: vi.fn()
      }
    }))

    await act(async () => {
      root.render(createElement(WorkspaceFilePreviewPanel, {
        target: { path: 'scan.pdf', workspaceRoot: '/workspace' },
        workspaceRoot: '/workspace',
        onClose: vi.fn()
      }))
    })
    await settle()
    await vi.waitFor(() => expect(container.textContent).toContain('使用高精度解析'), { timeout: 5_000 })
    const accurateButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('使用高精度解析'))
    await act(async () => accurateButton?.click())
    await settle()

    expect(previewWorkspaceFile).toHaveBeenLastCalledWith(expect.objectContaining({
      retryReasons: ['scanned_document']
    }))
    expect(container.textContent).toContain('切换原因：扫描件或 OCR 需求')
    expect(container.textContent).toContain('No high-accuracy document engine is configured.')
  })

  it('preserves the scanned-document reason after a successful accurate retry', async () => {
    const automatic: WorkspacePreviewResultV1 = {
      ...pdf('scan.pdf', 1),
      document: {
        engine: 'markitdown',
        engineVersion: 'fixture-fast',
        quality: { status: 'degraded', reasons: ['scanned_document'] },
        route: {
          requestedMode: 'auto',
          selectedEngine: 'markitdown',
          switchReason: ['scanned_document']
        },
        headings: [],
        references: []
      }
    }
    const accurate: WorkspacePreviewResultV1 = {
      ...pdf('scan.pdf', 1),
      document: {
        engine: 'unlimited-ocr-local',
        engineVersion: 'fixture-accurate',
        quality: { status: 'enhanced', reasons: [] },
        route: { requestedMode: 'accurate', selectedEngine: 'unlimited-ocr-local' },
        headings: [],
        references: []
      }
    }
    const previewWorkspaceFile = vi.fn((request: { parsingMode?: string }) =>
      Promise.resolve(request.parsingMode === 'accurate' ? accurate : automatic)
    )
    vi.stubGlobal('window', Object.assign(window, {
      workwise: {
        previewWorkspaceFile,
        cancelDocumentParse: vi.fn(async () => true),
        readWorkspaceFile: vi.fn(),
        openWorkspacePathInEditor: vi.fn(),
        logError: vi.fn()
      }
    }))

    await act(async () => {
      root.render(createElement(WorkspaceFilePreviewPanel, {
        target: { path: 'scan.pdf', workspaceRoot: '/workspace' },
        workspaceRoot: '/workspace',
        onClose: vi.fn()
      }))
    })
    await settle()
    await vi.waitFor(() => expect(container.textContent).toContain('使用高精度解析'), { timeout: 5_000 })

    const accurateButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('使用高精度解析'))
    await act(async () => accurateButton?.click())
    await settle()

    expect(previewWorkspaceFile).toHaveBeenLastCalledWith(expect.objectContaining({
      parsingMode: 'accurate',
      retryReasons: ['scanned_document']
    }))
    expect(container.textContent).toContain('切换原因：扫描件或 OCR 需求')
  })

  it('cancels an accurate retry and ignores its late result after switching files', async () => {
    let resolveAccurate: ((result: WorkspacePreviewResultV1) => void) | undefined
    const accurate = new Promise<WorkspacePreviewResultV1>((resolve) => {
      resolveAccurate = resolve
    })
    const previewWorkspaceFile = vi.fn((request: { relativePath: string; parsingMode?: string }) => {
      if (request.relativePath === 'first.pdf' && request.parsingMode === 'accurate') return accurate
      return Promise.resolve(pdf(request.relativePath, request.relativePath === 'first.pdf' ? 1 : 2))
    })
    const cancelDocumentParse = vi.fn(async () => true)
    vi.stubGlobal('window', Object.assign(window, {
      workwise: {
        previewWorkspaceFile,
        cancelDocumentParse,
        readWorkspaceFile: vi.fn(),
        openWorkspacePathInEditor: vi.fn(),
        logError: vi.fn()
      }
    }))

    await act(async () => {
      root.render(createElement(WorkspaceFilePreviewPanel, {
        target: { path: 'first.pdf', workspaceRoot: '/workspace' },
        workspaceRoot: '/workspace',
        onClose: vi.fn()
      }))
    })
    await settle()
    await settle()

    await vi.waitFor(() => expect(container.textContent).toContain('使用高精度解析'), { timeout: 5_000 })
    const accurateButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('使用高精度解析'))
    expect(accurateButton).toBeInstanceOf(HTMLButtonElement)
    await act(async () => accurateButton?.click())

    await act(async () => {
      root.render(createElement(WorkspaceFilePreviewPanel, {
        target: { path: 'second.pdf', workspaceRoot: '/workspace' },
        workspaceRoot: '/workspace',
        onClose: vi.fn()
      }))
    })
    await settle()
    resolveAccurate?.(pdf('first.pdf', 99))
    await settle()
    await settle()

    expect(cancelDocumentParse).toHaveBeenCalledWith('preview:/workspace:first.pdf:accurate')
    expect(container.textContent).toContain('1 / 2')
    expect(container.textContent).not.toContain('1 / 99')
  })
})
