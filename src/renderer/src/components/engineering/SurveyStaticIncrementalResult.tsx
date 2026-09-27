import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { SurveyStaticIncrementalOutputV1 } from '@shared/survey-advanced-trials'
import { EngineeringEvidenceQuestion } from './EngineeringEvidenceQuestion'

const cell = 'break-words border-b border-ds-border-muted px-2 py-2 text-left align-top'
const scroll = 'max-h-96 max-w-full overflow-auto rounded border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const failureKeys: Record<string, string> = {
  'base-fingerprint-mismatch': 'advancedStaticStale', 'variance-ratio-outside-supported-domain': 'advancedStaticVariance',
  'base-rank-or-conditioning': 'advancedStaticBaseRank', 'updated-rank-or-conditioning': 'advancedStaticUpdatedRank',
  'numeric-range-or-resolution': 'advancedNumerical', 'incremental-batch-disagreement': 'advancedStaticDisagreement'
}
export function SurveyStaticIncrementalResult({ result }: { result: SurveyStaticIncrementalOutputV1 }): ReactElement {
  const { t } = useTranslation('common')
  if (result.outcome === 'invalid-input') return <p role="alert">{t('advancedInvalidInput')}</p>
  const { request } = result
  return <section className="min-w-0 space-y-3" aria-label={t('advancedStaticResults')}>
    <h4 className="font-semibold">{t('advancedStaticResults')}</h4>
    <p role="status">{t(result.outcome === 'calculated' ? 'advancedCalculated' : failureKeys[result.code])}</p>
    <p className="leading-5 text-ds-muted">{t('advancedStaticBoundary')}</p>
    <p>{t('advancedStaticCounts', { base: request.base.observations.length, appended: request.append.observations.length, total: request.base.observations.length + request.append.observations.length })}</p>
    <p className="break-all">{t('advancedStaticRevisions', { network: request.base.networkId, base: request.base.revision, next: request.append.nextRevision })}</p>
    <p className="leading-5">{t('advancedStaticAssumptions')}</p>
    <dl className="space-y-2 break-all text-[11px]">
      <div><dt>{t('advancedStaticBaseFingerprint')}</dt><dd className="font-mono">{result.computedBaseFingerprint}</dd></div>
      {result.outcome === 'calculated' ? <div><dt>{t('advancedStaticFinalFingerprint')}</dt><dd className="font-mono">{result.finalFingerprint}</dd></div> : null}
    </dl>
    {result.outcome === 'calculated' ? <>
      <div className={scroll} role="region" tabIndex={0} aria-label={t('advancedStaticParameters')}><table className="w-full text-[11px]">
        <caption className="px-2 py-2 text-left">{t('advancedStaticParameters')} ({result.unit})</caption>
        <thead><tr>{['advancedStaticParameter', 'advancedStaticBase', 'advancedStaticUpdated', 'advancedStaticBatch'].map(key => <th className={cell} scope="col" key={key}>{t(key)}</th>)}</tr></thead>
        <tbody>{result.parameterIds.map((id, i) => <tr key={id}><th className={cell} scope="row">{id}</th>{[result.baseFit.parameters[i], result.updatedFit.parameters[i], result.batchCheck.referenceFit.parameters[i]].map((value, j) => <td className={`${cell} font-mono`} key={j}>{String(value)}</td>)}</tr>)}</tbody>
      </table></div>
      {([{ key: 'advancedStaticBaseCovariance', fit: result.baseFit }, { key: 'advancedStaticUpdatedCovariance', fit: result.updatedFit }] as const).map(({ key, fit }) => <div className={scroll} key={key} role="region" tabIndex={0} aria-label={t(key)}><table className="w-full text-[11px]">
        <caption className="px-2 py-2 text-left">{t(key)} ({result.unit}²)</caption>
        <thead><tr><th className={cell} scope="col">{t('advancedStaticParameter')}</th>{result.parameterIds.map(id => <th className={cell} key={id} scope="col">{id}</th>)}</tr></thead>
        <tbody>{fit.aprioriParameterCovariance.map((row, i) => <tr key={result.parameterIds[i]}><th className={cell} scope="row">{result.parameterIds[i]}</th>{row.map((value, j) => <td key={j} className={`${cell} font-mono`}>{String(value)}</td>)}</tr>)}</tbody>
      </table></div>)}
      <p className="leading-5">{t('advancedStaticPosterior', { sse: String(result.updatedFit.weightedResidualSumSquares), df: result.updatedFit.degreesOfFreedom, posterior: String(result.updatedFit.posteriorVarianceFactorEstimate) })}</p>
      <h5 className="font-medium">{t('advancedStaticSteps')}</h5>
      <div className={scroll} role="region" tabIndex={0} aria-label={t('advancedStaticSteps')}><table className="w-full text-[11px]">
        <thead><tr>{['advancedStaticObservation', 'advancedStaticTotal', 'advancedStaticResidual', 'advancedStaticResidualNorm', 'advancedStaticState'].map(key => <th className={cell} scope="col" key={key}>{t(key)}</th>)}</tr></thead>
        <tbody>{result.steps.map((step, index) => <tr key={step.observationId}><th className={cell} scope="row">{step.observationId}<EngineeringEvidenceQuestion label={step.observationId} selector={{ path: ['result', 'steps', index], identity: { observationId: step.observationId } }} /></th><td className={cell}>{step.totalObservationCount}</td><td className={cell}>{String(step.transformedResidual)}</td><td className={cell}>{String(step.accumulatedResidualNorm)}</td><td className={`${cell} max-w-72 break-all font-mono`}>{step.stateSha256}<details><summary className="cursor-pointer">{t('advancedStaticRotations')}</summary><p className="break-all">cos: {step.rotationCosines.map(String).join(', ')}</p><p className="break-all">sin: {step.rotationSines.map(String).join(', ')}</p></details></td></tr>)}</tbody>
      </table></div>
      <p className="leading-5">{t('advancedStaticComparison', { parameters: String(result.batchCheck.maximumScaledParameterDifference), covariance: String(result.batchCheck.maximumScaledCovarianceDifference), sse: String(result.batchCheck.scaledSseDifference), tolerance: result.batchCheck.relativeTolerance })}</p>
      <p className="leading-5 text-ds-muted">{t('advancedStaticComparisonBoundary')}</p>
      <details><summary className="cursor-pointer py-2">{t('advancedStaticQrStates')}</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px]" tabIndex={0}>{JSON.stringify({ base: result.baseQrState, updated: result.updatedQrState }, null, 2)}</pre></details>
    </> : null}
  </section>
}
