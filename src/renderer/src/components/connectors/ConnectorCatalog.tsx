import { ReadonlyConnectorSetup } from './ReadonlyConnectorSetup'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, CheckCircle2, Link2, PlugZap, RefreshCw, X } from 'lucide-react'
import type { MarketplaceCatalogPackageEntryV1 } from '@shared/marketplace'
import type { ManagedToolStatus } from '@shared/workwise-api'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { DingTalkConnectorSettingsCard } from '../dingtalk-connector-settings-card'
import { ManagedLarkConnection } from './ManagedLarkConnection'
import { ManagedDingTalkConnection } from './ManagedDingTalkConnection'

type NativeConnector = 'lark' | 'dingtalk'
type ConnectorState = { available?: boolean; enabled?: boolean; authState?: string; credentialState?: string; identityVerified?: boolean }
type RuntimeConnections = Partial<Record<NativeConnector, ConnectorState>>
type Props = {
  entries: MarketplaceCatalogPackageEntryV1[]
  query: string
  refreshKey?: number
  target?: NativeConnector | null
  onTargetOpened?: () => void
  name: (entry: MarketplaceCatalogPackageEntryV1) => string
  summary: (entry: MarketplaceCatalogPackageEntryV1) => string
  status: (entry: MarketplaceCatalogPackageEntryV1) => string
  onDetails: (entry: MarketplaceCatalogPackageEntryV1) => void
  onInstall?: (entry: MarketplaceCatalogPackageEntryV1) => void
  onRefresh: () => void | Promise<void>
}

// These are existing first-party execution adapters, not catalog packages or
// claims of remote authorization. Keep their setup reachable when catalogs fail.
const nativeConnectors = ['lark', 'dingtalk'] as const
const larkCatalogIds = new Set(['lark-cli', 'lark-openapi-mcp'])

