import { useEffect, useState, type ReactElement } from 'react'
import type { WorkspaceTrustLevel, WorkspaceTrustV1 } from '@shared/agent-workbench'
import { SettingRow } from './settings-controls'

const levels: WorkspaceTrustLevel[] = ['read-only', 'workspace-write', 'trusted', 'full-access']

export function WorkspaceTrustControl({ workspaceRoot, t }: {
  workspaceRoot: string
  t: (key: string, options?: Record<string, unknown>) => string
}): ReactElement {
  const [trust, setTrust] = useState<WorkspaceTrustV1 | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    setTrust(null)
    setError('')
    if (workspaceRoot.trim()) void window.workwise.getWorkspaceTrust(workspaceRoot).then(value => { if (active) setTrust(value) }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { active = false }
  }, [workspaceRoot])

  const update = async (level: WorkspaceTrustLevel): Promise<void> => {
    if (!trust || !workspaceRoot.trim()) return
    const raised = levels.indexOf(level) > levels.indexOf(trust.level)
    if (raised && !window.confirm(t('workspaceTrustElevationConfirm', { level: t(`agentCenterTrust_${level}`), path: workspaceRoot }))) return
    setBusy(true)
    setError('')
    try {
      const updated = await window.workwise.setWorkspaceTrust({
        workspaceRoot,
        level,
        expectedRevision: trust.revision,
        confirmed: raised,
        idempotencyKey: crypto.randomUUID()
      })
      setTrust(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      try { setTrust(await window.workwise.getWorkspaceTrust(workspaceRoot)) } catch { /* Preserve the original save error. */ }
    } finally { setBusy(false) }
  }

  return <SettingRow title={t('workspaceTrustTitle')} description={t('workspaceTrustDescription')} control={<div className="min-w-0">
    <select className="w-full rounded-md border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink disabled:opacity-50" value={trust?.level ?? 'read-only'} disabled={!trust || busy} onChange={event => void update(event.target.value as WorkspaceTrustLevel)}>
      {levels.map(level => <option key={level} value={level}>{t(`agentCenterTrust_${level}`)}</option>)}
    </select>
    {trust ? <code className="mt-1 block break-all text-[10px] leading-4 text-ds-faint">{trust.canonicalRoot}</code> : null}
    {error ? <p role="alert" className="mt-1 break-words text-[12px] text-red-700 dark:text-red-300">{error}</p> : null}
  </div>} />
}
