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
  const stages = new Map<string, { stageKind: 'planning' | 'process' | 'final' | 'acceptance'; status: 'started' | 'completed' | 'blocked' }>()
  const applicability = new Map<string, { status: 'applicable' | 'not-applicable' | 'pending'; revoked: boolean }>()
  const signoffs = new Map<string, { purpose: 'quality-review' | 'delivery-approval'; revoked: boolean }>()
  const approvals = new Set<string>()
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
    } else if (event.kind === 'issue-rechecked') {
      const issue = issues.get(event.issueId)
      if (!issue || issue.resolved || issue.correctionId !== event.correctionId
        || issue.correctedArtifactSha256 !== event.recheckedArtifactSha256) error('recheck-without-current-correction')
      else issue.resolved = event.outcome === 'resolved'
    } else if (event.kind === 'stage-started') {
      if (stages.has(event.stageId)) error('duplicate-stage-id')
      const order = ['planning', 'process', 'final', 'acceptance'].indexOf(event.stageKind)
      const prior = order > 0 && [...stages.values()].some(stage => stage.stageKind === ['planning', 'process', 'final'][order - 1] && stage.status === 'completed')
      if (order > 0 && !prior) error('stage-out-of-order')
      if (!stages.has(event.stageId)) stages.set(event.stageId, { stageKind: event.stageKind, status: 'started' })
    } else if (event.kind === 'stage-completed') {
      const stage = stages.get(event.stageId)
      if (!stage || stage.stageKind !== event.stageKind || stage.status !== 'started') error('stage-completion-without-start')
      else stage.status = event.outcome === 'completed' ? 'completed' : 'blocked'
    } else if (event.kind === 'rule-applicability') {
      if (applicability.has(event.declarationId)) error('duplicate-applicability-id')
      else applicability.set(event.declarationId, { status: event.status, revoked: false })
    } else if (event.kind === 'rule-revoked') {
      const declaration = applicability.get(event.declarationId)
      if (!declaration || declaration.revoked) error('rule-revocation-without-active-declaration')
      else declaration.revoked = true
    } else if (event.kind === 'signoff-declared') {
      if (signoffs.has(event.signoffId)) error('duplicate-signoff-id')
      else signoffs.set(event.signoffId, { purpose: event.purpose, revoked: false })
    } else if (event.kind === 'signoff-revoked') {
      const signoff = signoffs.get(event.signoffId)
      if (!signoff || signoff.revoked) error('signoff-revocation-without-active-signoff')
      else signoff.revoked = true
    } else {
      if (approvals.has(event.approvalId)) error('duplicate-approval-id')
      const acceptanceComplete = [...stages.values()].some(stage => stage.stageKind === 'acceptance' && stage.status === 'completed')
      const unresolved = [...issues.values()].some(issue => !issue.resolved)
      const declarations = [...applicability.values()].filter(declaration => !declaration.revoked)
      const activeApplicable = declarations.filter(declaration => declaration.status === 'applicable')
      const pending = declarations.some(declaration => declaration.status === 'pending')
      const requiredSignoffs = new Set(event.requiredSignoffIds)
      const activeDeliverySignoffs = [...signoffs.entries()].filter(([id, signoff]) => requiredSignoffs.has(id) && signoff.purpose === 'delivery-approval' && !signoff.revoked)
      if (unresolved) error('approval-with-open-issues')
      if (!acceptanceComplete) error('approval-before-acceptance')
      if (!activeApplicable.length || pending) error('approval-without-applicable-rules')
      if (activeDeliverySignoffs.length !== requiredSignoffs.size) error('approval-without-active-signoff')
      approvals.add(event.approvalId)
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

export type SurveyQualityGateSnapshot = {
  schemaVersion: 1
  status: 'not-evaluated' | 'blocked' | 'ready-for-external-approval'
  reasons: Array<'versioned-stage-record-missing' | 'acceptance-stage-incomplete' | 'open-issues' | 'blocking-stage'
    | 'applicability-not-evaluated' | 'rule-revoked' | 'signoff-missing' | 'signoff-revoked'
    | 'approval-request-missing' | 'approval-request-incomplete' | 'record-integrity-failed'
    | 'failed-quality-check' | 'quality-check-not-evaluated'>
  completedStageKinds: Array<'planning' | 'process' | 'final' | 'acceptance'>
  activeApplicableRuleIds: string[]
  revokedRuleIds: string[]
  activeSignoffIds: string[]
  revokedSignoffIds: string[]
  approvalRequestIds: string[]
}

/**
 * Derives a conservative delivery gate from the append-only declarations.
 * "ready-for-external-approval" is eligibility only; it never grants approval
 * and cannot change a draft manifest's review status.
 */
export function evaluateSurveyQualityGate(inputs: readonly unknown[]): SurveyQualityGateSnapshot {
  const integrity = verifySurveyQualityRecord(inputs)
  const reasons = new Set<SurveyQualityGateSnapshot['reasons'][number]>()
  const stages = new Map<string, { kind: 'planning' | 'process' | 'final' | 'acceptance'; status: 'started' | 'completed' | 'blocked' }>()
  const rules = new Map<string, { status: 'applicable' | 'not-applicable' | 'pending'; revoked: boolean }>()
  const signoffs = new Map<string, { purpose: 'quality-review' | 'delivery-approval'; revoked: boolean }>()
  const requests = new Map<string, string[]>()
  const checks = new Map<string, 'passed' | 'failed' | 'not-evaluated'>()
  let hasVersionedLifecycle = false
  for (const input of inputs) {
    const parsed = SurveyQualityEventV1.safeParse(input)
    if (!parsed.success) continue
    const event = parsed.data.event
    if (event.kind === 'stage-started') {
      hasVersionedLifecycle = true
      stages.set(event.stageId, { kind: event.stageKind, status: 'started' })
    } else if (event.kind === 'stage-completed') {
      hasVersionedLifecycle = true
      const stage = stages.get(event.stageId)
      if (stage) stage.status = event.outcome === 'completed' ? 'completed' : 'blocked'
    } else if (event.kind === 'rule-applicability') {
      hasVersionedLifecycle = true
      rules.set(event.declarationId, { status: event.status, revoked: false })
    } else if (event.kind === 'rule-revoked') {
      hasVersionedLifecycle = true
      const rule = rules.get(event.declarationId)
      if (rule) rule.revoked = true
    } else if (event.kind === 'signoff-declared') {
      hasVersionedLifecycle = true
      signoffs.set(event.signoffId, { purpose: event.purpose, revoked: false })
    } else if (event.kind === 'signoff-revoked') {
      hasVersionedLifecycle = true
      const signoff = signoffs.get(event.signoffId)
      if (signoff) signoff.revoked = true
    } else if (event.kind === 'delivery-approval-requested') {
      hasVersionedLifecycle = true
      requests.set(event.approvalId, event.requiredSignoffIds)
    } else if (event.kind === 'check' || event.kind === 'artifact-check') {
      // An artifact-check is the latest explicit outcome for the same logical
      // check and may move it back to passed after a correction.
      checks.set(event.checkId, event.outcome)
    }
  }
  const completedStageKinds = [...new Set([...stages.values()].filter(stage => stage.status === 'completed').map(stage => stage.kind))]
  const activeApplicableRuleIds = [...rules.entries()].filter(([, rule]) => !rule.revoked && rule.status === 'applicable').map(([id]) => id)
  const revokedRuleIds = [...rules.entries()].filter(([, rule]) => rule.revoked).map(([id]) => id)
  const activeSignoffIds = [...signoffs.entries()].filter(([, signoff]) => !signoff.revoked && signoff.purpose === 'delivery-approval').map(([id]) => id)
  const revokedSignoffIds = [...signoffs.entries()].filter(([, signoff]) => signoff.revoked).map(([id]) => id)
  const approvalRequestIds = [...requests.keys()]
  if (!integrity.valid) reasons.add('record-integrity-failed')
  if (!hasVersionedLifecycle) reasons.add('versioned-stage-record-missing')
  if (!completedStageKinds.includes('acceptance')) reasons.add('acceptance-stage-incomplete')
  if (integrity.openIssueCount > 0) reasons.add('open-issues')
  if ([...stages.values()].some(stage => stage.status === 'blocked')) reasons.add('blocking-stage')
  if ([...checks.values()].some(outcome => outcome === 'failed')) reasons.add('failed-quality-check')
  if ([...checks.values()].some(outcome => outcome === 'not-evaluated')) reasons.add('quality-check-not-evaluated')
  if (!rules.size || [...rules.values()].some(rule => !rule.revoked && rule.status === 'pending')) reasons.add('applicability-not-evaluated')
  if (revokedRuleIds.length) reasons.add('rule-revoked')
  if (!activeApplicableRuleIds.length) reasons.add('applicability-not-evaluated')
  if (!activeSignoffIds.length) reasons.add('signoff-missing')
  if (revokedSignoffIds.length && !activeSignoffIds.length) reasons.add('signoff-revoked')
  if (!approvalRequestIds.length) reasons.add('approval-request-missing')
  for (const required of requests.values()) {
    if (required.some(id => !activeSignoffIds.includes(id))) reasons.add('approval-request-incomplete')
  }
  const outputReasons = [...reasons]
  const eligible = integrity.valid && hasVersionedLifecycle && outputReasons.length === 0
  return { schemaVersion: 1, status: !hasVersionedLifecycle ? 'not-evaluated' : eligible ? 'ready-for-external-approval' : 'blocked',
    reasons: outputReasons, completedStageKinds, activeApplicableRuleIds, revokedRuleIds, activeSignoffIds, revokedSignoffIds, approvalRequestIds }
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
