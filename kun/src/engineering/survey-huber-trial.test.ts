import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SurveyHuberTrialInputV1, SurveyHuberTrialOutputV1 } from '../contracts/survey-huber-trial.js'
import { runSurveyHuberTrial } from './survey-huber-trial.js'

type ExactCase = { id: string; input: { A: number[][]; y: (number | string)[]; sigma?: number[]; scale?: number; k?: string }; candidateMinima: { parameters: string[]; objective: string }[]; multipleExactMinimizersFound: boolean }
const cases = JSON.parse(readFileSync(new URL('../../../docs/qa/evidence/railwise-huber-trial/huber-exact-cases.json', import.meta.url), 'utf8')) as ExactCase[]
const fraction = (value: string) => { const [a, b = '1'] = value.split('/'); return Number(a) / Number(b) }
const close = (actual: number, expected: number, tolerance = 1e-8) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(expected)))
function input(example = cases[0]!): SurveyHuberTrialInputV1 {
  const model = example.input, p = model.A[0]!.length
  return { schemaVersion: 1, model: 'fixed-linear-full-column-rank', independenceDeclaration: 'caller-declared-independent-observations',
    residualConvention: 'observed-minus-fitted', observationUnit: 'm', parameterIds: Array.from({ length: p }, (_, j) => `x${j}`),
    parameterUnits: Array<string>(p).fill('m'), initialParameters: Array<number>(p).fill(0),
    scale: { kind: 'fixed-external', value: model.scale ?? 1, unit: 'm', basisStatement: 'Synthetic exact-rational case; external scale explicitly fixed for this test.' },
    loss: { kind: 'huber', k: Number(model.k ?? 1) }, observations: model.y.map((y, i) => ({ id: `y${i}`, value: Number(y), coefficients: model.A[i]!, relativeSigma: model.sigma?.[i] ?? 1, sourceAnchor: `${example.id} row ${i}` })),
    stopping: { maxIterations: 200, standardizedPredictionStepTolerance: 1e-10, relativeObjectiveTolerance: 1e-10, normalizedScoreTolerance: 1e-10 } }
}
function stationary(request: unknown) {
  const result = runSurveyHuberTrial(request)
  expect(result.outcome, result.reason).toBe('stationary')
  expect(SurveyHuberTrialOutputV1.safeParse(result).success).toBe(true)
  return result
}

