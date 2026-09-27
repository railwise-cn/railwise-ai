import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SurveyStaticIncrementalOutputV1, type SurveyStaticIncrementalInputV1 as Input, type SurveyStaticIncrementalOutputV1 as Output } from '../contracts/survey-static-incremental'
import { appendSurveyStaticLinearObservationsV1 as append, hashSurveyStaticIncrementalBaseV1 as fingerprint } from './survey-static-incremental'

type Expected = Record<string, string | string[] | string[][]>
type Case = { name: string; request: Input; canonicalBaseUtf8: string; prefixes: { appended: number; exact: Expected; mp120: Expected }[] }
const oracle = JSON.parse(readFileSync(new URL('../../../docs/qa/evidence/railwise-static-incremental-20260920/survey-static-incremental-oracle.json', import.meta.url), 'utf8')) as { provenance: { mpmath: string; decimalPrecision: number }; cases: Case[] }
const sample = (name = 'equal-weight-location'): Input => structuredClone(oracle.cases.find(c => c.name === name)!.request)
const rehash = (value: Input): Input => { value.expectedBaseFingerprint = fingerprint(value.base); return value }
function result(input: unknown): Extract<Output, { outcome: 'calculated' }> {
  const value = append(input)
  expect(value.outcome, JSON.stringify(value)).toBe('calculated')
  if (value.outcome !== 'calculated') throw new Error(JSON.stringify(value))
  return value
}
function rational(value: string): number {
  const [a, b = '1'] = value.split('/')
  return Number(a) / Number(b)
}
function close(actual: unknown, expected: unknown, tolerance = 2e-10): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true)
    expect((actual as unknown[]).length).toBe(expected.length)
    expected.forEach((v, i) => close((actual as unknown[])[i], v, tolerance))
  } else {
    const target = typeof expected === 'string' ? rational(expected) : Number(expected)
    expect(Math.abs(Number(actual) - target)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(target)))
  }
}
const unavailable = (input: unknown, code: string): void => { expect(append(input)).toMatchObject({ outcome: 'unavailable', code }) }
function compareFit(actual: Extract<Output, { outcome: 'calculated' }>['updatedFit'], expected: Expected, observations: Input['base']['observations']): void {
  for (const [field, values] of Object.entries(expected)) {
    if (field === 'aprioriParameterCovariance') {
      const covariance = values as string[][]
      covariance.forEach((row, i) => row.forEach((value, j) => {
        const scale = Math.sqrt(rational(covariance[i]![i]!)) * Math.sqrt(rational(covariance[j]![j]!))
        expect(Math.abs(actual.aprioriParameterCovariance[i]![j]! - rational(value)) / scale).toBeLessThan(2e-10)
      }))
    } else if (field === 'residuals') {
      ;(values as string[]).forEach((value, i) => {
        const observation = observations[i]!
        const subtractionScale = Math.abs(observation.value) + observation.coefficients.reduce((sum, coefficient, j) => sum + Math.abs(coefficient * actual.parameters[j]!), 0)
        // A tiny residual from a 3e6 observation cannot have finer absolute
        // precision than subtraction of its fitted value (binary64 ULP).
        const allowance = 2e-10 * Math.max(1, Math.abs(rational(value))) + 2 * Number.EPSILON * subtractionScale
        expect(Math.abs(actual.residuals[i]! - rational(value))).toBeLessThanOrEqual(allowance)
      })
    } else close(actual[field as keyof typeof actual], values)
  }
}


