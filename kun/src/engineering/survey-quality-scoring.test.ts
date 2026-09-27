import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { QUALITY_CONTROL_TREE, QUALITY_PROFILE_VERSION, QUALITY_STANDARD_DIGEST, SurveyQualityScoringInputV1, SurveyQualityScoringOutputV1 } from '../contracts/survey-quality-scoring.js'
import { scoreSurveyQualityV1 } from './survey-quality-scoring.js'
import * as r from './survey-quality-scoring-rules.js'
import { parseExact, output, type Exact } from './survey-quality-scoring-exact.js'

type Input = SurveyQualityScoringInputV1
type Unit = Extract<Input, { operation: 'unit' }>
const refs = () => ['synthetic-check-record']
const common = () => ({ schemaVersion: 1 as const, standardCode: 'GB/T 24356-2023' as const, sourceDigest: QUALITY_STANDARD_DIGEST,
  productProfileId: 'planar-control-point' as const, productProfileVersion: QUALITY_PROFILE_VERSION, profileWeightTable: 43 as const, profileClassificationTable: 44 as const,
  declaredBasis: 'caller-declared-inspection-records-not-authenticated' as const, evidenceRefs: refs() })
const unitContext = () => ({ ...common(), unitId: 'declared-point', unitType: 'point' as const, inspectionStage: 'detailed-inspection' as const })
function accuracyModel(): Extract<Input, { operation: 'accuracy' }>['model'] {
  return { items: [{ id: 'precision-1', m: '0.3', m0: '1', unit: 'mm', source: 'caller-declared-error-magnitude-not-derived-from-adjustment-residuals', evidenceRefs: refs() }],
    aggregation: { kind: 'arithmetic' }, aCount: 0, aEvidenceRefs: refs() }
}
const defects = () => ({ a: 0, b: 0, c: 0, d: 0, t: '1', classification: 'caller-declared-profile-table-counts-not-automatically-classified' as const, evidenceRefs: refs() })
function unitInput(): Unit {
  return { ...unitContext(), operation: 'unit', declaredScope: 'explicit-profile-leaves', leaves: QUALITY_CONTROL_TREE.flatMap(element => element.children.map(child => ({ elementId: element.id, subelementId: child.id, state: 'checked' as const,
    record: child.id === 'mathematical-accuracy' ? { kind: 'accuracy' as const, model: accuracyModel() } : { kind: 'deduction' as const, defects: defects() } }))) }
}
function accuracyInput(): Extract<Input, { operation: 'accuracy' }> { return { ...unitContext(), operation: 'accuracy', declaredScope: 'declared-mathematical-accuracy-only', model: accuracyModel() } }
function deductionInput(): Extract<Input, { operation: 'deduction' }> { return { ...unitContext(), operation: 'deduction', declaredScope: 'declared-subelement-only', elementId: 'data-quality', subelementId: 'observation-quality', defects: defects() } }
function finalInput(): Extract<Input, { operation: 'final-batch' }> { return { ...common(), operation: 'final-batch', inspectionStage: 'final-inspection-batch', batchId: 'actual-batch', declaredScope: 'actual-final-inspection-batch-not-sample', declaredBatchUnitCount: 10, excellentCount: 5, goodCount: 4, qualifiedCount: 1, membershipStatus: 'complete', priorBatchQualification: 'qualified' } }
function acceptanceInput(): Extract<Input, { operation: 'acceptance-batch' }> { return { ...common(), operation: 'acceptance-batch', inspectionStage: 'acceptance-batch', batchId: 'acceptance-batch', declaredScope: 'declared-acceptance-inspections-only', detailed: 'qualified', overview: 'qualified', overviewNotPerformedBasis: null, fabricatedResults: false, majorTechnicalRouteDeviation: false } }
function sampleInput(): Extract<Input, { operation: 'sample' }> { return { ...common(), operation: 'sample', inspectionStage: 'detailed-sample', sampleId: 'sample', declaredScope: 'explicit-sample-members', declaredUnitIds: ['first', 'second'], units: [
  { unitId: 'first', state: 'qualified', declaredUnitCoverage: 'full-product-profile', score: '60', evidenceRefs: refs() },
  { unitId: 'second', state: 'qualified', declaredUnitCoverage: 'full-product-profile', score: '100', evidenceRefs: refs() }
] } }
const serial = (value: unknown): Exact => {
  if (typeof value === 'string' || typeof value === 'number') return parseExact(String(value))
  const fraction = value as { numerator: string; denominator: string }
  return parseExact(`${fraction.numerator}/${fraction.denominator}`)
}
const encoded = (value: r.RuleResult): Record<string, unknown> => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item !== null && typeof item === 'object' && 'n' in item ? output(item as Exact) : item]))
type OracleCase = { id: string; operation: string; input: Record<string, unknown>; expected: Record<string, unknown> }
const oracle = JSON.parse(readFileSync(new URL('../../../docs/qa/evidence/railwise-quality-scoring/quality-scoring-boundaries.json', import.meta.url), 'utf8')) as { cases: OracleCase[] }
function replay(example: OracleCase): Record<string, unknown> {
  const v = example.input, array = (key: string) => v[key] as unknown[], nullable = (value: unknown) => value === null ? null : Number(value)
  switch (example.operation) {
    case 'accuracy': return encoded(r.accuracy(serial(v.m), serial(v.m0)))
    case 'accuracy_aggregate': return encoded(r.multiple(array('scores').map(value => value === null ? null : serial(value)), Array.isArray(v.weights) ? v.weights.map(serial) : undefined))
    case 'deduction': return encoded(r.deduction(nullable(v.a), nullable(v.b), nullable(v.c), nullable(v.d), serial(v.t)))
    case 'grade': return encoded(r.grade(serial(v.score)))
    case 'unit': return encoded(r.unit(array('scores').map(value => value === null ? null : serial(value)), array('weights').map(serial), nullable(v.a), Boolean(v.complete)))
    case 'sample': return encoded(r.sample(array('units').map(value => { const unit = value as { state: r.QualityState; score?: unknown; reason?: string }; return { state: unit.state, reason: unit.reason ?? 'calculated', ...(unit.score ? { score: serial(unit.score) } : {}) } })))
    case 'overview': return encoded(r.overview(nullable(v.a), nullable(v.b)))
    case 'final_batch': return encoded(r.finalBatch(Number(v.e), Number(v.g), Number(v.q), v.qualified as boolean | null, Boolean(v.complete)))
    case 'acceptance_batch': return encoded(r.acceptance(v.detailed as string | null, v.overview as string | null, v.fabricated as boolean | null, v.major as boolean | null))
    case 'hierarchical_partial': {
      const input = unitInput(), scope = v.scope as Record<string, string[]>, values = v.values as Record<string, number>
      const mapping: Record<string, [string, string]> = { a: ['data-quality', 'mathematical-accuracy'], b: ['data-quality', 'observation-quality'], c: ['point-quality', 'selection-quality'], d: ['point-quality', 'marking-quality'] }
      const selected = Object.values(scope).flat()
      input.leaves = input.leaves.map(leaf => {
        const key = Object.keys(mapping).find(key => mapping[key]![1] === leaf.subelementId)
        if (!key || !selected.includes(key)) return { elementId: leaf.elementId, subelementId: leaf.subelementId, state: 'excluded', reason: 'explicit synthetic partial scope', evidenceRefs: refs() }
        if (!(key in values)) return { elementId: leaf.elementId, subelementId: leaf.subelementId, state: 'pending', reason: 'missing included leaf', evidenceRefs: refs() }
        if (leaf.state === 'checked' && leaf.record.kind === 'accuracy') leaf.record.model.items[0]!.m = values[key] === 60 ? '1' : '0.3'
        else if (leaf.state === 'checked' && leaf.record.kind === 'deduction') leaf.record.defects.d = 100 - values[key]!
        return leaf
      })
      const result = scoreSurveyQualityV1(input)
      if (example.id === 'partial_missing_included_leaf') return { state: result.result.state, reason: result.result.state === 'unavailable' ? 'missing_included_scope_value' : result.result.reason }
      return { state: result.result.state, score: result.result.score, elementWeights: { A: result.trace.find(row => row.nodeId === 'data-quality')!.effectiveWeight, B: result.trace.find(row => row.nodeId === 'point-quality')!.effectiveWeight }, childWeights: { A: { a: result.trace.find(row => row.nodeId === 'mathematical-accuracy')!.effectiveWeight }, B: { c: result.trace.find(row => row.nodeId === 'selection-quality')!.effectiveWeight, d: result.trace.find(row => row.nodeId === 'marking-quality')!.effectiveWeight } }, scopeLabel: 'declared_partial_scope_only' }
    }
    default: throw new Error(`Unhandled independent oracle operation ${example.operation}`)
  }
}

