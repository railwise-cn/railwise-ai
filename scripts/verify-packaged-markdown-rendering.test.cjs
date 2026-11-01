const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { join, dirname } = require('node:path')
const { tmpdir } = require('node:os')
const asar = require('@electron/asar')
const { verifyPackagedMarkdownRendering, PACKAGES, ASSETS, NOTICES } = require('./verify-packaged-markdown-rendering.cjs')

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
    for (const notice of NOTICES) await put(join(resources, 'third-party', 'markdown-rendering', notice), 'MIT Notice')
    await run({ source, resources })
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('the actual ASAR contains offline renderer assets and notices', async () => fixture(async ({ source, resources }) => {
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.equal(verifyPackagedMarkdownRendering(resources).assets, ASSETS.length)
}))

test('packaging fails when a local math font is missing', async () => fixture(async ({ source, resources }) => {
  await rm(join(source, 'node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2'))
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.throws(() => verifyPackagedMarkdownRendering(resources), /Missing bundled asset.*KaTeX_Main-Regular/)
}))
