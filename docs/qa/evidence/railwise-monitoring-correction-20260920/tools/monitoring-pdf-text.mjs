import { readFileSync } from 'node:fs'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
const bytes = readFileSync(process.argv[2])
if (bytes.length > 32 * 1024 * 1024) throw new Error('PDF too large')
const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false }).promise
const pages = []
for (let index = 1; index <= document.numPages; index++) {
  const page = await document.getPage(index), content = await page.getTextContent()
  pages.push(content.items.filter(item => 'str' in item).map(item => item.str).join(' '))
}
await document.destroy()
process.stdout.write(JSON.stringify({ pages: pages.length, text: pages.join('\n') }) + '\n')
