import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { Pin, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WriteDocumentTab, WriteRecentlyOpenedTab } from '../../write/write-workspace-store-types'
import { writeBasenameFromPath, writeRelativeToWorkspace } from '../../write/write-workspace-store'

export function WriteDocumentTabs({ tabs, activeTabId, workspaceRoot, canRestore, recent, dirty, onSelect, onClose, onPin, onRestore, onOpenRecent }: {
  tabs: WriteDocumentTab[]; activeTabId: string | null; workspaceRoot: string
  canRestore: boolean; recent: WriteRecentlyOpenedTab[]; dirty: boolean
  onSelect: (id: string) => void; onClose: (path: string) => void
  onPin: (id: string) => void; onRestore: () => void; onOpenRecent: (path: string) => void
}): ReactElement | null {
  const { i18n } = useTranslation('common')
  const [recentOpen, setRecentOpen] = useState(false)
  const activeTabRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    activeTabRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
  }, [activeTabId, tabs])
  const label = (cn: string, en: string): string => i18n.language.startsWith('zh') ? cn : en
  if (!tabs.length && !canRestore && !recent.length) return null
  return (
    <div className="relative mt-2 flex min-w-0 shrink-0 items-center gap-1 rounded-xl border border-ds-border-muted bg-ds-card px-1.5 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label={label('打开的文档', 'Open documents')} onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
        const index = buttons.indexOf(target as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
        event.preventDefault(); buttons[next]?.focus(); buttons[next]?.click()
      }}>
        {[...tabs].sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((tab) => {
          const active = tab.id === activeTabId
          const name = writeBasenameFromPath(tab.path)
          return (
            <div key={tab.id} ref={active ? activeTabRef : null} className={`group inline-flex max-w-[220px] shrink-0 items-center rounded-lg ${active ? 'bg-accent/12 text-accent' : 'text-ds-muted hover:bg-ds-hover'}`}>
              <button type="button" role="tab" tabIndex={active ? 0 : -1} aria-selected={active} className="min-w-0 truncate px-2.5 py-1.5 text-[12px]" title={writeRelativeToWorkspace(workspaceRoot, tab.path)} onClick={() => onSelect(tab.id)}>{name}{active && dirty ? ' •' : ''}</button>
              <button type="button" className={`rounded p-1 text-ds-faint hover:text-accent focus:opacity-100 ${tab.pinned ? 'text-accent' : 'opacity-60 sm:opacity-0 sm:group-hover:opacity-100'}`} aria-label={`${tab.pinned ? label('取消固定', 'Unpin') : label('固定', 'Pin')} ${name}`} title={tab.pinned ? label('取消固定', 'Unpin') : label('固定', 'Pin')} onClick={() => onPin(tab.id)}><Pin className="h-3 w-3" fill={tab.pinned ? 'currentColor' : 'none'} /></button>
              <button type="button" className="mr-1 rounded p-1 text-ds-faint hover:bg-ds-hover hover:text-ds-ink" aria-label={`${label('关闭', 'Close')} ${name}`} onClick={() => onClose(tab.path)}><X className="h-3 w-3" /></button>
            </div>
          )
        })}
      </div>
      {canRestore ? <button type="button" className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] text-ds-muted hover:bg-ds-hover" title={label('恢复最近关闭的文档', 'Restore the last closed document')} onClick={onRestore}>{label('恢复关闭', 'Reopen')}</button> : null}
      {recent.length ? <button type="button" aria-expanded={recentOpen} className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] text-ds-muted hover:bg-ds-hover" onClick={() => setRecentOpen((value) => !value)}>{label('最近打开', 'Recent')}</button> : null}
      {recentOpen ? <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-ds-border bg-ds-card p-1.5 shadow-xl">{recent.slice(0, 10).map((item) => <button key={item.path} type="button" className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-[12px] text-ds-ink hover:bg-ds-hover" title={item.path} onClick={() => { onOpenRecent(item.path); setRecentOpen(false) }}>{writeRelativeToWorkspace(workspaceRoot, item.path)}</button>)}</div> : null}
    </div>
  )
}
