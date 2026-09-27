import { createHash } from 'node:crypto'
import { SurveyQualityScoringInputV1, SurveyQualityScoringOutputV1, QUALITY_STANDARD_DIGEST, QUALITY_CONTROL_TREE, type QualityRuleResultV1 } from '../contracts/survey-quality-scoring.js'
import { parseExact, output, compare, div, sum, integer, ZERO, HUNDRED, type Exact } from './survey-quality-scoring-exact.js'
import * as rule from './survey-quality-scoring-rules.js'

type Input = SurveyQualityScoringInputV1
type AccuracyModel = Extract<Input, { operation: 'accuracy' }>['model']
const present = (value: Exact | undefined) => value ? output(value) : null
const encode = (value: rule.RuleResult): QualityRuleResultV1 => ({ state: value.state, reason: value.reason, score: present(value.score), rawScore: present(value.rawScore),
  fixedADeduction: present(value.fixedADeduction), diagnosticScoreUpperBound: present(value.diagnosticScoreUpperBound), grade: value.grade ?? null,
  qualified: value.qualified ?? null, count: value.count ?? null, excellentRate: present(value.excellentRate), excellentGoodRate: present(value.excellentGoodRate) })
function boundedJson(raw: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }]
  let nodes = 0, characters = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > 32768 || depth > 12) return false
    if (typeof value === 'string') { characters += value.length; if (characters > 1024 * 1024 || value.length > 4000) return false }
    else if (typeof value === 'object' && value !== null) {
      const entries = Array.isArray(value) ? value : Object.values(value)
      if (entries.length > 128) return false
      for (const child of entries) pending.push({ value: child, depth: depth + 1 })
    } else if (value !== null && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) return false
  }
  return true
}
function validateAccuracy(model: AccuracyModel): rule.RuleResult | null {
  if (model.aggregation.kind === 'weighted') {
    const check = rule.weighted(model.items.map(() => ZERO), model.aggregation.weights.map(parseExact))
    if (check.state === 'invalid') return check
  }
  for (const item of model.items) {
    if (item.m !== null && compare(parseExact(item.m), ZERO) < 0 || item.m0 !== null && compare(parseExact(item.m0), ZERO) <= 0) return rule.invalid('accuracy_domain')
  }
  return null
}
/** Exact declared-record scoring only. No file access, mutation, official approval or automatic defect classification. */
export function scoreSurveyQualityV1(raw: unknown): SurveyQualityScoringOutputV1 {
  let parsed: ReturnType<typeof SurveyQualityScoringInputV1.safeParse>
  try { parsed = SurveyQualityScoringInputV1.safeParse(boundedJson(raw) ? raw : null) }
  catch { parsed = SurveyQualityScoringInputV1.safeParse(null) }
  const result: SurveyQualityScoringOutputV1 = {
    schemaVersion: 1, algorithmVersion: 'gbt24356-declared-exact-quality-scoring-1', status: 'declared-inspection-trial-only',
    request: parsed.success ? parsed.data : null, requestSha256: parsed.success ? createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex') : null,
    result: encode(rule.invalid('invalid_request')), scopeAssessment: 'not-evaluated', checkedSubelementIds: [], pendingSubelementIds: [], excludedSubelementIds: [], trace: [],
    arithmetic: 'bounded-reduced-bigint-rational-no-rounded-thresholds', evidenceAuthenticity: 'not-verified', classificationAuthenticity: 'not-verified', priorQualificationAuthenticity: 'not-verified',
    engineeringDecision: 'not-evaluated', standardConformity: 'not-authenticated', humanSignatureVerification: 'not-evaluated', formalResultsModified: false, observationAction: 'none',
    source: { standardCode: 'GB/T 24356-2023', sha256: QUALITY_STANDARD_DIGEST, reviewedPrintedPageRanges: ['6-8', '57-63'], scope: 'limited-declared-inspection-scoring-not-full-standard-implementation' }
  }
  const finish = (value: rule.RuleResult) => { result.result = encode(value); return SurveyQualityScoringOutputV1.parse(result) }
  if (!parsed.success) return finish(rule.invalid('invalid_request'))
  const input = parsed.data
  const trace = (nodeId: string, clause: string, value: rule.RuleResult, originalWeight?: Exact, effectiveWeight?: Exact) => {
    result.trace.push({ nodeId, clause, result: encode(value), originalWeight: present(originalWeight), effectiveWeight: present(effectiveWeight) })
  }
  function accuracy(model: AccuracyModel, path: string): rule.RuleResult {
    const values = model.items.map(item => item.m === null || item.m0 === null ? rule.unavailable('missing_accuracy_item') : rule.accuracy(parseExact(item.m), parseExact(item.m0)))
    values.forEach((value, i) => trace(`${path}/${i}`, '6.2.4.1.1/formula-3', value))
    if (model.aCount !== null && model.aCount > 0) return { ...rule.nonconforming('a_class_veto'), fixedADeduction: integer(42 * model.aCount) }
    const unresolved = values.find(value => value.state !== 'calculated')
    if (unresolved) return unresolved
    if (model.aCount === null) return rule.unavailable('missing_a_evidence')
    return rule.multiple(values.map(value => value.score ?? null), model.aggregation.kind === 'weighted' ? model.aggregation.weights.map(parseExact) : undefined)
  }
  function deductions(item: Extract<Input, { operation: 'deduction' }>['defects'], subelement: string): rule.RuleResult {
    const value = rule.deduction(item.a, item.b, item.c, item.d, parseExact(item.t))
    return subelement === 'mathematical-accuracy' && value.state === 'calculated' ? rule.unavailable('mathematical_accuracy_requires_formula_3') : value
  }
  try {
    // Validate every supplied numeric domain before allowing a known veto to override missing evidence.
    if (input.operation === 'accuracy') { const invalid = validateAccuracy(input.model); if (invalid) return finish(invalid) }
    if (input.operation === 'deduction' && compare(parseExact(input.defects.t), ZERO) <= 0) return finish(rule.invalid('adjustment_coefficient'))
    if (input.operation === 'unit') for (const leaf of input.leaves) if (leaf.state === 'checked') {
      if (leaf.record.kind === 'accuracy') { const invalid = validateAccuracy(leaf.record.model); if (invalid) return finish(invalid) }
      else if (compare(parseExact(leaf.record.defects.t), ZERO) <= 0) return finish(rule.invalid('adjustment_coefficient'))
    }
    if (input.operation === 'sample' && input.units.some(unit => unit.state === 'qualified' && (compare(parseExact(unit.score), integer(60)) < 0 || compare(parseExact(unit.score), HUNDRED) > 0))) return finish(rule.invalid('invalid_qualified_unit_score'))
    if (input.operation === 'accuracy' || input.operation === 'deduction') {
      result.scopeAssessment = 'declared-component-only'
      const value = input.operation === 'accuracy' ? accuracy(input.model, 'accuracy') : deductions(input.defects, input.subelementId)
      trace(input.operation, input.operation === 'accuracy' ? '6.2.4.1.1' : '6.2.4.1.2/formula-4/table-2', value)
      return finish(value)
    }
    if (input.operation === 'unit') {
      result.checkedSubelementIds = input.leaves.filter(leaf => leaf.state === 'checked').map(leaf => leaf.subelementId)
      result.pendingSubelementIds = input.leaves.filter(leaf => leaf.state === 'pending').map(leaf => leaf.subelementId)
      result.excludedSubelementIds = input.leaves.filter(leaf => leaf.state === 'excluded').map(leaf => leaf.subelementId)
      result.scopeAssessment = result.pendingSubelementIds.length ? 'unresolved-declared-product-profile' : result.excludedSubelementIds.length ? 'partial-declared-product-profile' : 'complete-declared-product-profile'
      const included = QUALITY_CONTROL_TREE.filter(element => input.leaves.some(leaf => leaf.elementId === element.id && leaf.state !== 'excluded'))
      if (!included.length) return finish(rule.unavailable('empty_declared_scope'))
      const parentDenominator = sum(included.map(element => parseExact(element.weight))), elements: rule.RuleResult[] = [], parentWeights: Exact[] = []
      for (const element of included) {
        const children = element.children.filter(child => input.leaves.some(leaf => leaf.subelementId === child.id && leaf.state !== 'excluded'))
        const denominator = sum(children.map(child => parseExact(child.weight))), values: rule.RuleResult[] = [], weights: Exact[] = []
        for (const child of children) {
          const leaf = input.leaves.find(leaf => leaf.subelementId === child.id)!
          const value = leaf.state !== 'checked' ? rule.unavailable('pending_subelement') : leaf.record.kind === 'accuracy' ? accuracy(leaf.record.model, child.id) : deductions(leaf.record.defects, child.id)
          const weight = div(parseExact(child.weight), denominator)
          trace(child.id, '6.2.3/6.2.4.1', value, parseExact(child.weight), weight); values.push(value); weights.push(weight)
        }
        const failure = values.find(value => value.state === 'nonconforming'), unresolved = values.find(value => value.state !== 'calculated')
        const value = failure ? rule.nonconforming('child_below_60_or_a_veto') : unresolved ?? rule.weighted(values.map(item => item.score!), weights)
        const weight = div(parseExact(element.weight), parentDenominator)
        trace(element.id, '6.2.4.4/formula-5', value, parseExact(element.weight), weight); elements.push(value); parentWeights.push(weight)
      }
      const failure = elements.find(value => value.state === 'nonconforming'), unresolved = elements.find(value => value.state !== 'calculated')
      const value = failure ? rule.nonconforming('child_below_60_or_a_veto') : unresolved ?? rule.unit(elements.map(item => item.score ?? null), parentWeights, 0, true)
      trace(input.unitId, '6.2.5/formula-6/table-3', value)
      return finish(value)
    }
    if (input.operation === 'overview') {
      result.scopeAssessment = 'declared-component-only'; const value = rule.overview(input.a, input.b); trace(input.unitId, '6.1.3', value); return finish(value)
    }
    if (input.operation === 'sample') {
      result.scopeAssessment = 'declared-sample-only'
      const units = input.declaredUnitIds.map(id => { const record = input.units.find(unit => unit.unitId === id)
        const value = !record || record.state === 'pending' ? rule.unavailable('missing_or_pending_unit') : record.state === 'nonconforming' ? rule.nonconforming('declared_failed_unit') : rule.grade(parseExact(record.score))
        trace(id, '6.3/declared-unit', value); return value })
      const value = rule.sample(units); trace(input.sampleId, '6.3/table-3', value); return finish(value)
    }
    result.scopeAssessment = 'declared-batch-only'
    if (input.operation === 'final-batch') {
      const value = input.priorBatchQualification === 'failed' ? rule.nonconforming('batch_prerequisite_failed')
        : input.priorBatchQualification === 'unknown' || input.membershipStatus !== 'complete' ? rule.unavailable('batch_prerequisite_missing')
          : rule.finalBatch(input.excellentCount, input.goodCount, input.qualifiedCount, true, true)
      value.count = input.declaredBatchUnitCount
      trace(input.batchId, '6.4.1', value); return finish(value)
    }
    const value = rule.acceptance(input.detailed, input.overview, input.fabricatedResults, input.majorTechnicalRouteDeviation)
    trace(input.batchId, '6.4.2', value); return finish(value)
  } catch (error) {
    if (error instanceof RangeError) return finish(rule.unavailable('exact_arithmetic_budget'))
    throw error
  }
}
