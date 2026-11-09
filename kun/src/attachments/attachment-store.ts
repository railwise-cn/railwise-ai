import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { AttachmentsCapabilityConfig } from '../contracts/capabilities.js'
import type { AttachmentDiagnostics, AttachmentKind, AttachmentMetadata, AttachmentMetadataV2, AttachmentSectionV1, AttachmentTextFallback } from '../contracts/attachments.js'
import { ATTACHMENT_LIMITS_V2, AttachmentMetadata as AttachmentMetadataSchema, AttachmentMetadataV1, AttachmentMetadataV2 as AttachmentMetadataV2Schema, upgradeAttachmentMetadataV1 } from '../contracts/attachments.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { withFileMutationQueue } from '../adapters/tool/file-mutation-queue.js'
import { AttachmentIndex, type AttachmentSearchResult } from './attachment-index.js'
import JSZip from 'jszip'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const ATTACHMENT_ID_PATTERN = /^att_[a-f0-9]{24}$/

export type AttachmentContent = AttachmentMetadata & {
  data: Buffer
}

export interface AttachmentStore {
  create(input: {
    name: string
    data: Buffer
    mimeType?: string
    textFallback?: AttachmentTextFallback
    threadId?: string
    workspace?: string
  }): Promise<AttachmentMetadata>
  get(id: string): Promise<AttachmentMetadata | null>
  getV2(id: string): Promise<AttachmentMetadataV2 | null>
  resolveMetadataV2(id: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentMetadataV2>
  grantTaskReference?(id:string,source:{threadId:string;workspace:string},target:{threadId:string;workspace:string}):Promise<void>
  createDocument(input: {
    name: string
    data: Buffer
    mimeType: string
    kind: Exclude<AttachmentKind, 'image'>
    threadId?: string
    workspace?: string
  }): Promise<AttachmentMetadataV2>
  updateV2(id: string, update: Partial<Pick<AttachmentMetadataV2,
    'state' | 'parser' | 'sourceStructure' | 'degradationReasons' | 'parserWarnings' | 'indexState' | 'summary' | 'progress'>>): Promise<AttachmentMetadataV2>
  replaceSections(id: string, sections: AttachmentSectionV1[]): Promise<void>
  appendSections(id: string, sections: AttachmentSectionV1[]): Promise<void>
  listSections(id: string, scope: { threadId?: string; workspace?: string }, offset?: number, limit?: number): Promise<AttachmentSectionV1[]>
  readSection(id: string, sectionId: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentSectionV1 | null>
  searchSections(id: string, query: string, scope: { threadId?: string; workspace?: string }, limit?: number): Promise<AttachmentSearchResult[]>
  releaseReferences(input: { threadId?: string; workspace?: string }): Promise<number>
  cleanupAbandoned(now?: Date): Promise<number>
  resolveContent(id: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentContent>
  textFallbackPolicy(): Pick<
    AttachmentsCapabilityConfig,
    'textFallbackMaxBase64Bytes' | 'textFallbackMaxImageDimension' | 'textFallbackPreferredMimeType'
  >
  diagnostics(): Promise<AttachmentDiagnostics>
}

export class FileAttachmentStore implements AttachmentStore {
  private index?: AttachmentIndex
  constructor(
    private readonly options: {
      rootDir: string
      config: AttachmentsCapabilityConfig
      nowIso?: () => string
    }
  ) {}

  async create(input: {
    name: string
    data: Buffer
    mimeType?: string
    textFallback?: AttachmentTextFallback
    threadId?: string
    workspace?: string
  }): Promise<AttachmentMetadata> {
    await mkdir(this.options.rootDir, { recursive: true })
    const image = detectImage(input.data)
    if (!image) throw new Error('unsupported image MIME type')
    if (input.mimeType && input.mimeType !== image.mimeType) throw new Error('declared MIME type does not match image content')
    if (!this.options.config.allowedMimeTypes.includes(image.mimeType)) throw new Error(`image MIME type is not allowed: ${image.mimeType}`)
    const maxImageBytes = Math.min(this.options.config.maxImageBytes, MAX_ATTACHMENT_BYTES)
    if (input.data.byteLength > maxImageBytes) throw new Error(`image exceeds ${maxImageBytes} byte limit`)
    const maxDimension = Math.max(image.width ?? 0, image.height ?? 0)
    if (maxDimension > this.options.config.maxImageDimension) {
      throw new Error(`image exceeds ${this.options.config.maxImageDimension}px dimension limit`)
    }
    if (input.textFallback) validateTextFallback(input.textFallback, this.options.config)
    const workspace = input.workspace ? await canonicalWorkspace(input.workspace) : undefined
    const threadId = input.threadId?.trim() || undefined
    if (!threadId && !workspace) throw new Error('attachment requires a thread or workspace scope')
    const scopedInput = { threadId, workspace }
    const hash = createHash('sha256')
      .update(input.data)
      .update('\0')
      .update(workspace ?? '')
      .update('\0')
      .update(threadId ?? '')
      .digest('hex')
    const id = `att_${hash.slice(0, 24)}`
    const contentPath = this.contentPath(id)
    const metadataPath = this.metadataPath(id)
    const now = this.options.nowIso?.() ?? new Date().toISOString()
    const existing = await this.get(id)
    if (existing) {
      const next = mergeScope({
        ...existing,
        ...(input.textFallback ? { textFallback: input.textFallback } : {}),
        updatedAt: now
      }, scopedInput)
      await atomicWriteFile(contentPath, input.data)
      await atomicWriteFile(metadataPath, JSON.stringify(next, null, 2))
      return next
    }
    const metadata: AttachmentMetadata = AttachmentMetadataSchema.parse(mergeScope({
      id,
      name: input.name,
      mimeType: image.mimeType,
      byteSize: input.data.byteLength,
      hash,
      ...(image.width ? { width: image.width } : {}),
      ...(image.height ? { height: image.height } : {}),
      ...(input.textFallback ? { textFallback: input.textFallback } : {}),
      threadIds: [],
      workspaces: [],
      createdAt: now,
      updatedAt: now
    }, scopedInput))
    await atomicWriteFile(contentPath, input.data)
    await atomicWriteFile(metadataPath, JSON.stringify(metadata, null, 2))
    return metadata
  }

  async get(id: string): Promise<AttachmentMetadata | null> {
    try {
      const value = JSON.parse(await readFile(this.metadataPath(id), 'utf8'))
      const v2 = AttachmentMetadataV2Schema.safeParse(value)
      if (v2.success) return v2.data
      return AttachmentMetadataSchema.parse(value)
    } catch {
      return null
    }
  }

  async getV2(id: string): Promise<AttachmentMetadataV2 | null> {
    try {
      const value = JSON.parse(await readFile(this.metadataPath(id), 'utf8'))
      const v2 = AttachmentMetadataV2Schema.safeParse(value)
      if (v2.success) return v2.data
      const v1 = AttachmentMetadataV1.safeParse(value)
      if (!v1.success) return null
      const upgraded = upgradeAttachmentMetadataV1(v1.data)
      await atomicWriteFile(this.metadataPath(id), JSON.stringify(upgraded, null, 2))
      return upgraded
    } catch {
      return null
    }
  }

  async createDocument(input: {
    name: string
    data: Buffer
    mimeType: string
    kind: Exclude<AttachmentKind, 'image'>
    threadId?: string
    workspace?: string
  }): Promise<AttachmentMetadataV2> {
    await mkdir(this.options.rootDir, { recursive: true })
    if (input.data.byteLength > ATTACHMENT_LIMITS_V2.maxFileBytes) throw new Error('document exceeds 200 MiB limit')
    await validateDocumentBytes(input.name, input.mimeType, input.kind, input.data)
    const workspace = input.workspace ? await canonicalWorkspace(input.workspace) : undefined
    const threadId = input.threadId?.trim() || undefined
    if (!threadId && !workspace) throw new Error('attachment requires a thread or workspace scope')
    const hash = createHash('sha256').update(input.data).digest('hex')
    const id = `att_${hash.slice(0, 24)}`
    const now = this.options.nowIso?.() ?? new Date().toISOString()
    const existing = await this.getV2(id)
    if (existing) {
      const next = mergeScopeV2({ ...existing, updatedAt: now }, { threadId, workspace })
      await atomicWriteFile(this.metadataPath(id), JSON.stringify(next, null, 2))
      return next
    }
    const metadata = AttachmentMetadataV2Schema.parse(mergeScopeV2({
      schemaVersion: 2,
      id, name: input.name, originalFileName: input.name, mimeType: input.mimeType,
      byteSize: input.data.byteLength, hash, kind: input.kind, state: 'parsing',
      degradationReasons: [], parserWarnings: [], indexState: 'pending', progress: 0,
      managedRelativePath: `${id}${extname(input.name).toLowerCase()}`,
      threadIds: [], workspaces: [], createdAt: now, updatedAt: now
    }, { threadId, workspace }))
    await atomicWriteFile(this.contentPath(id), input.data)
    await atomicWriteFile(this.metadataPath(id), JSON.stringify(metadata, null, 2))
    return metadata
  }

  async updateV2(id: string, update: Partial<Pick<AttachmentMetadataV2,
    'state' | 'parser' | 'sourceStructure' | 'degradationReasons' | 'parserWarnings' | 'indexState' | 'summary' | 'progress'>>): Promise<AttachmentMetadataV2> {
    const current = await this.getV2(id)
    if (!current) throw new Error(`attachment not found: ${id}`)
    const next = AttachmentMetadataV2Schema.parse({
      ...current, ...update, updatedAt: this.options.nowIso?.() ?? new Date().toISOString()
    })
    await atomicWriteFile(this.metadataPath(id), JSON.stringify(next, null, 2))
    return next
  }

  async replaceSections(id: string, sections: AttachmentSectionV1[]): Promise<void> {
    if (!await this.getV2(id)) throw new Error(`attachment not found: ${id}`)
    await this.getIndex().replace(id, sections)
  }
  async appendSections(id: string, sections: AttachmentSectionV1[]): Promise<void> { if (!await this.getV2(id)) throw new Error(`attachment not found: ${id}`); this.getIndex().append(id, sections) }

  async listSections(id: string, scope: { threadId?: string; workspace?: string }, offset = 0, limit = 20): Promise<AttachmentSectionV1[]> {
    await this.authorizeV2(id, scope)
    return this.getIndex().list(id, offset, limit)
  }

  async readSection(id: string, sectionId: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentSectionV1 | null> {
    await this.authorizeV2(id, scope)
    const section = this.getIndex().read(id, sectionId)
    if (!section) return null
    return { ...section, text: section.text.slice(0, ATTACHMENT_LIMITS_V2.maxSectionCharacters) }
  }

  async searchSections(id: string, query: string, scope: { threadId?: string; workspace?: string }, limit = 8): Promise<AttachmentSearchResult[]> {
    await this.authorizeV2(id, scope)
    return this.getIndex().search(id, query, limit).map((section) => ({
      ...section, text: section.text.slice(0, ATTACHMENT_LIMITS_V2.maxSectionCharacters)
    }))
  }

  async releaseReferences(input: { threadId?: string; workspace?: string }): Promise<number> {
    await mkdir(this.options.rootDir, { recursive: true })
    let released = 0
    for (const entry of (await readdir(this.options.rootDir)).filter((name) => name.endsWith('.json'))) {
      const id = entry.slice(0, -5)
      const metadata = await this.getV2(id)
      if (!metadata) continue
      const threadIds = input.threadId ? metadata.threadIds.filter((value) => value !== input.threadId) : metadata.threadIds
      const workspaces = input.workspace ? metadata.workspaces.filter((value) => value !== input.workspace) : metadata.workspaces
      if (threadIds.length === metadata.threadIds.length && workspaces.length === metadata.workspaces.length) continue
      released += 1
      if (threadIds.length === 0 && workspaces.length === 0) {
        await this.remove(id)
      } else {
        await atomicWriteFile(this.metadataPath(id), JSON.stringify({ ...metadata, threadIds, workspaces }, null, 2))
      }
    }
    return released
  }

  async cleanupAbandoned(now = new Date()): Promise<number> {
    await mkdir(this.options.rootDir, { recursive: true })
    let removed = 0
    for (const entry of (await readdir(this.options.rootDir)).filter((name) => name.endsWith('.json'))) {
      const id = entry.slice(0, -5)
      const metadata = await this.getV2(id)
      if (!metadata || metadata.threadIds.length || metadata.workspaces.length) continue
      if (!['uploading', 'parsing', 'failed', 'cancelled'].includes(metadata.state)) continue
      if (now.getTime() - new Date(metadata.updatedAt).getTime() < ATTACHMENT_LIMITS_V2.abandonedImportMaxAgeMs) continue
      await this.remove(id)
      removed += 1
    }
    return removed
  }

  async resolveContent(id: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentContent> {
    const metadata = await this.get(id)
    if (!metadata) throw new Error(`attachment not found: ${id}`)
    const canonicalScope = {
      threadId: scope.threadId?.trim() || undefined,
      workspace: scope.workspace ? await canonicalWorkspace(scope.workspace) : undefined
    }
    if (!isAuthorized(metadata, canonicalScope)) throw new Error(`attachment is not authorized for this turn: ${id}`)
    return {
      ...metadata,
      data: await readFile(this.contentPath(id))
    }
  }

  async resolveMetadataV2(id: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentMetadataV2> {
    return this.authorizeV2(id, scope)
  }

  /** Explicitly selected inputs may be shared with a worker in the same workspace. */
  async grantTaskReference(id:string,source:{threadId:string;workspace:string},target:{threadId:string;workspace:string}):Promise<void> {
    await withFileMutationQueue(this.metadataPath(id),async()=>{
    const metadata=await this.authorizeV2(id,source)
    const workspace=await canonicalWorkspace(target.workspace)
    if(workspace !== await canonicalWorkspace(source.workspace)) throw new Error('attachment cannot be shared across project workspaces')
    await atomicWriteFile(this.metadataPath(id),JSON.stringify(mergeScopeV2({...metadata,updatedAt:this.options.nowIso?.() ?? new Date().toISOString()},{threadId:target.threadId,workspace}),null,2))
    })
  }

  async diagnostics(): Promise<AttachmentDiagnostics> {
    await mkdir(this.options.rootDir, { recursive: true })
    const entries = await readdir(this.options.rootDir).catch(() => [])
    const metadata = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => readFile(join(this.options.rootDir, entry), 'utf8')
          .then((text) => AttachmentMetadataSchema.parse(JSON.parse(text)))
          .catch(() => null))
    )
    const records = metadata.filter((record): record is AttachmentMetadata => Boolean(record))
    return {
      enabled: this.options.config.enabled,
      rootDir: this.options.rootDir,
      count: records.length,
      totalBytes: records.reduce((total, record) => total + record.byteSize, 0)
    }
  }

  textFallbackPolicy(): Pick<
    AttachmentsCapabilityConfig,
    'textFallbackMaxBase64Bytes' | 'textFallbackMaxImageDimension' | 'textFallbackPreferredMimeType'
  > {
    return {
      textFallbackMaxBase64Bytes: this.options.config.textFallbackMaxBase64Bytes,
      textFallbackMaxImageDimension: this.options.config.textFallbackMaxImageDimension,
      textFallbackPreferredMimeType: this.options.config.textFallbackPreferredMimeType
    }
  }

  private contentPath(id: string): string {
    if (!ATTACHMENT_ID_PATTERN.test(id)) throw new Error('invalid attachment id')
    return join(this.options.rootDir, `${id}.bin`)
  }

  private metadataPath(id: string): string {
    if (!ATTACHMENT_ID_PATTERN.test(id)) throw new Error('invalid attachment id')
    return join(this.options.rootDir, `${id}.json`)
  }

  private getIndex(): AttachmentIndex {
    this.index ??= new AttachmentIndex(join(this.options.rootDir, 'sections.sqlite'))
    return this.index
  }

  private async authorizeV2(id: string, scope: { threadId?: string; workspace?: string }): Promise<AttachmentMetadataV2> {
    const metadata = await this.getV2(id)
    if (!metadata) throw new Error(`attachment not found: ${id}`)
    const canonicalScope = {
      threadId: scope.threadId?.trim() || undefined,
      workspace: scope.workspace ? await canonicalWorkspace(scope.workspace) : undefined
    }
    if (!isAuthorized(metadata, canonicalScope)) throw new Error(`attachment is not authorized for this turn: ${id}`)
    return metadata
  }

  private async remove(id: string): Promise<void> {
    this.index?.remove(id)
    await Promise.all([rm(this.contentPath(id), { force: true }), rm(this.metadataPath(id), { force: true })])
  }
}

function mergeScopeV2(metadata: AttachmentMetadataV2, input: { threadId?: string; workspace?: string }): AttachmentMetadataV2 {
  return { ...metadata, threadIds: mergeUnique(metadata.threadIds, input.threadId), workspaces: mergeUnique(metadata.workspaces, input.workspace) }
}

function mergeScope<T extends AttachmentMetadata>(metadata: T, input: { threadId?: string; workspace?: string }): T {
  return {
    ...metadata,
    threadIds: mergeUnique(metadata.threadIds, input.threadId),
    workspaces: mergeUnique(metadata.workspaces, input.workspace)
  }
}

function mergeUnique(values: string[], value: string | undefined): string[] {
  return value && !values.includes(value) ? [...values, value] : values
}

function isAuthorized(metadata: AttachmentMetadata, scope: { threadId?: string; workspace?: string }): boolean {
  if (metadata.threadIds.length === 0 && metadata.workspaces.length === 0) return false
  if (metadata.threadIds.length > 0 && (!scope.threadId || !metadata.threadIds.includes(scope.threadId))) return false
  if (metadata.workspaces.length > 0 && (!scope.workspace || !metadata.workspaces.includes(scope.workspace))) return false
  return true
}

async function canonicalWorkspace(workspace: string): Promise<string> {
  const canonical = await realpath(resolve(workspace))
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function validateTextFallback(fallback: AttachmentTextFallback, config: AttachmentsCapabilityConfig): void {
  if (!config.allowedMimeTypes.includes(fallback.mimeType)) {
    throw new Error(`fallback image MIME type is not allowed: ${fallback.mimeType}`)
  }
  if (Buffer.byteLength(fallback.dataBase64, 'utf8') > config.textFallbackMaxBase64Bytes) {
    throw new Error(`fallback image exceeds ${config.textFallbackMaxBase64Bytes} base64 byte limit`)
  }
  const maxDimension = Math.max(fallback.width ?? 0, fallback.height ?? 0)
  if (maxDimension > config.textFallbackMaxImageDimension) {
    throw new Error(`fallback image exceeds ${config.textFallbackMaxImageDimension}px dimension limit`)
  }
}

async function validateDocumentBytes(name: string, mimeType: string, kind: Exclude<AttachmentKind, 'image'>, data: Buffer): Promise<void> {
  const expected: Record<typeof kind, { extensions: string[]; mimeTypes: string[] }> = {
    pdf: { extensions: ['.pdf'], mimeTypes: ['application/pdf'] },
    docx: { extensions: ['.docx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
    xlsx: { extensions: ['.xlsx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
    pptx: { extensions: ['.pptx'], mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
    text: { extensions: ['.txt'], mimeTypes: ['text/plain'] },
    markdown: { extensions: ['.md', '.markdown'], mimeTypes: ['text/markdown', 'text/plain'] },
    csv: { extensions: ['.csv'], mimeTypes: ['text/csv', 'text/plain'] }
  }
  const rule = expected[kind]
  if (!rule.extensions.includes(extname(name).toLowerCase())) throw new Error('document extension does not match kind')
  if (!rule.mimeTypes.includes(mimeType.toLowerCase())) throw new Error('document MIME does not match kind')
  if (kind === 'pdf' && data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('invalid PDF signature')
  if (['docx', 'xlsx', 'pptx'].includes(kind)) {
    if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) throw new Error('invalid Office ZIP signature')
    const archive = await JSZip.loadAsync(data, { checkCRC32: true })
    if (!archive.file('[Content_Types].xml')) throw new Error('invalid Office package structure')
    const prefix = kind === 'docx' ? 'word/' : kind === 'xlsx' ? 'xl/' : 'ppt/'
    if (!Object.keys(archive.files).some((entry) => entry.startsWith(prefix))) throw new Error(`invalid ${kind.toUpperCase()} package structure`)
    let expanded = 0
    for (const entry of Object.values(archive.files)) {
      if (entry.dir) continue
      const bytes = await entry.async('uint8array')
      expanded += bytes.byteLength
      if (expanded > 512 * 1024 * 1024) throw new Error('Office archive expansion exceeds 512 MiB')
    }
  }
  if (['text', 'markdown', 'csv'].includes(kind) && data.subarray(0, 4096).includes(0)) throw new Error('text attachment contains binary data')
}

export function detectImage(buffer: Buffer): { mimeType: string; width?: number; height?: number } | null {
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mimeType: 'image/png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg' }
  }
  if (
    buffer.length >= 10 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return {
      mimeType: 'image/gif',
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8)
    }
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp' }
  }
  return null
}
