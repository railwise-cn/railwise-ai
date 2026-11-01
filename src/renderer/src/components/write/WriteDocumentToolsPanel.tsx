import { useEffect, useState, type ReactElement } from 'react'
import { diffLines } from 'diff'
import { parseDocument, stringify } from 'yaml'
import { FileSliders, History, Link2, MessageSquare, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DocumentComment, DocumentHistoryEntry, DocumentHistorySummary, DocumentSemantics, DocumentRevision } from '@shared/write-document'
import type { WriteEditorSelectionState } from './WriteMarkdownEditor'
import { useWriteDialogFocus } from './use-write-dialog-focus'

type Tool = 'properties' | 'links' | 'history' | 'comments'
type Props = {
  workspaceRoot: string
  path: string
  content: string
  selection: WriteEditorSelectionState
  readOnly: boolean
  saveRevision: number
  onChange: (content: string) => void
  onOpenFile: (path: string) => void
  onAskAssistant: (prompt: string) => void
  onBeforeRestore: () => Promise<DocumentRevision | null>
  onRestored: () => Promise<boolean>
}

export function replaceDocumentFrontmatter(content: string, raw: string): string {
  const match = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content)
  const body = match ? content.slice(match[0].length) : content
  return raw.trim() ? `---\n${raw.trimEnd()}\n---\n${body}` : body
}

const buttonClass = 'rounded-lg border border-ds-border px-3 py-1.5 text-[12px] text-ds-ink transition hover:bg-ds-hover disabled:opacity-40'
const fieldClass = 'w-full rounded-lg border border-ds-border bg-ds-panel px-3 py-2 text-[12px] text-ds-ink outline-none focus:border-accent'