describe('GB/T 24356 exact declared scoring', () => {
  it.each(oracle.cases)('matches independently transcribed Fraction boundary: $id', example => {
    const expected = { ...example.expected }
    if (typeof expected.fixedADeduction === 'number') expected.fixedADeduction = output(serial(expected.fixedADeduction))
    expect(replay(example)).toMatchObject(expected)
  })
  it('binds source/profile and immutable request while keeping declared success separate from approval', () => {
    const input = unitInput(), before = JSON.stringify(input), result = scoreSurveyQualityV1(input)
    expect(result.result).toMatchObject({ state: 'calculated', score: { numerator: '100', denominator: '1' }, grade: 'excellent' })
    expect(JSON.stringify(input)).toBe(before); expect(result.requestSha256).toBe(createHash('sha256').update(before).digest('hex'))
    expect(result).toMatchObject({ evidenceAuthenticity: 'not-verified', classificationAuthenticity: 'not-verified', engineeringDecision: 'not-evaluated', standardConformity: 'not-authenticated', formalResultsModified: false, humanSignatureVerification: 'not-evaluated' })
    expect(SurveyQualityScoringOutputV1.safeParse(result).success).toBe(true)
    expect(result.trace.filter(row => row.nodeId.endsWith('-quality') && row.nodeId !== input.unitId).every(row => row.result.grade === null)).toBe(true)
  })
  it('supports height control only with table45/46 and declared section unit', () => {
    const input = { ...unitInput(), productProfileId: 'height-control-section', profileWeightTable: 45, profileClassificationTable: 46, unitType: 'section' }
    expect(scoreSurveyQualityV1(input).result.state).toBe('calculated')
    expect(scoreSurveyQualityV1({ ...input, profileClassificationTable: 44 }).result.state).toBe('invalid')
    expect(scoreSurveyQualityV1({ ...input, unitType: 'point' }).result.state).toBe('invalid')
  })
  it('does not round a sub-ulp excess to the m0 boundary or a score below60 to60', () => {
    const input = accuracyInput(); input.model.items[0]!.m = '1.000000000000000000000001'
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', reason: 'accuracy_formula_outside_domain', score: null })
    expect(r.grade(parseExact('59.999999999999999999999999')).state).toBe('nonconforming')
  })
  it('validates all supplied numeric evidence before applying an A veto', () => {
    const input = unitInput(), a = input.leaves[1]!, precision = input.leaves[0]!
    if (a.state !== 'checked' || a.record.kind !== 'deduction' || precision.state !== 'checked' || precision.record.kind !== 'accuracy') throw new Error('fixture')
    a.record.defects.a = 1; precision.record.model.items[0]!.m0 = '0'
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'invalid', reason: 'accuracy_domain', score: null })
  })
  it.each(['a', 'low'] as const)('retains %s veto with pending siblings and never emits a composite unit score', mode => {
    const input = unitInput(), failing = input.leaves[1]!
    if (failing.state !== 'checked' || failing.record.kind !== 'deduction') throw new Error('fixture')
    if (mode === 'a') failing.record.defects.a = 1
    else failing.record.defects.d = 41
    const sibling = input.leaves[2]!
    input.leaves[2] = { elementId: sibling.elementId, subelementId: sibling.subelementId, state: 'pending', reason: 'not inspected', evidenceRefs: refs() }
    const result = scoreSurveyQualityV1(input)
    expect(result.result).toMatchObject({ state: 'nonconforming', score: null, rawScore: null, grade: null })
    const leaf = result.trace.find(row => row.nodeId === 'observation-quality')!
    expect(mode === 'a' ? leaf.result.fixedADeduction : leaf.result.rawScore).toEqual({ numerator: mode === 'a' ? '42' : '59', denominator: '1' })
  })
  it('distinguishes explicitly excluded leaves from pending evidence', () => {
    const input = unitInput(), leaf = input.leaves[1]!
    input.leaves[1] = { elementId: leaf.elementId, subelementId: leaf.subelementId, state: 'pending', reason: 'pending check', evidenceRefs: refs() }
    expect(scoreSurveyQualityV1(input).result.state).toBe('unavailable')
    input.leaves[1] = { ...input.leaves[1], state: 'excluded' }
    expect(scoreSurveyQualityV1(input)).toMatchObject({ scopeAssessment: 'partial-declared-product-profile', result: { state: 'calculated', grade: 'excellent' } })
    input.leaves = input.leaves.map(leaf => ({ elementId: leaf.elementId, subelementId: leaf.subelementId, state: 'excluded', reason: 'explicit exclusion', evidenceRefs: refs() }))
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', reason: 'empty_declared_scope' })
  })
  it('keeps unknown A and missing precision items unresolved', () => {
    const input = accuracyInput(); input.model.aCount = null
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', reason: 'missing_a_evidence' })
    input.model.aCount = 0; input.model.items[0]!.m = null
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', reason: 'missing_accuracy_item' })
  })
  it('allows single60 and blocks multiple-accuracy60 without changing it into failure', () => {
    const input = accuracyInput(); input.model.items[0]!.m = '1'
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'calculated', score: { numerator: '60', denominator: '1' } })
    input.model.items.push({ ...input.model.items[0]!, id: 'second', m: '0' })
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', reason: 'multiple_accuracy_equality_60' })
  })
  it('requires exact positive accuracy weights summing to one even when some evidence is missing', () => {
    const input = accuracyInput(); input.model.items[0]!.m = null
    input.model.aggregation = { kind: 'weighted', weights: ['0.999999999999999999999999'], basisStatement: 'declared weights', evidenceRefs: refs() }
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'invalid', reason: 'weights_positive_sum_one' })
  })
  it('preserves negative raw deduction and a known upper-bound veto without treating missing counts as zero', () => {
    const input = deductionInput(); input.defects.b = 9
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'nonconforming', rawScore: { numerator: '-8', denominator: '1' }, score: null })
    input.defects.c = null
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'nonconforming', rawScore: null, diagnosticScoreUpperBound: { numerator: '-8', denominator: '1' } })
  })
  it('does not divide A by adjusted t, support adjusted t, or score mathematical accuracy by zero defect counts', () => {
    const input = deductionInput(); input.defects.t = '2'
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', reason: 'adjusted_t_not_in_minimal_contract' })
    input.defects.a = 2
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'nonconforming', fixedADeduction: { numerator: '84', denominator: '1' } })
    input.defects = defects(); input.subelementId = 'mathematical-accuracy'
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', reason: 'mathematical_accuracy_requires_formula_3' })
    input.defects.b = 1
    expect(scoreSurveyQualityV1(input).result.state).toBe('invalid')
  })
  it('uses the declared sample denominator, preserves unresolved members, and prioritizes valid known failure', () => {
    const input = sampleInput()
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'calculated', score: { numerator: '80', denominator: '1' }, grade: 'good' })
    input.units.pop()
    expect(scoreSurveyQualityV1(input).result.state).toBe('unavailable')
    input.units[0] = { unitId: 'first', state: 'nonconforming', reason: 'known failed inspection', evidenceRefs: refs() }
    expect(scoreSurveyQualityV1(input).result.state).toBe('nonconforming')
    const invalid = sampleInput(); invalid.units[0] = { ...invalid.units[0]!, score: '59' } as typeof invalid.units[number]
    expect(scoreSurveyQualityV1(invalid).result.state).toBe('invalid')
  })
  it('uses declared batch N and prerequisites even when the incomplete counts are all zero', () => {
    const input = finalInput(); input.membershipStatus = 'incomplete'; input.excellentCount = 0; input.goodCount = 0; input.qualifiedCount = 0
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'unavailable', count: 10, grade: null })
    input.priorBatchQualification = 'failed'
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'nonconforming', count: 10 })
    input.membershipStatus = 'complete'
    expect(scoreSurveyQualityV1(input).result.state).toBe('invalid')
  })
  it('never treats pending overview as not-performed or adds an excellent acceptance-batch grade', () => {
    const input = acceptanceInput(); input.overview = 'pending'
    expect(scoreSurveyQualityV1(input).result.state).toBe('unavailable')
    input.overview = 'not-performed'
    expect(scoreSurveyQualityV1(input).result.state).toBe('invalid')
    input.overviewNotPerformedBasis = 'Only detailed inspection was declared for this batch.'
    expect(scoreSurveyQualityV1(input).result).toMatchObject({ state: 'calculated', qualified: true, grade: null, score: null })
    input.fabricatedResults = true; input.detailed = 'missing'
    expect(scoreSurveyQualityV1(input).result.state).toBe('nonconforming')
  })
  it.each(['profile', 'source', 'stage', 'missing-leaf', 'duplicate-leaf', 'wrong-parent', 'empty-evidence', 'unknown-property', 'big-count', 'exponent', 'zero-denominator', 'long-integer', 'surrogate'])('rejects invalid public evidence before computation: %s', mode => {
    const input = unitInput(), raw = input as unknown as Record<string, unknown>, leaf = input.leaves[1]!
    if (mode === 'profile') raw.productProfileId = 'deformation-survey'
    if (mode === 'source') raw.sourceDigest = '0'.repeat(64)
    if (mode === 'stage') raw.inspectionStage = 'acceptance-batch'
    if (mode === 'missing-leaf') input.leaves.pop()
    if (mode === 'duplicate-leaf') input.leaves[1] = input.leaves[2]!
    if (mode === 'wrong-parent') input.leaves[1]!.elementId = 'material-quality'
    if (mode === 'empty-evidence') input.evidenceRefs = []
    if (mode === 'unknown-property') raw.approved = true
    if (mode === 'surrogate') input.unitId = '\ud800'
    if (leaf.state === 'checked' && leaf.record.kind === 'deduction') {
      if (mode === 'big-count') leaf.record.defects.a = 1_000_001
      if (mode === 'exponent') leaf.record.defects.t = '1e0'
      if (mode === 'zero-denominator') leaf.record.defects.t = '1/0'
      if (mode === 'long-integer') leaf.record.defects.t = '1'.repeat(10000)
    }
    expect(scoreSurveyQualityV1(input)).toMatchObject({ result: { state: 'invalid' }, request: null, requestSha256: null, trace: [] })
  })
  it('rejects cyclic and oversized objects but allows ordinary shared JSON references without mutation', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(scoreSurveyQualityV1(cyclic).result.state).toBe('invalid')
    const input = unitInput(), shared = refs(); input.evidenceRefs = shared
    for (const leaf of input.leaves) if (leaf.state === 'checked' && leaf.record.kind === 'deduction') leaf.record.defects.evidenceRefs = shared
    expect(scoreSurveyQualityV1(input).result.state).toBe('calculated')
    expect(scoreSurveyQualityV1(Array(100000).fill(null)).result.state).toBe('invalid')
  })
})
