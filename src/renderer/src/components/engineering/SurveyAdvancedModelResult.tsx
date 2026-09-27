import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { SurveyGeneralizedWResultV1, SurveyVceTrialOutputV1, SurveyHuberTrialOutputV1, SurveyStatisticalFamilyOutputV1 } from '@shared/survey-advanced-trials'
import { EngineeringEvidenceQuestion } from './EngineeringEvidenceQuestion'

const number = (value: number): string => Number(value.toPrecision(12)).toString()
const cell = 'break-words border-b border-ds-border-muted px-2 py-2 text-left align-top'
const scroll = 'max-h-96 max-w-full overflow-auto rounded border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
export const advancedOutcomeKeys: Record<string, string> = {
  calculated: 'advancedCalculated', stationary: 'advancedStationary', evaluated: 'advancedEvaluated', 'rank-or-conditioning': 'advancedFunctionalRank',
  resolved: 'advancedResolved', unavailable: 'advancedUnresolved', converged: 'advancedConverged',
  'invalid-input': 'advancedInvalidInput', 'functional-rank-or-conditioning': 'advancedFunctionalRank',
  'stochastic-rank-or-conditioning': 'advancedStochasticRank', 'numerical-boundary': 'advancedNumerical',
  'nonpositive-component': 'advancedNonpositive', 'iteration-limit': 'advancedIterationLimit',
  'insufficient-residual-degrees-of-freedom': 'advancedNoRedundancy',
  'covariance-not-symmetric-positive-definite-or-numerically-unresolved': 'advancedCovarianceInvalid',
  'design-not-full-rank-or-numerically-unresolved': 'advancedFunctionalRank',
  'numeric-range-or-backward-error': 'advancedNumerical'
}

function Values({ title, ids, values }: { title: string; ids: string[]; values: number[] }): ReactElement {
  return <div className={scroll} role="region" aria-label={title} tabIndex={0}><table className="w-full text-[11px]"><caption className="px-2 py-2 text-left font-medium">{title}</caption><tbody>{ids.map((id, i) => <tr key={id}><th scope="row" className={cell}>{id}</th><td className={`${cell} font-mono tabular-nums`}>{number(values[i]!)}</td></tr>)}</tbody></table></div>
}

export function GeneralizedWResult({ result }: { result: SurveyGeneralizedWResultV1 }): ReactElement {
  const { t } = useTranslation('common')
  return <section className="min-w-0 space-y-3" aria-label={t('advancedWResults')}>
    <h4 className="font-semibold">{t('advancedWResults')}</h4>
    <p role="status">{t(result.modelStatus === 'resolved' ? 'advancedResolved' : advancedOutcomeKeys[result.reason])}</p>
    <p className="leading-5 text-ds-muted">{t('advancedWNoDecision')}</p>
    {result.modelStatus === 'resolved' ? <>
      <p>{t('advancedRankDf', { rank: result.rank, df: result.degreesOfFreedom })} · {t('advancedEnergy')}: {number(result.aprioriWeightedResidualSum)}</p>
      <div className={scroll} role="region" aria-label={t('advancedDirections')} tabIndex={0}><table className="w-full text-[11px]"><caption className="px-2 py-2 text-left font-medium">{t('advancedDirections')}</caption><thead><tr>{['advancedDirection', 'advancedStatus', 'advancedSignedW', 'advancedDetectability', 'advancedStatisticError'].map(key => <th scope="col" className={cell} key={key}>{t(key)}</th>)}</tr></thead><tbody>{result.diagnostics.map((direction, index) => <tr key={direction.id}><th scope="row" className={cell}>{direction.id}<EngineeringEvidenceQuestion label={direction.id} selector={{ path: ['result', 'diagnostics', index], identity: { id: direction.id } }} /></th><td className={cell}>{t(direction.status === 'resolved' ? 'advancedResolved' : 'advancedUndetectable')}</td><td className={`${cell} font-mono`}>{direction.generalizedW === null ? t('advancedNotComputed') : number(direction.generalizedW)}</td><td className={`${cell} font-mono`}>{number(direction.detectabilityRatio)}</td><td className={`${cell} font-mono`}>{direction.status === 'resolved' ? number(direction.statisticErrorEstimate) : '—'}</td></tr>)}</tbody></table></div>
      <Values title={t('advancedParameters')} ids={result.request.parameterIds.map((id, i) => `${id} (${result.request.parameterUnits[i]})`)} values={result.parameters} />
      <Values title={t('advancedResiduals', { unit: result.request.observationUnit })} ids={result.request.observationIds} values={result.residuals} />
      <div className={scroll} role="region" aria-label={t('advancedFullCovariance')} tabIndex={0}><table className="w-full text-[11px]"><caption className="px-2 py-2 text-left font-medium">{t('advancedFullCovariance')} ({result.request.observationUnit}²)</caption><thead><tr><th scope="col" className={cell}>{t('advancedObservation')}</th>{result.request.observationIds.map(id => <th scope="col" className={cell} key={id}>{id}</th>)}</tr></thead><tbody>{result.residualCovariance.map((row, i) => <tr key={result.request.observationIds[i]}><th scope="row" className={cell}>{result.request.observationIds[i]}</th>{row.map((value, j) => <td key={j} className={`${cell} whitespace-nowrap font-mono tabular-nums`}>{number(value)}</td>)}</tr>)}</tbody></table></div>
      <p className="text-ds-muted">{t('advancedConditionEstimates', { whitening: number(result.whiteningConditionEstimate), design: number(result.designConditionEstimate) })}</p>
    </> : null}
  </section>
}