export function WriteDocumentToolsPanel({ workspaceRoot, path, content, selection, readOnly, saveRevision, onChange, onOpenFile, onAskAssistant, onBeforeRestore, onRestored }: Props): ReactElement {
  const { t, i18n } = useTranslation('common')
  const zh = i18n.language.startsWith('zh')
  const label = (cn: string, en: string): string => zh ? cn : en
  const [tool, setTool] = useState<Tool | null>(null)
  const [semantics, setSemantics] = useState<DocumentSemantics | null>(null)
  const [history, setHistory] = useState<DocumentHistorySummary[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [comments, setComments] = useState<DocumentComment[]>([])
  const [raw, setRaw] = useState('')
  const [comment, setComment] = useState('')
  const [commentAnchor, setCommentAnchor] = useState(selection)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedHistory, setSelectedHistory] = useState<DocumentHistoryEntry | null>(null)
  const [refresh, setRefresh] = useState(0)
  const historyRevision = tool === 'history' ? saveRevision : 0
  useWriteDialogFocus(Boolean(tool), 'write-document-tools-title', () => setTool(null))

  useEffect(() => { setTool(null); setSelectedHistory(null); setError(null); setComment('') }, [path])
  useEffect(() => {
    if (!tool) return
    let cancelled = false
    setBusy(true)
    setError(null)
    const load = async (): Promise<void> => {
      try {
        if (tool === 'properties' || tool === 'links') {
          const result = await window.workwise.getDocumentSemantics({ workspaceRoot, path, content })
          if (!cancelled) { setSemantics(result); setRaw(result.frontmatter.raw) }
        } else if (tool === 'history') {
          const result = await window.workwise.listDocumentHistory({ workspaceRoot, path })
          if (!cancelled) { setHistory(result.entries); setHistoryTotal(result.total) }
        } else {
          const result = await window.workwise.listDocumentComments({ workspaceRoot, path })
          if (!cancelled) setComments(result)
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally { if (!cancelled) setBusy(false) }
    }
    void load()
    return () => { cancelled = true }
    // Loading properties again while typing would overwrite the YAML draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, path, workspaceRoot, historyRevision, refresh])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const applyFrontmatter = (): void => {
    try {
    const parsed = parseDocument(raw, { uniqueKeys: true })
    const data = parsed.toJS({ maxAliasCount: 50 })
    if (parsed.errors.length || (data !== null && (typeof data !== 'object' || Array.isArray(data)))) {
      setError(parsed.errors[0]?.message ?? label('属性必须是 YAML 字段对象。', 'Properties must be a YAML mapping.'))
      return
    }
    for (const key of ['title', 'status', 'stage']) {
      if (data?.[key] !== undefined && typeof data[key] !== 'string') {
        setError(label(`${key} 字段必须是文本。`, `${key} must be text.`)); return
      }
    }
    if (data?.tags !== undefined && (!Array.isArray(data.tags) || data.tags.some((tag: unknown) => typeof tag !== 'string'))) {
      setError(label('tags 必须是文本列表。', 'tags must be a list of text values.')); return
    }
    onChange(replaceDocumentFrontmatter(content, raw)); setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const tools: Array<{ id: Tool; name: string; icon: typeof History }> = [
    { id: 'properties', name: label('属性', 'Properties'), icon: FileSliders },
    { id: 'links', name: label('链接与关系', 'Links'), icon: Link2 },
    { id: 'history', name: label('历史', 'History'), icon: History },
    { id: 'comments', name: label('批注', 'Comments'), icon: MessageSquare }
  ]

  return (
    <>
      <div className="flex shrink-0 items-center gap-1">
        {tools.map(({ id, name, icon: Icon }) => (
          <button key={id} type="button" className={`inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] transition hover:bg-ds-hover ${tool === id ? 'text-accent' : 'text-ds-muted'}`} title={name} aria-label={name} aria-expanded={tool === id} onClick={() => {
            if (id === 'comments') setCommentAnchor(selection)
            setTool((current) => current === id ? null : id)
          }}><Icon className="h-3.5 w-3.5" /><span className="hidden xl:inline">{name}</span></button>
        ))}
      </div>
      {tool ? (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/35 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setTool(null) }}>
          <section className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-ds-border bg-ds-card p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="write-document-tools-title">
            <div className="flex items-center justify-between gap-4">
              <h2 id="write-document-tools-title" className="text-[16px] font-semibold text-ds-ink">{tools.find((item) => item.id === tool)?.name}</h2>
              <button autoFocus type="button" className="rounded-lg p-2 text-ds-muted hover:bg-ds-hover" aria-label={t('close', { defaultValue: label('关闭', 'Close') })} onClick={() => setTool(null)}><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-1 truncate text-[11px] text-ds-faint">{path}</div>
            <div className="mt-4 min-h-0 flex-1 overflow-auto">
              {busy ? <p className="py-4 text-[12px] text-ds-muted">{label('读取中…', 'Loading…')}</p> : null}
              {error ? <p role="alert" className="mb-3 whitespace-pre-wrap text-[12px] text-red-600 dark:text-red-300">{error}</p> : null}
              {tool === 'properties' ? (
                <div className="space-y-3">
                  <p className="text-[12px] leading-5 text-ds-muted">{label('属性保存在文档开头的 YAML 中。title、tags 和 stage 可用于整理写作流程。', 'Properties live in YAML at the start of the document. Use title, tags and stage to organize writing.')}</p>
                  {semantics?.frontmatter.error ? <p className="text-[12px] text-amber-700 dark:text-amber-200">{semantics.frontmatter.error}</p> : null}
                  <div className="flex flex-wrap gap-2">
                    <select aria-label={label('文档模板', 'Document template')} className={buttonClass} defaultValue="" disabled={readOnly} onChange={(event) => {
                      const template = event.target.value
                      if (!template) return
                      const title = content.match(/^#\s+(.+)$/m)?.[1] ?? label('未命名文档', 'Untitled')
                      setRaw(stringify({ title, tags: [], stage: 'research', type: template, date: new Date().toISOString().slice(0, 10) }))
                    }}>
                      <option value="">{label('选择属性模板', 'Choose a property template')}</option>
                      <option value="article">{label('文章', 'Article')}</option><option value="technical-report">{label('工程报告', 'Technical report')}</option><option value="research-notes">{label('研究笔记', 'Research notes')}</option>
                    </select>
                    <select aria-label={label('写作阶段', 'Writing stage')} className={buttonClass} defaultValue="" disabled={readOnly} onChange={(event) => {
                      if (!event.target.value) return
                      try { const data = parseDocument(raw).toJS({ maxAliasCount: 50 }) ?? {}; setRaw(stringify({ ...data, stage: event.target.value })) }
                      catch (cause) { setError(String(cause)) }
                    }}>
                      <option value="">{label('设置写作阶段', 'Set writing stage')}</option>
                      <option value="research">{label('研究资料', 'Research')}</option><option value="draft">{label('草稿', 'Draft')}</option><option value="reviewed">{label('审定稿', 'Reviewed')}</option><option value="published">{label('发布稿', 'Published')}</option>
                    </select>
                  </div>
                  <textarea aria-label="YAML frontmatter" rows={11} value={raw} onChange={(event) => setRaw(event.target.value)} disabled={readOnly} className={`${fieldClass} font-mono leading-6`} spellCheck={false} />
                  <button type="button" className={buttonClass} disabled={readOnly || busy} onClick={applyFrontmatter}>{label('应用属性', 'Apply properties')}</button>
                </div>
              ) : null}
              {tool === 'links' && semantics ? (
                <div className="space-y-5 text-[12px]">
                  <div><h3 className="mb-2 font-semibold text-ds-ink">{label('文档链接', 'Outgoing links')}</h3>{semantics.outgoing.length ? semantics.outgoing.map((link, index) => (
                    <button key={index} type="button" disabled={link.status !== 'valid' || !link.resolvedPath} onClick={() => { if (link.resolvedPath) { onOpenFile(link.resolvedPath); setTool(null) } }} className="mb-1 flex w-full items-center justify-between gap-2 rounded-lg border border-ds-border-muted px-3 py-2 text-left text-ds-ink hover:bg-ds-hover disabled:text-ds-faint">
                      <span className="truncate">{link.label || link.target}<span className="ml-2 text-ds-faint">:{link.line}</span></span><span>{link.status === 'broken' ? label('断链', 'Missing') : link.status === 'unsafe' ? label('路径越界', 'Outside workspace') : '↗'}</span>
                    </button>
                  )) : <p className="text-ds-faint">{label('此文档没有本地链接。', 'No local links in this document.')}</p>}</div>
                  <div><h3 className="mb-2 font-semibold text-ds-ink">{label('反向链接', 'Backlinks')}</h3>{semantics.backlinks.length ? semantics.backlinks.map((link, index) => (
                    <button key={index} type="button" className="mb-1 block w-full truncate rounded-lg border border-ds-border-muted px-3 py-2 text-left text-ds-ink hover:bg-ds-hover" onClick={() => { onOpenFile(link.sourcePath); setTool(null) }}>{link.sourcePath.replace(`${workspaceRoot}/`, '')}:{link.line}</button>
                  )) : <p className="text-ds-faint">{label('尚无其他文档链接到这里。', 'No other documents link here yet.')}</p>}</div>
                  <div><h3 className="mb-2 font-semibold text-ds-ink">{label('工作区关系', 'Workspace relationships')}</h3>
                    <div className="max-h-48 overflow-auto rounded-xl border border-ds-border-muted p-2">{semantics.relations.edges.length ? semantics.relations.edges.map((edge, index) => <div key={index} className="flex items-center gap-2 border-b border-ds-border-muted px-1 py-2 last:border-0"><button type="button" className="min-w-0 flex-1 truncate text-left text-accent" onClick={() => { onOpenFile(edge.from); setTool(null) }}>{edge.from.replace(`${workspaceRoot}/`, '')}</button><span className="text-ds-faint">→</span><button type="button" className="min-w-0 flex-1 truncate text-left text-accent" onClick={() => { onOpenFile(edge.to); setTool(null) }}>{edge.to.replace(`${workspaceRoot}/`, '')}</button></div>) : <p className="p-2 text-ds-faint">{label('添加相对 Markdown 链接后即可查看文档关系。', 'Add relative Markdown links to build relationships.')}</p>}</div>
                    {semantics.relations.truncated ? <p className="mt-2 text-amber-700 dark:text-amber-200">{label('部分大型或超出扫描上限的文档未参与关系分析。', 'Some large documents or scan-limit results are omitted.')}</p> : null}
                  </div>
                </div>
              ) : null}
              {tool === 'history' ? (
                <div className="space-y-3">
                  <p className="text-[12px] text-ds-muted">{label('每次保存保留本地快照。恢复会新增历史记录，后续版本仍保留。', 'Saves keep local snapshots. Restoring adds a history entry and preserves later versions.')}</p>
                  <div className="max-h-40 space-y-1 overflow-auto">{history.length ? history.map((entry) => <button key={entry.id} type="button" disabled={busy} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-[12px] ${selectedHistory?.id === entry.id ? 'border-accent text-accent' : 'border-ds-border-muted text-ds-ink hover:bg-ds-hover'}`} onClick={() => void run(async () => setSelectedHistory(await window.workwise.getDocumentHistoryEntry({ workspaceRoot, path, id: entry.id })))}><span>{new Date(entry.createdAt).toLocaleString()}</span><span className="text-ds-faint">{entry.source} · {entry.revision.size} B</span></button>) : <p className="py-4 text-[12px] text-ds-faint">{label('首次保存后即可查看历史。', 'History appears after your first save.')}</p>}</div>
                  {historyTotal > history.length ? <p className="text-[11px] text-ds-faint">{label(`显示最近 ${history.length} 条，共 ${historyTotal} 条；全部记录均保留在本地。`, `Showing the latest ${history.length} of ${historyTotal} entries. All records remain on disk.`)}</p> : null}
                  {selectedHistory ? <>
                    <div className="max-h-60 overflow-auto rounded-xl border border-ds-border-muted p-3 font-mono text-[11px] leading-5">{diffLines(content, selectedHistory.content).map((part, index) => <pre key={index} className={`whitespace-pre-wrap break-words ${part.added ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-200' : part.removed ? 'bg-red-500/10 text-red-700 dark:text-red-200' : 'text-ds-muted'}`}>{part.added ? '+ ' : part.removed ? '− ' : '  '}{part.value}</pre>)}</div>
                    <button type="button" className={buttonClass} disabled={readOnly || busy} onClick={() => void run(async () => {
                      const expectedRevision = await onBeforeRestore()
                      if (!expectedRevision) throw new Error(label('请先解决当前文档的保存冲突。', 'Resolve the current save conflict first.'))
                      const restored = await window.workwise.restoreDocumentHistory({ path, workspaceRoot, id: selectedHistory.id, expectedRevision })
                      if (!restored.ok) throw new Error('message' in restored ? restored.message : label('恢复时检测到外部修改，请重新查看历史。', 'The file changed during restore. Refresh history and try again.'))
                      await onRestored(); setSelectedHistory(null); setRefresh((value) => value + 1)
                    })}>{label('恢复此版本', 'Restore this version')}</button>
                  </> : null}
                </div>
              ) : null}
              {tool === 'comments' ? (
                <div className="space-y-3">
                  <p className="text-[12px] leading-5 text-ds-muted">{label('批注仅保存在本地，不会写入 Markdown 正文。先选择文中内容可添加锚定批注。', 'Comments are local and kept outside Markdown. Select text first to anchor a comment.')}</p>
                  {commentAnchor.text ? <blockquote className="max-h-24 overflow-auto rounded-lg border-l-2 border-accent bg-accent/5 p-2 text-[12px] text-ds-muted">{commentAnchor.text}</blockquote> : null}
                  <textarea rows={3} aria-label={label('添加批注', 'Add a comment')} value={comment} onChange={(event) => setComment(event.target.value)} className={fieldClass} placeholder={label('输入审阅意见…', 'Write a review comment…')} />
                  <button type="button" className={buttonClass} disabled={!comment.trim() || !commentAnchor.ranges.length || busy || readOnly} onClick={() => void run(async () => {
                    const range = commentAnchor.ranges[0]
                    if (!await onBeforeRestore()) throw new Error(label('请先解决当前文档的保存冲突。', 'Resolve the current save conflict first.'))
                    await window.workwise.createDocumentComment({ path, workspaceRoot, text: comment.trim(), anchor: { from: range?.from ?? 0, to: range?.to ?? 0, text: range?.text ?? '' } })
                    setComment(''); setRefresh((value) => value + 1)
                  })}>{label('保存批注', 'Save comment')}</button>
                  {comments.map((item) => <article key={item.id} className={`rounded-xl border border-ds-border-muted p-3 ${item.status === 'resolved' ? 'opacity-60' : ''}`}>
                    <div className="text-[10px] text-ds-faint">{new Date(item.createdAt).toLocaleString()} · {item.status === 'resolved' ? label('已解决', 'Resolved') : label('待处理', 'Open')}</div>
                    {item.anchor.text ? <blockquote className="mt-2 max-h-20 overflow-auto border-l-2 border-ds-border pl-2 text-[11px] text-ds-faint">{item.anchor.text}{content.slice(item.anchor.from, item.anchor.to) !== item.anchor.text ? <span className="ml-2 text-amber-700 dark:text-amber-200">{label('原文已变化', 'Anchor changed')}</span> : null}</blockquote> : null}
                    <p className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-ds-ink">{item.text}</p>
                    <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => void run(async () => { await window.workwise.updateDocumentComment({ path, workspaceRoot, id: item.id, status: item.status === 'open' ? 'resolved' : 'open' }); setRefresh((value) => value + 1) })}>{item.status === 'open' ? label('解决', 'Resolve') : label('重新打开', 'Reopen')}</button><button type="button" className={buttonClass} onClick={() => { onAskAssistant(`${label('请根据这条批注提出修改建议，并在写入前提供差异审阅：', 'Propose changes for this comment and provide a diff before writing:')}\n\n@${path}\n\n${item.anchor.text}\n\n${item.text}`); setTool(null) }}>{label('加入 AI 写作队列', 'Send to AI writing')}</button></div>
                  </article>)}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  )
}
