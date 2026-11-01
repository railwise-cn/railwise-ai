const { test } = require('node:test')
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const config = require('../electron-builder.cjs')
const { PACKAGES, ASSETS } = require('./verify-packaged-markdown-rendering.cjs')
const { markdownPackageFileSets, verifyCollectedMarkdownFiles } = require('./verify-markdown-packaging-filesets.cjs')
const { EXPLICIT_RUNTIME_PACKAGES, OFFLINE_RENDERING_PACKAGES, RUNTIME_ENTRY_ASSETS } = require('./runtime-package-packaging.cjs')

function collectedFixture() {
  const root = resolve('/runtime-source')
  const destination = join(root, 'app')
  const fileSets = [...EXPLICIT_RUNTIME_PACKAGES, ...OFFLINE_RENDERING_PACKAGES].map((name) => {
    const packageRoot = `node_modules/${name}`
    const paths = new Set([
      `${packageRoot}/package.json`, `${packageRoot}/LICENSE`,
      ...[...ASSETS, ...RUNTIME_ENTRY_ASSETS].filter(asset => asset.startsWith(`${packageRoot}/`))
    ])
    return { src: join(root, packageRoot), destination: join(destination, packageRoot), files: [...paths].map(asset => join(root, asset)) }
  })
  return { root, destination, fileSets }
}

test('offline runtime packages use independent root FileSets instead of main-walker globs', () => {
  const fileSets = markdownPackageFileSets(config)
  assert.deepEqual(fileSets.map(entry => entry.from), [...EXPLICIT_RUNTIME_PACKAGES, ...OFFLINE_RENDERING_PACKAGES].map(name => `node_modules/${name}`))
  assert.deepEqual(fileSets.find(entry => entry.from === 'node_modules/mermaid').filter.filter(pattern => !pattern.startsWith('!')), ['package.json', 'LICENSE'])
  for (const name of [...EXPLICIT_RUNTIME_PACKAGES, ...OFFLINE_RENDERING_PACKAGES]) {
    const path = `node_modules/${name}`
    assert.throws(() => markdownPackageFileSets({ files: config.files.filter(entry => typeof entry !== 'object' || entry.from !== path).concat(`${path}/**/*`) }), /requires one explicit root FileSet/)
    assert.throws(() => markdownPackageFileSets({ files: config.files.map(entry => typeof entry === 'object' && entry.from === path ? { ...entry, to: `nested/${path}` } : entry) }), /retain its root runtime path/)
  }
})

test('collection gate rejects missing root assets, nested copies, and redirected package sources', () => {
  const complete = collectedFixture()
  assert(verifyCollectedMarkdownFiles(complete.root, complete.destination, complete.fileSets).collected > 0)
  for (const name of Object.keys(PACKAGES)) {
    const fixture = collectedFixture()
    const target = fixture.fileSets.find(entry => entry.src === join(fixture.root, 'node_modules', name))
    target.files = target.files.filter(file => !file.endsWith('package.json'))
    assert.throws(() => verifyCollectedMarkdownFiles(fixture.root, fixture.destination, fixture.fileSets), /did not collect root asset/)
  }
  const nested = collectedFixture()
  nested.fileSets[0].destination = join(nested.destination, 'node_modules', 'nested', 'node_modules', 'katex')
  assert.throws(() => verifyCollectedMarkdownFiles(nested.root, nested.destination, nested.fileSets), /did not collect root asset/)
  const redirected = collectedFixture()
  redirected.fileSets[0].files = redirected.fileSets[0].files.map(file => file.replace('node_modules', 'external-node_modules'))
  redirected.fileSets[0].src = redirected.fileSets[0].src.replace('node_modules', 'external-node_modules')
  assert.throws(() => verifyCollectedMarkdownFiles(redirected.root, redirected.destination, redirected.fileSets), /did not collect root asset/)
})

test('collection gate rejects upstream Mermaid code and dependency developer artifacts', () => {
  const mermaid = collectedFixture()
  const packageSet = mermaid.fileSets.find(entry => entry.src.endsWith('mermaid'))
  packageSet.files.push(join(packageSet.src, 'dist', 'mermaid.min.js'))
  assert.throws(() => verifyCollectedMarkdownFiles(mermaid.root, mermaid.destination, mermaid.fileSets), /Unreviewed upstream Mermaid asset/)
  const developer = collectedFixture()
  developer.fileSets[0].files.push(join(developer.fileSets[0].src, 'dist', 'test-results', 'report.json'))
  assert.throws(() => verifyCollectedMarkdownFiles(developer.root, developer.destination, developer.fileSets), /Developer artifact selected/)
})
