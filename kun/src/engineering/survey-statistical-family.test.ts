import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SurveyStatisticalFamilyInputV1, SurveyStatisticalFamilyOutputV1, type SurveyStatisticalDistributionV1, type SurveyStatisticalFamilyInputV1 as Input, type SurveyStatisticalFamilyOutputV1 as Output } from '../contracts/survey-statistical-family'
import { evaluateSurveyStatisticalFamilyV1 } from './survey-statistical-family'

const prior = { scaleBasis: 'caller-declared-known-prior-standard-deviation', priorStandardDeviation: 1, scaleUnit: 'mm' } as const
function distribution(kind: string, df: number | null = null): SurveyStatisticalDistributionV1 {
  if (kind === 'normal') return { kind, tail: 'two-sided', statisticBasis: 'standardized-by-known-prior-scale', ...prior }
  if (kind === 'student-t') return { kind, tail: 'two-sided', statisticBasis: 'externally-studentized', degreesOfFreedom: df! }
  return { kind: 'chi-square', tail: 'upper', statisticBasis: 'quadratic-form-divided-by-known-prior-variance', degreesOfFreedom: df!, ...prior }
}
function input(kind = 'normal', df: number | null = null, statistic = 2, alpha = 0.05, familySize = 1): Input {
  return {
    schemaVersion: 1, familyId: 'original-fixed-synthetic-family', declaration: 'caller-declared-before-observing-statistics',
    statisticPrecision: 'caller-declared-exact-scalar-inputs-no-upstream-error-propagation', correction: 'bonferroni', alpha,
    members: Array.from({ length: familySize }, (_, i) => ({ id: `member-${i}`, sourceAnchor: `synthetic/declared-member/${i}`, distribution: distribution(kind, df) })),
    statistics: [{ memberId: 'member-0', status: 'available', value: statistic }]
  }
}
function evaluated(value: unknown): Extract<Output, { outcome: 'evaluated' }> {
  const result = evaluateSurveyStatisticalFamilyV1(value)
  expect(result.outcome).toBe('evaluated')
  if (result.outcome !== 'evaluated') throw new Error(result.message)
  return result
}
function calculated(value: unknown): Extract<Extract<Output, { outcome: 'evaluated' }>['results'][number], { status: 'calculated' }> {
  const first = evaluated(value).results[0]!
  expect(first.status).toBe('calculated')
  if (first.status !== 'calculated') throw new Error(JSON.stringify(first))
  return first
}
const oracle = JSON.parse(readFileSync(new URL('../../../docs/qa/evidence/railwise-statistical-family-20260920/survey-statistical-family-oracle.json', import.meta.url), 'utf8')) as {
  provenance: { mpmath: string; decimalPrecision: number }
  probabilities: { kind: string; statistic: number; df: number | null; p: string; logP: string }[]
  critical: { kind: string; df: number | null; alpha: number; familySize: number; memberAlpha: number; critical: string }[]
}

