import { describe, expect, it } from 'vitest'
import {
  checkedDocumentWritePayloadSchema,
  documentCommentCreatePayloadSchema,
  documentCommentUpdatePayloadSchema,
  documentHistoryPayloadSchema,
  documentRestorePayloadSchema,
  documentSearchPayloadSchema,
  documentSemanticsPayloadSchema,
  writeMermaidPreviewPayloadSchema
} from './app-ipc-schemas'

const document = { path: '/workspace/draft.md', workspaceRoot: '/workspace' }
const id = '1761973200000-b3c047bc-1a18-4ff0-89f8-6363d5f065d5'

describe('document IPC contracts', () => {
  it('bounds local Mermaid preview requests and rejects extra runtime options', () => {
    expect(writeMermaidPreviewPayloadSchema.safeParse({ source: 'graph LR; A-->B' }).success).toBe(true)
    expect(writeMermaidPreviewPayloadSchema.safeParse({ source: 'x'.repeat(30001) }).success).toBe(false)
    expect(writeMermaidPreviewPayloadSchema.safeParse({ source: 'graph LR; A-->B', url: 'https://example.com' }).success).toBe(false)
  })
  it('distinguishes an omitted legacy baseline from an explicit expect-missing baseline', () => {
    expect(checkedDocumentWritePayloadSchema.parse({ ...document, content: 'draft' }).expectedRevision).toBeUndefined()
    expect(checkedDocumentWritePayloadSchema.parse({ ...document, content: 'draft', expectedRevision: null }).expectedRevision).toBeNull()
    expect(checkedDocumentWritePayloadSchema.safeParse({ ...document, content: 'draft', expectedRevision: 'unchecked' }).success).toBe(false)
  })

  it('requires a valid explicit baseline and traversal-free history ID for restoration', () => {
    expect(documentRestorePayloadSchema.safeParse({ ...document, id }).success).toBe(false)
    expect(documentRestorePayloadSchema.safeParse({ ...document, id, expectedRevision: null }).success).toBe(true)
    expect(documentHistoryPayloadSchema.safeParse({ ...document, id: '../../outside.json' }).success).toBe(false)
  })

  it('validates comment anchors and limits local review state updates', () => {
    expect(documentCommentCreatePayloadSchema.safeParse({ ...document, text: 'Review', anchor: { from: -1, to: 2, text: 'a' } }).success).toBe(false)
    expect(documentCommentCreatePayloadSchema.safeParse({ ...document, text: ' ', anchor: { from: 0, to: 2, text: 'ab' } }).success).toBe(false)
    expect(documentCommentUpdatePayloadSchema.safeParse({ ...document, id: id.slice(14), status: 'deleted' }).success).toBe(false)
    expect(documentCommentUpdatePayloadSchema.safeParse({ ...document, id: id.slice(14), status: 'resolved' }).success).toBe(true)
  })

  it('bounds visible search and rejects unexpected network or embedding parameters', () => {
    expect(documentSearchPayloadSchema.safeParse({ workspaceRoot: '/workspace', query: 'local', limit: 201 }).success).toBe(false)
    expect(documentSearchPayloadSchema.safeParse({ workspaceRoot: '/workspace', query: 'local', embeddingUrl: 'https://example.com' }).success).toBe(false)
    expect(documentSemanticsPayloadSchema.safeParse({ ...document, content: '# Draft', remote: true }).success).toBe(false)
  })
})
