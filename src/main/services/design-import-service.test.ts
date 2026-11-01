import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import {
  inspectDesignSvgFidelity,
  createDesignImportReport,
  hasBlockingDesignImportErrors,
  PPTX_IMPORT_LIMITS,
  preflightPptxForDesignImport,
  readImportedDesignImage,
  shouldKeepVectorElements
} from './design-import-service'
import { createDesignDocument, createDesignElement, createDesignPage } from '../../shared/design-document'

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const roots: string[] = []

describe('Design PPTX import quality report', () => {
  it('reports editable approximations for gradients and translucent paint', () => {
    const warnings = inspectDesignSvgFidelity(
      '<svg><defs><linearGradient id="g"><stop offset="0" stop-color="#fff" /></linearGradient></defs><rect fill="url(#g)" /><text fill-opacity="0.4">x</text></svg>',
      0
    )
    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'gradient_approximation',
      'transparency_approximation'
    ]))
  })

  it('blocks the fixed-line-spacing unit failure found in a real imported title', () => {
    const document = createDesignDocument()
    document.pages[0].elements.push(createDesignElement('text', {
      text: '实战培训', x: 58, y: 45_263_006, w: 238, h: 92
    }))
    const report = createDesignImportReport({ document, sourceFileName: 'training.pptx', sourceSlideCount: 1 })
    expect(hasBlockingDesignImportErrors(report)).toBe(true)
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      code: 'extreme_element_geometry', severity: 'error', pageNumber: 1,
      elementId: document.pages[0].elements[0].id
    }))
  })

  it('rejects incomplete conversion even when at least one slide was produced', () => {
    const report = createDesignImportReport({
      document: createDesignDocument(), sourceFileName: 'training.pptx', sourceSlideCount: 70
    })
    expect(hasBlockingDesignImportErrors(report)).toBe(true)
    expect(report.summary.errorCount).toBe(1)
    expect(report.diagnostics[0].code).toBe('slide_count_mismatch')
  })

  it('permits normal decorative bleed but reports fully off-page text', () => {
    const document = createDesignDocument()
    document.pages[0].elements.push(
      createDesignElement('ellipse', { x: -110, y: 400, w: 520, h: 400 }),
      createDesignElement('text', { text: 'Off-page label', x: 1300, y: 50, w: 120, h: 20 })
    )
    const report = createDesignImportReport({ document, sourceFileName: 'training.pptx', sourceSlideCount: 1 })
    expect(hasBlockingDesignImportErrors(report)).toBe(false)
    expect(report.summary).toMatchObject({ elementCount: 2, textElementCount: 1, warningCount: 1, errorCount: 0 })
    expect(report.diagnostics[0].code).toBe('text_outside_canvas')
  })

  it('links legacy warning page numbers to actual page ids and records mixed mode', () => {
    const document = createDesignDocument()
    document.pages.push({ ...createDesignPage(), displayMode: 'fidelity' })
    const report = createDesignImportReport({
      document, sourceFileName: '/private/source/training.pptx', sourceSlideCount: 2, importedAt: 123,
      warnings: [{ code: 'unsupported_mask', pageId: 'page-2', message: 'Mask is not editable.' }]
    })
    expect(report).toMatchObject({ sourceFileName: 'training.pptx', importedAt: 123, mode: 'mixed' })
    expect(report.diagnostics[0]).toMatchObject({ pageNumber: 2, pageId: document.pages[1].id })
  })

  it('rejects non-finite geometry without hiding the failed element', () => {
    const document = createDesignDocument()
    document.pages[0].elements.push(createDesignElement('rect', { x: Number.POSITIVE_INFINITY }))
    const report = createDesignImportReport({ document, sourceFileName: 'training.pptx', sourceSlideCount: 1 })
    expect(hasBlockingDesignImportErrors(report)).toBe(true)
    expect(report.diagnostics[0].code).toBe('invalid_element_geometry')
  })
})

async function createImportRoot(): Promise<{ root: string; svgDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-design-import-test-'))
  const svgDirectory = join(root, 'svg')
  await mkdir(svgDirectory)
  roots.push(root)
  return { root, svgDirectory }
}

