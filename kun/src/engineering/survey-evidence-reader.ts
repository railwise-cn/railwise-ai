import { SurveyEvidenceReferenceV1, type SurveyEvidenceSelectorV1 } from '../contracts/survey-evidence-reference.js'
import type { EngineeringService } from './engineering-service.js'
import type { SurveyService } from './survey-service.js'
import type { SurveyAdvancedTrialsWorkspaceService } from './survey-advanced-trials-workspace.js'
import type { SurveyQualityScoringWorkspaceService } from './survey-quality-scoring-workspace.js'
import type { SurveyQualityWorkspaceService } from './survey-quality-workspace.js'
import type { SurveySamplingWorkspaceService } from './survey-sampling-workspace.js'
import type { SurveyQualityAssessmentService } from './survey-quality-assessment.js'
import { resolveSurveyStandardBasis } from './survey-standard-basis.js'

export type SurveyEvidenceSources = {
  engineering: Pick<EngineeringService, 'getProject' | 'readMonitoringDatasetEvidence' | 'readMonitoringAnalysisEvidence' | 'readDeliverableVerificationEvidence' | 'readMonitoringReplayEvidence'>
  survey: Pick<SurveyService, 'getNetwork' | 'getRawSourceIntegrity' | 'getDeformationForProjectNewUse' | 'getAdjustmentStatisticalDiagnostics' | 'getFreeLevelingTrial'>
  advanced: Pick<SurveyAdvancedTrialsWorkspaceService, 'getTrial'>
  scoring: Pick<SurveyQualityScoringWorkspaceService, 'getRecord'>
  retention: Pick<SurveyQualityWorkspaceService, 'getPlan' | 'getRecord'>
  sampling: Pick<SurveySamplingWorkspaceService, 'getPopulation' | 'getRun' | 'listUnits' | 'listSamples'>
  assessment: Pick<SurveyQualityAssessmentService, 'getPlan' | 'getAssessment'>
}
class EvidenceError extends Error {
  constructor(readonly reason: 'not-found' | 'binding-mismatch' | 'selector-missing' | 'selector-identity-required' | 'selector-identity-mismatch') { super(reason) }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function same(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new EvidenceError('binding-mismatch')
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new EvidenceError('not-found')
  return value
}

export function selectSurveyEvidence(record: unknown, selector?: SurveyEvidenceSelectorV1): unknown {
  if (!selector) return record
  let current = record
  let indexedObject: Record<string, unknown> | undefined
  for (const segment of selector.path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || !Object.hasOwn(current, segment)) throw new EvidenceError('selector-missing')
      current = current[segment]
      if (object(current)) indexedObject = current
    } else {
      if (['__proto__', 'constructor', 'prototype'].includes(segment) || !object(current) || !Object.hasOwn(current, segment)) throw new EvidenceError('selector-missing')
      current = current[segment]
    }
  }
  if (indexedObject && (!selector.identity || !Object.keys(selector.identity).length) && !selector.identityPaths?.length) throw new EvidenceError('selector-identity-required')
  if (selector.identity) {
    const target = indexedObject ?? current
    if (!object(target) || Object.entries(selector.identity).some(([key, value]) => !Object.hasOwn(target, key) || target[key] !== value)) throw new EvidenceError('selector-identity-mismatch')
  }
  for (const check of selector.identityPaths ?? []) {
    let target: unknown = indexedObject ?? current
    for (const segment of check.path) {
      if (typeof segment === 'number') {
        if (!Array.isArray(target) || !Object.hasOwn(target, segment)) throw new EvidenceError('selector-identity-mismatch')
        target = target[segment]
      } else {
        if (['__proto__', 'constructor', 'prototype'].includes(segment) || !object(target) || !Object.hasOwn(target, segment)) throw new EvidenceError('selector-identity-mismatch')
        target = target[segment]
      }
    }
    if (target !== check.equals) throw new EvidenceError('selector-identity-mismatch')
  }
  return current
}

// Bound the whole response; no prefix of a record is presented as a complete result.
function withinBounds(value: unknown): boolean {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 48 * 1024) return false
  const pending = [value]
  let entries = 0
  while (pending.length) {
    const next = pending.pop()
    if (Array.isArray(next)) { entries += next.length; pending.push(...next) }
    else if (object(next)) { const values = Object.values(next); entries += values.length; pending.push(...values) }
    if (entries > 1500) return false
  }
  return true
}

