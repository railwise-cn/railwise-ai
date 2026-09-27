import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SurveyReferenceDatumOutputV1, type SurveyReferenceDatumInputV1 as Input, type SurveyReferenceDatumOutputV1 as Output } from '../contracts/survey-reference-datum'
import { compareSurveyReferenceDatumV1 } from './survey-reference-datum'

type Oracle = { name: string; request: Input; exactRational: Record<string, string | string[] | string[][]>; binary120: Record<string, string | string[] | string[][]> }
const oracle = JSON.parse(readFileSync(new URL('../../../docs/qa/evidence/railwise-reference-datum-20260920/survey-reference-datum-oracle.json', import.meta.url), 'utf8')) as { provenance: { mpmath: string; decimalPrecision: number }; cases: Oracle[] }
const sample = (name = 'three-equal-variance-gls-reference-mean'): Input => structuredClone(oracle.cases.find(c => c.name === name)!.request)
function calculated(input: unknown): Extract<Output, { outcome: 'calculated' }> {
  const result = compareSurveyReferenceDatumV1(input)
  expect(result.outcome, JSON.stringify(result)).toBe('calculated')
  if (result.outcome !== 'calculated') throw new Error(JSON.stringify(result))
  return result
}
function fraction(value: string): number {
  const [numerator, denominator = '1'] = value.split('/')
  return Number(numerator) / Number(denominator)
}
function close(actual: unknown, expected: unknown, tolerance = 2e-11): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true)
    expect((actual as unknown[]).length).toBe(expected.length)
    expected.forEach((v, i) => close((actual as unknown[])[i], v, tolerance))
  } else {
    const value = typeof expected === 'string' ? fraction(expected) : Number(expected)
    expect(Math.abs(Number(actual) - value)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(value)))
  }
}
function unavailable(value: unknown, code: string): void {
  expect(compareSurveyReferenceDatumV1(value)).toMatchObject({ outcome: 'unavailable', code })
}

describe('reference datum: independent rational and high precision oracle', () => {
  it('uses original Fraction models and a pinned independent high precision solver', () => {
    expect(oracle.cases).toHaveLength(54)
    expect(oracle.provenance.mpmath).toBe('1.3.0')
    expect(oracle.provenance.decimalPrecision).toBe(120)
  })
  for (const row of oracle.cases) it(row.name, () => {
    const result = calculated(row.request)
    for (const [key, expected] of Object.entries(row.exactRational)) close(result[key as keyof typeof result], expected)
    for (const [key, expected] of Object.entries(row.binary120)) close(result[key as keyof typeof result], expected)
  })
  it('keeps the moving reference displacement instead of declaring reference points stationary', () => {
    const result = calculated(sample())
    close(result.referenceShift, 1)
    close(result.displacements, [-1, -1, 2])
    close(result.displacementCovariance, [[4 / 3, -2 / 3, -2 / 3], [-2 / 3, 4 / 3, -2 / 3], [-2 / 3, -2 / 3, 4 / 3]])
    close(result.shiftDisplacementCovariance, [0, 0, 0])
    expect(result.referencePhysicalStability).toBe('not-evaluated')
  })
  it('retains legitimate negative GLS weights and keeps equal-reference semantics separate', () => {
    const gls = calculated(sample('negative-gls-weight-gls-reference-mean'))
    const equal = calculated(sample('negative-gls-weight-equal-reference-mean'))
    close(gls.referenceWeights, [1.5, -0.5, 0])
    close(equal.referenceWeights, [0.5, 0.5, 0])
    expect(gls.referenceShiftVariance).toBeLessThan(equal.referenceShiftVariance)
    expect(equal.datumMeaning).toBe('declared-equal-reference-definition-not-precision-optimality-or-stability')
  })
  it('supports a free-datum covariance with proper-subset GLS, and all-point equal means', () => {
    const gls = calculated(sample('free-datum-proper-subset-gls'))
    const equal = calculated(sample('free-datum-all-equal'))
    expect(gls.covarianceCheck.classification).toBe('semidefinite-or-unresolved-within-numerical-tolerance')
    expect(equal.referenceShiftVariance).toBe(0)
    expect(equal.covarianceCheck.matrixRepair).toBe('none')
    const allGls = sample('free-datum-all-equal')
    allGls.method = 'gls-reference-mean'
    unavailable(allGls, 'reference-covariance-rank-or-conditioning')
  })
})

