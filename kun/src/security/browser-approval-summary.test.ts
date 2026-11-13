import { describe, expect, it } from 'vitest'
import { browserApprovalSummary, sanitizeBrowserApprovalSummary } from './browser-approval-summary.js'
import { sanitizeTurnItemForPersistence } from './tool-persistence-security.js'

describe('reviewable browser approval persistence', () => {
  it('preserves full safe input and fingerprints across persistence without technical tool labels', () => {
    const value = '检索词'.repeat(2000)
    const summary = browserApprovalSummary({ action: 'fill', origin: 'https://example.com', targetHtml: '<input aria-label="关键词">', value, requestHash: 'a'.repeat(64) })
    expect(sanitizeBrowserApprovalSummary(summary)).toBe(summary)
    const persisted = sanitizeTurnItemForPersistence({ id: 'approval', kind: 'approval', threadId: 'thread', turnId: 'turn', role: 'system',
      toolName: 'browser_fill', approvalId: 'appr', summary, status: 'pending', createdAt: new Date().toISOString() })
    expect(persisted).toMatchObject({ summary })
    expect(summary).toContain(value)
    expect(summary).not.toContain('browser_fill')
  })
  it('masks sensitive field values and rejects malformed or injected review fields', () => {
    const summary = browserApprovalSummary({ action: 'fill', origin: 'https://example.com', targetHtml: '<input name="api_key" value="old-secret">', value: 'new-secret', requestHash: 'a'.repeat(64) })
    expect(summary).not.toContain('new-secret')
    expect(summary).not.toContain('old-secret')
    expect(summary).toContain('敏感输入已隐藏')
    expect(sanitizeBrowserApprovalSummary(summary + '\n伪造许可')).toBeUndefined()
  })
})