describe('declared statistical family: independent high precision distribution evidence', () => {
  it('pins the oracle implementation independently of the product', () => {
    expect(oracle.provenance.mpmath).toBe('1.3.0')
    expect(oracle.provenance.decimalPrecision).toBe(120)
    expect(oracle.probabilities.length).toBe(156)
    expect(oracle.critical.length).toBe(36)
  })
  for (const row of oracle.probabilities) it(`${row.kind} df=${row.df} statistic=${row.statistic}`, () => {
    const result = evaluated(input(row.kind, row.df, row.statistic)).results[0]!
    const logP = Number(row.logP)
    if (logP < Math.log(1e-300)) {
      expect(result).toMatchObject({ status: 'numerical-failure', code: 'probability-below-supported-range' })
      expect(result).not.toHaveProperty('pValue')
      expect(result).not.toHaveProperty('comparison')
    } else {
      expect(result.status).toBe('calculated')
      if (result.status !== 'calculated') throw new Error(JSON.stringify(result))
      expect(Math.abs(result.logPValue - logP)).toBeLessThan(2e-11)
      expect(Math.abs(result.pValue / Number(row.p) - 1)).toBeLessThan(2e-11)
    }
  })
  for (const row of oracle.critical) it(`critical ${row.kind} df=${row.df} alpha=${row.alpha}/${row.familySize}`, () => {
    const result = calculated(input(row.kind, row.df, 0, row.alpha, row.familySize))
    const expected = Number(row.critical)
    expect(Math.abs(result.criticalMagnitude / expected - 1)).toBeLessThan(2e-11)
    expect(result.numericalResolutionInterval[0]).toBeLessThan(expected)
    expect(result.numericalResolutionInterval[1]).toBeGreaterThan(expected)
    const atReference = calculated(input(row.kind, row.df, expected, row.alpha, row.familySize))
    expect(atReference.comparison).toBe('boundary-unresolved')
    expect(calculated(input(row.kind, row.df, expected * (1 - 1e-7), row.alpha, row.familySize)).comparison).toBe('p-above-adjusted-alpha')
    expect(calculated(input(row.kind, row.df, expected * (1 + 1e-7), row.alpha, row.familySize)).comparison).toBe('p-below-adjusted-alpha')
  })
  it('agrees with independent closed forms in extreme supported tails', () => {
    for (const value of [1, 100, 1e8, 1e16]) {
      expect(calculated(input('student-t', 1, value)).pValue / (2 / Math.PI * Math.atan(1 / value))).toBeCloseTo(1, 12)
      const hyp = Math.hypot(value, Math.sqrt(2))
      expect(calculated(input('student-t', 2, value)).pValue / (2 / (hyp * (hyp + value)))).toBeCloseTo(1, 12)
    }
    for (const value of [0, 2, 500, 1380]) expect(calculated(input('chi-square', 2, value)).logPValue).toBeCloseTo(-value / 2, 11)
    for (const alpha of [1e-12, 0.05, 0.5]) expect(calculated(input('chi-square', 2, 0, alpha, 256)).criticalMagnitude / (-2 * Math.log(alpha / 256))).toBeCloseTo(1, 12)
  })
})