async function writePptx(
  root: string,
  configure?: (zip: JSZip) => void,
  compression: 'STORE' | 'DEFLATE' = 'DEFLATE'
): Promise<string> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types />')
  zip.file('ppt/presentation.xml', '<p:presentation />')
  zip.file('ppt/slides/slide1.xml', '<p:sld />')
  configure?.(zip)
  const path = join(root, 'source.pptx')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression }))
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Design PPTX ZIP preflight', () => {
  it('accepts a bounded PowerPoint archive at the minimum required structure', async () => {
    const { root } = await createImportRoot()
    const path = await writePptx(root)

    await expect(preflightPptxForDesignImport(path)).resolves.toMatchObject({
      slideCount: 1
    })
  })

  it('rejects a source one byte above the 200 MiB hard limit before reading ZIP data', async () => {
    const { root } = await createImportRoot()
    const path = join(root, 'oversized.pptx')
    await writeFile(path, Buffer.alloc(0))
    await truncate(path, PPTX_IMPORT_LIMITS.sourceBytes + 1)

    await expect(preflightPptxForDesignImport(path)).rejects.toThrow('200 MiB')
  })

  it('rejects an OOXML part one byte above the per-XML limit', async () => {
    const { root } = await createImportRoot()
    const path = await writePptx(
      root,
      (zip) => {
        zip.file(
          'ppt/notesSlides/notesSlide1.xml',
          Buffer.alloc(PPTX_IMPORT_LIMITS.xmlBytes + 1, 0x20)
        )
      },
      'STORE'
    )

    await expect(preflightPptxForDesignImport(path)).rejects.toThrow('64 MiB XML')
  })

  it('rejects a highly compressed entry before Python or the sidecar is called', async () => {
    const { root } = await createImportRoot()
    const path = await writePptx(root, (zip) => {
      zip.file('ppt/media/bomb.bin', Buffer.alloc(2 * 1024 * 1024, 0x41))
    })

    await expect(preflightPptxForDesignImport(path)).rejects.toThrow('compression ratio')
  })

  it('accepts the slide-count boundary and rejects one page above it', async () => {
    const { root } = await createImportRoot()
    const boundary = await writePptx(root, (zip) => {
      for (let slide = 2; slide <= PPTX_IMPORT_LIMITS.slides; slide += 1) {
        zip.file(`ppt/slides/slide${slide}.xml`, '<p:sld />')
      }
    })
    await expect(preflightPptxForDesignImport(boundary)).resolves.toMatchObject({
      slideCount: PPTX_IMPORT_LIMITS.slides
    })

    const aboveRoot = await mkdtemp(join(tmpdir(), 'workwise-design-import-test-'))
    roots.push(aboveRoot)
    const above = await writePptx(aboveRoot, (zip) => {
      for (let slide = 2; slide <= PPTX_IMPORT_LIMITS.slides + 1; slide += 1) {
        zip.file(`ppt/slides/slide${slide}.xml`, '<p:sld />')
      }
    })
    await expect(preflightPptxForDesignImport(above)).rejects.toThrow('500 slides')
  })

  it('rejects an archive with more than 4096 central-directory entries', async () => {
    const { root } = await createImportRoot()
    const path = await writePptx(root, (zip) => {
      for (let index = 0; index < PPTX_IMPORT_LIMITS.entries; index += 1) {
        zip.file(`ppt/customXml/item-${index}.bin`, Buffer.from([index & 0xff]))
      }
    })

    await expect(preflightPptxForDesignImport(path)).rejects.toThrow('4096 entries')
  })

  it('rejects case-insensitive duplicate ZIP entry paths', async () => {
    const { root } = await createImportRoot()
    const path = await writePptx(root, (zip) => {
      zip.file('PPT/SLIDES/SLIDE1.XML', '<duplicate />')
    })

    await expect(preflightPptxForDesignImport(path)).rejects.toThrow('duplicate entry paths')
  })
})

