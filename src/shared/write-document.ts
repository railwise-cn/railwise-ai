export type DocumentRevision = {
  fingerprint: string
  size: number
  modifiedAt: number
}

export type DocumentSnapshot = {
  path: string
  content: string
  revision: DocumentRevision
}

export type DocumentConflict = {
  path: string
  expectedRevision: DocumentRevision | null
  currentRevision: DocumentRevision | null
  currentContent: string | null
  attemptedContent: string
}

export type DocumentHistoryEntry = {
  id: string
  path: string
  revision: DocumentRevision
  content: string
  createdAt: string
  source: 'user' | 'agent' | 'external' | 'restore'
}

export type DocumentHistorySummary = Omit<DocumentHistoryEntry, 'content'>
export type DocumentHistoryListResult = { entries: DocumentHistorySummary[]; total: number; truncated: boolean; limit: number }

export type FrontmatterParseResult = {
  data: Record<string, unknown>
  body: string
  raw: string
  startOffset: number
  endOffset: number
  error?: string
} | {
  data: Record<string, unknown>
  body: string
  raw: ''
  startOffset: 0
  endOffset: 0
  error?: string
}

export type MarkdownLink = {
  sourcePath: string
  target: string
  label?: string
  kind: 'markdown' | 'wiki'
  line: number
}

export type WorkspaceSearchResult = {
  path: string
  relativePath: string
  title: string
  line: number
  snippet: string
}

export type WorkspaceSearchResponse = {
  query: string
  results: WorkspaceSearchResult[]
  indexedFiles: number
  skippedFiles: number
  truncated: boolean
  limits: { maxFiles: number; maxFileBytes: number; maxResults: number }
}

export type DocumentReadPayload = {
  path: string
  workspaceRoot: string
}

export type DocumentSearchPayload = {
  workspaceRoot: string
  query: string
  limit?: number
}

export type CheckedDocumentWritePayload = {
  path: string
  workspaceRoot: string
  content: string
  expectedRevision?: DocumentRevision | null
  source?: DocumentHistoryEntry['source']
}

export type CheckedDocumentWriteResult =
  | { ok: true; snapshot: DocumentSnapshot }
  | { ok: false; conflict: DocumentConflict }
  | { ok: false; message: string }

export type DocumentHistoryPayload = DocumentReadPayload & { id: string }
export type DocumentRestorePayload = DocumentHistoryPayload & { expectedRevision: DocumentRevision | null }
export type DocumentCommentAnchor = { from: number; to: number; text: string }
export type DocumentComment = {
  id: string
  path: string
  text: string
  anchor: DocumentCommentAnchor
  status: 'open' | 'resolved'
  createdAt: string
  updatedAt: string
}
export type DocumentCommentCreatePayload = DocumentReadPayload & { text: string; anchor: DocumentCommentAnchor }
export type DocumentCommentUpdatePayload = DocumentReadPayload & { id: string; status: DocumentComment['status'] }
export type DocumentSemanticsPayload = DocumentReadPayload & { content?: string }
export type DocumentLinkState = MarkdownLink & {
  resolvedPath: string | null
  status: 'valid' | 'broken' | 'unsafe'
}
export type WorkspaceRelations = {
  nodes: Array<{ path: string; title: string }>
  edges: Array<{ from: string; to: string; line: number }>
  truncated: boolean
  skippedFiles: number
}
export type DocumentSemantics = {
  frontmatter: FrontmatterParseResult
  outgoing: DocumentLinkState[]
  backlinks: MarkdownLink[]
  relations: WorkspaceRelations
}
