import { ATTACHMENT_LIMITS_V2, AttachmentDocumentImportHeadersV1, AttachmentParserProvenance, AttachmentSectionV1, AttachmentSourceStructure, AttachmentUploadRequest } from '../../contracts/attachments.js'
import { z } from 'zod'
import type { AttachmentStore } from '../../attachments/attachment-store.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { ERRORS } from './runtime-error.js'
import { RUNTIME_RESOURCE_LIMITS_V1 } from '../../contracts/resource-limits.js'

export async function uploadAttachment(
  store: AttachmentStore | undefined,
  request: Request
): Promise<JsonResponse | Response> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const body = await readJsonBody(request, RUNTIME_RESOURCE_LIMITS_V1.attachmentRequestBodyBytes)
  if (!body.ok) return body.response
  const parsed = AttachmentUploadRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.attachmentValidation('invalid attachment upload body', parsed.error.issues)
  try {
    const attachment = await store.create({
      name: parsed.data.name,
      mimeType: parsed.data.mimeType,
      data: Buffer.from(parsed.data.dataBase64, 'base64'),
      textFallback: parsed.data.textFallback,
      threadId: parsed.data.threadId,
      workspace: parsed.data.workspace
    })
    return jsonResponse({ attachment }, 201)
  } catch (error) {
    return ERRORS.attachmentValidation(errorMessage(error))
  }
}

export async function importDocumentAttachment(store: AttachmentStore | undefined, request: Request): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > ATTACHMENT_LIMITS_V2.maxFileBytes) {
    return ERRORS.attachmentValidation('document exceeds 200 MiB limit')
  }
  const parsed = AttachmentDocumentImportHeadersV1.safeParse({
    name: decodeHeader(request.headers.get('x-workwise-file-name')),
    mimeType: request.headers.get('content-type'),
    kind: request.headers.get('x-workwise-attachment-kind'),
    threadId: request.headers.get('x-workwise-thread-id') ?? undefined,
    workspace: decodeHeader(request.headers.get('x-workwise-workspace')) || undefined
  })
  if (!parsed.success) return ERRORS.attachmentValidation('invalid document import headers', parsed.error.issues)
  try {
    const data = await readDocumentStream(request)
    const attachment = await store.createDocument({ ...parsed.data, data })
    return jsonResponse({ attachment }, 201)
  } catch (error) {
    return ERRORS.attachmentValidation(errorMessage(error))
  }
}

async function readDocumentStream(request: Request): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      if (request.signal.aborted) throw new Error('document import was cancelled')
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > ATTACHMENT_LIMITS_V2.maxFileBytes) {
        await reader.cancel('document exceeds 200 MiB limit')
        throw new Error('document exceeds 200 MiB limit')
      }
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks, total)
  } finally {
    reader.releaseLock()
  }
}

export async function getAttachmentMetadata(
  store: AttachmentStore | undefined,
  id: string,
  request: Request
): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const url = new URL(request.url)
  try {
    const { data: _data, ...attachment } = await store.resolveContent(id, {
      threadId: url.searchParams.get('thread_id') ?? undefined,
      workspace: url.searchParams.get('workspace') ?? undefined
    })
    return jsonResponse({ attachment })
  } catch (error) {
    const message = errorMessage(error)
    return /not authorized/i.test(message) ? ERRORS.forbidden(message) : ERRORS.notFound(message)
  }
}

export async function getAttachmentContent(
  store: AttachmentStore | undefined,
  id: string,
  request: Request
): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const url = new URL(request.url)
  try {
    const attachment = await store.resolveContent(id, {
      threadId: url.searchParams.get('thread_id') ?? undefined,
      workspace: url.searchParams.get('workspace') ?? undefined
    })
    return jsonResponse({
      attachment: {
        ...attachment,
        data: undefined
      },
      dataBase64: attachment.data.toString('base64')
    })
  } catch (error) {
    const message = errorMessage(error)
    return /not authorized/i.test(message) ? ERRORS.forbidden(message) : ERRORS.notFound(message)
  }
}

