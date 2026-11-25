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
  ref: '9ff78cf6a7c65dbeabb84a89a1099af4258decc7',
  version: '3.80.0',
  license: 'Apache-2.0',
  integration: 'local-vanilla-dom'
} as const)