function recordContext(value: unknown): Record<string, unknown> {
  if (!object(value)) return {}
  const fields = ['id', 'projectId', 'projectRevision', 'projectBindingHash', 'networkId', 'networkRevision', 'revision', 'kind', 'algorithmVersion', 'algorithmPolicyVersion',
    'inputHash', 'outputHash', 'recordHash', 'requestHash', 'requestSha256', 'declarationSha256', 'modelBasisSha256', 'modelHash', 'resultHash', 'replayEnvironmentHash',
    'sourceSha256', 'sourceFileHash', 'sourceAdmissionHash', 'populationHash', 'definitionEvidenceSha256', 'planHash', 'runHash', 'manifestHash', 'artifactHash', 'headHash',
    'referenceAdjustmentId', 'currentAdjustmentId', 'referenceEpoch', 'currentEpoch', 'datasetId', 'runId', 'resultId', 'manifestId', 'attemptId', 'checkedAt',
    'createdAt', 'diagnosticsVersion', 'calculationHash', 'status', 'outcome', 'reason', 'purpose', 'decision', 'engineeringDecision', 'standardConformity', 'humanSignatureVerification',
    'modelAssumptions', 'declarationTrust', 'associationTrust', 'checkpointTrust', 'definitionTrust', 'populationCompleteness', 'formalResultsModified', 'unit', 'units']
  return Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
}

export class SurveyEvidenceReader {
  constructor(private readonly sources: SurveyEvidenceSources) {}

