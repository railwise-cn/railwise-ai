import { describe, it, expect } from 'vitest'
import { externalOperationForTool, externalTarget, verifiedEffectReceipts } from './external-effect-evidence.js'
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

const processTask = {
  ...task,
  goal: '帮我处理飞书待办',
  acceptance: {
    kind: 'effect',
    effect: { provider: 'lark', operation: 'process', requiresConfirmation: true }
  }
} as TaskRun

describe('trusted external operation acceptance', () => {
  it('requires both approve and upload evidence and rejects a shortened legacy scope', () => {
    const approve = { provider: 'lark', operation: 'approve', target: 'a' }
    const upload = { provider: 'lark', operation: 'upload', target: 'folder' }
    const mixed = { ...task, goal: '请先批准飞书审批，再上传文件。', acceptance: { ...task.acceptance,
      effect: { ...task.acceptance.effect!, requiredOperations: ['approve', 'upload'], target: undefined, requiredEffects: [approve, upload] } } } as TaskRun
    const resolver = (name: string) => name === 'lark_drive_upload'
      ? { provider: 'lark', operation: 'upload', mutation: true, targetFields: ['folderToken'] } : externalOperationForTool(name)
    const uploadReceipt = receipt({ operation: 'upload', toolName: 'lark_drive_upload', target: 'folder' })
    expect(verifiedEffectReceipts(mixed, [receipt()], new Set(), resolver)).toEqual([])
    expect(verifiedEffectReceipts(mixed, [receipt(), uploadReceipt], new Set(), resolver)).toHaveLength(2)
    const legacy = { ...mixed, acceptance: { ...mixed.acceptance, effect: { ...mixed.acceptance.effect!, requiredOperations: undefined, requiredEffects: [approve] } } } as TaskRun
    expect(verifiedEffectReceipts(legacy, [receipt()], new Set(), resolver)).toEqual([])
  })

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

  it('binds list evidence to the current account and leaves detail targets explicit', () => {
    expect(externalTarget({}, 'lark_task_list')).toBe('current_user')
    expect(externalTarget({}, 'dingtalk_list_approvals')).toBe('current_user')
    expect(externalTarget({}, 'lark_task_get')).toBeUndefined()
    const listing = { ...task, acceptance: { ...task.acceptance, effect: { provider: 'lark', operation: 'list', target: 'current_user' } } } as TaskRun
    expect(verifiedEffectReceipts(listing, [receipt({ operation: 'list', toolName: 'lark_task_list', target: 'current_user' })])).toHaveLength(1)
  })

  it('reuses only explicitly trusted attempts of the same task after resume', () => {
    const old = receipt({ turnId: 'turn-old' })
    expect(verifiedEffectReceipts(task, [old])).toEqual([])
    expect(verifiedEffectReceipts(task, [old], new Set(['turn-old']))).toHaveLength(1)
    expect(verifiedEffectReceipts(task, [{ ...old, ownerId: 'other-task' }], new Set(['turn-old']))).toEqual([])
  })

  it('does not treat one successful write as completion of an unbounded process request', () => {
    const broad = { ...task, acceptance: { ...task.acceptance, effect: { provider: 'lark', operation: 'process' } } } as TaskRun
    const missingTarget = { ...task, acceptance: { ...task.acceptance, effect: { provider: 'lark', operation: 'approve' } } } as TaskRun
    expect(verifiedEffectReceipts(broad, [receipt()])).toEqual([])
    expect(verifiedEffectReceipts(broad, [receipt({ operation: 'list', toolName: 'lark_task_list' })])).toEqual([])
    expect(verifiedEffectReceipts(missingTarget, [receipt()])).toEqual([])
  })

  it('requires a persisted target set before accepting a broad process task', () => {
    const list = receipt({ operation: 'list', toolName: 'lark_task_list' })
    const pending = receipt({ status: 'prepared' })
    const denied = receipt()
    denied.result = { approved: false, item: { isError: false, output: { ok: true, status: 'succeeded', evidence: evidence('lark', 'approve', 'a') } } }
    expect(verifiedEffectReceipts(processTask, [])).toEqual([])
    expect(verifiedEffectReceipts(processTask, [list])).toEqual([])
    expect(verifiedEffectReceipts(processTask, [pending])).toEqual([])
    expect(verifiedEffectReceipts(processTask, [denied])).toEqual([])
    expect(verifiedEffectReceipts(processTask, [receipt()])).toEqual([])
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

  it('accepts an unknown dispatch only with its original approval and a separate matching readback receipt', () => {
    const unknown = receipt({ status: 'outcome_unknown' })
    unknown.result = undefined
    unknown.request = { ...unknown.request, approvalRequestHash: 'approved-request-hash' }
    unknown.dispatchApproval = { toolName: 'lark_approval_approve', requestHash: 'approved-request-hash', approvedAt: '2026-11-10T00:00:00Z' }
    const confirmed = evidence('lark', 'approve', 'a')
    const proof = { ...receipt(), id: 'readback-proof', kind: 'effect_verification',
      request: { originalReceiptId: unknown.id, originalFingerprint: unknown.fingerprint }, result: { evidence: confirmed } }
    unknown.resolution = { status: 'verified', receiptId: proof.id, evidence: confirmed as NonNullable<OperationReceipt['resolution']>['evidence'], resolvedAt: '2026-11-10T00:00:00Z' }
    expect(verifiedEffectReceipts(task, [unknown, proof])).toEqual([confirmed])
    expect(verifiedEffectReceipts(task, [unknown])).toEqual([])
    expect(verifiedEffectReceipts(task, [{ ...unknown, dispatchApproval: undefined }, proof])).toEqual([])
    expect(verifiedEffectReceipts(task, [{ ...unknown, dispatchApproval: { ...unknown.dispatchApproval, requestHash: 'other-request' } }, proof])).toEqual([])
    expect(verifiedEffectReceipts(task, [unknown, { ...proof, ownerId: 'other-task' }])).toEqual([])
    expect(verifiedEffectReceipts(task, [unknown, { ...proof, status: 'failed' }])).toEqual([])
    expect(verifiedEffectReceipts(task, [unknown, { ...proof, request: { ...proof.request, originalFingerprint: 'other-fingerprint' } }])).toEqual([])
    expect(verifiedEffectReceipts(task, [unknown, { ...proof, result: { evidence: evidence('dingtalk', 'approve', 'a') } }])).toEqual([])
  })
})
