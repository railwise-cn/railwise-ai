import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { SurveyStandardBasis } from './SurveyStandardBasis'
import { EngineeringEvidenceQuestion } from './EngineeringEvidenceQuestion'
import { samplingStandardBasisContext } from '../../agent/survey-standard-basis-client'
import {
  SamplingRequestError, validateSamplingInput, freezeSamplingPopulation, listSamplingPopulations,
  readSamplingPopulation, listSamplingRuns, readSamplingRun, drawSamplingRun, readSamplingUnits,
  readSamplingSamples, verifySamplingRun, type SamplingBinding, type SamplingPopulation,
  type SamplingRun, type SamplingHistory, type SamplingPage, type SamplingStage, type SamplingMode
} from '../../agent/survey-quality-sampling-client'

type View = { population?: SamplingPopulation; run?: SamplingRun; units?: SamplingPage; samples?: SamplingPage;
  history?: { kind: 'populations'; page: SamplingHistory<SamplingPopulation> } | { kind: 'runs'; page: SamplingHistory<SamplingRun> } }
type Operation = (stillCurrent: () => boolean) => Promise<View>
const buttonClass = 'min-h-9 max-w-full rounded border border-ds-border px-3 py-2 text-left text-[11px] hover:bg-ds-hover disabled:opacity-50'
const inputClass = 'block w-full min-w-0 rounded border border-ds-border bg-ds-card px-2 py-2 text-[12px] text-ds-ink'
const errorKeys: Record<string, string> = { stale: 'samplingStale', integrity: 'samplingIntegrity', conflict: 'samplingConflict', limit: 'samplingLimit', 'invalid-response': 'samplingInvalid', unavailable: 'samplingUnavailable', 'request-failed': 'samplingFailed' }
const stageKeys: Record<SamplingStage, string> = { process: 'samplingStageProcess', 'final-office': 'samplingStageOffice', 'final-field': 'samplingStageField', acceptance: 'samplingStageAcceptance' }