  read(input: unknown, scope: { projectId: string; workspace?: string }): unknown {
    const parsed = SurveyEvidenceReferenceV1.safeParse(input)
    if (!parsed.success) return { status: 'unavailable', reason: 'invalid-reference', readOnly: true }
    const ref = parsed.data
    try {
      same(scope.projectId, ref.projectId)
      const project = required(this.sources.engineering.getProject(ref.projectId))
      same(project.revision, ref.projectRevision)
      if (scope.workspace !== undefined) same(project.workspace, scope.workspace)
      const record = this.resolve(ref)
      const selected = selectSurveyEvidence(record, ref.selector)
      const boundaries = {
        readOnly: true, newComputationStarted: false, approvalCapability: 'none',
        callerDeclarationsAuthenticated: false, standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated',
        interpretation: 'Explain the selected stored evidence and its original limits. Caller declarations and trial outputs are not professional acceptance or authenticated field facts.'
      }
      const provenance = { record: recordContext(record),
        ...(object(record) && object(record.record) ? { retainedRecord: recordContext(record.record) } : {}),
        ...(object(record) && object(record.plan) ? { plan: recordContext(record.plan) } : {}),
        ...(object(record) && object(record.verification) ? { verification: recordContext(record.verification) } : {}) }
      const response = { status: 'resolved', reference: ref, boundaries, provenance, value: selected }
      if (!withinBounds(response)) return { status: 'selector-required', reason: 'output-limit', reference: ref, boundaries,
        availableFields: object(selected) ? Object.keys(selected) : [], arrayLength: Array.isArray(selected) ? selected.length : undefined }
      return response
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof EvidenceError ? error.reason : 'record-unavailable-or-integrity-failed', reference: ref, readOnly: true }
    }
  }

  private resolve(ref: SurveyEvidenceReferenceV1): unknown {
    const s = this.sources, pid = ref.projectId
    if ('networkId' in ref) {
      const network = required(s.survey.getNetwork(ref.networkId))
      same(network.id, ref.networkId); same(network.projectId, pid); same(network.revision, ref.networkRevision); same(network.sourceFile?.sha256, ref.sourceSha256)
      if (ref.kind === 'network') {
        const rawSourceIntegrity = s.survey.getRawSourceIntegrity(ref.networkId)
        if (rawSourceIntegrity.status === 'failed') throw new EvidenceError('binding-mismatch')
        return { ...network, rawSourceIntegrity }
      }
    }
    switch (ref.kind) {
      case 'deformation': {
        const value = required(s.survey.getDeformationForProjectNewUse(pid, ref.comparisonId))
        same(value.id, ref.comparisonId); same(value.projectId, pid); same(value.inputHash, ref.inputHash); same(value.algorithmVersion, ref.algorithmVersion)
        same(value.referenceAdjustmentId, ref.referenceAdjustmentId); same(value.currentAdjustmentId, ref.currentAdjustmentId)
        return value
      }
      case 'statistics': {
        const value = required(s.survey.getAdjustmentStatisticalDiagnostics(pid, ref.adjustmentId))
        same(value.projectId, pid); same(value.networkId, ref.networkId); same(value.runId, ref.adjustmentId); same(value.inputHash, ref.inputHash); same(value.calculationHash, ref.calculationHash); same(value.sourceSha256, ref.sourceSha256)
        same(value.diagnosticsVersion, ref.diagnosticsVersion)
        return value
      }
      case 'free-leveling': {
        const value = required(s.survey.getFreeLevelingTrial(pid, ref.networkId, ref.trialId))
        same(value.id, ref.trialId); same(value.projectId, pid); same(value.recordHash, ref.recordHash); same(value.networkRevision, ref.networkRevision); same(value.sourceSha256, ref.sourceSha256)
        return value
      }
      case 'advanced-trial': {
        const value = s.advanced.getTrial(pid, ref.trialId)
        same(value.id, ref.trialId); same(value.projectId, pid); same(value.recordHash, ref.recordHash)
        return value
      }
      case 'scoring': {
        const value = s.scoring.getRecord(pid, ref.recordId)
        same(value.id, ref.recordId); same(value.projectId, pid); same(value.recordHash, ref.recordHash)
        return value
      }
      case 'sampling-population': {
        const value = s.sampling.getPopulation(pid, ref.populationId)
        same(value.id, ref.populationId); same(value.projectId, pid); same(value.populationHash, ref.populationHash)
        if (ref.unitIndex !== undefined || ref.unitId !== undefined) {
          if (ref.unitIndex === undefined || ref.unitId === undefined) throw new EvidenceError('binding-mismatch')
          const page = s.sampling.listUnits(pid, ref.populationId, 1, ref.unitIndex)
          same(page.populationHash, ref.populationHash)
          const unit = required(page.units[0]); same(unit.index, ref.unitIndex); same(unit.unitProductId, ref.unitId)
          return { population: value, unit }
        }
        return value
      }
      case 'sampling-run': {
        const value = s.sampling.getRun(pid, ref.runId)
        same(value.id, ref.runId); same(value.projectId, pid); same(value.runHash, ref.runHash); same(value.planHash, ref.planHash)
        if (ref.sampleIndex !== undefined || ref.unitId !== undefined) {
          if (ref.sampleIndex === undefined || ref.unitId === undefined) throw new EvidenceError('binding-mismatch')
          const page = s.sampling.listSamples(pid, ref.runId, 1, ref.sampleIndex)
          same(page.planHash, ref.planHash)
          const sample = required(page.samples[0]); same(sample.index, ref.sampleIndex); same(sample.unitProductId, ref.unitId)
          return { run: value, sample }
        }
        return value
      }
      case 'retention-plan': {
        const value = s.retention.getPlan(pid, ref.planId)
        same(value.plan.id, ref.planId); same(value.plan.projectId, pid); same(value.plan.manifestHash, ref.manifestHash); same(value.plan.artifactHash, ref.artifactHash)
        return value
      }
      case 'retention-record': {
        const value = s.retention.getRecord(pid, ref.recordId)
        same(value.record.id, ref.recordId); same(value.record.projectId, pid); same(value.record.planHash, ref.planHash); same(value.verification.headHash, ref.headHash)
        return value
      }
      case 'assessment-plan': {
        const value = s.assessment.getPlan(pid, ref.planId)
        same(value.id, ref.planId); same(value.projectId, pid); same(value.planHash, ref.planHash)
        return value
      }
      case 'assessment': {
        const value = s.assessment.getAssessment(pid, ref.recordId)
        same(value.id, ref.recordId); same(value.projectId, pid); same(value.recordHash, ref.recordHash)
        return value
      }
      case 'standard-basis': {
        const value = resolveSurveyStandardBasis(ref.reference)
        same(value.entry.ruleDigest, ref.ruleDigest)
        if (ref.parent) {
          const parent = this.resolve({ ...ref.parent, schemaVersion: 1, projectId: pid, projectRevision: ref.projectRevision }) as Record<string, unknown>
          same(parent.algorithmVersion, ref.reference.algorithmVersion)
          same(value.entry.rule.executor.family, ref.parent.kind === 'sampling-run' ? 'sampling' : 'declared-scoring')
          same(value.entry.rule.executor.operation, ref.parent.kind === 'sampling-run' ? parent.inspectionMode : parent.kind)
          if (ref.parent.kind === 'sampling-run') {
            const source = required(object(parent.source) ? parent.source : null)
            same(source.standard, ref.reference.standardCode); same(source.sourceSha256, ref.reference.sourceSha256)
            same(parent.inspectionMode, ref.reference.profileId)
          } else {
            const output = required(object(parent.result) ? parent.result : null)
            const request = required(object(output.request) ? output.request : null)
            const source = required(object(output.source) ? output.source : null)
            same(source.standardCode, ref.reference.standardCode); same(source.sha256, ref.reference.sourceSha256)
            same(request.productProfileId, ref.reference.profileId); same(request.productProfileVersion, ref.reference.profileVersion)
          }
        }
        return value
      }
      case 'monitoring-dataset': {
        const value = required(s.engineering.readMonitoringDatasetEvidence(pid, ref.datasetId))
        same(value.revision, ref.datasetRevision); same(value.sourceFileHash, ref.sourceFileHash)
        return value
      }
      case 'monitoring-analysis': {
        const value = required(s.engineering.readMonitoringAnalysisEvidence(pid, ref.analysisId))
        same(value.datasetId, ref.datasetId); same(value.inputHash, ref.inputHash); same(value.algorithmVersion, ref.algorithmVersion)
        return value
      }
      case 'deliverable-verification': return required(s.engineering.readDeliverableVerificationEvidence(pid, ref.manifestId, ref.checkedAt))
      case 'monitoring-replay': return required(s.engineering.readMonitoringReplayEvidence(pid, ref.manifestId, ref.attemptId, ref.checkedAt))
    }
  }
}
