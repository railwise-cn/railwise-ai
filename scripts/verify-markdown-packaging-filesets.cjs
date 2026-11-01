const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { dirname, join, relative, resolve } = require('node:path')
const { ASSETS, PACKAGES, katexFontAssets } = require('./verify-packaged-markdown-rendering.cjs')
const { isDependencyArtifact } = require('./dependency-artifact-policy.cjs')
const { EXPLICIT_RUNTIME_PACKAGES, OFFLINE_RENDERING_PACKAGES, RUNTIME_ENTRY_ASSETS } = require('./runtime-package-packaging.cjs')

function markdownPackageFileSets(config) {
  return [...EXPLICIT_RUNTIME_PACKAGES, ...OFFLINE_RENDERING_PACKAGES].map((name) => {
    const packageRoot = `node_modules/${name}`
    const matches = config.files.filter((entry) => typeof entry === 'object' && entry.from === packageRoot)
    assert.equal(matches.length, 1, `[markdown-rendering] ${name} requires one explicit root FileSet.`)
    assert.equal(matches[0].to, packageRoot, `[markdown-rendering] ${name} FileSet must retain its root runtime path.`)
    return matches[0]
  })
}

function verifyCollectedMarkdownFiles(root, destination, fileSets, fonts = []) {
  const files = new Map()
  for (const fileSet of fileSets) {
    for (const file of fileSet.files) {
      const target = relative(destination, join(fileSet.destination, relative(fileSet.src, file))).replaceAll('\\', '/')
      assert(!target.startsWith('../'), '[markdown-rendering] Runtime asset destination escaped the app.')
      assert(!isDependencyArtifact(target), `[markdown-rendering] Developer artifact selected: ${target}`)
      if (target.startsWith('node_modules/mermaid/')) {
        assert(['node_modules/mermaid/package.json', 'node_modules/mermaid/LICENSE'].includes(target),
          `[markdown-rendering] Unreviewed upstream Mermaid asset selected: ${target}`)
      }
      files.set(target, file)
    }
  }
  const required = [
    ...RUNTIME_ENTRY_ASSETS,
    ...fonts,
    ...EXPLICIT_RUNTIME_PACKAGES.map(name => `node_modules/${name}/package.json`),
    ...Object.keys(PACKAGES).flatMap(name => [`node_modules/${name}/package.json`, `node_modules/${name}/LICENSE`]),
    ...ASSETS.filter(asset => asset.startsWith('node_modules/'))
  ]
  for (const asset of required) {
    assert.equal(files.get(asset), join(root, asset), `[markdown-rendering] Builder did not collect root asset: ${asset}`)
  }
  return { required: required.length, collected: files.size }
}

async function verifyMarkdownPackagingFileSets(root = resolve(__dirname, '..'), builderEntry = process.argv[1]) {
  // The hook runs inside the pinned electron-builder CLI. Resolve its actual
  // engine rather than duplicating minimatch or AppFileWalker semantics.
  const builderPaths = [dirname(resolve(builderEntry)), root]
  const { getMainFileMatchers } = require(require.resolve('app-builder-lib/out/fileMatcher.js', { paths: builderPaths }))
  const { computeFileSets } = require(require.resolve('app-builder-lib/out/util/appFileCopier.js', { paths: builderPaths }))
  const config = require(join(root, 'electron-builder.cjs'))
  const selected = markdownPackageFileSets(config)
  // FileSet collection is read-only; this destination is only used to verify
  // the paths which the ASAR packager will write later in the real build.
  const destination = join(root, 'dist', '.markdown-fileset-verification')
  const info = { projectDir: root, buildResourcesDir: 'build', config, debugLogger: { isEnabled: false } }
  const packager = { info }
  const matchers = getMainFileMatchers(root, destination, value => value, {}, packager, join(root, 'dist'), false)
    .filter(matcher => selected.some(entry => matcher.from === join(root, entry.from)))
  assert.equal(matchers.length, selected.length, '[markdown-rendering] Explicit runtime FileSets were not created.')
  const fileSets = await computeFileSets(matchers, null, packager, false)
  const fonts = katexFontAssets(readFileSync(join(root, 'node_modules/katex/dist/katex.min.css'), 'utf8'))
  return { ...verifyCollectedMarkdownFiles(root, destination, fileSets, fonts), fonts: fonts.length }
}

if (require.main === module) {
  verifyMarkdownPackagingFileSets(resolve(process.argv[2] || join(__dirname, '..')), process.argv[3])
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
module.exports = { markdownPackageFileSets, verifyCollectedMarkdownFiles, verifyMarkdownPackagingFileSets }
