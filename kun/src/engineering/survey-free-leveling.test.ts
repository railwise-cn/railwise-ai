import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FREE_LEVELING_LIMITS, FREE_LEVELING_VERSION, FreeLevelingError, solveFreeLevelingTrial, type FreeLevelingFailure, type FreeLevelingInput } from './survey-free-leveling.js'

function fixture(translation = 0): FreeLevelingInput {
  return {
    model: 'independent-linear-height-differences', unit: 'm', constraint: 'sum-height-corrections-zero',
    points: ['A', 'B', 'C'].map(id => ({ id, referenceHeight: translation })),
    observations: [['A', 'B', 1], ['B', 'C', 2], ['C', 'A', -2.7]].map(([from, to, value], i) => ({
      id: `edge-${i}`, from: from as string, to: to as string, heightDifference: value as number,
      weight: 1, weightSource: 'analytic P=I', sourceAnchor: `analytic:row-${i + 1}`
    })), aprioriVarianceFactor: 1
  }
}

function reorderedFixture(): FreeLevelingInput {
  const input = fixture()
  return { ...input, points: [input.points[2]!, input.points[0]!, input.points[1]!], observations: [
    input.observations[2]!, { ...input.observations[0]!, from: 'B', to: 'A', heightDifference: -1 }, input.observations[1]!
  ] }
}