describe('static append: independent exact batch and high precision QR for every prefix', () => {
  it('pins the independent oracle and preserves its separately computed canonical fingerprints', () => {
    expect(oracle.provenance.mpmath).toBe('1.3.0')
    expect(oracle.provenance.decimalPrecision).toBe(120)
    expect(oracle.cases).toHaveLength(29)
    expect(oracle.cases.reduce((n, c) => n + c.prefixes.length, 0)).toBe(133)
    for (const c of oracle.cases) {
      expect(fingerprint(c.request.base)).toBe(c.request.expectedBaseFingerprint)
      expect(createHash('sha256').update(c.canonicalBaseUtf8).digest('hex')).toBe(c.request.expectedBaseFingerprint)
    }
  })
  for (const c of oracle.cases) for (const prefix of c.prefixes) it(`${c.name} append ${prefix.appended}`, () => {
    const input = structuredClone(c.request)
    if (prefix.appended) input.append.observations = input.append.observations.slice(0, prefix.appended)
    const actual = result(input)
    const fit = prefix.appended ? actual.updatedFit : actual.baseFit
    const observations = prefix.appended ? [...input.base.observations, ...input.append.observations] : input.base.observations
    compareFit(fit, prefix.exact, observations)
    compareFit(fit, prefix.mp120, observations)
    expect(actual.steps).toHaveLength(input.append.observations.length)
    expect(actual.baseQrState.columnScales).toEqual(actual.updatedQrState.columnScales)
    expect(actual.batchCheck.maximumScaledParameterDifference).toBeLessThanOrEqual(1e-8)
    expect(actual.batchCheck.scaledSseDifference).toBeLessThanOrEqual(1e-8)
    expect(actual.batchCheck.maximumScaledCovarianceDifference).toBeLessThanOrEqual(1e-8)
    expect(JSON.stringify(actual.request.base)).toBe(c.canonicalBaseUtf8)
  })
  it('uses known prior covariance rather than multiplying it by the posterior diagnostic', () => {
    const value = sample()
    value.append.observations = value.append.observations.slice(0, 1)
    const actual = result(value)
    close(actual.baseFit.parameters, [2])
    close(actual.baseFit.aprioriParameterCovariance, [[1 / 3]])
    close(actual.updatedFit.parameters, [3.5])
    close(actual.updatedFit.aprioriParameterCovariance, [[0.25]])
    close(actual.updatedFit.weightedResidualSumSquares, 35)
    close(actual.updatedFit.posteriorVarianceFactorEstimate, 35 / 3)
    expect(actual.updatedFit.posteriorEstimateUse).toBe('diagnostic-only-not-applied-to-prior-covariance-or-weights')
  })
  it('adds a zero-information row only to residual evidence and degrees of freedom', () => {
    const actual = result(sample('zero-information-row'))
    close(actual.updatedFit.parameters, actual.baseFit.parameters)
    close(actual.updatedFit.aprioriParameterCovariance, actual.baseFit.aprioriParameterCovariance)
    close(actual.updatedFit.weightedResidualSumSquares, actual.baseFit.weightedResidualSumSquares + 25)
    expect(actual.updatedFit.degreesOfFreedom).toBe(actual.baseFit.degreesOfFreedom + 1)
  })
})

