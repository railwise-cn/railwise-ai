import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  appendQualityWorkflowEvent, createQualityWorkflow, listQualityWorkflows, readQualityWorkflow,
  listWorkflowSourcePlans, listWorkflowSourceRecords, readWorkflowSourceRecord, workflowSource,
  QualityWorkflowRequestError, type QualityWorkflow, type WorkflowEvent, type WorkflowContext,
  type WorkflowHistory, type WorkflowSourcePlan
} from '../../agent/survey-quality-workflow-client'
import type { QualityBinding, QualityPlan, QualityRecord } from '../../agent/survey-quality-client'

type View = {
  workflow?: QualityWorkflow
  history?: WorkflowHistory & { offset: number; previousOffsets: number[] }
  sources?: Awaited<ReturnType<typeof listWorkflowSourcePlans>> & { offset: number }
  records?: Awaited<ReturnType<typeof listWorkflowSourceRecords>> & { offset: number; source: WorkflowSourcePlan }
  selectedSource?: WorkflowContext
}
type Operation = (stillCurrent: () => boolean) => Promise<View>
type EditableWorkflowKind = 'check' | 'issue-opened' | 'correction-recorded' | 'issue-rechecked'
const buttonClass = 'min-h-9 max-w-full rounded border border-ds-border px-3 py-2 text-left text-[11px] hover:bg-ds-hover disabled:opacity-50'
const inputClass = 'mt-1 block min-h-9 w-full rounded border border-ds-border bg-ds-main p-2 text-[11px] text-ds-ink disabled:opacity-50'

function rememberQualityPlanMaterials(materialNames: Map<string, string>, source: { plan: QualityPlan }): void {
  for (const member of source.plan.artifact.members) {
    const name = member.path.split(/[\\/]/).at(-1) || ''
    if (name) materialNames.set(`${source.plan.artifact.bundleHash}:${member.id}`, name)
  }
}