describe('reference datum invariances and full covariance propagation', () => {
  for (const method of ['gls-reference-mean', 'equal-reference-mean'] as const) {
    it(`common translation changes only datum shift: ${method}`, () => {
      const original = sample(`negative-gls-weight-${method}`)
      const result = calculated(original)
      const shifted = structuredClone(original)
      shifted.secondEpoch.points.forEach(p => { p.coordinate += 1048576 })
      const moved = calculated(shifted)
      close(moved.referenceShift, result.referenceShift + 1048576)
      close(moved.displacements, result.displacements)
      close(moved.displacementCovariance, result.displacementCovariance)
      expect(moved.referencePhysicalStability).toBe('not-evaluated')
    })
    it(`a common offset in both epochs preserves the datum comparison: ${method}`, () => {
      const value = sample(`negative-gls-weight-${method}`)
      const result = calculated(value)
      for (const epoch of [value.firstEpoch, value.secondEpoch]) epoch.points.forEach(p => { p.coordinate += 1048576 })
      const moved = calculated(value)
      close(moved.displacements, result.displacements)
      close(moved.referenceShift, result.referenceShift)
      close(moved.displacementCovariance, result.displacementCovariance)
    })
    it(`covariance scaling preserves weights and scales all covariance blocks: ${method}`, () => {
      const value = sample(`joint-factor-3-${method}`)
      const result = calculated(value)
      for (const scale of [1e-60, 1e60]) {
        const scaled = structuredClone(value)
        for (const epoch of [scaled.firstEpoch, scaled.secondEpoch]) epoch.covariance = epoch.covariance.map(row => row.map(v => v * scale))
        if (scaled.dependence.kind === 'caller-declared-cross-covariance') scaled.dependence.firstToSecondCovariance = scaled.dependence.firstToSecondCovariance.map(row => row.map(v => v * scale))
        const actual = calculated(scaled)
        close(actual.referenceWeights, result.referenceWeights)
        close(actual.displacements, result.displacements)
        close(actual.referenceShiftVariance / scale, result.referenceShiftVariance)
        close(actual.displacementCovariance.map(row => row.map(v => v / scale)), result.displacementCovariance)
        close(actual.shiftDisplacementCovariance.map(v => v / scale), result.shiftDisplacementCovariance)
      }
    })
  }
  it('honors native point mapping including both axes of nonsymmetric cross covariance', () => {
    const value = sample('joint-factor-3-gls-reference-mean')
    const original = calculated(value)
    const n = value.mapping.length
    const p1 = Array.from({ length: n }, (_, i) => n - 1 - i)
    const p2 = Array.from({ length: n }, (_, i) => (i + 1) % n)
    value.firstEpoch.points = p1.map(i => value.firstEpoch.points[i]!)
    value.secondEpoch.points = p2.map(i => value.secondEpoch.points[i]!)
    value.firstEpoch.covariance = p1.map(i => p1.map(j => value.firstEpoch.covariance[i]![j]!))
    value.secondEpoch.covariance = p2.map(i => p2.map(j => value.secondEpoch.covariance[i]![j]!))
    const dependence = value.dependence
    if (dependence.kind !== 'caller-declared-cross-covariance') throw new Error('cross expected')
    dependence.firstToSecondCovariance = p1.map(i => p2.map(j => dependence.firstToSecondCovariance[i]![j]!))
    const reordered = calculated(value)
    close(reordered.displacements, original.displacements)
    close(reordered.displacementCovariance, original.displacementCovariance)
    close(reordered.shiftDisplacementCovariance, original.shiftDisplacementCovariance)
    value.mapping.reverse()
    const reversed = calculated(value)
    close(reversed.displacements, [...original.displacements].reverse())
    close(reversed.displacementCovariance, [...original.displacementCovariance].reverse().map(row => [...row].reverse()))
  })
  it('swapping epochs negates displacements but keeps propagated covariance', () => {
    const value = sample('joint-factor-4-gls-reference-mean')
    const original = calculated(value)
    ;[value.firstEpoch, value.secondEpoch] = [value.secondEpoch, value.firstEpoch]
    const dependence = value.dependence
    if (dependence.kind !== 'caller-declared-cross-covariance') throw new Error('cross expected')
    dependence.firstToSecondCovariance = dependence.firstToSecondCovariance.map((_, i) => dependence.firstToSecondCovariance.map(row => row[i]!))
    const result = calculated(value)
    close(result.referenceShift, -original.referenceShift)
    close(result.displacements, original.displacements.map(v => -v))
    close(result.displacementCovariance, original.displacementCovariance)
    close(result.shiftDisplacementCovariance, original.shiftDisplacementCovariance)
  })
  it('converts m to mm consistently only when caller scales coordinates and full covariance', () => {
    const value = sample('joint-factor-2-gls-reference-mean')
    const original = calculated(value)
    value.unit = 'm'
    for (const epoch of [value.firstEpoch, value.secondEpoch]) {
      epoch.points.forEach(p => { p.coordinate /= 1000 })
      epoch.covariance = epoch.covariance.map(row => row.map(v => v / 1e6))
    }
    if (value.dependence.kind === 'caller-declared-cross-covariance') value.dependence.firstToSecondCovariance = value.dependence.firstToSecondCovariance.map(row => row.map(v => v / 1e6))
    const result = calculated(value)
    expect(result.squaredUnit).toBe('m2')
    close(result.displacements.map(v => v * 1000), original.displacements)
    close(result.displacementCovariance.map(row => row.map(v => v * 1e6)), original.displacementCovariance)
  })
  it('preserves exact input bytes and reports all declarations unverified', () => {
    const value = sample()
    const before = JSON.stringify(value)
    const result = calculated(value)
    expect(JSON.stringify(value)).toBe(before)
    expect(result).toMatchObject({ sourceRecordsVerified: false, epochDependenceVerified: false, referencePhysicalStability: 'not-evaluated', engineeringDecision: 'not-evaluated', observationAction: 'none', formalCoordinatesModified: false, significanceTesting: 'not-performed' })
  })
})

