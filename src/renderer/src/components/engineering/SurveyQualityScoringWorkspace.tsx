import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS as LIMITS } from '@shared/survey-quality-scoring'
import {
  QualityScoringRequestError, qualityScoringSummary, createQualityScoring, listQualityScorings, exportQualityScoring,
  readQualityScoring, reverifyQualityScoring, validateQualityScoringInput,
  type QualityScoringBinding, type QualityScoringHistory, type QualityScoringInput, type QualityScoringKind,
  type QualityScoringRecord, type QualityScoringSummary
} from '../../agent/survey-quality-scoring-client'
import { QualityScoringResult } from './SurveyQualityScoringResult'
import { EngineeringEvidenceQuestion, EngineeringSelectedEvidence } from './EngineeringEvidenceQuestion'
import { qualityScoringExample, type ScoringProfile } from './survey-quality-scoring-examples'
import { parseQualityScoringJson } from '@shared/survey-quality-scoring'
import { saveGeneratedWorkspaceFileAs } from '../../lib/generated-file-actions'

const buttonClass = 'min-h-9 max-w-full rounded border border-ds-border px-3 py-2 text-left text-[12px] hover:bg-ds-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
const inputClass = 'block w-full min-w-0 rounded border border-ds-border bg-ds-card px-3 py-2 text-[12px] text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const fileName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path
const errorKeys: Record<string, string> = {
  stale: 'scoringStale', integrity: 'scoringIntegrity', conflict: 'scoringConflict', limit: 'scoringLimit',
  rate_limit: 'scoringRateLimit', 'replay-environment': 'scoringEnvironment', 'invalid-response': 'scoringInvalidResponse',
  'invalid-input': 'scoringValidation', not_found: 'scoringNotFound', unavailable: 'scoringUnavailable', 'request-failed': 'scoringFailed'
}
type View = { record?: QualityScoringRecord; history?: QualityScoringHistory; exportStatus?: 'saved' | 'cancelled' | 'failed'; exportPath?: string }
type Operation = { kind: 'save' | 'read'; idempotencyKey?: string; run: (stillCurrent: () => boolean) => Promise<View> }
type Props = { binding: QualityScoringBinding; runtimeReady: boolean }

export function SurveyQualityScoringWorkspace(props: Props): ReactElement {
  // A new project, revision, workspace or connection gets a fresh local session.
  const scope = JSON.stringify([props.binding.workspaceRoot, props.binding.projectId, props.binding.projectRevision, props.runtimeReady])
  return <QualityScoringSession key={scope} {...props} />
}

