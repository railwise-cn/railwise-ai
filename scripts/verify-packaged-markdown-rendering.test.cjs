const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { join, dirname } = require('node:path')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const asar = require('@electron/asar')
const { verifyPackagedMarkdownRendering, normalizeArchiveEntry, hasUpstreamMermaidAssets, PACKAGES, ASSETS, NOTICES } = require('./verify-packaged-markdown-rendering.cjs')
const { VERSIONS, sha256 } = require('./build-markdown-rendering.cjs')

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'railwise-markdown-assets-'))
  const source = join(root, 'source'), resources = join(root, 'Resources')
  const put = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  try {
    await mkdir(resources, { recursive: true })
    for (const [name, version] of Object.entries(PACKAGES)) {
      await put(join(source, 'node_modules', name, 'package.json'), JSON.stringify({ version, license: 'MIT' }))
      await put(join(source, 'node_modules', name, 'LICENSE'), 'MIT License')
    }
    for (const asset of ASSETS) await put(join(source, asset), 'local asset')
    await put(join(source, 'out/markdown-rendering/mermaid-build.json'), JSON.stringify({ schemaVersion: 1,
      entry: 'mermaid/dist/mermaid.core.mjs', versions: VERSIONS, bytes: 11, sha256: sha256('local asset'),
      inputs: { 'node_modules/mermaid/dist/mermaid.core.mjs': {}, 'node_modules/dompurify/dist/purify.es.mjs': {}, 'node_modules/katex/dist/katex.mjs': {} } }))
    for (const notice of NOTICES) await put(join(resources, 'third-party', 'markdown-rendering', notice), 'MIT Notice')
    await run({ source, resources })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('the actual ASAR contains offline renderer assets and notices', async () => fixture(async ({ source, resources }) => {
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.equal(verifyPackagedMarkdownRendering(resources).assets, ASSETS.length)
}))

test('Windows archive paths read real ASAR metadata and reject upstream Mermaid entries', async () => fixture(async ({ source, resources }) => {
  const archive = join(resources, 'app.asar')
  await asar.createPackage(source, archive)
  // Emulate only the Windows archive namespace in a separate process. Files
  // stay on the real host filesystem and the real ASAR header is exercised.
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const asar = require('@electron/asar');
    const { Filesystem } = require(require.resolve('@electron/asar').replace(/asar\\.js$/, 'filesystem.js'));
    const { normalizeArchiveEntry } = require(${JSON.stringify(join(__dirname, 'verify-packaged-markdown-rendering.cjs'))});
    const archive = process.argv[1];
    const header = asar.getRawHeader(archive);
    const filesystem = new Filesystem(archive);
    filesystem.setHeader(header.header, header.headerSize);
    path.dirname = path.win32.dirname;
    path.basename = path.win32.basename;
    path.sep = path.win32.sep;
    assert.throws(() => filesystem.getFile('node_modules/katex/package.json'));
    assert(Number.isInteger(filesystem.getFile(normalizeArchiveEntry('node_modules/katex/package.json', path.sep)).size));
  `, archive], { cwd: join(__dirname, '..'), stdio: 'pipe' })
  assert.equal(normalizeArchiveEntry('\\node_modules\\katex\\package.json', '/'), 'node_modules/katex/package.json')
  assert.equal(hasUpstreamMermaidAssets(['\\node_modules\\mermaid\\dist\\mermaid.min.js']), true)
  assert.equal(hasUpstreamMermaidAssets(['/node_modules/mermaid/package.json', '\\node_modules\\mermaid\\LICENSE']), false)
}))

test('packaging rejects a script changed after its build receipt', async () => fixture(async ({ source, resources }) => {
  await writeFile(join(source, 'out/markdown-rendering/mermaid.js'), 'changed script')
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.throws(() => verifyPackagedMarkdownRendering(resources), /provenance mismatch/)
}))

test('packaging rejects upstream prebundled Mermaid files and nested sanitizer inputs', async () => fixture(async ({ source, resources }) => {
  await mkdir(join(source, 'node_modules/mermaid/dist'), { recursive: true })
  await writeFile(join(source, 'node_modules/mermaid/dist/mermaid.min.js'), 'old bundled dependencies')
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.throws(() => verifyPackagedMarkdownRendering(resources), /upstream Mermaid/)
}))

test('packaging fails when a local math font is missing', async () => fixture(async ({ source, resources }) => {
  await rm(join(source, 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2'))
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.throws(() => verifyPackagedMarkdownRendering(resources), /Missing bundled asset.*KaTeX_Main-Regular/)
}))

test('packaging checks every font referenced by the bundled math CSS', async () => fixture(async ({ source, resources }) => {
  await writeFile(join(source, 'node_modules/katex/dist/katex.min.css'), '@font-face{src:url(fonts/KaTeX_Main-Regular.woff2),url(fonts/KaTeX_Main-Bold.woff2)}')
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.throws(() => verifyPackagedMarkdownRendering(resources), /Missing bundled asset.*KaTeX_Main-Bold/)
}))
