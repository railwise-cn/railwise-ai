import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { QualityExactValue, QualityRuleResultV1, SurveyQualityScoringOutputV1 } from '@shared/survey-quality-scoring'
import { SurveyStandardBasis } from './SurveyStandardBasis'
import { scoringStandardBasisContext } from '../../agent/survey-standard-basis-client'
import { EngineeringEvidenceQuestion, type EngineeringEvidenceSelection } from './EngineeringEvidenceQuestion'

// Never round or coerce exact fractions to Number when displaying a decision.
const exact = (value: QualityExactValue | null): string => value ? `${value.numerator}/${value.denominator}` : '—'
const metricKeys = ['score', 'rawScore', 'fixedADeduction', 'diagnosticScoreUpperBound', 'excellentRate', 'excellentGoodRate'] as const
export function QualityScoringResult({ result, evidence, runtimeReady = true }: { result: SurveyQualityScoringOutputV1; evidence?: Extract<EngineeringEvidenceSelection, { kind: 'scoring' }>; runtimeReady?: boolean }): ReactElement {
  const { t } = useTranslation('qualityScoring')
  const value = result.result
  const fields = (record: QualityRuleResultV1, path: Array<string | number>, identity?: Record<string, string>) => metricKeys.filter(key => record[key] !== null).map(key => <div key={key} className="min-w-0"><dt className="text-ds-muted">{t(`metrics.${key}`)}{evidence ? <EngineeringEvidenceQuestion label={t(`metrics.${key}`)} reference={evidence} selector={{ path: [...path, key], ...(identity ? { identity } : {}) }} disabled={!runtimeReady} /> : null}</dt><dd className="break-all font-mono">{exact(record[key])}</dd></div>)
  return <section className="min-w-0 space-y-3" aria-label={t('scoringResult')}>
    <h5 className="font-semibold">{t('scoringResult')}{evidence ? <EngineeringEvidenceQuestion label={t('scoringResult')} reference={evidence} selector={{ path: ['result'] }} disabled={!runtimeReady} /> : null}</h5>
    <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100">
      <p className="font-semibold">{t(`scopes.${result.scopeAssessment}`)}</p>
      <p>{t(`states.${value.state}`)}</p>
      <p className="leading-5">{t('scoringResultBoundary')}</p>
    </div>
    <p className="leading-5">{t(`reasons.${value.reason}`, { defaultValue: value.reason })}</p>
    <dl className="grid min-w-0 gap-3 sm:grid-cols-2">{fields(value, ['result', 'result'])}
      {value.grade ? <div><dt className="text-ds-muted">{t(result.scopeAssessment === 'partial-declared-product-profile' ? 'scoringPartialGrade' : 'scoringGrade')}</dt><dd>{t(`grades.${value.grade}`)}</dd></div> : null}
      {value.qualified !== null ? <div><dt className="text-ds-muted">{t('scoringDeclaredQualification')}</dt><dd>{t(value.qualified ? 'scoringDeclaredYes' : 'scoringDeclaredNo')}</dd></div> : null}
      {value.count !== null ? <div><dt className="text-ds-muted">{t('scoringBatchCount')}</dt><dd>{value.count}</dd></div> : null}
    </dl>
    <p className="leading-5 text-ds-muted">{t('scoringExactHint')}</p>
    {(['checkedSubelementIds', 'pendingSubelementIds', 'excludedSubelementIds'] as const).map(key => result[key].length ? <p key={key} className="break-words leading-5"><strong>{t(key)}</strong>：{result[key].map(id => t(`nodes.${id}`, { defaultValue: id })).join(' · ')}</p> : null)}
    <details><summary className="cursor-pointer py-2">{t('scoringTrace')}</summary>
      <div role="region" tabIndex={0} aria-label={t('scoringTrace')} className="max-h-96 max-w-full overflow-auto rounded border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        <table className="min-w-full text-left text-[11px]"><thead><tr>{['scoringNode', 'scoringClause', 'scoringState', 'scoringValues', 'scoringOriginalWeight', 'scoringEffectiveWeight'].map(key => <th key={key} className="border-b border-ds-border-muted px-3 py-2 font-medium">{t(key)}</th>)}</tr></thead>
          <tbody>{result.trace.map((row, index) => <tr key={`${row.nodeId}-${index}`}><td className="max-w-48 break-all border-b border-ds-border-muted px-3 py-2">{t(`nodes.${row.nodeId}`, { defaultValue: row.nodeId })}{evidence ? <EngineeringEvidenceQuestion label={`${row.nodeId} · ${row.clause}`} reference={evidence} selector={{ path: ['result', 'trace', index], identity: { nodeId: row.nodeId, clause: row.clause } }} disabled={!runtimeReady} /> : null}</td><td className="border-b border-ds-border-muted px-3 py-2">{row.clause}</td><td className="min-w-48 border-b border-ds-border-muted px-3 py-2"><p>{t(`states.${row.result.state}`)}</p><p className="mt-1 text-ds-muted">{t(`reasons.${row.result.reason}`, { defaultValue: row.result.reason })}</p></td><td className="min-w-40 border-b border-ds-border-muted px-3 py-2"><dl className="space-y-2">{fields(row.result, ['result', 'trace', index, 'result'], { nodeId: row.nodeId, clause: row.clause })}</dl></td><td className="max-w-48 break-all border-b border-ds-border-muted px-3 py-2 font-mono">{exact(row.originalWeight)}</td><td className="max-w-48 break-all border-b border-ds-border-muted px-3 py-2 font-mono">{exact(row.effectiveWeight)}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
    <SurveyStandardBasis context={scoringStandardBasisContext(result)} runtimeReady={runtimeReady} parent={evidence} />
  </section>
}
