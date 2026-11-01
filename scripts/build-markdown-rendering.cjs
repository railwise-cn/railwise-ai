const { build } = require('esbuild')
const { createHash } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const VERSIONS = { mermaid: '11.16.1', dompurify: '3.4.17', katex: '0.16.46' }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function validateMermaidInputs(inputs) {
  const paths = Object.keys(inputs).map(name => name.replaceAll('\\', '/'))
  if (!paths.includes('node_modules/mermaid/dist/mermaid.core.mjs')) throw new Error('The offline renderer must use Mermaid core ESM.')
  if (paths.some(name => /mermaid\/(?:dist\/)?(?:mermaid(?:\.min)?\.js|mermaid\.esm|chunks\/mermaid\.esm)/.test(name))) {
    throw new Error('A prebundled Mermaid dependency entered the offline renderer.')
  }
  for (const name of ['dompurify', 'katex']) {
    const matching = paths.filter(path => path.includes(`/node_modules/${name}/`) || path.startsWith(`node_modules/${name}/`))
    if (!matching.length || matching.some(path => !path.startsWith(`node_modules/${name}/`) || path.slice('node_modules/'.length).includes('/node_modules/'))) {
      throw new Error(`The offline renderer must resolve the reviewed root ${name}.`)
    }
  }
}

async function buildMarkdownRendering(root = resolve(__dirname, '..'), output = join(root, 'out/markdown-rendering')) {
  for (const [name, version] of Object.entries(VERSIONS)) {
    const metadata = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    if (metadata.version !== version) throw new Error(`Unreviewed offline rendering dependency: ${name}.`)
  }
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: "export { default } from './node_modules/mermaid/dist/mermaid.core.mjs'", resolveDir: root, sourcefile: 'offline-mermaid-entry.js' },
    bundle: true, write: false, metafile: true, platform: 'browser', target: 'chrome140',
    format: 'iife', globalName: 'railwiseMermaid', minify: true, legalComments: 'eof',
    footer: { js: ';var mermaid=railwiseMermaid.default;' }, logLevel: 'warning'
  })
  validateMermaidInputs(result.metafile.inputs)
  if (Object.values(result.metafile.outputs).some(item => item.imports.length)) throw new Error('The offline renderer contains external imports.')
  const bytes = result.outputFiles[0].contents
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'mermaid.js'), bytes)
  const inputs = Object.fromEntries(Object.entries(result.metafile.inputs).map(([name, info]) => [name, {
    bytes: info.bytes,
    sha256: sha256(name === 'offline-mermaid-entry.js' ? Buffer.from("export { default } from './node_modules/mermaid/dist/mermaid.core.mjs'") : readFileSync(join(root, name)))
  }]))
  const report = { schemaVersion: 1, entry: 'mermaid/dist/mermaid.core.mjs', versions: VERSIONS, sha256: sha256(bytes), bytes: bytes.length, inputs }
  writeFileSync(join(output, 'mermaid-build.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Offline Mermaid core built: ${bytes.length} bytes, DOMPurify ${VERSIONS.dompurify}, KaTeX ${VERSIONS.katex}.`)
  return report
}

if (require.main === module) buildMarkdownRendering().catch(error => { console.error(error); process.exitCode = 1 })
module.exports = { buildMarkdownRendering, validateMermaidInputs, VERSIONS, sha256 }
