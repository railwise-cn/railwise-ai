import { createHash } from 'node:crypto'
import {
  SURVEY_STATISTICAL_FAMILY_POLICY_V1 as policy,
  SurveyStatisticalFamilyInputV1,
  SurveyStatisticalFamilyOutputV1,
  type SurveyStatisticalDistributionV1,
  type SurveyStatisticalFamilyMemberResultV1
} from '../contracts/survey-statistical-family.js'

const flags = {
  algorithmVersion: 'declared-statistical-family-1', status: 'trial-only', modelAssumptions: 'not-verified',
  familyPredeclaration: 'not-verified', engineeringDecision: 'not-evaluated', observationAction: 'none',
  numericalIntervalMeaning: 'software-resolution-policy-not-certified-error-bound', logComparisonMargin: policy.logComparisonMargin
} as const

type NumericCode = 'probability-below-supported-range' | 'iteration-limit' | 'nonfinite-or-invalid-intermediate' | 'critical-value-not-bracketed'
class NumericFailure extends Error {
  constructor(readonly code: NumericCode, message: string) { super(message) }
}
const numericFailure = (message: string): never => { throw new NumericFailure('nonfinite-or-invalid-intermediate', message) }
const MAX_ITERATIONS = 4096
const EPS = 4 * Number.EPSILON
const TINY = 1e-300
const LOG_MIN_P = Math.log(policy.minProbability)
const nonzero = (value: number): number => Math.abs(value) < TINY ? (value < 0 ? -TINY : TINY) : value

// Lanczos, g=7, nine coefficients; this module only uses positive arguments >= 1/2.
function logGamma(value: number): number {
  const coefficients = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7]
  const z = value - 1
  let sum = coefficients[0]!
  for (let i = 1; i < coefficients.length; i++) sum += coefficients[i]! / (z + i)
  const t = z + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum)
}
function logComplement(logValue: number): number {
  if (logValue > 0 || !Number.isFinite(logValue)) return numericFailure('Invalid log probability in complementary tail')
  if (logValue === 0) return -Infinity
  return logValue < -Math.LN2 ? Math.log1p(-Math.exp(logValue)) : Math.log(-Math.expm1(logValue))
}
function validLogProbability(value: number): number {
  if (!Number.isFinite(value) || value > 0) return numericFailure('Tail evaluation produced a nonfinite or positive log probability')
  return value
}

/** Q(a,x): positive lower series when x<a+1, otherwise the contracted upper-gamma CF. */
function logGammaUpper(a: number, x: number): number {
  if (x === 0) return 0
  const prefactor = a * Math.log(x) - x - logGamma(a)
  if (x < a + 1) {
    let term = 1 / a
    let sum = term
    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      term *= x / (a + i)
      sum += term
      if (Math.abs(term) <= Math.abs(sum) * EPS) return validLogProbability(logComplement(prefactor + Math.log(sum)))
    }
  } else {
    // Even contraction of DLMF 8.9.2: b_n=x+1-a+2n, a_n=n(a-n).
    let b = x + 1 - a
    let c = 1 / TINY
    let d = 1 / nonzero(b)
    let h = d
    for (let i = 1; i <= MAX_ITERATIONS; i++) {
      const an = i * (a - i)
      b += 2
      d = nonzero(an * d + b)
      c = nonzero(b + an / c)
      d = 1 / d
      const delta = d * c
      h *= delta
      if (!Number.isFinite(h) || h <= 0) return numericFailure('Invalid upper-gamma continued fraction')
      if (Math.abs(delta - 1) <= EPS) return validLogProbability(prefactor + Math.log(h))
    }
  }
  throw new NumericFailure('iteration-limit', 'Incomplete gamma evaluation exceeded its fixed iteration budget')
}

