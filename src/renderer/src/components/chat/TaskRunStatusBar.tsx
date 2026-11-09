import { useTaskState } from '../../store/task-live-store'
import { useMemo, type ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, PauseCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TaskRunStatus, TaskRunV1 } from '@shared/agent-workbench'
import { requestTaskDetail } from '../../store/task-live-store'
import { currentTaskBranch } from '@shared/task-projection'

type Props = {
  threadId: string | null
  runtimeReady: boolean
  onOpenTasks?: () => void
}

const ACTIVE_STATUSES = new Set<TaskRunStatus>(['queued', 'running', 'retrying'])

export function taskProgress(task: TaskRunV1): { completed: number; total: number } {
  return { completed: task.nodes.filter((node) => node.status === 'completed').length, total: task.nodes.length }
}

export function taskNeedsAttention(task: TaskRunV1): boolean {
  return ['stalled', 'waiting_user', 'waiting_approval', 'failed'].includes(task.status)
}

/**
 * The conversation surface only gives a compact, read-only status summary.
 * Task actions and execution details live in the task workspace, which avoids
 * a second polling/interaction surface competing with the durable task view.
 */
export function TaskRunStatusBar({ threadId, runtimeReady, onOpenTasks }: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const live=useTaskState(runtimeReady)
  const task=useMemo(()=>live.tasks.filter(candidate=>!candidate.parentTaskId && (!candidate.rootTaskId || candidate.rootTaskId===candidate.id) && candidate.visible!==false && !['chat','internal'].includes(candidate.visibility??'') && (candidate.originThreadId===threadId || candidate.threadId===threadId)).map(root=>{
    const members=live.tasks.filter(candidate=>candidate.id===root.id || candidate.rootTaskId===root.id)
    const current=currentTaskBranch(members,root).current
    return {...current,rootTaskId:root.id}
  }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]??null,[live.tasks,threadId])
  const error=live.error

  const progress = useMemo(() => task ? taskProgress(task) : { completed: 0, total: 0 }, [task])
  if (!task && !error) return null

  const attention = task ? taskNeedsAttention(task) : true
  const running = task ? ACTIVE_STATUSES.has(task.status) : false
  const statusIcon = running
    ? <Loader2 className="h-4 w-4 animate-spin" />
    : task?.status === 'completed'
      ? <CheckCircle2 className="h-4 w-4" />
      : attention ? <AlertTriangle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />

  return (
    <div className={`ds-no-drag mx-3 mt-2 shrink-0 overflow-hidden rounded-2xl border ${attention ? 'border-amber-300/70 bg-amber-50/95 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100' : 'border-ds-border bg-ds-card/95 text-ds-ink'}`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="inline-flex items-center gap-2 text-[12.5px] font-semibold">{statusIcon}{task ? t(`taskRunStatus_${task.status}`) : t('taskRunUnavailable')}</span>
        {task && progress.total > 0 ? <span className="text-[11.5px] opacity-75">{t('taskRunProgress', progress)}</span> : null}
        {task?.stalledReason || task?.waitingReason ? <span className="min-w-0 flex-1 truncate text-[11.5px] opacity-80">{task.stalledReason || task.waitingReason}</span> : <span className="flex-1" />}
        {onOpenTasks ? <button type="button" onClick={() => { if (task) requestTaskDetail(task.rootTaskId ?? task.id); onOpenTasks() }} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-current/20 px-2.5 py-1.5 text-[11.5px] font-medium hover:bg-black/5 dark:hover:bg-white/5"><ExternalLink className="h-3.5 w-3.5" />{t('taskRunOpenTaskWorkspace')}</button> : null}
      </div>
      {error ? <div className="border-t border-current/10 px-3 py-2 text-[11.5px] text-red-800 dark:text-red-200">{error}</div> : null}
    </div>
  )
}
