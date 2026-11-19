export const MAX_COMPOSER_ATTACHMENTS = 8

export function isChatDocumentAttachment(file: Pick<File, 'name'>): boolean {
  return /\.(?:pdf|docx|xlsx|pptx|txt|md|markdown|csv)$/i.test(file.name)
}

export function attachmentImportErrorKey(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/password_required|password.required|password.protected/i.test(detail)) return 'composerAttachmentPasswordRequired'
  if (/PDF signature is invalid|invalid.document|InvalidPDFException|malformed PDF/i.test(detail)) return 'composerAttachmentInvalidDocument'
  if (/attachment original path unavailable|ENOENT|not a regular file/i.test(detail)) return 'composerAttachmentSourceUnavailable'
  return 'composerAttachmentImportFailed'
}

export function selectFilesForAvailableAttachmentSlots<T>(
  files: readonly T[],
  currentAttachmentCount: number
): T[] {
  const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - Math.max(0, currentAttachmentCount))
  return files.slice(0, available)
}
