import { staticIncrementalExample } from '@shared/survey-static-incremental-example'
import { SurveyStaticIncrementalResult } from './SurveyStaticIncrementalResult'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { SURVEY_ADVANCED_TRIAL_LIMITS as LIMITS } from '@shared/survey-advanced-trials'
import {
  AdvancedTrialRequestError, advancedTrialSummary, createAdvancedTrial, listAdvancedTrials, exportAdvancedTrial,
  readAdvancedTrial, reverifyAdvancedTrial, validateAdvancedTrialInput,
  type AdvancedTrialBinding, type AdvancedTrialHistory, type AdvancedTrialInput, type AdvancedTrialKind,
  type AdvancedTrialRecord, type AdvancedTrialSummary
} from '../../agent/survey-advanced-trials-client'
import { advancedOutcomeKeys, GeneralizedWResult, VceTrialResult, HuberTrialResult, StatisticalFamilyResult } from './SurveyAdvancedModelResult'
import { SurveyReferenceDatumResult } from './SurveyReferenceDatumResult'
import { saveGeneratedWorkspaceFileAs } from '../../lib/generated-file-actions'
import { EngineeringEvidenceQuestion, EngineeringSelectedEvidence } from './EngineeringEvidenceQuestion'

const buttonClass = 'min-h-9 max-w-full rounded border border-ds-border px-3 py-2 text-left text-[12px] hover:bg-ds-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50'
const inputClass = 'block w-full min-w-0 rounded border border-ds-border bg-ds-card px-3 py-2 text-[12px] text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const preClass = 'max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-all rounded border border-ds-border-muted p-3 font-mono text-[11px]'
const errorKeys: Record<string, string> = {
  stale: 'advancedStale', integrity: 'advancedIntegrity', conflict: 'advancedConflict', limit: 'advancedLimit',
  rate_limit: 'advancedRateLimit', 'replay-environment': 'advancedEnvironment', 'invalid-response': 'advancedInvalidResponse',
  'invalid-input': 'advancedValidation', not_found: 'advancedNotFound', unavailable: 'advancedUnavailable', 'request-failed': 'advancedFailed'
}
type View = { record?: AdvancedTrialRecord; history?: AdvancedTrialHistory; exportStatus?: 'saved' | 'cancelled' | 'failed'; exportPath?: string }
type Operation = { kind: 'save' | 'read'; idempotencyKey?: string; run: (stillCurrent: () => boolean) => Promise<View> }
type Props = { binding: AdvancedTrialBinding; runtimeReady: boolean }

