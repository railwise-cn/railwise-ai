import { z } from 'zod'
import { SurveyStandardBasisReferenceV1 } from './survey-standard-basis.js'

const id = z.string().min(1).max(512)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const key = id.refine(value => !['__proto__', 'prototype', 'constructor'].includes(value))
const path = z.array(z.union([key, z.number().int().nonnegative().max(20_000)])).max(16)
const scalar = z.union([id, z.number().finite(), z.boolean(), z.null()])
export const SurveyEvidenceSelectorV1 = z.object({
  path,
  identity: z.record(key, scalar).refine(value => Object.keys(value).length <= 16).optional(),
  identityPaths: z.array(z.object({ path, equals: scalar }).strict()).min(1).max(16).optional()
}).strict()
const common = { schemaVersion: z.literal(1), projectId: id, projectRevision: revision, selector: SurveyEvidenceSelectorV1.optional() }
const network = { networkId: id, networkRevision: revision, sourceSha256: hash }
const record = { recordId: id, recordHash: hash }

/** References select saved records. They never authorize computation or approval. */
export const SurveyEvidenceReferenceV1 = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('network'), ...network }).strict(),
  z.object({ ...common, kind: z.literal('deformation'), comparisonId: id, inputHash: hash, algorithmVersion: id, referenceAdjustmentId: id, currentAdjustmentId: id }).strict(),
  z.object({ ...common, kind: z.literal('statistics'), ...network, adjustmentId: id, inputHash: hash, calculationHash: hash, diagnosticsVersion: id }).strict(),
  z.object({ ...common, kind: z.literal('free-leveling'), ...network, trialId: id, recordHash: hash }).strict(),
  z.object({ ...common, kind: z.literal('advanced-trial'), trialId: id, recordHash: hash }).strict(),
  z.object({ ...common, kind: z.literal('sampling-population'), populationId: id, populationHash: hash, unitIndex: z.number().int().min(0).max(9999).optional(), unitId: id.optional() }).strict(),
  z.object({ ...common, kind: z.literal('sampling-run'), runId: id, runHash: hash, planHash: hash, sampleIndex: z.number().int().min(0).max(9999).optional(), unitId: id.optional() }).strict(),
  z.object({ ...common, kind: z.literal('scoring'), ...record }).strict(),
  z.object({ ...common, kind: z.literal('retention-plan'), planId: id, manifestHash: hash, artifactHash: hash }).strict(),
  z.object({ ...common, kind: z.literal('retention-record'), recordId: id, planHash: hash, headHash: hash }).strict(),
  z.object({ ...common, kind: z.literal('assessment-plan'), planId: id, planHash: hash }).strict(),
  z.object({ ...common, kind: z.literal('assessment'), ...record }).strict(),
  z.object({ ...common, kind: z.literal('standard-basis'), reference: SurveyStandardBasisReferenceV1, ruleDigest: hash,
    parent: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('sampling-run'), runId: id, runHash: hash, planHash: hash }).strict(),
      z.object({ kind: z.literal('scoring'), ...record }).strict()
    ]).optional() }).strict(),
  z.object({ ...common, kind: z.literal('monitoring-dataset'), datasetId: id, datasetRevision: revision, sourceFileHash: hash }).strict(),
  z.object({ ...common, kind: z.literal('monitoring-analysis'), analysisId: id, datasetId: id, inputHash: hash, algorithmVersion: id }).strict(),
  z.object({ ...common, kind: z.literal('deliverable-verification'), manifestId: id, checkedAt: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ ...common, kind: z.literal('monitoring-replay'), manifestId: id, attemptId: id, checkedAt: z.iso.datetime({ offset: true }) }).strict()
])
export type SurveyEvidenceReferenceV1 = z.infer<typeof SurveyEvidenceReferenceV1>
export type SurveyEvidenceSelectorV1 = z.infer<typeof SurveyEvidenceSelectorV1>
