const { dependencyArtifactFilters } = require('./dependency-artifact-policy.cjs')
const { createHash, randomUUID } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const EXPLICIT_RUNTIME_PACKAGES = ['@modelcontextprotocol/sdk', 'zod-to-json-schema', 'bindings', 'file-uri-to-path']
const OFFLINE_RENDERING_PACKAGES = ['katex', 'mermaid', 'markdown-it-footnote']
const RUNTIME_ENTRY_ASSETS = [
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js',
  'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
  'node_modules/zod-to-json-schema/dist/cjs/index.js',
  'node_modules/zod-to-json-schema/dist/esm/index.js',
  'node_modules/bindings/bindings.js',
  'node_modules/file-uri-to-path/index.js'
]
const CANVAS_ROOTS = ['', 'pptx-vanilla-viewer/node_modules/', 'ooxml-ui/node_modules/']
const CANVAS_NATIVE_TARGETS = {
  'darwin-arm64': 'canvas-darwin-arm64',
  'darwin-x64': 'canvas-darwin-x64',
  'win32-x64': 'canvas-win32-x64-msvc',
  'win32-arm64': 'canvas-win32-arm64-msvc',
  'linux-x64': 'canvas-linux-x64-gnu'
}

function canvasRuntimePackages(platform = process.platform, arch = process.env.WORKWISE_SIDECAR_ARCH || process.arch) {
  const native = CANVAS_NATIVE_TARGETS[`${platform}-${arch}`]
  if (!native) throw new Error(`[canvas-packaging] Unsupported target ${platform}-${arch}.`)
  return CANVAS_ROOTS.flatMap(prefix => [`${prefix}@napi-rs/canvas`, `${prefix}@napi-rs/${native}`])
}

function canvasLockEntry(lock, name) {
  const entry = lock.packages?.[`node_modules/${name}`]
  if (!entry || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || '')) {
    throw new Error(`[canvas-packaging] Missing exact dependency integrity for ${name}.`)
  }
  const packageName = name.slice(name.lastIndexOf('@napi-rs/'))
  const expected = `https://registry.npmjs.org/${packageName}/-/${packageName.slice('@napi-rs/'.length)}-${entry.version}.tgz`
  if (entry.resolved !== expected) throw new Error(`[canvas-packaging] Unexpected locked source for ${name}.`)
  return { ...entry, packageName }
}

function verifyCanvasRuntimePackages(read, lock, platform, arch) {
  const packages = canvasRuntimePackages(platform, arch)
  for (const name of packages) {
    const entry = canvasLockEntry(lock, name)
    const base = `node_modules/${name}`
    const metadata = JSON.parse(read(`${base}/package.json`).toString('utf8'))
    if (metadata.name !== entry.packageName || metadata.version !== entry.version || metadata.license !== entry.license) {
      throw new Error(`[canvas-packaging] Locked package identity mismatch for ${name}.`)
    }
    if (!/^[A-Za-z0-9_.-]+\.(?:js|node)$/.test(metadata.main || '') || !read(`${base}/${metadata.main}`).length) {
      throw new Error(`[canvas-packaging] Missing executable package entry for ${name}.`)
    }
    if (entry.packageName === '@napi-rs/canvas') {
      const nativeName = `@napi-rs/${CANVAS_NATIVE_TARGETS[`${platform}-${arch}`]}`
      if (metadata.optionalDependencies?.[nativeName] !== entry.version) {
        throw new Error(`[canvas-packaging] Native binding version mismatch for ${name}.`)
      }
      if (!read(`${base}/LICENSE`).length) throw new Error(`[canvas-packaging] Missing license for ${name}.`)
    }
  }
  return { packages: packages.length, platform, arch }
}