describe('declared family accounting and explicit limits', () => {
  it('never drops absent, unavailable, or undetectable declarations from the correction', () => {
    const value = input('normal', null, 2.5, 0.05, 4)
    value.statistics.push({ memberId: 'member-1', status: 'undetectable', reason: 'zero-redundancy' }, { memberId: 'member-2', status: 'unavailable', reason: 'missing-external-variance' })
    const result = evaluated(value)
    expect(result.denominator).toBe(4)
    expect(result.memberAlpha).toBe(0.0125)
    expect(result.results.slice(1)).toEqual([{ memberId: 'member-1', status: 'undetectable', reason: 'zero-redundancy' }, { memberId: 'member-2', status: 'unavailable', reason: 'missing-external-variance' }, { memberId: 'member-3', status: 'unavailable', reason: 'not-supplied' }])
    const first = calculated(value)
    expect(first.adjustedPValue).toBe(first.pValue * 4)
    expect(first.comparison).toBe('p-below-adjusted-alpha')
    expect(calculated(input('normal', null, 2.5, 0.05, 256)).comparison).toBe('p-above-adjusted-alpha')
  })
  it('preserves all-unavailable families, including the maximum size', () => {
    const value = input('normal', null, 0, 1e-12, 256)
    value.statistics = []
    const result = evaluated(value)
    expect(result.results).toHaveLength(256)
    expect(result.memberAlpha).toBe(1e-12 / 256)
    expect(result.results.every(r => r.status === 'unavailable')).toBe(true)
  })
  it('keeps domain and numerical failure members in a heterogeneous family', () => {
    const value = input('normal', null, 36, 0.05, 4)
    value.members[1]!.distribution = distribution('chi-square', 1000)
    value.members[2]!.distribution = distribution('student-t', 10)
    value.statistics.push({ memberId: 'member-1', status: 'available', value: 1e6 }, { memberId: 'member-2', status: 'available', value: 2 })
    const result = evaluated(value)
    expect(result.denominator).toBe(4)
    expect(result.results.map(r => r.status)).toEqual(['domain-failure', 'numerical-failure', 'calculated', 'unavailable'])
  })
  it('canonicalizes supplied statistic order without mutating the input', () => {
    const value = input('normal', null, 3, 0.05, 2)
    value.statistics.unshift({ memberId: 'member-1', status: 'available', value: -3 })
    const before = JSON.stringify(value)
    const result = evaluated(value)
    const reverse = structuredClone(value)
    reverse.statistics.reverse()
    expect(evaluated(reverse)).toEqual(result)
    expect(JSON.stringify(value)).toBe(before)
    expect(result.requestSha256).toBe(createHash('sha256').update(JSON.stringify(result.request)).digest('hex'))
    reverse.members.reverse()
    expect(evaluated(reverse).results).toEqual([...result.results].reverse())
  })
  it('does not rescale an already standardized statistic a second time', () => {
    const value = input('normal', null, 3)
    const original = calculated(value)
    const declared = value.members[0]!.distribution
    if (declared.kind !== 'normal') throw new Error('normal expected')
    declared.priorStandardDeviation = 2
    expect(calculated(value)).toEqual(original)
  })
  it('retains sign symmetry for two-sided tails and zero-statistic probability one', () => {
    for (const kind of ['normal', 'student-t']) {
      expect(calculated(input(kind, 10, -3)).pValue).toBe(calculated(input(kind, 10, 3)).pValue)
      expect(calculated(input(kind, 10, 0))).toMatchObject({ pValue: 1, logPValue: 0, adjustedPValue: 1, logAdjustedPValue: 0 })
    }
    expect(calculated(input('chi-square', 10, 0)).pValue).toBe(1)
  })
  it('supports representable near-zero scalars without NaN', () => {
    for (const kind of ['normal', 'student-t', 'chi-square']) for (const value of [Number.MIN_VALUE, 1e-160]) {
      expect(calculated(input(kind, 1, value)).pValue).toBe(1)
    }
  })
  for (const [kind, df, value] of [['normal', null, 35.00001], ['normal', null, -35.00001], ['student-t', 1, 1e16 + 2], ['chi-square', 1, -Number.MIN_VALUE], ['chi-square', 1, 1000000.1]] as const) it(`explicit domain failure for ${kind} ${value}`, () => {
    expect(evaluated(input(kind, df, value)).results[0]).toMatchObject({ status: 'domain-failure', code: 'statistic-outside-supported-domain' })
  })
  it('never outputs a silent zero when the positive tail is below its documented floor', () => {
    expect(evaluated(input('chi-square', 2, 1382)).results[0]).toMatchObject({ status: 'numerical-failure', code: 'probability-below-supported-range' })
    expect(calculated(input('chi-square', 2, 1380)).pValue).toBeGreaterThan(0)
  })
  it('reports declarations as unverified and performs no observation action', () => {
    expect(evaluated(input())).toMatchObject({ status: 'trial-only', modelAssumptions: 'not-verified', familyPredeclaration: 'not-verified', engineeringDecision: 'not-evaluated', observationAction: 'none', numericalIntervalMeaning: 'software-resolution-policy-not-certified-error-bound' })
  })
})

