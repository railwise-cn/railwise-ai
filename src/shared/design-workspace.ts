import type { DesignAsset, DesignDocumentV1, DesignElement, DesignImportReportV1 } from './design-document'

export type DesignFidelityWarningCode =
  | 'unsupported_filter'
  | 'unsupported_mask'
  | 'unsupported_effect'
  | 'flattened_group'
  | 'missing_image'
  | 'font_substitution'
  | 'layout_approximation'
  | 'gradient_approximation'
  | 'transparency_approximation'
  | 'native_import_diagnostic'
  | 'native_object_diagnostic'
  | 'reference_regions'

export type DesignFidelityWarning = {
  code: DesignFidelityWarningCode
  message: string
  pageId?: string
  elementId?: string
}

export type DesignDocumentLoadPayload = {
  workspaceRoot: string
  documentId?: string
}

export type DesignPptxSourceStatus = {
  state: 'available' | 'missing' | 'corrupt' | 'metadata_missing'
  message?: string
  expectedSha256?: string
  actualSha256?: string
  expectedBytes?: number
  actualBytes?: number
}

export type DesignDocumentLoadResult = {
  ok: boolean
  document?: DesignDocumentV1
  activePageId?: string
  revision?: number
  /** Durable source integrity is reported without preventing recovery of the document. */
  sourceStatus?: DesignPptxSourceStatus
  code?: 'not_found' | 'corrupt' | 'unsafe_path' | 'read_failed'
  message?: string
}

export type DesignDocumentSummaryV1 = {
  id: string
  name: string
  revision: number
  pageCount: number
  updatedAt: number
}

export type DesignDocumentListPayload = {
  workspaceRoot: string
}

export type DesignDocumentListResult = {
  ok: boolean
  documents: DesignDocumentSummaryV1[]
  activeDocumentId?: string
  corruptDocumentIds?: string[]
  code?: 'unsafe_path' | 'read_failed'
  message?: string
}

export type DesignDocumentSavePayload = {
  workspaceRoot: string
  document: DesignDocumentV1
  activePageId: string
  /** null means this is the first durable write for the document. */
  expectedRevision: number | null
}

export type DesignDocumentSaveResult = {
  ok: boolean
  document?: DesignDocumentV1
  revision?: number
  currentRevision?: number
  code?: 'stale_request' | 'invalid_document' | 'unsafe_path' | 'write_failed'
  message?: string
}

export type DesignImageImportPayload = {
  workspaceRoot: string
  documentId: string
}

export type DesignImageImportResult = {
  ok: boolean
  canceled?: boolean
  asset?: DesignAsset
  dataUrl?: string
  message?: string
}

export type DesignAssetReadPayload = {
  workspaceRoot: string
  documentId: string
  asset: DesignAsset
}

export type DesignAssetReadResult = {
  ok: boolean
  dataUrl?: string
  message?: string
}

export type DesignPptxImportPayload = {
  workspaceRoot: string
}

export type DesignPptxImportResult = {
  ok: boolean
  canceled?: boolean
  document?: DesignDocumentV1
  activePageId?: string
  warnings?: DesignFidelityWarning[]
  /** Also returned on quality-check failure; no partial document is committed. */
  importReport?: DesignImportReportV1
  code?: 'import_quality_failed'
  message?: string
}

export type DesignPptxRevisionMetadata = {
  kind: 'source' | 'edited'
  sha256: string
  byteSize: number
  /** Native revision page count; legacy pointers may omit it. */
  slideCount?: number
}

export type DesignPptxRevisionReadPayload = {
  workspaceRoot: string
  documentId: string
  /** Original immutable source or the latest validated edit (default). */
  kind?: 'source' | 'active'
}

export type DesignPptxRevisionReadResult = {
  ok: boolean
  revision?: DesignPptxRevisionMetadata
  bytes?: Uint8Array
  code?: 'not_found' | 'invalid_document' | 'corrupt' | 'unsafe_path' | 'read_failed'
  message?: string
}

export type DesignPptxRevisionSavePayload = {
  workspaceRoot: string
  documentId: string
  expectedSha256: string
  bytes: Uint8Array
}

export type DesignPptxRevisionSaveResult = {
  ok: boolean
  revision?: DesignPptxRevisionMetadata
  code?: 'stale_request' | 'invalid_document' | 'invalid_pptx' | 'unsafe_path' | 'write_failed'
  currentSha256?: string
  message?: string
}

export type DesignPptxBytesExportPayload = {
  workspaceRoot: string
  documentId: string
  name?: string
  expectedSlideCount: number
  bytes: Uint8Array
}

export type DesignPptxBytesExportResult = {
  ok: boolean
  canceled?: boolean
  path?: string
  message?: string
}

export type DesignCanvasElementPatch =
  Omit<Partial<DesignElement>, 'fill' | 'stroke'> & {
    fill?: string | null
    stroke?: string | null
  }

export type DesignCanvasOperation =
  | { kind: 'add'; element: DesignElement }
  | { kind: 'update'; elementId: string; patch: DesignCanvasElementPatch }
  | { kind: 'remove'; elementIds: string[] }
  | { kind: 'group'; elementIds: string[]; name?: string }
  | { kind: 'ungroup'; groupIds: string[] }

export type DesignCanvasCommandV1 = {
  schema: 'workwise.design.command'
  version: 1
  idempotencyKey: string
  workspaceRoot: string
  documentId: string
  pageId: string
  expectedRevision: number
  operations: DesignCanvasOperation[]
}

export type DesignCanvasCommandAckV1 = {
  schema: 'workwise.design.command.ack'
  version: 1
  idempotencyKey: string
  ok: boolean
  documentId: string
  revision: number
  appliedOperations: number
  code?: 'stale_request' | 'document_unavailable' | 'invalid_command' | 'operation_failed'
  message?: string
}