function near(actual: number, expected: number, tolerance = 1e-10) {
  expect(Number.isFinite(actual)).toBe(true)
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

function matrixNear(actual: number[][], expected: number[][], tolerance = 1e-10) {
  expect(actual.length).toBe(expected.length)
  actual.forEach((row, i) => {
    expect(row.length).toBe(expected[i]!.length)
    row.forEach((value, j) => near(value, expected[i]![j]!, tolerance))
  })
}

function rejects(input: FreeLevelingInput, reason: FreeLevelingFailure) {
  try {
    solveFreeLevelingTrial(input)
    expect.fail(`Expected ${reason}`)
  } catch (error) {
    expect(error).toBeInstanceOf(FreeLevelingError)
    expect((error as FreeLevelingError).reason).toBe(reason)
  }
}

describe('independent one-dimensional free leveling trial', () => {
  it('FREE-01 solves the analytical datum-deficient triangle with full cofactors', () => {
    const result = solveFreeLevelingTrial(fixture())
    expect(result.algorithmVersion).toBe(FREE_LEVELING_VERSION)
    expect(result.status).toBe('trial-only')
    expect(result.modelAssumptions).toBe('not-verified')
    expect(result.engineeringDecision).toBe('not-evaluated')
    expect([result.rank, result.datumDefect, result.degreesOfFreedom]).toEqual([2, 1, 1])
    result.points.forEach((point, i) => near(point.height, [-37 / 30, -1 / 3, 47 / 30][i]!))
    result.observations.forEach((observation, i) => {
      near(observation.residual, 0.1)
      near(observation.adjustedHeightDifference, [0.9, 1.9, -2.8][i]!)
    })
    matrixNear(result.heightCofactor, [[2, -1, -1], [-1, 2, -1], [-1, -1, 2]].map(row => row.map(v => v / 9)))
    matrixNear(result.residualCofactor, Array.from({ length: 3 }, () => [1 / 3, 1 / 3, 1 / 3]))
    near(result.adjustedHeightDifferenceCofactor[0]![0]!, 2 / 3)
    near(result.weightedSSE, 0.03)
    near(result.posteriorVarianceFactorEstimate, 0.03)
    matrixNear(result.aprioriCovariance!.height, result.heightCofactor)
    expect(result.numerical.reducedNormalConditionInfinity).toBeLessThan(2)
  })

  it('FREE-02 preserves estimable quantities under a common datum translation', () => {
    const base = solveFreeLevelingTrial(fixture()), shifted = solveFreeLevelingTrial(fixture(1234.5))
    shifted.points.forEach((point, i) => near(point.height - base.points[i]!.height, 1234.5))
    shifted.observations.forEach((observation, i) => near(observation.residual, base.observations[i]!.residual))
    matrixNear(shifted.heightCofactor, base.heightCofactor)
    matrixNear(shifted.residualCofactor, base.residualCofactor)
    near(shifted.weightedSSE, base.weightedSSE)
  })

  it('uses all reference heights only to define the zero-sum correction datum', () => {
    const input = fixture()
    const result = solveFreeLevelingTrial({ ...input, points: input.points.map((p, i) => ({ ...p, referenceHeight: [100, 105, 110][i]! })) })
    const base = solveFreeLevelingTrial(fixture(105))
    result.points.forEach((point, i) => near(point.height, base.points[i]!.height))
    near(result.points.reduce((sum, point) => sum + point.correction, 0), 0)
  })

  it('FREE-03 preserves IDs through reordering and reverses the residual covariance signs', () => {
    const result = solveFreeLevelingTrial(reorderedFixture())
    expect(result.pointIds).toEqual(['C', 'A', 'B'])
    result.observations.forEach((observation, i) => near(observation.residual, [0.1, -0.1, 0.1][i]!))
    matrixNear(result.residualCofactor, [[1, -1, 1], [-1, 1, -1], [1, -1, 1]].map(row => row.map(v => v / 3)))
  })

  it('FREE-04 transforms m to mm, including observation weights and full cofactors', () => {
    const input = fixture(12)
    const base = solveFreeLevelingTrial(input)
    const mm = solveFreeLevelingTrial({ ...input, unit: 'mm', points: input.points.map(p => ({ ...p, referenceHeight: p.referenceHeight * 1000 })), observations: input.observations.map(o => ({ ...o, heightDifference: o.heightDifference * 1000, weight: o.weight / 1e6 })) })
    expect(mm.squaredUnit).toBe('mm2')
    mm.points.forEach((point, i) => near(point.height / 1000, base.points[i]!.height))
    mm.observations.forEach((observation, i) => near(observation.residual / 1000, base.observations[i]!.residual))
    matrixNear(mm.heightCofactor.map(row => row.map(value => value / 1e6)), base.heightCofactor)
    matrixNear(mm.residualCofactor.map(row => row.map(value => value / 1e6)), base.residualCofactor)
    near(mm.weightedSSE, base.weightedSSE)
    mm.observations.forEach((o, i) => near(o.residual / Math.sqrt(mm.aprioriCovariance!.residual[i]![i]!), base.observations[i]!.residual / Math.sqrt(base.aprioriCovariance!.residual[i]![i]!)))
  })

  it('uniform weight scaling changes cofactors and posterior scale without moving the solution', () => {
    const input = fixture(), base = solveFreeLevelingTrial(input)
    const changed = solveFreeLevelingTrial({ ...input, observations: input.observations.map(o => ({ ...o, weight: o.weight * 7 })), aprioriVarianceFactor: 7 })
    changed.points.forEach((point, i) => near(point.height, base.points[i]!.height))
    matrixNear(changed.heightCofactor.map(row => row.map(value => value * 7)), base.heightCofactor)
    matrixNear(changed.aprioriCovariance!.height, base.aprioriCovariance!.height)
    near(changed.posteriorVarianceFactorEstimate, base.posteriorVarianceFactorEstimate * 7)
    expect(solveFreeLevelingTrial({ ...input, aprioriVarianceFactor: undefined }).aprioriCovariance).toBeNull()
  })

  it('handles unequal weights against the exact weighted closed-loop residual formula', () => {
    const input = fixture(), weights = [1, 2, 4]
    const result = solveFreeLevelingTrial({ ...input, observations: input.observations.map((o, i) => ({ ...o, weight: weights[i]! })) })
    const q = weights.map(w => 1 / w), total = q.reduce((sum, v) => sum + v, 0)
    result.observations.forEach((o, i) => near(o.residual, 0.3 * q[i]! / total))
    matrixNear(result.residualCofactor, q.map(a => q.map(b => a * b / total)))
  })

  it('FREE-05 rejects isolated points and two internally redundant disconnected components', () => {
    const input = fixture()
    rejects({ ...input, points: [...input.points, { id: 'D', referenceHeight: 0 }] }, 'disconnected-network')
    rejects({ ...input, points: [...input.points, ...input.points.map(p => ({ ...p, id: `${p.id}2` }))], observations: [...input.observations, ...input.observations.map(o => ({ ...o, id: `${o.id}2`, from: `${o.from}2`, to: `${o.to}2` }))] }, 'disconnected-network')
  })

  it('FREE-06 rejects a connected tree for insufficient redundancy', () => {
    const input = fixture()
    rejects({ ...input, observations: input.observations.slice(0, 2) }, 'insufficient-redundancy')
  })

  it.each([0, -1, NaN, Infinity])('FREE-07 rejects invalid weight %s', weight => {
    const input = fixture()
    rejects({ ...input, observations: input.observations.map((o, i) => i === 0 ? { ...o, weight } : o) }, 'invalid-weight')
  })

  it('FREE-07 rejects duplicate IDs, self-loops, missing anchors, invalid points and unsupported models', () => {
    const input = fixture(), first = input.observations[0]!
    rejects({ ...input, points: [input.points[0]!, input.points[0]!, input.points[2]!] }, 'duplicate-point-id')
    rejects({ ...input, observations: [first, first, input.observations[2]!] }, 'duplicate-observation-id')
    for (const [change, reason] of [
      [{ to: 'A' }, 'self-loop'], [{ to: 'missing' }, 'unknown-point'],
      [{ sourceAnchor: '' }, 'missing-provenance'], [{ weightSource: ' ' }, 'missing-provenance'],
      [{ heightDifference: Infinity }, 'invalid-observation']
    ] as const) rejects({ ...input, observations: [{ ...first, ...change }, ...input.observations.slice(1)] }, reason)
    rejects({ ...input, points: [{ id: 'A', referenceHeight: NaN }, ...input.points.slice(1)] }, 'invalid-point')
    rejects({ ...input, model: 'correlated' } as unknown as FreeLevelingInput, 'unsupported-model')
    rejects({ ...input, unit: 'ft' } as unknown as FreeLevelingInput, 'unsupported-unit')
    rejects({ ...input, constraint: 'fix-first-point' } as unknown as FreeLevelingInput, 'unsupported-constraint')
    rejects({ ...input, observationCovariance: [[1]] } as unknown as FreeLevelingInput, 'unsupported-covariance')
    rejects({ ...input, aprioriVarianceFactor: 0 }, 'invalid-apriori-variance')
  })

  it('FREE-08 rejects extreme weight ratios, unresolved coordinates and overflow', () => {
    const input = fixture()
    rejects({ ...input, observations: input.observations.map((o, i) => ({ ...o, weight: i ? 1 : 1e-9 })) }, 'numeric-unresolved')
    rejects(fixture(1e15), 'numeric-unresolved')
    rejects({ ...input, observations: input.observations.map(o => ({ ...o, weight: Number.MIN_VALUE })) }, 'numeric-unresolved')
    rejects({ ...input, observations: input.observations.map(o => ({ ...o, heightDifference: o.heightDifference * 1e308 })) }, 'invalid-observation')
    rejects({ ...input, aprioriVarianceFactor: Number.MIN_VALUE }, 'numeric-unresolved')
  })

  it('FREE-08 rejects a weak connecting edge by actual condition even at the weight-ratio boundary', () => {
    const input = fixture()
    const points = [...input.points, ...input.points.map(p => ({ ...p, id: `${p.id}2` }))]
    const observations = [...input.observations, ...input.observations.map(o => ({ ...o, id: `${o.id}2`, from: `${o.from}2`, to: `${o.to}2` })), { ...input.observations[0]!, id: 'weak-link', from: 'C', to: 'A2', weight: 1e-8 }]
    rejects({ ...input, points, observations }, 'numeric-unresolved')
    try {
      solveFreeLevelingTrial({ ...input, points, observations })
      expect.fail('Expected an unresolved condition failure')
    } catch (error) {
      expect(error).toBeInstanceOf(FreeLevelingError)
      expect((error as FreeLevelingError).diagnostics.criterion).toBe('reduced-normal-infinity-condition')
      expect((error as FreeLevelingError).diagnostics.value).toBeGreaterThan(FREE_LEVELING_LIMITS.maxReducedNormalCondition)
    }
  })

  it('refuses a rounded negative bridge-edge variance instead of emitting a NaN standard deviation', () => {
    const input = fixture()
    const bridge = { ...input.observations[0]!, id: 'bridge', from: 'C', to: 'D', heightDifference: 1 }
    const bridged = { ...input, points: [{ id: 'D', referenceHeight: 0 }, ...input.points], observations: [...input.observations, bridge] }
    rejects(bridged, 'numeric-unresolved')
    try {
      solveFreeLevelingTrial(bridged)
      expect.fail('Expected unresolved bridge variance')
    } catch (error) {
      expect((error as FreeLevelingError).diagnostics).toMatchObject({ criterion: 'residual-variance-range', observationId: 'bridge' })
    }
  })

  it.each([
    { lengthScale: 1e-200, weight: 1e300, expectedSSE: 3e-102 },
    { lengthScale: 1e200, weight: 1e-300, expectedSSE: 3e98 }
  ])('retains a representable positive SSE when unweighted squaring is out of range ($lengthScale)', ({ lengthScale, weight, expectedSSE }) => {
    const input = fixture()
    const result = solveFreeLevelingTrial({ ...input, observations: input.observations.map(o => ({ ...o, heightDifference: o.heightDifference * lengthScale, weight })) })
    expect(result.weightedSSE).toBeGreaterThan(0)
    near(result.weightedSSE / expectedSSE, 1, 1e-12)
    near(result.posteriorVarianceFactorEstimate / expectedSSE, 1, 1e-12)
  })

  it('rejects nonzero residual variance below floating-point range rather than reporting perfect fit', () => {
    const input = fixture()
    rejects({ ...input, observations: input.observations.map(o => ({ ...o, heightDifference: o.heightDifference * 1e-200 })) }, 'numeric-unresolved')
  })

  it('enforces finite work limits and preserves all input/provenance records', () => {
    const input = fixture(), before = structuredClone(input)
    input.points.forEach(Object.freeze); input.observations.forEach(Object.freeze)
    Object.freeze(input.points); Object.freeze(input.observations); Object.freeze(input)
    const result = solveFreeLevelingTrial(input)
    expect(input).toEqual(before)
    expect(result.observations.map(o => o.sourceAnchor)).toEqual(before.observations.map(o => o.sourceAnchor))
    result.points[0]!.height = 99
    expect(input).toEqual(before)
    rejects({ ...input, points: Array.from({ length: FREE_LEVELING_LIMITS.maxPoints + 1 }, (_, i) => ({ id: `${i}`, referenceHeight: 0 })) }, 'invalid-dimension')
    rejects({ ...input, observations: Array.from({ length: FREE_LEVELING_LIMITS.maxObservations + 1 }, () => input.observations[0]!) }, 'invalid-dimension')
  })

  it('allows exactly closed redundant observations without claiming a variance test passed', () => {
    const input = fixture()
    const result = solveFreeLevelingTrial({ ...input, observations: input.observations.map(o => ({ ...o, heightDifference: 0 })) })
    expect(result.weightedSSE).toBe(0)
    expect(result.posteriorVarianceFactorEstimate).toBe(0)
    expect(result.engineeringDecision).toBe('not-evaluated')
    expect(result.aprioriCovariance!.height[0]![0]).toBeGreaterThan(0)
  })

  it('resolves the maximum point count against an analytic ring closure', () => {
    const count = FREE_LEVELING_LIMITS.maxPoints
    const input = fixture()
    const result = solveFreeLevelingTrial({ ...input,
      points: Array.from({ length: count }, (_, i) => ({ id: `P${i}`, referenceHeight: 0 })),
      observations: Array.from({ length: count }, (_, i) => ({ ...input.observations[0]!, id: `E${i}`, from: `P${i}`, to: `P${(i + 1) % count}`, heightDifference: i === count - 1 ? -(count - 1) + 0.064 : 1 }))
    })
    expect([result.rank, result.degreesOfFreedom]).toEqual([63, 1])
    result.observations.forEach(o => near(o.residual, 0.001))
    result.points.forEach((p, i) => near(p.height, (i - (count - 1) / 2) * 0.999))
    near(result.weightedSSE, 64e-6)
    result.residualCofactor.forEach(row => row.forEach(value => near(value, 1 / count)))
  })

  const evidenceRoot = new URL('../../../docs/qa/evidence/railwise-advanced-methods-20260920/', import.meta.url)
  const report = JSON.parse(readFileSync(new URL('gama-benchmark.json', evidenceRoot), 'utf8')) as {
    cases: { id: string; outputProbeSha256: string }[]
  }
  it('requires all six recorded Gama comparisons', () => expect(report.cases).toHaveLength(6))
  for (const saved of report.cases) it(`FREE-09 matches pinned GNU Gama 2.29 ${saved.id}`, () => {
    const bytes = readFileSync(new URL(`gama-outputs/${saved.id}.json`, evidenceRoot))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(saved.outputProbeSha256)
    const gama = JSON.parse(bytes.toString()) as {
      version: string; degreesOfFreedom: number; defect: number; weightedSSE: number
      points: { id: string; heightM: number }[]
      observations: { from: string; to: string; residualObservedMinusAdjustedM: number }[]
      heightCofactorM2: number[][]; residualCofactorM2: number[][]
    }
    expect(gama.version).toBe('2.29')
    const result = solveFreeLevelingTrial(saved.id.includes('translated') ? fixture(1234.5) : saved.id.includes('reordered') ? reorderedFixture() : fixture())
    expect(result.degreesOfFreedom).toBe(gama.degreesOfFreedom)
    expect(result.datumDefect).toBe(gama.defect)
    near(result.weightedSSE, gama.weightedSSE)
    const order = result.points.map(point => gama.points.findIndex(p => p.id === point.id))
    result.points.forEach((point, i) => near(point.height, gama.points[order[i]!]!.heightM))
    matrixNear(result.heightCofactor, order.map(i => order.map(j => gama.heightCofactorM2[i]![j]!)))
    result.observations.forEach((o, i) => {
      expect([o.from, o.to]).toEqual([gama.observations[i]!.from, gama.observations[i]!.to])
      near(o.residual, gama.observations[i]!.residualObservedMinusAdjustedM)
    })
    matrixNear(result.residualCofactor, gama.residualCofactorM2)
  })
})
