import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { getProvider } from '../../agent/registry'
import { useChatStore } from '../../store/chat-store'
import { designAssistantThreadIdForDocument, markDesignAssistantThread } from '../../design/design-thread-registry'
import type { NativePptxProposal, NativePptxSnapshot } from './native-pptx-model'
import type { PptxElement } from 'pptx-vanilla-viewer'
import { nativePptxPrompt, parseNativePptxProposal } from './native-pptx-model'

type Props = {
  documentId: string
  documentName: string
  workspaceRoot: string
  getSnapshot: () => Promise<NativePptxSnapshot>
  applyProposal: (proposal: NativePptxProposal) => Promise<void>
  onClose: () => void
}

/** Uses the document's existing assistant thread, without routing PPTX writes through the free canvas. */
export function NativePptxAssistant({ documentId, documentName, workspaceRoot, getSnapshot, applyProposal, onClose }: Props): ReactElement {
  const { i18n } = useTranslation('common')
  const zh = /^zh/i.test(i18n.resolvedLanguage || i18n.language)
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<NativePptxProposal | null>(null)
  const [notice, setNotice] = useState('')
  const [history, setHistory] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  const token = useRef(0)
  const pending = useRef<{ threadId: string; turnId: string } | null>(null)
  const runtimeReady = useChatStore((state) => state.runtimeConnection === 'ready')
  useEffect(() => () => {
    token.current += 1
    const turn = pending.current
    if (turn) void getProvider().interruptTurn(turn.threadId, turn.turnId).catch(() => undefined)
  }, [])

  const generate = async (): Promise<void> => {
    if (!request.trim() || busy) return
    const currentToken = ++token.current
    const requestText = request.trim()
    setBusy(true)
    setProposal(null)
    setNotice('')
    try {
      const snapshot = await getSnapshot()
      const provider = getProvider()
      let threadId = designAssistantThreadIdForDocument(documentId)
      if (!threadId) {
        const thread = await provider.createThread({ workspace: workspaceRoot, title: `Design · ${documentName}`, mode: 'agent' })
        threadId = thread.id
        markDesignAssistantThread(documentId, threadId, workspaceRoot)
      } else {
        const existing = await provider.getThreadDetail(threadId)
        if (['running', 'queued', 'pending'].includes(existing.latestTurnStatus ?? '')) throw new Error(zh ? '此文档的助手正在处理另一项请求，请等待完成。' : 'The document assistant is handling another request. Wait for it to finish.')
      }
      const attachments: string[] = []
      if (snapshot.preview && provider.uploadAttachment) {
        const uploaded = await provider.uploadAttachment({
          name: `slide-${snapshot.slideIndex + 1}.png`, mimeType: 'image/png',
          dataBase64: snapshot.preview.split(',')[1], threadId, workspace: workspaceRoot
        })
        attachments.push(uploaded.id)
      }
      if (currentToken !== token.current) return
      const turn = await provider.sendUserMessage(threadId, nativePptxPrompt(requestText, snapshot), {
        mode: 'plan', displayText: requestText, attachmentIds: attachments
      })
      pending.current = { threadId, turnId: turn.turnId }
      setHistory((items) => [...items, { role: 'user', text: requestText }])
      for (;;) {
        if (currentToken !== token.current) return
        const detail = await provider.getThreadDetail(threadId)
        if (detail.latestTurnId === turn.turnId && ['completed', 'failed', 'aborted', 'cancelled', 'blocked'].includes(detail.latestTurnStatus ?? '')) {
          if (detail.latestTurnStatus !== 'completed') throw new Error(detail.latestTurnError || (zh ? 'AI 请求未完成。' : 'AI request did not complete.'))
          const userIndex = detail.blocks.map((block) => block.kind).lastIndexOf('user')
          const reply = detail.blocks.slice(userIndex + 1).filter((block) => block.kind === 'assistant').map((block) => 'text' in block ? block.text : '').join('\n')
          const next = parseNativePptxProposal(reply, snapshot)
          setProposal(next)
          setHistory((items) => [...items, { role: 'assistant', text: next.summary }])
          setRequest('')
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } catch (error) {
      if (currentToken === token.current) setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      if (currentToken === token.current) {
        setBusy(false)
        pending.current = null
      }
    }
  }

  const cancel = (): void => {
    token.current += 1
    setBusy(false)
    const turn = pending.current
    pending.current = null
    if (turn) void getProvider().interruptTurn(turn.threadId, turn.turnId).catch((error: unknown) => setNotice(String(error)))
  }

  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-80 max-w-full flex-col border-l border-ds-border bg-ds-card shadow-xl 2xl:static 2xl:shadow-none" aria-label={zh ? 'PPTX AI 助手' : 'PPTX AI assistant'}>
      <div className="flex shrink-0 items-center justify-between border-b border-ds-border px-3 py-2 text-sm font-medium">
        <span>{zh ? 'AI 编辑幻灯片' : 'AI slide editing'}</span>
        <button type="button" onClick={onClose} className="min-h-8 min-w-8 rounded hover:bg-ds-hover" aria-label={zh ? '关闭助手' : 'Close assistant'}>×</button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs leading-5">
        <p className="text-ds-muted">{zh ? '读取当前页全部对象及所选对象属性。AI 先提出修改，确认后作为一次可撤销操作应用。锁定与受保护对象不可修改。' : 'Reads every object on the current slide and the complete selection. Review a proposal before applying it as one undoable edit. Locked and protected objects cannot be changed.'}</p>
        {history.map((item, index) => <p key={index} className={`whitespace-pre-wrap rounded p-2 ${item.role === 'user' ? 'bg-accent/10' : 'bg-ds-main'}`}>{item.text}</p>)}
        {proposal ? (
          <div className="space-y-2 rounded border border-accent/30 bg-accent/5 p-3" data-testid="pptx-ai-proposal">
            <strong>{zh ? '待应用修改' : 'Proposed changes'}</strong>
            <p>{proposal.summary}</p>
            <p>{zh ? `第 ${proposal.snapshot.slideIndex + 1} 页 · ${proposal.updates.length} 个对象` : `Slide ${proposal.snapshot.slideIndex + 1} · ${proposal.updates.length} objects`}</p>
            <ul>{proposal.updates.map((update, index) => <li key={index}>{proposal.snapshot.slide.elements.find((item: PptxElement) => item.id === update.elementId)?.name || update.elementId}: {Object.keys(update.patch).join(', ')}</li>)}</ul>
            <div className="flex gap-2">
              <button type="button" className="min-h-9 rounded bg-accent px-3 text-white" onClick={() => {
                void applyProposal(proposal).then(() => { setProposal(null); setNotice(zh ? '已应用，可撤销。' : 'Applied. Undo is available.') }).catch((error: unknown) => setNotice(String(error)))
              }}>{zh ? '应用修改' : 'Apply changes'}</button>
              <button type="button" className="min-h-9 rounded border border-ds-border px-3" onClick={() => setProposal(null)}>{zh ? '放弃' : 'Discard'}</button>
            </div>
          </div>
        ) : null}
        {notice ? <p role="status" className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-950">{notice}</p> : null}
      </div>
      <div className="shrink-0 space-y-2 border-t border-ds-border p-3">
        <textarea value={request} onChange={(event) => setRequest(event.target.value)} className="min-h-24 w-full resize-y rounded border border-ds-border bg-ds-main p-2 text-sm outline-none focus:border-accent" aria-label={zh ? '描述幻灯片修改' : 'Describe slide changes'} placeholder={zh ? '例如：将选中标题改成深蓝色' : 'For example: make the selected title dark blue'} disabled={busy} />
        <button type="button" className="min-h-9 w-full rounded bg-accent px-3 text-sm text-white disabled:opacity-50" disabled={!busy && (!runtimeReady || !request.trim())} onClick={() => busy ? cancel() : void generate()}>{busy ? (zh ? '停止生成' : 'Stop') : (zh ? '生成修改建议' : 'Propose edits')}</button>
        {!runtimeReady ? <p className="text-xs text-ds-muted">{zh ? '正在连接 AI 运行时…' : 'Connecting to the AI runtime…'}</p> : null}
      </div>
    </aside>
  )
}
