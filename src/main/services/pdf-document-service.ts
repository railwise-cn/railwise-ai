import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const MAX_ANALYZED_PAGES = 500
const MAX_PAGE_TEXT_BYTES = 64 * 1024
const MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024
const MAX_IMAGE_PIXELS = 20_000_000

export type PdfPageTextV1 = {
  page: number
  text: string
}

export type PdfDocumentAnalysisV1 = {
  pageCount: number
  searchable: boolean
  pages: PdfPageTextV1[]
  truncated: boolean
  warnings: string[]
}

export async function analyzePdfDocument(
  path: string,
  signal?: AbortSignal
): Promise<PdfDocumentAnalysisV1> {
  if (signal?.aborted) throw cancelledError()
  let bytes: Buffer
  try {
    bytes = await readFile(path, { signal })
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw cancelledError()
    throw normalizePdfError(error)
  }
  if (signal?.aborted) throw cancelledError()
  // pdfjs probes optional native canvas bindings while the module loads. Keep
  // that work out of the desktop bootstrap so one missing cross-arch optional
  // package cannot prevent WorkWise itself from reaching app.whenReady().
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfAssets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  if (signal?.aborted) throw cancelledError()
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    // PDF.js Node factories use fs, and require a literal trailing slash.
    cMapUrl: `${join(pdfAssets, 'cmaps')}/`,
    cMapPacked: true,
    standardFontDataUrl: `${join(pdfAssets, 'standard_fonts')}/`,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    useWasm: false,
    stopAtErrors: true,
    maxImageSize: MAX_IMAGE_PIXELS
  })
  const abort = (): void => { void loadingTask.destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const document = await loadingTask.promise
    if (signal?.aborted) throw cancelledError()
    const pages: PdfPageTextV1[] = []
    const warnings: string[] = []
    let totalBytes = 0
    const limit = Math.min(document.numPages, MAX_ANALYZED_PAGES)
    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      if (signal?.aborted) throw cancelledError()
      const page = await document.getPage(pageNumber)
      if (signal?.aborted) throw cancelledError()
      const content = await page.getTextContent({ disableNormalization: false })
      if (signal?.aborted) throw cancelledError()
      const raw = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      const text = fitUtf8(raw, Math.min(MAX_PAGE_TEXT_BYTES, MAX_TOTAL_TEXT_BYTES - totalBytes))
      const textBytes = Buffer.byteLength(text, 'utf8')
      totalBytes += textBytes
      pages.push({ page: pageNumber, text })
      page.cleanup()
      if (totalBytes >= MAX_TOTAL_TEXT_BYTES) {
        warnings.push('PDF text-layer analysis reached the 4 MiB safety limit.')
        break
      }
    }
    if (document.numPages > MAX_ANALYZED_PAGES) {
      warnings.push(`PDF text-layer analysis is limited to the first ${MAX_ANALYZED_PAGES} pages.`)
    }
    const searchableCharacters = pages.reduce((sum, page) => sum + page.text.replace(/\s+/g, '').length, 0)
    return {
      pageCount: document.numPages,
      searchable: searchableCharacters > 0,
      pages,
      truncated: pages.length < document.numPages,
      warnings
    }
  } catch (error) {
    if (signal?.aborted) throw cancelledError()
    throw normalizePdfError(error)
  } finally {
    signal?.removeEventListener('abort', abort)
    await loadingTask.destroy().catch(() => undefined)
  }
}

function fitUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let output = ''
  let used = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

function cancelledError(): Error {
  return Object.assign(new Error('PDF analysis was cancelled.'), { code: 'document_parse_cancelled' })
}

export function normalizePdfError(error: unknown): Error {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') {
    return Object.assign(new Error('Password-protected PDF requires a password before it can be read.'), {
      code: 'password_required'
    })
  }
  if (name === 'InvalidPDFException' || name === 'MissingPDFException') {
    return Object.assign(new Error('The PDF is damaged or invalid.'), { code: 'invalid_document' })
  }
  return error instanceof Error ? error : new Error(String(error))
}
