import { TechnicalDetails } from '../ui/TechnicalDetails'
import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Copy, Download, File, FileEdit, FolderSearch, ImageIcon, Loader2, MessageSquareQuote, PencilLine, Terminal, Video, Wrench } from 'lucide-react'
import type { AttachmentReference, ChatBlock, GeneratedFileReference, RuntimeDisclosureMetadata, ToolBlock, UserInputAnswer, UserInputQuestion } from '../../agent/types'
import { extractUnifiedDiffText } from '../../lib/diff-stats'
import { useChatStore } from '../../store/chat-store'
import { getProvider } from '../../agent/registry'
import { parseWritePromptForDisplay } from '../../write/quoted-selection'
import { parseClawUserPromptForDisplay, type ClawUserPromptDisplay } from '@shared/app-settings'
import {
  openGeneratedWorkspaceFile,
  revealGeneratedWorkspaceFile,
  saveGeneratedWorkspaceFileAs
} from '../../lib/generated-file-actions'
import { resolveGeneratedFileWorkspaceRoot } from '../../lib/generated-file-path'
import { safeMediaPreviewUrl } from '../../lib/safe-media-preview-url'
import { projectDshUiText } from '../../lib/dsh-ui-stream'
import { DshUiBlocks } from './DshUiBlocks'
import { ApprovalOperationDetails } from './ApprovalOperationDetails'
import { CapabilityRequiredCard } from './CapabilityRequiredCard'
import { TaskIntentChoiceCard } from './TaskIntentChoiceCard'
import { DiffView } from '../DiffView'
import { AssistantMarkdown } from './AssistantMarkdown'
import { AttachmentFileName } from './FloatingComposerAttachments'
import { ModelMetaTag, WritePromptMetaDisclosure } from './message-timeline-cards'
import { readNumber, formatDuration } from './message-timeline-tools'
import { redactRuntimeText } from './conversation-visibility'
import { engineeringProfessionalAnswerText, engineeringProfessionalUserSurfaceText } from '../engineering/engineering-professional-text'
import { ConversationSources, type ConversationSource } from './ConversationSources'

const COPY_FEEDBACK_RESET_MS = 1600

/**
 * User message bubble with hover affordance to rewind/edit. Click the rewind
 * pill, the bubble flips into a textarea, and Resend submits an edited
 * version of the message — locally truncating subsequent turns and starting
 * a fresh turn on the same thread (see chat-store `rewindAndResend`).
 */
