import { describe, expect, it } from 'vitest'
import { deriveWebArtifactRepairState, type WebArtifactRepairAttempt } from './web-artifact-repair-state.js'

function failure(overrides: Partial<WebArtifactRepairAttempt> = {}): WebArtifactRepairAttempt {
  return { requirementHash: 'requirements-v1', evidenceFingerprint: 'trusted-sources-v1',
    failureKinds: ['missing_primary:https://gov.example.test'], reasons: ['正式公告正文尚未核验：https://gov.example.test'], ...overrides }
}

describe('web artifact semantic repair state', () => {
  it('allows one bounded repair and stalls the same source deficit on its second trusted failure', () => {
    const first = failure({ id: 'verify-1' })
    expect(deriveWebArtifactRepairState([], first)).toMatchObject({ failureCount: 1, stalled: false, reasons: first.reasons })
    expect(deriveWebArtifactRepairState([first], failure({ id: 'verify-2' }))).toMatchObject({ failureCount: 2, stalled: true })
  })

  it('does not reset semantic failures when HTML bytes, publication or display messages change', () => {
    const first = { ...failure({ id: 'verify-1' }), artifactHash: 'html-before', publicationId: 'publish-1' }
    const changed = { ...failure({ id: 'verify-2', reasons: ['同一正式来源仍然缺失；保留本次原始错误。'] }), artifactHash: 'html-after', publicationId: 'publish-2' }
    const before = deriveWebArtifactRepairState([], first)
    const after = deriveWebArtifactRepairState([first], changed)
    expect(after.fingerprint).toBe(before.fingerprint)
    expect(after).toMatchObject({ failureCount: 2, stalled: true, reasons: changed.reasons })
  })

  it('uses canonical error categories rather than their ordering, duplicates or report section identity', () => {
    const first = failure({ id: 'verify-1', failureKinds: ['field:budget', 'field:deadline', 'field:budget'], reasons: ['字段缺少正文与成果的精确依据：old-row/budget'] })
    const second = failure({ id: 'verify-2', failureKinds: ['field:deadline', 'field:budget'], reasons: ['字段缺少正文与成果的精确依据：renamed-row/budget'] })
    expect(deriveWebArtifactRepairState([first], second)).toMatchObject({
      fingerprint: deriveWebArtifactRepairState([], first).fingerprint, failureCount: 2, stalled: true, reasons: second.reasons
    })
  })

  it('counts different semantic categories separately without letting them erase an unchanged earlier deficit', () => {
    const first = failure({ id: 'verify-1', failureKinds: ['field:budget'] })
    const other = failure({ id: 'verify-2', failureKinds: ['field:deadline'] })
    expect(deriveWebArtifactRepairState([first], other)).toMatchObject({ failureCount: 1, stalled: false })
    expect(deriveWebArtifactRepairState([first, other], failure({ id: 'verify-3', failureKinds: ['field:budget'] }))).toMatchObject({ failureCount: 2, stalled: true })
  })

  it('does not reset a remaining deadline failure when a budget error is repaired', () => {
    const first = failure({ id: 'verify-1', failureKinds: ['field:budget', 'field:deadline'],
      reasons: ['预算与截止时间均缺少精确来源依据。'] })
    const repairedBudget = failure({ id: 'verify-2', failureKinds: ['field:deadline'],
      reasons: ['字段缺少正文与成果的精确依据：row/deadline'] })
    const result = deriveWebArtifactRepairState([first], repairedBudget)
    expect(result).toMatchObject({ failureCount: 2, stalled: true, reasons: repairedBudget.reasons })
    expect(result.fingerprint).not.toBe(deriveWebArtifactRepairState([], first).fingerprint)
  })

  it('does not clear a missing primary source by appending a different field error', () => {
    const first = failure({ id: 'verify-1' })
    const moreErrors = failure({ id: 'verify-2', failureKinds: [...first.failureKinds, 'field:budget'],
      reasons: [...first.reasons, '字段缺少正文与成果的精确依据：row/budget'] })
    expect(deriveWebArtifactRepairState([first], moreErrors)).toMatchObject({
      failureCount: 2, stalled: true, reasons: moreErrors.reasons
    })
  })

  it('deduplicates each receipt per failure kind while counting an independently repeated remaining defect', () => {
    const first = failure({ id: 'verify-1', failureKinds: ['field:budget', 'field:deadline'] })
    const duplicate = failure({ id: 'verify-1', failureKinds: ['field:deadline', 'field:deadline'] })
    expect(deriveWebArtifactRepairState([first], duplicate)).toMatchObject({ failureCount: 1, stalled: false })
    expect(deriveWebArtifactRepairState([first, duplicate], failure({ id: 'verify-2', failureKinds: ['field:deadline'] })))
      .toMatchObject({ failureCount: 2, stalled: true })
  })

  it.each(['evidenceFingerprint', 'requirementHash'] as const)('starts a new bounded repair after %s changes', key => {
    const first = failure({ id: 'verify-1' }), second = failure({ id: 'verify-2' })
    const updated = failure({ id: 'verify-3', [key]: 'new-epoch' })
    expect(deriveWebArtifactRepairState([first, second], updated)).toMatchObject({ failureCount: 1, stalled: false })
    expect(deriveWebArtifactRepairState([first, second], updated).fingerprint).not.toBe(deriveWebArtifactRepairState([first], second).fingerprint)
  })

  it('does not revive counters from an earlier epoch if source evidence later returns to the same fingerprint', () => {
    const first = failure({ id: 'verify-1' })
    const changed = failure({ id: 'verify-2', evidenceFingerprint: 'trusted-sources-v2' })
    expect(deriveWebArtifactRepairState([first, changed], failure({ id: 'verify-3' }))).toMatchObject({ failureCount: 1, stalled: false })
  })

  it('deduplicates persisted attempt identities, including a replayed current attempt', () => {
    const first = failure({ id: 'verify-1' })
    expect(deriveWebArtifactRepairState([first, { ...first }], { ...first })).toMatchObject({ failureCount: 1, stalled: false })
    expect(deriveWebArtifactRepairState([first, { ...first }], failure({ id: 'verify-2' }))).toMatchObject({ failureCount: 2, stalled: true })
  })

  it('can query the latest persisted failure without incrementing its count', () => {
    const first = failure({ id: 'verify-1' }), second = failure({ id: 'verify-2' })
    expect(deriveWebArtifactRepairState([first])).toEqual(deriveWebArtifactRepairState([], first))
    expect(deriveWebArtifactRepairState([first, second])).toEqual(deriveWebArtifactRepairState([first], second))
    expect(deriveWebArtifactRepairState([])).toEqual({ fingerprint: '', failureCount: 0, stalled: false, reasons: [] })
  })

  it('does not treat a successful assessment as another semantic failure', () => {
    const first = failure({ id: 'verify-1' })
    expect(deriveWebArtifactRepairState([first], failure({ id: 'verify-2', failureKinds: [], reasons: [] }))).toMatchObject({ failureCount: 0, stalled: false, reasons: [] })
  })

  it('leaves the trusted ledger inputs and original error messages unchanged', () => {
    const first = failure({ id: 'verify-1' }), second = failure({ id: 'verify-2' })
    const prior = Object.freeze([Object.freeze({ ...first, failureKinds: Object.freeze([...first.failureKinds]), reasons: Object.freeze([...first.reasons]) })])
    const current = Object.freeze({ ...second, failureKinds: Object.freeze([...second.failureKinds]), reasons: Object.freeze([...second.reasons]) })
    const before = JSON.stringify({ prior, current })
    const result = deriveWebArtifactRepairState(prior, current)
    result.reasons.push('local display note')
    expect(JSON.stringify({ prior, current })).toBe(before)
  })
})
