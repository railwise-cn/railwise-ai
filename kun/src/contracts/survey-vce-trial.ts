import { z } from 'zod'

const scalar = z.number().finite()
const id = z.string().trim().min(1).max(160)
const vector = z.array(scalar).max(128)
const matrix = z.array(vector).max(128)
export const SurveyVceTrialInputV1 = z.object({
  schemaVersion: z.literal(1),
  model: z.literal('fixed-linear-independent-disjoint-variance-groups'),
  unit: z.enum(['m', 'mm']),
  parameterIds: z.array(id).min(1).max(32),
  groups: z.array(z.object({ id, initialVariance: scalar.min(1e-18).max(1e18), sourceAnchor: id }).strict()).min(1).max(8),
  observations: z.array(z.object({
    id, value: scalar.min(-1e6).max(1e6), coefficients: vector.min(1).max(32),
    groupId: id, relativeVariance: scalar.min(1e-8).max(1e8), sourceAnchor: id
  }).strict()).min(2).max(128),
  maxIterations: z.number().int().min(1).max(100),
  relativeTolerance: scalar.min(1e-12).max(1e-4)
}).strict().superRefine((v, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message })
  for (const ids of [v.parameterIds, v.groups.map(g => g.id), v.observations.map(o => o.id)]) {
    if (new Set(ids).size !== ids.length) issue('Identifiers must be unique within each collection')
  }
  if (v.observations.length <= v.parameterIds.length) issue('Positive functional redundancy is required')
  if (v.observations.some(o => o.coefficients.length !== v.parameterIds.length)) issue('Design rows must match parameterIds')
  if (v.observations.some(o => !v.groups.some(g => g.id === o.groupId))) issue('Every observation needs one declared group')
  if (v.groups.some(g => !v.observations.some(o => o.groupId === g.id))) issue('Every declared group must contain observations')
})
export type SurveyVceTrialInputV1 = z.infer<typeof SurveyVceTrialInputV1>

