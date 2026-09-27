import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { SurveyReferenceDatumOutputV1 } from '@shared/survey-advanced-trials'
import { EngineeringEvidenceQuestion } from './EngineeringEvidenceQuestion'

const cell = 'break-words border-b border-ds-border-muted px-2 py-2 text-left align-top'
const scroll = 'max-h-96 max-w-full overflow-auto rounded border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const failureKeys: Record<string, string> = {
  'covariance-not-symmetric': 'advancedReferenceAsymmetric',
  'covariance-not-positive-semidefinite': 'advancedReferenceIndefinite',
  'covariance-scale-outside-supported-domain': 'advancedReferenceScale',
  'covariance-eigensolver-iteration-limit': 'advancedReferenceEigenLimit',
  'reference-covariance-rank-or-conditioning': 'advancedReferenceRank',
  'numeric-range-or-resolution': 'advancedNumerical'
}

export function SurveyReferenceDatumResult({ result }: { result: SurveyReferenceDatumOutputV1 }): ReactElement {
  const { t } = useTranslation('common')
  if (result.outcome === 'invalid-input') return <p role="alert">{t('advancedInvalidInput')}</p>
  const { request } = result
  return <section className="min-w-0 space-y-3" aria-label={t('advancedReferenceResults')}>
    <h4 className="font-semibold">{t('advancedReferenceResults')}<EngineeringEvidenceQuestion label={t('advancedReferenceResults')} selector={{ path: ['result'] }} /></h4>
    <p role="status">{t(result.outcome === 'calculated' ? 'advancedCalculated' : failureKeys[result.code])}</p>
    <p className="leading-5 text-ds-muted">{t('advancedReferenceBoundary')}</p>
    <p>{t(request.method === 'gls-reference-mean' ? 'advancedReferenceGls' : 'advancedReferenceEqual')}</p>
    <p className="break-words">{t('advancedReferenceEpochs', { first: request.firstEpoch.id, second: request.secondEpoch.id })}</p>
    <p>{t(request.dependence.kind === 'caller-declared-independent' ? 'advancedReferenceIndependent' : 'advancedReferenceDependent')}</p>
    <p className="break-words">{t('advancedReferenceSet', { ids: request.referenceIds.join(', ') })}</p>
    {result.covarianceCheck ? <p className="leading-5" role="status">{t(result.covarianceCheck.classification === 'numerically-positive-definite' ? 'advancedReferencePositive' : 'advancedReferenceUnresolved')}</p> : null}
    {result.outcome === 'calculated' ? <>
      <p>{t('advancedReferenceShift', { shift: String(result.referenceShift), variance: String(result.referenceShiftVariance), unit: result.unit })}</p>
      <div className={scroll} role="region" tabIndex={0} aria-label={t('advancedReferencePoints')}><table className="w-full text-[11px]">
        <caption className="px-2 py-2 text-left">{t('advancedReferenceConvention')}</caption>
        <thead><tr>{['advancedReferencePoint', 'advancedReferenceRawDifference', 'advancedReferenceWeight', 'advancedReferenceDisplacement', 'advancedReferenceShiftCovariance'].map(key => <th className={cell} scope="col" key={key}>{t(key)}{key === 'advancedReferenceRawDifference' || key === 'advancedReferenceDisplacement' ? ` (${result.unit})` : key === 'advancedReferenceShiftCovariance' ? ` (${result.unit}²)` : ''}</th>)}</tr></thead>
        <tbody>{result.pointIds.map((id, i) => <tr key={id}><th className={cell} scope="row">{id}<span className="block font-normal">{request.mapping[i]!.firstPointId} → {request.mapping[i]!.secondPointId}</span></th>{[result.rawDifferences[i], result.referenceWeights[i], result.displacements[i], result.shiftDisplacementCovariance[i]].map((value, j) => <td key={j} className={`${cell} font-mono`}>{String(value)}</td>)}</tr>)}</tbody>
      </table></div>
      {([{ key: 'advancedReferenceDifferenceCovariance', values: result.differenceCovariance }, { key: 'advancedReferenceDisplacementCovariance', values: result.displacementCovariance }] as const).map(({ key, values }) => <div className={scroll} key={key} role="region" tabIndex={0} aria-label={t(key)}><table className="w-full text-[11px]">
        <caption className="px-2 py-2 text-left">{t(key)} ({result.unit}²)</caption>
        <thead><tr><th scope="col" className={cell}>{t('advancedReferencePoint')}</th>{result.pointIds.map(id => <th key={id} scope="col" className={cell}>{id}</th>)}</tr></thead>
        <tbody>{values.map((row, i) => <tr key={result.pointIds[i]}><th scope="row" className={cell}>{result.pointIds[i]}</th>{row.map((value, j) => <td key={j} className={`${cell} font-mono`}>{String(value)}</td>)}</tr>)}</tbody>
      </table></div>)}
      <p className="leading-5 text-ds-muted">{t('advancedReferenceResolution', { coordinate: String(result.numerical.coordinateRoundoffEstimate), covariance: String(result.numerical.covarianceRoundoffEstimate), unit: result.unit })}</p>
    </> : null}
  </section>
}
