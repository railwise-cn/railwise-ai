const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const asar = require('@electron/asar')

const PACKAGES = { katex: '0.16.46', mermaid: '11.16.1', 'markdown-it-footnote': '4.0.0' }
const ASSETS = [
  'node_modules/katex/dist/katex.min.css',
  'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2',
  'node_modules/mermaid/dist/mermaid.min.js',
  'node_modules/markdown-it-footnote/index.mjs',
  'node_modules/markdown-it-footnote/dist/index.cjs.js'
]
const NOTICES = ['NOTICE.md', 'KaTeX-LICENSE.txt', 'Mermaid-LICENSE.txt', 'markdown-it-footnote-LICENSE.txt']

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
