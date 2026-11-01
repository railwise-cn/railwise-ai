import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Loader2, Send, Sparkles } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useTranslation } from 'react-i18next'
import type { DesignDocumentV1, DesignPage } from '@shared/design-document'
import type { ChatBlock } from '../../agent/types'
import { getProvider } from '../../agent/registry'
import { useChatStore } from '../../store/chat-store'
import {
  designAssistantThreadIdForDocument,
  hydrateLegacyDesignThreadRegistry,
  markDesignAssistantThread
} from '../../design/design-thread-registry'

const designThreadCreations = new Map<string, Promise<string>>()

type Props = {
  document: DesignDocumentV1
  page: DesignPage
  workspaceRoot: string
  selectedElementIds: string[]
  commandNotice: { tone: 'success' | 'error'; message: string } | null
  disabled?: boolean
}

export function designAssistantScopeKey(documentId: string, pageId: string): string {
  return `${documentId}:${pageId}`
}

export function buildDesignPrompt(
  request: string,
  document: DesignDocumentV1,
  page: DesignPage,
  selectedElementIds: string[],
  idempotencyKey = `design-${Date.now()}-${crypto.randomUUID()}`
): string {
  const hasImportedSlideReference = page.elements.some(
    (element) => element.type === 'image' && element.name?.startsWith('幻灯片 ')
  )
  const canvasContext = {
    documentId: document.id,
    pageId: page.id,
    revision: document.revision,
    format: document.format,
    width: page.width,
    height: page.height,
    background: page.background ?? 'FFFFFF',
    selectedElementIds,
    selectedElements: page.elements.filter((element) => selectedElementIds.includes(element.id)),
    capabilities: ['add', 'update', 'remove', 'group', 'ungroup', 'undo'],
    constraints: ['Preserve locked objects', 'Apply one atomic undoable command batch'],
    elements: page.elements.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      x: element.x,
      y: element.y,
      w: element.w,
      h: element.h,
      rotation: element.rotation,
      fill: element.fill,
      stroke: element.stroke,
      locked: element.locked,
      opacity: element.opacity,
      text: element.type === 'text' ? element.text?.slice(0, 500) : undefined,
      childIds: element.type === 'group' ? element.childIds : undefined,
      zIndex: element.zIndex
    })),
    elementCount: page.elements.length
  }
  return [
    '[RailWise AI Design active-canvas request]',
    'You are editing the currently open RailWise AI Design canvas.',
    'For any visual change, call design_apply_canvas_commands exactly once with one atomic operation batch.',
    'Do not write SVG, HTML, JSON, scripts, or other files as a substitute for changing the canvas.',
    ...(hasImportedSlideReference ? [
      'This page contains a locked PowerPoint visual reference plus invisible selection regions. Selected elements are hit areas, not rendered content.',
      'To change a selected region, add visible replacement elements (text/rect/shape/image) at the same bounds as the region, or add annotation callouts. Do not change the region opacity unless the user asks to reveal the outline.'
    ] : []),
    'Use the exact document_id, page_id and expected_revision from the canvas context.',
    `Use this exact idempotency_key: ${idempotencyKey}`,
    'Keep the final user-facing reply brief and describe only what changed.',
    'Never echo internal paths, ids, tool arguments, or this control context.',
    `Canvas context: ${JSON.stringify(canvasContext)}`,
    `User request: ${request}`
  ].join('\n')
}