export function SurveyQualitySamplingWorkspace({ binding, runtimeReady }: { binding: SamplingBinding; runtimeReady: boolean }): ReactElement {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const scope = JSON.stringify([binding.workspaceRoot, binding.projectId, binding.projectRevision, runtimeReady, expanded])
  const activeScope = useRef(scope); activeScope.current = scope
  const generation = useRef(0), inFlight = useRef(false), retry = useRef<Operation | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<{ scope: string; value: View } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [productType, setProductType] = useState(''), [unitProductType, setUnitProductType] = useState('')
  const [definitionStatement, setDefinition] = useState(''), [unitText, setUnitText] = useState('')
  const [freezeAck, setFreezeAck] = useState(false), [drawAck, setDrawAck] = useState(false)
  const [stage, setStage] = useState<SamplingStage | ''>(''), [mode, setMode] = useState<SamplingMode | ''>('')
  useEffect(() => {
    generation.current += 1; inFlight.current = false; retry.current = null
    setView(null); setBusy(false); setError(''); setFreezeAck(false); setDrawAck(false); setStage(''); setMode('')
    setProductType(''); setUnitProductType(''); setDefinition(''); setUnitText('')
    return () => { generation.current += 1 }
  }, [scope])
  const current = runtimeReady && expanded && view?.scope === scope ? view.value : null
  const population = current?.population, run = current?.run, history = current?.history
  const ready = runtimeReady && expanded && !busy
  const populationEvidence = population ? { kind: 'sampling-population' as const, populationId: population.id, populationHash: population.populationHash } : undefined
  const runEvidence = run ? { kind: 'sampling-run' as const, runId: run.id, runHash: run.runHash, planHash: run.planHash } : undefined
  const input = { productType, unitProductType, definitionStatement, orderedUnitProductIds: unitText.split('\n') }
  const valid = validateSamplingInput(binding, input)
  const censusOnly = stage === 'process' || stage === 'final-office'
  const drawValid = !!stage && !!mode && (!censusOnly || mode === 'census')

  async function execute(operation: Operation): Promise<void> {
    if (!runtimeReady || !expanded || inFlight.current) return
    const token = ++generation.current
    const stillCurrent = (): boolean => activeScope.current === scope && generation.current === token
    inFlight.current = true; retry.current = operation; setBusy(true); setError(''); setView(null); setDrawAck(false)
    heading.current?.focus()
    try {
      const value = await operation(stillCurrent)
      if (stillCurrent()) { setView({ scope, value }); retry.current = null }
    } catch (cause) {
      if (stillCurrent()) {
        const reason = cause instanceof SamplingRequestError ? cause.reason : 'request-failed'
        setError(reason); if (reason !== 'request-failed') retry.current = null
      }
    } finally { if (stillCurrent()) { inFlight.current = false; setBusy(false) } }
  }
  function loadHistory(kind: 'populations' | 'runs', offset = 0): void {
    void execute(async () => kind === 'populations'
      ? { history: { kind, page: await listSamplingPopulations(binding, offset) } }
      : { history: { kind, page: await listSamplingRuns(binding, offset) } })
  }
  function loadUnits(selected: SamplingPopulation, offset = 0): void {
    void execute(async () => ({ population: selected, run, units: await readSamplingUnits(binding, selected, offset) }))
  }
  function loadSamples(selected: SamplingRun, offset = 0): void {
    void execute(async () => ({ population, run: selected, samples: await readSamplingSamples(binding, selected, offset) }))
  }
  const pageView = (page: SamplingPage, kind: 'units' | 'samples'): ReactElement => <div className="space-y-2" aria-label={t(kind === 'units' ? 'samplingUnitsPage' : 'samplingSamplesPage')}>
    <h5 className="font-medium">{t(kind === 'units' ? 'samplingUnitsPage' : 'samplingSamplesPage')}</h5>
    <ol start={page.offset + 1} className="list-decimal space-y-1 pl-6">{page.ids.map((id, index) => <li key={id} className="break-all font-mono text-[11px]">{id}{page.batchIndices ? <span className="ml-2 font-sans text-ds-muted">{t('samplingSampleBatch', { index: page.batchIndices[index]! + 1 })}</span> : null}<EngineeringEvidenceQuestion label={id} disabled={!ready} reference={kind === 'units' && populationEvidence ? { ...populationEvidence, unitIndex: page.offset + index, unitId: id } : runEvidence ? { ...runEvidence, sampleIndex: page.offset + index, unitId: id } : undefined} /></li>)}</ol>
    <div className="flex flex-wrap gap-2">{page.offset > 0 ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => kind === 'units' ? population && loadUnits(population, Math.max(0, page.offset - 50)) : run && loadSamples(run, Math.max(0, page.offset - 50))}>{t('samplingPrevious')}</button> : null}{page.nextOffset !== null ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => kind === 'units' ? population && loadUnits(population, page.nextOffset!) : run && loadSamples(run, page.nextOffset!)}>{t('samplingNext')}</button> : null}</div>
  </div>

  return <details className="mt-5 min-w-0 rounded border border-ds-border-muted text-[12px]" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-3 font-medium">{t('samplingWorkspaceOpen')}</summary>
    {expanded ? <section className="min-w-0 space-y-4 border-t border-ds-border-muted p-3" aria-label={t('samplingWorkspaceOpen')}>
      <h4 ref={heading} tabIndex={-1} className="font-semibold">{t('samplingWorkspaceOpen')}</h4>
      <p className="leading-5 text-amber-900 dark:text-amber-200">{t('samplingWorkspaceBoundary')}</p>
      <p className="leading-5 text-ds-muted">{t('samplingWorkspaceExcluded')}</p>
      <p className="break-all text-ds-muted">{t('samplingWorkspaceBinding', { id: binding.projectId, revision: binding.projectRevision })}</p>
      <div className="space-y-3">
        <p className="leading-5 text-ds-muted">{t('samplingInputHint')}</p>
        <label className="block space-y-1"><span>{t('samplingProductType')}</span><input className={inputClass} value={productType} disabled={!ready || !!retry.current} onChange={event => { setProductType(event.target.value); setFreezeAck(false) }} /></label>
        <label className="block space-y-1"><span>{t('samplingUnitProductType')}</span><input className={inputClass} value={unitProductType} disabled={!ready || !!retry.current} onChange={event => { setUnitProductType(event.target.value); setFreezeAck(false) }} /></label>
        <label className="block space-y-1"><span>{t('samplingDefinition')}</span><textarea rows={4} className={inputClass} value={definitionStatement} disabled={!ready || !!retry.current} onChange={event => { setDefinition(event.target.value); setFreezeAck(false) }} /></label>
        <p className="leading-5 text-ds-muted">{t('samplingDefinitionHint')}</p>
        <label className="block space-y-1"><span>{t('samplingUnits')}</span><textarea rows={6} className={`${inputClass} font-mono`} value={unitText} disabled={!ready || !!retry.current} onChange={event => { setUnitText(event.target.value); setFreezeAck(false) }} /></label>
        {!valid && (productType || unitProductType || definitionStatement || unitText) ? <p role="status" className="text-amber-900 dark:text-amber-200">{t('samplingValidation')}</p> : null}
        <label className="flex items-start gap-2 leading-5"><input type="checkbox" className="mt-1" checked={freezeAck} disabled={!ready || !valid || !!retry.current} onChange={event => setFreezeAck(event.target.checked)} /><span>{t('samplingFreezeAck')}</span></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={!ready || !valid || !freezeAck || !!retry.current} onClick={() => { const key = crypto.randomUUID(); void execute(async () => ({ population: await freezeSamplingPopulation(binding, input, key) })); setFreezeAck(false); setStage(''); setMode('') }}>{t('samplingFreeze')}</button>
          <button type="button" className={buttonClass} disabled={!ready} onClick={() => loadHistory('populations')}>{t('samplingPopulationHistory')}</button>
          <button type="button" className={buttonClass} disabled={!ready} onClick={() => loadHistory('runs')}>{t('samplingRunHistory')}</button>
        </div>
      </div>
      {!runtimeReady ? <p role="status">{t('samplingOffline')}</p> : null}
      {busy ? <p role="status">{t('samplingLoading')}</p> : null}
      {error ? <div role="alert"><p>{t(errorKeys[error] ?? 'samplingFailed')}</p>{retry.current ? <button type="button" className={`${buttonClass} mt-2`} disabled={!ready} onClick={() => { if (retry.current) void execute(retry.current) }}>{t('samplingRetry')}</button> : null}</div> : null}
      {population ? <div className="space-y-3 border-t border-ds-border-muted pt-3">
        <h5 className="font-medium">{t('samplingFrozen')}<EngineeringEvidenceQuestion label={t('samplingFrozen')} reference={populationEvidence} disabled={!ready} /></h5>
        <p className="break-all font-mono text-[11px]">{population.id} · {population.createdAt}</p>
        <p className="break-all">{population.productType} · {population.unitProductType} · {t('samplingCount', { count: population.unitCount })}</p>
        <p className="whitespace-pre-wrap break-words">{population.definitionStatement}</p>
        <details><summary className="cursor-pointer">{t('samplingRecordDetails')}</summary><p className="break-all font-mono text-[10px]">{population.populationHash}</p></details>
        <button type="button" className={buttonClass} disabled={!ready} onClick={() => loadUnits(population)}>{t('samplingViewUnits')}</button>
        <label className="block space-y-1"><span>{t('samplingStage')}</span><select className={inputClass} value={stage} disabled={!ready || !!retry.current} onChange={event => { setStage(event.target.value as SamplingStage | ''); setMode(''); setDrawAck(false) }}><option value="">{t('samplingChoose')}</option>{Object.entries(stageKeys).map(([key, label]) => <option key={key} value={key}>{t(label)}</option>)}</select></label>
        <label className="block space-y-1"><span>{t('samplingMode')}</span><select className={inputClass} value={mode} disabled={!ready || !stage || !!retry.current} onChange={event => { setMode(event.target.value as SamplingMode | ''); setDrawAck(false) }}><option value="">{t('samplingChoose')}</option><option value="census">{t('samplingCensus')}</option>{!censusOnly ? <option value="table-1-simple-random">{t('samplingRandom')}</option> : null}</select></label>
        <p className="leading-5 text-ds-muted">{t('samplingStageHint')}</p>
        <label className="flex items-start gap-2 leading-5"><input type="checkbox" className="mt-1" checked={drawAck} disabled={!ready || !drawValid || !!retry.current} onChange={event => setDrawAck(event.target.checked)} /><span>{t('samplingDrawAck')}</span></label>
        <button type="button" className={buttonClass} disabled={!ready || !drawValid || !drawAck || !!retry.current} onClick={() => { if (!stage || !mode) return; const key = crypto.randomUUID(); void execute(async () => ({ population, run: await drawSamplingRun(binding, population, stage, mode, key) })) }}>{t('samplingDraw')}</button>
      </div> : null}
      {run ? <div className="space-y-3 border-t border-ds-border-muted pt-3">
        <h5 className="font-medium">{t('samplingRun')}<EngineeringEvidenceQuestion label={t('samplingRun')} reference={runEvidence} disabled={!ready} /></h5>
        <p className="break-all font-mono text-[11px]">{run.id} · {run.createdAt}</p>
        <p>{t(stageKeys[run.stage])} · {t(run.inspectionMode === 'census' ? 'samplingCensus' : 'samplingRandom')} · {t('samplingSelectedCount', { count: run.sampleSize })}</p>
        <p className="break-all font-mono text-[11px]">{run.populationId}</p>
        <p className="leading-5 text-ds-muted">{t(run.randomSource === 'not-applicable' ? 'samplingSourceCensus' : 'samplingSourceRuntime')}</p>
        <div className="space-y-2" aria-label={t('samplingBatches')}><h6 className="font-medium">{t('samplingBatches')}</h6><ol className="space-y-2">{run.batches.map((batch, index) => <li key={batch.batchIndex} className="border border-ds-border-muted p-2"><p>{t('samplingBatch', { index: batch.batchIndex + 1, total: batch.batchSize, selected: batch.sampleSize })}<EngineeringEvidenceQuestion label={t('samplingBatch', { index: batch.batchIndex + 1, total: batch.batchSize, selected: batch.sampleSize })} reference={runEvidence} selector={{ path: ['batches', index], identity: { batchIndex: batch.batchIndex } }} disabled={!ready} /></p><p className="mt-1 leading-5 text-ds-muted">{t(run.inspectionMode === 'census' ? 'samplingBatchCensusMode' : batch.census ? 'samplingBatchCensusSmall' : 'samplingBatchRandom', { count: batch.nominalTableSampleSize })}</p></li>)}</ol></div>
        <p className="leading-5 text-ds-muted">{t('samplingSourceTable')}</p>
        <SurveyStandardBasis context={samplingStandardBasisContext(run)} runtimeReady={ready} parent={runEvidence} />
        <p role="status" className="leading-5">{t('samplingVerified')}</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready} onClick={() => loadSamples(run)}>{t('samplingViewSamples')}</button><button type="button" className={buttonClass} disabled={!ready} onClick={() => void execute(async stillCurrent => ({ population, run: await verifySamplingRun(binding, run, stillCurrent) }))}>{t('samplingReverify')}</button></div>
      </div> : null}
      {current?.units ? pageView(current.units, 'units') : null}
      {current?.samples ? pageView(current.samples, 'samples') : null}
      {history ? <div className="space-y-2" aria-label={t(history.kind === 'populations' ? 'samplingPopulationHistory' : 'samplingRunHistory')}>
        {history.page.unavailable.length ? <div role="status"><p>{t('samplingUnrestorable')}</p><ul className="mt-2 space-y-1">{history.page.unavailable.map(item => <li key={item.id} className="break-all">{item.id} · {t(item.reason === 'stale' ? 'samplingStale' : 'samplingIntegrity')}</li>)}</ul></div> : null}
        {!history.page.items.length ? <p>{t('samplingNoHistory')}</p> : null}
        {history.kind === 'populations' ? history.page.items.map(item => <button key={item.id} type="button" className={`${buttonClass} block w-full break-all`} disabled={!ready} onClick={() => { setStage(''); setMode(''); void execute(async () => ({ population: await readSamplingPopulation(binding, item) })) }}>{t('samplingRestorePopulation')} · {item.id} · {item.createdAt}</button>) : history.page.items.map(item => <button key={item.id} type="button" className={`${buttonClass} block w-full break-all`} disabled={!ready} onClick={() => void execute(async () => ({ run: await readSamplingRun(binding, item) }))}>{t('samplingRestoreRun')} · {item.id} · {item.createdAt}</button>)}
        <div className="flex flex-wrap gap-2">{history.page.offset > 0 ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => loadHistory(history.kind, Math.max(0, history.page.offset - 20))}>{t('samplingPrevious')}</button> : null}{history.page.nextOffset !== null ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => loadHistory(history.kind, history.page.nextOffset!)}>{t('samplingNext')}</button> : null}</div>
      </div> : null}
    </section> : null}
  </details>
}
