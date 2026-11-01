import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  DESIGN_DOCUMENT_LIMITS,
  normalizeDesignDocument,
  type DesignAsset,
  type DesignDocumentV1
} from '../../shared/design-document'
import type {
  DesignAssetReadResult,
  DesignDocumentListResult,
  DesignDocumentLoadResult,
  DesignDocumentSavePayload,
  DesignDocumentSaveResult,
  DesignPptxSourceStatus,
  DesignPptxRevisionMetadata,
  DesignPptxRevisionReadPayload,
  DesignPptxRevisionReadResult,
  DesignPptxRevisionSavePayload,
  DesignPptxRevisionSaveResult
} from '../../shared/design-workspace'
import {
  canonicalizeContainmentRoot,
  recheckContainedParent,
  resolveContainedPath,
  UnsafePathError
} from './canonical-containment'
import { atomicWriteFile, readRecoveredFile, recoverAtomicFile, runSerialized } from './durable-file'
import { preflightPptxForDesignImport } from './design-import-service'
import { validateAndCommitPowerPoint, validateAndCommitPowerPointBytes } from './design-export-service'

const DESIGN_DIRECTORY = '.workwise/design'
const DESIGN_INDEX_FILE = 'index.json'
const MAX_DOCUMENT_BYTES = DESIGN_DOCUMENT_LIMITS.fileBytes
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_SOURCE_PPTX_BYTES = 200 * 1024 * 1024
const MAX_REVISION_POINTER_BYTES = 4 * 1024
const MAX_SAVED_DESIGN_DOCUMENTS = 256
const SAFE_DOCUMENT_ID = /^doc_[A-Za-z0-9_-]{1,120}$/
const SAFE_ASSET_ID = /^asset_[A-Za-z0-9_-]{1,120}$/
const SAFE_ASSET_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

type PptxRevisionPointerV1 = {
  schema: 'workwise.design.pptx-revision'
  version: 1
  sha256: string
  byteSize: number
  updatedAt: number
  slideCount?: number
}

class DesignPptxRevisionError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_document' | 'corrupt' | 'invalid_pptx' | 'stale_request' | 'write_failed',
    message: string
  ) {
    super(message)
    this.name = 'DesignPptxRevisionError'
  }
}

type DesignIndexV1 = {
  schema: 'workwise.design.index'
  version: 1
  activeDocumentId: string
  activePageByDocument: Record<string, string>
  updatedAt: number
}

export type DesignImageAssetWriteInput = {
  workspaceRoot: string
  documentId: string
  originalFilename: string
  mimeType: string
  width: number
  height: number
  bytes: Uint8Array
}

function assertDocumentId(documentId: string): void {
  if (!SAFE_DOCUMENT_ID.test(documentId)) throw new UnsafePathError('Invalid Design document id.')
}

function documentRelativePath(documentId: string): string {
  assertDocumentId(documentId)
  return `${DESIGN_DIRECTORY}/${documentId}.workwise-design.json`
}

function indexRelativePath(): string {
  return `${DESIGN_DIRECTORY}/${DESIGN_INDEX_FILE}`
}

/**
 * Check the immutable PPTX copy before returning a document to the renderer.
 * A missing or changed source must not make the design document disappear: the
 * imported editable representation remains recoverable, while the UI gets a
 * precise status for re-import/repair actions.
 */