function UserMessageBubble({
  block,
  professionalSurface = false,
  language
}: {
  block: Extract<ChatBlock, { kind: 'user' }>
  professionalSurface?: boolean
  language?: string
}): ReactElement {
  const { t } = useTranslation('common')
  const busy = useChatStore((s) => s.busy)
  const route = useChatStore((s) => s.route)
  const rewindAndResend = useChatStore((s) => s.rewindAndResend)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(block.text)
  const [writeMetaOpen, setWriteMetaOpen] = useState(false)
  const skillSelections = block.meta?.skillSelections ?? []
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const parsedWritePrompt = useMemo(() => {
    if (route !== 'write') return null
    const parsed = parseWritePromptForDisplay(block.text)
    return parsed?.userInput.trim() ? parsed : null
  }, [block.text, route])
  const parsedClawPrompt = useMemo(() => {
    const parsed = parseClawUserPromptForDisplay(block.text)
    if (!parsed.managed && !parsed.inbound && block.managedBy !== 'claw' && route !== 'claw') return null
    return parsed
  }, [block.managedBy, block.text, route])
  const metaDisplayText =
    typeof block.meta?.displayText === 'string' && block.meta.displayText.trim()
      ? block.meta.displayText.trim()
      : null
  const originalDisplayText = metaDisplayText ?? parsedWritePrompt?.userInput ?? parsedClawPrompt?.text ?? block.text
  const displayWithoutLegacySkill = originalDisplayText.replace(
    /(`+)[\s\S]*?\1|"[^"\n]*"|“[^”\n]*”|(^|\s)\/skill:[a-f0-9]{64}(?=\s|$)/gi,
    (token, quoted: string | undefined, prefix: string | undefined) => quoted || prefix === undefined ? token : prefix
  )
  const hasLegacySkillReference = displayWithoutLegacySkill !== originalDisplayText
  const rawDisplayText = hasLegacySkillReference ? displayWithoutLegacySkill.trim() : originalDisplayText
  const displayText = professionalSurface
    ? engineeringProfessionalUserSurfaceText(rawDisplayText, language)
    : rawDisplayText
  // A translated survey prompt may contain an internal record selector in its
  // stored text. Do not offer editing for that prompt: resending the translated
  // label would lose the selector while exposing it in the editor would leak
  // implementation details onto the professional surface.
  const canEdit = !metaDisplayText && !hasLegacySkillReference && (!professionalSurface || displayText === rawDisplayText)
  const showClawInboundCard = route === 'claw' && parsedClawPrompt?.inbound === true
  const skillLabels = skillSelections.length > 0 ? (
    <div className="mb-2 flex min-w-0 flex-wrap justify-end gap-1.5" aria-label={t('composerSelectedSkills')}>
      {skillSelections.map(skill => {
        const loaded = block.meta?.activeSkillIds?.includes(skill.id)
        return <span key={skill.id} data-loaded-skill={loaded ? '' : undefined} title={skill.name} className="max-w-full truncate rounded-md border border-ds-border-muted bg-ds-card px-2 py-1 text-[12px] text-ds-muted">{skill.name}{loaded ? <span className="ml-1.5 text-ds-faint">{t('composerSkillLoaded')}</span> : null}</span>
      })}
    </div>
  ) : hasLegacySkillReference ? (
    <div className="mb-2 text-right text-[12px] text-ds-muted">{t('composerSelectedSkills')}</div>
  ) : null

  useEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    if (!el) return
    el.focus()
    const len = el.value.length
    el.setSelectionRange(len, len)
    // Auto-size to content
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 360)}px`
  }, [editing])

  useEffect(() => {
    setWriteMetaOpen(false)
  }, [block.id])

  const startEdit = (): void => {
    if (busy || !canEdit) return
    setDraft(displayText)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    setDraft(block.text)
    setEditing(false)
  }

  const submit = async (): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed || busy) return
    setEditing(false)
    await rewindAndResend(block.id, trimmed)
  }

  if (editing) {
    return (
      <div className="ds-user-message">
        {skillLabels}
        <UserAttachmentPreviews meta={block.meta} />
        <div className="ds-user-message-bubble min-w-0 border border-accent/35 ring-1 ring-accent/15">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              const el = e.currentTarget
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 360)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelEdit()
              } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            rows={2}
            className="block w-full min-w-0 resize-none break-words bg-transparent text-[15px] font-medium leading-[1.58] text-ds-ink outline-none [overflow-wrap:anywhere]"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[12px] text-ds-faint">{t('rewindHint')}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cancelEdit}
                className="rounded-md px-3 py-1 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
              >
                {t('rewindCancel')}
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!draft.trim() || busy}
                className="rounded-md bg-accent px-3 py-1 text-[13px] font-medium text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('rewindResend')}
              </button>
            </div>
          </div>
        </div>
        {!professionalSurface ? (
          <div className="mt-2 flex min-w-0 items-center justify-end">
            <ModelMetaTag label={block.modelLabel} />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="ds-user-message group relative">
      {skillLabels}
      <UserAttachmentPreviews meta={block.meta} />
      {showClawInboundCard && parsedClawPrompt ? (
        <ClawInboundMessageCard display={parsedClawPrompt} text={displayText} />
      ) : (
        <div className="ds-user-message-bubble min-w-0">
          <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-left">
            {displayText}
          </div>
          {parsedWritePrompt ? (
            <WritePromptMetaDisclosure
              display={parsedWritePrompt}
              expanded={writeMetaOpen}
              onToggle={() => setWriteMetaOpen((value) => !value)}
            />
          ) : null}
          <RuntimeMetaChips
            meta={block.meta}
            align="right"
            hideAttachments
            professionalSurface={professionalSurface}
          />
        </div>
      )}
      <div className="mt-2 flex min-w-0 items-center justify-between gap-3 text-ds-faint opacity-90 transition group-hover:opacity-100">
        {!professionalSurface ? <ModelMetaTag label={block.modelLabel} className="flex-1 justify-start text-left" /> : <span className="flex-1" />}
        <div className="flex items-center justify-end gap-3">
          <CopyFeedbackButton text={displayText} iconOnly />
          {canEdit ? (
            <button
              type="button"
              onClick={startEdit}
              disabled={busy}
              title={t('rewindEditMessage')}
              aria-label={t('rewindEditMessage')}
              className="rounded-md p-1 transition hover:bg-ds-hover hover:text-ds-muted disabled:cursor-not-allowed disabled:hover:text-ds-faint"
            >
              <PencilLine className="h-4 w-4" strokeWidth={1.8} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ClawInboundMessageCard({
  display,
  text
}: {
  display: ClawUserPromptDisplay
  text: string
}): ReactElement {
  const { t } = useTranslation('common')
  const meta = [
    display.sender ? t('clawTimelineSender', { sender: display.sender }) : '',
    display.chatType ? t('clawTimelineChatType', { chatType: display.chatType }) : '',
    display.messageType ? t('clawTimelineMessageType', { messageType: display.messageType }) : '',
    display.mentions ? t('clawTimelineMentions', { mentions: display.mentions }) : ''
  ].filter(Boolean)

  return (
    <div className="w-full max-w-[min(560px,calc(100vw-3rem))] rounded-[18px] border border-ds-border bg-ds-card px-4 py-3 text-left shadow-[0_14px_34px_rgba(86,103,136,0.08)]">
      <div className="flex items-center gap-2 text-[12px] font-semibold text-ds-muted">
        <MessageSquareQuote className="h-3.5 w-3.5" strokeWidth={1.8} />
        <span>{t('clawTimelineInbound', { source: display.sourceLabel ?? t('claw') })}</span>
      </div>
      <div className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-6 text-ds-ink [overflow-wrap:anywhere]">
        {text}
      </div>
      {meta.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {meta.map((item) => (
            <span
              key={item}
              className="rounded-md border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[11px] text-ds-muted"
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const USER_INPUT_OTHER_LABEL = 'Other'
const USER_INPUT_FREEFORM_LABEL = 'Answer'

function metaStringArray(meta: Record<string, unknown> | undefined, key: string): string[] {
  const value = meta?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function metaAttachmentReferences(meta: RuntimeDisclosureMetadata | undefined): AttachmentReference[] {
  const value = meta?.attachments
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const raw = entry as Record<string, unknown>
      const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : ''
      if (!id) return null
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : undefined
      const mimeType = typeof raw.mimeType === 'string' && raw.mimeType.trim() ? raw.mimeType.trim() : undefined
      const byteSize = typeof raw.byteSize === 'number' && Number.isFinite(raw.byteSize) ? raw.byteSize : undefined
      const previewUrl = safeMediaPreviewUrl(raw.previewUrl)
      const width = typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : undefined
      const height = typeof raw.height === 'number' && Number.isFinite(raw.height) ? raw.height : undefined
      return {
        id,
        ...(name ? { name } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(byteSize ? { byteSize } : {}),
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
        ...(previewUrl ? { previewUrl } : {})
      }
    })
    .filter((entry): entry is AttachmentReference => entry !== null)
}

type TimelineMediaReference = GeneratedFileReference & {
  id?: string
}

function readMediaString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function normalizeGeneratedFileReference(entry: unknown): GeneratedFileReference | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const id = readMediaString(raw, 'id', 'attachmentId')
  const name = readMediaString(raw, 'name', 'fileName', 'filename')
  const mimeType = readMediaString(raw, 'mimeType', 'type', 'mediaType')
  const previewUrl = safeMediaPreviewUrl(readMediaString(raw, 'previewUrl', 'dataUrl', 'url'))
  const path = readMediaString(raw, 'path', 'file')
  const relativePath = readMediaString(raw, 'relativePath', 'relative_path')
  const absolutePath = readMediaString(raw, 'absolutePath', 'absolute_path')
  const byteSize = typeof raw.byteSize === 'number' && Number.isFinite(raw.byteSize) ? raw.byteSize : undefined
  const width = typeof raw.width === 'number' && Number.isFinite(raw.width) ? raw.width : undefined
  const height = typeof raw.height === 'number' && Number.isFinite(raw.height) ? raw.height : undefined
  const normalized: GeneratedFileReference = {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(byteSize ? { byteSize } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(path ? { path } : {}),
    ...(relativePath ? { relativePath } : {}),
    ...(absolutePath ? { absolutePath } : {})
  }
  return Object.keys(normalized).length > 0 ? normalized : null
}

function metaGeneratedFileReferences(meta: Record<string, unknown> | undefined): GeneratedFileReference[] {
  const value = meta?.generatedFiles
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => normalizeGeneratedFileReference(entry))
    .filter((entry): entry is GeneratedFileReference => entry !== null)
}

function mediaKey(media: TimelineMediaReference): string {
  return (
    media.id ||
    media.absolutePath ||
    media.relativePath ||
    media.path ||
    media.previewUrl ||
    media.name ||
    'media'
  )
}

export function generatedFilePreviewCacheKey(
  media: GeneratedFileReference,
  workspaceRoot?: string,
  activeThreadId?: string | null
): string {
  return [activeThreadId?.trim() ?? '', workspaceRoot?.trim() ?? '', mediaKey(media)].join('\u0000')
}

export function generatedFileActionFailureMessage(
  result: { ok: boolean; message?: string } | null | undefined,
  fallback: string
): string | null {
  if (result?.ok) return null
  return result?.message?.trim() || fallback
}

function mediaName(media: TimelineMediaReference, fallback = media.id || 'file'): string {
  const path = media.relativePath || media.path || media.absolutePath || ''
  const fromPath = path.split(/[\\/]/).filter(Boolean).at(-1)
  return media.name || fromPath || fallback
}

function mediaPath(media: TimelineMediaReference): string | undefined {
  return media.relativePath || media.path || media.absolutePath
}

function mediaMime(media: TimelineMediaReference): string {
  return media.mimeType?.toLowerCase() ?? ''
}

function mediaIsImage(media: TimelineMediaReference): boolean {
  const mimeType = mediaMime(media)
  if (mimeType.startsWith('image/')) return true
  return /\.(?:png|jpe?g|webp|gif|bmp|svg)$/i.test(mediaName(media))
}

function mediaIsVideo(media: TimelineMediaReference): boolean {
  const mimeType = mediaMime(media)
  if (mimeType.startsWith('video/')) return true
  return /\.(?:mp4|webm|mov|m4v|ogg)$/i.test(mediaName(media))
}

function formatByteSize(byteSize: number | undefined): string {
  if (typeof byteSize !== 'number' || !Number.isFinite(byteSize) || byteSize <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = byteSize
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

function dataUrlPayload(dataUrl: string | undefined): { dataBase64: string; mimeType?: string } | null {
  if (!dataUrl?.startsWith('data:')) return null
  const match = dataUrl.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/)
  if (!match?.[2]) return null
  return {
    dataBase64: match[2],
    ...(match[1] ? { mimeType: match[1] } : {})
  }
}

function mergeMediaReferences(
  attachments: AttachmentReference[],
  generatedFiles: GeneratedFileReference[]
): TimelineMediaReference[] {
  const media: TimelineMediaReference[] = []
  const indexByKey = new Map<string, number>()
  const indexByName = new Map<string, number>()

  const add = (entry: TimelineMediaReference, allowNameMerge: boolean): void => {
    const key = mediaKey(entry)
    const normalizedName = mediaName(entry).toLowerCase()
    const existingIndex = indexByKey.get(key) ?? (allowNameMerge ? indexByName.get(normalizedName) : undefined)
    if (existingIndex !== undefined) {
      media[existingIndex] = { ...media[existingIndex], ...entry }
      indexByKey.set(mediaKey(media[existingIndex]), existingIndex)
      indexByName.set(mediaName(media[existingIndex]).toLowerCase(), existingIndex)
      return
    }
    indexByKey.set(key, media.length)
    indexByName.set(normalizedName, media.length)
    media.push(entry)
  }

  for (const file of generatedFiles) add(file, false)
  for (const attachment of attachments) add(attachment, true)
  return media
}

type MediaPreviewRequest =
  | { key: string; id: string; mode: 'attachment' }
  | { key: string; path: string; workspaceRoot?: string; mode: 'workspace-image' }

function isMediaPreviewRequest(entry: MediaPreviewRequest | null): entry is MediaPreviewRequest {
  return entry !== null
}

function useMediaPreviewUrls(
  media: TimelineMediaReference[],
  workspaceRootOverride?: string,
  activeThreadIdOverride?: string | null
): Record<string, string> {
  const globalActiveThreadId = useChatStore((s) => s.activeThreadId)
  const activeThreadId = activeThreadIdOverride || globalActiveThreadId
  const globalWorkspaceRoot = useChatStore((s) => s.workspaceRoot)
  const artifactWorkspaceRoot = workspaceRootOverride?.trim() || globalWorkspaceRoot
  const [resolvedPreviewUrls, setResolvedPreviewUrls] = useState<Record<string, string>>({})
  const [failedPreviewIds, setFailedPreviewIds] = useState<Record<string, true>>({})
  const previewRequests = useMemo(
    () =>
      media
        .map((item) => {
          const key = generatedFilePreviewCacheKey(item, artifactWorkspaceRoot, activeThreadId)
          if (item.previewUrl || resolvedPreviewUrls[key] || failedPreviewIds[key]) return null
          if (item.id && (mediaIsImage(item) || mediaIsVideo(item) || !item.mimeType)) {
            return { key, id: item.id, mode: 'attachment' } satisfies MediaPreviewRequest
          }
          const path = mediaIsImage(item) ? mediaPath(item) : undefined
          if (path && artifactWorkspaceRoot) {
            return {
              key,
              path,
              workspaceRoot: resolveGeneratedFileWorkspaceRoot(artifactWorkspaceRoot),
              mode: 'workspace-image'
            } satisfies MediaPreviewRequest
          }
          return null
        })
        .filter(isMediaPreviewRequest),
    [activeThreadId, artifactWorkspaceRoot, failedPreviewIds, media, resolvedPreviewUrls]
  )
  const missingPreviewKey = previewRequests
    .map((request) =>
      request.mode === 'attachment'
        ? `attachment:${request.key}:${request.id}`
        : `workspace-image:${request.key}:${request.path}`
    )
    .join('\n')

  useEffect(() => {
    if (!missingPreviewKey) return
    const provider = getProvider()
    let cancelled = false
    void Promise.all(
      previewRequests.map(async (request) => {
        try {
          if (request.mode === 'attachment' && request.id && typeof provider.getAttachmentContent === 'function') {
            const content = await provider.getAttachmentContent(request.id, {
              ...(activeThreadId ? { threadId: activeThreadId } : {}),
              ...(artifactWorkspaceRoot ? { workspace: artifactWorkspaceRoot } : {})
            })
            const previewUrl = safeMediaPreviewUrl(
              `data:${content.attachment.mimeType};base64,${content.dataBase64}`
            )
            return previewUrl
              ? { key: request.key, previewUrl }
              : { key: request.key, failed: true as const }
          }
          if (request.mode === 'workspace-image' && request.path && typeof window.workwise?.readWorkspaceImage === 'function') {
            const result = await window.workwise.readWorkspaceImage({
              path: request.path,
              ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {})
            })
            if (result.ok) return { key: request.key, previewUrl: result.dataUrl }
          }
          return { key: request.key, failed: true as const }
        } catch {
          return { key: request.key, failed: true as const }
        }
      })
    ).then((results) => {
      if (cancelled) return
      setResolvedPreviewUrls((current) => {
        const next = { ...current }
        for (const result of results) {
          if ('previewUrl' in result && typeof result.previewUrl === 'string') {
            next[result.key] = result.previewUrl
          }
        }
        return next
      })
      setFailedPreviewIds((current) => {
        const next = { ...current }
        for (const result of results) {
          if ('failed' in result) next[result.key] = true
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [activeThreadId, artifactWorkspaceRoot, missingPreviewKey, previewRequests])

  return resolvedPreviewUrls
}

function MediaPreviewTile({
  media,
  previewUrl,
  variant,
  workspaceRoot: workspaceRootOverride
}: {
  media: TimelineMediaReference
  previewUrl?: string
  variant: 'user' | 'tool' | 'conversation'
  workspaceRoot?: string
}): ReactElement {
  const { t } = useTranslation('common')
  const globalWorkspaceRoot = useChatStore((s) => s.workspaceRoot)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [actionError, setActionError] = useState<string | null>(null)
  const title = mediaName(media, variant === 'user' ? t('composerAttachmentUnnamed') : undefined)
  const filePath = mediaPath(media)
  const owningWorkspaceRoot = resolveGeneratedFileWorkspaceRoot(
    workspaceRootOverride?.trim() || globalWorkspaceRoot
  )
  const mimeType = media.mimeType || (mediaIsImage(media) ? 'image' : mediaIsVideo(media) ? 'video' : '')
  const byteSize = formatByteSize(media.byteSize)
  const fileType = (() => {
    const extension = title.match(/\.([a-z0-9]{1,8})$/i)?.[1]
    return extension ? extension.toUpperCase() : mimeType
  })()
  const hasRichPreview = !!previewUrl && (mediaIsImage(media) || mediaIsVideo(media))
  const tileClass =
    variant === 'conversation'
      ? hasRichPreview
        ? 'h-72 w-full overflow-hidden rounded-lg border border-ds-border-muted bg-ds-card shadow-sm sm:h-80'
        : 'min-h-44 w-full overflow-hidden rounded-lg border border-ds-border-muted bg-ds-card shadow-sm'
      : variant === 'tool'
        ? 'block h-32 w-40 overflow-hidden rounded-lg border border-ds-border-muted bg-ds-card shadow-sm'
        : 'block h-28 w-36 min-w-0 max-w-full overflow-hidden rounded-lg border border-ds-border-muted bg-ds-card shadow-sm'
  const mediaClass = 'h-full w-full object-contain'
  const canSave = Boolean(filePath || dataUrlPayload(previewUrl))
  const saveLabel =
    saveState === 'saving'
      ? t('generatedFileSaving')
      : saveState === 'saved'
        ? t('generatedFileSaved')
        : saveState === 'error'
          ? t('generatedFileSaveFailed')
          : t('generatedFileDownload')
  const handleSaveAs = async (): Promise<void> => {
    if (saveState === 'saving') return
    if (typeof window.workwise?.saveWorkspaceFileAs !== 'function') {
      setActionError(t('generatedFileBridgeUnavailable'))
      return
    }
    const data = dataUrlPayload(previewUrl)
    const canUsePath = Boolean(filePath && owningWorkspaceRoot)
    if (!canUsePath && !data) {
      setSaveState('error')
      setActionError(filePath ? t('generatedFileWorkspaceUnavailable') : t('generatedFileNoData'))
      return
    }
    setActionError(null)
    setSaveState('saving')
    try {
      const result = await saveGeneratedWorkspaceFileAs({
        suggestedName: title,
        ...(canUsePath && filePath ? { sourcePath: filePath } : {}),
        ...(canUsePath && owningWorkspaceRoot ? { workspaceRoot: owningWorkspaceRoot } : {}),
        ...(media.mimeType || data?.mimeType ? { mimeType: media.mimeType ?? data?.mimeType } : {}),
        ...(data && !canUsePath ? { dataBase64: data.dataBase64 } : {})
      })
      if (result.ok) {
        setActionError(null)
        setSaveState('saved')
        window.setTimeout(() => setSaveState('idle'), 1600)
      } else if (result.canceled) {
        setSaveState('idle')
      } else {
        setSaveState('error')
        setActionError(result.message?.trim() || t('generatedFileSaveFailed'))
      }
    } catch (error) {
      setSaveState('error')
      setActionError(error instanceof Error ? error.message : String(error))
      void window.workwise?.logError?.('file-save-as', 'Failed to save generated file', {
        message: error instanceof Error ? error.message : String(error),
        filePath,
        title
      }).catch(() => undefined)
    }
  }
  const handleOpenInEditor = async (): Promise<void> => {
    if (!filePath) return
    if (!owningWorkspaceRoot) {
      setActionError(t('generatedFileWorkspaceUnavailable'))
      return
    }
    setActionError(null)
    const result = await openGeneratedWorkspaceFile({
      path: filePath,
      workspaceRoot: owningWorkspaceRoot
    })
    const message = generatedFileActionFailureMessage(result, t('generatedFileOpenFailed'))
    if (message) setActionError(message)
  }
  const handleReveal = async (): Promise<void> => {
    if (!filePath) return
    if (!owningWorkspaceRoot) {
      setActionError(t('generatedFileWorkspaceUnavailable'))
      return
    }
    setActionError(null)
    const result = await revealGeneratedWorkspaceFile({
      path: filePath,
      workspaceRoot: owningWorkspaceRoot
    })
    const message = generatedFileActionFailureMessage(result, t('generatedFileRevealFailed'))
    if (message) setActionError(message)
  }
  const saveButtonClass =
    'inline-flex h-7 items-center justify-center rounded-md border border-ds-border-muted bg-ds-card/90 px-2 text-[11.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-50'
  const iconButtonClass =
    'absolute right-2 top-2 inline-flex h-8 w-8 items-center justify-center rounded-md border border-ds-border-muted bg-ds-card/92 text-ds-muted shadow-sm backdrop-blur transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-50'
  const saveIcon = saveState === 'saving'
    ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.9} />
    : saveState === 'saved'
      ? <Check className="h-3.5 w-3.5" strokeWidth={2} />
      : <Download className="h-3.5 w-3.5" strokeWidth={1.9} />

  if (previewUrl && mediaIsImage(media)) {
    return (
      <figure className={`${tileClass} relative`} title={title}>
        <img src={previewUrl} alt={title} className={mediaClass} loading="lazy" />
        <button
          type="button"
          onClick={() => void handleSaveAs()}
          disabled={!canSave || saveState === 'saving'}
          title={saveLabel}
          aria-label={saveLabel}
          className={iconButtonClass}
        >
          {saveIcon}
        </button>
        {actionError ? (
          <figcaption className="absolute inset-x-2 bottom-2 rounded-md bg-red-950/85 px-2 py-1 text-[11px] text-white" role="alert">
            {t('generatedFileActionFailed', { message: actionError })}
          </figcaption>
        ) : null}
      </figure>
    )
  }

  if (previewUrl && mediaIsVideo(media)) {
    return (
      <figure className={`${tileClass} relative`} title={title}>
        <video src={previewUrl} className={mediaClass} controls preload="metadata" />
        <button
          type="button"
          onClick={() => void handleSaveAs()}
          disabled={!canSave || saveState === 'saving'}
          title={saveLabel}
          aria-label={saveLabel}
          className={iconButtonClass}
        >
          {saveIcon}
        </button>
        {actionError ? (
          <figcaption className="absolute inset-x-2 bottom-2 rounded-md bg-red-950/85 px-2 py-1 text-[11px] text-white" role="alert">
            {t('generatedFileActionFailed', { message: actionError })}
          </figcaption>
        ) : null}
      </figure>
    )
  }

  const Icon = mediaIsVideo(media) ? Video : mediaIsImage(media) ? ImageIcon : File
  if (variant === 'user' && !filePath) {
    return (
      <div className="w-64 min-w-0 max-w-full rounded-[10px] border border-ds-border-muted bg-ds-card px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-ds-subtle text-ds-muted" aria-hidden>
            <Icon className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold leading-5 text-ds-ink">
              <AttachmentFileName name={title} />
            </div>
            {byteSize ? <div className="truncate text-xs leading-4 text-ds-muted">{byteSize}</div> : null}
          </div>
          {canSave ? (
            <button type="button" onClick={() => void handleSaveAs()} disabled={saveState === 'saving'} title={saveLabel} aria-label={saveLabel} className={`${saveButtonClass} shrink-0`}>
              {saveIcon}
            </button>
          ) : null}
        </div>
        {actionError ? <p role="alert" className="mt-1 break-words text-xs text-ds-muted">{t('generatedFileActionFailed', { message: actionError })}</p> : null}
      </div>
    )
  }
  return (
    <div className={`${tileClass} flex flex-col justify-between p-3`} title={title}>
      <div className="flex min-w-0 items-start gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ds-border-muted bg-ds-subtle text-ds-muted">
          <Icon className="h-4 w-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <div className="line-clamp-2 break-words text-[12.5px] font-semibold leading-5 text-ds-ink">
            {title}
          </div>
          <div className="mt-0.5 break-words text-[11px] leading-4 text-ds-faint" title={mimeType || undefined}>
            {[fileType, byteSize].filter(Boolean).join(' · ') || t('generatedFilePreviewUnavailable')}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleSaveAs()}
          disabled={!canSave || saveState === 'saving'}
          className={saveButtonClass}
          title={saveLabel}
        >
          <span className="mr-1.5">{saveIcon}</span>
          {t('generatedFileDownload')}
        </button>
      {filePath ? (
        <>
          <button
            type="button"
            onClick={() => void handleOpenInEditor()}
            className={saveButtonClass}
          >
            {t('generatedFileOpen')}
          </button>
          <button
            type="button"
            onClick={() => void handleReveal()}
            className={saveButtonClass}
          >
            <FolderSearch className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.9} />
            {t('generatedFileReveal')}
          </button>
        </>
      ) : null}
      </div>
      {actionError ? (
        <div className="mt-2 break-words text-[11px] leading-4 text-red-600 dark:text-red-400" role="alert">
          {t('generatedFileActionFailed', { message: actionError })}
        </div>
      ) : null}
    </div>
  )
}

function MediaAttachmentGallery({
  media,
  variant,
  workspaceRoot,
  activeThreadId
}: {
  media: TimelineMediaReference[]
  variant: 'user' | 'tool' | 'conversation'
  workspaceRoot?: string
  activeThreadId?: string | null
}): ReactElement | null {
  const globalActiveThreadId = useChatStore((s) => s.activeThreadId)
  const globalWorkspaceRoot = useChatStore((s) => s.workspaceRoot)
  const resolvedThreadId = activeThreadId || globalActiveThreadId
  const resolvedWorkspaceRoot = workspaceRoot?.trim() || globalWorkspaceRoot
  const resolvedPreviewUrls = useMediaPreviewUrls(media, resolvedWorkspaceRoot, resolvedThreadId)
  if (media.length === 0) return null
  const wrapperClass =
    variant === 'conversation'
      ? `grid w-full max-w-2xl grid-cols-1 gap-2 ${media.length > 1 ? 'sm:grid-cols-2' : ''}`
      : variant === 'tool'
        ? 'flex min-w-0 flex-wrap gap-2 border-t border-ds-border-muted/60 px-4 py-3'
        : 'flex min-w-0 max-w-[min(100%,36rem)] flex-wrap justify-end gap-2'

  return (
    <div className={wrapperClass}>
      {media.map((item) => {
        const key = mediaKey(item)
        return (
          <MediaPreviewTile
            key={key}
            media={item}
            previewUrl={item.previewUrl ?? resolvedPreviewUrls[
              generatedFilePreviewCacheKey(item, resolvedWorkspaceRoot, resolvedThreadId)
            ]}
            variant={variant}
            workspaceRoot={resolvedWorkspaceRoot}
          />
        )
      })}
    </div>
  )
}

export function GeneratedFilesPanel({
  blocks,
  workspaceRoot,
  activeThreadId,
  professionalSurface = false
}: {
  blocks: ToolBlock[]
  workspaceRoot?: string
  activeThreadId?: string | null
  professionalSurface?: boolean
}): ReactElement | null {
  const { t } = useTranslation('common')
  const media = useMemo(
    () =>
      blocks.flatMap((block) =>
        mergeMediaReferences(
          metaAttachmentReferences(block.meta as RuntimeDisclosureMetadata | undefined),
          metaGeneratedFileReferences(block.meta)
        )
      ),
    [blocks]
  )

  // Generated files expose runtime paths, MIME types and tool-produced
  // artifacts. Survey users should only see professional deliverables in the
  // dedicated delivery view, never this developer conversation panel.
  if (professionalSurface || media.length === 0) return null

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="text-[12px] font-semibold text-ds-faint">{t('generatedFilesTitle')}</div>
      <MediaAttachmentGallery
        media={media}
        variant="conversation"
        workspaceRoot={workspaceRoot}
        activeThreadId={activeThreadId}
      />
    </div>
  )
}

function UserAttachmentPreviews({
  meta
}: {
  meta?: RuntimeDisclosureMetadata
}): ReactElement | null {
  const attachments = useMemo(() => {
    const attachmentIds = metaStringArray(meta, 'attachmentIds')
    const byId = new Map<string, AttachmentReference>()
    for (const attachment of metaAttachmentReferences(meta)) {
      byId.set(attachment.id, attachment)
    }
    for (const id of attachmentIds) {
      if (!byId.has(id)) byId.set(id, { id })
    }
    return [...byId.values()]
  }, [meta])

  if (attachments.length === 0) return null

  return (
    <div className="mb-2 flex min-w-0 justify-end">
      <MediaAttachmentGallery media={attachments} variant="user" />
    </div>
  )
}

function ToolAttachmentPreviews({
  meta
}: {
  meta?: Record<string, unknown>
}): ReactElement | null {
  const attachments = useMemo(
    () => metaAttachmentReferences(meta as RuntimeDisclosureMetadata | undefined),
    [meta]
  )

  if (attachments.length === 0) return null

  return <MediaAttachmentGallery media={attachments} variant="tool" />
}

function RuntimeMetaChips({
  meta,
  align = 'left',
  hideAttachments = false,
  professionalSurface = false
}: {
  meta?: Record<string, unknown>
  align?: 'left' | 'right'
  hideAttachments?: boolean
  professionalSurface?: boolean
}): ReactElement | null {
  const { t } = useTranslation('common')
  const attachmentIds = metaStringArray(meta, 'attachmentIds')
  const activeSkillIds = professionalSurface ? [] : metaStringArray(meta, 'activeSkillIds')
  const injectedMemoryIds = professionalSurface ? [] : metaStringArray(meta, 'injectedMemoryIds')
  const child = meta?.child && typeof meta.child === 'object' ? meta.child as Record<string, unknown> : null
  const childLabel =
    !professionalSurface && typeof child?.childLabel === 'string' && child.childLabel.trim()
      ? child.childLabel.trim()
      : ''
  if (
    (hideAttachments || attachmentIds.length === 0) &&
    activeSkillIds.length === 0 &&
    injectedMemoryIds.length === 0 &&
    !childLabel
  ) {
    return null
  }
  const chipClass = 'inline-flex max-w-full items-center gap-1 rounded-md border border-ds-border-muted bg-ds-card/75 px-1.5 py-0.5 text-[11px] font-medium text-ds-faint'
  return (
    <div className={`mt-2 flex min-w-0 flex-wrap gap-1.5 ${align === 'right' ? 'justify-end' : ''}`}>
      {!hideAttachments && attachmentIds.length > 0 ? (
        <span className={chipClass} title={attachmentIds.join(', ')}>
          {t('toolAttachments')} {attachmentIds.length}
        </span>
      ) : null}
      {activeSkillIds.length > 0 ? (
        <span className={chipClass}>
          {t('toolActiveSkills')} {activeSkillIds.length}
        </span>
      ) : null}
      {injectedMemoryIds.length > 0 ? (
        <span className={chipClass} title={injectedMemoryIds.join(', ')}>
          {t('toolInjectedMemories')} {injectedMemoryIds.length}
        </span>
      ) : null}
      {childLabel ? (
        <span className={chipClass} title={childLabel}>
          {t('toolChildAgent')} <span className="max-w-28 truncate font-mono text-ds-muted">{childLabel}</span>
        </span>
      ) : null}
    </div>
  )
}

function CopyFeedbackButton({
  text,
  iconOnly = false
}: {
  text: string
  iconOnly?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const resetRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetRef.current !== null) window.clearTimeout(resetRef.current)
    },
    []
  )

  const scheduleReset = (): void => {
    if (resetRef.current !== null) window.clearTimeout(resetRef.current)
    resetRef.current = window.setTimeout(() => {
      setStatus('idle')
      resetRef.current = null
    }, COPY_FEEDBACK_RESET_MS)
  }

  const handleCopy = async (): Promise<void> => {
    try {
      if (!navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setStatus('success')
    } catch {
      setStatus('error')
    }
    scheduleReset()
  }

  const success = status === 'success'
  const error = status === 'error'
  const label = success ? t('copySuccess') : error ? t('copyFailed') : t('copyMessage')
  const iconClassName = iconOnly ? 'h-4 w-4' : 'h-3.5 w-3.5'

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      title={label}
      aria-label={label}
      className={`flex shrink-0 items-center rounded-md transition ${
        iconOnly
          ? 'gap-0 p-1 hover:bg-ds-hover'
          : 'gap-1 px-1.5 py-0.5 hover:bg-ds-hover'
      } ${
        success
          ? 'text-emerald-500'
          : error
            ? 'text-rose-400'
            : 'text-ds-faint hover:text-ds-muted'
      }`}
    >
      {success ? (
        <Check className={iconClassName} strokeWidth={2} />
      ) : (
        <Copy className={iconClassName} strokeWidth={1.8} />
      )}
      {!iconOnly ? <span>{label}</span> : null}
    </button>
  )
}

function UserInputBubble({
  block,
  nested = false,
  replyInComposer = false,
  taskPausedQuestion = false
}: {
  block: Extract<ChatBlock, { kind: 'user_input' }>
  nested?: boolean
  replyInComposer?: boolean
  taskPausedQuestion?: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const resolveUserInput = useChatStore((s) => s.resolveUserInput)
  const [answers, setAnswers] = useState<Record<string, UserInputAnswer>>(() =>
    answersByQuestionId(block.answers)
  )
  const pending = block.status === 'pending'
  const done = block.status !== 'pending'

  useEffect(() => {
    setAnswers(answersByQuestionId(block.answers))
  }, [block.id, block.answers])

  const chooseOption = (question: UserInputQuestion, label: string, value = label): void => {
    setAnswers((prev) => ({
      ...prev,
      [question.id]: { id: question.id, label, value }
    }))
  }

  const canSubmit = block.questions.every((question) => {
    const answer = answers[question.id]
    if (!answer) return false
    if (question.options.length === 0 || answer.label === USER_INPUT_OTHER_LABEL) {
      return answer.value.trim().length > 0
    }
    return true
  })

  const submit = (): void => {
    if (!canSubmit || !pending) return
    const ordered = block.questions.map((question) => answers[question.id]).filter(Boolean)
    void resolveUserInput(block.id, { kind: 'submit', answers: ordered })
  }

  const cancel = (): void => {
    if (!pending) return
    void resolveUserInput(block.id, { kind: 'cancel' })
  }

  if (taskPausedQuestion && pending && block.questions[0]) {
    return <div role="status" className="min-w-0 rounded-xl border border-ds-border-muted bg-ds-subtle px-3 py-2 text-ds-ink">
      <p className="break-words text-[13px] font-medium">{block.questions[0].question}</p>
      <p className="text-xs text-ds-muted">{t('taskQuestionPausedReplyHint')}</p>
    </div>
  }

  if (replyInComposer && pending && block.questions[0]) {
    return <div className="flex min-w-0 flex-wrap items-start gap-2 px-1 py-1.5 text-ds-ink">
      <div className="min-w-0 flex-1 break-words">
        <p className="text-[13px] font-medium">{block.questions[0].question}</p>
        <p className="text-xs text-ds-muted">{t('userInputReplyInComposer')}</p>
      </div>
      <button type="button" className="rounded-md border border-ds-border px-2.5 py-1 text-xs hover:bg-ds-hover" onClick={cancel}>{t('userInputCancel')}</button>
    </div>
  }

  const statusLabel =
    block.status === 'submitted'
      ? t('userInputSubmitted')
      : block.status === 'cancelled'
        ? t('userInputCancelled')
        : block.status === 'error'
          ? t('userInputFailed')
          : t('userInputPending')
  const tone =
    block.status === 'error'
      ? 'error'
      : block.status === 'submitted'
        ? 'success'
        : block.status === 'cancelled'
          ? 'muted'
          : 'active'
  const questionCount = block.questions.length
  const containerClass = nested
    ? `overflow-hidden rounded-[14px] border px-3.5 py-3 text-[13px] leading-5 shadow-[0_8px_22px_rgba(15,23,42,0.035)] ${
        tone === 'error'
          ? 'border-red-300/65 bg-ds-card/88 dark:border-red-800/55 dark:bg-red-950/20'
          : tone === 'success'
            ? 'border-emerald-500/22 bg-ds-card/88 dark:border-emerald-600/30 dark:bg-ds-card/82'
            : tone === 'muted'
              ? 'border-ds-border-muted bg-ds-card/78'
              : 'border-accent/22 bg-ds-card/90'
      }`
    : `overflow-hidden rounded-[16px] border px-4 py-4 text-[13px] leading-6 shadow-[0_14px_36px_rgba(15,23,42,0.055)] ${
        tone === 'error'
          ? 'border-red-300/70 bg-ds-card/90 dark:border-red-800/60 dark:bg-red-950/20'
          : tone === 'success'
            ? 'border-emerald-500/24 bg-ds-card/90 dark:border-emerald-600/32 dark:bg-ds-card/84'
            : tone === 'muted'
              ? 'border-ds-border bg-ds-card/82'
              : 'border-accent/24 bg-ds-card/95 text-ds-ink'
      }`
  const iconFrameClass =
    tone === 'error'
      ? 'border-red-300/60 bg-red-500/10 text-red-700 dark:border-red-800/45 dark:text-red-300'
      : tone === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : tone === 'active'
          ? 'border-accent/20 bg-accent/10 text-accent'
          : 'border-ds-border-muted bg-ds-subtle text-ds-muted'
  const statusClass =
    tone === 'error'
      ? 'text-red-700 dark:text-red-300'
      : tone === 'success'
        ? 'text-emerald-700 dark:text-emerald-300'
        : tone === 'active'
          ? 'text-accent'
          : 'text-ds-muted'
  const statusIcon =
    tone === 'active' ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
    ) : tone === 'success' ? (
      <Check className="h-3.5 w-3.5" strokeWidth={2} />
    ) : tone === 'error' ? (
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current text-[10px] font-bold leading-none">
        !
      </span>
    ) : (
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
    )

  return (
    <div className={containerClass}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border ${iconFrameClass}`}
          >
            {statusIcon}
          </span>
          <div className="min-w-0 pt-0.5">
            <div className="font-semibold text-ds-ink">{t('userInputTitle')}</div>
            <div className={`mt-0.5 text-[12px] font-medium ${statusClass}`}>{statusLabel}</div>
          </div>
        </div>
        {questionCount > 1 ? (
          <span className="shrink-0 rounded-full border border-ds-border-muted bg-ds-subtle px-2 py-0.5 text-[11.5px] font-medium text-ds-muted">
            {questionCount}
          </span>
        ) : null}
      </div>

      <div className={nested ? 'mt-3 flex flex-col gap-2.5' : 'mt-3.5 flex flex-col gap-3'}>
        {block.questions.map((question, index) => {
          const answer = answers[question.id]
          const hasOptions = question.options.length > 0
          const otherSelected = answer?.label === USER_INPUT_OTHER_LABEL
          const submittedAnswer = done ? (answer?.value || answer?.label || '') : ''
          const showProgress = questionCount > 1
          const showHeader =
            typeof question.header === 'string' &&
            question.header.trim().length > 0 &&
            !(questionCount === 1 && question.header.trim().toLowerCase() === 'input')
          return (
            <div
              key={question.id}
              className={`min-w-0 rounded-[12px] border px-3 py-3 ${
                submittedAnswer
                  ? 'border-ds-border-muted bg-ds-main/35'
                  : 'border-ds-border-muted bg-ds-main/45'
              }`}
            >
              {showHeader || showProgress ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    {showHeader ? (
                      <div className="min-w-0 text-[12px] font-semibold text-ds-muted">
                        {question.header}
                      </div>
                    ) : null}
                  </div>
                  {showProgress ? (
                    <div className="rounded-full bg-ds-card/70 px-2 py-0.5 text-[11.5px] font-medium text-ds-faint">
                      {t('userInputQuestionProgress', {
                        current: index + 1,
                        total: block.questions.length
                      })}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <p
                className={`whitespace-pre-wrap break-words text-[14px] font-semibold leading-6 text-ds-ink [overflow-wrap:anywhere] ${
                  showHeader || showProgress ? 'mt-2' : ''
                }`}
              >
                {question.question}
              </p>

              {submittedAnswer ? (
                <div className="mt-3 flex min-w-0 items-start gap-2 rounded-[10px] border border-emerald-500/14 bg-ds-card/78 px-3 py-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                    <Check className="h-3.5 w-3.5" strokeWidth={2.1} />
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[13.5px] font-medium leading-5 text-ds-ink [overflow-wrap:anywhere]">
                    {submittedAnswer}
                  </span>
                </div>
              ) : done ? (
                <div className="mt-3 rounded-[10px] border border-ds-border-muted bg-ds-card/70 px-3 py-2 text-[12.5px] font-medium text-ds-muted">
                  {statusLabel}
                </div>
              ) : hasOptions ? (
                <div className="mt-3 grid gap-2">
                  {question.options.map((option) => {
                    const selected = answer?.label === option.label && answer.value === option.label
                    return (
                      <button
                        key={option.label}
                        type="button"
                        disabled={done}
                        onClick={() => chooseOption(question, option.label)}
                        className={`group flex min-w-0 gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition disabled:cursor-default ${
                          selected
                            ? 'border-accent/35 bg-accent/10 text-ds-ink ring-1 ring-accent/10'
                            : 'border-ds-border-muted bg-ds-card/78 text-ds-muted hover:border-ds-border hover:bg-ds-card hover:text-ds-ink'
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition ${
                            selected
                              ? 'border-accent bg-accent/10'
                              : 'border-ds-border bg-transparent group-hover:border-ds-muted'
                          }`}
                        >
                          {selected ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
                        </span>
                        <span className="min-w-0">
                          <span className="block break-words text-[13px] font-semibold [overflow-wrap:anywhere]">
                            {option.label}
                          </span>
                          {option.description ? (
                            <span className="mt-0.5 block break-words text-[12px] leading-5 text-ds-faint [overflow-wrap:anywhere]">
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    disabled={done}
                    onClick={() =>
                      chooseOption(
                        question,
                        USER_INPUT_OTHER_LABEL,
                        answer?.label === USER_INPUT_OTHER_LABEL ? answer.value : ''
                      )
                    }
                    className={`group flex min-w-0 gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition disabled:cursor-default ${
                      otherSelected
                        ? 'border-accent/35 bg-accent/10 text-ds-ink ring-1 ring-accent/10'
                        : 'border-ds-border-muted bg-ds-card/78 text-ds-muted hover:border-ds-border hover:bg-ds-card hover:text-ds-ink'
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition ${
                        otherSelected
                          ? 'border-accent bg-accent/10'
                          : 'border-ds-border bg-transparent group-hover:border-ds-muted'
                      }`}
                    >
                      {otherSelected ? <span className="h-2 w-2 rounded-full bg-accent" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold">{t('userInputOther')}</span>
                      <span className="mt-0.5 block text-[12px] leading-5 text-ds-faint">
                        {t('userInputOtherDescription')}
                      </span>
                    </span>
                  </button>
                  {otherSelected ? (
                    <textarea
                      rows={2}
                      disabled={done}
                      value={answer?.value ?? ''}
                      onChange={(e) =>
                        chooseOption(question, USER_INPUT_OTHER_LABEL, e.target.value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          submit()
                        }
                      }}
                      placeholder={t('userInputCustomPlaceholder')}
                      className="min-h-20 resize-y rounded-[10px] border border-ds-border-muted bg-ds-card/90 px-3 py-2 text-[13px] leading-5 text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent/45 focus:ring-2 focus:ring-accent/10 disabled:cursor-default disabled:opacity-80"
                    />
                  ) : null}
                </div>
              ) : (
                <div className="mt-3">
                  <textarea
                    rows={3}
                    disabled={done}
                    value={answer?.value ?? ''}
                    onChange={(e) =>
                      chooseOption(question, USER_INPUT_FREEFORM_LABEL, e.target.value)
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        submit()
                      }
                      }}
                      placeholder={t('userInputCustomPlaceholder')}
                    className="min-h-24 w-full resize-y rounded-[10px] border border-ds-border-muted bg-ds-card/90 px-3 py-2.5 text-[13px] leading-5 text-ds-ink outline-none transition placeholder:text-ds-faint focus:border-accent/45 focus:ring-2 focus:ring-accent/10 disabled:cursor-default disabled:opacity-80"
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {block.errorMessage ? (
        <p className="mt-3 text-[12px] text-red-700 dark:text-red-300">{block.errorMessage}</p>
      ) : null}

      {pending ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-ds-border-muted pt-3">
          <button
            type="button"
            disabled={!canSubmit}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-[9px] bg-ds-ink px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 dark:text-black"
            onClick={submit}
          >
            <Check className="h-3.5 w-3.5" strokeWidth={2} />
            {t('userInputSubmit')}
          </button>
          <button
            type="button"
            className="min-h-8 rounded-[9px] border border-ds-border-muted bg-ds-card/80 px-3 py-1.5 text-[13px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
            onClick={cancel}
          >
            {t('userInputCancel')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function answersByQuestionId(
  answers: UserInputAnswer[] | undefined
): Record<string, UserInputAnswer> {
  const out: Record<string, UserInputAnswer> = {}
  for (const answer of answers ?? []) {
    out[answer.id] = answer
  }
  return out
}

function formatMessageDateTime(input: string, locale: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function MessageBubble({ block, nested = false, professionalSurface = false, language, replyInComposer = false, taskPausedQuestion = false, sources }: { block: ChatBlock; nested?: boolean; professionalSurface?: boolean; language?: string; replyInComposer?: boolean; taskPausedQuestion?: boolean; sources?: ConversationSource[] }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const hideRuntimeBlock = professionalSurface && block.kind !== 'assistant' && block.kind !== 'user'
  // The professional conversation surface renders assistant answers and user
  // questions only. Runtime blocks are intentionally omitted here so a direct
  // caller cannot accidentally leak tool names, paths, session IDs, approval
  // payloads, or system codes into a Survey workflow.
  const dshUiProjection = useMemo(() => {
    if (block.kind !== 'assistant') return null
    const streaming = block.id === 'live-assistant'
    return projectDshUiText(block.text, {
      settled: !streaming,
      ...(streaming
        ? {}
        : {
            persistedBlockIds: (block.uiBlocks ?? [])
              .flatMap((candidate) => candidate && typeof candidate === 'object' && 'id' in candidate
                ? [String(candidate.id)]
                : [])
          })
    })
  }, [block])
  if (hideRuntimeBlock) return <></>
  if (block.kind === 'user') {
    return <UserMessageBubble block={block} professionalSurface={professionalSurface} language={language ?? i18n.language} />
  }
  if (block.kind === 'assistant') {
    const streaming = block.id === 'live-assistant'
    const uiBlocks = professionalSurface ? undefined : streaming ? dshUiProjection?.blocks : block.uiBlocks
    const displayedText = professionalSurface
      ? engineeringProfessionalAnswerText(block.text, i18n.language)
      : dshUiProjection?.markdown ?? block.text
    const createdAtLabel = block.createdAt
      ? formatMessageDateTime(block.createdAt, i18n.language)
      : null
    return (
      <div className="group/message flex min-w-0 max-w-full flex-col">
        <div className="ds-markdown ds-chat-answer min-w-0 max-w-full text-ds-ink">
          {!streaming && block.capabilityCard ? <CapabilityRequiredCard card={block.capabilityCard} /> : !streaming && block.intentCard ? <TaskIntentChoiceCard card={block.intentCard} message={displayedText} /> : <AssistantMarkdown text={displayedText} streaming={streaming} />}
          {uiBlocks?.length ? (
            <DshUiBlocks
              blocks={uiBlocks}
              threadId={streaming ? null : activeThreadId}
              messageId={block.id}
            />
          ) : null}
          {!professionalSurface && sources?.length ? <ConversationSources sources={sources} /> : null}
          {!professionalSurface && dshUiProjection?.diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.code}:${diagnostic.blockId ?? index}`} role="status" className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              {t(`dshUiDiagnostic_${diagnostic.code}`, { blockId: diagnostic.blockId ?? '' })}
            </div>
          ))}
        </div>
        {!streaming ? (
          <div className="mt-1 flex min-h-5 min-w-0 items-center justify-between gap-3 text-[11.5px] text-ds-faint opacity-0 transition duration-150 group-hover/message:opacity-100">
            <span className="min-w-0 truncate">{createdAtLabel ?? ''}</span>
            <CopyFeedbackButton text={displayedText} />
          </div>
        ) : null}
      </div>
    )
  }
  if (block.kind === 'reasoning') {
    return (
      <div className="ds-card-soft rounded-[20px] px-4 py-3 text-[13.5px] leading-6 text-ds-muted">
        <div className="ds-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
        </div>
      </div>
    )
  }
  if (block.kind === 'tool') {
    return <ToolEntry key={block.id} block={block} />
  }
  if (block.kind === 'user_input') {
    return <UserInputBubble block={block} nested={nested} replyInComposer={replyInComposer} taskPausedQuestion={taskPausedQuestion} />
  }
  if (block.kind === 'approval') {
    return <ApprovalBubble block={block} />
  }
  if (block.kind === 'compaction') {
    return (
      <div className="ds-card-soft rounded-[18px] px-3 py-2 text-[13.5px] text-ds-muted">
        {block.detail || block.summary}
      </div>
    )
  }
  if (block.kind === 'review') {
    return (
      <div className="ds-card-soft rounded-[18px] px-3 py-2 text-[13.5px] text-ds-muted">
        {block.reviewText || block.title}
      </div>
    )
  }
  if (block.kind === 'system') {
    const errorTone = block.severity === 'error'
    const warningTone = block.severity === 'warning'
    return (
      <div
        className={`rounded-[18px] border px-3 py-2 text-[13.5px] leading-6 ${
          errorTone
            ? 'border-red-300/80 bg-red-500/10 text-red-800 dark:border-red-800/60 dark:bg-red-950/35 dark:text-red-200'
            : warningTone
              ? 'border-amber-300/80 bg-amber-500/10 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/35 dark:text-amber-100'
              : 'border-ds-border bg-ds-subtle text-ds-muted'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{block.text}</p>
        <TechnicalDetails detail={[block.code, block.detail].filter(Boolean).map(value => redactRuntimeText(value!)).join('\n\n')} />
      </div>
    )
  }
  return <></>
}

const approvalLabels = {
  pending: 'approvalPending', allowed: 'approvalAllowed', denied: 'approvalDenied',
  expired: 'approvalExpired', error: 'approvalFailed'
} as const

function ApprovalBubble({ block }: { block: Extract<ChatBlock, { kind: 'approval' }> }): ReactElement {
  const { t } = useTranslation('common')
  const resolveApproval = useChatStore(state => state.resolveApproval)
  const runtimeConnection = useChatStore(state => state.runtimeConnection)
  const inFlight = useRef(false)
  const [submitting, setSubmitting] = useState(false)
  const submit = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (inFlight.current || runtimeConnection !== 'ready' || block.status !== 'pending') return
    inFlight.current = true
    setSubmitting(true)
    try { await resolveApproval(block.id, decision) } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }
  return (
    <div
      data-approval-id={block.approvalId}
      data-request-hash={block.requestHash}
      className="min-w-0 rounded-2xl border border-ds-border bg-ds-card px-4 py-3 text-ds-ink"
    >
      <div className="text-[13px] font-semibold">{t('approvalTitle')}</div>
      <ApprovalOperationDetails summary={block.summary} toolName={block.toolName} />
      {block.errorMessage ? <p role="status" className="mt-2 text-xs text-ds-muted">{block.errorMessage}</p> : null}
      {block.status === 'pending' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" disabled={submitting || runtimeConnection !== 'ready'}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            onClick={() => void submit('allow')}>{t('approvalAllow')}</button>
          <button type="button" disabled={submitting || runtimeConnection !== 'ready'}
            className="rounded-lg border border-ds-border px-3 py-1.5 text-xs font-medium hover:bg-ds-hover disabled:opacity-50"
            onClick={() => void submit('deny')}>{t('approvalDeny')}</button>
          {submitting ? <span role="status" className="text-xs text-ds-muted">{t('approvalSubmitting')}</span> : null}
        </div>
      ) : <p className="mt-2 text-xs text-ds-muted">{t(approvalLabels[block.status])}</p>}
    </div>
  )
}

function ToolEntry({ block }: { block: ToolBlock }): ReactElement {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)

  const Icon = block.toolKind === 'file_change' ? FileEdit : block.toolKind === 'command_execution' ? Terminal : Wrench
  const kindLabel =
    block.toolKind === 'file_change'
      ? t('toolKindFile')
      : block.toolKind === 'command_execution'
        ? t('toolKindCommand')
        : t('toolKindTool')

  const exitCode = readNumber(block.meta, 'exit_code')
  const durationMs = readNumber(block.meta, 'duration_ms')
  const detail = open && block.detail ? redactRuntimeText(block.detail) : undefined
  const filePath = open && block.filePath ? redactRuntimeText(block.filePath) : undefined
  const patchText = block.toolKind === 'file_change' ? extractUnifiedDiffText(detail) : undefined
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="min-w-0 text-ds-muted">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-fit max-w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13.5px] hover:bg-ds-hover/45"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 opacity-75" strokeWidth={1.75} />
        <span>{kindLabel}</span>
        <Chevron className="h-3.5 w-3.5 shrink-0 opacity-45" strokeWidth={1.75} />
      </button>
      <RuntimeMetaChips meta={block.meta} />
      <ToolAttachmentPreviews meta={block.meta} />
      {open ? (
        <div className="ds-work-timeline-detail min-w-0 text-[13.5px]">
          <div className="mb-1 flex flex-wrap gap-x-2 text-[12px]">
            {block.status === 'running' ? <span>{t('inspectorStatusRunning')}</span> : null}
            {block.status === 'error' ? <span>{t('taskReceiptStatus_failed')}</span> : null}
            {typeof exitCode === 'number' ? <span className="font-mono">exit {exitCode}</span> : null}
            {typeof durationMs === 'number' ? <span>{formatDuration(durationMs)}</span> : null}
          </div>
          {filePath ? <p className="break-all font-mono text-[12px]">{filePath}</p> : null}
          <p className="whitespace-pre-wrap break-words">{redactRuntimeText(block.summary)}</p>
          {patchText !== undefined ? (
            <DiffView patch={patchText} filePath={filePath} />
          ) : detail ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-6">
              {detail}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
