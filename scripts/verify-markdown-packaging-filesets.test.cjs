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
const { CANVAS_NATIVE_TARGETS, canvasRuntimePackages, canvasNativePackageFiles, canvasLockEntry, verifyCanvasRuntimePackages, ensureCanvasRuntimePackages, verifyPackagedCanvas, canvasCallerPackageName, packagedCanvasCallerManifests, canvasSmokeScript } = require('./runtime-package-packaging.cjs')

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
  for (const packageName of canvasRuntimePackages(platform, arch)) {
    const version = '1.1.0'
    const native = packageName !== '@napi-rs/canvas'
    const main = native ? `${CANVAS_NATIVE_TARGETS[`${platform}-${arch}`]}.node` : 'index.js'
    const metadata = { name: packageName, version, license: 'MIT', main,
      ...(native ? {} : { optionalDependencies: { [`@napi-rs/${CANVAS_NATIVE_TARGETS[`${platform}-${arch}`]}`]: version } }) }
    const base = `node_modules/${packageName}`
    lock.packages[base] = { version, license: 'MIT', integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      resolved: `https://registry.npmjs.org/${packageName}/-/${packageName.slice('@napi-rs/'.length)}-${version}.tgz` }
    files.set(`${base}/package.json`, Buffer.from(JSON.stringify(metadata)))
    files.set(`${base}/${main}`, Buffer.from('fixture'))
    if (!native) files.set(`${base}/LICENSE`, Buffer.from('MIT'))
  }
  const read = path => { assert(files.has(path), `Missing fixture ${path}`); return files.get(path) }
  return { lock, files, read }
}

test('canvas smoke discovers the actual packaged callers after dependency hoisting', () => {
  const path = 'node_modules/@napi-rs/canvas'
  const sets = config.files.filter(entry => typeof entry === 'object' && entry.from.endsWith(path))
  assert.equal(sets.length, 1)
  assert.equal(sets[0].from, path)
  assert.equal(sets[0].to, path)
  assert(sets[0].filter.includes('**/*'))

  const lock = require('../package-lock.json')
  const callers = Object.entries(lock.packages)
    .filter(([packagePath, entry]) => packagePath && (entry.optionalDependencies?.['@napi-rs/canvas'] || entry.peerDependencies?.['@napi-rs/canvas']))
  const packageFiles = new Map()
  const archivePaths = []
  callers.forEach(([packagePath, entry]) => {
    const packageName = canvasCallerPackageName(packagePath)
    const actualPackagePath = packagePath.startsWith('node_modules/ooxml-ui/node_modules/')
      ? `node_modules/${packageName}`
      : packagePath
    const actualManifestPath = `${actualPackagePath}/package.json`
    const metadata = { name: packageName, version: entry.version,
      ...(entry.optionalDependencies?.['@napi-rs/canvas'] ? { optionalDependencies: { '@napi-rs/canvas': entry.optionalDependencies['@napi-rs/canvas'] } } : {}),
      ...(entry.peerDependencies?.['@napi-rs/canvas'] ? { peerDependencies: { '@napi-rs/canvas': entry.peerDependencies['@napi-rs/canvas'] } } : {}) }
    packageFiles.set(actualManifestPath, Buffer.from(JSON.stringify(metadata)))
    archivePaths.push(`/${actualManifestPath}`)
  })
  const packagedCallers = packagedCanvasCallerManifests(archivePaths,
    path => packageFiles.get(path), lock)
  assert.equal(packagedCallers.length, 5)
  assert(packagedCallers.includes('node_modules/emf-converter/package.json'))
  assert(!packagedCallers.includes('node_modules/ooxml-ui/node_modules/emf-converter/package.json'))

  const smoke = canvasSmokeScript('/packaged/Resources', packagedCallers)
  assert(smoke.includes('node_modules/pdfjs-dist/package.json'))
  assert(smoke.includes('node_modules/ooxml-ui/node_modules/ooxml-core/package.json') || smoke.includes('node_modules/ooxml-core/package.json'))
  assert(smoke.includes('node_modules/pptx-vanilla-viewer/node_modules/emf-converter/package.json'))
  assert(smoke.includes('createCanvas(8, 8)'))
  assert(smoke.includes('loadCanvas.resolve'))
  assert(smoke.includes('"1.1.0"'))
  assert(smoke.includes('CALLERS=5'))
  assert.throws(() => canvasSmokeScript('/packaged/Resources'), /caller paths are required/)
})

test('canvas caller discovery reads hoisted manifests from an actual ASAR archive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'railwise-canvas-callers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const manifestPath = join(source, 'node_modules', 'emf-converter', 'package.json')
  mkdirSync(join(source, 'node_modules', 'emf-converter'), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify({ name: 'emf-converter', version: '4.28.1',
    optionalDependencies: { '@napi-rs/canvas': '1.1.0' } }))
  const archive = join(root, 'app.asar')
  const asar = require('@electron/asar')
  await asar.createPackage(source, archive)
  const lock = { packages: { 'node_modules/ooxml-ui/node_modules/emf-converter': {
    version: '4.28.1', optionalDependencies: { '@napi-rs/canvas': '1.1.0' }
  } } }

  const callers = packagedCanvasCallerManifests(asar.listPackage(archive),
    path => asar.extractFile(archive, join(...path.split('/'))), lock)
  assert.deepEqual(callers, ['node_modules/emf-converter/package.json'])
})

