import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SurveyGeneralizedWRequestV1, SurveyGeneralizedWResultV1 } from '../contracts/survey-generalized-w.js'
import { diagnoseGeneralizedW } from './survey-generalized-w.js'

type ExactCase = { A: string[][]; y: string[][]; C: string[][]; xhat: string[][]; observedMinusAdjusted: string[][];
  Cvv: string[][]; weightedResidualEnergy: string; residualDegreesOfFreedom: number;
  directions: Record<string, { c: string[][]; numerator: string; denominatorSquared: string; status: 'available' | 'undetectable'; w: string | null }> }
const oracle = JSON.parse(readFileSync(new URL('../../../docs/qa/evidence/railwise-generalized-w/fraction_oracle_output.json', import.meta.url), 'utf8')) as Record<string, unknown>
const fraction = (value: string): number => { const [numerator, denominator = '1'] = value.split('/'); return Number(numerator) / Number(denominator) }
function input(example = oracle.golden as ExactCase): SurveyGeneralizedWRequestV1 {
  return {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
    observationUnit: 'm', observationIds: example.y.map((_, index) => `observation-${index + 1}`),
    parameterIds: example.xhat.map((_, index) => `parameter-${index + 1}`), parameterUnits: example.xhat.map(() => 'm'),
    designMatrix: example.A.map(row => row.map(fraction)), observations: example.y.map(row => fraction(row[0]!)),
    covariance: { kind: 'known-apriori-absolute-observation-covariance', basisStatement: 'Explicit synthetic known covariance for independent numerical verification; no engineering authentication.', matrix: example.C.map(row => row.map(fraction)) },
    family: { id: 'predeclared-diagnostic-family', alpha: 0.05, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
    biasDirections: Object.entries(example.directions).filter(([, direction]) => direction.c.some(row => fraction(row[0]!) !== 0))
      .map(([id, direction]) => ({ id, coefficients: direction.c.map(row => fraction(row[0]!)) }))
  }
}
function resolved(value: unknown) {
  const result = diagnoseGeneralizedW(value)
  expect(result.modelStatus).toBe('resolved')
  if (result.modelStatus !== 'resolved') throw new Error(result.reason)
  return result
}
function close(actual: number, expected: number, tolerance = 1e-11): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(expected)))
}