export function ConnectorCatalog({ entries, query, refreshKey, target, onTargetOpened, name, summary, status, onDetails, onInstall, onRefresh }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [connections, setConnections] = useState<RuntimeConnections>({})
  const [lark, setLark] = useState<ManagedToolStatus | undefined>()
  const [checking, setChecking] = useState(false)
  const [readonlyEntry, setReadonlyEntry] = useState<MarketplaceCatalogPackageEntryV1 | null>(null)
  const [selected, setSelected] = useState<NativeConnector | null>(null)
  const [autoConnect, setAutoConnect] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)
  const targetHandled = useRef(onTargetOpened)
  targetHandled.current = onTargetOpened

  useEffect(() => {
    if (!target) return
    setAutoConnect(false)
    setSelected(target)
    targetHandled.current?.()
  }, [target])

  const refreshConnections = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setChecking(true)
    const results = await Promise.allSettled([
      Promise.resolve().then(() => rendererRuntimeClient.runtimeRequest('/v1/runtime/info')),
      Promise.resolve().then(() => window.workwise.diagnoseManagedTool('lark-cli'))
    ])
    if (current !== generation.current) return
    const [runtime, tool] = results
    // Clear stale success when Runtime/diagnostics cannot be read. Existing
    // installation records are never changed by this display-only check.
    let next: RuntimeConnections = {}
    if (runtime.status === 'fulfilled' && runtime.value.ok) {
      try {
        const payload = JSON.parse(runtime.value.body) as { capabilities?: RuntimeConnections }
        next = { lark: payload.capabilities?.lark, dingtalk: payload.capabilities?.dingtalk }
      } catch { /* unknown is displayed as unverified */ }
    }
    setConnections(next)
    setLark(tool.status === 'fulfilled' && tool.value.ok ? tool.value.status : undefined)
    setChecking(false)
  }, [])

  useEffect(() => {
    void refreshConnections()
    return () => { generation.current += 1 }
  }, [refreshConnections, refreshKey])

  useEffect(() => {
    if (!selected) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelected(null)
      if (event.key !== 'Tab') return
      const dialog = closeRef.current?.closest('[role="dialog"]')
      const elements = [...dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href], select:not([disabled]), textarea:not([disabled]), summary') ?? []].filter(element => {
        const closed = element.closest('details:not([open])')
        return !closed || (element.tagName === 'SUMMARY' && element.parentElement === closed)
      })
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [selected])

  const changed = async (): Promise<void> => {
    await refreshConnections()
    await onRefresh()
  }
  const nativeName = (id: NativeConnector): string => t(id === 'lark' ? 'connectorHubLark' : 'connectorHubDingTalk')
  const nativeSummary = (id: NativeConnector): string => t(id === 'lark' ? 'connectorHubLarkSummary' : 'connectorHubDingTalkSummary')
  const isAvailable = (id: NativeConnector): boolean => {
    const state = connections[id]
    return Boolean(state?.enabled && state.available && (id === 'lark'
      ? state.authState === 'installed' && (lark?.state === 'installed' || lark?.state === 'update_available')
      : state.identityVerified && state.credentialState === 'valid'))
  }
  const nativeStatus = (id: NativeConnector): string => {
    if (checking && !connections[id]) return t('connectorHubChecking')
    if (isAvailable(id)) return t(id === 'dingtalk' ? 'connectorHubDingTalkConnected' : 'connectorHubAvailable')
    if (id === 'lark' && lark?.state === 'not_installed') return t('connectorHubNotInstalled')
    if (id === 'lark' && lark?.state === 'needs_login') return t('connectorHubNeedsLogin')
    if (id === 'lark' && lark?.state === 'error') return t('connectorHubCheckFailed')
    if (id === 'lark' && connections.lark?.authState === 'installed') return t('connectorHubScopeReview')
    if (id === 'dingtalk' && connections.dingtalk?.credentialState === 'missing') return t('connectorHubNeedsConfiguration')
    if (id === 'dingtalk' && connections.dingtalk?.credentialState === 'invalid') return t('connectorHubNeedsLogin')
    if (connections[id]?.enabled === false) return t('connectorHubDisabled')
    return t('connectorHubUnverified')
  }
  const needle = query.trim().toLocaleLowerCase()
  const larkPackages = entries.filter(entry => larkCatalogIds.has(entry.package.id))
  const natives = nativeConnectors.filter(id => !needle || [id, nativeName(id), nativeSummary(id), id === 'lark' ? 'feishu 飞书 lark' : 'dingtalk 钉钉'].some(value => value.toLocaleLowerCase().includes(needle)))
  const catalog = entries.filter(entry => !larkCatalogIds.has(entry.package.id) && entry.package.id !== 'dingtalk' && (!needle || [name(entry), summary(entry), entry.package.id, entry.package.publisher.name].some(value => value.toLocaleLowerCase().includes(needle))))
  const details = (entry: MarketplaceCatalogPackageEntryV1): void => {
    if (['amap-maps', 'zotero-mcp'].includes(entry.package.id)) setReadonlyEntry(entry)
    else onDetails(entry)
  }
  const open = (id: NativeConnector, connect = false): void => { setAutoConnect(connect); setSelected(id) }

  return <section className="mx-auto w-full max-w-[1200px] px-5 py-5 md:px-7" aria-label={t('connectorHubTitle')}>
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold">{t('connectorHubTitle')}</h2>
        <p className="mt-1 max-w-3xl text-[12px] leading-5 text-ds-muted">{t('connectorHubDescription')}</p>
      </div>
      <button type="button" disabled={checking} onClick={() => void changed()} className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-ds-border bg-ds-card px-3 text-[12px] hover:bg-ds-hover disabled:opacity-50">
        <RefreshCw className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`} />{t('connectorHubCheckConnections')}
      </button>
    </div>
    {!natives.length && !catalog.length ? <p className="py-12 text-center text-sm text-ds-muted">{t('connectorHubNoResults')}</p> : null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {natives.map(id => <article key={id} className="flex min-h-[164px] flex-col rounded-xl border border-ds-border bg-ds-card p-4">
        <button type="button" onClick={() => open(id)} aria-label={t('connectorHubViewDetails', { name: nativeName(id) })} className="flex flex-1 items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ds-subtle text-accent"><Link2 className="h-5 w-5" /></span>
          <span className="min-w-0"><span className="block text-[14px] font-semibold">{nativeName(id)}</span><span className="mt-1 block text-[12px] leading-5 text-ds-muted">{nativeSummary(id)}</span></span>
        </button>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className={`inline-flex min-w-0 break-words items-center gap-1 text-[11px] ${id === 'lark' && isAvailable(id) ? 'text-emerald-700 dark:text-emerald-300' : 'text-ds-muted'}`}>{id === 'lark' && isAvailable(id) ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}{nativeStatus(id)}</span>
          <button type="button" onClick={() => open(id, !isAvailable(id))} className="inline-flex min-h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-ds-border px-3 text-[12px] font-medium hover:bg-ds-hover">{t(isAvailable(id) ? 'connectorHubManage' : 'connectorHubConnect')}<ArrowRight className="h-3.5 w-3.5" /></button>
        </div>
      </article>)}
      {catalog.map(entry => <article key={entry.key} className="flex min-h-[164px] flex-col rounded-xl border border-ds-border bg-ds-card p-4">
        <button type="button" onClick={() => details(entry)} aria-label={t('connectorHubViewDetails', { name: name(entry) })} className="flex flex-1 items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ds-subtle text-ds-muted"><PlugZap className="h-5 w-5" /></span>
          <span className="min-w-0"><span className="block text-[14px] font-semibold">{name(entry)}</span><span className="mt-1 line-clamp-2 block text-[12px] leading-5 text-ds-muted">{summary(entry)}</span></span>
        </button>
        <div className="mt-4 flex items-center justify-between gap-3"><span className="min-w-0 break-words text-[11px] text-ds-muted">{status(entry)}</span><button type="button" onClick={() => details(entry)} className="inline-flex min-h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-ds-border px-3 text-[12px] font-medium hover:bg-ds-hover">{t(entry.package.id === 'github-mcp' ? 'connectorHubConnect' : 'connectorHubDetails')}<ArrowRight className="h-3.5 w-3.5" /></button></div>
      </article>)}
    </div>
    {readonlyEntry ? <ReadonlyConnectorSetup entry={readonlyEntry} onClose={() => setReadonlyEntry(null)} onChanged={changed} onInstall={() => { const entry = readonlyEntry; setReadonlyEntry(null); if (onInstall) onInstall(entry); else onDetails(entry) }} /> : null}
    {selected ? <div className="ds-connector-overlay fixed inset-0 z-40 bg-black/30" onMouseDown={event => { if (event.currentTarget === event.target) setSelected(null) }}>
      <aside role="dialog" aria-modal="true" aria-labelledby="connector-hub-detail-title" className="absolute inset-y-0 right-0 flex w-full max-w-[640px] flex-col border-l border-ds-border bg-ds-card shadow-xl">
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-ds-border px-5"><h2 id="connector-hub-detail-title" className="text-[16px] font-semibold">{nativeName(selected)}</h2><button ref={closeRef} type="button" aria-label={t('connectorHubClose')} onClick={() => setSelected(null)} className="rounded-md p-2 hover:bg-ds-hover"><X className="h-4 w-4" /></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          <p className="mt-5 text-sm leading-6 text-ds-muted">{nativeSummary(selected)}</p>
          {selected === 'dingtalk' ? <div className="mt-4"><ManagedDingTalkConnection onChanged={changed} autoConnect={autoConnect} /></div> : null}
          <p className="mt-3 rounded-lg border border-ds-border bg-ds-subtle px-3 py-2 text-[12px] leading-5 text-ds-muted">{t('connectorHubWriteBoundary')}</p>
          <h3 className="mt-5 text-[13px] font-semibold">{t('connectorHubTry')}</h3>
          <ul className="mt-2 list-inside list-disc space-y-2 text-[12px] text-ds-muted"><li>{t(selected === 'lark' ? 'connectorHubLarkExampleRead' : 'connectorHubDingTalkExampleRead')}</li><li>{t(selected === 'lark' ? 'connectorHubLarkExampleWrite' : 'connectorHubDingTalkExampleWrite')}</li></ul>
          {selected === 'lark' ? <>
            <div className="mt-5"><ManagedLarkConnection onChanged={changed} autoConnect={autoConnect} initialState={lark?.state} initialSkillWarning={lark?.skillWarning} /></div>
            {larkPackages.length ? <details className="mt-6">
              <summary className="cursor-pointer py-2 text-[12px] font-medium text-ds-muted">{t('connectorHubAdvancedPackages')}</summary>
              <p className="mt-1 text-[12px] leading-5 text-ds-muted">{t('connectorHubAdvancedPackagesDescription')}</p>
              <div className="mt-2 space-y-2">{larkPackages.map(entry => <button key={entry.key} type="button" onClick={() => { setSelected(null); onDetails(entry) }} className="flex w-full items-center justify-between gap-3 rounded-md border border-ds-border px-3 py-2 text-left text-[12px] hover:bg-ds-hover"><span>{t('connectorHubManagePackage', { name: name(entry) })}</span><ArrowRight className="h-3.5 w-3.5 shrink-0" /></button>)}</div>
            </details> : null}
          </> : <><p className="mt-4 text-[12px] leading-5 text-ds-muted">{t('connectorHubDingTalkSetup')}</p><details className="mt-6"><summary className="cursor-pointer py-2 text-[12px] font-medium text-ds-muted">{t('connectorHubAdvancedDingTalk')}</summary><DingTalkConnectorSettingsCard /></details></>}
        </div>
      </aside>
    </div> : null}
  </section>
}
