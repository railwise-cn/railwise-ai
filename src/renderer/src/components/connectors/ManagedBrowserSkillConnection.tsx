import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ManagedBrowserSkillResult, ManagedBrowserSkillStatus } from '@shared/managed-browser-skill'

export function ManagedBrowserSkillConnection({ onChanged }: { onChanged?: () => void | Promise<void> }): ReactElement {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<ManagedBrowserSkillStatus>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [browser, setBrowser] = useState('')
  const [origins, setOrigins] = useState('')
  const [interaction, setInteraction] = useState(false)
  const [enabled, setEnabled] = useState(false)

  const apply = (result: ManagedBrowserSkillResult): void => {
    setStatus(result.status)
    setBrowser(result.status.browserInstanceId ?? '')
    setOrigins(result.status.origins.join('\n'))
    setInteraction(result.status.interaction === 'interact')
    setEnabled(result.status.enabled)
    setMessage(result.message ?? result.status.message ?? '')
  }
  const run = async (operation: () => Promise<ManagedBrowserSkillResult>): Promise<void> => {
    setBusy(true)
    setMessage('')
    try { apply(await operation()); await onChanged?.() }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    let active = true
    void window.workwise.diagnoseBrowserSkill().then(result => { if (active) apply(result) })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [])

  const save = async (): Promise<ManagedBrowserSkillResult> => {
    if (!status) throw new Error(t('browserSkillCheckFirst'))
    const sites = [...new Set(origins.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean))]
    for (const value of sites) {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) throw new Error(t('browserSkillOriginInvalid'))
    }
    return window.workwise.configureBrowserSkill({ enabled, browserInstanceId: browser || undefined, origins: sites,
      interaction: interaction ? 'interact' : 'observe', expectedRevision: status.revision })
  }

  return <section className="mt-4 space-y-4 text-[12px]" aria-label={t('browserSkillConfiguration')}>
    <p role="status" className="rounded-md border border-ds-border bg-ds-subtle px-3 py-2 leading-5">{t(`browserSkillState_${status?.state ?? 'checking'}`)}</p>
    <div className="flex flex-wrap gap-2 [&_button]:rounded-md [&_button]:border [&_button]:border-ds-border [&_button]:px-3 [&_button]:py-2 [&_button]:hover:bg-ds-hover [&_button:disabled]:opacity-50">
      <button type="button" disabled={busy} onClick={() => void run(() => window.workwise.installBrowserSkill())}>{t('browserSkillInstall')}</button>
      <button type="button" disabled={busy || !status?.executablePath} onClick={() => void run(() => window.workwise.connectBrowserSkill())}>{t('browserSkillConnect')}</button>
      <button type="button" disabled={busy} onClick={() => void run(() => window.workwise.diagnoseBrowserSkill())}>{t('browserSkillCheck')}</button>
    </div>
    <p className="leading-5 text-ds-muted">{t('browserSkillExtensionHelp')}</p>
    <div className="flex flex-wrap gap-3">
      <button type="button" className="text-accent hover:underline" onClick={() => void window.workwise.openBrowserSkillExtension('edge')}>{t('browserSkillEdgeExtension')}</button>
      <button type="button" className="text-accent hover:underline" onClick={() => void window.workwise.openBrowserSkillExtension('chrome')}>{t('browserSkillChromeExtension')}</button>
    </div>
    <label className="block space-y-1"><span>{t('browserSkillBrowser')}</span>
      <select className="w-full rounded-md border border-ds-border bg-ds-main px-3 py-2" value={browser} disabled={busy} onChange={event => setBrowser(event.target.value)}>
        <option value="">{t('browserSkillChooseBrowser')}</option>
        {status?.browsers.map(item => <option key={item.id} value={item.id} disabled={!item.connected}>{item.name}{item.label ? ` · ${item.label}` : ''} · {item.extensionVersion}</option>)}
      </select>
    </label>
    <label className="block space-y-1"><span>{t('browserSkillOrigins')}</span>
      <textarea className="min-h-20 w-full rounded-md border border-ds-border bg-ds-main px-3 py-2" value={origins} disabled={busy} placeholder="https://example.com" onChange={event => setOrigins(event.target.value)} />
      <span className="block text-ds-muted">{t('browserSkillOriginsHelp')}</span>
    </label>
    <label className="flex items-start gap-2"><input type="checkbox" checked={interaction} disabled={busy} onChange={event => setInteraction(event.target.checked)} /><span>{t('browserSkillAllowInteraction')}</span></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} /><span>{t('browserSkillEnable')}</span></label>
    <button type="button" disabled={busy || !status} className="rounded-md bg-accent px-3 py-2 text-white disabled:opacity-50" onClick={() => void run(save)}>{t('browserSkillSave')}</button>
    <p className="text-ds-muted">{t('browserSkillResumeHint')}</p>
    {message ? <p role="alert" className="whitespace-pre-wrap break-words text-ds-muted">{message}</p> : null}
    {status?.checkedAt ? <p className="text-ds-muted">{t('browserSkillCheckedAt', { time: new Date(status.checkedAt).toLocaleString() })}</p> : null}
    {status?.code ? <details><summary>{t('browserSkillDiagnostics')}</summary><p>{status.code}</p><p>{status.version} · {status.daemonProtocolVersion}</p></details> : null}
  </section>
}
