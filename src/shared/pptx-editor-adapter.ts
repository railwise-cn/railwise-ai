import type { DesignDocumentV1 } from './design-document'
import type { PptxEditorBackend, PptxImportReport } from './pptx-document'

/** Stable boundary between RailWise AI and a third-party slide editor. */
export type PptxEditorCapability =
  | 'text'
  | 'rich-text'
  | 'shape'
  | 'image'
  | 'table'
  | 'chart'
  | 'group'
  | 'protected-object'

export type PptxEditorSession = {
  documentId: string
  backend: PptxEditorBackend
  backendVersion: string
  capabilities: PptxEditorCapability[]
  report?: PptxImportReport
}

export type PptxEditorAdapter = {
  open: (document: DesignDocumentV1) => Promise<PptxEditorSession>
  save: (document: DesignDocumentV1) => Promise<DesignDocumentV1>
  export: (document: DesignDocumentV1, destinationPath: string) => Promise<{ ok: boolean; message?: string }>
}

export const PPTX_EDITOR_SOURCE = Object.freeze({
  name: 'pptx-vanilla-viewer',
  repository: 'https://github.com/ChristopherVR/ooxml',
  ref: 'd8f80c291c1f9ecc23278c4b2ac8674915d30828',
  version: '3.61.0',
  license: 'Apache-2.0',
  integration: 'local-vanilla-dom'
} as const)

