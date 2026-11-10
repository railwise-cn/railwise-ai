import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProfileV1, TaskPermissionSnapshotV1, TaskRunV1 } from '@shared/agent-workbench'
import { runtimeThreadPath } from '@shared/runtime-endpoints'

/** Explicit task-scoped confirmation. Reading this panel never changes authority or resumes work. */
export function TaskPermissionPanel({ taskId, onConfirmed }: { taskId: string; onConfirmed: (message: string) => void }): ReactElement {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<TaskPermissionSnapshotV1 | null>(null)
  const [task, setTask] = useState<TaskRunV1 | null>(null)
  const [profiles, setProfiles] = useState<AgentProfileV1[]>([])
  const [agentRevision, setAgentRevision] = useState(0)
  const [agentId, setAgentId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending) return
    setPending(true); setError('')
    try { await operation() } catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setPending(false) }
  }
  const load = async (): Promise<void> => {
    const [permission, current] = await Promise.all([window.workwise.getTaskPermissions(taskId), window.workwise.getTaskRun(taskId)])
    if (!current) throw new Error(t('taskPermissionReadFailed'))
    setSnapshot(permission); setTask(current); setConfirmed(false)
    const [agents, thread] = await Promise.all([
      window.workwise.listAgentProfiles(permission.workspaceRoot),
      window.workwise.runtimeRequest(runtimeThreadPath(current.threadId), 'GET')
    ])
    if (!thread.ok) throw new Error(t('taskPermissionReadFailed'))
    const value = JSON.parse(thread.body) as { agentRevision?: number }
    setAgentRevision(value.agentRevision ?? 0); setProfiles(agents.profiles)
  }
  const allow = async (): Promise<void> => {
    if (!snapshot || !confirmed || !snapshot.canConfirm) return
    const result = await window.workwise.confirmTaskPermissions(taskId, {
      expectedRevision: snapshot.taskRevision, scopeHash: snapshot.scopeHash, confirmed: true,
      approvalPolicy: 'on-request', ttlSeconds: 900, idempotencyKey: crypto.randomUUID()
    })
    setSnapshot(result.permission); setConfirmed(false)
    onConfirmed(t('taskPermissionSaved'))
  }
  const selectAgent = async (): Promise<void> => {
    if (!task || !agentId || !confirmed || !['waiting_user', 'stalled', 'paused'].includes(task.status)) return
    await window.workwise.setThreadAgent(task.threadId, { agentId, expectedRevision: agentRevision, idempotencyKey: crypto.randomUUID() })
    await load()
    onConfirmed(t('taskPermissionAgentSaved'))
  }
  return <div className="mt-3 rounded-lg border border-ds-border p-3 text-xs">
    <button type="button" disabled={pending} onClick={() => void run(load)} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskPermissionReview')}</button>
    {snapshot ? <div className="mt-2 space-y-2">
      <p className="font-medium">{snapshot.taskTitle}</p>
      <p className="break-all">{t('capabilityWorkspace')}: {snapshot.workspaceRoot || t('capabilityWorkspaceUnknown')}</p>
      <p className="text-ds-muted">{t('taskPermissionCeilingNotice')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-ds-muted">{t('capabilityWorkspaceTrust')}</dt><dd>{t(`settings:agentCenterTrust_${snapshot.workspaceTrust}`)}</dd>
        <dt className="text-ds-muted">{t('taskPermissionAgent')}</dt><dd>{snapshot.agentName || t('taskPermissionLegacyAgent')}</dd>
        <dt className="text-ds-muted">{t('capabilityAgentTrust')}</dt><dd>{snapshot.agentTrust ? t(`settings:agentCenterTrust_${snapshot.agentTrust}`) : t('capabilityStateUnknown')}</dd>
        <dt className="text-ds-muted">{t('capabilitySandbox')}</dt><dd>{t(({ 'read-only': 'sandboxReadOnlyShort', 'workspace-write': 'sandboxWorkspaceWriteShort', 'danger-full-access': 'sandboxFullAccessShort', 'external-sandbox': 'sandboxExternalShort' } as Record<string, string>)[snapshot.sandboxMode ?? ''] ?? 'capabilityStateUnknown')}</dd>
        <dt className="text-ds-muted">{t('composerApprovalShort')}</dt><dd>{t(({ auto: 'approvalAutoShort', 'on-request': 'approvalOnRequestShort', untrusted: 'approvalUntrustedShort', suggest: 'approvalSuggestShort', never: 'approvalNeverShort' } as Record<string, string>)[snapshot.approvalPolicy] ?? 'capabilityStateUnknown')}</dd>
        <dt className="text-ds-muted">{t('taskPermissionTools')}</dt><dd className="break-all">{snapshot.toolAllowlist?.join(', ') || t(snapshot.toolAllowlist ? 'taskPermissionEmptyAllowlist' : snapshot.agentTrust ? 'taskPermissionNoExtraAllowlist' : 'capabilityStateUnknown')}</dd>
        <dt className="text-ds-muted">{t('taskPermissionMcp')}</dt><dd className="break-all">{snapshot.mcpAllowlist?.join(', ') || t(snapshot.mcpAllowlist ? 'taskPermissionEmptyAllowlist' : snapshot.agentTrust ? 'taskPermissionNoExtraAllowlist' : 'capabilityStateUnknown')}</dd>
        <dt className="text-ds-muted">{t('taskPermissionTargets')}</dt><dd className="break-all">{snapshot.externalTargets?.join('; ') || t(snapshot.externalTargets ? 'taskPermissionTargetsUnconfirmed' : 'capabilityStateUnknown')}</dd>
      </dl>
      {snapshot.connectorScopeSources?.length ? <div className="space-y-1"><p className="text-ds-muted">{t('taskPermissionConnectorScopes')}</p>{snapshot.connectorScopeSources.map((source, index) => <p className="break-all" key={`${source.provider}:${source.source}:${index}`}>
        {source.provider}: {source.scopes.join(', ')} — {t(source.source === 'task_requirements' ? 'taskPermissionRequiredScopesSource' : 'taskPermissionRecordedScopesSource')}
        {source.expiresAt ? ` (${t('taskPermissionExpires', { at: new Date(source.expiresAt).toLocaleString() })})` : ''}
      </p>)}</div> : null}
      <p>{t('taskPermissionScope')}</p>
      {snapshot.grant ? <p>{t('taskPermissionExpires', { at: new Date(snapshot.grant.expiresAt).toLocaleString() })}</p> : null}
      {snapshot.reason ? <p className="text-ds-muted">{snapshot.reason}</p> : null}
      <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={pending} onChange={event => setConfirmed(event.target.checked)} /><span>{t('taskPermissionConfirmScope')}</span></label>
      <button type="button" disabled={pending || !confirmed || !snapshot.canConfirm} onClick={() => void run(allow)} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskPermissionAllow')}</button>
      {profiles.length && task && ['waiting_user', 'stalled', 'paused'].includes(task.status) ? <div className="flex flex-wrap gap-2">
        <select aria-label={t('taskPermissionSelectAgent')} value={agentId} disabled={pending} onChange={event => setAgentId(event.target.value)} className="max-w-full rounded border border-ds-border bg-ds-main p-1">
          <option value="">{t('taskPermissionSelectAgent')}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        <button type="button" disabled={pending || !confirmed || !agentId} onClick={() => void run(selectAgent)} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskPermissionApplyAgent')}</button>
      </div> : null}
    </div> : null}
    {error ? <p role="alert" className="mt-2 whitespace-pre-wrap text-red-700 dark:text-red-300">{error}</p> : null}
  </div>
}