describe('covariance domain, rank and explicit numerical boundaries', () => {
  it('rejects invalid full joint covariance even when the difference covariance is positive definite', () => {
    const value = sample()
    value.dependence = { kind: 'caller-declared-cross-covariance', sourceAnchor: 'impossible-joint', firstToSecondCovariance: [[-2, 0, 0], [0, -2, 0], [0, 0, -2]] }
    unavailable(value, 'covariance-not-positive-semidefinite')
  })
  it('detects a joint negative eigenvalue even with individually bounded pairwise correlations', () => {
    const value = sample()
    value.firstEpoch.covariance = [[1, -0.75, -0.75], [-0.75, 1, -0.75], [-0.75, -0.75, 1]]
    unavailable(value, 'covariance-not-positive-semidefinite')
  })
  it('does not silently symmetrize or clip a negative variance', () => {
    const asym = sample()
    asym.firstEpoch.covariance[0]![1] = 1e-15
    unavailable(asym, 'covariance-not-symmetric')
    const negative = sample()
    negative.firstEpoch.covariance[0]![0] = -1e-20
    unavailable(negative, 'covariance-not-positive-semidefinite')
    const zero = sample()
    zero.firstEpoch.covariance[0]![0] = 0
    zero.firstEpoch.covariance[0]![1] = zero.firstEpoch.covariance[1]![0] = 1e-20
    unavailable(zero, 'covariance-not-positive-semidefinite')
  })
  it('refuses a negative difference variance at the semidefinite numerical boundary', () => {
    const value = sample()
    value.dependence = { kind: 'caller-declared-cross-covariance', sourceAnchor: 'near-impossible-joint', firstToSecondCovariance: [[1 + 1e-12, 0, 0], [0, 1 + 1e-12, 0], [0, 0, 1 + 1e-12]] }
    unavailable(value, 'numeric-range-or-resolution')
  })
  it('records a numerically ambiguous boundary without claiming a PSD proof or repairing the matrix', () => {
    const value = sample('free-datum-all-equal')
    value.firstEpoch.covariance[0]![0] -= 1e-12
    const result = compareSurveyReferenceDatumV1(value)
    if (result.outcome === 'calculated') {
      expect(result.covarianceCheck.classification).toBe('semidefinite-or-unresolved-within-numerical-tolerance')
      expect(result.covarianceCheck.matrixRepair).toBe('none')
      expect(result.covarianceCheck.minimumCorrelationEigenvalueEstimate).toBeLessThan(0)
      expect(result.request.firstEpoch.covariance).toEqual(value.firstEpoch.covariance)
    } else expect(result).toMatchObject({ outcome: 'unavailable', code: 'numeric-range-or-resolution' })
  })
  for (const variance of [1e-101, 1e101]) it(`refuses variance scale ${variance}`, () => {
    const value = sample()
    for (const epoch of [value.firstEpoch, value.secondEpoch]) epoch.covariance = epoch.covariance.map(row => row.map(v => v * variance))
    unavailable(value, 'covariance-scale-outside-supported-domain')
  })
  it('rejects extreme relative variance span and nearly singular GLS without fallback', () => {
    const ratio = sample()
    ratio.firstEpoch.covariance[0]![0] = 1e-13
    unavailable(ratio, 'covariance-scale-outside-supported-domain')
    const singular = sample()
    for (const epoch of [singular.firstEpoch, singular.secondEpoch]) epoch.covariance = epoch.covariance.map((row, i) => row.map((_, j) => i === j ? 1 : 1 - 1e-11))
    unavailable(singular, 'reference-covariance-rank-or-conditioning')
    singular.method = 'equal-reference-mean'
    expect(compareSurveyReferenceDatumV1(singular).outcome).toBe('calculated')
  })
  it('rejects subnormal coordinates instead of silently underflowing the datum shift', () => {
    const value = sample()
    value.secondEpoch.points[0]!.coordinate = Number.MIN_VALUE
    unavailable(value, 'numeric-range-or-resolution')
  })
  it('supports the maximum 32 points and records a 64-dimensional joint check', () => {
    const value = sample()
    const n = 32
    for (const [epoch, shift] of [[value.firstEpoch, 0], [value.secondEpoch, 1]] as const) {
      epoch.points = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, coordinate: i + shift }))
      epoch.covariance = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0))
    }
    value.mapping = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, firstPointId: `p${i}`, secondPointId: `p${i}` }))
    value.referenceIds = value.mapping.map(p => p.id)
    const result = calculated(value)
    expect(result.covarianceCheck.dimension).toBe(64)
    close(result.referenceShift, 1)
    close(result.displacements, Array.from({ length: n }, () => 0))
    close(result.displacementCovariance, Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 2 : 0) - 2 / n)))
  })
  it('supports exact zero covariance only for an explicitly selected equal datum', () => {
    const value = sample()
    for (const epoch of [value.firstEpoch, value.secondEpoch]) epoch.covariance = epoch.covariance.map(row => row.map(() => 0))
    unavailable(value, 'reference-covariance-rank-or-conditioning')
    value.method = 'equal-reference-mean'
    const result = calculated(value)
    expect(result.referenceShiftVariance).toBe(0)
    expect(result.displacementCovariance.flat().every(v => v === 0)).toBe(true)
    expect(result.covarianceCheck.activeDimension).toBe(0)
  })
})

