import { z } from 'zod'

const id = z.string().min(1).max(160).refine(v => v.trim() === v && new TextDecoder().decode(new TextEncoder().encode(v)) === v)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().positive().max(1e9)
const finite = z.number().finite()
const vector = z.array(finite).min(1).max(64)
const matrix = z.array(vector).min(1).max(64)
export const SurveySourceFixedModelRequestV1 = z.object({ adjustmentId: id, expectedProjectRevision: revision, expectedNetworkRevision: revision }).strict()
export type SurveySourceFixedModelRequestV1 = z.infer<typeof SurveySourceFixedModelRequestV1>
export const SurveySourceFixedModelBindingV1 = z.object({
  adapterVersion: z.literal('admitted-fixed-leveling-1'), projectId: id, projectRevision: revision, networkId: id, networkRevision: revision,
  runId: id, resultId: id, inputHash: hash, algorithmVersion: id, sourceSha256: hash, sourceAdmissionHash: hash, calculationHash: hash, fixedModelHash: hash
}).strict()
export type SurveySourceFixedModelBindingV1 = z.infer<typeof SurveySourceFixedModelBindingV1>
export const SurveySourceFixedModelV1 = z.object({
  schemaVersion: z.literal(1), binding: SurveySourceFixedModelBindingV1,
  sourceName: z.string().min(1).max(1000),
  model: z.object({
    kind: z.literal('fixed-datum-independent-linear-height-differences'), unit: z.literal('m'), parameterMeaning: z.literal('height-corrections-from-source-approximation'),
    covarianceBasis: z.literal('source-declared-independent-absolute-prior-sigma-squared-not-field-authenticated'),
    parameterIds: z.array(id).min(1).max(16), referencePoints: z.array(z.object({ id, height: finite, fixed: z.boolean(), heightBasis: z.enum(['declared-height', 'zero-initial-approximation']) }).strict()).min(2).max(80),
    observations: z.array(z.object({ id, from: id, to: id, heightDifference: finite, value: finite, sigma: finite.positive(), sourceAnchor: id }).strict()).min(2).max(64),
    designMatrix: matrix, observationCovariance: matrix, priorParameterCovariance: matrix, formalCorrections: vector,
    degreesOfFreedom: z.number().int().positive().max(63)
  }).strict()
}).strict().superRefine((v, ctx) => {
  const m = v.model, p = m.parameterIds.length, n = m.observations.length
  if (n <= p || m.degreesOfFreedom !== n-p || m.designMatrix.length !== n || m.designMatrix.some(r => r.length !== p)
    || m.observationCovariance.length !== n || m.observationCovariance.some(r => r.length !== n)
    || m.priorParameterCovariance.length !== p || m.priorParameterCovariance.some(r => r.length !== p) || m.formalCorrections.length !== p
    || new Set(m.observations.map(o => o.id)).size !== n || new Set(m.parameterIds).size !== p
    || new Set(m.referencePoints.map(o => o.id)).size !== m.referencePoints.length
    || m.parameterIds.some(id => !m.referencePoints.some(point => point.id === id && !point.fixed))
    || !m.referencePoints.some(point => point.fixed)
    || m.observationCovariance.some((r, i) => r.some((x,j) => x !== (i === j ? m.observations[i]!.sigma ** 2 : 0)))) {
    ctx.addIssue({ code: 'custom', message: 'Source model dimensions, fixed datum and absolute independent prior covariance must agree' })
  }
})
export type SurveySourceFixedModelV1 = z.infer<typeof SurveySourceFixedModelV1>

/** Identical canonical bytes in the service and renderer; no Node dependency. */
export function canonicalSourceModel(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSourceModel).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalSourceModel(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
