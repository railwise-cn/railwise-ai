import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Circle, Folder, Search } from 'lucide-react'
import { currentTaskBranch } from '@shared/task-projection'
import { taskDisplayGoal, taskDisplayTitle } from '@shared/task-presentation'
import { filterWorkspaceTasks, groupWorkspaceTasks, scopeWorkspaceTasks, type TaskFilter } from '@shared/task-workspace-projection'
import { projectTaskRunActivity } from '../../agent/ag-ui-activity'
import { useTaskState, updateTaskNavigation } from '../../store/task-live-store'

const FILTERS: TaskFilter[] = ['ongoing', 'attention', 'completed', 'all']

/** Task navigation occupies the existing sidebar, never another work column. */
export function TaskSidebar({ workspaceRoot, runtimeReady, onChooseWorkspace, onNavigate }: { workspaceRoot: string; runtimeReady: boolean; onChooseWorkspace: () => void; onNavigate?: () => void }): ReactElement {
  const { t } = useTranslation('common')
  const live = useTaskState(runtimeReady), nav = live.navigation
  const tasks = useMemo(() => scopeWorkspaceTasks(live.tasks, nav.allWorkspaces ? undefined : workspaceRoot), [live.tasks, nav.allWorkspaces, workspaceRoot])
  const attention = live.attention.filter(item => nav.allWorkspaces || item.workspaceRoot === workspaceRoot || tasks.some(task => task.id === item.taskId))
  const groups = groupWorkspaceTasks(tasks)
  const visible = filterWorkspaceTasks(tasks, attention, nav.filter, nav.search)
  const standalone = attention.filter(item => !tasks.some(task => task.id === item.taskId || task.threadId === item.threadId))
    .filter(item => !nav.search.trim() || `${item.title}\n${item.message}`.toLocaleLowerCase().includes(nav.search.trim().toLocaleLowerCase()))
  const shownStandalone = nav.filter === 'all' || nav.filter === 'attention' ? standalone : []
  const count = (filter: TaskFilter): number => filterWorkspaceTasks(tasks, attention, filter, nav.search).length + (filter === 'all' || filter === 'attention' ? standalone.length : 0)
  const selected = groups.find(group => group.all.some(task => task.id === nav.selectedTaskId))
  const selectedOutside = Boolean(selected && !visible.some(task => task.id === selected.root.id))
  return <section className="ds-task-sidebar ds-no-drag flex min-h-0 flex-1 flex-col overflow-hidden" aria-label={t('taskWorkspaceTaskList')}>
    <div className="shrink-0 space-y-2 px-2 pb-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold text-ds-muted">{t('taskWorkspaceTitle')}</h2>
        <button type="button" title={workspaceRoot} onClick={onChooseWorkspace} className="flex min-w-0 max-w-[65%] items-center gap-1 text-[11px] text-ds-muted"><Folder className="h-3 w-3 shrink-0" /><span className="truncate">{workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) || t('taskWorkspaceLocation')}</span></button>
      </div>
      <label className="flex items-center gap-2 rounded-lg border border-ds-border bg-ds-card px-2 py-1.5"><Search className="h-3.5 w-3.5 shrink-0 text-ds-muted" /><input type="search" aria-label={t('taskWorkspaceSearch')} placeholder={t('taskSidebarSearch')} value={nav.search} onChange={event => updateTaskNavigation({ search: event.target.value })} className="min-w-0 flex-1 bg-transparent text-xs outline-none" /></label>
      <label className="flex items-center gap-2 text-[11px] text-ds-muted"><input type="checkbox" checked={nav.allWorkspaces} onChange={event => updateTaskNavigation({ allWorkspaces: event.target.checked, selectedTaskId: null, selectedAttentionId: null })} />{t('taskWorkspaceAllWorkspaces')}</label>
      <nav aria-label={t('taskWorkspaceFilters')} className="grid grid-cols-2 gap-1">{FILTERS.map(filter => <button type="button" key={filter} aria-pressed={nav.filter === filter} onClick={() => updateTaskNavigation({ filter, selectedTaskId: null, selectedAttentionId: null })} className={`flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-[11px] ${nav.filter === filter ? 'bg-accent/10 text-accent' : 'text-ds-muted hover:bg-ds-card'}`}><span>{t(`taskWorkspaceFilter_${filter}`)}</span><span className="tabular-nums">{count(filter)}</span></button>)}</nav>
    </div>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-1 pb-3">
      {selectedOutside && selected ? <div className="mb-2 rounded-lg border border-ds-border bg-ds-card p-2.5 text-xs text-ds-muted">
        <p>{t('taskWorkspaceOutsideFilter')}</p>
        <button type="button" className="mt-1 font-medium text-accent" onClick={() => updateTaskNavigation({
          filter: FILTERS.find(filter => filterWorkspaceTasks(tasks, attention, filter).some(task => task.id === selected.root.id)) ?? 'all',
          search: ''
        })}>{t('taskWorkspaceShowCurrent')}</button>
      </div> : null}
      {visible.map(root => {
        const group = groups.find(item => item.root.id === root.id)!
        const current = currentTaskBranch(group.all, root).current
        const pending = attention.filter(item => item.taskId === current.id || !item.taskId && item.threadId === current.threadId)
        const activity = projectTaskRunActivity(current, live.progress[current.id], current.artifacts.length, pending)
        const status = activity?.status ?? current.status
        const active = group.all.some(task => task.id === nav.selectedTaskId)
        return <button type="button" key={root.id} aria-pressed={active} title={taskDisplayGoal(root)} onClick={() => { updateTaskNavigation({ selectedTaskId: root.id, selectedAttentionId: null }); onNavigate?.() }} className={`w-full rounded-lg border px-2.5 py-2 text-left ${active ? 'border-accent/30 bg-accent/10' : 'border-transparent hover:bg-ds-card'}`}>
          <div className="flex items-start gap-2">{status === 'completed' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <Circle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${status === 'running' ? 'text-accent' : 'text-ds-muted'}`} />}<span className="line-clamp-2 min-w-0 flex-1 break-words text-xs font-medium leading-5">{taskDisplayTitle(root)}</span></div>
          <div className="mt-1 flex items-center justify-between gap-2 pl-5 text-[10px] text-ds-muted"><span>{t(`taskRunStatus_${status}`)}</span><time>{new Date(current.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        </button>
      })}
      {shownStandalone.map(item => <button type="button" key={item.id} aria-pressed={nav.selectedAttentionId === item.id} onClick={() => { updateTaskNavigation({ selectedTaskId: null, selectedAttentionId: item.id }); onNavigate?.() }} className="w-full rounded-lg border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-left text-xs"><span className="line-clamp-2">{item.title}</span><span className="mt-1 block text-[10px] text-ds-muted">{t('taskWorkspaceFilter_attention')}</span></button>)}
      {!visible.length && !shownStandalone.length ? <p className="px-2 py-5 text-xs text-ds-muted">{nav.search ? t('taskWorkspaceNoMatches') : groups.length || standalone.length ? t('taskWorkspaceFilterEmpty') : t('taskWorkspaceEmpty')}</p> : null}
    </div>
  </section>
}
