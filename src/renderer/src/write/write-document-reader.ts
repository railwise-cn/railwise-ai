import type { DocumentRevision } from '@shared/write-document'

const MAX_EDITABLE_DOCUMENT_BYTES = 1_500_000

/** Pair content and revision from one snapshot; never attach a newer baseline to an older buffer. */
export async function readWriteDocument(workspaceRoot: string, path: string): Promise<{
  path: string; content: string; size: number; truncated: boolean; documentRevision: DocumentRevision | null; documentBaselineKnown: boolean
}> {
  const legacy = await window.workwise.readWorkspaceFile({ path, workspaceRoot })
  if (!legacy.ok) throw new Error(legacy.message)
  if (legacy.truncated || typeof window.workwise.readDocumentSnapshot !== 'function') {
    return { ...legacy, documentRevision: null, documentBaselineKnown: false }
  }
  try {
    const snapshot = await window.workwise.readDocumentSnapshot({ path: legacy.path, workspaceRoot })
    const truncated = snapshot.revision.size > MAX_EDITABLE_DOCUMENT_BYTES
    return {
      path: snapshot.path,
      content: truncated ? snapshot.content.slice(0, MAX_EDITABLE_DOCUMENT_BYTES) : snapshot.content,
      size: snapshot.revision.size,
      truncated,
      documentRevision: truncated ? null : snapshot.revision,
      documentBaselineKnown: !truncated
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('No handler registered for')) throw error
    return { ...legacy, documentRevision: null, documentBaselineKnown: false }
  }
}
