// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { SurveyResidualStatisticV1, SurveyStatisticalSummaryV1 } from '@shared/survey-statistical-semantics'
import i18n from '../../i18n'
import { ResidualStatisticCell, SurveyAdjustmentStatistics } from './SurveyAdjustmentStatistics'

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
const basis = { schemaVersion: 1 as const, method: 'residual-sigma-ratio' as const, scaleBasis: 'estimated-posterior' as const,
  scope: 'descriptive-screening' as const, significance: 'not-evaluated' as const }

describe('statistical interpretation in the result surface', () => {
  it.each(['en', 'zh'])('keeps zero-like untestable rows and unknown historical basis visible in %s', async (lang) => {
    await i18n.changeLanguage(lang)
    const statistic: SurveyResidualStatisticV1 = { ...basis, status: 'not-testable', reason: 'residual-variance-unresolved' }
    await act(async () => root.render(createElement(ResidualStatisticCell, { statistic, legacyValue: 0 })))
    expect(host.textContent).toContain(i18n.t('surveyStatisticNotTestable'))
    expect(host.textContent).toContain(i18n.t('surveyStatisticVarianceUnresolved'))
    expect(host.textContent).not.toContain('0.0000')
    await act(async () => root.render(createElement(ResidualStatisticCell, { legacyValue: 0 })))
    expect(host.textContent).toContain(i18n.t('surveyStatisticLegacy'))
    expect(host.querySelector('[class*="green"]')).toBeNull()
  })

  it('renders deterministic variance and standard-deviation scales separately without granting conformance', async () => {
    await i18n.changeLanguage('en')
    const summary: SurveyStatisticalSummaryV1 = { schemaVersion: 1, scope: 'descriptive-screening', numericalStatus: 'clear',
      availableCount: 5, unavailableCount: 0, flaggedCount: 0, varianceBasis: 'estimated-posterior',
      varianceLog10RatioToUnit: -8, standardDeviationLog10RatioToUnit: -4, significance: 'not-evaluated', standardsConformity: 'not-evaluated' }
    await act(async () => root.render(createElement(SurveyAdjustmentStatistics, { summary })))
    expect(host.textContent).toContain('variance -8.000, standard deviation -4.000')
    expect(host.textContent).toContain('Significance and standards conformity are not evaluated')
    expect(host.textContent).toContain('Available 5 · Not testable 0 · Review 0')
  })

  it('uses the recorded threshold decision rather than independently reclassifying a legacy ratio', async () => {
    const statistic: SurveyResidualStatisticV1 = { ...basis, status: 'available', value: 4, threshold: 3, thresholdExceeded: true }
    await act(async () => root.render(createElement(ResidualStatisticCell, { statistic, legacyValue: 0 })))
    expect(host.textContent).toContain('4.0000')
    expect(host.querySelector('[class*="text-red"]')).not.toBeNull()
  })
})
