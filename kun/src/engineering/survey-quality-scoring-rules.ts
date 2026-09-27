/** Internal exact rule primitives. Public scoring requires the source/profile-bound request. */
import { add, sub, mul, div, compare, sum, integer, exact, ZERO, ONE, SIXTY, HUNDRED, type Exact } from './survey-quality-scoring-exact.js'
export type QualityState = 'calculated' | 'nonconforming' | 'unavailable' | 'invalid'
export type Grade = 'excellent' | 'good' | 'qualified'
export type RuleResult = { state: QualityState; reason: string; score?: Exact; rawScore?: Exact; fixedADeduction?: Exact; diagnosticScoreUpperBound?: Exact; grade?: Grade; qualified?: boolean;
  count?: number; excellentRate?: Exact; excellentGoodRate?: Exact }
export const invalid = (reason: string): RuleResult => ({ state: 'invalid', reason })
export const unavailable = (reason: string): RuleResult => ({ state: 'unavailable', reason })
export const nonconforming = (reason: string): RuleResult => ({ state: 'nonconforming', reason, qualified: false })
export const calculated = (score: Exact): RuleResult => ({ state: 'calculated', reason: 'calculated', score })
export function accuracy(m: Exact, m0: Exact): RuleResult {
  if (compare(m, ZERO) < 0 || compare(m0, ZERO) <= 0) return invalid('accuracy_domain')
  if (compare(m, m0) > 0) return unavailable('accuracy_formula_outside_domain')
  return calculated(compare(mul(integer(10), m), mul(integer(3), m0)) <= 0 ? HUNDRED : add(SIXTY, mul(exact(400n, 7n), div(sub(m0, m), m0))))
}
export function weighted(scores: Exact[], weights: Exact[]): RuleResult {
  if (!scores.length || scores.length !== weights.length) return invalid('weight_shape')
  if (weights.some(value => compare(value, ZERO) <= 0) || compare(sum(weights), ONE) !== 0) return invalid('weights_positive_sum_one')
  return calculated(sum(scores.map((score, i) => mul(score, weights[i]!))))
}
export function multiple(scores: Array<Exact | null>, suppliedWeights?: Exact[]): RuleResult {
  if (!scores.length) return invalid('empty_accuracy_items')
  const weights = suppliedWeights ?? scores.map(() => exact(1n, BigInt(scores.length)))
  const weightCheck = weighted(scores.map(() => ZERO), weights)
  if (weightCheck.state === 'invalid') return weightCheck
  if (scores.some(score => score !== null && (compare(score, SIXTY) < 0 || compare(score, HUNDRED) > 0))) return invalid('accuracy_score_outside_formula_range')
  if (scores.some(score => score === null)) return unavailable('missing_accuracy_item')
  const known = scores as Exact[]
  if (known.length > 1 && known.some(score => compare(score, SIXTY) === 0)) return unavailable('multiple_accuracy_equality_60')
  return weighted(known, weights)
}
export function deduction(a: number | null, b: number | null, c: number | null, d: number | null, t: Exact): RuleResult {
  if ([a, b, c, d].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) return invalid('defect_count')
  if (compare(t, ZERO) <= 0) return invalid('adjustment_coefficient')
  if (a !== null && a > 0) return { ...nonconforming('a_class_veto'), fixedADeduction: integer(42 * a) }
  if (compare(t, ONE) !== 0) return unavailable('adjusted_t_not_in_minimal_contract')
  const upper = integer(100 - 12 * (b ?? 0) - 4 * (c ?? 0) - (d ?? 0))
  if ([b, c, d].some(value => value === null)) return compare(upper, SIXTY) < 0
    ? { ...nonconforming('known_defects_already_below_60'), diagnosticScoreUpperBound: upper } : unavailable('missing_defect_evidence')
  if (compare(upper, SIXTY) < 0) return { ...nonconforming('subelement_below_60'), rawScore: upper }
  if (a === null) return { ...unavailable('missing_a_evidence'), diagnosticScoreUpperBound: upper }
  return calculated(upper)
}
export function grade(score: Exact): RuleResult {
  if (compare(score, HUNDRED) > 0) return invalid('score_above_100')
  if (compare(score, SIXTY) < 0) return { ...nonconforming('score_below_60'), rawScore: score }
  return { ...calculated(score), grade: compare(score, integer(90)) >= 0 ? 'excellent' : compare(score, integer(75)) >= 0 ? 'good' : 'qualified', qualified: true }
}
export function unit(scores: Array<Exact | null>, weights: Exact[], a: number | null, complete: boolean): RuleResult {
  const check = weighted(scores.map(() => ZERO), weights)
  if (check.state === 'invalid' || a !== null && (!Number.isSafeInteger(a) || a < 0)) return check.state === 'invalid' ? check : invalid('defect_count')
  if (scores.some(score => score !== null && compare(score, HUNDRED) > 0)) return invalid('score_above_100')
  if (a !== null && a > 0) return nonconforming('a_class_veto')
  if (scores.some(score => score !== null && compare(score, SIXTY) < 0)) return nonconforming('child_below_60')
  if (!complete || a === null || scores.some(score => score === null)) return unavailable('incomplete_unit_evidence')
  const combined = weighted(scores as Exact[], weights)
  return combined.score ? grade(combined.score) : combined
}
export function sample(units: RuleResult[]): RuleResult {
  if (!units.length) return invalid('empty_sample')
  if (units.some(value => value.state === 'invalid')) return invalid('invalid_sample_unit')
  if (units.some(value => value.state === 'nonconforming')) return nonconforming('sample_has_failed_unit')
  if (units.some(value => value.state !== 'calculated' || !value.score)) return unavailable('sample_has_unresolved_unit')
  return grade(div(sum(units.map(value => value.score!)), integer(units.length)))
}
export function overview(a: number | null, b: number | null): RuleResult {
  if ([a, b].some(value => value !== null && (!Number.isSafeInteger(value) || value < 0))) return invalid('defect_count')
  if (a !== null && a > 0 || b !== null && b >= 4) return nonconforming('overview_defects')
  if (a === null || b === null) return unavailable('overview_missing_evidence')
  return { state: 'calculated', reason: 'calculated', qualified: true }
}
export function finalBatch(e: number, g: number, q: number, prerequisite: boolean | null, complete: boolean): RuleResult {
  if ([e, g, q].some(value => !Number.isSafeInteger(value) || value < 0) || e + g + q === 0) return invalid('batch_counts')
  if (prerequisite === false) return nonconforming('batch_prerequisite_failed')
  if (prerequisite !== true || !complete) return unavailable('batch_prerequisite_missing')
  const n = e + g + q, E = BigInt(e), G = BigInt(g), N = BigInt(n)
  const rating: Grade = 10n * (E + G) >= 9n * N && 2n * E >= N ? 'excellent' : 5n * (E + G) >= 4n * N && 10n * E >= 3n * N ? 'good' : 'qualified'
  return { state: 'calculated', reason: 'calculated', grade: rating, qualified: true, count: n, excellentRate: exact(E, N), excellentGoodRate: exact(E + G, N) }
}
export function acceptance(detailed: string | null, overviewState: string | null, fabricated: boolean | null, major: boolean | null): RuleResult {
  if (fabricated || major) return nonconforming('batch_fabrication_or_major_route_veto')
  if (detailed === 'failed' || overviewState === 'failed') return nonconforming('inspection_failed')
  if (fabricated === null || major === null) return unavailable('batch_veto_evidence_missing')
  if (detailed !== 'qualified' || !['qualified', 'not-performed', 'not_performed'].includes(overviewState ?? '')) return unavailable('inspection_unresolved')
  return { state: 'calculated', reason: 'calculated', qualified: true }
}
