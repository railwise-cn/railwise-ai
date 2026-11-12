import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import type { ManagedDwsResult, ManagedDwsStatus } from '@shared/managed-dws'

type Props = {
  onChanged?: () => void | Promise<void>
  /** Set only as a result of the user's Connect action. */
  autoConnect?: boolean
}
type Login = Extract<ManagedDwsResult, { ok: true }>

/** Official device authorization; connecting an account never executes a task. */
export function ManagedDingTalkConnection({ onChanged, autoConnect = false }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<ManagedDwsStatus>()
  const [login, setLogin] = useState<Login>()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [browserError, setBrowserError] = useState(false)
  const [accessMessage, setAccessMessage] = useState('')
  const authorizationRef = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const started = useRef(false)
  const mounted = useRef(true)
  const changed = useRef(onChanged)
  changed.current = onChanged

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = useCallback(async (operation: () => Promise<void>, silent = false): Promise<void> => {
    if (busy.current) return
    busy.current = true
    if (mounted.current) { setPending(true); if (!silent) setMessage('') }
    try { await operation() }
    catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : String(error)) }
    finally { busy.current = false; if (mounted.current) setPending(false) }
  }, [])
  const apply = useCallback(async (result: ManagedDwsResult): Promise<Login> => {
    if (!result.ok) throw new Error(result.message)
    if (!mounted.current) return result
    if (result.status) setStatus(result.status)
    if (result.state) setLogin(result)
    if (result.message) setMessage(result.message)
    else if (result.state) setMessage(t(`managedDwsLogin_${result.state}`))
    else if (result.status) setMessage(result.status.message ?? '')
    return result
  }, [t])
  const diagnose = useCallback(async (): Promise<ManagedDwsStatus | undefined> => {
    if (!window.workwise.diagnoseManagedDingTalk) throw new Error(t('capabilityLoginUnavailable'))
    const result = await apply(await window.workwise.diagnoseManagedDingTalk())
    await changed.current?.()
    return result.status
  }, [apply, t])
  const openAuthorization = useCallback(async (url: string): Promise<void> => {
    setBrowserError(false)
    try { await window.workwise.openExternal(url) }
    catch { if (mounted.current) setBrowserError(true) }
  }, [])
  const connect = useCallback(async (): Promise<void> => {
    setBrowserError(false)
    setAccessMessage('')
    let current = await diagnose()
    if (!mounted.current) return
    if (current?.enabled === false) { setMessage(t('managedDwsDisabled')); return }
    if (current?.state === 'not_installed') {
      if (!window.workwise.installManagedDingTalk) throw new Error(t('capabilityLoginUnavailable'))
      setMessage(t('managedDwsInstalling'))
      current = (await apply(await window.workwise.installManagedDingTalk())).status
      await changed.current?.()
    }
    if (!mounted.current) return
    if (!current || current.state === 'not_installed' || current.state === 'error') throw new Error(current?.message ?? t('managedDwsStatus_error'))
    if (!window.workwise.beginManagedDingTalkLogin) throw new Error(t('capabilityLoginUnavailable'))
    const result = await apply(await window.workwise.beginManagedDingTalkLogin())
    if (result.state === 'succeeded') await changed.current?.()
    // The main process accepts only the pinned official CLI's allowlisted URL.
    if (mounted.current && result.state === 'waiting' && result.verificationUrl) await openAuthorization(result.verificationUrl)
  }, [apply, diagnose, openAuthorization, t])
  const check = useCallback(async (): Promise<void> => {
    if (!window.workwise.checkManagedDingTalkLogin) throw new Error(t('capabilityLoginUnavailable'))
    const checked = await window.workwise.checkManagedDingTalkLogin()
    // An unverifiable result requires explicit attention, not an endless retry
    // loop that could hide an identity change or an expired authorization.
    if (!checked.ok && mounted.current) setLogin(undefined)
    const result = await apply(checked)
    if (result.state === 'succeeded' || result.state === 'failed' || result.state === 'expired') await changed.current?.()
  }, [apply, t])

  useEffect(() => {
    if (!autoConnect || started.current) return
    started.current = true
    void run(connect)
  }, [autoConnect, connect, run])
  useEffect(() => {
    if (login?.state !== 'waiting') return
    const timer = setInterval(() => { void run(check, true) }, 2500)
    return () => clearInterval(timer)
  }, [check, login?.state, run])
  const waiting = login?.state === 'waiting'
  useEffect(() => {
    if (waiting && login.verificationUrl) authorizationRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [waiting, login?.verificationUrl])

  return <section aria-label={t('managedDwsTitle')} className="rounded-xl border border-ds-border bg-ds-surface p-4">
    <h3 className="font-semibold">{t('managedDwsTitle')}</h3>
    <p className="mt-1 text-xs leading-5 text-ds-muted">{t('managedDwsDescription')}</p>
    {status ? <p className="mt-3 text-xs">{status.enabled === false ? t('managedDwsDisabled') : t(`managedDwsStatus_${status.state}`)}</p> : null}
    {waiting && login.verificationUrl ? <div ref={authorizationRef} className="mt-3 rounded-lg border border-ds-border p-3">
      <div className="inline-block rounded-lg bg-white p-2"><QRCodeSVG value={login.verificationUrl} size={208} marginSize={2} title={t('managedDwsQrCode')} /></div>
      {login.userCode ? <p className="mt-2 text-sm">{t('capabilityLoginCode', { code: login.userCode })}</p> : null}
      {login.expiresAt ? <p className="mt-1 text-xs text-ds-muted">{t('capabilityLoginExpires', { expiresAt: new Date(login.expiresAt).toLocaleString() })}</p> : null}
      <p className="mt-2 text-xs text-ds-muted">{t('managedDwsWaiting')}</p>
      {browserError ? <p role="alert" className="mt-2 text-sm">{t('managedDwsBrowserFailed')}</p> : null}
      <label className="mt-2 block text-xs text-ds-muted">{t('managedDwsAuthorizationLink')}<input readOnly value={login.verificationUrl} className="mt-1 w-full rounded border border-ds-border bg-ds-card px-2 py-1.5" onFocus={event => event.currentTarget.select()} /></label>
      <button type="button" disabled={pending} onClick={() => void run(async () => { await openAuthorization(login.verificationUrl!) })} className="mt-2 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('managedLarkOpenAuthorization')}</button>
      <button type="button" disabled={pending} onClick={() => void run(async () => {
        try { await navigator.clipboard.writeText(login.verificationUrl!); setMessage(t('managedDwsLinkCopied')) }
        catch { setMessage(t('managedDwsCopyFailed')) }
      })} className="ml-2 mt-2 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('managedDwsCopyLink')}</button>
    </div> : null}
    {message ? <p role="status" className="mt-3 whitespace-pre-wrap text-xs leading-5">{message}</p> : null}
    {accessMessage ? <p role="status" className="mt-3 whitespace-pre-wrap text-sm leading-5">{accessMessage}</p> : null}
    <div className="mt-3 flex flex-wrap gap-2 [&_button]:rounded-md [&_button]:border [&_button]:border-ds-border [&_button]:px-3 [&_button]:py-1.5 [&_button:disabled]:opacity-50">
      <button type="button" disabled={pending || waiting || status?.enabled === false} onClick={() => void run(connect)}>{t(status?.state === 'installed' ? 'managedDwsReconnect' : 'managedDwsConnect')}</button>
      <button type="button" disabled={pending} onClick={() => void run(async () => { await diagnose() })}>{t('managedDwsCheckLogin')}</button>
      <button type="button" disabled={pending || waiting || status?.enabled === false} onClick={() => void run(async () => {
        if (!window.workwise.checkManagedDingTalkTaskAccess) throw new Error(t('capabilityLoginUnavailable'))
        setAccessMessage(t('managedDwsReadChecking'))
        try {
          const result = await window.workwise.checkManagedDingTalkTaskAccess()
          setAccessMessage(result.ok ? t('managedDwsReadSuccess', { count: result.itemCount }) : result.message)
        } catch {
          setAccessMessage(t('managedDwsReadFailed'))
        }
      })}>{t('managedDwsTestAccess')}</button>
      <button type="button" disabled={pending} onClick={() => void run(async () => {
        if (!window.workwise.openDingTalkDesktop) throw new Error(t('managedDwsDesktop_unsupported'))
        const result = await window.workwise.openDingTalkDesktop()
        setMessage(t(result.ok ? 'managedDwsDesktopOpened' : `managedDwsDesktop_${result.code}`))
      })}>{t('managedDwsOpenDesktop')}</button>
      {status?.enabled !== undefined && !waiting ? <button type="button" disabled={pending} onClick={() => void run(async () => {
        if (!window.workwise.setManagedDingTalkEnabled) throw new Error(t('capabilityLoginUnavailable'))
        await apply(await window.workwise.setManagedDingTalkEnabled(!status.enabled))
        await changed.current?.()
      })}>{t(status.enabled ? 'managedDwsDisable' : 'managedDwsEnable')}</button> : null}
      {waiting ? <>
        <button type="button" disabled={pending} onClick={() => void run(check)}>{t('capabilityLoginCompleted')}</button>
        <button type="button" disabled={pending} onClick={() => void run(async () => {
          if (!window.workwise.cancelManagedDingTalkLogin) throw new Error(t('capabilityLoginUnavailable'))
          await apply(await window.workwise.cancelManagedDingTalkLogin())
        })}>{t('managedDwsCancel')}</button>
      </> : null}
    </div>
  </section>
}
