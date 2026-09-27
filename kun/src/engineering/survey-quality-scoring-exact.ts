import { QUALITY_SCORING_LIMITS } from '../contracts/survey-quality-scoring.js'
import type { QualityExactValue } from '../contracts/survey-quality-scoring.js'

export type Exact = Readonly<{ n: bigint; d: bigint }>
const bound = (value: bigint): void => { if ((value < 0n ? -value : value).toString(2).length > QUALITY_SCORING_LIMITS.rationalBits) throw new RangeError('exact-arithmetic-budget') }
const gcd = (left: bigint, right: bigint): bigint => { let a = left < 0n ? -left : left, b = right < 0n ? -right : right; while (b) [a, b] = [b, a % b]; return a }
export function exact(n: bigint, d = 1n): Exact {
  if (!d) throw new RangeError('zero-denominator')
  bound(n); bound(d)
  if (d < 0n) { n = -n; d = -d }
  const g = gcd(n, d)
  return { n: n / g, d: d / g }
}
export function parseExact(value: string): Exact {
  if (!/^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,24}|\/[1-9]\d{0,23})?$/.test(value) || value.length > 52) throw new RangeError('invalid-exact-input')
  if (value.includes('/')) { const [n, d] = value.split('/'); return exact(BigInt(n!), BigInt(d!)) }
  if (value.includes('.')) { const [whole, fraction] = value.split('.'); return exact(BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction!.length)) }
  return exact(BigInt(value))
}
export const integer = (value: number): Exact => { if (!Number.isSafeInteger(value)) throw new RangeError('unsafe-integer'); return exact(BigInt(value)) }
export function add(a: Exact, b: Exact): Exact { const g = gcd(a.d, b.d); return exact(a.n * (b.d / g) + b.n * (a.d / g), (a.d / g) * b.d) }
export const neg = (a: Exact): Exact => ({ n: -a.n, d: a.d })
export const sub = (a: Exact, b: Exact): Exact => add(a, neg(b))
export function mul(a: Exact, b: Exact): Exact { const x = gcd(a.n, b.d), y = gcd(b.n, a.d); return exact((a.n / x) * (b.n / y), (a.d / y) * (b.d / x)) }
export const div = (a: Exact, b: Exact): Exact => mul(a, exact(b.d, b.n))
export const compare = (a: Exact, b: Exact): -1 | 0 | 1 => { const delta = a.n * b.d - b.n * a.d; bound(delta); return delta < 0n ? -1 : delta > 0n ? 1 : 0 }
export const sum = (values: readonly Exact[]): Exact => values.reduce(add, exact(0n))
export const output = (value: Exact): QualityExactValue => ({ numerator: value.n.toString(), denominator: value.d.toString() })
export const ZERO = exact(0n), ONE = exact(1n), SIXTY = exact(60n), HUNDRED = exact(100n)
