import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useWriteDialogFocus } from './use-write-dialog-focus'

export function WriteRelocateDocumentDialog({ path, onClose, onRelocate }: { path: string; onClose: () => void; onRelocate: (newPath: string) => Promise<boolean> }): ReactElement {
  const { i18n } = useTranslation('common')
  const label = (cn: string, en: string): string => i18n.language.startsWith('zh') ? cn : en
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useWriteDialogFocus(true, 'write-relocate-title', onClose)
  return <div className="fixed inset-0 z-[82] flex items-center justify-center bg-black/35 p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="write-relocate-title" className="w-full max-w-lg rounded-2xl border border-ds-border bg-ds-card p-5 shadow-2xl" onSubmit={(event) => {
      event.preventDefault(); if (!target.trim()) return
      setBusy(true); setError('')
      void onRelocate(target.trim()).then((ok) => {
        if (ok) onClose()
        else setError(label('无法重新定位。请检查工作区内的新路径。当前草稿已保留。', 'Could not relocate. Check the new path inside the workspace. Your draft is preserved.'))
      }).catch((cause) => setError(String(cause))).finally(() => setBusy(false))
    }}>
      <h2 id="write-relocate-title" className="text-[15px] font-semibold text-ds-ink">{label('重新定位文档', 'Locate moved document')}</h2>
      <p className="mt-2 break-all text-[12px] leading-5 text-ds-muted">{path}</p>
      <p className="mt-3 text-[12px] leading-5 text-ds-muted">{label('输入工作区内移动或重命名后的路径。草稿会保留；若文件内容不一致，将显示冲突供审阅。', 'Enter the renamed or moved path inside the workspace. Your draft is retained; differing file content will be shown for review.')}</p>
      <input autoFocus value={target} onChange={(event) => setTarget(event.target.value)} aria-label={label('新的文档路径', 'New document path')} placeholder="docs/renamed.md" className="mt-3 w-full rounded-lg border border-ds-border bg-ds-panel px-3 py-2 text-[13px] text-ds-ink outline-none focus:border-accent" onKeyDown={(event) => { if (event.key === 'Escape') onClose() }} />
      {error ? <p role="alert" className="mt-3 text-[12px] text-red-600 dark:text-red-300">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2"><button type="button" className="rounded-lg px-3 py-2 text-[12px] text-ds-muted hover:bg-ds-hover" disabled={busy} onClick={onClose}>{label('取消', 'Cancel')}</button><button type="submit" disabled={busy || !target.trim()} className="rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white disabled:opacity-40">{label('定位并审阅', 'Locate and review')}</button></div>
    </form>
  </div>
}