export function SurveyQualityWorkflowWorkspace({ binding, plan, record, runtimeReady }: {
  binding: QualityBinding; plan: QualityPlan; record: QualityRecord; runtimeReady: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const scope = JSON.stringify([binding, plan, record, runtimeReady, expanded])
  const activeScope = useRef(scope); activeScope.current = scope
  const generation = useRef(0), inFlight = useRef(false)
  const retry = useRef<Operation | null>(null)
  const [view, setView] = useState<{ scope: string; value: View } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [kind, setKind] = useState<EditableWorkflowKind>('check')
  const [outcome, setOutcome] = useState<'failed' | 'not-evaluated'>('failed')
  const [recheckOutcome, setRecheckOutcome] = useState<'resolved' | 'unresolved'>('unresolved')
  const [checkId, setCheckId] = useState(''), [issueId, setIssueId] = useState(''), [correctionId, setCorrectionId] = useState('')
  const [memberId, setMemberId] = useState(''), [acknowledged, setAcknowledged] = useState(false)
  const materialNames = useRef(new Map<string, string>())
  useEffect(() => {
    generation.current += 1; inFlight.current = false; retry.current = null
    setView(null); setBusy(false); setError(''); setKind('check'); setOutcome('failed'); setRecheckOutcome('unresolved')
    setCheckId(''); setIssueId(''); setCorrectionId(''); setMemberId(''); setAcknowledged(false)
    return () => { generation.current += 1 }
  }, [scope])
  const context: WorkflowContext = { binding, plan, record }
  const current = expanded && runtimeReady && view?.scope === scope ? view.value : {}
  const workflow = current.workflow
  const ready = runtimeReady && expanded && !busy
  const editing = ready && !retry.current
  const needsCorrection = kind === 'correction-recorded' || kind === 'issue-rechecked'
  const evidenceSource = needsCorrection ? current.selectedSource : context
  const evidenceMember = evidenceSource?.plan.artifact.members.find(member => member.id === memberId)
  const materialName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path
  const rememberMaterials = (source: { plan: QualityPlan }): void => rememberQualityPlanMaterials(materialNames.current, source)
  useEffect(() => {
    materialNames.current.clear()
    rememberQualityPlanMaterials(materialNames.current, { plan })
  }, [scope, plan])
  const checks = workflow?.entries.flatMap(entry => entry.request.event.kind === 'check' ? [entry.request.event.checkId] : []) ?? []
  const issues = new Map<string, { resolved: boolean; correctionId?: string; artifactHash?: string }>()
  for (const entry of workflow?.entries ?? []) {
    const event = entry.event.event
    if (event.kind === 'issue-opened') issues.set(event.issueId, { resolved: false })
    if (event.kind === 'correction-recorded') issues.set(event.issueId, { resolved: false, correctionId: event.correctionId, artifactHash: event.correctedArtifactSha256 })
    if (event.kind === 'issue-rechecked') { const issue = issues.get(event.issueId); if (issue) issue.resolved = event.outcome === 'resolved' }
  }
  const openIssues = [...issues].filter(([, issue]) => !issue.resolved)
  const selectedIssue = issues.get(issueId)

  async function execute(operation: Operation): Promise<void> {
    if (!runtimeReady || !expanded || inFlight.current) return
    const token = ++generation.current
    const stillCurrent = () => activeScope.current === scope && generation.current === token
    inFlight.current = true; retry.current = operation; setBusy(true); setError('')
    try {
      const value = await operation(stillCurrent)
      if (stillCurrent()) { setView({ scope, value }); retry.current = null }
    } catch (cause) {
      if (stillCurrent()) {
        const reason = cause instanceof QualityWorkflowRequestError ? cause.reason : 'request-failed'
        setError(reason); setView(null)
        if (reason !== 'request-failed' && reason !== 'invalid-response') retry.current = null
      }
    } finally { if (stillCurrent()) { inFlight.current = false; setBusy(false) } }
  }
  function loadHistory(offset = 0): void {
    const old = current.history
    const previousOffsets = offset === 0 ? [] : old && offset > old.offset ? [...old.previousOffsets, old.offset] : old?.previousOffsets.slice(0, -1) ?? []
    void execute(async () => ({ ...current, history: { ...await listQualityWorkflows(context, offset), offset, previousOffsets } }))
  }
  function loadSources(offset = 0): void { void execute(async () => { const sources = await listWorkflowSourcePlans(context, offset); sources.plans.forEach(rememberMaterials); return { ...current, records: undefined, sources: { ...sources, offset } } }) }
  function loadRecords(source: WorkflowSourcePlan, offset = 0): void { rememberMaterials(source); void execute(async () => ({ ...current, records: { ...await listWorkflowSourceRecords(source, offset), source, offset } })) }
  function eventInput(): Extract<WorkflowEvent, { kind: EditableWorkflowKind }> | null {
    if (!workflow || !evidenceSource || !evidenceMember || !acknowledged) return null
    const evidence = { ...workflowSource(evidenceSource), memberId: evidenceMember.id }
    if (kind === 'check') return checkId.trim() && !checks.includes(checkId.trim()) ? { kind, checkId: checkId.trim(), outcome, evidence } : null
    if (kind === 'issue-opened') return checks.includes(checkId) && issueId.trim() && !issues.has(issueId.trim()) ? { kind, checkId, issueId: issueId.trim(), evidence } : null
    if (!selectedIssue || selectedIssue.resolved || evidenceSource.plan.artifact.bundleHash === plan.artifact.bundleHash) return null
    if (kind === 'correction-recorded') return correctionId.trim() ? { kind, issueId, correctionId: correctionId.trim(), corrected: workflowSource(evidenceSource), evidence } : null
    return selectedIssue.correctionId && selectedIssue.artifactHash === evidenceSource.plan.artifact.bundleHash
      ? { kind, issueId, correctionId: selectedIssue.correctionId, rechecked: workflowSource(evidenceSource), outcome: recheckOutcome, evidence } : null
  }
  const unavailable = (items: Array<{ id: string; reason: string }>) => items.length ? <div role="status"><p>{t('qualityWorkflowUnavailableHistory')}</p><ul className="mt-1 space-y-1">{items.map(item => <li key={item.id}>{t(`qualityWorkflowReason_${item.reason}`)}</li>)}</ul></div> : null
  const pages = (offset: number, nextOffset: number | null, load: (offset: number) => void) => <div className="flex flex-wrap gap-2">{offset > 0 ? <button type="button" className={buttonClass} disabled={!editing} onClick={() => load(Math.max(0, offset - 20))}>{t('qualityWorkspacePrevious')}</button> : null}{nextOffset !== null ? <button type="button" className={buttonClass} disabled={!editing} onClick={() => load(nextOffset)}>{t('qualityWorkspaceNext')}</button> : null}</div>

  return <details className="mt-3 min-w-0 rounded border border-ds-border-muted" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-2 font-medium">{t('qualityWorkflowTitle')}</summary>
    {expanded ? <section className="min-w-0 space-y-3 border-t border-ds-border-muted p-3" aria-label={t('qualityWorkflowTitle')}>
      <p className="leading-5 text-amber-900 dark:text-amber-200">{t('qualityWorkflowBoundary')}</p>
      <p className="text-ds-muted">{t('qualityWorkflowProfessionalScope')}</p>
      {!runtimeReady ? <p role="status">{t('qualityWorkspaceOffline')}</p> : null}
      {busy ? <p role="status">{t('qualityWorkspaceLoading')}</p> : null}
      {error ? <div role="alert"><p>{t(`qualityWorkflowReason_${error}`)}</p>{retry.current ? <button type="button" className={`${buttonClass} mt-2`} disabled={!ready} onClick={() => { if (retry.current) void execute(retry.current) }}>{t('qualityWorkspaceRetry')}</button> : null}</div> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={!editing || !!workflow} onClick={() => { const key = crypto.randomUUID(); void execute(async () => ({ workflow: await createQualityWorkflow(context, key) })) }}>{t('qualityWorkflowCreate')}</button>
        <button type="button" className={buttonClass} disabled={!editing} onClick={() => loadHistory()}>{t('qualityWorkflowHistory')}</button>
      </div>
      {current.history ? <div className="space-y-2" aria-label={t('qualityWorkflowHistory')}>
        {unavailable(current.history.unavailable)}
        {!current.history.workflows.length ? <p>{t('qualityWorkflowNoHistory')}</p> : null}
        {current.history.workflows.map(item => <button key={item.workflow.id} type="button" className={`${buttonClass} block w-full`} disabled={!editing} onClick={() => void execute(async () => ({ workflow: await readQualityWorkflow(context, item.workflow.id) }))}>{t('qualityWorkflowRestore')} · {t('qualityWorkspacePlanDate', { date: new Date(item.workflow.createdAt).toLocaleString() })}</button>)}
        <div className="flex flex-wrap gap-2">{current.history.previousOffsets.length ? <button type="button" className={buttonClass} disabled={!editing} onClick={() => loadHistory(current.history!.previousOffsets.at(-1)!)}>{t('qualityWorkspacePrevious')}</button> : null}{current.history.nextOffset !== null ? <button type="button" className={buttonClass} disabled={!editing} onClick={() => loadHistory(current.history!.nextOffset!)}>{t('qualityWorkspaceNext')}</button> : null}</div>
      </div> : null}
      {workflow ? <div className="space-y-3 border-t border-ds-border-muted pt-3">
        <h6 className="font-medium">{t('qualityWorkflowCurrent')}</h6>
        <p className="text-ds-muted">{t('qualityWorkflowCurrentSummary', { date: new Date(workflow.workflow.createdAt).toLocaleString() })}</p>
        <p role="status">{t('qualityWorkflowCounts', { checks: workflow.recordedCheckCount, issues: workflow.openIssueCount })}</p>
        <details className="min-w-0 border-t border-ds-border-muted pt-3">
          <summary className="cursor-pointer text-ds-muted">{t('qualityWorkflowAdvancedEditing')}</summary>
        <div className="grid min-w-0 gap-3 pt-3 sm:grid-cols-2">
        <label className="text-[11px]">{t('qualityWorkflowEntryType')}<select className={inputClass} value={kind} disabled={!editing} onChange={event => { setKind(event.target.value as EditableWorkflowKind); setCheckId(''); setIssueId(''); setCorrectionId(''); setMemberId(''); setAcknowledged(false) }}>{(['check', 'issue-opened', 'correction-recorded', 'issue-rechecked'] as const).map(value => <option key={value} value={value}>{t(`qualityWorkflowKind_${value}`)}</option>)}</select></label>
          {kind === 'check' ? <label className="text-[11px]">{t('qualityWorkflowCheckId')}<input className={inputClass} maxLength={160} value={checkId} disabled={!editing} onChange={event => setCheckId(event.target.value)} /></label> : kind === 'issue-opened' ? <label className="text-[11px]">{t('qualityWorkflowCheckId')}<select className={inputClass} value={checkId} disabled={!editing} onChange={event => setCheckId(event.target.value)}><option value="">{t('qualityWorkflowChoose')}</option>{checks.map(id => <option key={id}>{id}</option>)}</select></label> : null}
          {kind === 'check' ? <label className="text-[11px]">{t('qualityWorkflowDeclaredOutcome')}<select className={inputClass} value={outcome} disabled={!editing} onChange={event => setOutcome(event.target.value as typeof outcome)}><option value="failed">{t('qualityWorkflowOutcome_failed')}</option><option value="not-evaluated">{t('qualityWorkflowOutcome_not-evaluated')}</option></select></label> : null}
          {kind === 'issue-opened' ? <label className="text-[11px]">{t('qualityWorkflowIssueId')}<input className={inputClass} maxLength={160} value={issueId} disabled={!editing} onChange={event => setIssueId(event.target.value)} /></label> : needsCorrection ? <label className="text-[11px]">{t('qualityWorkflowIssueId')}<select className={inputClass} value={issueId} disabled={!editing} onChange={event => setIssueId(event.target.value)}><option value="">{t('qualityWorkflowChoose')}</option>{openIssues.filter(([, issue]) => kind !== 'issue-rechecked' || issue.correctionId).map(([id]) => <option key={id}>{id}</option>)}</select></label> : null}
          {kind === 'correction-recorded' ? <label className="text-[11px]">{t('qualityWorkflowCorrectionId')}<input className={inputClass} maxLength={160} value={correctionId} disabled={!editing} onChange={event => setCorrectionId(event.target.value)} /></label> : null}
          {kind === 'issue-rechecked' ? <label className="text-[11px]">{t('qualityWorkflowDeclaredOutcome')}<select className={inputClass} value={recheckOutcome} disabled={!editing} onChange={event => setRecheckOutcome(event.target.value as typeof recheckOutcome)}><option value="unresolved">{t('qualityWorkflowOutcome_unresolved')}</option><option value="resolved">{t('qualityWorkflowOutcome_resolved')}</option></select></label> : null}
        </div>
        {needsCorrection ? <div className="space-y-2 border border-ds-border-muted p-2">
          <p>{t('qualityWorkflowCorrectionSource')}</p><p className="text-ds-muted">{t('qualityWorkflowCorrectionHint')}</p>
          <button type="button" className={buttonClass} disabled={!editing} onClick={() => loadSources()}>{t('qualityWorkflowLoadSources')}</button>
          {current.sources ? <div className="space-y-2" aria-label={t('qualityWorkflowSourcePlans')}>
            {unavailable(current.sources.unavailable)}
            {!current.sources.plans.filter(item => item.plan.artifact.bundleHash !== plan.artifact.bundleHash).length ? <p>{t('qualityWorkflowNoSources')}</p> : null}
            {current.sources.plans.filter(item => item.plan.artifact.bundleHash !== plan.artifact.bundleHash).map(item => <button type="button" key={item.plan.plan.id} className={`${buttonClass} block w-full`} disabled={!editing} onClick={() => loadRecords(item)}>{t('qualityWorkflowChoosePlan')} · {t('qualityWorkspacePlanDate', { date: new Date(item.plan.plan.createdAt).toLocaleString() })}</button>)}
            {pages(current.sources.offset, current.sources.nextOffset, loadSources)}
          </div> : null}
          {current.records ? <div className="space-y-2" aria-label={t('qualityWorkflowSourceRecords')}>
            {unavailable(current.records.unavailable)}
            {!current.records.records.length ? <p>{t('qualityWorkflowNoRecords')}</p> : null}
            {current.records.records.map((item, index) => <button type="button" key={item.record.id} className={`${buttonClass} block w-full`} disabled={!editing} onClick={() => { const selected = current.records!.source; void execute(async stillCurrent => { const selectedSource = await readWorkflowSourceRecord(selected, item); if (stillCurrent()) { rememberMaterials(selectedSource); setMemberId(''); setAcknowledged(false) }; return { ...current, selectedSource, records: undefined, sources: undefined } }) }}>{t('qualityWorkflowChooseRecord')} · {t('qualityWorkflowRecordOption', { index: index + 1 })}</button>)}
            {pages(current.records.offset, current.records.nextOffset, offset => loadRecords(current.records!.source, offset))}
          </div> : null}
            {current.selectedSource ? <p className="text-ds-muted">{t('qualityWorkflowSelectedSource')}</p> : null}
          {kind === 'issue-rechecked' && selectedIssue?.artifactHash && current.selectedSource && selectedIssue.artifactHash !== current.selectedSource.plan.artifact.bundleHash ? <p role="status">{t('qualityWorkflowRecheckMismatch')}</p> : null}
        </div> : null}
        <label className="block text-[11px]">{t('qualityWorkflowEvidence')}<select className={inputClass} value={memberId} disabled={!editing || !evidenceSource} onChange={event => setMemberId(event.target.value)}><option value="">{t('qualityWorkflowChoose')}</option>{evidenceSource?.plan.artifact.members.map((member, index) => <option key={member.id} value={member.id}>{t('qualityWorkflowMaterialOption', { index: index + 1 })} · {materialName(member.path)}</option>)}</select></label>
        {evidenceMember ? <p className="text-ds-muted">{t('qualityWorkflowSelectedMaterial', { size: evidenceMember.sizeBytes })}</p> : null}
        <label className="flex items-start gap-2 leading-5"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={!editing} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('qualityWorkflowAcknowledge')}</span></label>
        <button type="button" className={buttonClass} disabled={!editing || !eventInput()} onClick={() => {
          const event = eventInput(); if (!event || !evidenceSource) return
          const key = crypto.randomUUID(), evidence = evidenceSource
          void execute(async stillCurrent => { const next = await appendQualityWorkflowEvent(context, workflow, event, key, evidence, needsCorrection ? evidence : undefined, stillCurrent); if (stillCurrent()) setAcknowledged(false); return { ...current, workflow: next } })
        }}>{t('qualityWorkflowSave')}</button>
        <button type="button" className={`${buttonClass} ml-2`} disabled={!editing} onClick={() => void execute(async () => ({ ...current, workflow: await readQualityWorkflow(context, workflow.workflow.id) }))}>{t('qualityWorkflowRefresh')}</button>
        </details>
        <details data-testid="quality-workflow-audit-details"><summary className="cursor-pointer">{t('qualityWorkflowAudit')}</summary><ol className="mt-2 space-y-2" data-testid="quality-workflow-audit">
          {workflow.entries.map((entry, index) => {
            const declared = entry.request.event
            const checkKey = 'checkId' in declared ? ({
              closure: 'surveyProfessionalCheck.closure', precision: 'surveyProfessionalCheck.precision',
              reference: 'surveyProfessionalCheck.reference', 'source-integrity': 'surveyProfessionalCheck.source-coverage'
            } as Record<string, string>)[declared.checkId] : undefined
            // These names come from the user's check/issue/correction inputs.
            // They identify distinct review work and are not the generated
            // event IDs, which remain internal to the history record.
            const label = [
              'checkId' in declared ? checkKey ? t(checkKey) : declared.checkId : undefined,
              'issueId' in declared ? declared.issueId : undefined,
              'correctionId' in declared ? declared.correctionId : undefined
            ].filter(Boolean).join(' · ') || t(`qualityWorkflowKind_${declared.kind}`)
            const material = materialNames.current.get(`${entry.evidenceBinding.artifactHash}:${declared.evidence.memberId}`)
            const outcomeKeys: Record<string, string> = {
              failed: 'qualityWorkflowOutcome_failed', 'not-evaluated': 'qualityWorkflowOutcome_not-evaluated',
              resolved: 'qualityWorkflowOutcome_resolved', unresolved: 'qualityWorkflowOutcome_unresolved'
            }
            const outcomeLabel = 'outcome' in declared && outcomeKeys[declared.outcome]
              ? t(outcomeKeys[declared.outcome]!)
              : t(`qualityWorkflowKind_${declared.kind}`)
            const description = [...new Set([t(`qualityWorkflowKind_${declared.kind}`), label, outcomeLabel])].join(' · ')
            return <li key={entry.event.id} className="space-y-1 border-l-2 border-ds-border-muted pl-2" data-testid="quality-workflow-audit-entry">
              <p className="font-medium">{t('qualityWorkflowAuditEntry', { index: index + 1 })} · <time dateTime={entry.event.occurredAt}>{new Date(entry.event.occurredAt).toLocaleString()}</time></p>
              <p>{description}</p>
              <p className="text-ds-muted">{material ?? t('qualityWorkflowEvidence')}</p>
            </li>
          })}
        </ol>
        </details>
      </div> : null}
    </section> : null}
  </details>
}
