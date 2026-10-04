import { describe, expect, it } from 'vitest'
import en from '../../locales/en/common.json'
import zh from '../../locales/zh/common.json'

const userFacingSurveyCopy = [
  'surveyRuntimeDeterministic',
  'surveyRuntimeWaiting',
  'surveyDiagnostics',
  'surveyNoDiagnostics',
  'surveyRawAnchors',
  'surveyAnchorsHint',
  'surveySourceBoundary',
  'surveyImportBoundary',
  'surveyAdvancedJson',
  'surveyJsonSource',
  'surveyJsonObjectRequired',
  'surveyHideJson',
  'surveyInputRevision',
  'surveyParser',
  'surveyLocalConverter',
  'surveyConverterPermissions',
  'surveyParserHash',
  'surveyConverterIdentity',
  'surveyJsonContract',
  'surveyJsonUnits',
  'surveyCosaHint',
  'surveyResidualsMissing',
  'surveyOoxmlMemberSha256',
  'surveyStatsInputHash',
  'surveyStatsSourceHash',
  'surveyStatsCalculationHash',
  'engineeringExecutionChain',
  'engineeringNoticeRefreshed',
  'engineeringEvidenceStructured',
  'engineeringPlanBoundaryProject',
  'engineeringPlanQualityResult',
  'engineeringAttachmentStore',
  'engineeringControlledModel',
  'engineeringEvidenceSource',
  'engineeringReviewSurveyAnalysis',
  'engineeringSurveyAnalysisPending',
  'surveyProfessionalDatumDefectBasis',
  'engineeringReviewDescription',
  'engineeringReviewSurveyInputs',
  'surveyStructuralProbe',
  'runtimeActionNeedsConnection',
  'runtimeRequestFailed',
  'runtimeEngineeringPlanExecutionFailed',
  'runtimeEngineeringPlanStepsIncomplete'
] as const

describe('default Survey surface copy', () => {
  it('describes survey work without exposing implementation vocabulary', () => {
    for (const locale of [zh, en]) {
      for (const key of userFacingSurveyCopy) {
        expect(locale[key], `${key}`).not.toMatch(/P0|SHA-?256|parser diagnostics|解析诊断|解析器|parser|JSON|哈希|hash|binary|二进制|contract|合同|Attachment Store|本地计算服务|local processing service|anchor|锚点|deterministic|确定性|solver rank|结构探针|门禁|准入|runtime|运行时|execution receipts|执行回执/i)
      }
    }
  })

  it('keeps numerical meaning and the unapproved-deliverable limitation in plain language', () => {
    expect(zh.surveyProfessionalDatumDefectBasis).toContain('未知参数数减系数矩阵的秩')
    expect(en.surveyProfessionalDatumDefectBasis).toContain('number of unknowns minus the rank of the coefficient matrix')
    expect(zh.engineeringReviewDescription).toContain('不可作为已批准交付')
    expect(en.engineeringReviewDescription).toContain('not approved until professional review, approval and signing are complete')
  })
})