describe('known absolute covariance generalized w pure diagnostic', () => {
  it('matches x=103/46 and all three signed generalized w values, not marginal z under correlated C', () => {
    const request = input(), before = JSON.stringify(request), result = resolved(request)
    close(result.parameters[0]!, 103 / 46)
    const expected = [-19 / Math.sqrt(115), 49 / Math.sqrt(230), -Math.sqrt(11 / 46)]
    expected.forEach((value, index) => close(result.diagnostics[index]!.generalizedW!, value))
    close(result.aprioriWeightedResidualSum, 517 / 46)
    expect(Math.abs(result.diagnostics[0]!.generalizedW! - result.residuals[0]! / Math.sqrt(result.residualCovariance[0]![0]!))).toBeGreaterThan(0.5)
    expect(Math.abs(result.diagnostics[1]!.generalizedW! - result.residuals[1]! / Math.sqrt(result.residualCovariance[1]![1]!))).toBeGreaterThan(0.17)
    expect(JSON.stringify(request)).toBe(before)
    expect(result).toMatchObject({ assumptionsVerified: false, familyDeclarationVerified: false, observationAction: 'none',
      distributionEvaluation: 'not-performed', multipleComparisonAdjustment: 'not-performed', decision: 'not-evaluated' })
    expect(SurveyGeneralizedWResultV1.parse(result)).toEqual(result)
  })

  const cases = ['golden', 'invarianceBase', 'rowPermutation', 'parameterColumnPermutation', 'negativeControlWrongDirectionPermutation',
    'directionNegation', 'directionPositiveScale7', 'units1000ParameterUnitsChanged', 'units1000ParameterUnitsUnchanged',
    'mixedRowUnitReexpression', 'priorCovarianceScale9', 'directionPlusModelSpace', 'modelSpaceShift']
  it.each(cases)('matches the independent Fraction/70-digit Decimal oracle: %s', name => {
    const entry = oracle[name] as ExactCase | { result: ExactCase }, example = 'result' in entry ? entry.result : entry
    const result = resolved(input(example))
    example.xhat.forEach((row, index) => close(result.parameters[index]!, fraction(row[0]!)))
    example.observedMinusAdjusted.forEach((row, index) => close(result.residuals[index]!, fraction(row[0]!)))
    example.Cvv.forEach((row, i) => row.forEach((value, j) => close(result.residualCovariance[i]![j]!, fraction(value))))
    close(result.aprioriWeightedResidualSum, fraction(example.weightedResidualEnergy))
    expect(result.degreesOfFreedom).toBe(example.residualDegreesOfFreedom)
    for (const direction of result.diagnostics) {
      const expected = example.directions[direction.id]!
      if (expected.status === 'undetectable') {
        expect(direction).toMatchObject({ status: 'not-detectable-or-numerically-unresolved', generalizedW: null })
      } else { expect(direction.status).toBe('resolved'); close(direction.generalizedW!, Number(expected.w)) }
    }
  })

  it.each([1e-150, 1e-20, 1, 1e20, 1e150])('keeps direction scaling %s from changing detectability or w', scale => {
    const request = input(), baseline = resolved(request)
    request.biasDirections = request.biasDirections.map(direction => ({ ...direction, coefficients: direction.coefficients.map(value => value * scale) }))
    const result = resolved(request)
    result.diagnostics.forEach((direction, index) => {
      expect(direction.status).toBe(baseline.diagnostics[index]!.status)
      close(direction.detectabilityRatio, baseline.diagnostics[index]!.detectabilityRatio)
      if (direction.generalizedW !== null) close(direction.generalizedW, baseline.diagnostics[index]!.generalizedW!)
    })
  })

  it.each([1e-100, 1e-12, 1000, 1e100])('preserves diagnostics with coherent unit scaling %s including tiny absolute covariance', scale => {
    const request = input(), baseline = resolved(request)
    request.observationUnit = `scaled-unit-${scale}`
    request.parameterUnits = request.parameterUnits.map(() => request.observationUnit)
    request.observations = request.observations.map(value => value * scale)
    request.covariance.matrix = request.covariance.matrix.map(row => row.map(value => value * scale * scale))
    const result = resolved(request)
    result.parameters.forEach((value, index) => close(value / scale, baseline.parameters[index]!))
    result.residuals.forEach((value, index) => close(value / scale, baseline.residuals[index]!))
    result.residualCovariance.forEach((row, i) => row.forEach((value, j) => close(value / scale / scale, baseline.residualCovariance[i]![j]!)))
    result.diagnostics.forEach((direction, index) => {
      expect(direction.status).toBe(baseline.diagnostics[index]!.status)
      if (direction.generalizedW !== null) close(direction.generalizedW, baseline.diagnostics[index]!.generalizedW!)
    })
  })

  it('keeps parameter column units and order separate from model rank', () => {
    const request = input(oracle.invarianceBase as ExactCase), baseline = resolved(request)
    request.designMatrix = request.designMatrix.map(([a, b]) => [b! * 1e50, a! * 1e-50])
    request.parameterIds.reverse(); request.parameterUnits = ['m/1e50', 'm/1e-50']
    const result = resolved(request)
    close(result.parameters[0]! * 1e50, baseline.parameters[1]!)
    close(result.parameters[1]! * 1e-50, baseline.parameters[0]!)
    close(result.diagnostics[0]!.generalizedW!, baseline.diagnostics[0]!.generalizedW!)
  })

  it('treats directions close to model space as unresolved relatively, without replacing the denominator by epsilon', () => {
    for (const scale of [1e-80, 1, 1e80]) {
      const request = input()
      request.biasDirections = [{ id: 'near-common-mode', coefficients: [1, 1, 1 + 1e-12].map(value => value * scale) },
        { id: 'resolvable-near-common-mode', coefficients: [1, 1, 1 + 1e-3].map(value => value * scale) }]
      const result = resolved(request)
      expect(result.diagnostics[0]).toMatchObject({ status: 'not-detectable-or-numerically-unresolved', generalizedW: null })
      expect(result.diagnostics[1]!.status).toBe('resolved')
    }
  })

  it('preserves observed-minus-adjusted signs when an observation axis is reversed coherently', () => {
    const request = input(), baseline = resolved(request), signs = [-1, 1, 1]
    request.observations = request.observations.map((value, i) => value * signs[i]!)
    request.designMatrix = request.designMatrix.map((row, i) => row.map(value => value * signs[i]!))
    request.covariance.matrix = request.covariance.matrix.map((row, i) => row.map((value, j) => value * signs[i]! * signs[j]!))
    request.biasDirections = request.biasDirections.map(direction => ({ ...direction, coefficients: direction.coefficients.map((value, i) => value * signs[i]!) }))
    const result = resolved(request)
    result.residuals.forEach((value, i) => close(value, baseline.residuals[i]! * signs[i]!))
    result.diagnostics.forEach((direction, i) => { if (direction.generalizedW !== null) close(direction.generalizedW, baseline.diagnostics[i]!.generalizedW!) })
  })

  it('returns zero w under an exactly zero residual model without inventing a posterior variance', () => {
    const request = input(); request.observations = [0, 0, 0]
    const result = resolved(request)
    expect(result.aprioriWeightedResidualSum).toBe(0)
    expect(result.diagnostics.slice(0, 3).map(direction => direction.generalizedW)).toEqual([0, 0, 0])
    expect(result.diagnostics[3]!.generalizedW).toBeNull()
  })

  it.each([
    [[1, 2, 0], [2, 1, 0], [0, 0, 1]],
    [[1, 1, 0], [1, 1, 0], [0, 0, 1]],
    [[1, 0.1, 0], [0, 1, 0], [0, 0, 1]],
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    [[1, 0.9999999999999999, 0], [0.9999999999999999, 1, 0], [0, 0, 1]]
  ].map(covariance => ({ covariance })))('refuses non-SPD/asymmetric or unresolved covariance %#', ({ covariance }) => {
    const request = input(); request.covariance.matrix = covariance
    expect(diagnoseGeneralizedW(request)).toMatchObject({ modelStatus: 'unavailable', reason: 'covariance-not-symmetric-positive-definite-or-numerically-unresolved', diagnostics: [] })
  })

  it('refuses rank loss and insufficient residual degrees of freedom without regularizing', () => {
    const request = input(oracle.invarianceBase as ExactCase)
    for (const gap of [0, 1e-12]) {
      request.designMatrix = [[1, 1], [1, 1], [1, 1], [1, 1 + gap]]
      expect(diagnoseGeneralizedW(request)).toMatchObject({ modelStatus: 'unavailable', reason: 'design-not-full-rank-or-numerically-unresolved', diagnostics: [] })
    }
    const square = input(); square.parameterIds = ['a', 'b', 'c']; square.parameterUnits = ['m', 'm', 'm']; square.designMatrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    expect(diagnoseGeneralizedW(square)).toMatchObject({ modelStatus: 'unavailable', reason: 'insufficient-residual-degrees-of-freedom' })
  })

  it('returns an explicit unavailable result when finite inputs overflow intermediate numeric range', () => {
    const request = input(); request.observations = [Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE]
    const result = diagnoseGeneralizedW(request)
    expect(result).toMatchObject({ modelStatus: 'unavailable', reason: 'numeric-range-or-backward-error' })
    expect(JSON.stringify(result)).not.toContain('Infinity')
  })

  it.each([1e12, 1e14, 1e16])('does not interpret QR rounding under a %s model-space shift as a tiny-prior signal', shift => {
    for (const covarianceScale of [1, 1e-20, 1e-32]) {
      for (const original of [[0, 0, 0], [0, 11, 2]]) {
        const request = input()
        request.observations = original.map(value => value + shift)
        request.covariance.matrix = request.covariance.matrix.map(row => row.map(value => value * covarianceScale))
        const result = diagnoseGeneralizedW(request)
        // The exact all-equal mean has w=0; adding A*shift to the golden case
        // leaves its residuals unchanged. This double range cannot meet the
        // versioned statistic error budget, so neither is given a fake score.
        expect(result).toMatchObject({ modelStatus: 'unavailable', reason: 'numeric-range-or-backward-error', diagnostics: [] })
      }
    }
  })

  it('preserves a resolved model-space shift and exposes the statistical error estimate', () => {
    const request = input(), baseline = resolved(request)
    request.observations = request.observations.map(value => value + 1000)
    const result = resolved(request)
    close(result.parameters[0]!, baseline.parameters[0]! + 1000)
    result.diagnostics.forEach((direction, index) => {
      if (direction.status === 'resolved') {
        close(direction.generalizedW, baseline.diagnostics[index]!.generalizedW!, 1e-10)
        expect(direction.statisticErrorEstimate).toBeLessThanOrEqual(result.relativeStatisticErrorBudget * Math.max(1, direction.absoluteGeneralizedW))
      }
    })
  })

  it('refuses nonzero residual covariance or energy that would underflow to a false zero', () => {
    const tinyCovariance = input(), scale = Number.MIN_VALUE
    tinyCovariance.covariance.matrix = tinyCovariance.covariance.matrix.map(row => row.map(value => value * scale))
    tinyCovariance.observations = tinyCovariance.observations.map(value => value * Math.sqrt(scale))
    expect(diagnoseGeneralizedW(tinyCovariance)).toMatchObject({ modelStatus: 'unavailable', reason: 'numeric-range-or-backward-error' })
    const tinyEnergy = input(); tinyEnergy.observations = tinyEnergy.observations.map(value => value * 1e-200)
    expect(diagnoseGeneralizedW(tinyEnergy)).toMatchObject({ modelStatus: 'unavailable', reason: 'numeric-range-or-backward-error' })
  })

  it('refuses subnormal covariance quantization that can make the reported covariance indefinite', () => {
    // Independently found two-observation mean: exact Cvv = s/2 * [[1,-1],[-1,1]].
    // At s = 3*MIN_VALUE, rounding each Gram product can instead produce an
    // indefinite matrix with entries [s/3,-2*s/3;-2*s/3,2*s/3].
    const request = input(), scale = 3 * Number.MIN_VALUE
    request.observationIds = ['first', 'second']; request.designMatrix = [[1], [1]]
    request.observations = [0, Math.sqrt(scale)]
    request.covariance.matrix = [[scale, 0], [0, scale]]
    request.biasDirections = [{ id: 'first-axis', coefficients: [1, 0] }]
    expect(diagnoseGeneralizedW(request)).toMatchObject({ modelStatus: 'unavailable', reason: 'numeric-range-or-backward-error', diagnostics: [] })
    const tinyEnergy = input(); tinyEnergy.observations = tinyEnergy.observations.map(value => value * 1e-160)
    expect(diagnoseGeneralizedW(tinyEnergy)).toMatchObject({ modelStatus: 'unavailable', reason: 'numeric-range-or-backward-error', diagnostics: [] })
  })

  it('requires complete dimensions, exact IDs, nonzero directions and an explicit absolute prior covariance basis', () => {
    for (const patch of [
      { residualConvention: 'adjusted-minus-observed' }, { purpose: 'approve-deliverable' }, { observations: [0, 11] },
      { observationIds: ['same', 'same', 'other'] }, { parameterUnits: ['m', 'mm'] }, { designMatrix: [[1], [1, 2], [1]] },
      { covariance: { kind: 'posterior-estimated', basisStatement: 'estimated here', matrix: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } },
      { biasDirections: [{ id: 'zero', coefficients: [0, 0, 0] }] }, { biasDirections: [{ id: 'bad', coefficients: [1, 0] }] },
      { observations: [0, NaN, 2] }, { assumptionsVerified: true }, { constraints: { fixParameter: 0 } },
      { family: { id: 'undeclared', alpha: 0, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' } }
    ]) expect(SurveyGeneralizedWRequestV1.safeParse({ ...input(), ...patch }).success).toBe(false)
  })

  it('binds declaration and direction order to the request hash without applying an alpha cutoff', () => {
    const request = input(), first = resolved(request)
    request.family.alpha = 0.001
    const changed = resolved(request)
    expect(changed.requestHash).not.toBe(first.requestHash)
    expect(changed.diagnostics).toEqual(first.diagnostics)
    request.biasDirections.reverse()
    const reordered = resolved(request)
    expect(reordered.requestHash).not.toBe(changed.requestHash)
    expect(reordered.diagnostics).toEqual([...changed.diagnostics].reverse())
    const malformed = { ...first, diagnostics: [...first.diagnostics].reverse() }
    expect(SurveyGeneralizedWResultV1.safeParse(malformed).success).toBe(false)
  })
})