function QualityScoringSession({ binding, runtimeReady }: Props): ReactElement {
  const { t } = useTranslation('qualityScoring')
  const [kind, setKind] = useState<QualityScoringKind | ''>('')
  const [profile, setProfile] = useState<ScoringProfile>('planar-control-point')
  const [declarationJson, setDeclarationJson] = useState(''), [modelBasisStatement, setBasis] = useState('')
  const [unitId, setUnitId] = useState(''), [evidenceReference, setEvidenceReference] = useState('')
  const [observedValues, setObservedValues] = useState(''), [allowableError, setAllowableError] = useState(''), [aCount, setACount] = useState('')
  const [accuracyUnit, setAccuracyUnit] = useState<'m' | 'mm'>('mm')
  const [defectClass, setDefectClass] = useState('data-quality/observation-quality')
  const [defectCounts, setDefectCounts] = useState({ a: '', b: '', c: '', d: '', total: '' })
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
    if (!kind || !evidenceReference.trim()) return ''
    const common = qualityScoringExample(kind, profile)
    if (kind === 'accuracy' && 'model' in common) {
      const values = observedValues.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
      if (!unitId.trim() || !values.length || !allowableError.trim()) return ''
      const count = aCount.trim() ? Number(aCount) : null
      if (count !== null && (!Number.isInteger(count) || count < 0)) return ''
      return JSON.stringify({ ...common, unitId: unitId.trim(), evidenceRefs: [evidenceReference.trim()],
        model: { ...common.model, items: values.map((m, index) => ({ id: `precision-${index + 1}`, m, m0: allowableError.trim(), unit: accuracyUnit,
          source: 'caller-declared-error-magnitude-not-derived-from-adjustment-residuals', evidenceRefs: [evidenceReference.trim()] })),
          aCount: count, aEvidenceRefs: [evidenceReference.trim()] } })
    }
    if (kind === 'deduction' && 'elementId' in common && 'defects' in common) {
      const [elementId, subelementId] = defectClass.split('/')
      const count = (value: string): number | null => {
        if (!value.trim()) return null
        const parsed = Number(value)
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : Number.NaN
      }
      const a = count(defectCounts.a), b = count(defectCounts.b), c = count(defectCounts.c), d = count(defectCounts.d)
      if (!unitId.trim() || !elementId || !subelementId || !defectCounts.total.trim() || [a, b, c, d].some(value => Number.isNaN(value))) return ''
      return JSON.stringify({ ...common, unitId: unitId.trim(), evidenceRefs: [evidenceReference.trim()], elementId, subelementId,
        defects: { ...common.defects, a, b, c, d, t: defectCounts.total.trim(), evidenceRefs: [evidenceReference.trim()] } })
    }
    if (kind === 'overview' && 'unitId' in common) {
      const a = aCount.trim() ? Number(aCount) : null, b = defectCounts.b.trim() ? Number(defectCounts.b) : null
      if (!unitId.trim() || a !== null && (!Number.isInteger(a) || a < 0) || b !== null && (!Number.isInteger(b) || b < 0)) return ''
      return JSON.stringify({ ...common, unitId: unitId.trim(), evidenceRefs: [evidenceReference.trim()], a, b })
    }
    return ''
  }, [kind, profile, unitId, evidenceReference, observedValues, allowableError, accuracyUnit, aCount, defectClass, defectCounts])
  const effectiveDeclaration = declarationJson || professionalDeclaration
  const input = useMemo(() => kind ? { kind, declarationJson: effectiveDeclaration, modelBasisStatement } : null, [kind, effectiveDeclaration, modelBasisStatement])
  const valid = useMemo(() => {
    try { return !!input && validateQualityScoringInput(binding, input) && (parseQualityScoringJson(input.declarationJson) as { productProfileId: string }).productProfileId === profile } catch { return false }
  }, [binding, input, profile])
  const ready = runtimeReady && !busy
  const formReady = ready && !pendingSave.current

  function invalidate(): void {
    generation.current += 1; inFlight.current = false; setBusy(false); setView(null); setError(''); setAcknowledged(false)
  }
  function clearImportedDeclaration(): void { importSequence.current += 1; setDeclarationJson('') }
  function resetDraft(nextKind: QualityScoringKind | '' = kind): void {
    focusKind.current = true
    invalidate(); retry.current = null; pendingSave.current = null; setCancelled(false)
    importSequence.current += 1
    setKind(nextKind); setDeclarationJson(''); setBasis(''); setUnitId(''); setEvidenceReference(''); setObservedValues(''); setAllowableError(''); setAccuracyUnit('mm'); setACount('')
    setDefectClass('data-quality/observation-quality'); setDefectCounts({ a: '', b: '', c: '', d: '', total: '' })
  }
  async function importDeclaration(file: File | undefined): Promise<void> {
    const sequence = ++importSequence.current
    setDeclarationJson(''); setAcknowledged(false); setView(null)
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
        setView(result); retry.current = null
        if (operation.kind === 'save' || result.record?.idempotencyKey === pendingSave.current?.idempotencyKey) pendingSave.current = null
      }
    } catch (cause) {
      if (stillCurrent()) {
        const reason = cause instanceof QualityScoringRequestError ? cause.reason : 'request-failed'
        setError(reason)
        if (!['request-failed', 'rate_limit'].includes(reason)) retry.current = null
      }
    } finally { if (stillCurrent()) { inFlight.current = false; setBusy(false) } }
  }
  function save(): void {
    if (!input || !valid || !acknowledged || !formReady || inFlight.current) return
    const submitted: QualityScoringInput = { ...input }, key = crypto.randomUUID()
    const operation: Operation = { kind: 'save', idempotencyKey: key, run: async stillCurrent => ({ record: await createQualityScoring(binding, submitted, key, stillCurrent) }) }
    pendingSave.current = operation
    void execute(operation)
  }
  function history(offset = 0): void { void execute({ kind: 'read', run: async () => ({ history: await listQualityScorings(binding, offset) }) }) }
  function restore(summary: QualityScoringSummary): void { void execute({ kind: 'read', run: async () => ({ record: await readQualityScoring(binding, summary) }) }) }
  function exportRecord(selected: QualityScoringRecord): void {
    void execute({ kind: 'read', run: async stillCurrent => {
      const verified = await exportQualityScoring(binding, qualityScoringSummary(selected))
      if (!stillCurrent()) throw new QualityScoringRequestError('stale')
      const encoded = new TextEncoder().encode(`${JSON.stringify(verified)}\n`)
      let binary = ''
      for (let offset = 0; offset < encoded.length; offset += 32_768) binary += String.fromCharCode(...encoded.subarray(offset, offset + 32_768))
      const saved = await saveGeneratedWorkspaceFileAs({ workspaceRoot: binding.workspaceRoot,
        suggestedName: `survey-quality-${verified.kind}-declared-score.json`, mimeType: 'application/json', dataBase64: btoa(binary) })
      return { record: verified, exportStatus: saved.ok ? 'saved' : saved.canceled ? 'cancelled' : 'failed', exportPath: saved.ok ? saved.path : undefined }
    } })
  }
  const record = runtimeReady ? view?.record : null
  const page = runtimeReady ? view?.history : null

  return <section className="min-w-0 space-y-4 p-4 text-[12px] text-ds-ink sm:p-5" aria-label={t('scoringTitle')}>
    <h3 ref={heading} tabIndex={-1} className="text-[15px] font-semibold outline-offset-4">{t('scoringTitle')}</h3>
    <p className="leading-5 text-ds-muted">{t('scoringIntro')}</p>
    <p className="rounded border border-amber-300 bg-amber-50 p-3 leading-5 text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100">{t('scoringBoundary')}</p>
    <p className="text-ds-muted">{t('scoringProfessionalScope')}</p>
    <div className="min-w-0 space-y-3 rounded border border-ds-border-muted bg-ds-card p-3">
      <label className="block space-y-1"><span>{t('scoringMethod')}</span><select ref={kindControl} className={inputClass} value={kind} disabled={!formReady} onChange={event => resetDraft(event.target.value as QualityScoringKind | '')}><option value="">{t('scoringChooseMethod')}</option>{(['accuracy', 'deduction', 'unit', 'overview', 'sample', 'final-batch', 'acceptance-batch'] as const).map(value => <option key={value} value={value}>{t(`operations.${value}`)}</option>)}</select></label>
      {kind ? <>
        <label className="block space-y-1"><span>{t('scoringProduct')}</span><select className={inputClass} disabled={!formReady} value={profile} onChange={event => { resetDraft(kind); setProfile(event.target.value as ScoringProfile) }}><option value="planar-control-point">{t('scoringPlanar')}</option><option value="height-control-section">{t('scoringHeight')}</option></select></label>
        <p className="leading-5">{t('scoringLimits')}</p>
        <h4 className="font-medium">{t('scoringProfessionalInput')}</h4>
        {kind === 'accuracy' ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="block space-y-1"><span>{t('scoringUnitIdentifier')}</span><input className={inputClass} value={unitId} disabled={!formReady} onChange={event => { setUnitId(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>{t('scoringEvidenceReference')}</span><input className={inputClass} value={evidenceReference} disabled={!formReady} onChange={event => { setEvidenceReference(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>{t('scoringObservationValues')}</span><textarea rows={4} className={inputClass} value={observedValues} disabled={!formReady} onChange={event => { setObservedValues(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /><span className="block leading-5 text-ds-muted">{t('scoringObservationValuesHint')}</span></label>
          <div className="space-y-3">
            <label className="block space-y-1"><span>{t('scoringMeasurementUnit')}</span><select className={inputClass} value={accuracyUnit} disabled={!formReady} onChange={event => { setAccuracyUnit(event.target.value as 'm' | 'mm'); clearImportedDeclaration(); setAcknowledged(false); setView(null) }}><option value="m">m</option><option value="mm">mm</option></select></label>
            <label className="block space-y-1"><span>{t('scoringAllowableError')} ({accuracyUnit})</span><input inputMode="decimal" className={inputClass} value={allowableError} disabled={!formReady} onChange={event => { setAllowableError(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
            <label className="block space-y-1"><span>{t('scoringAClassCount')}</span><input inputMode="numeric" className={inputClass} value={aCount} disabled={!formReady} onChange={event => { setACount(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          </div>
        </div> : null}
        {kind === 'deduction' ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="block space-y-1"><span>{t('scoringUnitIdentifier')}</span><input className={inputClass} value={unitId} disabled={!formReady} onChange={event => { setUnitId(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>{t('scoringEvidenceReference')}</span><input className={inputClass} value={evidenceReference} disabled={!formReady} onChange={event => { setEvidenceReference(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>{t('scoringDefectClass')}</span><select className={inputClass} value={defectClass} disabled={!formReady} onChange={event => { setDefectClass(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }}>{['data-quality/observation-quality','data-quality/calculation-quality','point-quality/selection-quality','point-quality/marking-quality','material-quality/presentation-quality','material-quality/completeness'].map(value => { const [element, child] = value.split('/'); return <option key={value} value={value}>{t(`nodes.${element}`)} · {t(`nodes.${child}`)}</option> })}</select></label>
          <label className="block space-y-1"><span>{t('scoringDefectCounts')}</span><div className="grid grid-cols-2 gap-2">{(['a', 'b', 'c', 'd'] as const).map(value => <label key={value} className="block space-y-1"><span>{value.toUpperCase()}</span><input inputMode="numeric" className={inputClass} value={defectCounts[value]} disabled={!formReady} onChange={event => { setDefectCounts(current => ({ ...current, [value]: event.target.value })); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>)}</div></label>
          <label className="block space-y-1"><span>{t('scoringAdjustedTCoefficient')}</span><input inputMode="decimal" className={inputClass} value={defectCounts.total} disabled={!formReady} onChange={event => { setDefectCounts(current => ({ ...current, total: event.target.value })); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
        </div> : null}
        {kind === 'overview' ? <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="block space-y-1"><span>{t('scoringUnitIdentifier')}</span><input className={inputClass} value={unitId} disabled={!formReady} onChange={event => { setUnitId(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>{t('scoringEvidenceReference')}</span><input className={inputClass} value={evidenceReference} disabled={!formReady} onChange={event => { setEvidenceReference(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>A</span><input inputMode="numeric" className={inputClass} value={aCount} disabled={!formReady} onChange={event => { setACount(event.target.value); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
          <label className="block space-y-1"><span>B</span><input inputMode="numeric" className={inputClass} value={defectCounts.b} disabled={!formReady} onChange={event => { setDefectCounts(current => ({ ...current, b: event.target.value })); clearImportedDeclaration(); setAcknowledged(false); setView(null) }} /></label>
        </div> : null}
        {!['accuracy', 'deduction', 'overview'].includes(kind) ? <p className="leading-5 text-ds-muted">{t('scoringSpecializedInputUnavailable')}</p> : null}
        <label className="block space-y-1"><span>{t('scoringBasis')}</span><textarea rows={4} className={inputClass} value={modelBasisStatement} disabled={!formReady} onChange={event => { setBasis(event.target.value); setAcknowledged(false); setView(null) }} /></label>
        <p className="leading-5 text-ds-muted">{t('scoringBasisHint', { limit: LIMITS.basisBytes / 1024 })}</p>
        <label className="block space-y-1"><span>{t('scoringImportDeclaration')}</span><input type="file" accept="application/json,.json" className={inputClass} disabled={!formReady} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void importDeclaration(file) }} /></label>
        {!valid && (declarationJson || modelBasisStatement) ? <p role="status" className="text-amber-900 dark:text-amber-200">{t('scoringValidation')}</p> : null}
        <label className="flex items-start gap-2 leading-5"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={!formReady || !valid} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('scoringAcknowledge')}</span></label>
      </> : null}
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!formReady || !valid || !acknowledged} onClick={save}>{t('scoringSave')}</button><button type="button" className={buttonClass} disabled={!ready} onClick={() => history()}>{t('scoringHistory')}</button></div>
    </div>
    {!runtimeReady ? <p role="status">{t('scoringOffline')}</p> : null}
    {busy ? <div className="flex flex-wrap items-center gap-2"><p role="status">{t('scoringLoading')}</p><button type="button" className={buttonClass} onClick={() => { invalidate(); setCancelled(true); heading.current?.focus() }}>{t('scoringCancel')}</button></div> : null}
    {cancelled ? <p role="status" className="leading-5">{t('scoringCancelled')}</p> : null}
    {error ? <p role="alert" className="leading-5 text-amber-900 dark:text-amber-200">{t(errorKeys[error] ?? 'scoringFailed')}</p> : null}
    {ready && retry.current ? <button type="button" className={buttonClass} onClick={() => { if (retry.current) void execute(retry.current) }}>{t('scoringRetry')}</button> : null}
    {pendingSave.current && !busy ? <div className="space-y-2"><p className="leading-5 text-ds-muted">{t('scoringPending')}</p><div className="flex flex-wrap gap-2">{retry.current !== pendingSave.current ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => { if (pendingSave.current) void execute(pendingSave.current) }}>{t('scoringRetrySave')}</button> : null}<button type="button" className={buttonClass} disabled={!ready} onClick={() => resetDraft()}>{t('scoringNewDraft')}</button></div></div> : null}
    {record ? <EngineeringSelectedEvidence reference={{ kind: 'scoring', recordId: record.id, recordHash: record.recordHash }}><div className="min-w-0 space-y-4 border-t border-ds-border-muted pt-4">
      <h4 className="font-semibold">{t('scoringSavedRecord')}<EngineeringEvidenceQuestion label={t('scoringSavedRecord')} disabled={!ready} /></h4><p className="text-ds-muted">{t('scoringRecordSummary', { date: new Date(record.createdAt).toLocaleString() })}</p>
      <p className="font-medium leading-5">{t(record.declaration.productProfileId === 'planar-control-point' ? 'scoringPlanar' : 'scoringHeight')} · {t(`operations.${record.kind}`)} · {record.declaration.standardCode}</p>
      <p className="leading-5 text-ds-muted">{t('scoringVerified')}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready} onClick={() => void execute({ kind: 'read', run: async stillCurrent => ({ record: await reverifyQualityScoring(binding, qualityScoringSummary(record), stillCurrent) }) })}>{t('scoringReverify')}</button><button type="button" className={buttonClass} disabled={!ready} onClick={() => exportRecord(record)}>{t('scoringExport')}</button></div>
      {view?.exportStatus ? <p role={view.exportStatus === 'failed' ? 'alert' : 'status'} className="break-words leading-5">{t(view.exportStatus === 'saved' ? 'scoringExportSaved' : view.exportStatus === 'cancelled' ? 'scoringExportCancelled' : 'scoringExportFailed', { path: view.exportPath ? fileName(view.exportPath) : undefined })}</p> : null}
      <h5 className="font-medium">{t('scoringBasis')}<EngineeringEvidenceQuestion label={t('scoringBasis')} selector={{ path: ['modelBasisStatement'] }} disabled={!ready} /></h5><p className="whitespace-pre-wrap break-words leading-5">{record.modelBasisStatement}</p>
      <QualityScoringResult result={record.result} evidence={{ kind: 'scoring', recordId: record.id, recordHash: record.recordHash }} runtimeReady={ready} />
    </div></EngineeringSelectedEvidence> : null}
    {page ? <section className="min-w-0 space-y-3 border-t border-ds-border-muted pt-4" aria-label={t('scoringHistory')}>
      <h4 className="font-semibold">{t('scoringHistory')}</h4>
      {!page.records.length && !page.unavailable.length ? <p>{t('scoringNoHistory')}</p> : null}
      {page.unavailable.map(item => <div role="status" key={item.id} className="rounded border border-amber-300 p-3"><p>{t('scoringUnrestorable')}</p><p>{t(errorKeys[item.reason])}</p></div>)}
      {page.records.map(item => <button key={item.id} type="button" className={`${buttonClass} block w-full break-words`} disabled={!ready} onClick={() => restore(item)}><span className="block">{t('scoringRestore')} · {t(`operations.${item.kind}`)} · {t(`states.${item.outcome}`)} · {t(`scopes.${item.scopeAssessment}`)}</span><span className="mt-1 block text-ds-muted">{t('scoringRecordDate', { date: new Date(item.createdAt).toLocaleString() })}</span></button>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready || page.offset === 0} onClick={() => history(Math.max(0, page.offset - LIMITS.pageSize))}>{t('scoringPrevious')}</button><button type="button" className={buttonClass} disabled={!ready || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) history(page.nextOffset) }}>{t('scoringNext')}</button></div>
    </section> : null}
  </section>
}
