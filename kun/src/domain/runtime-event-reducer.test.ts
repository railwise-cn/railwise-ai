import { describe, expect, it } from 'vitest'
import { RuntimeEvent } from '../contracts/events.js'
import { replayRuntimeEvents } from './runtime-event-reducer.js'

describe('approval event projection', () => {
  it('preserves the approval request hash through history replay and resolution', () => {
    const requestHash = 'a'.repeat(64)
    const requested = RuntimeEvent.parse({
      kind: 'approval_requested', seq: 1, timestamp: '2026-11-25T00:00:00.000Z',
      threadId: 'thread', turnId: 'turn', approvalId: 'approval', requestHash,
      toolName: 'write', status: 'pending', summary: 'Write one file'
    })
    const resolved = RuntimeEvent.parse({
      kind: 'approval_resolved', seq: 2, timestamp: '2026-11-25T00:01:00.000Z',
      threadId: 'thread', turnId: 'turn', approvalId: 'approval', requestHash,
      toolName: 'write', status: 'allowed', summary: 'Write one file'
    })

    expect(replayRuntimeEvents([requested]).items[0]).toMatchObject({ approvalId: 'approval', requestHash, status: 'pending' })
    expect(replayRuntimeEvents([requested, resolved]).items[0]).toMatchObject({ approvalId: 'approval', requestHash, status: 'allowed' })
  })
})
