const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const asar = require('@electron/asar')
const { validateMermaidInputs, VERSIONS, sha256 } = require('./build-markdown-rendering.cjs')

const PACKAGES = { katex: '0.16.46', mermaid: '11.16.1', 'markdown-it-footnote': '4.0.0' }
const ASSETS = [
  'node_modules/katex/dist/katex.min.css',
  'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',
  'out/markdown-rendering/mermaid.js',
  'out/markdown-rendering/mermaid-build.json',
  'node_modules/markdown-it-footnote/index.mjs',
  'node_modules/markdown-it-footnote/dist/index.cjs.js'
]
const NOTICES = ['NOTICE.md', 'KaTeX-LICENSE.txt', 'Mermaid-LICENSE.txt', 'DOMPurify-LICENSE.txt', 'markdown-it-footnote-LICENSE.txt']

function verifyPackagedMarkdownRendering(resourcesDirectory) {
  const archive = join(resourcesDirectory, 'app.asar')
  let bytes = 0
  const readAsset = (relativePath) => {
    let content
    try { content = asar.extractFile(archive, relativePath) } catch {
      throw new Error(`[markdown-rendering] Missing bundled asset: ${relativePath}`)
    }
    if (!content.length) throw new Error(`[markdown-rendering] Empty bundled asset: ${relativePath}`)
    bytes += content.length
    return content
  }
  for (const [name, version] of Object.entries(PACKAGES)) {
    const metadata = JSON.parse(readAsset(`node_modules/${name}/package.json`).toString('utf8'))
    if (metadata.version !== version || metadata.license !== 'MIT') {
      throw new Error(`[markdown-rendering] Unexpected ${name} version or license.`)
    }
    readAsset(`node_modules/${name}/LICENSE`)
  }
  for (const asset of ASSETS) readAsset(asset)
  const bundle = readAsset('out/markdown-rendering/mermaid.js')
  const report = JSON.parse(readAsset('out/markdown-rendering/mermaid-build.json').toString('utf8'))
  if (report.schemaVersion !== 1 || report.entry !== 'mermaid/dist/mermaid.core.mjs'
    || JSON.stringify(report.versions) !== JSON.stringify(VERSIONS)
    || report.bytes !== bundle.length || report.sha256 !== sha256(bundle)) throw new Error('[markdown-rendering] Offline Mermaid provenance mismatch.')
  validateMermaidInputs(report.inputs)
  if (asar.listPackage(archive).some(name => /\/node_modules\/mermaid\/dist\//.test(name))) throw new Error('[markdown-rendering] Unreviewed upstream Mermaid browser assets remain packaged.')
  for (const notice of NOTICES) {
    const content = readFileSync(join(resourcesDirectory, 'third-party', 'markdown-rendering', notice))
    if (!content.length) throw new Error(`[markdown-rendering] Empty notice: ${notice}`)
  }
  return { packages: PACKAGES, assets: ASSETS.length, notices: NOTICES.length, bytes }
}

if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: node verify-packaged-markdown-rendering.cjs <Resources directory>')
  console.log(JSON.stringify(verifyPackagedMarkdownRendering(resolve(process.argv[2])), null, 2))
}
module.exports = { verifyPackagedMarkdownRendering, PACKAGES, ASSETS, NOTICES }
