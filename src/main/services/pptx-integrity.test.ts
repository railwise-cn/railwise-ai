import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectPptxPackage, preserveProtectedPptxContent, validatePptxRoundTrip } from './pptx-integrity'
import { importPptxToDesign } from './design-import-service'
import { validateAndCommitPowerPointBytes } from './design-export-service'
import { normalizeDesignDocument } from '../../shared/design-document'
import {
  readDesignPptxRevision, saveDesignDocument, saveDesignPptxRevision, storeDesignSourcePptx
} from './design-document-service'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(): Promise<Buffer> {
  const generator = await import(new URL('../../../scripts/create-pptx-regression-fixture.mjs', import.meta.url).href)
  return generator.createPptxRegressionFixture()
}

async function edit(bytes: Buffer, path: string, update: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes)
  zip.file(path, update(await zip.file(path)!.async('string')))
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('native PPTX semantic and protected-object integrity', () => {
  it('inventories rich text, merged cells, chart and protected SmartArt without SVG conversion', async () => {
    const bytes = await fixture()
    const { report } = await inspectPptxPackage(bytes)
    expect(report.errors).toEqual([])
    expect(report.pages[0]).toMatchObject({ width: 1280, height: 720, objectCount: 4, protectedObjectCount: 1 })
    expect(report.objects.find((object) => object.type === 'text')).toMatchObject({
      id: '2', text: 'RailWise regression\n — 原生编辑', fonts: ['Arial'], textRunCount: 2
    })
    expect(report.objects.find((object) => object.type === 'table')?.table).toEqual({ rows: 2, columns: 2, mergedCells: 2 })
    expect(report.objects.find((object) => object.type === 'chart')?.support).toBe('editable')
    expect(report.objects.find((object) => object.type === 'smart-art')?.support).toBe('protected')
    const root = await mkdtemp(join(tmpdir(), 'pptx-native-intake-')); roots.push(root)
    const path = join(root, 'native.pptx'); await writeFile(path, bytes)
    const result = await importPptxToDesign(path)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.images).toEqual([])
    expect(result.document.pptx?.importReport?.objects).toHaveLength(4)
    expect(result.importReport.diagnostics.some((item) => item.code === 'protected_object')).toBe(true)
    expect(result.importReport.diagnostics.some((item) => item.code === 'native_import_diagnostic')).toBe(false)
    const normalized = normalizeDesignDocument(result.document)
    expect(normalized?.pptx?.importReport?.objects).toEqual(result.document.pptx?.importReport?.objects)
  })

  it('uses presentation relationships for order instead of lexicographic filenames', async () => {
    const zip = await JSZip.loadAsync(await fixture())
    const presentation = await zip.file('ppt/presentation.xml')!.async('string')
    zip.file('ppt/presentation.xml', presentation.replace('<p:sldId id="256" r:id="rId1"/>', '<p:sldId id="266" r:id="rId10"/><p:sldId id="256" r:id="rId1"/>'))
    const relationships = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
    zip.file('ppt/_rels/presentation.xml.rels', relationships.replace('</Relationships>', '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide10.xml"/></Relationships>'))
    zip.file('ppt/slides/slide10.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>')
    const inspection = await inspectPptxPackage(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(inspection.slideParts).toEqual(['ppt/slides/slide10.xml', 'ppt/slides/slide1.xml'])
  })

  it('allows ordinary slide add/delete/reorder while rejecting deletion of protected pages', async () => {
    const zip = await JSZip.loadAsync(await fixture())
    const slide = '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>'
    zip.file('ppt/slides/slide2.xml', slide)
    zip.file('ppt/slides/slide3.xml', slide)
    const rel = (id: number) => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${id}.xml"/>`
    zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace('</Relationships>', `${rel(2)}${rel(3)}</Relationships>`))
    const originalPresentation = await zip.file('ppt/presentation.xml')!.async('string')
    zip.file('ppt/presentation.xml', originalPresentation.replace('</p:sldIdLst>', '<p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/></p:sldIdLst>'))
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    zip.file('ppt/presentation.xml', originalPresentation.replace('<p:sldId id="256" r:id="rId1"/>', '<p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/>'))
    zip.remove('ppt/slides/slide3.xml')
    zip.file('ppt/_rels/presentation.xml.rels', (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace(rel(3), ''))
    const reordered = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(validatePptxRoundTrip(source, reordered)).resolves.toMatchObject({ slideParts: ['ppt/slides/slide2.xml', 'ppt/slides/slide1.xml'] })
    await expect(validatePptxRoundTrip(await fixture(), source)).resolves.toMatchObject({ report: { importedSlideCount: 3 } })
    zip.remove('ppt/slides/slide1.xml')
    zip.file('ppt/presentation.xml', originalPresentation.replace('<p:sldId id="256" r:id="rId1"/>', '<p:sldId id="257" r:id="rId2"/>'))
    const removedProtected = await zip.generateAsync({ type: 'nodebuffer' })
    await expect(preserveProtectedPptxContent(source, removedProtected)).rejects.toThrow('Protected slide ppt/slides/slide1.xml was removed')
  })

  it('records binary media digests so unchanged media preservation can be audited', async () => {
    const zip = await JSZip.loadAsync(await fixture())
    zip.file('ppt/media/image1.png', Buffer.from([137, 80, 78, 71, 1, 2, 3]))
    const source = await zip.generateAsync({ type: 'nodebuffer' })
    const edited = await edit(source, 'ppt/slides/slide1.xml', (xml) => xml.replace('RailWise regression', 'Only a title changed'))
    const before = await inspectPptxPackage(source)
    const after = await validatePptxRoundTrip(source, edited)
    expect(after.mediaDigests).toEqual(before.mediaDigests)
  })

  it('allows ordinary native text edits but rejects loss or mutation of protected payloads', async () => {
    const source = await fixture()
    const edited = await edit(source, 'ppt/slides/slide1.xml', (xml) => xml.replace('RailWise regression', 'Edited title'))
    await expect(validatePptxRoundTrip(source, edited)).resolves.toMatchObject({ slideText: [expect.stringContaining('Edited title')] })
    const damaged = await edit(edited, 'ppt/diagrams/data1.xml', (xml) => xml.replace('modelId="0"', 'modelId="lost"'))
    await expect(validatePptxRoundTrip(source, damaged)).rejects.toThrow('protected content changed')
    const restored = await preserveProtectedPptxContent(source, damaged)
    await expect(validatePptxRoundTrip(source, restored)).resolves.toMatchObject({ slideText: [expect.stringContaining('Edited title')] })
    const missing = await JSZip.loadAsync(edited)
    missing.remove('ppt/diagrams/data1.xml')
    await expect(validatePptxRoundTrip(source, await missing.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow('missing resource')
  })

  it('rejects malformed XML and broken chart resources during semantic re-import', async () => {
    const bytes = await fixture()
    const malformed = await edit(bytes, 'ppt/slides/slide1.xml', (xml) => xml.replace('</p:sld>', ''))
    await expect(inspectPptxPackage(malformed)).rejects.toThrow()
    const zip = await JSZip.loadAsync(bytes); zip.remove('ppt/charts/chart1.xml')
    const result = await inspectPptxPackage(await zip.generateAsync({ type: 'nodebuffer' }))
    expect(result.report.status).toBe('blocked')
    expect(result.report.errors.join(' ')).toContain('missing resource')
  })

  it('keeps the old export and active revision when protected validation fails; reference reads the immutable source', async () => {
    const source = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'pptx-protected-rollback-')); roots.push(root)
    const path = join(root, 'source.pptx'); await writeFile(path, source)
    const result = await importPptxToDesign(path)
    if (!result.ok) throw new Error(result.message)
    const document = result.document
    const stored = await storeDesignSourcePptx({ workspaceRoot: root, documentId: document.id, bytes: source })
    document.pptx!.source = { cachedFilename: stored.filename, sha256: stored.sha256, bytes: stored.byteSize }
    const initialSave = await saveDesignDocument({ workspaceRoot: root, document, activePageId: document.pages[0].id, expectedRevision: null })
    expect(initialSave, initialSave.message).toMatchObject({ ok: true })
    const modified = await edit(source, 'ppt/slides/slide1.xml', (xml) => xml.replace('RailWise regression', 'New title'))
    const saved = await saveDesignPptxRevision({ workspaceRoot: root, documentId: document.id, expectedSha256: stored.sha256, bytes: modified })
    expect(saved.ok).toBe(true)
    const originalRead = await readDesignPptxRevision({ workspaceRoot: root, documentId: document.id, kind: 'source' })
    expect(Buffer.from(originalRead.bytes!)).toEqual(source)
    const damaged = await edit(modified, 'ppt/slides/slide1.xml', (xml) => xml.replace(/<dgm:relIds\b[^>]*\/>/, '<a:tbl><a:tr/></a:tbl>'))
    const rejected = await saveDesignPptxRevision({ workspaceRoot: root, documentId: document.id, expectedSha256: saved.revision!.sha256, bytes: damaged })
    expect(rejected.ok).toBe(false)
    const current = await readDesignPptxRevision({ workspaceRoot: root, documentId: document.id })
    expect(Buffer.from(current.bytes!)).toEqual(modified)
    const output = join(root, 'output.pptx'); await writeFile(output, modified)
    await expect(validateAndCommitPowerPointBytes(damaged, output, 1, source)).rejects.toThrow('replaced with another object type')
    expect(await readFile(output)).toEqual(modified)
  })
})
