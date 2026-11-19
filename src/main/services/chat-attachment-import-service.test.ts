import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentParseResultV1 } from '../../shared/agent-workbench'
import type { DocumentEngineService } from './document-engine-service'
import { ChatAttachmentImportService } from './chat-attachment-import-service'

const roots: string[] = []
const fixtureRoot = new URL('../../../test/fixtures/document-quality/', import.meta.url)
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

const emptyParse: DocumentParseResultV1 = {
  id: 'parse', engine: 'markitdown', engineVersion: 'fixture', sourceSha256: 'fixture',
  markdown: '', headings: [], tables: [], media: [], references: [], warnings: [],
  quality: { status: 'degraded', reasons: ['scanned_document'] },
  route: { requestedMode: 'auto', selectedEngine: 'markitdown' }, cacheHit: false, durationMs: 1
}

async function serviceWithFile(name: string, contents: string | Buffer, parse?: DocumentEngineService['parse']) {
  const root = await mkdtemp(join(tmpdir(), 'workwise-chat-attachment-'))
  roots.push(root)
  const sourcePath = join(root, name)
  await writeFile(sourcePath, contents)
  const service = new ChatAttachmentImportService({
    managedRoot: join(root, 'managed'),
    ...(parse ? { documentEngine: { parse } as DocumentEngineService } : {})
  })
  return { service, sourcePath }
}

