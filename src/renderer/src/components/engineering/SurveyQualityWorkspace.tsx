import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { SurveyQualityWorkflowWorkspace } from './SurveyQualityWorkflowWorkspace'
import { EngineeringEvidenceQuestion, EngineeringSelectedEvidence } from './EngineeringEvidenceQuestion'
import {
  QualityRequestError, freezeQualityPlan, readQualityPlan, listQualityPlans, createQualityRecord,
  listQualityRecords, readQualityRecord, appendQualityBytesCheck, verifyQualityRecord,
  type QualityBinding, type QualityPlan, type QualityRecord, type QualityRecordSummary, type QualityUnavailable
} from '../../agent/survey-quality-client'

type History = { kind: 'plans'; plans: QualityPlan[]; unavailable: QualityUnavailable; nextOffset: number | null; offset: number }
  | { kind: 'records'; records: QualityRecordSummary[]; unavailable: QualityUnavailable; nextOffset: number | null; offset: number }
type View = { plan?: QualityPlan; record?: QualityRecord; history?: History }
type Operation = (stillCurrent: () => boolean) => Promise<View>
const buttonClass = 'min-h-9 max-w-full rounded border border-ds-border px-3 py-2 text-left text-[11px] hover:bg-ds-hover disabled:opacity-50'
const failureKeys: Record<string, string> = {
  stale: 'qualityWorkspaceStale', integrity: 'qualityWorkspaceIntegrity', conflict: 'qualityWorkspaceConflict',
  limit: 'qualityWorkspaceLimit', 'invalid-reference': 'qualityWorkspaceReference', unavailable: 'qualityWorkspaceUnavailable',
  'invalid-response': 'qualityWorkspaceInvalid', 'request-failed': 'qualityWorkspaceFailed'
}

