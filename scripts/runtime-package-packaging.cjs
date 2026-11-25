const { dependencyArtifactFilters } = require('./dependency-artifact-policy.cjs')
const { createHash, randomUUID } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const EXPLICIT_RUNTIME_PACKAGES = ['@modelcontextprotocol/sdk', 'zod-to-json-schema', 'bindings', 'file-uri-to-path']
const OFFLINE_RENDERING_PACKAGES = ['katex', 'mermaid', 'markdown-it-footnote', 'pdfjs-dist']
const RUNTIME_ENTRY_ASSETS = [
  'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js',
  'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
  'node_modules/zod-to-json-schema/dist/cjs/index.js',
  'node_modules/zod-to-json-schema/dist/esm/index.js',
  'node_modules/bindings/bindings.js',
  'node_modules/file-uri-to-path/index.js',
  'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  'node_modules/pdfjs-dist/cmaps/UniGB-UCS2-H.bcmap',
  'node_modules/pdfjs-dist/cmaps/Adobe-GB1-UCS2.bcmap',
  'node_modules/pdfjs-dist/standard_fonts/FoxitSerif.pfb'
]
const CANVAS_PACKAGE = '@napi-rs/canvas'
const CANVAS_NATIVE_TARGETS = {
  'darwin-arm64': 'canvas-darwin-arm64',
  'darwin-x64': 'canvas-darwin-x64',
  'win32-x64': 'canvas-win32-x64-msvc',
  'win32-arm64': 'canvas-win32-arm64-msvc',
  'linux-x64': 'canvas-linux-x64-gnu'
}

function canvasRuntimePackages(platform = process.platform, arch = process.arch) {
  const native = CANVAS_NATIVE_TARGETS[`${platform}-${arch}`]
  if (!native) throw new Error(`[canvas-packaging] Unsupported target ${platform}-${arch}.`)
  return [CANVAS_PACKAGE, `@napi-rs/${native}`]
}

function runtimeFileSet(name, include) {
  return {
    from: `node_modules/${name}`, to: `node_modules/${name}`,
    filter: [...include, ...dependencyArtifactFilters(), '!**/*.map', '!**/*.d.ts', '!**/*.ts',
      '!**/tsconfig*.json', '!**/README*', '!**/CHANGELOG*']
  }
}

function canvasNativePackageFiles(platform) {
  const patterns = {
    darwin: 'canvas-darwin-${arch}',
    win32: 'canvas-win32-${arch}-msvc',
    linux: 'canvas-linux-${arch}-gnu'
  }
  if (!patterns[platform]) throw new Error(`[canvas-packaging] Unsupported platform ${platform}.`)
  return [runtimeFileSet(`@napi-rs/${patterns[platform]}`, ['**/*'])]
}