async function ensureCanvasRuntimePackages(root, platform, arch, download = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
  if (!response.ok) throw new Error(`[canvas-packaging] Dependency download failed with HTTP ${response.status}.`)
  return Buffer.from(await response.arrayBuffer())
}) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const archives = new Map()
  for (const name of canvasRuntimePackages(platform, arch)) {
    const entry = canvasLockEntry(lock, name)
    const destination = join(root, 'node_modules', name)
    if (existsSync(destination)) continue
    // npm installs optional binaries only for its host architecture. Fetch only
    // the committed target package, also covering optional peer omission.
    let bytes = archives.get(entry.resolved)
    if (!bytes) {
      bytes = await download(entry.resolved)
      archives.set(entry.resolved, bytes)
    }
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (integrity !== entry.integrity) throw new Error(`[canvas-packaging] Dependency integrity mismatch for ${name}.`)
    mkdirSync(dirname(destination), { recursive: true })
    const staging = `${destination}.railwise-${randomUUID()}`
    const archive = `${staging}.tgz`
    try {
      mkdirSync(staging)
      writeFileSync(archive, bytes)
      await require('tar').x({
        file: archive, cwd: staging, strip: 1, strict: true,
        filter(path, item) {
          if (!path.startsWith('package/') || path.split('/').includes('..') || !['File', 'Directory'].includes(item.type)) {
            throw new Error('[canvas-packaging] Unsupported dependency archive entry.')
          }
          return true
        }
      })
      const metadata = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'))
      if (metadata.name !== entry.packageName || metadata.version !== entry.version) {
        throw new Error(`[canvas-packaging] Downloaded package identity mismatch for ${name}.`)
      }
      renameSync(staging, destination)
    } finally {
      rmSync(staging, { recursive: true, force: true })
      rmSync(archive, { force: true })
    }
  }
  return verifyCanvasRuntimePackages(path => readFileSync(join(root, path)), lock, platform, arch)
}

function verifyPackagedCanvas(resourcesDirectory, platform, arch, root = resolve(__dirname, '..')) {
  const asar = require('@electron/asar')
  const archive = join(resourcesDirectory, 'app.asar')
  asar.uncache(archive)
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  return verifyCanvasRuntimePackages(path => asar.extractFile(archive, path), lock, platform, arch)
}

function canvasSmokeScript(resourcesDirectory, root = resolve(__dirname, '..')) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const callers = CANVAS_ROOTS.map(prefix => ({
    entry: prefix ? `node_modules/${prefix.slice(0, -'node_modules/'.length)}package.json` : 'package.json',
    version: canvasLockEntry(lock, `${prefix}@napi-rs/canvas`).version
  }))
  return `
    const canvasRequire = require('node:module').createRequire
    const canvasArchive = ${JSON.stringify(join(resourcesDirectory, 'app.asar'))}
    for (const caller of ${JSON.stringify(callers)}) {
      const loadCanvas = canvasRequire(require('node:path').join(canvasArchive, caller.entry))
      if (loadCanvas('@napi-rs/canvas/package.json').version !== caller.version) {
        throw new Error('Packaged canvas version mismatch for ' + caller.entry)
      }
      const canvas = loadCanvas('@napi-rs/canvas').createCanvas(8, 8)
      const context = canvas.getContext('2d')
      context.fillStyle = '#336699'
      context.fillRect(0, 0, 8, 8)
      const png = canvas.toBuffer('image/png')
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Packaged canvas could not render PNG for ' + caller.entry)
      }
    }
    console.log('RAILWISE_PACKAGED_CANVAS_OK CALLERS=3')
  `
}

function explicitRuntimePackageFiles() {
  const exclusions = [
    ...dependencyArtifactFilters(), '!**/*.map', '!**/*.d.ts', '!**/*.ts',
    '!**/tsconfig*.json', '!**/README*', '!**/CHANGELOG*'
  ]
  const fileSet = (name, include) => ({
    from: `node_modules/${name}`, to: `node_modules/${name}`, filter: [...include, ...exclusions]
  })
  return [
    ...EXPLICIT_RUNTIME_PACKAGES.map(name => fileSet(name, ['**/*'])),
    // electron-builder 26.8.1 omits optional peer dependencies from its graph.
    // Preserve both PPT callers' nested canvas versions and their native loader.
    ...canvasRuntimePackages().map(name => fileSet(name, ['**/*'])),
    fileSet('katex', ['package.json', 'LICENSE', 'dist/**/*']),
    fileSet('mermaid', ['package.json', 'LICENSE']),
    fileSet('markdown-it-footnote', ['package.json', 'LICENSE', 'index.mjs', 'dist/index.cjs.js'])
  ]
}

module.exports = {
  explicitRuntimePackageFiles, EXPLICIT_RUNTIME_PACKAGES, OFFLINE_RENDERING_PACKAGES, RUNTIME_ENTRY_ASSETS,
  CANVAS_NATIVE_TARGETS, canvasRuntimePackages, canvasLockEntry, ensureCanvasRuntimePackages,
  verifyCanvasRuntimePackages, verifyPackagedCanvas, canvasSmokeScript
}
