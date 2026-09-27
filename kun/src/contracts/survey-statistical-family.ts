import { z } from 'zod'

/** Version 1 is deliberately a declared scalar-statistic calculator, not an outlier-removal rule. */
export const SURVEY_STATISTICAL_FAMILY_POLICY_V1 = {
  maxFamilySize: 256,
  minAlpha: 1e-12,
  maxAlpha: 0.5,
  minProbability: 1e-300,
  logComparisonMargin: 2e-10,
  maxDegreesOfFreedom: 1000,
  normalMagnitudeLimit: 35,
  studentMagnitudeLimit: 1e16,
  chiSquareLimit: 1e6
} as const

const finite = z.number().finite()
const id = z.string().trim().min(1).max(160)
const df = z.number().int().min(1).max(SURVEY_STATISTICAL_FAMILY_POLICY_V1.maxDegreesOfFreedom)
const priorScale = {
  scaleBasis: z.literal('caller-declared-known-prior-standard-deviation'),
  priorStandardDeviation: finite.min(1e-150).max(1e150),
  scaleUnit: id
}
export const SurveyStatisticalDistributionV1 = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('normal'), tail: z.literal('two-sided'), statisticBasis: z.literal('standardized-by-known-prior-scale'), ...priorScale }).strict(),
  z.object({ kind: z.literal('student-t'), tail: z.literal('two-sided'), statisticBasis: z.literal('externally-studentized'), degreesOfFreedom: df }).strict(),
  z.object({ kind: z.literal('chi-square'), tail: z.literal('upper'), statisticBasis: z.literal('quadratic-form-divided-by-known-prior-variance'), degreesOfFreedom: df, ...priorScale }).strict()
])
export type SurveyStatisticalDistributionV1 = z.infer<typeof SurveyStatisticalDistributionV1>

const statistic = z.discriminatedUnion('status', [
  z.object({ memberId: id, status: z.literal('available'), value: finite }).strict(),
  z.object({ memberId: id, status: z.literal('unavailable'), reason: id }).strict(),
  z.object({ memberId: id, status: z.literal('undetectable'), reason: id }).strict()
])
export const SurveyStatisticalFamilyInputV1 = z.object({
  schemaVersion: z.literal(1),
  familyId: id,
  declaration: z.literal('caller-declared-before-observing-statistics'),
  statisticPrecision: z.literal('caller-declared-exact-scalar-inputs-no-upstream-error-propagation'),
  correction: z.literal('bonferroni'),
  alpha: finite.min(SURVEY_STATISTICAL_FAMILY_POLICY_V1.minAlpha).max(SURVEY_STATISTICAL_FAMILY_POLICY_V1.maxAlpha),
  members: z.array(z.object({ id, sourceAnchor: id, distribution: SurveyStatisticalDistributionV1 }).strict()).min(1).max(SURVEY_STATISTICAL_FAMILY_POLICY_V1.maxFamilySize),
  statistics: z.array(statistic).max(SURVEY_STATISTICAL_FAMILY_POLICY_V1.maxFamilySize)
}).strict().superRefine((value, ctx) => {
  const memberIds = new Set(value.members.map(m => m.id))
  if (memberIds.size !== value.members.length) ctx.addIssue({ code: 'custom', message: 'Declared member IDs must be unique' })
  if (new Set(value.statistics.map(s => s.memberId)).size !== value.statistics.length) ctx.addIssue({ code: 'custom', message: 'Statistic member IDs must be unique' })
  if (value.statistics.some(s => !memberIds.has(s.memberId))) ctx.addIssue({ code: 'custom', message: 'Every statistic must belong to the predeclared family' })
})
export type SurveyStatisticalFamilyInputV1 = z.infer<typeof SurveyStatisticalFamilyInputV1>

