import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { SurveyStaticIncrementalOutputV1 } from '@shared/survey-advanced-trials'
import { EngineeringEvidenceQuestion } from './EngineeringEvidenceQuestion'

const cell = 'break-words border-b border-ds-border-muted px-2 py-2 text-left align-top'
const scroll = 'max-h-96 max-w-full overflow-auto rounded border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const failureKeys: Record<string, string> = {
  'base-fingerprint-mismatch': 'advancedInvalidInput', 'variance-ratio-outside-supported-domain': 'advancedStaticVariance',
  'base-rank-or-conditioning': 'advancedStaticBaseRank', 'updated-rank-or-conditioning': 'advancedStaticUpdatedRank',
  'numeric-range-or-resolution': 'advancedNumerical', 'incremental-batch-disagreement': 'advancedStaticDisagreement'
}
export function SurveyStaticIncrementalResult({ result, sourceBound = false }: { result: SurveyStaticIncrementalOutputV1; sourceBound?: boolean }): ReactElement {
  const { t, i18n } = useTranslation('common')
  if (result.outcome === 'invalid-input') return <p role="alert">{t('advancedInvalidInput')}</p>
  const { request } = result
  const number = (value: number): string => value !== 0 && Math.abs(value) < 1e-5
    ? value.toExponential(4) : value.toLocaleString(i18n.language, { maximumSignificantDigits: 8 })
  const comparisonPassed = result.outcome === 'calculated'
  return <section className="min-w-0 space-y-3" aria-label={t('advancedStaticResults')}>
    <h4 className="font-semibold">{t('advancedStaticResults')}</h4>
    <p role="status" data-testid="survey-static-comparison-status" data-comparison={comparisonPassed ? 'passed' : 'not-passed'}>
      {t(comparisonPassed ? 'advancedCalculated' : failureKeys[result.code])}
    </p>
    <p className="leading-5 text-ds-muted">{t('advancedBoundary')}</p>
    <p>{t('advancedStaticCounts', { base: request.base.observations.length, appended: request.append.observations.length, total: request.base.observations.length + request.append.observations.length })}</p>
    <p className="leading-5">{t('advancedStaticAssumptions')}</p>
    {result.outcome === 'calculated' ? <>
      <div className={scroll} role="region" tabIndex={0} aria-label={t('advancedStaticParameters')}><table className="w-full text-[11px]">
        <caption className="px-2 py-2 text-left">{t('advancedStaticParameters')} ({result.unit})</caption>
        <thead><tr>{['advancedStaticParameter', 'advancedStaticBase', 'advancedStaticUpdated', 'advancedStaticBatch'].map(key => <th className={cell} scope="col" key={key}>{t(key)}</th>)}</tr></thead>
        <tbody>{result.parameterIds.map((id, i) => <tr key={id}><th className={cell} scope="row">{id}</th>{[result.baseFit.parameters[i], result.updatedFit.parameters[i], result.batchCheck.referenceFit.parameters[i]].map((value, j) => <td className={`${cell} font-mono`} key={j}>{number(value!)}</td>)}</tr>)}</tbody>
      </table></div>
      {([{ key: 'advancedStaticBaseCovariance', fit: result.baseFit }, { key: 'advancedStaticUpdatedCovariance', fit: result.updatedFit }] as const).map(({ key, fit }) => <div className={scroll} key={key} role="region" tabIndex={0} aria-label={t(key)}><table className="w-full text-[11px]">
        <caption className="px-2 py-2 text-left">{t(key)} ({result.unit}²)</caption>
        <thead><tr><th className={cell} scope="col">{t('advancedStaticParameter')}</th>{result.parameterIds.map(id => <th className={cell} key={id} scope="col">{id}</th>)}</tr></thead>
        <tbody>{fit.aprioriParameterCovariance.map((row, i) => <tr key={result.parameterIds[i]}><th className={cell} scope="row">{result.parameterIds[i]}</th>{row.map((value, j) => <td key={j} className={`${cell} font-mono`}>{number(value)}</td>)}</tr>)}</tbody>
      </table></div>)}
      <p className="leading-5">{t('advancedStaticPosterior', { sse: number(result.updatedFit.weightedResidualSumSquares), df: result.updatedFit.degreesOfFreedom, posterior: number(result.updatedFit.posteriorVarianceFactorEstimate) })}</p>
      <h5 className="font-medium">{t('advancedStaticObservation')}</h5>
      {sourceBound ? <p className="leading-5 text-ds-muted">{t('advancedStaticLinearizedValueMeaning')}</p> : null}
      <div className={scroll} role="region" tabIndex={0} aria-label={t('advancedStaticObservation')}><table className="w-full text-[11px]">
        <thead><tr>{['surveyObservationId', sourceBound ? 'advancedStaticLinearizedValue' : 'surveyObservationValue', 'advancedHuberResidual'].map(key => <th className={cell} scope="col" key={key}>{t(key)}</th>)}</tr></thead>
        <tbody>{request.append.observations.map((observation, index) => {
          const residualIndex = request.base.observations.length + index
          return <tr key={observation.id}>
            <th className={cell} scope="row">{observation.id}<EngineeringEvidenceQuestion label={observation.id} selector={{ path: ['result', 'steps', index], identity: { observationId: observation.id } }} /></th>
            <td className={cell}>{number(observation.value)} {result.unit}</td>
            <td className={cell}>{number(result.updatedFit.residuals[residualIndex]!)} {result.unit}</td>
          </tr>
        })}</tbody>
      </table></div>
    </> : null}
  </section>
}