describe('fixed external scale independent Huber read-only trial', () => {
  it.each(cases)('matches an independent exact piecewise KKT oracle: $id', example => {
    const result = stationary(input(example)), last = result.states.at(-1)!
    close(last.objective, fraction(example.candidateMinima[0]!.objective), 1e-11)
    if (!example.multipleExactMinimizersFound) example.candidateMinima[0]!.parameters.forEach((value, j) => close(result.acceptedParameters![j]!, fraction(value)))
    else expect(result.uniquenessAssessment).toBe('not-established')
    expect(last.normalizedScoreInfinity + last.scoreRoundoffEstimate).toBeLessThanOrEqual(1e-10)
    expect(result.uniqueMinimizerCertified).toBe(false)
  })
  it.each([-1000, -10, 0, 1, 5, 10, 1000])('reaches the same unique minimum from x=%s', start => {
    const request = input(); request.initialParameters = [start]
    close(stationary(request).acceptedParameters![0]!, 1 / 3)
  })
  it.each([-100, 0, 1, 5, 9, 10, 100])('does not label the flat minimizer interval unique from x=%s', start => {
    const request = input(cases[1]); request.initialParameters = [start]
    const result = stationary(request)
    expect(result.uniquenessAssessment).toBe('not-established')
    expect(result.acceptedParameters![0]!).toBeGreaterThanOrEqual(1 - 1e-8)
    expect(result.acceptedParameters![0]!).toBeLessThanOrEqual(9 + 1e-8)
    if (start === 5) expect(result.reason).toBe('initial-score')
  })
  it('preserves inputs, hashes the parsed request, and reports trial weights without covariance or engineering decisions', () => {
    const request = input(), before = JSON.stringify(request), result = stationary(request)
    expect(JSON.stringify(request)).toBe(before)
    expect(result.requestHash).toBe(createHash('sha256').update(before).digest('hex'))
    expect(result).toMatchObject({ assumptionsVerified: false, scaleVerified: false, formalWeightsModified: false,
      observationAction: 'none', parameterCovariance: null, gaussianWlsPrecision: 'not-provided', engineeringDecision: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' })
    for (const state of result.states) state.residuals.forEach((residual, i) => {
      close(residual, request.observations[i]!.value - state.fittedObservations[i]!)
      close(state.derivedIrlsWeights[i]!, state.robustMultipliers[i]! / (request.scale.value * request.observations[i]!.relativeSigma) ** 2)
    })
  })
  it.each([1e-12, 1e-6, 1000, 1e12])('preserves the objective and scaled parameters under coherent length scale %s', scale => {
    const request = input(cases[4]), baseline = stationary(request)
    request.scale.value *= scale; request.observationUnit = 'mm'; request.scale.unit = 'mm'; request.parameterUnits = ['mm', 'mm']
    request.observations.forEach(row => { row.value *= scale })
    const result = stationary(request)
    result.acceptedParameters!.forEach((value, j) => close(value / scale, baseline.acceptedParameters![j]!))
    close(result.states.at(-1)!.objective, baseline.states.at(-1)!.objective)
  })
  it.each([1e-100, 1e-20, -1, 1e20, 1e100])('preserves fitted observations across parameter re-expression %s', scale => {
    const request = input(cases[4]), baseline = stationary(request)
    request.observations.forEach(row => { row.coefficients = [row.coefficients[1]! * scale, row.coefficients[0]! / scale] })
    request.parameterIds.reverse(); request.parameterUnits = ['m/scaled', 'm*scaled']
    const result = stationary(request)
    close(result.acceptedParameters![0]! * scale, baseline.acceptedParameters![1]!)
    close(result.acceptedParameters![1]! / scale, baseline.acceptedParameters![0]!)
  })
  it('preserves row ordering, signed row units and nonuniform positive row scaling', () => {
    const request = input(cases[4]), baseline = stationary(request), factors = [1, -2, .5, 3, -4, 10]
    request.observations.forEach((row, i) => { row.value *= factors[i]!; row.coefficients = row.coefficients.map(v => v * factors[i]!); row.relativeSigma *= Math.abs(factors[i]!) })
    request.observations.reverse()
    const result = stationary(request)
    result.acceptedParameters!.forEach((value, j) => close(value, baseline.acceptedParameters![j]!))
    close(result.states.at(-1)!.objective, baseline.states.at(-1)!.objective)
  })
  it('shows that residual Huber fitting does not neutralize high leverage', () => {
    const result = stationary(input(cases[8]))
    close(result.acceptedParameters![0]!, 5000 / 5001)
    expect(result.acceptedParameters![0]!).toBeGreaterThan(.99)
  })
  it('requires score and step even when a constant giant loss masks the objective change', () => {
    const request = input(); request.observations = request.observations.slice(0, 3)
    request.observations[1]!.value = 2; request.observations[2]!.value = 1e150; request.observations[2]!.coefficients = [0]
    const result = stationary(request)
    expect(result.states.length).toBeGreaterThan(10)
    close(result.acceptedParameters![0]!, 1)
  })
  it('reports iteration exhaustion without an accepted result or uniqueness claim', () => {
    const request = input(); request.stopping.maxIterations = 1
    const result = runSurveyHuberTrial(request)
    expect(result).toMatchObject({ outcome: 'iteration-limit', reason: 'max-iterations', acceptedParameters: null, uniquenessAssessment: 'not-evaluated' })
    expect(result.states).toHaveLength(2)
  })
  it.each(['zero-column', 'duplicate-column', 'near-collinear'])('rejects %s before accepting parameters', mode => {
    const request = input(cases[4])
    request.observations.forEach((row, i) => { row.coefficients = mode === 'zero-column' ? [1, 0] : [1, 1 + (mode === 'near-collinear' ? i * 1e-9 : 0)] })
    expect(runSurveyHuberTrial(request)).toMatchObject({ outcome: 'rank-or-conditioning', reason: 'input-design', acceptedParameters: null })
  })
  it('rejects positive quadratic loss that underflows instead of reporting perfect fit', () => {
    const request = input(); request.observations = request.observations.slice(0, 2); request.observations[1]!.value = 1e-150
    request.scale.value = 1e12; request.observations.forEach(row => { row.relativeSigma = 1e8 })
    expect(runSurveyHuberTrial(request)).toMatchObject({ outcome: 'numerical-boundary', reason: 'arithmetic-range', acceptedParameters: null })
  })
  it('rejects a nonzero residual erased by standardization underflow', () => {
    const request = input(); request.observations[0]!.value = Number.MIN_VALUE; request.scale.value = 1e12
    expect(runSurveyHuberTrial(request)).toMatchObject({ outcome: 'numerical-boundary', reason: 'arithmetic-range', acceptedParameters: null })
  })
  it('rejects a nonzero model product erased by multiplication underflow', () => {
    const request = input(); request.observations.forEach(row => { row.coefficients = [1e-200]; row.value = 0 }); request.initialParameters = [1e-150]
    expect(runSurveyHuberTrial(request)).toMatchObject({ outcome: 'numerical-boundary', reason: 'arithmetic-range', acceptedParameters: null })
  })
  it('rejects overflow in products without emitting NaN or infinity', () => {
    const request = input(); request.observations.forEach(row => { row.coefficients = [1e150]; row.value = 1e150 }); request.initialParameters = [1e150]; request.scale.value = 1e-12
    const result = runSurveyHuberTrial(request)
    expect(result).toMatchObject({ outcome: 'numerical-boundary', acceptedParameters: null })
    expect(SurveyHuberTrialOutputV1.safeParse(result).success).toBe(true)
  })
  it('does not certify unresolved cancellation at a huge origin', () => {
    const request = input(); request.observations.forEach(row => { row.value += 1e16 }); request.initialParameters = [1e16]
    const result = runSurveyHuberTrial(request)
    expect(['numerical-boundary', 'iteration-limit']).toContain(result.outcome); expect(result.acceptedParameters).toBeNull()
  })
  it.each(['unknown-field', 'correlation', 'unit', 'dimensions', 'duplicate-id', 'non-finite', 'empty-source', 'bad-unicode', 'scale', 'k', 'redundancy', 'iteration'])('rejects invalid declaration: %s', mode => {
    const request = input(), raw = request as unknown as Record<string, unknown>
    if (mode === 'unknown-field') raw.foo = true
    if (mode === 'correlation') raw.covariance = [[1]]
    if (mode === 'unit') request.scale.unit = 'mm'
    if (mode === 'dimensions') request.observations[0]!.coefficients = [1, 2]
    if (mode === 'duplicate-id') request.observations[1]!.id = request.observations[0]!.id
    if (mode === 'non-finite') request.observations[0]!.value = NaN
    if (mode === 'empty-source') request.observations[0]!.sourceAnchor = ' '
    if (mode === 'bad-unicode') request.parameterIds[0] = '\ud800'
    if (mode === 'scale') request.scale.value = 0
    if (mode === 'k') request.loss.k = 0
    if (mode === 'redundancy') request.observations = request.observations.slice(0, 1)
    if (mode === 'iteration') request.stopping.maxIterations = 201
    expect(runSurveyHuberTrial(request)).toMatchObject({ outcome: 'invalid-input', request: null, requestHash: null, states: [], acceptedParameters: null })
  })
  it('rejects a forged stationary score that exceeds tolerance after its numerical budget', () => {
    const result = stationary(input()), last = result.states.at(-1)!, tolerance = result.request!.stopping.normalizedScoreTolerance
    last.normalizedScore = [.99 * tolerance]; last.normalizedScoreInfinity = .99 * tolerance; last.scoreRoundoffEstimate = .1 * tolerance
    expect(SurveyHuberTrialOutputV1.safeParse(result).success).toBe(false)
  })
})
