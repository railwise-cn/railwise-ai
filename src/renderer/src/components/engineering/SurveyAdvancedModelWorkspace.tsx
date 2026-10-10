import { SurveyStaticIncrementalResult } from './SurveyStaticIncrementalResult'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { SURVEY_ADVANCED_TRIAL_LIMITS as LIMITS, buildSourceTrialDeclaration, sourceStaticBase } from '@shared/survey-advanced-trials'
import {
  AdvancedTrialRequestError, advancedTrialSummary, createAdvancedTrial, listAdvancedTrials, exportAdvancedTrial,
  readAdvancedTrial, reverifyAdvancedTrial, validateAdvancedTrialInput, readSourceFixedModel, sourceStaticFingerprint,
  type SourceFixedSelection, type SourceFixedModel,
  type AdvancedTrialBinding, type AdvancedTrialHistory, type AdvancedTrialInput, type AdvancedTrialKind,
  type AdvancedTrialRecord, type AdvancedTrialSummary
} from '../../agent/survey-advanced-trials-client'
import { advancedOutcomeKeys, GeneralizedWResult, VceTrialResult, HuberTrialResult, StatisticalFamilyResult } from './SurveyAdvancedModelResult'
import { SurveyReferenceDatumResult } from './SurveyReferenceDatumResult'
import { saveGeneratedWorkspaceFileAs } from '../../lib/generated-file-actions'
import { EngineeringEvidenceQuestion, EngineeringSelectedEvidence } from './EngineeringEvidenceQuestion'

const buttonClass = 'min-h-[44px] max-w-full rounded border border-ds-border px-3 py-2 text-left text-[12px] hover:bg-ds-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
const inputClass = 'block w-full min-w-0 rounded border border-ds-border bg-ds-card px-3 py-2 text-[12px] text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const errorKeys: Record<string, string> = {
  stale: 'advancedStale', integrity: 'advancedIntegrity', conflict: 'advancedConflict', limit: 'advancedLimit',
  rate_limit: 'advancedRateLimit', 'replay-environment': 'advancedEnvironment', 'invalid-response': 'advancedInvalidResponse',
  'invalid-input': 'advancedValidation', not_found: 'advancedNotFound', unavailable: 'advancedUnavailable', 'request-failed': 'advancedFailed'
}
type View = { source?: SourceFixedModel; staticFingerprint?: string; record?: AdvancedTrialRecord; history?: AdvancedTrialHistory; exportStatus?: 'saved' | 'cancelled' | 'failed'; exportPath?: string }
type Operation = { kind: 'save' | 'read'; idempotencyKey?: string; run: (stillCurrent: () => boolean) => Promise<View> }
type Props = { binding: AdvancedTrialBinding; runtimeReady: boolean; sourceSelection?: SourceFixedSelection }

const methodKeys: Record<AdvancedTrialKind, string> = { 'generalized-w': 'advancedWMethod', vce: 'advancedVceMethod', huber: 'advancedHuberMethod', 'statistical-family': 'advancedStatisticalMethod', 'reference-datum': 'advancedReferenceMethod', 'static-incremental': 'advancedStaticMethod' }
const limitKeys: Record<AdvancedTrialKind, string> = { 'generalized-w': 'advancedWLimits', vce: 'advancedVceLimits', huber: 'advancedHuberLimits', 'statistical-family': 'advancedStatisticalLimits', 'reference-datum': 'advancedReferenceLimits', 'static-incremental': 'advancedStaticLimits' }
const fileName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path

export function SurveyAdvancedModelWorkspace(props: Props): ReactElement {
  // A new project, revision, workspace or connection gets a fresh local session.
  const scope = JSON.stringify([props.binding.workspaceRoot, props.binding.projectId, props.binding.projectRevision, props.runtimeReady, props.sourceSelection])
  return <AdvancedTrialSession key={scope} {...props} />
}

