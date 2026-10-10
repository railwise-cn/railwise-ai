// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { advancedTrialTestRequest } from '../../../../../kun/src/engineering/survey-advanced-trials-test-helpers'
import { appendSurveyStaticLinearObservationsV1 } from '../../../../../kun/src/engineering/survey-static-incremental'
import i18n from '../../i18n'
import { SurveyStaticIncrementalResult } from './SurveyStaticIncrementalResult'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

function calculatedResult() {
  const model = JSON.parse(advancedTrialTestRequest('static-incremental').declarationJson)
  const result = appendSurveyStaticLinearObservationsV1(model)
  if (result.outcome !== 'calculated') throw new Error(`Expected a calculated fixture, got ${result.outcome}`)
  return result
}

function baseMismatchResult() {
  const model = JSON.parse(advancedTrialTestRequest('static-incremental').declarationJson)
  model.base.observations[0].value += 1
  const result = appendSurveyStaticLinearObservationsV1(model)
  if (result.outcome !== 'unavailable') throw new Error(`Expected an unavailable fixture, got ${result.outcome}`)
  return result
}

describe('static incremental result presentation', () => {
  it.each(['en', 'zh'])('distinguishes source height-difference linearization from declared observations in %s', async language => {
    await i18n.changeLanguage(language)
    const result = calculatedResult()
    await act(async () => root.render(createElement(SurveyStaticIncrementalResult, { result, sourceBound: true })))
    const table = host.querySelector(`[aria-label="${i18n.t('advancedStaticObservation')}"]`)!
    expect(table.querySelectorAll('thead th')[1].textContent).toBe(i18n.t('advancedStaticLinearizedValue'))
    expect(host.textContent).toContain(i18n.t('advancedStaticLinearizedValueMeaning'))
    const values = [...table.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td')[0].textContent)
    await act(async () => root.render(createElement(SurveyStaticIncrementalResult, { result })))
    const declaredTable = host.querySelector(`[aria-label="${i18n.t('advancedStaticObservation')}"]`)!
    expect(declaredTable.querySelectorAll('thead th')[1].textContent).toBe(i18n.t('surveyObservationValue'))
    expect(host.textContent).not.toContain(i18n.t('advancedStaticLinearizedValueMeaning'))
    expect([...declaredTable.querySelectorAll('tbody tr')].map(row => row.querySelectorAll('td')[0].textContent)).toEqual(values)
  })

  it.each(['en', 'zh'])('keeps professional metrics and hides algorithm diagnostics in %s', async language => {
    await i18n.changeLanguage(language)
    const result = calculatedResult()
    await act(async () => root.render(createElement(SurveyStaticIncrementalResult, { result })))

    expect(host.textContent).toContain(i18n.t('advancedStaticCounts', { base: 3, appended: 2, total: 5 }))
    expect(host.textContent).toContain(i18n.t('advancedStaticParameters'))
    expect(host.textContent).toContain(language === 'en' ? 'Weighted residual sum of squares' : '加权残差平方和')
    expect(host.textContent).toContain(i18n.t('advancedCalculated'))
    expect(host.querySelector('[data-testid="survey-static-comparison-status"]')?.getAttribute('data-comparison')).toBe('passed')
    expect(host.textContent).not.toMatch(/fingerprint|Householder|Givens|QR state|rotation coefficients|policy tolerance|指纹|Householder|Givens|QR 状态|旋转系数|策略阈值/i)
    expect(host.querySelector('[aria-label="Per-observation update state"]')).toBeNull()
    expect(host.querySelectorAll('pre')).toHaveLength(0)
  })

  it.each(['en', 'zh'])('describes a changed model without exposing its internal fingerprint in %s', async language => {
    await i18n.changeLanguage(language)
    await act(async () => root.render(createElement(SurveyStaticIncrementalResult, { result: baseMismatchResult() })))

    expect(host.textContent).toContain(i18n.t('advancedInvalidInput'))
    expect(host.textContent).not.toMatch(/fingerprint|SHA-256|hash|指纹|哈希/i)
    expect(host.querySelector('[aria-label="Parameter comparison"]')).toBeNull()
  })
})