describe('static append bookkeeping, replay and transformations', () => {
  it('retains originals, rejects stale fingerprints and binds the resulting complete snapshot', () => {
    const value = sample('original-seeded-3')
    const before = JSON.stringify(value)
    const actual = result(value)
    expect(JSON.stringify(value)).toBe(before)
    const nextBase = { ...value.base, revision: value.append.nextRevision, observations: [...value.base.observations, ...value.append.observations] }
    expect(actual.finalFingerprint).toBe(fingerprint(nextBase))
    expect(actual.observationIds).toEqual(nextBase.observations.map(o => o.id))
    for (const change of ['value', 'weight', 'coefficient', 'parameter', 'network', 'revision'] as const) {
      const mutated = structuredClone(value)
      if (change === 'value') mutated.base.observations[0]!.value += 1
      if (change === 'weight') mutated.base.observations[0]!.aprioriVariance *= 2
      if (change === 'coefficient') mutated.base.observations[0]!.coefficients[0]! += 1
      if (change === 'parameter') mutated.base.parameterIds[0] = 'different-parameter'
      if (change === 'network') mutated.base.networkId = 'different-network'
      if (change === 'revision') { mutated.base.revision++; mutated.append.nextRevision++ }
      unavailable(mutated, 'base-fingerprint-mismatch')
    }
    expect(result(structuredClone(value))).toEqual(actual)
  })
  it('canonicalizes property insertion order but preserves declared observation order', () => {
    const value = sample()
    const shuffled = Object.fromEntries(Object.entries(value.base).reverse())
    expect(fingerprint(shuffled)).toBe(value.expectedBaseFingerprint)
    const reordered = structuredClone(value.base)
    reordered.observations.reverse()
    expect(fingerprint(reordered)).not.toBe(value.expectedBaseFingerprint)
  })
  it('one batch and successive append snapshots have equivalent final fits without claiming cross-request persistence', () => {
    const value = sample('original-seeded-3')
    const all = result(value)
    let base = structuredClone(value.base)
    let last: typeof all | null = null
    for (const observation of value.append.observations) {
      last = result({ ...value, base, expectedBaseFingerprint: fingerprint(base), append: { ...value.append, nextRevision: base.revision + 1, observations: [observation] } })
      base = { ...base, revision: base.revision + 1, observations: [...base.observations, observation] }
      expect(last.finalFingerprint).toBe(fingerprint(base))
    }
    close(last!.updatedFit.parameters, all.updatedFit.parameters)
    close(last!.updatedFit.aprioriParameterCovariance, all.updatedFit.aprioriParameterCovariance)
    close(last!.updatedFit.weightedResidualSumSquares, all.updatedFit.weightedResidualSumSquares)
    expect(all.persistenceAndCrossRequestIdempotency).toBe('not-implemented-pure-replay-only')
  })
  it('reordering original or new independent rows preserves the final weighted solution', () => {
    const value = sample('original-seeded-3')
    const original = result(value)
    value.base.observations.reverse()
    value.append.observations.reverse()
    const actual = result(rehash(value))
    close(actual.updatedFit.parameters, original.updatedFit.parameters)
    close(actual.updatedFit.aprioriParameterCovariance, original.updatedFit.aprioriParameterCovariance)
    close(actual.updatedFit.weightedResidualSumSquares, original.updatedFit.weightedResidualSumSquares)
  })
  for (const scale of [1e-60, 1e60]) it(`absolute variance scaling ${scale} preserves parameters and changes precision`, () => {
    const value = sample('original-seeded-3')
    const original = result(value)
    for (const o of [...value.base.observations, ...value.append.observations]) o.aprioriVariance *= scale
    const actual = result(rehash(value))
    close(actual.updatedFit.parameters, original.updatedFit.parameters)
    close(actual.updatedFit.aprioriParameterCovariance.map(row => row.map(v => v / scale)), original.updatedFit.aprioriParameterCovariance)
    close(actual.updatedFit.weightedResidualSumSquares * scale, original.updatedFit.weightedResidualSumSquares)
  })
  it('m/mm conversion changes parameters and covariance consistently', () => {
    const value = sample('original-seeded-3')
    const original = result(value)
    value.base.unit = 'm'
    for (const o of [...value.base.observations, ...value.append.observations]) { o.value /= 1000; o.aprioriVariance /= 1e6 }
    const actual = result(rehash(value))
    close(actual.updatedFit.parameters.map(v => v * 1000), original.updatedFit.parameters)
    close(actual.updatedFit.aprioriParameterCovariance.map(row => row.map(v => v * 1e6)), original.updatedFit.aprioriParameterCovariance)
    close(actual.updatedFit.weightedResidualSumSquares, original.updatedFit.weightedResidualSumSquares)
    expect(actual.squaredUnit).toBe('m2')
  })
  it('supports all-zero observations without dividing by a zero comparison scale', () => {
    const value = sample('original-seeded-3')
    for (const o of [...value.base.observations, ...value.append.observations]) o.value = 0
    const actual = result(rehash(value))
    expect(actual.updatedFit.parameters.every(v => v === 0)).toBe(true)
    expect(actual.updatedFit.weightedResidualSumSquares).toBe(0)
    expect(actual.updatedFit.aprioriParameterCovariance.every((row, i) => row[i]! > 0)).toBe(true)
  })
  it('supports the terminal 256-observation, 16-parameter snapshot and 128 additions', () => {
    const value = sample()
    value.base.parameterIds = Array.from({ length: 16 }, (_, i) => `x${i}`)
    const observations = Array.from({ length: 256 }, (_, i) => ({ id: `o${i}`, value: i % 16 + Math.floor(i / 16) * 0.25, coefficients: Array.from({ length: 16 }, (_, j) => i % 16 === j ? 1 : 0), aprioriVariance: 1, sourceAnchor: `synthetic:${i}` }))
    value.base.observations = observations.slice(0, 128)
    value.append.observations = observations.slice(128)
    const actual = result(rehash(value))
    expect(actual.steps).toHaveLength(128)
    expect(actual.observationIds).toHaveLength(256)
    close(actual.updatedFit.parameters, Array.from({ length: 16 }, (_, i) => i + 1.875))
    close(actual.updatedFit.aprioriParameterCovariance, Array.from({ length: 16 }, (_, i) => Array.from({ length: 16 }, (_, j) => i === j ? 1 / 16 : 0)))
  })
})

