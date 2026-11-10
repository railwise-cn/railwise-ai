import { describe, expect, it } from 'vitest'
import { buildToolArgumentSummary, sanitizeToolResultOutput, sanitizeTurnItemForPersistence } from './tool-persistence-security.js'

describe('typed connector evidence persistence', () => {
  it('preserves only bounded evidence metadata while redacting platform content', () => {
    const output = sanitizeToolResultOutput('lark_approval_approve', {
      ok: true, provider: 'lark', operation: 'approve', target: 'task-1', status: 'succeeded',
      evidence: { kind: 'external_operation', provider: 'lark', operation: 'approve', target: 'task-1', verified: true, verifiedAt: '2026-11-10T00:00:00.000Z', resultHash: 'a'.repeat(64), status: 'APPROVED', comment: 'private contents' },
      data: { form: 'private form', user_name: 'private name' }
    })
    expect(output).toMatchObject({ provider: 'lark', operation: 'approve', target: 'task-1', evidence: { kind: 'external_operation', target: 'task-1', verified: true, resultHash: 'a'.repeat(64) } })
    expect(JSON.stringify(output)).not.toContain('private')
    expect(sanitizeToolResultOutput('lark_arbitrary_custom', { evidence: { target: 'task-1' } })).toEqual({ evidence: { target: '<omitted>' } })
  })

  it('shows exact target in initial and persisted approval without exposing comment contents', () => {
    const summary = buildToolArgumentSummary({ toolName: 'lark_approval_approve', arguments: { taskId: 'task-1', instanceCode: 'ic-2', comment: 'private contents' } })
    expect(summary).toContain('External target: task-1')
    expect(summary).toContain('Approval instance: ic-2')
    expect(summary).not.toContain('private contents')
    const item = sanitizeTurnItemForPersistence({ id: 'i', kind: 'approval', turnId: 't', threadId: 'th', approvalId: 'a', toolName: 'lark_approval_approve', summary } as never) as { summary: string }
    expect(item.summary).toContain('External target: task-1')
    expect(item.summary).toContain('Action: approve')
  })
})
