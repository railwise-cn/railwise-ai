import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendQualityWorkflowEvent, createQualityWorkflow, listQualityWorkflows, parseQualityWorkflow, workflowSource } from './survey-quality-workflow-client'
import { appendFixture, emptyWorkflow, workflowFixture } from './survey-quality-workflow-test-fixtures'
const runtimeRequest = vi.fn()
vi.mock('./runtime-client', () => ({ rendererRuntimeClient: { runtimeRequest: (...args: unknown[]) => runtimeRequest(...args) } }))
const context = workflowFixture(), corrected = workflowFixture('2')
const evidence = { ...workflowSource(context), memberId: 'output-1' }
const response = (value: unknown) => ({ ok: true, status: 200, body: JSON.stringify(value) })
const check = { kind: 'check' as const, checkId: 'closure', outcome: 'failed' as const, evidence }
beforeEach(() => runtimeRequest.mockReset())

describe('declared workflow client trust boundary', () => {
  it('reads actual service shape and validates the complete correction/recheck chain', async () => {
    let value = emptyWorkflow(context)
    value = appendFixture(value, check, 'append-check', context)
    value = appendFixture(value, { kind: 'issue-opened', checkId: 'closure', issueId: 'issue-1', evidence }, 'append-issue', context)
    value = appendFixture(value, { kind: 'correction-recorded', issueId: 'issue-1', correctionId: 'fix-1', corrected: workflowSource(corrected), evidence: { ...workflowSource(corrected), memberId: 'output-1' } }, 'append-correction', corrected, corrected)
    value = appendFixture(value, { kind: 'issue-rechecked', issueId: 'issue-1', correctionId: 'fix-1', rechecked: workflowSource(corrected), outcome: 'resolved', evidence: { ...workflowSource(corrected), memberId: 'output-1' } }, 'append-recheck', corrected, corrected)
    expect((await parseQualityWorkflow(value, context)).openIssueCount).toBe(0)
    expect((await parseQualityWorkflow(value, context)).deliveryApproval).toBe('not-granted')
  })
  it('rejects role impersonation, false counters, mismatched source/head and altered hashes', async () => {
    const value = appendFixture(emptyWorkflow(context), check, 'append-check', context)
    const mutations: Array<(copy: typeof value) => void> = [
      copy => { copy.workflow.binding.manifestHash = 'f'.repeat(64) },
      copy => { copy.workflow.binding.recordId = 'other' },
      copy => { copy.workflow.binding.retentionHeadHash = 'f'.repeat(64) },
      copy => { copy.workflow.binding.projectRevision = 3 },
      copy => { copy.headHash = 'f'.repeat(64) },
      copy => { copy.openIssueCount = 20 },
      copy => { copy.recordedCheckCount = 20 },
      copy => { copy.entries[0]!.event.actor = { id: 'engineer', kind: 'human' } },
      copy => { copy.entries[0]!.event.stage = 'approved' },
      copy => { copy.entries[0]!.event.thisHash = 'f'.repeat(64) },
      copy => { copy.entries[0]!.evidenceBinding.projectId = 'other' },
      copy => { copy.entries[0]!.evidenceBinding.manifestHash = 'f'.repeat(64) },
      copy => { copy.entries[0]!.request.event.evidence.memberId = 'manifest' },
      copy => { copy.workflow.createdAt = '2026-09-25T00:00:00.000Z' },
      copy => { copy.entries[0]!.request.expectedHeadHash = 'f'.repeat(64) }
    ]
    for (const mutate of mutations) { const copy = structuredClone(value); mutate(copy); await expect(parseQualityWorkflow(copy, context)).rejects.toMatchObject({ reason: 'invalid-response' }) }
  })
  it('binds create key and append payload, evidence bytes, target and previous entries', async () => {
    runtimeRequest.mockResolvedValueOnce(response(emptyWorkflow(context, 'wrong-key')))
    await expect(createQualityWorkflow(context, 'intended-key')).rejects.toMatchObject({ reason: 'invalid-response' })
    const current = emptyWorkflow(context), valid = appendFixture(current, check, 'append-check', context)
    runtimeRequest.mockResolvedValueOnce(response(valid))
    await expect(appendQualityWorkflowEvent(context, current, check, 'append-check', context)).resolves.toEqual(valid)
    runtimeRequest.mockResolvedValueOnce(response(valid))
    await expect(appendQualityWorkflowEvent(context, current, check, 'different-key', context)).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockClear()
    await expect(appendQualityWorkflowEvent(context, current, check, 'append-check', context, undefined, () => false)).rejects.toMatchObject({ reason: 'stale' })
    expect(runtimeRequest).not.toHaveBeenCalled()
  })
  it('accepts resource-bounded short history pages and rejects duplicate/forged pagination', async () => {
    runtimeRequest.mockResolvedValueOnce(response({ workflows: [emptyWorkflow(context)], unavailable: [], nextOffset: 1 }))
    expect((await listQualityWorkflows(context)).nextOffset).toBe(1)
    for (const page of [
      { workflows: [emptyWorkflow(context)], unavailable: [], nextOffset: 0 },
      { workflows: [], unavailable: [], nextOffset: 1 },
      { workflows: [emptyWorkflow(context), emptyWorkflow(context)], unavailable: [], nextOffset: null }
    ]) { runtimeRequest.mockResolvedValueOnce(response(page)); await expect(listQualityWorkflows(context)).rejects.toMatchObject({ reason: 'invalid-response' }) }
  })
})
