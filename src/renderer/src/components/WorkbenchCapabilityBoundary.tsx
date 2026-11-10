import type { ReactElement, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { CoreRuntimeCapabilityManifestJson } from '../agent/runtime-contract'

type WorkspaceCapability = 'flow' | 'design' | 'schedule'
type CapabilityContext = {
  route: string
  capabilities?: CoreRuntimeCapabilityManifestJson | null
  runtimeReady: boolean
}

function workspaceCapability(route: string): WorkspaceCapability | null {
  return route === 'flow' || route === 'design' || route === 'schedule' ? route : null
}

/** Missing or stale capability information never authorizes mounting an executable surface. */
export function isWorkbenchCapabilityAvailable({ route, capabilities, runtimeReady }: CapabilityContext): boolean {
  const workspace = workspaceCapability(route)
  if (!workspace) return true
  const capability = capabilities?.workspaces?.[workspace]
  return Boolean(runtimeReady && capability?.enabled && capability.available && capability.status === 'available')
}

export function WorkbenchCapabilityBoundary({
  route,
  capabilities,
  runtimeReady,
  refreshing = false,
  onSettings,
  onPlugins,
  onRefresh,
  children
}: CapabilityContext & {
  refreshing?: boolean
  onSettings: () => void
  onPlugins: () => void
  onRefresh: () => void
  children: ReactNode
}): ReactElement {
  const { t } = useTranslation('common')
  const workspace = workspaceCapability(route)
  if (isWorkbenchCapabilityAvailable({ route, capabilities, runtimeReady }) || !workspace) {
    return <>{children}</>
  }

  const capability = capabilities?.workspaces?.[workspace]
  const reason = !runtimeReady
    ? t('workbenchCapabilityOffline')
    : capability?.reason?.trim() || t(capability?.status === 'disabled'
      ? 'workbenchCapabilityDisabled'
      : 'workbenchCapabilityUnverified')

  return (
    <section className="ds-no-drag flex h-full min-h-0 w-full flex-col items-center justify-center overflow-auto bg-ds-main px-6 py-10 text-center" aria-label={t('workbenchCapabilityTitle', { workspace: t(workspace) })}>
      <h2 className="text-[16px] font-semibold text-ds-text-primary">
        {t('workbenchCapabilityTitle', { workspace: t(workspace) })}
      </h2>
      <p className="mt-3 max-w-lg whitespace-pre-wrap break-words text-[13px] leading-6 text-ds-text-secondary">{reason}</p>
      <p className="mt-2 max-w-lg text-[12px] leading-5 text-ds-text-secondary">{t('workbenchCapabilityNextStep')}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button type="button" className="rounded-md border border-ds-border px-3 py-2 text-[12px] font-medium text-ds-text-primary hover:bg-ds-hover" onClick={onSettings}>
          {t('openSettings')}
        </button>
        <button type="button" className="rounded-md border border-ds-border px-3 py-2 text-[12px] font-medium text-ds-text-primary hover:bg-ds-hover" onClick={onPlugins}>
          {t('workbenchCapabilityOpenPlugins')}
        </button>
        <button type="button" className="rounded-md border border-ds-border px-3 py-2 text-[12px] font-medium text-ds-text-primary hover:bg-ds-hover disabled:opacity-50" onClick={onRefresh} disabled={refreshing}>
          {t(refreshing ? 'workbenchCapabilityChecking' : 'workbenchCapabilityRefresh')}
        </button>
      </div>
    </section>
  )
}
