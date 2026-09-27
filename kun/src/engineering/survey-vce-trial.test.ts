import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SurveyVceTrialInputV1, SurveyVceTrialOutputV1, type SurveyVceTrialInputV1 as Input } from '../contracts/survey-vce-trial.js'
import { runSurveyVceTrial } from './survey-vce-trial.js'

const oracle = JSON.parse(readFileSync(new URL('../../../docs/qa/evidence/railwise-vce-trial/oracle.json', import.meta.url), 'utf8')) as {
  fixtures: Array<{ id: string; a: number[][]; y: number[]; groups: number[]; initial: number[]; q?: number[]; expected: {
    status: string; components?: number[]; parameters?: number[]; residuals?: number[];
    trace: Array<{ current: number[]; candidate: number[]; relativeChange: number }>
  } }>
}
function fixture(id = 'paper-positive'): Input {
  const f = oracle.fixtures.find(f => f.id === id)!
  return {
    schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm',
    parameterIds: f.a[0]!.map((_, i) => `x${i}`),
    groups: f.initial.map((v, i) => ({ id: `g${i}`, initialVariance: v, sourceAnchor: 'synthetic-or-published-oracle' })),
    observations: f.y.map((v, i) => ({ id: `o${i}`, value: v, coefficients: [...f.a[i]!], groupId: `g${f.groups[i]}`, relativeVariance: f.q?.[i] ?? 1, sourceAnchor: 'oracle.json' })),
    maxIterations: 100, relativeTolerance: 1e-10
  }
}
function close(actual: number[], expected: number[], digits = 9): void {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, digits))
}
describe('restricted disjoint linear VCE trial', () => {
  it.each(oracle.fixtures.map(f => f.id))('agrees with independent condition-space SVD oracle: %s', id => {
    const expected = oracle.fixtures.find(f => f.id === id)!.expected
    const output = runSurveyVceTrial(fixture(id))
    expect(output.outcome).toBe(expected.status === 'unidentifiable' ? 'stochastic-rank-or-conditioning' : expected.status)
    expect(output.iterations).toHaveLength(expected.trace.length)
    output.iterations.forEach((row, i) => {
      close(row.currentVariances, expected.trace[i]!.current)
      close(row.candidateVariances, expected.trace[i]!.candidate)
      row.normal.forEach((r, j) => expect(r.reduce((s, v, g) => s + v * row.candidateVariances[g]!, 0)).toBeCloseTo(row.rightHandSide[j]!, 9))
    })
    if (expected.components) {
      close(output.convergedVariances!, expected.components)
      close(output.finalFit!.parameters, expected.parameters!)
      close(output.finalFit!.residuals, expected.residuals!)
    }
    expect(SurveyVceTrialOutputV1.safeParse(output).success).toBe(true)
    expect(output.formalWeightsModified).toBe(false)
    expect(output.componentCovariance).toBeNull()
  })
  it('reproduces exact paper negative components and stops without clamping', () => {
    const out = runSurveyVceTrial(fixture('paper-negative'))
    close(out.iterations[0]!.candidateVariances, [-37/25, 42/5], 12)
    expect(out.iterations).toHaveLength(1)
    expect(out.convergedVariances).toBeNull()
    expect(out.finalFit).toBeNull()
  })
  it('matches published rounded first and converged estimates', () => {
    const out = runSurveyVceTrial(fixture())
    close(out.iterations[0]!.candidateVariances, [.198,5.463], 3)
    close(out.convergedVariances!, [.235,5.184], 3)
  })
  it('one group reduces to SSE / functional degrees of freedom', () => {
    const out = runSurveyVceTrial(fixture('one-group'))
    close(out.convergedVariances!, [10/3], 12)
  })
  it('preserves outputs under row and group permutations', () => {
    const f = fixture(); const baseline = runSurveyVceTrial(f)
    f.observations.reverse(); f.groups.reverse()
    const out = runSurveyVceTrial(f)
    close(out.convergedVariances!, [...baseline.convergedVariances!].reverse())
    close(out.finalFit!.residuals, [...baseline.finalFit!.residuals].reverse())
  })
  it('preserves supported variance units m versus mm', () => {
    const f = fixture(); const baseline = runSurveyVceTrial(f)
    f.unit = 'm'
    f.observations.forEach(o => { o.value /= 1000 })
    f.groups.forEach(g => { g.initialVariance /= 1e6 })
    const out = runSurveyVceTrial(f)
    expect(out.outcome).toBe('converged')
    close(out.convergedVariances!.map(v => v * 1e6), baseline.convergedVariances!)
    close(out.finalFit!.parameters.map(v => v * 1000), baseline.finalFit!.parameters)
  })
  it('is invariant to common initial variance scale and fitted datum shift', () => {
    const f = fixture(); const baseline = runSurveyVceTrial(f)
    f.groups.forEach(g => { g.initialVariance *= 1e6 })
    f.observations.forEach(o => { o.value += 10000 })
    const out = runSurveyVceTrial(f)
    close(out.convergedVariances!, baseline.convergedVariances!, 7)
    close(out.finalFit!.parameters.map(v => v - 10000), baseline.finalFit!.parameters, 8)
  })
  it('column rescaling and permutation preserve identifiable multi-parameter trial', () => {
    const f = fixture('one-group')
    f.parameterIds = ['x','y']
    f.observations = [1,2,4,5,2,3,5,6].map((v,i) => ({ id:`o${i}`, value:v, coefficients:i<4?[1,0]:[0,1], groupId:'g0',relativeVariance:1,sourceAnchor:'synthetic' }))
    const baseline = runSurveyVceTrial(f)
    f.parameterIds.reverse()
    f.observations.forEach(o => { o.coefficients = [o.coefficients[1]! * 1e6, o.coefficients[0]! / 1e6] })
    const out = runSurveyVceTrial(f)
    close(out.convergedVariances!, baseline.convergedVariances!)
    close([out.finalFit!.parameters[1]! / 1e6, out.finalFit!.parameters[0]! * 1e6], baseline.finalFit!.parameters)
  })
  it('rejects a variance signal below datum resolution', () => {
    const f = fixture()
    f.observations.forEach(o => { o.value = 1e6 + o.value * 1e-10 - 1e-9 })
    expect(runSurveyVceTrial(f).outcome).toBe('numerical-boundary')
  })
  it('keeps final fit consistent with the converged covariance, including unequal q', () => {
    const f = fixture('three-positive-groups')
    const out = runSurveyVceTrial(f)
    expect(out.outcome).toBe('converged')
    const score = f.parameterIds.map(() => 0)
    f.observations.forEach((o, i) => {
      const g = f.groups.findIndex(g => g.id === o.groupId)
      const residual = o.value - o.coefficients.reduce((s, c, j) => s + c * out.finalFit!.parameters[j]!, 0)
      expect(out.finalFit!.residuals[i]).toBeCloseTo(residual, 10)
      o.coefficients.forEach((c, j) => { score[j]! += c * residual / (out.convergedVariances![g]! * o.relativeVariance) })
    })
    close(score, score.map(() => 0), 10)
  })
  it('rejects undeclared overlapping membership rather than inferring groups', () => {
    const f = fixture()
    Object.assign(f.observations[0]!, { groupIds: ['g0', 'g1'] })
    expect(runSurveyVceTrial(f).outcome).toBe('invalid-input')
  })
  it('records iteration exhaustion without a converged result', () => {
    const f=fixture(); f.maxIterations=1
    const out=runSurveyVceTrial(f)
    expect(out.outcome).toBe('iteration-limit')
    expect(out.iterations).toHaveLength(1)
    expect(out.convergedVariances).toBeNull()
  })
  it.each([1e-160, 1e-200, Number.MIN_VALUE])('reports residual-energy underflow as numeric failure, not zero variance: %s', scale => {
    const f = fixture('one-group')
    f.observations = f.observations.slice(0, 2)
    f.observations[0]!.value = -scale
    f.observations[1]!.value = scale
    const out = runSurveyVceTrial(f)
    expect(out.outcome).toBe('numerical-boundary')
    expect(out.iterations).toHaveLength(0)
    expect(out.convergedVariances).toBeNull()
  })
  it('rejects exact zero variance boundary', () => {
    const f=fixture('one-group'); f.observations.forEach(o => {o.value=2})
    expect(runSurveyVceTrial(f).outcome).toBe('nonpositive-component')
  })
  it('rejects deficient, near-deficient and zero-column functional designs', () => {
    for (const epsilon of [0, 1e-8]) {
      const f=fixture(); f.parameterIds=['x','y']; f.observations.forEach((o,i)=>{o.coefficients=[1,1+epsilon*i]})
      expect(runSurveyVceTrial(f).outcome).toBe('functional-rank-or-conditioning')
    }
    const f=fixture(); f.observations.forEach(o=>{o.coefficients=[0]})
    expect(runSurveyVceTrial(f).outcome).toBe('functional-rank-or-conditioning')
  })
  it.each([2, 3])('rejects an invisible group despite relative-variance amplification: %s tail rows', tail => {
    const f = fixture()
    f.parameterIds = ['x', 'y']
    f.groups[0]!.initialVariance = 1e-6
    f.groups[1]!.initialVariance = 1e6
    f.observations = Array.from({ length: tail + 1 }, (_, i) => ({
      id: `o${i}`, value: i === 0 ? 0 : 2 ** i - 1, coefficients: i === 0 ? [1,1] : [.01,0],
      groupId: i === 0 ? 'g0' : 'g1', relativeVariance: i === 0 ? 1e6 : 1e-6, sourceAnchor: 'exact invisible-group review counterexample'
    }))
    const out = runSurveyVceTrial(f)
    expect(out.outcome).toBe('stochastic-rank-or-conditioning')
    expect(out.iterations).toHaveLength(0)
  })
  it('rejects excessive covariance ratio without iterating', () => {
    const f=fixture(); f.groups[1]!.initialVariance=1e12
    const out=runSurveyVceTrial(f)
    expect(out.outcome).toBe('numerical-boundary'); expect(out.iterations).toHaveLength(0)
  })
  it.each(['duplicate-observation','duplicate-group','duplicate-parameter','empty-group','unknown-group','wrong-row','zero-q','negative-initial','nan','extra','no-redundancy'])('rejects malformed input: %s', kind => {
    const f=fixture()
    if(kind==='duplicate-observation')f.observations[1]!.id=f.observations[0]!.id
    if(kind==='duplicate-group')f.groups[1]!.id=f.groups[0]!.id
    if(kind==='duplicate-parameter')f.parameterIds.push(f.parameterIds[0]!)
    if(kind==='empty-group')f.groups.push({id:'g2',initialVariance:1,sourceAnchor:'test'})
    if(kind==='unknown-group')f.observations[0]!.groupId='unknown'
    if(kind==='wrong-row')f.observations[0]!.coefficients.push(1)
    if(kind==='zero-q')f.observations[0]!.relativeVariance=0
    if(kind==='negative-initial')f.groups[0]!.initialVariance=-1
    if(kind==='nan')f.observations[0]!.value=NaN
    if(kind==='extra')Object.assign(f,{Q0:[[1]]})
    if(kind==='no-redundancy')f.parameterIds=['a','b','c','d']
    expect(SurveyVceTrialInputV1.safeParse(f).success).toBe(false)
    expect(runSurveyVceTrial(f).outcome).toBe('invalid-input')
  })
  it.each(['false-convergence', 'failed-with-result', 'wrong-dimensions', 'broken-continuity', 'wrong-unit', 'false-boundary', 'false-change', 'false-convergence-policy'])('rejects inconsistent output records: %s', kind => {
    const out = runSurveyVceTrial(fixture())
    if (kind === 'false-convergence') out.convergedVariances![0]! += 1
    if (kind === 'failed-with-result') out.outcome = 'iteration-limit'
    if (kind === 'wrong-dimensions') out.iterations[0]!.normal[0]!.pop()
    if (kind === 'broken-continuity') out.iterations[1]!.currentVariances[0]! += 1
    if (kind === 'wrong-unit') out.unit = 'm'
    if (kind === 'false-change') out.iterations[0]!.relativeChange += 1
    if (kind === 'false-convergence-policy') out.convergencePolicy!.relativeTolerance = 1e-12
    if (kind === 'false-boundary') { out.outcome = 'nonpositive-component'; out.convergedVariances = null; out.finalFit = null }
    expect(SurveyVceTrialOutputV1.safeParse(out).success).toBe(false)
  })
  it('does not mutate input or produce aliased input arrays', () => {
    const f=fixture(); const before=structuredClone(f)
    const output=runSurveyVceTrial(f)
    output.parameterIds[0]='changed'; output.iterations[0]!.currentVariances[0]=99
    expect(f).toEqual(before)
  })
})