export async function attachmentDiagnostics(
  store: AttachmentStore | undefined
): Promise<JsonResponse> {
  if (!store) {
    return jsonResponse({ enabled: false, rootDir: '', count: 0, totalBytes: 0 })
  }
  return jsonResponse(await store.diagnostics())
}

export async function listAttachmentSections(store: AttachmentStore | undefined, id: string, request: Request): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const url = new URL(request.url)
  try {
    const sections = await store.listSections(id, scopeFromUrl(url), numberParam(url, 'offset', 0), numberParam(url, 'limit', 20))
    return jsonResponse({ sections, untrusted: true })
  } catch (error) { return attachmentLookupError(error) }
}

export async function readAttachmentSection(store: AttachmentStore | undefined, id: string, sectionId: string, request: Request): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  try {
    const section = await store.readSection(id, sectionId, scopeFromUrl(new URL(request.url)))
    return section ? jsonResponse({ section, untrusted: true }) : ERRORS.notFound('attachment section not found')
  } catch (error) { return attachmentLookupError(error) }
}

export async function searchAttachmentSections(store: AttachmentStore | undefined, id: string, request: Request): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const url = new URL(request.url)
  const query = (url.searchParams.get('q') ?? '').trim()
  if (!query) return ERRORS.attachmentValidation('q is required')
  try {
    const results = await store.searchSections(id, query, scopeFromUrl(url), numberParam(url, 'limit', 8))
    return jsonResponse({ results, untrusted: true })
  } catch (error) { return attachmentLookupError(error) }
}

const ParsedBatch = z.object({
  replace: z.boolean().default(false), sections: z.array(AttachmentSectionV1).max(64),
  final: z.boolean().default(false),
  metadata: z.object({ state: z.enum(['ready', 'degraded', 'failed']), parser: AttachmentParserProvenance.optional(), sourceStructure: AttachmentSourceStructure.optional(), degradationReasons: z.array(z.string()).optional(), parserWarnings: z.array(z.string()).optional(), summary: z.string().max(4000).optional() }).strict().optional()
}).strict()
export async function ingestParsedAttachmentBatch(store: AttachmentStore | undefined, id: string, request: Request): Promise<JsonResponse> {
  if (!store) return ERRORS.unavailable('attachment store is unavailable')
  const body = await readJsonBody(request, RUNTIME_RESOURCE_LIMITS_V1.jsonRequestBodyBytes); if (!body.ok) return body.response
  const parsed = ParsedBatch.safeParse(body.value); if (!parsed.success) return ERRORS.attachmentValidation('invalid parsed attachment batch', parsed.error.issues)
  try {
    if (parsed.data.replace) await store.replaceSections(id, parsed.data.sections); else await store.appendSections(id, parsed.data.sections)
    const metadata = parsed.data.metadata
    const noPdfText = parsed.data.replace && parsed.data.sections.length === 0 &&
      metadata?.state === 'degraded' && metadata.degradationReasons?.includes('no_extractable_pdf_text')
    const attachment = parsed.data.final && metadata ? await store.updateV2(id, {
      ...metadata, indexState: metadata.state === 'failed' ? 'failed' : noPdfText ? 'not_applicable' : 'ready', progress: 1
    }) : await store.getV2(id)
    return jsonResponse({ attachment })
  } catch (error) { return ERRORS.attachmentValidation(errorMessage(error)) }
}

function scopeFromUrl(url: URL): { threadId?: string; workspace?: string } {
  return {
    threadId: url.searchParams.get('thread_id') ?? undefined,
    workspace: url.searchParams.get('workspace') ?? undefined
  }
}

function numberParam(url: URL, key: string, fallback: number): number {
  const value = Number(url.searchParams.get(key))
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

function attachmentLookupError(error: unknown): JsonResponse {
  const message = errorMessage(error)
  return /not authorized/i.test(message) ? ERRORS.forbidden(message) : ERRORS.notFound(message)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decodeHeader(value: string | null): string {
  if (!value) return ''
  try { return decodeURIComponent(value) } catch { return '' }
}