function canvasLockEntry(lock, name) {
  const entry = lock.packages?.[`node_modules/${name}`]
  if (!entry || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity || '')) {
    throw new Error(`[canvas-packaging] Missing exact dependency integrity for ${name}.`)
  }
  const expected = `https://registry.npmjs.org/${name}/-/${name.slice('@napi-rs/'.length)}-${entry.version}.tgz`
  if (entry.resolved !== expected) throw new Error(`[canvas-packaging] Unexpected locked source for ${name}.`)
  return { ...entry, packageName: name }
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
    if (entry.packageName === CANVAS_PACKAGE) {
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
  for (const name of canvasRuntimePackages(platform, arch)) {
    const entry = canvasLockEntry(lock, name)
    const destination = join(root, 'node_modules', name)
    if (existsSync(destination)) continue
    // npm installs optional binaries only for its host architecture.
    const bytes = await download(entry.resolved)
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
  return verifyCanvasRuntimePackages(path => asar.extractFile(archive, join(...path.split('/'))), lock, platform, arch)
}

function canvasCallerPackageName(path) {
  const segments = path.replace(/^\/+/, '').split('/')
  const nodeModulesIndex = segments.lastIndexOf('node_modules')
  if (nodeModulesIndex < 0 || nodeModulesIndex + 1 >= segments.length) return ''
  const first = segments[nodeModulesIndex + 1]
  return first.startsWith('@') ? `${first}/${segments[nodeModulesIndex + 2] || ''}` : first
}

function normalizeAsarPath(path) {
  return path.replaceAll('\\', '/').replace(/^\/+/, '')
}

function hasCanvasRuntimeDependency(metadata) {
  return Boolean(metadata.optionalDependencies?.[CANVAS_PACKAGE] || metadata.peerDependencies?.[CANVAS_PACKAGE])
}

function packagedCanvasCallerManifests(packagePaths, read, lock) {
  const lockCallers = Object.entries(lock.packages || {})
    .filter(([path, entry]) => path && (entry.optionalDependencies?.[CANVAS_PACKAGE] || entry.peerDependencies?.[CANVAS_PACKAGE]))
    .map(([path, entry]) => `${canvasCallerPackageName(path)}@${entry.version}`)
  const expected = new Set(lockCallers)
  if (lockCallers.some(identity => /^@\d/.test(identity)) || expected.size === 0) {
    throw new Error('The lockfile has no valid packaged Canvas callers.')
  }

  const callers = []
  const found = new Set()
  for (const rawPath of packagePaths) {
    const path = normalizeAsarPath(rawPath)
    if (!path.startsWith('node_modules/') || !path.endsWith('/package.json')) continue
    const metadata = JSON.parse(read(path).toString('utf8'))
    if (!hasCanvasRuntimeDependency(metadata)) continue
    const identity = `${metadata.name}@${metadata.version}`
    if (!expected.has(identity)) throw new Error(`[canvas-packaging] Packaged Canvas caller is not in the lockfile: ${identity}.`)
    callers.push(path)
    found.add(identity)
  }

  const missing = [...expected].filter(identity => !found.has(identity))
  if (missing.length) throw new Error(`[canvas-packaging] Missing packaged Canvas caller(s): ${missing.join(', ')}.`)
  return callers.sort()
}

function canvasSmokeScript(resourcesDirectory, callers, root = resolve(__dirname, '..')) {
  if (!Array.isArray(callers) || callers.length === 0) throw new Error('Packaged Canvas caller paths are required.')
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
  const canvasVersion = canvasLockEntry(lock, CANVAS_PACKAGE).version
  const normalizedCallers = callers.map(normalizeAsarPath)
  return `
    const canvasRequire = require('node:module').createRequire
    const canvasJoin = require('node:path').join
    const canvasArchive = ${JSON.stringify(join(resourcesDirectory, 'app.asar'))}
    const canvasManifest = canvasJoin(canvasArchive, 'node_modules', ${JSON.stringify(CANVAS_PACKAGE)}, 'package.json')
    for (const caller of ${JSON.stringify(normalizedCallers)}) {
      const callerManifest = canvasJoin(canvasArchive, caller)
      if (!require('node:fs').existsSync(callerManifest)) {
        throw new Error('Missing packaged Canvas caller ' + caller)
      }
      const loadCanvas = canvasRequire(callerManifest)
      const canvasPackage = ${JSON.stringify(CANVAS_PACKAGE)}
      if (loadCanvas.resolve(canvasPackage + '/package.json') !== canvasManifest ||
          loadCanvas(canvasPackage + '/package.json').version !== ${JSON.stringify(canvasVersion)}) {
        throw new Error('Packaged canvas resolution or version mismatch for ' + caller)
      }
      const canvas = loadCanvas(canvasPackage).createCanvas(8, 8)
      const context = canvas.getContext('2d')
      context.fillStyle = '#336699'
      context.fillRect(0, 0, 8, 8)
      const png = canvas.toBuffer('image/png')
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error('Packaged canvas could not render PNG for ' + caller)
      }
    }
    console.log('RAILWISE_PACKAGED_CANVAS_OK CALLERS=${normalizedCallers.length}')
  `
}

function explicitRuntimePackageFiles() {
  return [
    ...EXPLICIT_RUNTIME_PACKAGES.map(name => runtimeFileSet(name, ['**/*'])),
    runtimeFileSet(CANVAS_PACKAGE, ['**/*']),
    runtimeFileSet('katex', ['package.json', 'LICENSE', 'dist/**/*']),
    runtimeFileSet('mermaid', ['package.json', 'LICENSE']),
    runtimeFileSet('markdown-it-footnote', ['package.json', 'LICENSE', 'index.mjs', 'dist/index.cjs.js']),
    runtimeFileSet('pdfjs-dist', ['package.json', 'LICENSE', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'cmaps/**/*', 'standard_fonts/**/*'])
  ]
}

module.exports = {
  explicitRuntimePackageFiles, EXPLICIT_RUNTIME_PACKAGES, OFFLINE_RENDERING_PACKAGES, RUNTIME_ENTRY_ASSETS,
  CANVAS_NATIVE_TARGETS, canvasRuntimePackages, canvasNativePackageFiles, canvasLockEntry, ensureCanvasRuntimePackages,
  verifyCanvasRuntimePackages, verifyPackagedCanvas, canvasCallerPackageName, packagedCanvasCallerManifests, canvasSmokeScript
}
