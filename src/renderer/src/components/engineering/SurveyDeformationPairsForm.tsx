import { useId, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'

export const MAX_DEFORMATION_PAIRS = 1_000

export type DeformationPairDraft = {
  rowKey: string
  id: string
  firstPointId: string
  secondPointId: string
  kind: 'tilt' | 'convergence'
  distanceMode: 'horizontal' | 'spatial' | 'vertical'
  baseline: string
}

export function parseDeformationPairs(drafts: readonly DeformationPairDraft[]): Array<{
  id: string
  firstPointId: string
  secondPointId: string
  kind: 'tilt' | 'convergence'
  distanceMode: 'horizontal' | 'spatial' | 'vertical'
  baselineM?: number
}> | null {
  if (drafts.length > MAX_DEFORMATION_PAIRS) return null
  const pairs = drafts.map(pair => ({
    id: pair.id.trim(), firstPointId: pair.firstPointId.trim(), secondPointId: pair.secondPointId.trim(),
    kind: pair.kind, distanceMode: pair.distanceMode,
    ...(pair.kind === 'tilt' && pair.baseline.trim() ? { baselineM: Number(pair.baseline) } : {})
  }))
  const names = new Set<string>()
  for (const pair of pairs) {
    if (!pair.id || names.has(pair.id) || !pair.firstPointId || !pair.secondPointId
      || pair.firstPointId === pair.secondPointId
      || (pair.kind === 'tilt' && pair.distanceMode !== 'horizontal')
      || (pair.baselineM !== undefined && (!Number.isFinite(pair.baselineM) || pair.baselineM <= 0))) return null
    names.add(pair.id)
  }
  return pairs
}

export function SurveyDeformationPairsForm({ pairs, disabled, onAdd, onChange }: {
  pairs: readonly DeformationPairDraft[]
  disabled: boolean
  onAdd: () => void
  onChange: (pairs: DeformationPairDraft[]) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const formId = useId()
  const update = (rowKey: string, patch: Partial<DeformationPairDraft>): void => {
    if (!disabled) onChange(pairs.map(pair => pair.rowKey === rowKey ? { ...pair, ...patch } : pair))
  }
  const controlClass = 'mt-1 min-h-11 w-full border border-ds-border bg-ds-main px-2 text-[11px] text-ds-ink disabled:opacity-50'
  return <fieldset disabled={disabled} aria-label={t('surveyPairsTitle')} className="min-w-0 lg:col-span-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-[11px] font-medium text-ds-muted">{t('surveyPairsTitle')}</p>
      <button type="button" disabled={disabled || pairs.length >= MAX_DEFORMATION_PAIRS} onClick={onAdd} className="inline-flex min-h-11 items-center gap-2 border border-ds-border px-3 text-[11px] text-ds-ink disabled:opacity-50"><Plus className="h-3.5 w-3.5" />{t('surveyAddPair')}</button>
    </div>
    {pairs.length ? <div className="mt-2 space-y-2">{pairs.map((pair, index) => <fieldset key={pair.rowKey} aria-label={t('surveyPairName', { number: index + 1 })} className="grid min-w-0 gap-2 border border-ds-border-muted bg-ds-card p-3 sm:grid-cols-2 lg:grid-cols-3">
      <label className="text-[10.5px] text-ds-muted">{t('surveyPairName', { number: index + 1 })}<input aria-label={t('surveyPairName', { number: index + 1 })} value={pair.id} onChange={event => update(pair.rowKey, { id: event.target.value })} className={controlClass} /></label>
      <label className="text-[10.5px] text-ds-muted">{t('surveyFirstPoint')}<input aria-label={t('surveyFirstPoint', { number: index + 1 })} value={pair.firstPointId} onChange={event => update(pair.rowKey, { firstPointId: event.target.value })} className={controlClass} /></label>
      <label className="text-[10.5px] text-ds-muted">{t('surveySecondPoint')}<input aria-label={t('surveySecondPoint', { number: index + 1 })} value={pair.secondPointId} onChange={event => update(pair.rowKey, { secondPointId: event.target.value })} className={controlClass} /></label>
      <label className="text-[10.5px] text-ds-muted">{t('surveyPairType')}<select aria-label={t('surveyPairType', { number: index + 1 })} value={pair.kind} onChange={event => update(pair.rowKey, { kind: event.target.value as DeformationPairDraft['kind'], distanceMode: event.target.value === 'tilt' ? 'horizontal' : pair.distanceMode })} className={controlClass}><option value="tilt">{t('surveyTiltKind')}</option><option value="convergence">{t('surveyConvergenceKind')}</option></select></label>
      <label className="text-[10.5px] text-ds-muted">{t('surveyDistanceMode')}<select aria-label={t('surveyDistanceMode', { number: index + 1 })} value={pair.distanceMode} disabled={disabled || pair.kind === 'tilt'} onChange={event => update(pair.rowKey, { distanceMode: event.target.value as DeformationPairDraft['distanceMode'] })} className={controlClass}><option value="horizontal">{t('surveyDistanceHorizontal')}</option><option value="spatial">{t('surveyDistanceSpatial')}</option><option value="vertical">{t('surveyDistanceVertical')}</option></select></label>
      {pair.kind === 'tilt' ? <label className="text-[10.5px] text-ds-muted">{t('surveyPairBaseline')}<input type="number" step="any" min="0" aria-label={t('surveyPairBaseline')} aria-describedby={`${formId}-${pair.rowKey}-baseline`} value={pair.baseline} onChange={event => update(pair.rowKey, { baseline: event.target.value })} className={controlClass} /><span id={`${formId}-${pair.rowKey}-baseline`} className="mt-1 block">{t('surveyPairBaselineHint')}</span></label> : null}
      <div className="flex justify-end sm:col-span-2 lg:col-span-3"><button type="button" aria-label={t('surveyRemovePair', { number: index + 1 })} onClick={() => { if (!disabled) onChange(pairs.filter(item => item.rowKey !== pair.rowKey)) }} className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1 text-[11px] text-ds-muted"><X className="h-4 w-4" />{t('surveyRemovePair', { number: index + 1 })}</button></div>
    </fieldset>)}</div> : <p className="mt-2 text-[10.5px] text-ds-faint">{t('surveyPairsOptional')}</p>}
    <p className="mt-2 text-[10.5px] text-ds-faint">{t('surveyPairsHint')}</p>
    {!parseDeformationPairs(pairs) ? <p role="status" className="mt-2 text-[10.5px] text-amber-800 dark:text-amber-200">{t('surveyPairsArrayRequired')}</p> : null}
    {pairs.length >= MAX_DEFORMATION_PAIRS ? <p role="status" className="mt-2 text-[10.5px] text-ds-muted">{t('surveyPairsLimit', { count: MAX_DEFORMATION_PAIRS })}</p> : null}
  </fieldset>
}
