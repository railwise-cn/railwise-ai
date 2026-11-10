import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { buildToolArgumentSummary, sanitizeToolResultOutput, sanitizeTurnItemForPersistence } from './tool-persistence-security.js'

describe('typed connector evidence persistence', () => {
  it('preserves the complete exact command approval, workspace, lifetime and hashes without truncation', () => {
    const command = `printf '${'c'.repeat(950)}'`, workspace = '/workspace/本地项目'
    const args = { command, ttl_seconds: 120, timeout_seconds: 30, idempotency_key: 'one-only' }
    const summary = buildToolArgumentSummary({ toolName: 'request_host_shell', arguments: args, workspace })
    expect(summary).toContain(`Command (JSON): ${JSON.stringify(command)}`)
    expect(summary).toContain(`Command SHA256: ${createHash('sha256').update(command).digest('hex')}`)
    expect(summary).toContain(`Request SHA256: ${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`)
    expect(summary).toContain(`Workspace (JSON): ${JSON.stringify(workspace)}`)
    expect(summary).toContain('Lifetime seconds: 120')
    expect(summary).toContain('Timeout seconds: 30')
    expect(summary.length).toBeGreaterThan(1000)
    const persisted = sanitizeTurnItemForPersistence({ id: 'shell', kind: 'approval', turnId: 't', threadId: 'th', approvalId: 'a', toolName: 'request_host_shell', summary } as never) as { summary: string }
    expect(persisted.summary).toBe(summary)
  })
  it('shows the whole finite effect scope without truncating targets, including after persistence', () => {
    const effects = Array.from({ length: 8 }, (_, index) => ({ tool_name: 'lark_task_complete', target: `${index}${'a'.repeat(63)}` }))
    const summary = buildToolArgumentSummary({ toolName: 'confirm_external_effect_scope', arguments: { effects, expected_revision: 42, idempotency_key: 'private-key' } })
    expect(summary).toContain('Scope: Entire task is limited to these 8 actions')
    expect(summary).toContain(`Action 8: lark complete ${effects[7]!.target}`)
    expect(summary).not.toContain('...')
    expect(summary).not.toContain('private-key')
    const persisted = sanitizeTurnItemForPersistence({ id: 'scope', kind: 'approval', turnId: 't', threadId: 'th', approvalId: 'a', toolName: 'confirm_external_effect_scope', summary } as never) as { summary: string }
    expect(persisted.summary).toBe(summary)
  })

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