async function inspectPptxSource(
  workspaceRoot: string,
  document: DesignDocumentV1
): Promise<DesignPptxSourceStatus | undefined> {
  if (document.documentKind !== 'pptx' && !document.pptx) return undefined
  const source = document.pptx?.source
  if (
    !source?.cachedFilename ||
    !source.sha256 ||
    !/^[a-f0-9]{64}$/i.test(source.sha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes! < 1 ||
    source.bytes! > MAX_SOURCE_PPTX_BYTES
  ) {
    return { state: 'metadata_missing', message: 'This PPTX document has no complete cached source metadata.' }
  }
  let sourcePath: string
  try {
    sourcePath = await resolveContainedPath({
      root: workspaceRoot,
      target: assetRelativePath(document.id, source.cachedFilename),
      mustExist: true,
      expect: 'file',
      rejectFinalLink: true
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: 'missing',
        message: 'The cached PPTX source is missing. The imported document is still available; re-import the original file to repair it.',
        expectedSha256: source.sha256,
        expectedBytes: source.bytes
      }
    }
    return {
      state: 'corrupt',
      message: error instanceof Error ? error.message : String(error),
      expectedSha256: source.sha256,
      expectedBytes: source.bytes
    }
  }
  try {
    const info = await stat(sourcePath)
    if (!info.isFile() || info.size < 1 || info.size > MAX_SOURCE_PPTX_BYTES) {
      return {
        state: 'corrupt',
        message: 'The cached PPTX source is invalid or exceeds the 200 MiB limit.',
        expectedSha256: source.sha256,
        expectedBytes: source.bytes,
        actualBytes: info.size
      }
    }
    const bytes = await readFile(sourcePath)
    const actualSha256 = createHash('sha256').update(bytes).digest('hex')
    if (info.size !== source.bytes) {
      return {
        state: 'corrupt',
        message: `The cached PPTX size is ${info.size} bytes, expected ${source.bytes} bytes.`,
        expectedSha256: source.sha256,
        actualSha256,
        expectedBytes: source.bytes,
        actualBytes: info.size
      }
    }
    if (actualSha256 !== source.sha256 || bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      return {
        state: 'corrupt',
        message: 'The cached PPTX source failed its integrity check. Re-import the original file to repair it.',
        expectedSha256: source.sha256,
        actualSha256,
        expectedBytes: source.bytes,
        actualBytes: bytes.length
      }
    }
    return {
      state: 'available',
      expectedSha256: source.sha256,
      actualSha256,
      expectedBytes: source.bytes,
      actualBytes: bytes.length
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        state: 'missing',
        message: 'The cached PPTX source is missing. The imported document is still available; re-import the original file to repair it.',
        expectedSha256: source.sha256,
        expectedBytes: source.bytes
      }
    }
    return {
      state: 'corrupt',
      message: error instanceof Error ? error.message : String(error),
      expectedSha256: source.sha256,
      expectedBytes: source.bytes
    }
  }
}

/**
 * Source bytes are immutable for a document id. Repairs and re-imports must use
 * a fresh document id, so saving an editing revision cannot replace provenance.
 */
function hasSamePptxSource(left: DesignDocumentV1, right: DesignDocumentV1): boolean {
  const before = left.pptx?.source
  if (!before) return true
  const after = right.pptx?.source
  return Boolean(after) &&
    before.sha256 === after?.sha256 &&
    before.bytes === after?.bytes &&
    before.cachedFilename === after?.cachedFilename
}

function assetRelativePath(documentId: string, filename: string): string {
  assertDocumentId(documentId)
  if (!SAFE_ASSET_FILENAME.test(filename)) throw new UnsafePathError('Invalid Design asset filename.')
  return `${DESIGN_DIRECTORY}/assets/${documentId}/${filename}`
}

async function readBoundedJson(path: string): Promise<unknown> {
  const info = await stat(path)
  if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) {
    throw new Error('Design document is not a valid bounded file.')
  }
  const raw = await readRecoveredFile(path)
  return JSON.parse(raw)
}

function normalizeIndex(input: unknown): DesignIndexV1 | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<DesignIndexV1>
  if (
    raw.schema !== 'workwise.design.index' ||
    raw.version !== 1 ||
    typeof raw.activeDocumentId !== 'string' ||
    !SAFE_DOCUMENT_ID.test(raw.activeDocumentId) ||
    !raw.activePageByDocument ||
    typeof raw.activePageByDocument !== 'object'
  ) {
    return null
  }
  const activePageByDocument: Record<string, string> = {}
  for (const [documentId, pageId] of Object.entries(raw.activePageByDocument)) {
    if (
      SAFE_DOCUMENT_ID.test(documentId) &&
      typeof pageId === 'string' &&
      pageId.length > 0 &&
      pageId.length <= 160
    ) {
      activePageByDocument[documentId] = pageId
    }
  }
  return {
    schema: 'workwise.design.index',
    version: 1,
    activeDocumentId: raw.activeDocumentId,
    activePageByDocument,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
  }
}