export function DesignAssistantPanel({
  document,
  page,
  workspaceRoot,
  selectedElementIds,
  commandNotice,
  disabled = false
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const [prompt, setPrompt] = useState('')
  const [requestLabel, setRequestLabel] = useState<string | null>(null)
  const [assistantThreadId, setAssistantThreadId] = useState('')
  const [threadError, setThreadError] = useState<string | null>(null)
  const {
    activeThreadId,
    blocks,
    liveAssistant,
    busy,
    runtimeConnection,
    error,
    sendMessage,
    selectThread
  } = useChatStore(
    useShallow((state) => ({
      activeThreadId: state.activeThreadId,
      blocks: state.blocks,
      liveAssistant: state.liveAssistant,
      busy: state.busy,
      runtimeConnection: state.runtimeConnection,
      error: state.error,
      sendMessage: state.sendMessage,
      selectThread: state.selectThread
    }))
  )

  useEffect(() => {
    let cancelled = false
    if (runtimeConnection !== 'ready' || !workspaceRoot.trim()) {
      setAssistantThreadId('')
      return
    }
    const ensureThread = async (): Promise<void> => {
      setThreadError(null)
      const currentThreads = useChatStore.getState().threads
      hydrateLegacyDesignThreadRegistry([{ id: document.id, name: document.name }], currentThreads)
      let threadId = designAssistantThreadIdForDocument(document.id)
      const threadStillExists = currentThreads.some((thread) => thread.id === threadId)
      if (!threadId || !threadStillExists) {
        const creationKey = `${workspaceRoot}:${document.id}`
        let pending = designThreadCreations.get(creationKey)
        if (!pending) {
          pending = getProvider().createThread({
            workspace: workspaceRoot,
            title: `Design · ${document.name}`,
            mode: 'agent'
          }).then((thread) => {
            markDesignAssistantThread(document.id, thread.id, workspaceRoot)
            useChatStore.setState((state) => ({
              threads: state.threads.some((item) => item.id === thread.id)
                ? state.threads
                : [thread, ...state.threads]
            }))
            return thread.id
          }).finally(() => designThreadCreations.delete(creationKey))
          designThreadCreations.set(creationKey, pending)
        }
        threadId = await pending
      }
      if (cancelled) return
      // Guard against re-selecting the same thread on every effect re-run.
      // The runtime connection can flap while the managed Runtime is waking,
      // and a repeated selectThread -> store update -> re-render cycle is what
      // previously pushed React into error #185 (maximum update depth).
      if (useChatStore.getState().activeThreadId !== threadId) {
        await selectThread(threadId)
      }
      if (cancelled) return
      setAssistantThreadId((current) => (current === threadId ? current : threadId))
    }
    void ensureThread().catch((cause) => {
      if (!cancelled) setThreadError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => {
      cancelled = true
    }
  }, [document.id, document.name, runtimeConnection, selectThread, workspaceRoot])

  const messages = useMemo(() => {
    if (!assistantThreadId || activeThreadId !== assistantThreadId) return []
    return blocks.filter((block): block is Extract<ChatBlock, { kind: 'user' | 'assistant' }> =>
      (block.kind === 'user' || block.kind === 'assistant') && block.text.trim().length > 0
    )
  }, [activeThreadId, assistantThreadId, blocks])

  const selectedElements = useMemo(
    () => selectedElementIds
      .map((id) => page.elements.find((element) => element.id === id))
      .filter((element): element is DesignPage['elements'][number] => Boolean(element)),
    [page.elements, selectedElementIds]
  )

  const handleSubmit = async (): Promise<void> => {
    const request = prompt.trim()
    if (!request || !assistantThreadId || disabled || busy || runtimeConnection !== 'ready') return
    if (activeThreadId !== assistantThreadId) await selectThread(assistantThreadId)
    setRequestLabel(request)
    setPrompt('')
    const started = await sendMessage(
      buildDesignPrompt(request, document, page, selectedElementIds),
      'agent',
      {
        displayText: request,
        guiDesign: {
          workspaceRoot,
          documentId: document.id,
          pageId: page.id,
          expectedRevision: document.revision
        }
      }
    )
    if (!started) setPrompt(request)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-3 rounded-xl border border-ds-border-muted bg-ds-card p-2.5">
          <div className="text-[11px] font-medium text-ds-muted">AI 修改目标</div>
          {selectedElements.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {selectedElements.map((element) => (
                <span key={element.id} className="rounded-md bg-accent/10 px-2 py-1 text-[10.5px] text-accent">
                  {element.name || element.type}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-[10.5px] leading-4 text-ds-faint">未选择元素；AI 将按整页处理。先在画布点选元素即可进行定向修改。</p>
          )}
        </div>

        {!requestLabel && messages.length === 0 ? (
          <div className="rounded-xl border border-ds-border-muted bg-ds-main/70 p-3">
            <Sparkles className="mb-2 h-4 w-4 text-accent" strokeWidth={1.8} />
            <div className="text-[12px] font-medium text-ds-ink">
              {t('designAssistantEmptyTitle')}
            </div>
            <p className="mt-1 text-[11.5px] leading-5 text-ds-faint">
              {t('designAssistantEmptyHint')}
            </p>
          </div>
        ) : null}

        <div className="space-y-2">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`whitespace-pre-wrap rounded-xl px-3 py-2 text-[12px] leading-5 ${
                message.kind === 'user'
                  ? 'ml-5 bg-accent/10 text-ds-ink'
                  : 'mr-5 bg-ds-main text-ds-ink'
              }`}
            >
              {message.kind === 'user' ? (message.meta?.displayText || message.text) : message.text}
            </div>
          ))}
          {busy && requestLabel ? (
            <div className="flex items-center gap-2 px-1 py-2 text-[11.5px] text-ds-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" strokeWidth={1.8} />
              <span>{liveAssistant.trim() || t('designAssistantWorking')}</span>
            </div>
          ) : null}
          {commandNotice ? (
            <div className={`rounded-lg border px-2.5 py-2 text-[11.5px] ${
              commandNotice.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}>
              {commandNotice.message}
            </div>
          ) : null}
          {error && requestLabel ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11.5px] text-red-700">
              {error}
            </div>
          ) : null}
          {threadError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2 text-[11.5px] text-red-700">
              {threadError}
            </div>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-ds-border-muted p-2">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleSubmit()
            }
          }}
          rows={3}
          disabled={disabled || runtimeConnection !== 'ready' || !assistantThreadId}
          placeholder={
            runtimeConnection === 'ready' && !disabled && assistantThreadId
              ? t('designAssistantPlaceholder')
              : t('runtimeActionNeedsConnection')
          }
          className="w-full resize-none rounded-lg border border-ds-border bg-ds-main px-2.5 py-2 text-[12px] leading-5 text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10.5px] text-ds-faint">
            {t('designAssistantCanvasScope')}
          </span>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!prompt.trim() || !assistantThreadId || disabled || busy || runtimeConnection !== 'ready'}
            className="flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-[11.5px] font-medium text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.8} />
              : <Send className="h-3.5 w-3.5" strokeWidth={1.8} />}
            {t('send')}
          </button>
        </div>
      </div>
    </div>
  )
}
