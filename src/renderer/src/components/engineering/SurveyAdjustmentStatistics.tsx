import { useTranslation } from 'react-i18next'
import type { SurveyResidualStatisticV1, SurveyStatisticalSummaryV1 } from '@shared/survey-statistical-semantics'

const methodKeys = {
  'observation-sigma-ratio': 'surveyStatisticObservationRatio',
  'weight-normalized-residual': 'surveyStatisticWeightRatio',
  'residual-sigma-ratio': 'surveyStatisticResidualRatio'
} as const
const basisKeys = {
  'declared-prior': 'surveyStatisticDeclaredPrior',
  'default-prior': 'surveyStatisticDefaultPrior',
  'relative-weight': 'surveyStatisticRelativeWeight',
  'estimated-posterior': 'surveyStatisticPosterior',
  'prior-fallback': 'surveyStatisticPriorFallback',
  'not-estimated': 'surveyStatisticNotEstimated'
} as const
const reasonKeys = {
  'no-redundancy': 'surveyStatisticNoRedundancy',
  'residual-variance-unresolved': 'surveyStatisticVarianceUnresolved',
  'numeric-unavailable': 'surveyStatisticNumericUnavailable'
} as const
const statusKeys = {
  clear: 'surveyStatisticClear',
  'review-required': 'surveyReviewNeeded',
  incomplete: 'surveyStatisticIncomplete',
  'not-evaluated': 'surveyStatisticNotEvaluated'
} as const

export function ResidualStatisticCell({ statistic, legacyValue }: { statistic?: SurveyResidualStatisticV1; legacyValue?: number }) {
  const { t } = useTranslation('common')
  if (!statistic) return <div className="text-ds-muted"><p>{legacyValue === undefined ? '—' : legacyValue.toPrecision(5)}</p><p>{t('surveyStatisticLegacy')}</p></div>
  return <div className={statistic.status === 'available' && statistic.thresholdExceeded ? 'text-red-700 dark:text-red-300' : 'text-ds-muted'}>
    <p className="font-medium">{statistic.status === 'available' ? statistic.value.toPrecision(5) : t('surveyStatisticNotTestable')}</p>
    <p>{t(methodKeys[statistic.method])} · {t(basisKeys[statistic.scaleBasis])}</p>
    {statistic.status === 'not-testable' ? <p>{t(reasonKeys[statistic.reason])}</p> : null}
  </div>
}

export function SurveyAdjustmentStatistics({ summary }: { summary?: SurveyStatisticalSummaryV1 }) {
  const { t } = useTranslation('common')
  return <section aria-label={t('surveyStatisticScope')} className="mt-3 border border-ds-border-muted bg-ds-card px-3 py-2 text-[11px] leading-5 text-ds-muted">
    <p className="font-medium text-ds-ink">{summary ? t(statusKeys[summary.numericalStatus]) : t('surveyStatisticLegacy')}</p>
    {summary ? <>
      <p>{t('surveyStatisticCounts', { available: summary.availableCount, unavailable: summary.unavailableCount, flagged: summary.flaggedCount })} · {t(basisKeys[summary.varianceBasis])}</p>
      {summary.varianceLog10RatioToUnit !== null && summary.standardDeviationLog10RatioToUnit !== null ? <p>{t('surveyStatisticOrders', { variance: summary.varianceLog10RatioToUnit.toFixed(3), deviation: summary.standardDeviationLog10RatioToUnit.toFixed(3) })}</p> : null}
    </> : null}
    <p>{t('surveyStatisticBoundary')}</p>
  </section>
}
