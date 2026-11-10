import { describe, it, expect } from 'vitest'
import { verifiedEffectReceipts } from './external-effect-evidence.js'
import { TaskAcceptanceSchema, type OperationReceipt, type TaskRun } from '../contracts/tasks.js'

const turnId = 'turn-current'
const task = {
  id: 't',
  activeTurnId: turnId,
  goal: '同意飞书审批',
  acceptance: { kind: 'effect', effect: { provider: 'lark', operation: 'approve', target: 'a' } }
} as TaskRun

function evidence(provider: string, operation: string, target: string, remoteOperationId?: string) {
  return { kind: 'external_operation', provider, operation, target, status: 'APPROVED', verified: true, verifiedAt: '2026-11-10T00:00:00Z', ...(remoteOperationId ? { remoteOperationId } : {}), resultHash: `hash-${target}` }
}

function receipt(input: { provider?: string; operation?: string; target?: string; turnId?: string; status?: OperationReceipt['status']; toolName?: string; verified?: boolean } = {}): OperationReceipt {
  const provider = input.provider ?? 'lark'
  const operation = input.operation ?? 'approve'
  const target = input.target ?? 'a'
  const toolName = input.toolName ?? (operation === 'approve' ? 'lark_approval_approve' : 'lark_task_complete')
  const resultEvidence = evidence(provider, operation, target)
  return {
    id: `receipt-${provider}-${operation}-${target}`, idempotencyKey: `key-${provider}-${operation}-${target}`, fingerprint: `fingerprint-${provider}-${operation}-${target}`,
    ownerId: 't', kind: 'tool', status: input.status ?? 'succeeded', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z',
    request: { toolName, provider, providerId: provider === 'lark' ? 'lark-cli' : 'dingtalk', operation, target, turnId: input.turnId ?? turnId },
    result: { approved: true, item: { isError: false, output: { ok: true, status: 'succeeded', evidence: { ...resultEvidence, verified: input.verified ?? true } } } }
} as unknown as OperationReceipt
}

const multiTargetTask = {
  ...task,
  acceptance: {
    ...task.acceptance,
    effect: {
      provider: 'lark', operation: 'process', requiredScopes: [], requiresConfirmation: true, successStatus: ['succeeded'], verification: 'provider_readback',
      requiredEffects: [
        { provider: 'lark', operation: 'approve', target: 'a', requiredScopes: [], requiresConfirmation: true, successStatus: ['succeeded'], verification: 'provider_readback' },
        { provider: 'lark', operation: 'complete', target: 'b', requiredScopes: [], requiresConfirmation: true, successStatus: ['succeeded'], verification: 'provider_readback' }
      ]
    }
  }
} as unknown as TaskRun

describe('trusted external operation acceptance', () => {
  it('validates an explicit multi-target contract while retaining the legacy single-target shape', () => {
    const common = { requiredNodeKinds: ['execute'], requireFinalResponse: true, requireActionableArtifactCard: false }
    expect(TaskAcceptanceSchema.parse({ kind: 'effect', ...common, effect: { provider: 'lark', operation: 'approve', target: 'a', requiredScopes: [], requiresConfirmation: true, verification: 'provider_readback' } }).effect?.target).toBe('a')
    expect(TaskAcceptanceSchema.parse({ kind: 'effect', ...common, effect: { provider: 'lark', operation: 'process', requiredEffects: [{ provider: 'lark', operation: 'approve', target: 'a' }, { provider: 'lark', operation: 'complete', target: 'b' }], requiresConfirmation: true, verification: 'provider_readback' } }).effect?.requiredEffects).toHaveLength(2)
    expect(TaskAcceptanceSchema.safeParse({ kind: 'effect', ...common, effect: { provider: 'lark', operation: 'process', requiredEffects: [{ provider: 'lark', operation: 'approve' }], requiresConfirmation: true, verification: 'provider_readback' } }).success).toBe(false)
  })

  it('accepts readback-verified evidence for the exact legacy single-target contract without inventing a remote operation ID', () => {
    expect(verifiedEffectReceipts(task, [receipt()])).toEqual([evidence('lark', 'approve', 'a')])
  })

  it('requires every persisted provider-operation-target tuple for multi-target process tasks', () => {
    const approve = receipt({ target: 'a', operation: 'approve' })
    const complete = receipt({ target: 'b', operation: 'complete' })
    expect(verifiedEffectReceipts(multiTargetTask, [approve])).toEqual([])
    expect(verifiedEffectReceipts(multiTargetTask, [approve, complete])).toEqual([
      evidence('lark', 'approve', 'a'), evidence('lark', 'complete', 'b')
    ])
    expect(verifiedEffectReceipts(multiTargetTask, [approve, complete, receipt({ target: 'c' })])).toHaveLength(2)
  })

  it('accepts a genuine operation ID when the provider returns one', () => {
    const result = receipt()
    const output = result.result as { item: { output: { evidence: Record<string, unknown> } } }
    output.item.output.evidence = evidence('lark', 'approve', 'a', 'remote-operation-a')
    expect(verifiedEffectReceipts(task, [result])).toEqual([evidence('lark', 'approve', 'a', 'remote-operation-a')])
  })

  it('refuses broad process contracts that do not persist an exact target and operation set', () => {
    const broad = { ...task, acceptance: { ...task.acceptance, effect: { provider: 'lark', operation: 'process' } } } as TaskRun
    const missingTarget = { ...task, acceptance: { ...task.acceptance, effect: { provider: 'lark', operation: 'approve' } } } as TaskRun
    expect(verifiedEffectReceipts(broad, [receipt()])).toEqual([])
    expect(verifiedEffectReceipts(missingTarget, [receipt()])).toEqual([])
  })

  it('requires current-turn binding, matching provider, exact request target, and verified evidence', () => {
    expect(verifiedEffectReceipts(task, [receipt({ turnId: 'turn-old' })])).toEqual([])
    const wrongLedgerTurn = receipt()
    wrongLedgerTurn.turnId = 'turn-old'
    expect(verifiedEffectReceipts(task, [wrongLedgerTurn])).toEqual([])
    expect(verifiedEffectReceipts(task, [receipt({ provider: 'dingtalk', operation: 'approve', toolName: 'dingtalk_approve' })])).toEqual([])
    expect(verifiedEffectReceipts(task, [receipt({ target: 'other' })])).toEqual([])
    expect(verifiedEffectReceipts(task, [receipt({ verified: false })])).toEqual([])
    expect(verifiedEffectReceipts({ ...task, activeTurnId: undefined } as TaskRun, [receipt()])).toEqual([])
  })

  it('rejects missing targets, unknown outcomes, denied approvals, reads, and fabricated tools', () => {
    const missingTarget = receipt()
    missingTarget.request = { ...missingTarget.request, target: undefined }
    const mismatchedRequestOperation = receipt()
    mismatchedRequestOperation.request = { ...mismatchedRequestOperation.request, operation: 'reject' }
    const denied = receipt()
    denied.result = { approved: false, item: { isError: false, output: { ok: true, status: 'succeeded', evidence: evidence('lark', 'approve', 'a') } } }
    for (const item of [
      missingTarget,
      mismatchedRequestOperation,
      receipt({ status: 'outcome_unknown' }),
      denied,
      receipt({ toolName: 'lark_task_list' }),
      receipt({ toolName: 'bash' }),
      receipt({ toolName: 'send_approval_fake' })
    ]) expect(verifiedEffectReceipts(task, [item])).toEqual([])
  })
})
