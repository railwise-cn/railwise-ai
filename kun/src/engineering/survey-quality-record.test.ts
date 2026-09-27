import { describe, expect, it } from 'vitest'
import type { SurveyQualityEventV1 } from '../contracts/survey-standard-quality.js'
import { appendSurveyQualityEvent, evaluateSurveyFinalArtifactCoverage, verifySurveyQualityRecord } from './survey-quality-record.js'

type Input = Omit<SurveyQualityEventV1, 'sequence' | 'previousHash' | 'thisHash'>
const sha = '1'.repeat(64)
const corrected = '2'.repeat(64)
function input(id: string, event: Input['event'], updates: Partial<Input> = {}): Input {
  return { schemaVersion: 1, id, projectId: 'test-project', artifactSha256: sha,
    occurredAt: '2026-09-19T00:00:00Z', actor: { id: 'test-agent', kind: 'agent' },
    stage: 'local-project-review', event, ...updates }
}
function failingCheck() {
  return appendSurveyQualityEvent([], input('event-1', {
    kind: 'check', checkId: 'check-1', outcome: 'failed', evidenceSha256: sha
  }))
}
function opened() {
  return appendSurveyQualityEvent(failingCheck(), input('event-2', {
    kind: 'issue-opened', issueId: 'issue-1', checkId: 'check-1', evidenceSha256: sha
  }))
}
function correction() {
  return appendSurveyQualityEvent(opened(), input('event-3', {
    kind: 'correction-recorded', issueId: 'issue-1', correctionId: 'correction-1', correctedArtifactSha256: corrected,
    evidenceSha256: sha
  }))
}
function recheck(updates: Partial<Extract<Input['event'], { kind: 'issue-rechecked' }>> = {}) {
  return input('event-4', { kind: 'issue-rechecked', issueId: 'issue-1', correctionId: 'correction-1',
    recheckedArtifactSha256: corrected, outcome: 'resolved', evidenceSha256: sha, ...updates })
}

