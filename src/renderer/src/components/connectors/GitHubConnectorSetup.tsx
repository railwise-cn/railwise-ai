import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ExternalLink, Loader2, X } from 'lucide-react'
import type { McpServerConfigV2, McpServerStatusV1 } from '@shared/agent-workbench'
import { GITHUB_MCP_AUTH_GUIDE_URL, GITHUB_MCP_READONLY_URL, GITHUB_MCP_URL, GITHUB_TOKEN_CREATE_URL, GITHUB_TOKEN_GUIDE_URL, githubMcpMode, isGitHubMcpServer } from '@shared/github-connector'
import { rendererRuntimeClient } from '../../agent/runtime-client'

type RuntimeState = { enabled?: boolean; available?: boolean; status?: string; toolCount?: number }

export function GitHubConnectorSetup({ workspaceRoot, onClose, onChanged, onAdvanced }: {
  workspaceRoot?: string
  onClose: () => void
  onChanged: () => void | Promise<void>
  onAdvanced: () => void
}): ReactElement {
  const [servers, setServers] = useState<McpServerConfigV2[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [mode, setMode] = useState<'readonly' | 'token'>('readonly')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState('')
  const [check, setCheck] = useState<{ revision: number; result: McpServerStatusV1 }>()
  const [runtime, setRuntime] = useState<RuntimeState>()
  const closeRef = useRef<HTMLButtonElement>(null)
  const server = servers.find(item => item.id === selectedId)
  const githubServers = servers.filter(isGitHubMcpServer)
  const simpleEndpoint = !server || [GITHUB_MCP_URL, GITHUB_MCP_READONLY_URL].includes(server.url ?? '')
  const changedMode = simpleEndpoint && mode !== githubMcpMode(server)
  const verified = Boolean(server && !changedMode && check?.revision === server.revision && check.result.authorized && check.result.state === 'connected')
  const active = Boolean(server?.enabled && runtime?.enabled && runtime.available && runtime.status === 'connected' && (runtime.toolCount ?? 0) > 0)

  const readRuntime = useCallback(async (id: string): Promise<RuntimeState | undefined> => {
    const response = await rendererRuntimeClient.runtimeRequest('/v1/runtime/tools')
    if (!response.ok) return undefined
    const body = JSON.parse(response.body) as { mcpServers?: Array<RuntimeState & { id: string }> }
    return body.mcpServers?.find(item => item.id === id)
  }, [])

  useEffect(() => {
    let current = true
    void window.workwise.listMcpServers(workspaceRoot).then(async entries => {
      if (!current) return
      setServers(entries)
      const github = entries.find(item => item.id === 'github-mcp' && isGitHubMcpServer(item)) ?? entries.find(isGitHubMcpServer)
      if (github) {
        setSelectedId(github.id)
        setMode(githubMcpMode(github))
        const state = await readRuntime(github.id).catch(() => undefined)
        if (current) setRuntime(state)
      }
    }).catch(() => { if (current) setMessage('读取 GitHub 连接配置失败，请重新打开详情。') })
      .finally(() => { if (current) setLoaded(true) })
    return () => { current = false }
  }, [workspaceRoot, readRuntime])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const controls = Array.from(closeRef.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),summary') ?? [])
        .filter(element => !element.closest('details:not([open])') || element.tagName === 'SUMMARY')
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [onClose])

  const remember = (saved: McpServerConfigV2): void => {
    setServers(entries => [...entries.filter(item => item.id !== saved.id), saved])
    setSelectedId(saved.id)
  }
  const open = (url: string): void => { void window.workwise.openExternal(url).catch(() => setMessage('无法打开浏览器，请检查默认浏览器后重试。')) }

  const inspect = async (): Promise<void> => {
    setBusy(true); setMessage(''); setCheck(undefined); setRuntime(undefined)
    const enteredToken = token.trim()
    setToken('')
    try {
      const entries = await window.workwise.listMcpServers(workspaceRoot)
      let current = entries.find(item => item.id === selectedId)
      if (selectedId && (!current || !isGitHubMcpServer(current))) throw new Error('连接配置已变化，请重新打开详情。')
      if (!current) {
        if (!enteredToken) throw new Error('请先在 GitHub 创建个人访问令牌，并填入此页面。')
        const id = entries.some(item => item.id === 'github-mcp') ? `github-mcp-${crypto.randomUUID().slice(0, 8)}` : 'github-mcp'
        current = await window.workwise.saveMcpServer({ config: { id, name: 'GitHub', scope: 'global', transport: 'http',
          url: mode === 'readonly' ? GITHUB_MCP_READONLY_URL : GITHUB_MCP_URL, timeoutMs: 30_000, source: 'managed-tool', toolPolicy: {}, enabled: false },
          expectedRevision: 0, idempotencyKey: crypto.randomUUID() })
        remember(current)
      } else if (changedMode) {
        current = await window.workwise.saveMcpServer({ config: { ...current, url: mode === 'readonly' ? GITHUB_MCP_READONLY_URL : GITHUB_MCP_URL, enabled: false },
          expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() })
        remember(current)
      }
      if (enteredToken) {
        // Changing the active credential is a separate explicit save. Keep it
        // disabled until the new credential passes discovery and is enabled.
        if (current.enabled) {
          current = await window.workwise.saveMcpServer({ config: { ...current, enabled: false }, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() })
          remember(current)
        }
        current = await window.workwise.setMcpServerCredential({ serverId: current.id, workspaceRoot: current.workspaceRoot,
          accessToken: enteredToken, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() })
        remember(current)
      }
      const result = await window.workwise.testMcpServer(current.id, current.workspaceRoot)
      setCheck({ revision: current.revision, result })
      setMessage(result.message ?? '连接检查结束，请查看当前状态。')
      setRuntime(await readRuntime(current.id).catch(() => undefined))
      await onChanged()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const apply = async (enabled: boolean): Promise<void> => {
    if (!server) return
    setBusy(true); setMessage(''); setRuntime(undefined)
    try {
      const current = (await window.workwise.listMcpServers(workspaceRoot)).find(item => item.id === server.id)
      if (!current || current.revision !== server.revision) throw new Error('连接配置已变化，请重新检查连接。')
      if (enabled && !verified) throw new Error('请先检查当前连接和令牌权限。')
      const saved = await window.workwise.saveMcpServer({ config: { ...current, enabled }, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() })
      remember(saved)
      if (check) setCheck({ ...check, revision: saved.revision })
      const state = await readRuntime(saved.id)
      setRuntime(state)
      if (enabled && !(state?.enabled && state.available && state.status === 'connected' && (state.toolCount ?? 0) > 0)) throw new Error('配置已保存，任务执行服务尚未确认可用工具。请检查连接后重新应用。')
      setMessage(enabled ? 'GitHub 工具已启用。可以回到原任务选择继续。' : 'GitHub 工具已停用，连接配置和凭据保留。')
      await onChanged()
    } catch (error) {
      const entries = await window.workwise.listMcpServers(workspaceRoot).catch(() => [])
      const saved = entries.find(item => item.id === server.id)
      if (saved) remember(saved)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { setBusy(false) }
  }

  return <div className="fixed inset-0 z-40 bg-black/30" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <aside role="dialog" aria-modal="true" aria-label="GitHub 连接" className="absolute inset-y-0 right-0 w-full max-w-[640px] overflow-y-auto border-l border-ds-border bg-ds-card p-5 shadow-xl">
      <header className="flex items-center justify-between"><h2 className="text-base font-semibold">连接 GitHub</h2><button ref={closeRef} type="button" aria-label="关闭 GitHub 连接详情" onClick={onClose} className="rounded p-2 hover:bg-ds-hover"><X className="h-4 w-4" /></button></header>
      <p className="mt-4 text-sm leading-6 text-ds-muted">使用 GitHub 官方托管 MCP 服务。创建有期限、限定仓库范围的个人访问令牌后，在本机保存并验证。</p>
      <p className="mt-3 text-sm font-medium">{active ? `任务工具已就绪 · ${runtime?.toolCount} 项` : verified ? '认证检查通过，等待应用到任务' : server?.credentialRef ? '凭据已保存，需要检查连接' : '等待配置访问令牌'}</p>
      {githubServers.length > 1 ? <label className="mt-4 block text-sm">已有 GitHub 连接<select aria-label="已有 GitHub 连接" disabled={busy} value={selectedId} onChange={event => {
        const current = servers.find(item => item.id === event.target.value)
        setSelectedId(event.target.value); setMode(githubMcpMode(current)); setCheck(undefined); setRuntime(undefined); setMessage(''); setToken('')
      }} className="mt-2 h-10 w-full rounded border border-ds-border bg-ds-page px-3">{githubServers.map(item => <option key={item.id} value={item.id}>{item.name} · {item.scope === 'workspace' ? item.workspaceRoot : '全局'}</option>)}</select></label> : null}
      <ol className="mt-5 list-inside list-decimal space-y-3 text-sm leading-6">
        <li>选择令牌所属账号或组织，设置有效期，并选择需要处理的具体仓库。</li>
        <li>读取仓库文件需要 Contents 读取权限，读取议题需要 Issues 读取权限，读取合并请求需要 Pull requests 读取权限。Metadata 读取权限由 GitHub 自动提供。</li>
        <li>需要提交修改时，为相关权限选择读写，并在下方选择按令牌权限启用。组织要求批准时，先完成组织审批或 SSO 授权。</li>
      </ol>
      <div className="mt-3 flex flex-wrap gap-4"><button type="button" onClick={() => open(GITHUB_TOKEN_CREATE_URL)} className="inline-flex items-center gap-1 text-sm text-accent">在 GitHub 创建令牌<ExternalLink className="h-3.5 w-3.5" /></button><button type="button" onClick={() => open(GITHUB_TOKEN_GUIDE_URL)} className="text-sm text-accent">令牌权限说明</button></div>
      <label className="mt-5 block text-sm">个人访问令牌<input type="password" autoComplete="off" spellCheck={false} disabled={busy || !loaded} value={token} onChange={event => { setToken(event.target.value); setCheck(undefined) }} placeholder={server?.credentialRef ? '已有凭据，可留空检查或填写新令牌替换' : '仅在此页面填写令牌'} className="mt-2 h-10 w-full rounded-md border border-ds-border bg-ds-page px-3" /></label>
      <p className="mt-2 text-xs leading-5 text-ds-muted">令牌通过系统受保护存储保存。保护存储不可用时仅在当前运行期间保存，重启后需重新配置。令牌明文只发送至 GitHub 官方服务。</p>
      <label className="mt-4 block text-sm">任务可用能力<select aria-label="GitHub 任务可用能力" disabled={busy || !simpleEndpoint} value={mode} onChange={event => { setMode(event.target.value as 'readonly' | 'token'); setCheck(undefined); setRuntime(undefined) }} className="mt-2 h-10 w-full rounded-md border border-ds-border bg-ds-page px-3"><option value="readonly">只读仓库、议题和合并请求</option><option value="token">按令牌权限启用读写操作</option></select></label>
      {server?.workspaceRoot ? <p className="mt-2 break-all text-xs text-ds-muted">工作区范围 {server.workspaceRoot}</p> : null}
      <p className="mt-2 text-xs leading-5 text-ds-muted">写操作还需符合任务授权和工具审批策略。检查连接仅验证认证及工具目录。</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" disabled={busy || !loaded || (!server && !token.trim())} onClick={() => void inspect()} className="inline-flex items-center gap-2 rounded-md border border-ds-border px-4 py-2 text-sm hover:bg-ds-hover disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{token.trim() || changedMode ? '保存并检查' : '检查连接'}</button>
        <button type="button" disabled={busy || !verified || active} onClick={() => void apply(true)} className="rounded-md border border-ds-border px-4 py-2 text-sm hover:bg-ds-hover disabled:opacity-50">{server?.enabled ? '重新应用到任务' : '启用任务工具'}</button>
        {server?.enabled ? <button type="button" disabled={busy} onClick={() => void apply(false)} className="rounded-md border border-ds-border px-4 py-2 text-sm hover:bg-ds-hover disabled:opacity-50">停用</button> : null}
      </div>
      {message ? <p role="status" className="mt-4 rounded-lg border border-ds-border p-3 text-sm leading-6">{message}</p> : null}
      {check?.result.errorCode ? <p className="mt-2 text-xs text-ds-muted">{check.result.errorCode}</p> : null}
      <details className="mt-5"><summary className="cursor-pointer text-sm text-ds-muted">已有 OAuth 与高级配置</summary><p className="mt-2 text-xs leading-5 text-ds-muted">GitHub 远端 OAuth 登录要求宿主应用具有已注册的 GitHub App 或 OAuth App。已有 OAuth 配置和凭据可在高级设置中继续管理。</p><div className="mt-2 flex gap-4"><button type="button" onClick={onAdvanced} className="text-sm text-accent">打开高级 MCP 设置</button><button type="button" onClick={() => open(GITHUB_MCP_AUTH_GUIDE_URL)} className="text-sm text-accent">GitHub 官方认证说明</button></div></details>
    </aside>
  </div>
}
