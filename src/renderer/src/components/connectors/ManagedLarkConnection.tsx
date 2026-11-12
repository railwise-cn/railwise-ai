import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import type { ManagedLarkAppSetupResult, ManagedLarkLoginResult, ManagedToolState, WorkWiseApi } from '@shared/workwise-api'

type ConnectionApi = Partial<Pick<WorkWiseApi, 'beginManagedLarkLogin' | 'completeManagedLarkLogin' | 'beginManagedLarkAppSetup' | 'checkManagedLarkAppSetup' | 'cancelManagedLarkAppSetup'>>
export type ManagedLarkConnectionProps = {
  onChanged?: () => void | Promise<void>
  initialState?: ManagedToolState
  initialSkillWarning?: string
  compact?: boolean
  /** Only set after an explicit user click on Connect, never on catalog load. */
  autoConnect?: boolean
}

/** Shared connection flow: official installation, app scan and user login. No task execution. */
export function ManagedLarkConnection({ onChanged, initialState, initialSkillWarning, compact = false, autoConnect = false }: ManagedLarkConnectionProps): ReactElement {
  const { t } = useTranslation('common')
  const api: ConnectionApi = window.workwise
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [state, setState] = useState<ManagedToolState | undefined>(initialState)
  const [skillWarning, setSkillWarning] = useState(initialSkillWarning)
  const [login, setLogin] = useState<Extract<ManagedLarkLoginResult, { ok: true }> | null>(null)
  const [appSetup, setAppSetup] = useState<Extract<ManagedLarkAppSetupResult, { ok: true }> | null>(null)
  const [appRequired, setAppRequired] = useState(false)
  const [capability, setCapability] = useState<'tasks' | 'mail' | 'im' | 'drive'>('tasks')
  const appSetupGeneration = useRef(0)
  const started = useRef(false)
  const busy = useRef(false)
  const run = useCallback(async (operation: () => Promise<void>): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    setMessage('')
    try { await operation() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; setPending(false) }
  }, [])
  const managed = useCallback(async (install: boolean) => {
    const result = await (install ? window.workwise.installManagedTool('lark-cli') : window.workwise.diagnoseManagedTool('lark-cli'))
    if (!result.ok) throw new Error(result.message)
    setState(result.status.state)
    setSkillWarning(result.status.skillWarning)
    const statusMessage = result.status.message ?? t(`capabilityManaged_${result.status.state}`)
    setMessage(result.status.skillWarning ? statusMessage.replace(result.status.skillWarning, '').trim() : statusMessage)
    await onChanged?.()
    return result.status
  }, [onChanged, t])
  const beginAppSetup = useCallback(async (): Promise<void> => {
    if (!api.beginManagedLarkAppSetup) throw new Error(t('capabilityLoginUnavailable'))
    const result = await api.beginManagedLarkAppSetup()
    if (!result.ok) throw new Error(result.message)
    appSetupGeneration.current++
    setAppSetup(result)
    if (result.state === 'configured') { setAppRequired(false); setMessage(t('capabilityLarkAppReady')); await onChanged?.(); return }
    if (result.verificationUrl && result.state === 'waiting') await window.workwise.openExternal(result.verificationUrl)
    setMessage(t(`capabilityLarkApp_${result.state}`))
  }, [api, onChanged, t])
  const beginLogin = useCallback(async (setupIfRequired = false): Promise<void> => {
    if (!api.beginManagedLarkLogin) throw new Error(t('capabilityLoginUnavailable'))
    const result = await api.beginManagedLarkLogin({ capability })
    if (!result.ok) {
      if (result.reason === 'app_configuration_required') {
        setAppRequired(true)
        setMessage(t('capabilityLarkAppRequired'))
        if (setupIfRequired) await beginAppSetup()
        return
      }
      throw new Error(result.message)
    }
    setAppRequired(false)
    setLogin(result)
    setMessage(t('capabilityLoginIncomplete'))
    // Main validates the official URL; no app secret or device code crosses IPC.
    await window.workwise.openExternal(result.verificationUrl)
  }, [api, beginAppSetup, capability, t])
  const connect = useCallback(async (): Promise<void> => {
    let status = await managed(false)
    if (status.state === 'not_installed') status = await managed(true)
    if (capability !== 'tasks' && status.installedVersion !== '1.0.100') status = await managed(true)
    if (status.state === 'error' || status.state === 'not_installed') throw new Error(status.message || t('capabilityManaged_error'))
    await beginLogin(true)
  }, [beginLogin, capability, managed, t])
  useEffect(() => {
    setSkillWarning(initialSkillWarning)
  }, [initialSkillWarning])
  useEffect(() => {
    if (!autoConnect || started.current) return
    started.current = true
    void run(connect)
  }, [autoConnect, connect, run])
  useEffect(() => {
    if (!login) return
    const remaining = Date.parse(login.expiresAt) - Date.now()
    if (!Number.isFinite(remaining)) return
    const timer = setTimeout(() => {
      setLogin(null)
      setMessage(t('managedLarkAuthorizationExpired'))
    }, Math.max(0, Math.min(remaining, 2_147_483_647)))
    return () => clearTimeout(timer)
  }, [login, t])
  useEffect(() => {
    if (appSetup?.state !== 'waiting' || !appSetup.expiresAt) return
    const remaining = Date.parse(appSetup.expiresAt) - Date.now()
    if (!Number.isFinite(remaining)) return
    const generation = appSetupGeneration.current
    const timer = setTimeout(() => {
      if (generation !== appSetupGeneration.current) return
      appSetupGeneration.current++
      setAppSetup({ ok: true, state: 'expired', expiresAt: appSetup.expiresAt })
      setMessage(t('capabilityLarkApp_expired'))
    }, Math.max(0, Math.min(remaining, 2_147_483_647)))
    return () => clearTimeout(timer)
  }, [appSetup, t])
  const checkAppSetup = async (cancel = false): Promise<void> => {
    const action = cancel ? api.cancelManagedLarkAppSetup : api.checkManagedLarkAppSetup
    if (!action) throw new Error(t('capabilityLoginUnavailable'))
    const result = await action()
    if (!result.ok) throw new Error(result.message)
    appSetupGeneration.current++
    setAppSetup(result)
    if (result.state === 'configured') {
      setAppRequired(false)
      setMessage(t('capabilityLarkAppReady'))
      await onChanged?.()
      if (!compact) await beginLogin()
    } else setMessage(t(`capabilityLarkApp_${result.state}`))
  }
  const finishLogin = async (): Promise<void> => {
    if (!api.completeManagedLarkLogin) throw new Error(t('capabilityLoginUnavailable'))
    const result = await api.completeManagedLarkLogin()
    if (!result.ok) throw new Error(result.message)
    setLogin(null)
    setState(result.status.state)
    setMessage(result.status.state === 'installed' ? t('capabilityLoginReady') : result.status.message ?? t('capabilityLoginIncomplete'))
    await onChanged?.()
  }
  const authorization = appSetup?.state === 'waiting' ? appSetup : login
  return <section aria-label={t('managedLarkConnectionTitle')} className={compact ? 'mt-3 border-t border-ds-border pt-3' : 'rounded-xl border border-ds-border bg-ds-surface p-4'}>
    {!compact ? <h3 className="font-semibold">{t('managedLarkConnectionTitle')}</h3> : null}
    <p className="text-xs text-ds-muted">{t('managedLarkConnectionDescription')}</p>
    <label className="mt-3 flex flex-col gap-1 text-xs">
      <span>{t('managedLarkCapabilityLabel')}</span>
      <select value={capability} disabled={pending || Boolean(login) || appSetup?.state === 'waiting'}
        onChange={event => setCapability(event.target.value as typeof capability)}
        className="rounded-md border border-ds-border bg-ds-surface px-2 py-2">
        <option value="tasks">{t('managedLarkCapabilityTasks')}</option>
        <option value="mail">{t('managedLarkCapabilityMail')}</option>
        <option value="im">{t('managedLarkCapabilityIm')}</option>
        <option value="drive">{t('managedLarkCapabilityDrive')}</option>
      </select>
    </label>
    <p className="mt-1 text-xs text-ds-muted">{t('managedLarkCapabilityScopeHint')}</p>
    {appRequired ? <p className="mt-3 text-xs">{t('capabilityLarkAppRequired')}</p> : null}
    {authorization?.verificationUrl ? <div role="status" className="mt-3 rounded-lg border border-ds-border bg-ds-surface p-3">
      <div className="inline-block rounded-lg bg-white p-2"><QRCodeSVG value={authorization.verificationUrl} size={144} marginSize={1} title={t('managedLarkQrCode')} /></div>
      {login?.userCode && appSetup?.state !== 'waiting' ? <p>{t('capabilityLoginCode', { code: login.userCode })}</p> : null}
      {authorization.expiresAt ? <p className="mt-1 text-xs text-ds-muted">{t('capabilityLoginExpires', { expiresAt: new Date(authorization.expiresAt).toLocaleString() })}</p> : null}
      <button type="button" disabled={pending} onClick={() => void run(async () => { await window.workwise.openExternal(authorization.verificationUrl!) })} className="mt-2 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('managedLarkOpenAuthorization')}</button>
      {appSetup?.state === 'waiting' ? <>
        <p className="mt-2 text-xs">{t('capabilityLarkApp_waiting')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={pending} onClick={() => void run(() => checkAppSetup())} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('capabilityLarkAppCheck')}</button>
          <button type="button" disabled={pending} onClick={() => void run(() => checkAppSetup(true))} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('capabilityLarkAppCancel')}</button>
        </div>
      </> : <button type="button" disabled={pending} onClick={() => void run(finishLogin)} className="ml-2 mt-2 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('capabilityLoginCompleted')}</button>}
    </div> : null}
    {message ? <p role="status" className="mt-3 whitespace-pre-wrap text-xs">{message}</p> : null}
    {skillWarning ? <p role="status" className="mt-3 whitespace-pre-wrap rounded-md border border-amber-400/50 p-3 text-xs">{skillWarning}</p> : null}
    <div className="mt-3 flex flex-wrap gap-2 [&_button]:rounded-md [&_button]:border [&_button]:border-ds-border [&_button]:px-3 [&_button]:py-1.5 [&_button:disabled]:opacity-50">
      {!compact ? <button type="button" disabled={pending || appSetup?.state === 'waiting' || Boolean(login)} onClick={() => void run(connect)}>{t('managedLarkConnect')}</button> : null}
      {compact && state === 'not_installed' ? <button type="button" disabled={pending} onClick={() => void run(async () => { await managed(true) })}>{t('capabilityInstallLark')}</button> : null}
      <button type="button" disabled={pending} onClick={() => void run(async () => { await managed(false) })}>{t(compact ? 'capabilityDiagnose' : 'connectorHubCheckConnections')}</button>
      {skillWarning ? <button type="button" disabled={pending || appSetup?.state === 'waiting' || Boolean(login)} onClick={() => void run(async () => { await managed(true) })}>{t('managedLarkRepairTools')}</button> : null}
      {appRequired && api.beginManagedLarkAppSetup ? <button type="button" disabled={pending || appSetup?.state === 'waiting'} onClick={() => void run(beginAppSetup)}>{t('capabilityLarkAppConfigure')}</button> : null}
      {compact && state !== 'not_installed' && api.beginManagedLarkLogin ? <button type="button" disabled={pending || appSetup?.state === 'waiting'} onClick={() => void run(() => beginLogin())}>{t('capabilityLoginLark')}</button> : null}
    </div>
  </section>
}
