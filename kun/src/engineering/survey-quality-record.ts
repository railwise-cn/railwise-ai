import { createHash } from 'node:crypto'
import { SurveyFinalArtifactCoverageRequestV1, SurveyFinalArtifactCoverageV1,
  SurveyQualityCheckpointV1, SurveyQualityEventV1, type SurveyQualityCheckpointV1 as Checkpoint,
  type SurveyQualityEventV1 as QualityEvent } from '../contracts/survey-standard-quality.js'

export const SURVEY_QUALITY_CHAIN_GENESIS = '0'.repeat(64)

function digest(event: Omit<QualityEvent, 'thisHash'>): string {
  // Zod parsing gives a fixed schema field order, including discriminated event fields.
  const { thisHash: _hash, ...parsed } = SurveyQualityEventV1.parse({ ...event, thisHash: SURVEY_QUALITY_CHAIN_GENESIS })
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
}

export type SurveyQualityIntegrity = {
  valid: boolean
  errors: string[]
  openIssueCount: number
  recordedCheckCount: number
  standardConformity: 'not-evaluated'
  humanSignatureVerification: 'not-evaluated'
}

/** Internal workflow integrity only, not GB/T 24356 sampling/scoring or acceptance. */
export function verifySurveyQualityRecord(inputs: readonly unknown[], checkpoint?: Checkpoint): SurveyQualityIntegrity {
  const errors: string[] = []
  const ids = new Set<string>()
  const checks = new Map<string, 'passed' | 'failed' | 'not-evaluated'>()
  const originalRules = new Map<string, string>()
  const issues = new Map<string, { correctionId?: string; correctedArtifactSha256?: string; resolved: boolean }>()
  const corrections = new Set<string>()
  let previousHash = SURVEY_QUALITY_CHAIN_GENESIS
  let previousTime = -Infinity
  let binding: { projectId: string; artifactSha256: string } | undefined
  for (const [index, input] of inputs.entries()) {
    const parsed = SurveyQualityEventV1.safeParse(input)
    if (!parsed.success) { errors.push(`event[${index}]:invalid-schema`); continue }
    const item = parsed.data
    const error = (reason: string): void => { errors.push(`event[${index}]:${reason}`) }
    if (ids.has(item.id)) error('duplicate-event-id')
    ids.add(item.id)
    if (item.sequence !== index + 1) error('noncontiguous-sequence')
    if (item.previousHash !== previousHash || item.thisHash !== digest(item)) error('hash-chain-mismatch')
    if (Date.parse(item.occurredAt) < previousTime) error('backwards-time')
    if (binding && (item.projectId !== binding.projectId || item.artifactSha256 !== binding.artifactSha256)) error('cross-project-or-artifact')
    binding ??= { projectId: item.projectId, artifactSha256: item.artifactSha256 }
    const event = item.event
    if (event.kind === 'check') {
      if (checks.has(event.checkId)) error('duplicate-check-id')
      else {
        checks.set(event.checkId, event.outcome)
        originalRules.set(event.checkId, JSON.stringify(event.rule ?? null))
      }
    } else if (event.kind === 'artifact-check') {
      if (!checks.has(event.checkId)) error('artifact-check-without-original-check')
      else if (originalRules.get(event.checkId) !== JSON.stringify(event.rule ?? null)) error('artifact-check-rule-mismatch')
      else checks.set(event.checkId, event.outcome)
    } else if (event.kind === 'issue-opened') {
      if (issues.has(event.issueId)) error('duplicate-issue-id')
      if (!checks.has(event.checkId) || checks.get(event.checkId) === 'passed') error('issue-without-nonpassing-check')
      if (!issues.has(event.issueId)) issues.set(event.issueId, { resolved: false })
    } else if (event.kind === 'correction-recorded') {
      const issue = issues.get(event.issueId)
      if (!issue || issue.resolved) error('correction-without-open-issue')
      if (corrections.has(event.correctionId)) error('duplicate-correction-id')
      if (event.correctedArtifactSha256 === item.artifactSha256) error('correction-with-unchanged-artifact')
      corrections.add(event.correctionId)
      if (issue && !issue.resolved) {
        issue.correctionId = event.correctionId
        issue.correctedArtifactSha256 = event.correctedArtifactSha256
      }
    } else {
      const issue = issues.get(event.issueId)
      if (!issue || issue.resolved || issue.correctionId !== event.correctionId
        || issue.correctedArtifactSha256 !== event.recheckedArtifactSha256) error('recheck-without-current-correction')
      else issue.resolved = event.outcome === 'resolved'
    }
    previousHash = item.thisHash
    previousTime = Date.parse(item.occurredAt)
  }
  if (checkpoint) {
    const parsed = SurveyQualityCheckpointV1.safeParse(checkpoint)
    if (!parsed.success) errors.push('invalid-checkpoint')
    else if (parsed.data.eventCount !== inputs.length || parsed.data.headHash !== previousHash
      || (binding && (parsed.data.projectId !== binding.projectId || parsed.data.artifactSha256 !== binding.artifactSha256))) {
      errors.push('checkpoint-mismatch')
    }
  }
  return { valid: errors.length === 0, errors, openIssueCount: [...issues.values()].filter(issue => !issue.resolved).length,
    recordedCheckCount: checks.size, standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' }
}

/** Creates a new array; rejects broken history and invalid transitions before returning. */
export function appendSurveyQualityEvent(history: readonly QualityEvent[], input: Omit<QualityEvent, 'sequence' | 'previousHash' | 'thisHash'>): QualityEvent[] {
  if (!verifySurveyQualityRecord(history).valid) throw new Error('Invalid quality record history')
  const event = SurveyQualityEventV1.parse({ ...input, sequence: history.length + 1,
    previousHash: history.at(-1)?.thisHash ?? SURVEY_QUALITY_CHAIN_GENESIS, thisHash: SURVEY_QUALITY_CHAIN_GENESIS })
  event.thisHash = digest(event)
  const result = [...history.map(item => SurveyQualityEventV1.parse(item)), event]
  const verification = verifySurveyQualityRecord(result)
  if (!verification.valid) throw new Error(`Invalid quality event: ${verification.errors.join(', ')}`)
  return result
}

/**
 * Recorded coverage only. A trusted recorder must establish evidence bytes and
 * check semantics; this pure function cannot authenticate an outcome or signer.
 */
export function evaluateSurveyFinalArtifactCoverage(inputs: readonly unknown[], input: unknown): SurveyFinalArtifactCoverageV1 {
  const request = SurveyFinalArtifactCoverageRequestV1.parse(input)
  const integrity = verifySurveyQualityRecord(inputs, request.checkpoint)
  const result: SurveyFinalArtifactCoverageV1 = {
    schemaVersion: 1, projectId: request.projectId, finalArtifactSha256: request.finalArtifactSha256,
    assessmentBasis: 'recorded-events-only',
    coverageStatus: 'not-evaluated', recordIntegrity: integrity.valid, reasons: [], checks: [],
    standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated'
  }
  if (!integrity.valid) {
    result.reasons = ['invalid-quality-record', ...integrity.errors]
    return result
  }
  if (request.checkpoint.projectId !== request.projectId) {
    result.reasons = ['requested-project-mismatch']
    return result
  }
  const latest = new Map<string, { item: QualityEvent; artifactSha256: string;
    outcome: 'passed' | 'failed' | 'not-evaluated'; evidenceSha256: string }>()
  let lastCorrectionSequence = 0
  for (const value of inputs) {
    const item = SurveyQualityEventV1.parse(value)
    const event = item.event
    if (event.kind === 'check' || event.kind === 'artifact-check') {
      latest.set(event.checkId, { item, artifactSha256: event.kind === 'check' ? item.artifactSha256 : event.checkedArtifactSha256,
        outcome: event.outcome, evidenceSha256: event.evidenceSha256 })
    } else if (event.kind === 'correction-recorded') lastCorrectionSequence = item.sequence
  }
  result.checks = request.requiredCheckIds.map(checkId => {
    const recorded = latest.get(checkId)
    if (!recorded) return { checkId, status: 'missing' }
    const status = recorded.artifactSha256 !== request.finalArtifactSha256 ? 'artifact-mismatch'
      : recorded.item.sequence <= lastCorrectionSequence ? 'stale-after-correction' : recorded.outcome
    return { checkId, status, eventId: recorded.item.id, sequence: recorded.item.sequence,
      checkedArtifactSha256: recorded.artifactSha256, evidenceSha256: recorded.evidenceSha256 }
  })
  if (integrity.openIssueCount > 0) result.reasons.push('unresolved-issues')
  if (result.checks.some(check => check.status !== 'passed')) result.reasons.push('required-final-checks-incomplete')
  result.coverageStatus = result.reasons.length ? 'incomplete' : 'covered'
  return SurveyFinalArtifactCoverageV1.parse(result)
}
