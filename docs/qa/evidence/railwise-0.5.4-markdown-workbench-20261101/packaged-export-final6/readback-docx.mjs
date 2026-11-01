import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { fileURLToPath } from 'node:url'

const destination = path.dirname(fileURLToPath(import.meta.url))
const workspace = '/Users/wangjiawei/Documents/WorkWise/dist/railwise-0.5.4-markdown-workbench-private-final/home/workspace/markdown-workbench'
const sourcePath = path.join(workspace, 'export-final6.docx')
const fixturePath = path.join(workspace, 'export-check.md')
const bytes = await fs.readFile(sourcePath)
await fs.mkdir(destination, { recursive: true })
await fs.copyFile(sourcePath, path.join(destination, 'export-final6.docx'))
const fixture = await fs.readFile(fixturePath, 'utf8')
await fs.writeFile(path.join(destination, 'export-check.source.md'), fixture)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const zip = await JSZip.loadAsync(bytes)
const xml = await zip.file('word/document.xml').async('string')
// One XML-entity decode only. Decoding a second time could conceal the final5 defect.
const decodeXml = (value) => value.replace(/&(?:#x([a-f0-9]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (entity, hex, decimal, named) => {
  if (hex || decimal) return String.fromCodePoint(Number.parseInt(hex || decimal, hex ? 16 : 10))
  return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()] ?? entity
})
const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((match) => ({
  style: match[1].match(/<w:pStyle\s+w:val="([^"]+)"/)?.[1] ?? null,
  text: [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((text) => decodeXml(text[1])).join('')
}))
const documentText = paragraphs.map((paragraph) => paragraph.text).join('\n')
const expectedCode = fixture.match(/```ts\n([\s\S]*?)\n```/)?.[1] ?? ''
const sourceImage = await fs.readFile(path.join(workspace, 'assets/diagram.png'))
const media = []
for (const name of Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)) {
  const contents = await zip.file(name).async('nodebuffer')
  media.push({ name, sizeBytes: contents.length, sha256: hash(contents) })
}
const evidenceBytes = await fs.readFile(path.join(destination, 'export-final6.docx'))
const checks = {
  exactCopy: hash(bytes) === hash(evidenceBytes),
  heading: paragraphs.some((paragraph) => paragraph.style === 'Heading1' && paragraph.text === '文档工作台导出验收'),
  table: xml.includes('<w:tbl>') && documentText.includes('DB-01') && documentText.includes('1.25 mm') && documentText.includes('正常'),
  sourceImagePreserved: media.some((image) => image.sha256 === hash(sourceImage)),
  metadataHidden: !documentText.includes('title: 导出验收') && !documentText.includes('stage: reviewed'),
  codeExact: expectedCode.length > 0 && paragraphs.some((paragraph) => paragraph.text === expectedCode),
  quotesPreserved: documentText.includes("source = 'markdown'"),
  noSpuriousQuoteEntities: !documentText.includes('&#x27;markdown&#x27;') && !documentText.includes('&#39;markdown&#39;')
}
const result = {
  schema: 'railwise.markdown-workbench.packaged-docx-readback.v1',
  inspectedAt: new Date().toISOString(),
  provenance: {
    product: 'RailWise AI', version: '0.5.4', candidate: 'final6',
    sourceHead: '1864d44d23f5328d5fc435edec9323b57db53ece',
    asarSha256: '1661b8e597be4c69634e0c9b1ebdc4941f7defed6bbc96508e5bf6f103dafe07',
    sourcePath, exportOrigin: 'Fresh filename exported by parent agent through installed final6 GUI; this independent tool only copies and reads the existing file.'
  },
  file: { evidencePath: path.join(destination, 'export-final6.docx'), sizeBytes: bytes.length, sha256: hash(bytes) },
  fixture: { path: fixturePath, sha256: hash(Buffer.from(fixture)), expectedCode, imageSha256: hash(sourceImage) },
  tableCount: (xml.match(/<w:tbl>/g) || []).length,
  drawingCount: (xml.match(/<w:drawing>/g) || []).length,
  paragraphs, documentText, media, checks, allChecksPassed: Object.values(checks).every(Boolean),
  previousFinding: { id: 'PACKAGED-EXPORT-01', previousCandidate: 'final5', previousEvidence: '../packaged-export-final5/readback.json', resolvedInThisArtifact: checks.codeExact && checks.quotesPreserved && checks.noSpuriousQuoteEntities }
}
await fs.writeFile(path.join(destination, 'readback.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ file: result.file, checks, previousFinding: result.previousFinding }, null, 2))