test('packaged canvas smoke rejects missing or unlocked caller packages', () => {
  const lock = require('../package-lock.json')
  const callers = Object.entries(lock.packages)
    .filter(([packagePath, entry]) => packagePath && (entry.optionalDependencies?.['@napi-rs/canvas'] || entry.peerDependencies?.['@napi-rs/canvas']))
  const packageFiles = new Map()
  const archivePaths = callers.map(([packagePath, entry]) => {
    const packageName = canvasCallerPackageName(packagePath)
    const manifestPath = `${packagePath}/package.json`
    packageFiles.set(manifestPath, Buffer.from(JSON.stringify({ name: packageName, version: entry.version,
      optionalDependencies: entry.optionalDependencies, peerDependencies: entry.peerDependencies })))
    return `/${manifestPath}`
  })
  const read = path => packageFiles.get(path)

  assert.throws(() => packagedCanvasCallerManifests(archivePaths.slice(1), read, lock), /Missing packaged Canvas caller/)
  const unlockedPaths = [...archivePaths, '/node_modules/unreviewed/package.json']
  packageFiles.set('node_modules/unreviewed/package.json', Buffer.from(JSON.stringify({ name: 'unreviewed', version: '1.0.0',
    peerDependencies: { '@napi-rs/canvas': '^1.1.0' } })))
  assert.throws(() => packagedCanvasCallerManifests(unlockedPaths, read, lock), /not in the lockfile/)
})

test('canvas native FileSets select the build target architecture without an environment override', () => {
  const originalArch = process.env.WORKWISE_SIDECAR_ARCH
  delete process.env.WORKWISE_SIDECAR_ARCH
  try {
    for (const target of Object.keys(CANVAS_NATIVE_TARGETS)) {
      const [platform, arch] = target.split('-')
      const key = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'linux'
      assert.deepEqual(config[key].files, canvasNativePackageFiles(platform))
      const actual = config[key].files.map(entry => ({ ...entry,
        from: entry.from.replaceAll('${arch}', arch), to: entry.to.replaceAll('${arch}', arch) }))
      assert.deepEqual(actual.map(entry => entry.from), canvasRuntimePackages(platform, arch)
        .filter(name => !name.endsWith('/canvas')).map(name => `node_modules/${name}`))
      assert(actual.every(entry => entry.to === entry.from))
    }
    const sameConfig = canvasNativePackageFiles('darwin')
    assert(sameConfig.every(entry => entry.from.includes('${arch}')))
    assert(sameConfig.every(entry => entry.from.replaceAll('${arch}', 'x64').includes('canvas-darwin-x64')))
    assert(sameConfig.every(entry => entry.from.replaceAll('${arch}', 'arm64').includes('canvas-darwin-arm64')))
  } finally {
    if (originalArch === undefined) delete process.env.WORKWISE_SIDECAR_ARCH
    else process.env.WORKWISE_SIDECAR_ARCH = originalArch
  }
})

test('canvas package verification covers target bindings and rejects a mismatched version', () => {
  for (const target of Object.keys(CANVAS_NATIVE_TARGETS)) {
    const [platform, arch] = target.split('-')
    const fixture = canvasFixture(platform, arch)
    assert.equal(verifyCanvasRuntimePackages(fixture.read, fixture.lock, platform, arch).packages, 2)
    const root = 'node_modules/@napi-rs/canvas/package.json'
    const incompatible = JSON.parse(fixture.files.get(root).toString('utf8'))
    incompatible.version = '0.1.100'
    fixture.files.set(root, Buffer.from(JSON.stringify(incompatible)))
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
  assert.equal(report.packages, 2)
  assert.equal(downloads, 2)
  await ensureCanvasRuntimePackages(root, 'darwin', 'x64', async () => { throw new Error('Existing packages must not download.') })
  const corrupted = join(root, 'corrupted')
  mkdirSync(corrupted)
  writeFileSync(join(corrupted, 'package-lock.json'), JSON.stringify(fixture.lock))
  await assert.rejects(ensureCanvasRuntimePackages(corrupted, 'darwin', 'x64', async () => Buffer.from('changed')), /integrity mismatch/)
})

test('packaged canvas verification rejects an ASAR without the target binding', async t => {
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
  assert.equal(verifyPackagedCanvas(resources, 'win32', 'x64', root).packages, 2)
  rmSync(join(source, 'node_modules/@napi-rs/canvas-win32-x64-msvc'), { recursive: true })
  await asar.createPackage(source, join(resources, 'app.asar'))
  assert.throws(() => verifyPackagedCanvas(resources, 'win32', 'x64', root), /not found|ENOENT/)
})