export function VceTrialResult({ result }: { result: SurveyVceTrialOutputV1 }): ReactElement {
  const { t } = useTranslation('common')
  return <section className="min-w-0 space-y-3" aria-label={t('advancedVceResults')}>
    <h4 className="font-semibold">{t('advancedVceResults')}</h4>
    <p role="status">{t(advancedOutcomeKeys[result.outcome])}</p>
    <p className="leading-5 text-ds-muted">{t('advancedVceNoDecision')}</p>
    <p>{t('advancedIterationCount', { count: result.iterations.length, df: result.degreesOfFreedom })}</p>
    {result.convergedVariances ? <Values title={t('advancedAcceptedVariances', { unit: result.squaredUnit })} ids={result.groupIds} values={result.convergedVariances} /> : null}
    {result.finalFit ? <><Values title={t('advancedFinalParameters', { unit: result.unit })} ids={result.parameterIds} values={result.finalFit.parameters} /><Values title={t('advancedResiduals', { unit: result.unit })} ids={result.observationIds} values={result.finalFit.residuals} /></> : null}
    <div className="space-y-2" aria-label={t('advancedIterationTrace')}>{result.iterations.map((iteration, index) => <details key={iteration.iteration} className="min-w-0 rounded border border-ds-border-muted" open={iteration.iteration === result.iterations.length}>
      <summary className="cursor-pointer break-words px-3 py-2">{t('advancedIteration', { index: iteration.iteration, change: number(iteration.relativeChange) })}</summary>
      <div className="min-w-0 space-y-3 px-3 pb-3"><EngineeringEvidenceQuestion label={t('advancedIteration', { index: iteration.iteration, change: number(iteration.relativeChange) })} selector={{ path: ['result', 'iterations', index], identity: { iteration: iteration.iteration } }} />
        <div className={scroll} role="region" aria-label={t('advancedIterationComponents', { index: iteration.iteration })} tabIndex={0}><table className="w-full text-[11px]"><thead><tr>{['advancedGroup', 'advancedCurrentVariance', 'advancedCandidateVariance'].map(key => <th scope="col" className={cell} key={key}>{t(key)}{key === 'advancedGroup' ? '' : ` (${result.squaredUnit})`}</th>)}</tr></thead><tbody>{result.groupIds.map((id, i) => <tr key={id}><th scope="row" className={cell}>{id}</th><td className={`${cell} font-mono`}>{number(iteration.currentVariances[i]!)}</td><td className={`${cell} font-mono ${iteration.candidateVariances[i]! <= 0 ? 'text-amber-900 dark:text-amber-200' : ''}`}>{number(iteration.candidateVariances[i]!)}{iteration.candidateVariances[i]! <= 0 ? ` · ${t('advancedNonpositiveValue')}` : ''}</td></tr>)}</tbody></table></div>
        <p className="text-ds-muted">{t('advancedIterationCondition', { functional: number(iteration.fit.functionalNormalConditionInfinity), stochastic: number(iteration.stochasticNormalConditionInfinity) })}</p>
        <Values title={t('advancedResiduals', { unit: result.unit })} ids={result.observationIds} values={iteration.fit.residuals} />
      </div>
    </details>)}</div>
  </section>
}


