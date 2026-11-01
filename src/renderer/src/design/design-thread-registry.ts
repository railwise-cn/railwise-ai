import { browserStorage, type BrowserStorageLike } from '../lib/browser-storage'
import type { NormalizedThread } from '../agent/types'
import type { DesignDocumentSummaryV1 } from '@shared/design-workspace'

const DESIGN_THREAD_REGISTRY_KEY = 'workwise.design.threadRegistry.v1'
const PENDING_DESIGN_DOCUMENT_KEY = 'workwise.design.pendingDocument.v1'
const ACTIVE_DESIGN_DOCUMENTS_KEY = 'workwise.design.activeDocumentByWorkspace.v1'
const MAX_DESIGN_THREAD_RECORDS = 200

export type DesignThreadRecord = {
  documentId: string
  threadId: string
  workspaceRoot: string
  updatedAt: string
}
export type DesignThreadRegistry = {
  version: 1
  documents: Record<string, DesignThreadRecord>
}

function emptyRegistry(): DesignThreadRegistry {
  return { version: 1, documents: {} }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeDesignThreadRegistry(raw: unknown): DesignThreadRegistry {
  if (!raw || typeof raw !== 'object') return emptyRegistry()
  const source = raw as { documents?: unknown }
  if (!source.documents || typeof source.documents !== 'object') return emptyRegistry()
  const records: DesignThreadRecord[] = []
  for (const [key, value] of Object.entries(source.documents as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const candidate = value as Partial<DesignThreadRecord>
    const documentId = normalizeText(candidate.documentId) || normalizeText(key)
    const threadId = normalizeText(candidate.threadId)
    const workspaceRoot = normalizeText(candidate.workspaceRoot).replaceAll('\\', '/').replace(/\/+$/, '')
    if (!documentId || !threadId || !workspaceRoot) continue
    records.push({
      documentId,
      threadId,
      workspaceRoot,
      updatedAt: normalizeText(candidate.updatedAt) || new Date(0).toISOString()
    })
  }
  const documents = Object.fromEntries(
    records
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
      .slice(-MAX_DESIGN_THREAD_RECORDS)
      .map((record) => [record.documentId, record])
  )
  return { version: 1, documents }
}

export function readDesignThreadRegistry(
  storage: BrowserStorageLike | null = browserStorage()
): DesignThreadRegistry {
  if (!storage) return emptyRegistry()
  try {
    const value = storage.getItem(DESIGN_THREAD_REGISTRY_KEY)
    return normalizeDesignThreadRegistry(value ? JSON.parse(value) : null)
  } catch {
    return emptyRegistry()
  }
}

export function saveDesignThreadRegistry(
  registry: DesignThreadRegistry,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  if (!storage) return
  try {
    storage.setItem(DESIGN_THREAD_REGISTRY_KEY, JSON.stringify(normalizeDesignThreadRegistry(registry)))
  } catch {
    /* ignore storage failures */
  }
}

export function markDesignAssistantThread(
  documentId: string,
  threadId: string,
  workspaceRoot: string,
  storage: BrowserStorageLike | null = browserStorage()
): DesignThreadRegistry {
  const registry = readDesignThreadRegistry(storage)
  const normalizedDocumentId = documentId.trim()
  const normalizedThreadId = threadId.trim()
  const normalizedWorkspace = workspaceRoot.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (!normalizedDocumentId || !normalizedThreadId || !normalizedWorkspace) return registry
  const next = normalizeDesignThreadRegistry({
    version: 1,
    documents: {
      ...registry.documents,
      [normalizedDocumentId]: {
        documentId: normalizedDocumentId,
        threadId: normalizedThreadId,
        workspaceRoot: normalizedWorkspace,
        updatedAt: new Date().toISOString()
      }
    }
  })
  saveDesignThreadRegistry(next, storage)
  return next
}

export function designAssistantThreadIdForDocument(
  documentId: string,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): string {
  return registry.documents[documentId.trim()]?.threadId ?? ''
}

/** Returns the Design document that owns an assistant thread, if known. */
export function designDocumentIdForAssistantThread(
  threadId: string | null | undefined,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): string {
  const normalized = threadId?.trim() ?? ''
  if (!normalized) return ''
  return Object.values(registry.documents).find((record) => record.threadId === normalized)?.documentId ?? ''
}

/**
 * Older builds named Design threads but did not persist their document mapping.
 * Hydrate that mapping only for an unambiguous exact document-title match.
 */
export function hydrateLegacyDesignThreadRegistry(
  documents: ReadonlyArray<Pick<DesignDocumentSummaryV1, 'id' | 'name'>>,
  threads: ReadonlyArray<Pick<NormalizedThread, 'id' | 'title' | 'workspace'>>,
  storage: BrowserStorageLike | null = browserStorage()
): DesignThreadRegistry {
  const byName = new Map<string, string[]>()
  for (const document of documents) {
    const name = document.name.trim()
    if (!name) continue
    byName.set(name, [...(byName.get(name) ?? []), document.id])
  }
  let registry = readDesignThreadRegistry(storage)
  for (const thread of threads) {
    const title = thread.title.trim()
    const workspace = normalizeText(thread.workspace)
    const name = title.startsWith('Design · ') ? title.slice('Design · '.length).trim()
      : title.startsWith('Design:') ? title.slice('Design:'.length).trim()
        : ''
    const matches = name ? byName.get(name) ?? [] : []
    if (matches.length !== 1 || !workspace) continue
    const documentId = matches[0]
    if (registry.documents[documentId]?.threadId === thread.id) continue
    registry = markDesignAssistantThread(documentId, thread.id, workspace, storage)
  }
  return registry
}

export function requestDesignDocumentOpen(
  documentId: string,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  const normalized = documentId.trim()
  if (!normalized || !storage) return
  try {
    storage.setItem(PENDING_DESIGN_DOCUMENT_KEY, normalized)
  } catch {
    /* Opening Design remains possible without persistent browser storage. */
  }
}

export function consumeRequestedDesignDocument(
  storage: BrowserStorageLike | null = browserStorage()
): string {
  if (!storage) return ''
  try {
    const documentId = storage.getItem(PENDING_DESIGN_DOCUMENT_KEY)?.trim() ?? ''
    if (documentId) storage.removeItem?.(PENDING_DESIGN_DOCUMENT_KEY)
    return documentId
  } catch {
    return ''
  }
}

export function activeDesignDocumentForWorkspace(
  workspaceRoot: string,
  storage: BrowserStorageLike | null = browserStorage()
): string {
  const workspace = workspaceRoot.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (!workspace || !storage) return ''
  try {
    const parsed = JSON.parse(storage.getItem(ACTIVE_DESIGN_DOCUMENTS_KEY) ?? '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    return normalizeText((parsed as Record<string, unknown>)[workspace])
  } catch {
    return ''
  }
}

export function rememberActiveDesignDocument(
  workspaceRoot: string,
  documentId: string,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  const workspace = workspaceRoot.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  const normalizedDocumentId = documentId.trim()
  if (!workspace || !normalizedDocumentId || !storage) return
  try {
    const current = JSON.parse(storage.getItem(ACTIVE_DESIGN_DOCUMENTS_KEY) ?? '{}') as unknown
    const records = current && typeof current === 'object' && !Array.isArray(current)
      ? current as Record<string, unknown>
      : {}
    storage.setItem(ACTIVE_DESIGN_DOCUMENTS_KEY, JSON.stringify({
      ...records,
      [workspace]: normalizedDocumentId
    }))
  } catch {
    /* Design remains usable when browser storage is unavailable or malformed. */
  }
}

/** Forget the document that should be restored when this workspace is opened. */
export function clearActiveDesignDocument(
  workspaceRoot: string,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  const workspace = workspaceRoot.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (!workspace || !storage) return
  try {
    const current = JSON.parse(storage.getItem(ACTIVE_DESIGN_DOCUMENTS_KEY) ?? '{}') as unknown
    if (!current || typeof current !== 'object' || Array.isArray(current)) return
    const records = { ...(current as Record<string, unknown>) }
    delete records[workspace]
    if (Object.keys(records).length === 0) storage.removeItem?.(ACTIVE_DESIGN_DOCUMENTS_KEY)
    else storage.setItem(ACTIVE_DESIGN_DOCUMENTS_KEY, JSON.stringify(records))
  } catch {
    /* Design remains usable when browser storage is unavailable or malformed. */
  }
}

/** Forget the document that should be restored when this workspace is opened again. */
export function forgetActiveDesignDocumentForWorkspace(
  workspaceRoot: string,
  storage: BrowserStorageLike | null = browserStorage()
): void {
  clearActiveDesignDocument(workspaceRoot, storage)
}

export function isDesignAssistantThreadId(
  threadId: string | null | undefined,
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): boolean {
  const normalized = threadId?.trim() ?? ''
  return Boolean(normalized && Object.values(registry.documents).some((record) => record.threadId === normalized))
}

/**
 * Design assistant threads created before the registry was persisted still
 * carry the reserved title prefix. Keep them out of the coding session list
 * while the registry catches up after the next Design open.
 */
export function isDesignAssistantThread(
  thread: { id?: string | null; title?: string | null },
  registry: DesignThreadRegistry = readDesignThreadRegistry()
): boolean {
  if (isDesignAssistantThreadId(thread.id, registry)) return true
  const title = thread.title?.trim().toLowerCase() ?? ''
  return title.startsWith('design ·') || title.startsWith('design:')
}
