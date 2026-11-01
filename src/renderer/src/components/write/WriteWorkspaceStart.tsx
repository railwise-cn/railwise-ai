import { useState, type ReactElement } from 'react'
import { FilePenLine, FilePlus2, FolderOpen, ListTodo, Presentation, RefreshCw, Sparkles, Target, Users, PackageOpen, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceEntry } from '@shared/workspace-file'

export function WriteWorkspaceStart({
  busy = false,
  onAskAssistant,
  onCreateDraft,
  onCreatePresentation,
  onPickWorkspace,
  onRefreshWorkspace,
  workspaceName,
  workspacePathLabel
}: {
  busy?: boolean
  onAskAssistant: (prompt: string) => void
  onCreateDraft: (brief?: string) => void
  onCreatePresentation: (brief?: string) => void
  onPickWorkspace: () => void
  onRefreshWorkspace: () => void
  workspaceName: string
  workspacePathLabel: string
}): ReactElement {
  const { t, i18n } = useTranslation('common')
  const [goal, setGoal] = useState('')
  const [materials, setMaterials] = useState('')
  const [audience, setAudience] = useState('')
  const [output, setOutput] = useState('')
  const [materialFiles, setMaterialFiles] = useState<WorkspaceEntry[]>([])
  const [materialPickerOpen, setMaterialPickerOpen] = useState(false)
  const [materialPickerBusy, setMaterialPickerBusy] = useState(false)
  const [materialPickerError, setMaterialPickerError] = useState('')
  const brief = [
    goal.trim() ? `${t('writeStartGoalLabel')}: ${goal.trim()}` : '',
    materials.trim() ? `${t('writeStartMaterialsLabel')}: ${materials.trim()}` : '',
    audience.trim() ? `${t('writeStartAudienceLabel')}: ${audience.trim()}` : '',
    output.trim() ? `${t('writeStartOutputLabel')}: ${output.trim()}` : ''
  ].filter(Boolean).join('\n')
  const outlinePrompt = `${t('writeStartOutlinePrompt')}\n\n${brief || t('writeStartClarifyPrompt')}`
  const openMaterialPicker = async (): Promise<void> => {
    if (materialPickerBusy) return
    setMaterialPickerOpen(true)
    setMaterialPickerBusy(true)
    setMaterialPickerError('')
    try {
      const rootPath = workspacePathLabel
      const queue: Array<{ path?: string; depth: number }> = [{ depth: 0 }]
      const files: WorkspaceEntry[] = []
      const visited = new Set<string>()
      while (queue.length && visited.size < 120) {
        const current = queue.shift()!
        const result = await window.workwise.listWorkspaceDirectory({ workspaceRoot: rootPath, path: current.path })
        if (!result.ok) throw new Error(result.message)
        if (visited.has(result.root)) continue
        visited.add(result.root)
        for (const entry of result.entries) {
          if (entry.type === 'directory' && current.depth < 3) queue.push({ path: entry.path, depth: current.depth + 1 })
          else if (entry.type === 'file' && /\.(md|markdown|txt|docx|pdf|csv|xlsx|pptx)$/i.test(entry.name)) files.push(entry)
        }
      }
      setMaterialFiles(files.sort((left, right) => left.path.localeCompare(right.path)))
    } catch (error) {
      setMaterialPickerError(error instanceof Error ? error.message : String(error))
    } finally {
      setMaterialPickerBusy(false)
    }
  }
  const selectMaterial = (path: string): void => {
    if (!path) return
    const reference = `@${path}`
    setMaterials((current) => current.split('\n').some((line) => line.trim() === reference)
      ? current
      : [current.trim(), reference].filter(Boolean).join('\n'))
    setMaterialPickerOpen(false)
  }
  return (
    <div className="write-start-shell relative h-full min-h-[420px] overflow-auto rounded-[28px] bg-[linear-gradient(180deg,rgba(255,255,255,0.82),rgba(247,250,255,0.62))] px-5 py-5 dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.025))] sm:px-8 sm:py-8">
      <div className="write-start-grid mx-auto grid min-h-full w-full max-w-6xl gap-6">
        <section className="write-start-hero min-w-0 py-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accent/10 px-3 py-1.5 text-[12px] font-semibold text-accent">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.9} />
            <span>{t('writeStudio')}</span>
          </div>
          <h2 className="write-start-heading mt-5 max-w-[16ch] text-[clamp(2.1rem,4vw,3rem)] font-semibold leading-[1.08] tracking-[0] text-ds-ink">
            {t('writeStartTitle')}
          </h2>
          <p className="write-start-copy mt-4 max-w-[56ch] text-[15px] leading-7 text-ds-muted">
            {t('writeStartSub')}
          </p>

          <div className="write-start-brief mt-7 grid gap-3 rounded-[22px] border border-ds-border-muted bg-white/62 p-4 shadow-sm dark:bg-white/[0.035]">
            <label className="grid gap-1.5">
              <span className="flex items-center gap-2 text-[12px] font-semibold text-ds-muted"><Target className="h-3.5 w-3.5 text-accent" />{t('writeStartGoalLabel')}</span>
              <input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t('writeStartGoalPlaceholder')} className="h-10 rounded-xl border border-ds-border-muted bg-white/80 px-3 text-[13px] text-ds-ink outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10 dark:bg-white/[0.06]" />
            </label>
            <label className="grid gap-1.5">
              <span className="flex items-center gap-2 text-[12px] font-semibold text-ds-muted"><PackageOpen className="h-3.5 w-3.5 text-violet-500" />{t('writeStartMaterialsLabel')}</span>
              <textarea value={materials} onChange={(event) => setMaterials(event.target.value)} placeholder={t('writeStartMaterialsPlaceholder')} rows={2} className="resize-none rounded-xl border border-ds-border-muted bg-white/80 px-3 py-2 text-[13px] leading-5 text-ds-ink outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10 dark:bg-white/[0.06]" />
              <button type="button" onClick={() => void openMaterialPicker()} disabled={materialPickerBusy || !workspacePathLabel} className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md border border-ds-border px-2.5 text-[11px] font-medium text-ds-ink hover:bg-ds-hover disabled:opacity-50"><FileText className="h-3.5 w-3.5" />{t('writeStartChooseMaterials')}</button>
              {materialPickerOpen ? <div className="grid gap-2 border-t border-ds-border-muted pt-2">
                {materialPickerBusy ? <span className="text-[12px] text-ds-muted">{t('writeStartLoadingMaterials')}</span> : null}
                {materialPickerError ? <span role="alert" className="text-[12px] text-red-600">{materialPickerError}</span> : null}
                {!materialPickerBusy && !materialPickerError && materialFiles.length === 0 ? <span className="text-[12px] text-ds-muted">{t('writeStartNoMaterials')}</span> : null}
                {materialFiles.length > 0 ? <select aria-label={t('writeStartChooseMaterials')} defaultValue="" onChange={(event) => selectMaterial(event.target.value)} className="h-9 min-w-0 rounded-md border border-ds-border-muted bg-ds-card px-2 text-[12px] text-ds-ink">
                  <option value="" disabled>{t('writeStartSelectMaterial')}</option>
                  {materialFiles.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
                </select> : null}
              </div> : null}
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="flex items-center gap-2 text-[12px] font-semibold text-ds-muted"><Users className="h-3.5 w-3.5 text-emerald-500" />{t('writeStartAudienceLabel')}</span>
                <input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder={t('writeStartAudiencePlaceholder')} className="h-10 rounded-xl border border-ds-border-muted bg-white/80 px-3 text-[13px] text-ds-ink outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10 dark:bg-white/[0.06]" />
              </label>
              <label className="grid gap-1.5">
                <span className="flex items-center gap-2 text-[12px] font-semibold text-ds-muted"><FilePenLine className="h-3.5 w-3.5 text-amber-500" />{t('writeStartOutputLabel')}</span>
                <input value={output} onChange={(event) => setOutput(event.target.value)} placeholder={t('writeStartOutputPlaceholder')} className="h-10 rounded-xl border border-ds-border-muted bg-white/80 px-3 text-[13px] text-ds-ink outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10 dark:bg-white/[0.06]" />
              </label>
            </div>
          </div>

          <div className="write-start-primary-actions mt-5 grid gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => onAskAssistant(outlinePrompt)}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 text-[14px] font-semibold text-white shadow-[0_14px_30px_rgba(0,136,255,0.22)] transition hover:brightness-110"
            >
              <ListTodo className="h-4 w-4" strokeWidth={1.9} />
              {t('writeStartOutlineAction')}
            </button>
            <button type="button" disabled={busy || !materials.trim()} onClick={() => onAskAssistant(`${t('writeStartFromMaterialsPrompt')}\n\n${brief}`)} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-ds-border bg-ds-card px-5 text-[14px] font-semibold text-ds-ink hover:bg-ds-hover disabled:opacity-50">
              <PackageOpen className="h-4 w-4" />{t('writeStartFromMaterialsAction')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onCreateDraft(brief)}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-ds-border bg-white/70 px-5 text-[14px] font-semibold text-ds-ink shadow-sm transition hover:bg-white dark:bg-white/[0.055] dark:hover:bg-white/[0.08]"
            >
              <FilePlus2 className="h-4 w-4 text-emerald-600 dark:text-emerald-300" strokeWidth={1.9} />
              {t('writeStartDraftAction')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onCreatePresentation(brief)}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-ds-border bg-white/70 px-5 text-[14px] font-semibold text-ds-ink shadow-sm transition hover:bg-white dark:bg-white/[0.055] dark:hover:bg-white/[0.08]"
            >
              <Presentation className="h-4 w-4 text-violet-600 dark:text-violet-300" strokeWidth={1.9} />
              {t('writeGeneratePpt', {
                defaultValue: i18n.language.startsWith('zh') ? '生成 PPT' : 'Generate PPT'
              })}
            </button>
          </div>

          <div className="write-start-shortcuts mt-7 grid gap-3">
            <button
              type="button"
              onClick={onRefreshWorkspace}
              className="group flex min-h-[82px] items-center gap-3 rounded-2xl border border-ds-border-muted bg-white/52 px-4 py-3 text-left transition hover:border-accent/25 hover:bg-white/78 dark:bg-white/[0.035] dark:hover:bg-white/[0.07]"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-300">
                <RefreshCw className="h-5 w-5" strokeWidth={1.9} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ds-ink">
                  {t('writeStartRefresh')}
                </span>
                <span className="mt-1 block text-[12.5px] leading-5 text-ds-faint">
                  {t('writeStartRefreshSub')}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={onPickWorkspace}
              className="group flex min-h-[82px] items-center gap-3 rounded-2xl border border-ds-border-muted bg-white/52 px-4 py-3 text-left transition hover:border-accent/25 hover:bg-white/78 dark:bg-white/[0.035] dark:hover:bg-white/[0.07]"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-300">
                <FolderOpen className="h-5 w-5" strokeWidth={1.9} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ds-ink">
                  {t('writeStartChangeWorkspace')}
                </span>
                <span className="mt-1 block truncate text-[12.5px] leading-5 text-ds-faint">
                  {workspaceName}
                </span>
              </span>
            </button>
          </div>
        </section>

        <aside className="write-start-card min-w-0 rounded-[24px] border border-ds-border-muted bg-white/58 p-5 shadow-[0_18px_48px_rgba(15,23,42,0.07)] dark:bg-white/[0.04]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-semibold text-ds-faint">
                {t('writeStartWorkspaceLabel')}
              </div>
              <div className="mt-1 truncate text-[18px] font-semibold text-ds-ink">
                {workspaceName}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11.5px] font-semibold text-emerald-700 dark:text-emerald-300">
              {t('writeStartReadyLabel')}
            </span>
          </div>

          <div className="mt-5 rounded-[20px] border border-ds-border-muted bg-white/76 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.64)] dark:bg-white/[0.035] dark:shadow-none">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                <FilePenLine className="h-5 w-5" strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold text-ds-ink">
                  {t('writeStartPreviewTitle')}
                </div>
                <div className="mt-1 text-[12.5px] leading-5 text-ds-faint">
                  {t('writeStartPreviewSub')}
                </div>
              </div>
            </div>
            <div className="mt-6 space-y-3" aria-hidden="true">
              <div className="h-3 w-2/3 rounded-full bg-slate-900/10 dark:bg-white/10" />
              <div className="h-2.5 w-full rounded-full bg-slate-900/5 dark:bg-white/10" />
              <div className="h-2.5 w-11/12 rounded-full bg-slate-900/5 dark:bg-white/10" />
              <div className="h-2.5 w-4/5 rounded-full bg-slate-900/5 dark:bg-white/10" />
              <div className="pt-2">
                <div className="h-2.5 w-1/2 rounded-full bg-accent/15" />
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-ds-border-muted bg-ds-subtle/45 px-4 py-3">
            <div className="text-[12px] font-semibold text-ds-faint">
              {t('writeStartWorkspacePath')}
            </div>
            <div className="mt-2 break-all font-mono text-[12px] leading-5 text-ds-muted" title={workspacePathLabel}>
              {workspacePathLabel}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