describe('Design PPTX image import boundary', () => {
  it('accepts a supported embedded image and preserves its bytes', async () => {
    const { root, svgDirectory } = await createImportRoot()
    const dataUrl = `data:image/png;base64,${PNG_HEADER.toString('base64')}`

    const result = await readImportedDesignImage(dataUrl, svgDirectory, root)

    expect(result.mimeType).toBe('image/png')
    expect(Buffer.from(result.bytes)).toEqual(PNG_HEADER)
  })

  it('accepts a regular image below the import root', async () => {
    const { root, svgDirectory } = await createImportRoot()
    await writeFile(join(svgDirectory, 'picture.png'), PNG_HEADER)

    const result = await readImportedDesignImage('picture.png', svgDirectory, root)

    expect(result.filename).toBe('picture.png')
    expect(result.mimeType).toBe('image/png')
  })

  it.each([
    'https://example.com/image.png',
    'file:///tmp/image.png',
    '/tmp/image.png',
    '../../image.png'
  ])('rejects external or escaping image href %s', async (href) => {
    const { root, svgDirectory } = await createImportRoot()
    await expect(readImportedDesignImage(href, svgDirectory, root)).rejects.toThrow()
  })

  it('rejects a symlink even when its target is inside the import root', async () => {
    const { root, svgDirectory } = await createImportRoot()
    await writeFile(join(svgDirectory, 'target.png'), PNG_HEADER)
    await symlink(join(svgDirectory, 'target.png'), join(svgDirectory, 'linked.png'))

    await expect(
      readImportedDesignImage('linked.png', svgDirectory, root)
    ).rejects.toThrow('safe regular file')
  })

  it('rejects content whose signature does not match its file type', async () => {
    const { root, svgDirectory } = await createImportRoot()
    await writeFile(join(svgDirectory, 'fake.png'), Buffer.from('not an image'))

    await expect(
      readImportedDesignImage('fake.png', svgDirectory, root)
    ).rejects.toThrow('signature')
  })
})

describe('Design PPTX fidelity diagnostics', () => {
  it('reports filters, masks, flattened groups and complex transforms explicitly', () => {
    const warnings = inspectDesignSvgFidelity(
      '<svg><defs><filter id="f"><feBlur /></filter><mask id="m" /></defs>' +
      '<g transform="translate(10 10)"><rect mask="url(#m)" /></g></svg>',
      1
    )

    expect(warnings.map((warning) => warning.code)).toEqual([
      'unsupported_filter',
      'unsupported_mask',
      'flattened_group',
      'layout_approximation'
    ])
    expect(warnings.every((warning) => warning.pageId === 'page-2')).toBe(true)
  })
})

describe('shouldKeepVectorElements', () => {
  it('keeps pages with real text elements', () => {
    expect(shouldKeepVectorElements({
      id: 'p1',
      name: 'Page 1',
      width: 1280,
      height: 720,
      background: 'FFFFFF',
      elements: [
        { id: 'img', type: 'image', x: 0, y: 0, w: 1280, h: 720, rotation: 0, zIndex: 0 },
        { id: 'txt', type: 'text', x: 100, y: 100, w: 200, h: 40, rotation: 0, text: '标题', zIndex: 1 }
      ]
    })).toBe(true)
  })

  it('keeps pages with visible filled shapes', () => {
    expect(shouldKeepVectorElements({
      id: 'p1',
      name: 'Page 1',
      width: 1280,
      height: 720,
      background: 'FFFFFF',
      elements: [
        { id: 'rect', type: 'rect', x: 10, y: 10, w: 100, h: 50, rotation: 0, fill: '1E3A5F', zIndex: 0 }
      ]
    })).toBe(true)
  })

  it('falls back for picture-only pages with invisible placeholder rects', () => {
    expect(shouldKeepVectorElements({
      id: 'p1',
      name: 'Page 1',
      width: 1280,
      height: 720,
      background: 'FFFFFF',
      elements: [
        { id: 'img', type: 'image', x: 0, y: 0, w: 1280, h: 720, rotation: 0, zIndex: 0 },
        { id: 'r1', type: 'rect', x: 10, y: 10, w: 100, h: 50, rotation: 0, opacity: 0, zIndex: 1 }
      ]
    })).toBe(false)
  })
})
