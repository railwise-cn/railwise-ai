// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { diagnoseGeneralizedW } from '../../../../../kun/src/engineering/survey-generalized-w'
import { GeneralizedWResult } from './SurveyAdvancedModelResult'
import i18n from '../../i18n'

const result = diagnoseGeneralizedW({
  schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
  observationUnit: 'm', observationIds: ['S1-A', 'S1-B', 'S1-C'], parameterIds: ['height'], parameterUnits: ['m'],
  designMatrix: [[1], [1], [1]], observations: [0, 11, 2],
  covariance: { kind: 'known-apriori-absolute-observation-covariance', basisStatement: 'Synthetic known covariance.', matrix: [[4, 1, 0], [1, 9, 0], [0, 0, 1]] },
  family: { id: 'internal-family-implementation-id', alpha: .05, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
  biasDirections: [{ id: 'S1-A', coefficients: [1, 0, 0] }, { id: 'all-observations', coefficients: [1, 1, 1] }]
})

function render(value = result): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(createElement(GeneralizedWResult, { result: value }))
  return host
}

describe('professional statistical declaration', () => {
  it.each(['zh', 'en'])('shows the method and unverified assumptions without internal identifiers in %s', async language => {
    await i18n.changeLanguage(language)
    const host = render(), text = host.textContent!
    for (const key of ['advancedDeclarationWModel', 'advancedDeclarationPriorCovariance', 'advancedDeclarationBiasSource', 'advancedDeclarationReviewUnverified', 'advancedDeclarationNoSignoff', 'advancedDeclarationBoundary', 'advancedDeclarationBiasH0', 'advancedDeclarationBiasH1']) expect(text).toContain(i18n.t(key))
    expect(text).toContain('0.05')
    expect(text).toContain('S1-A')
    expect(text).not.toMatch(/fixed-linear-known-covariance|caller-declared-known|not-evaluated|survey\/generalized-w\/family|internal-family-implementation-id|H0[:：]\s*H0/)
    expect(host.querySelector('[aria-label="' + i18n.t('advancedFullCovariance') + '"]')?.querySelectorAll('tbody td')).toHaveLength(9)
    expect(host.querySelector('[aria-label="' + i18n.t('advancedDirections') + '"]')?.textContent).toContain(i18n.t('advancedUndetectable'))
  })

  it.each(['zh', 'en'])('retains custom hypotheses and review limitations without treating a declaration as verified in %s', async language => {
    await i18n.changeLanguage(language)
    const custom = structuredClone(result)
    custom.statisticalDeclaration = {
      status: 'declared', targetPower: .8,
      hypotheses: { h0: 'H0: COSA.in2:6, bias = 0 m.', h1: 'H1: COSA.in2:6, bias ≠ 0 m.', scope: 'per-bias-direction' },
      modelVersion: 'private-model-version-12', covarianceModelVersion: 'private-covariance-version-3',
      testFamily: { id: 'private-family-55', declaration: 'Synthetic family', source: 'private/source/contract-3', alpha: .05, correction: 'bonferroni' },
      humanReview: { status: 'confirmed', declaration: 'Coordinate datum still requires review.', reviewer: 'Reviewer A', recordedAt: '2026-10-02T00:00:00Z' }
    }
    const text = render(custom).textContent!
    for (const key of ['advancedDeclarationSuppliedModel', 'advancedDeclarationSuppliedCovariance', 'advancedDeclarationSuppliedSource', 'advancedDeclarationReviewConfirmed', 'advancedDeclarationBoundary']) expect(text).toContain(i18n.t(key))
    expect(text).toContain('COSA.in2:6, bias = 0 m.')
    expect(text).toContain('COSA.in2:6, bias ≠ 0 m.')
    expect(text).toContain('Coordinate datum still requires review.')
    expect(text).toContain('Bonferroni')
    expect(text).not.toMatch(/private-model-version|private-covariance-version|private-family|private\/source\/contract|not-evaluated/)
  })
})