export function HuberTrialResult({ result }: { result: SurveyHuberTrialOutputV1 }): ReactElement {
  const { t } = useTranslation('common'), request = result.request
  const [selectedIteration, setSelectedIteration] = useState<number | null>(null)
  const expandedIteration = selectedIteration ?? result.states.at(-1)?.iteration
  const reasons: Record<string, string> = { 'initial-score': 'advancedHuberInitialScore', 'score-step-objective': 'advancedHuberScoreStep',
    'invalid-input': 'advancedInvalidInput', 'input-design': 'advancedFunctionalRank', 'irls-design': 'advancedHuberIrlsRank',
    'arithmetic-range': 'advancedNumerical', 'objective-increase': 'advancedHuberObjectiveIncrease', 'score-resolution': 'advancedHuberScoreResolution',
    'stagnation-before-score': 'advancedHuberStagnation', 'max-iterations': 'advancedIterationLimit' }
  return <section className="min-w-0 space-y-3" aria-label={t('advancedHuberResults')}>
    <h4 className="font-semibold">{t('advancedHuberResults')}</h4><p role="status">{t(advancedOutcomeKeys[result.outcome])} · {t(reasons[result.reason])}</p>
    <p className="leading-5 text-ds-muted">{t('advancedHuberNoDecision')}</p>
    <p>{t(result.uniquenessAssessment === 'strict-inlier-full-rank-sufficient-condition' ? 'advancedHuberSufficientUniqueness' : 'advancedHuberNoUniqueness')}</p>
    {request ? <><p>{t('advancedHuberScale', { scale: number(request.scale.value), unit: request.scale.unit, k: number(request.loss.k) })}</p><p className="whitespace-pre-wrap break-words">{request.scale.basisStatement}</p>
      <p>{t('advancedHuberStopping', { iterations: request.stopping.maxIterations, score: request.stopping.normalizedScoreTolerance, step: request.stopping.standardizedPredictionStepTolerance, objective: request.stopping.relativeObjectiveTolerance })}</p>
      {result.acceptedParameters ? <Values title={t('advancedParameters')} ids={request.parameterIds.map((id, i) => `${id} (${request.parameterUnits[i]})`)} values={result.acceptedParameters} /> : null}
      <div className="space-y-2" aria-label={t('advancedIterationTrace')}>{result.states.map((state, index) => <details key={state.iteration} className="min-w-0 rounded border border-ds-border-muted" open={state.iteration === expandedIteration} onToggle={event => {
          if (event.currentTarget.open) setSelectedIteration(state.iteration)
          else if (expandedIteration === state.iteration) setSelectedIteration(-1)
        }}>
        <summary className="cursor-pointer break-words px-3 py-2">{t('advancedHuberIteration', { index: state.iteration, objective: number(state.objective), score: number(state.normalizedScoreInfinity) })}</summary>
        {state.iteration === expandedIteration ? <div className="min-w-0 space-y-3 px-3 pb-3"><EngineeringEvidenceQuestion label={t('advancedHuberIteration', { index: state.iteration, objective: number(state.objective), score: number(state.normalizedScoreInfinity) })} selector={{ path: ['result', 'states', index], identity: { iteration: state.iteration } }} /><p>{t('advancedHuberScoreBudget', { budget: number(state.scoreRoundoffEstimate), step: state.standardizedPredictionStep === null ? '—' : number(state.standardizedPredictionStep), change: state.relativeObjectiveChange === null ? '—' : number(state.relativeObjectiveChange) })}</p>
          <div className={scroll} role="region" aria-label={t('advancedHuberObservations')} tabIndex={0}><table className="w-full text-[11px]"><thead><tr>{['advancedObservation', 'advancedHuberResidual', 'advancedHuberStandardized', 'advancedHuberMultiplier', 'advancedHuberWeight'].map(key => <th scope="col" className={cell} key={key}>{t(key)}{key === 'advancedHuberResidual' ? ` (${request.observationUnit})` : key === 'advancedHuberWeight' ? ` (${request.observationUnit}⁻²)` : ''}</th>)}</tr></thead><tbody>{request.observations.map((row, i) => <tr key={row.id}><th scope="row" className={cell}>{row.id}</th>{[state.residuals[i], state.standardizedResiduals[i], state.robustMultipliers[i], state.derivedIrlsWeights[i]].map((value, j) => <td key={j} className={`${cell} font-mono`}>{number(value!)}</td>)}</tr>)}</tbody></table></div>
        </div> : null}
      </details>)}</div></> : null}
  </section>
}