describe('static append failure boundaries and strict contract', () => {
  it('rejects rank-deficient or badly conditioned originals instead of silently changing datum', () => {
    const value = sample('noiseless-fixed-line')
    value.base.observations.forEach(o => { o.coefficients = [1, 1] })
    unavailable(rehash(value), 'base-rank-or-conditioning')
    value.base.observations.forEach((o, i) => { o.coefficients = [1, 1 + i * 1e-10] })
    unavailable(rehash(value), 'base-rank-or-conditioning')
  })
  it('refuses a numerically dominated update although exact mathematical rank cannot decrease', () => {
    const value = sample('noiseless-fixed-line')
    value.append.observations = [{ id: 'dominant', value: 1, coefficients: [1e6, 0], aprioriVariance: 1e-12, sourceAnchor: 'synthetic:dominant' }]
    unavailable(value, 'updated-rank-or-conditioning')
  })
  it('enforces global prior variance ratio and rejects subnormal numerical input', () => {
    const ratio = sample()
    ratio.append.observations[0]!.aprioriVariance = 1e-13
    unavailable(ratio, 'variance-ratio-outside-supported-domain')
    const tiny = sample()
    tiny.append.observations[0]!.value = Number.MIN_VALUE
    unavailable(tiny, 'numeric-range-or-resolution')
  })
  it('retains declared sources and makes no runtime, approval or formal-write claims', () => {
    expect(result(sample())).toMatchObject({ status: 'trial-only', modelAssumptions: 'not-verified', sourceRecordsVerified: false, priorRuntimeStateVerified: false, formalResultsModified: false, originalObservationsModified: false, engineeringDecision: 'not-evaluated' })
  })
  it('rejects duplicate IDs, changing dimensions, empty updates, revision jumps and unsupported operations', () => {
    const values = [sample(), sample(), sample(), sample(), sample()]
    values[0]!.append.observations[0]!.id = values[0]!.base.observations[0]!.id
    values[1]!.append.observations[0]!.coefficients.push(1)
    values[2]!.append.observations = []
    values[3]!.append.nextRevision = 4
    values[4]!.append.observations.push(values[4]!.append.observations[0]!)
    for (const value of values) expect(append(value).outcome).toBe('invalid-input')
    expect(append({ ...sample(), operation: 'delete-old-observation' }).outcome).toBe('invalid-input')
    expect(append({ ...sample(), crossCovariance: [[1]] }).outcome).toBe('invalid-input')
  })
  it('rejects zero/negative/nonfinite variance, unknown basis and malformed observation inputs', () => {
    for (const variance of [0, -1, Infinity, NaN, 1e-101, 1e101]) {
      const value = sample()
      value.append.observations[0]!.aprioriVariance = variance
      expect(append(value).outcome).toBe('invalid-input')
    }
    const value = sample() as unknown as { base: Record<string, unknown> }
    value.base.covarianceBasis = 'relative-weights-with-estimated-posterior-scale'
    expect(append(value).outcome).toBe('invalid-input')
  })
  it('rejects forged output IDs, scale changes, failed comparisons and posterior rescaling', () => {
    const valid = result(sample())
    expect(SurveyStaticIncrementalOutputV1.safeParse({ ...valid, observationIds: [...valid.observationIds].reverse() }).success).toBe(false)
    expect(SurveyStaticIncrementalOutputV1.safeParse({ ...valid, engineeringDecision: 'approved' }).success).toBe(false)
    expect(SurveyStaticIncrementalOutputV1.safeParse({ ...valid, batchCheck: { ...valid.batchCheck, scaledSseDifference: 0.1 } }).success).toBe(false)
    const scale = structuredClone(valid)
    scale.updatedQrState.columnScales[0]! *= 2
    expect(SurveyStaticIncrementalOutputV1.safeParse(scale).success).toBe(false)
    const posterior = structuredClone(valid)
    posterior.updatedFit.posteriorVarianceFactorEstimate += 1
    expect(SurveyStaticIncrementalOutputV1.safeParse(posterior).success).toBe(false)
    const step = structuredClone(valid)
    step.steps[0]!.observationId = 'wrong-row'
    expect(SurveyStaticIncrementalOutputV1.safeParse(step).success).toBe(false)
  })
})
