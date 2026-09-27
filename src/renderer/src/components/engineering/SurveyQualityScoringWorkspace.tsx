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
const preClass = 'max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all rounded border border-ds-border-muted p-3 font-mono text-[11px]'
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
  const [acknowledged, setAcknowledged] = useState(false), [busy, setBusy] = useState(false)
  const [view, setView] = useState<View | null>(null), [error, setError] = useState(''), [cancelled, setCancelled] = useState(false)
  const generation = useRef(0), inFlight = useRef(false), alive = useRef(true)
  const retry = useRef<Operation | null>(null), pendingSave = useRef<Operation | null>(null)
  const heading = useRef<HTMLHeadingElement>(null), kindControl = useRef<HTMLSelectElement>(null)
  const focusKind = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current += 1 } }, [])
  useEffect(() => { if (focusKind.current) { focusKind.current = false; kindControl.current?.focus() } })
  const input = useMemo(() => kind ? { kind, declarationJson, modelBasisStatement } : null, [kind, declarationJson, modelBasisStatement])
  const valid = useMemo(() => {
    try { return !!input && validateQualityScoringInput(binding, input) && (parseQualityScoringJson(input.declarationJson) as { productProfileId: string }).productProfileId === profile } catch { return false }
  }, [binding, input, profile])
  const ready = runtimeReady && !busy
  const formReady = ready && !pendingSave.current

  function invalidate(): void {
    generation.current += 1; inFlight.current = false; setBusy(false); setView(null); setError(''); setAcknowledged(false)
  }
  function resetDraft(nextKind: QualityScoringKind | '' = kind): void {
    focusKind.current = true
    invalidate(); retry.current = null; pendingSave.current = null; setCancelled(false)
    setKind(nextKind); setDeclarationJson(''); setBasis('')
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
    <p className="break-all text-ds-muted">{t('scoringBinding', { id: binding.projectId, revision: binding.projectRevision })}</p>
    <div className="min-w-0 space-y-3 rounded border border-ds-border-muted bg-ds-card p-3">
      <label className="block space-y-1"><span>{t('scoringMethod')}</span><select ref={kindControl} className={inputClass} value={kind} disabled={!formReady} onChange={event => resetDraft(event.target.value as QualityScoringKind | '')}><option value="">{t('scoringChooseMethod')}</option>{(['accuracy', 'deduction', 'unit', 'overview', 'sample', 'final-batch', 'acceptance-batch'] as const).map(value => <option key={value} value={value}>{t(`operations.${value}`)}</option>)}</select></label>
      {kind ? <>
        <label className="block space-y-1"><span>{t('scoringProduct')}</span><select className={inputClass} disabled={!formReady} value={profile} onChange={event => { resetDraft(kind); setProfile(event.target.value as ScoringProfile) }}><option value="planar-control-point">{t('scoringPlanar')}</option><option value="height-control-section">{t('scoringHeight')}</option></select></label>
        <p className="leading-5">{t('scoringLimits')}</p>
        <details><summary className="cursor-pointer py-2">{t('scoringExample')}</summary><p className="mb-2 leading-5 text-ds-muted">{t('scoringExampleWarning')}</p><pre className={preClass} tabIndex={0}>{JSON.stringify(qualityScoringExample(kind, profile), null, 2)}</pre></details>
        <label className="block space-y-1"><span>{t('scoringBasis')}</span><textarea rows={4} className={inputClass} value={modelBasisStatement} disabled={!formReady} onChange={event => { setBasis(event.target.value); setAcknowledged(false); setView(null) }} /></label>
        <p className="leading-5 text-ds-muted">{t('scoringBasisHint', { limit: LIMITS.basisBytes / 1024 })}</p>
        <label className="block space-y-1"><span>{t('scoringJson')}</span><textarea rows={12} spellCheck={false} className={`${inputClass} font-mono`} value={declarationJson} disabled={!formReady} onChange={event => { setDeclarationJson(event.target.value); setAcknowledged(false); setView(null) }} /></label>
        <p className="leading-5 text-ds-muted">{t('scoringJsonHint', { limit: LIMITS.declarationBytes / 1024, bytes: new TextEncoder().encode(declarationJson).byteLength })}</p>
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
      <h4 className="font-semibold">{t('scoringSavedRecord')}<EngineeringEvidenceQuestion label={t('scoringSavedRecord')} disabled={!ready} /></h4><p className="break-all font-mono text-[11px]">{record.id} · {record.createdAt}</p>
      <p className="font-medium leading-5">{t(record.declaration.productProfileId === 'planar-control-point' ? 'scoringPlanar' : 'scoringHeight')} · {t(`operations.${record.kind}`)} · {record.declaration.standardCode}</p>
      <p className="leading-5 text-ds-muted">{t('scoringVerified')}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready} onClick={() => void execute({ kind: 'read', run: async stillCurrent => ({ record: await reverifyQualityScoring(binding, qualityScoringSummary(record), stillCurrent) }) })}>{t('scoringReverify')}</button><button type="button" className={buttonClass} disabled={!ready} onClick={() => exportRecord(record)}>{t('scoringExport')}</button></div>
      {view?.exportStatus ? <p role={view.exportStatus === 'failed' ? 'alert' : 'status'} className="break-all leading-5">{t(view.exportStatus === 'saved' ? 'scoringExportSaved' : view.exportStatus === 'cancelled' ? 'scoringExportCancelled' : 'scoringExportFailed', { path: view.exportPath })}</p> : null}
      <h5 className="font-medium">{t('scoringBasis')}<EngineeringEvidenceQuestion label={t('scoringBasis')} selector={{ path: ['modelBasisStatement'] }} disabled={!ready} /></h5><p className="whitespace-pre-wrap break-words leading-5">{record.modelBasisStatement}</p>
      <QualityScoringResult result={record.result} evidence={{ kind: 'scoring', recordId: record.id, recordHash: record.recordHash }} runtimeReady={ready} />
      <details><summary className="cursor-pointer py-2">{t('scoringOriginalInput')}</summary><p className="mb-2 leading-5 text-ds-muted">{t('scoringNormalizationHint')}</p><pre className={preClass} tabIndex={0}>{record.declarationJson}</pre></details>
      <details><summary className="cursor-pointer py-2">{t('scoringNormalizedInput')}</summary><pre className={preClass} tabIndex={0}>{JSON.stringify(record.declaration, null, 2)}</pre></details>
      <details><summary className="cursor-pointer py-2">{t('scoringEvidence')}</summary><dl className="space-y-2 break-all text-[11px]">{(['algorithmVersion', 'requestSha256', 'declarationSha256', 'modelBasisSha256', 'modelHash', 'resultHash', 'recordHash', 'replayEnvironmentHash'] as const).map(key => <div key={key}><dt>{key}</dt><dd className="font-mono">{record[key]}</dd></div>)}</dl><pre className={`${preClass} mt-3`} tabIndex={0}>{record.requestJson}</pre><pre className={`${preClass} mt-3`} tabIndex={0}>{JSON.stringify(record.result, null, 2)}</pre></details>
    </div></EngineeringSelectedEvidence> : null}
    {page ? <section className="min-w-0 space-y-3 border-t border-ds-border-muted pt-4" aria-label={t('scoringHistory')}>
      <h4 className="font-semibold">{t('scoringHistory')}</h4>
      {!page.records.length && !page.unavailable.length ? <p>{t('scoringNoHistory')}</p> : null}
      {page.unavailable.map(item => <div role="status" key={item.id} className="break-all rounded border border-amber-300 p-3"><p>{t('scoringUnrestorable')} · {item.id}</p><p>{t(errorKeys[item.reason])}</p></div>)}
      {page.records.map(item => <button key={item.id} type="button" className={`${buttonClass} block w-full break-words`} disabled={!ready} onClick={() => restore(item)}><span className="block">{t('scoringRestore')} · {t(`operations.${item.kind}`)} · {t(`states.${item.outcome}`)} · {t(`scopes.${item.scopeAssessment}`)}</span><span className="mt-1 block break-all font-mono text-[11px]">{item.id} · {item.createdAt}</span></button>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready || page.offset === 0} onClick={() => history(Math.max(0, page.offset - LIMITS.pageSize))}>{t('scoringPrevious')}</button><button type="button" className={buttonClass} disabled={!ready || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) history(page.nextOffset) }}>{t('scoringNext')}</button></div>
    </section> : null}
  </section>
}