export function StatisticalFamilyResult({ result }: { result: SurveyStatisticalFamilyOutputV1 }): ReactElement {
  const { t } = useTranslation('common')
  const statuses: Record<string, string> = { calculated: 'advancedCalculated', unavailable: 'advancedUnresolved', undetectable: 'advancedUndetectable', 'domain-failure': 'advancedStatisticalDomain', 'numerical-failure': 'advancedNumerical' }
  const distributions: Record<string, string> = { normal: 'advancedDistributionNormal', 'student-t': 'advancedDistributionStudent', 'chi-square': 'advancedDistributionChiSquare' }
  const failureKeys: Record<string, string> = { 'statistic-outside-supported-domain': 'advancedStatisticalDomain', 'probability-below-supported-range': 'advancedProbabilityBelowRange', 'iteration-limit': 'advancedIterationLimit', 'nonfinite-or-invalid-intermediate': 'advancedNumerical', 'critical-value-not-bracketed': 'advancedCriticalUnbracketed' }
  const comparisons: Record<string, string> = { 'p-below-adjusted-alpha': 'advancedStatisticalBelow', 'p-above-adjusted-alpha': 'advancedStatisticalAbove', 'boundary-unresolved': 'advancedStatisticalBoundary' }
  return <section className="min-w-0 space-y-3" aria-label={t('advancedStatisticalResults')}>
    <h4 className="font-semibold">{t('advancedStatisticalResults')}</h4><p role="status">{t(advancedOutcomeKeys[result.outcome])}</p>
    <p className="leading-5 text-ds-muted">{t('advancedStatisticalNoDecision')}</p>
    {result.outcome === 'evaluated' ? <><p>{t('advancedStatisticalFamily', { id: result.request.familyId, count: result.denominator, alpha: number(result.request.alpha), memberAlpha: number(result.memberAlpha) })}</p>
      <div className={scroll} role="region" aria-label={t('advancedStatisticalMembers')} tabIndex={0}><table className="w-full min-w-[64rem] text-[11px]"><thead><tr>{['advancedStatisticalMember', 'advancedStatus', 'advancedDeclaredStatistic', 'advancedStatisticalP', 'advancedStatisticalAdjustedP', 'advancedStatisticalCritical', 'advancedStatisticalComparison'].map(key => <th scope="col" className={cell} key={key}>{t(key)}</th>)}</tr></thead><tbody>{result.results.map((member, i) => { const distribution = result.request.members[i]!.distribution; return <tr key={member.memberId}>
        <th scope="row" className={`${cell} min-w-44`}>{member.memberId}<EngineeringEvidenceQuestion label={member.memberId} selector={{ path: ['result', 'results', i], identity: { memberId: member.memberId } }} /><span className="block font-normal">{t(distributions[distribution.kind])} · {result.request.members[i]!.sourceAnchor}</span>{'degreesOfFreedom' in distribution ? <span className="block font-normal">{t('advancedDistributionDf', { df: distribution.degreesOfFreedom })}</span> : null}{'priorStandardDeviation' in distribution ? <span className="block font-normal">{t('advancedDistributionPriorScale', { sigma: String(distribution.priorStandardDeviation), unit: distribution.scaleUnit })}</span> : null}</th><td className={cell}>{t(statuses[member.status])}{member.status !== 'calculated' ? <span className="block break-all">{'reason' in member ? member.reason === 'not-supplied' ? t('advancedStatisticalNotSupplied') : member.reason : t(failureKeys[member.code])}</span> : null}</td>
        {member.status === 'calculated' ? <><td className={`${cell} font-mono`}>{number(member.statistic)}</td><td className={`${cell} font-mono`}>{number(member.pValue)}</td><td className={`${cell} font-mono`}>{number(member.adjustedPValue)}</td><td className={`${cell} font-mono`}>{String(member.criticalMagnitude)}<span className="block">[{member.numericalResolutionInterval.map(String).join(', ')}]</span></td><td className={cell}>{t(comparisons[member.comparison])}</td></> : <td colSpan={5} className={cell}>{t('advancedNotComputed')}</td>}
      </tr> })}</tbody></table></div><p className="leading-5 text-ds-muted">{t('advancedStatisticalInterval')}</p></> : null}
  </section>
}
