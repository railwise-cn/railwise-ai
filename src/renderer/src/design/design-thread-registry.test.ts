import { describe, expect, it } from 'vitest'
import type { BrowserStorageLike } from '../lib/browser-storage'
import {
  activeDesignDocumentForWorkspace,
  clearActiveDesignDocument,
  designAssistantThreadIdForDocument,
  consumeRequestedDesignDocument,
  designDocumentIdForAssistantThread,
  hydrateLegacyDesignThreadRegistry,
  isDesignAssistantThread,
  isDesignAssistantThreadId,
  markDesignAssistantThread,
  readDesignThreadRegistry,
  rememberActiveDesignDocument,
  requestDesignDocumentOpen
} from './design-thread-registry'

function memoryStorage(): BrowserStorageLike {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

describe('Design assistant thread registry', () => {
  it('keeps a stable document-scoped thread outside Code', () => {
    const storage = memoryStorage()
    const registry = markDesignAssistantThread('design-1', 'thread-design-1', '/workspace', storage)
    expect(designAssistantThreadIdForDocument('design-1', registry)).toBe('thread-design-1')
    expect(isDesignAssistantThreadId('thread-design-1', readDesignThreadRegistry(storage))).toBe(true)
    expect(isDesignAssistantThreadId('thread-code', registry)).toBe(false)
    expect(designDocumentIdForAssistantThread('thread-design-1', registry)).toBe('design-1')
  })

  it('hydrates an unambiguous legacy title without touching unrelated threads', () => {
    const storage = memoryStorage()
    const registry = hydrateLegacyDesignThreadRegistry(
      [{ id: 'design-1', name: '项目周报' }],
      [
        { id: 'design-thread', title: 'Design · 项目周报', workspace: '/workspace' },
        { id: 'code-thread', title: '项目周报', workspace: '/workspace' }
      ],
      storage
    )
    expect(designAssistantThreadIdForDocument('design-1', registry)).toBe('design-thread')
    expect(designDocumentIdForAssistantThread('code-thread', registry)).toBe('')
  })

  it('recognizes registry-backed and legacy Design threads before Code renders its session list', () => {
    const storage = memoryStorage()
    const registry = markDesignAssistantThread('design-1', 'thread-design-1', '/workspace', storage)

    expect(isDesignAssistantThread({ id: 'thread-design-1', title: '普通标题' }, registry)).toBe(true)
    expect(isDesignAssistantThread({ id: 'legacy-design', title: 'Design · 项目周报' }, registry)).toBe(true)
    expect(isDesignAssistantThread({ id: 'code-thread', title: '项目周报' }, registry)).toBe(false)
  })

  it('passes a requested Design document safely through a route transition', () => {
    const storage = memoryStorage()
    requestDesignDocumentOpen('design-1', storage)
    expect(consumeRequestedDesignDocument(storage)).toBe('design-1')
    expect(consumeRequestedDesignDocument(storage)).toBe('')
  })

  it('remembers the selected document independently for each workspace', () => {
    const storage = memoryStorage()
    rememberActiveDesignDocument('/workspace/one/', 'doc-one', storage)
    rememberActiveDesignDocument('/workspace/two', 'doc-two', storage)

    expect(activeDesignDocumentForWorkspace('/workspace/one', storage)).toBe('doc-one')
    expect(activeDesignDocumentForWorkspace('/workspace/two/', storage)).toBe('doc-two')
    expect(activeDesignDocumentForWorkspace('/workspace/unknown', storage)).toBe('')
  })

  it('ignores malformed persisted document selection data', () => {
    const storage = memoryStorage()
    storage.setItem('workwise.design.activeDocumentByWorkspace.v1', '{broken')
    expect(activeDesignDocumentForWorkspace('/workspace/one', storage)).toBe('')
  })

  it('clears only the active document for the closed workspace', () => {
    const storage = memoryStorage()
    rememberActiveDesignDocument('/workspace/one', 'doc-one', storage)
    rememberActiveDesignDocument('/workspace/two', 'doc-two', storage)

    clearActiveDesignDocument('/workspace/one', storage)

    expect(activeDesignDocumentForWorkspace('/workspace/one', storage)).toBe('')
    expect(activeDesignDocumentForWorkspace('/workspace/two', storage)).toBe('doc-two')
  })
})
