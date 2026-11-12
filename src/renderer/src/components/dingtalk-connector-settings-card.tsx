import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { InlineNoticeView, SettingsCard } from './settings-controls'

type DingTalkStatus = {
  enabled: boolean
  available: boolean
  credentialState: 'missing' | 'invalid' | 'valid'
  identityVerified: boolean
  scopes: string[]
  reason?: string
  checkedAt: string
}

type OAuthStart = { authorizationUrl: string; expiresAt: string }
type OAuthComplete = { unionId: string; expiresAt: string; status: DingTalkStatus }

const USER_SCOPES = ['Todo.Todo.Read', 'Todo.Todo.Write'] as const
const WORKFLOW_SCOPES = ['qyapi_aflow', 'Workflow.Instance.Read', 'Workflow.Instance.Write'] as const

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await rendererRuntimeClient.runtimeRequest(
    path,
    'POST',
    body === undefined ? undefined : JSON.stringify(body)
  )
  let payload: { message?: string } & Record<string, unknown> = {}
  try { payload = JSON.parse(response.body) as typeof payload } catch { /* handled below */ }
  if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`)
  return payload as T
}

export function DingTalkConnectorSettingsCard(): ReactElement {
  const { t } = useTranslation('settings')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState('')
  const [userId, setUserId] = useState('')
  const [todoWrite, setTodoWrite] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [workflowUserId, setWorkflowUserId] = useState('')
  const [workflowUnionId, setWorkflowUnionId] = useState('')
  const [workflowScopes, setWorkflowScopes] = useState<string[]>(['qyapi_aflow', 'Workflow.Instance.Read'])
  const [confirmWorkflow, setConfirmWorkflow] = useState(false)
  const [oauthExpiresAt, setOauthExpiresAt] = useState('')
  const [status, setStatus] = useState<DingTalkStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null)

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try { await action() }
    catch (error) { setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) }) }
    finally { setBusy(false) }
  }

  const saveConfig = async (): Promise<void> => {
    if (!clientId.trim() || !clientSecret || !redirectUri.trim()) throw new Error(t('dingtalkRequiredFields'))
    if (todoWrite && !userId.trim()) throw new Error(t('dingtalkTodoWriterRequired'))
    await post('/v1/connectors/dingtalk/configure', {
      clientId: clientId.trim(), clientSecret, redirectUri: redirectUri.trim(),
      userScopes: USER_SCOPES.filter(scope => scope === 'Todo.Todo.Read' || todoWrite),
      ...(userId.trim() ? { userId: userId.trim() } : {}),
      allowedWriteUserIds: todoWrite ? [userId.trim()] : []
    })
    setClientSecret('')
    setNotice({ tone: 'success', message: t('dingtalkConfigSaved') })
  }

  const startOAuth = async (): Promise<void> => {
    const result = await post<OAuthStart>('/v1/connectors/dingtalk/oauth/start')
    await window.workwise.openExternal(result.authorizationUrl)
    setOauthExpiresAt(result.expiresAt)
    setNotice({ tone: 'info', message: t('dingtalkOAuthStarted', { expiresAt: new Date(result.expiresAt).toLocaleString() }) })
  }

  const completeOAuth = async (): Promise<void> => {
    if (!callbackUrl.trim()) throw new Error(t('dingtalkCallbackRequired'))
    const result = await post<OAuthComplete>('/v1/connectors/dingtalk/oauth/complete', { callbackUrl: callbackUrl.trim() })
    setStatus(result.status)
    setCallbackUrl('')
    setOauthExpiresAt('')
    setNotice({ tone: 'success', message: t('dingtalkOAuthComplete') })
  }

  const authorizeWorkflow = async (): Promise<void> => {
    if (!confirmWorkflow) throw new Error(t('dingtalkWorkflowConfirmRequired'))
    if (!workflowUserId.trim() || !workflowUnionId.trim()) throw new Error(t('dingtalkWorkflowIdentityRequired'))
    const result = await post<{ expiresAt: string; status: DingTalkStatus }>('/v1/connectors/dingtalk/workflow/authorize', {
      confirmed: true, userId: workflowUserId.trim(), unionId: workflowUnionId.trim(), scopes: workflowScopes
    })
    setStatus(result.status)
    setConfirmWorkflow(false)
    setNotice({ tone: 'success', message: t('dingtalkWorkflowConnected') })
  }

  const checkStatus = async (): Promise<void> => {
    setStatus(await post<DingTalkStatus>('/v1/connectors/dingtalk/refresh'))
    setNotice({ tone: 'info', message: t('dingtalkStatusUpdated') })
  }

  const inputClass = 'w-full min-w-0 rounded-md border border-ds-border bg-ds-main px-3 py-2 text-sm text-ds-ink placeholder:text-ds-muted focus:border-accent focus:outline-none'
  const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-md border border-ds-border bg-ds-card px-3 py-2 text-sm font-medium text-ds-ink transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-50'

  return <SettingsCard title={t('dingtalkConnectorTitle')} className="mt-6">
    <div className="space-y-4 px-3 py-4">
      <p className="max-w-3xl text-sm leading-relaxed text-ds-muted">{t('dingtalkConnectorDescription')}</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="min-w-0 space-y-1 text-xs font-medium text-ds-muted">
          <span>{t('dingtalkClientId')}</span>
          <input className={inputClass} autoComplete="off" value={clientId} onChange={event => setClientId(event.target.value)} />
        </label>
        <label className="min-w-0 space-y-1 text-xs font-medium text-ds-muted">
          <span>{t('dingtalkClientSecret')}</span>
          <input className={inputClass} type="password" autoComplete="new-password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} />
        </label>
        <label className="min-w-0 space-y-1 text-xs font-medium text-ds-muted sm:col-span-2">
          <span>{t('dingtalkRedirectUri')}</span>
          <input className={inputClass} type="url" autoComplete="url" placeholder="https://… or http://127.0.0.1/…" value={redirectUri} onChange={event => setRedirectUri(event.target.value)} />
        </label>
        <label className="min-w-0 space-y-1 text-xs font-medium text-ds-muted sm:col-span-2">
          <span>{t('dingtalkTodoUserId')}</span>
          <input className={inputClass} autoComplete="off" value={userId} onChange={event => setUserId(event.target.value)} />
        </label>
      </div>
      <label className="flex min-w-0 items-start gap-2 text-sm text-ds-ink">
        <input className="mt-0.5 shrink-0" type="checkbox" checked={todoWrite} onChange={event => setTodoWrite(event.target.checked)} />
        <span className="min-w-0">{t('dingtalkEnableTodoWrite')}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(saveConfig)}>{t('dingtalkSaveConfig')}</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(startOAuth)}><ExternalLink className="h-4 w-4" />{t('dingtalkStartOAuth')}</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(checkStatus)}><RefreshCw className="h-4 w-4" />{t('dingtalkCheckStatus')}</button>
      </div>
      {oauthExpiresAt ? <p className="text-xs text-ds-muted">{t('dingtalkOAuthExpires', { expiresAt: new Date(oauthExpiresAt).toLocaleString() })}</p> : null}
      <label className="block space-y-1 text-xs font-medium text-ds-muted">
        <span>{t('dingtalkCallbackUrl')}</span>
        <textarea className={`${inputClass} min-h-20 resize-y`} autoComplete="off" value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} />
      </label>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(completeOAuth)}>{t('dingtalkCompleteOAuth')}</button>
      {status ? <div role="status" className="rounded-md border border-ds-border bg-ds-main p-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-ds-ink">
          {status.available ? <ShieldCheck className="h-4 w-4 text-emerald-600" /> : <ShieldX className="h-4 w-4 text-amber-600" />}
          {t(status.available ? 'dingtalkStatusAvailable' : 'dingtalkStatusUnavailable')}
        </div>
        {status.reason ? <p className="mt-1 text-xs text-ds-muted">{status.reason}</p> : null}
        <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ds-muted">{t('dingtalkCredentialState')}</dt><dd className="break-words">{t(`dingtalkCredential_${status.credentialState}`)}</dd>
          <dt className="text-ds-muted">{t('dingtalkIdentityVerified')}</dt><dd>{t(status.identityVerified ? 'dingtalkYes' : 'dingtalkNo')}</dd>
          <dt className="text-ds-muted">{t('dingtalkGrantedScopes')}</dt><dd className="break-all">{status.scopes.length ? status.scopes.join(', ') : t('dingtalkNoScopes')}</dd>
        </dl>
      </div> : null}
      <div className="border-t border-ds-border-muted pt-4">
        <h3 className="text-sm font-semibold text-ds-ink">{t('dingtalkWorkflowTitle')}</h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ds-muted">{t('dingtalkWorkflowDescription')}</p>
        <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
          <label className="min-w-0 space-y-1 text-xs font-medium text-ds-muted">
            <span>{t('dingtalkWorkflowUserId')}</span>
            <input className={inputClass} autoComplete="off" value={workflowUserId} onChange={event => setWorkflowUserId(event.target.value)} />
          </label>
          <label className="min-w-0 space-y-1 text-xs font-medium text-ds-muted">
            <span>{t('dingtalkWorkflowUnionId')}</span>
            <input className={inputClass} autoComplete="off" value={workflowUnionId} onChange={event => setWorkflowUnionId(event.target.value)} />
          </label>
        </div>
        <fieldset className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ds-ink">
          <legend className="mb-2 text-xs font-medium text-ds-muted">{t('dingtalkWorkflowScopes')}</legend>
          {WORKFLOW_SCOPES.map(scope => <label key={scope} className="flex min-w-0 items-start gap-2">
            <input className="mt-0.5 shrink-0" type="checkbox" checked={workflowScopes.includes(scope)} onChange={event => setWorkflowScopes(current => event.target.checked ? [...new Set([...current, scope])] : current.filter(value => value !== scope))} />
            <span className="break-all">{scope}</span>
          </label>)}
        </fieldset>
        <label className="mt-3 flex min-w-0 items-start gap-2 text-sm text-ds-ink">
          <input className="mt-0.5 shrink-0" type="checkbox" checked={confirmWorkflow} onChange={event => setConfirmWorkflow(event.target.checked)} />
          <span className="min-w-0">{t('dingtalkWorkflowConfirm')}</span>
        </label>
        <button type="button" className={`${buttonClass} mt-3`} disabled={busy || !confirmWorkflow} onClick={() => void run(authorizeWorkflow)}>{t('dingtalkAuthorizeWorkflow')}</button>
      </div>
      {notice ? <InlineNoticeView notice={notice} /> : null}
    </div>
  </SettingsCard>
}