const probability = finite.min(SURVEY_STATISTICAL_FAMILY_POLICY_V1.minProbability).max(1)
const calculation = z.object({
  memberId: id, status: z.literal('calculated'), statistic: finite,
  pValue: probability, logPValue: finite.min(Math.log(SURVEY_STATISTICAL_FAMILY_POLICY_V1.minProbability)).max(0), adjustedPValue: probability, logAdjustedPValue: finite.max(0),
  criticalMagnitude: finite.positive(),
  numericalResolutionInterval: z.tuple([finite.nonnegative(), finite.positive()]),
  comparison: z.enum(['p-below-adjusted-alpha', 'p-above-adjusted-alpha', 'boundary-unresolved'])
}).strict()
const memberResult = z.discriminatedUnion('status', [
  calculation,
  z.object({ memberId: id, status: z.literal('unavailable'), reason: id }).strict(),
  z.object({ memberId: id, status: z.literal('undetectable'), reason: id }).strict(),
  z.object({ memberId: id, status: z.literal('domain-failure'), code: z.literal('statistic-outside-supported-domain'), message: z.string() }).strict(),
  z.object({ memberId: id, status: z.literal('numerical-failure'), code: z.enum(['probability-below-supported-range', 'iteration-limit', 'nonfinite-or-invalid-intermediate', 'critical-value-not-bracketed']), message: z.string() }).strict()
])
export type SurveyStatisticalFamilyMemberResultV1 = z.infer<typeof memberResult>
const guardrails = {
  algorithmVersion: z.literal('declared-statistical-family-1'),
  status: z.literal('trial-only'),
  modelAssumptions: z.literal('not-verified'),
  familyPredeclaration: z.literal('not-verified'),
  engineeringDecision: z.literal('not-evaluated'),
  observationAction: z.literal('none'),
  numericalIntervalMeaning: z.literal('software-resolution-policy-not-certified-error-bound'),
  logComparisonMargin: z.literal(SURVEY_STATISTICAL_FAMILY_POLICY_V1.logComparisonMargin)
}
export const SurveyStatisticalFamilyOutputV1 = z.discriminatedUnion('outcome', [
  z.object({ ...guardrails, outcome: z.literal('invalid-input'), message: z.string() }).strict(),
  z.object({
    ...guardrails, outcome: z.literal('evaluated'),
    request: SurveyStatisticalFamilyInputV1,
    requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    denominator: z.number().int().min(1).max(SURVEY_STATISTICAL_FAMILY_POLICY_V1.maxFamilySize),
    memberAlpha: finite.positive().max(0.5),
    results: z.array(memberResult).min(1).max(SURVEY_STATISTICAL_FAMILY_POLICY_V1.maxFamilySize)
  }).strict()
]).superRefine((value, ctx) => {
  if (value.outcome === 'invalid-input') return
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message })
  const { request, denominator, memberAlpha, results } = value
  if (denominator !== request.members.length || results.length !== denominator) issue('All declared members must remain in the denominator and result list')
  if (memberAlpha !== request.alpha / denominator) issue('Member alpha must use the full predeclared denominator')
  results.forEach((result, i) => {
    const member = request.members[i]
    if (!member || member.id !== result.memberId) issue('Result order and identity must match the declared family')
    const supplied = request.statistics.find(s => s.memberId === result.memberId)
    if (!supplied) {
      if (result.status !== 'unavailable' || result.reason !== 'not-supplied') issue('Missing statistics must remain unavailable')
      return
    }
    if (supplied.status !== 'available') {
      if (result.status !== supplied.status || !('reason' in result) || result.reason !== supplied.reason) issue('Availability states and reasons must be preserved')
      return
    }
    if (result.status === 'unavailable' || result.status === 'undetectable') issue('Available scalar cannot be silently removed')
    if (member) {
      const distribution = member.distribution
      const limit = distribution.kind === 'normal' ? SURVEY_STATISTICAL_FAMILY_POLICY_V1.normalMagnitudeLimit : distribution.kind === 'student-t' ? SURVEY_STATISTICAL_FAMILY_POLICY_V1.studentMagnitudeLimit : SURVEY_STATISTICAL_FAMILY_POLICY_V1.chiSquareLimit
      const outsideDomain = Math.abs(supplied.value) > limit || (distribution.kind === 'chi-square' && supplied.value < 0)
      if ((result.status === 'domain-failure') !== outsideDomain) issue('Domain status must match the declared distribution bounds')
      if (result.status === 'calculated' && result.numericalResolutionInterval[1] > limit) issue('Critical interval exceeds the supported statistic domain')
    }
    if (result.status !== 'calculated') return
    if (result.statistic !== supplied.value) issue('Calculated statistic must equal the declared scalar')
    if (Math.abs(Math.log(result.pValue) - result.logPValue) > 1e-12) issue('Probability and log probability disagree')
    const logAdjusted = Math.min(0, result.logPValue + Math.log(denominator))
    if (result.logAdjustedPValue !== logAdjusted || result.adjustedPValue !== Math.min(1, result.pValue * denominator)) issue('Adjusted probability must use the complete family')
    const delta = result.logPValue - Math.log(memberAlpha)
    const expected = Math.abs(delta) <= value.logComparisonMargin ? 'boundary-unresolved' : delta < 0 ? 'p-below-adjusted-alpha' : 'p-above-adjusted-alpha'
    if (result.comparison !== expected) issue('Comparison must apply the declared software resolution margin')
    const [lower, upper] = result.numericalResolutionInterval
    if (!(lower < result.criticalMagnitude && result.criticalMagnitude < upper)) issue('Critical magnitude must be inside its numerical resolution interval')
  })
})
export type SurveyStatisticalFamilyOutputV1 = z.infer<typeof SurveyStatisticalFamilyOutputV1>