export function SurveyQualityWorkspace({ binding, runtimeReady }: { binding: QualityBinding; runtimeReady: boolean }): ReactElement {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const scope = JSON.stringify([binding, runtimeReady, expanded])
  const activeScope = useRef(scope); activeScope.current = scope
  const generation = useRef(0)
  const inFlight = useRef(false)
  const retry = useRef<Operation | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [view, setView] = useState<{ scope: string; value: View } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => {
    generation.current += 1; inFlight.current = false; retry.current = null
    setView(null); setBusy(false); setError(''); setAcknowledged(false)
    return () => { generation.current += 1 }
  }, [scope])
  const current = expanded && runtimeReady && view?.scope === scope ? view.value : null
  const plan = current?.plan
  const record = current?.record
  const history = current?.history
  const ready = runtimeReady && expanded && !busy
  const requirements = binding.outputs.map((output, index) => ({ id: `output-${index + 1}`, memberId: `output-${index + 1}`, title: `${t('qualityWorkspaceMaterial')} ${index + 1}: ${output.path.split(/[\\/]/).at(-1)?.slice(0, 230) ?? index + 1}` }))

  async function execute(operation: Operation): Promise<void> {
    if (!runtimeReady || !expanded || inFlight.current) return
    const token = ++generation.current
    const stillCurrent = (): boolean => activeScope.current === scope && generation.current === token
    inFlight.current = true; retry.current = operation
    setBusy(true); setError(''); setView(null)
    heading.current?.focus()
    try {
      const value = await operation(stillCurrent)
      if (stillCurrent()) { setView({ scope, value }); retry.current = null }
    } catch (cause) {
      if (stillCurrent()) {
        const reason = cause instanceof QualityRequestError ? cause.reason : 'request-failed'
        setError(reason)
        if (reason !== 'request-failed') retry.current = null
      }
    } finally { if (stillCurrent()) { inFlight.current = false; setBusy(false) } }
  }
  function loadPlans(offset = 0): void {
    void execute(async () => ({ history: { kind: 'plans', ...await listQualityPlans(binding, offset), offset } }))
  }
  function loadRecords(selected: QualityPlan, offset = 0): void {
    void execute(async () => {
      const fresh = await readQualityPlan(binding, selected)
      return { plan: fresh, history: { kind: 'records', ...await listQualityRecords(binding, fresh, offset), offset } }
    })
  }
  function append(checkId: string, memberId?: string): void {
    if (!plan || !record) return
    const appendKey = crypto.randomUUID(), evidenceKey = crypto.randomUUID()
    void execute(async stillCurrent => ({ plan, record: await appendQualityBytesCheck(binding, plan, record, checkId, appendKey, memberId, evidenceKey, stillCurrent) }))
  }
  const formatDate = (date: string): string => new Date(date).toLocaleString()

  return <details className="mt-3 min-w-0 rounded border border-ds-border-muted" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-2 font-medium">{t('qualityWorkspaceOpen')}</summary>
    {expanded ? <section className="min-w-0 space-y-3 border-t border-ds-border-muted p-3" aria-label={t('qualityWorkspaceTitle')}>
      <h4 ref={heading} tabIndex={-1} className="font-semibold">{t('qualityWorkspaceTitle')}</h4>
      <p className="leading-5 text-amber-900 dark:text-amber-200">{t('qualityWorkspaceBoundary')}</p>
      <p className="break-all text-ds-muted">{t('qualityWorkspaceBinding', { id: binding.manifestId, revision: binding.projectRevision })}</p>
      <div className="space-y-2">
        <p className="font-medium">{t('qualityWorkspaceProposedScope')}</p>
        <p className="text-ds-muted">{t('qualityWorkspaceScopeHint')}</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>{t('qualityWorkspaceArtifactBytes')}</li>
          {binding.outputs.map((output, index) => <li key={`${output.path}-${index}`} className="break-all"><span className="font-medium">{requirements[index]!.title}</span><span className="block text-ds-muted">{output.path}</span><span className="block font-mono text-[10px]">SHA-256 {output.sha256} · {output.sizeBytes} B</span></li>)}
        </ol>
        <label className="flex items-start gap-2 leading-5"><input type="checkbox" className="mt-1" checked={acknowledged} disabled={!ready || !!retry.current} onChange={event => setAcknowledged(event.target.checked)} /><span>{t('qualityWorkspaceAcknowledge')}</span></label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={!ready || !acknowledged || !binding.outputs.length || !!retry.current} onClick={() => {
            const key = crypto.randomUUID(); void execute(async () => ({ plan: await freezeQualityPlan(binding, requirements, key) }))
          }}>{t('qualityWorkspaceFreeze')}</button>
          <button type="button" className={buttonClass} disabled={!ready} onClick={() => loadPlans()}>{t('qualityWorkspacePlanHistory')}</button>
        </div>
      </div>
      {!runtimeReady ? <p role="status">{t('qualityWorkspaceOffline')}</p> : null}
      {busy ? <p role="status">{t('qualityWorkspaceLoading')}</p> : null}
      {error ? <div role="alert"><p>{t(failureKeys[error] ?? 'qualityWorkspaceFailed')}</p>{retry.current ? <button type="button" className={`${buttonClass} mt-2`} disabled={!ready} onClick={() => { if (retry.current) void execute(retry.current) }}>{t('qualityWorkspaceRetry')}</button> : null}</div> : null}
      {plan ? <EngineeringSelectedEvidence reference={{ kind: 'retention-plan', planId: plan.plan.id, manifestHash: plan.plan.manifestHash, artifactHash: plan.plan.artifactHash }}><div className="min-w-0 space-y-3 border-t border-ds-border-muted pt-3">
        <h5 className="font-medium">{t('qualityWorkspaceFrozenPlan')}<EngineeringEvidenceQuestion label={t('qualityWorkspaceFrozenPlan')} disabled={!ready} /></h5>
        <p className="break-all font-mono text-[10px]">{plan.plan.id} · {formatDate(plan.plan.createdAt)}</p>
        <ul className="list-disc space-y-1 pl-5"><li>{t('qualityWorkspaceArtifactBytes')}</li>{plan.plan.requiredEvidence.map((item, index) => <li key={item.id} className="break-words">{item.title}<EngineeringEvidenceQuestion label={item.title} selector={{ path: ['plan', 'requiredEvidence', index], identity: { id: item.id, memberId: item.memberId } }} disabled={!ready} /></li>)}</ul>
        <details><summary className="cursor-pointer">{t('qualityWorkspaceFrozenFiles')}</summary><ul className="mt-2 space-y-2">{plan.artifact.members.map((member, index) => <li key={member.id} className="break-all"><p>{member.path}<EngineeringEvidenceQuestion label={member.path} selector={{ path: ['artifact', 'members', index], identity: { id: member.id, sha256: member.sha256 } }} disabled={!ready} /></p><p className="font-mono text-[10px]">SHA-256 {member.sha256} · {member.sizeBytes} B</p></li>)}</ul><p className="mt-2 break-all font-mono text-[10px]">{t('qualityWorkspaceBundleHash')}: {plan.artifact.bundleHash}</p></details>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={!ready} onClick={() => { const key = crypto.randomUUID(); void execute(async () => ({ plan, record: await createQualityRecord(binding, plan, key) })) }}>{t('qualityWorkspaceCreateRecord')}</button>
          <button type="button" className={buttonClass} disabled={!ready} onClick={() => loadRecords(plan)}>{t('qualityWorkspaceRecordHistory')}</button>
        </div>
      </div></EngineeringSelectedEvidence> : null}
      {history ? <div className="space-y-2" aria-label={t(history.kind === 'plans' ? 'qualityWorkspacePlanHistory' : 'qualityWorkspaceRecordHistory')}>
        {history.unavailable.length ? <div role="status"><p>{t('qualityWorkspaceUnavailableHistory')}</p><ul className="mt-1 space-y-2">{history.unavailable.map(item => <li key={item.id} className="break-all">{item.id} · {t(item.reason === 'stale' ? 'qualityWorkspaceHistoryStale' : 'qualityWorkspaceHistoryIntegrity')}</li>)}</ul></div> : null}
        {(history.kind === 'plans' ? history.plans.length : history.records.length) === 0 ? <p>{t('qualityWorkspaceNoHistory')}</p> : null}
        {history.kind === 'plans' ? history.plans.map(item => <button type="button" key={item.plan.id} className={`${buttonClass} block w-full break-all`} disabled={!ready} onClick={() => void execute(async () => ({ plan: await readQualityPlan(binding, item) }))}>{t('qualityWorkspaceRestorePlan')} · {item.plan.id} · {formatDate(item.plan.createdAt)}</button>) : history.records.map(item => <button type="button" key={item.record.id} className={`${buttonClass} block w-full break-all`} disabled={!ready || !plan} onClick={() => { if (plan) void execute(async () => ({ plan, record: await readQualityRecord(binding, plan, item) })) }}>{t('qualityWorkspaceRestoreRecord')} · {item.record.id} · {formatDate(item.record.createdAt)}</button>)}
        <div className="flex flex-wrap gap-2">{history.offset > 0 ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => history.kind === 'plans' ? loadPlans(Math.max(0, history.offset - 20)) : plan && loadRecords(plan, Math.max(0, history.offset - 20))}>{t('qualityWorkspacePrevious')}</button> : null}{history.nextOffset !== null ? <button type="button" className={buttonClass} disabled={!ready} onClick={() => history.kind === 'plans' ? loadPlans(history.nextOffset!) : plan && loadRecords(plan, history.nextOffset!)}>{t('qualityWorkspaceNext')}</button> : null}</div>
      </div> : null}
      {plan && record ? <EngineeringSelectedEvidence reference={{ kind: 'retention-record', recordId: record.record.id, planHash: record.record.planHash, headHash: record.verification.headHash }}><div className="min-w-0 space-y-3 border-t border-ds-border-muted pt-3">
        <h5 className="font-medium">{t('qualityWorkspaceRecord')}<EngineeringEvidenceQuestion label={t('qualityWorkspaceRecord')} disabled={!ready} /></h5>
        <p className="break-all font-mono text-[10px]">{record.record.id}</p>
        <p role="status">{t('qualityWorkspaceVerifiedBoundary')}</p>
        <ul className="space-y-4">{record.verification.checks.map((check, index) => {
          const requirement = plan.plan.requiredEvidence.find(item => `evidence:${item.id}` === check.checkId)
          const title = requirement?.title ?? t('qualityWorkspaceArtifactBytes')
          const selected = requirement?.memberId
          return <li key={check.checkId} className="space-y-2 border border-ds-border-muted p-2"><p className="break-words font-medium">{title} · {t(check.status === 'passed' ? 'qualityWorkspaceRecorded' : 'qualityWorkspaceMissing')}<EngineeringEvidenceQuestion label={title} selector={{ path: ['verification', 'checks', index], identity: { checkId: check.checkId } }} disabled={!ready} /></p>
            {requirement ? <p className="break-all text-ds-muted">{t('qualityWorkspaceBoundMember')}: {selected} · {plan.artifact.members.find(member => member.id === selected)?.path}</p> : null}
            <button type="button" className={buttonClass} disabled={!ready} onClick={() => append(check.checkId, requirement ? selected : undefined)}>{t(requirement ? 'qualityWorkspaceRetainCheck' : 'qualityWorkspaceCheckBytes')}</button>
          </li>
        })}</ul>
        <button type="button" className={buttonClass} disabled={!ready} onClick={() => void execute(async () => ({ plan, record: await verifyQualityRecord(binding, plan, record) }))}>{t('qualityWorkspaceReverify')}</button>
        <details><summary className="cursor-pointer">{t('qualityWorkspaceAudit')}</summary><p className="mt-2 break-all font-mono text-[10px]">{t('qualityWorkspaceHeadHash')}: {record.verification.headHash}</p><p>{t('qualityWorkspaceEventCount', { count: record.events.length })}</p><ol className="mt-2 space-y-2">{record.events.map((event, index) => <li key={event.id} className="break-all font-mono text-[10px]">#{event.sequence} · {event.id} · {formatDate(event.occurredAt)} · {t('qualityWorkspaceSystemActor')}<EngineeringEvidenceQuestion label={event.id} selector={{ path: ['events', index], identity: { id: event.id, sequence: event.sequence, thisHash: event.thisHash } }} disabled={!ready} /><span className="block">{event.thisHash}</span></li>)}</ol></details>
        <SurveyQualityWorkflowWorkspace binding={binding} plan={plan} record={record} runtimeReady={runtimeReady && !busy} />
      </div></EngineeringSelectedEvidence> : null}
    </section> : null}
  </details>
}