describe('ChatAttachmentImportService parse states', () => {
  it.each([
    ['image.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
    ['image.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff])],
    ['image.webp', 'image/webp', Buffer.from('RIFFxxxxWEBP', 'ascii')]
  ])('imports valid %s content using its real signature', async (name, mimeType, bytes) => {
    const fixture = await serviceWithFile(name, bytes)

    await expect(fixture.service.stage({
      sourcePath: fixture.sourcePath,
      declaredMimeType: mimeType
    })).resolves.toMatchObject({ kind: 'image', mimeType })
  })

  it('imports GIF87a and GIF89a images and rejects spoofed GIF content', async () => {
    for (const signature of ['GIF87a', 'GIF89a']) {
      const bytes = Buffer.alloc(10)
      bytes.write(signature, 0, 'ascii')
      bytes.writeUInt16LE(12, 6)
      bytes.writeUInt16LE(8, 8)
      const fixture = await serviceWithFile(`${signature}.gif`, bytes)

      await expect(fixture.service.stage({
        sourcePath: fixture.sourcePath,
        declaredMimeType: 'image/gif'
      })).resolves.toMatchObject({ kind: 'image', mimeType: 'image/gif' })
    }

    const invalid = await serviceWithFile('invalid.gif', Buffer.from('not-a-gif'))
    await expect(invalid.service.stage({ sourcePath: invalid.sourcePath }))
      .rejects.toThrow('image signature is invalid')

    const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const spoofed = await serviceWithFile('spoofed.gif', pngBytes)
    await expect(spoofed.service.stage({ sourcePath: spoofed.sourcePath }))
      .rejects.toThrow('image signature does not match file extension')
  })

  it('rejects empty text and corrupt PDF signatures with explicit errors', async () => {
    const empty = await serviceWithFile('empty.txt', '   \n')
    const stagedText = await empty.service.stage({ sourcePath: empty.sourcePath })
    await expect(empty.service.parse(stagedText)).rejects.toThrow('no usable text')

    const corrupt = await serviceWithFile('damaged.pdf', 'not a pdf')
    await expect(corrupt.service.stage({ sourcePath: corrupt.sourcePath })).rejects.toThrow('PDF signature is invalid')

    const spoofed = await serviceWithFile('spoofed.pdf', '%PDF-1.7\n%%EOF')
    await expect(spoofed.service.stage({ sourcePath: spoofed.sourcePath, declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).rejects.toThrow('MIME type does not match')
  })

  it('surfaces password errors and preserves degraded OCR/parser metadata', async () => {
    const encrypted = await serviceWithFile('encrypted.pdf', '%PDF-1.7\n%%EOF', vi.fn(async () => {
      throw Object.assign(new Error('Password-protected PDF requires a password before it can be read.'), { code: 'password_required' })
    }))
    const stagedEncrypted = await encrypted.service.stage({ sourcePath: encrypted.sourcePath })
    await expect(encrypted.service.parse(stagedEncrypted)).rejects.toMatchObject({ code: 'password_required' })

    const degraded = await serviceWithFile('scan.pdf', '%PDF-1.7\n%%EOF', vi.fn(async () => ({
      id: 'parse', engine: 'markitdown' as const, engineVersion: 'fixture', sourceSha256: 'hash',
      markdown: '# 招标文件\n\n扫描正文', headings: [{ level: 1, text: '招标文件', page: 2 }],
      tables: [{ markdown: '| 条款 | 值 |', page: 3 }], media: [], references: [],
      sourceStructure: { pageCount: 120 }, warnings: ['OCR is not installed'],
      quality: { status: 'degraded' as const, reasons: ['scanned_or_sparse_pages'] },
      route: { requestedMode: 'auto' as const, selectedEngine: 'markitdown' as const }, cacheHit: false, durationMs: 1
    })))
    const stagedScan = await degraded.service.stage({ sourcePath: degraded.sourcePath })
    await expect(degraded.service.parse(stagedScan)).resolves.toMatchObject({
      state: 'degraded', warnings: ['OCR is not installed'], degradationReasons: ['scanned_or_sparse_pages'],
      sourceStructure: { pageCount: 120, headings: 1, tables: 1 }
    })
  })

  it('passes the configured parsing mode and local OCR endpoint to the document engine', async () => {
    const parse = vi.fn(async () => ({
      id: 'parse', engine: 'unlimited-ocr-local' as const, engineVersion: 'fixture', sourceSha256: 'hash',
      markdown: '# 解析结果', headings: [], tables: [], media: [], references: [],
      warnings: [], quality: { status: 'enhanced' as const, reasons: [] },
      route: { requestedMode: 'accurate' as const, selectedEngine: 'unlimited-ocr-local' as const },
      cacheHit: false, durationMs: 1
    }))
    const fixture = await serviceWithFile('accurate.pdf', '%PDF-1.7\n%%EOF', parse)
    const staged = await fixture.service.stage({ sourcePath: fixture.sourcePath })

    await expect(fixture.service.parse(staged, {
      mode: 'accurate',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000'
    })).resolves.toMatchObject({ state: 'ready', document: { engine: 'unlimited-ocr-local' } })
    expect(parse).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'accurate',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000'
    }))
  })

  it('retains the original of a real image-only PDF without inventing indexed text', async () => {
    const scan = await readFile(new URL('synthetic-image-only-scan.pdf', fixtureRoot))
    const parse = vi.fn(async () => emptyParse)
    const fixture = await serviceWithFile('scan.pdf', scan, parse)
    const staged = await fixture.service.stage({ sourcePath: fixture.sourcePath })
    const result = await fixture.service.parse(staged)

    expect(result).toMatchObject({
      state: 'degraded', pdfTextPages: [], sourceStructure: { pageCount: 1 },
      degradationReasons: ['no_extractable_pdf_text', 'scanned_or_sparse_pages']
    })
    expect(result.document).toBeUndefined()
    expect(result.text).toBeUndefined()
    expect(await readFile(result.absolutePath)).toEqual(scan)
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('recovers real PDF text and its page when the document sidecar fails', async () => {
    const source = await readFile(new URL('synthetic-complex-layout.pdf', fixtureRoot))
    const fixture = await serviceWithFile('report.pdf', source, vi.fn(async () => {
      throw new Error('document sidecar failed')
    }))
    const staged = await fixture.service.stage({ sourcePath: fixture.sourcePath })

    await expect(fixture.service.parse(staged)).resolves.toMatchObject({
      state: 'degraded', degradationReasons: ['pdf_text_layer_fallback'],
      pdfTextPages: [{ page: 1, text: expect.stringContaining('Complex Layout Fixture') }],
      sourceStructure: { pageCount: 1 }
    })
  })

  it('rejects a structurally invalid PDF with a valid header instead of treating it as a scan', async () => {
    const fixture = await serviceWithFile('damaged.pdf', '%PDF-1.7\n%%EOF', vi.fn(async () => emptyParse))
    const staged = await fixture.service.stage({ sourcePath: fixture.sourcePath })

    await expect(fixture.service.parse(staged)).rejects.toMatchObject({ code: 'invalid_document' })
  })

  it('tries configured local OCR once for a real scan and uses its actual extracted text', async () => {
    const scan = await readFile(new URL('synthetic-image-only-scan.pdf', fixtureRoot))
    const ocr: DocumentParseResultV1 = {
      ...emptyParse, engine: 'unlimited-ocr-local', markdown: '<!-- page:1 -->\n\nOCR 文字',
      quality: { status: 'enhanced', reasons: [] },
      route: { requestedMode: 'accurate', selectedEngine: 'unlimited-ocr-local' }
    }
    const parse = vi.fn<DocumentEngineService['parse']>().mockResolvedValueOnce(emptyParse).mockResolvedValueOnce(ocr)
    const fixture = await serviceWithFile('scan.pdf', scan, parse)
    const staged = await fixture.service.stage({ sourcePath: fixture.sourcePath })

    await expect(fixture.service.parse(staged, { unlimitedOcrServerUrl: 'http://127.0.0.1:3000' }))
      .resolves.toMatchObject({ state: 'ready', document: ocr })
    expect(parse).toHaveBeenCalledTimes(2)
    expect(parse).toHaveBeenLastCalledWith(expect.objectContaining({
      allowPrivateServerUpload: false, mode: 'accurate', preferredEngine: 'unlimited-ocr-local',
      unlimitedOcrServerUrl: 'http://127.0.0.1:3000', signal: expect.any(AbortSignal)
    }))
  })
})
