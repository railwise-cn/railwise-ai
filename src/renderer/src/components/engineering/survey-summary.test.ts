import { describe, expect, it } from 'vitest'
import { selectSurveyClosureKey, surveyReadiness, surveyMeasurementNumber } from './survey-summary'

describe('survey summary closure metric selection', () => {
  it('uses height closure for leveling even when another field is serialized first', () => {
    expect(selectSurveyClosureKey('leveling', { horizontal: 9, heightDifference: 0.001 })).toBe('heightDifference')
  })

  it('uses relative closure for traverse and baseline norm for GNSS', () => {
    expect(selectSurveyClosureKey('traverse', { horizontal: 0.2, relativeClosure: 0.0001 })).toBe('relativeClosure')
    expect(selectSurveyClosureKey('gnss', { baselineX: 0.01, baseline: 0.02 })).toBe('baseline')
  })

  it('falls back to a finite generic metric for legacy or unknown network types', () => {
    expect(selectSurveyClosureKey('legacy', { angular: Number.NaN, vertical: 0.003 })).toBe('vertical')
    expect(selectSurveyClosureKey(undefined, undefined)).toBeUndefined()
  })
})


describe('survey summary review boundaries', () => {
  const ready = { blocked: false, networkValidated: true, datasetValidated: false, hasSource: true, hasResult: false, hasOutputs: false, manifestValid: false }
  it('allows a validated survey network without a monitoring dataset', () => {
    expect(surveyReadiness(ready)).toBe('adjustment-ready')
  })
  it('never treats preview files or a draft manifest as reviewed', () => {
    expect(surveyReadiness({ ...ready, hasOutputs: true })).toBe('candidate')
    expect(surveyReadiness({ ...ready, hasOutputs: true, manifestValid: true, reviewStatus: 'draft' })).toBe('candidate')
    expect(surveyReadiness({ ...ready, hasOutputs: true, manifestValid: true, reviewStatus: 'approved' })).toBe('reviewed')
  })
  it('gives source blockers precedence over historical outputs', () => {
    for (const disposition of ['archive-only', 'converter-required', 'gnss-processing-required']) {
      expect(surveyReadiness({ ...ready, disposition, hasOutputs: true })).toBe(disposition)
    }
    expect(surveyReadiness({ ...ready, blocked: true, hasOutputs: true, manifestValid: true, reviewStatus: 'approved' })).toBe('blocked')
  })
})


describe('survey measurement precision in the compact summary', () => {
  it('preserves tiny positive and negative results instead of presenting exact zero', () => {
    for (const locale of ['zh-CN', 'en-US']) {
      expect(surveyMeasurementNumber(1.35922e-7, locale)).toBe('1.3592E-7')
      expect(surveyMeasurementNumber(-1.37267e-7, locale)).toBe('-1.3727E-7')
      expect(surveyMeasurementNumber(0, locale)).toBe('0')
      expect(surveyMeasurementNumber(0.00666981, locale)).toBe('0.0067')
      expect(surveyMeasurementNumber(Number.NaN, locale)).toBe('—')
      expect(surveyMeasurementNumber(undefined, locale)).toBe('—')
    }
  })
})
