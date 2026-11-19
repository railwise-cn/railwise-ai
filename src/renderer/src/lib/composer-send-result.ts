import type { AttachmentReference } from '../agent/types'
import { isChatDocumentAttachment } from './attachment-selection'

export function emptyComposerMessage(
  attachments: readonly AttachmentReference[],
  workspaceReferenceCount: number,
  t: (key: string, options?: { count: number }) => string
): { prompt: string; display: string } {
  const hasDocument = attachments.some(item =>
    (item.kind && item.kind !== 'image') ||
    (item.name && isChatDocumentAttachment({ name: item.name })) ||
    item.mimeType === 'application/pdf'
  )
  if (hasDocument) {
    return {
      prompt: t(workspaceReferenceCount ? 'composerDocumentsAndReferencesPrompt' : 'composerDocumentsOnlyPrompt'),
      display: t('composerDocumentsOnlyDisplay', { count: attachments.length })
    }
  }
  if (workspaceReferenceCount) {
    const key = attachments.length ? 'composerFileAndImageOnly' : 'composerFileOnly'
    return { prompt: t(`${key}Prompt`), display: t(`${key}Display`, { count: workspaceReferenceCount }) }
  }
  return { prompt: t('composerImageOnlyPrompt'), display: t('composerImageOnlyDisplay') }
}

export type ComposerDraftClearActions = {
  clearInput: () => void
  clearAttachments: () => void
  clearFileReferences: () => void
  clearCapabilities?: () => void
}

export function clearComposerDraftAfterSuccessfulSend(
  sent: boolean,
  actions: ComposerDraftClearActions
): boolean {
  if (!sent) return false
  actions.clearInput()
  actions.clearAttachments()
  actions.clearFileReferences()
  actions.clearCapabilities?.()
  return true
}