const fit = z.object({ parameters: vector, residuals: vector, functionalNormalConditionInfinity: scalar.nonnegative() }).strict()
export const SurveyVceIterationV1 = z.object({
  iteration: z.number().int().positive(), currentVariances: vector, candidateVariances: vector,
  covarianceScale: scalar.positive(), normal: matrix, rightHandSide: vector,
  stochasticNormalConditionInfinity: scalar.nonnegative(), groupGramConditionInfinity: scalar.nonnegative(), relativeChange: scalar.nonnegative(), fit
}).strict()
export type SurveyVceIterationV1 = z.infer<typeof SurveyVceIterationV1>
export const SurveyVceTrialOutputV1 = z.object({
  algorithmVersion: z.literal('disjoint-linear-vce-trial-1'), status: z.literal('trial-only'),
  modelAssumptions: z.literal('not-verified'), engineeringDecision: z.literal('not-evaluated'),
  formalWeightsModified: z.literal(false), componentCovariance: z.null(),
  outcome: z.enum(['converged', 'invalid-input', 'functional-rank-or-conditioning', 'stochastic-rank-or-conditioning', 'numerical-boundary', 'nonpositive-component', 'iteration-limit']),
  message: z.string(), unit: z.enum(['m', 'mm']).nullable(), squaredUnit: z.enum(['m2', 'mm2']).nullable(),
  parameterIds: z.array(id).max(32), groupIds: z.array(id).max(8), observationIds: z.array(id).max(128),
  convergencePolicy: z.object({ maxIterations: z.number().int().min(1).max(100), relativeTolerance: scalar.min(1e-12).max(1e-4) }).strict().nullable(),
  degreesOfFreedom: z.number().int().nonnegative(), iterations: z.array(SurveyVceIterationV1).max(100),
  convergedVariances: vector.nullable(), finalFit: fit.nullable(),
  residualConvention: z.literal('observed-minus-adjusted'),
  normalConvention: z.literal('half-trace-with-weights-covarianceScale-over-covariance'),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message })
  const equal = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
  const p = v.parameterIds.length
  const g = v.groupIds.length
  const m = v.observationIds.length
  if (v.outcome === 'invalid-input') {
    if (v.unit !== null || v.squaredUnit !== null || p || g || m || v.degreesOfFreedom || v.iterations.length || v.convergencePolicy !== null) issue('Invalid-input output cannot contain a model or iterations')
  } else {
    if (!p || !g || m <= p || v.degreesOfFreedom !== m - p) issue('Output model dimensions or functional redundancy are inconsistent')
    if (!v.unit || v.squaredUnit !== `${v.unit}2`) issue('Output units are inconsistent')
    if (!v.convergencePolicy || v.iterations.length > v.convergencePolicy.maxIterations) issue('Missing or exceeded convergence policy')
    for (const ids of [v.parameterIds, v.groupIds, v.observationIds]) if (new Set(ids).size !== ids.length) issue('Output identifiers must be unique')
  }
  const checkFit = (f: z.infer<typeof fit>): void => {
    if (f.parameters.length !== p || f.residuals.length !== m) issue('Fit dimensions are inconsistent')
  }
  v.iterations.forEach((row, i) => {
    if (row.iteration !== i + 1) issue('Iteration indices must be consecutive')
    if (row.currentVariances.length !== g || row.candidateVariances.length !== g || row.rightHandSide.length !== g || row.normal.length !== g || row.normal.some(r => r.length !== g)) issue('Iteration dimensions are inconsistent')
    if (row.currentVariances.some(x => x <= 0)) issue('Current variances must be positive')
    if (i && !equal(row.currentVariances, v.iterations[i - 1]!.candidateVariances)) issue('Iteration continuity is broken')
    if (i < v.iterations.length - 1 && row.candidateVariances.some(x => x <= 0)) issue('A nonpositive candidate cannot be followed by another iteration')
    if (row.currentVariances.length === row.candidateVariances.length) {
      const change = Math.max(...row.candidateVariances.map((x, j) => Math.abs(x - row.currentVariances[j]!) / Math.max(Math.abs(x), Math.abs(row.currentVariances[j]!))))
      if (change !== row.relativeChange) issue('Relative change does not match the recorded component update')
    }
    if (i < v.iterations.length - 1 && v.convergencePolicy && row.relativeChange <= v.convergencePolicy.relativeTolerance) issue('A converged update cannot be followed by more iterations')
    checkFit(row.fit)
  })
  const last = v.iterations.at(-1)
  if (v.outcome === 'converged') {
    if (!last || !v.convergencePolicy || last.relativeChange > v.convergencePolicy.relativeTolerance || !v.finalFit || !v.convergedVariances || v.convergedVariances.some(x => x <= 0) || !equal(v.convergedVariances, last.candidateVariances)) issue('Converged output requires the final positive candidate and a final fit')
  } else if (v.finalFit !== null || v.convergedVariances !== null) issue('Failed trial cannot contain a converged result')
  if (last?.candidateVariances.some(x => x <= 0) && v.outcome !== 'nonpositive-component') issue('Nonpositive candidate requires the explicit boundary outcome')
  if (v.outcome === 'nonpositive-component' && (!last || !last.candidateVariances.some(x => x <= 0))) issue('Nonpositive-component outcome requires its failed candidate')
  if (v.outcome === 'iteration-limit' && (!last || !v.convergencePolicy || v.iterations.length !== v.convergencePolicy.maxIterations || last.relativeChange <= v.convergencePolicy.relativeTolerance || last.candidateVariances.some(x => x <= 0))) issue('Iteration-limit outcome requires a positive attempted candidate')
  if (v.finalFit) checkFit(v.finalFit)
})
export type SurveyVceTrialOutputV1 = z.infer<typeof SurveyVceTrialOutputV1>