describe('survey quality record integrity', () => {
  it('records a correction and exact-artifact recheck without claiming standards compliance or human signature', () => {
    const original = correction(); const snapshot = JSON.stringify(original)
    const result = appendSurveyQualityEvent(original, recheck())
    expect(verifySurveyQualityRecord(result)).toEqual({ valid: true, errors: [], openIssueCount: 0,
      recordedCheckCount: 1, standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' })
    expect(JSON.stringify(original)).toBe(snapshot)
    result[0]!.actor.id = 'mutated'
    expect(original[0]!.actor.id).toBe('test-agent')
  })

  it('keeps unresolved issues open and rejects rechecking an absent or superseded correction', () => {
    expect(verifySurveyQualityRecord(appendSurveyQualityEvent(correction(), recheck({ outcome: 'unresolved' }))).openIssueCount).toBe(1)
    expect(() => appendSurveyQualityEvent(opened(), recheck())).toThrow('recheck-without-current-correction')
    expect(() => appendSurveyQualityEvent(correction(), recheck({ correctionId: 'old' }))).toThrow('recheck-without-current-correction')
    expect(() => appendSurveyQualityEvent(correction(), recheck({ recheckedArtifactSha256: sha }))).toThrow('recheck-without-current-correction')
  })

  it('never permits unchanged-artifact corrections or a second closure', () => {
    expect(() => appendSurveyQualityEvent(opened(), input('event-3', {
      kind: 'correction-recorded', issueId: 'issue-1', correctionId: 'correction-1', correctedArtifactSha256: sha,
      evidenceSha256: sha
    }))).toThrow('correction-with-unchanged-artifact')
    const closed = appendSurveyQualityEvent(correction(), recheck())
    expect(() => appendSurveyQualityEvent(closed, { ...recheck(), id: 'event-5' })).toThrow('recheck-without-current-correction')
  })

  it('detects tampering, reordering, deletion and invalid schema without leaking evidence values', () => {
    const history = correction()
    const tampered = structuredClone(history); tampered[0]!.actor.id = 'PRIVATE'
    const report = verifySurveyQualityRecord(tampered)
    expect(report.valid).toBe(false)
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(verifySurveyQualityRecord([...history].reverse()).valid).toBe(false)
    expect(verifySurveyQualityRecord(history.slice(1)).valid).toBe(false)
    expect(verifySurveyQualityRecord([{ private: 'PRIVATE' }]).errors).toEqual(['event[0]:invalid-schema'])
    expect(() => appendSurveyQualityEvent(tampered, recheck())).toThrow('Invalid quality record history')
  })

  it('rejects duplicate identifiers, cross-project/artifact binding and backwards times', () => {
    const next = input('event-2', { kind: 'check', checkId: 'check-2', outcome: 'not-evaluated', evidenceSha256: sha })
    for (const updates of [{ id: 'event-1' }, { projectId: 'other' }, { artifactSha256: corrected },
      { occurredAt: '2026-09-18T23:59:59Z' }]) {
      expect(() => appendSurveyQualityEvent(failingCheck(), { ...next, ...updates })).toThrow('Invalid quality event')
    }
    expect(() => appendSurveyQualityEvent(failingCheck(), input('event-2', {
      kind: 'check', checkId: 'check-1', outcome: 'failed', evidenceSha256: sha
    }))).toThrow('duplicate-check-id')
  })

  it('requires a prior nonpassing check before opening an issue', () => {
    const event = input('event-2', { kind: 'issue-opened', issueId: 'issue-1', checkId: 'absent', evidenceSha256: sha })
    expect(() => appendSurveyQualityEvent(failingCheck(), event)).toThrow('issue-without-nonpassing-check')
    const passed = appendSurveyQualityEvent([], input('event-1', { kind: 'check', checkId: 'passed', outcome: 'passed', evidenceSha256: sha }))
    expect(() => appendSurveyQualityEvent(passed, { ...event, event: { ...event.event, checkId: 'passed' } } as Input)).toThrow('issue-without-nonpassing-check')
  })

  it('accepts timezone-equivalent event times and keeps an empty record unevaluated', () => {
    const record = appendSurveyQualityEvent(failingCheck(), input('event-2', {
      kind: 'check', checkId: 'check-2', outcome: 'not-evaluated', evidenceSha256: sha
    }, { occurredAt: '2026-09-19T08:00:00+08:00' }))
    expect(verifySurveyQualityRecord(record).valid).toBe(true)
    expect(verifySurveyQualityRecord([])).toMatchObject({ valid: true, recordedCheckCount: 0, standardConformity: 'not-evaluated' })
  })

  it('detects tail truncation and substituted project records against an independent checkpoint', () => {
    const history = correction()
    const checkpoint = { projectId: 'test-project', artifactSha256: sha,
      eventCount: history.length, headHash: history.at(-1)!.thisHash }
    expect(verifySurveyQualityRecord(history, checkpoint).valid).toBe(true)
    expect(verifySurveyQualityRecord(history.slice(0, -1), checkpoint).errors).toContain('checkpoint-mismatch')
    expect(verifySurveyQualityRecord(history, { ...checkpoint, projectId: 'other' }).errors).toContain('checkpoint-mismatch')
    expect(verifySurveyQualityRecord([], checkpoint).errors).toContain('checkpoint-mismatch')
  })
})

function checkpoint(history: SurveyQualityEventV1[]) {
  return { projectId: 'test-project', artifactSha256: sha,
    eventCount: history.length, headHash: history.at(-1)?.thisHash ?? '0'.repeat(64) }
}
function coverage(history: SurveyQualityEventV1[], finalArtifactSha256 = corrected, requiredCheckIds = ['check-1']) {
  return evaluateSurveyFinalArtifactCoverage(history, { schemaVersion: 1, projectId: 'test-project',
    finalArtifactSha256, requiredCheckIds, checkpoint: checkpoint(history) })
}
function checkArtifact(history: SurveyQualityEventV1[], checkId = 'check-1', checkedArtifactSha256 = corrected,
  outcome: 'passed' | 'failed' | 'not-evaluated' = 'passed') {
  return appendSurveyQualityEvent(history, input(`event-${history.length + 1}`, {
    kind: 'artifact-check', checkId, checkedArtifactSha256, outcome, evidenceSha256: sha
  }))
}

describe('final artifact recorded check coverage', () => {
  it('requires an explicit passed check on corrected bytes, not only a resolved issue', () => {
    const closed = appendSurveyQualityEvent(correction(), recheck())
    expect(verifySurveyQualityRecord(closed).openIssueCount).toBe(0)
    expect(coverage(closed)).toMatchObject({ coverageStatus: 'incomplete', checks: [{ status: 'artifact-mismatch' }] })
    const checked = checkArtifact(closed)
    expect(coverage(checked)).toMatchObject({ coverageStatus: 'covered', recordIntegrity: true,
      checks: [{ checkId: 'check-1', status: 'passed', checkedArtifactSha256: corrected, eventId: 'event-5' }],
      standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' })
  })

  it('preserves original V1 checks as coverage only for their original artifact', () => {
    const original = appendSurveyQualityEvent([], input('event-1', {
      kind: 'check', checkId: 'check-1', outcome: 'passed', evidenceSha256: sha
    }))
    expect(coverage(original, sha).coverageStatus).toBe('covered')
    expect(coverage(original, corrected).checks[0]!.status).toBe('artifact-mismatch')
    expect(() => checkArtifact([], 'never-recorded')).toThrow('artifact-check-without-original-check')
  })

  it('uses latest sequence, including a later failure or unevaluated outcome at the same timestamp', () => {
    let history = checkArtifact(appendSurveyQualityEvent(correction(), recheck()))
    expect(coverage(history).coverageStatus).toBe('covered')
    history = checkArtifact(history, 'check-1', corrected, 'failed')
    expect(coverage(history)).toMatchObject({ coverageStatus: 'incomplete', checks: [{ status: 'failed' }] })
    history = checkArtifact(history, 'check-1', corrected, 'not-evaluated')
    expect(coverage(history)).toMatchObject({ coverageStatus: 'incomplete', checks: [{ status: 'not-evaluated' }] })
    history = checkArtifact(history)
    expect(coverage(history).coverageStatus).toBe('covered')
    history = checkArtifact(history, 'check-1', '3'.repeat(64))
    expect(coverage(history, corrected).checks[0]!.status).toBe('artifact-mismatch')
  })

  it('prevents a repeated logical check from silently replacing or dropping its original rule version', () => {
    const rule = { standardCode: 'TEST-ONLY', standardVersion: '2026', ruleId: 'synthetic-check', ruleVersion: '1' }
    const history = appendSurveyQualityEvent([], input('event-1', {
      kind: 'check', checkId: 'check-1', rule, outcome: 'failed', evidenceSha256: sha
    }))
    const repeat = input('event-2', { kind: 'artifact-check', checkId: 'check-1', checkedArtifactSha256: corrected,
      rule, outcome: 'passed', evidenceSha256: sha })
    expect(coverage(appendSurveyQualityEvent(history, repeat)).coverageStatus).toBe('covered')
    for (const replacement of [undefined, { ...rule, ruleVersion: '2' }]) {
      expect(() => appendSurveyQualityEvent(history, { ...repeat, event: { ...repeat.event, rule: replacement } } as Input))
        .toThrow('artifact-check-rule-mismatch')
    }
  })

  it('blocks missing checks, empty requirements, duplicate requirements and absent independent checkpoints', () => {
    const history = checkArtifact(appendSurveyQualityEvent(correction(), recheck()))
    expect(coverage(history, corrected, ['check-1', 'missing'])).toMatchObject({ coverageStatus: 'incomplete',
      checks: [{ status: 'passed' }, { checkId: 'missing', status: 'missing' }] })
    expect(coverage([]).coverageStatus).toBe('incomplete')
    const request = { schemaVersion: 1, projectId: 'test-project', finalArtifactSha256: corrected,
      requiredCheckIds: ['check-1'], checkpoint: checkpoint(history) }
    for (const requiredCheckIds of [[], ['check-1', 'check-1'], ['check-1', ' check-1 ']]) {
      expect(() => evaluateSurveyFinalArtifactCoverage(history, { ...request, requiredCheckIds })).toThrow()
    }
    expect(() => evaluateSurveyFinalArtifactCoverage(history, { ...request, checkpoint: undefined })).toThrow()
  })

  it('blocks unclosed issues even when every requested final check has passed', () => {
    const history = checkArtifact(correction())
    expect(coverage(history)).toMatchObject({ coverageStatus: 'incomplete', reasons: ['unresolved-issues'],
      checks: [{ status: 'passed' }] })
    const unresolved = appendSurveyQualityEvent(history, { ...recheck({ outcome: 'unresolved' }), id: 'event-5' })
    expect(coverage(unresolved).coverageStatus).toBe('incomplete')
  })

  it('does not combine closed issues and passing checks across different corrected artifacts', () => {
    let history: SurveyQualityEventV1[] = []
    const third = '3'.repeat(64)
    for (const [index, artifact] of [[1, corrected], [2, third]] as const) {
      const append = (event: Input['event']) => { history = appendSurveyQualityEvent(history, input(`event-${history.length + 1}`, event)) }
      append({ kind: 'check', checkId: `check-${index}`, outcome: 'failed', evidenceSha256: sha })
      append({ kind: 'issue-opened', checkId: `check-${index}`, issueId: `issue-${index}`, evidenceSha256: sha })
      append({ kind: 'correction-recorded', issueId: `issue-${index}`, correctionId: `correction-${index}`,
        correctedArtifactSha256: artifact, evidenceSha256: sha })
      append({ kind: 'issue-rechecked', issueId: `issue-${index}`, correctionId: `correction-${index}`,
        recheckedArtifactSha256: artifact, outcome: 'resolved', evidenceSha256: sha })
      history = checkArtifact(history, `check-${index}`, artifact)
    }
    expect(verifySurveyQualityRecord(history).openIssueCount).toBe(0)
    expect(coverage(history, corrected, ['check-1', 'check-2'])).toMatchObject({ coverageStatus: 'incomplete',
      checks: [{ status: 'stale-after-correction' }, { status: 'artifact-mismatch' }] })
    history = checkArtifact(history, 'check-1', third)
    expect(coverage(history, third, ['check-1', 'check-2']).coverageStatus).toBe('covered')
  })

  it('refuses tampered or truncated chains using the independently retained final checkpoint', () => {
    const history = checkArtifact(appendSurveyQualityEvent(correction(), recheck()))
    const request = { schemaVersion: 1, projectId: 'test-project', finalArtifactSha256: corrected,
      requiredCheckIds: ['check-1'], checkpoint: checkpoint(history) }
    const tampered = structuredClone(history); tampered.at(-1)!.actor.id = 'changed'
    for (const invalid of [tampered, history.slice(0, -1), [...history].reverse()]) {
      expect(evaluateSurveyFinalArtifactCoverage(invalid, request)).toMatchObject({
        coverageStatus: 'not-evaluated', recordIntegrity: false, checks: []
      })
    }
    expect(evaluateSurveyFinalArtifactCoverage(history, { ...request, projectId: 'other' })).toMatchObject({
      coverageStatus: 'not-evaluated', reasons: ['requested-project-mismatch']
    })
  })
})
