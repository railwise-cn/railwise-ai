import { QUALITY_CONTROL_TREE, QUALITY_PROFILE_VERSION, QUALITY_STANDARD_DIGEST, type SurveyQualityScoringInputV1 } from '../contracts/survey-quality-scoring.js'
export function qualityScoringTestDeclaration(operation: 'unit' | 'accuracy' = 'unit'): SurveyQualityScoringInputV1 {
  const common = { schemaVersion: 1 as const, standardCode: 'GB/T 24356-2023' as const, sourceDigest: QUALITY_STANDARD_DIGEST,
    productProfileId: 'planar-control-point' as const, productProfileVersion: QUALITY_PROFILE_VERSION, profileWeightTable: 43 as const, profileClassificationTable: 44 as const,
    declaredBasis: 'caller-declared-inspection-records-not-authenticated' as const, evidenceRefs: ['synthetic'],
    inspectionStage: 'detailed-inspection' as const, unitId: 'synthetic-point', unitType: 'point' as const }
  const model = { items: [{ id: 'precision', m: '0.3', m0: '1', unit: 'mm', source: 'caller-declared-error-magnitude-not-derived-from-adjustment-residuals' as const, evidenceRefs: ['synthetic'] }],
    aggregation: { kind: 'arithmetic' as const }, aCount: 0, aEvidenceRefs: ['synthetic'] }
  if (operation === 'accuracy') return { ...common, operation, declaredScope: 'declared-mathematical-accuracy-only', model }
  return { ...common, operation, declaredScope: 'explicit-profile-leaves', leaves: QUALITY_CONTROL_TREE.flatMap(element => element.children.map(child => ({ elementId: element.id, subelementId: child.id, state: 'checked' as const,
    record: child.id === 'mathematical-accuracy' ? { kind: 'accuracy' as const, model } : { kind: 'deduction' as const, defects: { a: 0, b: 0, c: 0, d: 0, t: '1', classification: 'caller-declared-profile-table-counts-not-automatically-classified' as const, evidenceRefs: ['synthetic'] } } }))) }
}
export function qualityScoringTestRequest(operation: 'unit' | 'accuracy' = 'unit', key = 'quality-scoring-test-1') {
  return { kind: operation, acknowledged: true as const, expectedProjectRevision: 1, idempotencyKey: key,
    declarationJson: JSON.stringify(qualityScoringTestDeclaration(operation), null, 2), modelBasisStatement: '合成声明资料。\n不是工程质量批准。' }
}
