import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** Parse the visible text, rather than searching compressed PDF bytes. */
export async function readReportPdf(bytes: Uint8Array): Promise<{ text: string; pageCount: number; pages: string[] }> {
  const document = await getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, isEvalSupported: false }).promise
  try {
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => 'str' in item ? item.str : '').join(''))
    }
    return { text: pages.join('\n'), pageCount: document.numPages, pages }
  } finally { await document.destroy() }
}
