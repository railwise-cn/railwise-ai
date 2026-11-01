import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const requirements = readFileSync(resolve(root, 'sidecars/markitdown/requirements.lock'), 'utf8')
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const notices = readFileSync(resolve(root, 'sidecars/markitdown/THIRD_PARTY_NOTICES.md'), 'utf8')

assert(requirements.includes('932084c88679aeda901c2903a151f3ed82f86081'), 'MarkItDown must use the audited upstream commit.')
assert(/markitdown\[pdf,docx,pptx,xlsx\]/i.test(requirements), 'Only the required MarkItDown format extras may be installed.')
assert(!/(?:markitdown-ocr|pymupdf|\bfitz\b|agpl)/i.test(requirements), 'MarkItDown OCR, PyMuPDF, Fitz, and AGPL dependencies are forbidden.')
assert(lock.packages?.['node_modules/pdfjs-dist']?.version === '5.4.624', 'PDF.js must remain pinned to the audited Electron-compatible version.')
assert(lock.packages?.['node_modules/pdfjs-dist']?.license === 'Apache-2.0', 'PDF.js license metadata must be Apache-2.0.')
const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
for (const [name, version] of [['katex', '0.16.46'], ['mermaid', '11.16.1'], ['markdown-it-footnote', '4.0.0']]) {
  assert(packageJson.dependencies[name] === version, `${name} must remain pinned to the reviewed document-rendering version.`)
  assert(lock.packages?.[`node_modules/${name}`]?.version === version, `${name} lockfile version must match its reviewed pin.`)
  assert(lock.packages?.[`node_modules/${name}`]?.license === 'MIT', `${name} must retain MIT license metadata.`)
}
assert(packageJson.overrides?.dompurify === '3.4.17', 'Offline Mermaid must use the reviewed DOMPurify override.')
assert(lock.packages?.['node_modules/dompurify']?.version === '3.4.17', 'DOMPurify lockfile version must match the reviewed browser bundle.')
assert(lock.packages?.['node_modules/dompurify']?.license === '(MPL-2.0 OR Apache-2.0)', 'DOMPurify must retain its Apache-2.0 license alternative.')
const markdownNotices = readFileSync(resolve(root, 'src/asset/markdown-rendering/NOTICE.md'), 'utf8')
assert(markdownNotices.includes('DOMPurify') && markdownNotices.includes('Apache-2.0'), 'Offline rendering notices must cover DOMPurify.')
assert(readFileSync(resolve(root, 'src/asset/markdown-rendering/DOMPurify-LICENSE.txt'), 'utf8').includes('Apache License'), 'DOMPurify Apache-2.0 license text must be shipped.')
assert(!Object.keys(dependencies).some((name) => /mineru|markitdown-ocr|pymupdf/i.test(name)), 'MinerU and OCR engines must not enter the client dependency graph.')
assert(/Microsoft MarkItDown/i.test(notices) && /MinerU/i.test(notices) && /PDF\.js/i.test(notices), 'Third-party notices must cover MarkItDown, MinerU, and PDF.js.')

const sbomFlag = process.argv.indexOf('--python-sbom')
if (sbomFlag >= 0) {
  const path = process.argv[sbomFlag + 1]
  assert(path, '--python-sbom requires a JSON path.')
  const packages = JSON.parse(readFileSync(resolve(path), 'utf8'))
  assert(Array.isArray(packages), 'Python SBOM must be a JSON array.')
  const forbidden = packages.filter((entry) => {
    const license = String(entry.License ?? entry.license ?? '')
    return /agpl|affero|non[- ]?commercial|commons clause/i.test(license)
  })
  assert(forbidden.length === 0, `Forbidden Python licenses: ${forbidden.map((entry) => `${entry.Name}: ${entry.License}`).join(', ')}`)
  assert(packages.some((entry) => String(entry.Name ?? '').toLowerCase() === 'markitdown'), 'Python SBOM is missing MarkItDown.')
}

console.log('Document dependency and license policy verified.')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
