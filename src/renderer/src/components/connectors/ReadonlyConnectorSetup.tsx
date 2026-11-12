import { useEffect, useRef, useState, type ReactElement } from 'react'
import { ExternalLink, Loader2, X } from 'lucide-react'
import type { McpServerConfigV2 } from '@shared/agent-workbench'
import type { MarketplaceCatalogPackageEntryV1 } from '@shared/marketplace'
import { AMAP_READ_TOOLS } from '@shared/engineering-marketplace'
import { currentMcpConnectionCheck, mcpToolDiscoveryPassed } from '@shared/mcp-connection-check'

export function ReadonlyConnectorSetup({ entry, onClose, onInstall, onChanged }: {
  entry: MarketplaceCatalogPackageEntryV1
  onClose: () => void
  onInstall: () => void
  onChanged: () => void | Promise<void>
}): ReactElement {
  const amap = entry.package.id === 'amap-maps'
  const serverId = amap ? 'amap-maps-server' : 'zotero-mcp-server'
  const [server, setServer] = useState<McpServerConfigV2>()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [connected, setConnected] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const keydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('keydown', keydown); previous?.focus() }
  }, [onClose])
  useEffect(() => {
    let active = true
    void window.workwise.listMcpServers().then(servers => {
      if (!active) return
      const current = servers.find(item => item.id === serverId)
      setServer(current)
      setConnected(mcpToolDiscoveryPassed(current))
    })
      .catch(() => { if (active) setMessage('读取连接配置失败，请重试。') })
    return () => { active = false }
  }, [serverId])

  const check = async (): Promise<void> => {
    setBusy(true); setMessage(''); setConnected(false)
    try {
      let current = (await window.workwise.listMcpServers()).find(item => item.id === serverId)
      if (amap && (key.trim() || !current)) {
        if (current && (current.source !== 'managed-tool' || current.managedPreset !== 'amap-readonly')) throw new Error('同名的已有连接配置已保留，请在高级 MCP 设置中管理。')
        if (!key.trim()) throw new Error('请输入高德 Web 服务 Key。')
        current = await window.workwise.saveMcpServer({ config: {
          id: serverId, name: '高德地图', scope: 'global', transport: 'http', url: 'https://mcp.amap.com/mcp',
          timeoutMs: 30_000, source: 'managed-tool', managedPreset: 'amap-readonly',
          toolPolicy: { '*': 'deny', ...Object.fromEntries(AMAP_READ_TOOLS.map(name => [name, 'allow' as const])) },
          readOnlyTools: [...AMAP_READ_TOOLS], enabled: false, ...(current?.credentialRef ? { credentialRef: current.credentialRef } : {})
        }, expectedRevision: current?.revision ?? 0, idempotencyKey: crypto.randomUUID() })
        current = await window.workwise.setMcpServerCredential({ serverId, accessToken: key.trim(), expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() })
        setKey('')
        setServer(current)
      }
      if (!current) throw new Error('请先安装连接器。')
      if (current.managedPreset !== (amap ? 'amap-readonly' : 'zotero-readonly')) throw new Error('同名的已有配置已保留，请在高级 MCP 设置中管理。')
      const result = await window.workwise.testMcpServer(serverId, current.workspaceRoot)
      const updated = (await window.workwise.listMcpServers()).find(item => item.id === serverId)
      setServer(updated)
      setConnected(mcpToolDiscoveryPassed(updated))
      setMessage(result.state === 'connected' && result.authorized ? '' : result.message ?? '连接尚未就绪。')
      await onChanged()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const toggle = async (): Promise<void> => {
    if (!server) return
    setBusy(true)
    try {
      const current = (await window.workwise.listMcpServers()).find(item => item.id === serverId)
      if (!current) throw new Error('连接配置已变化，请重新打开详情。')
      const saved = await window.workwise.saveMcpServer({ config: { ...current, enabled: !server.enabled }, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID() })
      setServer(saved)
      setConnected(mcpToolDiscoveryPassed(saved))
      setMessage(saved.enabled ? '已启用只读工具。' : '已停用，重新启用前请检查连接。')
      await onChanged()
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const checkEvidence = currentMcpConnectionCheck(server)
  return <div className="ds-connector-overlay fixed inset-0 z-40 bg-black/30" onMouseDown={event => { if (event.currentTarget === event.target) onClose() }}>
    <aside role="dialog" aria-modal="true" aria-label={entry.package.name} className="absolute inset-y-0 right-0 w-full max-w-[600px] overflow-y-auto border-l border-ds-border bg-ds-card p-5 shadow-xl">
      <header className="flex items-center justify-between"><h2 className="text-base font-semibold">{entry.package.name}</h2><button ref={closeRef} type="button" onClick={onClose} aria-label="关闭连接详情" className="rounded p-2 hover:bg-ds-hover"><X className="h-4 w-4" /></button></header>
      <p className="mt-5 text-sm leading-6 text-ds-muted">{entry.package.summary}</p>
      {amap ? <>
        <button type="button" onClick={() => void window.workwise.openExternal('https://console.amap.com/dev/key/app').catch(() => setMessage('无法打开高德控制台，请检查默认浏览器。'))} className="mt-4 inline-flex items-center gap-2 text-sm text-accent">获取高德 Web 服务 Key<ExternalLink className="h-3.5 w-3.5" /></button>
        <label className="mt-4 block text-sm">Web 服务 Key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} placeholder={server?.credentialRef ? '已保存，可填写新的 Key' : '在高德控制台创建的 Key'} className="mt-2 h-10 w-full rounded-md border border-ds-border bg-ds-page px-3" /></label>
      </> : <>
        <p className="mt-4 text-sm leading-6">打开 Zotero，在“设置 → 高级”中允许本机应用连接。此连接器仅访问本机已同步文献。</p>
        <p className="mt-3 text-xs leading-5 text-ds-muted">固定版本 0.17.0，采用 MIT AND AGPL-3.0-or-later，由用户独立从上游安装。保留完整许可证，仅启用本机只读工具。semantic、PDF 扩展和写入授权保持关闭。</p>
        {!server ? <button type="button" onClick={onInstall} className="mt-4 rounded-md border border-ds-border px-4 py-2 text-sm hover:bg-ds-hover">审阅并安装</button> : null}
      </>}
      <div className="mt-5 flex flex-wrap gap-3">
        <button type="button" disabled={busy || (!amap && !server)} onClick={() => void check()} className="inline-flex items-center gap-2 rounded-md border border-ds-border px-4 py-2 text-sm hover:bg-ds-hover disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{amap && key ? '保存并检查' : '检查连接'}</button>
        {server ? <button type="button" disabled={busy || (!server.enabled && !connected)} onClick={() => void toggle()} className="rounded-md border border-ds-border px-4 py-2 text-sm hover:bg-ds-hover disabled:opacity-50">{server.enabled ? '停用' : '启用只读工具'}</button> : null}
      </div>
      <p className="mt-3 text-xs leading-5 text-ds-muted">检查连接后启用工具，再从原任务选择继续。</p>
      {checkEvidence ? <div className="mt-4 rounded-lg border border-ds-border p-3 text-sm leading-6">
        <p role="status">{mcpToolDiscoveryPassed(server) ? `连接检查通过（${checkEvidence.toolCount} 项工具）` : '连接检查未通过'}</p>
        <time dateTime={checkEvidence.checkedAt} className="text-xs text-ds-muted">{new Date(checkEvidence.checkedAt).toLocaleString()}</time>
        <p className="text-xs text-ds-muted">业务调用结果见任务详情中的操作回执。</p>
      </div> : null}
      {message ? <p role="status" className="mt-4 rounded-lg border border-ds-border p-3 text-sm leading-6">{message}</p> : null}
    </aside>
  </div>
}
