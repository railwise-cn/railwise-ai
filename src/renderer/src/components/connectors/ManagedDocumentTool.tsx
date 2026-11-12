import { useState, type ReactElement } from 'react'
import { Loader2 } from 'lucide-react'
import type { ManagedToolStatus } from '@shared/workwise-api'

export function ManagedDocumentTool({ id }: { id: 'officecli' | 'markitdown' }): ReactElement {
  const [status, setStatus] = useState<ManagedToolStatus>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (install: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (id === 'markitdown') {
        const engines = await window.workwise.listDocumentEngines()
        const engine = engines.find(item => item.id === 'markitdown')
        setMessage(engine?.state === 'available' ? 'MarkItDown 已就绪，可从附件导入或资料读取入口解析文档。' : engine?.message ?? '内置文档解析引擎尚未就绪，请检查安装包。')
      } else {
        const result = await (install ? window.workwise.installManagedTool(id) : window.workwise.diagnoseManagedTool(id))
        if (!result.ok) throw new Error(result.message)
        setStatus(result.status)
        setMessage(['installed', 'update_available'].includes(result.status.state) ? `OfficeCLI ${result.status.installedVersion ?? ''} 已安装，配套技能可在任务中选择。` : result.status.message ?? 'OfficeCLI 尚未安装。')
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="mt-4 rounded-lg border border-ds-border p-3">
    <div className="flex gap-2"><button type="button" disabled={busy} onClick={() => void run(false)} className="inline-flex items-center gap-2 rounded-md border border-ds-border px-3 py-1.5 text-xs hover:bg-ds-hover disabled:opacity-50">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}检查安装</button>{id === 'officecli' ? <button type="button" disabled={busy || status?.state === 'installed'} onClick={() => void run(true)} className="rounded-md border border-ds-border px-3 py-1.5 text-xs hover:bg-ds-hover disabled:opacity-50">{status?.state === 'update_available' ? '更新 OfficeCLI' : '安装 OfficeCLI'}</button> : null}</div>
    {message ? <p role="status" className="mt-3 text-xs leading-5 text-ds-muted">{message}</p> : null}
  </div>
}