describe('strict versioned contract rejects unsupported claims and malformed families', () => {
  const mutations: [string, (value: Record<string, unknown>) => void][] = [
    ['empty family', v => { v.members = [] }], ['257 members', v => { v.members = input('normal', null, 0, 0.05, 257).members }],
    ['duplicate members', v => { v.members = [input().members[0], input().members[0]] }],
    ['duplicate statistics', v => { v.statistics = [input().statistics[0], input().statistics[0]] }],
    ['unknown statistic', v => { v.statistics = [{ memberId: 'not-declared', status: 'available', value: 1 }] }],
    ['NaN', v => { v.statistics = [{ memberId: 'member-0', status: 'available', value: NaN }] }],
    ['Infinity', v => { v.statistics = [{ memberId: 'member-0', status: 'available', value: Infinity }] }],
    ['small alpha', v => { v.alpha = 1e-13 }], ['large alpha', v => { v.alpha = 0.50001 }], ['version', v => { v.schemaVersion = 2 }],
    ['adaptive family', v => { v.declaration = 'after-observing-statistics' }], ['other correction', v => { v.correction = 'holm' }],
    ['upstream approximate scalar', v => { v.statisticPrecision = 'propagated-error' }], ['unknown field', v => { v.autoDelete = true }]
  ]
  for (const [name, mutate] of mutations) it(name, () => {
    const value = structuredClone(input()) as unknown as Record<string, unknown>
    mutate(value)
    expect(SurveyStatisticalFamilyInputV1.safeParse(value).success).toBe(false)
    expect(evaluateSurveyStatisticalFamilyV1(value).outcome).toBe('invalid-input')
  })
  for (const df of [0, -1, 1.5, 1001, Infinity, NaN]) it(`rejects df=${df}`, () => {
    expect(evaluateSurveyStatisticalFamilyV1(input('student-t', df)).outcome).toBe('invalid-input')
    expect(evaluateSurveyStatisticalFamilyV1(input('chi-square', df)).outcome).toBe('invalid-input')
  })
  it('rejects wrong tails, posterior scale, internal studentization and omitted exact-input declaration', () => {
    for (const [kind, field, replacement] of [['normal', 'tail', 'upper'], ['chi-square', 'tail', 'two-sided'], ['normal', 'scaleBasis', 'estimated-from-current-fit'], ['student-t', 'statisticBasis', 'internally-studentized']] as const) {
      const value = input(kind, 1) as unknown as { members: { distribution: Record<string, unknown> }[] }
      value.members[0]!.distribution[field] = replacement
      expect(evaluateSurveyStatisticalFamilyV1(value).outcome).toBe('invalid-input')
    }
    const value = input() as unknown as Record<string, unknown>
    delete value.statisticPrecision
    expect(evaluateSurveyStatisticalFamilyV1(value).outcome).toBe('invalid-input')
  })
  it('requires output domain failures to match the input domain', () => {
    const value = evaluated(input('normal', null, 2))
    const forged = { ...value, results: [{ memberId: 'member-0', status: 'domain-failure', code: 'statistic-outside-supported-domain', message: 'forged refusal' }] }
    expect(SurveyStatisticalFamilyOutputV1.safeParse(forged).success).toBe(false)
    const outside = structuredClone(value)
    const supplied = outside.request.statistics[0]!
    if (supplied.status !== 'available') throw new Error('available expected')
    supplied.value = 36
    expect(SurveyStatisticalFamilyOutputV1.safeParse(outside).success).toBe(false)
  })
  it('rejects forged denominator, result identity, omission, correction and decision fields', () => {
    const value = input('normal', null, 2, 0.05, 4)
    const valid = evaluated(value)
    const variants = [
      { ...valid, denominator: 1 }, { ...valid, memberAlpha: 0.05 }, { ...valid, results: valid.results.slice(0, 1) },
      { ...valid, engineeringDecision: 'accepted' }, { ...valid, observationAction: 'delete' },
      { ...valid, results: valid.results.map((r, i) => i === 0 ? { ...r, memberId: 'forged' } : r) },
      { ...valid, results: valid.results.map((r, i) => i === 0 ? { ...r, adjustedPValue: 0.5 } : r) },
      { ...valid, results: valid.results.map((r, i) => i === 0 ? { ...r, comparison: 'p-below-adjusted-alpha' } : r) },
      { ...valid, results: valid.results.map((r, i) => i === 1 ? { memberId: r.memberId, status: 'unavailable', reason: 'silently-dropped' } : r) }
    ]
    for (const forged of variants) expect(SurveyStatisticalFamilyOutputV1.safeParse(forged).success).toBe(false)
  })
})
