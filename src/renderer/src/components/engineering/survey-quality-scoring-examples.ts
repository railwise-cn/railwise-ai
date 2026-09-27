import { QUALITY_CONTROL_TREE, QUALITY_PROFILE_VERSION, QUALITY_STANDARD_DIGEST, type SurveyQualityScoringInputV1 } from '@shared/survey-quality-scoring'
export type ScoringProfile = SurveyQualityScoringInputV1['productProfileId']
export function qualityScoringExample(kind: SurveyQualityScoringInputV1['operation'], profile: ScoringProfile): SurveyQualityScoringInputV1 {
  const planar = profile === 'planar-control-point'
  const common = { schemaVersion: 1 as const, standardCode: 'GB/T 24356-2023' as const, sourceDigest: QUALITY_STANDARD_DIGEST,
    productProfileId: profile, productProfileVersion: QUALITY_PROFILE_VERSION, profileWeightTable: planar ? 43 as const : 45 as const,
    profileClassificationTable: planar ? 44 as const : 46 as const, declaredBasis: 'caller-declared-inspection-records-not-authenticated' as const, evidenceRefs: ['replace-with-inspection-record-reference'] }
  const unit = { ...common, unitId: 'replace-with-unit-id', unitType: planar ? 'point' as const : 'section' as const, inspectionStage: 'detailed-inspection' as const }
  const model = { items: [{ id: 'precision-1', m: null, m0: null, unit: 'mm', source: 'caller-declared-error-magnitude-not-derived-from-adjustment-residuals' as const, evidenceRefs: ['replace-with-accuracy-reference'] }], aggregation: { kind: 'arithmetic' as const }, aCount: null, aEvidenceRefs: ['replace-with-a-inspection-reference'] }
  const defects = { a: null, b: null, c: null, d: null, t: '1', classification: 'caller-declared-profile-table-counts-not-automatically-classified' as const, evidenceRefs: ['replace-with-classified-defect-record-reference'] }
  if (kind === 'accuracy') return { ...unit, operation: kind, declaredScope: 'declared-mathematical-accuracy-only', model }
  if (kind === 'deduction') return { ...unit, operation: kind, declaredScope: 'declared-subelement-only', elementId: 'data-quality', subelementId: 'observation-quality', defects }
  if (kind === 'unit') return { ...unit, operation: kind, declaredScope: 'explicit-profile-leaves', leaves: QUALITY_CONTROL_TREE.flatMap(element => element.children.map(child => ({ elementId: element.id, subelementId: child.id, state: 'checked' as const, record: child.id === 'mathematical-accuracy' ? { kind: 'accuracy' as const, model } : { kind: 'deduction' as const, defects } }))) }
  if (kind === 'overview') return { ...common, operation: kind, inspectionStage: 'overview-inspection', declaredScope: 'declared-overview-only', unitId: unit.unitId, unitType: unit.unitType, a: null, b: null }
  if (kind === 'sample') return { ...common, operation: kind, inspectionStage: 'detailed-sample', declaredScope: 'explicit-sample-members', sampleId: 'replace-with-sample-id', declaredUnitIds: ['replace-with-unit-id'], units: [{ unitId: 'replace-with-unit-id', state: 'pending', reason: 'replace-with-inspection-status', evidenceRefs: common.evidenceRefs }] }
  if (kind === 'final-batch') return { ...common, operation: kind, inspectionStage: 'final-inspection-batch', declaredScope: 'actual-final-inspection-batch-not-sample', batchId: 'replace-with-batch-id', declaredBatchUnitCount: 1, excellentCount: 0, goodCount: 0, qualifiedCount: 0, membershipStatus: 'unknown', priorBatchQualification: 'unknown' }
  return { ...common, operation: kind, inspectionStage: 'acceptance-batch', declaredScope: 'declared-acceptance-inspections-only', batchId: 'replace-with-batch-id', detailed: 'unknown', overview: 'unknown', overviewNotPerformedBasis: null, fabricatedResults: null, majorTechnicalRouteDeviation: null }
}