/** DLMF 8.17.22–23, evaluated by modified Lentz. */
function betaFraction(a: number, b: number, x: number): number {
  let c = 1
  let d = 1 / nonzero(1 - (a + b) * x / (a + 1))
  let h = d
  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m
    let numerator = m * (b - m) * x / ((a + m2 - 1) * (a + m2))
    d = 1 / nonzero(1 + numerator * d)
    c = nonzero(1 + numerator / c)
    h *= d * c
    numerator = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))
    d = 1 / nonzero(1 + numerator * d)
    c = nonzero(1 + numerator / c)
    const delta = d * c
    h *= delta
    if (!Number.isFinite(h) || h <= 0) return numericFailure('Invalid incomplete-beta continued fraction')
    if (Math.abs(delta - 1) <= EPS) return h
  }
  throw new NumericFailure('iteration-limit', 'Incomplete beta evaluation exceeded its fixed iteration budget')
}
function logStudentTwoSided(df: number, magnitude: number): number {
  if (magnitude === 0) return 0
  // Separate log(x), log(1-x) preserve the small complement when x rounds to 1.
  const ratioLog = 2 * Math.log(magnitude) - Math.log(df)
  const softplus = ratioLog > 0 ? ratioLog + Math.log1p(Math.exp(-ratioLog)) : Math.log1p(Math.exp(ratioLog))
  const logX = -softplus
  const logY = ratioLog > 0 ? -Math.log1p(Math.exp(-ratioLog)) : ratioLog - softplus
  const a = df / 2
  const b = 0.5
  const prefactor = a * logX + b * logY - (logGamma(a) + logGamma(b) - logGamma(a + b))
  const x = Math.exp(logX)
  if (x < (a + 1) / (a + b + 2)) return validLogProbability(prefactor + Math.log(betaFraction(a, b, x)) - Math.log(a))
  const logComplementValue = prefactor + Math.log(betaFraction(b, a, Math.exp(logY))) - Math.log(b)
  return validLogProbability(logComplement(logComplementValue))
}
function ceiling(distribution: SurveyStatisticalDistributionV1): number {
  return distribution.kind === 'normal' ? policy.normalMagnitudeLimit : distribution.kind === 'student-t' ? policy.studentMagnitudeLimit : policy.chiSquareLimit
}
function logTail(distribution: SurveyStatisticalDistributionV1, magnitude: number): number {
  if (distribution.kind === 'normal') return logGammaUpper(0.5, magnitude * magnitude / 2)
  if (distribution.kind === 'student-t') return logStudentTwoSided(distribution.degreesOfFreedom, magnitude)
  return logGammaUpper(distribution.degreesOfFreedom / 2, magnitude / 2)
}
function rootInterval(distribution: SurveyStatisticalDistributionV1, target: number): [number, number] {
  let lower = 0
  let upper = 1
  const limit = ceiling(distribution)
  while (logTail(distribution, upper) > target && upper < limit) upper = Math.min(limit, upper * 2)
  if (logTail(distribution, upper) > target) throw new NumericFailure('critical-value-not-bracketed', 'Critical value is outside the supported statistic domain')
  for (let i = 0; i < 160; i++) {
    const mid = lower + (upper - lower) / 2
    if (mid === lower || mid === upper || upper - lower <= 8 * Number.EPSILON * Math.max(1, mid)) return [lower, upper]
    if (logTail(distribution, mid) > target) lower = mid
    else upper = mid
  }
  throw new NumericFailure('iteration-limit', 'Critical-value search exceeded its fixed iteration budget')
}
function critical(distribution: SurveyStatisticalDistributionV1, memberAlpha: number): { criticalMagnitude: number; numericalResolutionInterval: [number, number] } {
  const target = Math.log(memberAlpha)
  const nominal = rootInterval(distribution, target)
  const lo = rootInterval(distribution, target + policy.logComparisonMargin)
  const hi = rootInterval(distribution, target - policy.logComparisonMargin)
  return { criticalMagnitude: nominal[0] + (nominal[1] - nominal[0]) / 2, numericalResolutionInterval: [lo[0], hi[1]] }
}

/** Pure bounded computation. It never verifies model assumptions, edits observations, or grants engineering acceptance. */
export function evaluateSurveyStatisticalFamilyV1(input: unknown): SurveyStatisticalFamilyOutputV1 {
  const parsed = SurveyStatisticalFamilyInputV1.safeParse(input)
  if (!parsed.success) return { ...flags, outcome: 'invalid-input', message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
  const request = parsed.data
  // Canonical statistic order makes reordering a supplied subset irrelevant; family declaration order remains significant.
  request.statistics.sort((a, b) => a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0)
  const denominator = request.members.length
  const memberAlpha = request.alpha / denominator
  const supplied = new Map(request.statistics.map(s => [s.memberId, s]))
  const criticalCache = new Map<string, ReturnType<typeof critical>>()
  const results: SurveyStatisticalFamilyMemberResultV1[] = request.members.map((member): SurveyStatisticalFamilyMemberResultV1 => {
    const statistic = supplied.get(member.id)
    if (!statistic) return { memberId: member.id, status: 'unavailable', reason: 'not-supplied' }
    if (statistic.status === 'unavailable') return { memberId: member.id, status: 'unavailable', reason: statistic.reason }
    if (statistic.status === 'undetectable') return { memberId: member.id, status: 'undetectable', reason: statistic.reason }
    const distribution = member.distribution
    const magnitude = Math.abs(statistic.value)
    if (magnitude > ceiling(distribution) || (distribution.kind === 'chi-square' && statistic.value < 0)) return {
      memberId: member.id, status: 'domain-failure', code: 'statistic-outside-supported-domain', message: `Statistic must lie within ${distribution.kind === 'chi-square' ? '[0' : `[-${ceiling(distribution)}`} , ${ceiling(distribution)}]`
    }
    try {
      const logPValue = logTail(distribution, magnitude)
      if (logPValue < LOG_MIN_P) throw new NumericFailure('probability-below-supported-range', 'Tail probability is below 1e-300; no zero p-value or decision is returned')
      const pValue = Math.exp(logPValue)
      const cacheKey = distribution.kind === 'normal' ? 'normal' : `${distribution.kind}:${distribution.degreesOfFreedom}`
      let cutoff = criticalCache.get(cacheKey)
      if (!cutoff) {
        cutoff = critical(distribution, memberAlpha)
        criticalCache.set(cacheKey, cutoff)
      }
      const delta = logPValue - Math.log(memberAlpha)
      return {
        memberId: member.id, status: 'calculated', statistic: statistic.value, pValue, logPValue,
        adjustedPValue: Math.min(1, denominator * pValue), logAdjustedPValue: Math.min(0, logPValue + Math.log(denominator)),
        ...cutoff,
        comparison: Math.abs(delta) <= policy.logComparisonMargin ? 'boundary-unresolved' : delta < 0 ? 'p-below-adjusted-alpha' : 'p-above-adjusted-alpha'
      }
    } catch (error) {
      if (!(error instanceof NumericFailure)) throw error
      return { memberId: member.id, status: 'numerical-failure', code: error.code, message: error.message }
    }
  })
  return SurveyStatisticalFamilyOutputV1.parse({ ...flags, outcome: 'evaluated', request, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'), denominator, memberAlpha, results })
}
