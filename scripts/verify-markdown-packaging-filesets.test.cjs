const { test } = require('node:test')
const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const config = require('../electron-builder.cjs')
const { PACKAGES, ASSETS } = require('./verify-packaged-markdown-rendering.cjs')
const { markdownPackageFileSets, verifyCollectedMarkdownFiles } = require('./verify-markdown-packaging-filesets.cjs')
const { EXPLICIT_RUNTIME_PACKAGES, OFFLINE_RENDERING_PACKAGES, RUNTIME_ENTRY_ASSETS } = require('./runtime-package-packaging.cjs')
const { CANVAS_NATIVE_TARGETS, canvasRuntimePackages, canvasLockEntry, verifyCanvasRuntimePackages, ensureCanvasRuntimePackages, verifyPackagedCanvas, canvasSmokeScript } = require('./runtime-package-packaging.cjs')

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

function canvasFixture(platform, arch) {
  const lock = { packages: {} }
  const files = new Map()
  for (const name of canvasRuntimePackages(platform, arch)) {
    const packageName = name.slice(name.lastIndexOf('@napi-rs/'))
    const version = name.includes('/node_modules/') ? '1.1.0' : '0.1.100'
    const native = packageName !== '@napi-rs/canvas'
    const main = native ? `${CANVAS_NATIVE_TARGETS[`${platform}-${arch}`]}.node` : 'index.js'
    const metadata = { name: packageName, version, license: 'MIT', main,
      ...(native ? {} : { optionalDependencies: { [`@napi-rs/${CANVAS_NATIVE_TARGETS[`${platform}-${arch}`]}`]: version } }) }
    const base = `node_modules/${name}`
    lock.packages[base] = { version, license: 'MIT', integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      resolved: `https://registry.npmjs.org/${packageName}/-/${packageName.slice('@napi-rs/'.length)}-${version}.tgz` }
    files.set(`${base}/package.json`, Buffer.from(JSON.stringify(metadata)))
    files.set(`${base}/${main}`, Buffer.from('fixture'))
    if (!native) files.set(`${base}/LICENSE`, Buffer.from('MIT'))
  }
  const read = path => { assert(files.has(path), `Missing fixture ${path}`); return files.get(path) }
  return { lock, files, read }
}

test('canvas FileSets retain root and both PPT peer versions at their original runtime paths', () => {
  for (const name of canvasRuntimePackages()) {
    const path = `node_modules/${name}`
    const sets = config.files.filter(entry => typeof entry === 'object' && entry.from === path)
    assert.equal(sets.length, 1)
    assert.equal(sets[0].to, path)
    assert(sets[0].filter.includes('**/*'))
  }
  const smoke = canvasSmokeScript('/packaged/Resources')
  assert(smoke.includes('node_modules/pptx-vanilla-viewer/package.json'))
  assert(smoke.includes('node_modules/ooxml-ui/package.json'))
  assert(smoke.includes('createCanvas(8, 8)'))
  assert(smoke.includes('"version":"0.1.100"'))
  assert(smoke.includes('"version":"1.1.0"'))
})

test('canvas package verification covers target bindings and rejects root-version fallback', () => {
  for (const target of Object.keys(CANVAS_NATIVE_TARGETS)) {
    const [platform, arch] = target.split('-')
    const fixture = canvasFixture(platform, arch)
    assert.equal(verifyCanvasRuntimePackages(fixture.read, fixture.lock, platform, arch).packages, 6)
    const nested = 'node_modules/pptx-vanilla-viewer/node_modules/@napi-rs/canvas/package.json'
    fixture.files.set(nested, fixture.files.get('node_modules/@napi-rs/canvas/package.json'))
    assert.throws(() => verifyCanvasRuntimePackages(fixture.read, fixture.lock, platform, arch), /identity mismatch/)
  }
  assert.throws(() => canvasRuntimePackages('linux', 'riscv64'), /Unsupported target/)
  const fixture = canvasFixture('darwin', 'arm64')
  fixture.lock.packages['node_modules/@napi-rs/canvas'].resolved = 'https://untrusted.example/canvas.tgz'
  assert.throws(() => canvasLockEntry(fixture.lock, '@napi-rs/canvas'), /Unexpected locked source/)
})

test('missing host or cross-architecture canvas packages restore only exact integrity-checked lock entries', async t => {
  const root = mkdtempSync(join(tmpdir(), 'railwise-canvas-packaging-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = canvasFixture('darwin', 'x64')
  const archives = new Map()
  const tar = require('tar')
  for (const name of canvasRuntimePackages('darwin', 'x64')) {
    const base = `node_modules/${name}`
    const entry = fixture.lock.packages[base]
    if (!archives.has(entry.resolved)) {
      const staging = join(root, `archive-${archives.size}`)
      mkdirSync(join(staging, 'package'), { recursive: true })
      for (const [path, bytes] of fixture.files) {
        if (path.startsWith(`${base}/`)) writeFileSync(join(staging, 'package', path.slice(base.length + 1)), bytes)
      }
      const archive = join(staging, 'package.tgz')
      await tar.c({ gzip: true, file: archive, cwd: staging }, ['package'])
      archives.set(entry.resolved, readFileSync(archive))
    }
    entry.integrity = `sha512-${createHash('sha512').update(archives.get(entry.resolved)).digest('base64')}`
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(fixture.lock))
  let downloads = 0
  const report = await ensureCanvasRuntimePackages(root, 'darwin', 'x64', async url => { downloads++; return archives.get(url) })
  assert.equal(report.packages, 6)
  assert.equal(downloads, 4)
  await ensureCanvasRuntimePackages(root, 'darwin', 'x64', async () => { throw new Error('Existing packages must not download.') })
  const corrupted = join(root, 'corrupted')
  mkdirSync(corrupted)
  writeFileSync(join(corrupted, 'package-lock.json'), JSON.stringify(fixture.lock))
  await assert.rejects(ensureCanvasRuntimePackages(corrupted, 'darwin', 'x64', async () => Buffer.from('changed')), /integrity mismatch/)
})

test('packaged canvas verification rejects an ASAR with the nested peer packages omitted', async t => {
  const root = mkdtempSync(join(tmpdir(), 'railwise-canvas-asar-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fixture = canvasFixture('win32', 'x64')
  const source = join(root, 'source')
  const resources = join(root, 'resources')
  mkdirSync(resources)
  for (const [path, bytes] of fixture.files) {
    mkdirSync(join(source, path, '..'), { recursive: true })
    writeFileSync(join(source, path), bytes)
  }
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(fixture.lock))
  const asar = require('@electron/asar')
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.equal(verifyPackagedCanvas(resources, 'win32', 'x64', root).packages, 6)
  rmSync(join(source, 'node_modules/pptx-vanilla-viewer/node_modules/@napi-rs/canvas'), { recursive: true })
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.throws(() => verifyPackagedCanvas(resources, 'win32', 'x64', root), /not found|ENOENT/)
})