function AdvancedTrialSession({ binding, runtimeReady, sourceSelection }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [source, setSource] = useState<SourceFixedModel | null>(null), [staticFingerprint, setStaticFingerprint] = useState('')
  const [familyId, setFamilyId] = useState(''), [alpha, setAlpha] = useState('0.05')
  const [externalScale, setExternalScale] = useState(''), [externalScaleBasis, setExternalScaleBasis] = useState(''), [huberK, setHuberK] = useState('1.345'), [appendRows, setAppendRows] = useState('')
  const [kind, setKind] = useState<AdvancedTrialKind | ''>('')
  const [declarationJson, setDeclarationJson] = useState(''), [modelBasisStatement, setBasis] = useState('')
  const [vceParameter, setVceParameter] = useState(''), [vceUnit, setVceUnit] = useState<'m' | 'mm'>('mm')
  const [vceValues, setVceValues] = useState(''), [vceInitialVariance, setVceInitialVariance] = useState(''), [vceRelativeVariance, setVceRelativeVariance] = useState(''), [vceSource, setVceSource] = useState('')
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false)
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(''), [cancelled, setCancelled] = useState(false)
  const generation = useRef(0), inFlight = useRef(false), alive = useRef(true)
  const importSequence = useRef(0)
  const retry = useRef<Operation | null>(null), pendingSave = useRef<Operation | null>(null)
  const heading = useRef<HTMLHeadingElement>(null), kindControl = useRef<HTMLSelectElement>(null)
  const focusKind = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1; importSequence.current += 1 } }, [])
  useEffect(() => { if (focusKind.current) { focusKind.current = false; kindControl.current?.focus() } })
  const professionalDeclaration = useMemo(() => {
    if (kind !== 'vce' || !vceParameter.trim() || !vceSource.trim() || !vceValues.trim() || !vceInitialVariance.trim() || !vceRelativeVariance.trim()) return ''
    const values = vceValues.split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(Number)
    const initialVariance = Number(vceInitialVariance), relativeVariance = Number(vceRelativeVariance)
    if (values.length < 2 || values.some(value => !Number.isFinite(value)) || !Number.isFinite(initialVariance) || !Number.isFinite(relativeVariance)) return ''
    return JSON.stringify({ schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: vceUnit, parameterIds: [vceParameter.trim()],
      groups: [{ id: '观测组', initialVariance, sourceAnchor: vceSource.trim() }],
      observations: values.map((value, index) => ({ id: `观测${index + 1}`, value, coefficients: [1], groupId: '观测组', relativeVariance, sourceAnchor: vceSource.trim() })),
      maxIterations: 30, relativeTolerance: 1e-8 })
  }, [kind, vceParameter, vceUnit, vceValues, vceInitialVariance, vceRelativeVariance, vceSource])
  const sourceDeclaration = useMemo(() => {
    if (!source || !kind) return ''
    try {
      const appended = appendRows.trim() ? appendRows.trim().split(/\r?\n/).map(line => {
        const fields = line.split(',').map(v => v.trim())
        if (fields.length !== 6) throw new Error('invalid append row')
        return { id: fields[0]!, from: fields[1]!, to: fields[2]!, heightDifference: Number(fields[3]), sigma: Number(fields[4]), sourceAnchor: fields[5]! }
      }) : []
      return JSON.stringify(buildSourceTrialDeclaration(source, kind, { familyId: familyId.trim(), alpha: Number(alpha), externalScale: externalScale.trim() ? Number(externalScale) : NaN,
        externalScaleBasis, huberK: Number(huberK), appended, staticBaseFingerprint: staticFingerprint }))
    } catch { return '' }
  }, [source, kind, familyId, alpha, externalScale, externalScaleBasis, huberK, appendRows, staticFingerprint])
  const effectiveDeclaration = source ? sourceDeclaration : declarationJson || professionalDeclaration
  const input = useMemo(() => kind ? { kind, declarationJson: effectiveDeclaration, modelBasisStatement, ...(source ? { sourceModel: source.binding } : {}) } : null, [kind, effectiveDeclaration, modelBasisStatement, source])
  const valid = useMemo(() => !!input && validateAdvancedTrialInput(binding, input), [binding, input])
  const ready = runtimeReady && !busy
  const formReady = ready && !pendingSave.current

  function invalidate(): void {
    generation.current += 1; inFlight.current = false; setBusy(false); setView(null); setError(''); setAcknowledged(false)
  }
  function resetDraft(nextKind: AdvancedTrialKind | '' = kind): void {
    focusKind.current = true
    invalidate(); retry.current = null; pendingSave.current = null; setCancelled(false)
    importSequence.current += 1
    setSource(null); setStaticFingerprint(''); setFamilyId(''); setAlpha('0.05'); setExternalScale(''); setExternalScaleBasis(''); setHuberK('1.345'); setAppendRows('')
    setKind(nextKind); setDeclarationJson(''); setBasis(''); setVceParameter(''); setVceUnit('mm'); setVceValues(''); setVceInitialVariance(''); setVceRelativeVariance(''); setVceSource('')
  }
  function clearImportedDeclaration(): void { importSequence.current += 1; setDeclarationJson('') }
  async function importDeclaration(file: File | undefined): Promise<void> {
    const sequence = ++importSequence.current
    if (source) setBasis('')
    setSource(null); setStaticFingerprint(''); setDeclarationJson(''); setAcknowledged(false); setView(null)
    if (!file) return
    if (file.size > LIMITS.declarationBytes) { setError('invalid-input'); return }
    try {
      const text = await file.text()
      if (!alive.current || sequence !== importSequence.current) return
      if (new TextEncoder().encode(text).byteLength > LIMITS.declarationBytes) { setError('invalid-input'); return }
      setDeclarationJson(text); setError('')
    } catch { if (alive.current && sequence === importSequence.current) setError('invalid-input') }
  }
  async function execute(operation: Operation): Promise<void> {
    if (!runtimeReady || inFlight.current || !alive.current) return
    const token = ++generation.current
    const stillCurrent = (): boolean => alive.current && token === generation.current
    inFlight.current = true; retry.current = operation; setBusy(true); setView(null); setError(''); setCancelled(false); setAcknowledged(false)
    heading.current?.focus()
    try {
      const result = await operation.run(stillCurrent)
      if (stillCurrent()) {
        if (result.source) {
          setSource(result.source); setStaticFingerprint(result.staticFingerprint ?? ''); setDeclarationJson('')
          setBasis(t('advancedSourceBasis', { name: result.source.sourceName }))
        }
        setView(result); retry.current = null
        if (operation.kind === 'save' || result.record?.idempotencyKey === pendingSave.current?.idempotencyKey) pendingSave.current = null
      }
    } catch (cause) {
      if (stillCurrent()) {
        const reason = cause instanceof AdvancedTrialRequestError ? cause.reason : 'request-failed'
        setError(reason)
        if (!['request-failed', 'rate_limit'].includes(reason)) retry.current = null
      }
    } finally { if (stillCurrent()) { inFlight.current = false; setBusy(false) } }
  }
  function save(): void {
    if (!input || !valid || !acknowledged || !formReady || inFlight.current) return
    const submitted: AdvancedTrialInput = { ...input }, key = crypto.randomUUID()
    const operation: Operation = { kind: 'save', idempotencyKey: key, run: async stillCurrent => ({ record: await createAdvancedTrial(binding, submitted, key, stillCurrent) }) }
    pendingSave.current = operation
    void execute(operation)
  }
  function loadSource(): void {
    if (!sourceSelection || !kind || !formReady) return
    setSource(null); setStaticFingerprint(''); setDeclarationJson(''); setBasis('')
    void execute({ kind: 'read', run: async stillCurrent => {
      const selected = await readSourceFixedModel(binding, sourceSelection)
      if (!stillCurrent()) throw new AdvancedTrialRequestError('stale')
      const fingerprint = await sourceStaticFingerprint(sourceStaticBase(selected))
      return { source: selected, staticFingerprint: fingerprint }
    } })
  }
  function changeSourceOption(setter: (value: string) => void, value: string): void { setter(value); setAcknowledged(false); setView(null) }
  function history(offset = 0): void { void execute({ kind: 'read', run: async () => ({ history: await listAdvancedTrials(binding, offset) }) }) }
  function restore(summary: AdvancedTrialSummary): void { void execute({ kind: 'read', run: async () => ({ record: await readAdvancedTrial(binding, summary) }) }) }
  function exportRecord(selected: AdvancedTrialRecord): void {
    void execute({ kind: 'read', run: async stillCurrent => {
      const verified = await exportAdvancedTrial(binding, advancedTrialSummary(selected))
      if (!stillCurrent()) throw new AdvancedTrialRequestError('stale')
      const encoded = new TextEncoder().encode(`${JSON.stringify(verified)}\n`)
      let binary = ''
      for (let offset = 0; offset < encoded.length; offset += 32_768) binary += String.fromCharCode(...encoded.subarray(offset, offset + 32_768))
      const saved = await saveGeneratedWorkspaceFileAs({ workspaceRoot: binding.workspaceRoot,
        suggestedName: `survey-${verified.kind}-trial.json`, mimeType: 'application/json', dataBase64: btoa(binary) })
      return { record: verified, exportStatus: saved.ok ? 'saved' : saved.canceled ? 'cancelled' : 'failed', exportPath: saved.ok ? saved.path : undefined }
    } })
  }
  const record = runtimeReady ? view?.record : null
  const page = runtimeReady ? view?.history : null

  return <section className="min-w-0 space-y-4 p-4 text-[12px] text-ds-ink sm:p-5" aria-label={t('advancedTitle')}>
    <h3 ref={heading} tabIndex={-1} className="text-[15px] font-semibold outline-offset-4">{t('advancedTitle')}</h3>
    <p className="leading-5 text-ds-muted">{t('advancedIntro')}</p>
    <p className="rounded border border-amber-300 bg-amber-50 p-3 leading-5 text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100">{t('advancedBoundary')}</p>
    <div className="min-w-0 space-y-3 rounded border border-ds-border-muted bg-ds-card p-3">
      <label className="block space-y-1"><span>{t('advancedMethod')}</span><select ref={kindControl} className={inputClass} value={kind} disabled={!formReady} onChange={event => resetDraft(event.target.value as AdvancedTrialKind | '')}><option value="">{t('advancedChooseMethod')}</option>{(Object.entries(methodKeys) as Array<[AdvancedTrialKind, string]>).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
      {kind ? <>
        <p className="leading-5">{t(limitKeys[kind])}</p>
        {['generalized-w', 'vce', 'huber', 'static-incremental'].includes(kind) ? <div className="space-y-3 rounded border border-ds-border-muted p-3">
          <button type="button" className={buttonClass} disabled={!formReady || !sourceSelection} onClick={loadSource}>{t('advancedUseSource')}</button>
          <p className="leading-5 text-ds-muted">{t(sourceSelection ? 'advancedSourceScope' : 'advancedSourceMissing')}</p>
          {source ? <>
            <p className="break-words font-medium">{source.sourceName}</p>
            <p>{t('advancedSourceCounts', { points: source.model.referencePoints.length, observations: source.model.observations.length, parameters: source.model.parameterIds.length, redundancy: source.model.degreesOfFreedom })}</p>
            <p className="leading-5">{t('advancedSourcePrior')}</p>
            <p className="leading-5">{t('advancedSourceDatum', { points: source.model.referencePoints.filter(p => p.fixed).map(p => p.id).join('、') })}</p>
            {kind === 'generalized-w' ? <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1"><span>{t('advancedSourceFamily')}</span><input className={inputClass} value={familyId} disabled={!formReady} onChange={e => changeSourceOption(setFamilyId, e.target.value)} /></label>
              <label className="block space-y-1"><span>{t('advancedSourceAlpha')}</span><input inputMode="decimal" className={inputClass} value={alpha} disabled={!formReady} onChange={e => changeSourceOption(setAlpha, e.target.value)} /></label>
            </div> : kind === 'huber' ? <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1"><span>{t('advancedSourceScale')}</span><input inputMode="decimal" className={inputClass} value={externalScale} disabled={!formReady} onChange={e => changeSourceOption(setExternalScale, e.target.value)} /></label>
              <label className="block space-y-1"><span>{t('advancedSourceHuberK')}</span><input inputMode="decimal" className={inputClass} value={huberK} disabled={!formReady} onChange={e => changeSourceOption(setHuberK, e.target.value)} /></label>
              <label className="block space-y-1 sm:col-span-2"><span>{t('advancedSourceScaleBasis')}</span><textarea className={inputClass} value={externalScaleBasis} disabled={!formReady} onChange={e => changeSourceOption(setExternalScaleBasis, e.target.value)} /></label>
            </div> : kind === 'static-incremental' ? <label className="block space-y-1"><span>{t('advancedSourceAppend')}</span><textarea rows={4} className={inputClass} value={appendRows} disabled={!formReady} onChange={e => changeSourceOption(setAppendRows, e.target.value)} /><span className="block leading-5 text-ds-muted">{t('advancedSourceAppendHint')}</span></label> : <p className="leading-5 text-ds-muted">{t('advancedSourceVceGroup')}</p>}
          </> : null}
        </div> : null}
        {!source && kind === 'vce' ? <fieldset className="grid min-w-0 gap-3 rounded border border-ds-border-muted p-3 sm:grid-cols-2"><legend className="px-1 font-medium">{t('advancedProfessionalInput')}</legend>
          <label className="block space-y-1"><span>{t('advancedParameter')}</span><input className={inputClass} value={vceParameter} disabled={!formReady} onChange={event => { setVceParameter(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>{t('advancedObservationUnit')}</span><select className={inputClass} value={vceUnit} disabled={!formReady} onChange={event => { setVceUnit(event.target.value as 'm' | 'mm'); clearImportedDeclaration(); setAcknowledged(false); setView(null) }}><option value="m">m</option><option value="mm">mm</option></select></label>
          <label className="block space-y-1"><span>{t('advancedObservationRows')}</span><textarea rows={5} className={inputClass} value={vceValues} disabled={!formReady} onChange={event => { setVceValues(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <div className="space-y-3">
            <label className="block space-y-1"><span>{t('advancedInitialValue')}</span><input inputMode="decimal" className={inputClass} value={vceInitialVariance} disabled={!formReady} onChange={event => { setVceInitialVariance(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
            <label className="block space-y-1"><span>{t('advancedRelativeVariance')}</span><input inputMode="decimal" className={inputClass} value={vceRelativeVariance} disabled={!formReady} onChange={event => { setVceRelativeVariance(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
            <label className="block space-y-1"><span>{t('advancedSourceReference')}</span><input className={inputClass} value={vceSource} disabled={!formReady} onChange={event => { setVceSource(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          </div>
          <p className="leading-5 text-ds-muted sm:col-span-2">{t('advancedVceProfessionalHint')}</p>
        </fieldset> : null}
        <details className="rounded border border-ds-border-muted p-3"><summary className="min-h-[44px] cursor-pointer py-3">{t('advancedManualModel')}</summary>
        <label className="block space-y-1"><span>{t('advancedImportModel')}</span><input type="file" accept="application/json,.json" className={inputClass} disabled={!formReady} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importDeclaration(file) }} /></label></details>
        <label className="block space-y-1"><span>{t('advancedBasis')}</span><textarea rows={4} className={inputClass} value={modelBasisStatement} disabled={!formReady} onChange={event => { setBasis(event.target.value); setAcknowledged(false); setView(null) }} /></label>
        <p className="leading-5 text-ds-muted">{t('advancedBasisHint', { limit: LIMITS.basisBytes / 1024 })}</p>
        {!valid && (declarationJson || modelBasisStatement) ? <p role="status" className="text-amber-900 dark:text-amber-200">{t('advancedValidation')}</p> : null}
        <label className="flex items-start gap-2 leading-5"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={!formReady || !valid} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('advancedAcknowledge')}</span></label>
      </> : null}
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!formReady || !valid || !acknowledged} onClick={save}>{t('advancedSave')}</button><button type="button" className={buttonClass} disabled={!ready} onClick={() => history()}>{t('advancedHistory')}</button></div>
    </div>
    {!runtimeReady ? <p role="status">{t('advancedOffline')}</p> : null}
    {busy ? <div className="flex flex-wrap items-center gap-2"><p role="status">{t('advancedLoading')}</p><button type="button" className={buttonClass} onClick={() => { invalidate(); setCancelled(true); heading.current?.focus() }}>{t('advancedCancel')}</button></div> : null}
    {cancelled ? <p role="status" className="leading-5">{t('advancedCancelled')}</p> : null}
    {error ? <p role="alert" className="leading-5 text-amber-900 dark:text-amber-200">{t(errorKeys[error] ?? 'advancedFailed')}</p> : null}
    {ready && retry.current ? <button type="button" className={buttonClass} onClick={() => { if (retry.current) void execute(retry.current) }}>{t('advancedRetry')}</button> : null}
    {pendingSave.current && !busy ? <div className="space-y-2"><p className="leading-5 text-ds-muted">{t('advancedPending')}</p><div className="flex flex-wrap gap-2">{retry.current !== pendingSave.current ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => { if (pendingSave.current) void execute(pendingSave.current) }}>{t('advancedRetrySave')}</button> : null}<button type="button" className={buttonClass} disabled={!ready} onClick={() => resetDraft()}>{t('advancedNewDraft')}</button></div></div> : null}
    {record ? <EngineeringSelectedEvidence reference={{ kind: 'advanced-trial', trialId: record.id, recordHash: record.recordHash }}><div className="min-w-0 space-y-4 border-t border-ds-border-muted pt-4">
      <EngineeringEvidenceQuestion label={t(methodKeys[record.kind])} />
      <h4 className="font-semibold">{t('advancedSavedRecord')}</h4><p className="text-ds-muted">{new Date(record.createdAt).toLocaleString()}</p>
      <p className="leading-5 text-ds-muted">{t('advancedVerified')}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready} onClick={() => void execute({ kind: 'read', run: async stillCurrent => ({ record: await reverifyAdvancedTrial(binding, advancedTrialSummary(record), stillCurrent) }) })}>{t('advancedReverify')}</button><button type="button" className={buttonClass} disabled={!ready} onClick={() => exportRecord(record)}>{t('advancedExport')}</button></div>
      {view?.exportStatus ? <p role={view.exportStatus === 'failed' ? 'alert' : 'status'} className="break-words leading-5">{t(view.exportStatus === 'saved' ? 'advancedExportSaved' : view.exportStatus === 'cancelled' ? 'advancedExportCancelled' : 'advancedExportFailed', { path: view.exportPath ? fileName(view.exportPath) : undefined })}</p> : null}
      <h5 className="font-medium">{t('advancedBasis')}</h5><p className="whitespace-pre-wrap break-words leading-5">{record.modelBasisStatement}</p>
      {record.kind === 'static-incremental' ? <SurveyStaticIncrementalResult result={record.result} sourceBound={Boolean(record.sourceModel)} /> : record.kind === 'reference-datum' ? <SurveyReferenceDatumResult result={record.result} /> : record.kind === 'generalized-w' ? <GeneralizedWResult result={record.result} /> : record.kind === 'huber' ? <HuberTrialResult result={record.result} /> : record.kind === 'statistical-family' ? <StatisticalFamilyResult result={record.result} /> : <>
        <div className="min-w-0 space-y-2" aria-label={t('advancedInitialGroups')}><h5 className="font-medium">{t('advancedInitialGroups')}</h5>{record.declaration.groups.map(group => <p key={group.id} className="break-all">{record.sourceModel ? t('advancedSourceObservationGroup') : group.id} · {group.initialVariance} {record.declaration.unit}² · {record.sourceModel ? source?.binding.fixedModelHash === record.sourceModel.fixedModelHash ? source.sourceName : t('advancedSourceRecordedReference') : group.sourceAnchor}</p>)}<p>{t('advancedStoppingPolicy', { iterations: record.declaration.maxIterations, tolerance: record.declaration.relativeTolerance })}</p></div>
        <VceTrialResult result={record.result} groupLabels={record.sourceModel ? Object.fromEntries(record.result.groupIds.map(id => [id, t('advancedSourceObservationGroup')])) : undefined} />
      </>}
    </div></EngineeringSelectedEvidence> : null}
    {page ? <section className="min-w-0 space-y-3 border-t border-ds-border-muted pt-4" aria-label={t('advancedHistory')}>
      <h4 className="font-semibold">{t('advancedHistory')}</h4>
      {!page.trials.length && !page.unavailable.length ? <p>{t('advancedNoHistory')}</p> : null}
      {page.unavailable.map(item => <div role="status" key={item.id} className="rounded border border-amber-300 p-3"><p>{t('advancedUnrestorable')}</p><p>{t(errorKeys[item.reason])}</p></div>)}
      {page.trials.map(item => <button key={item.id} type="button" className={`${buttonClass} block w-full break-words`} disabled={!ready} onClick={() => restore(item)}><span className="block">{t('advancedRestore')} · {t(methodKeys[item.kind])} · {t(advancedOutcomeKeys[item.outcome])}</span><span className="mt-1 block text-ds-muted">{new Date(item.createdAt).toLocaleString()}</span>{item.kind === 'static-incremental' ? <span className="mt-1 block">{t('advancedStaticCounts', { base: item.baseObservationCount, appended: item.appendedObservationCount, total: item.observationCount })}</span> : null}</button>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready || page.offset === 0} onClick={() => history(Math.max(0, page.offset - LIMITS.pageSize))}>{t('advancedPrevious')}</button><button type="button" className={buttonClass} disabled={!ready || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) history(page.nextOffset) }}>{t('advancedNext')}</button></div>
    </section> : null}
  </section>
}
