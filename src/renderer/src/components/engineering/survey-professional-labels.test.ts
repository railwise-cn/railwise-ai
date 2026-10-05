import { describe, expect, it } from 'vitest'
import { surveyObservationDisplayLabel } from './survey-professional-labels'
import { surveySourceFormatLabel } from './survey-source-format-labels'
import { SurveyFormatIdV1 } from '../../../../../kun/src/contracts/survey'
import i18n from '../../i18n'

describe('professional survey labels', () => {
  it('keeps measured geometry, type and original location instead of a parser identifier', () => {
    const observation = { id: 'cosa-in2-6-backsight-reset', station: 'S1', target: 'A', type: 'direction', sourceRow: 6 }
    expect(surveyObservationDisplayLabel(observation, 'zh')).toBe('S1 → A · 方向 · 来源第 6 行')
    expect(surveyObservationDisplayLabel(observation, 'en')).toBe('S1 → A · Direction · source row 6')
    expect(surveyObservationDisplayLabel({ id: 'gsi-block-1-line-20-dh', type: 'height-difference', sequence: 2 }, 'zh')).toBe('高差 · 观测 2')
  })

  it('preserves meaningful observation names while providing a location or sequence fallback', () => {
    expect(surveyObservationDisplayLabel({ id: '东区复测', from: 'BM01', to: 'BM02', sequence: 1 }, 'zh')).toBe('东区复测 · BM01 → BM02 · 观测 1')
    expect(surveyObservationDisplayLabel({ observationId: 'cosa-in1-4', sourceRow: 4 }, 'zh')).toBe('来源第 4 行')
    expect(surveyObservationDisplayLabel({ observationId: 'sdr-4-hz', sequence: 5 }, 'en')).toBe('observation 5')
    expect(surveyObservationDisplayLabel({ id: 'tabular-12', type: 'height-difference', sourceRow: 12 }, 'en')).toBe('Height difference · source row 12')
    expect(surveyObservationDisplayLabel({ id: 'BM01复测-12', sequence: 1 }, 'zh')).toBe('BM01复测-12 · 观测 1')
  })

  it.each(['zh', 'en'])('names every registered survey format in %s', async language => {
    await i18n.changeLanguage(language)
    const t = i18n.getFixedT(language, 'common')
    for (const format of SurveyFormatIdV1.options.filter(value => value !== 'unknown')) {
      expect(surveySourceFormatLabel(t, format, language), format).not.toBe(t('surveyUnknownFormat'))
    }
    expect(surveySourceFormatLabel(t, 'cosa-in2', language)).toBe('COSA IN2')
    expect(surveySourceFormatLabel(t, 'south-dat', language)).toBe(language === 'en' ? 'South DAT' : '南方 DAT')
  })
})
