import { SurveyStaticIncrementalInputV1, SurveyStaticIncrementalOutputV1 } from './survey-static-incremental.js'
import { z } from 'zod'
import { SurveyReferenceDatumInputV1, SurveyReferenceDatumOutputV1 } from './survey-reference-datum.js'
import { SurveyGeneralizedWRequestV1, SurveyGeneralizedWResultV1 } from './survey-generalized-w.js'
import { SurveyVceTrialInputV1, SurveyVceTrialOutputV1 } from './survey-vce-trial.js'
import { SurveyHuberTrialInputV1, SurveyHuberTrialOutputV1 } from './survey-huber-trial.js'
import { SurveyStatisticalFamilyInputV1, SurveyStatisticalFamilyOutputV1 } from './survey-statistical-family.js'

export const SURVEY_ADVANCED_TRIAL_LIMITS = Object.freeze({ requestBytes: 512 * 1024, declarationBytes: 256 * 1024,
  basisBytes: 16 * 1024, recordBytes: 4 * 1024 * 1024, trialsPerProject: 128, storedBytesPerProject: 64 * 1024 * 1024,
  pageSize: 10, workUnitsPerMinute: 240 })
const unicode = (value: string): boolean => new TextDecoder().decode(new TextEncoder().encode(value)) === value
const id = z.string().min(1).max(160).refine(value => value.trim() === value && unicode(value))
const key = id.refine(value => value.length >= 8)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const time = z.iso.datetime({ offset: true })
const text = (max: number) => z.string().min(1).max(max).refine(value => unicode(value) && new TextEncoder().encode(value).byteLength <= max)
export const SurveyAdvancedTrialKindV1 = z.enum(['generalized-w', 'vce', 'huber', 'statistical-family', 'reference-datum', 'static-incremental'])
export type SurveyAdvancedTrialKindV1 = z.infer<typeof SurveyAdvancedTrialKindV1>
export const SurveyAdvancedTrialCreateV1 = z.object({
  kind: SurveyAdvancedTrialKindV1, acknowledged: z.literal(true), expectedProjectRevision: revision,
  idempotencyKey: key, declarationJson: text(SURVEY_ADVANCED_TRIAL_LIMITS.declarationBytes),
  modelBasisStatement: text(SURVEY_ADVANCED_TRIAL_LIMITS.basisBytes).refine(v => v.trim().length > 0)
}).strict()
export type SurveyAdvancedTrialCreateV1 = z.infer<typeof SurveyAdvancedTrialCreateV1>
const boundaries = {
  status: z.literal('trial-only'), modelAssumptions: z.literal('not-verified'), engineeringDecision: z.literal('not-evaluated'),
  formalResultsModified: z.literal(false), declarationTrust: z.literal('caller-declared-not-authenticated'),
  checkpointTrust: z.literal('local-records-only')
}
const common = {
  schemaVersion: z.literal(1), id, projectId: id, projectRevision: revision, projectBindingHash: hash,
  kind: SurveyAdvancedTrialKindV1, acknowledged: z.literal(true), idempotencyKey: key,
  algorithmVersion: z.enum(['fixed-linear-known-covariance-generalized-w-1', 'disjoint-linear-vce-trial-1', 'fixed-scale-independent-huber-irls-1', 'declared-statistical-family-1', 'declared-reference-datum-1', 'declared-static-linear-append-1']),
  createdAt: time, modelBasisSha256: hash, modelBasisSizeBytes: z.number().int().positive().max(SURVEY_ADVANCED_TRIAL_LIMITS.basisBytes), replayEnvironmentHash: hash, requestSha256: hash, declarationSha256: hash, modelHash: hash, resultHash: hash, recordHash: hash,
  requestSizeBytes: z.number().int().positive().max(SURVEY_ADVANCED_TRIAL_LIMITS.requestBytes),
  declarationSizeBytes: z.number().int().positive().max(SURVEY_ADVANCED_TRIAL_LIMITS.declarationBytes),
  modelNormalization: z.literal('schema-normalized'),
  outcome: z.enum(['resolved', 'unavailable', 'converged', 'invalid-input', 'functional-rank-or-conditioning',
    'stochastic-rank-or-conditioning', 'numerical-boundary', 'nonpositive-component', 'iteration-limit', 'stationary', 'rank-or-conditioning', 'evaluated', 'calculated']),
  baseObservationCount: z.number().int().min(2).max(255).optional(), appendedObservationCount: z.number().int().min(1).max(128).optional(),
  observationCount: z.number().int().min(0).max(256), parameterCount: z.number().int().min(0).max(32),
  pointCount: z.number().int().min(2).max(32).optional(), referenceCount: z.number().int().min(2).max(32).optional(),
  familyMemberCount: z.number().int().min(1).max(256).optional(),
  ...boundaries
}
export const SurveyAdvancedTrialSummaryV1 = z.object(common).strict().superRefine((v, ctx) => {
  const policies = {
    'generalized-w': { algorithm: 'fixed-linear-known-covariance-generalized-w-1', outcomes: ['resolved', 'unavailable'] },
    vce: { algorithm: 'disjoint-linear-vce-trial-1', outcomes: ['converged', 'functional-rank-or-conditioning', 'stochastic-rank-or-conditioning', 'numerical-boundary', 'nonpositive-component', 'iteration-limit'] },
    huber: { algorithm: 'fixed-scale-independent-huber-irls-1', outcomes: ['stationary', 'rank-or-conditioning', 'numerical-boundary', 'iteration-limit'] },
    'statistical-family': { algorithm: 'declared-statistical-family-1', outcomes: ['evaluated'] },
    'static-incremental': { algorithm: 'declared-static-linear-append-1', outcomes: ['calculated', 'unavailable'] },
    'reference-datum': { algorithm: 'declared-reference-datum-1', outcomes: ['calculated', 'unavailable'] }
  }
  const policy = policies[v.kind]
  const legacyCountsValid = v.kind === 'static-incremental' || v.observationCount <= 128 && v.baseObservationCount === undefined && v.appendedObservationCount === undefined
  const dimensionsValid = v.kind === 'static-incremental'
    ? v.baseObservationCount !== undefined && v.appendedObservationCount !== undefined && v.observationCount === v.baseObservationCount + v.appendedObservationCount
      && v.parameterCount > 0 && v.parameterCount <= 16 && v.baseObservationCount > v.parameterCount
      && v.familyMemberCount === undefined && v.pointCount === undefined && v.referenceCount === undefined
    : v.kind === 'reference-datum'
    ? v.observationCount === 0 && v.parameterCount === 0 && v.familyMemberCount === undefined
      && v.pointCount !== undefined && v.referenceCount !== undefined && v.referenceCount <= v.pointCount
    : v.pointCount === undefined && v.referenceCount === undefined
      && (v.kind === 'statistical-family' ? v.observationCount === 0 && v.parameterCount === 0 && v.familyMemberCount !== undefined
        : v.observationCount > 0 && v.parameterCount > 0 && v.familyMemberCount === undefined)
  if (v.algorithmVersion !== policy.algorithm || !policy.outcomes.includes(v.outcome)
    || !dimensionsValid || !legacyCountsValid) {
    ctx.addIssue({ code: 'custom', message: 'Trial kind, algorithm, dimensions and outcome are inconsistent' })
  }
})
export type SurveyAdvancedTrialSummaryV1 = z.infer<typeof SurveyAdvancedTrialSummaryV1>
export const SurveyAdvancedTrialReplayEnvironmentV1 = z.object({
  node: id, v8: id, platform: id, arch: id, bun: id.nullable()
}).strict()
const detail = {
  ...common, requestJson: text(SURVEY_ADVANCED_TRIAL_LIMITS.requestBytes), declarationJson: text(SURVEY_ADVANCED_TRIAL_LIMITS.declarationBytes),
  modelBasisStatement: text(SURVEY_ADVANCED_TRIAL_LIMITS.basisBytes), replayEnvironment: SurveyAdvancedTrialReplayEnvironmentV1,
  projectSnapshot: z.object({ id, revision, workspace: text(8192) }).strict()
}
export const SurveyAdvancedTrialRecordV1 = z.discriminatedUnion('kind', [
  z.object({ ...detail, kind: z.literal('generalized-w'), declaration: SurveyGeneralizedWRequestV1, result: SurveyGeneralizedWResultV1 }).strict(),
  z.object({ ...detail, kind: z.literal('vce'), declaration: SurveyVceTrialInputV1, result: SurveyVceTrialOutputV1 }).strict(),
  z.object({ ...detail, kind: z.literal('huber'), declaration: SurveyHuberTrialInputV1, result: SurveyHuberTrialOutputV1 }).strict(),
  z.object({ ...detail, kind: z.literal('statistical-family'), declaration: SurveyStatisticalFamilyInputV1, result: SurveyStatisticalFamilyOutputV1 }).strict(),
  z.object({ ...detail, kind: z.literal('static-incremental'), declaration: SurveyStaticIncrementalInputV1, result: SurveyStaticIncrementalOutputV1 }).strict(),
  z.object({ ...detail, kind: z.literal('reference-datum'), declaration: SurveyReferenceDatumInputV1, result: SurveyReferenceDatumOutputV1 }).strict()
]).superRefine((v, ctx) => {
  const { requestJson, declarationJson, projectSnapshot, declaration: _declaration, result: _result, modelBasisStatement, replayEnvironment: _environment, ...summary } = v
  if (!SurveyAdvancedTrialSummaryV1.safeParse(summary).success || projectSnapshot.id !== v.projectId || projectSnapshot.revision !== v.projectRevision
    || new TextEncoder().encode(modelBasisStatement).byteLength !== v.modelBasisSizeBytes
    || new TextEncoder().encode(requestJson).byteLength !== v.requestSizeBytes || new TextEncoder().encode(declarationJson).byteLength !== v.declarationSizeBytes
    || (v.kind === 'static-incremental' ? v.baseObservationCount !== v.declaration.base.observations.length || v.appendedObservationCount !== v.declaration.append.observations.length || v.parameterCount !== v.declaration.base.parameterIds.length
      : v.kind === 'reference-datum' ? v.pointCount !== v.declaration.mapping.length || v.referenceCount !== v.declaration.referenceIds.length
      : v.kind === 'statistical-family' ? v.familyMemberCount !== v.declaration.members.length
      : v.parameterCount !== v.declaration.parameterIds.length || v.observationCount !== v.declaration.observations.length)
    || v.outcome !== (v.kind === 'generalized-w' ? v.result.modelStatus : v.result.outcome)
    || v.algorithmVersion !== (v.kind === 'generalized-w' ? v.result.diagnosticsVersion : v.result.algorithmVersion)) {
    ctx.addIssue({ code: 'custom', message: 'Trial record identity, dimensions, result or raw byte sizes are inconsistent' })
  }
})
export type SurveyAdvancedTrialRecordV1 = z.infer<typeof SurveyAdvancedTrialRecordV1>
export const SurveyAdvancedTrialListV1 = z.object({
  trials: z.array(SurveyAdvancedTrialSummaryV1).max(SURVEY_ADVANCED_TRIAL_LIMITS.pageSize),
  unavailable: z.array(z.object({ id, reason: z.enum(['stale', 'integrity', 'replay-environment']) }).strict()).max(SURVEY_ADVANCED_TRIAL_LIMITS.pageSize),
  nextOffset: z.number().int().min(0).max(SURVEY_ADVANCED_TRIAL_LIMITS.trialsPerProject).nullable()
}).strict().refine(v => v.trials.length + v.unavailable.length <= SURVEY_ADVANCED_TRIAL_LIMITS.pageSize
  && new Set([...v.trials, ...v.unavailable].map(x => x.id)).size === v.trials.length + v.unavailable.length)
export type SurveyAdvancedTrialListV1 = z.infer<typeof SurveyAdvancedTrialListV1>
export const SurveyAdvancedTrialReverifyRequestV1 = z.object({}).strict()
export const SurveyAdvancedTrialVerificationV1 = z.object({
  schemaVersion: z.literal(1), projectId: id, trialId: id, kind: SurveyAdvancedTrialKindV1,
  requestSha256: hash, declarationSha256: hash, modelHash: hash, resultHash: hash, recordHash: hash,
  checkedAt: time, recordIntegrity: z.literal('verified'), recomputed: z.literal(true), ...boundaries
}).strict()
export type SurveyAdvancedTrialVerificationV1 = z.infer<typeof SurveyAdvancedTrialVerificationV1>
