import { describe, expect, it } from 'vitest'
import { browserApprovalSummary, browserScheduleApprovalSummary, sanitizeBrowserApprovalSummary } from './browser-approval-summary.js'
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
  it('persists exact continuous purpose, actual times and unknown identity without turning them into a verified account', () => {
    const summary = browserApprovalSummary({ action: 'fill', origin: 'https://example.com', targetHtml: '<input aria-label="采购关键词">', value: '轨道交通', requestHash: 'a'.repeat(64),
      schedule: { purpose: '每日公告查询', requirement: { kind: 'daily', times: ['09:00', '17:00'], leadMinutes: 30, timezone: 'Asia/Shanghai' }, browserLabel: 'Test Chrome', version: 'b'.repeat(64) } })
    expect(sanitizeBrowserApprovalSummary(summary)).toBe(summary)
    expect(summary).toContain('08:30、16:30')
    expect(summary).toContain('未知；仅授权无需账号的公开查询')
    const plan = browserScheduleApprovalSummary({ purpose: '每日公告查询', times: ['08:30', '16:30'], timezone: 'Asia/Shanghai', readPaths: [], writePaths: ['/outputs'],
      origins: ['https://example.com'], browserLabel: 'Test Chrome', actions: [{ summary }], scopeHash: 'c'.repeat(64) })
    expect(sanitizeBrowserApprovalSummary(plan)).toBe(plan)
    expect(sanitizeTurnItemForPersistence({ id: 'plan-review', kind: 'approval', threadId: 'thread', turnId: 'turn', role: 'system',
      toolName: 'schedule_task', approvalId: 'appr', summary: plan, status: 'pending', createdAt: new Date().toISOString() })).toMatchObject({ summary: plan })
    expect(plan).toContain('采购关键词')
    expect(plan).toContain('轨道交通')
  })

})
