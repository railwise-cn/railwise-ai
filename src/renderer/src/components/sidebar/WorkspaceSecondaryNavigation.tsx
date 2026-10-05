import { ProductIcon } from '../ProductIcon'
import { useEffect, useState, type ReactElement } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppRoute } from '../../store/chat-store'
import { SidebarCommandRow } from './SidebarPrimitives'

type Props = {
  activeRoute: AppRoute
  onWriteOpen: () => void
  onOpenPlugins: () => void
  onScheduleOpen: () => void
  onFlowOpen: () => void
  onDesignOpen: () => void
}

export function WorkspaceSecondaryNavigation({
  activeRoute,
  onWriteOpen,
  onOpenPlugins,
  onScheduleOpen,
  onFlowOpen,
  onDesignOpen
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const toolRouteActive = ['write', 'plugins', 'schedule', 'flow', 'design'].includes(activeRoute)
  const [open, setOpen] = useState(toolRouteActive)

  // Keep a deep-linked tool discoverable after navigation while leaving the
  // default work surface focused on the two primary modes.
  useEffect(() => {
    if (toolRouteActive) setOpen(true)
  }, [toolRouteActive])

  return (
    <nav aria-label={t('workspaceToolsNavigation')} className="flex flex-col [&_button]:min-h-11">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="group flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] text-ds-muted outline-none transition hover:bg-[color-mix(in_srgb,var(--ds-sidebar-field-focus)_56%,transparent)] hover:text-ds-ink focus-visible:ring-2 focus-visible:ring-black/10 dark:focus-visible:ring-white/20">
          <span className="flex h-[21px] w-[21px] shrink-0 items-center justify-center rounded-[7px] text-ds-faint group-hover:text-accent">
            <ProductIcon name="tools" className="h-3.5 w-3.5" strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{t('workspaceTools')}</span>
          <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </summary>
      <div id="workspace-tools-menu" className="mt-0.5 space-y-0.5 border-l border-ds-border-muted pl-2">
        <SidebarCommandRow icon={<ProductIcon name="write" className="h-4 w-4" strokeWidth={1.75} />} label={t('write')} onClick={onWriteOpen} active={activeRoute === 'write'} />
        <SidebarCommandRow icon={<ProductIcon name="plugins" className="h-4 w-4" strokeWidth={1.75} />} label={t('plugins')} onClick={onOpenPlugins} active={activeRoute === 'plugins'} />
        <SidebarCommandRow icon={<ProductIcon name="schedule" className="h-4 w-4" strokeWidth={1.75} />} label={t('schedule')} onClick={onScheduleOpen} active={activeRoute === 'schedule'} />
        <SidebarCommandRow icon={<ProductIcon name="flow" className="h-4 w-4" strokeWidth={1.75} />} label={t('flow')} onClick={onFlowOpen} active={activeRoute === 'flow'} />
        <SidebarCommandRow icon={<ProductIcon name="design" className="h-4 w-4" strokeWidth={1.75} />} label={t('design')} onClick={onDesignOpen} active={activeRoute === 'design'} />
      </div>
      </details>
    </nav>
  )
}
