import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentProfileV1, TaskPermissionSnapshotV1, TaskRunV1 } from '@shared/agent-workbench'
import { runtimeTaskPermissionsPath, runtimeThreadPath } from '@shared/runtime-endpoints'

/** Explicit task-scoped confirmation. Reading this panel never changes authority or resumes work. */
export function TaskPermissionPanel({ taskId, onConfirmed, autoLoad = false, revision }: { taskId: string; onConfirmed: (message: string) => void; autoLoad?: boolean; revision?: number }): ReactElement {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<TaskPermissionSnapshotV1 | null>(null)
  const [task, setTask] = useState<TaskRunV1 | null>(null)
  const [profiles, setProfiles] = useState<AgentProfileV1[]>([])
  const [agentRevision, setAgentRevision] = useState(0)
  const [agentId, setAgentId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [editScope, setEditScope] = useState(false)
  const [duration, setDuration] = useState<'task'|'next_operation'>('task')
  const [scopeFields, setScopeFields] = useState({ readPaths: '', writePaths: '', networkOrigins: '', providerIds: '', externalTargets: '' })
  const loadGeneration = useRef(0)
  const terminal = Boolean(task && ['completed', 'failed', 'cancelled'].includes(task.status))
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending) return
    setPending(true); setError('')
    try { await operation() } catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setPending(false) }
  }
  const load = async (): Promise<void> => {
    const generation = ++loadGeneration.current
    const [permission, current] = await Promise.all([window.workwise.getTaskPermissions(taskId), window.workwise.getTaskRun(taskId)])
    if (generation !== loadGeneration.current) return
    if (!current) throw new Error(t('taskPermissionReadFailed'))
    setSnapshot(permission); setTask(current); setConfirmed(false)
    const scope = permission.grant?.scope
    setScopeFields({ readPaths: (scope?.readPaths ?? (permission.workspaceRoot ? [permission.workspaceRoot] : [])).join('\n'),
      writePaths: permission.sandboxMode === 'read-only' && !permission.canWritePaths ? '' : (scope?.writePaths ?? (permission.workspaceRoot ? [permission.workspaceRoot] : [])).join('\n'),
      networkOrigins: scope?.networkOrigins?.join('\n') ?? '', providerIds: scope?.providerIds?.join('\n') ?? '', externalTargets: scope?.externalTargets?.join('\n') ?? '' })
    const [agents, thread] = await Promise.all([
      window.workwise.listAgentProfiles(permission.workspaceRoot),
      window.workwise.runtimeRequest(runtimeThreadPath(current.threadId), 'GET')
    ])
    if (generation !== loadGeneration.current) return
    if (!thread.ok) throw new Error(t('taskPermissionReadFailed'))
    const value = JSON.parse(thread.body) as { agentRevision?: number }
    setAgentRevision(value.agentRevision ?? 0); setProfiles(agents.profiles)
  }
  useEffect(() => {
    if (autoLoad) void run(load)
    return () => { loadGeneration.current++ }
  }, [taskId, revision, autoLoad])
  const allow = async (): Promise<void> => {
    if (terminal || !snapshot || !confirmed || !snapshot.canConfirm) return
    const result = await window.workwise.confirmTaskPermissions(taskId, {
      expectedRevision: snapshot.taskRevision, scopeHash: snapshot.scopeHash, confirmed: true,
      approvalPolicy: 'on-request', ttlSeconds: 900, idempotencyKey: crypto.randomUUID(), duration,
      ...(editScope ? { scope: {
        readPaths: lines(scopeFields.readPaths), writePaths: lines(scopeFields.writePaths),
        ...(scopeFields.networkOrigins.trim() ? { networkOrigins: lines(scopeFields.networkOrigins) } : {}),
        ...(scopeFields.providerIds.trim() ? { providerIds: lines(scopeFields.providerIds) } : {}),
        ...(scopeFields.externalTargets.trim() ? { externalTargets: lines(scopeFields.externalTargets) } : {})
      } } : {})
    })
    setSnapshot(result.permission); setConfirmed(false)
    onConfirmed(t('taskPermissionSaved'))
  }
  const revoke = async ():Promise<void> => {
    if(!snapshot?.grant)return
    const response=await window.workwise.runtimeRequest(runtimeTaskPermissionsPath(taskId),'DELETE',JSON.stringify({expectedRevision:snapshot.taskRevision,permissionId:snapshot.grant.id,idempotencyKey:crypto.randomUUID()}))
    if(!response.ok)throw new Error(JSON.parse(response.body).message || t('taskPermissionReadFailed'))
    await load()
    onConfirmed(t('taskPermissionRevoked'))
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
        {source.provider}: {source.scopes.join(', ')} — {t(source.source === 'task_requirements' ? 'taskPermissionRequiredScopesSource' : source.source === 'tool_catalog' ? 'taskPermissionCatalogScopesSource' : 'taskPermissionRecordedScopesSource')}
        {source.expiresAt ? ` (${t('taskPermissionExpires', { at: new Date(source.expiresAt).toLocaleString() })})` : ''}
      </p>)}</div> : null}
      {!terminal ? <p>{t('taskPermissionScope')}</p> : null}
      {snapshot.executionGrants?.length ? <details className="rounded border border-ds-border p-2"><summary className="cursor-pointer font-medium">{t('taskPermissionExecutionHistory')}</summary>
        {[...snapshot.executionGrants].reverse().map(grant => <div key={grant.turnId} className="mt-2 space-y-1 border-t border-ds-border pt-2">
          <p>{t('taskPermissionExecutionRecorded', { at: new Date(grant.issuedAt).toLocaleString() })}</p>
          <p className="break-all">{grant.workspaceRoot} · {grant.sandboxMode} · {grant.approvalPolicy}</p>
          <p className="break-all">{t('taskPermissionExecutionTools')} {grant.allowedToolNames?.join(', ') || t('capabilityNoTools')}</p>
          <p className="break-all">{t('taskPermissionScopeRead')} {(grant.readPathAllowlist ?? grant.pathAllowlist).join(', ') || '—'}</p>
          <p className="break-all">{t('taskPermissionScopeWrite')} {(grant.writePathAllowlist ?? grant.pathAllowlist).join(', ') || '—'}</p>
          <p className="break-all">{t('taskPermissionScopeNetwork')} {grant.networkAllowlist.join(', ') || '—'}</p>
          <p className="break-all">{t('taskPermissionScopeProviders')} {grant.allowedProviderIds?.join(', ') || '—'}</p>
          <p className="break-all">{t('taskPermissionTargets')} {grant.externalTargets.join(', ') || '—'}</p>
          <p className="break-all">{t('taskPermissionConnectorScopes')} {grant.connectorScopes.join(', ') || '—'}</p>
        </div>)}
      </details> : null}
      {snapshot.grant ? <p>{t('taskPermissionExpires', { at: new Date(snapshot.grant.expiresAt).toLocaleString() })}</p> : null}
      {!terminal ? <>
      {snapshot.grant?.status === 'active' ? <button type="button" disabled={pending} onClick={() => void run(revoke)} className="rounded-md border border-ds-border px-3 py-1.5">{t('taskPermissionRevoke')}</button> : null}
      {snapshot.reason ? <p className="text-ds-muted">{snapshot.reason}</p> : null}
      <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={pending} onChange={event => setConfirmed(event.target.checked)} /><span>{t('taskPermissionConfirmScope')}</span></label>
      {snapshot.canConfirm ? <div className="space-y-2">
        <label className="block">{t('taskPermissionDuration')}<select value={duration} onChange={event => { setDuration(event.target.value as 'task'|'next_operation'); setConfirmed(false) }} className="ml-2 rounded border border-ds-border bg-ds-main p-1">
          <option value="task">{t('taskPermissionDurationTask')}</option><option value="next_operation">{t('taskPermissionDurationOnce')}</option>
        </select></label>
        <button type="button" onClick={() => { setEditScope(!editScope); setConfirmed(false) }} className="text-accent">{t('taskPermissionScopeEdit')}</button>
        {editScope ? <div className="space-y-2"><p className="text-ds-muted">{t('taskPermissionScopeHint')}</p>{([
          ['readPaths', 'taskPermissionScopeRead'], ['writePaths', 'taskPermissionScopeWrite'], ['networkOrigins', 'taskPermissionScopeNetwork'],
          ['providerIds', 'taskPermissionScopeProviders'], ['externalTargets', 'taskPermissionTargets']
        ] as const).map(([field, label]) => <label key={field} className="block">{t(label)}<textarea rows={2} value={scopeFields[field]} disabled={field === 'writePaths' && snapshot.sandboxMode === 'read-only' && !snapshot.canWritePaths} onChange={event => { setScopeFields(current => ({ ...current, [field]: event.target.value })); setConfirmed(false) }} className="mt-1 block w-full rounded border border-ds-border bg-ds-main p-2" /></label>)}</div> : null}
      </div> : null}
      <button type="button" disabled={pending || !confirmed || !snapshot.canConfirm} onClick={() => void run(allow)} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskPermissionAllow')}</button>
      {profiles.length && task && ['waiting_user', 'stalled', 'paused'].includes(task.status) ? <div className="flex flex-wrap gap-2">
        <select aria-label={t('taskPermissionSelectAgent')} value={agentId} disabled={pending} onChange={event => setAgentId(event.target.value)} className="max-w-full rounded border border-ds-border bg-ds-main p-1">
          <option value="">{t('taskPermissionSelectAgent')}</option>{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
        </select>
        <button type="button" disabled={pending || !confirmed || !agentId} onClick={() => void run(selectAgent)} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskPermissionApplyAgent')}</button>
      </div> : null}
      </> : null}
    </div> : null}
    {error ? <p role="alert" className="mt-2 whitespace-pre-wrap text-red-700 dark:text-red-300">{error}</p> : null}
  </div>
}

function lines(value: string): string[] { return value.split('\n').map(item => item.trim()).filter(Boolean) }
