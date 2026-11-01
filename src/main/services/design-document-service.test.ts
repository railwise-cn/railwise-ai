import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESIGN_DOCUMENT_LIMITS,
  createDesignDocument,
  createDesignElement,
  validateDesignDocumentResourceLimits
} from '../../shared/design-document'
import {
  listDesignDocuments,
  loadDesignDocument,
  readDesignAsset,
  readSafeDesignImageSource,
  saveDesignDocument,
  readDesignPptxRevision,
  saveDesignPptxRevision,
  storeDesignImageAsset,
  storeDesignSourcePptx
} from './design-document-service'

const tempRoots: string[] = []
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function powerPointBytes(slideCount = 1): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types/>')
  zip.file(
    '_rels/.rels',
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>'
  )
  const slideIds = Array.from({ length: slideCount }, (_, index) =>
    `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`
  ).join('')
  zip.file(
    'ppt/presentation.xml',
    `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${slideIds}</p:sldIdLst></p:presentation>`
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships>${Array.from({ length: slideCount }, (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
    ).join('')}</Relationships>`
  )
  for (let index = 0; index < slideCount; index += 1) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, '<p:sld xmlns:p="p"/>')
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function savedPptxDocument(root: string): Promise<{
  documentId: string
  sourceBytes: Buffer
  sourceSha256: string
}> {
  const document = createDesignDocument({ name: 'Native deck' })
  document.schemaVersion = 'v2'
  document.documentKind = 'pptx'
  const sourceBytes = await powerPointBytes()
  const source = await storeDesignSourcePptx({ workspaceRoot: root, documentId: document.id, bytes: sourceBytes })
  document.pptx = {
    editorBackend: 'legacy-svg',
    editorVersion: 'test',
    source: { cachedFilename: source.filename, bytes: source.byteSize, sha256: source.sha256 }
  }
  const saved = await saveDesignDocument({
    workspaceRoot: root,
    document,
    activePageId: document.pages[0].id,
    expectedRevision: null
  })
  if (!saved.ok) throw new Error(saved.message ?? 'Failed to create PPTX test document.')
  return { documentId: document.id, sourceBytes, sourceSha256: source.sha256 }
}

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-design-document-'))
  tempRoots.push(root)
  return root
}

describe('Design document persistence', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('atomically saves, indexes, and restores a workspace Design document', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument({ name: 'Report canvas' })
    document.pages[0].elements.push(createDesignElement('rect'))
    document.appliedCommands = [{
      idempotencyKey: 'turn-1-command-1',
      revision: 0,
      appliedOperations: 1
    }]

    const saved = await saveDesignDocument({
      workspaceRoot: root,
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })
    expect(saved.ok).toBe(true)
    expect(saved.revision).toBe(document.revision)

    const loaded = await loadDesignDocument(root)
    expect(loaded.ok).toBe(true)
    expect(loaded.document?.name).toBe('Report canvas')
    expect(loaded.document?.pages[0].elements).toHaveLength(1)
    expect(loaded.document?.appliedCommands).toEqual(document.appliedCommands)
    expect(loaded.activePageId).toBe(document.pages[0].id)
  })

  it('lists and reopens previously saved Design documents without relying on the active index', async () => {
    const root = await temporaryWorkspace()
    const first = createDesignDocument({ name: 'First board' })
    const second = createDesignDocument({ name: 'Second board' })
    expect((await saveDesignDocument({
      workspaceRoot: root,
      document: first,
      activePageId: first.pages[0].id,
      expectedRevision: null
    })).ok).toBe(true)
    expect((await saveDesignDocument({
      workspaceRoot: root,
      document: second,
      activePageId: second.pages[0].id,
      expectedRevision: null
    })).ok).toBe(true)
    await writeFile(
      join(root, '.workwise', 'design', 'doc_corrupt.workwise-design.json'),
      '{not-json'
    )

    const listed = await listDesignDocuments(root)
    expect(listed).toMatchObject({
      ok: true,
      activeDocumentId: second.id,
      corruptDocumentIds: ['doc_corrupt']
    })
    expect(listed.documents.map((document) => document.id)).toEqual(
      expect.arrayContaining([first.id, second.id])
    )
    const reopened = await loadDesignDocument(root, first.id)
    expect(reopened).toMatchObject({
      ok: true,
      document: { id: first.id, name: 'First board' }
    })
  })

  it('reloads a multi-megabyte document after a successful bounded save', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument({ name: 'Large but safe' })
    document.pages[0].elements = Array.from({ length: 20 }, (_, index) =>
      createDesignElement('text', {
        id: `el_large_${index}`,
        text: '文'.repeat(60_000),
        zIndex: index
      })
    )

    const saved = await saveDesignDocument({
      workspaceRoot: root,
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })
    expect(saved.ok).toBe(true)

    const loaded = await loadDesignDocument(root, document.id)
    expect(loaded.ok).toBe(true)
    expect(loaded.document?.pages[0].elements).toHaveLength(20)
    expect(loaded.document?.pages[0].elements[19].text).toHaveLength(60_000)
  })

  it('rejects a document when pretty-printed persistence would exceed 8 MiB', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument({ name: 'Pretty overflow' })
    document.pages[0].elements = Array.from(
      { length: DESIGN_DOCUMENT_LIMITS.elementsPerPage },
      (_, index) =>
        createDesignElement('text', {
          id: `el_${index}`,
          text: '',
          zIndex: index
        })
    )

    let textLength = 1_000
    for (;;) {
      const text = 'x'.repeat(textLength)
      for (const element of document.pages[0].elements) element.text = text
      const compact = Buffer.byteLength(JSON.stringify(document), 'utf8')
      const pretty = Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
      if (compact <= DESIGN_DOCUMENT_LIMITS.fileBytes && pretty > DESIGN_DOCUMENT_LIMITS.fileBytes) {
        break
      }
      textLength += 25
      if (compact > DESIGN_DOCUMENT_LIMITS.fileBytes) {
        throw new Error('The test fixture could not straddle compact and persisted size limits.')
      }
    }
    expect(validateDesignDocumentResourceLimits(document).ok).toBe(true)

    const result = await saveDesignDocument({
      workspaceRoot: root,
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_document',
      message: expect.stringContaining('8 MiB')
    })
  })

  it('rejects a stale renderer instead of overwriting newer data', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument()
    const first = await saveDesignDocument({
      workspaceRoot: root,
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })
    expect(first.ok).toBe(true)
    if (!first.ok || !first.document) return

    const changed = {
      ...first.document,
      revision: first.document.revision + 1,
      name: 'Changed'
    }
    const second = await saveDesignDocument({
      workspaceRoot: root,
      document: changed,
      activePageId: changed.pages[0].id,
      expectedRevision: first.document.revision
    })
    expect(second.ok).toBe(true)

    const stale = await saveDesignDocument({
      workspaceRoot: root,
      document: { ...first.document, name: 'Stale' },
      activePageId: first.document.pages[0].id,
      expectedRevision: first.document.revision
    })
    expect(stale).toMatchObject({
      ok: false,
      code: 'stale_request',
      currentRevision: second.revision
    })
    expect((await loadDesignDocument(root)).document?.name).toBe('Changed')
  })

  it('does not replace a corrupt document with an empty document', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument()
    const designDirectory = join(root, '.workwise', 'design')
    await mkdir(designDirectory, { recursive: true })
    const documentPath = join(designDirectory, `${document.id}.workwise-design.json`)
    await writeFile(documentPath, '{ broken')

    const result = await saveDesignDocument({
      workspaceRoot: root,
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })
    expect(result.ok).toBe(false)
    expect(await readFile(documentPath, 'utf8')).toBe('{ broken')
  })

  it('stores and reads a signature-checked image asset inside the workspace', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument()
    const stored = await storeDesignImageAsset({
      workspaceRoot: root,
      documentId: document.id,
      originalFilename: '封面.png',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes: ONE_PIXEL_PNG
    })
    const read = await readDesignAsset(root, document.id, stored.asset)
    expect(read.ok).toBe(true)
    expect(read.dataUrl).toBe(stored.dataUrl)
  })

  it('rejects a symbolic-link image source', async () => {
    const root = await temporaryWorkspace()
    const target = join(root, 'image.png')
    const link = join(root, 'linked.png')
    await writeFile(target, ONE_PIXEL_PNG)
    await symlink(target, link)
    await expect(readSafeDesignImageSource(link)).rejects.toThrow(/regular file/)
  })

  it('reports a missing cached PPTX source without hiding the imported document', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument({ name: 'Imported deck' })
    document.schemaVersion = 'v2'
    document.documentKind = 'pptx'
    const sourceBytes = Buffer.from('PK\x03\x04cached-pptx')
    const stored = await storeDesignSourcePptx({
      workspaceRoot: root,
      documentId: document.id,
      bytes: sourceBytes
    })
    document.pptx = {
      editorBackend: 'legacy-svg',
      editorVersion: 'ppt-master-v6.8.0',
      source: { cachedFilename: stored.filename, bytes: stored.byteSize, sha256: stored.sha256 }
    }
    const saved = await saveDesignDocument({
      workspaceRoot: root,
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })
    expect(saved.ok).toBe(true)

    const sourcePath = join(root, '.workwise', 'design', 'assets', document.id, stored.filename)
    await rm(sourcePath)
    const loaded = await loadDesignDocument(root, document.id)
    expect(loaded).toMatchObject({
      ok: true,
      sourceStatus: { state: 'missing' },
      document: { id: document.id, documentKind: 'pptx' }
    })
    expect(loaded.sourceStatus?.message).toContain('re-import')
  })

  it('keeps the original cached PPTX immutable and requires a new document for re-imports', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument()
    const sourceBytes = Buffer.from('PK\x03\x04first-pptx')
    const stored = await storeDesignSourcePptx({ workspaceRoot: root, documentId: document.id, bytes: sourceBytes })
    await expect(storeDesignSourcePptx({ workspaceRoot: root, documentId: document.id, bytes: sourceBytes }))
      .resolves.toEqual(stored)
    await expect(storeDesignSourcePptx({
      workspaceRoot: root,
      documentId: document.id,
      bytes: Buffer.from('PK\x03\x04replacement-pptx')
    })).rejects.toThrow(/immutable.*new document/)
    await expect(readFile(join(root, '.workwise', 'design', 'assets', document.id, stored.filename)))
      .resolves.toEqual(sourceBytes)
  })

  it('reports a tampered cached PPTX source with the expected and actual digest', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument({ name: 'Tampered deck' })
    document.schemaVersion = 'v2'
    document.documentKind = 'pptx'
    const sourceBytes = Buffer.from('PK\x03\x04cached-pptx')
    const stored = await storeDesignSourcePptx({
      workspaceRoot: root,
      documentId: document.id,
      bytes: sourceBytes
    })
    document.pptx = {
      editorBackend: 'legacy-svg',
      editorVersion: 'ppt-master-v6.8.0',
      source: { cachedFilename: stored.filename, bytes: stored.byteSize, sha256: stored.sha256 }
    }
    expect((await saveDesignDocument({
      workspaceRoot: root,
      document,
      activePageId: document.pages[0].id,
      expectedRevision: null
    })).ok).toBe(true)
    const sourcePath = join(root, '.workwise', 'design', 'assets', document.id, stored.filename)
    await writeFile(sourcePath, Buffer.from('PK\x03\x04tampered'))
    const loaded = await loadDesignDocument(root, document.id)
    expect(loaded.sourceStatus?.state).toBe('corrupt')
    expect(loaded.sourceStatus?.expectedSha256).toBe(stored.sha256)
    expect(loaded.sourceStatus?.actualSha256).toBeTruthy()
    expect(loaded.document?.id).toBe(document.id)
  })

  it('rejects replacing source metadata while saving an editing revision', async () => {
    const root = await temporaryWorkspace()
    const document = createDesignDocument({ name: 'Original deck' })
    document.schemaVersion = 'v2'
    document.documentKind = 'pptx'
    const stored = await storeDesignSourcePptx({
      workspaceRoot: root,
      documentId: document.id,
      bytes: Buffer.from('PK\x03\x04first-pptx')
    })
    document.pptx = {
      editorBackend: 'legacy-svg',
      editorVersion: 'ppt-master-v6.8.0',
      source: { cachedFilename: stored.filename, bytes: stored.byteSize, sha256: stored.sha256 }
    }
    const saved = await saveDesignDocument({
      workspaceRoot: root, document, activePageId: document.pages[0].id, expectedRevision: null
    })
    expect(saved.ok).toBe(true)
    if (!saved.document) return
    const result = await saveDesignDocument({
      workspaceRoot: root,
      document: {
        ...saved.document,
        name: 'Unexpected replacement',
        pptx: { ...saved.document.pptx!, source: { ...saved.document.pptx!.source, sha256: 'a'.repeat(64) } }
      },
      activePageId: document.pages[0].id,
      expectedRevision: saved.document.revision
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_document', message: expect.stringContaining('immutable') })
    expect((await loadDesignDocument(root, document.id)).document?.name).toBe('Original deck')
  })

  it('reads the immutable source as the initial active native PPTX revision', async () => {
    const root = await temporaryWorkspace()
    const { documentId, sourceBytes, sourceSha256 } = await savedPptxDocument(root)

    const result = await readDesignPptxRevision({ workspaceRoot: root, documentId })
    expect(result).toMatchObject({
      ok: true,
      revision: { kind: 'source', sha256: sourceSha256, byteSize: sourceBytes.byteLength }
    })
    expect(Buffer.from(result.bytes ?? [])).toEqual(sourceBytes)
    expect(await readFile(join(root, '.workwise', 'design', 'assets', documentId, 'source.pptx')))
      .toEqual(sourceBytes)
  })

  it('stores validated edits as immutable content-addressed revisions and reads them back', async () => {
    const root = await temporaryWorkspace()
    const { documentId, sourceBytes, sourceSha256 } = await savedPptxDocument(root)
    const editedBytes = await powerPointBytes(2)
    const editedSha256 = createHash('sha256').update(editedBytes).digest('hex')

    const saved = await saveDesignPptxRevision({
      workspaceRoot: root,
      documentId,
      expectedSha256: sourceSha256,
      bytes: editedBytes
    })
    expect(saved).toEqual({
      ok: true,
      revision: { kind: 'edited', sha256: editedSha256, byteSize: editedBytes.byteLength, slideCount: 2 }
    })
    const loaded = await readDesignPptxRevision({ workspaceRoot: root, documentId })
    expect(loaded.revision).toEqual(saved.revision)
    expect(Buffer.from(loaded.bytes ?? [])).toEqual(editedBytes)
    const summaries = await listDesignDocuments(root)
    expect(summaries.documents.find((item) => item.id === documentId)?.pageCount).toBe(2)

    const sourcePath = join(root, '.workwise', 'design', 'assets', documentId, 'source.pptx')
    expect(await readFile(sourcePath)).toEqual(sourceBytes)
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(sourceSha256)

    const repeated = await saveDesignPptxRevision({
      workspaceRoot: root,
      documentId,
      expectedSha256: editedSha256,
      bytes: editedBytes
    })
    expect(repeated).toEqual(saved)
  })

  it('rejects stale PPTX editors without changing the active revision', async () => {
    const root = await temporaryWorkspace()
    const { documentId, sourceSha256 } = await savedPptxDocument(root)
    const editedBytes = await powerPointBytes(2)
    const saved = await saveDesignPptxRevision({
      workspaceRoot: root,
      documentId,
      expectedSha256: sourceSha256,
      bytes: editedBytes
    })
    if (!saved.ok || !saved.revision) throw new Error('Fixture save failed.')

    const stale = await saveDesignPptxRevision({
      workspaceRoot: root,
      documentId,
      expectedSha256: sourceSha256,
      bytes: await powerPointBytes(3)
    })
    expect(stale).toMatchObject({ ok: false, code: 'stale_request', currentSha256: saved.revision.sha256 })
    expect((await readDesignPptxRevision({ workspaceRoot: root, documentId })).revision).toEqual(saved.revision)
  })

  it('keeps the last good revision active when PPTX validation fails', async () => {
    const root = await temporaryWorkspace()
    const { documentId, sourceSha256 } = await savedPptxDocument(root)
    const editedBytes = await powerPointBytes(2)
    const saved = await saveDesignPptxRevision({
      workspaceRoot: root,
      documentId,
      expectedSha256: sourceSha256,
      bytes: editedBytes
    })
    if (!saved.ok || !saved.revision) throw new Error('Fixture save failed.')
    const revisionDirectory = join(root, '.workwise', 'design', 'assets', documentId, 'revisions')
    const pointerPath = join(revisionDirectory, 'current-revision.json')
    const priorPointer = await readFile(pointerPath, 'utf8')

    const failed = await saveDesignPptxRevision({
      workspaceRoot: root,
      documentId,
      expectedSha256: saved.revision.sha256,
      bytes: Buffer.from('PK\x03\x04not-an-ooxml-package')
    })
    expect(failed).toMatchObject({ ok: false, code: 'invalid_pptx' })
    expect(await readFile(pointerPath, 'utf8')).toBe(priorPointer)
    const loaded = await readDesignPptxRevision({ workspaceRoot: root, documentId })
    expect(loaded.revision).toEqual(saved.revision)
    expect(Buffer.from(loaded.bytes ?? [])).toEqual(editedBytes)
  })

  it('reports a corrupt active revision instead of silently falling back to the source', async () => {
    const root = await temporaryWorkspace()
    const { documentId, sourceSha256 } = await savedPptxDocument(root)
    const editedBytes = await powerPointBytes(2)
    const saved = await saveDesignPptxRevision({
      workspaceRoot: root,
      documentId,
      expectedSha256: sourceSha256,
      bytes: editedBytes
    })
    if (!saved.ok || !saved.revision) throw new Error('Fixture save failed.')
    const revisionPath = join(
      root,
      '.workwise',
      'design',
      'assets',
      documentId,
      'revisions',
      `${saved.revision.sha256}.pptx`
    )
    await writeFile(revisionPath, Buffer.from('PK\x03\x04tampered'))

    expect(await readDesignPptxRevision({ workspaceRoot: root, documentId }))
      .toMatchObject({ ok: false, code: 'corrupt' })
  })
})