describe('strict reference datum contract', () => {
  it('rejects missing dependence, insufficient references, cofactor labels and identity errors', () => {
    const variations: Record<string, unknown>[] = []
    const missing = sample() as unknown as Record<string, unknown>
    delete missing.dependence
    variations.push(missing)
    variations.push({ ...sample(), referenceIds: ['p0'] }, { ...sample(), referenceIds: ['p0', 'p0'] }, { ...sample(), referenceIds: ['p0', 'unknown'] })
    variations.push({ ...sample(), method: 'automatically-select-stable-points' }, { ...sample(), testingStrategy: 'approved-at-alpha-0.05' })
    const cofactor = sample() as unknown as { firstEpoch: Record<string, unknown> }
    cofactor.firstEpoch.covarianceBasis = 'relative-weight-cofactor'
    variations.push(cofactor)
    const duplicate = sample()
    duplicate.mapping[0]!.firstPointId = duplicate.mapping[1]!.firstPointId
    variations.push(duplicate)
    const duplicateEpoch = sample()
    duplicateEpoch.secondEpoch.id = duplicateEpoch.firstEpoch.id
    variations.push(duplicateEpoch)
    for (const value of variations) expect(compareSurveyReferenceDatumV1(value).outcome).toBe('invalid-input')
  })
  it('rejects malformed dimensions, unknown keys and nonfinite coordinates/covariance', () => {
    const values = [sample(), sample(), sample(), sample()]
    values[0]!.firstEpoch.covariance[0]!.pop()
    values[1]!.firstEpoch.points[0]!.coordinate = Infinity
    values[2]!.secondEpoch.covariance[0]![0] = NaN
    values[3]!.mapping.pop()
    for (const value of values) expect(compareSurveyReferenceDatumV1(value).outcome).toBe('invalid-input')
    expect(compareSurveyReferenceDatumV1({ ...sample(), autoApprove: true }).outcome).toBe('invalid-input')
  })
  it('rejects output identity, method substitution, covariance asymmetry and invented approval', () => {
    const result = calculated(sample())
    expect(SurveyReferenceDatumOutputV1.safeParse({ ...result, engineeringDecision: 'accepted' }).success).toBe(false)
    expect(SurveyReferenceDatumOutputV1.safeParse({ ...result, pointIds: ['wrong', 'p1', 'p2'] }).success).toBe(false)
    const asym = structuredClone(result)
    asym.displacementCovariance[0]![1] += 1
    expect(SurveyReferenceDatumOutputV1.safeParse(asym).success).toBe(false)
    expect(SurveyReferenceDatumOutputV1.safeParse({ ...result, datumMeaning: 'declared-equal-reference-definition-not-precision-optimality-or-stability' }).success).toBe(false)
    const transform = structuredClone(result)
    transform.transformation[0]![0] = 1
    expect(SurveyReferenceDatumOutputV1.safeParse(transform).success).toBe(false)
  })
})