async function readIndex(workspaceRoot: string): Promise<DesignIndexV1 | null> {
  const indexPath = await resolveContainedPath({
    root: workspaceRoot,
    target: indexRelativePath(),
    mustExist: false,
    expect: 'file',
    rejectFinalLink: true
  })
  try {
    return normalizeIndex(await readBoundedJson(indexPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function listDesignDocuments(
  workspaceRootInput: string
): Promise<DesignDocumentListResult> {
  try {
    const workspaceRoot = await canonicalizeContainmentRoot(workspaceRootInput)
    const designDirectory = await resolveContainedPath({
      root: workspaceRoot,
      target: DESIGN_DIRECTORY,
      mustExist: false,
      expect: 'directory',
      rejectFinalLink: true
    })
    let entries: Dirent[]
    try {
      entries = await readdir(designDirectory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true, documents: [] }
      }
      throw error
    }
    const candidates = entries
      .filter((entry) => entry.name.endsWith('.workwise-design.json'))
      .slice(0, MAX_SAVED_DESIGN_DOCUMENTS + 1)
    if (candidates.length > MAX_SAVED_DESIGN_DOCUMENTS) {
      return {
        ok: false,
        documents: [],
        code: 'read_failed',
        message: `Design workspace contains more than ${MAX_SAVED_DESIGN_DOCUMENTS} documents.`
      }
    }

    const documents: DesignDocumentListResult['documents'] = []
    const corruptDocumentIds: string[] = []
    for (const entry of candidates) {
      const documentId = entry.name.slice(0, -'.workwise-design.json'.length)
      if (!SAFE_DOCUMENT_ID.test(documentId)) continue
      if (!entry.isFile() || entry.isSymbolicLink()) {
        corruptDocumentIds.push(documentId)
        continue
      }
      try {
        const documentPath = await resolveContainedPath({
          root: workspaceRoot,
          target: documentRelativePath(documentId),
          mustExist: true,
          expect: 'file',
          rejectFinalLink: true
        })
        const document = normalizeDesignDocument(
          await readBoundedJson(documentPath) as Partial<DesignDocumentV1>
        )
        if (!document || document.id !== documentId) {
          corruptDocumentIds.push(documentId)
          continue
        }
        let nativeSummary: Pick<PptxRevisionPointerV1, 'slideCount' | 'updatedAt'> | undefined
        if (document.documentKind === 'pptx' || document.pptx) {
          const pointerPath = await resolveContainedPath({ root: workspaceRoot,
            target: revisionPointerRelativePath(document.id), mustExist: false, expect: 'file', rejectFinalLink: true })
          try {
            const info = await lstat(pointerPath)
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REVISION_POINTER_BYTES) throw new Error('Invalid native revision pointer.')
            const pointer = parseRevisionPointer(JSON.parse(await readRecoveredFile(pointerPath)))
            if (!pointer) throw new Error('Invalid native revision pointer metadata.')
            nativeSummary = pointer
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        documents.push({
          id: document.id,
          name: document.name,
          revision: document.revision,
          pageCount: nativeSummary?.slideCount ?? document.pages.length,
          updatedAt: Math.max(document.updatedAt, nativeSummary?.updatedAt ?? 0)
        })
      } catch {
        corruptDocumentIds.push(documentId)
      }
    }
    documents.sort((left, right) =>
      right.updatedAt - left.updatedAt || left.name.localeCompare(right.name)
    )
    const index = await readIndex(workspaceRoot).catch(() => null)
    return {
      ok: true,
      documents,
      ...(index?.activeDocumentId ? { activeDocumentId: index.activeDocumentId } : {}),
      ...(corruptDocumentIds.length > 0 ? { corruptDocumentIds } : {})
    }
  } catch (error) {
    return {
      ok: false,
      documents: [],
      code: error instanceof UnsafePathError ? 'unsafe_path' : 'read_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function loadDesignDocument(
  workspaceRootInput: string,
  requestedDocumentId?: string
): Promise<DesignDocumentLoadResult> {
  try {
    const workspaceRoot = await canonicalizeContainmentRoot(workspaceRootInput)
    let index: DesignIndexV1 | null = null
    let documentId = requestedDocumentId
    if (!documentId) {
      try {
        index = await readIndex(workspaceRoot)
      } catch (error) {
        return {
          ok: false,
          code: 'corrupt',
          message: error instanceof Error ? error.message : String(error)
        }
      }
      documentId = index?.activeDocumentId
    }
    if (!documentId) return { ok: false, code: 'not_found', message: 'No saved Design document.' }
    assertDocumentId(documentId)

    const documentPath = await resolveContainedPath({
      root: workspaceRoot,
      target: documentRelativePath(documentId),
      mustExist: false,
      expect: 'file',
      rejectFinalLink: true
    })
    let raw: unknown
    try {
      raw = await readBoundedJson(documentPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, code: 'not_found', message: 'Saved Design document was not found.' }
      }
      return {
        ok: false,
        code: 'corrupt',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    const document = normalizeDesignDocument(raw as Partial<DesignDocumentV1>)
    if (!document || document.id !== documentId) {
      return { ok: false, code: 'corrupt', message: 'Saved Design document is invalid.' }
    }
    if (!index) {
      try {
        index = await readIndex(workspaceRoot)
      } catch {
        index = null
      }
    }
    const indexedPageId = index?.activePageByDocument[document.id]
    const activePageId = document.pages.some((page) => page.id === indexedPageId)
      ? indexedPageId
      : document.pages[0]?.id
    const sourceStatus = await inspectPptxSource(workspaceRoot, document)
    return {
      ok: true,
      document,
      activePageId,
      revision: document.revision,
      ...(sourceStatus ? { sourceStatus } : {})
    }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof UnsafePathError ? 'unsafe_path' : 'read_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function saveDesignDocument(
  payload: DesignDocumentSavePayload
): Promise<DesignDocumentSaveResult> {
  try {
    const workspaceRoot = await canonicalizeContainmentRoot(payload.workspaceRoot)
    const normalized = normalizeDesignDocument(payload.document)
    if (
      !normalized ||
      normalized.id !== payload.document.id ||
      !normalized.pages.some((page) => page.id === payload.activePageId)
    ) {
      return { ok: false, code: 'invalid_document', message: 'Design document is invalid.' }
    }
    assertDocumentId(normalized.id)

    return runSerialized(`design-workspace:${workspaceRoot}`, async () => {
      const documentPath = await resolveContainedPath({
        root: workspaceRoot,
        target: documentRelativePath(normalized.id),
        mustExist: false,
        expect: 'file',
        rejectFinalLink: true
      })
      let current: DesignDocumentV1 | null = null
      try {
        const raw = await readBoundedJson(documentPath)
        current = normalizeDesignDocument(raw as Partial<DesignDocumentV1>)
        if (!current || current.id !== normalized.id) {
          return { ok: false, code: 'invalid_document', message: 'Existing Design document is corrupt.' }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return {
            ok: false,
            code: 'write_failed',
            message: error instanceof Error ? error.message : String(error)
          }
        }
      }

      const currentRevision = current?.revision ?? null
      if (payload.expectedRevision !== currentRevision) {
        return {
          ok: false,
          code: 'stale_request',
          currentRevision: currentRevision ?? undefined,
          message: 'Design document changed in another window.'
        }
      }
      if (current && !hasSamePptxSource(current, normalized)) {
        return {
          ok: false,
          code: 'invalid_document',
          message: 'The original PPTX source is immutable. Re-import into a new document instead of replacing source metadata.'
        }
      }

      const nextRevision = current
        ? Math.max(normalized.revision, current.revision + 1)
        : Math.max(0, normalized.revision)
      const savedDocument: DesignDocumentV1 = {
        ...normalized,
        revision: nextRevision,
        updatedAt: Date.now()
      }
      const serializedDocument = `${JSON.stringify(savedDocument, null, 2)}\n`
      if (Buffer.byteLength(serializedDocument, 'utf8') > MAX_DOCUMENT_BYTES) {
        return {
          ok: false,
          code: 'invalid_document',
          message: 'Design document exceeds the 8 MiB persisted file limit.'
        }
      }
      const index: DesignIndexV1 = {
        schema: 'workwise.design.index',
        version: 1,
        activeDocumentId: savedDocument.id,
        activePageByDocument: {
          ...((await readIndex(workspaceRoot).catch(() => null))?.activePageByDocument ?? {}),
          [savedDocument.id]: payload.activePageId
        },
        updatedAt: Date.now()
      }
      await atomicWriteFile(documentPath, serializedDocument, {
        beforeReplace: () => recheckContainedParent(workspaceRoot, documentPath)
      })
      const indexPath = await resolveContainedPath({
        root: workspaceRoot,
        target: indexRelativePath(),
        mustExist: false,
        expect: 'file',
        rejectFinalLink: true
      })
      await atomicWriteFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, {
        beforeReplace: () => recheckContainedParent(workspaceRoot, indexPath)
      })
      return { ok: true, document: savedDocument, revision: savedDocument.revision }
    })
  } catch (error) {
    return {
      ok: false,
      code: error instanceof UnsafePathError ? 'unsafe_path' : 'write_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function extensionForMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
    default: return null
  }
}

function signatureMatches(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  }
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mimeType === 'image/gif') {
    const header = Buffer.from(bytes.subarray(0, 6)).toString('ascii')
    return header === 'GIF87a' || header === 'GIF89a'
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
      Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  }
  return false
}

export async function readSafeDesignImageSource(sourcePath: string): Promise<Uint8Array> {
  const linkInfo = await lstat(sourcePath)
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile() || linkInfo.size <= 0 || linkInfo.size > MAX_IMAGE_BYTES) {
    throw new Error('Selected image must be a regular file no larger than 12 MiB.')
  }
  const canonical = await realpath(sourcePath)
  const canonicalInfo = await stat(canonical)
  if (!canonicalInfo.isFile() || canonicalInfo.size !== linkInfo.size) {
    throw new Error('Selected image changed while it was being read.')
  }
  return readFile(canonical)
}

export async function storeDesignImageAsset(
  input: DesignImageAssetWriteInput
): Promise<{ asset: DesignAsset; dataUrl: string }> {
  const workspaceRoot = await canonicalizeContainmentRoot(input.workspaceRoot)
  assertDocumentId(input.documentId)
  const extension = extensionForMimeType(input.mimeType)
  if (
    !extension ||
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0 ||
    input.width > 32_768 ||
    input.height > 32_768 ||
    input.bytes.byteLength <= 0 ||
    input.bytes.byteLength > MAX_IMAGE_BYTES ||
    !signatureMatches(input.bytes, input.mimeType)
  ) {
    throw new Error('Selected image is invalid or unsupported.')
  }
  const assetId = `asset_${randomUUID().replaceAll('-', '')}`
  if (!SAFE_ASSET_ID.test(assetId)) throw new Error('Could not create Design asset id.')
  const originalStem = input.originalFilename
    .slice(0, -extname(input.originalFilename).length || undefined)
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const filename = `${originalStem || 'image'}-${assetId.slice(-12)}.${extension}`
  const assetPath = await resolveContainedPath({
    root: workspaceRoot,
    target: assetRelativePath(input.documentId, filename),
    mustExist: false,
    expect: 'file',
    rejectFinalLink: true
  })
  await atomicWriteFile(assetPath, input.bytes, {
    beforeReplace: () => recheckContainedParent(workspaceRoot, assetPath)
  })
  const asset: DesignAsset = {
    id: assetId,
    filename,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    byteSize: input.bytes.byteLength
  }
  return {
    asset,
    dataUrl: `data:${asset.mimeType};base64,${Buffer.from(input.bytes).toString('base64')}`
  }
}

/** Store the immutable source PPTX beside the document for native re-imports. */
export async function storeDesignSourcePptx(input: {
  workspaceRoot: string
  documentId: string
  bytes: Uint8Array
}): Promise<{ filename: string; byteSize: number; sha256: string }> {
  const workspaceRoot = await canonicalizeContainmentRoot(input.workspaceRoot)
  assertDocumentId(input.documentId)
  const bytes = Buffer.from(input.bytes)
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength > MAX_SOURCE_PPTX_BYTES ||
    bytes.length < 4 ||
    bytes[0] !== 0x50 || bytes[1] !== 0x4b
  ) {
    throw new Error('Source PPTX is invalid or exceeds the 200 MiB limit.')
  }
  const filename = 'source.pptx'
  const sourcePath = await resolveContainedPath({
    root: workspaceRoot,
    target: assetRelativePath(input.documentId, filename),
    mustExist: false,
    expect: 'file',
    rejectFinalLink: true
  })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await runSerialized(`design-source:${sourcePath}`, async () => {
    try {
      const currentInfo = await lstat(sourcePath)
      if (!currentInfo.isFile() || currentInfo.isSymbolicLink() || currentInfo.size > MAX_SOURCE_PPTX_BYTES) {
        throw new Error('Existing source PPTX is not a safe regular file.')
      }
      const currentSha256 = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
      if (currentSha256 !== sha256) {
        throw new Error('Source PPTX is immutable. Re-import into a new document instead of replacing the original source.')
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await atomicWriteFile(sourcePath, bytes, {
      beforeReplace: () => recheckContainedParent(workspaceRoot, sourcePath)
    })
  })
  return {
    filename,
    byteSize: bytes.byteLength,
    sha256
  }
}

function revisionDirectoryRelativePath(documentId: string): string {
  assertDocumentId(documentId)
  return `${DESIGN_DIRECTORY}/assets/${documentId}/revisions`
}

function revisionPointerRelativePath(documentId: string): string {
  return `${revisionDirectoryRelativePath(documentId)}/current-revision.json`
}

function parseRevisionPointer(value: unknown): PptxRevisionPointerV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const pointer = value as Partial<PptxRevisionPointerV1>
  if (
    pointer.schema !== 'workwise.design.pptx-revision' ||
    pointer.version !== 1 ||
    typeof pointer.sha256 !== 'string' ||
    !SHA256_PATTERN.test(pointer.sha256) ||
    !Number.isSafeInteger(pointer.byteSize) ||
    pointer.byteSize! <= 0 ||
    pointer.byteSize! > MAX_SOURCE_PPTX_BYTES ||
    !Number.isSafeInteger(pointer.updatedAt) ||
    pointer.updatedAt! < 0
    || (pointer.slideCount !== undefined && (!Number.isSafeInteger(pointer.slideCount) || pointer.slideCount < 1 || pointer.slideCount > 500))
  ) return null
  return pointer as PptxRevisionPointerV1
}

function assertPowerPointBytes(bytes: Uint8Array): Buffer {
  const buffer = Buffer.from(bytes)
  if (
    buffer.byteLength <= 0 ||
    buffer.byteLength > MAX_SOURCE_PPTX_BYTES ||
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b
  ) {
    throw new DesignPptxRevisionError('invalid_pptx', 'PPTX bytes are invalid or exceed the 200 MiB limit.')
  }
  return buffer
}

async function requirePptxDocument(
  workspaceRoot: string,
  documentId: string
): Promise<DesignDocumentV1> {
  const loaded = await loadDesignDocument(workspaceRoot, documentId)
  if (!loaded.ok || !loaded.document) {
    throw new DesignPptxRevisionError(
      loaded.code === 'not_found' ? 'not_found' : 'corrupt',
      loaded.message ?? 'Design document could not be loaded.'
    )
  }
  if ((loaded.document.documentKind !== 'pptx' && !loaded.document.pptx) || !loaded.document.pptx) {
    throw new DesignPptxRevisionError('invalid_document', 'Native PPTX revisions are only available for PPTX documents.')
  }
  if (loaded.sourceStatus?.state !== 'available') {
    throw new DesignPptxRevisionError(
      'corrupt',
      loaded.sourceStatus?.message ?? 'The immutable source PPTX is unavailable.'
    )
  }
  return loaded.document
}

async function readCurrentPptxRevision(
  workspaceRoot: string,
  document: DesignDocumentV1,
  sourceOnly = false
): Promise<{ metadata: DesignPptxRevisionMetadata; bytes: Buffer }> {
  const source = document.pptx?.source
  if (
    !source?.cachedFilename ||
    !SAFE_ASSET_FILENAME.test(source.cachedFilename) ||
    typeof source.sha256 !== 'string' ||
    !SHA256_PATTERN.test(source.sha256) ||
    !Number.isSafeInteger(source.bytes) ||
    source.bytes! <= 0 ||
    source.bytes! > MAX_SOURCE_PPTX_BYTES
  ) {
    throw new DesignPptxRevisionError('corrupt', 'The PPTX source metadata is incomplete or invalid.')
  }

  const pointerPath = await resolveContainedPath({
    root: workspaceRoot,
    target: revisionPointerRelativePath(document.id),
    mustExist: false,
    expect: 'file',
    rejectFinalLink: true
  })
  try {
    await recheckContainedParent(workspaceRoot, pointerPath)
    await recoverAtomicFile(pointerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let pointerInfo
  try {
    pointerInfo = await lstat(pointerPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (pointerInfo && !sourceOnly) {
    if (pointerInfo.isSymbolicLink() || !pointerInfo.isFile() || pointerInfo.size > MAX_REVISION_POINTER_BYTES) {
      throw new DesignPptxRevisionError('corrupt', 'The active PPTX revision pointer is not a safe bounded file.')
    }
    let rawPointer: unknown
    try {
      rawPointer = JSON.parse(await readFile(pointerPath, 'utf8'))
    } catch (error) {
      throw new DesignPptxRevisionError(
        'corrupt',
        `The active PPTX revision pointer is invalid: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    const pointer = parseRevisionPointer(rawPointer)
    if (!pointer) throw new DesignPptxRevisionError('corrupt', 'The active PPTX revision pointer has invalid metadata.')

    const relativeRevisionPath = `${revisionDirectoryRelativePath(document.id)}/${pointer.sha256}.pptx`
    const revisionPath = await resolveContainedPath({
      root: workspaceRoot,
      target: relativeRevisionPath,
      mustExist: true,
      expect: 'file',
      rejectFinalLink: true
    })
    const revisionInfo = await lstat(revisionPath)
    if (revisionInfo.isSymbolicLink() || !revisionInfo.isFile() || revisionInfo.size !== pointer.byteSize) {
      throw new DesignPptxRevisionError('corrupt', 'The active PPTX revision is missing or has an invalid size.')
    }
    const bytes = await readFile(revisionPath)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== pointer.sha256 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new DesignPptxRevisionError('corrupt', 'The active PPTX revision failed its integrity check.')
    }
    return { metadata: { kind: 'edited', sha256, byteSize: bytes.byteLength,
      ...(pointer.slideCount !== undefined ? { slideCount: pointer.slideCount } : {}) }, bytes }
  }

  const sourcePath = await resolveContainedPath({
    root: workspaceRoot,
    target: assetRelativePath(document.id, source.cachedFilename),
    mustExist: true,
    expect: 'file',
    rejectFinalLink: true
  })
  const sourceInfo = await lstat(sourcePath)
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.size !== source.bytes) {
    throw new DesignPptxRevisionError('corrupt', 'The immutable source PPTX is missing or has an invalid size.')
  }
  const bytes = await readFile(sourcePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== source.sha256 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new DesignPptxRevisionError('corrupt', 'The immutable source PPTX failed its integrity check.')
  }
  return { metadata: { kind: 'source', sha256, byteSize: bytes.byteLength,
    slideCount: document.pptx?.importReport?.sourceSlideCount ?? document.pages.length }, bytes }
}

export async function readDesignPptxRevision(
  payload: DesignPptxRevisionReadPayload
): Promise<DesignPptxRevisionReadResult> {
  try {
    const workspaceRoot = await canonicalizeContainmentRoot(payload.workspaceRoot)
    assertDocumentId(payload.documentId)
    const document = await requirePptxDocument(workspaceRoot, payload.documentId)
    const current = await readCurrentPptxRevision(workspaceRoot, document, payload.kind === 'source')
    return { ok: true, revision: current.metadata, bytes: current.bytes }
  } catch (error) {
    if (error instanceof DesignPptxRevisionError) {
      const code = error.code === 'not_found'
        ? 'not_found'
        : error.code === 'invalid_document'
          ? 'invalid_document'
          : 'corrupt'
      return { ok: false, code, message: error.message }
    }
    return {
      ok: false,
      code: error instanceof UnsafePathError ? 'unsafe_path' : 'read_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function saveDesignPptxRevision(
  payload: DesignPptxRevisionSavePayload
): Promise<DesignPptxRevisionSaveResult> {
  try {
    const workspaceRoot = await canonicalizeContainmentRoot(payload.workspaceRoot)
    assertDocumentId(payload.documentId)
    if (!SHA256_PATTERN.test(payload.expectedSha256)) {
      return { ok: false, code: 'invalid_document', message: 'Expected PPTX revision digest is invalid.' }
    }
    const bytes = assertPowerPointBytes(payload.bytes)

    return await runSerialized(`design-pptx-revision:${workspaceRoot}:${payload.documentId}`, async () => {
      const document = await requirePptxDocument(workspaceRoot, payload.documentId)
      const current = await readCurrentPptxRevision(workspaceRoot, document)
      if (payload.expectedSha256 !== current.metadata.sha256) {
        return {
          ok: false,
          code: 'stale_request',
          currentSha256: current.metadata.sha256,
          message: 'The active PPTX revision changed in another editor.'
        }
      }

      const revisionsRelative = revisionDirectoryRelativePath(document.id)
      const candidateRelative = `${revisionsRelative}/.candidate-${randomUUID()}.pptx`
      const candidatePath = await resolveContainedPath({
        root: workspaceRoot,
        target: candidateRelative,
        mustExist: false,
        expect: 'file',
        rejectFinalLink: true
      })
      try {
        await atomicWriteFile(candidatePath, bytes, {
          beforeReplace: () => recheckContainedParent(workspaceRoot, candidatePath)
        })
        let preflight
        try {
          preflight = await preflightPptxForDesignImport(candidatePath)
          await recheckContainedParent(workspaceRoot, candidatePath)
          await validateAndCommitPowerPoint(candidatePath, candidatePath, preflight.slideCount, current.bytes)
        } catch (error) {
          throw new DesignPptxRevisionError('invalid_pptx', error instanceof Error ? error.message : String(error))
        }

        const validatedBytes = await readFile(candidatePath)
        const sha256 = createHash('sha256').update(validatedBytes).digest('hex')
        const revisionRelative = `${revisionsRelative}/${sha256}.pptx`
        const revisionPath = await resolveContainedPath({
          root: workspaceRoot,
          target: revisionRelative,
          mustExist: false,
          expect: 'file',
          rejectFinalLink: true
        })
        try {
          const existingInfo = await lstat(revisionPath)
          if (existingInfo.isSymbolicLink() || !existingInfo.isFile() || existingInfo.size !== validatedBytes.byteLength) {
            throw new DesignPptxRevisionError('corrupt', 'An existing content-addressed PPTX revision is invalid.')
          }
          const existingBytes = await readFile(revisionPath)
          if (createHash('sha256').update(existingBytes).digest('hex') !== sha256) {
            throw new DesignPptxRevisionError('corrupt', 'An existing content-addressed PPTX revision failed its integrity check.')
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await atomicWriteFile(revisionPath, validatedBytes, {
            beforeReplace: () => recheckContainedParent(workspaceRoot, revisionPath)
          })
        }

        const pointerPath = await resolveContainedPath({
          root: workspaceRoot,
          target: revisionPointerRelativePath(document.id),
          mustExist: false,
          expect: 'file',
          rejectFinalLink: true
        })
        const pointer: PptxRevisionPointerV1 = {
          schema: 'workwise.design.pptx-revision',
          version: 1,
          sha256,
          byteSize: validatedBytes.byteLength,
          slideCount: preflight.slideCount,
          updatedAt: Date.now()
        }
        await atomicWriteFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, {
          beforeReplace: () => recheckContainedParent(workspaceRoot, pointerPath)
        })
        return { ok: true, revision: { kind: 'edited', sha256, byteSize: validatedBytes.byteLength, slideCount: preflight.slideCount } }
      } finally {
        await rm(candidatePath, { force: true }).catch(() => undefined)
      }
    })
  } catch (error) {
    if (error instanceof DesignPptxRevisionError) {
      return {
        ok: false,
        code: error.code === 'not_found' || error.code === 'corrupt' ? 'invalid_document' : error.code,
        message: error.message
      }
    }
    return {
      ok: false,
      code: error instanceof UnsafePathError ? 'unsafe_path' : 'write_failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** Export against a trusted on-disk baseline, never renderer-supplied source bytes. */
export async function exportDesignPptxRevisionBytes(input: {
  workspaceRoot: string
  documentId: string
  bytes: Uint8Array
  expectedSlideCount: number
}, outputPath: string): Promise<void> {
  const workspaceRoot = await canonicalizeContainmentRoot(input.workspaceRoot)
  assertDocumentId(input.documentId)
  const document = await requirePptxDocument(workspaceRoot, input.documentId)
  const current = await readCurrentPptxRevision(workspaceRoot, document)
  await validateAndCommitPowerPointBytes(input.bytes, outputPath, input.expectedSlideCount, current.bytes)
}

export async function readDesignAsset(
  workspaceRootInput: string,
  documentId: string,
  asset: DesignAsset
): Promise<DesignAssetReadResult> {
  try {
    const workspaceRoot = await canonicalizeContainmentRoot(workspaceRootInput)
    if (
      !SAFE_ASSET_ID.test(asset.id) ||
      !SAFE_ASSET_FILENAME.test(asset.filename) ||
      extensionForMimeType(asset.mimeType) === null ||
      !Number.isSafeInteger(asset.byteSize) ||
      asset.byteSize <= 0 ||
      asset.byteSize > MAX_IMAGE_BYTES
    ) {
      throw new Error('Design asset metadata is invalid.')
    }
    const assetPath = await resolveContainedPath({
      root: workspaceRoot,
      target: assetRelativePath(documentId, asset.filename),
      mustExist: true,
      expect: 'file',
      rejectFinalLink: true
    })
    const info = await stat(assetPath)
    if (info.size !== asset.byteSize || info.size > MAX_IMAGE_BYTES) {
      throw new Error('Design asset size does not match its metadata.')
    }
    const bytes = await readFile(assetPath)
    if (!signatureMatches(bytes, asset.mimeType)) throw new Error('Design asset signature is invalid.')
    return {
      ok: true,
      dataUrl: `data:${asset.mimeType};base64,${Buffer.from(bytes).toString('base64')}`
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