const methodKeys: Record<AdvancedTrialKind, string> = { 'generalized-w': 'advancedWMethod', vce: 'advancedVceMethod', huber: 'advancedHuberMethod', 'statistical-family': 'advancedStatisticalMethod', 'reference-datum': 'advancedReferenceMethod', 'static-incremental': 'advancedStaticMethod' }
const limitKeys: Record<AdvancedTrialKind, string> = { 'generalized-w': 'advancedWLimits', vce: 'advancedVceLimits', huber: 'advancedHuberLimits', 'statistical-family': 'advancedStatisticalLimits', 'reference-datum': 'advancedReferenceLimits', 'static-incremental': 'advancedStaticLimits' }
const examples: Record<AdvancedTrialKind, unknown> = {
  'static-incremental': staticIncrementalExample,
  'reference-datum': {
    schemaVersion: 1, model: 'two-epoch-one-dimensional-declared-reference-datum', unit: 'mm', method: 'gls-reference-mean',
    referenceDeclaration: 'caller-selected-reference-set-not-verified-stable', testingStrategy: 'none-datum-comparison-only',
    firstEpoch: { id: 'epoch-1', sourceAnchor: 'synthetic-not-verified', sourceSha256: '0'.repeat(64), covarianceBasis: 'caller-declared-full-coordinate-covariance-not-cofactor',
      points: [0, 10, 20].map((coordinate, i) => ({ id: ['a', 'b', 'c'][i], coordinate })), covariance: [[1,0,0],[0,1,0],[0,0,1]] },
    secondEpoch: { id: 'epoch-2', sourceAnchor: 'synthetic-not-verified', sourceSha256: '0'.repeat(64), covarianceBasis: 'caller-declared-full-coordinate-covariance-not-cofactor',
      points: [2, 14, 27].map((coordinate, i) => ({ id: ['a', 'b', 'c'][i], coordinate })), covariance: [[1,0,0],[0,1,0],[0,0,1]] },
    mapping: ['a', 'b', 'c'].map(id => ({ id, firstPointId: id, secondPointId: id })), referenceIds: ['a', 'b'],
    dependence: { kind: 'caller-declared-independent', sourceAnchor: 'synthetic-not-verified' }
  },
  huber: {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', independenceDeclaration: 'caller-declared-independent-observations', residualConvention: 'observed-minus-fitted', observationUnit: 'm',
    parameterIds: ['position'], parameterUnits: ['m'], initialParameters: [0], scale: { kind: 'fixed-external', value: 1, unit: 'm', basisStatement: 'Synthetic fixed external scale.' }, loss: { kind: 'huber', k: 1 },
    observations: [0, 0, 0, 10].map((value, i) => ({ id: `o${i}`, value, coefficients: [1], relativeSigma: 1, sourceAnchor: 'synthetic-example' })),
    stopping: { maxIterations: 200, standardizedPredictionStepTolerance: 1e-10, relativeObjectiveTolerance: 1e-10, normalizedScoreTolerance: 1e-10 }
  },
  'statistical-family': {
    schemaVersion: 1, familyId: 'example-family', declaration: 'caller-declared-before-observing-statistics', statisticPrecision: 'caller-declared-exact-scalar-inputs-no-upstream-error-propagation', correction: 'bonferroni', alpha: .05,
    members: ['a', 'b'].map(id => ({ id, sourceAnchor: 'synthetic-example', distribution: { kind: 'normal', tail: 'two-sided', statisticBasis: 'standardized-by-known-prior-scale', scaleBasis: 'caller-declared-known-prior-standard-deviation', priorStandardDeviation: 1, scaleUnit: 'm' } })),
    statistics: [{ memberId: 'a', status: 'available', value: 3 }]
  },
  'generalized-w': {
    schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
    observationUnit: 'm', observationIds: ['o1', 'o2', 'o3'], parameterIds: ['mean'], parameterUnits: ['m'],
    designMatrix: [[1], [1], [1]], observations: [0, 11, 2],
    covariance: { kind: 'known-apriori-absolute-observation-covariance', basisStatement: 'Synthetic known covariance for this example only.', matrix: [[4, 1, 0], [1, 9, 0], [0, 0, 1]] },
    family: { id: 'example-family', alpha: 0.05, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
    biasDirections: [{ id: 'o1-axis', coefficients: [1, 0, 0] }, { id: 'common-mode', coefficients: [1, 1, 1] }]
  },
  vce: {
    schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm', parameterIds: ['mean'],
    groups: [{ id: 'g1', initialVariance: 1, sourceAnchor: 'synthetic-example' }],
    observations: [1, 2, 4, 5].map((value, i) => ({ id: `o${i + 1}`, value, coefficients: [1], groupId: 'g1', relativeVariance: 1, sourceAnchor: 'synthetic-example' })),
    maxIterations: 30, relativeTolerance: 1e-10
  }
}

export function SurveyAdvancedModelWorkspace(props: Props): ReactElement {
  // A new project, revision, workspace or connection gets a fresh local session.
  const scope = JSON.stringify([props.binding.workspaceRoot, props.binding.projectId, props.binding.projectRevision, props.runtimeReady])
  return <AdvancedTrialSession key={scope} {...props} />
}

function AdvancedTrialSession({ binding, runtimeReady }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [kind, setKind] = useState<AdvancedTrialKind | ''>('')
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
  const valid = useMemo(() => !!input && validateAdvancedTrialInput(binding, input), [binding, input])
  const ready = runtimeReady && !busy
  const formReady = ready && !pendingSave.current

  function invalidate(): void {
    generation.current += 1; inFlight.current = false; setBusy(false); setView(null); setError(''); setAcknowledged(false)
  }
  function resetDraft(nextKind: AdvancedTrialKind | '' = kind): void {
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
    <p className="break-all text-ds-muted">{t('advancedBinding', { id: binding.projectId, revision: binding.projectRevision })}</p>
    <div className="min-w-0 space-y-3 rounded border border-ds-border-muted bg-ds-card p-3">
      <label className="block space-y-1"><span>{t('advancedMethod')}</span><select ref={kindControl} className={inputClass} value={kind} disabled={!formReady} onChange={event => resetDraft(event.target.value as AdvancedTrialKind | '')}><option value="">{t('advancedChooseMethod')}</option>{(Object.entries(methodKeys) as Array<[AdvancedTrialKind, string]>).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</select></label>
      {kind ? <>
        <p className="leading-5">{t(limitKeys[kind])}</p>
        <details><summary className="cursor-pointer py-2">{t('advancedExample')}</summary><p className="mb-2 leading-5 text-ds-muted">{t('advancedExampleWarning')}</p><pre className={preClass} tabIndex={0}>{JSON.stringify(examples[kind], null, 2)}</pre></details>
        <label className="block space-y-1"><span>{t('advancedBasis')}</span><textarea rows={4} className={inputClass} value={modelBasisStatement} disabled={!formReady} onChange={event => { setBasis(event.target.value); setAcknowledged(false); setView(null) }} /></label>
        <p className="leading-5 text-ds-muted">{t('advancedBasisHint', { limit: LIMITS.basisBytes / 1024 })}</p>
        <label className="block space-y-1"><span>{t('advancedJson')}</span><textarea rows={12} spellCheck={false} className={`${inputClass} font-mono`} value={declarationJson} disabled={!formReady} onChange={event => { setDeclarationJson(event.target.value); setAcknowledged(false); setView(null) }} /></label>
        <p className="leading-5 text-ds-muted">{t('advancedJsonHint', { limit: LIMITS.declarationBytes / 1024, bytes: new TextEncoder().encode(declarationJson).byteLength })}</p>
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
      <EngineeringEvidenceQuestion label={`${t(methodKeys[record.kind])} · ${record.id}`} />
      <h4 className="font-semibold">{t('advancedSavedRecord')}</h4><p className="break-all font-mono text-[11px]">{record.id} · {record.createdAt}</p>
      <p className="leading-5 text-ds-muted">{t('advancedVerified')}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready} onClick={() => void execute({ kind: 'read', run: async stillCurrent => ({ record: await reverifyAdvancedTrial(binding, advancedTrialSummary(record), stillCurrent) }) })}>{t('advancedReverify')}</button><button type="button" className={buttonClass} disabled={!ready} onClick={() => exportRecord(record)}>{t('advancedExport')}</button></div>
      {view?.exportStatus ? <p role={view.exportStatus === 'failed' ? 'alert' : 'status'} className="break-all leading-5">{t(view.exportStatus === 'saved' ? 'advancedExportSaved' : view.exportStatus === 'cancelled' ? 'advancedExportCancelled' : 'advancedExportFailed', { path: view.exportPath })}</p> : null}
      <h5 className="font-medium">{t('advancedBasis')}</h5><p className="whitespace-pre-wrap break-words leading-5">{record.modelBasisStatement}</p>
      {record.kind === 'static-incremental' ? <SurveyStaticIncrementalResult result={record.result} /> : record.kind === 'reference-datum' ? <SurveyReferenceDatumResult result={record.result} /> : record.kind === 'generalized-w' ? <GeneralizedWResult result={record.result} /> : record.kind === 'huber' ? <HuberTrialResult result={record.result} /> : record.kind === 'statistical-family' ? <StatisticalFamilyResult result={record.result} /> : <>
        <div className="min-w-0 space-y-2" aria-label={t('advancedInitialGroups')}><h5 className="font-medium">{t('advancedInitialGroups')}</h5>{record.declaration.groups.map(group => <p key={group.id} className="break-all">{group.id} · {group.initialVariance} {record.declaration.unit}² · {group.sourceAnchor}</p>)}<p>{t('advancedStoppingPolicy', { iterations: record.declaration.maxIterations, tolerance: record.declaration.relativeTolerance })}</p></div>
        <VceTrialResult result={record.result} />
      </>}
      <details><summary className="cursor-pointer py-2">{t('advancedOriginalInput')}</summary><p className="mb-2 leading-5 text-ds-muted">{t('advancedNormalizationHint')}</p><pre className={preClass} tabIndex={0}>{record.declarationJson}</pre></details>
      <details><summary className="cursor-pointer py-2">{t('advancedNormalizedInput')}</summary><pre className={preClass} tabIndex={0}>{JSON.stringify(record.declaration, null, 2)}</pre></details>
      <details><summary className="cursor-pointer py-2">{t('advancedEvidence')}</summary><dl className="space-y-2 break-all text-[11px]">{(['algorithmVersion', 'requestSha256', 'declarationSha256', 'modelBasisSha256', 'modelHash', 'resultHash', 'recordHash', 'replayEnvironmentHash'] as const).map(key => <div key={key}><dt>{key}</dt><dd className="font-mono">{record[key]}</dd></div>)}</dl><pre className={`${preClass} mt-3`} tabIndex={0}>{record.requestJson}</pre><pre className={`${preClass} mt-3`} tabIndex={0}>{JSON.stringify(record.result, null, 2)}</pre></details>
    </div></EngineeringSelectedEvidence> : null}
    {page ? <section className="min-w-0 space-y-3 border-t border-ds-border-muted pt-4" aria-label={t('advancedHistory')}>
      <h4 className="font-semibold">{t('advancedHistory')}</h4>
      {!page.trials.length && !page.unavailable.length ? <p>{t('advancedNoHistory')}</p> : null}
      {page.unavailable.map(item => <div role="status" key={item.id} className="break-all rounded border border-amber-300 p-3"><p>{t('advancedUnrestorable')} · {item.id}</p><p>{t(errorKeys[item.reason])}</p></div>)}
      {page.trials.map(item => <button key={item.id} type="button" className={`${buttonClass} block w-full break-words`} disabled={!ready} onClick={() => restore(item)}><span className="block">{t('advancedRestore')} · {t(methodKeys[item.kind])} · {t(advancedOutcomeKeys[item.outcome])}</span><span className="mt-1 block break-all font-mono text-[11px]">{item.id} · {item.createdAt}</span>{item.kind === 'static-incremental' ? <span className="mt-1 block">{t('advancedStaticCounts', { base: item.baseObservationCount, appended: item.appendedObservationCount, total: item.observationCount })}</span> : null}</button>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={!ready || page.offset === 0} onClick={() => history(Math.max(0, page.offset - LIMITS.pageSize))}>{t('advancedPrevious')}</button><button type="button" className={buttonClass} disabled={!ready || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) history(page.nextOffset) }}>{t('advancedNext')}</button></div>
    </section> : null}
  </section>
}
